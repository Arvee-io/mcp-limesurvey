/**
 * Changing what exists from a spec.
 *
 * limesurvey_update_question_from_spec (GEN-B) brings one question to a desired end state (a question spec, typically
 * the changed output of limesurvey_get_survey_spec). The difference to the live question decides the mode: none (nothing
 * to do), texts (question, help and subquestion texts, written in place with questionl10ns, also at an active survey),
 * columns (columns of the main question, in place, inactive only) or replace (everything else, inactive only): the end
 * state is imported as a new question, moved to the place of the old one and read back completely; only when it matches
 * is the old question deleted, otherwise the new one is deleted again and the old one gets its code back (design 9.17).
 * Unchanged texts are written as LimeSurvey stores them, not in the normal form (design 9.24).
 *
 * limesurvey_update_survey_texts (GEN-F) changes texts by code: the survey texts per language (set_language_properties),
 * group texts (set_group_properties with questiongroupl10ns) and question, help and subquestion texts
 * (set_question_properties with questionl10ns). A failed write resets what the call wrote before.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { BASE_THEME_BY_TYPE } from "./attribute-defaults.js";
import { limeSurveyGeneration } from "./limesurvey-generation.js";
import { probeOldQuestion } from "./replace-question.js";
import { capLists, MAX_LIST_ENTRIES, structuredSize } from "./response-limit.js";
import type { CreatedIds, RpcClient } from "./scoped-client.js";
import { cappedError, cutList, isRefusal, placeQuestion, questionSequence, relativeTo, setQuestion, type Limit } from "./spec-add.js";
import {
  canonicalJson,
  diffSpecs,
  fingerprint,
  normalizeSpec,
  normalScript,
  normalText,
  type ComparableQuestion,
  type ComparableSpec,
  type ComparableSurvey,
  type SpecDifference,
} from "./spec-compare.js";
import { generateQuestionLsq, specInvalidError } from "./spec-generate.js";
import { asString, expandText, isRecord, type TextMap } from "./spec-model.js";
import { mapLimit, PARALLEL_READS, readSurveyOutline, readSurveySpec, type SpecRead, type SurveyOutline } from "./spec-read.js";
import { DATA_URI_SOURCE, validateSpec, type SpecFinding, type SpecWarning } from "./spec-validate.js";
import { describeError, LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";

type JsonObject = Record<string, JsonValue>;

const json = (value: unknown): JsonValue => value as JsonValue;
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
const objectOf = (value: JsonValue | undefined): JsonObject | undefined => (isRecord(value) ? (value as JsonObject) : undefined);
const causeOf = (value: unknown): string => describeError(value).message;

function integer(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** A field value of a LimeSurvey answer as text; null when it is not there. */
function textOf(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/** Strings longer than `max` cut to `max` characters (and marked with an ellipsis), anywhere in a JSON value. */
function shorten(value: JsonValue, max: number): JsonValue {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((item) => shorten(item, max));
  const row = objectOf(value);
  return row ? Object.fromEntries(Object.entries(row).map(([key, item]) => [key, shorten(item, max)])) : value;
}

/**
 * manual_cleanup within LIMESURVEY_MAX_RESPONSE_CHARS: first the long values are shortened (the entry says
 * values_truncated), then entries are cut (the caller reports the full number).
 */
function fitCleanup(entries: JsonObject[], fits: (shown: JsonObject[]) => boolean): JsonObject[] {
  if (fits(entries)) return entries;
  const shortened = (max: number): JsonObject[] => entries.map((entry) => {
    const short = shorten(entry, max) as JsonObject;
    return JSON.stringify(short) === JSON.stringify(entry) ? entry : { ...short, values_truncated: true };
  });
  for (let max = 2000; max >= 20; max = Math.floor(max / 2)) {
    const shown = shortened(max);
    if (fits(shown)) return shown;
  }
  return capLists({ entries: shortened(20) }, (cut) => fits(cut.entries)).entries;
}

/** Risks with at most `max` locations each; a risk with locations names their full number (locations_total). */
function cutRisks(risks: ReadonlyArray<{ locations?: string[] }>, max: number): JsonObject[] {
  return risks.map((risk) => {
    const { locations, ...rest } = risk;
    const head = rest as unknown as JsonObject;
    return locations === undefined ? head : { ...head, locations: locations.slice(0, max), locations_total: locations.length };
  });
}

/** The risks that fit: their locations halved until fits(shown) holds, then, as a last resort, fewer risks. */
function fitRisks(risks: ReadonlyArray<{ locations?: string[] }>, fits: (shown: JsonObject[]) => boolean): JsonObject[] {
  for (let max = MAX_LIST_ENTRIES; max >= 0; max = max === 0 ? -1 : Math.floor(max / 2)) {
    const shown = cutRisks(risks, max);
    if (fits(shown)) return shown;
  }
  return capLists({ risks: cutRisks(risks, 0) }, (cut) => fits(cut.risks)).risks;
}

/** Whether risks were shown with fewer locations than they have. */
const locationsCut = (shown: readonly JsonObject[]): boolean => shown.some((risk) => (
  Array.isArray(risk.locations) && typeof risk.locations_total === "number" && risk.locations.length < risk.locations_total
));

/** Only the read-back after a successful write failed: the change is there, it was not compared. */
function verifyReadFailed(what: string, value: unknown, details: JsonObject): LimeSurveyError {
  const cause = describeError(value);
  return new LimeSurveyError(
    `${what} was written, but reading it back failed: ${cause.message} The change was not compared with what was asked for.`,
    "VERIFY_READ_FAILED",
    {
      written: true,
      ...details,
      ...(cause.code !== undefined ? { cause_code: cause.code } : {}),
      recovery: "Do not repeat the call blindly: the change is written. Read it with limesurvey_get_survey_spec and compare it with "
        + "what was asked for; call the tool again only for what is still missing.",
    },
  );
}

/** The scoped client of the call, the client object the LimeSurvey generation is kept for, and what the call may delete. */
export interface UpdateContext {
  rpc: RpcClient;
  client: object;
  config: LimeSurveyConfig;
  /** delete_question is opened for the question this call imported and, after its checks, for the old question. */
  created: CreatedIds;
}

// ================================================================ GEN-B: update_question_from_spec

export const UPDATE_ACKNOWLEDGEMENTS = [
  "qid_bound_links",
  "quota_members",
  "other_default",
  "removals",
  "fill_translation_gaps",
  "answer_code_references",
] as const;

export type UpdateAcknowledgement = (typeof UPDATE_ACKNOWLEDGEMENTS)[number];

export interface UpdateQuestionInput {
  survey_id: number;
  question_id: number;
  question: unknown;
  dry_run?: boolean | undefined;
  expected_fingerprint?: string | undefined;
  acknowledge?: UpdateAcknowledgement[] | undefined;
  confirm_destructive_action?: true | undefined;
}

type ChangeKind = "text" | "column" | "structure";
type Mode = "none" | "texts" | "columns" | "replace";

interface Change {
  path: string;
  kind: ChangeKind;
  current: JsonValue;
  desired: JsonValue;
}

interface Risk {
  code: string;
  blocking: boolean;
  acknowledgeable: boolean;
  detail: string;
  locations?: string[];
}

/** The columns of the main question that set_question_properties writes in place (spec name: LimeSurvey column). */
const COLUMN_PROPERTIES: Readonly<Record<string, string>> = {
  code: "title",
  mandatory: "mandatory",
  relevance: "relevance",
  preg: "preg",
  other: "other",
  same_default: "same_default",
  same_script: "same_script",
  encrypted: "encrypted",
  question_theme_name: "question_theme_name",
  modulename: "modulename",
};

/** text: question, help and subquestion texts; column: a column of the main question; structure: everything else. */
function kindOf(path: string): ChangeKind {
  if (/^(text|help)(\.|$)/.test(path) || /^subquestions\[\d+\]\.text(\.|$)/.test(path)) return "text";
  const head = /^[a-z_]+/.exec(path)?.[0] ?? "";
  if (Object.hasOwn(COLUMN_PROPERTIES, head) && (path === head || path.startsWith(`${head}.`))) return "column";
  return "structure";
}

const wrapQuestion = (survey: ComparableSurvey, question: ComparableQuestion): ComparableSpec => ({
  survey,
  groups: [{ title: {}, description: {}, relevance: "1", questions: [question] }],
});

/** Where two forms of one question differ, with paths relative to the question; a new code is one change at code. */
function questionDifferences(survey: ComparableSurvey, from: ComparableQuestion, to: ComparableQuestion): SpecDifference[] {
  const differences = relativeTo(
    "groups[0].questions[0]",
    "question",
    diffSpecs(wrapQuestion(survey, from), wrapQuestion(survey, { ...to, code: from.code })),
  );
  return from.code === to.code ? differences : [{ path: "code", expected: from.code, actual: to.code }, ...differences];
}

function modeOf(changes: readonly Change[]): Mode {
  if (changes.length === 0) return "none";
  if (changes.some((item) => item.kind === "structure")) return "replace";
  if (changes.some((item) => item.kind === "column")) return "columns";
  return "texts";
}

/** One question of a spec in the normal form, for the given languages. */
function normalQuestion(question: unknown, languages: readonly string[], trim: boolean): ComparableQuestion | undefined {
  return normalizeSpec({ groups: [{ questions: [question] }] }, languages, { trim }).groups[0]?.questions[0];
}

/** The texts of a question (with their paths): question, help, script, subquestion and answer texts, attribute values. */
function textEntries(question: ComparableQuestion): Array<{ path: string; value: string }> {
  const entries: Array<{ path: string; value: string }> = [];
  const addMap = (path: string, map: TextMap | undefined): void => {
    for (const [language, value] of Object.entries(map ?? {})) entries.push({ path: `${path}.${language}`, value });
  };
  addMap("text", question.text);
  addMap("help", question.help);
  addMap("script", question.script);
  question.subquestions.forEach((item, index) => addMap(`subquestions[${index}].text`, item.text));
  question.answers.forEach((item, index) => addMap(`answers[${index}].text`, item.text));
  for (const [name, value] of Object.entries(question.attributes)) {
    if (typeof value === "string") entries.push({ path: `attributes.${name}`, value });
    else addMap(`attributes.${name}`, value);
  }
  return entries;
}

/** The text rows a write in place touches: the main question in the changed languages and the changed subquestions. */
function touchedTextPaths(changes: readonly Change[]): Set<string> {
  const paths = new Set<string>();
  for (const change of changes) {
    const main = /^(?:text|help)\.(.+)$/.exec(change.path);
    if (main?.[1] !== undefined) {
      for (const field of ["text", "help", "script"]) paths.add(`${field}.${main[1]}`);
      continue;
    }
    const sub = /^(subquestions\[\d+\]\.text)\.(.+)$/.exec(change.path);
    if (sub?.[1] !== undefined && sub[2] !== undefined) paths.add(`${sub[1]}.${sub[2]}`);
  }
  return paths;
}

const tokenPattern = (token: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`);

/** Survey texts searched for references (every surveyls_* text, no attachments, no passwords). */
const SURVEY_REFERENCE_FIELDS: readonly string[] = [
  "surveyls_title", "surveyls_description", "surveyls_welcometext", "surveyls_endtext", "surveyls_policy_notice",
  "surveyls_policy_error", "surveyls_policy_notice_label", "surveyls_url", "surveyls_urldescription",
  "surveyls_email_invite_subj", "surveyls_email_invite", "surveyls_email_remind_subj", "surveyls_email_remind",
  "surveyls_email_register_subj", "surveyls_email_register", "surveyls_email_confirm_subj", "surveyls_email_confirm",
  "email_admin_notification_subj", "email_admin_notification", "email_admin_responses_subj", "email_admin_responses",
];

/**
 * How a source is searched: an expression (relevance, script, attribute) as a whole, a free text (question, help, answer,
 * group and survey texts, default values) only inside its EM expressions {...}.
 */
type SourceKind = "expression" | "text";

interface Source {
  location: string;
  text: string;
  kind: SourceKind;
}

const rowsOf = (value: JsonValue): JsonObject[] => (Array.isArray(value) ? value.map(objectOf).filter((row): row is JsonObject => row !== undefined) : []);

/**
 * The EM expressions of a free text: a { that is not followed by white space, up to its matching }; braces inside string
 * literals ('...' or "...", with backslash escapes) do not count. An unbalanced { starts no expression.
 */
export function emExpressions(text: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start < 0) break;
    const next = text.charAt(start + 1);
    if (next === "" || /\s/.test(next)) {
      index = start + 1;
      continue;
    }
    let depth = 0;
    let quote: string | undefined;
    let end = -1;
    for (let position = start; position < text.length; position += 1) {
      const character = text.charAt(position);
      if (quote !== undefined) {
        if (character === "\\") position += 1;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === "'" || character === "\"") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = position;
          break;
        }
      }
    }
    if (end < 0) {
      index = start + 1;
      continue;
    }
    found.push(text.slice(start + 1, end));
    index = end + 1;
  }
  return found;
}

/** The parts of a source that are searched: the whole expression, or the EM expressions of a free text. */
const searchable = (source: Source): string[] => (source.kind === "expression" ? [source.text] : emExpressions(source.text));

/** The answer texts in an answeroptions value of get_question_properties (flat, or per scale for dual scale). */
function answerTexts(value: JsonValue | undefined): Array<{ code: string; text: string }> {
  const found: Array<{ code: string; text: string }> = [];
  const visit = (node: JsonValue | undefined, key: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, String(index)));
      return;
    }
    const row = objectOf(node);
    if (!row) return;
    if (typeof row.answer === "string") {
      found.push({ code: textOf(row.code) ?? key, text: row.answer });
      return;
    }
    for (const [name, item] of Object.entries(row)) visit(item, name);
  };
  visit(value, "");
  return found;
}

/** The texts and expressions of the end state of the question itself (it may name its own code or its own parts). */
function ownSources(question: ComparableQuestion): Source[] {
  const sources: Source[] = [];
  const code = question.code;
  const add = (location: string, value: string | undefined, kind: SourceKind): void => {
    if (value !== undefined && value !== "") sources.push({ location, text: value, kind });
  };
  const addMap = (location: string, value: string | TextMap | undefined, kind: SourceKind): void => {
    if (typeof value === "string") add(location, value, kind);
    else for (const [language, text] of Object.entries(value ?? {})) add(`${location}.${language}`, text, kind);
  };
  add(`${code}.relevance`, question.relevance, "expression");
  addMap(`${code}.text`, question.text, "text");
  addMap(`${code}.help`, question.help, "text");
  addMap(`${code}.script`, question.script, "expression");
  addMap(`${code}.default`, question.default, "text");
  addMap(`${code}.default_other`, question.default_other, "text");
  for (const [name, value] of Object.entries(question.attributes)) addMap(`${code}.attributes.${name}`, value, "expression");
  for (const sub of question.subquestions) {
    add(`${code}_${sub.code}.relevance`, sub.relevance, "expression");
    addMap(`${code}_${sub.code}.text`, sub.text, "text");
    addMap(`${code}_${sub.code}.default`, sub.default, "text");
  }
  for (const answer of question.answers) {
    add(`${code}.answers.${answer.code}.relevance`, answer.relevance, "expression");
    addMap(`${code}.answers.${answer.code}.text`, answer.text, "text");
  }
  return sources;
}

/**
 * Every place of the survey where an expression or a text can name the question: survey texts, group relevances and
 * texts, relevances, texts and help of all questions and subquestions, answer texts, scripts and default values of every
 * language, and the attributes of the other questions; the question itself as its end state `own` (which is what will
 * exist). Read methods only. A question without a text row in a language is skipped there; any other read error stops
 * the call before anything is written.
 */
async function readReferenceSources(
  rpc: RpcClient,
  surveyId: number,
  languages: readonly string[],
  own: { questionId: number; question: ComparableQuestion },
): Promise<Source[]> {
  const base = languages[0] ?? "";
  const sources: Source[] = [];
  const add = (location: string, value: JsonValue | undefined, kind: SourceKind): void => {
    const text = textOf(value);
    if (text !== null && text !== "") sources.push({ location, text, kind });
  };
  const surveyRows = await mapLimit(languages, PARALLEL_READS, async (language) => (
    objectOf(await rpc.call("get_language_properties", [surveyId, [...SURVEY_REFERENCE_FIELDS], language]))
  ));
  languages.forEach((language, index) => {
    for (const field of SURVEY_REFERENCE_FIELDS) add(`survey.${field}.${language}`, surveyRows[index]?.[field], "text");
  });
  const groupLists = await mapLimit(languages, PARALLEL_READS, async (language) => rowsOf(await rpc.call("list_groups", [surveyId, language])));
  languages.forEach((language, index) => {
    for (const row of groupLists[index] ?? []) {
      const name = `group ${String(row.gid)}`;
      if (language === base) add(`${name}.relevance`, row.grelevance, "expression");
      add(`${name}.title.${language}`, row.group_name, "text");
      add(`${name}.description.${language}`, row.description, "text");
    }
  });
  const questionLists = await mapLimit(languages, PARALLEL_READS, async (language) => (
    rowsOf(await rpc.call("list_questions", [surveyId, null, language]))
  ));
  const codes = new Map((questionLists[0] ?? []).map((row) => [integer(row.qid) ?? 0, asString(row.title)] as const));
  const nameOf = (row: JsonObject): string => {
    const parent = integer(row.parent_qid) ?? 0;
    return parent === 0 ? asString(row.title) : `${codes.get(parent) ?? String(parent)}_${asString(row.title)}`;
  };
  const others = (row: JsonObject): boolean => integer(row.qid) !== own.questionId && integer(row.parent_qid) !== own.questionId;
  languages.forEach((language, index) => {
    for (const row of (questionLists[index] ?? []).filter(others)) {
      const name = nameOf(row);
      if (language === base) add(`${name}.relevance`, row.relevance, "expression");
      add(`${name}.text.${language}`, row.question, "text");
      add(`${name}.help.${language}`, row.help, "text");
    }
  });

  // Scripts, answer texts and attributes of the other main questions, per language (attributes of the base language).
  const mains = (questionLists[0] ?? []).filter((row) => others(row) && (integer(row.parent_qid) ?? 0) === 0);
  const tasks = mains.flatMap((row) => languages.map((language) => ({ row, language })));
  const properties = await mapLimit(tasks, PARALLEL_READS, async ({ row, language }) => {
    const fields = ["script", "attributes_lang", "answeroptions", "answeroptions_multiscale", ...(language === base ? ["attributes"] : [])];
    try {
      return objectOf(await rpc.call("get_question_properties", [integer(row.qid) ?? 0, fields, language]));
    } catch (error) {
      // A question without a text row in this language cannot be read there; that is a translation gap, nothing to search.
      if (isMissingRow(error)) return undefined;
      throw error;
    }
  });
  tasks.forEach(({ row, language }, index) => {
    const props = properties[index];
    const name = asString(row.title);
    add(`${name}.script.${language}`, props?.script, "expression");
    for (const answer of answerTexts(props?.answeroptions)) add(`${name}.answers.${answer.code}.${language}`, answer.text, "text");
    for (const [attribute, value] of Object.entries(objectOf(props?.attributes) ?? {})) add(`${name}.attributes.${attribute}`, value, "expression");
    for (const [attribute, value] of Object.entries(objectOf(props?.attributes_lang) ?? {})) add(`${name}.attributes.${attribute}.${language}`, value, "expression");
  });

  // Default values of the other questions, per language, from the field map (get_question_properties cannot give them).
  const fieldmaps = await mapLimit(languages, PARALLEL_READS, async (language) => {
    try {
      return await rpc.call("get_fieldmap", [surveyId, language]);
    } catch (error) {
      // A survey without fields answers "Can not obtain field map": it has no default values either.
      if (error instanceof LimeSurveyError && /field ?map/i.test(error.message)) return null;
      throw error;
    }
  });
  languages.forEach((language, index) => {
    const fieldmap = fieldmaps[index] ?? null;
    const entries = Array.isArray(fieldmap) ? fieldmap : Object.values(objectOf(fieldmap) ?? {});
    for (const entry of entries.map(objectOf)) {
      const qid = integer(entry?.qid);
      if (!entry || qid === undefined || qid === own.questionId) continue;
      const aid = asString(entry.aid);
      const name = `${codes.get(qid) ?? String(qid)}${aid !== "" ? `_${aid}` : ""}`;
      add(`${name}.default.${language}`, entry.defaultvalue, "text");
    }
  });

  sources.push(...ownSources(own.question));
  return sources;
}

/** What the risk check needs to know about the call. */
interface RiskInput {
  rpc: RpcClient;
  surveyId: number;
  questionId: number;
  groupId: number;
  mode: Mode;
  changes: readonly Change[];
  current: ComparableQuestion;
  raw: ComparableQuestion;
  desired: ComparableQuestion;
  outline: SurveyOutline;
  languages: readonly string[];
  /** The texts of the question that have no row in a language (paths relative to the question). */
  ownGaps: Array<{ path: string; language: string }>;
  /** Texts of the question that exist but cannot be read in a language (paths relative to the question). */
  unreadable: Array<{ path: string; language: string }>;
  /** The LimeSurvey generation, probed only when it matters (a mention of Q{qid}). */
  generation: () => Promise<6 | 7>;
}

const itemKey = (item: { code: string; scale_id?: number }): string => `${item.scale_id ?? 0}:${item.code}`;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What exists now and is missing from the end state: subquestions, answers, attributes and default values. */
function removals(current: ComparableQuestion, desired: ComparableQuestion): {
  paths: string[];
  subquestions: Array<{ code: string; scale: number }>;
  answers: string[];
} {
  const paths: string[] = [];
  const desiredSubs = new Map(desired.subquestions.map((item) => [itemKey(item), item] as const));
  const removedSubs: Array<{ code: string; scale: number }> = [];
  current.subquestions.forEach((item, index) => {
    const kept = desiredSubs.get(itemKey(item));
    if (!kept) {
      paths.push(`subquestions[${index}]`);
      removedSubs.push({ code: item.code, scale: item.scale_id ?? 0 });
    } else if (item.default !== undefined && kept.default === undefined) {
      paths.push(`subquestions[${index}].default`);
    }
  });
  const desiredAnswers = new Set(desired.answers.map(itemKey));
  const removedAnswers: string[] = [];
  current.answers.forEach((item, index) => {
    if (!desiredAnswers.has(itemKey(item))) {
      paths.push(`answers[${index}]`);
      removedAnswers.push(item.code);
    }
  });
  for (const name of Object.keys(current.attributes)) if (!Object.hasOwn(desired.attributes, name)) paths.push(`attributes.${name}`);
  if (current.default !== undefined && desired.default === undefined) paths.push("default");
  if (current.default_other !== undefined && desired.default_other === undefined) paths.push("default_other");
  return { paths, subquestions: removedSubs, answers: removedAnswers };
}

/**
 * The names other expressions use for what the end state renames or removes: the old code (on a new code); for removed
 * subquestions CODE_SQ (P also CODE_SQcomment; : and ; a removed row CODE_row..., a removed column CODE_<row>_col); for
 * a dropped "Other" option CODE_other (P also CODE_othercomment).
 */
function referenceTokens(current: ComparableQuestion, desired: ComparableQuestion, removedSubs: ReadonlyArray<{ code: string; scale: number }>): Array<{ name: string; pattern: RegExp }> {
  const code = current.code;
  const tokens: Array<{ name: string; pattern: RegExp }> = [];
  const add = (name: string, source: string): void => {
    tokens.push({ name, pattern: new RegExp(`(?<![A-Za-z0-9_])${source}(?![A-Za-z0-9])`) });
  };
  const literal = (text: string): string => escapeRegExp(text);
  if (desired.code !== code) add(code, literal(code));
  const matrix = current.type === ":" || current.type === ";";
  for (const sub of removedSubs) {
    if (matrix && sub.scale === 1) add(`${code}_*_${sub.code}`, `${literal(code)}_[A-Za-z0-9]+_${literal(sub.code)}`);
    else add(`${code}_${sub.code}`, `${literal(code)}_${literal(sub.code)}`);
    if (current.type === "P") add(`${code}_${sub.code}comment`, `${literal(code)}_${literal(sub.code)}comment`);
  }
  if (current.other && !desired.other) {
    add(`${code}_other`, `${literal(code)}_other`);
    if (current.type === "P") add(`${code}_othercomment`, `${literal(code)}_othercomment`);
  }
  return tokens;
}

/** Whether an expression compares with the answer code: quoted ('A2', "A2") or after a comparison operator (== 3). */
function comparesWith(expression: string, answerCode: string): boolean {
  const code = escapeRegExp(answerCode);
  if (expression.includes(`'${answerCode}'`) || expression.includes(`"${answerCode}"`)) return true;
  const operator = "(?:==|!=|<=|>=|<|>|\\b(?:eq|ne|lt|gt|le|ge)\\b)";
  return new RegExp(`${operator}\\s*${code}(?![A-Za-z0-9_.])`).test(expression)
    || new RegExp(`(?<![A-Za-z0-9_.'"])${code}\\s*${operator}`).test(expression);
}

async function questionRisks(input: RiskInput): Promise<{ risks: Risk[]; notes: string[] }> {
  const { rpc, mode, current, raw, desired } = input;
  const risks: Risk[] = [];
  const notes: string[] = [];
  if (mode === "none") return { risks, notes };
  const replace = mode === "replace";

  // Data URIs: LimeSurvey removes them from every text of a row it saves (also from texts this call does not change).
  const touched = replace ? undefined : touchedTextPaths(input.changes);
  const withDataUri = [...textEntries(raw), ...textEntries(desired)]
    .filter((entry) => (touched === undefined || touched.has(entry.path)) && DATA_URI_SOURCE.test(entry.value))
    .map((entry) => entry.path);
  if (withDataUri.length > 0) {
    risks.push({
      code: "data_uri",
      blocking: true,
      acknowledgeable: false,
      detail: "A text of the question that this call writes holds an image embedded as a data URI (src=\"data:...\"). LimeSurvey "
        + "removes such images whenever it saves the text, also from texts that are not changed. Upload the image and link it by "
        + "URL (or remove it) in the LimeSurvey admin first.",
      locations: [...new Set(withDataUri)],
    });
  }

  const removed = removals(current, desired);
  if (replace) {
    risks.push({
      code: "qid_bound_links",
      blocking: true,
      acknowledgeable: true,
      detail: "The question is replaced by a new one with a new ID. What hangs on the old ID cannot be read and is lost: URL "
        + "parameter assignments, archived response columns, rows of its own old conditions (their logic stays in the "
        + "relevance) and quota memberships.",
    });
    const quotas = await rpc.call("list_quotas", [input.surveyId]);
    if (Array.isArray(quotas) && quotas.length > 0) {
      risks.push({
        code: "quota_members",
        blocking: true,
        acknowledgeable: true,
        detail: `The survey has ${quotas.length} quota${quotas.length === 1 ? "" : "s"}. Quota members cannot be read; the members `
          + "that count this question are deleted with the old question and a quota without members stops working silently. "
          + "Set them again in the LimeSurvey admin afterwards.",
        locations: rowsOf(quotas).map((row) => asString(row.name)).filter((name) => name !== ""),
      });
    }
    if ((current.type === "M" || current.type === "P") && current.other) {
      risks.push({
        code: "other_default",
        blocking: true,
        acknowledgeable: true,
        detail: "The default value of the \"Other\" option of an M or P question cannot be read, so a default there is lost.",
      });
    }
    if (removed.paths.length > 0) {
      risks.push({
        code: "removals",
        blocking: true,
        acknowledgeable: true,
        detail: "The end state lacks subquestions, answers, attributes or default values the question has now; they are deleted "
          + "with the old question.",
        locations: removed.paths,
      });
    }
    const otherGaps = input.outline.gaps.filter((gap) => gap.question_id !== input.questionId);
    const gaps = [...otherGaps.map((gap) => `${gap.path} (${gap.language})`), ...input.ownGaps.map((gap) => `question.${gap.path} (${gap.language})`)];
    if (gaps.length > 0) {
      risks.push({
        code: "translation_gaps",
        blocking: true,
        acknowledgeable: true,
        detail: "import_question fills every text of the survey that has no row in an additional language with the base-language "
          + "text (texts of this question that lack a language get it as well). That cannot be undone; acknowledge "
          + "fill_translation_gaps to accept it, or translate the texts first with limesurvey_update_survey_texts.",
        locations: gaps,
      });
    }
    if (input.unreadable.length > 0) {
      risks.push({
        code: "unreadable_texts",
        blocking: true,
        acknowledgeable: true,
        detail: "Some texts of the question exist but cannot be read in a language, because the question has no text row there "
          + "(answer texts, language-dependent attributes). The replacement writes the base-language text in their place, so "
          + "the stored texts are lost; acknowledge fill_translation_gaps to accept that, or add the missing text row first "
          + "(limesurvey_update_survey_texts) and read the question again.",
        locations: input.unreadable.map((item) => `${item.path} (${item.language})`),
      });
    }
    risks.push({
      code: "undefined_attributes",
      blocking: false,
      acknowledgeable: false,
      detail: "Stored attributes that the question type, theme or a plugin does not define cannot be read (unreadable "
        + "undefined_attributes); the new question does not have them.",
    });
  }

  const tokens = referenceTokens(current, desired, replace ? removed.subquestions : []);
  if (tokens.length > 0 || replace) {
    const sources = await readReferenceSources(rpc, input.surveyId, input.languages, { questionId: input.questionId, question: desired });
    /** The locations whose searchable parts match. */
    const hits = (match: (expression: string) => boolean): string[] => [...new Set(sources
      .filter((source) => searchable(source).some(match))
      .map((source) => source.location))];
    const codeHits = hits((expression) => tokens.some((token) => token.pattern.test(expression)));
    if (codeHits.length > 0) {
      risks.push({
        code: "code_references",
        blocking: true,
        acknowledgeable: false,
        detail: `Parts of the survey name ${tokens.map((token) => token.name).join(", ")}, which the end state renames or removes; these `
          + "expressions or texts would break. Change them first (or keep the code and the fields).",
        locations: codeHits,
      });
    }
    if (replace) {
      // The new question gets a new ID. {sid}X{gid}X{qid} (and INSERTANS) names a question by its ID on both generations;
      // Q{qid} only on LimeSurvey 7, and only when no question of the survey has that code.
      const sgqa = new RegExp(`(?<![0-9])${input.surveyId}X${input.groupId}X${input.questionId}(?![0-9])`);
      const qidName = `Q${input.questionId}`;
      const qidPattern = new RegExp(`(?<![A-Za-z0-9_])${qidName}(?![0-9])`);
      const qidHits = hits((expression) => qidPattern.test(expression));
      let byId = hits((expression) => sgqa.test(expression));
      if (qidHits.length > 0) {
        if (input.outline.questionCodes.some((code) => code.toLowerCase() === qidName.toLowerCase())) {
          notes.push(`${qidName} is also the code of a question of the survey, so its mentions (${qidHits.slice(0, 10).join(", ")}`
            + `${qidHits.length > 10 ? ", ..." : ""}) are taken as that code, not as the ID of this question. Check them by hand if one `
            + "means this question.");
        } else if (await input.generation() === 7) {
          byId = [...new Set([...byId, ...qidHits])];
        }
      }
      if (byId.length > 0) {
        risks.push({
          code: "sgqa_references",
          blocking: true,
          acknowledgeable: false,
          detail: `Parts of the survey name the question by its ID (${input.surveyId}X${input.groupId}X${input.questionId}, INSERTANS or, `
            + `on LimeSurvey 7, ${qidName}); the new question has a new ID, so these references would break.`,
          locations: byId,
        });
      }
      if (removed.answers.length > 0) {
        const codePattern = tokenPattern(current.code);
        const answerHits = hits((expression) => codePattern.test(expression) && removed.answers.some((code) => comparesWith(expression, code)));
        if (answerHits.length > 0) {
          risks.push({
            code: "answer_code_references",
            blocking: true,
            acknowledgeable: true,
            detail: `Expressions name the question together with answer codes the end state removes (${removed.answers.join(", ")}); `
              + "they would never be true again.",
            locations: answerHits,
          });
        }
      }
    }
  }
  return { risks, notes };
}

/** translation_gaps and unreadable_texts are confirmed with fill_translation_gaps; every other risk with its own code. */
const acknowledgementOf = (code: string): string => (code === "translation_gaps" || code === "unreadable_texts" ? "fill_translation_gaps" : code);

function planFor(mode: Mode | "rejected", input: { questionId: number; groupId: number; position: number; rename: boolean; columns: string[]; changes: readonly Change[] }): string[] {
  const textLanguages = [...new Set(input.changes.filter((item) => item.kind === "text").map((item) => item.path.split(".").pop() ?? ""))];
  const textStep = `Write the changed texts (${textLanguages.join(", ")}) with set_question_properties (questionl10ns) of question `
    + `${input.questionId} and its changed subquestions; unchanged texts are written back as stored.`;
  const readBack = "Read the question back with get_survey_spec and compare it with the end state.";
  switch (mode) {
    case "none":
      return ["Nothing to write: the question already matches the end state."];
    case "rejected":
      return [
        "Nothing can be written: the survey is active and the end state changes columns or the structure of the question "
          + "(only question, help and subquestion texts can change at an active survey). Change the texts only, or work on an "
          + "inactive copy (limesurvey_copy_survey).",
      ];
    case "texts":
      return [textStep, readBack];
    case "columns":
      return [
        `Save the columns ${input.columns.join(", ")} with set_question_properties on question ${input.questionId} (the ID stays).`,
        ...(input.changes.some((item) => item.kind === "text") ? [textStep] : []),
        readBack,
        "If a write fails, the old values are written back.",
      ];
    default:
      return [
        ...(input.rename ? [`Give question ${input.questionId} a temporary code, so that the end state can be imported under its code.`] : []),
        `Import the end state as a new question (import_question) into group ${input.groupId}.`,
        `Move the new question to place ${input.position} of the group (only the new question is moved).`,
        "Read the new question back completely and compare it with the end state; on any difference delete it again and give the "
          + "old question its code back.",
        `Delete the old question ${input.questionId}; the question then has a new ID (old conditions of its own stay as relevance).`,
      ];
  }
}

function staleSpec(expected: string | undefined, current: string): LimeSurveyError {
  return new LimeSurveyError(
    "The question changed since the spec was read (expected_fingerprint does not match). Nothing was written.",
    "STALE_SPEC",
    {
      expected_fingerprint: expected ?? null,
      current_fingerprint: current,
      recovery: "Read the question again with limesurvey_get_survey_spec (or run a dry run), apply the change to that spec and call the "
        + "tool again with its fingerprint.",
    },
  );
}

/** The value set_question_properties gets for a column of the end state. */
function columnValue(name: string, desired: ComparableQuestion): JsonValue {
  switch (name) {
    case "code":
      return desired.code;
    case "mandatory":
      return desired.mandatory === "soft" ? "S" : desired.mandatory ? "Y" : "N";
    case "relevance":
      return desired.relevance;
    case "preg":
      return desired.preg ?? "";
    case "other":
      return desired.other ? "Y" : "N";
    case "same_default":
      return desired.same_default === true ? "1" : "0";
    case "same_script":
      return desired.same_script === true ? "1" : "0";
    case "encrypted":
      return desired.encrypted === true ? "Y" : "N";
    case "question_theme_name":
      return desired.question_theme_name ?? (Object.hasOwn(BASE_THEME_BY_TYPE, desired.type) ? (BASE_THEME_BY_TYPE[desired.type] ?? "") : "");
    default:
      return desired.modulename ?? "";
  }
}

/** One set_question_properties call with questionl10ns, and what it overwrites (for the rollback). */
interface TextWrite {
  qid: number;
  data: JsonObject;
  undo: JsonObject;
  /** For a subquestion: its key (scale:code). */
  sub?: string;
}

/** The text of a spec value in one language: one string counts for every language. */
const textIn = (value: unknown, language: string, languages: readonly string[]): string => expandText(value ?? "", languages)[language] ?? "";

/**
 * The questionl10ns writes of the text changes: the changed fields with the values of the end state as given, the
 * unchanged ones of the same row with the stored values (never the normal form).
 */
function textWrites(input: {
  changes: readonly Change[];
  questionId: number;
  raw: ComparableQuestion;
  current: ComparableQuestion;
  desiredInput: Record<string, unknown>;
  subquestionIds: Map<string, number>;
  languages: readonly string[];
}): TextWrite[] {
  const { raw, current, desiredInput, languages } = input;
  const main = new Map<string, Set<string>>();
  const subs = new Map<number, Map<string, string>>();
  const desiredSubs = Array.isArray(desiredInput.subquestions) ? desiredInput.subquestions.filter(isRecord) : [];
  for (const change of input.changes.filter((item) => item.kind === "text")) {
    const mainMatch = /^(text|help)\.(.+)$/.exec(change.path);
    if (mainMatch?.[1] !== undefined && mainMatch[2] !== undefined) {
      const fields = main.get(mainMatch[2]) ?? new Set<string>();
      fields.add(mainMatch[1]);
      main.set(mainMatch[2], fields);
      continue;
    }
    const subMatch = /^subquestions\[(\d+)\]\.text\.(.+)$/.exec(change.path);
    if (subMatch?.[1] === undefined || subMatch[2] === undefined) continue;
    const index = Number(subMatch[1]);
    const sub = current.subquestions[index];
    const qid = sub === undefined ? undefined : input.subquestionIds.get(itemKey(sub));
    if (sub === undefined || qid === undefined) {
      throw new LimeSurveyError(`The subquestion at subquestions[${index}] was not found in the survey. Nothing was written.`, "UNEXPECTED_RESPONSE", {
        path: `subquestions[${index}]`,
        recovery: "Read the question again with limesurvey_get_survey_spec (it may have changed) and call the tool again with that spec.",
      });
    }
    const given = desiredSubs.find((item) => `${Math.trunc(Number(item.scale_id ?? 0)) || 0}:${asString(item.code).trim()}` === itemKey(sub));
    const texts = subs.get(qid) ?? new Map<string, string>();
    texts.set(subMatch[2], textIn(given?.text, subMatch[2], languages));
    subs.set(qid, texts);
  }
  const writes: TextWrite[] = [];
  if (main.size > 0) {
    const data: JsonObject = {};
    const undo: JsonObject = {};
    for (const [language, fields] of main) {
      const stored = { question: raw.text[language] ?? "", help: raw.help[language] ?? "" };
      data[language] = {
        question: fields.has("text") ? textIn(desiredInput.text, language, languages) : stored.question,
        help: fields.has("help") ? textIn(desiredInput.help, language, languages) : stored.help,
      };
      undo[language] = stored;
    }
    writes.push({ qid: input.questionId, data: { questionl10ns: data }, undo: { questionl10ns: undo } });
  }
  for (const [qid, texts] of subs) {
    const index = current.subquestions.findIndex((item) => input.subquestionIds.get(itemKey(item)) === qid);
    const data: JsonObject = {};
    const undo: JsonObject = {};
    for (const [language, text] of texts) {
      data[language] = { question: text };
      undo[language] = { question: raw.subquestions[index]?.text[language] ?? "" };
    }
    const sub = current.subquestions[index];
    writes.push({ qid, data: { questionl10ns: data }, undo: { questionl10ns: undo }, ...(sub !== undefined ? { sub: itemKey(sub) } : {}) });
  }
  return writes;
}

/**
 * What an L10n write did not save. LimeSurvey answers questionl10ns / questiongroupl10ns per language and field with the
 * result of save(), for example { "de": { "question": true, "help": true } }; false for a language (a missing row could
 * not be created) and the text "Empty question L10n data" / "Empty group L10n data" (no valid field) are failures, as is
 * false for a field (7.5.1 remotecontrol_handle.php:1430-1464 and 1991-2031, 6.17.11 :1363-1406 and 1908-1950). Returns
 * the languages and fields that were sent but not saved.
 */
export function l10nNotSaved(answer: JsonObject | undefined, key: string, sent: JsonObject): string[] {
  const saved = objectOf(answer?.[key]);
  const missing: string[] = [];
  for (const [language, fields] of Object.entries(sent)) {
    const entry = saved?.[language];
    if (!isRecord(entry)) {
      missing.push(`${language}: ${JSON.stringify(entry ?? null)}`);
      continue;
    }
    for (const field of Object.keys(objectOf(fields) ?? {})) {
      if (entry[field] !== true) missing.push(`${language}.${field}: ${JSON.stringify(entry[field] ?? null)}`);
    }
  }
  return missing;
}

/** A questionl10ns write; any language or field it did not save makes it a failure. */
async function writeTexts(rpc: RpcClient, qid: number, data: JsonObject): Promise<void> {
  const answer = objectOf(await rpc.call("set_question_properties", [qid, data]));
  const missing = l10nNotSaved(answer, "questionl10ns", objectOf(data.questionl10ns) ?? {});
  if (missing.length > 0) {
    throw new LimeSurveyError(`set_question_properties did not save the texts of ${qid} (${missing.join(", ")}).`, "FIELD_SAVE_FAILED", answer ?? null);
  }
}

/** The ids of the subquestions of a question, by scale and code. */
async function subquestionIds(rpc: RpcClient, surveyId: number, groupId: number, questionId: number): Promise<Map<string, number>> {
  const rows = rowsOf(await rpc.call("list_questions", [surveyId, groupId]));
  return new Map(rows
    .filter((row) => integer(row.parent_qid) === questionId)
    .map((row) => [`${integer(row.scale_id) ?? 0}:${asString(row.title)}`, integer(row.qid) ?? 0] as const));
}

/** Differences between what the end state says and what the survey holds now (both trimmed, LimeSurvey may trim). */
function verifyDifferences(survey: ComparableSurvey, expectedInput: unknown, live: SpecRead, languages: readonly string[]): SpecDifference[] {
  const expected = normalQuestion(expectedInput, languages, true);
  const actual = normalizeSpec(live.spec, languages, { trim: true }).groups[0]?.questions[0];
  if (!expected || !actual) return [{ path: "question", expected: json(expected ?? null), actual: json(actual ?? null) }];
  return questionDifferences(survey, expected, actual);
}

/**
 * The spec the replacement imports: the end state, its texts that do not change carrying the values LimeSurvey stores
 * (design 9.24), and a language the end state lacks (an unchanged translation gap) filled with the base-language text,
 * as the import would fill it.
 */
function replacementSpec(desiredInput: Record<string, unknown>, current: ComparableQuestion, raw: ComparableQuestion, languages: readonly string[]): Record<string, unknown> {
  const base = languages[0] ?? "";
  const merge = (value: unknown, now: TextMap | undefined, stored: TextMap | undefined, normal: (text: string) => string): TextMap => {
    const given = expandText(value ?? "", languages);
    const result: TextMap = {};
    for (const language of languages) {
      const text = given[language] ?? given[base] ?? Object.values(given)[0] ?? "";
      const before = now?.[language];
      const storedText = stored?.[language];
      result[language] = before !== undefined && storedText !== undefined && normal(text) === before ? storedText : text;
    }
    return result;
  };
  /** One value: the stored one when the end state does not change it (compared in the normal form). */
  const keep = (value: unknown, now: string | undefined, stored: string | undefined): unknown => {
    if (typeof value !== "string" && typeof value !== "number") return value;
    return now !== undefined && stored !== undefined && normalText(asString(value)) === now ? stored : value;
  };
  /** A default value (a string, or a map that may name some languages): unchanged values as stored. */
  const keepDefault = (value: unknown, now: string | TextMap | undefined, stored: string | TextMap | undefined): unknown => {
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([language, item]) => [
        language,
        keep(item, isRecord(now) ? now[language] : undefined, isRecord(stored) ? stored[language] : undefined),
      ]));
    }
    return keep(value, typeof now === "string" ? now : undefined, typeof stored === "string" ? stored : undefined);
  };
  /** Attributes: unchanged values as stored; a language a per-language value lacks gets the base-language value. */
  const attributes = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      const now = current.attributes[name];
      const stored = raw.attributes[name];
      if (!isRecord(item)) return [name, keep(item, typeof now === "string" ? now : undefined, typeof stored === "string" ? stored : undefined)];
      const given = Object.fromEntries(Object.entries(item).map(([language, text]) => [language, asString(text)]));
      return [name, Object.fromEntries(languages.map((language) => [
        language,
        keep(given[language] ?? given[base] ?? Object.values(given)[0] ?? "", isRecord(now) ? now[language] : undefined, isRecord(stored) ? stored[language] : undefined),
      ]))];
    }));
  };
  const items = (
    list: unknown,
    now: ReadonlyArray<{ code: string; scale_id?: number; text: TextMap; default?: string | TextMap }>,
    stored: ReadonlyArray<{ text: TextMap; default?: string | TextMap }>,
  ) => (
    (Array.isArray(list) ? list.filter(isRecord) : []).map((item) => {
      const index = now.findIndex((entry) => itemKey(entry) === `${Math.trunc(Number(item.scale_id ?? 0)) || 0}:${asString(item.code).trim()}`);
      return {
        ...item,
        text: merge(item.text, now[index]?.text, stored[index]?.text, normalText),
        ...(item.default !== undefined ? { default: keepDefault(item.default, now[index]?.default, stored[index]?.default) } : {}),
      };
    })
  );
  return {
    ...desiredInput,
    text: merge(desiredInput.text, current.text, raw.text, normalText),
    help: merge(desiredInput.help, current.help, raw.help, normalText),
    script: merge(desiredInput.script, current.script, raw.script, normalScript),
    subquestions: items(desiredInput.subquestions, current.subquestions, raw.subquestions),
    answers: items(desiredInput.answers, current.answers, raw.answers),
    ...(desiredInput.attributes !== undefined ? { attributes: attributes(desiredInput.attributes) } : {}),
    ...(desiredInput.default !== undefined ? { default: keepDefault(desiredInput.default, current.default, raw.default) } : {}),
    ...(desiredInput.default_other !== undefined ? { default_other: keepDefault(desiredInput.default_other, current.default_other, raw.default_other) } : {}),
  };
}

/** A temporary code no question of the survey uses (letters and digits, a letter first, at most 20). */
function temporaryCode(taken: readonly string[]): string {
  const used = new Set(taken.map((code) => code.toLowerCase()));
  for (;;) {
    const code = `RPL${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (!used.has(code.toLowerCase())) return code;
  }
}

/** The import of the replacement failed: refused before anything was created, or with an unknown outcome. */
class ImportFailure extends Error {
  constructor(readonly created: false | "unknown", readonly reason: unknown, readonly candidates: JsonObject[]) {
    super(causeOf(reason));
  }
}

interface ReplaceJob {
  surveyId: number;
  groupId: number;
  oldQid: number;
  oldCode: string;
  desiredCode: string;
  /** The main questions of the group (the old one among them), in their order. */
  before: SurveyOutline["groups"][number]["questions"];
  /** The 1-based place of the old question in the group. */
  target: number;
  lsq: string;
  mandatory: string;
  expectedInput: unknown;
  survey: ComparableSurvey;
  languages: readonly string[];
  outline: SurveyOutline;
}

interface ReplaceOutcome {
  newQid: number;
  live: SpecRead;
  steps: JsonObject[];
}

const RECOVERY_RETRY = "Fix the cause in the message and call the tool again (a dry run shows the plan).";

function replaceFailed(message: string, details: JsonObject, limit: Limit, differences: SpecDifference[] = []): LimeSurveyError {
  return cappedError(limit, message, "REPLACE_QUESTION_FAILED", { differences }, (cut) => ({
    ...details,
    ...cutList("differences", cut.differences, differences),
  }));
}

async function runReplacement(context: UpdateContext, job: ReplaceJob, limit: Limit): Promise<ReplaceOutcome> {
  const { rpc } = context;
  const { surveyId, groupId, oldQid, oldCode, desiredCode } = job;
  const steps: JsonObject[] = [];
  let renamed = false;
  let tempCode: string | undefined;
  let newQid: number | undefined;
  let failedStep = "rename_old_question";
  let differences: SpecDifference[] = [];

  const candidates = async (): Promise<JsonObject[]> => {
    try {
      return (await questionSequence(rpc, surveyId, groupId))
        .filter((item) => !job.outline.questionIds.has(item.question_id) && item.code.toLowerCase() === desiredCode.toLowerCase())
        .map((item) => ({ question_id: item.question_id, code: item.code }));
    } catch {
      return [];
    }
  };

  /** Deletes the question this call imported and gives the old question its code back. */
  const rollback = async (): Promise<{ steps: JsonObject[]; manualCleanup: JsonObject[] }> => {
    const done: JsonObject[] = [];
    const manualCleanup: JsonObject[] = [];
    if (newQid !== undefined) {
      try {
        const deleted = integer(await rpc.call("delete_question", [newQid]));
        if (deleted !== newQid) throw new LimeSurveyError(`delete_question answered ${String(deleted)} instead of ${newQid}.`);
        done.push({ step: "rollback_delete_new_question", question_id: newQid });
      } catch (value) {
        manualCleanup.push({ action: "delete_question", question_id: newQid, reason: causeOf(value) });
      }
    }
    if (renamed) {
      try {
        const now = asString(objectOf(await rpc.call("get_question_properties", [oldQid, ["title"]]))?.title);
        if (now !== oldCode) await setQuestion(rpc, oldQid, { title: oldCode });
        done.push({ step: "rollback_restore_code", question_id: oldQid, code: oldCode });
      } catch (value) {
        manualCleanup.push({ action: "restore_code", question_id: oldQid, temporary_code: tempCode ?? null, expected_code: oldCode, reason: causeOf(value) });
      }
    }
    return { steps: done, manualCleanup };
  };

  const finish = (live: SpecRead): ReplaceOutcome => ({ newQid: newQid as number, live, steps });

  let live: SpecRead | undefined;
  try {
    if (desiredCode.toLowerCase() === oldCode.toLowerCase()) {
      // import_question refuses a code that exists, so the old question gives its code up for the time of the replacement.
      tempCode = temporaryCode(job.outline.questionCodes);
      renamed = true;
      await setQuestion(rpc, oldQid, { title: tempCode });
      steps.push({ step: "rename_old_question", temporary_code: tempCode });
    }

    failedStep = "import_question";
    let answer: JsonValue;
    try {
      answer = await rpc.call("import_question", [surveyId, groupId, Buffer.from(job.lsq, "utf8").toString("base64"), "lsq", job.mandatory]);
    } catch (value) {
      if (value instanceof LimeSurveyError && isRefusal(value.details)) throw new ImportFailure(false, value, []);
      throw new ImportFailure("unknown", value, await candidates());
    }
    const id = integer(answer);
    if (id === undefined || id <= 0 || job.outline.questionIds.has(id)) {
      if (isRefusal(answer)) throw new ImportFailure(false, new LimeSurveyError(`import_question failed: ${String(objectOf(answer)?.status)}`, undefined, answer), []);
      throw new ImportFailure("unknown", new LimeSurveyError(`import_question answered without a new question id: ${JSON.stringify(answer)}.`, undefined, answer), await candidates());
    }
    newQid = id;
    context.created.questions.add(newQid);
    steps.push({ step: "import_question", new_question_id: newQid });

    failedStep = "position";
    await placeQuestion(rpc, {
      surveyId,
      groupId,
      qid: newQid,
      code: desiredCode,
      target: job.target,
      before: job.before,
      takenCodes: new Set([...job.outline.questionCodes, tempCode ?? ""].map((code) => code.toLowerCase())),
    });
    failedStep = "verify_position";
    const expected = job.before.map((item) => item.question_id);
    expected.splice(job.target - 1, 0, newQid);
    const actual = (await questionSequence(rpc, surveyId, groupId)).map((item) => item.question_id);
    if (actual.length !== expected.length || actual.some((qid, index) => qid !== expected[index])) {
      throw new LimeSurveyError("The new question is not at the place of the old one after positioning.", "POSITION_NOT_SET", {
        expected_sequence: expected,
        actual_sequence: actual,
      });
    }
    steps.push({ step: "position", place: job.target });

    // The full comparison comes before the old question is deleted (design 9.17).
    failedStep = "verify_new_question";
    live = await readSurveySpec(rpc, surveyId, { questionId: newQid });
    differences = verifyDifferences(job.survey, job.expectedInput, live, job.languages);
    if (differences.length > 0) {
      throw new LimeSurveyError(
        `The imported question differs from the end state in ${differences.length} place${differences.length === 1 ? "" : "s"}.`,
        "VERIFY_FAILED",
      );
    }
    steps.push({ step: "verify_new_question" });

    failedStep = "verify_old_question";
    const expectedCode = tempCode ?? oldCode;
    const check = objectOf(await rpc.call("get_question_properties", [oldQid, ["sid", "parent_qid", "title"]]));
    if (integer(check?.sid) !== surveyId || integer(check?.parent_qid) !== 0 || asString(check?.title) !== expectedCode) {
      throw new LimeSurveyError(
        `Question ${oldQid} changed during the replacement (expected survey ${surveyId}, a main question, code ${expectedCode}); it is not deleted.`,
        "QUESTION_CHANGED",
        check ?? null,
      );
    }
    failedStep = "delete_old_question";
    context.created.questions.add(oldQid);
    const deleted = integer(await rpc.call("delete_question", [oldQid]));
    if (deleted !== oldQid) throw new LimeSurveyError(`delete_question answered ${String(deleted)} instead of ${oldQid}.`, "UNEXPECTED_RESPONSE");
    steps.push({ step: "delete_old_question", old_question_id: oldQid });
    return finish(live);
  } catch (value) {
    const cause = describeError(value instanceof ImportFailure ? value.reason : value);
    const base: JsonObject = {
      failed_step: failedStep,
      cause: cause.message,
      ...(cause.code !== undefined ? { cause_code: cause.code } : {}),
      old_question_id: oldQid,
      new_question_id: newQid ?? null,
      steps: json(steps),
    };

    if (value instanceof ImportFailure && value.created === "unknown") {
      // Nothing is deleted when it is unknown what the import did; the old code comes back only if no candidate can hold it.
      const manual: JsonObject[] = [{
        action: "check_candidates",
        candidates: json(value.candidates),
        hint: `Check group ${groupId} of survey ${surveyId} for a new question with the code ${desiredCode} and delete it by hand.`,
      }];
      if (renamed) {
        if (value.candidates.length === 0) {
          const restored = await rollback();
          manual.push(...restored.manualCleanup);
        } else {
          manual.push({ action: "restore_code", question_id: oldQid, temporary_code: tempCode ?? null, expected_code: oldCode, hint: "After the candidate is deleted, give the old question its code back." });
        }
      }
      throw replaceFailed(`It is unknown whether the replacement question was created: ${cause.message} Nothing was deleted automatically.`, {
        ...base,
        created: "unknown",
        candidates: json(value.candidates),
        rolled_back: false,
        manual_cleanup: json(manual),
        recovery: "Check the candidates and the survey with limesurvey_get_survey_spec before calling the tool again.",
      }, limit);
    }

    // delete_question commits before it answers: an unclear answer may hide a delete that happened.
    if (failedStep === "delete_old_question" && newQid !== undefined && live !== undefined) {
      const probe = await probeOldQuestion(rpc, surveyId, oldQid, tempCode ?? oldCode);
      if (probe === "gone") {
        steps.push({ step: "delete_old_question", old_question_id: oldQid, note: `the answer of delete_question was unclear (${cause.message}), but the old question is gone` });
        return finish(live);
      }
      if (probe === "unknown") {
        throw replaceFailed(`The replacement failed at step "delete_old_question": ${cause.message} NOT ROLLED BACK: the old question may be deleted already, so the new question ${newQid} was kept.`, {
          ...base,
          rolled_back: false,
          manual_cleanup: json([{
            action: "check_questions",
            old_question_id: oldQid,
            new_question_id: newQid,
            hint: `If question ${oldQid} still exists (code ${tempCode ?? oldCode}), delete question ${newQid} and give ${oldQid} the code ${oldCode}; if it is gone, keep ${newQid}.`,
          }]),
          recovery: "Check by hand which of the two questions exists (see manual_cleanup).",
        }, limit);
      }
    }

    const restored = await rollback();
    const rolledBack = restored.manualCleanup.length === 0;
    throw replaceFailed(
      `The replacement failed at step "${failedStep}": ${cause.message} `
        + (rolledBack ? "It was rolled back: the new question is deleted and the old question is unchanged." : "ROLLBACK INCOMPLETE: see details.manual_cleanup."),
      {
        ...base,
        ...(value instanceof ImportFailure ? { created: false } : {}),
        rolled_back: rolledBack,
        manual_cleanup: json(restored.manualCleanup),
        rollback: json(restored.steps),
        recovery: rolledBack
          ? (failedStep === "verify_new_question"
            ? "LimeSurvey stored the end state differently (see differences). Adjust the end state or make the change in the LimeSurvey admin."
            : RECOVERY_RETRY)
          : "Clean up by hand (see manual_cleanup), then call the tool again.",
      },
      limit,
      differences,
    );
  }
}

/** The answer of the tool, every list cut to stay within LIMESURVEY_MAX_RESPONSE_CHARS. */
function questionResult(
  limit: Limit,
  lists: { changes: Change[]; risks: Risk[]; warnings: SpecWarning[]; differences: SpecDifference[] },
  head: JsonObject,
  verification?: JsonObject,
): JsonValue {
  type Others = { changes: Change[]; warnings: SpecWarning[]; differences: SpecDifference[] };
  const others: Others = { changes: lists.changes, warnings: lists.warnings, differences: lists.differences };
  const build = (cut: Others, risks: JsonObject[]): JsonValue => ({
    ...head,
    changes: json(cut.changes),
    changes_total: lists.changes.length,
    risks: json(risks),
    ...(verification !== undefined
      ? {
        verification: {
          ...verification,
          ok: verification.ok === true && lists.differences.length === 0,
          differences: json(cut.differences),
          differences_total: lists.differences.length,
          truncated: cut.differences.length < lists.differences.length,
        },
      }
      : {}),
    ...(lists.warnings.length > 0 ? { warnings: json(cut.warnings), warnings_total: lists.warnings.length } : {}),
    truncated: cut.changes.length < lists.changes.length || risks.length < lists.risks.length || locationsCut(risks)
      || cut.warnings.length < lists.warnings.length || cut.differences.length < lists.differences.length,
  });
  const fits = (value: JsonValue): boolean => structuredSize(limit.workflow, value) <= limit.maxChars;
  const othersFor = (risks: JsonObject[]): Others => capLists<Others>(others, (shown) => fits(build(shown, risks)));
  // The locations of the risks are cut before the risks themselves.
  const risks = fitRisks(lists.risks, (shown) => fits(build(othersFor(shown), shown)));
  return build(othersFor(risks), risks);
}

export async function updateQuestionFromSpec(context: UpdateContext, input: UpdateQuestionInput): Promise<JsonValue> {
  const limit: Limit = { workflow: "update_question_from_spec", maxChars: context.config.maxResponseChars };
  const { rpc } = context;
  const { survey_id: surveyId, question_id: questionId } = input;
  const dryRun = input.dry_run === true;
  const desiredSpec = plain(input.question);
  const desiredInput = isRecord(desiredSpec) ? desiredSpec : {};

  // 1. The spec alone, before anything is read (a data URI is a risk of this tool, not a spec error).
  const local = validateSpec("question", desiredSpec, { allowDataUri: true });
  if (!local.valid) throw specInvalidError(local.errors, limit);

  // 2. The survey and the question as they are now (read methods only).
  const outline = await readSurveyOutline(rpc, surveyId, { gaps: true });
  const read = await readSurveySpec(rpc, surveyId, { questionId });
  const languages = read.languages;
  const groupIndex = read.layout.groups.findIndex((group) => group.questions.some((item) => item.question_id === questionId));
  const layoutGroup = read.layout.groups[groupIndex];
  const position = (layoutGroup?.questions ?? []).findIndex((item) => item.question_id === questionId) + 1;
  const current = read.spec.groups[0]?.questions[0];
  const raw = read.raw.groups[0]?.questions[0];
  const before = outline.groups.find((group) => group.group_id === layoutGroup?.group_id)?.questions;
  if (!layoutGroup || !current || !raw || !before || position < 1) {
    throw new LimeSurveyError(`Question ${questionId} could not be read from survey ${surveyId}.`, "UNEXPECTED_RESPONSE", {
      survey_id: surveyId,
      question_id: questionId,
      recovery: "Read the question with limesurvey_get_survey_spec (survey_id and question_id) to see whether LimeSurvey reports it, then "
        + "call the tool again.",
    });
  }
  const groupId = layoutGroup.group_id;
  const currentFingerprint = fingerprint(current);
  const prefix = `groups[${groupIndex}].questions[${position - 1}].`;
  const relative = (items: ReadonlyArray<{ path: string; language: string }>): Array<{ path: string; language: string }> => items
    .filter((item) => item.path.startsWith(prefix))
    .map((item) => ({ path: item.path.slice(prefix.length), language: item.language }));
  const ownGaps = relative(read.missing_translations);
  // Texts that exist but cannot be read in a language (no text row there): answer texts and language-dependent attributes
  // (reported at the path attributes, which stands for every attribute that is a map).
  const unreadable = relative(read.unreadable);
  const unreadablePaths = unreadable.flatMap((item) => (item.path === "attributes"
    ? Object.entries(current.attributes).filter(([, value]) => typeof value !== "string").map(([name]) => `attributes.${name}`)
    : [item.path]));

  // 3. The spec against the survey: its languages, the codes of the other questions, the generation for a Ranking question.
  const ranking = current.type === "R" || desiredInput.type === "R";
  const generation = ranking ? await limeSurveyGeneration(rpc, context.client) : undefined;
  const validation = validateSpec("question", desiredSpec, {
    languages,
    existingQuestionCodes: outline.questionCodes.filter((code) => code.toLowerCase() !== current.code.toLowerCase()),
    allowDataUri: true,
    subsetPaths: new Set([...ownGaps.map((item) => item.path), ...unreadablePaths]),
    ...(generation !== undefined ? { rankingGeneration: generation } : {}),
  });
  if (!validation.valid) throw specInvalidError(validation.errors, limit);

  // 4. What changes, and how it can be written.
  const desired = normalQuestion(desiredSpec, languages, false);
  if (!desired) throw specInvalidError([{ path: "(spec)", message: "The question spec is empty.", fix: "Give the end state of the question." }], limit);
  const changes: Change[] = questionDifferences(read.spec.survey, current, desired)
    .map((item) => ({ path: item.path, kind: kindOf(item.path), current: item.expected, desired: item.actual }));
  const mode = modeOf(changes);
  const active = read.active;
  const rejected = active && (mode === "replace" || mode === "columns");

  if (!dryRun && input.expected_fingerprint !== currentFingerprint) throw staleSpec(input.expected_fingerprint, currentFingerprint);
  if (rejected && !dryRun) {
    const blocked = changes.filter((item) => item.kind !== "text");
    throw cappedError(
      limit,
      `Survey ${surveyId} is active: only question, help and subquestion texts can change, but the end state also changes `
        + `${blocked.length} column or structure value${blocked.length === 1 ? "" : "s"}. Nothing was written.`,
      "SURVEY_ACTIVE",
      { changes: blocked },
      (cut) => ({
        survey_id: surveyId,
        question_id: questionId,
        ...cutList("changes", cut.changes, blocked),
        recovery: "Change only the texts (answer texts and attributes cannot be written by RemoteControl at an active survey), or "
          + "work on an inactive copy (limesurvey_copy_survey) or deactivate the survey in the LimeSurvey admin.",
      }),
    );
  }

  const { risks, notes } = rejected
    ? { risks: [] as Risk[], notes: [] as string[] }
    : await questionRisks({
      rpc,
      surveyId,
      questionId,
      groupId,
      mode,
      changes,
      current,
      raw,
      desired,
      outline,
      languages,
      ownGaps,
      unreadable,
      generation: () => limeSurveyGeneration(rpc, context.client),
    });
  const columns = [...new Set(changes.filter((item) => item.kind === "column").map((item) => item.path.split(".")[0] ?? ""))];
  const plan = [...planFor(rejected ? "rejected" : mode, {
    questionId,
    groupId,
    position,
    rename: desired.code.toLowerCase() === current.code.toLowerCase(),
    columns,
    changes,
  }), ...notes.map((note) => `Note: ${note}`)];
  const head: JsonObject = {
    survey_id: surveyId,
    question_id: questionId,
    survey_active: active,
    mode: rejected ? "rejected" : mode,
    plan,
    fingerprint: currentFingerprint,
  };
  const lists = { changes, risks, warnings: validation.warnings, differences: [] as SpecDifference[] };
  if (dryRun) return questionResult(limit, lists, head);
  if (mode === "none") return questionResult(limit, lists, { ...head, applied: false }, { ok: true });

  // 5. Risks that are not acknowledged stop the call before anything is written.
  const acknowledged = new Set<string>(input.acknowledge ?? []);
  const blocking = risks.filter((risk) => risk.blocking && (!risk.acknowledgeable || !acknowledged.has(acknowledgementOf(risk.code))));
  if (blocking.length > 0) {
    const message = `The change is blocked by ${blocking.map((risk) => risk.code).join(", ")}. Nothing was written.`;
    const details = (shown: JsonObject[]): JsonObject => ({
      survey_id: surveyId,
      question_id: questionId,
      mode,
      blocking: blocking.map((risk) => risk.code),
      risks: json(shown),
      risks_total: risks.length,
      truncated: shown.length < risks.length || locationsCut(shown),
      recovery: "Read the risks. An acknowledgeable risk is confirmed with acknowledge (translation_gaps and unreadable_texts with "
        + "fill_translation_gaps); a risk that is not acknowledgeable has to be resolved first (see its detail and locations).",
    });
    const shown = fitRisks(risks, (cut) => (
      structuredSize(limit.workflow, { status: "error", message, code: "UPDATE_QUESTION_BLOCKED", details: details(cut) }) <= limit.maxChars
    ));
    throw new LimeSurveyError(message, "UPDATE_QUESTION_BLOCKED", details(shown));
  }

  if (mode === "replace") {
    const desiredCode = desired.code;
    const writeSpec = replacementSpec(desiredInput, current, raw, languages);
    const lsq = generateQuestionLsq(writeSpec, { languages, ranking: generation === 7 ? "subquestions" : "answers", raw: true });
    const outcome = await runReplacement(context, {
      surveyId,
      groupId,
      oldQid: questionId,
      oldCode: current.code,
      desiredCode,
      before,
      target: position,
      lsq,
      mandatory: desired.mandatory === "soft" ? "S" : desired.mandatory ? "Y" : "N",
      expectedInput: writeSpec,
      survey: read.spec.survey,
      languages,
      outline,
    }, limit);
    let positionMatches = false;
    try {
      const expected = before.map((item) => (item.question_id === questionId ? outcome.newQid : item.question_id));
      const actual = (await questionSequence(rpc, surveyId, groupId)).map((item) => item.question_id);
      positionMatches = actual.length === expected.length && actual.every((qid, index) => qid === expected[index]);
    } catch {
      positionMatches = false;
    }
    const newQuestion = outcome.live.spec.groups[0]?.questions[0];
    const gaps = outline.gaps.filter((gap) => gap.question_id !== questionId);
    return questionResult(limit, lists, {
      ...head,
      question_id: outcome.newQid,
      old_question_id: questionId,
      applied: true,
      fingerprint: newQuestion ? fingerprint(newQuestion) : null,
      steps: json(outcome.steps),
      side_effects: gaps.length + ownGaps.length > 0
        ? [{ kind: "translations_filled_from_base", gaps_total: gaps.length + ownGaps.length }]
        : [],
      notes: "The question has a new ID. URL parameter assignments, archived response columns and quota memberships of the old "
        + "ID are gone; set them again in the LimeSurvey admin if the survey used them.",
    }, { ok: positionMatches, position_matches: positionMatches });
  }

  // texts and columns: written in place on the same question.
  const failure = (step: string, value: unknown, rolledBack: boolean, manualCleanup: JsonObject[]): LimeSurveyError => {
    const cause = describeError(value);
    const message = `Changing question ${questionId} failed at step "${step}": ${cause.message} `
      + (rolledBack ? "The old values were written back." : "ROLLBACK INCOMPLETE: see details.manual_cleanup.");
    const details = (cleanup: JsonObject[]): JsonObject => ({
      failed_step: step,
      ...(cause.code !== undefined ? { cause_code: cause.code } : {}),
      ...(cause.details !== undefined ? { cause: cause.details } : {}),
      question_id: questionId,
      rolled_back: rolledBack,
      manual_cleanup: json(cleanup),
      recovery: rolledBack ? RECOVERY_RETRY : "Write the values of manual_cleanup back in the LimeSurvey admin (or check the question), then call the tool again.",
    });
    const fits = (cleanup: JsonObject[]): boolean => (
      structuredSize(limit.workflow, { status: "error", message, code: "UPDATE_QUESTION_FAILED", details: details(cleanup) }) <= limit.maxChars
    );
    return new LimeSurveyError(message, "UPDATE_QUESTION_FAILED", details(fitCleanup(manualCleanup, fits)));
  };
  const ids = changes.some((item) => item.kind === "text" && item.path.startsWith("subquestions"))
    ? await subquestionIds(rpc, surveyId, groupId, questionId)
    : new Map<string, number>();
  const texts = textWrites({ changes, questionId, raw, current, desiredInput, subquestionIds: ids, languages });
  const columnData: JsonObject = {};
  const columnUndo: JsonObject = {};
  if (columns.length > 0) {
    const properties = columns.map((name) => COLUMN_PROPERTIES[name] ?? name);
    const stored = objectOf(await rpc.call("get_question_properties", [questionId, properties])) ?? {};
    for (const name of columns) {
      const property = COLUMN_PROPERTIES[name] ?? name;
      columnData[property] = columnValue(name, desired);
      columnUndo[property] = stored[property] ?? "";
    }
  }
  // Each undo is registered before its write: a write that fails may have saved a part (LimeSurvey saves field by
  // field), so the failed write is reset as well, with the stored values of the fields it sent. Each undo carries the
  // checks that tell, after reading the question back, whether the old value is really there again.
  interface Undo {
    run: () => Promise<void>;
    checks: Array<{ entry: JsonObject; restored: (back: ComparableQuestion) => boolean }>;
  }
  const field = (question: ComparableQuestion, name: string): unknown => (question as unknown as Record<string, unknown>)[name];
  const textChecks = (write: TextWrite): Undo["checks"] => Object.entries(objectOf(write.undo.questionl10ns) ?? {}).flatMap(([language, old]) => (
    Object.entries(objectOf(old) ?? {}).map(([name, value]) => {
      const specField = name === "help" ? "help" : "text";
      const sub = write.sub;
      return {
        entry: {
          action: "restore_text",
          question_id: write.qid,
          ...(sub !== undefined ? { subquestion: sub.slice(sub.indexOf(":") + 1) } : {}),
          language,
          field: name,
          value,
        },
        restored: (back: ComparableQuestion): boolean => {
          if (sub === undefined) return ((field(back, specField) as TextMap)[language] ?? "") === ((field(current, specField) as TextMap)[language] ?? "");
          const before = current.subquestions.find((item) => itemKey(item) === sub);
          const after = back.subquestions.find((item) => itemKey(item) === sub);
          return (after?.text[language] ?? "") === (before?.text[language] ?? "");
        },
      };
    })
  ));
  const undo: Undo[] = [];
  let step = "columns";
  try {
    if (columns.length > 0) {
      undo.push({
        run: () => setQuestion(rpc, questionId, columnUndo),
        checks: columns.map((name) => ({
          entry: { action: "restore_column", question_id: questionId, field: COLUMN_PROPERTIES[name] ?? name, value: columnUndo[COLUMN_PROPERTIES[name] ?? name] ?? null },
          restored: (back: ComparableQuestion) => canonicalJson(field(back, name)) === canonicalJson(field(current, name)),
        })),
      });
      await setQuestion(rpc, questionId, columnData);
    }
    step = "texts";
    for (const write of texts) {
      undo.push({ run: () => writeTexts(rpc, write.qid, write.undo), checks: textChecks(write) });
      await writeTexts(rpc, write.qid, write.data);
    }
  } catch (value) {
    const failed: string[] = [];
    for (const action of [...undo].reverse()) {
      try {
        await action.run();
      } catch (undoError) {
        failed.push(causeOf(undoError));
      }
    }
    // The rollback counts only when the question, read back, holds the old values again.
    let back: ComparableQuestion | undefined;
    try {
      back = (await readSurveySpec(rpc, surveyId, { questionId })).spec.groups[0]?.questions[0];
    } catch {
      back = undefined;
    }
    const checks = undo.flatMap((action) => action.checks);
    const open = checks.filter((check) => back === undefined || !check.restored(back)).map((check) => check.entry);
    const reasons = [...failed, ...(back === undefined ? ["the question could not be read back after the rollback"] : [])];
    const manualCleanup = open.map((entry) => (reasons.length > 0 ? { ...entry, reason: reasons.join("; ") } : entry));
    throw failure(step, value, open.length === 0 && back !== undefined, manualCleanup);
  }
  let live: SpecRead;
  try {
    live = await readSurveySpec(rpc, surveyId, { questionId });
  } catch (value) {
    throw verifyReadFailed(`Question ${questionId}`, value, { question_id: questionId, mode });
  }
  const differences = verifyDifferences(read.spec.survey, desiredSpec, live, languages);
  const after = live.spec.groups[0]?.questions[0];
  return questionResult(limit, { ...lists, differences }, {
    ...head,
    applied: true,
    fingerprint: after ? fingerprint(after) : null,
  }, { ok: true });
}

// ================================================================ GEN-F: update_survey_texts

type TextValue = string | Record<string, string>;

export interface SurveyTextsInput {
  survey_id: number;
  texts: {
    survey?: { title?: TextValue | undefined; description?: TextValue | undefined; welcometext?: TextValue | undefined; endtext?: TextValue | undefined } | undefined;
    groups?: Array<{ group_id: number; title?: TextValue | undefined; description?: TextValue | undefined }> | undefined;
    questions?: Array<{
      code: string;
      text?: TextValue | undefined;
      help?: TextValue | undefined;
      subquestions?: Array<{ code: string; scale_id?: 0 | 1 | undefined; text: TextValue }> | undefined;
      answers?: unknown;
      attributes?: unknown;
    }> | undefined;
  };
  dry_run?: boolean | undefined;
  expected_fingerprint?: string | undefined;
}

type RowKind = "survey" | "group" | "question";

interface RowRef {
  kind: RowKind;
  /** sid, gid or qid. */
  id: number;
  language: string;
}

/** One text the call sets: where it is in the input, which row and field of LimeSurvey it is, and its values. */
interface TextEntry {
  path: string;
  language: string;
  row: RowRef;
  field: string;
  /** For a question row: whether it is a subquestion (only its question text is written). */
  sub: boolean;
  desired: string;
  current: string | null;
}

type Row = Record<string, string | null>;

const SURVEY_TEXT_FIELDS: Readonly<Record<string, string>> = {
  title: "surveyls_title",
  description: "surveyls_description",
  welcometext: "surveyls_welcometext",
  endtext: "surveyls_endtext",
};

/** The whole survey language row that a save validates: every text column and attachments, never a password field. */
const SURVEY_ROW_FIELDS: readonly string[] = [...SURVEY_REFERENCE_FIELDS, "surveyls_attributecaptions", "surveyls_alias", "attachments"];

/** Mail templates LimeSurvey fills with its default texts when a row with an empty one is saved (lsdefault). */
const MAIL_TEMPLATE_FIELDS: readonly string[] = SURVEY_REFERENCE_FIELDS.filter((field) => /email/.test(field));

const QUESTION_ROW_FIELDS: readonly string[] = ["question", "help", "script"];

const rowKey = (row: RowRef): string => `${row.kind}:${row.id}:${row.language}`;

function isMissingRow(error: unknown): boolean {
  return error instanceof LimeSurveyError && (error.code === "ERR_INVALID_QUESTION" || /invalid questionid/i.test(error.message));
}

/** Reads the rows (each once): survey language rows, group rows per language and question rows. undefined = no row. */
async function readRows(rpc: RpcClient, surveyId: number, refs: readonly RowRef[]): Promise<Map<string, Row | undefined>> {
  const unique = [...new Map(refs.map((ref) => [rowKey(ref), ref] as const)).values()];
  const rows = new Map<string, Row | undefined>();
  const toRow = (value: JsonValue | undefined, fields: readonly string[]): Row => Object.fromEntries(fields.map((field) => [field, textOf(objectOf(value)?.[field])]));
  const groupLanguages = [...new Set(unique.filter((ref) => ref.kind === "group").map((ref) => ref.language))];
  const groupLists = await mapLimit(groupLanguages, PARALLEL_READS, async (language) => rowsOf(await rpc.call("list_groups", [surveyId, language])));
  groupLanguages.forEach((language, index) => {
    for (const ref of unique.filter((item) => item.kind === "group" && item.language === language)) {
      const found = (groupLists[index] ?? []).find((row) => integer(row.gid) === ref.id);
      rows.set(rowKey(ref), found === undefined || textOf(found.group_name) === null ? undefined : toRow(found, ["group_name", "description"]));
    }
  });
  const others = unique.filter((ref) => ref.kind !== "group");
  const results = await mapLimit(others, PARALLEL_READS, async (ref): Promise<Row | undefined> => {
    if (ref.kind === "survey") {
      const row = toRow(await rpc.call("get_language_properties", [surveyId, [...SURVEY_ROW_FIELDS], ref.language]), SURVEY_ROW_FIELDS);
      return row.surveyls_title === null ? undefined : row;
    }
    try {
      return toRow(await rpc.call("get_question_properties", [ref.id, [...QUESTION_ROW_FIELDS], ref.language]), QUESTION_ROW_FIELDS);
    } catch (error) {
      if (isMissingRow(error)) return undefined;
      throw error;
    }
  });
  others.forEach((ref, index) => rows.set(rowKey(ref), results[index]));
  return rows;
}

const describeRow = (row: RowRef, labels: Map<string, string>): string => labels.get(`${row.kind}:${row.id}`) ?? `${row.kind} ${row.id}`;

export async function updateSurveyTexts(context: UpdateContext, input: SurveyTextsInput): Promise<JsonValue> {
  const limit: Limit = { workflow: "update_survey_texts", maxChars: context.config.maxResponseChars };
  const { rpc } = context;
  const { survey_id: surveyId, texts } = input;
  const dryRun = input.dry_run === true;

  // 1. Answer texts and attributes have no RemoteControl write: refused before anything is read.
  const notWritable = (texts.questions ?? []).flatMap((question, index) => [
    ...(question.answers !== undefined ? [`questions[${index}].answers`] : []),
    ...(question.attributes !== undefined ? [`questions[${index}].attributes`] : []),
  ]);
  if (notWritable.length > 0) {
    throw new LimeSurveyError(
      `RemoteControl cannot write answer texts or question attributes (${notWritable.join(", ")}). Nothing was written.`,
      "TEXT_NOT_WRITABLE",
      {
        paths: notWritable,
        recovery: "At an inactive survey change answer texts and attributes with limesurvey_update_question_from_spec (it replaces the "
          + "question); at an active survey only the LimeSurvey admin can change them. Send the other texts without answers and "
          + "attributes.",
      },
    );
  }

  // 2. The survey: languages, groups, questions and subquestions (read methods only).
  const properties = objectOf(await rpc.call("get_survey_properties", [surveyId, ["language", "additional_languages", "active"]])) ?? {};
  const base = asString(properties.language).trim();
  if (base === "") {
    // Without the base language no text can be placed; it is never guessed.
    throw new LimeSurveyError(`get_survey_properties did not report the base language of survey ${surveyId}. Nothing was written.`, "UNEXPECTED_RESPONSE", {
      survey_id: surveyId,
      answer: json(properties),
      recovery: "Check the survey with limesurvey_get_survey_properties (survey_id, settings [\"language\"]) and the permissions of the "
        + "service account, then call the tool again.",
    });
  }
  const languages = [base, ...asString(properties.additional_languages).split(/[\s,;]+/).filter((item) => item !== "" && item !== base)];
  const active = properties.active === "Y";
  const groupRows = rowsOf(await rpc.call("list_groups", [surveyId, base]));
  const questionRows = rowsOf(await rpc.call("list_questions", [surveyId, null, base]));

  const errors: SpecFinding[] = [];
  const entries: TextEntry[] = [];
  const labels = new Map<string, string>([[`survey:${surveyId}`, "survey"]]);
  const addTexts = (path: string, value: TextValue | undefined, row: Omit<RowRef, "language">, field: string, sub: boolean): void => {
    if (value === undefined) return;
    let map: Record<string, string>;
    if (typeof value === "string") {
      map = Object.fromEntries(languages.map((language) => [language, value]));
    } else {
      map = value;
      if (Object.keys(map).length === 0) errors.push({ path, message: "The language map is empty.", fix: "Give one string for every language or a map with at least one language." });
    }
    for (const [language, text] of Object.entries(map)) {
      if (!languages.includes(language)) {
        errors.push({
          path: `${path}.${language}`,
          message: `The language ${language} is not a language of the survey (the survey has ${languages.join(", ")}).`,
          fix: `Remove ${JSON.stringify(language)}, or add the language to the survey first.`,
        });
        continue;
      }
      entries.push({ path, language, row: { ...row, language }, field, sub, desired: text, current: null });
    }
  };

  const surveyTexts: Record<string, TextValue | undefined> = texts.survey ?? {};
  for (const [name, field] of Object.entries(SURVEY_TEXT_FIELDS)) {
    addTexts(`survey.${name}`, surveyTexts[name], { kind: "survey", id: surveyId }, field, false);
  }
  const knownGroups = new Set(groupRows.map((row) => integer(row.gid)));
  const foreign = (texts.groups ?? []).filter((group) => !knownGroups.has(group.group_id)).map((group) => group.group_id);
  if (foreign.length > 0) {
    throw new LimeSurveyError(`Group ${foreign.join(", ")} does not belong to survey ${surveyId}. Nothing was written.`, "GROUP_SURVEY_MISMATCH", {
      survey_id: surveyId,
      group_ids: foreign,
      recovery: "Use group IDs of this survey; limesurvey_get_survey_spec lists them (ids.groups).",
    });
  }
  const seenGroups = new Set<number>();
  (texts.groups ?? []).forEach((group, index) => {
    const path = `groups[${index}]`;
    if (seenGroups.has(group.group_id)) errors.push({ path: `${path}.group_id`, message: `Group ${group.group_id} is named twice.`, fix: "Name every group once." });
    seenGroups.add(group.group_id);
    labels.set(`group:${group.group_id}`, `group ${group.group_id}`);
    addTexts(`${path}.title`, group.title, { kind: "group", id: group.group_id }, "group_name", false);
    addTexts(`${path}.description`, group.description, { kind: "group", id: group.group_id }, "description", false);
  });
  const mains = questionRows.filter((row) => (integer(row.parent_qid) ?? 0) === 0);
  const findCode = <T extends JsonObject>(rows: T[], code: string): T[] => {
    const exact = rows.filter((row) => asString(row.title) === code);
    return exact.length > 0 ? exact : rows.filter((row) => asString(row.title).toLowerCase() === code.toLowerCase());
  };
  const seenQuestions = new Set<number>();
  (texts.questions ?? []).forEach((question, index) => {
    const path = `questions[${index}]`;
    const main = findCode(mains, question.code)[0];
    const qid = integer(main?.qid);
    if (main === undefined || qid === undefined) {
      errors.push({ path: `${path}.code`, message: `Survey ${surveyId} has no question with the code ${question.code}.`, fix: "Use a question code of the survey; limesurvey_get_survey_spec lists them." });
      return;
    }
    if (seenQuestions.has(qid)) errors.push({ path: `${path}.code`, message: `The question ${question.code} is named twice.`, fix: "Name every question once." });
    seenQuestions.add(qid);
    labels.set(`question:${qid}`, `question ${asString(main.title)}`);
    addTexts(`${path}.text`, question.text, { kind: "question", id: qid }, "question", false);
    addTexts(`${path}.help`, question.help, { kind: "question", id: qid }, "help", false);
    const subs = questionRows.filter((row) => integer(row.parent_qid) === qid);
    const seenSubs = new Set<number>();
    (question.subquestions ?? []).forEach((sub, subIndex) => {
      const subPath = `${path}.subquestions[${subIndex}]`;
      const found = findCode(subs, sub.code).filter((row) => sub.scale_id === undefined || (integer(row.scale_id) ?? 0) === sub.scale_id);
      const sqid = integer(found[0]?.qid);
      if (found.length !== 1 || sqid === undefined) {
        errors.push(found.length > 1
          ? { path: `${subPath}.scale_id`, message: `The code ${sub.code} exists on both scales of ${question.code}.`, fix: "Give scale_id 0 or 1." }
          : { path: `${subPath}.code`, message: `The question ${question.code} has no subquestion with the code ${sub.code}.`, fix: "Use a subquestion code of the question." });
        return;
      }
      if (seenSubs.has(sqid)) {
        errors.push({ path: `${subPath}.code`, message: `The subquestion ${sub.code} of ${question.code} is named twice.`, fix: "Name every subquestion once." });
        return;
      }
      seenSubs.add(sqid);
      labels.set(`question:${sqid}`, `question ${asString(main.title)}_${asString(found[0]?.title)}`);
      addTexts(`${subPath}.text`, sub.text, { kind: "question", id: sqid }, "question", true);
    });
  });
  if (entries.length === 0 && errors.length === 0) {
    errors.push({ path: "texts", message: "texts names no text to change.", fix: "Give at least one text, for example survey.title or questions[].text." });
  }
  if (errors.length > 0) throw specInvalidError(errors, limit);

  // 3. The rows that are written, as they are now; a data URI anywhere in such a row stops the call.
  const refs = entries.map((entry) => entry.row);
  const before = await readRows(rpc, surveyId, refs);
  for (const entry of entries) entry.current = before.get(rowKey(entry.row))?.[entry.field] ?? null;
  const withDataUri = [
    ...[...new Map(refs.map((ref) => [rowKey(ref), ref] as const)).values()].flatMap((ref) => Object.entries(before.get(rowKey(ref)) ?? {})
      .filter(([, value]) => value !== null && DATA_URI_SOURCE.test(value))
      .map(([field]) => `${describeRow(ref, labels)} (${ref.language}): ${field}`)),
    ...entries.filter((entry) => DATA_URI_SOURCE.test(entry.desired)).map((entry) => `${entry.path} (${entry.language})`),
  ];
  if (withDataUri.length > 0) {
    throw cappedError(limit, "A row this call would save holds an image embedded as a data URI, which LimeSurvey removes whenever it saves the row. Nothing was written.", "DATA_URI_PRESENT", { locations: withDataUri }, (cut) => ({
      ...cutList("locations", cut.locations, withDataUri),
      recovery: "Upload the image to LimeSurvey and link it by URL (or remove it) in the LimeSurvey admin first, then call the tool again.",
    }));
  }

  // 4. The changes and the fingerprint of the texts as they are now.
  const currentFingerprint = fingerprint(entries.map((entry) => ({ path: entry.path, language: entry.language, current: entry.current })));
  if (input.expected_fingerprint !== undefined && input.expected_fingerprint !== currentFingerprint) {
    throw new LimeSurveyError("A text changed since the fingerprint was taken (expected_fingerprint does not match). Nothing was written.", "STALE_SPEC", {
      expected_fingerprint: input.expected_fingerprint,
      current_fingerprint: currentFingerprint,
      recovery: "Run the call with dry_run true again, check the changes and use its fingerprint.",
    });
  }
  const changed = entries.filter((entry) => entry.current === null || normalText(entry.current) !== normalText(entry.desired));
  const changes = changed.map((entry): JsonObject => ({ path: entry.path, language: entry.language, current: entry.current, desired: entry.desired }));
  const surveyLanguagesWritten = [...new Set(changed.filter((entry) => entry.row.kind === "survey").map((entry) => entry.row.language))];
  const sideEffects: JsonObject[] = surveyLanguagesWritten.flatMap((language) => {
    const row = before.get(rowKey({ kind: "survey", id: surveyId, language }));
    const empty = MAIL_TEMPLATE_FIELDS.filter((field) => (row?.[field] ?? "") === "");
    return empty.length === 0 ? [] : [{
      kind: "mail_templates_filled",
      language,
      fields: empty,
      detail: "LimeSurvey fills empty mail templates of a survey language row with its default texts when the row is saved (as the admin does).",
    }];
  });

  type Lists = { changes: JsonObject[]; differences: JsonObject[]; collateral: JsonObject[] };
  const result = (lists: Lists, head: JsonObject, verification: JsonObject | null): JsonValue => {
    const build = (cut: Lists): JsonValue => ({
      survey_id: surveyId,
      survey_active: active,
      ...head,
      changes: json(cut.changes),
      changes_total: lists.changes.length,
      verification: verification === null ? null : {
        ...verification,
        ok: lists.differences.length === 0,
        differences: json(cut.differences),
        differences_total: lists.differences.length,
        truncated: cut.differences.length < lists.differences.length,
      },
      side_effects: json(sideEffects),
      collateral_changes: json(cut.collateral),
      collateral_changes_total: lists.collateral.length,
      truncated: cut.changes.length < lists.changes.length || cut.differences.length < lists.differences.length
        || cut.collateral.length < lists.collateral.length,
    });
    return build(capLists<Lists>(lists, (shown) => structuredSize(limit.workflow, build(shown)) <= limit.maxChars));
  };
  if (dryRun) return result({ changes, differences: [], collateral: [] }, { applied: false, fingerprint: currentFingerprint }, null);
  if (changed.length === 0) return result({ changes, differences: [], collateral: [] }, { applied: false, fingerprint: currentFingerprint }, {});

  // 5. The writes: per survey language, per group, per question row; each remembers what it overwrites.
  interface Write {
    label: string;
    method: "set_language_properties" | "set_group_properties" | "set_question_properties";
    params: JsonValue[];
    undo: JsonValue[];
    /** The fields of the answer that must be true. */
    fields: string[];
  }
  const writes: Write[] = [];
  const stored = (entry: TextEntry, field: string): string => before.get(rowKey(entry.row))?.[field] ?? "";
  for (const language of surveyLanguagesWritten) {
    const own = changed.filter((entry) => entry.row.kind === "survey" && entry.row.language === language);
    const data = Object.fromEntries(own.map((entry) => [entry.field, entry.desired]));
    const undo = Object.fromEntries(own.map((entry) => [entry.field, entry.current ?? ""]));
    writes.push({
      label: `set_language_properties (${language})`,
      method: "set_language_properties",
      params: [surveyId, data, language],
      undo: [surveyId, undo, language],
      fields: Object.keys(data),
    });
  }
  const byRow = (kind: RowKind): Map<number, TextEntry[]> => {
    const map = new Map<number, TextEntry[]>();
    for (const entry of changed.filter((item) => item.row.kind === kind)) map.set(entry.row.id, [...(map.get(entry.row.id) ?? []), entry]);
    return map;
  };
  for (const [gid, own] of byRow("group")) {
    const data: JsonObject = {};
    const undo: JsonObject = {};
    for (const language of [...new Set(own.map((entry) => entry.language))]) {
      const inLanguage = own.filter((entry) => entry.language === language);
      const sample = inLanguage[0] as TextEntry;
      const value = (field: string): string => inLanguage.find((entry) => entry.field === field)?.desired ?? stored(sample, field);
      // Always both texts: the old form with group_name/language would empty the one not given (RR 5.3).
      data[language] = { group_name: value("group_name"), description: value("description") };
      undo[language] = { group_name: stored(sample, "group_name"), description: stored(sample, "description") };
    }
    writes.push({
      label: `set_group_properties (group ${gid})`,
      method: "set_group_properties",
      params: [gid, { questiongroupl10ns: data }],
      undo: [gid, { questiongroupl10ns: undo }],
      fields: [],
    });
  }
  for (const [qid, own] of byRow("question")) {
    const data: JsonObject = {};
    const undo: JsonObject = {};
    const sub = own[0]?.sub === true;
    for (const language of [...new Set(own.map((entry) => entry.language))]) {
      const inLanguage = own.filter((entry) => entry.language === language);
      const sample = inLanguage[0] as TextEntry;
      const value = (field: string): string => inLanguage.find((entry) => entry.field === field)?.desired ?? stored(sample, field);
      data[language] = sub ? { question: value("question") } : { question: value("question"), help: value("help") };
      undo[language] = sub ? { question: stored(sample, "question") } : { question: stored(sample, "question"), help: stored(sample, "help") };
    }
    writes.push({
      label: `set_question_properties (${describeRow({ kind: "question", id: qid, language: base }, labels)})`,
      method: "set_question_properties",
      params: [qid, { questionl10ns: data }],
      undo: [qid, { questionl10ns: undo }],
      fields: [],
    });
  }

  const send = async (method: Write["method"], params: JsonValue[], fields: string[]): Promise<void> => {
    const answer = objectOf(await rpc.call(method, params));
    const key = method === "set_group_properties" ? "questiongroupl10ns" : method === "set_question_properties" ? "questionl10ns" : undefined;
    // set_language_properties answers each field with true; the L10n writes answer per language and field.
    const failed = [
      ...fields.filter((field) => answer?.[field] !== true),
      ...(key !== undefined ? l10nNotSaved(answer, key, objectOf(objectOf(params[1])?.[key]) ?? {}) : []),
    ];
    if (failed.length > 0) {
      throw new LimeSurveyError(`${method} did not save ${failed.join(", ")}: ${JSON.stringify(answer ?? null)}`, "FIELD_SAVE_FAILED", answer ?? null);
    }
  };

  const written: Write[] = [];
  for (const write of writes) {
    try {
      await send(write.method, write.params, write.fields);
      written.push(write);
    } catch (value) {
      // Reset everything this call wrote, the failed write included (it may have saved a part).
      const manualCleanup: JsonObject[] = [];
      for (const done of [...written, write].reverse()) {
        try {
          await send(done.method, done.undo, done.method === "set_language_properties" ? done.fields : []);
        } catch (undoError) {
          manualCleanup.push({ action: "restore", write: done.label, values: json(done.undo[1] ?? null), reason: causeOf(undoError) });
        }
      }
      // The rollback counts only when the rows, read back, hold the old texts again; a text that is not back is named with its old value.
      let restoredRows = false;
      try {
        const now = await readRows(rpc, surveyId, refs);
        const open = changed.filter((entry) => (now.get(rowKey(entry.row))?.[entry.field] ?? "") !== (entry.current ?? ""));
        restoredRows = open.length === 0;
        if (manualCleanup.length === 0) {
          manualCleanup.push(...open.map((entry): JsonObject => ({
            action: "restore_text",
            row: describeRow(entry.row, labels),
            language: entry.language,
            field: entry.field,
            value: entry.current ?? "",
          })));
        }
      } catch {
        restoredRows = false;
      }
      const rolledBack = manualCleanup.length === 0 && restoredRows;
      const cause = describeError(value);
      const message = `Writing the texts failed at "${write.label}": ${cause.message} `
        + (rolledBack ? "Every text this call wrote was reset." : "ROLLBACK INCOMPLETE: see details.manual_cleanup.");
      const details = (cleanup: JsonObject[]): JsonObject => ({
        failed_step: write.label,
        ...(cause.code !== undefined ? { cause_code: cause.code } : {}),
        ...(cause.details !== undefined ? { cause: cause.details } : {}),
        rolled_back: rolledBack,
        manual_cleanup: json(cleanup),
        manual_cleanup_total: manualCleanup.length,
        recovery: rolledBack
          ? "Fix the cause in the message (for example the permission of the service account) and call the tool again."
          : "Write the old values of manual_cleanup back in the LimeSurvey admin (or check the texts there), then call the tool again.",
      });
      const fits = (cleanup: JsonObject[]): boolean => (
        structuredSize(limit.workflow, { status: "error", message, code: "TEXT_UPDATE_FAILED", details: details(cleanup) }) <= limit.maxChars
      );
      throw new LimeSurveyError(message, "TEXT_UPDATE_FAILED", details(fitCleanup(manualCleanup, fits)));
    }
  }

  // 6. Read the rows back: the written texts against the request, the other fields against before.
  let after: Map<string, Row | undefined>;
  try {
    after = await readRows(rpc, surveyId, refs);
  } catch (value) {
    throw verifyReadFailed("The texts", value, { survey_id: surveyId, changes_total: changes.length });
  }
  const differences: JsonObject[] = changed
    .filter((entry) => normalText(after.get(rowKey(entry.row))?.[entry.field] ?? "").trim() !== normalText(entry.desired).trim())
    .map((entry) => ({ path: entry.path, language: entry.language, expected: entry.desired, actual: after.get(rowKey(entry.row))?.[entry.field] ?? null }));
  const writtenFields = new Set(changed.map((entry) => `${rowKey(entry.row)}|${entry.field}`));
  const collateral: JsonObject[] = [...new Map(refs.map((ref) => [rowKey(ref), ref] as const)).values()].flatMap((ref) => {
    const old = before.get(rowKey(ref)) ?? {};
    const now = after.get(rowKey(ref)) ?? {};
    return [...new Set([...Object.keys(old), ...Object.keys(now)])]
      .filter((field) => !writtenFields.has(`${rowKey(ref)}|${field}`) && (old[field] ?? null) !== (now[field] ?? null))
      .map((field) => ({ row: describeRow(ref, labels), language: ref.language, field, before: old[field] ?? null, after: now[field] ?? null }));
  });
  const newFingerprint = fingerprint(entries.map((entry) => ({ path: entry.path, language: entry.language, current: after.get(rowKey(entry.row))?.[entry.field] ?? null })));
  return result({ changes, differences, collateral }, { applied: true, fingerprint: newFingerprint }, {});
}

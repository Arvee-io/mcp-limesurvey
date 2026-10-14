/**
 * Reads a live survey into the comparable spec form (texts as a map per language), with read methods only. Used to
 * verify what an import produced, to answer limesurvey_get_survey_spec and to give validate_spec the facts of the
 * target survey.
 */
import { BASE_THEME_BY_TYPE, I18N_ATTRIBUTES } from "./attribute-defaults.js";
import type { RpcClient } from "./scoped-client.js";
import { normalizeSpec, type AttributeValue, type ComparableSpec, type DefaultValue, type TextMap } from "./spec-compare.js";
import { isRecord, NO_DEFAULT_TYPES } from "./spec-model.js";
import { LimeSurveyError, type JsonValue } from "./types.js";

/**
 * The survey properties the spec covers. A fixed list on purpose: get_survey_properties without a field list also
 * returns secrets (bounceaccountpass, bounceaccountuser, bounceaccounthost, googleanalyticsapikey,
 * tokenencryptionoptions), and the settings outside the spec are not read at all.
 */
export const SPEC_SURVEY_PROPERTIES: readonly string[] = Object.freeze([
  "language", "additional_languages", "active", "expires", "adminemail", "anonymized", "format", "savetimings",
  "template", "datestamp", "ipaddr", "showqnumcode", "showprogress",
]);

export const SPEC_LANGUAGE_PROPERTIES: readonly string[] = Object.freeze([
  "surveyls_title", "surveyls_description", "surveyls_welcometext", "surveyls_endtext",
]);

/** The question columns plus texts, attributes and answer options. Never defaultvalue: 6.17.11 throws once one exists. */
export const SPEC_QUESTION_PROPERTIES: readonly string[] = Object.freeze([
  "qid", "parent_qid", "sid", "gid", "type", "title", "preg", "other", "mandatory", "encrypted", "question_order",
  "scale_id", "same_default", "relevance", "question_theme_name", "modulename", "same_script",
  "question", "help", "script", "attributes", "attributes_lang", "answeroptions", "answeroptions_multiscale",
]);

const PARALLEL_READS = 4;

export interface MissingTranslation {
  path: string;
  language: string;
}

/** A value that exists but could not be read in this language, with the reason. */
export interface UnreadableItem {
  path: string;
  language: string;
  reason: string;
}

/** Where the groups and main questions of the survey are, by id, in the order of the survey. */
export interface SpecLayout {
  groups: Array<{
    group_id: number;
    questions: Array<{ question_id: number; code: string }>;
  }>;
}

/** Restricts a reading to one group (all its questions) or one question; the layout always covers the whole survey. */
export interface ReadScope {
  groupId?: number;
  questionId?: number;
}

export interface SpecRead {
  languages: string[];
  active: boolean;
  /**
   * Comparable form; a language a text lacks is missing from its map and listed in missing_translations. With a scope
   * only the selected group (or the group of the selected question, with that question alone) is in spec.groups;
   * the paths of missing_translations and unreadable are those of the whole survey (groups[1].questions[0].text).
   */
  spec: ComparableSpec;
  /** Texts that have no row in a language (the question text itself, not what hangs on it). */
  missing_translations: MissingTranslation[];
  /** Answer texts and language-dependent attributes that cannot be read because the question has no text row in the language. */
  unreadable: UnreadableItem[];
  layout: SpecLayout;
}

const NO_TEXT_ROW_ANSWERS = "The question has no text row in this language, so get_question_properties fails for it and its answer options cannot be read.";
const NO_TEXT_ROW_ATTRIBUTES = "The question has no text row in this language, so get_question_properties fails for it and its language-dependent attributes cannot be read.";

type Row = Record<string, JsonValue>;

const asRow = (value: JsonValue | undefined): Row | undefined => (isRecord(value) ? (value as Row) : undefined);
const rowsOf = (value: JsonValue): Row[] => (Array.isArray(value) ? value.filter(isRecord).map((item) => item as Row) : []);

function str(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function num(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return fallback;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function splitLanguages(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return value.split(/[\s,;]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item !== "");
  return [];
}

function yesNo(value: JsonValue | undefined, fallback: boolean): boolean | "inherit" {
  if (value === "Y") return true;
  if (value === "N") return false;
  if (value === "I") return "inherit";
  return fallback;
}

/** Runs fn over the items with at most `limit` calls at a time; the results keep the order of the items. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const isMainQuestion = (row: Row): boolean => num(row.parent_qid) === 0;

function isMissingTranslation(error: unknown): boolean {
  return error instanceof LimeSurveyError && (error.code === "ERR_INVALID_QUESTION" || /invalid questionid/i.test(error.message));
}

async function readQuestionProperties(client: RpcClient, qid: string, language: string): Promise<Row | undefined> {
  try {
    return asRow(await client.call("get_question_properties", [Number(qid), [...SPEC_QUESTION_PROPERTIES], language]));
  } catch (error) {
    // A question without a text row in this language answers "Invalid questionid".
    if (isMissingTranslation(error)) return undefined;
    throw error;
  }
}

interface Option {
  code: string;
  scale_id: number;
  order: number;
  answer: string;
  assessment_value: number;
}

function optionsOf(value: JsonValue | undefined, defaultScale: number): Option[] {
  if (value === null || value === undefined || typeof value === "string") return [];
  // Codes 0..n-1 make PHP answer a list instead of an object; the list index is then the code.
  const entries: Array<[string, JsonValue]> = Array.isArray(value)
    ? value.map((item, index): [string, JsonValue] => [String(index), item])
    : Object.entries(value);
  const options: Option[] = [];
  for (const [key, item] of entries) {
    const row = asRow(item);
    if (!row) continue;
    options.push({
      code: str(row.code) || key,
      scale_id: row.scale_id === undefined ? defaultScale : num(row.scale_id),
      order: num(row.order),
      answer: str(row.answer),
      assessment_value: num(row.assessment_value),
    });
  }
  return options;
}

/** Answer options of get_question_properties: flat by code, or (dual scale) by scale and then by code. */
function parseOptions(value: JsonValue | undefined, multiscale: boolean): Option[] {
  if (value === null || value === undefined || typeof value === "string") return [];
  const options = multiscale
    ? (Array.isArray(value)
      ? value.map((inner, index): [string, JsonValue] => [String(index), inner])
      : Object.entries(value)).flatMap(([scale, inner]) => optionsOf(inner, num(scale)))
    : optionsOf(value, 0);
  return options.sort((a, b) => a.scale_id - b.scale_id || a.order - b.order || compareText(a.code, b.code));
}

function attributeValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The default values of one question in one language, as the field map reports them. */
interface FieldDefaults {
  /** The default of the question itself (aid empty). */
  main?: string;
  /** The default of the "Other" option (aid other). */
  other?: string;
  /** The default of a subquestion, by its code (the aid of its field). */
  subs: Map<string, string>;
}

function parseFieldDefaults(fieldmap: JsonValue): Map<string, FieldDefaults> {
  const result = new Map<string, FieldDefaults>();
  const entries = Array.isArray(fieldmap) ? fieldmap : isRecord(fieldmap) ? Object.values(fieldmap as Row) : [];
  for (const entry of entries) {
    const row = asRow(entry);
    if (!row) continue;
    const value = str(row.defaultvalue);
    const qid = str(row.qid);
    if (value === "" || qid === "") continue;
    const target = result.get(qid) ?? { subs: new Map<string, string>() };
    result.set(qid, target);
    const sqid = str(row.sqid);
    const aid = str(row.aid);
    if (sqid !== "" && sqid !== "0") target.subs.set(aid, value);
    else if (aid === "other") target.other = value;
    else if (aid === "") target.main = value;
  }
  return result;
}

/** The default values of a survey in one language: from get_fieldmap, because get_question_properties cannot give them. */
async function readFieldDefaults(client: RpcClient, surveyId: number, language: string): Promise<Map<string, FieldDefaults>> {
  let fieldmap: JsonValue;
  try {
    fieldmap = await client.call("get_fieldmap", [surveyId, language]);
  } catch (error) {
    // A survey without fields answers "Can not obtain field map": it has no default values either.
    if (error instanceof LimeSurveyError && /field ?map/i.test(error.message)) return new Map();
    throw error;
  }
  return parseFieldDefaults(fieldmap);
}

function mismatch(code: string, message: string, details: Record<string, JsonValue>): LimeSurveyError {
  return new LimeSurveyError(message, code, {
    ...details,
    recovery: "Read the survey with survey_id alone: ids lists the group and question IDs of this survey.",
  });
}

/** Reads the survey with get_* and list_* methods only. */
export async function readSurveySpec(client: RpcClient, surveyId: number, scope: ReadScope = {}): Promise<SpecRead> {
  const properties = asRow(await client.call("get_survey_properties", [surveyId, [...SPEC_SURVEY_PROPERTIES]])) ?? {};
  const base = str(properties.language) || "de";
  const languages = [base, ...splitLanguages(properties.additional_languages).filter((language) => language !== base)];
  const missing: MissingTranslation[] = [];
  const unreadable: UnreadableItem[] = [];
  const scoped = scope.groupId !== undefined || scope.questionId !== undefined;

  // Survey texts (not needed to read a group or a question).
  const surveyTexts = { title: {} as TextMap, description: {} as TextMap, welcometext: {} as TextMap, endtext: {} as TextMap };
  if (!scoped) {
    const languageRows = await mapLimit(languages, PARALLEL_READS, async (language) => (
      asRow(await client.call("get_language_properties", [surveyId, [...SPEC_LANGUAGE_PROPERTIES], language]))
    ));
    languages.forEach((language, index) => {
      const row = languageRows[index];
      if (!row || row.surveyls_title === null || row.surveyls_title === undefined) {
        // The row of this language is missing: every text of it is.
        for (const field of ["title", "description", "welcometext", "endtext"]) missing.push({ path: `survey.${field}`, language });
        return;
      }
      surveyTexts.title[language] = str(row.surveyls_title);
      surveyTexts.description[language] = str(row.surveyls_description);
      surveyTexts.welcometext[language] = str(row.surveyls_welcometext);
      surveyTexts.endtext[language] = str(row.surveyls_endtext);
    });
  }

  // Groups and questions of every language.
  const groupLists = await mapLimit(languages, PARALLEL_READS, async (language) => rowsOf(await client.call("list_groups", [surveyId, language])));
  const questionLists = await mapLimit(languages, PARALLEL_READS, async (language) => (
    rowsOf(await client.call("list_questions", [surveyId, null, language]))
  ));
  const baseGroups = [...(groupLists[0] ?? [])].sort((a, b) => (
    num(a.group_order) - num(b.group_order) || compareText(str(a.group_name), str(b.group_name)) || num(a.gid) - num(b.gid)
  ));
  const groupByLanguage = languages.map((_language, index) => new Map((groupLists[index] ?? []).map((row) => [str(row.gid), row] as const)));
  const questionByLanguage = languages.map((_language, index) => new Map((questionLists[index] ?? []).map((row) => [str(row.qid), row] as const)));
  const baseQuestions = questionLists[0] ?? [];
  const mainRows = baseQuestions.filter(isMainQuestion);
  const orderedQuestions = (gid: string): Row[] => mainRows
    .filter((row) => str(row.gid) === gid)
    .sort((a, b) => num(a.question_order) - num(b.question_order) || compareText(str(a.title), str(b.title)));

  const layout: SpecLayout = {
    groups: baseGroups.map((groupRow) => ({
      group_id: num(groupRow.gid),
      questions: orderedQuestions(str(groupRow.gid)).map((row) => ({ question_id: num(row.qid), code: str(row.title) })),
    })),
  };

  // The scope: which group and which question are read. An id of another survey stops here, before any property is read.
  let wantedGroup: string | undefined;
  let wantedQuestion: string | undefined;
  if (scope.questionId !== undefined) {
    const found = mainRows.find((row) => num(row.qid) === scope.questionId);
    if (!found) {
      const isSub = baseQuestions.some((row) => num(row.qid) === scope.questionId);
      throw mismatch(
        "QUESTION_SURVEY_MISMATCH",
        isSub
          ? `Question ${scope.questionId} is a subquestion of survey ${surveyId}; give the ID of its main question.`
          : `Question ${scope.questionId} does not belong to survey ${surveyId}.`,
        { survey_id: surveyId, question_id: scope.questionId },
      );
    }
    wantedQuestion = str(found.qid);
    wantedGroup = str(found.gid);
  } else if (scope.groupId !== undefined) {
    const found = baseGroups.find((row) => num(row.gid) === scope.groupId);
    if (!found) {
      throw mismatch(
        "GROUP_SURVEY_MISMATCH",
        `Group ${scope.groupId} does not belong to survey ${surveyId}.`,
        { survey_id: surveyId, group_id: scope.groupId },
      );
    }
    wantedGroup = str(found.gid);
  }
  const selectedMain = (row: Row): boolean => (
    (wantedGroup === undefined || str(row.gid) === wantedGroup) && (wantedQuestion === undefined || str(row.qid) === wantedQuestion)
  );

  // Properties of every selected main question in every language.
  const selectedRows = mainRows.filter(selectedMain);
  const tasks = selectedRows.flatMap((row) => languages.map((language) => ({ qid: str(row.qid), language })));
  const taskResults = await mapLimit(tasks, PARALLEL_READS, (task) => readQuestionProperties(client, task.qid, task.language));
  const propertiesOf = new Map<string, Row | undefined>(tasks.map((task, index) => [`${task.qid}|${task.language}`, taskResults[index]]));

  // Default values per language.
  const needsDefaults = selectedRows.some((row) => !NO_DEFAULT_TYPES.has(str(row.type)));
  // (Ranking and file upload questions have no default value, so a survey of nothing else needs no field map.)
  const defaultsByLanguage = needsDefaults
    ? await mapLimit(languages, PARALLEL_READS, (language) => readFieldDefaults(client, surveyId, language))
    : languages.map(() => new Map<string, FieldDefaults>());

  const groups = baseGroups.flatMap((groupRow, groupIndex) => {
    const gid = str(groupRow.gid);
    if (wantedGroup !== undefined && gid !== wantedGroup) return [];
    const title: TextMap = {};
    const description: TextMap = {};
    languages.forEach((language, languageIndex) => {
      const row = groupByLanguage[languageIndex]?.get(gid);
      if (!row || row.group_name === null || row.group_name === undefined) {
        // The row of this language is missing: every text of it is.
        missing.push({ path: `groups[${groupIndex}].title`, language }, { path: `groups[${groupIndex}].description`, language });
        return;
      }
      title[language] = str(row.group_name);
      description[language] = str(row.description);
    });

    const questions = orderedQuestions(gid).flatMap((row, questionIndex) => {
      if (!selectedMain(row)) return [];
      const qid = str(row.qid);
      const questionPath = `groups[${groupIndex}].questions[${questionIndex}]`;
      const propsIn = (language: string): Row | undefined => propertiesOf.get(`${qid}|${language}`);
      // Columns, attributes and the answer codes do not depend on the language: the base language gives them, any
      // readable language will do when the base language has no text row for this question.
      const baseProps = propsIn(base) ?? languages.map(propsIn).find((props) => props !== undefined);
      const column = (name: string): JsonValue | undefined => baseProps?.[name] ?? row[name];
      const type = str(column("type"));

      const text: TextMap = {};
      const help: TextMap = {};
      const script: TextMap = {};
      const missingLanguages: string[] = [];
      languages.forEach((language, languageIndex) => {
        const props = propertiesOf.get(`${qid}|${language}`);
        const fallback = questionByLanguage[languageIndex]?.get(qid);
        const question = props?.question ?? fallback?.question;
        if (props === undefined || question === null || question === undefined) {
          missingLanguages.push(language);
          return;
        }
        text[language] = str(question);
        help[language] = str(props.help ?? fallback?.help);
        script[language] = str(props.script);
      });
      // The row of a language is missing: every field of it is (the script only counts when the question has one).
      const hasScript = Object.values(script).some((item) => item !== "");
      for (const language of missingLanguages) {
        missing.push({ path: `${questionPath}.text`, language }, { path: `${questionPath}.help`, language });
        if (hasScript) missing.push({ path: `${questionPath}.script`, language });
      }

      // Attributes that depend on the language are the ones attributes_lang reports: the 16 known ones and any other
      // (a plugin attribute stored per language). The rest, language independent, come with the base language.
      const languageAttributeNames = new Set(languages.flatMap((language) => Object.keys(asRow(propsIn(language)?.attributes_lang) ?? {})));
      const attributes: Record<string, AttributeValue> = {};
      for (const [name, value] of Object.entries(asRow(baseProps?.attributes) ?? {})) {
        if (!I18N_ATTRIBUTES.has(name) && !languageAttributeNames.has(name)) attributes[name] = attributeValue(value);
      }
      const hasLanguageAttributes = languageAttributeNames.size > 0;
      for (const language of languages) {
        const props = propsIn(language);
        if (props === undefined) {
          // Only worth a note when another language of this question has such attributes.
          if (hasLanguageAttributes) unreadable.push({ path: `${questionPath}.attributes`, language, reason: NO_TEXT_ROW_ATTRIBUTES });
          continue;
        }
        for (const [name, value] of Object.entries(asRow(props.attributes_lang) ?? {})) {
          const perLanguage = (attributes[name] ??= {}) as TextMap;
          perLanguage[language] = attributeValue(value);
        }
      }

      const subRows = baseQuestions
        .filter((sub) => !isMainQuestion(sub) && str(sub.parent_qid) === qid)
        .sort((a, b) => num(a.scale_id) - num(b.scale_id) || num(a.question_order) - num(b.question_order) || compareText(str(a.title), str(b.title)));
      const subTexts = (sub: Row, path: string): TextMap => {
        const result: TextMap = {};
        languages.forEach((language, languageIndex) => {
          const subRow = questionByLanguage[languageIndex]?.get(str(sub.qid));
          if (!subRow || subRow.question === null || subRow.question === undefined) {
            missing.push({ path, language });
            return;
          }
          result[language] = str(subRow.question);
        });
        return result;
      };
      const relevanceOf = (item: Row): { relevance?: string } => {
        const relevance = str(item.relevance).trim() || "1";
        return relevance === "1" ? {} : { relevance };
      };

      // Default values: one string with same_default, otherwise a text per language that has one.
      const sameDefault = str(column("same_default")) === "1";
      const defaultsOf = (pick: (entry: FieldDefaults) => string | undefined): DefaultValue | undefined => {
        const perLanguage: TextMap = {};
        languages.forEach((language, languageIndex) => {
          const entry = defaultsByLanguage[languageIndex]?.get(qid);
          const found = entry === undefined ? undefined : pick(entry);
          if (found !== undefined) perLanguage[language] = found;
        });
        const entries = Object.entries(perLanguage);
        if (entries.length === 0) return undefined;
        return sameDefault ? (perLanguage[base] ?? entries[0]?.[1]) : perLanguage;
      };

      // LimeSurvey 7 stores the entries of a Ranking question as subquestions; the spec calls them answers.
      const rankingAsAnswers = type === "R" && subRows.length > 0;
      const subquestions = rankingAsAnswers
        ? []
        : subRows.map((sub, index) => {
          const subDefault = defaultsOf((entry) => entry.subs.get(str(sub.title)));
          return {
            code: str(sub.title),
            text: subTexts(sub, `${questionPath}.subquestions[${index}].text`),
            ...(num(sub.scale_id) === 0 ? {} : { scale_id: num(sub.scale_id) }),
            ...relevanceOf(sub),
            ...(subDefault !== undefined ? { default: subDefault } : {}),
          };
        });

      let answers: Array<Record<string, unknown>>;
      if (rankingAsAnswers) {
        answers = subRows.map((sub, index) => ({
          code: str(sub.title),
          text: subTexts(sub, `${questionPath}.answers[${index}].text`),
          assessment_value: 0,
          ...relevanceOf(sub),
        }));
      } else {
        const multiscale = type === "1";
        const optionsByLanguage = languages.map((language) => new Map(
          parseOptions(propsIn(language)?.answeroptions, multiscale).map((option) => [`${option.scale_id}:${option.code}`, option] as const),
        ));
        // The answers are the union over all languages (an option without a text row in the base language must not
        // vanish); what does not depend on the language comes from the first language that has the option.
        const union = new Map<string, Option>();
        for (const byCode of optionsByLanguage) {
          for (const [key, option] of byCode) if (!union.has(key)) union.set(key, option);
        }
        const unionOptions = [...union.values()].sort(
          (a, b) => a.scale_id - b.scale_id || a.order - b.order || compareText(a.code, b.code),
        );
        answers = unionOptions.map((option, index) => {
          const answerText: TextMap = {};
          languages.forEach((language, languageIndex) => {
            const found = optionsByLanguage[languageIndex]?.get(`${option.scale_id}:${option.code}`);
            if (!found) {
              const path = `${questionPath}.answers[${index}].text`;
              // Without a text row the answers cannot be read at all: that is not a missing answer translation.
              if (propsIn(language) === undefined) unreadable.push({ path, language, reason: NO_TEXT_ROW_ANSWERS });
              else missing.push({ path, language });
              return;
            }
            answerText[language] = found.answer;
          });
          return {
            code: option.code,
            text: answerText,
            assessment_value: option.assessment_value,
            ...(option.scale_id === 0 ? {} : { scale_id: option.scale_id }),
          };
        });
      }

      const mandatory = str(column("mandatory"));
      const hasSubquestions = subRows.length > 0;
      const questionDefault = hasSubquestions || NO_DEFAULT_TYPES.has(type) ? undefined : defaultsOf((entry) => entry.main);
      const otherDefault = !hasSubquestions && (type === "L" || type === "!") && str(column("other")) === "Y"
        ? defaultsOf((entry) => entry.other)
        : undefined;
      return [{
        code: str(column("title")),
        type,
        text,
        help,
        mandatory: mandatory === "Y" ? true : mandatory === "S" ? "soft" : false,
        relevance: str(column("relevance")) || "1",
        other: str(column("other")) === "Y",
        question_theme_name: str(column("question_theme_name")) || (Object.hasOwn(BASE_THEME_BY_TYPE, type) ? BASE_THEME_BY_TYPE[type] : ""),
        attributes,
        subquestions,
        answers,
        preg: str(column("preg")),
        encrypted: str(column("encrypted")) === "Y",
        same_default: sameDefault,
        same_script: str(column("same_script")) === "1",
        modulename: str(column("modulename")),
        script,
        ...(questionDefault !== undefined ? { default: questionDefault } : {}),
        ...(otherDefault !== undefined ? { default_other: otherDefault } : {}),
      }];
    });
    return [{
      title,
      description,
      relevance: str(groupRow.grelevance) || "1",
      randomization_group: str(groupRow.randomization_group),
      questions,
    }];
  });

  const adminemail = str(properties.adminemail);
  const template = str(properties.template);
  const survey = {
    ...surveyTexts,
    language: base,
    additional_languages: languages.slice(1),
    anonymized: yesNo(properties.anonymized, false),
    datestamp: yesNo(properties.datestamp, false),
    ipaddr: yesNo(properties.ipaddr, false),
    savetimings: yesNo(properties.savetimings, false),
    format: str(properties.format) || "G",
    adminemail: adminemail === "inherit" ? "" : adminemail,
    showprogress: yesNo(properties.showprogress, true),
    ...(template !== "" && template !== "inherit" ? { template } : {}),
    showqnumcode: str(properties.showqnumcode) || "X",
    expires: str(properties.expires),
  };

  return {
    languages,
    active: properties.active === "Y",
    spec: normalizeSpec({ survey, groups }, languages),
    missing_translations: missing,
    unreadable,
    layout,
  };
}

/** A main question of a survey outline. */
export interface OutlineQuestion {
  question_id: number;
  code: string;
  order: number;
}

/** A group of a survey outline, with its main questions in their order. */
export interface OutlineGroup {
  group_id: number;
  order: number;
  /** The name in the base language ("" when the group has no text row there). */
  name: string;
  questions: OutlineQuestion[];
}

/** What the add tools need of a survey before they write: structure, codes and ids, and (on request) the translation gaps. */
export interface SurveyOutline {
  languages: string[];
  /** undefined when get_survey_properties does not report it. */
  active: boolean | undefined;
  /** In the order of the survey: groups by (group_order, name, gid), questions by (question_order, code). */
  groups: OutlineGroup[];
  /** The codes of all main questions of the survey. */
  questionCodes: string[];
  /** Every question id (main questions and subquestions) and every group id of the survey. */
  questionIds: Set<number>;
  groupIds: Set<number>;
  /**
   * With options.gaps: the group, question and subquestion texts that have a row in the base language but none in an
   * additional language (paths of the whole survey). fixLanguageConsistency fills exactly these from the base language.
   */
  gaps: MissingTranslation[];
}

const byGroupOrder = (a: Row, b: Row): number => (
  num(a.group_order) - num(b.group_order) || compareText(str(a.group_name), str(b.group_name)) || num(a.gid) - num(b.gid)
);
const byQuestionOrder = (a: Row, b: Row): number => num(a.question_order) - num(b.question_order) || compareText(str(a.title), str(b.title));
const bySubquestionOrder = (a: Row, b: Row): number => num(a.scale_id) - num(b.scale_id) || byQuestionOrder(a, b);

/** Reads the outline of a survey with get_survey_properties, list_groups and list_questions only. */
export async function readSurveyOutline(client: RpcClient, surveyId: number, options: { gaps?: boolean } = {}): Promise<SurveyOutline> {
  const properties = asRow(await client.call("get_survey_properties", [surveyId, ["language", "additional_languages", "active"]])) ?? {};
  const base = str(properties.language) || "de";
  const languages = [base, ...splitLanguages(properties.additional_languages).filter((language) => language !== base)];
  const active = properties.active === "Y" ? true : properties.active === "N" ? false : undefined;
  const listed = options.gaps === true ? languages : [base];
  const groupLists = await mapLimit(listed, PARALLEL_READS, async (language) => rowsOf(await client.call("list_groups", [surveyId, language])));
  const questionLists = await mapLimit(listed, PARALLEL_READS, async (language) => (
    rowsOf(await client.call("list_questions", [surveyId, null, language]))
  ));
  const baseGroups = [...(groupLists[0] ?? [])].sort(byGroupOrder);
  const baseQuestions = questionLists[0] ?? [];
  const mains = baseQuestions.filter(isMainQuestion);
  const mainsOf = (gid: string): Row[] => mains.filter((row) => str(row.gid) === gid).sort(byQuestionOrder);

  const gaps: MissingTranslation[] = [];
  if (options.gaps === true) {
    const groupsIn = listed.map((_language, index) => new Map((groupLists[index] ?? []).map((row) => [str(row.gid), row] as const)));
    const questionsIn = listed.map((_language, index) => new Map((questionLists[index] ?? []).map((row) => [str(row.qid), row] as const)));
    const hasText = (row: Row | undefined, field: string): boolean => row !== undefined && row[field] !== null && row[field] !== undefined;
    /** The additional languages that lack the row of the element, when the base language has it. */
    const lacking = (maps: Array<Map<string, Row>>, id: string, field: string): string[] => (
      hasText(maps[0]?.get(id), field) ? languages.filter((_language, index) => index > 0 && !hasText(maps[index]?.get(id), field)) : []
    );
    baseGroups.forEach((groupRow, groupIndex) => {
      const gid = str(groupRow.gid);
      for (const language of lacking(groupsIn, gid, "group_name")) {
        gaps.push({ path: `groups[${groupIndex}].title`, language }, { path: `groups[${groupIndex}].description`, language });
      }
      mainsOf(gid).forEach((questionRow, questionIndex) => {
        const qid = str(questionRow.qid);
        const path = `groups[${groupIndex}].questions[${questionIndex}]`;
        for (const language of lacking(questionsIn, qid, "question")) gaps.push({ path: `${path}.text`, language }, { path: `${path}.help`, language });
        const subs = baseQuestions.filter((row) => !isMainQuestion(row) && str(row.parent_qid) === qid).sort(bySubquestionOrder);
        // LimeSurvey 7 stores the entries of a Ranking question as subquestions; the spec calls them answers.
        const list = str(questionRow.type) === "R" ? "answers" : "subquestions";
        subs.forEach((sub, subIndex) => {
          for (const language of lacking(questionsIn, str(sub.qid), "question")) gaps.push({ path: `${path}.${list}[${subIndex}].text`, language });
        });
      });
    });
  }

  return {
    languages,
    active,
    groups: baseGroups.map((row) => ({
      group_id: num(row.gid),
      order: num(row.group_order),
      name: str(row.group_name),
      questions: mainsOf(str(row.gid)).map((question) => ({ question_id: num(question.qid), code: str(question.title), order: num(question.question_order) })),
    })),
    questionCodes: mains.map((row) => str(row.title)),
    questionIds: new Set(baseQuestions.map((row) => num(row.qid))),
    groupIds: new Set(baseGroups.map((row) => num(row.gid))),
    gaps,
  };
}

/** What validate_spec needs of a live survey: its languages, groups and the codes of its main questions. */
export interface SurveyContext {
  languages: string[];
  groups: Array<{ group_id: number; title: string }>;
  questionCodes: string[];
}

export async function readSurveyContext(client: RpcClient, surveyId: number): Promise<SurveyContext> {
  const properties = asRow(await client.call("get_survey_properties", [surveyId, ["language", "additional_languages"]])) ?? {};
  const base = str(properties.language) || "de";
  const languages = [base, ...splitLanguages(properties.additional_languages).filter((language) => language !== base)];
  const groups = rowsOf(await client.call("list_groups", [surveyId, base]))
    .sort((a, b) => num(a.group_order) - num(b.group_order) || num(a.gid) - num(b.gid))
    .map((row) => ({ group_id: num(row.gid), title: str(row.group_name) }));
  const questionCodes = rowsOf(await client.call("list_questions", [surveyId, null, base]))
    .filter(isMainQuestion)
    .map((row) => str(row.title));
  return { languages, groups, questionCodes };
}

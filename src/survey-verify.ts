import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { LimeSurveyClient } from "./client.js";
import { LimeSurveyError, type JsonValue } from "./types.js";

/**
 * Comparison of a LimeSurvey structure file (.lss) with the live survey, using read-only RemoteControl calls.
 *
 * Everything is matched by codes (group name and order, question code, subquestion code, answer code, attribute
 * name), never by IDs: IDs change when a survey is imported. The .lss format of LimeSurvey 6 (DB version 6xx) keeps
 * one table per entity (groups, group_l10ns, questions, subquestions, question_l10ns, answers, answer_l10ns,
 * question_attributes); older exports keep the texts in the entity rows (a `language` column), which is tolerated.
 */

export const MAX_DIFFERENCES = 500;
const MAX_VALUE_CHARS = 300;

type Row = Record<string, string>;
type JsonObject = { [key: string]: JsonValue };

const LIMITATIONS = [
  "Not compared: conditions (legacy and scenarios), quotas, assessments, default values, survey settings, theme, and language settings (titles, texts, email templates).",
  "Not compared: answer order, subquestion order, and question types' option layout beyond the attributes RemoteControl reports.",
  "Compared per language: only the language given in `language` (default: the base language of the live survey).",
  "RemoteControl reports defaults for attributes that are not stored. Live attributes missing in the file are therefore only listed when their live value is not empty and not 0; file attributes with an empty value are not reported as missing.",
  "Answer and subquestion counts in the summary cover the questions that exist on both sides.",
  `Values longer than ${MAX_VALUE_CHARS} characters are shortened in the differences list.`,
];

// ---------------------------------------------------------------------------------------------------------
// .lss model

interface LssGroup { gid: string; order: number; name: string; relevance: string }
interface LssSubquestion { title: string; scale: string; text: string }
interface LssAnswer { code: string; scale: string; text: string }
interface LssQuestion {
  qid: string;
  gid: string;
  title: string;
  type: string;
  mandatory: string;
  relevance: string;
  other: string;
  order: number;
  text: string;
  help: string;
  subquestions: LssSubquestion[];
  answers: LssAnswer[];
  attributes: Map<string, string>;
}
interface LssSurvey {
  baseLanguage: string;
  languages: string[];
  language: string;
  groups: LssGroup[];
  questions: LssQuestion[];
}

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const num = (value: unknown): number => {
  const parsed = Number(str(value));
  return Number.isFinite(parsed) ? parsed : 0;
};
const normalize = (value: unknown): string => str(value).replace(/\r\n/g, "\n").trim();
const relevance = (value: unknown): string => {
  const text = normalize(value);
  return text === "" ? "1" : text;
};

function invalid(message: string): LimeSurveyError {
  return new LimeSurveyError(message, "LSS_INVALID", {
    recovery: "Pass a LimeSurvey survey structure file (.lss) exported from the admin UI (Display/Export > Survey structure).",
  });
}

function parseXml(xml: string): Record<string, unknown> {
  if (XMLValidator.validate(xml) !== true) throw invalid("The file is not well-formed XML.");
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (_name, jpath) => typeof jpath === "string" && (jpath.endsWith(".row") || jpath === "document.languages.language"),
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const document = parsed.document;
  if (document === null || typeof document !== "object") throw invalid("The file has no <document> root element and is not a LimeSurvey structure file.");
  return document as Record<string, unknown>;
}

function rowsOf(document: Record<string, unknown>, section: string): Row[] {
  const node = document[section];
  if (node === null || typeof node !== "object") return [];
  const rows = (node as { rows?: { row?: unknown } }).rows?.row;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Row => row !== null && typeof row === "object");
}

/** Keeps a row when it has no language column (LimeSurvey 6) or the language matches (older exports). */
const inLanguage = (row: Row, language: string): boolean => row.language === undefined || str(row.language) === "" || str(row.language) === language;

export function parseLss(xml: string, requestedLanguage: string | undefined): LssSurvey {
  const document = parseXml(xml);
  if (document.LimeSurveyDocType !== undefined && str(document.LimeSurveyDocType) !== "Survey") {
    throw invalid(`The file is a LimeSurvey "${str(document.LimeSurveyDocType)}" file, not a survey structure.`);
  }
  if (rowsOf(document, "groups").length === 0 && rowsOf(document, "questions").length === 0 && document.LimeSurveyDocType === undefined) {
    throw invalid("The file contains no groups and no questions.");
  }

  const languageNode = (document.languages as { language?: unknown } | undefined)?.language;
  const languages = Array.isArray(languageNode) ? languageNode.map(str).filter((item) => item !== "") : [];
  const surveyRow = rowsOf(document, "surveys")[0];
  const baseLanguage = str(surveyRow?.language) || languages[0] || "";
  const language = requestedLanguage ?? baseLanguage;
  if (languages.length > 0 && !languages.includes(language)) {
    throw new LimeSurveyError(
      `The file has no language "${language}" (it has: ${languages.join(", ")}).`,
      "LSS_LANGUAGE_NOT_FOUND",
      { available_languages: languages },
    );
  }

  const groupL10n = rowsOf(document, "group_l10ns").filter((row) => str(row.language) === language);
  const groups = rowsOf(document, "groups")
    .filter((row) => inLanguage(row, language))
    .map((row): LssGroup => ({
      gid: str(row.gid),
      order: num(row.group_order),
      name: normalize(groupL10n.find((item) => str(item.gid) === str(row.gid))?.group_name ?? row.group_name),
      relevance: relevance(row.grelevance),
    }))
    .sort((a, b) => a.order - b.order);

  const questionL10n = new Map<string, Row>();
  for (const row of rowsOf(document, "question_l10ns")) {
    if (str(row.language) === language) questionL10n.set(str(row.qid), row);
  }
  const textOf = (row: Row, field: "question" | "help"): string =>
    normalize(questionL10n.get(str(row.qid))?.[field] ?? row[field]);

  const answerL10n = new Map<string, Row>();
  for (const row of rowsOf(document, "answer_l10ns")) {
    if (str(row.language) === language) answerL10n.set(str(row.aid), row);
  }
  const answersByQid = new Map<string, LssAnswer[]>();
  for (const row of rowsOf(document, "answers").filter((item) => inLanguage(item, language))) {
    const list = answersByQid.get(str(row.qid)) ?? [];
    list.push({
      code: str(row.code),
      scale: str(row.scale_id) || "0",
      text: normalize(answerL10n.get(str(row.aid))?.answer ?? row.answer),
    });
    answersByQid.set(str(row.qid), list);
  }

  const subsByParent = new Map<string, LssSubquestion[]>();
  const subRows = [
    ...rowsOf(document, "subquestions"),
    // Some older exports keep subquestions in the questions table with a parent_qid.
    ...rowsOf(document, "questions").filter((row) => str(row.parent_qid) !== "" && str(row.parent_qid) !== "0"),
  ];
  for (const row of subRows.filter((item) => inLanguage(item, language))) {
    const list = subsByParent.get(str(row.parent_qid)) ?? [];
    list.push({ title: str(row.title), scale: str(row.scale_id) || "0", text: textOf(row, "question") });
    subsByParent.set(str(row.parent_qid), list);
  }

  const attributesByQid = new Map<string, Map<string, string>>();
  const attributeRows = rowsOf(document, "question_attributes");
  // Rows without a language first, then the rows of the chosen language, which win on a conflict.
  for (const row of [...attributeRows.filter((item) => str(item.language) === ""), ...attributeRows.filter((item) => str(item.language) === language)]) {
    const map = attributesByQid.get(str(row.qid)) ?? new Map<string, string>();
    map.set(str(row.attribute), normalize(row.value));
    attributesByQid.set(str(row.qid), map);
  }

  const questions = rowsOf(document, "questions")
    .filter((row) => (str(row.parent_qid) === "" || str(row.parent_qid) === "0") && inLanguage(row, language))
    .map((row): LssQuestion => ({
      qid: str(row.qid),
      gid: str(row.gid),
      title: str(row.title),
      type: str(row.type),
      mandatory: normalize(row.mandatory) || "N",
      relevance: relevance(row.relevance),
      other: normalize(row.other) || "N",
      order: num(row.question_order),
      text: textOf(row, "question"),
      help: textOf(row, "help"),
      subquestions: subsByParent.get(str(row.qid)) ?? [],
      answers: answersByQid.get(str(row.qid)) ?? [],
      attributes: attributesByQid.get(str(row.qid)) ?? new Map<string, string>(),
    }));

  return { baseLanguage, languages, language, groups, questions };
}

// ---------------------------------------------------------------------------------------------------------
// live model

interface LiveGroup { gid: string; order: number; name: string; relevance: string }
interface LiveQuestion {
  qid: string;
  gid: string;
  title: string;
  order: number;
}
interface LiveSub { parent: string; title: string; scale: string; text: string }

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function liveAnswers(value: JsonValue | undefined): LssAnswer[] {
  if (!isObject(value)) return [];
  const answers: LssAnswer[] = [];
  const isLeaf = (item: JsonValue | undefined): item is JsonObject => isObject(item) && typeof item.answer === "string";
  for (const [key, item] of Object.entries(value)) {
    if (isLeaf(item)) {
      answers.push({ code: key, scale: str(item.scale_id) || "0", text: normalize(item.answer) });
    } else if (isObject(item)) {
      // Dual-scale questions: { scale_id: { code: { code, answer, scale_id, ... } } }
      for (const [code, inner] of Object.entries(item)) {
        if (isLeaf(inner)) answers.push({ code, scale: str(inner.scale_id) || key, text: normalize(inner.answer) });
      }
    }
  }
  return answers;
}

function liveAttributes(properties: JsonObject): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of ["attributes", "attributes_lang"]) {
    const value = properties[key];
    if (isObject(value)) for (const [name, item] of Object.entries(value)) map.set(name, normalize(item));
  }
  return map;
}

// ---------------------------------------------------------------------------------------------------------
// comparison

export interface Difference {
  kind: string;
  group: string | null;
  question: string | null;
  item: string | null;
  field: string | null;
  lss: JsonValue;
  live: JsonValue;
}

const shorten = (value: string): string =>
  value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}... (${value.length} characters)` : value;

/** Items of `a` that are not part of the longest common subsequence of `a` and `b` (both hold the same items). */
function outOfOrder(a: string[], b: string[]): string[] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      (table[i] as number[])[j] = a[i] === b[j]
        ? ((table[i + 1] as number[])[j + 1] as number) + 1
        : Math.max((table[i + 1] as number[])[j] as number, (table[i] as number[])[j + 1] as number);
    }
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(a[i] as string);
      i += 1;
      j += 1;
    } else if (((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return a.filter((item) => !kept.has(item));
}

class Collector {
  readonly differences: Difference[] = [];
  readonly counts: Record<string, number> = {};
  total = 0;

  add(kind: string, parts: Partial<Omit<Difference, "kind">>): void {
    this.total += 1;
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    if (this.differences.length >= MAX_DIFFERENCES) return;
    this.differences.push({
      kind,
      group: parts.group ?? null,
      question: parts.question ?? null,
      item: parts.item ?? null,
      field: parts.field ?? null,
      lss: parts.lss === undefined || parts.lss === null ? null : typeof parts.lss === "string" ? shorten(parts.lss) : parts.lss,
      live: parts.live === undefined || parts.live === null ? null : typeof parts.live === "string" ? shorten(parts.live) : parts.live,
    });
  }

  count(prefix: string): number {
    return Object.entries(this.counts).filter(([kind]) => kind.startsWith(prefix)).reduce((sum, [, value]) => sum + value, 0);
  }
}

const QUESTION_PROPERTIES = ["title", "question", "help", "type", "mandatory", "relevance", "other", "attributes", "attributes_lang", "answeroptions", "answeroptions_multiscale"];

export async function verifySurveyAgainstLss(
  client: LimeSurveyClient,
  surveyId: number,
  lssFile: string,
  lssXml: string,
  requestedLanguage: string | undefined,
  maxResponseChars: number,
): Promise<JsonValue> {
  // Parse (and validate) the file first: a bad file must fail before any RPC.
  let lss = parseLss(lssXml, requestedLanguage);
  // Without a language, list_groups answers in the survey's base language and names it in each row. That avoids
  // get_survey_properties, which needs surveysettings/read (the other methods only need surveycontent/read).
  const groupRows = await client.call("list_groups", [surveyId, requestedLanguage ?? null]);
  if (requestedLanguage === undefined) {
    const firstRow = (Array.isArray(groupRows) ? groupRows : []).find(isObject);
    const liveLanguage = firstRow?.language;
    if (typeof liveLanguage === "string" && liveLanguage !== "" && liveLanguage !== lss.language) {
      lss = parseLss(lssXml, liveLanguage);
    }
  }
  const useLanguage = lss.language;

  const questionRows = await client.call("list_questions", [surveyId, null, useLanguage]);

  const liveGroups: LiveGroup[] = (Array.isArray(groupRows) ? groupRows : [])
    .filter(isObject)
    .map((row) => ({
      gid: str(row.gid ?? row.id),
      order: num(row.group_order),
      name: normalize(row.group_name),
      relevance: relevance(row.grelevance),
    }))
    .sort((a, b) => a.order - b.order);
  const liveMain: LiveQuestion[] = [];
  const liveSubs: LiveSub[] = [];
  for (const row of (Array.isArray(questionRows) ? questionRows : []).filter(isObject)) {
    const parent = str(row.parent_qid);
    if (parent === "" || parent === "0") {
      liveMain.push({ qid: str(row.qid ?? row.id), gid: str(row.gid), title: str(row.title), order: num(row.question_order) });
    } else {
      liveSubs.push({ parent, title: str(row.title), scale: str(row.scale_id) || "0", text: normalize(row.question) });
    }
  }

  const collector = new Collector();
  const liveGroupName = (gid: string): string => liveGroups.find((group) => group.gid === gid)?.name ?? "";
  const lssGroupName = (gid: string): string => lss.groups.find((group) => group.gid === gid)?.name ?? "";

  // Groups: by name first; the rest is paired by order so that a rename is reported as a change.
  const unmatchedLss = lss.groups.filter((group) => !liveGroups.some((live) => live.name === group.name));
  const unmatchedLive = liveGroups.filter((live) => !lss.groups.some((group) => group.name === live.name));
  const groupPairs = new Map<string, LiveGroup>();
  for (const group of lss.groups) {
    const live = liveGroups.find((item) => item.name === group.name);
    if (live) groupPairs.set(group.gid, live);
  }
  unmatchedLss.forEach((group, index) => {
    const live = unmatchedLive[index];
    if (live) {
      groupPairs.set(group.gid, live);
      collector.add("group_field", { group: group.name, field: "group_name", lss: group.name, live: live.name });
    } else {
      collector.add("group_missing_in_live", { group: group.name, lss: group.name });
    }
  });
  unmatchedLive.slice(unmatchedLss.length).forEach((live) => {
    collector.add("group_extra_in_live", { group: live.name, live: live.name });
  });
  for (const group of lss.groups) {
    const live = groupPairs.get(group.gid);
    if (live && group.relevance !== live.relevance) {
      collector.add("group_field", { group: group.name, field: "grelevance", lss: group.relevance, live: live.relevance });
    }
  }
  const pairedLss = lss.groups.filter((group) => groupPairs.has(group.gid));
  const pairedLive = pairedLss.map((group) => groupPairs.get(group.gid) as LiveGroup);
  const liveOrderIds = [...pairedLive].sort((a, b) => a.order - b.order).map((group) => group.gid);
  const pairedLiveIds = pairedLive.map((group) => group.gid);
  for (const gid of outOfOrder(pairedLiveIds, liveOrderIds)) {
    const live = pairedLive.find((group) => group.gid === gid) as LiveGroup;
    collector.add("group_field", {
      group: live.name,
      field: "group_order",
      lss: pairedLiveIds.indexOf(gid) + 1,
      live: liveOrderIds.indexOf(gid) + 1,
    });
  }

  // Questions: by code.
  const groupSorted = (gid: string, side: "lss" | "live"): number =>
    (side === "lss" ? lss.groups.find((group) => group.gid === gid)?.order : liveGroups.find((group) => group.gid === gid)?.order) ?? 0;
  const lssSorted = [...lss.questions].sort((a, b) => groupSorted(a.gid, "lss") - groupSorted(b.gid, "lss") || a.order - b.order);
  const liveSorted = [...liveMain].sort((a, b) => groupSorted(a.gid, "live") - groupSorted(b.gid, "live") || a.order - b.order);
  const liveByTitle = new Map(liveMain.map((question) => [question.title, question]));
  const commonTitles = new Set(lssSorted.filter((question) => liveByTitle.has(question.title)).map((question) => question.title));
  const lssSequence = lssSorted.filter((question) => commonTitles.has(question.title)).map((question) => question.title);
  const liveSequence = liveSorted.filter((question) => commonTitles.has(question.title)).map((question) => question.title);
  const movedTitles = new Set(outOfOrder(lssSequence, liveSequence));

  let subquestionsLss = 0;
  let subquestionsLive = 0;
  let answersLss = 0;
  let answersLive = 0;

  for (const question of lssSorted) {
    const live = liveByTitle.get(question.title);
    const groupName = lssGroupName(question.gid);
    if (!live) {
      collector.add("question_missing_in_live", { group: groupName, question: question.title, lss: question.text });
      continue;
    }
    const properties = await client.call("get_question_properties", [Number(live.qid), QUESTION_PROPERTIES, useLanguage]);
    if (!isObject(properties)) {
      throw new LimeSurveyError(`get_question_properties returned an unexpected answer for question ${question.title}.`, "UNEXPECTED_RESPONSE", properties);
    }
    const compare = (field: string, lssValue: string, liveValue: string): void => {
      if (lssValue !== liveValue) collector.add("question_field", { group: groupName, question: question.title, field, lss: lssValue, live: liveValue });
    };
    const liveGroup = liveGroupName(live.gid);
    const pairedGroup = groupPairs.get(question.gid);
    if (!pairedGroup || pairedGroup.gid !== live.gid) compare("group", groupName, liveGroup);
    compare("type", question.type, normalize(properties.type));
    compare("mandatory", question.mandatory, normalize(properties.mandatory) || "N");
    compare("relevance", question.relevance, relevance(properties.relevance));
    compare("other", question.other, normalize(properties.other) || "N");
    compare("question", question.text, normalize(properties.question));
    compare("help", question.help, normalize(properties.help));
    if (movedTitles.has(question.title)) {
      collector.add("question_field", {
        group: groupName,
        question: question.title,
        field: "position",
        lss: lssSequence.indexOf(question.title) + 1,
        live: liveSequence.indexOf(question.title) + 1,
      });
    }

    // Subquestions
    const subKey = (item: { title: string; scale: string }) => `${item.scale}:${item.title}`;
    const liveSubsOfQuestion = liveSubs.filter((sub) => sub.parent === live.qid);
    const liveSubMap = new Map(liveSubsOfQuestion.map((sub) => [subKey(sub), sub]));
    subquestionsLss += question.subquestions.length;
    subquestionsLive += liveSubsOfQuestion.length;
    for (const sub of question.subquestions) {
      const liveSub = liveSubMap.get(subKey(sub));
      if (!liveSub) {
        collector.add("subquestion_missing_in_live", { group: groupName, question: question.title, item: sub.title, lss: sub.text });
      } else if (sub.text !== liveSub.text) {
        collector.add("subquestion_field", { group: groupName, question: question.title, item: sub.title, field: "question", lss: sub.text, live: liveSub.text });
      }
    }
    const lssSubKeys = new Set(question.subquestions.map(subKey));
    for (const sub of liveSubsOfQuestion) {
      if (!lssSubKeys.has(subKey(sub))) collector.add("subquestion_extra_in_live", { group: groupName, question: question.title, item: sub.title, live: sub.text });
    }

    // Answers
    const answerKey = (item: LssAnswer) => `${item.scale}:${item.code}`;
    const answerLabel = (item: LssAnswer) => (item.scale === "0" ? item.code : `${item.code} (scale ${item.scale})`);
    const liveAnswerList = liveAnswers(properties.answeroptions);
    const liveAnswerMap = new Map(liveAnswerList.map((answer) => [answerKey(answer), answer]));
    answersLss += question.answers.length;
    answersLive += liveAnswerList.length;
    for (const answer of question.answers) {
      const liveAnswer = liveAnswerMap.get(answerKey(answer));
      if (!liveAnswer) {
        collector.add("answer_missing_in_live", { group: groupName, question: question.title, item: answerLabel(answer), lss: answer.text });
      } else if (answer.text !== liveAnswer.text) {
        collector.add("answer_field", { group: groupName, question: question.title, item: answerLabel(answer), field: "answer", lss: answer.text, live: liveAnswer.text });
      }
    }
    const lssAnswerKeys = new Set(question.answers.map(answerKey));
    for (const answer of liveAnswerList) {
      if (!lssAnswerKeys.has(answerKey(answer))) collector.add("answer_extra_in_live", { group: groupName, question: question.title, item: answerLabel(answer), live: answer.text });
    }

    // Attributes
    const liveAttrs = liveAttributes(properties);
    for (const [name, value] of question.attributes) {
      const liveValue = liveAttrs.get(name);
      if (liveValue === undefined) {
        if (value !== "") collector.add("attribute_missing_in_live", { group: groupName, question: question.title, item: name, field: "value", lss: value });
      } else if (liveValue !== value) {
        collector.add("attribute_changed", { group: groupName, question: question.title, item: name, field: "value", lss: value, live: liveValue });
      }
    }
    for (const [name, liveValue] of liveAttrs) {
      if (!question.attributes.has(name) && liveValue !== "" && liveValue !== "0") {
        collector.add("attribute_extra_in_live", { group: groupName, question: question.title, item: name, field: "value", live: liveValue });
      }
    }
  }
  const lssTitles = new Set(lss.questions.map((question) => question.title));
  for (const live of liveSorted) {
    if (!lssTitles.has(live.title)) collector.add("question_extra_in_live", { group: liveGroupName(live.gid), question: live.title });
  }

  const result: JsonObject = {
    survey_id: surveyId,
    lss_file: lssFile,
    language: useLanguage,
    summary: {
      groups: { lss: lss.groups.length, live: liveGroups.length, differences: collector.count("group_") },
      questions: { lss: lss.questions.length, live: liveMain.length, differences: collector.count("question_") },
      subquestions: { lss: subquestionsLss, live: subquestionsLive, differences: collector.count("subquestion_") },
      answers: { lss: answersLss, live: answersLive, differences: collector.count("answer_") },
      attributes: {
        missing_in_live: collector.counts.attribute_missing_in_live ?? 0,
        extra_in_live: collector.counts.attribute_extra_in_live ?? 0,
        changed: collector.counts.attribute_changed ?? 0,
      },
    },
    differences: collector.differences as unknown as JsonValue,
    differences_total: collector.total,
    truncated: collector.total > collector.differences.length,
    limitations: LIMITATIONS,
  };

  // Stay within LIMESURVEY_MAX_RESPONSE_CHARS: cut the list, never silently.
  let shown = collector.differences.length;
  while (shown > 0 && JSON.stringify(result).length > maxResponseChars) {
    shown = Math.floor(shown / 2);
    result.differences = collector.differences.slice(0, shown) as unknown as JsonValue;
    result.truncated = true;
  }
  return result;
}

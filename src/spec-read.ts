/**
 * Reads a live survey into the comparable spec form (texts as a map per language), with read methods only. Used to
 * verify what an import produced and to give validate_spec the facts of the target survey.
 */
import { BASE_THEME_BY_TYPE, I18N_ATTRIBUTES } from "./attribute-defaults.js";
import type { RpcClient } from "./scoped-client.js";
import { normalizeSpec, type AttributeValue, type ComparableSpec, type TextMap } from "./spec-compare.js";
import { isRecord } from "./spec-model.js";
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

export interface SpecRead {
  languages: string[];
  active: boolean;
  /** Comparable form; a language a text lacks is missing from its map and listed in missing_translations. */
  spec: ComparableSpec;
  /** Texts that have no row in a language (the question text itself, not what hangs on it). */
  missing_translations: MissingTranslation[];
  /** Answer texts and language-dependent attributes that cannot be read because the question has no text row in the language. */
  unreadable: UnreadableItem[];
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
  return options.sort((a, b) => a.scale_id - b.scale_id || a.order - b.order || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function attributeValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Reads the survey with get_* and list_* methods only. */
export async function readSurveySpec(client: RpcClient, surveyId: number): Promise<SpecRead> {
  const properties = asRow(await client.call("get_survey_properties", [surveyId, [...SPEC_SURVEY_PROPERTIES]])) ?? {};
  const base = str(properties.language) || "de";
  const languages = [base, ...splitLanguages(properties.additional_languages).filter((language) => language !== base)];
  const missing: MissingTranslation[] = [];
  const unreadable: UnreadableItem[] = [];

  // Survey texts.
  const surveyTexts = { title: {} as TextMap, description: {} as TextMap, welcometext: {} as TextMap, endtext: {} as TextMap };
  const languageRows = await mapLimit(languages, PARALLEL_READS, async (language) => (
    asRow(await client.call("get_language_properties", [surveyId, [...SPEC_LANGUAGE_PROPERTIES], language]))
  ));
  languages.forEach((language, index) => {
    const row = languageRows[index];
    if (!row || row.surveyls_title === null || row.surveyls_title === undefined) {
      missing.push({ path: "survey.title", language });
      return;
    }
    surveyTexts.title[language] = str(row.surveyls_title);
    surveyTexts.description[language] = str(row.surveyls_description);
    surveyTexts.welcometext[language] = str(row.surveyls_welcometext);
    surveyTexts.endtext[language] = str(row.surveyls_endtext);
  });

  // Groups and questions of every language.
  const groupLists = await mapLimit(languages, PARALLEL_READS, async (language) => rowsOf(await client.call("list_groups", [surveyId, language])));
  const questionLists = await mapLimit(languages, PARALLEL_READS, async (language) => (
    rowsOf(await client.call("list_questions", [surveyId, null, language]))
  ));
  const baseGroups = [...(groupLists[0] ?? [])].sort((a, b) => (
    num(a.group_order) - num(b.group_order) || (str(a.group_name) < str(b.group_name) ? -1 : str(a.group_name) > str(b.group_name) ? 1 : 0)
    || num(a.gid) - num(b.gid)
  ));
  const groupByLanguage = languages.map((_language, index) => new Map((groupLists[index] ?? []).map((row) => [str(row.gid), row] as const)));
  const questionByLanguage = languages.map((_language, index) => new Map((questionLists[index] ?? []).map((row) => [str(row.qid), row] as const)));
  const baseQuestions = questionLists[0] ?? [];

  // Properties of every main question in every language.
  const mainRows = baseQuestions.filter(isMainQuestion);
  const tasks = mainRows.flatMap((row) => languages.map((language) => ({ qid: str(row.qid), language })));
  const taskResults = await mapLimit(tasks, PARALLEL_READS, (task) => readQuestionProperties(client, task.qid, task.language));
  const propertiesOf = new Map<string, Row | undefined>(tasks.map((task, index) => [`${task.qid}|${task.language}`, taskResults[index]]));

  const groups = baseGroups.map((groupRow, groupIndex) => {
    const gid = str(groupRow.gid);
    const title: TextMap = {};
    const description: TextMap = {};
    languages.forEach((language, languageIndex) => {
      const row = groupByLanguage[languageIndex]?.get(gid);
      if (!row || row.group_name === null || row.group_name === undefined) {
        missing.push({ path: `groups[${groupIndex}].title`, language });
        return;
      }
      title[language] = str(row.group_name);
      description[language] = str(row.description);
    });

    const questionRows = mainRows
      .filter((row) => str(row.gid) === gid)
      .sort((a, b) => num(a.question_order) - num(b.question_order) || (str(a.title) < str(b.title) ? -1 : str(a.title) > str(b.title) ? 1 : 0));
    const questions = questionRows.map((row, questionIndex) => {
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
      languages.forEach((language, languageIndex) => {
        const props = propertiesOf.get(`${qid}|${language}`);
        const fallback = questionByLanguage[languageIndex]?.get(qid);
        const question = props?.question ?? fallback?.question;
        if (props === undefined || question === null || question === undefined) {
          missing.push({ path: `${questionPath}.text`, language });
          return;
        }
        text[language] = str(question);
        help[language] = str(props.help ?? fallback?.help);
      });

      const attributes: Record<string, AttributeValue> = {};
      for (const [name, value] of Object.entries(asRow(baseProps?.attributes) ?? {})) {
        if (!I18N_ATTRIBUTES.has(name)) attributes[name] = attributeValue(value);
      }
      const hasLanguageAttributes = languages.some((language) => (
        Object.keys(asRow(propsIn(language)?.attributes_lang) ?? {}).some((name) => I18N_ATTRIBUTES.has(name))
      ));
      for (const language of languages) {
        const props = propsIn(language);
        if (props === undefined) {
          // Only worth a note when another language of this question has such attributes.
          if (hasLanguageAttributes) unreadable.push({ path: `${questionPath}.attributes`, language, reason: NO_TEXT_ROW_ATTRIBUTES });
          continue;
        }
        for (const [name, value] of Object.entries(asRow(props.attributes_lang) ?? {})) {
          if (!I18N_ATTRIBUTES.has(name)) continue;
          const perLanguage = (attributes[name] ??= {}) as TextMap;
          perLanguage[language] = attributeValue(value);
        }
      }

      const subRows = baseQuestions
        .filter((sub) => !isMainQuestion(sub) && str(sub.parent_qid) === qid)
        .sort((a, b) => num(a.scale_id) - num(b.scale_id) || num(a.question_order) - num(b.question_order) || (str(a.title) < str(b.title) ? -1 : str(a.title) > str(b.title) ? 1 : 0));
      const subTexts = (sub: Row, path: string): TextMap => {
        const result: TextMap = {};
        languages.forEach((language, languageIndex) => {
          const row = questionByLanguage[languageIndex]?.get(str(sub.qid));
          if (!row || row.question === null || row.question === undefined) {
            missing.push({ path, language });
            return;
          }
          result[language] = str(row.question);
        });
        return result;
      };

      // LimeSurvey 7 stores the entries of a Ranking question as subquestions; the spec calls them answers.
      const rankingAsAnswers = type === "R" && subRows.length > 0;
      const subquestions = rankingAsAnswers
        ? []
        : subRows.map((sub, index) => ({
          code: str(sub.title),
          text: subTexts(sub, `${questionPath}.subquestions[${index}].text`),
          ...(num(sub.scale_id) === 0 ? {} : { scale_id: num(sub.scale_id) }),
        }));

      let answers: Array<Record<string, unknown>>;
      if (rankingAsAnswers) {
        answers = subRows.map((sub, index) => ({
          code: str(sub.title),
          text: subTexts(sub, `${questionPath}.answers[${index}].text`),
          assessment_value: 0,
        }));
      } else {
        const multiscale = type === "1";
        const baseOptions = parseOptions(baseProps?.answeroptions, multiscale);
        const optionsByLanguage = languages.map((language) => new Map(
          parseOptions(propsIn(language)?.answeroptions, multiscale).map((option) => [`${option.scale_id}:${option.code}`, option] as const),
        ));
        answers = baseOptions.map((option, index) => {
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
      return {
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
      };
    });
    return { title, description, relevance: str(groupRow.grelevance) || "1", questions };
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

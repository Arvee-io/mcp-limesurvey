/**
 * The survey description ("spec") the generator tools take: constants, types and the normalisation that fills in
 * defaults. Version 2 of the spec format (version 1 is the one of the plugin's Python generator and stays valid):
 * every text is one string (it counts for every language of the survey) or a map per language, and questions carry
 * default values, a script and the columns LimeSurvey stores. The question types 1, : and ; are not supported yet.
 */
import { ATTRIBUTE_DEFAULTS, I18N_ATTRIBUTES } from "./attribute-defaults.js";
import { unescapeHtmlSafe } from "./html-unescape.js";

export type SpecKind = "survey" | "group" | "question";

/** Texts per language, for example { de: "Ja", en: "Yes" }. */
export type TextMap = Record<string, string>;

/** Question types this version can write (Python: SUPPORTED_TYPES). */
export const SUPPORTED_TYPES: ReadonlySet<string> = new Set("XL!OMYNSTQ5FARKBCEHPDGUI*|");
/** Types that LimeSurvey knows but this version rejects, because they need a second subquestion or answer scale. */
export const TWO_SCALE_TYPES: ReadonlySet<string> = new Set(["1", ":", ";"]);
export const NEED_SUBQUESTIONS: ReadonlySet<string> = new Set("MQAKBCEP"); // M options are subquestions
export const NEED_ANSWERS: ReadonlySet<string> = new Set("L!OR");
export const NEED_BOTH: ReadonlySet<string> = new Set("FH"); // rows = subquestions, columns = answers
export const OTHER_ALLOWED: ReadonlySet<string> = new Set("L!MP");
/** The types whose "Other" option can have a default value of its own. */
export const DEFAULT_OTHER_ALLOWED: ReadonlySet<string> = new Set("L!");
/** The types that have no default value at all (Ranking and file upload). */
export const NO_DEFAULT_TYPES: ReadonlySet<string> = new Set("R|");

/** Question codes LimeSurvey reserves (compared without case, because the title collation is case-insensitive). */
export const RESERVED_CODES: ReadonlySet<string> = new Set(
  ["LANG", "SID", "SAVEDID", "TOKEN", "QID", "GID", "SGQ", "self", "that", "this"].map((code) => code.toLowerCase()),
);

export const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,10}){0,3}$/;
export const QUESTION_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
export const SUBQUESTION_CODE_PATTERN = /^[A-Za-z0-9]{1,20}$/;
export const ANSWER_CODE_PATTERN = /^[A-Za-z0-9]{1,5}$/;
export const ANSWER_CODE_MAX_LENGTH = 5;
export const MAX_QUESTION_CODE_LENGTH = 20;
/** question_theme_name: the name of a question theme, for example listradio or bootstrap_buttons. */
export const THEME_NAME_PATTERN = /^[A-Za-z0-9_/-]{1,100}$/;

export const SHOWQNUMCODE_VALUES = ["B", "N", "C", "X", "I"] as const;
export const EXPIRES_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
export const EXPIRES_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Question attribute names LimeSurvey stores: a letter first, then letters, digits or underscores, at most 50. */
export const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;

/**
 * Attributes known to be language independent: they stand in the table of some question theme and are not among the
 * attributes stored per language. Every other name (a plugin or custom theme attribute) may be stored per language, so
 * it takes a map per language as well as a plain value.
 */
const KNOWN_LANGUAGE_INDEPENDENT: ReadonlySet<string> = new Set(
  Object.values(ATTRIBUTE_DEFAULTS).flatMap((table) => Object.keys(table)).filter((name) => !I18N_ATTRIBUTES.has(name)),
);

export function isKnownLanguageIndependent(attribute: string): boolean {
  return KNOWN_LANGUAGE_INDEPENDENT.has(attribute);
}

/** The base question theme: core is a name for it (LimeSurvey stores it for questions that use no extended theme). */
export const CORE_THEME = "core";
/** survey.format: G group by group, S question by question, A all in one page, I inherit. */
export const SURVEY_FORMATS = ["G", "A", "S", "I"] as const;

/**
 * Whether survey.expires is usable: "ok", "format" (neither YYYY-MM-DD nor YYYY-MM-DD HH:MM:SS) or "calendar" (the
 * format fits, but there is no such date or time: month 13, 30 February, 29 February of a common year, minute 61).
 */
export function checkExpires(value: string): "ok" | "format" | "calendar" {
  if (!EXPIRES_DATETIME_PATTERN.test(value) && !EXPIRES_DATE_PATTERN.test(value)) return "format";
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = value.split(/[- :]/).map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const real = month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth ?? 0) && hour <= 23 && minute <= 59 && second <= 59;
  return real ? "ok" : "calendar";
}

/** Keys of the three levels, in the order the spec documents them. */
export const SURVEY_KEYS = [
  "title", "language", "additional_languages", "description", "welcometext", "endtext", "anonymized", "datestamp",
  "ipaddr", "savetimings", "format", "adminemail", "showprogress", "expires", "template", "showqnumcode",
] as const;
/** The Yes/No settings; each may also be "inherit" (LimeSurvey I). */
export const SURVEY_BOOLEAN_KEYS = ["anonymized", "datestamp", "ipaddr", "savetimings", "showprogress"] as const;
export const SURVEY_TEXT_KEYS = ["title", "description", "welcometext", "endtext"] as const;
export const GROUP_KEYS = ["title", "description", "relevance", "randomization_group", "questions"] as const;
export const QUESTION_KEYS = [
  "code", "type", "text", "help", "mandatory", "relevance", "other", "attributes", "subquestions", "answers",
  "default", "default_other", "script", "preg", "question_theme_name", "encrypted", "same_default", "same_script",
  "modulename",
] as const;
export const SUBQUESTION_KEYS = ["code", "text", "relevance", "default"] as const;
export const ANSWER_KEYS = ["code", "text", "assessment_value", "relevance"] as const;

export const SURVEY_DEFAULTS = {
  language: "de",
  additional_languages: [] as string[],
  description: "",
  welcometext: "",
  endtext: "",
  anonymized: false,
  datestamp: false,
  ipaddr: false,
  savetimings: false,
  format: "G",
  adminemail: "",
  showprogress: true,
  template: "",
  showqnumcode: "X",
};

/** The spec after normalisation: every default filled in, every text a map with one entry per survey language. */
export interface NormalSurvey {
  title: TextMap;
  language: string;
  additional_languages: string[];
  description: TextMap;
  welcometext: TextMap;
  endtext: TextMap;
  anonymized: boolean | "inherit";
  datestamp: boolean | "inherit";
  ipaddr: boolean | "inherit";
  savetimings: boolean | "inherit";
  format: string;
  adminemail: string;
  showprogress: boolean | "inherit";
  template: string;
  showqnumcode: string;
  expires: string;
}

export interface NormalAnswer {
  code: string;
  text: TextMap;
  assessment_value: number;
  /** Only an entry of a Ranking question on LimeSurvey 7 can have one other than 1. */
  relevance: string;
}

export interface NormalSubquestion {
  code: string;
  text: TextMap;
  relevance: string;
  /** Default value per language; with same_default only the base language. Absent without a default. */
  default?: TextMap;
}

export interface NormalQuestion {
  code: string;
  type: string;
  text: TextMap;
  help: TextMap;
  script: TextMap;
  mandatory: boolean | "soft";
  relevance: string;
  other: boolean;
  attributes: Record<string, string | TextMap>;
  subquestions: NormalSubquestion[];
  answers: NormalAnswer[];
  preg: string;
  question_theme_name: string;
  encrypted: boolean;
  same_default: boolean;
  same_script: boolean;
  modulename: string;
  default?: TextMap;
  default_other?: TextMap;
}

export interface NormalGroup {
  title: TextMap;
  description: TextMap;
  relevance: string;
  randomization_group: string;
  questions: NormalQuestion[];
}

export interface NormalSpec {
  survey: NormalSurvey;
  /** The base language first, then the additional languages. */
  languages: string[];
  groups: NormalGroup[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python truthiness for the values a JSON spec can hold. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python str() for strings and numbers; anything else (null, objects) becomes the fallback. */
export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

/** Date-only survey.expires becomes end of day (Python: _normalize_expires). */
export function normalizeExpires(value: string): string {
  if (!value) return "";
  return EXPIRES_DATE_PATTERN.test(value) ? `${value} 23:59:59` : value;
}

/** The languages of a survey: the base language first, then the additional ones (each once). */
export function surveyLanguages(language: string, additional: readonly string[]): string[] {
  return [language, ...additional.filter((item) => item !== language)];
}

function unescapeValue(value: unknown, inAttributes: boolean): unknown {
  if (typeof value === "string") return unescapeHtmlSafe(value);
  if (Array.isArray(value)) return value.map((item) => unescapeValue(item, false));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      // A question script is code, not HTML text: it is kept as written. An attribute may carry any name.
      key === "script" && !inAttributes ? item : unescapeValue(item, key === "attributes"),
    ]));
  }
  return value;
}

/**
 * Decodes the HTML entities of every string value (not of keys), like Python's normalize_entities. The decoding is
 * the safe one: references to & < > " ' stay as written. The script of a question is left alone.
 */
export function unescapeStrings<T>(value: T): T {
  return unescapeValue(value, false) as T;
}

/** One string counts for every language; a map keeps its languages, its values turned into strings. */
export function expandText(value: unknown, languages: readonly string[]): TextMap {
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([language, item]) => [language, asString(item)]));
  const text = asString(value);
  return Object.fromEntries(languages.map((language) => [language, text]));
}

/**
 * A default value as texts per language: empty values dropped, nothing when no value is left. With same_default the
 * default belongs to the base language alone (LimeSurvey keeps one default for all languages then).
 */
export function defaultTexts(value: unknown, languages: readonly string[], sameDefault: boolean): TextMap | undefined {
  if (value === undefined || value === null) return undefined;
  const entries = Object.entries(expandText(value, languages)).filter(([, text]) => text !== "");
  if (entries.length === 0) return undefined;
  const base = languages[0];
  if (!sameDefault) return Object.fromEntries(entries);
  const baseEntry = entries.find(([language]) => language === base);
  const chosen = baseEntry ?? entries[0];
  return chosen === undefined ? undefined : { [base ?? chosen[0]]: chosen[1] };
}

function flag(value: unknown, fallback: boolean): boolean | "inherit" {
  if (value === "inherit") return "inherit";
  return truthy(value ?? fallback);
}

/** Python: normalize_spec. Expects a spec that validateSpec accepted (strings, booleans and lists of the right type). */
export function normalizeSurveySpec(spec: unknown): NormalSpec {
  const root = isRecord(spec) ? spec : {};
  const surveyIn = isRecord(root.survey) ? root.survey : {};
  const additional = Array.isArray(surveyIn.additional_languages) ? surveyIn.additional_languages : [];
  const language = asString(surveyIn.language, SURVEY_DEFAULTS.language);
  const additionalLanguages = additional.map((item) => asString(item));
  const languages = surveyLanguages(language, additionalLanguages);
  const survey: NormalSurvey = {
    title: expandText(surveyIn.title, languages),
    language,
    additional_languages: additionalLanguages,
    description: expandText(surveyIn.description, languages),
    welcometext: expandText(surveyIn.welcometext, languages),
    endtext: expandText(surveyIn.endtext, languages),
    anonymized: flag(surveyIn.anonymized, SURVEY_DEFAULTS.anonymized),
    datestamp: flag(surveyIn.datestamp, SURVEY_DEFAULTS.datestamp),
    ipaddr: flag(surveyIn.ipaddr, SURVEY_DEFAULTS.ipaddr),
    savetimings: flag(surveyIn.savetimings, SURVEY_DEFAULTS.savetimings),
    format: asString(surveyIn.format, SURVEY_DEFAULTS.format),
    adminemail: asString(surveyIn.adminemail),
    showprogress: flag(surveyIn.showprogress, SURVEY_DEFAULTS.showprogress),
    template: asString(surveyIn.template),
    showqnumcode: asString(surveyIn.showqnumcode, SURVEY_DEFAULTS.showqnumcode),
    expires: normalizeExpires(asString(surveyIn.expires)),
  };

  const groups: NormalGroup[] = [];
  for (const group of Array.isArray(root.groups) ? root.groups : []) {
    const groupIn = isRecord(group) ? group : {};
    const questions: NormalQuestion[] = [];
    for (const question of Array.isArray(groupIn.questions) ? groupIn.questions : []) {
      questions.push(normalizeQuestion(question, languages));
    }
    groups.push({
      title: expandText(groupIn.title, languages),
      description: expandText(groupIn.description, languages),
      relevance: asString(groupIn.relevance) || "1",
      randomization_group: asString(groupIn.randomization_group),
      questions,
    });
  }
  return { survey, languages, groups };
}

export function normalizeQuestion(question: unknown, languages: readonly string[]): NormalQuestion {
  const q = isRecord(question) ? question : {};
  const attributes: Record<string, string | TextMap> = {};
  if (isRecord(q.attributes)) {
    for (const [name, value] of Object.entries(q.attributes)) {
      // A map is kept as a map; a string at an attribute stored per language counts for every language.
      attributes[name] = isRecord(value) || I18N_ATTRIBUTES.has(name) ? expandText(value, languages) : asString(value);
    }
  }
  const theme = asString(q.question_theme_name);
  const records = (value: unknown): Array<Record<string, unknown>> => (
    Array.isArray(value) ? value.filter(isRecord) : []
  );
  const sameDefault = truthy(q.same_default);
  const defaultValue = defaultTexts(q.default, languages, sameDefault);
  const defaultOther = defaultTexts(q.default_other, languages, sameDefault);
  return {
    code: asString(q.code),
    type: asString(q.type),
    text: expandText(q.text, languages),
    help: expandText(q.help, languages),
    script: expandText(q.script, languages),
    mandatory: q.mandatory === "soft" ? "soft" : truthy(q.mandatory),
    relevance: asString(q.relevance) || "1",
    other: truthy(q.other),
    attributes,
    subquestions: records(q.subquestions).map((sub) => {
      const subDefault = defaultTexts(sub.default, languages, sameDefault);
      return {
        code: asString(sub.code),
        text: expandText(sub.text, languages),
        relevance: asString(sub.relevance) || "1",
        ...(subDefault !== undefined ? { default: subDefault } : {}),
      };
    }),
    answers: records(q.answers).map((answer) => ({
      code: asString(answer.code),
      text: expandText(answer.text, languages),
      assessment_value: typeof answer.assessment_value === "number" ? Math.trunc(answer.assessment_value) : 0,
      relevance: asString(answer.relevance).trim() || "1",
    })),
    preg: asString(q.preg),
    question_theme_name: theme === CORE_THEME ? "" : theme,
    encrypted: truthy(q.encrypted),
    same_default: sameDefault,
    same_script: truthy(q.same_script),
    modulename: asString(q.modulename),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(defaultOther !== undefined ? { default_other: defaultOther } : {}),
  };
}

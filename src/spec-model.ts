/**
 * The survey description ("spec") the generator tools take: constants, types and the normalisation that fills in
 * defaults. Version 1 of the spec format (the one of the plugin's Python generator): texts are plain strings, the
 * question types 1, : and ; and language maps are not supported yet.
 */
import { unescapeHtmlSafe } from "./html-unescape.js";

export type SpecKind = "survey" | "group" | "question";

/** Question types this version can write (Python: SUPPORTED_TYPES). */
export const SUPPORTED_TYPES: ReadonlySet<string> = new Set("XL!OMYNSTQ5FARKBCEHPDGUI*|");
/** Types that LimeSurvey knows but this version rejects, because they need a second subquestion or answer scale. */
export const TWO_SCALE_TYPES: ReadonlySet<string> = new Set(["1", ":", ";"]);
export const NEED_SUBQUESTIONS: ReadonlySet<string> = new Set("MQAKBCEP"); // M options are subquestions
export const NEED_ANSWERS: ReadonlySet<string> = new Set("L!OR");
export const NEED_BOTH: ReadonlySet<string> = new Set("FH"); // rows = subquestions, columns = answers
export const OTHER_ALLOWED: ReadonlySet<string> = new Set("L!MP");

/** Question codes LimeSurvey reserves (compared without case, because the title collation is case-insensitive). */
export const RESERVED_CODES: ReadonlySet<string> = new Set(
  ["LANG", "SID", "SAVEDID", "TOKEN", "QID", "GID", "SGQ", "self", "that", "this"].map((code) => code.toLowerCase()),
);

export const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,10}){0,3}$/;
export const QUESTION_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
export const SUBQUESTION_CODE_PATTERN = /^[A-Za-z0-9]{1,20}$/;
export const ANSWER_CODE_PATTERN = /^[A-Za-z0-9]{1,5}$/;
export const MAX_QUESTION_CODE_LENGTH = 20;

export const SHOWQNUMCODE_VALUES = ["B", "N", "C", "X", "I"] as const;
export const EXPIRES_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
export const EXPIRES_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Question attribute names LimeSurvey stores: a letter first, then letters, digits or underscores, at most 50. */
export const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
/** survey.format: G group by group, S question by question, A all in one page. */
export const SURVEY_FORMATS = ["G", "A", "S"] as const;

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
export const SURVEY_BOOLEAN_KEYS = ["anonymized", "datestamp", "ipaddr", "savetimings", "showprogress"] as const;
export const SURVEY_TEXT_KEYS = ["title", "description", "welcometext", "endtext"] as const;
export const GROUP_KEYS = ["title", "description", "relevance", "questions"] as const;
export const QUESTION_KEYS = [
  "code", "type", "text", "help", "mandatory", "relevance", "other", "attributes", "subquestions", "answers",
] as const;
export const SUBQUESTION_KEYS = ["code", "text"] as const;
export const ANSWER_KEYS = ["code", "text", "assessment_value"] as const;

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

/** The spec after normalisation: every default filled in, every text a string. */
export interface NormalSurvey {
  title: string;
  language: string;
  additional_languages: string[];
  description: string;
  welcometext: string;
  endtext: string;
  anonymized: boolean;
  datestamp: boolean;
  ipaddr: boolean;
  savetimings: boolean;
  format: string;
  adminemail: string;
  showprogress: boolean;
  template: string;
  showqnumcode: string;
  expires: string;
}

export interface NormalAnswer {
  code: string;
  text: string;
  assessment_value: number;
}

export interface NormalSubquestion {
  code: string;
  text: string;
}

export interface NormalQuestion {
  code: string;
  type: string;
  text: string;
  help: string;
  mandatory: boolean | "soft";
  relevance: string;
  other: boolean;
  attributes: Record<string, string>;
  subquestions: NormalSubquestion[];
  answers: NormalAnswer[];
}

export interface NormalGroup {
  title: string;
  description: string;
  relevance: string;
  questions: NormalQuestion[];
}

export interface NormalSpec {
  survey: NormalSurvey;
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

/**
 * Decodes the HTML entities of every string value (not of keys), like Python's normalize_entities. The decoding is
 * the safe one: references to & < > " ' stay as written.
 */
export function unescapeStrings<T>(value: T): T {
  if (typeof value === "string") return unescapeHtmlSafe(value) as T;
  if (Array.isArray(value)) return value.map((item) => unescapeStrings(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unescapeStrings(item)])) as T;
  }
  return value;
}

/** Python: normalize_spec. Expects a spec that validateSpec accepted (strings, booleans and lists of the right type). */
export function normalizeSurveySpec(spec: unknown): NormalSpec {
  const root = isRecord(spec) ? spec : {};
  const surveyIn = isRecord(root.survey) ? root.survey : {};
  const additional = Array.isArray(surveyIn.additional_languages) ? surveyIn.additional_languages : [];
  const survey: NormalSurvey = {
    title: asString(surveyIn.title),
    language: asString(surveyIn.language, SURVEY_DEFAULTS.language),
    additional_languages: additional.map((language) => asString(language)),
    description: asString(surveyIn.description),
    welcometext: asString(surveyIn.welcometext),
    endtext: asString(surveyIn.endtext),
    anonymized: truthy(surveyIn.anonymized ?? SURVEY_DEFAULTS.anonymized),
    datestamp: truthy(surveyIn.datestamp ?? SURVEY_DEFAULTS.datestamp),
    ipaddr: truthy(surveyIn.ipaddr ?? SURVEY_DEFAULTS.ipaddr),
    savetimings: truthy(surveyIn.savetimings ?? SURVEY_DEFAULTS.savetimings),
    format: asString(surveyIn.format, SURVEY_DEFAULTS.format),
    adminemail: asString(surveyIn.adminemail),
    showprogress: truthy(surveyIn.showprogress ?? SURVEY_DEFAULTS.showprogress),
    template: asString(surveyIn.template),
    showqnumcode: asString(surveyIn.showqnumcode, SURVEY_DEFAULTS.showqnumcode),
    expires: normalizeExpires(asString(surveyIn.expires)),
  };

  const groups: NormalGroup[] = [];
  for (const group of Array.isArray(root.groups) ? root.groups : []) {
    const groupIn = isRecord(group) ? group : {};
    const questions: NormalQuestion[] = [];
    for (const question of Array.isArray(groupIn.questions) ? groupIn.questions : []) {
      questions.push(normalizeQuestion(question));
    }
    groups.push({
      title: asString(groupIn.title),
      description: asString(groupIn.description),
      relevance: asString(groupIn.relevance) || "1",
      questions,
    });
  }
  return { survey, groups };
}

export function normalizeQuestion(question: unknown): NormalQuestion {
  const q = isRecord(question) ? question : {};
  const attributes: Record<string, string> = {};
  if (isRecord(q.attributes)) {
    for (const [name, value] of Object.entries(q.attributes)) attributes[name] = asString(value);
  }
  const records = (value: unknown): Array<Record<string, unknown>> => (
    Array.isArray(value) ? value.filter(isRecord) : []
  );
  return {
    code: asString(q.code),
    type: asString(q.type),
    text: asString(q.text),
    help: asString(q.help),
    mandatory: q.mandatory === "soft" ? "soft" : truthy(q.mandatory),
    relevance: asString(q.relevance) || "1",
    other: truthy(q.other),
    attributes,
    subquestions: records(q.subquestions).map((sub) => ({ code: asString(sub.code), text: asString(sub.text) })),
    answers: records(q.answers).map((answer) => ({
      code: asString(answer.code),
      text: asString(answer.text),
      assessment_value: typeof answer.assessment_value === "number" ? Math.trunc(answer.assessment_value) : 0,
    })),
  };
}

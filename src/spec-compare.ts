/**
 * Comparing two survey descriptions. normalizeSpec brings a spec (as written by a person, or as read from a live
 * survey) into one comparable form: texts as a map per language, every default filled in, attribute values that equal
 * the default of their question theme left out. diffSpecs lists where two such forms differ.
 */
import { createHash } from "node:crypto";
import { ATTRIBUTE_DEFAULTS, BASE_THEME_BY_TYPE, I18N_ATTRIBUTES } from "./attribute-defaults.js";
import { unescapeHtmlSafe } from "./html-unescape.js";
import { asString, isRecord, normalizeExpires, SURVEY_DEFAULTS, truthy } from "./spec-model.js";
import type { JsonValue } from "./types.js";

export type TextMap = Record<string, string>;
export type AttributeValue = string | TextMap;

export interface ComparableAnswer {
  code: string;
  text: TextMap;
  assessment_value: number;
  scale_id?: number;
}

export interface ComparableSubquestion {
  code: string;
  text: TextMap;
  scale_id?: number;
}

export interface ComparableQuestion {
  code: string;
  type: string;
  text: TextMap;
  help: TextMap;
  mandatory: boolean | "soft";
  relevance: string;
  other: boolean;
  attributes: Record<string, AttributeValue>;
  subquestions: ComparableSubquestion[];
  answers: ComparableAnswer[];
  question_theme_name?: string;
}

export interface ComparableGroup {
  title: TextMap;
  description: TextMap;
  relevance: string;
  questions: ComparableQuestion[];
}

export interface ComparableSurvey {
  title: TextMap;
  description: TextMap;
  welcometext: TextMap;
  endtext: TextMap;
  language: string;
  additional_languages: string[];
  anonymized: boolean | "inherit";
  datestamp: boolean | "inherit";
  ipaddr: boolean | "inherit";
  savetimings: boolean | "inherit";
  format: string;
  adminemail: string;
  showprogress: boolean | "inherit";
  template?: string;
  showqnumcode: string;
  expires: string;
}

export interface ComparableSpec {
  survey: ComparableSurvey;
  groups: ComparableGroup[];
}

export type SpecDifference = { path: string; expected: JsonValue; actual: JsonValue };

/** CRLF to LF, trim, then the safe entity decoding. */
function clean(value: string): string {
  return unescapeHtmlSafe(value.replace(/\r\n/g, "\n").trim());
}

const cleanText = (value: unknown): string => clean(asString(value));

function attributeText(value: unknown): string {
  if (typeof value === "string") return clean(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** A string counts for every language; a map keeps its languages. */
function textMap(value: unknown, languages: readonly string[], convert: (item: unknown) => string = cleanText): TextMap {
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([language, item]) => [language, convert(item)]));
  const text = convert(value);
  return Object.fromEntries(languages.map((language) => [language, text]));
}

function flag(value: unknown, fallback: boolean): boolean | "inherit" {
  if (value === "inherit") return "inherit";
  return value === undefined || value === null ? fallback : truthy(value);
}

function integer(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);

function baseTheme(type: string): string {
  return Object.hasOwn(BASE_THEME_BY_TYPE, type) ? (BASE_THEME_BY_TYPE[type] ?? "") : "";
}

function normalizeAttributes(
  attributes: unknown,
  theme: string,
  languages: readonly string[],
): Record<string, AttributeValue> {
  const defaults = Object.hasOwn(ATTRIBUTE_DEFAULTS, theme) ? ATTRIBUTE_DEFAULTS[theme] : undefined;
  const defaultOf = (name: string): string | undefined => (defaults && Object.hasOwn(defaults, name) ? defaults[name] : undefined);
  const result: Record<string, AttributeValue> = {};
  if (!isRecord(attributes)) return result;
  for (const name of Object.keys(attributes).sort()) {
    const value = attributes[name];
    if (I18N_ATTRIBUTES.has(name)) {
      const perLanguage = textMap(value, languages, attributeText);
      const kept = Object.fromEntries(Object.entries(perLanguage).filter(([, item]) => item !== defaultOf(name)));
      if (Object.keys(kept).length > 0) result[name] = kept;
    } else {
      const text = attributeText(value);
      if (text !== defaultOf(name)) result[name] = text;
    }
  }
  return result;
}

function normalizeQuestionForCompare(question: Record<string, unknown>, languages: readonly string[]): ComparableQuestion {
  const type = asString(question.type);
  const explicitTheme = asString(question.question_theme_name);
  const base = baseTheme(type);
  const scale = (item: Record<string, unknown>): { scale_id?: number } => {
    const scaleId = integer(item.scale_id);
    return scaleId === 0 ? {} : { scale_id: scaleId };
  };
  return {
    code: cleanText(question.code),
    type,
    text: textMap(question.text, languages),
    help: textMap(question.help, languages),
    mandatory: question.mandatory === "soft" ? "soft" : truthy(question.mandatory),
    relevance: cleanText(question.relevance) || "1",
    other: truthy(question.other),
    attributes: normalizeAttributes(question.attributes, explicitTheme || base, languages),
    subquestions: records(question.subquestions).map((item) => ({
      code: cleanText(item.code),
      text: textMap(item.text, languages),
      ...scale(item),
    })),
    answers: records(question.answers).map((item) => ({
      code: cleanText(item.code),
      text: textMap(item.text, languages),
      assessment_value: integer(item.assessment_value),
      ...scale(item),
    })),
    ...(explicitTheme !== "" && explicitTheme !== base ? { question_theme_name: explicitTheme } : {}),
  };
}

export function normalizeSpec(spec: unknown, languages: readonly string[]): ComparableSpec {
  const root = isRecord(spec) ? spec : {};
  const survey = isRecord(root.survey) ? root.survey : {};
  const language = cleanText(survey.language ?? SURVEY_DEFAULTS.language);
  const additional = Array.isArray(survey.additional_languages) ? survey.additional_languages : [];
  const adminemail = cleanText(survey.adminemail);
  const template = cleanText(survey.template);
  return {
    survey: {
      title: textMap(survey.title, languages),
      description: textMap(survey.description, languages),
      welcometext: textMap(survey.welcometext, languages),
      endtext: textMap(survey.endtext, languages),
      language,
      additional_languages: [...new Set(additional.map((item) => cleanText(item)))].filter((item) => item !== language),
      anonymized: flag(survey.anonymized, SURVEY_DEFAULTS.anonymized),
      datestamp: flag(survey.datestamp, SURVEY_DEFAULTS.datestamp),
      ipaddr: flag(survey.ipaddr, SURVEY_DEFAULTS.ipaddr),
      savetimings: flag(survey.savetimings, SURVEY_DEFAULTS.savetimings),
      format: cleanText(survey.format ?? SURVEY_DEFAULTS.format) || SURVEY_DEFAULTS.format,
      adminemail: adminemail === "inherit" ? "" : adminemail,
      showprogress: flag(survey.showprogress, SURVEY_DEFAULTS.showprogress),
      ...(template !== "" && template !== "inherit" ? { template } : {}),
      showqnumcode: cleanText(survey.showqnumcode ?? SURVEY_DEFAULTS.showqnumcode) || SURVEY_DEFAULTS.showqnumcode,
      expires: normalizeExpires(cleanText(survey.expires)),
    },
    groups: records(root.groups).map((group) => ({
      title: textMap(group.title, languages),
      description: textMap(group.description, languages),
      relevance: cleanText(group.relevance) || "1",
      questions: records(group.questions).map((question) => normalizeQuestionForCompare(question, languages)),
    })),
  };
}

/** JSON with sorted keys, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 (hex) of the canonical JSON of a value. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const json = (value: unknown): JsonValue => (value === undefined ? null : (JSON.parse(canonicalJson(value)) as JsonValue));

function diffValue(path: string, expected: unknown, actual: unknown, out: SpecDifference[]): void {
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...Object.keys(expected), ...Object.keys(actual).filter((key) => !(key in expected))];
    for (const key of keys) diffValue(`${path}.${key}`, expected[key], actual[key], out);
    return;
  }
  if (canonicalJson(expected) !== canonicalJson(actual)) out.push({ path, expected: json(expected), actual: json(actual) });
}

/** Items matched by key (code and scale); a different order of the same items is one difference at the list. */
function diffItems<T extends { code: string; scale_id?: number }>(
  path: string,
  expected: readonly T[],
  actual: readonly T[],
  out: SpecDifference[],
  describe: (item: T) => unknown = (item) => item,
): void {
  const keyOf = (item: T): string => `${item.scale_id ?? 0}:${item.code}`;
  const actualIndex = new Map(actual.map((item, index) => [keyOf(item), index] as const));
  const matched = new Set<number>();
  expected.forEach((item, index) => {
    const found = actualIndex.get(keyOf(item));
    if (found === undefined) {
      out.push({ path: `${path}[${index}]`, expected: json(describe(item)), actual: null });
      return;
    }
    matched.add(found);
    diffValue(`${path}[${index}]`, item, actual[found], out);
  });
  actual.forEach((item, index) => {
    if (!matched.has(index)) out.push({ path: `${path}[${index}]`, expected: null, actual: json(describe(item)) });
  });
  const commonExpected = expected.filter((item) => actualIndex.has(keyOf(item))).map(keyOf);
  const commonActual = actual.filter((_item, index) => matched.has(index)).map(keyOf);
  if (canonicalJson(commonExpected) !== canonicalJson(commonActual)) {
    out.push({ path, expected: commonExpected, actual: commonActual });
  }
}

const briefQuestion = (question: ComparableQuestion): unknown => ({ code: question.code, type: question.type });

function diffQuestion(path: string, expected: ComparableQuestion, actual: ComparableQuestion, out: SpecDifference[]): void {
  const { subquestions: expectedSubs, answers: expectedAnswers, ...expectedRest } = expected;
  const { subquestions: actualSubs, answers: actualAnswers, ...actualRest } = actual;
  diffValue(path, expectedRest, actualRest, out);
  diffItems(`${path}.subquestions`, expectedSubs, actualSubs, out);
  diffItems(`${path}.answers`, expectedAnswers, actualAnswers, out);
}

/**
 * Where two comparable specs differ. Groups are matched by position, questions by code within the group, subquestions
 * and answers by code. Paths follow the validator (groups[1].questions[3].answers[0].text.de); a missing item is
 * reported at its place with null on the side that lacks it.
 */
export function diffSpecs(expected: ComparableSpec, actual: ComparableSpec): SpecDifference[] {
  const out: SpecDifference[] = [];
  diffValue("survey", expected.survey, actual.survey, out);
  const count = Math.max(expected.groups.length, actual.groups.length);
  for (let index = 0; index < count; index += 1) {
    const path = `groups[${index}]`;
    const expectedGroup = expected.groups[index];
    const actualGroup = actual.groups[index];
    const brief = (group: ComparableGroup): unknown => ({ title: group.title, questions: group.questions.map((question) => question.code) });
    if (!actualGroup) {
      if (expectedGroup) out.push({ path, expected: json(brief(expectedGroup)), actual: null });
      continue;
    }
    if (!expectedGroup) {
      out.push({ path, expected: null, actual: json(brief(actualGroup)) });
      continue;
    }
    diffValue(`${path}.title`, expectedGroup.title, actualGroup.title, out);
    diffValue(`${path}.description`, expectedGroup.description, actualGroup.description, out);
    diffValue(`${path}.relevance`, expectedGroup.relevance, actualGroup.relevance, out);
    const questionPath = `${path}.questions`;
    const actualIndex = new Map(actualGroup.questions.map((question, position) => [question.code, position] as const));
    const matched = new Set<number>();
    expectedGroup.questions.forEach((question, position) => {
      const found = actualIndex.get(question.code);
      const actualQuestion = found === undefined ? undefined : actualGroup.questions[found];
      if (found === undefined || !actualQuestion) {
        out.push({ path: `${questionPath}[${position}]`, expected: json(briefQuestion(question)), actual: null });
        return;
      }
      matched.add(found);
      diffQuestion(`${questionPath}[${position}]`, question, actualQuestion, out);
    });
    actualGroup.questions.forEach((question, position) => {
      if (!matched.has(position)) out.push({ path: `${questionPath}[${position}]`, expected: null, actual: json(briefQuestion(question)) });
    });
    const commonExpected = expectedGroup.questions.filter((question) => actualIndex.has(question.code)).map((question) => question.code);
    const commonActual = actualGroup.questions.filter((_question, position) => matched.has(position)).map((question) => question.code);
    if (canonicalJson(commonExpected) !== canonicalJson(commonActual)) {
      out.push({ path: questionPath, expected: commonExpected, actual: commonActual });
    }
  }
  return out;
}

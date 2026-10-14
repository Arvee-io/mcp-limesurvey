/**
 * Comparing two survey descriptions. normalizeSpec brings a spec (as written by a person, or as read from a live
 * survey) into one comparable form: texts as a map per language, every default filled in, attribute values that equal
 * the default of their question theme left out. diffSpecs lists where two such forms differ.
 */
import { createHash } from "node:crypto";
import { ATTRIBUTE_DEFAULTS, BASE_THEME_BY_TYPE, I18N_ATTRIBUTES } from "./attribute-defaults.js";
import { unescapeHtmlSafe } from "./html-unescape.js";
import { asString, CORE_THEME, isRecord, normalizeExpires, SURVEY_DEFAULTS, truthy, type TextMap } from "./spec-model.js";
import type { JsonValue } from "./types.js";

export type { TextMap };
export type AttributeValue = string | TextMap;
/** A default value: a text per language, or (with same_default) one string for all languages. */
export type DefaultValue = string | TextMap;

export interface ComparableAnswer {
  code: string;
  text: TextMap;
  assessment_value: number;
  scale_id?: number;
  /** Only when it is not 1 (a Ranking entry with a condition). */
  relevance?: string;
}

export interface ComparableSubquestion {
  code: string;
  text: TextMap;
  scale_id?: number;
  /** Only when it is not 1. */
  relevance?: string;
  default?: DefaultValue;
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
  /** The optional fields below are there only when they carry a value. */
  preg?: string;
  encrypted?: true;
  same_default?: true;
  same_script?: true;
  modulename?: string;
  script?: TextMap;
  default?: DefaultValue;
  default_other?: DefaultValue;
}

export interface ComparableGroup {
  title: TextMap;
  description: TextMap;
  relevance: string;
  randomization_group?: string;
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

/** CRLF (and a lone CR, which an XML parser also turns into LF) to LF, trimmed when asked, then the safe entity decoding. */
function clean(value: string, trim: boolean): string {
  const lines = value.replace(/\r\n?/g, "\n");
  return unescapeHtmlSafe(trim ? lines.trim() : lines);
}

/** Codes, relevance, language codes and the like: always trimmed. */
const cleanText = (value: unknown): string => clean(asString(value), true);

/** A text in the normal form of a spec read from a survey (LF, safe entity decoding, not trimmed). */
export const normalText = (value: string): string => clean(value, false);

/** A script in the normal form of a spec: only the line endings become LF (a script is code). */
export const normalScript = (value: string): string => value.replace(/\r\n?/g, "\n");

/** How the texts, scripts and attribute values of a spec are cleaned: trimmed (to compare), as read, or raw. */
interface Cleaning {
  text: (value: unknown) => string;
  script: (value: unknown) => string;
  attribute: (value: unknown) => string;
}

const attributeText = (value: unknown, text: (item: string) => string): string => {
  if (typeof value === "string") return text(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
};

function cleaning(trim: boolean, raw: boolean): Cleaning {
  // Raw: the values exactly as LimeSurvey stores them (CRLF and entities kept), for writing unchanged texts back.
  if (raw) return { text: (value) => asString(value), script: (value) => asString(value), attribute: (value) => attributeText(value, (item) => item) };
  return {
    text: (value) => clean(asString(value), trim),
    script: (value) => rawText(value),
    attribute: (value) => attributeText(value, (item) => clean(item, trim)),
  };
}

/** A string counts for every language; a map keeps its languages. */
function textMap(value: unknown, languages: readonly string[], convert: (item: unknown) => string): TextMap {
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

/**
 * Text that is kept as written, except that line endings become LF (a script is code: no trimming, no decoding; an
 * import turns CRLF into LF, so a spec with CRLF and the survey read back must come out the same).
 */
const rawText = (value: unknown): string => asString(value).replace(/\r\n?/g, "\n");

/**
 * Attribute values that equal the default of the question theme are left out. A language-dependent attribute (one of
 * the 16 known ones, or any attribute given as a map) is left out when every language holds the default, and otherwise
 * kept with every language, so that the map names the languages of the survey (as the validator demands).
 */
function normalizeAttributes(
  attributes: unknown,
  theme: string,
  languages: readonly string[],
  cleaner: Cleaning,
): Record<string, AttributeValue> {
  const defaults = Object.hasOwn(ATTRIBUTE_DEFAULTS, theme) ? ATTRIBUTE_DEFAULTS[theme] : undefined;
  const defaultOf = (name: string): string | undefined => (defaults && Object.hasOwn(defaults, name) ? defaults[name] : undefined);
  const result: Record<string, AttributeValue> = {};
  if (!isRecord(attributes)) return result;
  for (const name of Object.keys(attributes).sort()) {
    const value = attributes[name];
    if (I18N_ATTRIBUTES.has(name) || isRecord(value)) {
      const perLanguage = textMap(value, languages, cleaner.attribute);
      if (!Object.values(perLanguage).every((item) => item === defaultOf(name))) result[name] = perLanguage;
    } else {
      const text = cleaner.attribute(value);
      if (text !== defaultOf(name)) result[name] = text;
    }
  }
  return result;
}

/** A default value: empty values dropped; with same_default one string (the value of the base language). */
function normalizeDefault(value: unknown, languages: readonly string[], sameDefault: boolean, cleaner: Cleaning): DefaultValue | undefined {
  if (value === undefined || value === null) return undefined;
  const entries = Object.entries(textMap(value, languages, cleaner.text)).filter(([, text]) => text !== "");
  if (entries.length === 0) return undefined;
  if (!sameDefault) return Object.fromEntries(entries);
  const base = languages[0];
  return (entries.find(([language]) => language === base) ?? entries[0])?.[1];
}

function normalizeQuestionForCompare(question: Record<string, unknown>, languages: readonly string[], cleaner: Cleaning): ComparableQuestion {
  const type = asString(question.type);
  const base = baseTheme(type);
  // The theme name core, like none, is the base theme of the type: nothing to state, and its defaults apply.
  const explicitTheme = asString(question.question_theme_name);
  const extendedTheme = explicitTheme !== "" && explicitTheme !== CORE_THEME && explicitTheme !== base ? explicitTheme : "";
  const scale = (item: Record<string, unknown>): { scale_id?: number } => {
    const scaleId = integer(item.scale_id);
    return scaleId === 0 ? {} : { scale_id: scaleId };
  };
  const relevanceOf = (item: Record<string, unknown>): { relevance?: string } => {
    const relevance = cleanText(item.relevance) || "1";
    return relevance === "1" ? {} : { relevance };
  };
  const sameDefault = truthy(question.same_default);
  const defaultValue = normalizeDefault(question.default, languages, sameDefault, cleaner);
  const defaultOther = normalizeDefault(question.default_other, languages, sameDefault, cleaner);
  const script = textMap(question.script, languages, cleaner.script);
  const preg = rawText(question.preg);
  const modulename = rawText(question.modulename);
  return {
    code: cleanText(question.code),
    type,
    text: textMap(question.text, languages, cleaner.text),
    help: textMap(question.help, languages, cleaner.text),
    mandatory: question.mandatory === "soft" ? "soft" : truthy(question.mandatory),
    relevance: cleanText(question.relevance) || "1",
    other: truthy(question.other),
    attributes: normalizeAttributes(question.attributes, extendedTheme || base, languages, cleaner),
    subquestions: records(question.subquestions).map((item) => {
      const subDefault = normalizeDefault(item.default, languages, sameDefault, cleaner);
      return {
        code: cleanText(item.code),
        text: textMap(item.text, languages, cleaner.text),
        ...scale(item),
        ...relevanceOf(item),
        ...(subDefault !== undefined ? { default: subDefault } : {}),
      };
    }),
    answers: records(question.answers).map((item) => ({
      code: cleanText(item.code),
      text: textMap(item.text, languages, cleaner.text),
      assessment_value: integer(item.assessment_value),
      ...scale(item),
      ...relevanceOf(item),
    })),
    ...(extendedTheme !== "" ? { question_theme_name: extendedTheme } : {}),
    ...(preg !== "" ? { preg } : {}),
    ...(truthy(question.encrypted) ? { encrypted: true as const } : {}),
    ...(sameDefault ? { same_default: true as const } : {}),
    ...(truthy(question.same_script) ? { same_script: true as const } : {}),
    ...(modulename !== "" ? { modulename } : {}),
    ...(Object.values(script).some((text) => text !== "") ? { script } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(defaultOther !== undefined ? { default_other: defaultOther } : {}),
  };
}

/**
 * The normal form of a spec. The texts and attribute values keep their surrounding blanks, so what a survey holds comes
 * out as it is; with trim true they are trimmed, which is how two forms are compared (LimeSurvey may trim a text it stores).
 * With raw true the texts, scripts and attribute values are not cleaned at all (the same structure, the stored values).
 */
export function normalizeSpec(spec: unknown, languages: readonly string[], options: { trim?: boolean; raw?: boolean } = {}): ComparableSpec {
  const cleaner = cleaning(options.trim === true, options.raw === true);
  const root = isRecord(spec) ? spec : {};
  const survey = isRecord(root.survey) ? root.survey : {};
  const language = cleanText(survey.language ?? SURVEY_DEFAULTS.language);
  const additional = Array.isArray(survey.additional_languages) ? survey.additional_languages : [];
  const adminemail = cleanText(survey.adminemail);
  const template = cleanText(survey.template);
  return {
    survey: {
      title: textMap(survey.title, languages, cleaner.text),
      description: textMap(survey.description, languages, cleaner.text),
      welcometext: textMap(survey.welcometext, languages, cleaner.text),
      endtext: textMap(survey.endtext, languages, cleaner.text),
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
    groups: records(root.groups).map((group) => {
      const randomization = rawText(group.randomization_group);
      return {
        title: textMap(group.title, languages, cleaner.text),
        description: textMap(group.description, languages, cleaner.text),
        relevance: cleanText(group.relevance) || "1",
        ...(randomization !== "" ? { randomization_group: randomization } : {}),
        questions: records(group.questions).map((question) => normalizeQuestionForCompare(question, languages, cleaner)),
      };
    }),
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
    diffValue(`${path}.randomization_group`, expectedGroup.randomization_group, actualGroup.randomization_group, out);
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

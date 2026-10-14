/**
 * Local check of a survey description (spec): every problem is collected, each with the path of the offending value
 * (0-based, for example groups[1].questions[3].answers[0].code), a message and a fix. Nothing here talks to
 * LimeSurvey; checks that need the live survey get their data through the optional context.
 */
import {
  ANSWER_CODE_MAX_LENGTH,
  ANSWER_CODE_PATTERN,
  ANSWER_KEYS,
  ATTRIBUTE_NAME_PATTERN,
  DEFAULT_OTHER_ALLOWED,
  GROUP_KEYS,
  LANGUAGE_CODE_PATTERN,
  MAX_QUESTION_CODE_LENGTH,
  NEED_ANSWERS,
  NEED_BOTH,
  NEED_SUBQUESTIONS,
  NO_DEFAULT_TYPES,
  OTHER_ALLOWED,
  QUESTION_CODE_PATTERN,
  QUESTION_KEYS,
  RESERVED_CODES,
  SHOWQNUMCODE_VALUES,
  SUBQUESTION_CODE_PATTERN,
  SUBQUESTION_KEYS,
  SUPPORTED_TYPES,
  CORE_THEME,
  SURVEY_BOOLEAN_KEYS,
  SURVEY_DEFAULTS,
  SURVEY_FORMATS,
  SURVEY_KEYS,
  SURVEY_TEXT_KEYS,
  THEME_NAME_PATTERN,
  TWO_ANSWER_SCALES,
  TWO_SCALE_TYPES,
  TWO_SUBQUESTION_SCALES,
  checkExpires,
  isKnownLanguageIndependent,
  isRecord,
  surveyLanguages,
  unescapeStrings,
  type SpecKind,
} from "./spec-model.js";
import { ATTRIBUTE_NAMES, BASE_THEME_BY_TYPE, I18N_ATTRIBUTES, THEME_TYPES } from "./attribute-defaults.js";

/** The attribute names per question theme (core and extended themes of LimeSurvey 6 and 7). */
const THEME_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(ATTRIBUTE_NAMES).map(([theme, names]) => [theme, new Set(names)]),
);
/** Every attribute name some theme defines; a name outside it (a plugin attribute) is not held to a theme. */
const THEME_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set(Object.values(ATTRIBUTE_NAMES).flat());

/** The theme whose attributes a question uses: question_theme_name, or (none or core) the base theme of the type. */
function themeOfQuestion(question: Record<string, unknown>): string | undefined {
  const theme = typeof question.question_theme_name === "string" ? question.question_theme_name.trim() : "";
  if (theme !== "" && theme !== CORE_THEME) return theme;
  const type = typeof question.type === "string" ? question.type : "";
  return Object.hasOwn(BASE_THEME_BY_TYPE, type) ? BASE_THEME_BY_TYPE[type] : undefined;
}

export type SpecFinding = { path: string; message: string; fix: string };
export type SpecWarning = { path: string; message: string };

/** What the live survey adds to the check (read by the caller; the validator itself never reads anything). */
export interface SpecContext {
  /** Question codes that already exist in the target survey. */
  existingQuestionCodes?: readonly string[];
  /**
   * The languages of the target survey, base language first. For kind group and question they are what a language map
   * is held to; for kind survey the languages come from survey.language and survey.additional_languages.
   */
  languages?: readonly string[];
  /**
   * The LimeSurvey generation of the target instance (6 or 7), when the caller knows it. It decides what an entry of a
   * Ranking question may have: on 7 a code of up to 20 characters and a relevance, on 6 neither. Without it both are
   * allowed and reported as a warning.
   */
  rankingGeneration?: 6 | 7;
  /**
   * Embedded data URIs are not reported (limesurvey_update_question_from_spec reports them as the risk data_uri, because
   * an unchanged text of the question may hold one).
   */
  allowDataUri?: boolean;
  /**
   * Paths of language maps that may name only some of the languages (texts of an existing question that have no row in
   * a language: an unchanged translation gap), for example text or subquestions[0].text.
   */
  subsetPaths?: ReadonlySet<string>;
}

export type SpecSummary = { groups?: number; questions?: number; subquestions?: number; answers?: number; type?: string };

export interface SpecValidation {
  valid: boolean;
  errors: SpecFinding[];
  warnings: SpecWarning[];
  summary: SpecSummary;
}

/** Characters XML 1.0 cannot store: control characters, the non-characters U+FFFE and U+FFFF and unpaired surrogates. */
const XML_FORBIDDEN_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/u;
/** An image embedded as a data URI, which LimeSurvey removes from a text whenever it saves the row. */
export const DATA_URI_SOURCE = /src\s*=\s*["']?\s*data:/i;
const TEXT_FIX = "Give one string (it is used for every language of the survey) or a map per language such as {\"de\": \"...\", \"en\": \"...\"}.";

const keyPath = (base: string, name: string): string => (base === "" ? name : `${base}.${name}`);
const indexPath = (base: string, index: number): string => `${base}[${index}]`;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return "a number";
  return `a ${typeof value}`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function closestKey(name: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of allowed) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

class Findings {
  readonly errors: SpecFinding[] = [];
  readonly warnings: SpecWarning[] = [];

  error(path: string, message: string, fix: string): void {
    this.errors.push({ path, message, fix });
  }

  warning(path: string, message: string): void {
    this.warnings.push({ path, message });
  }
}

interface Scope {
  /** Question codes seen so far in the checked spec (lower case) -> path of the first occurrence. */
  seenCodes: Map<string, string>;
  /** Question codes of the live survey (lower case). */
  existingCodes: Set<string>;
  /** The languages a language map is held to (base language first); undefined when they are not known. */
  languages: readonly string[] | undefined;
  /** The LimeSurvey generation of the target instance when it is known; it decides what a Ranking entry may have. */
  generation: 6 | 7 | undefined;
  /** Map paths that may name only some of the languages (SpecContext.subsetPaths). */
  subsetPaths: ReadonlySet<string>;
  counters: { groups: number; questions: number; subquestions: number; answers: number };
}

function checkKeys(findings: Findings, path: string, value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const name of Object.keys(value)) {
    if (allowed.includes(name)) continue;
    const suggestion = closestKey(name, allowed);
    findings.error(
      keyPath(path, name),
      `Unknown key "${name}" in ${where}.`,
      `${suggestion ? `Did you mean "${suggestion}"? ` : ""}Remove the key or use one of: ${allowed.join(", ")}.`,
    );
  }
}

const quoted = (items: readonly string[]): string => items.map((item) => JSON.stringify(item)).join(", ");

interface MapOptions {
  required: boolean;
  /** An empty entry of a required map is a warning, not an error (a question, subquestion or answer text). */
  warnEmpty?: boolean;
  /** A default value may name only some of the languages of the survey. */
  subset: boolean;
  /** An attribute value may also be a number. */
  numbers: boolean;
}

const EMPTY_TEXT_WARNING = "This text is empty; LimeSurvey stores it, but nothing is shown for it.";

/** An empty text: an error, or (a question, subquestion or answer text) a warning. */
function emptyText(findings: Findings, path: string, warnEmpty: boolean | undefined): void {
  if (warnEmpty === true) findings.warning(path, EMPTY_TEXT_WARNING);
  else findings.error(path, "This text must not be empty.", "Give a non-empty string.");
}

/**
 * A language map: one string (an attribute: or a number) per language code. When the languages of the survey are known,
 * the keys must be exactly these languages (a default value may name fewer, but none that the survey lacks).
 */
function checkLanguageMap(findings: Findings, path: string, map: Record<string, unknown>, scope: Scope, options: MapOptions): void {
  const keys = Object.keys(map);
  if (keys.length === 0) {
    findings.error(path, "The language map is empty.", TEXT_FIX);
    return;
  }
  for (const key of keys) {
    const entry = map[key];
    const entryPath = keyPath(path, key);
    if (typeof entry === "string") {
      if (options.required && entry.trim() === "") emptyText(findings, entryPath, options.warnEmpty);
    } else if (!(options.numbers && typeof entry === "number" && Number.isFinite(entry))) {
      findings.error(entryPath, `The entry must be a string${options.numbers ? " or a number" : ""}, got ${describeValue(entry)}.`, TEXT_FIX);
    }
  }
  const languages = scope.languages;
  if (languages === undefined) {
    for (const key of keys) {
      if (!LANGUAGE_CODE_PATTERN.test(key)) {
        findings.error(keyPath(path, key), `${JSON.stringify(key)} is not a language code.`, "Use language codes such as de, en or pt-BR as the keys of the map.");
      }
    }
    return;
  }
  for (const key of keys) {
    if (!languages.includes(key)) {
      findings.error(
        keyPath(path, key),
        `The language ${key} is not a language of the survey (the survey has ${languages.join(", ")}).`,
        `Remove ${JSON.stringify(key)}, or add the language to the survey (survey.language, survey.additional_languages).`,
      );
    }
  }
  if (options.subset || scope.subsetPaths.has(path)) return;
  const missing = languages.filter((language) => !keys.includes(language));
  if (missing.length > 0) {
    findings.error(
      path,
      `The map has no entry for the language${missing.length > 1 ? "s" : ""} ${quoted(missing)} (the survey has ${languages.join(", ")}).`,
      `Add ${quoted(missing)} to the map, or give one string that is used for every language.`,
    );
  }
}

/** A text field: one string for every language, or a map per language. */
function checkText(
  findings: Findings,
  path: string,
  value: unknown,
  scope: Scope,
  options: { required: boolean; subset?: boolean; warnEmpty?: boolean },
): void {
  if (value === undefined) {
    if (options.required) findings.error(path, "This text is required.", `Add "${path.split(".").pop() ?? path}" with a string (it may be empty).`);
    return;
  }
  if (isRecord(value)) {
    checkLanguageMap(findings, path, value, scope, {
      required: options.required,
      ...(options.warnEmpty !== undefined ? { warnEmpty: options.warnEmpty } : {}),
      subset: options.subset === true,
      numbers: false,
    });
  } else if (typeof value !== "string") {
    findings.error(path, `A text must be a string or a language map, got ${describeValue(value)}.`, TEXT_FIX);
  } else if (options.required && value.trim() === "") {
    emptyText(findings, path, options.warnEmpty);
  }
}

/** A field that is one string for the whole survey (a relevance, a regular expression, a name). */
function checkPlainString(findings: Findings, path: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    findings.error(path, `Must be a string, got ${describeValue(value)}.`, "Use one string; this field is not stored per language.");
  }
}

function checkBoolean(findings: Findings, path: string, value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") {
    findings.error(path, `Must be true or false, got ${describeValue(value)}.`, "Use the JSON value true or false (not a string).");
  }
}

/** A Yes/No survey setting: true, false or "inherit" (the setting of the survey group or the installation). */
function checkFlag(findings: Findings, path: string, value: unknown): void {
  if (value !== undefined && typeof value !== "boolean" && value !== "inherit") {
    findings.error(path, `Must be true, false or "inherit", got ${describeValue(value)}.`, 'Use the JSON value true or false, or "inherit".');
  }
}

/** The languages a spec of kind survey names: survey.language (default de) and survey.additional_languages. */
function languagesOfSurveySpec(survey: unknown): string[] | undefined {
  if (!isRecord(survey)) return undefined;
  const base = survey.language === undefined ? SURVEY_DEFAULTS.language : survey.language;
  if (typeof base !== "string" || !LANGUAGE_CODE_PATTERN.test(base)) return undefined;
  const additional = survey.additional_languages;
  if (additional === undefined || additional === null) return [base];
  if (!Array.isArray(additional)) return undefined;
  const valid = additional.filter((item): item is string => typeof item === "string" && LANGUAGE_CODE_PATTERN.test(item));
  if (valid.length !== additional.length) return undefined;
  return [...new Set(surveyLanguages(base, valid))];
}

function checkLanguage(findings: Findings, path: string, value: unknown): void {
  if (typeof value !== "string" || !LANGUAGE_CODE_PATTERN.test(value)) {
    findings.error(
      path,
      `${typeof value === "string" ? JSON.stringify(value) : describeValue(value)} is not a language code.`,
      "Use a code such as de, en or pt-BR (2-3 letters, optional subtags).",
    );
  }
}

function listOf(value: unknown): unknown[] | "invalid" {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : "invalid";
}

function validateSurveyObject(findings: Findings, survey: unknown, path: string, scope: Scope): void {
  if (!isRecord(survey)) {
    findings.error(path, "survey is required and must be an object.", 'Add "survey": { "title": "..." }.');
    return;
  }
  checkKeys(findings, path, survey, SURVEY_KEYS, "the survey settings");
  const title = survey.title;
  if (title === undefined || (typeof title === "string" && title.trim() === "")) {
    findings.error(keyPath(path, "title"), "survey.title is missing or empty.", 'Add "title" with the survey title.');
  } else {
    checkText(findings, keyPath(path, "title"), title, scope, { required: true });
  }
  for (const name of SURVEY_TEXT_KEYS) {
    if (name !== "title") checkText(findings, keyPath(path, name), survey[name], scope, { required: false });
  }
  if (survey.language !== undefined) checkLanguage(findings, keyPath(path, "language"), survey.language);
  const additional = survey.additional_languages;
  if (additional !== undefined && additional !== null) {
    if (!Array.isArray(additional)) {
      findings.error(keyPath(path, "additional_languages"), "additional_languages must be a list of language codes.", 'Use a list such as ["en"].');
    } else {
      // A language may appear once and not as the base language (case is ignored, like LimeSurvey does).
      const base = survey.language === undefined ? SURVEY_DEFAULTS.language : survey.language;
      const baseKey = typeof base === "string" && LANGUAGE_CODE_PATTERN.test(base) ? base.toLowerCase() : undefined;
      const seen = new Map<string, string>();
      additional.forEach((language, index) => {
        const languagePath = indexPath(keyPath(path, "additional_languages"), index);
        checkLanguage(findings, languagePath, language);
        if (typeof language !== "string" || !LANGUAGE_CODE_PATTERN.test(language)) return;
        const key = language.toLowerCase();
        if (key === baseKey) {
          findings.error(
            languagePath,
            `The language ${language} is the base language of the survey (survey.language, default ${SURVEY_DEFAULTS.language}).`,
            "Remove it from additional_languages; the base language is always part of the survey.",
          );
        } else if (seen.has(key)) {
          findings.error(languagePath, `The language ${language} is listed twice (first at ${seen.get(key)}; case is ignored).`, "List every additional language once.");
        } else {
          seen.set(key, languagePath);
        }
      });
    }
  }
  for (const name of SURVEY_BOOLEAN_KEYS) checkFlag(findings, keyPath(path, name), survey[name]);
  for (const name of ["format", "adminemail"] as const) {
    if (survey[name] !== undefined && typeof survey[name] !== "string") {
      findings.error(keyPath(path, name), `Must be a string, got ${describeValue(survey[name])}.`, "Use a string.");
    }
  }
  const format = survey.format;
  if (typeof format === "string" && !(SURVEY_FORMATS as readonly string[]).includes(format)) {
    findings.error(
      keyPath(path, "format"),
      `format ${JSON.stringify(format)} is not allowed.`,
      "Use G (group by group), S (question by question), A (all in one page) or I (inherit), or leave format out for G.",
    );
  }
  const expires = survey.expires;
  if (expires !== undefined && expires !== null && expires !== "") {
    const check = typeof expires === "string" ? checkExpires(expires) : "format";
    if (check === "format") {
      findings.error(
        keyPath(path, "expires"),
        `expires ${JSON.stringify(expires)} has an unsupported format.`,
        "Use YYYY-MM-DD HH:MM:SS or YYYY-MM-DD (end of that day), or leave expires out.",
      );
    } else if (check === "calendar") {
      findings.error(
        keyPath(path, "expires"),
        `expires ${JSON.stringify(expires)} is not a real date or time.`,
        "Use a date that exists (mind the month length and leap years) and a time from 00:00:00 to 23:59:59, or leave expires out.",
      );
    }
  }
  const showqnumcode = survey.showqnumcode;
  if (showqnumcode !== undefined && (typeof showqnumcode !== "string" || !(SHOWQNUMCODE_VALUES as readonly string[]).includes(showqnumcode))) {
    findings.error(
      keyPath(path, "showqnumcode"),
      `showqnumcode ${JSON.stringify(showqnumcode)} is not allowed.`,
      `Use one of: ${SHOWQNUMCODE_VALUES.join(", ")}.`,
    );
  }
  const template = survey.template;
  if (template !== undefined && (typeof template !== "string" || template.trim() === "")) {
    findings.error(keyPath(path, "template"), "template must be a non-empty theme name.", "Give the theme name or leave template out to inherit it.");
  }
}

/**
 * scale_id of a subquestion or answer: 0 or 1. Scale 1 exists only for the subquestions of : and ; (the columns) and the
 * answers of 1 (the second answer scale); scale 0, the scale of every other item, may always be given. Returns the scale
 * the code is unique in (LimeSurvey: subquestion codes per parent and scale, Question.php:203-217 and 286-297; answer codes
 * per question and scale, Answer.php:76-100 and 126-129).
 */
function checkScale(findings: Findings, itemPath: string, value: unknown, type: string, list: "subquestions" | "answers"): string {
  if (value === undefined) return "0";
  const scalePath = keyPath(itemPath, "scale_id");
  if (value !== 0 && value !== 1) {
    findings.error(
      scalePath,
      `scale_id must be 0 or 1, got ${typeof value === "number" ? String(value) : describeValue(value)}.`,
      "Use 0 (the first scale) or 1 (the second scale: the columns of the types : and ;, the second answer scale of type 1), or leave scale_id out for scale 0.",
    );
    return JSON.stringify(value) ?? "?";
  }
  if (value === 1 && SUPPORTED_TYPES.has(type)) {
    if (list === "subquestions" && !TWO_SUBQUESTION_SCALES.has(type)) {
      findings.error(
        scalePath,
        `Type ${type} has one subquestion scale, so a subquestion cannot be on scale 1; only the types : and ; have a second subquestion scale (the columns).`,
        type === "1"
          ? "Remove scale_id: the subquestions of type 1 are its rows on scale 0; its second scale is an answer scale (answers[].scale_id)."
          : "Remove scale_id, or use the type : or ; for an array with rows and columns.",
      );
    } else if (list === "answers" && !TWO_ANSWER_SCALES.has(type)) {
      findings.error(
        scalePath,
        `Type ${type} has ${TWO_SUBQUESTION_SCALES.has(type) ? "no answers" : "one answer scale"}, so an answer cannot be on scale 1; only type 1 has a second answer scale.`,
        TWO_SUBQUESTION_SCALES.has(type)
          ? "Make the columns subquestions with scale_id 1 and remove answers."
          : "Remove scale_id, or use type 1 for two answer scales.",
      );
    }
  }
  return String(value);
}

function validateAnswers(findings: Findings, path: string, answers: unknown[], question: Record<string, unknown>, scope: Scope): void {
  const seen = new Set<string>();
  const type = typeof question.type === "string" ? question.type : "";
  answers.forEach((answer, index) => {
    const answerPath = indexPath(path, index);
    scope.counters.answers += 1;
    if (!isRecord(answer)) {
      findings.error(answerPath, `An answer must be an object, got ${describeValue(answer)}.`, 'Use { "code": "A1", "text": "..." }.');
      return;
    }
    checkKeys(findings, answerPath, answer, ANSWER_KEYS, "an answer");
    const scale = checkScale(findings, answerPath, answer.scale_id, type, "answers");
    const twoScales = TWO_ANSWER_SCALES.has(type);
    // LimeSurvey 7 stores the entries of a Ranking question as subquestions: a code of up to 20 characters and a
    // relevance. LimeSurvey 6 keeps answers (up to 5 characters, no relevance). Without the version both are allowed
    // and reported as a warning.
    const isRanking = question.type === "R";
    const longCodes = isRanking && scope.generation !== 6;
    const code = answer.code;
    const codePath = keyPath(answerPath, "code");
    if (typeof code !== "string" || !(longCodes ? SUBQUESTION_CODE_PATTERN : ANSWER_CODE_PATTERN).test(code)) {
      findings.error(
        codePath,
        `The answer code ${JSON.stringify(code)} is invalid (${longCodes ? "1-20 letters or digits" : "1-5 letters or digits"}).`,
        `Use ${longCodes ? "1-20" : "1-5"} letters or digits, for example A1 or 3.`,
      );
    } else if (seen.has(`${scale}:${code.toLowerCase()}`)) {
      findings.error(
        codePath,
        `The answer code ${code} is used twice ${twoScales ? `on scale ${scale} of` : "in"} this question.`,
        twoScales
          ? "Give every answer of a scale a different code (case is ignored); the same code may stand once on each scale."
          : "Give every answer a different code (case is ignored).",
      );
    } else {
      seen.add(`${scale}:${code.toLowerCase()}`);
      if (longCodes && scope.generation === undefined && code.length > ANSWER_CODE_MAX_LENGTH) {
        findings.warning(
          codePath,
          `The code ${code} has more than ${ANSWER_CODE_MAX_LENGTH} characters: the code of an entry of a Ranking question may be that long only on LimeSurvey 7 (this check does not know the version).`,
        );
      }
    }
    checkText(findings, keyPath(answerPath, "text"), answer.text, scope, { required: true, warnEmpty: true });
    const value = answer.assessment_value;
    if (value !== undefined && !(typeof value === "number" && Number.isInteger(value))) {
      findings.error(keyPath(answerPath, "assessment_value"), "assessment_value must be a whole number.", "Use an integer such as 0 or 3.");
    }
    const relevance = answer.relevance;
    const relevancePath = keyPath(answerPath, "relevance");
    if (relevance !== undefined) {
      if (typeof relevance !== "string") {
        checkPlainString(findings, relevancePath, relevance);
      } else if (relevance.trim() !== "" && relevance.trim() !== "1") {
        if (!isRanking) {
          findings.error(relevancePath, "Only the entries of a Ranking question (type R) take a relevance.", "Remove relevance from this answer.");
        } else if (scope.generation === 6) {
          findings.error(
            relevancePath,
            "A relevance on an entry of a Ranking question exists only on LimeSurvey 7; this instance runs LimeSurvey 6.",
            "Remove relevance (or set it to 1), or create the survey on a LimeSurvey 7 instance.",
          );
        } else if (scope.generation === undefined) {
          findings.warning(
            relevancePath,
            "A relevance on an entry of a Ranking question works only on LimeSurvey 7 (this check does not know the version).",
          );
        }
      }
    }
  });
}

/** same_default: one default for all languages, so every language value of a default must be the same. */
function checkSameDefault(findings: Findings, path: string, value: unknown, sameDefault: boolean): void {
  if (!sameDefault || !isRecord(value)) return;
  const texts = new Set(Object.values(value).filter((item) => typeof item === "string"));
  if (texts.size > 1) {
    findings.error(
      path,
      "same_default is true, so the default value is the same for every language, but the map has different values.",
      "Give one string, or the same value for every language.",
    );
  }
}

/** default, default_other and the default of a subquestion: a text that may name only some of the languages. */
function checkDefault(findings: Findings, path: string, value: unknown, scope: Scope, sameDefault: boolean): void {
  checkText(findings, path, value, scope, { required: false, subset: true });
  checkSameDefault(findings, path, value, sameDefault);
}

function validateSubquestions(findings: Findings, path: string, subquestions: unknown[], question: Record<string, unknown>, scope: Scope): void {
  const seen = new Set<string>();
  const type = typeof question.type === "string" ? question.type : "";
  const twoScales = TWO_SUBQUESTION_SCALES.has(type);
  subquestions.forEach((item, index) => {
    const itemPath = indexPath(path, index);
    scope.counters.subquestions += 1;
    if (!isRecord(item)) {
      findings.error(itemPath, `A subquestion must be an object, got ${describeValue(item)}.`, 'Use { "code": "SQ001", "text": "..." }.');
      return;
    }
    checkKeys(findings, itemPath, item, SUBQUESTION_KEYS, "a subquestion");
    const scale = checkScale(findings, itemPath, item.scale_id, type, "subquestions");
    const code = item.code;
    const codePath = keyPath(itemPath, "code");
    if (typeof code !== "string" || !SUBQUESTION_CODE_PATTERN.test(code)) {
      findings.error(codePath, `The subquestion code ${JSON.stringify(code)} is invalid (1-20 letters or digits).`, "Use 1-20 letters or digits, for example SQ001.");
    } else if (code.toLowerCase() === "time") {
      findings.error(codePath, 'The subquestion code "time" is reserved by LimeSurvey.', "Use another code, for example SQ001.");
    } else if (seen.has(`${scale}:${code.toLowerCase()}`)) {
      findings.error(
        codePath,
        `The subquestion code ${code} is used twice ${twoScales ? `on scale ${scale} of` : "in"} this question.`,
        twoScales
          ? "Give every subquestion of a scale a different code (case is ignored); the same code may stand once on each scale (a row and a column)."
          : "Give every subquestion a different code (case is ignored).",
      );
    } else if (question.other === true && code.toLowerCase() === "other") {
      findings.error(codePath, 'With other=true the code "other" belongs to the "Other" option.', "Use another code or set other to false.");
    } else if (question.type === "P" && code.toLowerCase().endsWith("comment")) {
      findings.error(codePath, 'In a P question a code ending in "comment" collides with the comment field of another option.', 'Use a code that does not end in "comment".');
    } else {
      seen.add(`${scale}:${code.toLowerCase()}`);
    }
    checkText(findings, keyPath(itemPath, "text"), item.text, scope, { required: true, warnEmpty: true });
    checkPlainString(findings, keyPath(itemPath, "relevance"), item.relevance);
    checkDefault(findings, keyPath(itemPath, "default"), item.default, scope, question.same_default === true);
    if (item.default !== undefined && TWO_SCALE_TYPES.has(type)) {
      findings.error(
        keyPath(itemPath, "default"),
        `LimeSurvey has no default value for the subquestions of a type ${type} question (the type keeps no default values).`,
        "Remove default from the subquestion.",
      );
    }
  });
}

/** How many items of a list are on the scale (no scale_id counts as scale 0). */
const onScale = (items: unknown[], scale: number): number => items.filter((item) => isRecord(item) && (item.scale_id ?? 0) === scale).length;

function validateAttributes(findings: Findings, path: string, attributes: unknown, scope: Scope, question: Record<string, unknown>): void {
  if (attributes === undefined || attributes === null) return;
  if (!isRecord(attributes)) {
    findings.error(path, `attributes must be an object, got ${describeValue(attributes)}.`, 'Use { "attribute_name": "value" }.');
    return;
  }
  // An attribute some theme defines but the theme of this question does not: LimeSurvey does not use it, and the import
  // does not keep it. A theme the tables do not know (a custom theme) and plugin attributes are not checked.
  const theme = themeOfQuestion(question);
  const themeAttributes = theme === undefined ? undefined : THEME_ATTRIBUTES.get(theme);
  const type = typeof question.type === "string" ? question.type : "";
  const extended = theme !== undefined && theme !== BASE_THEME_BY_TYPE[type];
  for (const [name, value] of Object.entries(attributes)) {
    const attributePath = keyPath(path, name);
    if (!ATTRIBUTE_NAME_PATTERN.test(name)) {
      findings.error(
        attributePath,
        `The attribute name ${JSON.stringify(name)} is invalid.`,
        "Use 1-50 characters: a letter first, then letters, digits or underscores (for example display_columns).",
      );
    } else if (themeAttributes !== undefined && THEME_ATTRIBUTE_NAMES.has(name) && !themeAttributes.has(name)) {
      const user = extended ? `the question theme ${theme ?? ""} (type ${type})` : `type ${type}`;
      findings.error(
        attributePath,
        `The attribute ${name} is not defined for ${user}: LimeSurvey does not use it for this question and does not keep it.`,
        `${user.charAt(0).toUpperCase()}${user.slice(1)} does not use ${name}; remove it${extended ? "" : " (or use a question theme that defines it)"}.`,
      );
    }
    if (isRecord(value)) {
      // The attributes stored per language, and the ones no question theme table lists (a plugin attribute may be stored
      // per language), take a map; an attribute known to be language independent does not.
      if (I18N_ATTRIBUTES.has(name) || !isKnownLanguageIndependent(name)) {
        checkLanguageMap(findings, attributePath, value, scope, { required: false, subset: false, numbers: true });
      } else {
        findings.error(
          attributePath,
          `The attribute ${name} is not stored per language, so it takes one string or number, not a language map.`,
          "Give one string or number. Only these attributes take a value per language: " + [...I18N_ATTRIBUTES].join(", ") + ".",
        );
      }
    } else if (!(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) {
      findings.error(attributePath, `An attribute value must be a string or a number, got ${describeValue(value)}.`, 'Use a string such as "1" or a number.');
    }
  }
}

function validateQuestion(findings: Findings, question: unknown, path: string, scope: Scope): void {
  if (!isRecord(question)) {
    findings.error(path || "(spec)", `A question must be an object, got ${describeValue(question)}.`, 'Use { "code": "Q01", "type": "S", "text": "..." }.');
    return;
  }
  scope.counters.questions += 1;
  checkKeys(findings, path, question, QUESTION_KEYS, "a question");

  const code = question.code;
  const codePath = keyPath(path, "code");
  if (typeof code !== "string" || !QUESTION_CODE_PATTERN.test(code) || code.length > MAX_QUESTION_CODE_LENGTH) {
    findings.error(
      codePath,
      `The question code ${JSON.stringify(code)} is invalid (a letter first, then letters or digits, at most ${MAX_QUESTION_CODE_LENGTH} characters).`,
      "Use a code such as Q01 or A1b: start with a letter, no spaces, underscores or dots.",
    );
  } else if (RESERVED_CODES.has(code.toLowerCase())) {
    findings.error(codePath, `The question code ${code} is reserved by LimeSurvey.`, "Use another code, for example Q01.");
  } else if (scope.seenCodes.has(code.toLowerCase())) {
    findings.error(
      codePath,
      `The question code ${code} is used twice (first at ${scope.seenCodes.get(code.toLowerCase())}; case is ignored).`,
      "Give every question a different code.",
    );
  } else if (scope.existingCodes.has(code.toLowerCase())) {
    findings.error(codePath, `The question code ${code} already exists in the survey (case is ignored).`, "Choose a code that no question of the survey uses.");
  } else {
    scope.seenCodes.set(code.toLowerCase(), path === "" ? "the question" : path);
  }

  checkText(findings, keyPath(path, "text"), question.text, scope, { required: true, warnEmpty: true });
  checkText(findings, keyPath(path, "help"), question.help, scope, { required: false });
  checkText(findings, keyPath(path, "script"), question.script, scope, { required: false });
  checkPlainString(findings, keyPath(path, "relevance"), question.relevance);
  checkPlainString(findings, keyPath(path, "preg"), question.preg);
  checkPlainString(findings, keyPath(path, "modulename"), question.modulename);
  const theme = question.question_theme_name;
  if (theme !== undefined && (typeof theme !== "string" || !THEME_NAME_PATTERN.test(theme))) {
    findings.error(
      keyPath(path, "question_theme_name"),
      `The question theme name ${typeof theme === "string" ? JSON.stringify(theme) : describeValue(theme)} is invalid.`,
      "Give the name of a question theme such as listradio or bootstrap_buttons, or leave question_theme_name out for the base theme of the type.",
    );
  } else if (typeof theme === "string" && theme !== CORE_THEME && typeof question.type === "string") {
    // A theme the tables know serves certain types only (design 9.27); a theme they do not know (a custom one) is not checked.
    const types = Object.hasOwn(THEME_TYPES, theme) ? THEME_TYPES[theme] : undefined;
    if (types !== undefined && types.length > 0 && !types.includes(question.type)) {
      const base = BASE_THEME_BY_TYPE[question.type];
      findings.error(
        keyPath(path, "question_theme_name"),
        `The question theme ${theme} is for type${types.length === 1 ? "" : "s"} ${types.join(", ")}, not for type ${question.type}.`,
        `Use a question theme of type ${question.type}${base !== undefined ? ` (for example ${base})` : ""}, or leave question_theme_name out.`,
      );
    }
  }
  const mandatory = question.mandatory;
  if (mandatory !== undefined && typeof mandatory !== "boolean" && mandatory !== "soft") {
    findings.error(keyPath(path, "mandatory"), `mandatory must be true, false or "soft", got ${describeValue(mandatory)}.`, 'Use true, false or "soft".');
  }
  checkBoolean(findings, keyPath(path, "other"), question.other);
  for (const name of ["encrypted", "same_default", "same_script"] as const) checkBoolean(findings, keyPath(path, name), question[name]);
  validateAttributes(findings, keyPath(path, "attributes"), question.attributes, scope, question);
  const sameDefault = question.same_default === true;
  checkDefault(findings, keyPath(path, "default"), question.default, scope, sameDefault);
  checkDefault(findings, keyPath(path, "default_other"), question.default_other, scope, sameDefault);

  const subquestions = listOf(question.subquestions);
  const answers = listOf(question.answers);
  if (subquestions === "invalid") {
    findings.error(keyPath(path, "subquestions"), "subquestions must be a list.", 'Use [ { "code": "SQ001", "text": "..." } ].');
  }
  if (answers === "invalid") {
    findings.error(keyPath(path, "answers"), "answers must be a list.", 'Use [ { "code": "A1", "text": "..." } ].');
  }
  if (subquestions !== "invalid") validateSubquestions(findings, keyPath(path, "subquestions"), subquestions, question, scope);
  if (answers !== "invalid") validateAnswers(findings, keyPath(path, "answers"), answers, question, scope);

  const type = question.type;
  if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
    findings.error(
      keyPath(path, "type"),
      `The question type ${JSON.stringify(type)} is unknown.`,
      `Use one of: ${[...SUPPORTED_TYPES].join(" ")}.`,
    );
    return;
  }

  const hasSubquestions = subquestions !== "invalid" && subquestions.length > 0;
  const hasAnswers = answers !== "invalid" && answers.length > 0;
  const subPath = keyPath(path, "subquestions");
  const answerPath = keyPath(path, "answers");
  // The sets each type needs (research-gen-types.md section 4: LimeSurvey checks them only when the admin activates a
  // survey, activate_helper.php:131-226, never on import or RemoteControl activation, so they are checked here).
  if (type === "1") {
    // Rows on scale 0; answers on scale 0 and on scale 1 (activate_helper.php:161-171, 201-226).
    if (!hasSubquestions) findings.error(subPath, "Type 1 needs subquestions (the rows, on scale 0).", 'Add subquestions: [ { "code": "SQ001", "text": "..." } ].');
    const answerList = answers === "invalid" ? [] : answers;
    if (onScale(answerList, 0) === 0) {
      findings.error(answerPath, "Type 1 needs answers on scale 0 (the first answer scale).", 'Add answers without scale_id (scale 0): { "code": "A1", "text": "..." }.');
    }
    if (onScale(answerList, 1) === 0) {
      findings.error(answerPath, "Type 1 needs answers on scale 1 (the second answer scale).", 'Add answers with scale_id 1: { "code": "A1", "text": "...", "scale_id": 1 }.');
    }
  } else if (TWO_SUBQUESTION_SCALES.has(type)) {
    // Rows on scale 0 and columns on scale 1, no answers (activate_helper.php:161-171; CX(arrays/multiflexi):20-21).
    const subList = subquestions === "invalid" ? [] : subquestions;
    if (onScale(subList, 0) === 0) {
      findings.error(subPath, `Type ${type} needs subquestions on scale 0 (the rows).`, 'Add rows without scale_id (scale 0): { "code": "SQ001", "text": "..." }.');
    }
    if (onScale(subList, 1) === 0) {
      findings.error(subPath, `Type ${type} needs subquestions on scale 1 (the columns).`, 'Add columns with scale_id 1: { "code": "SQ001", "text": "...", "scale_id": 1 }.');
    }
    if (hasAnswers) {
      findings.error(answerPath, `Type ${type} takes no answers; its rows and columns are subquestions (scale_id 0 and 1).`, "Make the columns subquestions with scale_id 1 and remove answers.");
    }
  } else if (NEED_BOTH.has(type)) {
    if (!hasSubquestions) findings.error(subPath, `Type ${type} needs subquestions (the rows).`, 'Add subquestions: [ { "code": "SQ001", "text": "..." } ].');
    if (!hasAnswers) findings.error(answerPath, `Type ${type} needs answers (the columns).`, 'Add answers: [ { "code": "A1", "text": "..." } ].');
  } else if (NEED_SUBQUESTIONS.has(type)) {
    if (!hasSubquestions) findings.error(subPath, `Type ${type} needs subquestions.`, 'Add subquestions: [ { "code": "SQ001", "text": "..." } ].');
    if (hasAnswers) findings.error(answerPath, `Type ${type} takes no answers; its options are subquestions.`, "Move the entries to subquestions or remove answers.");
  } else if (NEED_ANSWERS.has(type)) {
    if (!hasAnswers) findings.error(answerPath, `Type ${type} needs answers.`, 'Add answers: [ { "code": "A1", "text": "..." } ].');
    if (hasSubquestions) findings.error(subPath, `Type ${type} takes no subquestions.`, "Remove subquestions or use answers.");
  } else {
    if (hasSubquestions) findings.error(subPath, `Type ${type} takes no subquestions.`, "Remove subquestions.");
    if (hasAnswers) findings.error(answerPath, `Type ${type} takes no answers.`, "Remove answers.");
  }
  if (question.other === true && !OTHER_ALLOWED.has(type)) {
    findings.error(keyPath(path, "other"), `other is only allowed for the types ${[...OTHER_ALLOWED].join(", ")}.`, "Set other to false or remove it.");
  }
  if (question.default_other !== undefined && !(DEFAULT_OTHER_ALLOWED.has(type) && question.other === true)) {
    findings.error(
      keyPath(path, "default_other"),
      `default_other is the default value of the "Other" option and only exists for the types ${[...DEFAULT_OTHER_ALLOWED].join(", ")} with other: true.`,
      "Set other to true on a type L or ! question, or remove default_other.",
    );
  }
  // A default value counts only where LimeSurvey evaluates it: on a question without subquestions, and not on R and |.
  if (question.default !== undefined) {
    const defaultPath = keyPath(path, "default");
    if (TWO_SCALE_TYPES.has(type)) {
      findings.error(defaultPath, `LimeSurvey has no default value for a type ${type} question, neither on the question nor on its subquestions.`, "Remove default.");
    } else if (NEED_SUBQUESTIONS.has(type) || NEED_BOTH.has(type)) {
      findings.error(
        defaultPath,
        `A type ${type} question keeps its default values per subquestion, so LimeSurvey ignores a default on the question itself.`,
        "Put the default on the subquestions: subquestions[].default.",
      );
    } else if (NO_DEFAULT_TYPES.has(type)) {
      findings.error(defaultPath, `LimeSurvey has no default value for a type ${type} question.`, "Remove default.");
    }
  }
}

function validateGroup(findings: Findings, group: unknown, path: string, scope: Scope): void {
  if (!isRecord(group)) {
    findings.error(path || "(spec)", `A group must be an object, got ${describeValue(group)}.`, 'Use { "title": "...", "questions": [ ... ] }.');
    return;
  }
  scope.counters.groups += 1;
  checkKeys(findings, path, group, GROUP_KEYS, "a group");
  const title = group.title;
  if (title === undefined || (typeof title === "string" && title.trim() === "")) {
    findings.error(keyPath(path, "title"), "The group title is missing or empty.", 'Add "title" with the group name.');
  } else {
    checkText(findings, keyPath(path, "title"), title, scope, { required: true });
  }
  checkText(findings, keyPath(path, "description"), group.description, scope, { required: false });
  checkPlainString(findings, keyPath(path, "relevance"), group.relevance);
  checkPlainString(findings, keyPath(path, "randomization_group"), group.randomization_group);
  const questions = listOf(group.questions);
  const questionsPath = keyPath(path, "questions");
  if (questions === "invalid") {
    findings.error(questionsPath, "questions must be a list.", 'Use "questions": [ { "code": "Q01", ... } ].');
    return;
  }
  questions.forEach((question, index) => validateQuestion(findings, question, indexPath(questionsPath, index), scope));
}

/** Every string of the spec: XML 1.0 control characters and (unless allowed) embedded data URIs. */
function checkStrings(findings: Findings, value: unknown, path: string, allowDataUri: boolean): void {
  if (typeof value === "string") {
    const forbidden = XML_FORBIDDEN_CHARACTER.exec(value);
    if (forbidden) {
      const hex = (forbidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
      findings.error(
        path,
        `The text contains the character U+${hex}, which XML 1.0 cannot store (a control character, U+FFFE, U+FFFF or an unpaired surrogate).`,
        "Remove the character (copy the text again without hidden control characters).",
      );
    }
    if (!allowDataUri && DATA_URI_SOURCE.test(value)) {
      findings.error(
        path,
        'The text embeds an image as a data URI (src="data:...") which LimeSurvey removes when it saves the text.',
        "Upload the image to LimeSurvey and link it by URL, or remove the image.",
      );
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => checkStrings(findings, item, indexPath(path, index), allowDataUri));
  } else if (isRecord(value)) {
    for (const [name, item] of Object.entries(value)) checkStrings(findings, item, keyPath(path, name), allowDataUri);
  }
}

export function validateSpec(kind: SpecKind, spec: unknown, context: SpecContext = {}): SpecValidation {
  const unescaped = unescapeStrings(spec);
  const findings = new Findings();
  const scope: Scope = {
    seenCodes: new Map(),
    existingCodes: new Set((context.existingQuestionCodes ?? []).map((code) => code.toLowerCase())),
    languages: kind === "survey" ? (isRecord(unescaped) ? languagesOfSurveySpec(unescaped.survey) : undefined) : context.languages,
    generation: context.rankingGeneration,
    subsetPaths: context.subsetPaths ?? new Set(),
    counters: { groups: 0, questions: 0, subquestions: 0, answers: 0 },
  };

  if (kind === "survey") {
    if (!isRecord(unescaped)) {
      findings.error("(spec)", `The spec must be an object, got ${describeValue(unescaped)}.`, 'Use { "survey": { "title": "..." }, "groups": [ ... ] }.');
    } else {
      checkKeys(findings, "", unescaped, ["survey", "groups"], "the survey spec");
      validateSurveyObject(findings, unescaped.survey, "survey", scope);
      const groups = unescaped.groups;
      if (!Array.isArray(groups) || groups.length === 0) {
        findings.error("groups", "groups is missing or empty.", 'Add at least one group: "groups": [ { "title": "...", "questions": [ ... ] } ].');
      } else {
        groups.forEach((group, index) => validateGroup(findings, group, indexPath("groups", index), scope));
      }
    }
  } else if (kind === "group") {
    validateGroup(findings, unescaped, "", scope);
  } else {
    validateQuestion(findings, unescaped, "", scope);
  }
  checkStrings(findings, unescaped, "", context.allowDataUri === true);

  const { counters } = scope;
  let summary: SpecSummary;
  if (kind === "survey") summary = { ...counters };
  else if (kind === "group") summary = { questions: counters.questions, subquestions: counters.subquestions, answers: counters.answers };
  else {
    const type = isRecord(unescaped) && typeof unescaped.type === "string" ? unescaped.type : undefined;
    summary = { ...(type !== undefined ? { type } : {}), subquestions: counters.subquestions, answers: counters.answers };
  }
  return { valid: findings.errors.length === 0, errors: findings.errors, warnings: findings.warnings, summary };
}

/**
 * Local check of a survey description (spec): every problem is collected, each with the path of the offending value
 * (0-based, for example groups[1].questions[3].answers[0].code), a message and a fix. Nothing here talks to
 * LimeSurvey; checks that need the live survey get their data through the optional context.
 */
import {
  ANSWER_CODE_PATTERN,
  ANSWER_KEYS,
  EXPIRES_DATETIME_PATTERN,
  EXPIRES_DATE_PATTERN,
  GROUP_KEYS,
  LANGUAGE_CODE_PATTERN,
  MAX_QUESTION_CODE_LENGTH,
  NEED_ANSWERS,
  NEED_BOTH,
  NEED_SUBQUESTIONS,
  OTHER_ALLOWED,
  QUESTION_CODE_PATTERN,
  QUESTION_KEYS,
  RESERVED_CODES,
  SHOWQNUMCODE_VALUES,
  SUBQUESTION_CODE_PATTERN,
  SUBQUESTION_KEYS,
  SUPPORTED_TYPES,
  SURVEY_BOOLEAN_KEYS,
  SURVEY_KEYS,
  SURVEY_TEXT_KEYS,
  TWO_SCALE_TYPES,
  isRecord,
  unescapeStrings,
  type SpecKind,
} from "./spec-model.js";
import { I18N_ATTRIBUTES } from "./attribute-defaults.js";

export type SpecFinding = { path: string; message: string; fix: string };
export type SpecWarning = { path: string; message: string };

/** What the live survey adds to the check (read by the caller; the validator itself never reads anything). */
export interface SpecContext {
  /** Question codes that already exist in the target survey. */
  existingQuestionCodes?: readonly string[];
}

export type SpecSummary = { groups?: number; questions?: number; subquestions?: number; answers?: number; type?: string };

export interface SpecValidation {
  valid: boolean;
  errors: SpecFinding[];
  warnings: SpecWarning[];
  summary: SpecSummary;
}

const XML_FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;
const DATA_URI_SOURCE = /src\s*=\s*["']?\s*data:/i;
const TEXT_FIX = "Give one string; it is used for every language of the survey.";

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

/** A text field: one string. An object (language map) is rejected as not supported yet. */
function checkText(findings: Findings, path: string, value: unknown, required: boolean): void {
  if (value === undefined) {
    if (required) findings.error(path, "This text is required.", `Add "${path.split(".").pop() ?? path}" with a non-empty string.`);
    return;
  }
  if (isRecord(value)) {
    findings.error(path, "Texts per language (a language map) are not supported yet.", TEXT_FIX);
  } else if (typeof value !== "string") {
    findings.error(path, `A text must be a string, got ${describeValue(value)}.`, TEXT_FIX);
  } else if (required && value.trim() === "") {
    findings.error(path, "This text must not be empty.", "Give a non-empty string.");
  }
}

function checkBoolean(findings: Findings, path: string, value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") {
    findings.error(path, `Must be true or false, got ${describeValue(value)}.`, "Use the JSON value true or false (not a string).");
  }
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

function validateSurveyObject(findings: Findings, survey: unknown, path: string): void {
  if (!isRecord(survey)) {
    findings.error(path, "survey is required and must be an object.", 'Add "survey": { "title": "..." }.');
    return;
  }
  checkKeys(findings, path, survey, SURVEY_KEYS, "the survey settings");
  const title = survey.title;
  if (title === undefined || (typeof title === "string" && title.trim() === "")) {
    findings.error(keyPath(path, "title"), "survey.title is missing or empty.", 'Add "title" with the survey title.');
  } else {
    checkText(findings, keyPath(path, "title"), title, true);
  }
  for (const name of SURVEY_TEXT_KEYS) {
    if (name !== "title") checkText(findings, keyPath(path, name), survey[name], false);
  }
  if (survey.language !== undefined) checkLanguage(findings, keyPath(path, "language"), survey.language);
  const additional = survey.additional_languages;
  if (additional !== undefined && additional !== null) {
    if (!Array.isArray(additional)) {
      findings.error(keyPath(path, "additional_languages"), "additional_languages must be a list of language codes.", 'Use a list such as ["en"].');
    } else {
      additional.forEach((language, index) => checkLanguage(findings, indexPath(keyPath(path, "additional_languages"), index), language));
    }
  }
  for (const name of SURVEY_BOOLEAN_KEYS) checkBoolean(findings, keyPath(path, name), survey[name]);
  for (const name of ["format", "adminemail"] as const) {
    if (survey[name] !== undefined && typeof survey[name] !== "string") {
      findings.error(keyPath(path, name), `Must be a string, got ${describeValue(survey[name])}.`, "Use a string.");
    }
  }
  const expires = survey.expires;
  if (expires !== undefined && expires !== null && expires !== ""
    && !(typeof expires === "string" && (EXPIRES_DATETIME_PATTERN.test(expires) || EXPIRES_DATE_PATTERN.test(expires)))) {
    findings.error(
      keyPath(path, "expires"),
      `expires ${JSON.stringify(expires)} has an unsupported format.`,
      "Use YYYY-MM-DD HH:MM:SS or YYYY-MM-DD (end of that day), or leave expires out.",
    );
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

function validateAnswers(findings: Findings, path: string, answers: unknown[], scope: Scope): void {
  const seen = new Set<string>();
  answers.forEach((answer, index) => {
    const answerPath = indexPath(path, index);
    scope.counters.answers += 1;
    if (!isRecord(answer)) {
      findings.error(answerPath, `An answer must be an object, got ${describeValue(answer)}.`, 'Use { "code": "A1", "text": "..." }.');
      return;
    }
    checkKeys(findings, answerPath, answer, ANSWER_KEYS, "an answer");
    const code = answer.code;
    if (typeof code !== "string" || !ANSWER_CODE_PATTERN.test(code)) {
      findings.error(
        keyPath(answerPath, "code"),
        `The answer code ${JSON.stringify(code)} is invalid (1-5 letters or digits).`,
        "Use 1-5 letters or digits, for example A1 or 3.",
      );
    } else if (seen.has(code.toLowerCase())) {
      findings.error(keyPath(answerPath, "code"), `The answer code ${code} is used twice in this question.`, "Give every answer a different code (case is ignored).");
    } else {
      seen.add(code.toLowerCase());
    }
    checkText(findings, keyPath(answerPath, "text"), answer.text, true);
    const value = answer.assessment_value;
    if (value !== undefined && !(typeof value === "number" && Number.isInteger(value))) {
      findings.error(keyPath(answerPath, "assessment_value"), "assessment_value must be a whole number.", "Use an integer such as 0 or 3.");
    }
  });
}

function validateSubquestions(findings: Findings, path: string, subquestions: unknown[], question: Record<string, unknown>, scope: Scope): void {
  const seen = new Set<string>();
  subquestions.forEach((item, index) => {
    const itemPath = indexPath(path, index);
    scope.counters.subquestions += 1;
    if (!isRecord(item)) {
      findings.error(itemPath, `A subquestion must be an object, got ${describeValue(item)}.`, 'Use { "code": "SQ001", "text": "..." }.');
      return;
    }
    checkKeys(findings, itemPath, item, SUBQUESTION_KEYS, "a subquestion");
    const code = item.code;
    const codePath = keyPath(itemPath, "code");
    if (typeof code !== "string" || !SUBQUESTION_CODE_PATTERN.test(code)) {
      findings.error(codePath, `The subquestion code ${JSON.stringify(code)} is invalid (1-20 letters or digits).`, "Use 1-20 letters or digits, for example SQ001.");
    } else if (code.toLowerCase() === "time") {
      findings.error(codePath, 'The subquestion code "time" is reserved by LimeSurvey.', "Use another code, for example SQ001.");
    } else if (seen.has(code.toLowerCase())) {
      findings.error(codePath, `The subquestion code ${code} is used twice in this question.`, "Give every subquestion a different code (case is ignored).");
    } else if (question.other === true && code.toLowerCase() === "other") {
      findings.error(codePath, 'With other=true the code "other" belongs to the "Other" option.', "Use another code or set other to false.");
    } else if (question.type === "P" && code.toLowerCase().endsWith("comment")) {
      findings.error(codePath, 'In a P question a code ending in "comment" collides with the comment field of another option.', 'Use a code that does not end in "comment".');
    } else {
      seen.add(code.toLowerCase());
    }
    checkText(findings, keyPath(itemPath, "text"), item.text, true);
  });
}

function validateAttributes(findings: Findings, path: string, attributes: unknown): void {
  if (attributes === undefined || attributes === null) return;
  if (!isRecord(attributes)) {
    findings.error(path, `attributes must be an object, got ${describeValue(attributes)}.`, 'Use { "attribute_name": "value" }.');
    return;
  }
  for (const [name, value] of Object.entries(attributes)) {
    const attributePath = keyPath(path, name);
    if (isRecord(value)) {
      findings.error(attributePath, "A value per language (a language map) is not supported yet.", "Give one string or number.");
    } else if (!(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) {
      findings.error(attributePath, `An attribute value must be a string or a number, got ${describeValue(value)}.`, 'Use a string such as "1" or a number.');
    } else if (I18N_ATTRIBUTES.has(name)) {
      findings.warning(
        attributePath,
        `The attribute ${name} is stored per language. This version writes it without a language, and LimeSurvey ignores such a value.`,
      );
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

  checkText(findings, keyPath(path, "text"), question.text, true);
  checkText(findings, keyPath(path, "help"), question.help, false);
  checkText(findings, keyPath(path, "relevance"), question.relevance, false);
  const mandatory = question.mandatory;
  if (mandatory !== undefined && typeof mandatory !== "boolean" && mandatory !== "soft") {
    findings.error(keyPath(path, "mandatory"), `mandatory must be true, false or "soft", got ${describeValue(mandatory)}.`, 'Use true, false or "soft".');
  }
  checkBoolean(findings, keyPath(path, "other"), question.other);
  validateAttributes(findings, keyPath(path, "attributes"), question.attributes);

  const subquestions = listOf(question.subquestions);
  const answers = listOf(question.answers);
  if (subquestions === "invalid") {
    findings.error(keyPath(path, "subquestions"), "subquestions must be a list.", 'Use [ { "code": "SQ001", "text": "..." } ].');
  }
  if (answers === "invalid") {
    findings.error(keyPath(path, "answers"), "answers must be a list.", 'Use [ { "code": "A1", "text": "..." } ].');
  }
  if (subquestions !== "invalid") validateSubquestions(findings, keyPath(path, "subquestions"), subquestions, question, scope);
  if (answers !== "invalid") validateAnswers(findings, keyPath(path, "answers"), answers, scope);

  const type = question.type;
  if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
    const typePath = keyPath(path, "type");
    if (typeof type === "string" && TWO_SCALE_TYPES.has(type)) {
      findings.error(
        typePath,
        `The question type "${type}" is not supported yet: it needs a second subquestion or answer scale.`,
        "Use another question type (for example F for a matrix) or build this question in the LimeSurvey admin.",
      );
    } else {
      findings.error(
        typePath,
        `The question type ${JSON.stringify(type)} is unknown.`,
        `Use one of: ${[...SUPPORTED_TYPES].join(" ")}.`,
      );
    }
    return;
  }

  const hasSubquestions = subquestions !== "invalid" && subquestions.length > 0;
  const hasAnswers = answers !== "invalid" && answers.length > 0;
  const subPath = keyPath(path, "subquestions");
  const answerPath = keyPath(path, "answers");
  if (NEED_BOTH.has(type)) {
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
    checkText(findings, keyPath(path, "title"), title, true);
  }
  checkText(findings, keyPath(path, "description"), group.description, false);
  checkText(findings, keyPath(path, "relevance"), group.relevance, false);
  const questions = listOf(group.questions);
  const questionsPath = keyPath(path, "questions");
  if (questions === "invalid") {
    findings.error(questionsPath, "questions must be a list.", 'Use "questions": [ { "code": "Q01", ... } ].');
    return;
  }
  questions.forEach((question, index) => validateQuestion(findings, question, indexPath(questionsPath, index), scope));
}

/** Every string of the spec: XML 1.0 control characters and embedded data URIs. */
function checkStrings(findings: Findings, value: unknown, path: string): void {
  if (typeof value === "string") {
    const control = XML_FORBIDDEN_CONTROL.exec(value);
    if (control) {
      const hex = (control[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
      findings.error(
        path,
        `The text contains the control character U+${hex}, which XML 1.0 cannot store.`,
        "Remove the character (copy the text again without hidden control characters).",
      );
    }
    if (DATA_URI_SOURCE.test(value)) {
      findings.error(
        path,
        'The text embeds an image as a data URI (src="data:...") which LimeSurvey removes when it saves the text.',
        "Upload the image to LimeSurvey and link it by URL, or remove the image.",
      );
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => checkStrings(findings, item, indexPath(path, index)));
  } else if (isRecord(value)) {
    for (const [name, item] of Object.entries(value)) checkStrings(findings, item, keyPath(path, name));
  }
}

export function validateSpec(kind: SpecKind, spec: unknown, context: SpecContext = {}): SpecValidation {
  const unescaped = unescapeStrings(spec);
  const findings = new Findings();
  const scope: Scope = {
    seenCodes: new Map(),
    existingCodes: new Set((context.existingQuestionCodes ?? []).map((code) => code.toLowerCase())),
    counters: { groups: 0, questions: 0, subquestions: 0, answers: 0 },
  };

  if (kind === "survey") {
    if (!isRecord(unescaped)) {
      findings.error("(spec)", `The spec must be an object, got ${describeValue(unescaped)}.`, 'Use { "survey": { "title": "..." }, "groups": [ ... ] }.');
    } else {
      checkKeys(findings, "", unescaped, ["survey", "groups"], "the survey spec");
      validateSurveyObject(findings, unescaped.survey, "survey");
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
  checkStrings(findings, unescaped, "");

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

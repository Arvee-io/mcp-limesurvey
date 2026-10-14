/**
 * Adding to an existing, inactive survey from a spec: limesurvey_add_question_from_spec (GEN-A) inserts one question
 * into a group, limesurvey_add_group_from_spec (GEN-C) one group with its questions.
 *
 * Only the new element is ever written. The import appends it (import_question at MAX+2, import_group at MAX+1); to
 * bring it to its place only its own order changes, and to break a tie its own code or base-language name changes for
 * a moment (design 9.2). LimeSurvey renumbers the whole group or survey after every saved field, sorting a tie by code
 * or name; neighbours are never written. A step that fails after the import deletes the new element again, and nothing
 * else (the scoped client allows no other delete), and reports failed_step, rolled_back and manual_cleanup.
 */
import { Buffer } from "node:buffer";
import { limeSurveyGeneration } from "./limesurvey-generation.js";
import { capLists, structuredSize } from "./response-limit.js";
import type { CreatedIds, RpcClient } from "./scoped-client.js";
import { diffSpecs, normalizeSpec, type ComparableSpec, type SpecDifference } from "./spec-compare.js";
import { generateGroupLsg, generateQuestionLsq, specInvalidError } from "./spec-generate.js";
import { asString, hasRankingQuestion, isRecord, normalizeGroup, unescapeStrings, type SpecKind } from "./spec-model.js";
import { readSurveyOutline, readSurveySpec, type MissingTranslation, type OutlineGroup, type OutlineQuestion, type SurveyOutline } from "./spec-read.js";
import { validateSpec, type SpecWarning } from "./spec-validate.js";
import { describeError, LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";

export type QuestionPosition = number | { before: string } | { after: string };
export type GroupPosition = number | { before: number } | { after: number };

export interface AddQuestionInput {
  survey_id: number;
  group_id: number;
  question: unknown;
  position?: QuestionPosition | undefined;
}

export interface AddGroupInput {
  survey_id: number;
  group: unknown;
  position?: GroupPosition | undefined;
}

export interface AddContext {
  /** The scoped client of this call: reads, the writes of the tool and deletes of what it created. */
  rpc: RpcClient;
  /** The client object the LimeSurvey generation is kept for. */
  client: object;
  config: LimeSurveyConfig;
  /** Filled with the id of the imported element, which opens its delete for the rollback. */
  created: CreatedIds;
}

/** "Ganz vorn": far below every order LimeSurvey numbers (questions from 1, groups from 0). */
const FRONT_ORDER = -1000000;
/** A code that sorts after every other code (binary and case-insensitive collations), and one that sorts before. */
const LAST_CODE = "z".repeat(20);
const FIRST_CODE = "A";

type JsonObject = Record<string, JsonValue>;

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
const objectOf = (value: JsonValue): JsonObject | undefined => (isRecord(value) ? (value as JsonObject) : undefined);

function integer(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

// ---------------------------------------------------------------- checks before anything is written

/** The check of the spec alone, before anything is read. */
function checkLocally(kind: SpecKind, spec: unknown, workflow: string, config: LimeSurveyConfig): void {
  const validation = validateSpec(kind, spec);
  if (!validation.valid) throw specInvalidError(validation.errors, { workflow, maxChars: config.maxResponseChars });
}

/** The check against the survey: its languages and, for a Ranking question, the generation of LimeSurvey. */
async function checkAgainstSurvey(
  kind: SpecKind,
  spec: unknown,
  outline: SurveyOutline,
  context: AddContext,
  workflow: string,
): Promise<{ warnings: SpecWarning[]; generation: 6 | 7 | undefined }> {
  const generation = hasRankingQuestion(kind, spec) ? await limeSurveyGeneration(context.rpc, context.client) : undefined;
  const validation = validateSpec(kind, spec, {
    languages: outline.languages,
    ...(generation !== undefined ? { rankingGeneration: generation } : {}),
  });
  if (!validation.valid) throw specInvalidError(validation.errors, { workflow, maxChars: context.config.maxResponseChars });
  return { warnings: validation.warnings, generation };
}

/** Every new code must be free in the whole survey, case ignored (import_question fails on a taken code, .lsg renames it). */
function assertCodesFree(codes: Array<{ path: string; code: string }>, outline: SurveyOutline): void {
  const taken = new Map(outline.questionCodes.map((code) => [code.toLowerCase(), code] as const));
  const conflicts = codes.flatMap(({ path, code }) => {
    const existing = taken.get(code.toLowerCase());
    return existing === undefined ? [] : [{ path, code, existing_code: existing }];
  });
  if (conflicts.length === 0) return;
  throw new LimeSurveyError(
    `The survey already has the question code${conflicts.length === 1 ? "" : "s"} ${conflicts.map((item) => item.existing_code).join(", ")} `
      + "(codes are compared without case). Nothing was written.",
    "CODE_CONFLICT",
    {
      conflicts,
      recovery: "Choose codes that no question of the survey uses; limesurvey_get_survey_spec lists the codes of the survey.",
    },
  );
}

function assertInactive(outline: SurveyOutline, surveyId: number): void {
  if (outline.active === undefined) {
    throw new LimeSurveyError("get_survey_properties did not report whether the survey is active. Nothing was written.", "UNEXPECTED_RESPONSE", {
      survey_id: surveyId,
    });
  }
  if (outline.active) {
    throw new LimeSurveyError(
      `Survey ${surveyId} is active: questions and groups can only be added to an inactive survey. Nothing was written.`,
      "SURVEY_ACTIVE",
      {
        survey_id: surveyId,
        recovery: "Add the element to an inactive copy of the survey (limesurvey_copy_survey), or deactivate the survey in the "
          + "LimeSurvey admin first.",
      },
    );
  }
}

function positionInvalid(message: string, details: JsonObject): LimeSurveyError {
  return new LimeSurveyError(`${message} Nothing was written.`, "POSITION_INVALID", details);
}

/** The 1-based place of the new question among the questions of the group (n + 1 = the end). */
function questionTarget(position: QuestionPosition | undefined, questions: readonly OutlineQuestion[], groupId: number): number {
  const count = questions.length;
  const recovery = `Give a position from 1 to ${count + 1}, or before/after the code of a question of group ${groupId} `
    + "(limesurvey_get_survey_spec with group_id lists them).";
  if (position === undefined) return count + 1;
  if (typeof position === "number") {
    if (position > count + 1) throw positionInvalid(`Position ${position} is beyond the end of group ${groupId} (${count} questions).`, { position, recovery });
    return position;
  }
  const code = "before" in position ? position.before : position.after;
  const exact = questions.findIndex((question) => question.code === code);
  const index = exact >= 0 ? exact : questions.findIndex((question) => question.code.toLowerCase() === code.toLowerCase());
  if (index < 0) {
    throw positionInvalid(`Group ${groupId} has no question with the code ${code}.`, {
      position: position as unknown as JsonValue,
      codes: questions.map((question) => question.code),
      recovery,
    });
  }
  return "before" in position ? index + 1 : index + 2;
}

/** The 1-based place of the new group among the groups of the survey (n + 1 = the end). */
function groupTarget(position: GroupPosition | undefined, groups: readonly OutlineGroup[], surveyId: number): number {
  const count = groups.length;
  const recovery = `Give a position from 1 to ${count + 1}, or before/after the group_id of a group of survey ${surveyId} `
    + "(limesurvey_get_survey_spec lists them).";
  if (position === undefined) return count + 1;
  if (typeof position === "number") {
    if (position > count + 1) throw positionInvalid(`Position ${position} is beyond the end of survey ${surveyId} (${count} groups).`, { position, recovery });
    return position;
  }
  const gid = "before" in position ? position.before : position.after;
  const index = groups.findIndex((group) => group.group_id === gid);
  if (index < 0) {
    throw positionInvalid(`Survey ${surveyId} has no group ${gid}.`, {
      position: position as unknown as JsonValue,
      group_ids: groups.map((group) => group.group_id),
      recovery,
    });
  }
  return "before" in position ? index + 1 : index + 2;
}

// ---------------------------------------------------------------- writing one element

async function setQuestion(rpc: RpcClient, qid: number, data: JsonObject): Promise<void> {
  const answer = objectOf(await rpc.call("set_question_properties", [qid, data]));
  for (const field of Object.keys(data)) {
    if (answer?.[field] !== true) {
      throw new LimeSurveyError(
        `set_question_properties did not save ${field} of question ${qid}: ${JSON.stringify(answer?.[field] ?? null)}`,
        "FIELD_SAVE_FAILED",
        answer ?? null,
      );
    }
  }
}

async function setGroup(rpc: RpcClient, gid: number, data: JsonObject): Promise<void> {
  const answer = objectOf(await rpc.call("set_group_properties", [gid, data]));
  // The texts (questiongroupl10ns) are checked by reading the group back; the base fields answer true when saved.
  for (const field of Object.keys(data).filter((name) => name !== "questiongroupl10ns")) {
    if (answer?.[field] !== true) {
      throw new LimeSurveyError(
        `set_group_properties did not save ${field} of group ${gid}: ${JSON.stringify(answer?.[field] ?? null)}`,
        "FIELD_SAVE_FAILED",
        answer ?? null,
      );
    }
  }
}

/** The main questions of a group in the order LimeSurvey numbers them: (question_order, code). */
async function questionSequence(rpc: RpcClient, surveyId: number, groupId: number): Promise<OutlineQuestion[]> {
  const rows = await rpc.call("list_questions", [surveyId, groupId]);
  return (Array.isArray(rows) ? rows : [])
    .map(objectOf)
    .filter((row): row is JsonObject => row !== undefined && (integer(row.parent_qid) ?? 0) === 0)
    .map((row) => ({ question_id: integer(row.qid ?? row.id) ?? 0, code: asString(row.title), order: integer(row.question_order) ?? 0 }))
    .sort((a, b) => a.order - b.order || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** The groups of a survey in the order LimeSurvey numbers them: (group_order, base-language name, gid). */
async function groupSequence(rpc: RpcClient, surveyId: number, base: string): Promise<Array<Omit<OutlineGroup, "questions">>> {
  const rows = await rpc.call("list_groups", [surveyId, base]);
  return (Array.isArray(rows) ? rows : [])
    .map(objectOf)
    .filter((row): row is JsonObject => row !== undefined)
    .map((row) => ({ group_id: integer(row.gid ?? row.id) ?? 0, order: integer(row.group_order) ?? 0, name: asString(row.group_name) }))
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.group_id - b.group_id);
}

/**
 * Moves the new question (now last) to place `target` among `before`. Ganz vorn: order -1000000. Dazwischen: the question
 * ties with its predecessor under a code that sorts after every other one (z x 20), or, if that is taken, with its
 * successor under A, which sorts before every other one; then it gets its own code back.
 */
async function placeQuestion(
  rpc: RpcClient,
  place: { surveyId: number; groupId: number; qid: number; code: string; target: number; before: readonly OutlineQuestion[]; takenCodes: ReadonlySet<string> },
): Promise<void> {
  const { surveyId, groupId, qid, target, before } = place;
  if (target === before.length + 1) return;
  if (target === 1) {
    await setQuestion(rpc, qid, { question_order: FRONT_ORDER });
    return;
  }
  const previous = before[target - 2];
  const next = before[target - 1];
  const behind = !place.takenCodes.has(LAST_CODE.toLowerCase());
  if (!previous || !next || (!behind && place.takenCodes.has(FIRST_CODE.toLowerCase()))) {
    throw new LimeSurveyError("No temporary code is free to bring the question to its place.", "POSITION_NOT_SET");
  }
  await setQuestion(rpc, qid, { title: behind ? LAST_CODE : FIRST_CODE });
  // Saving the code renumbered the group: the order of the neighbour is read now.
  const neighbour = behind ? previous : next;
  const order = (await questionSequence(rpc, surveyId, groupId)).find((item) => item.question_id === neighbour.question_id)?.order;
  if (order === undefined) throw new LimeSurveyError(`Question ${neighbour.question_id} is no longer in group ${groupId}.`, "POSITION_NOT_SET");
  await setQuestion(rpc, qid, { question_order: order });
  await setQuestion(rpc, qid, { title: place.code });
}

/**
 * Moves the new group (now last) to place `target` among `before`. Ganz vorn: order -1000000. Dazwischen: the group ties
 * with its successor under the base-language name "" (sorts first), or, when the successor has no name, with its
 * predecessor under the predecessor's name + "zz"; then it gets its own name back. Returns the temporary name used.
 */
async function placeGroup(
  rpc: RpcClient,
  place: { surveyId: number; base: string; gid: number; target: number; before: readonly OutlineGroup[]; name: string; description: string },
): Promise<string | undefined> {
  const { surveyId, base, gid, target, before } = place;
  if (target === before.length + 1) return undefined;
  if (target === 1) {
    await setGroup(rpc, gid, { group_order: FRONT_ORDER });
    return undefined;
  }
  const previous = before[target - 2];
  const next = before[target - 1];
  if (!previous || !next) throw new LimeSurveyError("The neighbours of the target place are unknown.", "POSITION_NOT_SET");
  const inFront = next.name !== "";
  const temporary = inFront ? "" : `${previous.name}zz`;
  const texts = (groupName: string): JsonObject => ({ questiongroupl10ns: { [base]: { group_name: groupName, description: place.description } } });
  await setGroup(rpc, gid, texts(temporary));
  const neighbour = inFront ? next : previous;
  const order = (await groupSequence(rpc, surveyId, base)).find((item) => item.group_id === neighbour.group_id)?.order;
  if (order === undefined) throw new LimeSurveyError(`Group ${neighbour.group_id} is no longer in survey ${surveyId}.`, "POSITION_NOT_SET");
  await setGroup(rpc, gid, { group_order: order });
  await setGroup(rpc, gid, texts(place.name));
  return temporary;
}

// ---------------------------------------------------------------- failure and rollback

interface Rollback {
  rolled_back: boolean;
  manual_cleanup: boolean;
  cleanup_hint?: string;
}

async function deleteCreated(rpc: RpcClient, kind: "question" | "group", surveyId: number, id: number): Promise<Rollback> {
  try {
    const answer = kind === "question"
      ? await rpc.call("delete_question", [id])
      : await rpc.call("delete_group", [surveyId, id]);
    if (integer(answer) !== id) throw new LimeSurveyError(`delete_${kind} answered ${JSON.stringify(answer)} instead of ${id}.`);
    return { rolled_back: true, manual_cleanup: false };
  } catch (value) {
    return {
      rolled_back: false,
      manual_cleanup: true,
      cleanup_hint: `Delete the ${kind} ${id} of survey ${surveyId} in the LimeSurvey admin (deleting it here failed: ${describeError(value).message}).`,
    };
  }
}

function addFailed(
  code: "ADD_QUESTION_FAILED" | "ADD_GROUP_FAILED",
  kind: "question" | "group",
  step: string,
  value: unknown,
  rollback: Rollback & { created?: boolean },
  extra: JsonObject = {},
): LimeSurveyError {
  const cause = describeError(value);
  const outcome = rollback.manual_cleanup
    ? "MANUAL CLEANUP NEEDED: see details.cleanup_hint."
    : rollback.created === false
      ? "Nothing was created."
      : `The new ${kind} was deleted again; nothing else was changed.`;
  return new LimeSurveyError(
    `Adding the ${kind} failed at step "${step}": ${cause.message} ${outcome}`,
    code,
    {
      failed_step: step,
      ...(rollback.created !== undefined ? { created: rollback.created } : {}),
      rolled_back: rollback.rolled_back,
      manual_cleanup: rollback.manual_cleanup,
      ...(rollback.cleanup_hint !== undefined ? { cleanup_hint: rollback.cleanup_hint } : {}),
      ...extra,
      ...(cause.details !== undefined ? { cause: cause.details } : {}),
      recovery: rollback.manual_cleanup
        ? "Remove the leftover element by hand (see cleanup_hint), then call the tool again."
        : "Fix the cause in the message and call the tool again.",
    },
  );
}

/**
 * The import itself failed. An answer of LimeSurvey with a status proves that nothing was created; after a transport or
 * JSON-RPC error the element may exist, so the tool looks for it (not there before, with the new code or name) and
 * deletes what it finds.
 */
async function importFailed(
  context: AddContext,
  kind: "question" | "group",
  surveyId: number,
  value: unknown,
  find: () => Promise<number[]>,
): Promise<LimeSurveyError> {
  const code = kind === "question" ? "ADD_QUESTION_FAILED" : "ADD_GROUP_FAILED";
  const step = kind === "question" ? "import_question" : "import_group";
  const answered = value instanceof LimeSurveyError && isRecord(value.details) && "status" in value.details;
  if (answered) return addFailed(code, kind, step, value, { created: false, rolled_back: false, manual_cleanup: false });
  let strays: number[];
  try {
    strays = await find();
  } catch (lookup) {
    return addFailed(code, kind, step, value, {
      rolled_back: false,
      manual_cleanup: true,
      cleanup_hint: `It is unknown whether the ${kind} was created (looking for it failed: ${describeError(lookup).message}); check the survey in the LimeSurvey admin.`,
    });
  }
  if (strays.length === 0) return addFailed(code, kind, step, value, { created: false, rolled_back: false, manual_cleanup: false });
  const results: Rollback[] = [];
  for (const id of strays) {
    (kind === "question" ? context.created.questions : context.created.groups).add(id);
    results.push(await deleteCreated(context.rpc, kind, surveyId, id));
  }
  const failed = results.filter((item) => !item.rolled_back);
  return addFailed(code, kind, step, value, {
    rolled_back: failed.length === 0,
    manual_cleanup: failed.length > 0,
    ...(failed.length > 0 ? { cleanup_hint: failed.map((item) => item.cleanup_hint).join(" ") } : {}),
  });
}

// ---------------------------------------------------------------- reading back

/** Differences relative to the element: "groups[0].questions[0].text.de" becomes "text.de". */
function relativeTo(prefix: string, label: string, differences: SpecDifference[]): SpecDifference[] {
  return differences.map((item) => ({
    ...item,
    path: item.path === prefix ? label : item.path.startsWith(`${prefix}.`) ? item.path.slice(prefix.length + 1) : item.path,
  }));
}

const GAP_DETAIL = "import_question completes the translations of the whole survey: these texts of other groups and questions had "
  + "no row in an additional language and now hold the text of the base language. This stays when the question is deleted "
  + "again. Answer texts are not checked.";

type Lists = { differences: SpecDifference[]; warnings: SpecWarning[]; gaps: MissingTranslation[] };

/** The success result, with every list cut to stay within LIMESURVEY_MAX_RESPONSE_CHARS. */
function successResult(workflow: string, config: LimeSurveyConfig, lists: Lists, head: JsonObject): JsonValue {
  const build = (cut: Lists): JsonValue => ({
    ...head,
    verification: {
      ok: lists.differences.length === 0,
      differences: cut.differences as unknown as JsonValue,
      differences_total: lists.differences.length,
      truncated: cut.differences.length < lists.differences.length,
    },
    side_effects: lists.gaps.length === 0
      ? []
      : [{
        kind: "translations_filled_from_base",
        detail: GAP_DETAIL,
        gaps: cut.gaps as unknown as JsonValue,
        gaps_total: lists.gaps.length,
        truncated: cut.gaps.length < lists.gaps.length,
      }],
    ...(lists.warnings.length > 0 ? { warnings: cut.warnings as unknown as JsonValue, warnings_total: lists.warnings.length } : {}),
    truncated: cut.differences.length < lists.differences.length
      || cut.warnings.length < lists.warnings.length
      || cut.gaps.length < lists.gaps.length,
  });
  return build(capLists<Lists>(lists, (shown) => structuredSize(workflow, build(shown)) <= config.maxResponseChars));
}

// ---------------------------------------------------------------- the tools

export async function addQuestionFromSpec(context: AddContext, input: AddQuestionInput): Promise<JsonValue> {
  const workflow = "add_question_from_spec";
  const { rpc, config } = context;
  const { survey_id: surveyId, group_id: groupId } = input;
  const spec = plain(input.question);
  checkLocally("question", spec, workflow, config);

  const outline = await readSurveyOutline(rpc, surveyId, { gaps: true });
  const { warnings, generation } = await checkAgainstSurvey("question", spec, outline, context, workflow);
  const question = isRecord(spec) ? spec : {};
  const code = asString(question.code);
  assertCodesFree([{ path: "code", code }], outline);
  assertInactive(outline, surveyId);
  const group = outline.groups.find((item) => item.group_id === groupId);
  if (!group) {
    throw new LimeSurveyError(`Group ${groupId} does not belong to survey ${surveyId}. Nothing was written.`, "GROUP_SURVEY_MISMATCH", {
      survey_id: surveyId,
      group_id: groupId,
      group_ids: outline.groups.map((item) => item.group_id),
      recovery: "Use a group_id of this survey; limesurvey_get_survey_spec lists them.",
    });
  }
  const target = questionTarget(input.position, group.questions, groupId);
  const languages = outline.languages;
  const lsq = generateQuestionLsq(spec, { languages, ranking: generation === 7 ? "subquestions" : "answers" });
  // import_question always sets the mandatory flag from this parameter (the file's value is overwritten).
  const mandatory = question.mandatory === "soft" ? "S" : question.mandatory === true ? "Y" : "N";
  // The import fills the gaps even when the question is deleted again: a failure reports them too.
  const sideEffects = outline.gaps.length > 0
    ? { side_effects: [{ kind: "translations_filled_from_base", detail: GAP_DETAIL, gaps_total: outline.gaps.length }] }
    : {};

  let qid: number;
  try {
    const answer = await rpc.call("import_question", [surveyId, groupId, Buffer.from(lsq, "utf8").toString("base64"), "lsq", mandatory]);
    const id = integer(answer);
    if (id === undefined || id <= 0) throw new LimeSurveyError(`import_question answered without a question id: ${JSON.stringify(answer)}`);
    qid = id;
  } catch (value) {
    throw await importFailed(context, "question", surveyId, value, async () => (await questionSequence(rpc, surveyId, groupId))
      .filter((item) => !outline.questionIds.has(item.question_id) && item.code.toLowerCase() === code.toLowerCase())
      .map((item) => item.question_id));
  }
  if (!outline.questionIds.has(qid)) context.created.questions.add(qid);

  let step = "position";
  try {
    await placeQuestion(rpc, {
      surveyId, groupId, qid, code, target, before: group.questions,
      takenCodes: new Set(outline.questionCodes.map((item) => item.toLowerCase())),
    });
    step = "verify_position";
    const expected = group.questions.map((item) => item.question_id);
    expected.splice(target - 1, 0, qid);
    const actual = (await questionSequence(rpc, surveyId, groupId)).map((item) => item.question_id);
    if (!sameList(actual, expected)) {
      throw new LimeSurveyError("The question is not at the requested place after positioning.", "POSITION_NOT_SET", {
        expected_sequence: expected,
        actual_sequence: actual,
      });
    }
    step = "read_back";
    const live = await readSurveySpec(rpc, surveyId, { questionId: qid });
    const actualSpec = normalizeSpec(live.spec, languages, { trim: true });
    const actualGroup = actualSpec.groups[0];
    const expectedQuestions = normalizeSpec({ groups: [{ questions: [spec] }] }, languages, { trim: true }).groups[0]?.questions ?? [];
    const expectedSpec: ComparableSpec = {
      survey: actualSpec.survey,
      groups: actualGroup ? [{ ...actualGroup, questions: expectedQuestions }] : [],
    };
    const differences = relativeTo("groups[0].questions[0]", "question", diffSpecs(expectedSpec, actualSpec));
    return successResult(workflow, config, { differences, warnings, gaps: outline.gaps }, {
      survey_id: surveyId,
      group_id: groupId,
      question_id: qid,
      code,
      position: { index: target },
    });
  } catch (value) {
    const rollback = await deleteCreated(rpc, "question", surveyId, qid);
    throw addFailed("ADD_QUESTION_FAILED", "question", step, value, rollback, { question_id: qid, ...sideEffects });
  }
}

export async function addGroupFromSpec(context: AddContext, input: AddGroupInput): Promise<JsonValue> {
  const workflow = "add_group_from_spec";
  const { rpc, config } = context;
  const { survey_id: surveyId } = input;
  const spec = plain(input.group);
  checkLocally("group", spec, workflow, config);

  const outline = await readSurveyOutline(rpc, surveyId);
  const { warnings, generation } = await checkAgainstSurvey("group", spec, outline, context, workflow);
  const questions = isRecord(spec) && Array.isArray(spec.questions) ? spec.questions : [];
  assertCodesFree(questions.map((item, index) => ({ path: `questions[${index}].code`, code: asString(isRecord(item) ? item.code : undefined) })), outline);
  assertInactive(outline, surveyId);
  const target = groupTarget(input.position, outline.groups, surveyId);
  const languages = outline.languages;
  const base = languages[0] ?? "";
  const lsg = generateGroupLsg(spec, { languages, ranking: generation === 7 ? "subquestions" : "answers" });
  const normal = normalizeGroup(unescapeStrings(spec), languages);
  const name = normal.title[base] ?? "";
  const description = normal.description[base] ?? "";

  let gid: number;
  try {
    const answer = await rpc.call("import_group", [surveyId, Buffer.from(lsg, "utf8").toString("base64"), "lsg"]);
    const id = integer(answer);
    if (id === undefined || id <= 0) throw new LimeSurveyError(`import_group answered without a group id: ${JSON.stringify(answer)}`);
    gid = id;
  } catch (value) {
    throw await importFailed(context, "group", surveyId, value, async () => (await groupSequence(rpc, surveyId, base))
      .filter((item) => !outline.groupIds.has(item.group_id) && item.name === name)
      .map((item) => item.group_id));
  }
  if (!outline.groupIds.has(gid)) context.created.groups.add(gid);

  let step = "position";
  try {
    const temporary = await placeGroup(rpc, { surveyId, base, gid, target, before: outline.groups, name, description });
    step = "verify_position";
    const expected = outline.groups.map((item) => item.group_id);
    expected.splice(target - 1, 0, gid);
    const sequence = await groupSequence(rpc, surveyId, base);
    const actual = sequence.map((item) => item.group_id);
    const current = sequence.find((item) => item.group_id === gid)?.name;
    if (!sameList(actual, expected) || (temporary !== undefined && temporary !== name && current === temporary)) {
      throw new LimeSurveyError("The group is not at the requested place, or not under its own name, after positioning.", "POSITION_NOT_SET", {
        expected_sequence: expected,
        actual_sequence: actual,
      });
    }
    step = "read_back";
    const live = await readSurveySpec(rpc, surveyId, { groupId: gid });
    const actualSpec = normalizeSpec(live.spec, languages, { trim: true });
    const expectedSpec: ComparableSpec = {
      survey: actualSpec.survey,
      groups: normalizeSpec({ groups: [spec] }, languages, { trim: true }).groups,
    };
    const differences = relativeTo("groups[0]", "group", diffSpecs(expectedSpec, actualSpec));
    const created = live.layout.groups.find((item) => item.group_id === gid)?.questions ?? [];
    return successResult(workflow, config, { differences, warnings, gaps: [] }, {
      survey_id: surveyId,
      group_id: gid,
      position: { index: target },
      questions: created.map((item) => ({ code: item.code, question_id: item.question_id })),
    });
  } catch (value) {
    const rollback = await deleteCreated(rpc, "group", surveyId, gid);
    throw addFailed("ADD_GROUP_FAILED", "group", step, value, rollback, { group_id: gid });
  }
}

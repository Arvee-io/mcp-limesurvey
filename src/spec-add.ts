/**
 * Adding to an existing, inactive survey from a spec: limesurvey_add_question_from_spec (GEN-A) inserts one question
 * into a group, limesurvey_add_group_from_spec (GEN-C) one group with its questions.
 *
 * Only the new element is ever written. The import appends it (import_question at MAX+2, import_group at MAX+1); to
 * bring it to its place only its own order changes, and to break a tie its own code or base-language name changes for
 * a moment (design 9.2). LimeSurvey renumbers the whole group or survey after every saved field, sorting a tie by code
 * or name; neighbours are never written. A step that fails after the import deletes the new element again, and nothing
 * else (the scoped client allows no other delete), and reports failed_step, rolled_back and manual_cleanup. When it is
 * not certain what the import did, nothing is deleted: the error lists the candidates for a manual check.
 */
import { Buffer } from "node:buffer";
import { limeSurveyGeneration } from "./limesurvey-generation.js";
import { capLists, structuredSize } from "./response-limit.js";
import type { CreatedIds, RpcClient } from "./scoped-client.js";
import { diffSpecs, normalizeSpec, type ComparableSpec, type SpecDifference } from "./spec-compare.js";
import { generateGroupLsg, generateQuestionLsq, specInvalidError } from "./spec-generate.js";
import { asString, hasRankingQuestion, isRecord, normalizeGroup, unescapeStrings, type SpecKind } from "./spec-model.js";
import { readSurveyOutline, readSurveySpec, type OutlineGroup, type OutlineQuestion, type SurveyOutline, type TranslationGap } from "./spec-read.js";
import { validateSpec, type SpecWarning } from "./spec-validate.js";
import { describeError, LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";

export type QuestionPosition = number | { before: string } | { after: string };
export type GroupPosition = number | { before: number } | { after: number };

/** Risks a call of add_question_from_spec may confirm. */
export type QuestionAcknowledgement = "fill_translation_gaps";

export interface AddQuestionInput {
  survey_id: number;
  group_id: number;
  question: unknown;
  position?: QuestionPosition | undefined;
  acknowledge?: QuestionAcknowledgement[] | undefined;
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

/** The workflow name and the size limit of its answer, for errors whose lists are cut. */
interface Limit {
  workflow: string;
  maxChars: number;
}

type Kind = "question" | "group";

/** "Ganz vorn": far below every order LimeSurvey numbers (questions from 1, groups from 0); "ganz hinten" far above. */
const FRONT_ORDER = -1000000;
const END_ORDER = 1000000;
/** A code that sorts after every other code (binary and case-insensitive collations), and one that sorts before. */
const LAST_CODE = "z".repeat(20);
const FIRST_CODE = "A";

type JsonObject = Record<string, JsonValue>;

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
const objectOf = (value: JsonValue | undefined): JsonObject | undefined => (isRecord(value) ? (value as JsonObject) : undefined);
const json = (value: unknown): JsonValue => value as JsonValue;

function integer(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

/** An error whose lists are cut (keeping their start) so that the error answer fits LIMESURVEY_MAX_RESPONSE_CHARS. */
function cappedError<T extends Record<string, readonly unknown[]>>(
  limit: Limit,
  message: string,
  code: string,
  lists: T,
  details: (cut: T) => JsonObject,
): LimeSurveyError {
  const fits = (cut: T): boolean => structuredSize(limit.workflow, { status: "error", message, code, details: details(cut) }) <= limit.maxChars;
  return new LimeSurveyError(message, code, details(capLists(lists, fits)));
}

/** A cut list with its full number and whether it was cut: { [name]: shown, [name]_total, truncated }. */
const cutList = (name: string, shown: readonly unknown[], all: readonly unknown[]): JsonObject => ({
  [name]: json(shown),
  [`${name}_total`]: all.length,
  truncated: shown.length < all.length,
});

// ---------------------------------------------------------------- checks before anything is written

/** The check of the spec alone, before anything is read. */
function checkLocally(kind: SpecKind, spec: unknown, limit: Limit): void {
  const validation = validateSpec(kind, spec);
  if (!validation.valid) throw specInvalidError(validation.errors, limit);
}

/** The check against the survey: its languages and, for a Ranking question, the generation of LimeSurvey. */
async function checkAgainstSurvey(
  kind: SpecKind,
  spec: unknown,
  outline: SurveyOutline,
  context: AddContext,
  limit: Limit,
): Promise<{ warnings: SpecWarning[]; generation: 6 | 7 | undefined }> {
  const generation = hasRankingQuestion(kind, spec) ? await limeSurveyGeneration(context.rpc, context.client) : undefined;
  const validation = validateSpec(kind, spec, {
    languages: outline.languages,
    ...(generation !== undefined ? { rankingGeneration: generation } : {}),
  });
  if (!validation.valid) throw specInvalidError(validation.errors, limit);
  return { warnings: validation.warnings, generation };
}

/** Every new code must be free in the whole survey, case ignored (import_question fails on a taken code, .lsg renames it). */
function assertCodesFree(codes: Array<{ path: string; code: string }>, outline: SurveyOutline, limit: Limit): void {
  const taken = new Map(outline.questionCodes.map((code) => [code.toLowerCase(), code] as const));
  const conflicts = codes.flatMap(({ path, code }) => {
    const existing = taken.get(code.toLowerCase());
    return existing === undefined ? [] : [{ path, code, existing_code: existing }];
  });
  if (conflicts.length === 0) return;
  const named = conflicts.slice(0, 5).map((item) => item.existing_code).join(", ") + (conflicts.length > 5 ? ", ..." : "");
  throw cappedError(
    limit,
    `The survey already uses ${conflicts.length === 1 ? "the question code" : `${conflicts.length} of the question codes`} ${named} `
      + "(codes are compared without case). Nothing was written.",
    "CODE_CONFLICT",
    { conflicts },
    (cut) => ({
      ...cutList("conflicts", cut.conflicts, conflicts),
      recovery: "Choose codes that no question of the survey uses; limesurvey_get_survey_spec lists the codes of the survey.",
    }),
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

/** The 1-based place of the new question among the questions of the group (n + 1 = the end). */
function questionTarget(position: QuestionPosition | undefined, questions: readonly OutlineQuestion[], groupId: number, limit: Limit): number {
  const count = questions.length;
  const recovery = `Give a position from 1 to ${count + 1}, or before/after the code of a question of group ${groupId} `
    + "(limesurvey_get_survey_spec with group_id lists them).";
  if (position === undefined) return count + 1;
  if (typeof position === "number") {
    if (position > count + 1) {
      throw new LimeSurveyError(`Position ${position} is beyond the end of group ${groupId} (${count} questions). Nothing was written.`, "POSITION_INVALID", {
        position,
        recovery,
      });
    }
    return position;
  }
  const code = "before" in position ? position.before : position.after;
  const exact = questions.findIndex((question) => question.code === code);
  const index = exact >= 0 ? exact : questions.findIndex((question) => question.code.toLowerCase() === code.toLowerCase());
  if (index < 0) {
    const codes = questions.map((question) => question.code);
    throw cappedError(limit, `Group ${groupId} has no question with the code ${code}. Nothing was written.`, "POSITION_INVALID", { codes }, (cut) => ({
      position: json(position),
      ...cutList("codes", cut.codes, codes),
      recovery,
    }));
  }
  return "before" in position ? index + 1 : index + 2;
}

/** The 1-based place of the new group among the groups of the survey (n + 1 = the end). */
function groupTarget(position: GroupPosition | undefined, groups: readonly OutlineGroup[], surveyId: number, limit: Limit): number {
  const count = groups.length;
  const recovery = `Give a position from 1 to ${count + 1}, or before/after the group_id of a group of survey ${surveyId} `
    + "(limesurvey_get_survey_spec lists them).";
  if (position === undefined) return count + 1;
  if (typeof position === "number") {
    if (position > count + 1) {
      throw new LimeSurveyError(`Position ${position} is beyond the end of survey ${surveyId} (${count} groups). Nothing was written.`, "POSITION_INVALID", {
        position,
        recovery,
      });
    }
    return position;
  }
  const gid = "before" in position ? position.before : position.after;
  const index = groups.findIndex((group) => group.group_id === gid);
  if (index < 0) {
    const groupIds = groups.map((group) => group.group_id);
    throw cappedError(limit, `Survey ${surveyId} has no group ${gid}. Nothing was written.`, "POSITION_INVALID", { groupIds }, (cut) => ({
      position: json(position),
      ...cutList("group_ids", cut.groupIds, groupIds),
      recovery,
    }));
  }
  return "before" in position ? index + 1 : index + 2;
}

/**
 * import_question runs fixLanguageConsistency over the whole survey (7.5.1 RC:1661): texts without a row in an additional
 * language get the base-language text. That cannot be undone, so it needs acknowledge: ["fill_translation_gaps"].
 */
function assertGapsAcknowledged(gaps: readonly TranslationGap[], acknowledge: readonly QuestionAcknowledgement[] | undefined, limit: Limit): void {
  if (gaps.length === 0 || acknowledge?.includes("fill_translation_gaps") === true) return;
  throw cappedError(
    limit,
    `The survey has ${gaps.length} text${gaps.length === 1 ? "" : "s"} without a row in an additional language. import_question would `
      + "fill them with the base-language text, which cannot be undone. Nothing was written.",
    "TRANSLATION_GAPS",
    { gaps },
    (cut) => ({
      ...cutList("gaps", cut.gaps, gaps),
      recovery: "Translate the texts first (limesurvey_update_survey_texts), or pass acknowledge: [\"fill_translation_gaps\"] to let "
        + "the import fill them with the base-language text.",
    }),
  );
}

// ---------------------------------------------------------------- writing one element

/** A field answer that says old conditions forbid the new order (RC:2062-2064 questions, RC:1493-1495 groups). */
const DEPENDENCIES = /with dependencies/i;

function checkSaved(method: string, id: number, data: JsonObject, answer: JsonObject | undefined, skip: readonly string[] = []): void {
  for (const field of Object.keys(data).filter((name) => !skip.includes(name))) {
    const value = answer?.[field];
    if (value === true) continue;
    if (typeof value === "string" && DEPENDENCIES.test(value)) {
      throw new LimeSurveyError(`${method} refused ${field} of ${id}: ${value}`, "POSITION_NOT_SET", answer ?? null);
    }
    throw new LimeSurveyError(`${method} did not save ${field} of ${id}: ${JSON.stringify(value ?? null)}`, "FIELD_SAVE_FAILED", answer ?? null);
  }
}

async function setQuestion(rpc: RpcClient, qid: number, data: JsonObject): Promise<void> {
  checkSaved("set_question_properties", qid, data, objectOf(await rpc.call("set_question_properties", [qid, data])));
}

async function setGroup(rpc: RpcClient, gid: number, data: JsonObject): Promise<void> {
  // The texts (questiongroupl10ns) are checked by reading the group back; the base fields answer true when saved.
  checkSaved("set_group_properties", gid, data, objectOf(await rpc.call("set_group_properties", [gid, data])), ["questiongroupl10ns"]);
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
 * successor under A, which sorts before every other one; then it gets its own code back. Saving the temporary code
 * renumbers the group first (updateQuestionOrder after every saved field, RC:2069-2070), so ties of question_order
 * among the other questions are gone before the neighbour's order is read.
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
 * Moves the new group (now last) to place `target` among `before`. Ganz vorn: order -1000000. Dazwischen: first the
 * group's order is saved as "ganz hinten" (1000000), which makes LimeSurvey renumber the groups (updateGroupOrder after
 * every saved field, RC:1501-1502) and so removes ties of group_order among the other groups; then the group ties with
 * its successor under the base-language name "" (sorts first), or, when the successor has no name, with its predecessor
 * under the predecessor's name + "zz"; then it gets its own name back. Returns the temporary name used.
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
  await setGroup(rpc, gid, { group_order: END_ORDER });
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

// ---------------------------------------------------------------- the import and its outcome

/**
 * Refusals of import_question and import_group after which LimeSurvey has certainly created nothing (class b).
 * LimeSurvey 7.5.1, application/helpers/remotecontrol/remotecontrol_handle.php:
 * - import_question: ERR_INVALID_SESSION RC:1598-1600, ERR_INVALID_SURVEY RC:1604-1606, ERR_NO_PERMISSION RC:1607-1609,
 *   ERR_SURVEY_ACTIVE RC:1610-1612, ERR_INVALID_GROUP RC:1614-1617, ERR_ALREADY_EXISTS RC:1628-1630,
 *   ERR_INVALID_EXTENSION RC:1634-1636 and 1653-1655, ERR_INVALID_XML RC:1648-1651, ERR_CREATION_FAILED RC:1658-1659.
 * - import_group: ERR_INVALID_SESSION RC:1291-1293, ERR_INVALID_SURVEY RC:1233-1235, ERR_NO_PERMISSION RC:1288-1290,
 *   ERR_SURVEY_ACTIVE RC:1238-1240, ERR_INVALID_EXTENSION RC:1242-1244 and 1259-1261, ERR_INVALID_XML RC:1254-1257,
 *   ERR_CREATION_FAILED RC:1266-1267.
 * ERR_CREATION_FAILED carries the fatalerror of the import helper (application/helpers/admin/import_helper.php), which
 * XMLImportQuestion sets only before or when saving the main question fails (IH:710 language check, 778 no free code,
 * 798 save failed; the .lsq of this tool holds exactly one main question) and XMLImportGroup only in its language check
 * (IH:62): nothing is stored then.
 * Not a refusal: "Error when update question" with "errors" (RC:1676-1681, 1700-1705), which import_question answers
 * after the question was created, and any other answer with "errors".
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "ERR_INVALID_SESSION",
  "ERR_INVALID_SURVEY",
  "ERR_NO_PERMISSION",
  "ERR_SURVEY_ACTIVE",
  "ERR_INVALID_GROUP",
  "ERR_ALREADY_EXISTS",
  "ERR_INVALID_EXTENSION",
  "ERR_INVALID_XML",
  "ERR_CREATION_FAILED",
]);

/**
 * The same refusals on LimeSurvey 6.17.11, which answers without error_code: import_question RC:1528-1605 (the
 * session, survey, permission, active, group, "Missmatch in surveyid and groupid", title, extension and XML checks,
 * the fatalerror as "Error: " + text at RC:1605), import_group RC:1160-1202 and 1227 (the fatalerror at RC:1202). Every
 * "Error: ..." status of these two methods comes before the creation; "Error when update question" (RC:1627, 1651)
 * comes after it and has no colon.
 */
const REFUSAL_STATUSES: ReadonlySet<string> = new Set([
  "Invalid session key",
  "No permission",
  "Error:Survey is Active and not editable",
  "Error:Survey is active and not editable",
  "Invalid extension",
  "Really Invalid extension",
]);

/** Whether an answer of import_question or import_group is a refusal that comes before anything is created. */
function isRefusal(answer: JsonValue | undefined): boolean {
  const row = objectOf(answer);
  if (!row || "errors" in row || typeof row.status !== "string") return false;
  if ("error_code" in row) return typeof row.error_code === "string" && REFUSAL_CODES.has(row.error_code);
  return REFUSAL_STATUSES.has(row.status) || row.status.startsWith("Error: ");
}

const failedCode = (kind: Kind): "ADD_QUESTION_FAILED" | "ADD_GROUP_FAILED" => (kind === "question" ? "ADD_QUESTION_FAILED" : "ADD_GROUP_FAILED");

/**
 * The outcome of the import is not known (class c): LimeSurvey may have created the element. Nothing is deleted
 * automatically; the candidates (read only: new elements with the code or name that were not there before) and a
 * cleanup hint go into the error.
 */
async function unknownOutcome(
  kind: Kind,
  surveyId: number,
  value: unknown,
  findCandidates: () => Promise<JsonObject[]>,
  limit: Limit,
  extra: JsonObject = {},
): Promise<LimeSurveyError> {
  let candidates: JsonObject[] = [];
  let lookup = "";
  try {
    candidates = await findCandidates();
  } catch (error) {
    lookup = ` Listing the candidates failed (${describeError(error).message}).`;
  }
  const cause = describeError(value);
  const deleteTool = kind === "question" ? "limesurvey_delete_question" : "limesurvey_delete_group";
  const cleanupHint = `It is unknown whether LimeSurvey created the ${kind}. Check the candidates and the survey with `
    + `limesurvey_get_survey_spec (survey_id ${surveyId}); delete a leftover ${kind} by hand in the LimeSurvey admin or with `
    + `${deleteTool} under the write scope lifecycle.${lookup}`;
  return cappedError(
    limit,
    `It is unknown whether the ${kind} was created: ${cause.message} Nothing was deleted automatically; see details.candidates `
      + "and details.cleanup_hint.",
    failedCode(kind),
    { candidates },
    (cut) => ({
      failed_step: `import_${kind}`,
      created: "unknown",
      rolled_back: false,
      manual_cleanup: true,
      ...cutList("candidates", cut.candidates, candidates),
      cleanup_hint: cleanupHint,
      ...extra,
      ...(cause.code !== undefined ? { cause_code: cause.code } : {}),
      ...(cause.details !== undefined ? { cause: cause.details } : {}),
      recovery: `Check the candidates before calling the tool again: another call adds the ${kind} once more.`,
    }),
  );
}

/**
 * Runs the import and returns the id of the new element (class a). A refusal before the creation (class b) throws
 * created: false; anything else (class c), also an id that was in the survey before, throws created: "unknown".
 */
async function runImport(
  kind: Kind,
  call: () => Promise<JsonValue>,
  known: ReadonlySet<number>,
  unknown: (value: unknown) => Promise<LimeSurveyError>,
): Promise<number> {
  let answer: JsonValue;
  try {
    answer = await call();
  } catch (value) {
    if (value instanceof LimeSurveyError && isRefusal(value.details)) {
      throw addFailed(kind, `import_${kind}`, value, { created: false, rolled_back: false, manual_cleanup: false });
    }
    throw await unknown(value);
  }
  const id = integer(answer);
  if (id !== undefined && id > 0 && !known.has(id)) return id;
  // A 6.x refusal whose status the client does not take for an error (for example "Really Invalid extension").
  if (isRefusal(answer)) {
    const refusal = new LimeSurveyError(`import_${kind} failed: ${String(objectOf(answer)?.status)}`, undefined, answer);
    throw addFailed(kind, `import_${kind}`, refusal, { created: false, rolled_back: false, manual_cleanup: false });
  }
  throw await unknown(new LimeSurveyError(
    id !== undefined && known.has(id)
      ? `import_${kind} answered the id ${id}, which was in the survey before.`
      : `import_${kind} answered without a new id: ${JSON.stringify(answer)}.`,
    undefined,
    answer,
  ));
}

// ---------------------------------------------------------------- failure and rollback

interface Rollback {
  created?: boolean;
  rolled_back: boolean;
  manual_cleanup: boolean;
  cleanup_hint?: string;
}

async function deleteCreated(rpc: RpcClient, kind: Kind, surveyId: number, id: number): Promise<Rollback> {
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

/** What to do after a failure, by its cause. */
function recoveryFor(kind: Kind, causeCode: string | undefined, rollback: Rollback): string {
  if (rollback.manual_cleanup) return "Remove the leftover element by hand (see cleanup_hint), then call the tool again.";
  const container = kind === "question" ? "group" : "survey";
  if (causeCode === "POSITION_NOT_SET") {
    return `LimeSurvey did not let the new ${kind} move to the requested place, typically because old conditions (the condition `
      + `table) in the ${container} block a new order. Add the ${kind} without position (at the end) and move it in the LimeSurvey `
      + "admin, or remove the old conditions first.";
  }
  if (causeCode === "FIELD_SAVE_FAILED") {
    return `LimeSurvey did not save a field while moving the new ${kind} to its place (see the message). Add the ${kind} without `
      + "position (at the end) and move it in the LimeSurvey admin, or check the permissions of the service account.";
  }
  return "Fix the cause in the message and call the tool again.";
}

function addFailed(kind: Kind, step: string, value: unknown, rollback: Rollback, extra: JsonObject = {}): LimeSurveyError {
  const cause = describeError(value);
  const outcome = rollback.manual_cleanup
    ? "MANUAL CLEANUP NEEDED: see details.cleanup_hint."
    : rollback.created === false
      ? "Nothing was created."
      : `The new ${kind} was deleted again; nothing else was changed.`;
  return new LimeSurveyError(
    `Adding the ${kind} failed at step "${step}": ${cause.message} ${outcome}`,
    failedCode(kind),
    {
      failed_step: step,
      ...(rollback.created !== undefined ? { created: rollback.created } : {}),
      rolled_back: rollback.rolled_back,
      manual_cleanup: rollback.manual_cleanup,
      ...(rollback.cleanup_hint !== undefined ? { cleanup_hint: rollback.cleanup_hint } : {}),
      ...extra,
      ...(cause.code !== undefined ? { cause_code: cause.code } : {}),
      ...(cause.details !== undefined ? { cause: cause.details } : {}),
      recovery: recoveryFor(kind, cause.code, rollback),
    },
  );
}

// ---------------------------------------------------------------- reading back

/** Differences relative to the element: "groups[0].questions[0].text.de" becomes "text.de". */
function relativeTo(prefix: string, label: string, differences: SpecDifference[]): SpecDifference[] {
  return differences.map((item) => ({
    ...item,
    path: item.path === prefix ? label : item.path.startsWith(`${prefix}.`) ? item.path.slice(prefix.length + 1) : item.path,
  }));
}

/** The paths of the gaps as they are after the new question took place `target` in the group at `groupIndex`. */
function gapsAfterInsertion(gaps: readonly TranslationGap[], groupIndex: number, target: number): TranslationGap[] {
  return gaps.map((gap) => {
    const match = /^groups\[(\d+)\]\.questions\[(\d+)\](.*)$/.exec(gap.path);
    if (!match || Number(match[1]) !== groupIndex || Number(match[2]) < target - 1) return gap;
    return { ...gap, path: `groups[${groupIndex}].questions[${Number(match[2]) + 1}]${match[3] ?? ""}` };
  });
}

const GAP_DETAIL = "import_question completes the translations of the whole survey: these texts of other groups and questions had "
  + "no row in an additional language and now hold the text of the base language (paths as after the insertion). This stays "
  + "when the question is deleted again. Answer texts are not checked.";

type Lists = { differences: SpecDifference[]; warnings: SpecWarning[]; gaps: TranslationGap[]; questions: JsonObject[] };

/** The success result, with every list cut to stay within LIMESURVEY_MAX_RESPONSE_CHARS. */
function successResult(limit: Limit, lists: Lists, head: JsonObject, listQuestions: boolean): JsonValue {
  const build = (cut: Lists): JsonValue => ({
    ...head,
    ...(listQuestions ? { questions: json(cut.questions), questions_total: lists.questions.length } : {}),
    verification: {
      ok: lists.differences.length === 0,
      differences: json(cut.differences),
      differences_total: lists.differences.length,
      truncated: cut.differences.length < lists.differences.length,
    },
    side_effects: lists.gaps.length === 0
      ? []
      : [{ kind: "translations_filled_from_base", detail: GAP_DETAIL, ...cutList("gaps", cut.gaps, lists.gaps) }],
    ...(lists.warnings.length > 0 ? { warnings: json(cut.warnings), warnings_total: lists.warnings.length } : {}),
    truncated: cut.differences.length < lists.differences.length
      || cut.warnings.length < lists.warnings.length
      || cut.gaps.length < lists.gaps.length
      || cut.questions.length < lists.questions.length,
  });
  return build(capLists<Lists>(lists, (shown) => structuredSize(limit.workflow, build(shown)) <= limit.maxChars));
}

// ---------------------------------------------------------------- the tools

export async function addQuestionFromSpec(context: AddContext, input: AddQuestionInput): Promise<JsonValue> {
  const limit: Limit = { workflow: "add_question_from_spec", maxChars: context.config.maxResponseChars };
  const { rpc } = context;
  const { survey_id: surveyId, group_id: groupId } = input;
  const spec = plain(input.question);
  checkLocally("question", spec, limit);

  const outline = await readSurveyOutline(rpc, surveyId, { gaps: true });
  const { warnings, generation } = await checkAgainstSurvey("question", spec, outline, context, limit);
  const question = isRecord(spec) ? spec : {};
  const code = asString(question.code);
  assertCodesFree([{ path: "code", code }], outline, limit);
  assertInactive(outline, surveyId);
  const groupIndex = outline.groups.findIndex((item) => item.group_id === groupId);
  const group = outline.groups[groupIndex];
  if (!group) {
    const groupIds = outline.groups.map((item) => item.group_id);
    throw cappedError(limit, `Group ${groupId} does not belong to survey ${surveyId}. Nothing was written.`, "GROUP_SURVEY_MISMATCH", { groupIds }, (cut) => ({
      survey_id: surveyId,
      group_id: groupId,
      ...cutList("group_ids", cut.groupIds, groupIds),
      recovery: "Use a group_id of this survey; limesurvey_get_survey_spec lists them.",
    }));
  }
  const target = questionTarget(input.position, group.questions, groupId, limit);
  assertGapsAcknowledged(outline.gaps, input.acknowledge, limit);
  const languages = outline.languages;
  const lsq = generateQuestionLsq(spec, { languages, ranking: generation === 7 ? "subquestions" : "answers" });
  // import_question always sets the mandatory flag from this parameter (the file's value is overwritten).
  const mandatory = question.mandatory === "soft" ? "S" : question.mandatory === true ? "Y" : "N";
  // The import fills the gaps even when the question is deleted again or its outcome is unknown: a failure reports them too.
  const sideEffects: JsonObject = outline.gaps.length > 0
    ? { side_effects: [{ kind: "translations_filled_from_base", gaps_total: outline.gaps.length }] }
    : {};

  const qid = await runImport(
    "question",
    () => rpc.call("import_question", [surveyId, groupId, Buffer.from(lsq, "utf8").toString("base64"), "lsq", mandatory]),
    outline.questionIds,
    (value) => unknownOutcome("question", surveyId, value, async () => (await questionSequence(rpc, surveyId, groupId))
      .filter((item) => !outline.questionIds.has(item.question_id) && item.code.toLowerCase() === code.toLowerCase())
      .map((item) => ({ question_id: item.question_id, code: item.code })), limit, sideEffects),
  );
  context.created.questions.add(qid);

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
    return successResult(limit, { differences, warnings, gaps: gapsAfterInsertion(outline.gaps, groupIndex, target), questions: [] }, {
      survey_id: surveyId,
      group_id: groupId,
      question_id: qid,
      code,
      position: { index: target },
    }, false);
  } catch (value) {
    const rollback = await deleteCreated(rpc, "question", surveyId, qid);
    throw addFailed("question", step, value, rollback, { question_id: qid, ...sideEffects });
  }
}

export async function addGroupFromSpec(context: AddContext, input: AddGroupInput): Promise<JsonValue> {
  const limit: Limit = { workflow: "add_group_from_spec", maxChars: context.config.maxResponseChars };
  const { rpc } = context;
  const { survey_id: surveyId } = input;
  const spec = plain(input.group);
  checkLocally("group", spec, limit);

  const outline = await readSurveyOutline(rpc, surveyId);
  const { warnings, generation } = await checkAgainstSurvey("group", spec, outline, context, limit);
  const questions = isRecord(spec) && Array.isArray(spec.questions) ? spec.questions : [];
  assertCodesFree(questions.map((item, index) => ({ path: `questions[${index}].code`, code: asString(isRecord(item) ? item.code : undefined) })), outline, limit);
  assertInactive(outline, surveyId);
  const target = groupTarget(input.position, outline.groups, surveyId, limit);
  const languages = outline.languages;
  const base = languages[0] ?? "";
  const lsg = generateGroupLsg(spec, { languages, ranking: generation === 7 ? "subquestions" : "answers" });
  const normal = normalizeGroup(unescapeStrings(spec), languages);
  const name = normal.title[base] ?? "";
  const description = normal.description[base] ?? "";

  const gid = await runImport(
    "group",
    () => rpc.call("import_group", [surveyId, Buffer.from(lsg, "utf8").toString("base64"), "lsg"]),
    outline.groupIds,
    (value) => unknownOutcome("group", surveyId, value, async () => (await groupSequence(rpc, surveyId, base))
      .filter((item) => !outline.groupIds.has(item.group_id) && item.name === name)
      .map((item) => ({ group_id: item.group_id, title: item.name })), limit),
  );
  context.created.groups.add(gid);

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
    const created = (live.layout.groups.find((item) => item.group_id === gid)?.questions ?? [])
      .map((item): JsonObject => ({ code: item.code, question_id: item.question_id }));
    return successResult(limit, { differences, warnings, gaps: [], questions: created }, {
      survey_id: surveyId,
      group_id: gid,
      position: { index: target },
    }, true);
  } catch (value) {
    const rollback = await deleteCreated(rpc, "group", surveyId, gid);
    throw addFailed("group", step, value, rollback, { group_id: gid });
  }
}

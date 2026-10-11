import { randomUUID } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { LimeSurveyClient } from "./client.js";
import { readImportFile } from "./tool-definitions.js";
import { LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";

/**
 * Replaces one main question of an INACTIVE survey by the question in a .lsq file, using only official
 * RemoteControl methods (LimeSurvey 6.17.11: import_question RC:1524-1656, delete_question RC:1468-1500,
 * set_question_properties RC:1872-2006).
 *
 * The only question this can delete is the one named by question_id, after it was checked against the survey
 * (sid), found to be a main question (parent_qid 0), renamed by this call, and read back by its temporary code.
 * Any failure after the first write rolls back: the question this call imported is deleted and the old code is
 * restored. A rollback that fails is reported as manual_cleanup, never hidden.
 */

type JsonObject = { [key: string]: JsonValue };

const MAX_INLINE_CHARS = 200_000;
const OLD_QUESTION_FIELDS = ["sid", "gid", "parent_qid", "title", "question_order", "mandatory", "type"];
const NOTES = "question IDs change; references by code (relevance) keep working; legacy conditions referencing the old qid are not migrated";

export interface ReplaceQuestionInput {
  survey_id: number;
  question_id: number;
  import_data?: string | undefined;
  import_data_path?: string | undefined;
}

interface LsqQuestion {
  title: string;
  mandatory: "Y" | "S" | "N";
  type: string;
}

interface Step {
  step: string;
  status: "done" | "skipped";
  detail?: JsonValue;
}

interface MainQuestion {
  qid: number;
  title: string;
  order: number;
}

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value).trim());

/** LimeSurvey answers ids and counters as numbers or numeric strings. */
function integer(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function objectValue(value: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function causeOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function lsqInvalid(message: string): LimeSurveyError {
  return new LimeSurveyError(message, "LSQ_INVALID", {
    recovery: "Pass a LimeSurvey question file (.lsq) exported from the admin UI (question > Export).",
  });
}

/** Reads the main question (parent_qid 0) of a .lsq file: its code, type and mandatory flag. */
export function parseLsq(buffer: Buffer): LsqQuestion {
  const xml = buffer.toString("utf8").replace(/^﻿/, "");
  if (XMLValidator.validate(xml) !== true) throw lsqInvalid("The file is not well-formed XML.");
  const parsed = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (_name, jpath) => typeof jpath === "string" && jpath.endsWith(".row"),
  }).parse(xml) as { document?: Record<string, unknown> };
  const document = parsed.document;
  if (document === null || typeof document !== "object" || str(document.LimeSurveyDocType) !== "Question") {
    throw lsqInvalid('The file is not a LimeSurvey question file (LimeSurveyDocType "Question" expected).');
  }
  const rows = (document.questions as { rows?: { row?: unknown } } | undefined)?.rows?.row;
  const main = (Array.isArray(rows) ? rows : []).find((row): row is Record<string, unknown> => {
    if (row === null || typeof row !== "object") return false;
    const parent = str((row as Record<string, unknown>).parent_qid);
    return parent === "" || parent === "0";
  });
  if (!main) throw lsqInvalid("The file contains no main question (parent_qid 0).");
  const title = str(main.title);
  if (title === "") throw lsqInvalid("The main question in the file has no code (title).");
  const mandatory = str(main.mandatory);
  return {
    title,
    type: str(main.type),
    // import_question overwrites the flag with its own parameter (RC:1616-1620), so it must be passed on.
    mandatory: mandatory === "Y" || mandatory === "S" ? mandatory : "N",
  };
}

async function loadLsq(config: LimeSurveyConfig, input: ReplaceQuestionInput): Promise<Buffer> {
  const hasData = typeof input.import_data === "string";
  const hasPath = typeof input.import_data_path === "string";
  if (hasData === hasPath) {
    throw new LimeSurveyError(
      "Exactly one of import_data or import_data_path must be provided.",
      "IMPORT_PARAM_CONFLICT",
      { recovery: "Set import_data for a small inline base64 payload, or import_data_path for a local file; never both or neither." },
    );
  }
  if (typeof input.import_data_path === "string") return readImportFile(config, input.import_data_path);
  const data = input.import_data as string;
  if (data.length > MAX_INLINE_CHARS) {
    throw new LimeSurveyError(
      `import_data is ${data.length} characters, which is too large to inline.`,
      "IMPORT_PAYLOAD_TOO_LARGE",
      { recovery: "Use import_data_path with a local file inside LIMESURVEY_IMPORT_DIR instead of inline base64." },
    );
  }
  return Buffer.from(data, "base64");
}

/** The main questions of a group in position order, from list_questions. */
async function listMainQuestions(client: LimeSurveyClient, surveyId: number, groupId: number): Promise<MainQuestion[]> {
  const value = await client.call("list_questions", [surveyId, groupId]);
  if (!Array.isArray(value)) throw new LimeSurveyError("list_questions did not return a list.", "UNEXPECTED_RESPONSE", value);
  const questions: MainQuestion[] = [];
  for (const row of value) {
    const item = objectValue(row);
    if (!item) continue;
    if ((integer(item.parent_qid) ?? 0) !== 0) continue;
    const qid = integer(item.qid ?? item.id);
    if (qid === undefined) continue;
    questions.push({ qid, title: str(item.title), order: integer(item.question_order) ?? 0 });
  }
  return questions.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.order - b.item.order || a.index - b.index)
    .map(({ item }) => item);
}

/** import_question / delete_question answer the question id; anything else is a failure. */
function expectQid(method: string, value: JsonValue): number {
  const qid = integer(value);
  if (qid === undefined || qid <= 0) {
    throw new LimeSurveyError(`${method} did not return a question id.`, "UNEXPECTED_RESPONSE", value);
  }
  return qid;
}

async function setFields(client: LimeSurveyClient, qid: number, data: JsonObject, field: string): Promise<void> {
  const answer = objectValue(await client.call("set_question_properties", [qid, data]));
  if (answer?.[field] !== true) {
    const reported = answer?.[field];
    throw new LimeSurveyError(
      `set_question_properties did not accept ${field}: ${typeof reported === "string" ? reported : JSON.stringify(reported ?? null)}`,
      "FIELD_SAVE_FAILED",
      answer ?? null,
    );
  }
}

interface RollbackState {
  surveyId: number;
  groupId: number;
  oldQid: number;
  oldTitle: string;
  importTitle: string;
  beforeQids: Set<number>;
  renameAttempted: boolean;
  importAttempted: boolean;
  newQids: number[];
}

async function rollback(client: LimeSurveyClient, state: RollbackState): Promise<{ steps: Step[]; manualCleanup: JsonObject[] }> {
  const steps: Step[] = [];
  const manualCleanup: JsonObject[] = [];

  // A failed import may still have created the question (import_question saves it before it sets mandatory).
  // Only a main question that did not exist before and carries the file's code can be that question.
  if (state.importAttempted && state.newQids.length === 0) {
    try {
      const stray = (await listMainQuestions(client, state.surveyId, state.groupId))
        .filter((item) => !state.beforeQids.has(item.qid) && item.title.toLowerCase() === state.importTitle.toLowerCase());
      state.newQids.push(...stray.map((item) => item.qid));
      steps.push({ step: "rollback_find_imported_question", status: "done", detail: { found: stray.map((item) => item.qid) } });
    } catch (value) {
      manualCleanup.push({
        action: "find_imported_question",
        reason: causeOf(value),
        hint: `Check group ${state.groupId} of survey ${state.surveyId} for a question with the code "${state.importTitle}" that was not there before and delete it.`,
      });
    }
  }

  for (const qid of state.newQids) {
    try {
      const deleted = expectQid("delete_question", await client.call("delete_question", [qid]));
      if (deleted !== qid) throw new LimeSurveyError(`delete_question answered ${deleted} instead of ${qid}.`);
      steps.push({ step: "rollback_delete_imported_question", status: "done", detail: { question_id: qid } });
    } catch (value) {
      manualCleanup.push({ action: "delete_question", question_id: qid, reason: causeOf(value) });
    }
  }

  if (state.renameAttempted) {
    try {
      let current: string | undefined;
      try {
        current = str(objectValue(await client.call("get_question_properties", [state.oldQid, ["title"]]))?.title);
      } catch {
        current = undefined;
      }
      if (current === state.oldTitle) {
        steps.push({ step: "rollback_restore_title", status: "skipped", detail: { reason: "the old code was never changed" } });
      } else {
        await setFields(client, state.oldQid, { title: state.oldTitle }, "title");
        steps.push({ step: "rollback_restore_title", status: "done", detail: { question_id: state.oldQid, title: state.oldTitle } });
      }
    } catch (value) {
      manualCleanup.push({
        action: "restore_title",
        question_id: state.oldQid,
        expected_title: state.oldTitle,
        reason: causeOf(value),
      });
    }
  }
  return { steps, manualCleanup };
}

export async function replaceQuestion(
  client: LimeSurveyClient,
  config: LimeSurveyConfig,
  input: ReplaceQuestionInput,
): Promise<JsonValue> {
  const { survey_id: surveyId, question_id: oldQid } = input;
  const file = await loadLsq(config, input);
  const steps: Step[] = [];

  // 1. Only an inactive survey is touched (import_question and delete_question refuse an active one anyway).
  const survey = objectValue(await client.call("get_survey_properties", [surveyId, ["active"]]));
  if (survey?.active === "Y") {
    throw new LimeSurveyError(
      `Survey ${surveyId} is active, so its questions cannot be replaced.`,
      "SURVEY_ACTIVE",
      { survey_id: surveyId },
      { hint_code: "SURVEY_ACTIVE", hint: "Replace the question in an inactive copy of the survey (limesurvey_copy_survey) or deactivate the survey in the admin UI first." },
    );
  }
  if (survey?.active !== "N") {
    throw new LimeSurveyError("get_survey_properties did not report whether the survey is active.", "UNEXPECTED_RESPONSE", survey ?? null);
  }
  steps.push({ step: "check_survey_inactive", status: "done" });

  // 2. The question must belong to the survey and be a main question.
  const old = objectValue(await client.call("get_question_properties", [oldQid, OLD_QUESTION_FIELDS]));
  if (!old || integer(old.sid) !== surveyId) {
    throw new LimeSurveyError(
      `Question ${oldQid} does not belong to survey ${surveyId}.`,
      "QUESTION_SURVEY_MISMATCH",
      { survey_id: surveyId, question_id: oldQid, question_sid: old?.sid ?? null },
    );
  }
  if (integer(old.parent_qid) !== 0) {
    throw new LimeSurveyError(
      `Question ${oldQid} is a subquestion; only main questions can be replaced.`,
      "NOT_A_MAIN_QUESTION",
      { question_id: oldQid, parent_qid: old.parent_qid ?? null },
    );
  }
  const groupId = integer(old.gid);
  const oldOrder = integer(old.question_order);
  const oldTitle = str(old.title);
  if (groupId === undefined || oldOrder === undefined || oldTitle === "") {
    throw new LimeSurveyError("get_question_properties did not report gid, question_order, and title.", "UNEXPECTED_RESPONSE", old);
  }
  const before = await listMainQuestions(client, surveyId, groupId);
  if (!before.some((item) => item.qid === oldQid)) {
    throw new LimeSurveyError(`Question ${oldQid} is not listed in group ${groupId}.`, "UNEXPECTED_RESPONSE", { group_id: groupId });
  }
  steps.push({
    step: "read_old_question",
    status: "done",
    detail: { group_id: groupId, title: oldTitle, question_order: oldOrder, type: str(old.type) },
  });

  // 3. Read the replacement locally. Nothing has been written yet.
  const lsq = parseLsq(file);
  steps.push({ step: "parse_lsq", status: "done", detail: { title: lsq.title, type: lsq.type, mandatory: lsq.mandatory } });

  const state: RollbackState = {
    surveyId,
    groupId,
    oldQid,
    oldTitle,
    importTitle: lsq.title,
    beforeQids: new Set(before.map((item) => item.qid)),
    renameAttempted: false,
    importAttempted: false,
    newQids: [],
  };
  let failedStep = "rename_old_question";

  try {
    // 4. The same code would make import_question fail ("Question title already exist"), so free it first.
    let tempTitle: string | undefined;
    if (lsq.title.toLowerCase() === oldTitle.toLowerCase()) {
      tempTitle = `RPL${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      state.renameAttempted = true;
      await setFields(client, oldQid, { title: tempTitle }, "title");
      steps.push({ step: "rename_old_question", status: "done", detail: { temporary_title: tempTitle } });
    } else {
      steps.push({ step: "rename_old_question", status: "skipped", detail: { reason: "the file brings a different code" } });
    }

    // 5. Import at the end of the group; mandatory comes from the file.
    failedStep = "import_question";
    state.importAttempted = true;
    const newQid = expectQid("import_question", await client.call("import_question", [surveyId, groupId, file.toString("base64"), "lsq", lsq.mandatory]));
    state.newQids.push(newQid);
    steps.push({ step: "import_question", status: "done", detail: { new_question_id: newQid } });

    // 6. Take the old position (LimeSurvey renumbers the group after the change).
    failedStep = "set_question_order";
    await setFields(client, newQid, { question_order: oldOrder }, "question_order");
    steps.push({ step: "set_question_order", status: "done", detail: { question_order: oldOrder } });

    // 7. Delete exactly the old question, after reading it back: same survey, main question, the code this call gave it.
    failedStep = "verify_old_question";
    const expectedTitle = tempTitle ?? oldTitle;
    const check = objectValue(await client.call("get_question_properties", [oldQid, ["sid", "parent_qid", "title"]]));
    if (integer(check?.sid) !== surveyId || integer(check?.parent_qid) !== 0 || str(check?.title) !== expectedTitle) {
      throw new LimeSurveyError(
        `Question ${oldQid} changed during the replacement (expected survey ${surveyId}, a main question, code "${expectedTitle}"); it is not deleted.`,
        "QUESTION_CHANGED",
        check ?? null,
      );
    }
    failedStep = "delete_old_question";
    const deleted = expectQid("delete_question", await client.call("delete_question", [oldQid]));
    if (deleted !== oldQid) {
      throw new LimeSurveyError(`delete_question answered ${deleted} instead of ${oldQid}.`, "UNEXPECTED_RESPONSE");
    }
    steps.push({ step: "delete_old_question", status: "done", detail: { old_question_id: oldQid } });

    // 9. Verification only reports; the old question is gone and cannot be restored here.
    const verification = await verify(client, surveyId, groupId, oldQid, newQid, lsq.title, before);
    return {
      survey_id: surveyId,
      group_id: groupId,
      old_question_id: oldQid,
      new_question_id: newQid,
      title: lsq.title,
      question_order: verification.question_order,
      steps: steps as unknown as JsonValue,
      verification: verification.report,
      notes: NOTES,
    };
  } catch (value) {
    const result = await rollback(client, state);
    const rolledBack = result.manualCleanup.length === 0;
    const cause = causeOf(value);
    throw new LimeSurveyError(
      `replace_question failed at step "${failedStep}": ${cause} `
        + (rolledBack
          ? "All changes were rolled back; the original question is unchanged."
          : "ROLLBACK INCOMPLETE: manual cleanup is required, see details.manual_cleanup."),
      "REPLACE_QUESTION_FAILED",
      {
        failed_step: failedStep,
        cause,
        old_question_id: oldQid,
        new_question_id: state.newQids[0] ?? null,
        steps: steps as unknown as JsonValue,
        rollback: result.steps as unknown as JsonValue,
        rolled_back: rolledBack,
        manual_cleanup: result.manualCleanup,
      },
    );
  }
}

async function verify(
  client: LimeSurveyClient,
  surveyId: number,
  groupId: number,
  oldQid: number,
  newQid: number,
  title: string,
  before: MainQuestion[],
): Promise<{ question_order: number | null; report: JsonValue }> {
  try {
    const props = objectValue(await client.call("get_question_properties", [newQid, ["title", "gid", "question_order", "type"]]));
    const after = await listMainQuestions(client, surveyId, groupId);
    const expected = before.map((item) => (item.qid === oldQid ? newQid : item.qid));
    const actual = after.map((item) => item.qid);
    const checks: JsonObject = {
      title_matches: str(props?.title).toLowerCase() === title.toLowerCase(),
      group_matches: integer(props?.gid) === groupId,
      old_question_removed: !actual.includes(oldQid),
      position_matches: expected.length === actual.length && expected.every((qid, index) => qid === actual[index]),
    };
    return {
      question_order: integer(props?.question_order) ?? null,
      report: {
        ok: Object.values(checks).every((item) => item === true),
        checks,
        expected_sequence: expected,
        actual_sequence: actual,
        type: props?.type ?? null,
      },
    };
  } catch (value) {
    return {
      question_order: null,
      report: { ok: false, error: causeOf(value), hint: "The replacement was done; verify the group in the admin UI." },
    };
  }
}

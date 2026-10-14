import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type Generation } from "./helpers/fake-limesurvey.js";
import { groupsOf, importSpec, mainQuestionsOf, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import { addGroupError, addQuestionError, outcomeAfterRun, surveyOutline, type Outcome } from "./helpers/add-tools.js";

/**
 * GEN-A and GEN-C, review of PR4: what the add tools do when the import does not answer with a new id. Three classes:
 *
 * (a) an answer with a new id: created, rolled back by exactly this id (test/add-question-from-spec.test.ts and
 *     test/add-group-from-spec.test.ts). An id that was in the survey before counts as (c).
 * (b) LimeSurvey refused before it created anything (7.x: the error codes below; 6.x: their status texts):
 *     created false, nothing is deleted.
 * (c) everything else (transport, HTTP and JSON-RPC errors, a status after the creation such as "Error when update
 *     question", an answer with "errors", an unknown answer): created "unknown", nothing is deleted automatically,
 *     manual_cleanup with the candidates (read only) and a cleanup hint.
 *
 * Status texts: LimeSurvey 7.5.1 remotecontrol_handle.php import_group 1227-1294, import_question 1595-1709;
 * 6.17.11 import_group 1153-1230, import_question 1524-1656.
 */

const BASE: Json = {
  survey: { title: "Basis" },
  groups: [
    { title: "Gruppe 1", questions: [{ code: "Q1", type: "S", text: "Eins" }, { code: "Q2", type: "S", text: "Zwei" }] },
    { title: "Gruppe 2", questions: [{ code: "Q3", type: "S", text: "Drei" }] },
  ],
};

const NEW_QUESTION: Json = { code: "N1", type: "S", text: "Neu" };
const NEW_GROUP: Json = { title: "Neue Gruppe", questions: [{ code: "N1", type: "S", text: "Neu" }] };

async function setup(generation: Generation = 7): Promise<{ fake: FakeLimeSurvey; sid: number; gid: number }> {
  const fake = new FakeLimeSurvey({ generation });
  const sid = await importSpec(fake, BASE);
  const first = groupsOf(fake, sid)[0];
  assert.ok(first);
  return { fake, sid, gid: first.gid };
}

const deletes = (fake: FakeLimeSurvey, from: number): string[] => writeMethodsSince(fake, from).filter((method) => method.startsWith("delete_"));

// ---- (b) refused before anything was created ----

/** [error_code of 7.x, status text] of import_question. */
const QUESTION_REFUSALS_7: Array<[string, string]> = [
  ["ERR_INVALID_SESSION", "Invalid session key"],
  ["ERR_INVALID_SURVEY", "Error: Invalid survey ID"],
  ["ERR_NO_PERMISSION", "No permission"],
  ["ERR_SURVEY_ACTIVE", "Error:Survey is Active and not editable"],
  ["ERR_INVALID_GROUP", "Error: Invalid group ID"],
  ["ERR_ALREADY_EXISTS", "Error: Question title already exist in this survey."],
  ["ERR_INVALID_EXTENSION", "Really Invalid extension"],
  ["ERR_INVALID_XML", "Error: Invalid LimeSurvey question structure XML "],
  ["ERR_CREATION_FAILED", "Error: The question could not be imported for the following reasons: x"],
];

/** Status texts of import_question on 6.x (no error_code). */
const QUESTION_REFUSALS_6 = [
  "Invalid session key",
  "Error: Invalid survey ID",
  "No permission",
  "Error:Survey is Active and not editable",
  "Error: Invalid group ID",
  "Error: Missmatch in surveyid and groupid",
  "Error: Question title already exist in this survey.",
  "Invalid extension",
  "Really Invalid extension",
  "Error: Invalid LimeSurvey question structure XML ",
  "Error: The question could not be imported for the following reasons: x",
];

const GROUP_REFUSALS_7: Array<[string, string]> = [
  ["ERR_INVALID_SESSION", "Invalid session key"],
  ["ERR_INVALID_SURVEY", "Error: Invalid survey ID"],
  ["ERR_NO_PERMISSION", "No permission"],
  ["ERR_SURVEY_ACTIVE", "Error:Survey is active and not editable"],
  ["ERR_INVALID_EXTENSION", "Invalid extension"],
  ["ERR_INVALID_XML", "Error: Invalid LimeSurvey group structure XML "],
  ["ERR_CREATION_FAILED", "Error: The languages of the imported group file must at least include the base language of this survey."],
];

const GROUP_REFUSALS_6 = [
  "Invalid session key",
  "Error: Invalid survey ID",
  "No permission",
  "Error:Survey is active and not editable",
  "Invalid extension",
  "Error: Invalid LimeSurvey group structure XML ",
  "Error: The languages of the imported group file must at least include the base language of this survey.",
];

/** The refusal is queued twice for an invalid session: the client logs in again and repeats the call once. */
function refuse(fake: FakeLimeSurvey, method: string, answer: Json): void {
  const times = answer.status === "Invalid session key" ? 2 : 1;
  for (let index = 0; index < times; index += 1) fake.failNext(method, answer);
}

function assertNotCreated(error: Json, kind: "question" | "group", label: string): void {
  assert.equal(error.code, kind === "question" ? "ADD_QUESTION_FAILED" : "ADD_GROUP_FAILED", `${label}: ${JSON.stringify(error).slice(0, 800)}`);
  assert.equal(error.details?.failed_step, `import_${kind}`, label);
  assert.equal(error.details?.created, false, `${label}: created`);
  assert.equal(error.details?.rolled_back, false, `${label}: rolled_back`);
  assert.equal(error.details?.manual_cleanup, false, `${label}: manual_cleanup`);
}

const questionRefusals = [
  ...QUESTION_REFUSALS_7.map(([code, status]): [Generation, Json] => [7, { status, error_code: code }]),
  ...QUESTION_REFUSALS_6.map((status): [Generation, Json] => [6, { status }]),
];

for (const [generation, answer] of questionRefusals) {
  const label = `generation ${generation}, ${String(answer.error_code ?? JSON.stringify(answer.status))}`;
  test(`[GEN-A] import_question refused before creating (${label}): created false, nothing deleted, survey unchanged`, async () => {
    const { fake, sid, gid } = await setup(generation);
    const outline = surveyOutline(fake, sid);
    refuse(fake, "import_question", answer);
    const before = fake.requests.length;
    const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid, question: NEW_QUESTION }), { fake });
    assertNotCreated(error, "question", label);
    assert.deepEqual(deletes(fake, before), [], `${label}: nothing may be deleted`);
    assert.deepEqual(surveyOutline(fake, sid), outline);
  });
}

const groupRefusals = [
  ...GROUP_REFUSALS_7.map(([code, status]): [Generation, Json] => [7, { status, error_code: code }]),
  ...GROUP_REFUSALS_6.map((status): [Generation, Json] => [6, { status }]),
];

for (const [generation, answer] of groupRefusals) {
  const label = `generation ${generation}, ${String(answer.error_code ?? JSON.stringify(answer.status))}`;
  test(`[GEN-C] import_group refused before creating (${label}): created false, nothing deleted, survey unchanged`, async () => {
    const { fake, sid } = await setup(generation);
    const outline = surveyOutline(fake, sid);
    refuse(fake, "import_group", answer);
    const before = fake.requests.length;
    const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP }), { fake });
    assertNotCreated(error, "group", label);
    assert.deepEqual(deletes(fake, before), [], `${label}: nothing may be deleted`);
    assert.deepEqual(surveyOutline(fake, sid), outline);
  });
}

// ---- (c) the outcome is unknown: nothing is deleted automatically ----

function assertUnknown(error: Json, kind: "question" | "group", label: string): void {
  assert.equal(error.code, kind === "question" ? "ADD_QUESTION_FAILED" : "ADD_GROUP_FAILED", `${label}: ${JSON.stringify(error).slice(0, 800)}`);
  assert.equal(error.details?.failed_step, `import_${kind}`, label);
  assert.equal(error.details?.created, "unknown", `${label}: created`);
  assert.equal(error.details?.rolled_back, false, `${label}: rolled_back`);
  assert.equal(error.details?.manual_cleanup, true, `${label}: manual_cleanup`);
  const hint = String(error.details?.cleanup_hint ?? "");
  assert.match(hint, /limesurvey_get_survey_spec/, `${label}: cleanup_hint names the tool to check with`);
  assert.match(hint, kind === "question" ? /limesurvey_delete_question/ : /limesurvey_delete_group/, `${label}: cleanup_hint names the delete tool`);
  assert.match(hint, /lifecycle/, `${label}: cleanup_hint names the write scope lifecycle`);
}

/** Outcomes after which LimeSurvey has created the element (the fake ran the import). */
const AFTER_CREATION: Array<[label: string, outcome: Outcome]> = [
  ["a lost connection", { kind: "transport" }],
  ["HTTP 500", { kind: "http", status: 500 }],
  ["a JSON-RPC error", { kind: "rpc_error", message: "Internal error" }],
  ['"Error when update question" with errors', { kind: "result", result: { status: "Error when update question", errors: { title: ["Question code is invalid."] } } }],
  ["a refusal code together with errors", { kind: "result", result: { status: "Error: x", error_code: "ERR_CREATION_FAILED", errors: { title: ["x"] } } }],
  ["an unknown error_code", { kind: "result", result: { status: "Error: something", error_code: "ERR_SOMETHING_NEW" } }],
  ["an answer that is no id", { kind: "result", result: true }],
];

for (const [label, outcome] of AFTER_CREATION) {
  test(`[GEN-A] after ${label} from import_question the question is not deleted: created unknown, manual_cleanup, the new question as candidate`, async () => {
    const { fake, sid, gid } = await setup();
    const known = new Set(fake.questions.map((item) => item.qid));
    outcomeAfterRun(fake, "import_question", outcome);
    const before = fake.requests.length;
    const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid, question: NEW_QUESTION }), { fake });
    assertUnknown(error, "question", label);
    const created = mainQuestionsOf(fake, gid).find((item) => !known.has(item.qid));
    assert.ok(created, "the premise: the fake created the question");
    assert.deepEqual(error.details?.candidates, [{ question_id: created.qid, code: "N1" }]);
    assert.deepEqual(writeMethodsSince(fake, before), ["import_question"], "nothing is written or deleted after the import");
    assert.ok(fake.questions.some((item) => item.qid === created.qid), "the question still exists");
  });

  test(`[GEN-C] after ${label} from import_group the group is not deleted: created unknown, manual_cleanup, the new group as candidate`, async () => {
    const { fake, sid } = await setup();
    const known = new Set(groupsOf(fake, sid).map((item) => item.gid));
    outcomeAfterRun(fake, "import_group", outcome);
    const before = fake.requests.length;
    const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP }), { fake });
    assertUnknown(error, "group", label);
    const created = groupsOf(fake, sid).find((item) => !known.has(item.gid));
    assert.ok(created, "the premise: the fake created the group");
    assert.deepEqual(error.details?.candidates, [{ group_id: created.gid, title: "Neue Gruppe" }]);
    assert.deepEqual(writeMethodsSince(fake, before), ["import_group"], "nothing is written or deleted after the import");
    assert.ok(fake.groups.some((item) => item.gid === created.gid), "the group still exists");
  });
}

test("[GEN-A] generation 6: \"Error when update question\" after the import is no refusal: created unknown, the question stays", async () => {
  const { fake, sid, gid } = await setup(6);
  const known = new Set(fake.questions.map((item) => item.qid));
  outcomeAfterRun(fake, "import_question", { kind: "result", result: { status: "Error when update question", errors: [{ title: ["x"] }] } });
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid, question: NEW_QUESTION }), { fake });
  assertUnknown(error, "question", "6.x Error when update question");
  const created = mainQuestionsOf(fake, gid).find((item) => !known.has(item.qid));
  assert.ok(created);
  assert.deepEqual(error.details?.candidates, [{ question_id: created.qid, code: "N1" }]);
  assert.deepEqual(deletes(fake, before), []);
});

test("[GEN-A] generation 6: an unknown status from import_question counts as unknown, not as a refusal", async () => {
  const { fake, sid, gid } = await setup(6);
  fake.failNext("import_question", { status: "Something unexpected" });
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid, question: NEW_QUESTION }), { fake });
  assertUnknown(error, "question", "6.x unknown status");
  assert.deepEqual(error.details?.candidates, []);
  assert.deepEqual(deletes(fake, before), []);
});

test("[GEN-A] a JSON-RPC error before anything was created: created unknown and no candidates, nothing deleted", async () => {
  const { fake, sid, gid } = await setup();
  const outline = surveyOutline(fake, sid);
  fake.failNext("import_question", new Error("boom"));
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid, question: NEW_QUESTION }), { fake });
  assertUnknown(error, "question", "JSON-RPC error");
  assert.deepEqual(error.details?.candidates, []);
  assert.deepEqual(deletes(fake, before), []);
  assert.deepEqual(surveyOutline(fake, sid), outline);
});

// ---- (a) with an id that was there before counts as (c) ----

test("[GEN-A] import_question answering the id of an existing question: created unknown, that question is neither written nor deleted", async () => {
  const { fake, sid, gid } = await setup();
  const existing = mainQuestionsOf(fake, gid)[0];
  assert.ok(existing);
  const outline = surveyOutline(fake, sid);
  fake.failNext("import_question", existing.qid);
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid, question: NEW_QUESTION }), { fake });
  assertUnknown(error, "question", "existing qid");
  assert.deepEqual(error.details?.candidates, []);
  assert.deepEqual(writeMethodsSince(fake, before), ["import_question"], "no write after the import, no delete");
  assert.deepEqual(surveyOutline(fake, sid), outline);
});

test("[GEN-C] import_group answering the id of an existing group: created unknown, that group is neither written nor deleted", async () => {
  const { fake, sid, gid } = await setup();
  const outline = surveyOutline(fake, sid);
  fake.failNext("import_group", gid);
  const before = fake.requests.length;
  const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP }), { fake });
  assertUnknown(error, "group", "existing gid");
  assert.deepEqual(error.details?.candidates, []);
  assert.deepEqual(writeMethodsSince(fake, before), ["import_group"], "no write after the import, no delete");
  assert.deepEqual(surveyOutline(fake, sid), outline);
});

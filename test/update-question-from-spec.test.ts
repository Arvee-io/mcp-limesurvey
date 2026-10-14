import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type FakeQuestion, type Generation } from "./helpers/fake-limesurvey.js";
import { envConfig } from "./helpers/mcp-session.js";
import { seedSurvey, type SeedSurvey } from "./helpers/seed-survey.js";
import { importSpec, mainQuestionsOf, readOk, validateSpec, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import { both, captureResults, codesOf, errorPaths, outcomeAfterRun, propertyNames, requestsSince, surveyOutline } from "./helpers/add-tools.js";
import {
  acknowledgeable,
  ALL_ACK,
  answerText,
  clone,
  dropFirstAnswerFromNowOn,
  riskOf,
  UPDATE_QUESTION,
  updateQuestion,
  updateQuestionError,
  updateQuestionOk,
} from "./helpers/update-tools.js";

/**
 * GEN-B: limesurvey_update_question_from_spec changes one existing question to the desired end state (a question spec,
 * typically the changed output of get_survey_spec). The dry run shows the changes, the mode (none, texts, columns,
 * replace) and the risks. The real run needs expected_fingerprint and confirm_destructive_action; texts are written in
 * place (also at an active survey), the main question columns in place (inactive only), everything else replaces the
 * question (import, same place, full read-back before the old question is deleted, rollback on any difference).
 */

/** One language (de): group 1 with Q0, Q1 (L with two answers) and Q2; group 2 with Q4 (M with two subquestions). */
const BASE: Json = {
  survey: { title: "Basis" },
  groups: [
    {
      title: "Gruppe 1",
      questions: [
        { code: "Q0", type: "S", text: "Vorher" },
        { code: "Q1", type: "L", text: "Wahl", help: "Bitte wählen", answers: [{ code: "A1", text: "Eins" }, { code: "A2", text: "Zwei" }] },
        { code: "Q2", type: "S", text: "Nachher" },
      ],
    },
    {
      title: "Gruppe 2",
      questions: [{ code: "Q4", type: "M", text: "Auswahl", subquestions: [{ code: "SQ1", text: "Eins" }, { code: "SQ2", text: "Zwei" }] }],
    },
  ],
};

const EXTRA_ANSWER: Json = { code: "A3", text: { de: "Drei" }, assessment_value: 0 };

const DATA_URI = '<img src="data:image/png;base64,AAAA">';

interface Base {
  fake: FakeLimeSurvey;
  sid: number;
  /** The main question with this code. */
  question: (code: string) => FakeQuestion;
}

function questionIn(fake: FakeLimeSurvey, sid: number, code: string): FakeQuestion {
  const found = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === code);
  assert.ok(found, `the survey has no question ${code}`);
  return found;
}

/** A fake with a survey created by create_survey_from_spec. */
async function setup(spec: Json = BASE, generation: Generation = 7): Promise<Base> {
  const fake = new FakeLimeSurvey({ generation });
  const sid = await importSpec(fake, spec);
  return { fake, sid, question: (code) => questionIn(fake, sid, code) };
}

/** The arguments of a dry run. */
const dry = (surveyId: number, questionId: number, question: Json): Json => ({
  survey_id: surveyId,
  question_id: questionId,
  question,
  dry_run: true,
});

/** The arguments of a real run, with the fingerprint, the confirmation and (optionally) the acknowledged risks. */
function real(surveyId: number, questionId: number, question: Json, fingerprint: unknown, acknowledge?: readonly string[]): Json {
  return {
    survey_id: surveyId,
    question_id: questionId,
    question,
    expected_fingerprint: String(fingerprint),
    confirm_destructive_action: true,
    ...(acknowledge !== undefined ? { acknowledge: [...acknowledge] } : {}),
  };
}

/** The spec with one more answer (A3): a change that needs the replacement. */
function withExtraAnswer(spec: Json): Json {
  const desired = clone(spec);
  desired.answers.push(clone(EXTRA_ANSWER));
  return desired;
}

function without(args: Json, key: string): Json {
  const copy = { ...args };
  delete copy[key];
  return copy;
}

/** The answers of a question in their order: [code, text in de]. */
const answersOf = (fake: FakeLimeSurvey, qid: number): Array<[string, string | undefined]> => fake.answers
  .filter((item) => item.qid === qid)
  .sort((a, b) => a.scale_id - b.scale_id || a.sortorder - b.sortorder)
  .map((item) => [item.code, item.l10n.de]);

// ---- the tool and its contract ----

test("[GEN-B] update_question_from_spec is registered with the annotations and the input of the contract, and takes no file path", async () => {
  await withSession(async (session) => {
    const tool = (await session.client.listTools()).tools.find((item) => item.name === UPDATE_QUESTION);
    assert.ok(tool, `${UPDATE_QUESTION} is not registered`);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, true);
    assert.equal(tool.annotations?.idempotentHint, false);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.outputSchema, "the tool has an output schema");
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
      "acknowledge", "confirm_destructive_action", "dry_run", "expected_fingerprint", "question", "question_id", "survey_id",
    ]);
    const required = tool.inputSchema.required ?? [];
    for (const name of ["survey_id", "question_id", "question"]) assert.ok(required.includes(name), `${name} is required`);
    for (const name of ["expected_fingerprint", "confirm_destructive_action", "acknowledge"]) {
      assert.ok(!required.includes(name), `${name} is only needed for the real run, so the schema must not require it`);
    }
    const acknowledge = JSON.stringify(tool.inputSchema.properties?.acknowledge ?? null);
    for (const value of ALL_ACK) assert.ok(acknowledge.includes(`"${value}"`), `acknowledge lacks ${value}: ${acknowledge}`);
    assert.deepEqual(propertyNames(tool.inputSchema).filter((name) => /path|file/i.test(name)), [], "the tool takes no file parameter");
  });
});

// ---- 1: round trip without a change ----

test("[GEN-B] the unchanged spec of get_survey_spec gives mode none: the dry run lists no change, the real run writes nothing", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  const outline = surveyOutline(fake, sid);
  let before = 0;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    before = fake.requests.length;
    const preview = await updateQuestionOk(session, dry(sid, q1, read.spec));
    assert.equal(preview.mode, "none");
    assert.deepEqual(preview.changes, []);
    assert.equal(preview.changes_total, 0);
    assert.equal(preview.survey_id, sid);
    assert.equal(preview.question_id, q1);
    assert.equal(preview.survey_active, false);
    assert.equal(preview.fingerprint, read.fingerprint, "the fingerprint of the dry run is the one get_survey_spec gives for the question");

    const result = await updateQuestionOk(session, real(sid, q1, read.spec, read.fingerprint));
    assert.equal(result.mode, "none");
    assert.deepEqual(result.changes, []);
    assert.equal(result.question_id, q1);
  }, { fake });
  assert.deepEqual(writeMethodsSince(fake, before), [], "nothing is written");
  assert.deepEqual(surveyOutline(fake, sid), outline);
});

// ---- 2: dry run of a replacement ----

test("[GEN-B] a dry run with a changed answer list (write scope none) gives mode replace, a structure change at answers, the risk qid_bound_links, and sends read methods only", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  const read = await withSession((session) => readOk(session, { survey_id: sid, question_id: q1 }), { fake });
  const before = fake.requests.length;
  const preview = await withSession(
    (session) => updateQuestionOk(session, dry(sid, q1, withExtraAnswer(read.spec))),
    { fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) },
  );
  assert.equal(preview.mode, "replace");
  assert.equal(preview.survey_active, false);
  const changes = preview.changes as Json[];
  assert.ok(changes.some((item) => String(item.path).startsWith("answers") && item.kind === "structure"), JSON.stringify(changes));
  assert.equal(preview.changes_total, changes.length);
  const risk = riskOf(preview.risks, "qid_bound_links");
  assert.ok(risk, `risks: ${JSON.stringify(preview.risks)}`);
  assert.equal(risk.blocking, true);
  assert.equal(risk.acknowledgeable, true);
  assert.ok(typeof risk.detail === "string" && risk.detail.trim().length > 0, "the risk explains itself");
  assert.ok(Array.isArray(preview.plan) && preview.plan.length > 0, `plan: ${JSON.stringify(preview.plan)}`);
  assert.ok((preview.plan as unknown[]).every((step) => typeof step === "string"), "every step of the plan is a sentence");
  assert.equal(preview.fingerprint, read.fingerprint);

  assert.ok(fake.requests.length > before, "the dry run read the survey");
  assert.deepEqual(writeMethodsSince(fake, before), [], "a dry run sends read methods only");
  assert.deepEqual(answersOf(fake, q1), [["A1", "Eins"], ["A2", "Zwei"]]);
});

// ---- 3: the real replacement ----

test("[GEN-B] the real replacement (inactive, reported risks acknowledged): a new question at the same place, the old one deleted only after the new one was read back", async () => {
  const { fake, sid, question } = await setup();
  const old = question("Q1");
  const codes = codesOf(fake, old.gid);
  let before = 0;
  const result = await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: old.qid });
    const desired = withExtraAnswer(read.spec);
    const preview = await updateQuestionOk(session, dry(sid, old.qid, desired));
    before = fake.requests.length;
    return updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(preview)));
  }, { fake });

  assert.equal(result.mode, "replace");
  assert.equal(result.applied, true);
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const newQid = Number(result.question_id);
  assert.ok(Number.isInteger(newQid) && newQid > 0 && newQid !== old.qid, `question_id: ${String(result.question_id)}`);
  assert.deepEqual(codesOf(fake, old.gid), codes, "the codes of the group keep their order");
  assert.equal(mainQuestionsOf(fake, old.gid)[1]?.qid, newQid, "the new question takes the place of the old one");
  assert.ok(!fake.questions.some((item) => item.qid === old.qid), "the old question is deleted");
  assert.deepEqual(answersOf(fake, newQid), [["A1", "Eins"], ["A2", "Zwei"], ["A3", "Drei"]]);

  const requests = fake.requests.slice(before);
  const deletes = requests.filter((request) => request.method === "delete_question").map((request) => Number(request.params[1]));
  assert.deepEqual(deletes, [old.qid], "only the old question is deleted");
  const deleteAt = requests.findIndex((request) => request.method === "delete_question");
  const readBackAt = requests.findIndex((request) => request.method === "get_question_properties" && Number(request.params[1]) === newQid);
  assert.ok(readBackAt >= 0 && readBackAt < deleteAt, `the new question is read back (at ${readBackAt}) before the old one is deleted (at ${deleteAt})`);
});

// ---- 4: confirmation and fingerprint ----

test("[GEN-B] the real run without confirm_destructive_action (or with false) or without expected_fingerprint fails and writes nothing", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  const outline = surveyOutline(fake, sid);
  let before = 0;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    const full = real(sid, q1, withExtraAnswer(read.spec), read.fingerprint, ALL_ACK);
    before = fake.requests.length;
    const cases: Array<[label: string, args: Json, pattern: RegExp]> = [
      ["without confirm_destructive_action", without(full, "confirm_destructive_action"), /confirm_destructive_action/],
      ["with confirm_destructive_action false", { ...full, confirm_destructive_action: false }, /confirm_destructive_action/],
      ["without expected_fingerprint", without(full, "expected_fingerprint"), /expected_fingerprint/],
    ];
    for (const [label, args, pattern] of cases) {
      const response = await updateQuestion(session, args);
      assert.equal(response.isError, true, label);
      assert.match(answerText(response), pattern, `${label}: the error names the missing argument`);
    }
  }, { fake });
  assert.deepEqual(writeMethodsSince(fake, before), []);
  assert.deepEqual(surveyOutline(fake, sid), outline);
  assert.deepEqual(answersOf(fake, q1), [["A1", "Eins"], ["A2", "Zwei"]]);
});

// ---- 5: stale spec ----

test("[GEN-B] a question text changed in LimeSurvey after get_survey_spec makes the real run answer STALE_SPEC, and nothing is written", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = withExtraAnswer(read.spec);
    const row = q1.l10n.de;
    assert.ok(row);
    row.question = "Inzwischen geändert";
    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint, ALL_ACK));
    assert.equal(error.code, "STALE_SPEC", JSON.stringify(error).slice(0, 1500));
    assert.deepEqual(writeMethodsSince(fake, before), []);
  }, { fake });
  assert.equal(question("Q1").qid, q1.qid);
  assert.equal(q1.l10n.de?.question, "Inzwischen geändert");
  assert.deepEqual(answersOf(fake, q1.qid), [["A1", "Eins"], ["A2", "Zwei"]]);
});

// ---- 6: blocking risks ----

test("[GEN-B] a replacement without acknowledge answers UPDATE_QUESTION_BLOCKED with the risks and writes nothing; with the acknowledged risks it runs", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    const desired = withExtraAnswer(read.spec);
    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, q1, desired, read.fingerprint));
    assert.equal(error.code, "UPDATE_QUESTION_BLOCKED", JSON.stringify(error).slice(0, 1500));
    const risk = riskOf(error.details?.risks, "qid_bound_links");
    assert.ok(risk, JSON.stringify(error.details));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, true);
    assert.deepEqual(writeMethodsSince(fake, before), []);

    const result = await updateQuestionOk(session, real(sid, q1, desired, read.fingerprint, acknowledgeable({ risks: error.details?.risks })));
    assert.equal(result.mode, "replace");
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  }, { fake });
});

// ---- 7: active survey ----

test("[GEN-B] active survey: changed structure, a changed column and a changed answer text answer SURVEY_ACTIVE with the changes and write nothing", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  fake.setActive(sid, true);
  const outline = surveyOutline(fake, sid);
  const refused: Array<[label: string, change: (spec: Json) => void, path: RegExp]> = [
    ["an added answer", (spec) => spec.answers.push(clone(EXTRA_ANSWER)), /^answers/],
    ["mandatory", (spec) => { spec.mandatory = true; }, /^mandatory/],
    // RemoteControl has no method that writes answer texts.
    ["an answer text", (spec) => { spec.answers[0].text = { de: "Eins!" }; }, /^answers\[0\]/],
  ];
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    assert.equal(read.active, true);
    for (const [label, change, path] of refused) {
      const desired = clone(read.spec);
      change(desired);
      const before = fake.requests.length;
      const error = await updateQuestionError(session, real(sid, q1, desired, read.fingerprint, ALL_ACK));
      assert.equal(error.code, "SURVEY_ACTIVE", `${label}: ${JSON.stringify(error).slice(0, 1500)}`);
      const changes = error.details?.changes as Json[] | undefined;
      assert.ok(Array.isArray(changes) && changes.some((item) => path.test(String(item.path))), `${label}: ${JSON.stringify(error.details)}`);
      assert.deepEqual(writeMethodsSince(fake, before), [], label);
    }
  }, { fake });
  assert.deepEqual(surveyOutline(fake, sid), outline);
  assert.deepEqual(answersOf(fake, q1), [["A1", "Eins"], ["A2", "Zwei"]]);
});

test("[GEN-B] active survey: a changed question text gives mode texts and is written with set_question_properties (questionl10ns only), no import, no delete", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  fake.setActive(sid, true);
  let before = 0;
  const result = await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = clone(read.spec);
    desired.text = { de: "Wahl, neu formuliert" };
    before = fake.requests.length;
    return updateQuestionOk(session, real(sid, q1.qid, desired, read.fingerprint));
  }, { fake });
  assert.equal(result.mode, "texts");
  assert.equal(result.survey_active, true);
  assert.equal(result.applied, true);
  assert.equal(result.question_id, q1.qid);
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  assert.ok((result.changes as Json[]).some((item) => String(item.path).startsWith("text") && item.kind === "text"), JSON.stringify(result.changes));

  const writes = writeMethodsSince(fake, before);
  assert.ok(writes.length > 0 && writes.every((method) => method === "set_question_properties"), writes.join(", "));
  for (const request of requestsSince(fake, before, "set_question_properties")) {
    assert.equal(Number(request.params[1]), q1.qid);
    assert.deepEqual(Object.keys(request.params[2] as Json), ["questionl10ns"], "an active survey gets texts only");
  }
  assert.equal(q1.l10n.de?.question, "Wahl, neu formuliert");
  assert.equal(q1.l10n.de?.help, "Bitte wählen", "the help text stays");
  assert.equal(question("Q1").qid, q1.qid, "the question keeps its id");
});

// ---- 8: columns ----

test("[GEN-B] inactive survey, only mandatory and relevance changed: mode columns, set_question_properties on the same question, no new question", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  const codes = codesOf(fake, q1.gid);
  let before = 0;
  const result = await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = clone(read.spec);
    desired.mandatory = true;
    desired.relevance = "Q0.NAOK != ''";
    before = fake.requests.length;
    return updateQuestionOk(session, real(sid, q1.qid, desired, read.fingerprint));
  }, { fake });
  assert.equal(result.mode, "columns");
  assert.equal(result.applied, true);
  assert.equal(result.question_id, q1.qid);
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  assert.ok((result.changes as Json[]).some((item) => item.path === "mandatory" && item.kind === "column"), JSON.stringify(result.changes));

  const writes = writeMethodsSince(fake, before);
  assert.ok(writes.length > 0 && writes.every((method) => method === "set_question_properties"), writes.join(", "));
  for (const request of requestsSince(fake, before, "set_question_properties")) assert.equal(Number(request.params[1]), q1.qid);
  assert.equal(q1.mandatory, "Y");
  assert.equal(q1.relevance, "Q0.NAOK != ''");
  assert.equal(question("Q1").qid, q1.qid);
  assert.deepEqual(codesOf(fake, q1.gid), codes);
});

// ---- 9: full comparison before the delete ----

test("[GEN-B] when the import changes the new question (an answer is lost), REPLACE_QUESTION_FAILED rolls back: the new question is deleted, the old one is unchanged", async () => {
  const { fake, sid, question } = await setup();
  const old = question("Q1");
  const imported = captureResults(fake, "import_question");
  const read = await withSession((session) => readOk(session, { survey_id: sid, question_id: old.qid }), { fake });
  const desired = withExtraAnswer(read.spec);
  const preview = await withSession((session) => updateQuestionOk(session, dry(sid, old.qid, desired)), { fake });
  const outline = surveyOutline(fake, sid);
  const oldAnswers = clone(fake.answers.filter((item) => item.qid === old.qid));
  dropFirstAnswerFromNowOn(fake);
  const before = fake.requests.length;

  const error = await withSession(
    (session) => updateQuestionError(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(preview))),
    { fake },
  );
  assert.equal(error.code, "REPLACE_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
  assert.ok(typeof error.details?.failed_step === "string" && error.details.failed_step.length > 0, JSON.stringify(error.details));
  assert.equal(error.details?.rolled_back, true);
  assert.ok(["false", "[]"].includes(JSON.stringify(error.details?.manual_cleanup)), `manual_cleanup: ${JSON.stringify(error.details?.manual_cleanup)}`);
  const differences = error.details?.differences;
  assert.ok(Array.isArray(differences) && differences.length > 0, JSON.stringify(error.details));
  assert.match(JSON.stringify(differences), /answers/);

  assert.equal(imported.length, 1, "one question was imported");
  const newQid = Number(imported[0]);
  assert.ok(Number.isInteger(newQid) && newQid > 0, `import_question answered ${JSON.stringify(imported[0])}`);
  assert.ok(!fake.questions.some((item) => item.qid === newQid || item.parent_qid === newQid), "the new question is deleted again");
  assert.deepEqual(requestsSince(fake, before, "delete_question").map((request) => Number(request.params[1])), [newQid], "the old question is never deleted");
  assert.deepEqual(surveyOutline(fake, sid), outline, "the old question keeps its id, code, texts and place");
  assert.deepEqual(fake.answers.filter((item) => item.qid === old.qid), oldAnswers);
});

// ---- 10: removals ----

test("[GEN-B] an end state without an existing answer reports the acknowledgeable risk removals; without it acknowledged the run is blocked", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    const desired = clone(read.spec);
    desired.answers = (desired.answers as Json[]).filter((item) => item.code !== "A2");
    const preview = await updateQuestionOk(session, dry(sid, q1, desired));
    assert.equal(preview.mode, "replace");
    const removals = riskOf(preview.risks, "removals");
    assert.ok(removals, JSON.stringify(preview.risks));
    assert.equal(removals.blocking, true);
    assert.equal(removals.acknowledgeable, true);

    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, q1, desired, read.fingerprint, ["qid_bound_links"]));
    assert.equal(error.code, "UPDATE_QUESTION_BLOCKED", JSON.stringify(error).slice(0, 1500));
    assert.ok(riskOf(error.details?.risks, "removals"), JSON.stringify(error.details));
    assert.deepEqual(writeMethodsSince(fake, before), []);

    const result = await updateQuestionOk(session, real(sid, q1, desired, read.fingerprint, acknowledgeable(preview)));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    assert.deepEqual(answersOf(fake, Number(result.question_id)), [["A1", "Eins"]]);
  }, { fake });
});

// ---- 11: references to the code ----

test("[GEN-B] renaming a code another question refers to reports code_references (blocking, not acknowledgeable): blocked even with every acknowledgement", async () => {
  const referenced = clone(BASE);
  referenced.groups[0].questions[2].relevance = "Q1.NAOK == 'A1'";
  const { fake, sid, question } = await setup(referenced);
  const q1 = question("Q1").qid;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    const desired = clone(read.spec);
    desired.code = "Q9";
    const preview = await updateQuestionOk(session, dry(sid, q1, desired));
    const risk = riskOf(preview.risks, "code_references");
    assert.ok(risk, JSON.stringify(preview.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, false);
    assert.match(JSON.stringify(risk), /Q2|questions\[2\]/, "the risk names where the old code is used (Q2)");

    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, q1, desired, read.fingerprint, ALL_ACK));
    assert.equal(error.code, "UPDATE_QUESTION_BLOCKED", JSON.stringify(error).slice(0, 1500));
    assert.ok(riskOf(error.details?.risks, "code_references"), JSON.stringify(error.details));
    assert.deepEqual(writeMethodsSince(fake, before), []);
  }, { fake });
  assert.equal(question("Q1").qid, q1, "the code stays");
});

// ---- 12: quotas ----

test("[GEN-B] a survey with a quota reports quota_members (acknowledgeable) for a replacement; without it acknowledged the run is blocked", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  fake.addQuota(sid, "Quote 1");
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    const desired = withExtraAnswer(read.spec);
    const preview = await updateQuestionOk(session, dry(sid, q1, desired));
    const risk = riskOf(preview.risks, "quota_members");
    assert.ok(risk, JSON.stringify(preview.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, true);

    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, q1, desired, read.fingerprint, ["qid_bound_links"]));
    assert.equal(error.code, "UPDATE_QUESTION_BLOCKED", JSON.stringify(error).slice(0, 1500));
    assert.ok(riskOf(error.details?.risks, "quota_members"), JSON.stringify(error.details));
    assert.deepEqual(writeMethodsSince(fake, before), []);
  }, { fake });
});

// ---- 13: data URIs ----

test("[GEN-B] a help text with an embedded data URI blocks a replacement (data_uri, not acknowledgeable) even with every acknowledgement", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  const row = q1.l10n.de;
  assert.ok(row);
  row.help = DATA_URI;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = withExtraAnswer(read.spec);
    const preview = await updateQuestionOk(session, dry(sid, q1.qid, desired));
    const risk = riskOf(preview.risks, "data_uri");
    assert.ok(risk, JSON.stringify(preview.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, false);

    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint, ALL_ACK));
    assert.equal(error.code, "UPDATE_QUESTION_BLOCKED", JSON.stringify(error).slice(0, 1500));
    assert.ok(riskOf(error.details?.risks, "data_uri"), JSON.stringify(error.details));
    assert.deepEqual(writeMethodsSince(fake, before), []);
  }, { fake });
  assert.equal(q1.l10n.de?.help, DATA_URI);
  assert.equal(question("Q1").qid, q1.qid);
});

// ---- 14: LimeSurvey 6 ----

test("[GEN-B] generation 6: the replacement works: a new question at the same place with the desired answers", async () => {
  const { fake, sid, question } = await setup(BASE, 6);
  const old = question("Q1");
  const codes = codesOf(fake, old.gid);
  const result = await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: old.qid });
    const desired = withExtraAnswer(read.spec);
    const preview = await updateQuestionOk(session, dry(sid, old.qid, desired));
    assert.equal(preview.mode, "replace");
    return updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(preview)));
  }, { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const newQid = Number(result.question_id);
  assert.notEqual(newQid, old.qid);
  assert.deepEqual(codesOf(fake, old.gid), codes);
  assert.equal(mainQuestionsOf(fake, old.gid)[1]?.qid, newQid);
  assert.ok(!fake.questions.some((item) => item.qid === old.qid));
  assert.deepEqual(answersOf(fake, newQid), [["A1", "Eins"], ["A2", "Zwei"], ["A3", "Drei"]]);
});

// ---- 15: type change ----

test("[GEN-B] a type change L to ! (inactive) is a replacement: the new question has type ! and the same place", async () => {
  const { fake, sid, question } = await setup();
  const old = question("Q1");
  const codes = codesOf(fake, old.gid);
  const result = await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: old.qid });
    const desired = clone(read.spec);
    desired.type = "!";
    const preview = await updateQuestionOk(session, dry(sid, old.qid, desired));
    assert.equal(preview.mode, "replace");
    return updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(preview)));
  }, { fake });
  assert.equal(result.mode, "replace");
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const created = fake.questions.find((item) => item.qid === Number(result.question_id));
  assert.ok(created, `question_id ${String(result.question_id)} is not in the fake`);
  assert.equal(created.type, "!");
  assert.equal(created.title, "Q1");
  assert.deepEqual(codesOf(fake, old.gid), codes);
  assert.equal(mainQuestionsOf(fake, old.gid)[1]?.qid, created.qid);
});

// ---- 25: write scope ----

test("[GEN-B] under the write scope none the real run answers WRITE_SCOPE_INSUFFICIENT and sends no request", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  const read = await withSession((session) => readOk(session, { survey_id: sid, question_id: q1 }), { fake });
  const before = fake.requests.length;
  const error = await withSession(
    (session) => updateQuestionError(session, real(sid, q1, withExtraAnswer(read.spec), read.fingerprint, ALL_ACK)),
    { fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) },
  );
  assert.equal(error.code, "WRITE_SCOPE_INSUFFICIENT");
  assert.equal(fake.requests.length, before, "no request reached LimeSurvey");
});

// ---- 26: Ranking ----

/** A Ranking question R01 between Q1 (L) and Q3. */
const RANKING: Json = {
  survey: { title: "Ranking" },
  groups: [{
    title: "Gruppe",
    questions: [
      { code: "Q1", type: "L", text: "Wahl", answers: [{ code: "A1", text: "Eins" }, { code: "A2", text: "Zwei" }] },
      { code: "R01", type: "R", text: "Reihenfolge", answers: [{ code: "A", text: "Anton" }, { code: "B", text: "Berta" }] },
      { code: "Q3", type: "S", text: "Danach" },
    ],
  }],
};

const LONG_ENTRY: Json = { code: "LONGCODE1", text: { de: "Lang" }, assessment_value: 0, relevance: "Q1 == 'A1'" };

test("[GEN-B] LimeSurvey 7: a Ranking entry with a long code and a relevance is written as a subquestion by the replacement, and get_survey_spec gives the end state back", async () => {
  const { fake, sid, question } = await setup(RANKING, 7);
  const old = question("R01");
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: old.qid });
    const desired = clone(read.spec);
    desired.answers.push(clone(LONG_ENTRY));
    const preview = await updateQuestionOk(session, dry(sid, old.qid, desired));
    assert.equal(preview.mode, "replace");
    const result = await updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(preview)));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    const newQid = Number(result.question_id);
    const entries = fake.questions.filter((item) => item.parent_qid === newQid).sort((a, b) => a.question_order - b.question_order);
    assert.deepEqual(entries.map((item) => [item.title, item.type, item.scale_id, item.relevance]), [
      ["A", "R", 0, "1"],
      ["B", "R", 0, "1"],
      ["LONGCODE1", "R", 0, "Q1 == 'A1'"],
    ]);
    assert.deepEqual(fake.answers.filter((item) => item.qid === newQid), [], "the entries are no answer options");
    const after = await readOk(session, { survey_id: sid, question_id: newQid });
    assert.deepEqual(after.spec, desired, "get_survey_spec gives the end state back");
  }, { fake });
  assert.deepEqual(codesOf(fake, old.gid), ["Q1", "R01", "Q3"]);
});

test("[GEN-B] LimeSurvey 6: the same Ranking change answers SPEC_INVALID at answers[2] and writes nothing", async () => {
  const { fake, sid, question } = await setup(RANKING, 6);
  const old = question("R01");
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: old.qid });
    const desired = clone(read.spec);
    desired.answers.push(clone(LONG_ENTRY));
    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, old.qid, desired, read.fingerprint, ALL_ACK));
    const paths = errorPaths(error);
    assert.ok(paths.some((path) => /^answers\[2\]\.(code|relevance)$/.test(path)), `paths: ${paths.join(", ")}`);
    assert.deepEqual(writeMethodsSince(fake, before), []);
  }, { fake });
  assert.equal(question("R01").qid, old.qid);
});

// ---- 27: empty texts and default values ----

test("[GEN-B] an empty subquestion text in the end state is only a warning and is written; a default on an M question answers SPEC_INVALID without a write", async () => {
  const { fake, sid, question } = await setup();
  const q4 = question("Q4").qid;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q4 });
    const desired = clone(read.spec);
    desired.subquestions[0].text = { de: "" };
    const result = await updateQuestionOk(session, real(sid, q4, desired, read.fingerprint, ALL_ACK));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    const warnings = (result.warnings ?? []) as Json[];
    assert.ok(warnings.some((item) => String(item.path).startsWith("subquestions[0].text")), `warnings: ${JSON.stringify(result.warnings)}`);
    const qid = Number(result.question_id);
    const sq1 = fake.questions.find((item) => item.parent_qid === qid && item.title === "SQ1");
    assert.equal(sq1?.l10n.de?.question, "");

    const again = await readOk(session, { survey_id: sid, question_id: qid });
    const withDefault = clone(again.spec);
    withDefault.default = "Y";
    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, qid, withDefault, again.fingerprint, ALL_ACK));
    assert.ok(errorPaths(error).includes("default"), `paths: ${errorPaths(error).join(", ")}`);
    assert.deepEqual(writeMethodsSince(fake, before), []);
  }, { fake });
});

// ---- 28: a question built in the admin ----

const ADMIN_BUILT: SeedSurvey = {
  title: both("Oberfläche", "Surface"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      { code: "Q0", type: "S", text: both("Vorher", "Before") },
      {
        code: "Q1",
        type: "L",
        theme: "bootstrap_buttons",
        mandatory: "S",
        other: true,
        text: both("Wie zufrieden?\r\nBitte wählen", "How satisfied?\r\nPlease choose"),
        help: both("Hilfe&nbsp;Text", "Help"),
        answers: [
          { code: "0", text: both("schlecht", "bad"), assessment_value: 0 },
          { code: "1", text: both("mittel", "medium"), assessment_value: 1 },
          { code: "2", text: both("gut", "good"), assessment_value: 2 },
        ],
        attributes: [
          { name: "answer_order", value: "random" },
          { name: "hidden", value: "0" },
          { name: "button_size", value: "large" },
          { name: "plugin_hint", value: "Hinweis", language: "de" },
          { name: "plugin_hint", value: "Hint", language: "en" },
        ],
        defaults: [{ text: both("1", "1") }, { specialtype: "other", text: both("Sonstiges", "Other") }],
        script: both("var a = 1;\r\nvar b = 2;", "var c = 3;"),
      },
      { code: "Q2", type: "S", text: both("Nachher", "After") },
    ],
  }],
};

test("[GEN-B] a question built in the admin: its unchanged spec gives mode none; with one more answer it is replaced and reads back as the end state (theme, attributes, plugin attribute, defaults, script)", async () => {
  const fake = new FakeLimeSurvey({ generation: 7 });
  const { sid, gids, qids } = seedSurvey(fake, ADMIN_BUILT);
  const q1 = qids.Q1;
  const gid = gids[0];
  assert.ok(q1 !== undefined && gid !== undefined);
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    // The premise: what the admin built is in the spec.
    assert.equal(read.spec.question_theme_name, "bootstrap_buttons");
    assert.equal(read.spec.attributes.answer_order, "random");
    assert.equal(read.spec.attributes.button_size, "large");
    assert.deepEqual(read.spec.attributes.plugin_hint, both("Hinweis", "Hint"));
    assert.deepEqual(read.spec.default, both("1", "1"));
    assert.deepEqual(read.spec.default_other, both("Sonstiges", "Other"));
    assert.deepEqual(read.spec.script, both("var a = 1;\nvar b = 2;", "var c = 3;"));

    const before = fake.requests.length;
    const unchangedPreview = await updateQuestionOk(session, dry(sid, q1, read.spec));
    assert.equal(unchangedPreview.mode, "none", JSON.stringify(unchangedPreview.changes));
    assert.deepEqual(unchangedPreview.changes, []);
    const unchanged = await updateQuestionOk(session, real(sid, q1, read.spec, read.fingerprint));
    assert.equal(unchanged.mode, "none");
    assert.deepEqual(writeMethodsSince(fake, before), [], "an unchanged question is not written");

    const desired = clone(read.spec);
    desired.answers.push({ code: "3", text: both("sehr gut", "very good"), assessment_value: 3 });
    const preview = await updateQuestionOk(session, dry(sid, q1, desired));
    assert.equal(preview.mode, "replace");
    const result = await updateQuestionOk(session, real(sid, q1, desired, read.fingerprint, acknowledgeable(preview)));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification).slice(0, 2000));
    const after = await readOk(session, { survey_id: sid, question_id: Number(result.question_id) });
    assert.deepEqual(after.spec, desired, "every feature of the question is kept");
    assert.deepEqual(after.missing_translations, []);
  }, { fake });
  assert.deepEqual(codesOf(fake, gid), ["Q0", "Q1", "Q2"]);
});

// ---- 29: what RemoteControl cannot read ----

test("[GEN-B] the dry run of a replacement names what RemoteControl cannot read of the question (undefined_attributes) as a risk or in the plan", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1").qid;
  const preview = await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    return updateQuestionOk(session, dry(sid, q1, withExtraAnswer(read.spec)));
  }, { fake });
  assert.equal(preview.mode, "replace");
  const named = JSON.stringify({ risks: preview.risks ?? null, plan: preview.plan ?? null });
  assert.match(named, /undefined_attributes/, named);
});

// ---- live findings of PR5 (LimeSurvey 7.5.1 and 6.17.11) ----

/**
 * set_question_properties answers questionl10ns per language and field (7.5.1 RC:1991-2031): { de: { question: true,
 * help: true } } is a success; false for a language, the text "Empty question L10n data" or false for a field is not.
 * The existing texts tests (active survey, empty subquestion text) cover the success form.
 */
const TEXT_WRITE_FAILURES: Array<[label: string, prepare: (fake: FakeLimeSurvey) => void]> = [
  ["false for the language (the missing row could not be created)", (fake) => fake.failNext("set_question_properties", { questionl10ns: { de: false } })],
  ["the text \"Empty question L10n data\"", (fake) => fake.failNext("set_question_properties", { questionl10ns: { de: "Empty question L10n data" } })],
  // The write really runs (the question text is saved), but LimeSurvey reports the help text as not saved.
  ["false for one field (help) after the question text was saved", (fake) => outcomeAfterRun(fake, "set_question_properties", {
    kind: "result",
    result: { questionl10ns: { de: { question: true, help: false } } },
  })],
];

for (const [label, prepare] of TEXT_WRITE_FAILURES) {
  test(`[GEN-B] texts mode: set_question_properties answering ${label} is a failure: UPDATE_QUESTION_FAILED, the old texts are back`, async () => {
    const { fake, sid, question } = await setup();
    const q1 = question("Q1");
    fake.setActive(sid, true);
    const read = await withSession((session) => readOk(session, { survey_id: sid, question_id: q1.qid }), { fake });
    const desired = clone(read.spec);
    desired.text = { de: "Wahl, neu formuliert" };
    prepare(fake);
    const error = await withSession((session) => updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint)), { fake });
    assert.equal(error.code, "UPDATE_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
    assert.equal(error.details?.rolled_back, true, JSON.stringify(error.details));
    assert.deepEqual([q1.l10n.de?.question, q1.l10n.de?.help], ["Wahl", "Bitte wählen"], "the question keeps its texts");
  });
}

/** BASE with display_columns on Q1 (type L): an attribute of the theme listradio that list_dropdown (type !) does not have. */
function withDisplayColumns(): Json {
  const spec = clone(BASE);
  spec.groups[0].questions[1].attributes = { display_columns: 2 };
  return spec;
}

test("[GEN-B] a type change L to ! that keeps display_columns (type ! does not use it): dry run and real run answer SPEC_INVALID at attributes.display_columns and write nothing; without the attribute the replacement runs", async () => {
  const { fake, sid, question } = await setup(withDisplayColumns());
  const old = question("Q1");
  const codes = codesOf(fake, old.gid);
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: old.qid });
    assert.equal(read.spec.attributes.display_columns, "2", "the premise: the question has the attribute");
    const desired = clone(read.spec);
    desired.type = "!";
    const before = fake.requests.length;
    for (const args of [dry(sid, old.qid, desired), real(sid, old.qid, desired, read.fingerprint, ALL_ACK)]) {
      const error = await updateQuestionError(session, args);
      const paths = errorPaths(error);
      assert.ok(paths.includes("attributes.display_columns"), `dry_run ${String(args.dry_run === true)}: paths ${paths.join(", ")}`);
      const finding = (error.details?.errors as Json[]).find((item) => item.path === "attributes.display_columns");
      assert.match(String(finding?.fix), /display_columns/);
      assert.match(String(finding?.fix), /remove/i);
    }
    assert.deepEqual(writeMethodsSince(fake, before), [], "nothing is written");

    delete desired.attributes.display_columns;
    const preview = await updateQuestionOk(session, dry(sid, old.qid, desired));
    assert.equal(preview.mode, "replace");
    const result = await updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(preview)));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    assert.equal(fake.questions.find((item) => item.qid === Number(result.question_id))?.type, "!");
  }, { fake });
  assert.deepEqual(codesOf(fake, old.gid), codes);
});

test("[GEN-B] the spec check of every spec tool (validate_spec) refuses an attribute that the theme of the question does not use; plugin attributes, attributes of the extended theme and unknown themes stay allowed", async () => {
  const answers = [{ code: "A1", text: "Eins" }];
  await withSession(async (session) => {
    const refused: Array<[label: string, spec: Json, path: string]> = [
      ["display_columns on type ! (list_dropdown)", { code: "Q1", type: "!", text: "Wahl", answers, attributes: { display_columns: "2" } }, "attributes.display_columns"],
      ["button_size on type L without the theme bootstrap_buttons", { code: "Q1", type: "L", text: "Wahl", answers, attributes: { button_size: "large" } }, "attributes.button_size"],
    ];
    for (const [label, spec, path] of refused) {
      const result = await validateSpec(session, spec, { kind: "question" });
      assert.equal(result.valid, false, label);
      const finding = (result.errors as Json[]).find((item) => item.path === path);
      assert.ok(finding, `${label}: no error at ${path}; ${JSON.stringify(result.errors)}`);
      assert.ok(String(finding.fix).includes(path.split(".")[1] ?? ""), `${label}: the fix names the attribute: ${String(finding.fix)}`);
    }
    const allowed: Array<[label: string, spec: Json]> = [
      ["button_size with the theme bootstrap_buttons", { code: "Q1", type: "L", question_theme_name: "bootstrap_buttons", text: "Wahl", answers, attributes: { button_size: "large", answer_order: "random" } }],
      ["a plugin attribute (in no theme table)", { code: "Q1", type: "!", text: "Wahl", answers, attributes: { plugin_hint: "Hinweis" } }],
      ["display_columns with a theme the tables do not know", { code: "Q1", type: "!", question_theme_name: "my_custom_theme", text: "Wahl", answers, attributes: { display_columns: "2" } }],
    ];
    for (const [label, spec] of allowed) {
      const result = await validateSpec(session, spec, { kind: "question" });
      assert.equal(result.valid, true, `${label}: ${JSON.stringify(result.errors)}`);
    }
  });
});

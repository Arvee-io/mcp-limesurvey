import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type FakeGroup, type FakeQuestion, type Generation } from "./helpers/fake-limesurvey.js";
import { envConfig } from "./helpers/mcp-session.js";
import { groupsOf, importSpec, mainQuestionsOf, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import {
  addGroup,
  addGroupError,
  addGroupOk,
  addQuestion,
  addQuestionError,
  addQuestionOk,
  both,
  codesOf,
  requestsSince,
  toolResult,
} from "./helpers/add-tools.js";

/**
 * GEN-A and GEN-C, review of PR4: translation gaps need a confirmation (design 9.18 before 9.12), ties of group_order,
 * the fallbacks of the tie-break, generation 6 in the middle of a group or survey, lists cut to
 * LIMESURVEY_MAX_RESPONSE_CHARS and the recovery of a failed positioning.
 */

const BASE: Json = {
  survey: { title: "Basis" },
  groups: [
    { title: "Gruppe 1", questions: [{ code: "Q1", type: "S", text: "Eins" }, { code: "Q2", type: "S", text: "Zwei" }, { code: "Q3", type: "S", text: "Drei" }] },
    { title: "Gruppe 2", questions: [{ code: "Q4", type: "S", text: "Vier" }] },
  ],
};

const BILINGUAL: Json = {
  survey: { title: both("Basis", "Base"), language: "de", additional_languages: ["en"] },
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [{ code: "Q1", type: "S", text: both("Eins", "One") }, { code: "Q2", type: "S", text: both("Zwei", "Two") }],
  }],
};

const NEW_QUESTION: Json = { code: "N1", type: "S", text: both("Neu", "New") };
const NEW_GROUP: Json = { title: "Neue Gruppe", questions: [{ code: "N1", type: "S", text: "Neu" }] };
const ACK = ["fill_translation_gaps"];

const manyQuestions = (prefix: string, count: number): Json[] => Array.from({ length: count }, (_unused, index) => ({
  code: `${prefix}${String(index + 1).padStart(3, "0")}`,
  type: "S",
  text: `Frage ${index + 1}`,
}));

async function setup(spec: Json = BASE, generation: Generation = 7): Promise<{ fake: FakeLimeSurvey; sid: number; groups: FakeGroup[] }> {
  const fake = new FakeLimeSurvey({ generation });
  const sid = await importSpec(fake, spec);
  return { fake, sid, groups: groupsOf(fake, sid) };
}

const questionByCode = (fake: FakeLimeSurvey, sid: number, code: string): FakeQuestion => {
  const found = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === code);
  assert.ok(found, `no question ${code}`);
  return found;
};

/** The text row of a question or group in a language (a function, so a deleted row is read again, not narrowed). */
const questionRow = (question: FakeQuestion, language: string) => question.l10n[language];
const groupRow = (group: FakeGroup, language: string) => group.l10n[language];

const gapAt = (gaps: unknown, path: string): Json | undefined => ((gaps as Json[] | undefined) ?? []).find((item) => item.path === path);

const groupIds = (fake: FakeLimeSurvey, sid: number): number[] => groupsOf(fake, sid).map((item) => item.gid);

// ---- 3: translation gaps need a confirmation ----

/** BILINGUAL without the English rows of Q2 and of the group: four gaps the .lsq import would fill. */
async function withGaps(): Promise<{ fake: FakeLimeSurvey; sid: number; group: FakeGroup; q2: FakeQuestion }> {
  const { fake, sid, groups } = await setup(BILINGUAL);
  const group = groups[0];
  assert.ok(group);
  const q2 = questionByCode(fake, sid, "Q2");
  assert.ok(questionRow(q2, "en") && groupRow(group, "en"), "the import created the English rows first");
  delete q2.l10n.en;
  delete group.l10n.en;
  return { fake, sid, group, q2 };
}

test("[GEN-A] translation gaps without acknowledge: TRANSLATION_GAPS lists every gap with path, language and question_code/question_id or group_id, and writes nothing", async () => {
  const { fake, sid, group, q2 } = await withGaps();
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: group.gid, question: NEW_QUESTION }), { fake });
  assert.equal(error.code, "TRANSLATION_GAPS", JSON.stringify(error).slice(0, 1500));
  const gaps = error.details?.gaps;
  assert.deepEqual(gapAt(gaps, "groups[0].questions[1].text"), { path: "groups[0].questions[1].text", language: "en", question_code: "Q2", question_id: q2.qid });
  assert.deepEqual(gapAt(gaps, "groups[0].questions[1].help"), { path: "groups[0].questions[1].help", language: "en", question_code: "Q2", question_id: q2.qid });
  assert.deepEqual(gapAt(gaps, "groups[0].title"), { path: "groups[0].title", language: "en", group_id: group.gid });
  assert.equal(error.details?.gaps_total, 4);
  assert.equal(error.details?.truncated, false);
  const recovery = String(error.details?.recovery ?? "");
  assert.match(recovery, /limesurvey_update_survey_texts/);
  assert.match(recovery, /acknowledge/);
  assert.match(recovery, /fill_translation_gaps/);
  assert.deepEqual(writeMethodsSince(fake, before), [], "nothing is written");
  assert.equal(questionRow(q2, "en"), undefined, "the gap stays open");
  assert.equal(groupRow(group, "en"), undefined, "the gap stays open");
});

test("[GEN-A] TRANSLATION_GAPS keeps its gap list within LIMESURVEY_MAX_RESPONSE_CHARS (gaps_total, truncated)", async () => {
  const limit = 2500;
  const spec: Json = {
    survey: { title: both("Viele", "Many"), language: "de", additional_languages: ["en"] },
    groups: [{ title: both("Gruppe", "Group"), questions: manyQuestions("Q", 100).map((item) => ({ ...item, text: both(String(item.text), "Question") })) }],
  };
  const { fake, sid, groups } = await setup(spec);
  for (const question of fake.questions.filter((item) => item.sid === sid)) delete question.l10n.en;
  const group = groups[0];
  assert.ok(group);
  const response = await withSession(
    (session) => addQuestion(session, { survey_id: sid, group_id: group.gid, question: NEW_QUESTION }),
    { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) },
  );
  assert.equal(response.isError, true);
  const size = JSON.stringify(response.structuredContent).length;
  assert.ok(size <= limit, `the error has ${size} characters, the limit is ${limit}`);
  const error = toolResult(response);
  assert.equal(error.code, "TRANSLATION_GAPS");
  assert.equal(error.details?.gaps_total, 200);
  assert.equal(error.details?.truncated, true);
  const shown = error.details?.gaps as Json[];
  assert.ok(shown.length >= 1 && shown.length < 200, `${shown.length} gaps are shown`);
});

test("[GEN-A] with acknowledge the question is added; side_effects name each filled gap with question_code/question_id, paths as after the insertion", async () => {
  const { fake, sid, group, q2 } = await withGaps();
  const result = await withSession((session) => addQuestionOk(session, {
    survey_id: sid,
    group_id: group.gid,
    question: NEW_QUESTION,
    position: 1,
    acknowledge: ACK,
  }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  assert.deepEqual(codesOf(fake, group.gid), ["N1", "Q1", "Q2"]);
  const effect = (result.side_effects as Json[]).find((item) => item.kind === "translations_filled_from_base");
  assert.ok(effect, JSON.stringify(result.side_effects));
  // Q2 was questions[1] before; the new question at place 1 makes it questions[2].
  assert.deepEqual(gapAt(effect.gaps, "groups[0].questions[2].text"), { path: "groups[0].questions[2].text", language: "en", question_code: "Q2", question_id: q2.qid });
  assert.equal(gapAt(effect.gaps, "groups[0].questions[1].text"), undefined, "the paths refer to the survey after the insertion");
  assert.deepEqual(gapAt(effect.gaps, "groups[0].title"), { path: "groups[0].title", language: "en", group_id: group.gid });
  assert.equal(effect.gaps_total, 4);
  assert.equal(questionRow(q2, "en")?.question, "Zwei", "the import filled the gap with the base text");
});

test("[GEN-C] add_group_from_spec fills no translation gap (.lsg import): no error without acknowledge, no side effect, the gap stays", async () => {
  const { fake, sid, q2 } = await withGaps();
  const result = await withSession((session) => addGroupOk(session, {
    survey_id: sid,
    group: { title: both("Neu", "New"), questions: [{ code: "N1", type: "S", text: both("Neu", "New") }] },
  }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  assert.deepEqual(result.side_effects, []);
  assert.equal(questionRow(q2, "en"), undefined, "the gap stays open");
});

// ---- 4: ties and the fallbacks of the tie-break ----

test("[GEN-C] three groups that all have group_order 1: a group inserted after the first lands between the first and the second", async () => {
  const spec: Json = {
    survey: { title: "Gleichstand" },
    groups: [1, 2, 3].map((number) => ({ title: `Gruppe ${number}`, questions: [{ code: `Q${number}`, type: "S", text: `Frage ${number}` }] })),
  };
  const { fake, sid, groups } = await setup(spec);
  const [first, second, third] = groups;
  assert.ok(first && second && third);
  for (const group of groups) group.group_order = 1;
  const result = await withSession((session) => addGroupOk(session, { survey_id: sid, group: NEW_GROUP, position: { after: first.gid } }), { fake });
  assert.deepEqual(groupIds(fake, sid), [first.gid, result.group_id, second.gid, third.gid]);
  const orders = groupsOf(fake, sid).map((item) => item.group_order);
  assert.equal(new Set(orders).size, orders.length, `no two groups share a group_order: ${orders.join(", ")}`);
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
});

test("[GEN-A] when the code z x 20 is taken, the tie-break uses the code A with the successor, and the question still lands at its place", async () => {
  const spec: Json = {
    survey: { title: "Ausweichcode" },
    groups: [
      { title: "Gruppe 1", questions: ["A1", "B1", "C1"].map((code) => ({ code, type: "S", text: `Frage ${code}` })) },
      { title: "Gruppe 2", questions: [{ code: "z".repeat(20), type: "S", text: "Belegt" }] },
    ],
  };
  const { fake, sid, groups } = await setup(spec);
  const group = groups[0];
  assert.ok(group);
  const before = fake.requests.length;
  const result = await withSession((session) => addQuestionOk(session, {
    survey_id: sid,
    group_id: group.gid,
    question: { code: "N1", type: "S", text: "Neu" },
    position: { after: "A1" },
  }), { fake });
  assert.deepEqual(codesOf(fake, group.gid), ["A1", "N1", "B1", "C1"]);
  const titles = requestsSince(fake, before, "set_question_properties")
    .map((request) => (request.params[2] as Json | undefined)?.title)
    .filter((title) => title !== undefined);
  assert.deepEqual(titles, ["A", "N1"], "the temporary code is A, then the final code");
  assert.equal(questionByCode(fake, sid, "z".repeat(20)).title, "z".repeat(20), "the question with the code z x 20 is untouched");
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
});

test("[GEN-C] when the successor has no base-language name, the tie-break uses the predecessor's name + zz, and the group still lands at its place", async () => {
  const { fake, sid, groups } = await setup();
  const [first, second] = groups;
  assert.ok(first && second);
  const secondRow = groupRow(second, "de");
  assert.ok(secondRow);
  secondRow.group_name = "";
  const before = fake.requests.length;
  const result = await withSession((session) => addGroupOk(session, { survey_id: sid, group: NEW_GROUP, position: { after: first.gid } }), { fake });
  assert.deepEqual(groupIds(fake, sid), [first.gid, result.group_id, second.gid]);
  const names = requestsSince(fake, before, "set_group_properties")
    .map((request) => ((request.params[2] as Json | undefined)?.questiongroupl10ns as Json | undefined)?.de?.group_name)
    .filter((name) => name !== undefined);
  assert.deepEqual(names, ["Gruppe 1zz", "Neue Gruppe"], "the temporary name is the predecessor's name + zz, then the final name");
  assert.equal(fake.groups.find((item) => item.gid === result.group_id)?.l10n.de?.group_name, "Neue Gruppe");
  assert.equal(groupRow(second, "de")?.group_name, "", "the successor is untouched");
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
});

test("[GEN-A] generation 6: a question inserted in the middle of the group lands at its place", async () => {
  const { fake, sid, groups } = await setup(BASE, 6);
  const group = groups[0];
  assert.ok(group);
  const result = await withSession((session) => addQuestionOk(session, {
    survey_id: sid,
    group_id: group.gid,
    question: { code: "N1", type: "S", text: "Neu" },
    position: { after: "Q1" },
  }), { fake });
  assert.deepEqual(codesOf(fake, group.gid), ["Q1", "N1", "Q2", "Q3"]);
  assert.deepEqual(result.position, { index: 2 });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
});

test("[GEN-C] generation 6: a group inserted between two groups lands at its place", async () => {
  const { fake, sid, groups } = await setup(BASE, 6);
  const [first, second] = groups;
  assert.ok(first && second);
  const result = await withSession((session) => addGroupOk(session, { survey_id: sid, group: NEW_GROUP, position: { after: first.gid } }), { fake });
  assert.deepEqual(groupIds(fake, sid), [first.gid, result.group_id, second.gid]);
  assert.deepEqual(result.position, { index: 2 });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
});

// ---- 4: lists within LIMESURVEY_MAX_RESPONSE_CHARS ----

const MANY: Json = { survey: { title: "Viele" }, groups: [{ title: "Gruppe", questions: manyQuestions("Q", 300) }] };

test("[GEN-C] CODE_CONFLICT keeps its conflict list within LIMESURVEY_MAX_RESPONSE_CHARS (conflicts_total, truncated)", async () => {
  const limit = 3000;
  const { fake, sid } = await setup(MANY);
  const response = await withSession(
    (session) => addGroup(session, { survey_id: sid, group: { title: "Neu", questions: manyQuestions("Q", 300) } }),
    { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) },
  );
  assert.equal(response.isError, true);
  const size = JSON.stringify(response.structuredContent).length;
  assert.ok(size <= limit, `the error has ${size} characters, the limit is ${limit}`);
  const error = toolResult(response);
  assert.equal(error.code, "CODE_CONFLICT");
  assert.equal(error.details?.conflicts_total, 300);
  assert.equal(error.details?.truncated, true);
  const shown = error.details?.conflicts as Json[];
  assert.ok(shown.length >= 1 && shown.length < 300, `${shown.length} conflicts are shown`);
});

test("[GEN-A] POSITION_INVALID keeps the list of codes of the group within LIMESURVEY_MAX_RESPONSE_CHARS (codes_total, truncated)", async () => {
  const limit = 1500;
  const { fake, sid, groups } = await setup(MANY);
  const group = groups[0];
  assert.ok(group);
  const response = await withSession(
    (session) => addQuestion(session, { survey_id: sid, group_id: group.gid, question: { code: "N1", type: "S", text: "Neu" }, position: { after: "XYZ" } }),
    { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) },
  );
  assert.equal(response.isError, true);
  const size = JSON.stringify(response.structuredContent).length;
  assert.ok(size <= limit, `the error has ${size} characters, the limit is ${limit}`);
  const error = toolResult(response);
  assert.equal(error.code, "POSITION_INVALID");
  assert.equal(error.details?.codes_total, 300);
  assert.equal(error.details?.truncated, true);
});

test("[GEN-C] the questions list of add_group_from_spec stays within LIMESURVEY_MAX_RESPONSE_CHARS (questions_total, truncated)", async () => {
  const limit = 4000;
  const { fake, sid } = await setup();
  const response = await withSession(
    (session) => addGroup(session, { survey_id: sid, group: { title: "Neu", questions: manyQuestions("N", 300) } }),
    { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) },
  );
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 800));
  const size = JSON.stringify(response.structuredContent).length;
  assert.ok(size <= limit, `the result has ${size} characters, the limit is ${limit}`);
  const result = toolResult(response);
  assert.equal(result.verification?.ok, true);
  assert.equal(result.questions_total, 300);
  assert.equal(result.truncated, true);
  const shown = result.questions as Json[];
  assert.ok(shown.length >= 1 && shown.length < 300, `${shown.length} questions are shown`);
  assert.equal(mainQuestionsOf(fake, Number(result.group_id)).length, 300, "every question was created");
});

// ---- 4: the recovery of a failed positioning ----

const POSITION_FAILURES: Array<[label: string, answer: (field: string) => Json, cause: string, recovery: RegExp[]]> = [
  ["the field is not saved", (field) => ({ [field]: false }), "FIELD_SAVE_FAILED", [/position/i, /admin/i]],
  [
    "old conditions forbid the reordering",
    (field) => ({ [field]: field === "question_order" ? "Questions with dependencies - Order cannot be changed" : "Group with dependencies - Order cannot be changed" }),
    "POSITION_NOT_SET",
    [/condition/i, /position/i],
  ],
];

for (const [label, answer, cause, recovery] of POSITION_FAILURES) {
  test(`[GEN-A] when ${label} while positioning, ADD_QUESTION_FAILED names the cause ${cause} and a recovery that fits it`, async () => {
    const { fake, sid, groups } = await setup();
    const group = groups[0];
    assert.ok(group);
    fake.failNext("set_question_properties", answer("question_order"));
    const error = await withSession((session) => addQuestionError(session, {
      survey_id: sid,
      group_id: group.gid,
      question: { code: "N1", type: "S", text: "Neu" },
      position: 1,
    }), { fake });
    assert.equal(error.code, "ADD_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
    assert.equal(error.details?.failed_step, "position");
    assert.equal(error.details?.cause_code, cause);
    assert.equal(error.details?.rolled_back, true);
    for (const pattern of recovery) assert.match(String(error.details?.recovery ?? ""), pattern);
    assert.deepEqual(codesOf(fake, group.gid), ["Q1", "Q2", "Q3"], "the new question is gone again");
  });

  test(`[GEN-C] when ${label} while positioning, ADD_GROUP_FAILED names the cause ${cause} and a recovery that fits it`, async () => {
    const { fake, sid, groups } = await setup();
    fake.failNext("set_group_properties", answer("group_order"));
    const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP, position: 1 }), { fake });
    assert.equal(error.code, "ADD_GROUP_FAILED", JSON.stringify(error).slice(0, 1500));
    assert.equal(error.details?.failed_step, "position");
    assert.equal(error.details?.cause_code, cause);
    assert.equal(error.details?.rolled_back, true);
    for (const pattern of recovery) assert.match(String(error.details?.recovery ?? ""), pattern);
    assert.deepEqual(groupIds(fake, sid), groups.map((item) => item.gid), "the new group is gone again");
  });
}

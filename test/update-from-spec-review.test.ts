import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type FakeQuestion, type Generation } from "./helpers/fake-limesurvey.js";
import { envConfig } from "./helpers/mcp-session.js";
import { seedSurvey, type SeedSurvey } from "./helpers/seed-survey.js";
import { groupsOf, importSpec, readOk, validateSpec, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import {
  both,
  errorPaths,
  outcomeAfterRun,
  parseStructureFile,
  requestsSince,
  surveyOutline,
  toolResult,
} from "./helpers/add-tools.js";
import {
  acknowledgeable,
  ALL_ACK,
  clone,
  dropFirstAnswerFromNowOn,
  failAfter,
  failOnCall,
  failWhen,
  riskOf,
  transportFailureOnce,
  updateQuestionError,
  updateQuestionOk,
  updateTexts,
  updateTextsError,
} from "./helpers/update-tools.js";

/**
 * GEN-B and GEN-F, review of PR5: texts that cannot be read, a complete reference check, the question theme against the
 * type, the error and rollback paths of the replacement, the risks one by one, raw values of attributes and defaults,
 * the read-back after a rollback or a write, duplicate names and a missing base language in update_survey_texts, and the
 * size of risk locations and cleanup values.
 */

/** One language (de): group 1 with Q0, Q1 (L with A1, A2) and Q2; group 2 with Q4 (M with SQ1, SQ2). */
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

/** Two languages (de, en): Q0, Q1 (L with A1, A2) and Q2 (S with the language-dependent attribute prefix). */
const BILINGUAL: Json = {
  survey: { title: both("Basis", "Base"), language: "de", additional_languages: ["en"] },
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      { code: "Q0", type: "S", text: both("Vorher", "Before") },
      { code: "Q1", type: "L", text: both("Wahl", "Choice"), answers: [{ code: "A1", text: both("Eins", "One") }, { code: "A2", text: both("Zwei", "Two") }] },
      { code: "Q2", type: "S", text: both("Betrag", "Amount"), attributes: { prefix: both("€", "EUR") } },
    ],
  }],
};

/** Two languages (de, en) for update_survey_texts: Q1 (S) and Q2 (M with SQ1, SQ2). */
const TEXTS: Json = {
  survey: { title: both("Umfrage", "Survey"), language: "de", additional_languages: ["en"] },
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      { code: "Q1", type: "S", text: both("Frage eins", "Question one") },
      { code: "Q2", type: "M", text: both("Auswahl", "Choice"), subquestions: [{ code: "SQ1", text: both("Erste", "First") }, { code: "SQ2", text: both("Zweite", "Second") }] },
    ],
  }],
};

const EXTRA_ANSWER: Json = { code: "A3", text: { de: "Drei" }, assessment_value: 0 };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

async function setup(spec: Json = BASE, generation: Generation = 7) {
  const fake = new FakeLimeSurvey({ generation });
  const sid = await importSpec(fake, spec);
  const question = (code: string): FakeQuestion => {
    const found = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === code);
    assert.ok(found, `the survey has no question ${code}`);
    return found;
  };
  return { fake, sid, question };
}

const dry = (surveyId: number, questionId: number, question: Json): Json => ({ survey_id: surveyId, question_id: questionId, question, dry_run: true });

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

function withExtraAnswer(spec: Json): Json {
  const desired = clone(spec);
  desired.answers.push(clone(EXTRA_ANSWER));
  return desired;
}

/** A dry run of the end state that `change` makes from the spec of get_survey_spec; returns the read and the dry run. */
async function preview(fake: FakeLimeSurvey, sid: number, qid: number, change: (spec: Json) => void): Promise<{ read: Json; desired: Json; preview: Json }> {
  return withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: qid });
    const desired = clone(read.spec);
    change(desired);
    return { read, desired, preview: await updateQuestionOk(session, dry(sid, qid, desired)) };
  }, { fake });
}

const rename = (code: string) => (spec: Json): void => {
  spec.code = code;
};

// ================================================================ MAJOR 1: texts that cannot be read

test("[GEN-B] a question without a text row in en (its answer texts and a language-dependent attribute cannot be read there): the unchanged spec gives mode none and nothing is written", async () => {
  const { fake, sid, question } = await setup(BILINGUAL);
  for (const code of ["Q1", "Q2"]) delete question(code).l10n.en;
  await withSession(async (session) => {
    for (const code of ["Q1", "Q2"]) {
      const qid = question(code).qid;
      const read = await readOk(session, { survey_id: sid, question_id: qid });
      // The premise: get_survey_spec reports what it could not read in en.
      assert.ok((read.unreadable as Json[]).some((item) => item.language === "en" && typeof item.path === "string"), `${code}: ${JSON.stringify(read.unreadable)}`);
      const before = fake.requests.length;
      const shown = await updateQuestionOk(session, dry(sid, qid, read.spec));
      assert.equal(shown.mode, "none", `${code}: ${JSON.stringify(shown.changes)}`);
      assert.deepEqual(shown.changes, []);
      const result = await updateQuestionOk(session, real(sid, qid, read.spec, read.fingerprint));
      assert.equal(result.mode, "none");
      assert.deepEqual(writeMethodsSince(fake, before), [], `${code}: nothing is written`);
    }
  }, { fake });
});

test("[GEN-B] replacing a question whose answer texts cannot be read in en reports unreadable_texts (blocking, confirmed with fill_translation_gaps, locations with path and language); without it UPDATE_QUESTION_BLOCKED, with it the replacement runs", async () => {
  const { fake, sid, question } = await setup(BILINGUAL);
  const q1 = question("Q1");
  delete q1.l10n.en;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = clone(read.spec);
    desired.answers.push({ code: "A3", text: both("Drei", "Three"), assessment_value: 0 });
    const shown = await updateQuestionOk(session, dry(sid, q1.qid, desired));
    assert.equal(shown.mode, "replace");
    const risk = riskOf(shown.risks, "unreadable_texts");
    assert.ok(risk, JSON.stringify(shown.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, true);
    const locations = JSON.stringify(risk.locations);
    assert.match(locations, /answers\[0\]\.text/);
    assert.match(locations, /\ben\b/);

    const before = fake.requests.length;
    const blocked = await updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint, acknowledgeable(shown).filter((item) => item !== "fill_translation_gaps")));
    assert.equal(blocked.code, "UPDATE_QUESTION_BLOCKED", JSON.stringify(blocked).slice(0, 1500));
    assert.ok(riskOf(blocked.details?.risks, "unreadable_texts"), JSON.stringify(blocked.details));
    assert.deepEqual(writeMethodsSince(fake, before), []);

    const result = await updateQuestionOk(session, real(sid, q1.qid, desired, read.fingerprint, acknowledgeable(shown)));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  }, { fake });
});

// ================================================================ MAJOR 2: a complete reference check

const REFERENCES: Json = {
  survey: { title: "Referenzen" },
  groups: [{
    title: "Gruppe",
    questions: [
      { code: "Q1", type: "S", text: "Name" },
      { code: "Q2", type: "L", text: "Wahl", answers: [{ code: "A1", text: "Wie {Q1.shown}" }, { code: "A2", text: "Anders" }] },
      { code: "Q3", type: "S", text: "Mit Skript", script: "console.log('{Q1}');" },
      { code: "Q4", type: "S", text: "Mit Vorgabe", default: "{Q1.NAOK}" },
    ],
  }],
};

test("[GEN-B] renaming a code finds it in answer texts, scripts and default values of other questions (code_references)", async () => {
  const { fake, sid, question } = await setup(REFERENCES);
  const { preview: shown } = await preview(fake, sid, question("Q1").qid, rename("Q9"));
  const risk = riskOf(shown.risks, "code_references");
  assert.ok(risk, JSON.stringify(shown.risks));
  assert.equal(risk.blocking, true);
  assert.equal(risk.acknowledgeable, false);
  const locations = JSON.stringify(risk.locations);
  for (const code of ["Q2", "Q3", "Q4"]) assert.match(locations, new RegExp(code), `the locations name ${code}: ${locations}`);
});

test("[GEN-B] renaming a code also searches the question itself: a subquestion relevance that names its own code is a code reference", async () => {
  const spec: Json = {
    survey: { title: "Eigen" },
    groups: [{
      title: "Gruppe",
      questions: [
        { code: "Q1", type: "S", text: "Vorher" },
        { code: "Q4", type: "M", text: "Auswahl", subquestions: [{ code: "SQ1", text: "Eins" }, { code: "SQ2", text: "Zwei", relevance: "Q4_SQ1.NAOK == 'Y'" }] },
      ],
    }],
  };
  const { fake, sid, question } = await setup(spec);
  const { preview: shown } = await preview(fake, sid, question("Q4").qid, rename("Q5"));
  const risk = riskOf(shown.risks, "code_references");
  assert.ok(risk, JSON.stringify(shown.risks));
  assert.match(JSON.stringify(risk.locations), /SQ2/, "the location names the subquestion of the question itself");
});

/** A survey with the question under test (code Q3) and Q5, whose relevance names a field of Q3. */
const fieldSurvey = (question: Json, relevance: string): Json => ({
  survey: { title: "Felder" },
  groups: [{ title: "Gruppe", questions: [question, { code: "Q5", type: "S", text: "Danach", relevance }] }],
});

const REMOVED_FIELDS: Array<[label: string, spec: Json, change: (spec: Json) => void]> = [
  [
    "the comment field of a removed P subquestion (Q3_SQ2comment)",
    fieldSurvey({ code: "Q3", type: "P", text: "Mit Kommentar", subquestions: [{ code: "SQ1", text: "Eins" }, { code: "SQ2", text: "Zwei" }] }, "!is_empty(Q3_SQ2comment)"),
    (spec) => {
      spec.subquestions = (spec.subquestions as Json[]).filter((item) => item.code !== "SQ2");
    },
  ],
  [
    "the Other field of an L question that loses other (Q3_other)",
    fieldSurvey({ code: "Q3", type: "L", text: "Wahl", other: true, answers: [{ code: "A1", text: "Eins" }] }, "!is_empty(Q3_other)"),
    (spec) => {
      spec.other = false;
    },
  ],
  [
    "the Other comment of a P question that loses other (Q3_othercomment)",
    fieldSurvey({ code: "Q3", type: "P", text: "Mit Kommentar", other: true, subquestions: [{ code: "SQ1", text: "Eins" }] }, "!is_empty(Q3_othercomment)"),
    (spec) => {
      spec.other = false;
    },
  ],
];

for (const [label, spec, change] of REMOVED_FIELDS) {
  test(`[GEN-B] an end state that removes ${label} named elsewhere reports code_references (blocking, not acknowledgeable)`, async () => {
    const { fake, sid, question } = await setup(spec);
    const { preview: shown } = await preview(fake, sid, question("Q3").qid, change);
    const risk = riskOf(shown.risks, "code_references");
    assert.ok(risk, JSON.stringify(shown.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, false);
    assert.match(JSON.stringify(risk.locations), /Q5/);
  });
}

const FREE_TEXTS: Array<[label: string, text: string, found: boolean]> = [
  ["a plain mention of the code outside {...} is no reference", "Wie bei Q1 beschrieben", false],
  ["a mention inside {...} is one, also after a } inside a string of the expression", "Siehe {join(\"}\", Q1.shown)}", true],
];

for (const [label, text, found] of FREE_TEXTS) {
  test(`[GEN-B] free texts are searched inside EM expressions only: ${label}`, async () => {
    const spec: Json = { survey: { title: "Freitext" }, groups: [{ title: "Gruppe", questions: [{ code: "Q1", type: "S", text: "Name" }, { code: "Q2", type: "S", text }] }] };
    const { fake, sid, question } = await setup(spec);
    const { preview: shown } = await preview(fake, sid, question("Q1").qid, rename("Q9"));
    assert.equal(riskOf(shown.risks, "code_references") !== undefined, found, JSON.stringify(shown.risks));
  });
}

test("[GEN-B] a source that cannot be read for another reason than a missing text row stops the call before anything is written", async () => {
  const spec: Json = { survey: { title: "Lesefehler" }, groups: [{ title: "Gruppe", questions: [{ code: "Q1", type: "S", text: "Name" }, { code: "Q2", type: "S", text: "Danach" }] }] };
  const { fake, sid, question } = await setup(spec);
  const q1 = question("Q1");
  const q2 = question("Q2");
  failWhen(fake, "get_question_properties", (params) => Number(params[1]) === q2.qid, new Error("connection reset"));
  const before = fake.requests.length;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = clone(read.spec);
    desired.code = "Q9";
    await updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint, ALL_ACK));
  }, { fake });
  assert.deepEqual(writeMethodsSince(fake, before), [], "nothing is written");
  assert.equal(question("Q1").qid, q1.qid, "the code stays");
});

// ================================================================ MAJOR 3: question_theme_name against the type

test("[GEN-B] the spec check of every spec tool refuses a known question theme of another type at question_theme_name; the theme of the type and unknown themes stay allowed", async () => {
  const answers = [{ code: "A1", text: "Eins" }];
  await withSession(async (session) => {
    const refused = await validateSpec(session, { code: "Q1", type: "S", text: "Kurz", question_theme_name: "bootstrap_buttons" }, { kind: "question" });
    assert.equal(refused.valid, false);
    const finding = (refused.errors as Json[]).find((item) => item.path === "question_theme_name");
    assert.ok(finding, JSON.stringify(refused.errors));
    assert.ok(typeof finding.fix === "string" && finding.fix.length > 0);
    for (const spec of [
      { code: "Q1", type: "L", text: "Wahl", answers, question_theme_name: "bootstrap_buttons" },
      { code: "Q1", type: "S", text: "Kurz", question_theme_name: "my_custom_theme" },
    ]) {
      const result = await validateSpec(session, spec, { kind: "question" });
      assert.equal(result.valid, true, `${JSON.stringify(spec)}: ${JSON.stringify(result.errors)}`);
    }
  });
});

test("[GEN-B] the columns mode does not write a question theme of another type: SPEC_INVALID at question_theme_name, nothing written", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  const theme = q1.question_theme_name;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = clone(read.spec);
    desired.question_theme_name = "longfreetext";
    const before = fake.requests.length;
    const error = await updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint, ALL_ACK));
    assert.ok(errorPaths(error).includes("question_theme_name"), errorPaths(error).join(", "));
    assert.deepEqual(writeMethodsSince(fake, before), []);
  }, { fake });
  assert.equal(question("Q1").question_theme_name, theme);
});

// ================================================================ MAJOR 4: error and rollback paths of the replacement

const CODES: Array<[label: string, code: string | undefined]> = [["the same code", undefined], ["a new code (Q9)", "Q9"]];

/** The replacement end state: one more answer, and with `code` also a new code. */
const replacement = (code: string | undefined) => (spec: Json): void => {
  spec.answers.push(clone(EXTRA_ANSWER));
  if (code !== undefined) spec.code = code;
};

for (const [label, code] of CODES) {
  test(`[GEN-B] replacement with ${label}: delete_question of the old question answers ERR_DEPENDENCIES: rolled back, the old question keeps code and place, only the new one is deleted`, async () => {
    const { fake, sid, question } = await setup();
    const old = question("Q1");
    const outline = surveyOutline(fake, sid);
    const { read, desired, preview: shown } = await preview(fake, sid, old.qid, replacement(code));
    failWhen(fake, "delete_question", (params) => Number(params[1]) === old.qid, {
      status: "Cannot delete Question. Others rely on this question",
      error_code: "ERR_DEPENDENCIES",
    });
    const before = fake.requests.length;
    const error = await withSession((session) => updateQuestionError(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(shown))), { fake });
    assert.equal(error.code, "REPLACE_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
    assert.equal(error.details?.failed_step, "delete_old_question");
    assert.equal(error.details?.rolled_back, true, JSON.stringify(error.details));
    assert.deepEqual(error.details?.manual_cleanup, []);
    const deletes = requestsSince(fake, before, "delete_question").map((request) => Number(request.params[1]));
    assert.equal(deletes.length, 2, JSON.stringify(deletes));
    assert.equal(deletes[0], old.qid, "the old question is attempted");
    assert.notEqual(deletes[1], old.qid, "the rollback deletes only the new question");
    assert.deepEqual(surveyOutline(fake, sid), outline, "the old question keeps its code and place");
  });

  test(`[GEN-B] replacement with ${label}: delete_question deletes the old question but the answer is lost: the tool looks, and the replacement is reported as done`, async () => {
    const { fake, sid, question } = await setup();
    const old = question("Q1");
    const { read, desired, preview: shown } = await preview(fake, sid, old.qid, replacement(code));
    outcomeAfterRun(fake, "delete_question", { kind: "transport" });
    const before = fake.requests.length;
    const result = await withSession((session) => updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(shown))), { fake });
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    assert.ok(!fake.questions.some((item) => item.qid === old.qid), "the old question is gone");
    assert.deepEqual(requestsSince(fake, before, "delete_question").map((request) => Number(request.params[1])), [old.qid], "the new question is never deleted");
    assert.ok(fake.questions.some((item) => item.qid === Number(result.question_id)));
  });

  test(`[GEN-B] replacement with ${label}: import_question fails in transport and no candidate exists: created unknown, candidates [], nothing deleted, the old question keeps its code`, async () => {
    const { fake, sid, question } = await setup();
    const old = question("Q1");
    const outline = surveyOutline(fake, sid);
    const { read, desired, preview: shown } = await preview(fake, sid, old.qid, replacement(code));
    transportFailureOnce(fake, "import_question");
    const before = fake.requests.length;
    const error = await withSession((session) => updateQuestionError(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(shown))), { fake });
    assert.equal(error.code, "REPLACE_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
    assert.equal(error.details?.created, "unknown");
    assert.deepEqual(error.details?.candidates, []);
    assert.deepEqual(requestsSince(fake, before, "delete_question"), [], "nothing is deleted");
    assert.deepEqual(surveyOutline(fake, sid), outline, "the old question keeps its code");
  });

  test(`[GEN-B] replacement with ${label}: positioning the new question fails: rolled back, only the new question is deleted`, async () => {
    const { fake, sid, question } = await setup();
    const old = question("Q1");
    const outline = surveyOutline(fake, sid);
    const { read, desired, preview: shown } = await preview(fake, sid, old.qid, replacement(code));
    failWhen(fake, "set_question_properties", (params) => isRecord(params[2]) && "question_order" in params[2], { question_order: false });
    const before = fake.requests.length;
    const error = await withSession((session) => updateQuestionError(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(shown))), { fake });
    assert.equal(error.code, "REPLACE_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
    assert.equal(error.details?.failed_step, "position");
    assert.equal(error.details?.rolled_back, true, JSON.stringify(error.details));
    const deletes = requestsSince(fake, before, "delete_question").map((request) => Number(request.params[1]));
    assert.equal(deletes.length, 1, JSON.stringify(deletes));
    assert.notEqual(deletes[0], old.qid);
    assert.deepEqual(surveyOutline(fake, sid), outline);
  });
}

test("[GEN-B] when giving the old question its code back fails in the rollback, manual_cleanup names the question, the temporary code and the code to restore", async () => {
  const { fake, sid, question } = await setup();
  const old = question("Q1");
  const { read, desired, preview: shown } = await preview(fake, sid, old.qid, replacement(undefined));
  dropFirstAnswerFromNowOn(fake);
  failWhen(fake, "set_question_properties", (params) => Number(params[1]) === old.qid && isRecord(params[2]) && params[2].title === "Q1", { title: false });
  const error = await withSession((session) => updateQuestionError(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(shown))), { fake });
  assert.equal(error.code, "REPLACE_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
  assert.equal(error.details?.rolled_back, false);
  const cleanup = (error.details?.manual_cleanup as Json[]).find((item) => item.question_id === old.qid);
  assert.ok(cleanup, JSON.stringify(error.details?.manual_cleanup));
  assert.equal(cleanup.expected_code, "Q1");
  assert.ok(typeof cleanup.temporary_code === "string" && cleanup.temporary_code.length > 0, JSON.stringify(cleanup));
  // The premise: the old question still has the temporary code the manual cleanup names.
  assert.equal(fake.questions.find((item) => item.qid === old.qid)?.title, cleanup.temporary_code);
});

// ---- the risks one by one ----

test("[GEN-B] a relevance that names the old question by its ID (Q{qid}, LimeSurvey 7) reports sgqa_references (blocking, not acknowledgeable)", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  question("Q2").relevance = `Q${q1.qid}.NAOK == 'A1'`;
  const { preview: shown } = await preview(fake, sid, q1.qid, replacement(undefined));
  const risk = riskOf(shown.risks, "sgqa_references");
  assert.ok(risk, JSON.stringify(shown.risks));
  assert.equal(risk.blocking, true);
  assert.equal(risk.acknowledgeable, false);
  assert.match(JSON.stringify(risk.locations), /Q2/);
});

const ANSWER_REFERENCES: string[] = ["Q1 == 'A2'", "Q1 == \"A2\""];

for (const relevance of ANSWER_REFERENCES) {
  test(`[GEN-B] removing an answer code that an expression compares with (${relevance}) reports answer_code_references (acknowledgeable)`, async () => {
    const { fake, sid, question } = await setup();
    question("Q2").relevance = relevance;
    const { preview: shown } = await preview(fake, sid, question("Q1").qid, (spec) => {
      spec.answers = (spec.answers as Json[]).filter((item) => item.code !== "A2");
    });
    const risk = riskOf(shown.risks, "answer_code_references");
    assert.ok(risk, JSON.stringify(shown.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, true);
  });
}

test("[GEN-B] replacing an M question with other reports other_default (blocking, acknowledgeable)", async () => {
  const spec = clone(BASE);
  spec.groups[1].questions[0].other = true;
  const { fake, sid, question } = await setup(spec);
  const { preview: shown } = await preview(fake, sid, question("Q4").qid, (desired) => {
    desired.subquestions.push({ code: "SQ3", text: { de: "Drei" } });
  });
  const risk = riskOf(shown.risks, "other_default");
  assert.ok(risk, JSON.stringify(shown.risks));
  assert.equal(risk.blocking, true);
  assert.equal(risk.acknowledgeable, true);
});

test("[GEN-B] a translation gap of another question reports translation_gaps for a replacement: blocked without fill_translation_gaps, done with it", async () => {
  const { fake, sid, question } = await setup(BILINGUAL);
  delete question("Q0").l10n.en;
  const q1 = question("Q1");
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1.qid });
    const desired = clone(read.spec);
    desired.answers.push({ code: "A3", text: both("Drei", "Three"), assessment_value: 0 });
    const shown = await updateQuestionOk(session, dry(sid, q1.qid, desired));
    const risk = riskOf(shown.risks, "translation_gaps");
    assert.ok(risk, JSON.stringify(shown.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, true);
    assert.match(JSON.stringify(risk.locations), /questions\[0\]/);
    const blocked = await updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint, acknowledgeable(shown).filter((item) => item !== "fill_translation_gaps")));
    assert.equal(blocked.code, "UPDATE_QUESTION_BLOCKED");
    const result = await updateQuestionOk(session, real(sid, q1.qid, desired, read.fingerprint, acknowledgeable(shown)));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  }, { fake });
});

// ================================================================ MINOR

const NUMERIC: Json = {
  survey: { title: "Zahlen" },
  groups: [{
    title: "Gruppe",
    questions: [
      { code: "Q1", type: "L", text: "Note", answers: [{ code: "1", text: "eins" }, { code: "2", text: "zwei" }, { code: "3", text: "drei" }] },
      { code: "Q2", type: "S", text: "Danach" },
    ],
  }],
};

for (const relevance of ["Q1 == 3", "Q1.code == 3"]) {
  test(`[GEN-B] an answer code compared without quotes (${relevance}) counts for answer_code_references when the end state removes it`, async () => {
    const { fake, sid, question } = await setup(NUMERIC);
    question("Q2").relevance = relevance;
    const { preview: shown } = await preview(fake, sid, question("Q1").qid, (spec) => {
      spec.answers = (spec.answers as Json[]).filter((item) => item.code !== "3");
    });
    const risk = riskOf(shown.risks, "answer_code_references");
    assert.ok(risk, JSON.stringify(shown.risks));
    assert.equal(risk.acknowledgeable, true);
  });
}

test("[GEN-B] LimeSurvey 6: Q{qid} names no question there (no sgqa_references), {sid}X{gid}X{qid} does", async () => {
  const plain = await setup(BASE, 6);
  const q1 = plain.question("Q1");
  plain.question("Q2").relevance = `Q${q1.qid}.NAOK == 'A1'`;
  const first = await preview(plain.fake, plain.sid, q1.qid, replacement(undefined));
  assert.equal(riskOf(first.preview.risks, "sgqa_references"), undefined, JSON.stringify(first.preview.risks));

  const sgqa = await setup(BASE, 6);
  const other = sgqa.question("Q1");
  sgqa.question("Q2").relevance = `${sgqa.sid}X${other.gid}X${other.qid}.NAOK == 'A1'`;
  const second = await preview(sgqa.fake, sgqa.sid, other.qid, replacement(undefined));
  assert.ok(riskOf(second.preview.risks, "sgqa_references"), JSON.stringify(second.preview.risks));
});

test("[GEN-B] when Q{qid} is also the code of a question of the survey, a mention is only a hint in the plan, not a blocking risk", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  const lookalike = `Q${q1.qid}`;
  question("Q2").title = lookalike;
  question("Q0").relevance = `${lookalike}.NAOK != ''`;
  const { preview: shown } = await preview(fake, sid, q1.qid, replacement(undefined));
  assert.ok(!(shown.risks as Json[]).some((item) => item.code === "sgqa_references" && item.blocking === true), JSON.stringify(shown.risks));
  assert.match(JSON.stringify(shown.plan), new RegExp(lookalike), JSON.stringify(shown.plan));
});

const RAW_VALUES: SeedSurvey = {
  title: both("Roh", "Raw"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [{
      code: "Q1",
      type: "S",
      text: both("Betrag", "Amount"),
      attributes: [
        { name: "prefix", value: "&euro;", language: "de" },
        { name: "prefix", value: "&euro;", language: "en" },
        { name: "maximum_chars", value: "20" },
      ],
      defaults: [{ text: both("5&nbsp;&euro;", "5&nbsp;&euro;") }],
    }],
  }],
};

test("[GEN-B] the replacement writes unchanged attribute values (also language-dependent ones) and default values as LimeSurvey stores them", async () => {
  const fake = new FakeLimeSurvey({ generation: 7 });
  const { sid, qids } = seedSurvey(fake, RAW_VALUES);
  const q1 = qids.Q1;
  assert.ok(q1 !== undefined);
  let before = 0;
  await withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: q1 });
    // The premise: the spec has the decoded values.
    assert.deepEqual(read.spec.attributes.prefix, both("€", "€"));
    const desired = clone(read.spec);
    desired.attributes.maximum_chars = "30";
    const shown = await updateQuestionOk(session, dry(sid, q1, desired));
    assert.equal(shown.mode, "replace");
    before = fake.requests.length;
    const result = await updateQuestionOk(session, real(sid, q1, desired, read.fingerprint, acknowledgeable(shown)));
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  }, { fake });
  const request = requestsSince(fake, before, "import_question")[0];
  assert.ok(request, "import_question was sent");
  const file = parseStructureFile(request.params[3]);
  const prefixes = (file.sections.question_attributes ?? []).filter((row) => row.attribute === "prefix").map((row) => [row.language, row.value]);
  assert.deepEqual(prefixes.sort(), [["de", "&euro;"], ["en", "&euro;"]], "the unchanged attribute keeps its stored value");
  assert.deepEqual((file.sections.question_attributes ?? []).find((row) => row.attribute === "maximum_chars")?.value, "30");
  const defaults = (file.sections.defaultvalue_l10ns ?? []).map((row) => row.defaultvalue);
  assert.ok(defaults.length > 0 && defaults.every((value) => value === "5&nbsp;&euro;"), JSON.stringify(defaults));
});

test("[GEN-B] texts mode: when writing the old texts back does not restore them, rolled_back is false and manual_cleanup carries the old values per language and field", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  fake.setActive(sid, true);
  const read = await withSession((session) => readOk(session, { survey_id: sid, question_id: q1.qid }), { fake });
  const desired = clone(read.spec);
  desired.text = { de: "Wahl, neu formuliert" };
  // The write runs but reports help as not saved; the undo answers success without running.
  outcomeAfterRun(fake, "set_question_properties", { kind: "result", result: { questionl10ns: { de: { question: true, help: false } } } });
  failOnCall(fake, "set_question_properties", 2, { questionl10ns: { de: { question: true, help: true } } });
  const error = await withSession((session) => updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint)), { fake });
  assert.equal(error.code, "UPDATE_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
  assert.equal(error.details?.rolled_back, false, JSON.stringify(error.details));
  const cleanup = JSON.stringify(error.details?.manual_cleanup);
  assert.match(cleanup, /Wahl/, "the old text is named");
  assert.match(cleanup, /\bde\b/, "with its language");
  assert.equal(q1.l10n.de?.question, "Wahl, neu formuliert", "the premise: the old text is not back");
});

test("[GEN-B] when only the read-back after a successful write fails, the error says written: true and how to check", async () => {
  const { fake, sid, question } = await setup();
  const q1 = question("Q1");
  fake.setActive(sid, true);
  const read = await withSession((session) => readOk(session, { survey_id: sid, question_id: q1.qid }), { fake });
  const desired = clone(read.spec);
  desired.text = { de: "Wahl, neu formuliert" };
  failAfter(fake, "set_question_properties", "get_question_properties", new Error("connection reset"));
  const error = await withSession((session) => updateQuestionError(session, real(sid, q1.qid, desired, read.fingerprint)), { fake });
  assert.equal(error.details?.written, true, JSON.stringify(error).slice(0, 1500));
  assert.ok(typeof error.details?.recovery === "string" && error.details.recovery.length > 0, JSON.stringify(error.details));
  assert.equal(q1.l10n.de?.question, "Wahl, neu formuliert", "the premise: the text was written");
});

test("[GEN-F] when only the read-back after a successful write fails, the error says written: true and how to check", async () => {
  const { fake, sid } = await setup(TEXTS);
  failAfter(fake, "set_language_properties", "get_language_properties", new Error("connection reset"));
  const error = await withSession((session) => updateTextsError(session, { survey_id: sid, texts: { survey: { title: { de: "Umfrage neu" } } } }), { fake });
  assert.equal(error.details?.written, true, JSON.stringify(error).slice(0, 1500));
  assert.ok(typeof error.details?.recovery === "string" && error.details.recovery.length > 0, JSON.stringify(error.details));
  assert.equal(fake.surveys.find((item) => item.sid === sid)?.languagesettings.de?.surveyls_title, "Umfrage neu", "the premise: the title was written");
});

test("[GEN-F] a subquestion, question or group named twice answers SPEC_INVALID and nothing is written", async () => {
  const { fake, sid } = await setup(TEXTS);
  const group = groupsOf(fake, sid)[0];
  assert.ok(group);
  const cases: Array<[texts: Json, path: string]> = [
    [{ questions: [{ code: "Q2", subquestions: [{ code: "SQ1", text: "a" }, { code: "SQ1", text: "b" }] }] }, "questions[0].subquestions[1].code"],
    [{ questions: [{ code: "Q1", text: "a" }, { code: "Q1", text: "b" }] }, "questions[1].code"],
    [{ groups: [{ group_id: group.gid, title: "a" }, { group_id: group.gid, title: "b" }] }, "groups[1].group_id"],
  ];
  const before = fake.requests.length;
  await withSession(async (session) => {
    for (const [texts, path] of cases) {
      const error = await updateTextsError(session, { survey_id: sid, texts });
      assert.ok(errorPaths(error).includes(path), `${path}: ${errorPaths(error).join(", ")}`);
    }
  }, { fake });
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

test("[GEN-F] without a base language in the survey properties the tool guesses none: UNEXPECTED_RESPONSE with a recovery, nothing written", async () => {
  const { fake, sid } = await setup(TEXTS);
  fake.failNext("get_survey_properties", { additional_languages: "en", active: "N" });
  const before = fake.requests.length;
  const error = await withSession((session) => updateTextsError(session, { survey_id: sid, texts: { survey: { title: "Neu" } } }), { fake });
  assert.equal(error.code, "UNEXPECTED_RESPONSE", JSON.stringify(error).slice(0, 1500));
  assert.ok(typeof error.details?.recovery === "string" && error.details.recovery.length > 0, JSON.stringify(error.details));
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

test("[GEN-B] the locations of a risk are cut to stay within LIMESURVEY_MAX_RESPONSE_CHARS (locations_total)", async () => {
  const limit = 2500;
  const spec: Json = {
    survey: { title: "Viele" },
    groups: [{
      title: "Gruppe",
      questions: [
        { code: "Q1", type: "S", text: "Name" },
        ...Array.from({ length: 150 }, (_unused, index) => ({ code: `R${String(index + 1).padStart(3, "0")}`, type: "S", text: `Frage ${index + 1}`, relevance: "Q1.NAOK != ''" })),
      ],
    }],
  };
  const { fake, sid, question } = await setup(spec);
  const q1 = question("Q1");
  const read = await withSession((session) => readOk(session, { survey_id: sid, question_id: q1.qid }), { fake });
  const desired = clone(read.spec);
  desired.code = "Q9";
  const response = await withSession(
    (session) => session.client.callTool({ name: "limesurvey_update_question_from_spec", arguments: dry(sid, q1.qid, desired) }),
    { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) },
  );
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 800));
  const size = JSON.stringify(response.structuredContent).length;
  assert.ok(size <= limit, `the result has ${size} characters, the limit is ${limit}`);
  const risk = riskOf(toolResult(response).risks, "code_references");
  assert.ok(risk, "the risk is kept, its locations are cut");
  assert.equal(risk.locations_total, 150);
  assert.ok(Array.isArray(risk.locations) && risk.locations.length < 150, `${String(risk.locations?.length)} locations are shown`);
});

test("[GEN-F] the values of manual_cleanup are cut to stay within LIMESURVEY_MAX_RESPONSE_CHARS", async () => {
  const limit = 3000;
  const { fake, sid } = await setup(TEXTS);
  const q1 = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "Q1");
  const row = q1?.l10n.en;
  assert.ok(row);
  row.question = "x".repeat(4000);
  failOnCall(fake, "set_question_properties", 1, { status: "Error: write failed", error_code: "ERR_UPDATE_FAILED" });
  failOnCall(fake, "set_question_properties", 2, { status: "Error: undo failed", error_code: "ERR_UPDATE_FAILED" });
  const response = await withSession(
    (session) => updateTexts(session, { survey_id: sid, texts: { questions: [{ code: "Q1", text: { en: "kurz" } }] } }),
    { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) },
  );
  assert.equal(response.isError, true);
  const size = JSON.stringify(response.structuredContent).length;
  assert.ok(size <= limit, `the error has ${size} characters, the limit is ${limit}`);
  const error = toolResult(response);
  assert.equal(error.code, "TEXT_UPDATE_FAILED");
  assert.equal(error.details?.rolled_back, false);
  assert.ok(Array.isArray(error.details?.manual_cleanup) && error.details.manual_cleanup.length > 0, JSON.stringify(error.details).slice(0, 500));
});

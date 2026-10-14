import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type FakeQuestion, type Generation } from "./helpers/fake-limesurvey.js";
import { seedSurvey, type SeedSurvey } from "./helpers/seed-survey.js";
import { createOk, importSpec, readOk, validateSpec, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import { both } from "./helpers/add-tools.js";
import { acknowledgeable, ALL_ACK, clone, riskOf, updateQuestionError, updateQuestionOk } from "./helpers/update-tools.js";

/**
 * GEN-TYPES, review of PR6: references by {sid}X{gid}X{qid} to fields whose subquestion code starts with a digit
 * (LimeSurvey 6), the replacement of a type 1 question, answer code references per scale, references to the rows of type
 * 1, and the code and scale_id of an entry in changes and verification differences.
 *
 * Field names (research-gen-types.md section 2): LimeSurvey 6 names a field {sid}X{gid}X{qid}{sq} (arrays, M, Q, K),
 * {sid}X{gid}X{qid}{row}_{column} (: and ;), {sid}X{gid}X{qid}{sq}#0 and #1 (type 1) and {sid}X{gid}X{qid}{sq}comment (P),
 * common_helper.php 6.17.11:1532-1916. Expressions name the two scales of type 1 as CODE_SQ_0 and CODE_SQ_1.
 */

const GENERATIONS: readonly Generation[] = [6, 7];

/** Type 1: rows SQ001 and SQ002; answers A1, A2 on scale 0 and A1, A2, A3 on scale 1; both headers per language. */
const DUAL: Json = {
  code: "T1",
  type: "1",
  text: both("Wie wichtig ist Ihnen das, und wie zufrieden sind Sie damit?", "How important is it to you, and how satisfied are you?"),
  subquestions: [{ code: "SQ001", text: both("Preis", "Price") }, { code: "SQ002", text: both("Beratung", "Advice") }],
  answers: [
    { code: "A1", text: both("unwichtig", "unimportant"), assessment_value: 1 },
    { code: "A2", text: both("wichtig", "important"), assessment_value: 2 },
    { code: "A1", text: both("unzufrieden", "dissatisfied"), assessment_value: 1, scale_id: 1 },
    { code: "A2", text: both("teils/teils", "partly"), assessment_value: 2, scale_id: 1 },
    { code: "A3", text: both("zufrieden", "satisfied"), assessment_value: 3, scale_id: 1 },
  ],
  attributes: { dualscale_headerA: both("Wichtigkeit", "Importance"), dualscale_headerB: both("Zufriedenheit", "Satisfaction") },
};

/** Type ":": rows SQ001, SQ002 (scale 0) and columns SQ001, SQ002 (scale 1). */
const NUMBERS: Json = {
  code: "T2",
  type: ":",
  text: both("Wie viele Stunden arbeiten Sie?", "How many hours do you work?"),
  subquestions: [
    { code: "SQ001", text: both("Montag", "Monday") },
    { code: "SQ002", text: both("Dienstag", "Tuesday") },
    { code: "SQ001", text: both("vormittags", "mornings"), scale_id: 1 },
    { code: "SQ002", text: both("nachmittags", "afternoons"), scale_id: 1 },
  ],
};

/** Two languages (de, en): the questions, then Q9 (S), whose relevance the tests set. */
function surveyWith(questions: Json[], q9Relevance?: string): Json {
  return clone({
    survey: { title: both("Matrizen", "Arrays"), language: "de", additional_languages: ["en"] },
    groups: [{
      title: both("Gruppe", "Group"),
      questions: [
        ...questions,
        { code: "Q9", type: "S", text: both("Nachher", "After"), ...(q9Relevance !== undefined ? { relevance: q9Relevance } : {}) },
      ],
    }],
  });
}

async function setup(spec: Json, generation: Generation) {
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

/** A dry run of the end state that `change` makes from the spec of get_survey_spec. */
async function preview(fake: FakeLimeSurvey, sid: number, qid: number, change: (spec: Json) => void): Promise<Json> {
  return withSession(async (session) => {
    const read = await readOk(session, { survey_id: sid, question_id: qid });
    const desired = clone(read.spec);
    change(desired);
    return updateQuestionOk(session, dry(sid, qid, desired));
  }, { fake });
}

const withoutItem = (list: "subquestions" | "answers", code: string, scale: number) => (spec: Json): void => {
  spec[list] = (spec[list] as Json[]).filter((item) => !(item.code === code && (item.scale_id ?? 0) === scale));
};

// ================================================================ MAJOR: {sid}X{gid}X{qid} before a code that starts with a digit

const DIGIT_CODES: Array<[label: string, question: Json, field: string, change: (spec: Json) => void]> = [
  [
    "an M question with the subquestion 1 (field <sgqa>1)",
    { code: "M1", type: "M", text: both("Auswahl", "Choice"), subquestions: [{ code: "1", text: both("Eins", "One") }, { code: "2", text: both("Zwei", "Two") }] },
    "1 == \"Y\"",
    (spec) => spec.subquestions.push({ code: "3", text: both("Drei", "Three") }),
  ],
  [
    "a : question with the row 1 and the column 2 (field <sgqa>1_2)",
    {
      code: "T2",
      type: ":",
      text: both("Zahlen", "Numbers"),
      subquestions: [
        { code: "1", text: both("Zeile 1", "Row 1") },
        { code: "2", text: both("Zeile 2", "Row 2") },
        { code: "1", text: both("Spalte 1", "Column 1"), scale_id: 1 },
        { code: "2", text: both("Spalte 2", "Column 2"), scale_id: 1 },
      ],
    },
    "1_2 > 3",
    (spec) => spec.subquestions.push({ code: "3", text: both("Spalte 3", "Column 3"), scale_id: 1 }),
  ],
  [
    "a 1 question with the row 001 (field <sgqa>001#0)",
    { ...clone(DUAL), subquestions: [{ code: "001", text: both("Preis", "Price") }, { code: "002", text: both("Beratung", "Advice") }] },
    "001#0 == \"A1\"",
    (spec) => spec.answers.push({ code: "A4", text: both("sehr zufrieden", "very satisfied"), assessment_value: 4, scale_id: 1 }),
  ],
  [
    "a P question with the subquestion 1 (field <sgqa>1comment)",
    { code: "P1", type: "P", text: both("Mit Kommentar", "With comment"), subquestions: [{ code: "1", text: both("Eins", "One") }, { code: "2", text: both("Zwei", "Two") }] },
    "1comment != ''",
    (spec) => spec.subquestions.push({ code: "3", text: both("Drei", "Three") }),
  ],
];

for (const [label, target, field, change] of DIGIT_CODES) {
  test(`[GEN-TYPES] generation 6: a relevance that names a field of ${label} by {sid}X{gid}X{qid} reports sgqa_references for a replacement, and the real run writes nothing`, async () => {
    const { fake, sid, question } = await setup(surveyWith([target]), 6);
    const old = question(String(target.code));
    question("Q9").relevance = `${sid}X${old.gid}X${old.qid}${field}`;
    await withSession(async (session) => {
      const read = await readOk(session, { survey_id: sid, question_id: old.qid });
      const desired = clone(read.spec);
      change(desired);
      const shown = await updateQuestionOk(session, dry(sid, old.qid, desired));
      assert.equal(shown.mode, "replace", JSON.stringify(shown.changes));
      const risk = riskOf(shown.risks, "sgqa_references");
      assert.ok(risk, `relevance ${question("Q9").relevance}: ${JSON.stringify(shown.risks)}`);
      assert.equal(risk.blocking, true);
      assert.equal(risk.acknowledgeable, false);
      assert.match(JSON.stringify(risk.locations), /Q9/);

      const before = fake.requests.length;
      const error = await updateQuestionError(session, real(sid, old.qid, desired, read.fingerprint, ALL_ACK));
      assert.equal(error.code, "UPDATE_QUESTION_BLOCKED", JSON.stringify(error).slice(0, 1500));
      assert.ok(riskOf(error.details?.risks, "sgqa_references"), JSON.stringify(error.details));
      assert.deepEqual(writeMethodsSince(fake, before), [], "nothing is written");
    }, { fake });
    assert.equal(question(String(target.code)).qid, old.qid, "the question keeps its ID");
  });
}

// ================================================================ MINOR: replacing a type 1 question

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: replacing a 1 question with one more answer on scale 1 (with an assessment value) and a new dualscale_headerB per language verifies, and get_survey_spec gives exactly the end state`, async () => {
    const { fake, sid, question } = await setup(surveyWith([DUAL]), generation);
    const old = question("T1");
    await withSession(async (session) => {
      const read = await readOk(session, { survey_id: sid, question_id: old.qid });
      const desired = clone(read.spec);
      desired.answers.push({ code: "A4", text: both("sehr zufrieden", "very satisfied"), assessment_value: 4, scale_id: 1 });
      desired.attributes.dualscale_headerB = both("Zufriedenheit heute", "Satisfaction today");
      const shown = await updateQuestionOk(session, dry(sid, old.qid, desired));
      assert.equal(shown.mode, "replace", JSON.stringify(shown.changes));
      const result = await updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(shown)));
      assert.equal(result.mode, "replace");
      assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
      const newQid = Number(result.question_id);
      const after = await readOk(session, { survey_id: sid, question_id: newQid });
      assert.deepEqual(after.spec, desired, "nothing of the end state is lost");

      const added = fake.answers.find((item) => item.qid === newQid && item.code === "A4");
      assert.deepEqual([added?.scale_id, added?.assessment_value, added?.l10n.en], [1, 4, "very satisfied"]);
      const headers = fake.attributes
        .filter((item) => item.qid === newQid && item.attribute === "dualscale_headerB")
        .map((item) => [item.language, item.value])
        .sort();
      assert.deepEqual(headers, [["de", "Zufriedenheit heute"], ["en", "Satisfaction today"]]);
    }, { fake });
  });
}

/** A type 1 question built in the admin: answer codes 0..n-1 on each scale (PHP answers lists), headers per language. */
const SURFACE_DUAL: SeedSurvey = {
  title: both("Oberfläche", "Admin"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      { code: "Q0", type: "S", text: both("Vorher", "Before") },
      {
        code: "T1",
        type: "1",
        text: both("Zwei Skalen", "Two scales"),
        subquestions: [{ code: "SQ001", text: both("Preis", "Price") }, { code: "SQ002", text: both("Beratung", "Advice") }],
        answers: [
          { code: "0", text: both("unwichtig", "unimportant"), scale_id: 0 },
          { code: "1", text: both("wichtig", "important"), scale_id: 0, assessment_value: 1 },
          { code: "0", text: both("unzufrieden", "dissatisfied"), scale_id: 1 },
          { code: "1", text: both("teils/teils", "partly"), scale_id: 1, assessment_value: 1 },
          { code: "2", text: both("zufrieden", "satisfied"), scale_id: 1, assessment_value: 2 },
        ],
        attributes: [
          { name: "dualscale_headerA", value: "Wichtigkeit", language: "de" },
          { name: "dualscale_headerA", value: "Importance", language: "en" },
          { name: "dualscale_headerB", value: "Zufriedenheit", language: "de" },
          { name: "dualscale_headerB", value: "Satisfaction", language: "en" },
          { name: "use_dropdown", value: "1" },
        ],
      },
    ],
  }],
};

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: the unchanged spec of a 1 question built in the admin gives mode none, and the real run writes nothing`, async () => {
    const fake = new FakeLimeSurvey({ generation });
    const { sid, qids } = seedSurvey(fake, SURFACE_DUAL);
    const qid = qids.T1;
    assert.ok(qid !== undefined);
    await withSession(async (session) => {
      const read = await readOk(session, { survey_id: sid, question_id: qid });
      const before = fake.requests.length;
      const shown = await updateQuestionOk(session, dry(sid, qid, read.spec));
      assert.equal(shown.mode, "none", JSON.stringify(shown.changes));
      assert.deepEqual(shown.changes, []);
      const result = await updateQuestionOk(session, real(sid, qid, read.spec, read.fingerprint));
      assert.equal(result.mode, "none");
      assert.deepEqual(writeMethodsSince(fake, before), [], "nothing is written");
    }, { fake });
  });
}

// ================================================================ MINOR: answer code references per scale

const ANSWER_SCALE_CASES: Array<[relevance: string, found: boolean]> = [
  ["T1_SQ001_0 == \"A1\"", false],
  ["T1_SQ001_1 == \"A1\"", true],
];

for (const [relevance, found] of ANSWER_SCALE_CASES) {
  test(`[GEN-TYPES] removing the answer A1 of scale 1 of a 1 question ${found ? "reports" : "does not report"} answer_code_references for ${relevance}${found ? ", and the detail names the scale" : " (scale 0 keeps A1)"}`, async () => {
    const { fake, sid, question } = await setup(surveyWith([DUAL], relevance), 7);
    const shown = await preview(fake, sid, question("T1").qid, withoutItem("answers", "A1", 1));
    assert.equal(shown.mode, "replace");
    const risk = riskOf(shown.risks, "answer_code_references");
    if (!found) {
      assert.equal(risk, undefined, JSON.stringify(shown.risks));
      return;
    }
    assert.ok(risk, JSON.stringify(shown.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, true);
    assert.match(JSON.stringify(risk.locations), /Q9/);
    assert.match(String(risk.detail), /scale 1/, `the detail names the scale: ${String(risk.detail)}`);
  });
}

// ================================================================ MINOR: the rows of type 1, a ; question without a row

for (const relevance of ["T1_SQ001_0 == \"A1\"", "T1_SQ001_1 == \"A1\""]) {
  test(`[GEN-TYPES] removing the row SQ001 of a 1 question reports code_references (blocking, not acknowledgeable) for ${relevance}`, async () => {
    const { fake, sid, question } = await setup(surveyWith([DUAL], relevance), 7);
    const shown = await preview(fake, sid, question("T1").qid, withoutItem("subquestions", "SQ001", 0));
    const risk = riskOf(shown.risks, "code_references");
    assert.ok(risk, JSON.stringify(shown.risks));
    assert.equal(risk.blocking, true);
    assert.equal(risk.acknowledgeable, false);
    assert.match(JSON.stringify(risk.locations), /Q9/);
  });
}

test("[GEN-TYPES] validate_spec reports a ; question without a row (no subquestion on scale 0) at subquestions, naming the scale", async () => {
  const spec: Json = {
    code: "T3",
    type: ";",
    text: "Kontakte",
    subquestions: [{ code: "C1", text: "Name", scale_id: 1 }, { code: "C2", text: "Telefon", scale_id: 1 }],
  };
  await withSession(async (session) => {
    const result = await validateSpec(session, spec, { kind: "question" });
    assert.equal(result.valid, false);
    const found = (result.errors as Array<{ path: string; message: string; fix: string }>).find((item) => item.path === "subquestions");
    assert.ok(found, JSON.stringify(result.errors));
    assert.match(`${found.message} ${found.fix}`, /scale 0/);
  });
});

// ================================================================ MINOR: code and scale_id in changes and differences

/** The entry with this path; it must name the code, and the scale_id exactly when the entry is on scale 1. */
function assertEntry(list: Json[], path: string | RegExp, code: string, scale: number | undefined): void {
  const entry = list.find((item) => (typeof path === "string" ? item.path === path : path.test(String(item.path))));
  assert.ok(entry, `no entry at ${String(path)}: ${JSON.stringify(list.map((item) => item.path))}`);
  assert.equal(entry.code, code, `${String(path)}: code of the entry: ${JSON.stringify(entry)}`);
  if (scale === undefined) assert.ok(!Object.hasOwn(entry, "scale_id"), `${String(path)}: no scale_id on scale 0: ${JSON.stringify(entry)}`);
  else assert.equal(entry.scale_id, scale, `${String(path)}: scale_id of the entry: ${JSON.stringify(entry)}`);
}

test("[GEN-TYPES] the changes of a dry run name the code of a subquestion or answer, and its scale_id when it is on scale 1", async () => {
  const { fake, sid, question } = await setup(surveyWith([DUAL, NUMBERS]), 7);
  const columns = await preview(fake, sid, question("T2").qid, (spec) => {
    const subs = spec.subquestions as Json[];
    const row = subs.find((item) => item.code === "SQ001" && item.scale_id === undefined);
    const column = subs.find((item) => item.code === "SQ001" && item.scale_id === 1);
    assert.ok(row && column);
    row.text = both("Montag neu", "Monday new");
    column.text = both("vormittags neu", "mornings new");
  });
  const subChanges = columns.changes as Json[];
  assertEntry(subChanges, "subquestions[0].text.de", "SQ001", undefined);
  assertEntry(subChanges, "subquestions[2].text.de", "SQ001", 1);
  assertEntry(subChanges, "subquestions[2].text.en", "SQ001", 1);

  const answers = await preview(fake, sid, question("T1").qid, (spec) => {
    const answer = (spec.answers as Json[]).find((item) => item.code === "A1" && item.scale_id === 1);
    assert.ok(answer);
    answer.text = both("gar nicht zufrieden", "not satisfied at all");
  });
  assertEntry(answers.changes as Json[], "answers[2].text.de", "A1", 1);
});

test("[GEN-TYPES] the verification differences of create_survey_from_spec name the code of a subquestion or answer, and its scale_id when it is on scale 1", async () => {
  const fake = new FakeLimeSurvey({ generation: 7 });
  // After the import a row and a column with the same code (T2) and an answer of scale 1 (T1) get another text.
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  target.fetch = async (input, init) => {
    const response = await original(input, init);
    if ((JSON.parse(String(init?.body)) as { method?: unknown }).method === "import_survey") {
      const main = (code: string): FakeQuestion | undefined => fake.questions.find((item) => item.parent_qid === 0 && item.title === code);
      const t1 = main("T1");
      const t2 = main("T2");
      for (const sub of fake.questions.filter((item) => item.parent_qid === t2?.qid && item.title === "SQ001")) {
        if (sub.l10n.de) sub.l10n.de.question = "geändert";
      }
      const answer = fake.answers.find((item) => item.qid === t1?.qid && item.code === "A1" && item.scale_id === 1);
      if (answer) answer.l10n.de = "geändert";
    }
    return response;
  };
  await withSession(async (session) => {
    const created = await createOk(session, surveyWith([DUAL, NUMBERS]));
    assert.equal(created.verification?.ok, false, "the changed texts are differences");
    const differences = created.verification.differences as Json[];
    assertEntry(differences, "groups[0].questions[1].subquestions[0].text.de", "SQ001", undefined);
    assertEntry(differences, "groups[0].questions[1].subquestions[2].text.de", "SQ001", 1);
    assertEntry(differences, "groups[0].questions[0].answers[2].text.de", "A1", 1);
  }, { fake });
});

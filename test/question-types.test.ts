import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { generateQuestionLsq, generateSurveyLss } from "../src/spec-generate.js";
import { FakeLimeSurvey, type FakeQuestion, type Generation } from "./helpers/fake-limesurvey.js";
import { seedSurvey, type SeedSurvey } from "./helpers/seed-survey.js";
import { createOk, groupsOf, importSpec, mainQuestionsOf, readOk, validateSpec, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import {
  ADD_GROUP,
  ADD_QUESTION,
  addGroupOk,
  addQuestionError,
  addQuestionOk,
  both,
  captureResults,
  codesOf,
  errorPaths,
  parseStructureFile,
  requestsSince,
  type StructureFile,
} from "./helpers/add-tools.js";
import {
  acknowledgeable,
  clone,
  riskOf,
  UPDATE_QUESTION,
  UPDATE_TEXTS,
  updateQuestionOk,
  updateTextsError,
  updateTextsOk,
} from "./helpers/update-tools.js";

/**
 * GEN-TYPES: the question types 1 (array dual scale), : (array numbers) and ; (array texts) in every spec tool, then all
 * 29 core types. Rules (research-gen-types.md, sections 2 and 4, "Konsequenzen für den Generator" 2, 3, 5 and 6):
 *
 * - 1: subquestions on scale 0 only (at least one), answers on scale 0 and on scale 1 (at least one each), answer codes
 *   unique per scale; base theme arrays/dualscale; dualscale_headerA and dualscale_headerB are stored per language.
 * - : and ;: subquestions on scale 0 (rows, Y) and on scale 1 (columns, X), at least one each, no answers; subquestion
 *   codes unique per scale (the same code on both scales is allowed); base themes arrays/multiflexi and arrays/texts.
 * - scale_id (0 or 1) only there: on the answers of 1 and the subquestions of : and ;. A default is not evaluated for
 *   these types (neither on the question nor on a subquestion).
 *
 * Decision for the output of get_survey_spec: scale_id is stated only when it is 1; scale 0 is the default and stays out,
 * as for every other type (the reader and the normal form already work this way). A spec may give scale_id 0; the normal
 * form drops it. The tests below hold the round trip to that form.
 */

const GENERATIONS: readonly Generation[] = [6, 7];

/** Type 1: rows on scale 0, answers on both scales (the codes A1 and A2 on both, which is allowed). */
const T1: Json = {
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
  // A map per language and one string for every language.
  attributes: { dualscale_headerA: both("Wichtigkeit", "Importance"), dualscale_headerB: "Zufriedenheit / Satisfaction" },
};

/** Type ":": the codes SQ001 and SQ002 are rows (scale 0) and columns (scale 1). */
const T2: Json = {
  code: "T2",
  type: ":",
  text: both("Wie viele Stunden arbeiten Sie?", "How many hours do you work?"),
  subquestions: [
    { code: "SQ001", text: both("Montag", "Monday") },
    { code: "SQ002", text: both("Dienstag", "Tuesday") },
    { code: "SQ001", text: both("vormittags", "mornings"), scale_id: 1 },
    { code: "SQ002", text: both("nachmittags", "afternoons"), scale_id: 1 },
  ],
  attributes: { multiflexible_max: "12" },
};

/** Type ";": rows R1, R2 (scale 0) and columns C1, C2 (scale 1). */
const T3: Json = {
  code: "T3",
  type: ";",
  text: both("Wer ist Ihr Ansprechpartner?", "Who is your contact person?"),
  subquestions: [
    { code: "R1", text: both("Vertrieb", "Sales") },
    { code: "R2", text: both("Technik", "Engineering") },
    { code: "C1", text: both("Name", "Name"), scale_id: 1 },
    { code: "C2", text: both("Telefon", "Phone"), scale_id: 1 },
  ],
  attributes: { placeholder: both("bitte eintragen", "please enter") },
};

/** Two languages (de, en): Q0, T1, T2, T3 and Q9 in one group. */
function typesSurvey(): Json {
  return clone({
    survey: { title: both("Matrizen", "Arrays"), language: "de", additional_languages: ["en"] },
    groups: [{
      title: both("Gruppe", "Group"),
      questions: [
        { code: "Q0", type: "S", text: both("Vorher", "Before") },
        T1,
        T2,
        T3,
        { code: "Q9", type: "S", text: both("Nachher", "After") },
      ],
    }],
  });
}

/** Two languages (de, en), types of version 1 only: one group with Q1 and Q2, the target of the add tools. */
const ADD_BASE: Json = {
  survey: { title: both("Basis", "Base"), language: "de", additional_languages: ["en"] },
  groups: [{ title: both("Gruppe", "Group"), questions: [{ code: "Q1", type: "S", text: both("Eins", "One") }, { code: "Q2", type: "S", text: both("Zwei", "Two") }] }],
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** scale_id of each item, "none" where the item has no such key. */
const scalesOf = (items: Json[]): Array<number | "none"> => items.map((item) => (Object.hasOwn(item, "scale_id") ? item.scale_id : "none"));

/** The subquestions of a question in the fake: [code, scale_id], by scale and order. */
const subsOf = (fake: FakeLimeSurvey, qid: number): Array<[string, number]> => fake.questions
  .filter((item) => item.parent_qid === qid)
  .sort((a, b) => a.scale_id - b.scale_id || a.question_order - b.question_order)
  .map((item) => [item.title, item.scale_id]);

/** The answers of a question in the fake: [code, scale_id], by scale and order. */
const answersOf = (fake: FakeLimeSurvey, qid: number): Array<[string, number]> => fake.answers
  .filter((item) => item.qid === qid)
  .sort((a, b) => a.scale_id - b.scale_id || a.sortorder - b.sortorder)
  .map((item) => [item.code, item.scale_id]);

function subIn(fake: FakeLimeSurvey, parent: number, code: string, scale: number): FakeQuestion {
  const found = fake.questions.find((item) => item.parent_qid === parent && item.title === code && item.scale_id === scale);
  assert.ok(found, `question ${parent} has no subquestion ${code} on scale ${scale}`);
  return found;
}

/** The questions of a survey-level spec, by code. */
const questionsByCode = (spec: Json): Map<string, Json> => new Map(
  (spec.groups as Json[]).flatMap((group) => group.questions as Json[]).map((question): [string, Json] => [String(question.code), question]),
);

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

/** A copy of a question spec with one list replaced. */
function withList(question: Json, key: "subquestions" | "answers", change: (items: Json[]) => Json[]): Json {
  const copy = clone(question);
  copy[key] = change(clone((question[key] ?? []) as Json[]));
  return copy;
}

// ================================================================ 1: validate_spec

test("[GEN-TYPES] validate_spec accepts valid questions of the types 1, : and ; (the same code on both scales, scale_id 0 given or left out) and the survey that holds them", async () => {
  const explicitRows = withList(T3, "subquestions", (items) => items.map((item) => ({ ...item, scale_id: item.scale_id ?? 0 })));
  await withSession(async (session) => {
    for (const question of [T1, T2, T3, explicitRows]) {
      const result = await validateSpec(session, question, { kind: "question" });
      assert.equal(result.valid, true, `${String(question.code)} (${String(question.type)}): ${JSON.stringify(result.errors)}`);
      assert.deepEqual(result.errors, []);
    }
    const survey = await validateSpec(session, typesSurvey());
    assert.equal(survey.valid, true, JSON.stringify(survey.errors));
  });
});

const SIMPLE_F: Json = {
  code: "F1",
  type: "F",
  text: "Matrix",
  subquestions: [{ code: "SQ001", text: "Zeile" }, { code: "SQ002", text: "Zeile 2" }],
  answers: [{ code: "A1", text: "Ja" }, { code: "A2", text: "Nein" }],
};

/** [label, question spec, path of the error, what message or fix must name]. */
const INVALID: Array<[label: string, spec: Json, path: string, about?: RegExp]> = [
  ["type 1 without an answer on scale 1", withList(T1, "answers", (items) => items.filter((item) => item.scale_id !== 1)), "answers", /scale/i],
  ["type 1 without an answer on scale 0", withList(T1, "answers", (items) => items.filter((item) => item.scale_id === 1)), "answers", /scale/i],
  ["type 1 without subquestions", withList(T1, "subquestions", () => []), "subquestions"],
  [
    "type 1 with a subquestion on scale 1",
    withList(T1, "subquestions", (items) => [...items, { code: "SQ003", text: both("Spalte", "Column"), scale_id: 1 }]),
    "subquestions[2].scale_id",
  ],
  ["type : without a column (no subquestion on scale 1)", withList(T2, "subquestions", (items) => items.filter((item) => item.scale_id !== 1)), "subquestions", /scale/i],
  ["type : without a row (no subquestion on scale 0)", withList(T2, "subquestions", (items) => items.filter((item) => item.scale_id === 1)), "subquestions", /scale/i],
  ["type ; without a column (no subquestion on scale 1)", withList(T3, "subquestions", (items) => items.filter((item) => item.scale_id !== 1)), "subquestions", /scale/i],
  ["type : with answers", withList(T2, "answers", () => [{ code: "A1", text: "Eins" }]), "answers"],
  ["type ; with answers", withList(T3, "answers", () => [{ code: "A1", text: "Eins" }]), "answers"],
  ["type : with scale_id 2", withList(T2, "subquestions", (items) => items.map((item, index) => (index === 3 ? { ...item, scale_id: 2 } : item))), "subquestions[3].scale_id"],
  [
    "type : with the code SQ001 twice on scale 1",
    withList(T2, "subquestions", (items) => [...items, { code: "SQ001", text: both("abends", "evenings"), scale_id: 1 }]),
    "subquestions[4].code",
  ],
  [
    "type 1 with the answer code A1 twice on scale 1",
    withList(T1, "answers", (items) => [...items, { code: "A1", text: both("doppelt", "twice"), scale_id: 1 }]),
    "answers[5].code",
  ],
  ["type F with scale_id 1 on a subquestion", withList(SIMPLE_F, "subquestions", (items) => items.map((item, index) => (index === 1 ? { ...item, scale_id: 1 } : item))), "subquestions[1].scale_id", /\bF\b/],
  ["type F with scale_id 1 on an answer", withList(SIMPLE_F, "answers", (items) => items.map((item, index) => (index === 1 ? { ...item, scale_id: 1 } : item))), "answers[1].scale_id", /\bF\b/],
  [
    "type M with scale_id 1 on a subquestion",
    { code: "M1", type: "M", text: "Auswahl", subquestions: [{ code: "SQ001", text: "Eins", scale_id: 1 }] },
    "subquestions[0].scale_id",
    /\bM\b/,
  ],
  [
    "type L with scale_id 1 on an answer",
    { code: "L1", type: "L", text: "Wahl", answers: [{ code: "A1", text: "Eins", scale_id: 1 }] },
    "answers[0].scale_id",
    /\bL\b/,
  ],
  ["a default on a subquestion of type 1", withList(T1, "subquestions", (items) => items.map((item, index) => (index === 0 ? { ...item, default: "A1" } : item))), "subquestions[0].default"],
  ["a default on a subquestion of type :", withList(T2, "subquestions", (items) => items.map((item, index) => (index === 0 ? { ...item, default: "3" } : item))), "subquestions[0].default"],
  ["a default on a subquestion of type ;", withList(T3, "subquestions", (items) => items.map((item, index) => (index === 0 ? { ...item, default: "x" } : item))), "subquestions[0].default"],
  ["a default on the question of type 1", { ...clone(T1), default: "A1" }, "default"],
  ["a default on the question of type :", { ...clone(T2), default: "3" }, "default"],
  ["a default on the question of type ;", { ...clone(T3), default: "x" }, "default"],
];

for (const [label, spec, path, about] of INVALID) {
  test(`[GEN-TYPES] validate_spec reports ${label} at ${path}, with a fix (the type itself is accepted)`, async () => {
    await withSession(async (session) => {
      const result = await validateSpec(session, spec, { kind: "question" });
      assert.equal(result.valid, false, `${label}: the spec must be invalid`);
      const errors = result.errors as Array<{ path: string; message: string; fix: string }>;
      assert.ok(!errors.some((item) => item.path === "type"), `the type ${String(spec.type)} is accepted: ${JSON.stringify(errors)}`);
      const found = errors.find((item) => item.path === path);
      assert.ok(found, `no error at ${path}; errors: ${JSON.stringify(errors)}`);
      assert.ok(found.message.trim().length > 0 && found.fix.trim().length > 0, `message and fix: ${JSON.stringify(found)}`);
      if (about !== undefined) assert.match(`${found.message} ${found.fix}`, about, `the error explains itself: ${JSON.stringify(found)}`);
    });
  });
}

// ================================================================ 12: attribute and theme tables

test("[GEN-TYPES] the attribute and theme tables hold for 1, : and ;: an attribute of another theme or the theme of another type is the only error; their own attributes and themes are valid", async () => {
  const withoutAttributes = (question: Json): Json => {
    const copy = clone(question);
    delete copy.attributes;
    return copy;
  };
  const refused: Array<[label: string, spec: Json, path: string]> = [
    ["dualscale_headerA on type :", { ...withoutAttributes(T2), attributes: { dualscale_headerA: "Kopf" } }, "attributes.dualscale_headerA"],
    ["multiflexible_max on type ;", { ...withoutAttributes(T3), attributes: { multiflexible_max: "10" } }, "attributes.multiflexible_max"],
    ["placeholder on type 1", { ...withoutAttributes(T1), attributes: { placeholder: "x" } }, "attributes.placeholder"],
    ["the theme arrays/dualscale on type :", { ...withoutAttributes(T2), question_theme_name: "arrays/dualscale" }, "question_theme_name"],
    ["the theme arrays/multiflexi on type 1", { ...withoutAttributes(T1), question_theme_name: "arrays/multiflexi" }, "question_theme_name"],
  ];
  const allowed: Array<[label: string, spec: Json]> = [
    ["dualscale_headerA and dualscale_headerB on type 1", T1],
    ["multiflexible_max and the base theme named on type :", { ...clone(T2), question_theme_name: "arrays/multiflexi" }],
    ["placeholder and the base theme named on type ;", { ...clone(T3), question_theme_name: "arrays/texts" }],
  ];
  await withSession(async (session) => {
    for (const [label, spec, path] of refused) {
      const result = await validateSpec(session, spec, { kind: "question" });
      assert.equal(result.valid, false, label);
      assert.deepEqual((result.errors as Json[]).map((item) => item.path), [path], `${label}: ${JSON.stringify(result.errors)}`);
    }
    for (const [label, spec] of allowed) {
      const result = await validateSpec(session, spec, { kind: "question" });
      assert.equal(result.valid, true, `${label}: ${JSON.stringify(result.errors)}`);
    }
  });
});

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: add_question_from_spec with dualscale_headerA on a : question answers SPEC_INVALID at the attribute alone and writes nothing`, async () => {
    const { fake, sid } = await setup(ADD_BASE, generation);
    const gid = groupsOf(fake, sid)[0]?.gid;
    assert.ok(gid !== undefined);
    const question = { ...clone(T2), attributes: { dualscale_headerA: "Kopf" } };
    const before = fake.requests.length;
    const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid, question }), { fake });
    assert.deepEqual(errorPaths(error), ["attributes.dualscale_headerA"]);
    assert.deepEqual(writeMethodsSince(fake, before), []);
  });
}

// ================================================================ 2: the generator

/** The rows of a section that belong to one question: subquestions by parent_qid, the others by qid. */
function rowsFor(file: StructureFile, section: string, qid: string | undefined): Array<Record<string, string>> {
  return (file.sections[section] ?? []).filter((row) => (section === "subquestions" ? row.parent_qid : row.qid) === qid);
}

function questionRow(file: StructureFile, code: string): Record<string, string> {
  const row = (file.sections.questions ?? []).find((item) => item.title === code);
  assert.ok(row, `the file has no question ${code}`);
  return row;
}

/** [code, scale_id, order within the scale] of the subquestions and answers of the three questions. */
const EXPECTED_ROWS: Record<string, { subquestions: string[][]; answers: string[][] }> = {
  T1: {
    subquestions: [["SQ001", "0", "0"], ["SQ002", "0", "1"]],
    answers: [["A1", "0", "0"], ["A2", "0", "1"], ["A1", "1", "0"], ["A2", "1", "1"], ["A3", "1", "2"]],
  },
  T2: {
    subquestions: [["SQ001", "0", "0"], ["SQ002", "0", "1"], ["SQ001", "1", "0"], ["SQ002", "1", "1"]],
    answers: [],
  },
  T3: {
    subquestions: [["R1", "0", "0"], ["R2", "0", "1"], ["C1", "1", "0"], ["C2", "1", "1"]],
    answers: [],
  },
};

/**
 * The new types name their base theme in the file (research, Konsequenz 6). LimeSurvey would also fill an empty
 * question_theme_name with it (Question.php:1544-1570), which is why the version 1 types keep the empty column of the
 * Python generator (parity).
 */
const BASE_THEMES: Record<string, string> = { T1: "arrays/dualscale", T2: "arrays/multiflexi", T3: "arrays/texts" };

function assertQuestionRows(file: StructureFile, code: string, label: string): void {
  const row = questionRow(file, code);
  assert.equal(row.question_theme_name, BASE_THEMES[code], `${label}: question_theme_name of ${code}`);
  const expected = EXPECTED_ROWS[code];
  assert.ok(expected);
  assert.deepEqual(
    rowsFor(file, "subquestions", row.qid).map((item) => [item.title, item.scale_id, item.question_order]),
    expected.subquestions,
    `${label}: subquestions of ${code} (code, scale_id, question_order from 0 within each scale)`,
  );
  assert.deepEqual(
    rowsFor(file, "answers", row.qid).map((item) => [item.code, item.scale_id, item.sortorder]),
    expected.answers,
    `${label}: answers of ${code} (code, scale_id, sortorder from 0 within each scale)`,
  );
}

const fileOf = (text: string): StructureFile => parseStructureFile(Buffer.from(text, "utf8").toString("base64"));

test("[GEN-TYPES] the generator writes 1, : and ; with scale_id, the order from 0 within each scale, the base theme and dualscale_headerA/B per language (.lss and .lsq)", () => {
  let lss = "";
  assert.doesNotThrow(() => {
    lss = generateSurveyLss(typesSurvey());
  }, "the generator accepts the types 1, : and ;");
  const file = fileOf(lss);
  for (const code of ["T1", "T2", "T3"]) assertQuestionRows(file, code, ".lss");
  assert.deepEqual(
    ["T1", "T2", "T3"].map((code) => questionRow(file, code).type),
    ["1", ":", ";"],
  );

  // Texts per language: a column of T2 and an answer on scale 1 of T1.
  const t2 = questionRow(file, "T2").qid;
  const column = rowsFor(file, "subquestions", t2).find((item) => item.title === "SQ001" && item.scale_id === "1");
  assert.ok(column, "T2 has the column SQ001");
  const columnTexts = (file.sections.question_l10ns ?? []).filter((item) => item.qid === column.qid).map((item) => [item.language, item.question]);
  assert.deepEqual(columnTexts, [["de", "vormittags"], ["en", "mornings"]]);
  const t1 = questionRow(file, "T1").qid;
  const answer = rowsFor(file, "answers", t1).find((item) => item.code === "A1" && item.scale_id === "1");
  assert.ok(answer, "T1 has the answer A1 on scale 1");
  const answerTexts = (file.sections.answer_l10ns ?? []).filter((item) => item.aid === answer.aid).map((item) => [item.language, item.answer]);
  assert.deepEqual(answerTexts, [["de", "unzufrieden"], ["en", "dissatisfied"]]);

  // dualscale_headerA and dualscale_headerB are stored per language: one row per survey language, never one without.
  const attributes = rowsFor(file, "question_attributes", t1);
  for (const [name, values] of [
    ["dualscale_headerA", [["de", "Wichtigkeit"], ["en", "Importance"]]],
    ["dualscale_headerB", [["de", "Zufriedenheit / Satisfaction"], ["en", "Zufriedenheit / Satisfaction"]]],
  ] as const) {
    assert.deepEqual(attributes.filter((item) => item.attribute === name).map((item) => [item.language, item.value]), values, name);
  }

  // The question file of add_question_from_spec and update_question_from_spec numbers the same way.
  for (const question of [T1, T2]) {
    let lsq = "";
    assert.doesNotThrow(() => {
      lsq = generateQuestionLsq(question, { languages: ["de", "en"] });
    }, `the question file of ${String(question.code)}`);
    assertQuestionRows(fileOf(lsq), String(question.code), ".lsq");
  }
});

// ================================================================ 3: create and read, round trip

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: create_survey_from_spec with the types 1, : and ; (de, en) verifies cleanly; get_survey_spec states scale_id only for scale 1, and its spec creates a copy that reads back the same (fingerprint too)`, async () => {
    const fake = new FakeLimeSurvey({ generation });
    await withSession(async (session) => {
      const created = await createOk(session, typesSurvey());
      assert.equal(created.verification?.ok, true, JSON.stringify(created.verification));
      assert.deepEqual(created.languages, ["de", "en"]);
      assert.equal(created.questions, 5);
      const sid = Number(created.survey_id);
      const stored = (code: string): number => {
        const found = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === code);
        assert.ok(found, `no question ${code}`);
        return found.qid;
      };
      assert.deepEqual(answersOf(fake, stored("T1")), [["A1", 0], ["A2", 0], ["A1", 1], ["A2", 1], ["A3", 1]]);
      assert.deepEqual(subsOf(fake, stored("T1")), [["SQ001", 0], ["SQ002", 0]]);
      assert.deepEqual(subsOf(fake, stored("T2")), [["SQ001", 0], ["SQ002", 0], ["SQ001", 1], ["SQ002", 1]]);
      assert.deepEqual(subsOf(fake, stored("T3")), [["R1", 0], ["R2", 0], ["C1", 1], ["C2", 1]]);

      const first = await readOk(session, { survey_id: sid });
      assert.deepEqual(first.missing_translations, []);
      const questions = questionsByCode(first.spec);
      const [t1, t2, t3] = ["T1", "T2", "T3"].map((code) => questions.get(code));
      assert.ok(t1 && t2 && t3, `questions: ${[...questions.keys()].join(", ")}`);
      // The decision: scale_id only when it is 1.
      assert.deepEqual(scalesOf(t1.subquestions), ["none", "none"]);
      assert.deepEqual(scalesOf(t1.answers), ["none", "none", 1, 1, 1]);
      assert.deepEqual(t1.answers.map((item: Json) => [item.code, item.text.en]), [
        ["A1", "unimportant"], ["A2", "important"], ["A1", "dissatisfied"], ["A2", "partly"], ["A3", "satisfied"],
      ]);
      assert.deepEqual(scalesOf(t2.subquestions), ["none", "none", 1, 1]);
      assert.deepEqual(t2.subquestions.map((item: Json) => [item.code, item.text.de]), [
        ["SQ001", "Montag"], ["SQ002", "Dienstag"], ["SQ001", "vormittags"], ["SQ002", "nachmittags"],
      ]);
      assert.deepEqual(scalesOf(t3.subquestions), ["none", "none", 1, 1]);
      assert.deepEqual(t2.answers, []);
      assert.deepEqual(t3.answers, []);
      // Attributes per language; the base theme is not stated.
      assert.deepEqual(t1.attributes, {
        dualscale_headerA: both("Wichtigkeit", "Importance"),
        dualscale_headerB: both("Zufriedenheit / Satisfaction", "Zufriedenheit / Satisfaction"),
      });
      assert.deepEqual(t2.attributes, { multiflexible_max: "12" });
      assert.deepEqual(t3.attributes, { placeholder: both("bitte eintragen", "please enter") });
      for (const question of [t1, t2, t3]) assert.ok(!Object.hasOwn(question, "question_theme_name"), `${String(question.code)} states its base theme`);

      const copy = await createOk(session, first.spec);
      assert.equal(copy.verification?.ok, true, JSON.stringify(copy.verification));
      assert.notEqual(copy.survey_id, sid);
      const second = await readOk(session, { survey_id: Number(copy.survey_id) });
      assert.deepEqual(second.spec, first.spec);
      assert.equal(second.fingerprint, first.fingerprint);
    }, { fake });
  });
}

// ================================================================ 4: built in the admin

/** Built in the admin: T1 with the answer codes 0..n-1 on each scale (PHP answers a list), T2 with SQ001 on both scales. */
const SURFACE: SeedSurvey = {
  title: both("Matrizen aus der Oberfläche", "Arrays from the admin"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      {
        code: "T1",
        type: "1",
        text: both("Zwei Skalen", "Two scales"),
        subquestions: [{ code: "SQ001", text: both("Preis", "Price") }, { code: "SQ002", text: both("Beratung", "Advice") }],
        answers: [
          { code: "0", text: both("unwichtig", "unimportant"), scale_id: 0 },
          { code: "1", text: both("wichtig", "important"), scale_id: 0, assessment_value: 1 },
          { code: "2", text: both("sehr wichtig", "very important"), scale_id: 0, assessment_value: 2 },
          { code: "0", text: both("unzufrieden", "dissatisfied"), scale_id: 1 },
          { code: "1", text: both("zufrieden", "satisfied"), scale_id: 1, assessment_value: 1 },
        ],
        attributes: [
          { name: "dualscale_headerA", value: "Wichtigkeit", language: "de" },
          { name: "dualscale_headerA", value: "Importance", language: "en" },
          { name: "dualscale_headerB", value: "Zufriedenheit", language: "de" },
          { name: "dualscale_headerB", value: "Satisfaction", language: "en" },
          { name: "use_dropdown", value: "1" },
          // Equal to the default of the theme: not part of the spec.
          { name: "hidden", value: "0" },
        ],
      },
      {
        code: "T2",
        type: ":",
        text: both("Stunden", "Hours"),
        subquestions: [
          { code: "SQ001", text: both("Montag", "Monday") },
          { code: "SQ002", text: both("Dienstag", "Tuesday") },
          { code: "SQ001", text: both("vormittags", "mornings"), scale_id: 1 },
          { code: "SQ002", text: both("nachmittags", "afternoons"), scale_id: 1 },
        ],
        attributes: [{ name: "multiflexible_checkbox", value: "1" }],
      },
      {
        code: "T3",
        type: ";",
        text: both("Kontakte", "Contacts"),
        subquestions: [
          { code: "R1", text: both("Vertrieb", "Sales") },
          { code: "C1", text: both("Name", "Name"), scale_id: 1 },
          { code: "C2", text: both("Telefon", "Phone"), scale_id: 1 },
        ],
        attributes: [{ name: "placeholder", value: "bitte eintragen", language: "de" }, { name: "placeholder", value: "please enter", language: "en" }],
      },
    ],
  }],
};

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: a survey with 1, : and ; built in the admin (answer codes 0..n-1, the same code on both scales) reads as a valid spec that creates a copy reading back the same`, async () => {
    const fake = new FakeLimeSurvey({ generation });
    const { sid } = seedSurvey(fake, SURFACE);
    const properties = captureResults(fake, "get_question_properties");
    await withSession(async (session) => {
      const first = await readOk(session, { survey_id: sid });
      // The premise: the answer options of T1 come as a list of scales, each a list (codes 0..n-1, a PHP list).
      assert.ok(
        properties.some((item) => isRecord(item) && Array.isArray(item.answeroptions) && item.answeroptions.length === 2 && item.answeroptions.every(Array.isArray)),
        "get_question_properties answered the dual-scale options as lists",
      );
      const questions = questionsByCode(first.spec);
      const [t1, t2, t3] = ["T1", "T2", "T3"].map((code) => questions.get(code));
      assert.ok(t1 && t2 && t3, `questions: ${[...questions.keys()].join(", ")}`);
      assert.deepEqual(t1.answers.map((item: Json) => [item.code, item.scale_id ?? 0, item.text.en, item.assessment_value]), [
        ["0", 0, "unimportant", 0], ["1", 0, "important", 1], ["2", 0, "very important", 2], ["0", 1, "dissatisfied", 0], ["1", 1, "satisfied", 1],
      ]);
      assert.deepEqual(t1.attributes, {
        dualscale_headerA: both("Wichtigkeit", "Importance"),
        dualscale_headerB: both("Zufriedenheit", "Satisfaction"),
        use_dropdown: "1",
      });
      assert.deepEqual(t2.subquestions.map((item: Json) => [item.code, item.scale_id ?? 0, item.text.de]), [
        ["SQ001", 0, "Montag"], ["SQ002", 0, "Dienstag"], ["SQ001", 1, "vormittags"], ["SQ002", 1, "nachmittags"],
      ]);
      assert.deepEqual(t3.subquestions.map((item: Json) => [item.code, item.scale_id ?? 0]), [["R1", 0], ["C1", 1], ["C2", 1]]);

      const validated = await validateSpec(session, first.spec);
      assert.equal(validated.valid, true, JSON.stringify(validated.errors));
      const copy = await createOk(session, first.spec);
      assert.equal(copy.verification?.ok, true, JSON.stringify(copy.verification));
      const second = await readOk(session, { survey_id: Number(copy.survey_id) });
      assert.deepEqual(second.spec, first.spec);
      assert.equal(second.fingerprint, first.fingerprint);
    }, { fake });
  });
}

// ================================================================ 5: add question, add group

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: add_question_from_spec puts a : question at position 1 and verifies it; the .lsq carries the scales`, async () => {
    const { fake, sid } = await setup(ADD_BASE, generation);
    const gid = groupsOf(fake, sid)[0]?.gid;
    assert.ok(gid !== undefined);
    const before = fake.requests.length;
    const result = await withSession((session) => addQuestionOk(session, { survey_id: sid, group_id: gid, question: clone(T2), position: 1 }), { fake });
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    assert.deepEqual(result.position, { index: 1 });
    assert.deepEqual(codesOf(fake, gid), ["T2", "Q1", "Q2"]);
    assert.deepEqual(subsOf(fake, Number(result.question_id)), [["SQ001", 0], ["SQ002", 0], ["SQ001", 1], ["SQ002", 1]]);
    const imported = requestsSince(fake, before, "import_question");
    assert.equal(imported.length, 1);
    const file = parseStructureFile(imported[0]?.params[3]);
    assert.deepEqual((file.sections.subquestions ?? []).map((row) => [row.title, row.scale_id, row.question_order]), EXPECTED_ROWS.T2?.subquestions);
  });

  test(`[GEN-TYPES] generation ${generation}: add_group_from_spec with a 1 and a ; question verifies the group; answers and subquestions keep their scales`, async () => {
    const { fake, sid } = await setup(ADD_BASE, generation);
    const group = { title: both("Matrizen", "Arrays"), questions: [clone(T1), clone(T3)] };
    const result = await withSession((session) => addGroupOk(session, { survey_id: sid, group }), { fake });
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    const created = new Map((result.questions as Json[]).map((item): [string, number] => [String(item.code), Number(item.question_id)]));
    assert.deepEqual([...created.keys()], ["T1", "T3"]);
    assert.deepEqual(answersOf(fake, created.get("T1") ?? 0), [["A1", 0], ["A2", 0], ["A1", 1], ["A2", 1], ["A3", 1]]);
    assert.deepEqual(subsOf(fake, created.get("T1") ?? 0), [["SQ001", 0], ["SQ002", 0]]);
    assert.deepEqual(subsOf(fake, created.get("T3") ?? 0), [["R1", 0], ["R2", 0], ["C1", 1], ["C2", 1]]);
    assert.deepEqual(groupsOf(fake, sid).length, 2);
  });
}

// ================================================================ 6: update_question_from_spec

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: a column (scale 1) added to a : question is a replacement at the same place that verifies, and get_survey_spec gives the end state back`, async () => {
    const { fake, sid, question } = await setup(typesSurvey(), generation);
    const old = question("T2");
    const codes = codesOf(fake, old.gid);
    const result = await withSession(async (session) => {
      const read = await readOk(session, { survey_id: sid, question_id: old.qid });
      const desired = clone(read.spec);
      desired.subquestions.push({ code: "SQ003", text: both("abends", "evenings"), scale_id: 1 });
      const preview = await updateQuestionOk(session, dry(sid, old.qid, desired));
      assert.equal(preview.mode, "replace", JSON.stringify(preview.changes));
      const done = await updateQuestionOk(session, real(sid, old.qid, desired, read.fingerprint, acknowledgeable(preview)));
      const after = await readOk(session, { survey_id: sid, question_id: Number(done.question_id) });
      assert.deepEqual(after.spec, desired, "get_survey_spec gives the end state back");
      return done;
    }, { fake });
    assert.equal(result.mode, "replace");
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    const newQid = Number(result.question_id);
    assert.notEqual(newQid, old.qid);
    assert.deepEqual(codesOf(fake, old.gid), codes, "the codes keep their order");
    assert.equal(mainQuestionsOf(fake, old.gid)[2]?.qid, newQid, "the new question takes the place of the old one");
    assert.ok(!fake.questions.some((item) => item.qid === old.qid), "the old question is deleted");
    assert.deepEqual(subsOf(fake, newQid), [["SQ001", 0], ["SQ002", 0], ["SQ001", 1], ["SQ002", 1], ["SQ003", 1]]);
  });

  test(`[GEN-TYPES] generation ${generation}: a changed text of a column (scale 1) of a : question at an active survey gives mode texts and is written to that column, not to the row with the same code`, async () => {
    const { fake, sid, question } = await setup(typesSurvey(), generation);
    const t2 = question("T2");
    const column = subIn(fake, t2.qid, "SQ001", 1);
    const row = subIn(fake, t2.qid, "SQ001", 0);
    fake.setActive(sid, true);
    let before = 0;
    const result = await withSession(async (session) => {
      const read = await readOk(session, { survey_id: sid, question_id: t2.qid });
      const desired = clone(read.spec);
      const target = (desired.subquestions as Json[]).find((item) => item.code === "SQ001" && item.scale_id === 1);
      assert.ok(target, `the spec has the column SQ001: ${JSON.stringify(desired.subquestions)}`);
      target.text = both("morgens", "early");
      before = fake.requests.length;
      return updateQuestionOk(session, real(sid, t2.qid, desired, read.fingerprint));
    }, { fake });
    assert.equal(result.mode, "texts");
    assert.equal(result.survey_active, true);
    assert.equal(result.applied, true);
    assert.equal(result.question_id, t2.qid);
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    const writes = writeMethodsSince(fake, before);
    assert.ok(writes.length > 0 && writes.every((method) => method === "set_question_properties"), writes.join(", "));
    assert.deepEqual(requestsSince(fake, before, "set_question_properties").map((request) => Number(request.params[1])), [column.qid]);
    assert.deepEqual([column.l10n.de?.question, column.l10n.en?.question], ["morgens", "early"]);
    assert.deepEqual([row.l10n.de?.question, row.l10n.en?.question], ["Montag", "Monday"]);
  });
}

// ================================================================ 7: update_survey_texts

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: update_survey_texts writes a subquestion text with scale_id 1 to the column, not to the row with the same code; without scale_id the code is ambiguous`, async () => {
    const { fake, sid, question } = await setup(typesSurvey(), generation);
    const t2 = question("T2");
    const column = subIn(fake, t2.qid, "SQ001", 1);
    const row = subIn(fake, t2.qid, "SQ001", 0);
    await withSession(async (session) => {
      const before = fake.requests.length;
      const ambiguous = await updateTextsError(session, {
        survey_id: sid,
        texts: { questions: [{ code: "T2", subquestions: [{ code: "SQ001", text: { de: "neu" } }] }] },
      });
      assert.ok(errorPaths(ambiguous).includes("questions[0].subquestions[0].scale_id"), JSON.stringify(ambiguous.details));
      assert.deepEqual(writeMethodsSince(fake, before), []);

      const start = fake.requests.length;
      const result = await updateTextsOk(session, {
        survey_id: sid,
        texts: { questions: [{ code: "T2", subquestions: [{ code: "SQ001", scale_id: 1, text: { de: "vormittags, neu" } }] }] },
      });
      assert.equal(result.applied, true);
      assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
      assert.deepEqual(requestsSince(fake, start, "set_question_properties").map((request) => Number(request.params[1])), [column.qid]);
      assert.deepEqual([column.l10n.de?.question, column.l10n.en?.question], ["vormittags, neu", "mornings"]);
      assert.deepEqual([row.l10n.de?.question, row.l10n.en?.question], ["Montag", "Monday"]);

      const read = await readOk(session, { survey_id: sid, question_id: t2.qid });
      assert.deepEqual((read.spec.subquestions as Json[]).map((item) => [item.code, item.scale_id ?? 0, item.text.de]), [
        ["SQ001", 0, "Montag"], ["SQ002", 0, "Dienstag"], ["SQ001", 1, "vormittags, neu"], ["SQ002", 1, "nachmittags"],
      ]);
    }, { fake });
  });
}

// ================================================================ 11: references to a cell of a : question

/** typesSurvey with Q9 relevant only when the cell row SQ001 / column SQ002 of T2 has a value. */
function cellReferenceSurvey(): Json {
  const spec = typesSurvey();
  const q9 = (spec.groups[0].questions as Json[]).find((item) => item.code === "Q9");
  assert.ok(q9);
  q9.relevance = "!is_empty(T2_SQ001_SQ002)";
  return spec;
}

const drop = (code: string, scale: number) => (spec: Json): void => {
  spec.subquestions = (spec.subquestions as Json[]).filter((item) => !(item.code === code && (item.scale_id ?? 0) === scale));
};

const CELL_CASES: Array<[label: string, change: (spec: Json) => void, found: boolean]> = [
  ["removes the column SQ002 (scale 1) of the cell", drop("SQ002", 1), true],
  ["removes the row SQ001 (scale 0) of the cell", drop("SQ001", 0), true],
  ["removes the column SQ001 (scale 1), which the cell does not use", drop("SQ001", 1), false],
];

for (const generation of GENERATIONS) {
  for (const [label, change, found] of CELL_CASES) {
    test(`[GEN-TYPES] generation ${generation}: Q9 names the cell T2_SQ001_SQ002; an end state of T2 that ${label} ${found ? "reports" : "does not report"} code_references`, async () => {
      const { fake, sid, question } = await setup(cellReferenceSurvey(), generation);
      const t2 = question("T2");
      const preview = await withSession(async (session) => {
        const read = await readOk(session, { survey_id: sid, question_id: t2.qid });
        const desired = clone(read.spec);
        change(desired);
        assert.equal((desired.subquestions as Json[]).length, 3, "one subquestion is gone");
        return updateQuestionOk(session, dry(sid, t2.qid, desired));
      }, { fake });
      assert.equal(preview.mode, "replace");
      assert.ok(riskOf(preview.risks, "removals"), JSON.stringify(preview.risks));
      const risk = riskOf(preview.risks, "code_references");
      if (!found) {
        assert.equal(risk, undefined, JSON.stringify(preview.risks));
        return;
      }
      assert.ok(risk, JSON.stringify(preview.risks));
      assert.equal(risk.blocking, true);
      assert.equal(risk.acknowledgeable, false);
      assert.match(JSON.stringify(risk.locations), /Q9/, "the risk names where the cell is used");
    });
  }
}

// ================================================================ 8 and 13: all 29 core types

const CORE_TYPES = "XL!OMYNSTQ5FARKBCEHPDGUI*|1:;";

/** A valid question of the type: subquestions and answers as the type needs them. */
function questionOfType(type: string, index: number): Json {
  const question: Json = { code: `Q${String(index + 1).padStart(2, "0")}`, type, text: both(`Frage vom Typ ${type}`, `Question of type ${type}`) };
  const rows = [{ code: "SQ001", text: both("Erste Zeile", "First row") }, { code: "SQ002", text: both("Zweite Zeile", "Second row") }];
  const answers = [{ code: "A1", text: both("Ja", "Yes") }, { code: "A2", text: both("Nein", "No") }];
  if ("MPQKABCE".includes(type)) return { ...question, subquestions: rows };
  if ("L!OR".includes(type)) return { ...question, answers };
  if ("FH".includes(type)) return { ...question, subquestions: rows, answers };
  if (type === "1") return { ...question, subquestions: rows, answers: [...answers, ...answers.map((item) => ({ ...item, scale_id: 1 }))] };
  if (":;".includes(type)) {
    const columns = [{ code: "SQ001", text: both("Erste Spalte", "First column"), scale_id: 1 }, { code: "SQ002", text: both("Zweite Spalte", "Second column"), scale_id: 1 }];
    return { ...question, subquestions: [...rows, ...columns] };
  }
  return question;
}

const ALL_TYPES: Json = {
  survey: { title: both("Alle Fragetypen", "All question types"), language: "de", additional_languages: ["en"] },
  groups: [{ title: both("Alle", "All"), questions: [...CORE_TYPES].map(questionOfType) }],
};

for (const generation of GENERATIONS) {
  test(`[GEN-TYPES] generation ${generation}: a survey with one question of each of the 29 core types is created and verified; its spec creates a copy that reads back the same; Ranking stays as before (subquestions on 7, answers on 6)`, async () => {
    assert.equal(new Set(CORE_TYPES).size, 29, "the 29 core types of LimeSurvey 6 and 7");
    const fake = new FakeLimeSurvey({ generation });
    await withSession(async (session) => {
      const created = await createOk(session, ALL_TYPES);
      assert.equal(created.verification?.ok, true, JSON.stringify(created.verification).slice(0, 2500));
      assert.equal(created.questions, CORE_TYPES.length);
      const sid = Number(created.survey_id);
      const mains = fake.questions.filter((item) => item.sid === sid && item.parent_qid === 0);
      assert.deepEqual(new Set(mains.map((item) => item.type)), new Set(CORE_TYPES));

      // Ranking as in PR3: LimeSurvey 7 keeps the entries as subquestions of type R, LimeSurvey 6 as answer options.
      const ranking = mains.find((item) => item.type === "R");
      assert.ok(ranking);
      const entries = fake.questions.filter((item) => item.parent_qid === ranking.qid);
      assert.equal(entries.length, generation === 7 ? 2 : 0);
      assert.ok(entries.every((item) => item.type === "R" && item.scale_id === 0), JSON.stringify(entries));
      assert.equal(fake.answers.filter((item) => item.qid === ranking.qid).length, generation === 7 ? 0 : 2);

      const first = await readOk(session, { survey_id: sid });
      assert.deepEqual(first.missing_translations, []);
      const rankingSpec = questionsByCode(first.spec).get(ranking.title);
      assert.ok(rankingSpec);
      assert.deepEqual(rankingSpec.answers.map((item: Json) => item.code), ["A1", "A2"], "the spec calls the entries answers");
      assert.deepEqual(rankingSpec.subquestions, []);

      const copy = await createOk(session, first.spec);
      assert.equal(copy.verification?.ok, true, JSON.stringify(copy.verification).slice(0, 2500));
      const second = await readOk(session, { survey_id: Number(copy.survey_id) });
      assert.deepEqual(second.spec, first.spec);
      assert.equal(second.fingerprint, first.fingerprint);
    }, { fake });
  });
}

// ================================================================ the tool descriptions

const SPEC_TOOLS = [
  "limesurvey_validate_spec",
  "limesurvey_create_survey_from_spec",
  "limesurvey_get_survey_spec",
  ADD_QUESTION,
  ADD_GROUP,
  UPDATE_QUESTION,
  UPDATE_TEXTS,
];

test("[GEN-TYPES] no spec tool calls the types 1, : and ; unsupported any more, and every tool that takes a spec describes scale_id", async () => {
  await withSession(async (session) => {
    const tools = (await session.client.listTools()).tools;
    for (const name of SPEC_TOOLS) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `${name} is not registered`);
      assert.doesNotMatch(String(tool.description), /not supported/i, `${name}: ${String(tool.description)}`);
    }
    for (const name of ["limesurvey_validate_spec", "limesurvey_create_survey_from_spec", ADD_QUESTION, ADD_GROUP, UPDATE_QUESTION]) {
      const tool = tools.find((item) => item.name === name);
      assert.match(JSON.stringify(tool?.inputSchema ?? null), /scale_id/, `${name} does not describe scale_id`);
    }
  });
});

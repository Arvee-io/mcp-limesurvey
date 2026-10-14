import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type Generation } from "./helpers/fake-limesurvey.js";
import { envConfig } from "./helpers/mcp-session.js";
import { seedSurvey, type SeedSurvey } from "./helpers/seed-survey.js";
import { groupsOf, importSpec, mainQuestionsOf, readOk, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import {
  ADD_QUESTION,
  addQuestionError,
  addQuestionOk,
  both,
  captureResults,
  codesOf,
  errorPaths,
  parseStructureFile,
  propertyNames,
  requestsSince,
  surveyOutline,
} from "./helpers/add-tools.js";

/**
 * GEN-A: limesurvey_add_question_from_spec inserts one new question, described as a question spec, at a given place of a
 * group of an inactive survey: spec check against the live survey, .lsq, import_question, position (only the new
 * question is moved), read-back through get_survey_spec and comparison with the spec. A failure after the import deletes
 * the new question again and nothing else.
 */

/** One language (de): group 1 with Q1 (L), Q2 and Q3, group 2 with Q4. */
const BASE: Json = {
  survey: { title: "Basis" },
  groups: [
    {
      title: "Gruppe 1",
      questions: [
        { code: "Q1", type: "L", text: "Wahl", answers: [{ code: "A1", text: "Eins" }, { code: "A2", text: "Zwei" }] },
        { code: "Q2", type: "S", text: "Name" },
        { code: "Q3", type: "T", text: "Anmerkung" },
      ],
    },
    { title: "Gruppe 2", questions: [{ code: "Q4", type: "S", text: "Ort" }] },
  ],
};

/** Two languages (de, en): one group with Q1 and Q2. */
const BILINGUAL: Json = {
  survey: { title: both("Basis", "Base"), language: "de", additional_languages: ["en"] },
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      { code: "Q1", type: "S", text: both("Eins", "One") },
      { code: "Q2", type: "S", text: both("Zwei", "Two") },
    ],
  }],
};

const NEW_QUESTION: Json = { code: "N1", type: "S", text: "Neu" };

interface Base {
  fake: FakeLimeSurvey;
  sid: number;
  /** The group id at this index of the survey order. */
  gid: (index: number) => number;
}

/** A fake with a survey created by create_survey_from_spec. */
async function setup(spec: Json = BASE, generation: Generation = 7): Promise<Base> {
  const fake = new FakeLimeSurvey({ generation });
  const sid = await importSpec(fake, spec);
  const gids = groupsOf(fake, sid).map((group) => group.gid);
  return {
    fake,
    sid,
    gid: (index) => {
      const gid = gids[index];
      assert.ok(gid !== undefined, `the survey has no group ${index}`);
      return gid;
    },
  };
}

const WRITE_SET = new Set(["import_question", "set_question_properties"]);

// ---- the tool and its contract ----

test("[GEN-A] add_question_from_spec is registered with the annotations and the input of the contract, and takes no file path", async () => {
  await withSession(async (session) => {
    const tool = (await session.client.listTools()).tools.find((item) => item.name === ADD_QUESTION);
    assert.ok(tool, `${ADD_QUESTION} is not registered`);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, false);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.outputSchema, "the tool has an output schema");
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["acknowledge", "group_id", "position", "question", "survey_id"]);
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), ["group_id", "question", "survey_id"]);
    // Review of PR4: filling translation gaps of the survey needs acknowledge: ["fill_translation_gaps"].
    assert.match(JSON.stringify(tool.inputSchema.properties?.acknowledge ?? null), /fill_translation_gaps/);
    assert.deepEqual(propertyNames(tool.inputSchema).filter((name) => /path|file/i.test(name)), [], "the tool takes no file parameter");
  });
});

// ---- 1: at the end ----

test("[GEN-A] add_question_from_spec without position appends the question to the group and verifies it; import_question gets sid, gid, lsq and the mandatory flag", async () => {
  const { fake, sid, gid } = await setup();
  const g1 = gid(0);
  const oldOrder = codesOf(fake, g1);
  const before = fake.requests.length;
  await withSession(async (session) => {
    const first = await addQuestionOk(session, {
      survey_id: sid,
      group_id: g1,
      question: { code: "N1", type: "M", text: "Neu", mandatory: true, subquestions: [{ code: "SQ1", text: "Eins" }, { code: "SQ2", text: "Zwei" }] },
    });
    const created = fake.questions.find((item) => item.qid === first.question_id);
    assert.ok(created, `question_id ${String(first.question_id)} is not in the fake`);
    assert.equal(created.sid, sid);
    assert.equal(created.gid, g1);
    assert.equal(created.parent_qid, 0);
    assert.equal(created.title, "N1");
    assert.equal(created.type, "M");
    assert.equal(created.mandatory, "Y");
    assert.deepEqual(fake.questions.filter((item) => item.parent_qid === created.qid).map((item) => item.title).sort(), ["SQ1", "SQ2"]);
    assert.equal(first.survey_id, sid);
    assert.equal(first.group_id, g1);
    assert.equal(first.code, "N1");
    assert.deepEqual(first.position, { index: 4 });
    assert.equal(first.verification?.ok, true, JSON.stringify(first.verification));
    assert.deepEqual(first.verification.differences, []);
    assert.equal(first.verification.differences_total, 0);
    assert.equal(first.verification.truncated, false);
    assert.deepEqual(first.side_effects, []);
    assert.deepEqual(codesOf(fake, g1), [...oldOrder, "N1"]);

    const second = await addQuestionOk(session, { survey_id: sid, group_id: g1, question: { code: "N2", type: "S", text: "Noch eine" } });
    const createdSecond = fake.questions.find((item) => item.qid === second.question_id);
    assert.ok(createdSecond, `question_id ${String(second.question_id)} is not in the fake`);
    assert.equal(createdSecond.title, "N2");
    assert.equal(createdSecond.mandatory, "N");
    assert.deepEqual(second.position, { index: 5 });
    assert.equal(second.verification?.ok, true, JSON.stringify(second.verification));
    assert.deepEqual(codesOf(fake, g1), [...oldOrder, "N1", "N2"]);
  }, { fake });

  const imports = requestsSince(fake, before, "import_question");
  assert.equal(imports.length, 2, "one import_question per call");
  for (const request of imports) {
    assert.equal(request.params[1], sid);
    assert.equal(request.params[2], g1);
    assert.equal(request.params[4], "lsq");
  }
  assert.equal(imports[0]?.params[5], "Y", "mandatory true is sent as Y");
  assert.equal(imports[1]?.params[5], "N", "without mandatory the flag is sent as N, never left out");
  assert.ok(writeMethodsSince(fake, before).every((method) => WRITE_SET.has(method)), writeMethodsSince(fake, before).join(", "));
});

test("[GEN-A] the imported .lsq is a Question document with exactly the survey languages, and the texts are only in question_l10ns", async () => {
  const { fake, sid, gid } = await setup();
  const before = fake.requests.length;
  await withSession(async (session) => {
    await addQuestionOk(session, {
      survey_id: sid,
      group_id: gid(0),
      question: { code: "N1", type: "M", text: "Neu", help: "Hilfe", subquestions: [{ code: "SQ1", text: "Eins" }, { code: "SQ2", text: "Zwei" }] },
    });
  }, { fake });
  const request = requestsSince(fake, before, "import_question")[0];
  assert.ok(request, "import_question was not sent");
  const file = parseStructureFile(request.params[3]);
  assert.equal(file.docType, "Question");
  assert.deepEqual(file.languages, ["de"]);

  const mains = file.sections.questions ?? [];
  const subs = file.sections.subquestions ?? [];
  assert.deepEqual(mains.map((row) => row.title), ["N1"]);
  assert.deepEqual(subs.map((row) => row.title), ["SQ1", "SQ2"]);
  for (const row of [...mains, ...subs]) {
    for (const inline of ["question", "help", "language"]) {
      assert.ok(!(inline in row), `the row of ${row.title ?? "?"} has the inline column ${inline}; texts belong into question_l10ns`);
    }
  }
  const texts = new Map((file.sections.question_l10ns ?? []).map((row) => [`${row.qid ?? ""}|${row.language ?? ""}`, row]));
  const textOf = (qid: string | undefined) => texts.get(`${qid ?? ""}|de`);
  assert.equal(textOf(mains[0]?.qid)?.question, "Neu");
  assert.equal(textOf(mains[0]?.qid)?.help, "Hilfe");
  assert.equal(textOf(subs[0]?.qid)?.question, "Eins");
  assert.equal(textOf(subs[1]?.qid)?.question, "Zwei");
  assert.equal(texts.size, 3, "one text row per question and language");
});

// ---- 2: positions ----

const POSITIONS: Array<[label: string, position: Json | number, expected: string[]]> = [
  ["position 1", 1, ["N1", "Q1", "Q2", "Q3"]],
  ['{ after: "Q1" }', { after: "Q1" }, ["Q1", "N1", "Q2", "Q3"]],
  ['{ before: "Q3" }', { before: "Q3" }, ["Q1", "Q2", "N1", "Q3"]],
];

for (const [label, position, expected] of POSITIONS) {
  test(`[GEN-A] add_question_from_spec at ${label} gives ${expected.join(" ")} and sends set_question_properties for the new question only`, async () => {
    const { fake, sid, gid } = await setup();
    const g1 = gid(0);
    const othersBefore = mainQuestionsOf(fake, g1).map((item) => [item.qid, item.title]);
    const outlineOfGroup2 = surveyOutline(fake, sid)[1];
    const before = fake.requests.length;
    const result = await withSession((session) => addQuestionOk(session, { survey_id: sid, group_id: g1, question: NEW_QUESTION, position }), { fake });

    assert.deepEqual(codesOf(fake, g1), expected);
    assert.deepEqual(result.position, { index: expected.indexOf("N1") + 1 });
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    const sets = requestsSince(fake, before, "set_question_properties");
    for (const request of sets) assert.equal(request.params[1], result.question_id, `set_question_properties for ${String(request.params[1])}`);
    assert.ok(writeMethodsSince(fake, before).every((method) => WRITE_SET.has(method)), writeMethodsSince(fake, before).join(", "));
    // The neighbours keep their ids and codes; the other group is untouched.
    assert.deepEqual(mainQuestionsOf(fake, g1).filter((item) => item.qid !== result.question_id).map((item) => [item.qid, item.title]), othersBefore);
    assert.deepEqual(surveyOutline(fake, sid)[1], outlineOfGroup2);
  });
}

// ---- 3: ties are broken without help of the code ----

const TIE_BASE: Json = {
  survey: { title: "Gleichstand" },
  groups: [{ title: "Gruppe", questions: ["A1", "B1", "C1"].map((code) => ({ code, type: "S", text: `Frage ${code}` })) }],
};

const TIES: Array<[code: string, after: string, expected: string[]]> = [
  // The new code sorts after the next neighbour (B1) ...
  ["Z9", "A1", ["A1", "Z9", "B1", "C1"]],
  // ... and before the previous one (B1).
  ["A0", "B1", ["A1", "B1", "A0", "C1"]],
];

for (const [code, after, expected] of TIES) {
  test(`[GEN-A] a new code that sorts ${code < after ? "before" : "after"} its neighbours still lands at its place: ${code} after ${after} gives ${expected.join(" ")}`, async () => {
    const { fake, sid, gid } = await setup(TIE_BASE);
    const g1 = gid(0);
    const result = await withSession((session) => addQuestionOk(session, {
      survey_id: sid,
      group_id: g1,
      question: { code, type: "S", text: "Neu" },
      position: { after },
    }), { fake });
    assert.deepEqual(codesOf(fake, g1), expected);
    const orders = mainQuestionsOf(fake, g1).map((item) => item.question_order);
    assert.equal(new Set(orders).size, orders.length, `no two questions share a question_order: ${orders.join(", ")}`);
    // The new question has its final code (no temporary code is left), and nothing else was renamed.
    assert.equal(fake.questions.find((item) => item.qid === result.question_id)?.title, code);
    assert.deepEqual(fake.questions.filter((item) => item.sid === sid && item.parent_qid === 0).map((item) => item.title).sort(), [...expected].sort());
    assert.equal(result.code, code);
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  });
}

// ---- 4: two languages ----

test("[GEN-A] two languages: a question with text maps is written per language and verifies; the .lsq names exactly de and en", async () => {
  const { fake, sid, gid } = await setup(BILINGUAL);
  const before = fake.requests.length;
  const result = await withSession((session) => addQuestionOk(session, {
    survey_id: sid,
    group_id: gid(0),
    question: { code: "N1", type: "L", text: both("Neu", "New"), help: both("Hilfe", "Help"), answers: [{ code: "A1", text: both("Ja", "Yes") }] },
  }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const created = fake.questions.find((item) => item.qid === result.question_id);
  assert.ok(created);
  assert.deepEqual(
    Object.fromEntries(Object.entries(created.l10n).map(([language, row]) => [language, [row.question, row.help]])),
    { de: ["Neu", "Hilfe"], en: ["New", "Help"] },
  );
  assert.deepEqual(fake.answers.filter((item) => item.qid === created.qid).map((item) => item.l10n), [both("Ja", "Yes")]);
  const request = requestsSince(fake, before, "import_question")[0];
  assert.ok(request);
  assert.deepEqual([...parseStructureFile(request.params[3]).languages].sort(), ["de", "en"]);
});

test("[GEN-A] two languages: a text map without en answers SPEC_INVALID at text and writes nothing", async () => {
  const { fake, sid, gid } = await setup(BILINGUAL);
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, {
    survey_id: sid,
    group_id: gid(0),
    question: { code: "N1", type: "S", text: { de: "Nur deutsch" } },
  }), { fake });
  assert.ok(errorPaths(error).includes("text"), `paths: ${errorPaths(error).join(", ")}`);
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

test("[GEN-A] two languages: one string is the text of both languages", async () => {
  const { fake, sid, gid } = await setup(BILINGUAL);
  const result = await withSession((session) => addQuestionOk(session, {
    survey_id: sid,
    group_id: gid(0),
    question: { code: "N1", type: "S", text: "Beide" },
  }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const created = fake.questions.find((item) => item.qid === result.question_id);
  assert.ok(created);
  assert.deepEqual(Object.fromEntries(Object.entries(created.l10n).map(([language, row]) => [language, row.question])), both("Beide", "Beide"));
});

// ---- 5 to 8: refused before anything is written ----

for (const [label, code] of [["the code of a question of the same group in another case", "q1"], ["the code of a question of another group", "Q4"]] as const) {
  test(`[GEN-A] CODE_CONFLICT for ${label} (${code}): no import_question and no other write`, async () => {
    const { fake, sid, gid } = await setup();
    const before = fake.requests.length;
    const error = await withSession((session) => addQuestionError(session, {
      survey_id: sid,
      group_id: gid(0),
      question: { code, type: "S", text: "Doppelt" },
    }), { fake });
    assert.equal(error.code, "CODE_CONFLICT", JSON.stringify(error).slice(0, 1500));
    assert.deepEqual(requestsSince(fake, before, "import_question"), []);
    assert.deepEqual(writeMethodsSince(fake, before), []);
  });
}

test("[GEN-A] an active survey answers SURVEY_ACTIVE and nothing is written", async () => {
  const { fake, sid, gid } = await setup();
  fake.setActive(sid, true);
  const outline = surveyOutline(fake, sid);
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid(0), question: NEW_QUESTION }), { fake });
  assert.equal(error.code, "SURVEY_ACTIVE", JSON.stringify(error).slice(0, 1500));
  assert.deepEqual(writeMethodsSince(fake, before), []);
  assert.deepEqual(surveyOutline(fake, sid), outline);
});

test("[GEN-A] a group of another survey answers GROUP_SURVEY_MISMATCH and nothing is written", async () => {
  const { fake, sid } = await setup();
  const otherSid = await importSpec(fake, BILINGUAL);
  const foreign = groupsOf(fake, otherSid)[0];
  assert.ok(foreign);
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: foreign.gid, question: NEW_QUESTION }), { fake });
  assert.equal(error.code, "GROUP_SURVEY_MISMATCH", JSON.stringify(error).slice(0, 1500));
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

for (const [label, position] of [
  ["a code that does not exist", { after: "XYZ" }],
  ["the code of a question of another group", { before: "Q4" }],
] as const) {
  test(`[GEN-A] a position next to ${label} answers POSITION_INVALID and nothing is written`, async () => {
    const { fake, sid, gid } = await setup();
    const before = fake.requests.length;
    const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid(0), question: NEW_QUESTION, position }), { fake });
    assert.equal(error.code, "POSITION_INVALID", JSON.stringify(error).slice(0, 1500));
    assert.deepEqual(writeMethodsSince(fake, before), []);
  });
}

// ---- 9: rollback ----

test("[GEN-A] when positioning fails, the new question is deleted again and nothing else: ADD_QUESTION_FAILED with rolled_back", async () => {
  const { fake, sid, gid } = await setup();
  const g1 = gid(0);
  const imported = captureResults(fake, "import_question");
  const outline = surveyOutline(fake, sid);
  fake.failNext("set_question_properties", { status: "Error: x", error_code: "ERR_UPDATE_FAILED" });
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, {
    survey_id: sid,
    group_id: g1,
    question: { code: "N1", type: "M", text: "Neu", subquestions: [{ code: "SQ1", text: "Eins" }] },
    position: 1,
  }), { fake });
  assert.equal(error.code, "ADD_QUESTION_FAILED", JSON.stringify(error).slice(0, 1500));
  assert.ok(typeof error.details?.failed_step === "string" && error.details.failed_step.length > 0, JSON.stringify(error.details));
  assert.equal(error.details?.rolled_back, true);
  assert.equal(error.details?.manual_cleanup, false);

  assert.equal(imported.length, 1, "one question was imported");
  const newQid = Number(imported[0]);
  assert.ok(Number.isInteger(newQid) && newQid > 0, `import_question answered ${JSON.stringify(imported[0])}`);
  assert.deepEqual(requestsSince(fake, before, "delete_question").map((request) => request.params[1]), [newQid], "exactly the new question is deleted");
  assert.ok(!fake.questions.some((item) => item.qid === newQid || item.parent_qid === newQid), "the new question and its subquestions are gone");
  assert.deepEqual(surveyOutline(fake, sid), outline, "every other question keeps its id, code, texts and place");
  assert.ok(
    writeMethodsSince(fake, before).every((method) => ["import_question", "set_question_properties", "delete_question"].includes(method)),
    writeMethodsSince(fake, before).join(", "),
  );
});

// ---- 10: write scope ----

test("[GEN-A] under the write scope none the tool answers WRITE_SCOPE_INSUFFICIENT and sends no request", async () => {
  const { fake, sid, gid } = await setup();
  const before = fake.requests.length;
  const error = await withSession(
    (session) => addQuestionError(session, { survey_id: sid, group_id: gid(0), question: NEW_QUESTION }),
    { fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) },
  );
  assert.equal(error.code, "WRITE_SCOPE_INSUFFICIENT");
  assert.equal(fake.requests.length, before, "no request reached LimeSurvey");
});

// ---- 11: side effects ----

test("[GEN-A] a translation gap elsewhere in the survey is reported as side effect translations_filled_from_base with its path (import_question fills it)", async () => {
  const { fake, sid, gid } = await setup(BILINGUAL);
  const gap = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "Q2");
  assert.ok(gap?.l10n.en, "the import must have created the English text row first");
  delete gap.l10n.en;
  const result = await withSession((session) => addQuestionOk(session, {
    survey_id: sid,
    group_id: gid(0),
    question: { code: "N1", type: "S", text: both("Neu", "New") },
    // Review of PR4: filling the gap needs the confirmation (without it: TRANSLATION_GAPS).
    acknowledge: ["fill_translation_gaps"],
  }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const sideEffects = (result.side_effects as Array<{ kind?: unknown }> | undefined) ?? [];
  const filled = sideEffects.filter((item) => item.kind === "translations_filled_from_base");
  assert.ok(filled.length > 0, `side_effects: ${JSON.stringify(result.side_effects)}`);
  const text = JSON.stringify(filled);
  assert.ok(text.includes('"groups[0].questions[1].text"'), `the side effect names the gap groups[0].questions[1].text: ${text}`);
  assert.ok(text.includes('"en"'), `the side effect names the language en: ${text}`);
  // The premise: the import filled the gap with the text of the base language.
  const textIn = (language: string): string | undefined => gap.l10n[language]?.question;
  assert.equal(textIn("en"), "Zwei");
});

// ---- 12: LimeSurvey 6 ----

test("[GEN-A] generation 6: the question is appended at the end and inserted at position 1", async () => {
  const { fake, sid, gid } = await setup(BASE, 6);
  const g1 = gid(0);
  await withSession(async (session) => {
    const end = await addQuestionOk(session, { survey_id: sid, group_id: g1, question: NEW_QUESTION });
    assert.equal(end.verification?.ok, true, JSON.stringify(end.verification));
    assert.deepEqual(codesOf(fake, g1), ["Q1", "Q2", "Q3", "N1"]);
    assert.deepEqual(end.position, { index: 4 });

    const front = await addQuestionOk(session, { survey_id: sid, group_id: g1, question: { code: "N2", type: "S", text: "Vorne" }, position: 1 });
    assert.equal(front.verification?.ok, true, JSON.stringify(front.verification));
    assert.deepEqual(codesOf(fake, g1), ["N2", "Q1", "Q2", "Q3", "N1"]);
    assert.deepEqual(front.position, { index: 1 });
  }, { fake });
});

// ---- 19: Ranking ----

const RANKING_QUESTION: Json = {
  code: "R01",
  type: "R",
  text: "Reihenfolge",
  answers: [{ code: "LONGCODE1", text: "Lang", relevance: "Q1 == 'A1'" }, { code: "SHORT", text: "Kurz" }],
};

test("[GEN-A] LimeSurvey 7: a Ranking question goes into the .lsq with its entries as subquestions of type R (scale 0, with relevance) and verifies", async () => {
  const { fake, sid, gid } = await setup(BASE, 7);
  const before = fake.requests.length;
  const result = await withSession((session) => addQuestionOk(session, { survey_id: sid, group_id: gid(0), question: RANKING_QUESTION }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));

  const request = requestsSince(fake, before, "import_question")[0];
  assert.ok(request);
  const file = parseStructureFile(request.params[3]);
  const entries = file.sections.subquestions ?? [];
  assert.deepEqual(entries.map((row) => [row.title, row.type, row.scale_id]), [["LONGCODE1", "R", "0"], ["SHORT", "R", "0"]]);
  assert.equal(entries[0]?.relevance, "Q1 == 'A1'");
  assert.deepEqual(file.sections.answers ?? [], [], "the entries are no answers");

  const stored = fake.questions.filter((item) => item.parent_qid === result.question_id).sort((a, b) => a.question_order - b.question_order);
  assert.deepEqual(stored.map((item) => [item.title, item.type, item.scale_id, item.relevance]), [
    ["LONGCODE1", "R", 0, "Q1 == 'A1'"],
    ["SHORT", "R", 0, "1"],
  ]);
  assert.deepEqual(fake.answers.filter((item) => item.qid === result.question_id), []);
});

test("[GEN-A] LimeSurvey 6: the same Ranking question answers SPEC_INVALID at answers[0].code or .relevance and writes nothing", async () => {
  const { fake, sid, gid } = await setup(BASE, 6);
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, { survey_id: sid, group_id: gid(0), question: RANKING_QUESTION }), { fake });
  const paths = errorPaths(error);
  assert.ok(paths.some((path) => /^answers\[0\]\.(code|relevance)$/.test(path)), `paths: ${paths.join(", ")}`);
  // Reads (the version probe among them) are allowed, writes are not.
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

// ---- 20: default values and empty texts ----

test("[GEN-A] default on a question with subquestions (type M) answers SPEC_INVALID at default and writes nothing", async () => {
  const { fake, sid, gid } = await setup();
  const before = fake.requests.length;
  const error = await withSession((session) => addQuestionError(session, {
    survey_id: sid,
    group_id: gid(0),
    question: { code: "N1", type: "M", text: "Auswahl", default: "Y", subquestions: [{ code: "SQ1", text: "Eins" }] },
  }), { fake });
  assert.ok(errorPaths(error).includes("default"), `paths: ${errorPaths(error).join(", ")}`);
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

test("[GEN-A] an empty question text is only a warning: the question is created and the result lists the warning", async () => {
  const { fake, sid, gid } = await setup();
  const result = await withSession((session) => addQuestionOk(session, {
    survey_id: sid,
    group_id: gid(0),
    question: { code: "N1", type: "S", text: "" },
  }), { fake });
  const warnings = (result.warnings ?? []) as Array<{ path?: string }>;
  assert.ok(warnings.some((item) => item.path === "text" || String(item.path).startsWith("text.")), `warnings: ${JSON.stringify(result.warnings)}`);
  const created = fake.questions.find((item) => item.qid === result.question_id);
  assert.ok(created, "the question was created");
  assert.equal(created.l10n.de?.question, "");
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
});

// ---- 21: round trip from a survey built in the admin ----

const ADMIN_BUILT: SeedSurvey = {
  title: both("Oberfläche", "Surface"),
  groups: [
    {
      title: both("Erste", "First"),
      questions: [
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
          attributes: [{ name: "answer_order", value: "random" }, { name: "hidden", value: "0" }, { name: "button_size", value: "large" }],
          defaults: [{ text: both("1", "1") }, { specialtype: "other", text: both("Sonstiges", "Other") }],
          script: both("var a = 1;\r\nvar b = 2;", "var c = 3;"),
        },
        {
          code: "Q2",
          type: "S",
          mandatory: "Y",
          encrypted: true,
          preg: "^[a-z]+$",
          same_default: true,
          same_script: true,
          text: both("Kürzel", "Code"),
          attributes: [
            { name: "prefix", value: "km", language: "de" },
            { name: "prefix", value: "mi", language: "en" },
            { name: "maximum_chars", value: "20" },
          ],
          defaults: [{ text: { de: "hallo" } }],
          script: both("s();", "s();"),
        },
        {
          code: "Q3",
          type: "M",
          text: both("Auswahl", "Choice"),
          subquestions: [
            { code: "SM1", text: both("Erste", "First"), relevance: "Q1 == '1'" },
            { code: "SM2", text: both("", "") },
            { code: "SM3", text: both("Dritte", "Third") },
          ],
          defaults: [{ subquestion: "SM3", text: both("Y", "Y") }],
        },
        {
          code: "Q4",
          type: "R",
          text: both("Reihenfolge", "Order"),
          // LimeSurvey 7 stores Ranking entries as subquestions of type R (code up to 20 characters, with relevance).
          subquestions: [{ code: "LONGCODE1", text: both("Rot", "Red"), relevance: "Q1 == '1'" }, { code: "R2", text: both("Blau", "Blue") }],
        },
        {
          code: "Q5",
          type: "T",
          text: both("Anmerkung", "Remark"),
          help: both("Bitte kurz", "Keep it short"),
          attributes: [{ name: "plugin_hint", value: "Hinweis", language: "de" }, { name: "plugin_hint", value: "Hint", language: "en" }],
        },
      ],
    },
    { title: both("Zweite", "Second"), questions: [{ code: "Z1", type: "S", text: both("Ort", "Place") }] },
  ],
};

test("[GEN-A] round trip: get_survey_spec of a question built in the admin goes with another code into another group, and reads back the same except the code", async () => {
  const fake = new FakeLimeSurvey({ generation: 7 });
  const { sid, gids, qids } = seedSurvey(fake, ADMIN_BUILT);
  const target = gids[1];
  assert.ok(target !== undefined);
  await withSession(async (session) => {
    for (const code of ["Q1", "Q2", "Q3", "Q4", "Q5"]) {
      const original = await readOk(session, { survey_id: sid, question_id: qids[code] ?? 0 });
      assert.equal(original.spec.code, code);
      const newCode = `${code}N`;
      const added = await addQuestionOk(session, { survey_id: sid, group_id: target, question: { ...original.spec, code: newCode } });
      assert.equal(added.verification?.ok, true, `${code}: ${JSON.stringify(added.verification).slice(0, 2000)}`);
      const copy = await readOk(session, { survey_id: sid, question_id: Number(added.question_id) });
      assert.deepEqual(copy.spec, { ...original.spec, code: newCode }, `${code}: the copy differs from the original`);
      assert.deepEqual(copy.missing_translations, []);
      assert.equal(copy.position?.group_id, target);
    }
  }, { fake });
  assert.deepEqual(codesOf(fake, target), ["Z1", "Q1N", "Q2N", "Q3N", "Q4N", "Q5N"]);
});

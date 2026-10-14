import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type Generation } from "./helpers/fake-limesurvey.js";
import { envConfig } from "./helpers/mcp-session.js";
import { groupsOf, importSpec, mainQuestionsOf, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import {
  ADD_GROUP,
  addGroupError,
  addGroupOk,
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
 * GEN-C: limesurvey_add_group_from_spec inserts one new group with its questions, described as a group spec, at a given
 * place of an inactive survey: spec check against the live survey (every question code must be free, because the .lsg
 * import renames silently), .lsg with exactly the survey languages, import_group, position (only the new group is moved),
 * read-back through get_survey_spec and comparison with the spec. A failure after the import deletes the new group again
 * and nothing else.
 */

/** One language (de): group 1 with Q1 (L) and Q2, group 2 with Q3. */
const BASE: Json = {
  survey: { title: "Basis" },
  groups: [
    {
      title: "Gruppe 1",
      questions: [
        { code: "Q1", type: "L", text: "Wahl", answers: [{ code: "A1", text: "Eins" }, { code: "A2", text: "Zwei" }] },
        { code: "Q2", type: "S", text: "Name" },
      ],
    },
    { title: "Gruppe 2", questions: [{ code: "Q3", type: "T", text: "Anmerkung" }] },
  ],
};

/** Two languages (de, en): group 1 with Q1 (L), group 2 with Q2. */
const BILINGUAL: Json = {
  survey: { title: both("Basis", "Base"), language: "de", additional_languages: ["en"] },
  groups: [
    {
      title: both("Gruppe 1", "Group 1"),
      questions: [{ code: "Q1", type: "L", text: both("Wahl", "Choice"), answers: [{ code: "A1", text: both("Eins", "One") }, { code: "A2", text: both("Zwei", "Two") }] }],
    },
    { title: both("Gruppe 2", "Group 2"), questions: [{ code: "Q2", type: "S", text: both("Name", "Name") }] },
  ],
};

const NEW_GROUP: Json = {
  title: "Neue Gruppe",
  description: "Beschreibung",
  questions: [
    { code: "N1", type: "S", text: "Eins" },
    { code: "N2", type: "M", text: "Zwei", subquestions: [{ code: "SQ1", text: "Erste" }, { code: "SQ2", text: "Zweite" }] },
  ],
};

interface Base {
  fake: FakeLimeSurvey;
  sid: number;
  /** The group ids of the survey in their order, before the call. */
  gids: number[];
}

/** A fake with a survey created by create_survey_from_spec. */
async function setup(spec: Json = BASE, generation: Generation = 7): Promise<Base> {
  const fake = new FakeLimeSurvey({ generation });
  const sid = await importSpec(fake, spec);
  return { fake, sid, gids: groupsOf(fake, sid).map((group) => group.gid) };
}

const groupIds = (fake: FakeLimeSurvey, sid: number): number[] => groupsOf(fake, sid).map((group) => group.gid);

const WRITE_SET = new Set(["import_group", "set_group_properties"]);

// ---- the tool and its contract ----

test("[GEN-C] add_group_from_spec is registered with the annotations and the input of the contract, and takes no file path", async () => {
  await withSession(async (session) => {
    const tool = (await session.client.listTools()).tools.find((item) => item.name === ADD_GROUP);
    assert.ok(tool, `${ADD_GROUP} is not registered`);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, false);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.outputSchema, "the tool has an output schema");
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["group", "position", "survey_id"]);
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), ["group", "survey_id"]);
    assert.deepEqual(propertyNames(tool.inputSchema).filter((name) => /path|file/i.test(name)), [], "the tool takes no file parameter");
  });
});

// ---- 13: positions ----

type Place = "NEW" | 0 | 1;

const PLACES: Array<[label: string, positionOf: (gids: number[]) => Json | number | undefined, expected: Place[]]> = [
  ["the end (no position)", () => undefined, [0, 1, "NEW"]],
  ["position 1", () => 1, ["NEW", 0, 1]],
  ["{ after: <first group> }", (gids) => ({ after: gids[0] }), [0, "NEW", 1]],
];

for (const [label, positionOf, expected] of PLACES) {
  test(`[GEN-C] add_group_from_spec at ${label} puts the group at place ${expected.indexOf("NEW") + 1}, imports a .lsg and sends set_group_properties for the new group only`, async () => {
    const { fake, sid, gids } = await setup();
    const outline = surveyOutline(fake, sid);
    const position = positionOf(gids);
    const before = fake.requests.length;
    const result = await withSession((session) => addGroupOk(session, {
      survey_id: sid,
      group: NEW_GROUP,
      ...(position !== undefined ? { position } : {}),
    }), { fake });

    const newGid = result.group_id;
    const group = fake.groups.find((item) => item.gid === newGid);
    assert.ok(group && group.sid === sid, `group_id ${String(newGid)} is not a group of the survey`);
    assert.equal(result.survey_id, sid);
    assert.deepEqual(groupIds(fake, sid), expected.map((place) => (place === "NEW" ? newGid : gids[place])));
    assert.deepEqual(result.position, { index: expected.indexOf("NEW") + 1 });
    assert.deepEqual(group.l10n, { de: { group_name: "Neue Gruppe", description: "Beschreibung" } });

    const created = mainQuestionsOf(fake, newGid);
    assert.deepEqual(created.map((item) => item.title), ["N1", "N2"]);
    assert.deepEqual(result.questions, created.map((item) => ({ code: item.title, question_id: item.qid })));
    assert.deepEqual(fake.questions.filter((item) => item.parent_qid === created[1]?.qid).map((item) => item.title).sort(), ["SQ1", "SQ2"]);
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
    assert.deepEqual(result.verification.differences, []);
    assert.equal(result.verification.differences_total, 0);
    assert.equal(result.verification.truncated, false);
    assert.deepEqual(result.side_effects, []);

    for (const request of requestsSince(fake, before, "set_group_properties")) {
      assert.equal(request.params[1], newGid, `set_group_properties for ${String(request.params[1])}`);
    }
    assert.ok(writeMethodsSince(fake, before).every((method) => WRITE_SET.has(method)), writeMethodsSince(fake, before).join(", "));
    const imports = requestsSince(fake, before, "import_group");
    assert.equal(imports.length, 1, "one import_group");
    assert.equal(imports[0]?.params[1], sid);
    assert.equal(imports[0]?.params[3], "lsg");
    const file = parseStructureFile(imports[0]?.params[2]);
    assert.equal(file.docType, "Group");
    assert.deepEqual(file.languages, ["de"]);
    // The other groups keep their ids, names and questions.
    assert.deepEqual(surveyOutline(fake, sid).filter((item) => item.gid !== newGid), outline);
  });
}

// ---- ties of the group name are broken without help of the name ----

for (const [title, side] of [["Aaa Gruppe", "before"], ["Zzz Gruppe", "after"]] as const) {
  test(`[GEN-C] a group name that sorts ${side} its neighbours still lands at its place: "${title}" after the first group`, async () => {
    const { fake, sid, gids } = await setup();
    const [first, second] = gids;
    assert.ok(first !== undefined && second !== undefined);
    const result = await withSession((session) => addGroupOk(session, {
      survey_id: sid,
      group: { ...NEW_GROUP, title },
      position: { after: first },
    }), { fake });
    assert.deepEqual(groupIds(fake, sid), [first, result.group_id, second]);
    const orders = groupsOf(fake, sid).map((item) => item.group_order);
    assert.equal(new Set(orders).size, orders.length, `no two groups share a group_order: ${orders.join(", ")}`);
    assert.equal(fake.groups.find((item) => item.gid === result.group_id)?.l10n.de?.group_name, title, "the name is the final one");
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  });
}

// ---- 14 and 15: refused before anything is written ----

for (const code of ["Q1", "q2"]) {
  test(`[GEN-C] CODE_CONFLICT when a question of the new group uses the existing code ${code}: no import_group and no other write`, async () => {
    const { fake, sid } = await setup();
    const before = fake.requests.length;
    const error = await withSession((session) => addGroupError(session, {
      survey_id: sid,
      group: { title: "Neu", questions: [{ code: "N1", type: "S", text: "Eins" }, { code, type: "S", text: "Doppelt" }] },
    }), { fake });
    assert.equal(error.code, "CODE_CONFLICT", JSON.stringify(error).slice(0, 1500));
    assert.deepEqual(requestsSince(fake, before, "import_group"), []);
    assert.deepEqual(writeMethodsSince(fake, before), []);
  });
}

test("[GEN-C] an active survey answers SURVEY_ACTIVE and nothing is written", async () => {
  const { fake, sid } = await setup();
  fake.setActive(sid, true);
  const outline = surveyOutline(fake, sid);
  const before = fake.requests.length;
  const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP }), { fake });
  assert.equal(error.code, "SURVEY_ACTIVE", JSON.stringify(error).slice(0, 1500));
  assert.deepEqual(writeMethodsSince(fake, before), []);
  assert.deepEqual(surveyOutline(fake, sid), outline);
});

test("[GEN-C] a position after a group id that does not exist answers POSITION_INVALID and nothing is written", async () => {
  const { fake, sid } = await setup();
  const before = fake.requests.length;
  const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP, position: { after: 999999 } }), { fake });
  assert.equal(error.code, "POSITION_INVALID", JSON.stringify(error).slice(0, 1500));
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

test("[GEN-C] a position before a group of another survey answers POSITION_INVALID and nothing is written", async () => {
  const { fake, sid } = await setup();
  const otherSid = await importSpec(fake, BILINGUAL);
  const foreign = groupsOf(fake, otherSid)[0];
  assert.ok(foreign);
  const before = fake.requests.length;
  const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP, position: { before: foreign.gid } }), { fake });
  assert.equal(error.code, "POSITION_INVALID", JSON.stringify(error).slice(0, 1500));
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

test("[GEN-C] under the write scope none the tool answers WRITE_SCOPE_INSUFFICIENT and sends no request", async () => {
  const { fake, sid } = await setup();
  const before = fake.requests.length;
  const error = await withSession(
    (session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP }),
    { fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) },
  );
  assert.equal(error.code, "WRITE_SCOPE_INSUFFICIENT");
  assert.equal(fake.requests.length, before, "no request reached LimeSurvey");
});

// ---- 16: rollback ----

test("[GEN-C] when positioning fails, the new group is deleted again and nothing else: ADD_GROUP_FAILED with rolled_back", async () => {
  const { fake, sid } = await setup();
  const imported = captureResults(fake, "import_group");
  const outline = surveyOutline(fake, sid);
  fake.failNext("set_group_properties", { status: "Error: x", error_code: "ERR_UPDATE_FAILED" });
  const before = fake.requests.length;
  const error = await withSession((session) => addGroupError(session, { survey_id: sid, group: NEW_GROUP, position: 1 }), { fake });
  assert.equal(error.code, "ADD_GROUP_FAILED", JSON.stringify(error).slice(0, 1500));
  assert.ok(typeof error.details?.failed_step === "string" && error.details.failed_step.length > 0, JSON.stringify(error.details));
  assert.equal(error.details?.rolled_back, true);
  assert.equal(error.details?.manual_cleanup, false);

  assert.equal(imported.length, 1, "one group was imported");
  const newGid = Number(imported[0]);
  assert.ok(Number.isInteger(newGid) && newGid > 0, `import_group answered ${JSON.stringify(imported[0])}`);
  assert.deepEqual(
    requestsSince(fake, before, "delete_group").map((request) => [request.params[1], request.params[2]]),
    [[sid, newGid]],
    "exactly the new group is deleted",
  );
  assert.ok(!fake.groups.some((item) => item.gid === newGid), "the new group is gone");
  assert.ok(!fake.questions.some((item) => item.gid === newGid), "the questions of the new group are gone");
  assert.deepEqual(surveyOutline(fake, sid), outline, "every other group keeps its id, name, questions and place");
  assert.ok(
    writeMethodsSince(fake, before).every((method) => ["import_group", "set_group_properties", "delete_group"].includes(method)),
    writeMethodsSince(fake, before).join(", "),
  );
});

// ---- 17: two languages ----

test("[GEN-C] two languages: group title and question texts as maps verify; the .lsg names exactly de and en", async () => {
  const { fake, sid } = await setup(BILINGUAL);
  const before = fake.requests.length;
  const result = await withSession((session) => addGroupOk(session, {
    survey_id: sid,
    group: {
      title: both("Neu", "New"),
      description: both("Beschreibung", "Description"),
      questions: [{ code: "N1", type: "L", text: both("Frage", "Question"), answers: [{ code: "A1", text: both("Ja", "Yes") }] }],
    },
  }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const group = fake.groups.find((item) => item.gid === result.group_id);
  assert.ok(group);
  assert.deepEqual(group.l10n, {
    de: { group_name: "Neu", description: "Beschreibung" },
    en: { group_name: "New", description: "Description" },
  });
  const question = mainQuestionsOf(fake, group.gid)[0];
  assert.ok(question);
  assert.deepEqual(Object.fromEntries(Object.entries(question.l10n).map(([language, row]) => [language, row.question])), both("Frage", "Question"));
  assert.deepEqual(fake.answers.filter((item) => item.qid === question.qid).map((item) => item.l10n), [both("Ja", "Yes")]);
  const request = requestsSince(fake, before, "import_group")[0];
  assert.ok(request);
  assert.deepEqual([...parseStructureFile(request.params[2]).languages].sort(), ["de", "en"]);
});

test("[GEN-C] two languages: a group title or a question text without en answers SPEC_INVALID at title and questions[0].text and writes nothing", async () => {
  const { fake, sid } = await setup(BILINGUAL);
  const before = fake.requests.length;
  const error = await withSession((session) => addGroupError(session, {
    survey_id: sid,
    group: { title: { de: "Neu" }, questions: [{ code: "N1", type: "S", text: { de: "Frage" } }] },
  }), { fake });
  const paths = errorPaths(error);
  for (const path of ["title", "questions[0].text"]) assert.ok(paths.includes(path), `no error at ${path}; paths: ${paths.join(", ")}`);
  assert.deepEqual(writeMethodsSince(fake, before), []);
});

// ---- LimeSurvey 6 ----

test("[GEN-C] generation 6: a group is appended at the end and inserted at position 1", async () => {
  const { fake, sid, gids } = await setup(BASE, 6);
  await withSession(async (session) => {
    const end = await addGroupOk(session, { survey_id: sid, group: NEW_GROUP });
    assert.equal(end.verification?.ok, true, JSON.stringify(end.verification));
    assert.deepEqual(groupIds(fake, sid), [...gids, end.group_id]);
    assert.deepEqual(end.position, { index: 3 });

    const front = await addGroupOk(session, {
      survey_id: sid,
      group: { title: "Vorne", questions: [{ code: "V1", type: "S", text: "Vorne" }] },
      position: 1,
    });
    assert.equal(front.verification?.ok, true, JSON.stringify(front.verification));
    assert.deepEqual(groupIds(fake, sid), [front.group_id, ...gids, end.group_id]);
    assert.deepEqual(front.position, { index: 1 });
  }, { fake });
});

// ---- 23: Ranking and attributes per language ----

test("[GEN-C] LimeSurvey 7: a Ranking question of the group gets its entries as subquestions, and a plugin attribute map becomes one row per language", async () => {
  const { fake, sid } = await setup(BILINGUAL, 7);
  const before = fake.requests.length;
  const result = await withSession((session) => addGroupOk(session, {
    survey_id: sid,
    group: {
      title: both("Neu", "New"),
      questions: [
        {
          code: "R01",
          type: "R",
          text: both("Reihenfolge", "Order"),
          answers: [{ code: "LONGCODE1", text: both("Lang", "Long"), relevance: "Q1 == 'A1'" }, { code: "SHORT", text: both("Kurz", "Short") }],
        },
        { code: "S01", type: "S", text: both("Hinweis", "Hint"), attributes: { plugin_hint: both("Hinweis", "Hint") } },
      ],
    },
  }), { fake });
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));

  const request = requestsSince(fake, before, "import_group")[0];
  assert.ok(request);
  const file = parseStructureFile(request.params[2]);
  const fileQid = (code: string): string => {
    const row = (file.sections.questions ?? []).find((item) => item.title === code);
    assert.ok(row?.qid, `the .lsg has no question ${code}`);
    return row.qid;
  };
  const entries = (file.sections.subquestions ?? []).filter((row) => row.parent_qid === fileQid("R01"));
  assert.deepEqual(entries.map((row) => [row.title, row.type, row.scale_id]), [["LONGCODE1", "R", "0"], ["SHORT", "R", "0"]]);
  assert.equal(entries[0]?.relevance, "Q1 == 'A1'");
  const hintRows = (file.sections.question_attributes ?? [])
    .filter((row) => row.qid === fileQid("S01") && row.attribute === "plugin_hint")
    .map((row) => [row.language ?? "", row.value ?? ""])
    .sort();
  assert.deepEqual(hintRows, [["de", "Hinweis"], ["en", "Hint"]]);

  const [ranking, hint] = mainQuestionsOf(fake, Number(result.group_id));
  assert.ok(ranking && hint);
  assert.deepEqual(codesOf(fake, Number(result.group_id)), ["R01", "S01"]);
  const stored = fake.questions.filter((item) => item.parent_qid === ranking.qid).sort((a, b) => a.question_order - b.question_order);
  assert.deepEqual(stored.map((item) => [item.title, item.type, item.scale_id, item.relevance]), [
    ["LONGCODE1", "R", 0, "Q1 == 'A1'"],
    ["SHORT", "R", 0, "1"],
  ]);
  assert.deepEqual(fake.answers.filter((item) => item.qid === ranking.qid), []);
  assert.deepEqual(
    fake.attributes.filter((item) => item.qid === hint.qid && item.attribute === "plugin_hint").map((item) => [item.language, item.value]).sort(),
    [["de", "Hinweis"], ["en", "Hint"]],
  );
});

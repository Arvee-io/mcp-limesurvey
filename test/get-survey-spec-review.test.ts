import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type Generation } from "./helpers/fake-limesurvey.js";
import { paritySpec, resultOf } from "./helpers/mcp-session.js";
import { seedSurvey, type SeedQuestion, type SeedSurvey } from "./helpers/seed-survey.js";
import {
  create,
  createOk,
  groupsOf,
  importSpec,
  mainQuestionsOf,
  readOk,
  sortedMissing,
  validateSpec,
  withSession,
  writeMethodsSince,
  type Json,
} from "./helpers/spec-tools.js";

/**
 * GEN-D, review round of PR3: what a survey built in the LimeSurvey admin does to limesurvey_get_survey_spec and to the
 * round trip get_survey_spec -> create_survey_from_spec -> get_survey_spec.
 */

const both = (de: string, en: string) => ({ de, en });

// ---- 1: answer options without a text row in the base language ----

for (const index of [0, 1]) {
  test(`[GEN-D] answer ${index + 1} of S01 without a text row in the base language stays in the spec; the missing text is in missing_translations`, async () => {
    const fake = new FakeLimeSurvey();
    const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
    const question = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "S01");
    assert.ok(question);
    const options = fake.answers.filter((item) => item.qid === question.qid).sort((a, b) => a.sortorder - b.sortorder);
    const target = options[index];
    const other = options[1 - index];
    assert.ok(target?.l10n.de !== undefined && target.l10n.en !== undefined && other);
    const englishText = target.l10n.en;
    delete target.l10n.de;

    await withSession(async (session) => {
      const result = await readOk(session, { survey_id: sid });
      const answers = result.spec.groups[0].questions[0].answers as Json[];
      assert.deepEqual(answers.map((item) => item.code), ["1", "2"], "the answer without a base language text is kept, in the order of the question");
      assert.deepEqual(answers[index]?.text, { en: englishText }, "the fields that do not depend on the language come from the first language that has the answer");
      assert.equal(answers[index]?.assessment_value, target.assessment_value);
      assert.deepEqual(answers[1 - index]?.text, { de: other.l10n.de, en: other.l10n.en });
      assert.deepEqual(result.missing_translations, [{ path: `groups[0].questions[0].answers[${index}].text`, language: "de" }]);

      const alone = await readOk(session, { survey_id: sid, question_id: question.qid });
      assert.deepEqual(alone.missing_translations, [{ path: `answers[${index}].text`, language: "de" }]);
    }, { fake });
  });
}

// ---- 2: unreadable ----

const ALWAYS_UNREADABLE = ["legacy_conditions", "quota_members", "url_parameters", "undefined_attributes", "archived_responses"];

test("[GEN-D] unreadable always names the old conditions, quota members, URL parameters, undefined attributes and archived responses; survey_settings only at level survey", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const group = groupsOf(fake, sid)[0];
  const question = group ? mainQuestionsOf(fake, group.gid)[0] : undefined;
  assert.ok(group && question);
  await withSession(async (session) => {
    const levels: Array<[string, Json]> = [
      ["survey", await readOk(session, { survey_id: sid })],
      ["group", await readOk(session, { survey_id: sid, group_id: group.gid })],
      ["question", await readOk(session, { survey_id: sid, question_id: question.qid })],
    ];
    for (const [level, result] of levels) {
      const entries = result.unreadable as Array<{ code?: unknown; detail?: unknown }>;
      const codes = new Set(entries.map((item) => item.code));
      for (const code of ALWAYS_UNREADABLE) assert.ok(codes.has(code), `level ${level}: unreadable lacks ${code}; codes: ${[...codes].join(", ")}`);
      for (const item of entries) assert.ok(typeof item.detail === "string" && item.detail.trim().length > 0, `level ${level}: ${String(item.code)} has no detail`);
      assert.equal(codes.has("survey_settings"), level === "survey", `level ${level}: survey_settings`);
    }
  }, { fake });
});

test("[GEN-D] unreadable entries that point at an element carry path and language as fields, relative to the level", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const group = groupsOf(fake, sid)[0];
  const question = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "S01");
  assert.ok(group && question?.l10n.en, "the import must have created the English text row first");
  delete question.l10n.en;
  await withSession(async (session) => {
    const cases: Array<[string, Json, string[]]> = [
      ["survey", await readOk(session, { survey_id: sid }), ["groups[0].questions[0].answers[0].text", "groups[0].questions[0].answers[1].text"]],
      ["group", await readOk(session, { survey_id: sid, group_id: group.gid }), ["questions[0].answers[0].text", "questions[0].answers[1].text"]],
      ["question", await readOk(session, { survey_id: sid, question_id: question.qid }), ["answers[0].text", "answers[1].text"]],
    ];
    for (const [level, result, paths] of cases) {
      const entries = result.unreadable as Array<{ code?: string; detail?: string; path?: unknown; language?: unknown }>;
      for (const path of paths) {
        const found = entries.find((item) => item.path === path);
        assert.ok(found, `level ${level}: no unreadable entry with the path ${path}; entries: ${JSON.stringify(entries.map((item) => [item.code, item.path]))}`);
        assert.equal(found.language, "en", `level ${level}: ${path}`);
      }
      for (const item of entries.filter((entry) => entry.path !== undefined)) {
        assert.ok(typeof item.path === "string" && typeof item.language === "string" && item.language.length > 0, `level ${level}: an entry with a path needs a language: ${JSON.stringify(item)}`);
      }
    }
  }, { fake });
});

// ---- 3: language-dependent attributes of plugins ----

const PLUGIN_SURVEY: SeedSurvey = {
  title: both("Plugin", "Plugin"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [{
      code: "Q1",
      type: "S",
      text: both("Frage", "Question"),
      attributes: [
        { name: "plugin_hint", value: "Hinweis", language: "de" },
        { name: "plugin_hint", value: "Hint", language: "en" },
        { name: "prefix", value: "€", language: "de" },
        { name: "prefix", value: "EUR", language: "en" },
        { name: "plugin_flag", value: "1" },
      ],
    }],
  }],
};

test("[GEN-D] a language-dependent attribute the theme does not define (a plugin attribute) is a map per language in the spec", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, PLUGIN_SURVEY);
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid });
    const attributes = result.spec.groups[0].questions[0].attributes;
    assert.deepEqual(attributes, {
      plugin_flag: "1",
      plugin_hint: { de: "Hinweis", en: "Hint" },
      prefix: { de: "€", en: "EUR" },
    });
  }, { fake });
});

test("[GEN-D] the round trip keeps a plugin attribute stored per language: the new survey has one row per language", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, PLUGIN_SURVEY);
  await withSession(async (session) => {
    const first = await readOk(session, { survey_id: sid });
    const created = await createOk(session, first.spec);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    assert.deepEqual(created.verification.differences, []);
    const second = await readOk(session, { survey_id: Number(created.survey_id) });
    assert.deepEqual(second.spec, first.spec);
    assert.equal(second.fingerprint, first.fingerprint);

    const newQuestion = fake.questions.find((item) => item.sid === Number(created.survey_id) && item.title === "Q1");
    assert.ok(newQuestion);
    const rows = fake.attributes.filter((item) => item.qid === newQuestion.qid && item.attribute === "plugin_hint");
    assert.deepEqual(rows.map((item) => [item.language, item.value]).sort(), [["de", "Hinweis"], ["en", "Hint"]]);
  }, { fake });
});

// ---- 4: script and preg with CRLF ----

const CRLF_SURVEY: SeedSurvey = {
  title: both("Skript", "Script"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [{
      code: "Q1",
      type: "S",
      text: both("Frage", "Question"),
      script: { de: "  var a = '&amp;';\r\nvar b = 2;  ", en: "x\r\ny" },
      preg: "^a&amp;b\r\nc$",
    }],
  }],
};

test("[GEN-D] script and preg come out with LF, without trimming and without decoding entities", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, CRLF_SURVEY);
  await withSession(async (session) => {
    const question = (await readOk(session, { survey_id: sid })).spec.groups[0].questions[0];
    assert.deepEqual(question.script, { de: "  var a = '&amp;';\nvar b = 2;  ", en: "x\ny" });
    assert.equal(question.preg, "^a&amp;b\nc$");
  }, { fake });
});

test("[GEN-D] round trip of a survey whose script and preg have CRLF: the spec and the fingerprint stay the same", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, CRLF_SURVEY);
  await withSession(async (session) => {
    const first = await readOk(session, { survey_id: sid });
    const created = await createOk(session, first.spec);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    assert.deepEqual(created.verification.differences, []);
    const second = await readOk(session, { survey_id: Number(created.survey_id) });
    assert.deepEqual(second.spec, first.spec);
    assert.equal(second.fingerprint, first.fingerprint);
  }, { fake });
});

test("[GEN-D] create_survey_from_spec with CRLF in script and preg verifies cleanly: the import turns CRLF into LF, the comparison expects that", async () => {
  const spec = {
    survey: { title: "Skript" },
    groups: [{
      title: "Gruppe",
      questions: [{ code: "Q1", type: "S", text: "Frage", script: { de: "a();\r\nb();" }, preg: "x\r\ny" }],
    }],
  };
  const fake = new FakeLimeSurvey();
  await withSession(async (session) => {
    const created = await createOk(session, spec);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    const question = (await readOk(session, { survey_id: Number(created.survey_id) })).spec.groups[0].questions[0];
    assert.deepEqual(question.script, { de: "a();\nb();" });
    assert.equal(question.preg, "x\ny");
  }, { fake });
});

// ---- 5: empty texts ----

const EMPTY_TEXTS: SeedSurvey = {
  title: both("Leere Texte", "Empty texts"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      {
        code: "Q1",
        type: "M",
        text: both("Auswahl", "Choice"),
        subquestions: [{ code: "SM1", text: both("", "") }, { code: "SM2", text: both("Zwei", "Two") }],
      },
      {
        code: "Q2",
        type: "L",
        text: both("Wahl", "Pick"),
        answers: [{ code: "A1", text: both("", "") }, { code: "A2", text: both("Zwei", "Two") }],
      },
    ],
  }],
};

test("[GEN-D] a survey with an empty subquestion text and an empty answer text is valid (a warning), and the round trip keeps it", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, EMPTY_TEXTS);
  await withSession(async (session) => {
    const first = await readOk(session, { survey_id: sid });
    const questions = first.spec.groups[0].questions as Json[];
    assert.deepEqual(questions[0]?.subquestions[0]?.text, { de: "", en: "" });
    assert.deepEqual(questions[1]?.answers[0]?.text, { de: "", en: "" });

    const validated = await validateSpec(session, first.spec);
    assert.equal(validated.valid, true, JSON.stringify(validated.errors));
    const warned = (validated.warnings as Array<{ path: string }>).map((item) => item.path);
    for (const path of ["groups[0].questions[0].subquestions[0].text", "groups[0].questions[1].answers[0].text"]) {
      assert.ok(warned.some((item) => item === path || item.startsWith(`${path}.`)), `no warning at ${path}; warnings: ${warned.join(", ")}`);
    }

    const created = await createOk(session, first.spec);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    const second = await readOk(session, { survey_id: Number(created.survey_id) });
    assert.deepEqual(second.spec, first.spec);
    assert.equal(second.fingerprint, first.fingerprint);
  }, { fake });
});

// ---- 6: Ranking on LimeSurvey 7 and 6 ----

/** A survey with a Ranking question whose first entry has a long code and a relevance. */
function rankingSpec(first: { code: string; relevance?: string }): Json {
  return {
    survey: { title: "Ranking" },
    groups: [{
      title: "Gruppe",
      questions: [
        { code: "Q1", type: "L", text: "Wahl", answers: [{ code: "A1", text: "Eins" }, { code: "A2", text: "Zwei" }] },
        {
          code: "R01",
          type: "R",
          text: "Reihenfolge",
          answers: [{ code: first.code, text: "Lang", ...(first.relevance !== undefined ? { relevance: first.relevance } : {}) }, { code: "SHORT", text: "Kurz" }],
        },
      ],
    }],
  };
}

const LONG_ENTRY = { code: "LONGCODE1", relevance: "Q1 == 'A1'" };

const RANKING_SEVEN: SeedSurvey = {
  title: { de: "Ranking" },
  groups: [{
    title: { de: "Gruppe" },
    questions: [
      { code: "Q1", type: "L", text: { de: "Wahl" }, answers: [{ code: "A1", text: { de: "Eins" } }, { code: "A2", text: { de: "Zwei" } }] },
      {
        code: "R01",
        type: "R",
        text: { de: "Reihenfolge" },
        // LimeSurvey 7 stores the entries as subquestions of type R; the code may have 20 characters and the entry a relevance.
        subquestions: [{ code: "LONGCODE1", text: { de: "Lang" }, relevance: "Q1 == 'A1'" }, { code: "SHORT", text: { de: "Kurz" } }],
      },
    ],
  }],
};

test("[GEN-D] LimeSurvey 7: a Ranking entry with a long code and a relevance is read as an answer, and the round trip keeps both", async () => {
  const fake = new FakeLimeSurvey({ generation: 7 });
  const { sid } = seedSurvey(fake, RANKING_SEVEN);
  await withSession(async (session) => {
    const first = await readOk(session, { survey_id: sid });
    const answers = first.spec.groups[0].questions[1].answers as Json[];
    assert.deepEqual(answers.map((item) => [item.code, item.relevance]), [["LONGCODE1", "Q1 == 'A1'"], ["SHORT", undefined]]);

    const created = await createOk(session, first.spec);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    assert.deepEqual(created.verification.differences, []);
    const second = await readOk(session, { survey_id: Number(created.survey_id) });
    assert.deepEqual(second.spec, first.spec);
    assert.equal(second.fingerprint, first.fingerprint);
  }, { fake });
});

test("[GEN-D] LimeSurvey 7: create_survey_from_spec writes the Ranking entries as subquestions of type R (scale 0, with relevance), not as answers", async () => {
  const fake = new FakeLimeSurvey({ generation: 7 });
  await withSession(async (session) => {
    const created = await createOk(session, rankingSpec(LONG_ENTRY));
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    const sid = Number(created.survey_id);
    const ranking = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "R01");
    assert.ok(ranking);
    const entries = fake.questions.filter((item) => item.parent_qid === ranking.qid).sort((a, b) => a.question_order - b.question_order);
    assert.deepEqual(entries.map((item) => [item.title, item.type, item.scale_id, item.relevance]), [
      ["LONGCODE1", "R", 0, "Q1 == 'A1'"],
      ["SHORT", "R", 0, "1"],
    ]);
    assert.deepEqual(fake.answers.filter((item) => item.qid === ranking.qid), []);
  }, { fake });
});

const PROBE = (request: { method: string; params: unknown[] }): boolean => request.method === "get_group_properties";

test("[GEN-D] LimeSurvey 6: the Ranking entry with a long code and a relevance is refused at its paths, after one read probe and without a write", async () => {
  const fake = new FakeLimeSurvey({ generation: 6 });
  await withSession(async (session) => {
    const response = await create(session, rankingSpec(LONG_ENTRY));
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "SPEC_INVALID");
    const paths = (result.details?.errors as Array<{ path: string }>).map((item) => item.path);
    assert.ok(
      paths.some((path) => /^groups\[0\]\.questions\[1\]\.answers\[0\]\.(relevance|code)$/.test(path)),
      `no error at the code or the relevance of the entry; paths: ${paths.join(", ")}`,
    );
    assert.deepEqual(writeMethodsSince(fake, 0), []);
    const probes = fake.requests.filter(PROBE);
    assert.equal(probes.length, 1, "the version is probed with one read");
    assert.equal(probes[0]?.params[1], 0);
    assert.deepEqual(probes[0]?.params[2], ["gid"]);
  }, { fake });
});

for (const [label, entry, path] of [
  ["a relevance", { code: "LC1", relevance: "Q1 == 'A1'" }, "relevance"],
  ["a code of nine characters", { code: "LONGCODE1" }, "code"],
] as const) {
  test(`[GEN-D] LimeSurvey 6: a Ranking entry with ${label} is refused at answers[0].${path}`, async () => {
    const fake = new FakeLimeSurvey({ generation: 6 });
    await withSession(async (session) => {
      const response = await create(session, rankingSpec(entry));
      assert.equal(response.isError, true);
      const result = resultOf(response);
      assert.equal(result.code, "SPEC_INVALID");
      const paths = (result.details?.errors as Array<{ path: string }>).map((item) => item.path);
      assert.ok(paths.includes(`groups[0].questions[1].answers[0].${path}`), `paths: ${paths.join(", ")}`);
      assert.deepEqual(writeMethodsSince(fake, 0), []);
    }, { fake });
  });
}

test("[GEN-D] the version of LimeSurvey is probed once per client (LimeSurvey 7: two creates, LimeSurvey 6: two refused creates)", async () => {
  for (const generation of [7, 6] as const) {
    const fake = new FakeLimeSurvey({ generation });
    await withSession(async (session) => {
      for (let round = 0; round < 2; round += 1) {
        const response = await create(session, rankingSpec(generation === 7 ? LONG_ENTRY : { code: "LC1", relevance: "Q1 == 'A1'" }));
        assert.equal(response.isError, generation === 7 ? undefined : true, `generation ${generation}, round ${round}: ${JSON.stringify(response.structuredContent).slice(0, 400)}`);
      }
      const probes = fake.requests.filter(PROBE);
      assert.equal(probes.length, 1, `generation ${generation}: ${probes.length} probes`);
      assert.deepEqual(probes[0]?.params.slice(1), [0, ["gid"]]);
    }, { fake });
  }
});

// ---- 8: a survey built in the admin, both generations ----

function adminSurvey(generation: Generation): SeedSurvey {
  const ranking: SeedQuestion = generation === 7
    ? {
      code: "Q6",
      type: "R",
      text: both("Reihenfolge", "Order"),
      subquestions: [{ code: "R1", text: both("Rot", "Red") }, { code: "R2", text: both("Blau", "Blue") }],
    }
    : {
      code: "Q6",
      type: "R",
      text: both("Reihenfolge", "Order"),
      answers: [{ code: "R1", text: both("Rot", "Red") }, { code: "R2", text: both("Blau", "Blue") }],
    };
  return {
    title: both("Rundlauf", "Round trip"),
    groups: [
      {
        title: both("Allgemein", "General"),
        description: both("Einstieg", "Start"),
        questions: [
          {
            code: "Q1",
            type: "L",
            theme: "bootstrap_buttons",
            mandatory: "S",
            other: true,
            text: both("Wie zufrieden?\r\nBitte wählen", "How satisfied?\r\nPlease choose"),
            help: both("Hilfe&nbsp;Text", "Help"),
            // The codes 0..n-1 make PHP answer a list instead of an object.
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
            type: "F",
            text: both("Matrix", "Matrix"),
            subquestions: [{ code: "SQ1", text: both("Zeile", "Row") }],
            answers: [
              { code: "1", text: both("eins", "one"), assessment_value: 1 },
              { code: "2", text: both("zwei", "two"), assessment_value: 2 },
              { code: "3", text: both("drei", "three"), assessment_value: 3 },
            ],
          },
        ],
      },
      {
        title: both("Details", "Details"),
        relevance: "Q1 == '1'",
        randomization_group: "rg1",
        questions: [
          {
            code: "Q5",
            type: "T",
            text: both("Anmerkung", "Remark"),
            help: both("Bitte kurz", "Keep it short"),
            attributes: [
              { name: "plugin_hint", value: "Hinweis", language: "de" },
              { name: "plugin_hint", value: "Hint", language: "en" },
            ],
          },
          ranking,
        ],
      },
    ],
  };
}

for (const generation of [7, 6] as const) {
  test(`[GEN-D] round trip of a survey built in the admin on generation ${generation}: create_survey_from_spec verifies cleanly and the new survey reads back the same`, async () => {
    const fake = new FakeLimeSurvey({ generation });
    const { sid } = seedSurvey(fake, adminSurvey(generation));
    await withSession(async (session) => {
      const first = await readOk(session, { survey_id: sid });
      // What the admin built must be in the spec, otherwise the round trip would pass by leaving it out.
      const [q1, q2, q3, , q5] = [...first.spec.groups[0].questions, ...first.spec.groups[1].questions] as Json[];
      assert.deepEqual(q1?.answers.map((item: Json) => item.code), ["0", "1", "2"]);
      assert.equal(q1?.question_theme_name, "bootstrap_buttons");
      assert.equal(q1?.mandatory, "soft");
      assert.deepEqual(q1?.default, both("1", "1"));
      assert.deepEqual(q1?.default_other, both("Sonstiges", "Other"));
      assert.deepEqual(q1?.script, both("var a = 1;\nvar b = 2;", "var c = 3;"));
      assert.equal(q2?.same_default, true);
      assert.equal(q2?.default, "hallo");
      assert.equal(q2?.encrypted, true);
      assert.equal(q2?.preg, "^[a-z]+$");
      assert.deepEqual(q2?.attributes, { maximum_chars: "20", prefix: both("km", "mi") });
      assert.equal(q3?.subquestions[0]?.relevance, "Q1 == '1'");
      assert.deepEqual(q3?.subquestions[1]?.text, both("", ""));
      assert.deepEqual(q3?.subquestions[2]?.default, both("Y", "Y"));
      assert.deepEqual(q5?.attributes, { plugin_hint: both("Hinweis", "Hint") });
      assert.equal(first.spec.groups[1].randomization_group, "rg1");

      const created = await createOk(session, first.spec);
      assert.equal(created.verification.ok, true, JSON.stringify(created.verification).slice(0, 2000));
      assert.deepEqual(created.verification.differences, []);
      const second = await readOk(session, { survey_id: Number(created.survey_id) });
      assert.deepEqual(second.spec, first.spec);
      assert.equal(second.fingerprint, first.fingerprint);
      assert.deepEqual(sortedMissing(second.missing_translations), sortedMissing(first.missing_translations));
    }, { fake });
  });
}

// ---- 9: smaller findings ----

test("[GEN-D] missing_translations names every field of a missing question row: text and help", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const question = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "S01");
  assert.ok(question?.l10n.en);
  delete question.l10n.en;
  await withSession(async (session) => {
    const missing = (await readOk(session, { survey_id: sid })).missing_translations as Array<{ path: string; language: string }>;
    const paths = missing.map((item) => item.path);
    for (const path of ["groups[0].questions[0].text", "groups[0].questions[0].help"]) assert.ok(paths.includes(path), `${path} is not reported; paths: ${paths.join(", ")}`);
    assert.ok(missing.every((item) => item.language === "en" && /^groups\[0\]\.questions\[0\]\.(text|help|script)$/.test(item.path)), JSON.stringify(missing));
  }, { fake });
});

test("[GEN-D] missing_translations names every field of a missing group row: title and description", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const group = groupsOf(fake, sid)[0];
  assert.ok(group?.l10n.en);
  delete group.l10n.en;
  await withSession(async (session) => {
    const missing = sortedMissing((await readOk(session, { survey_id: sid })).missing_translations);
    assert.deepEqual(missing, [
      { path: "groups[0].description", language: "en" },
      { path: "groups[0].title", language: "en" },
    ]);
    const alone = sortedMissing((await readOk(session, { survey_id: sid, group_id: group.gid })).missing_translations);
    assert.deepEqual(alone, [{ path: "description", language: "en" }, { path: "title", language: "en" }]);
  }, { fake });
});

test("[GEN-D] missing_translations names every text of a missing survey language row: title, description, welcometext and endtext", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const survey = fake.surveys.find((item) => item.sid === sid);
  assert.ok(survey?.languagesettings.en);
  delete survey.languagesettings.en;
  await withSession(async (session) => {
    const missing = sortedMissing((await readOk(session, { survey_id: sid })).missing_translations);
    assert.deepEqual(missing, [
      { path: "survey.description", language: "en" },
      { path: "survey.endtext", language: "en" },
      { path: "survey.title", language: "en" },
      { path: "survey.welcometext", language: "en" },
    ]);
  }, { fake });
});

test("[GEN-D] the spec does not trim: an attribute value with a leading space keeps it, and the round trip holds", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, {
    title: both("Leerzeichen", "Blanks"),
    groups: [{
      title: both("Gruppe", "Group"),
      questions: [{
        code: "Q1",
        type: "N",
        text: both("Strecke", "Distance"),
        attributes: [{ name: "suffix", value: " km", language: "de" }, { name: "suffix", value: " mi", language: "en" }],
      }],
    }],
  });
  await withSession(async (session) => {
    const first = await readOk(session, { survey_id: sid });
    assert.deepEqual(first.spec.groups[0].questions[0].attributes, { suffix: { de: " km", en: " mi" } });
    const created = await createOk(session, first.spec);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    const second = await readOk(session, { survey_id: Number(created.survey_id) });
    assert.deepEqual(second.spec, first.spec);
  }, { fake });
});

test("[GEN-D] the comparison after the import ignores surrounding blanks: a text that LimeSurvey stores trimmed is no difference", async () => {
  const spec = {
    survey: { title: "Rand" },
    groups: [{ title: "Gruppe", questions: [{ code: "Q1", type: "S", text: "  Frage mit Rand  ", attributes: { suffix: " km" } }] }],
  };
  const fake = new FakeLimeSurvey();
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  target.fetch = async (input, init) => {
    const response = await original(input, init);
    if ((JSON.parse(String(init?.body)) as { method?: string }).method === "import_survey") {
      for (const item of fake.questions) for (const row of Object.values(item.l10n)) row.question = row.question.trim();
      for (const item of fake.attributes) item.value = item.value.trim();
    }
    return response;
  };
  await withSession(async (session) => {
    const created = await createOk(session, spec);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
  }, { fake });
});

test("[GEN-D] question_theme_name core is the base theme: it is not in the spec and the attribute values of the base theme are left out", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, {
    title: both("Kern", "Core"),
    groups: [{
      title: both("Gruppe", "Group"),
      questions: [{
        code: "Q1",
        type: "L",
        theme: "core",
        text: both("Wahl", "Pick"),
        answers: [{ code: "A1", text: both("Eins", "One") }],
        attributes: [{ name: "answer_order", value: "normal" }, { name: "display_columns", value: "2" }],
      }],
    }],
  });
  await withSession(async (session) => {
    const question = (await readOk(session, { survey_id: sid })).spec.groups[0].questions[0];
    assert.ok(!Object.hasOwn(question, "question_theme_name"), `question_theme_name: ${String(question.question_theme_name)}`);
    assert.deepEqual(question.attributes, { display_columns: "2" });
  }, { fake });
});

const DEFAULT_TYPES: SeedSurvey = {
  title: both("Defaults", "Defaults"),
  groups: [{
    title: both("Gruppe", "Group"),
    questions: [
      { code: "Q1", type: "X", text: both("Hinweis", "Note"), defaults: [{ text: both("Vorgabe", "Preset") }] },
      { code: "Q2", type: "S", text: both("Eingabe", "Input"), defaults: [{ text: both("hallo", "hello") }] },
      { code: "Q3", type: "|", text: both("Datei", "File"), defaults: [{ text: both("x", "x") }] },
    ],
  }],
};

test("[GEN-D] default values are read for every type except R and |: a boilerplate question has its default, a file upload has none", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, DEFAULT_TYPES);
  await withSession(async (session) => {
    const questions = (await readOk(session, { survey_id: sid })).spec.groups[0].questions as Json[];
    assert.deepEqual(questions[0]?.default, { de: "Vorgabe", en: "Preset" });
    assert.deepEqual(questions[1]?.default, { de: "hallo", en: "hello" });
    assert.ok(!Object.hasOwn(questions[2] ?? {}, "default"), "a file upload question has no default in the spec");
  }, { fake });
});

test("[GEN-D] a boilerplate question alone still has its default (level question)", async () => {
  const fake = new FakeLimeSurvey();
  const { sid, qids } = seedSurvey(fake, {
    title: both("Hinweis", "Note"),
    groups: [{
      title: both("Gruppe", "Group"),
      questions: [{ code: "Q1", type: "X", text: both("Hinweis", "Note"), defaults: [{ text: both("Vorgabe", "Preset") }] }],
    }],
  });
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid, question_id: qids.Q1 ?? 0 });
    assert.deepEqual(result.spec.default, { de: "Vorgabe", en: "Preset" });
    const checked = await validateSpec(session, result.spec, { kind: "question" });
    assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  }, { fake });
});

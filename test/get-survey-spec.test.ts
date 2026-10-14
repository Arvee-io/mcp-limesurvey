import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type Generation } from "./helpers/fake-limesurvey.js";
import { connectFake, envConfig, paritySpec, resultOf, type Session } from "./helpers/mcp-session.js";
import { seedSurvey, type SeedSurvey } from "./helpers/seed-survey.js";

/**
 * GEN-D: limesurvey_get_survey_spec reads a survey, one group or one question as a spec (texts always as a map per
 * language) with read methods only. The spec is what the matching write tool takes unchanged; the envelope adds the
 * ids, a fingerprint and what RemoteControl cannot read.
 */

const GET = "limesurvey_get_survey_spec";
const CREATE = "limesurvey_create_survey_from_spec";
const VALIDATE = "limesurvey_validate_spec";

type Json = Record<string, any>;
type Args = { survey_id: number; group_id?: number; question_id?: number };

async function withSession<T>(
  run: (session: Session) => Promise<T>,
  options: { fake?: FakeLimeSurvey; config?: ReturnType<typeof envConfig> } = {},
): Promise<T> {
  const session = await connectFake(options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

/** Creates a survey in the fake with create_survey_from_spec (default write scope) and returns its survey ID. */
async function importSpec(fake: FakeLimeSurvey, spec: unknown): Promise<number> {
  return withSession(async (session) => {
    const response = await session.client.callTool({ name: CREATE, arguments: { spec } });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    const result = resultOf(response);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    return Number(result.survey_id);
  }, { fake });
}

const read = (session: Session, args: Args) => session.client.callTool({ name: GET, arguments: args });

async function readOk(session: Session, args: Args): Promise<Json> {
  const response = await read(session, args);
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
  assert.equal((response.structuredContent as { workflow?: string } | undefined)?.workflow, "get_survey_spec");
  return resultOf(response);
}

const groupsOf = (fake: FakeLimeSurvey, sid: number) => fake.groups
  .filter((group) => group.sid === sid)
  .sort((a, b) => a.group_order - b.group_order);

const mainQuestionsOf = (fake: FakeLimeSurvey, gid: number) => fake.questions
  .filter((question) => question.gid === gid && question.parent_qid === 0)
  .sort((a, b) => a.question_order - b.question_order);

/** The ids section of a survey-level answer, derived from the state of the fake. */
function expectedSurveyIds(fake: FakeLimeSurvey, sid: number): Json {
  const groups = groupsOf(fake, sid);
  return {
    groups: groups.map((group, index) => ({ path: `groups[${index}]`, group_id: group.gid })),
    questions: groups.flatMap((group, groupIndex) => mainQuestionsOf(fake, group.gid).map((question, index) => ({
      path: `groups[${groupIndex}].questions[${index}]`,
      code: question.title,
      question_id: question.qid,
    }))),
  };
}

/** The questions of the first group of a survey-level answer, by question code. */
const questionsByCode = (result: Json): Map<string, Json> => new Map(
  (result.spec.groups[0].questions as Json[]).map((question): [string, Json] => [String(question.code), question]),
);

const HEX_64 = /^[0-9a-f]{64}$/;

// ---- the tool and its contract ----

test("[GEN-D] get_survey_spec is registered with the annotations and the input of the design, and takes no file path", async () => {
  await withSession(async (session) => {
    const listed = await session.client.listTools();
    const tool = listed.tools.find((item) => item.name === GET);
    assert.ok(tool, `${GET} is not registered`);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.outputSchema, "the tool has an output schema");
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["group_id", "question_id", "survey_id"]);
    assert.deepEqual(tool.inputSchema.required, ["survey_id"]);
  });
});

// ---- level survey ----

test("[GEN-D] get_survey_spec reads a two-language survey as a spec with texts per language, ids, a fingerprint and the unreadable parts (p04)", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid });
    assert.equal(result.level, "survey");
    assert.equal(result.survey_id, sid);
    assert.deepEqual(result.languages, ["de", "en"]);
    assert.equal(result.active, false);

    const title = "Kundenbefragung „Service“ 2026";
    assert.deepEqual(result.spec.survey.title, { de: title, en: title });
    assert.equal(result.spec.survey.language, "de");
    assert.deepEqual(result.spec.survey.additional_languages, ["en"]);
    assert.deepEqual(
      result.spec.groups.map((group: Json) => group.questions.map((question: Json) => question.code)),
      [["S01", "S02", "S03"], ["T01"]],
    );

    assert.deepEqual(result.ids, expectedSurveyIds(fake, sid));
    assert.match(String(result.fingerprint), HEX_64);
    assert.deepEqual(result.missing_translations, []);

    assert.ok(Array.isArray(result.unreadable), `unreadable is ${JSON.stringify(result.unreadable)}`);
    const unreadable = result.unreadable as Array<{ code?: unknown; detail?: unknown }>;
    const codes = new Set(unreadable.map((item) => item.code));
    for (const code of ["legacy_conditions", "quota_members", "url_parameters"]) {
      assert.ok(codes.has(code), `unreadable lacks ${code}; codes: ${[...codes].join(", ")}`);
    }
    for (const item of unreadable) {
      assert.ok(typeof item.detail === "string" && item.detail.trim().length > 0, `unreadable entry ${String(item.code)} has no detail`);
    }
  }, { fake });
});

async function roundTrip(name: string, generation: Generation): Promise<void> {
  const fake = new FakeLimeSurvey({ generation });
  const sid = await importSpec(fake, await paritySpec(name));
  await withSession(async (session) => {
    const first = await readOk(session, { survey_id: sid });
    // The spec of the first reading goes into the write tool unchanged.
    const response = await session.client.callTool({ name: CREATE, arguments: { spec: first.spec } });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 1500));
    const created = resultOf(response);
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    assert.notEqual(created.survey_id, sid, "a second survey was created");

    const second = await readOk(session, { survey_id: Number(created.survey_id) });
    assert.deepEqual(second.spec, first.spec);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.deepEqual(second.missing_translations, []);
    assert.deepEqual(second.languages, first.languages);
  }, { fake });
}

for (const name of ["p01-plugin-example", "p04-languages-settings"]) {
  test(`[GEN-D] round trip: the spec read from ${name} creates a survey that reads back the same, with the same fingerprint`, async () => {
    await roundTrip(name, 7);
  });
}

test("[GEN-D] generation 6: the survey level works without error_code fields, and the round trip holds (p01, with the Ranking question)", async () => {
  await roundTrip("p01-plugin-example", 6);
});

test("[GEN-D] generation 6: a two-language survey is read with texts per language (p04)", async () => {
  const fake = new FakeLimeSurvey({ generation: 6 });
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid });
    assert.deepEqual(result.languages, ["de", "en"]);
    const title = "Kundenbefragung „Service“ 2026";
    assert.deepEqual(result.spec.survey.title, { de: title, en: title });
    assert.deepEqual(result.ids, expectedSurveyIds(fake, sid));
    assert.deepEqual(result.missing_translations, []);
  }, { fake });
});

test("[GEN-D] the fingerprint changes with the content and is the same for equal content; a group keeps its fingerprint when another group changes", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p01-plugin-example"));
  const [first, second] = groupsOf(fake, sid);
  assert.ok(first && second);
  await withSession(async (session) => {
    const before = await readOk(session, { survey_id: sid });
    const again = await readOk(session, { survey_id: sid });
    assert.equal(again.fingerprint, before.fingerprint, "reading twice gives the same fingerprint");
    const secondBefore = await readOk(session, { survey_id: sid, group_id: second.gid });

    const question = mainQuestionsOf(fake, first.gid)[0];
    assert.ok(question?.l10n.de);
    question.l10n.de.question = "Ein anderer Text";

    const after = await readOk(session, { survey_id: sid });
    assert.notEqual(after.fingerprint, before.fingerprint, "the survey fingerprint follows a changed text");
    const secondAfter = await readOk(session, { survey_id: sid, group_id: second.gid });
    assert.equal(secondAfter.fingerprint, secondBefore.fingerprint, "the other group did not change");
    const firstAfter = await readOk(session, { survey_id: sid, group_id: first.gid });
    assert.equal(firstAfter.spec.questions[0].text.de, "Ein anderer Text");
  }, { fake });
});

// ---- level group ----

test("[GEN-D] get_survey_spec reads one group: the group spec, its position, ids, and a spec that validate_spec accepts (p01)", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p01-plugin-example"));
  const [first, second] = groupsOf(fake, sid);
  assert.ok(first && second);
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid, group_id: second.gid });
    assert.equal(result.level, "group");
    assert.equal(result.survey_id, sid);
    assert.equal(result.group_id, second.gid);
    assert.deepEqual(result.languages, ["de"]);
    assert.equal(result.active, false);
    assert.deepEqual(result.spec.title, { de: "Block B — Details" });
    assert.deepEqual(result.spec.description, { de: "" });
    assert.equal(result.spec.relevance, "1");
    assert.deepEqual(
      result.spec.questions.map((question: Json) => question.code),
      ["B01", "B02", "B03", "B04", "B05", "B06", "B07"],
      "the questions come in the order of the group",
    );
    assert.deepEqual(result.position, { index: 2 });
    assert.deepEqual(result.ids, {
      group_id: second.gid,
      questions: mainQuestionsOf(fake, second.gid).map((question, index) => ({
        path: `questions[${index}]`,
        code: question.title,
        question_id: question.qid,
      })),
    });
    assert.match(String(result.fingerprint), HEX_64);
    assert.deepEqual(result.missing_translations, []);
    assert.ok(Array.isArray(result.unreadable));

    const firstResult = await readOk(session, { survey_id: sid, group_id: first.gid });
    assert.deepEqual(firstResult.position, { index: 1 });

    // The group spec is the group of the survey spec.
    const whole = await readOk(session, { survey_id: sid });
    assert.deepEqual(whole.spec.groups[1], result.spec);

    // The group spec is a valid group description, with and without the survey: with the survey, only the codes that
    // the survey itself already uses may be reported.
    const alone = resultOf(await session.client.callTool({ name: VALIDATE, arguments: { kind: "group", spec: result.spec } }));
    assert.equal(alone.valid, true, JSON.stringify(alone.errors));
    const against = resultOf(await session.client.callTool({ name: VALIDATE, arguments: { kind: "group", spec: result.spec, survey_id: sid } }));
    const others = (against.errors as Array<{ path: string }>).filter((item) => !/^questions\[\d+\]\.code$/.test(item.path));
    assert.deepEqual(others, [], JSON.stringify(against.errors));
  }, { fake });
});

// ---- level question ----

test("[GEN-D] get_survey_spec reads one question: the question spec, its position, ids, and a spec that validate_spec accepts (p01)", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p01-plugin-example"));
  const [first, second] = groupsOf(fake, sid);
  assert.ok(first && second);
  const matrix = mainQuestionsOf(fake, second.gid).find((question) => question.title === "B05");
  const number = mainQuestionsOf(fake, first.gid).find((question) => question.title === "A06");
  assert.ok(matrix && number);
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid, question_id: matrix.qid });
    assert.equal(result.level, "question");
    assert.equal(result.survey_id, sid);
    assert.equal(result.question_id, matrix.qid);
    assert.deepEqual(result.languages, ["de"]);
    assert.equal(result.active, false);
    assert.deepEqual(result.position, { group_id: second.gid, index: 5 });
    assert.deepEqual(result.ids, { question_id: matrix.qid, group_id: second.gid });
    assert.equal(result.spec.code, "B05");
    assert.equal(result.spec.type, "F");
    assert.deepEqual(result.spec.text, { de: "Wie zufrieden sind Sie mit den folgenden Aspekten?" });
    assert.equal(result.spec.mandatory, false);
    assert.deepEqual(
      result.spec.subquestions.map((item: Json) => [item.code, item.text]),
      [["SQ001", { de: "Führungskräfte-Feedback" }], ["SQ002", { de: "Teamarbeit und Unterstützung" }]],
    );
    assert.deepEqual(
      result.spec.answers.map((item: Json) => [item.code, item.text.de, item.assessment_value]),
      [["A1", "überhaupt nicht zufrieden", 1], ["A2", "eher nicht zufrieden", 2], ["A3", "teils/teils", 3], ["A4", "eher zufrieden", 4], ["A5", "sehr zufrieden", 5]],
    );
    assert.match(String(result.fingerprint), HEX_64);
    assert.deepEqual(result.missing_translations, []);
    assert.ok(Array.isArray(result.unreadable));

    const whole = await readOk(session, { survey_id: sid });
    assert.deepEqual(whole.spec.groups[1].questions[4], result.spec, "the question spec is the question of the survey spec");

    const alone = resultOf(await session.client.callTool({ name: VALIDATE, arguments: { kind: "question", spec: result.spec } }));
    assert.equal(alone.valid, true, JSON.stringify(alone.errors));
    // With the survey the question's own code is taken, and only that may be reported.
    const against = resultOf(await session.client.callTool({ name: VALIDATE, arguments: { kind: "question", spec: result.spec, survey_id: sid } }));
    assert.deepEqual((against.errors as Array<{ path: string }>).filter((item) => item.path !== "code"), [], JSON.stringify(against.errors));

    const numeric = await readOk(session, { survey_id: sid, question_id: number.qid });
    assert.deepEqual(numeric.position, { group_id: first.gid, index: 7 });
    assert.equal(numeric.spec.type, "N");
    assert.equal(numeric.spec.relevance, '((A05.NAOK == "Y"))');
    assert.deepEqual(numeric.spec.attributes, { min_num_value_n: "0", max_num_value_n: "200" });
  }, { fake });
});

// ---- a survey built in the admin ----

const SURFACE: SeedSurvey = {
  title: { de: "Oberfläche", en: "Surface" },
  groups: [{
    title: { de: "Gruppe", en: "Group" },
    questions: [
      {
        code: "Q1",
        type: "L",
        theme: "bootstrap_buttons",
        mandatory: "Y",
        text: { de: "Zeile eins\r\nZeile zwei", en: "Line one\r\nLine two" },
        help: { de: "Bitte&nbsp;wählen: &lt;b&gt;fett&lt;/b&gt;", en: "Choose" },
        answers: [{ code: "A1", text: { de: "Eins", en: "One" } }, { code: "A2", text: { de: "Zwei", en: "Two" } }],
        // answer_order differs from the default of the theme (normal), hidden equals it.
        attributes: [{ name: "answer_order", value: "random" }, { name: "hidden", value: "0" }],
        defaults: [{ text: { de: "A1", en: "A1" } }],
      },
      {
        code: "Q2",
        type: "S",
        mandatory: "S",
        text: { de: "Betrag", en: "Amount" },
        attributes: [{ name: "prefix", value: "€", language: "de" }, { name: "prefix", value: "EUR", language: "en" }],
      },
      {
        code: "Q3",
        type: "M",
        text: { de: "Auswahl", en: "Choice" },
        subquestions: [
          { code: "SM1", text: { de: "Erste", en: "First" }, relevance: "Q1 == 'A1'" },
          { code: "SM2", text: { de: "Zweite", en: "Second" } },
        ],
        defaults: [{ subquestion: "SM2", text: { de: "Y", en: "Y" } }],
      },
      {
        code: "Q4",
        type: "S",
        same_default: true,
        text: { de: "Gruß", en: "Greeting" },
        defaults: [{ text: { de: "Hallo" } }],
      },
    ],
  }],
};

test("[GEN-D] get_survey_spec reads a survey built in the admin: attributes, themes, mandatory, relevance, defaults and the text normal form", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, SURFACE);
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid });
    assert.deepEqual(result.languages, ["de", "en"]);
    const questions = questionsByCode(result);
    const [q1, q2, q3, q4] = ["Q1", "Q2", "Q3", "Q4"].map((code) => questions.get(code));
    assert.ok(q1 && q2 && q3 && q4, `questions: ${[...questions.keys()].join(", ")}`);

    // Q1: extended theme, the attribute that differs from the default stays, the one equal to it goes.
    assert.equal(q1.question_theme_name, "bootstrap_buttons");
    assert.deepEqual(q1.attributes, { answer_order: "random" });
    assert.ok(!("hidden" in q1.attributes));
    assert.equal(q1.mandatory, true);
    // CRLF becomes LF; &nbsp; becomes the character; markup entities stay.
    assert.deepEqual(q1.text, { de: "Zeile eins\nZeile zwei", en: "Line one\nLine two" });
    assert.deepEqual(q1.help, { de: "Bitte wählen: &lt;b&gt;fett&lt;/b&gt;", en: "Choose" });
    // The default of a question is a text per language.
    assert.deepEqual(q1.default, { de: "A1", en: "A1" });
    assert.notEqual(q1.same_default, true);

    // Q2: base theme (no question_theme_name), soft mandatory, a language dependent attribute as a map.
    assert.ok(!Object.hasOwn(q2, "question_theme_name"), "a question with the base theme has no question_theme_name");
    assert.equal(q2.mandatory, "soft");
    assert.deepEqual(q2.attributes, { prefix: { de: "€", en: "EUR" } });

    // Q3: the relevance of a subquestion and the default of one subquestion.
    const subquestions = q3.subquestions as Json[];
    assert.deepEqual(subquestions.map((item) => item.code), ["SM1", "SM2"]);
    assert.equal(subquestions[0]?.relevance, "Q1 == 'A1'");
    assert.equal(subquestions[1]?.relevance ?? "1", "1");
    assert.equal(subquestions[0]?.default, undefined);
    assert.deepEqual(subquestions[1]?.default, { de: "Y", en: "Y" });

    // Q4: same_default is a flag and the default one string.
    assert.equal(q4.same_default, true);
    assert.equal(q4.default, "Hallo");
  }, { fake });
});

test("[GEN-D] a spec read from a survey built in the admin is valid for the write tools (validate_spec kind survey)", async () => {
  const fake = new FakeLimeSurvey();
  const { sid } = seedSurvey(fake, SURFACE);
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid });
    const validated = resultOf(await session.client.callTool({ name: VALIDATE, arguments: { kind: "survey", spec: result.spec } }));
    assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  }, { fake });
});

// ---- Ranking on both generations ----

const RANKING_SPEC = {
  survey: { title: "Ranking" },
  groups: [{
    title: "Gruppe",
    questions: [{
      code: "R01",
      type: "R",
      text: "Bitte ordnen",
      answers: [{ code: "C", text: "Cäsar" }, { code: "A", text: "Anton" }, { code: "B", text: "Berta" }],
    }],
  }],
};

test("[GEN-D] Ranking is read as answers in the order of the question on generation 7 (subquestions) and on generation 6 (answers), in the same form", async () => {
  const specs: Json[] = [];
  for (const generation of [7, 6] as const) {
    const fake = new FakeLimeSurvey({ generation });
    const sid = await importSpec(fake, RANKING_SPEC);
    const ranking = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0);
    assert.ok(ranking);
    // The premise: generation 7 stores the entries as subquestions of type R, generation 6 as answer options.
    const subquestions = fake.questions.filter((item) => item.parent_qid === ranking.qid);
    const answers = fake.answers.filter((item) => item.qid === ranking.qid);
    assert.equal(subquestions.length, generation === 7 ? 3 : 0);
    assert.equal(answers.length, generation === 7 ? 0 : 3);

    await withSession(async (session) => {
      const result = await readOk(session, { survey_id: sid, question_id: ranking.qid });
      assert.equal(result.spec.type, "R");
      assert.deepEqual(
        result.spec.answers.map((item: Json) => ({ code: item.code, text: item.text })),
        [{ code: "C", text: { de: "Cäsar" } }, { code: "A", text: { de: "Anton" } }, { code: "B", text: { de: "Berta" } }],
        `generation ${generation}: the answers keep the order of the question, not of the codes`,
      );
      assert.deepEqual(result.spec.subquestions ?? [], [], `generation ${generation}: the entries are answers, not subquestions`);
      specs.push(result.spec);
    }, { fake });
  }
  assert.deepEqual(specs[0], specs[1], "both generations give the same spec");
});

// ---- missing translations ----

test("[GEN-D] a question without a text row in one language is no error: the map lacks the language and missing_translations names it", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const first = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "S01");
  assert.ok(first?.l10n.en, "the import must have created the English text row first");
  delete first.l10n.en;
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid });
    const question = result.spec.groups[0].questions[0];
    assert.equal(question.code, "S01");
    assert.deepEqual(question.text, { de: "Wie zufrieden waren Sie?" });
    // Every field of the missing row is a missing translation: the text and the help (and a script, when there is one).
    const missing = result.missing_translations as Array<{ path: string; language: string }>;
    assert.ok(missing.some((item) => item.path === "groups[0].questions[0].text" && item.language === "en"), JSON.stringify(missing));
    assert.ok(missing.every((item) => item.language === "en" && /^groups\[0\]\.questions\[0\]\.(text|help|script)$/.test(item.path)), JSON.stringify(missing));
    assert.deepEqual(question.answers.map((answer: Json) => answer.code), ["1", "2"], "the answers stay in the spec");
    assert.deepEqual(result.languages, ["de", "en"]);
  }, { fake });
});

// ---- too large ----

test("[GEN-D] a survey larger than LIMESURVEY_MAX_RESPONSE_CHARS answers SPEC_TOO_LARGE with an outline per group, and never cuts", async () => {
  const limit = 2000;
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p01-plugin-example"));
  const groups = groupsOf(fake, sid);
  await withSession(async (session) => {
    const response = await read(session, { survey_id: sid });
    assert.equal(response.isError, true, "the survey does not fit into 2000 characters");
    const result = resultOf(response);
    assert.equal(result.code, "SPEC_TOO_LARGE");
    const size = JSON.stringify(response.structuredContent).length;
    assert.ok(size <= limit, `the error has ${size} characters, the limit is ${limit}`);
    assert.ok(typeof result.details?.recovery === "string" && /group_id/.test(result.details.recovery), JSON.stringify(result.details?.recovery));
    const outline = result.details?.outline as Json[] | undefined;
    assert.ok(Array.isArray(outline), JSON.stringify(result.details));
    assert.equal(outline.length, groups.length);
    outline.forEach((entry, index) => {
      const group = groups[index];
      assert.ok(group);
      assert.equal(entry.group_id, group.gid);
      assert.equal(entry.title, group.l10n.de?.group_name);
      assert.equal(entry.questions, mainQuestionsOf(fake, group.gid).length);
      assert.ok(Number.isInteger(entry.estimated_chars) && entry.estimated_chars > 0, `estimated_chars: ${String(entry.estimated_chars)}`);
    });

    // The outline leads to the groups: a group of the outline either fits or is too large itself.
    const first = outline[0];
    assert.ok(first);
    const group = await read(session, { survey_id: sid, group_id: Number(first.group_id) });
    if (group.isError === true) assert.equal(resultOf(group).code, "SPEC_TOO_LARGE");
    else assert.ok(JSON.stringify(group.structuredContent).length <= limit);
  }, { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) });
});

test("[GEN-D] with a limit just below the size of the survey, the survey is too large and every group is still readable", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p01-plugin-example"));
  const groups = groupsOf(fake, sid);
  const whole = await withSession(async (session) => {
    const response = await read(session, { survey_id: sid });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 500));
    return JSON.stringify(response.structuredContent).length;
  }, { fake });
  const limit = whole - 1;
  await withSession(async (session) => {
    const tooLarge = await read(session, { survey_id: sid });
    assert.equal(tooLarge.isError, true);
    assert.equal(resultOf(tooLarge).code, "SPEC_TOO_LARGE");
    for (const group of groups) {
      const response = await read(session, { survey_id: sid, group_id: group.gid });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 500));
      const size = JSON.stringify(response.structuredContent).length;
      assert.ok(size <= limit, `the group has ${size} characters, the limit is ${limit}`);
    }
  }, { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) });
});

// ---- scope none: reads only ----

const SECRET_PROPERTIES = ["bounceaccountpass", "bounceaccountuser", "bounceaccounthost", "googleanalyticsapikey", "tokenencryptionoptions"];
const READ_METHOD = /^(get_session_key|release_session_key|get_[a-z_]+|list_[a-z_]+)$/;

test("[GEN-D] get_survey_spec sends read methods only (also under write scope none and in error paths) and never asks for defaultvalue or the secret survey fields", async () => {
  const fake = new FakeLimeSurvey();
  const sid = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const otherSid = await importSpec(fake, await paritySpec("p03-minimal-matrix"));
  const otherGroup = groupsOf(fake, otherSid)[0];
  const otherQuestion = otherGroup ? mainQuestionsOf(fake, otherGroup.gid)[0] : undefined;
  assert.ok(otherGroup && otherQuestion);
  const before = fake.requests.length;
  await withSession(async (session) => {
    const survey = await readOk(session, { survey_id: sid });
    await readOk(session, { survey_id: sid, group_id: Number(survey.ids.groups[0].group_id) });
    await readOk(session, { survey_id: sid, question_id: Number(survey.ids.questions[0].question_id) });
    // Error paths read too, and only read.
    assert.equal((await read(session, { survey_id: sid, question_id: otherQuestion.qid })).isError, true);
    assert.equal((await read(session, { survey_id: sid, group_id: otherGroup.gid })).isError, true);
  }, { fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) });

  const requests = fake.requests.slice(before);
  assert.ok(requests.length > 0, "the tool read the survey");
  for (const request of requests) assert.match(request.method, READ_METHOD, `${request.method} is not a read method`);

  const surveyLists = requests.filter((request) => request.method === "get_survey_properties").map((request) => request.params[2]);
  assert.ok(surveyLists.length > 0, "no get_survey_properties call was recorded");
  for (const list of surveyLists) {
    assert.ok(Array.isArray(list) && list.length > 0, `the field list must be a non-empty array, got ${JSON.stringify(list)}`);
    const names = (list as unknown[]).map((item) => String(item).toLowerCase());
    for (const secret of SECRET_PROPERTIES) assert.ok(!names.includes(secret), `the field list asks for ${secret}`);
  }

  const questionLists = requests.filter((request) => request.method === "get_question_properties").map((request) => request.params[2]);
  assert.ok(questionLists.length > 0, "no get_question_properties call was recorded");
  for (const list of questionLists) {
    assert.ok(Array.isArray(list), `get_question_properties needs a field list (without one it also returns defaultvalue), got ${JSON.stringify(list)}`);
    assert.ok(!(list as unknown[]).some((item) => String(item).toLowerCase() === "defaultvalue"), "the field list asks for defaultvalue");
  }
});

test("[GEN-D] generation 6 throws for defaultvalue as soon as a default exists: the spec still has the defaults, read from the field map", async () => {
  const fake = new FakeLimeSurvey({ generation: 6 });
  const { sid } = seedSurvey(fake, SURFACE);
  assert.ok(fake.defaults.length > 0, "the survey has default values");
  await withSession(async (session) => {
    const result = await readOk(session, { survey_id: sid });
    const questions = questionsByCode(result);
    assert.deepEqual(questions.get("Q1")?.default, { de: "A1", en: "A1" });
    assert.equal(questions.get("Q4")?.default, "Hallo");
    assert.deepEqual((questions.get("Q3")?.subquestions as Json[] | undefined)?.[1]?.default, { de: "Y", en: "Y" });
  }, { fake });
  for (const request of fake.requests.filter((item) => item.method === "get_question_properties")) {
    assert.ok(Array.isArray(request.params[2]) && !(request.params[2] as unknown[]).includes("defaultvalue"));
  }
});

// ---- foreign ids ----

test("[GEN-D] ids of another survey are refused with QUESTION_SURVEY_MISMATCH and GROUP_SURVEY_MISMATCH; group_id and question_id together are rejected", async () => {
  const fake = new FakeLimeSurvey();
  const sidA = await importSpec(fake, await paritySpec("p03-minimal-matrix"));
  const sidB = await importSpec(fake, await paritySpec("p04-languages-settings"));
  const ownGroup = groupsOf(fake, sidA)[0];
  const foreignGroup = groupsOf(fake, sidB)[0];
  const ownQuestion = ownGroup ? mainQuestionsOf(fake, ownGroup.gid)[0] : undefined;
  const foreignQuestion = foreignGroup ? mainQuestionsOf(fake, foreignGroup.gid)[0] : undefined;
  assert.ok(ownGroup && foreignGroup && ownQuestion && foreignQuestion);
  await withSession(async (session) => {
    const listed = await session.client.listTools();
    assert.ok(listed.tools.some((item) => item.name === GET), `${GET} is not registered`);

    const question = await read(session, { survey_id: sidA, question_id: foreignQuestion.qid });
    assert.equal(question.isError, true);
    assert.equal(resultOf(question).code, "QUESTION_SURVEY_MISMATCH");

    const group = await read(session, { survey_id: sidA, group_id: foreignGroup.gid });
    assert.equal(group.isError, true);
    assert.equal(resultOf(group).code, "GROUP_SURVEY_MISMATCH");

    // The own ids of the same survey work.
    await readOk(session, { survey_id: sidA, group_id: ownGroup.gid });
    await readOk(session, { survey_id: sidA, question_id: ownQuestion.qid });

    // Both ids at once: the input is rejected before anything is read.
    const before = fake.requests.length;
    const both = await read(session, { survey_id: sidA, group_id: ownGroup.gid, question_id: ownQuestion.qid });
    assert.equal(both.isError, true);
    const message = JSON.stringify(both.content) + JSON.stringify(both.structuredContent ?? "");
    assert.match(message, /group_id/);
    assert.match(message, /question_id/);
    assert.equal(fake.requests.length, before, "a rejected input must not reach LimeSurvey");
  }, { fake });
});

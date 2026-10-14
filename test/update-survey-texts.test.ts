import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey, type FakeGroup, type FakeQuestion, type FakeSurvey } from "./helpers/fake-limesurvey.js";
import { envConfig } from "./helpers/mcp-session.js";
import { groupsOf, importSpec, withSession, writeMethodsSince, type Json } from "./helpers/spec-tools.js";
import { both, errorPaths, propertyNames, requestsSince } from "./helpers/add-tools.js";
import { clone, failOnCall, UPDATE_TEXTS, updateTextsError, updateTextsOk } from "./helpers/update-tools.js";

/**
 * GEN-F: limesurvey_update_survey_texts changes texts of a survey by code: the survey texts per language
 * (set_language_properties), group texts (set_group_properties with questiongroupl10ns) and question, help and
 * subquestion texts (set_question_properties with questionl10ns), also at an active survey. Answer texts and attributes
 * have no RemoteControl write and are refused, like unknown codes, foreign groups, other languages and rows with an
 * embedded data URI, before anything is written. A failed write resets what the call wrote before.
 */

/** Two languages (de, en): group 1 with Q1 (S) and Q2 (M with SQ1, SQ2), group 2 with Q3 (L). */
const SURVEY: Json = {
  survey: {
    title: both("Umfrage", "Survey"),
    welcometext: both("Willkommen", "Welcome"),
    endtext: both("Danke", "Thanks"),
    language: "de",
    additional_languages: ["en"],
  },
  groups: [
    {
      title: both("Gruppe 1", "Group 1"),
      description: both("Beschreibung 1", "Description 1"),
      questions: [
        { code: "Q1", type: "S", text: both("Frage eins", "Question one"), help: both("Hilfe", "Help") },
        {
          code: "Q2",
          type: "M",
          text: both("Auswahl", "Choice"),
          subquestions: [{ code: "SQ1", text: both("Erste", "First") }, { code: "SQ2", text: both("Zweite", "Second") }],
        },
      ],
    },
    {
      title: both("Gruppe 2", "Group 2"),
      questions: [{ code: "Q3", type: "L", text: both("Wahl", "Pick"), answers: [{ code: "A1", text: both("Ja", "Yes") }] }],
    },
  ],
};

const DATA_URI = '<img src="data:image/png;base64,AAAA">';

interface Base {
  fake: FakeLimeSurvey;
  sid: number;
  survey: FakeSurvey;
  /** The groups in their order. */
  groups: FakeGroup[];
  /** The main question with this code. */
  question: (code: string) => FakeQuestion;
  /** The subquestion `code` of the main question `parent`. */
  sub: (parent: string, code: string) => FakeQuestion;
}

async function setup(): Promise<Base> {
  const fake = new FakeLimeSurvey({ generation: 7 });
  const sid = await importSpec(fake, SURVEY);
  const survey = fake.surveys.find((item) => item.sid === sid);
  assert.ok(survey);
  const question = (code: string): FakeQuestion => {
    const found = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === code);
    assert.ok(found, `no question ${code}`);
    return found;
  };
  const sub = (parent: string, code: string): FakeQuestion => {
    const parentQid = question(parent).qid;
    const found = fake.questions.find((item) => item.parent_qid === parentQid && item.title === code);
    assert.ok(found, `no subquestion ${parent}.${code}`);
    return found;
  };
  return { fake, sid, survey, groups: groupsOf(fake, sid), question, sub };
}

/** Every text of the survey (survey language rows, group rows, question and subquestion rows), to compare. */
function snapshot(fake: FakeLimeSurvey, sid: number): Json {
  const survey = fake.surveys.find((item) => item.sid === sid);
  assert.ok(survey);
  return clone({
    survey: survey.languagesettings,
    groups: groupsOf(fake, sid).map((group) => ({ gid: group.gid, l10n: group.l10n })),
    questions: fake.questions.filter((item) => item.sid === sid).map((item) => ({ qid: item.qid, title: item.title, l10n: item.l10n })),
  });
}

function groupAt(groups: FakeGroup[], index: number): FakeGroup {
  const group = groups[index];
  assert.ok(group, `the survey has no group ${index}`);
  return group;
}

const changesOf = (result: Json): Json[] => {
  assert.ok(Array.isArray(result.changes), `changes: ${JSON.stringify(result.changes)}`);
  return result.changes as Json[];
};

// ---- the tool and its contract ----

test("[GEN-F] update_survey_texts is registered with the annotations and the input of the contract, and takes no file path", async () => {
  await withSession(async (session) => {
    const tool = (await session.client.listTools()).tools.find((item) => item.name === UPDATE_TEXTS);
    assert.ok(tool, `${UPDATE_TEXTS} is not registered`);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, true);
    assert.equal(tool.annotations?.idempotentHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.outputSchema, "the tool has an output schema");
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["dry_run", "expected_fingerprint", "survey_id", "texts"]);
    const required = tool.inputSchema.required ?? [];
    for (const name of ["survey_id", "texts"]) assert.ok(required.includes(name), `${name} is required`);
    assert.ok(!required.includes("expected_fingerprint"), "expected_fingerprint is optional");
    assert.deepEqual(propertyNames(tool.inputSchema).filter((name) => /path|file/i.test(name)), [], "the tool takes no file parameter");
  });
});

// ---- 16: question and subquestion texts ----

test("[GEN-F] a question text changed only in en is written for en and verified, de stays; a subquestion text goes to the subquestion's own qid", async () => {
  const { fake, sid, question, sub } = await setup();
  const q1 = question("Q1");
  const sq1 = sub("Q2", "SQ1");
  const before = fake.requests.length;
  const result = await withSession((session) => updateTextsOk(session, {
    survey_id: sid,
    texts: {
      questions: [
        { code: "Q1", text: { en: "Question one, new" } },
        { code: "Q2", subquestions: [{ code: "SQ1", text: { de: "Erste, neu" } }] },
      ],
    },
  }), { fake });

  assert.equal(result.survey_id, sid);
  assert.equal(result.survey_active, false);
  assert.equal(result.applied, true);
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  const changes = changesOf(result);
  assert.equal(changes.length, 2, JSON.stringify(changes));
  const questionChange = changes.find((item) => item.desired === "Question one, new");
  assert.ok(questionChange, JSON.stringify(changes));
  assert.equal(questionChange.language, "en");
  assert.equal(questionChange.current, "Question one");
  const subChange = changes.find((item) => item.desired === "Erste, neu");
  assert.ok(subChange, JSON.stringify(changes));
  assert.equal(subChange.language, "de");
  assert.equal(subChange.current, "Erste");

  assert.deepEqual([q1.l10n.de?.question, q1.l10n.en?.question], ["Frage eins", "Question one, new"]);
  assert.deepEqual([q1.l10n.de?.help, q1.l10n.en?.help], ["Hilfe", "Help"], "the help texts stay");
  assert.deepEqual([sq1.l10n.de?.question, sq1.l10n.en?.question], ["Erste, neu", "First"]);

  assert.ok(writeMethodsSince(fake, before).every((method) => method === "set_question_properties"), writeMethodsSince(fake, before).join(", "));
  const sets = requestsSince(fake, before, "set_question_properties");
  for (const request of sets) {
    const data = request.params[2] as Json;
    for (const legacy of ["question", "help", "language"]) assert.ok(!(legacy in data), `the old form ${legacy} is never sent: ${JSON.stringify(data)}`);
  }
  const forQ1 = sets.filter((request) => Number(request.params[1]) === q1.qid);
  assert.ok(forQ1.some((request) => (request.params[2] as Json).questionl10ns?.en?.question === "Question one, new"), JSON.stringify(sets));
  const forSq1 = sets.filter((request) => Number(request.params[1]) === sq1.qid);
  assert.ok(forSq1.some((request) => (request.params[2] as Json).questionl10ns?.de?.question === "Erste, neu"), JSON.stringify(sets));
});

// ---- 17: survey and group texts ----

test("[GEN-F] survey title and welcome text go per language through set_language_properties; a group title through set_group_properties with questiongroupl10ns only", async () => {
  const { fake, sid, survey, groups } = await setup();
  const g1 = groupAt(groups, 0);
  const before = fake.requests.length;
  const result = await withSession((session) => updateTextsOk(session, {
    survey_id: sid,
    texts: {
      // A map names some languages; a string is the text of every language.
      survey: { title: { de: "Umfrage neu", en: "Survey new" }, welcometext: "Hallo" },
      groups: [{ group_id: g1.gid, title: { de: "Gruppe 1 neu" } }],
    },
  }), { fake });
  assert.equal(result.applied, true);
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));

  const languageWrites = requestsSince(fake, before, "set_language_properties");
  assert.deepEqual(languageWrites.map((request) => request.params[3]).sort(), ["de", "en"], "one write per language");
  for (const [language, title] of [["de", "Umfrage neu"], ["en", "Survey new"]] as const) {
    const data = languageWrites.find((request) => request.params[3] === language)?.params[2] as Json | undefined;
    assert.equal(data?.surveyls_title, title, `${language}: ${JSON.stringify(data)}`);
    assert.equal(data?.surveyls_welcometext, "Hallo", `${language}: ${JSON.stringify(data)}`);
  }
  assert.deepEqual(
    ["de", "en"].map((language) => [survey.languagesettings[language]?.surveyls_title, survey.languagesettings[language]?.surveyls_welcometext, survey.languagesettings[language]?.surveyls_endtext]),
    [["Umfrage neu", "Hallo", "Danke"], ["Survey new", "Hallo", "Thanks"]],
  );

  const groupWrites = requestsSince(fake, before, "set_group_properties");
  assert.ok(groupWrites.length > 0, "the group title was written");
  for (const request of groupWrites) {
    assert.equal(Number(request.params[1]), g1.gid);
    const data = request.params[2] as Json;
    for (const legacy of ["language", "group_name", "description"]) {
      assert.ok(!(legacy in data), `the old form with ${legacy} (which empties the other text) is never sent: ${JSON.stringify(data)}`);
    }
  }
  assert.ok(groupWrites.some((request) => (request.params[2] as Json).questiongroupl10ns?.de?.group_name === "Gruppe 1 neu"), JSON.stringify(groupWrites));
  assert.deepEqual(g1.l10n.de, { group_name: "Gruppe 1 neu", description: "Beschreibung 1" });
  assert.deepEqual(g1.l10n.en, { group_name: "Group 1", description: "Description 1" });
  assert.ok(
    writeMethodsSince(fake, before).every((method) => ["set_language_properties", "set_group_properties"].includes(method)),
    writeMethodsSince(fake, before).join(", "),
  );
});

// ---- 18: active survey ----

test("[GEN-F] at an active survey the texts of the survey, a group, a question and a subquestion are written and verified", async () => {
  const { fake, sid, survey, groups, question, sub } = await setup();
  const g2 = groupAt(groups, 1);
  fake.setActive(sid, true);
  const result = await withSession((session) => updateTextsOk(session, {
    survey_id: sid,
    texts: {
      survey: { title: { de: "Umfrage aktiv" } },
      groups: [{ group_id: g2.gid, title: { en: "Group 2 active" } }],
      questions: [
        { code: "Q1", help: { de: "Hilfe aktiv" } },
        { code: "Q2", subquestions: [{ code: "SQ2", text: { en: "Second, active" } }] },
      ],
    },
  }), { fake });
  assert.equal(result.survey_active, true);
  assert.equal(result.applied, true);
  assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  assert.equal(survey.languagesettings.de?.surveyls_title, "Umfrage aktiv");
  assert.equal(survey.languagesettings.en?.surveyls_title, "Survey");
  assert.equal(g2.l10n.en?.group_name, "Group 2 active");
  assert.equal(question("Q1").l10n.de?.help, "Hilfe aktiv");
  assert.equal(question("Q1").l10n.de?.question, "Frage eins");
  assert.equal(sub("Q2", "SQ2").l10n.en?.question, "Second, active");
  assert.equal(survey.active, "Y");
});

// ---- 19: answer texts and attributes ----

for (const [label, entry] of [
  ["answers", { code: "Q3", answers: [{ code: "A1", text: "Ja!" }] }],
  ["attributes", { code: "Q1", attributes: { prefix: "€" } }],
] as const) {
  test(`[GEN-F] ${label} in texts answer TEXT_NOT_WRITABLE with a hint to update_question_from_spec, and nothing is written (not even the valid texts of the call)`, async () => {
    const { fake, sid } = await setup();
    const original = snapshot(fake, sid);
    const before = fake.requests.length;
    const error = await withSession((session) => updateTextsError(session, {
      survey_id: sid,
      texts: { survey: { title: { de: "Umfrage neu" } }, questions: [entry] },
    }), { fake });
    assert.equal(error.code, "TEXT_NOT_WRITABLE", JSON.stringify(error).slice(0, 1500));
    assert.match(JSON.stringify(error), /limesurvey_update_question_from_spec/);
    assert.deepEqual(writeMethodsSince(fake, before), []);
    assert.deepEqual(snapshot(fake, sid), original);
  });
}

// ---- 20: foreign group, unknown code, other language ----

test("[GEN-F] a group of another survey answers GROUP_SURVEY_MISMATCH, an unknown code SPEC_INVALID at its path, a language the survey lacks an error; none of them writes", async () => {
  const { fake, sid } = await setup();
  const otherSid = await importSpec(fake, { survey: { title: "Andere" }, groups: [{ title: "Fremd", questions: [{ code: "X1", type: "S", text: "X" }] }] });
  const foreign = groupAt(groupsOf(fake, otherSid), 0);
  const original = snapshot(fake, sid);
  const valid = { code: "Q1", text: { de: "Frage eins, neu" } };
  const before = fake.requests.length;
  await withSession(async (session) => {
    const mismatch = await updateTextsError(session, {
      survey_id: sid,
      texts: { groups: [{ group_id: foreign.gid, title: "Fremd" }], questions: [valid] },
    });
    assert.equal(mismatch.code, "GROUP_SURVEY_MISMATCH", JSON.stringify(mismatch).slice(0, 1500));

    const unknown = await updateTextsError(session, { survey_id: sid, texts: { questions: [{ code: "QX", text: "Unbekannt" }, valid] } });
    const paths = errorPaths(unknown);
    assert.ok(paths.some((path) => /questions\[0\]/.test(path)), `paths: ${paths.join(", ")}`);

    const french = await updateTextsError(session, { survey_id: sid, texts: { survey: { title: { de: "Umfrage neu", fr: "Enquête" } } } });
    assert.match(JSON.stringify(french), /\bfr\b/, `the error names the language fr: ${JSON.stringify(french).slice(0, 1500)}`);
  }, { fake });
  assert.deepEqual(writeMethodsSince(fake, before), []);
  assert.deepEqual(snapshot(fake, sid), original);
});

// ---- 21: data URIs in the row that is written ----

const DATA_URI_ROWS: Array<[label: string, prepare: (base: Base) => void, texts: (base: Base) => Json]> = [
  [
    "the survey language row (surveyls_endtext) when the title changes",
    (base) => {
      const row = base.survey.languagesettings.de;
      assert.ok(row);
      row.surveyls_endtext = DATA_URI;
    },
    () => ({ survey: { title: { de: "Umfrage neu" } } }),
  ],
  [
    "the group row (description) when the group title changes",
    (base) => {
      const row = groupAt(base.groups, 0).l10n.de;
      assert.ok(row);
      row.description = DATA_URI;
    },
    (base) => ({ groups: [{ group_id: groupAt(base.groups, 0).gid, title: { de: "Gruppe 1 neu" } }] }),
  ],
  [
    "the question row (help) when the question text changes",
    (base) => {
      const row = base.question("Q1").l10n.de;
      assert.ok(row);
      row.help = DATA_URI;
    },
    () => ({ questions: [{ code: "Q1", text: { de: "Frage eins, neu" } }] }),
  ],
];

for (const [label, prepare, texts] of DATA_URI_ROWS) {
  test(`[GEN-F] a data URI in ${label} answers DATA_URI_PRESENT and nothing is written`, async () => {
    const base = await setup();
    const { fake, sid } = base;
    prepare(base);
    const original = snapshot(fake, sid);
    const before = fake.requests.length;
    const error = await withSession((session) => updateTextsError(session, { survey_id: sid, texts: texts(base) }), { fake });
    assert.equal(error.code, "DATA_URI_PRESENT", JSON.stringify(error).slice(0, 1500));
    assert.deepEqual(writeMethodsSince(fake, before), []);
    assert.deepEqual(snapshot(fake, sid), original);
  });
}

// ---- 22: rollback ----

test("[GEN-F] when a later write fails (the second set_group_properties), TEXT_UPDATE_FAILED with rolled_back: every text written before is back", async () => {
  const { fake, sid, groups } = await setup();
  const g1 = groupAt(groups, 0);
  const g2 = groupAt(groups, 1);
  const original = snapshot(fake, sid);
  failOnCall(fake, "set_group_properties", 2, { status: "Error: x", error_code: "ERR_UPDATE_FAILED" });
  const before = fake.requests.length;
  const error = await withSession((session) => updateTextsError(session, {
    survey_id: sid,
    texts: {
      survey: { title: { de: "Umfrage neu" } },
      groups: [{ group_id: g1.gid, title: { de: "Gruppe 1 neu" } }, { group_id: g2.gid, title: { de: "Gruppe 2 neu" } }],
    },
  }), { fake });
  assert.equal(error.code, "TEXT_UPDATE_FAILED", JSON.stringify(error).slice(0, 1500));
  assert.equal(error.details?.rolled_back, true, JSON.stringify(error.details));
  assert.ok(requestsSince(fake, before, "set_group_properties").length >= 2, "a group title was written before the failing write");
  assert.deepEqual(snapshot(fake, sid), original, "every text the call wrote is reset");
});

// ---- 23 and 25: dry run and write scope ----

test("[GEN-F] a dry run under the write scope none lists the changes with current and desired text, sends read methods only and changes nothing", async () => {
  const { fake, sid } = await setup();
  const original = snapshot(fake, sid);
  const before = fake.requests.length;
  const result = await withSession((session) => updateTextsOk(session, {
    survey_id: sid,
    dry_run: true,
    texts: { survey: { title: { de: "Umfrage neu" } }, questions: [{ code: "Q1", text: { en: "Question one, new" } }] },
  }), { fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) });
  assert.equal(result.applied, false);
  const changes = changesOf(result);
  assert.ok(changes.some((item) => item.language === "de" && item.current === "Umfrage" && item.desired === "Umfrage neu"), JSON.stringify(changes));
  assert.ok(changes.some((item) => item.language === "en" && item.current === "Question one" && item.desired === "Question one, new"), JSON.stringify(changes));
  assert.match(String(result.fingerprint), /^[0-9a-f]{64}$/);
  assert.ok(fake.requests.length > before, "the dry run read the survey");
  assert.deepEqual(writeMethodsSince(fake, before), [], "a dry run sends read methods only");
  assert.deepEqual(snapshot(fake, sid), original);
});

test("[GEN-F] under the write scope none the real run answers WRITE_SCOPE_INSUFFICIENT and sends no request", async () => {
  const { fake, sid } = await setup();
  const before = fake.requests.length;
  const error = await withSession(
    (session) => updateTextsError(session, { survey_id: sid, texts: { survey: { title: { de: "Umfrage neu" } } } }),
    { fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) },
  );
  assert.equal(error.code, "WRITE_SCOPE_INSUFFICIENT");
  assert.equal(fake.requests.length, before, "no request reached LimeSurvey");
});

// ---- expected_fingerprint ----

test("[GEN-F] the fingerprint of a dry run is accepted by the real run; a text changed in between makes the real run answer STALE_SPEC without a write", async () => {
  const { fake, sid, question } = await setup();
  const texts = { questions: [{ code: "Q1", text: { en: "Question one, new" } }] };
  await withSession(async (session) => {
    const first = await updateTextsOk(session, { survey_id: sid, dry_run: true, texts });
    const row = question("Q1").l10n.en;
    assert.ok(row);
    row.question = "Changed elsewhere";
    const before = fake.requests.length;
    const stale = await updateTextsError(session, { survey_id: sid, texts, expected_fingerprint: first.fingerprint });
    assert.equal(stale.code, "STALE_SPEC", JSON.stringify(stale).slice(0, 1500));
    assert.deepEqual(writeMethodsSince(fake, before), []);
    assert.equal(question("Q1").l10n.en?.question, "Changed elsewhere");

    const second = await updateTextsOk(session, { survey_id: sid, dry_run: true, texts });
    const result = await updateTextsOk(session, { survey_id: sid, texts, expected_fingerprint: second.fingerprint });
    assert.equal(result.applied, true);
    assert.equal(result.verification?.ok, true, JSON.stringify(result.verification));
  }, { fake });
  assert.equal(question("Q1").l10n.en?.question, "Question one, new");
});

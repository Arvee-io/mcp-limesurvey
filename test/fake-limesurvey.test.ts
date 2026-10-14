import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FakeLimeSurvey, type Generation } from "./helpers/fake-limesurvey.js";
import { parityLss } from "./helpers/mcp-session.js";

/**
 * GEN-FAKE: the in-memory LimeSurvey the generator tests rely on behaves like the source reports say. These tests
 * talk to the fake directly with JSON-RPC bodies; they have nothing to do with the MCP server.
 */

type Json = Record<string, any>;

async function rpc(fake: FakeLimeSurvey, method: string, ...params: unknown[]): Promise<any> {
  const response = await fake.fetch("https://survey.example.test/index.php/admin/remotecontrol", {
    method: "POST",
    body: JSON.stringify({ method, params, id: 1 }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { result: unknown; error: unknown };
  if (payload.error !== null) throw new Error(String(payload.error));
  return payload.result;
}

const b64 = (data: Buffer | string): string => Buffer.from(data).toString("base64");

async function login(fake: FakeLimeSurvey): Promise<string> {
  return (await rpc(fake, "get_session_key", "rpc-user", "secret", "Authdb")) as string;
}

/** A fake with the p03 survey imported (one group, one F question with two subquestions and five answers). */
async function withP03(generation: Generation = 7) {
  const fake = new FakeLimeSurvey({ generation });
  const key = await login(fake);
  const sid = (await rpc(fake, "import_survey", key, b64(await parityLss("p03-minimal-matrix")), "lss", null, null)) as number;
  return { fake, key, sid };
}

async function questionsOf(fake: FakeLimeSurvey, key: string, sid: number, language = "de"): Promise<Json[]> {
  return (await rpc(fake, "list_questions", key, sid, null, language)) as Json[];
}

/** The replace-question fixture with the language switched to German, so it fits the German p03 survey. */
async function lsqForGerman(): Promise<string> {
  const xml = await readFile(path.resolve("test", "fixtures", "replace-question.lsq"), "utf8");
  return b64(xml.replace("<language>en</language>", "<language>de</language>").replace("<![CDATA[en]]>", "<![CDATA[de]]>"));
}

const LSG = `<?xml version="1.0" encoding="UTF-8"?><document><LimeSurveyDocType>Group</LimeSurveyDocType><DBVersion>617</DBVersion>`
  + `<languages><language>de</language></languages>`
  + `<groups><rows><row><gid><![CDATA[7]]></gid><sid><![CDATA[0]]></sid><group_order><![CDATA[1]]></group_order><randomization_group/><grelevance><![CDATA[1]]></grelevance></row></rows></groups>`
  + `<group_l10ns><rows><row><id><![CDATA[1]]></id><gid><![CDATA[7]]></gid><group_name><![CDATA[Neue Gruppe]]></group_name><description/><language><![CDATA[de]]></language></row></rows></group_l10ns>`
  + `<questions><rows><row><qid><![CDATA[70]]></qid><parent_qid><![CDATA[0]]></parent_qid><sid><![CDATA[0]]></sid><gid><![CDATA[7]]></gid><type><![CDATA[S]]></type><title><![CDATA[A01]]></title><preg/><other><![CDATA[N]]></other><mandatory><![CDATA[N]]></mandatory><question_order><![CDATA[1]]></question_order><scale_id><![CDATA[0]]></scale_id><same_default><![CDATA[0]]></same_default><relevance><![CDATA[1]]></relevance></row></rows></questions>`
  + `<question_l10ns><rows><row><id><![CDATA[1]]></id><qid><![CDATA[70]]></qid><question><![CDATA[Gruppentext]]></question><help/><language><![CDATA[de]]></language><script/></row></rows></question_l10ns></document>`;

test("[GEN-FAKE] import_survey creates the survey and the read methods answer in LimeSurvey's shapes", async () => {
  const { fake, key, sid } = await withP03();
  assert.equal(sid, 100001);
  assert.deepEqual(
    await rpc(fake, "get_survey_properties", key, sid, ["active", "language", "additional_languages", "format", "no_such_field"]),
    { active: "N", language: "de", additional_languages: "", format: "G" },
  );
  const groups = (await rpc(fake, "list_groups", key, sid, null)) as Json[];
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.group_name, "Inhalt und Relevanz");
  assert.equal(groups[0]?.group_order, "1");

  const rows = await questionsOf(fake, key, sid);
  assert.equal(rows.length, 3, "main question and two subquestions");
  const main = rows.find((row) => row.parent_qid === "0");
  assert.ok(main);
  assert.equal(main.title, "A01");
  assert.equal(main.question, "Wie bewerten Sie die folgenden Aspekte des Seminars?");

  const props = (await rpc(fake, "get_question_properties", key, Number(main.qid), ["title", "subquestions", "answeroptions", "attributes", "attributes_lang", "defaultvalue", "bogus"], "de")) as Json;
  assert.deepEqual(Object.keys(props).sort(), ["answeroptions", "attributes", "attributes_lang", "defaultvalue", "subquestions", "title"]);
  assert.equal(Object.keys(props.subquestions).length, 2);
  assert.deepEqual(Object.keys(props.answeroptions), ["1", "2", "3", "4", "5"]);
  assert.equal(props.answeroptions["5"].answer, "sehr gut");
  assert.equal(props.answeroptions["5"].order, "4");
  assert.equal(props.attributes.hidden, "0", "type defaults come back mixed with stored values");
  assert.deepEqual(
    props.attributes_lang,
    { em_validation_q_tip: "", printable_help: "" },
    "the language dependent attributes of the theme come with their defaults",
  );
  assert.equal(props.defaultvalue, null);
});

test("[GEN-FAKE] answer options with the codes 0..n-1 come back as a JSON list (PHP array behaviour)", async () => {
  const { fake, key, sid } = await withP03();
  fake.answers.forEach((answer, index) => {
    answer.code = String(index);
  });
  const main = (await questionsOf(fake, key, sid)).find((row) => row.parent_qid === "0");
  assert.ok(main);
  const props = (await rpc(fake, "get_question_properties", key, Number(main.qid), ["answeroptions"], "de")) as Json;
  assert.ok(Array.isArray(props.answeroptions));
  assert.equal(props.answeroptions.length, 5);
});

test("[GEN-FAKE] Ranking: generation 7 turns the answers into subquestions, generation 6 keeps answer options", async () => {
  for (const generation of [7, 6] as const) {
    const fake = new FakeLimeSurvey({ generation });
    const key = await login(fake);
    const spec = await readFile(path.resolve("test", "fixtures", "lss-parity", "p01-plugin-example.lss"));
    const sid = (await rpc(fake, "import_survey", key, b64(spec), "lss", null, null)) as number;
    const ranking = fake.questions.find((item) => item.sid === sid && item.type === "R" && item.parent_qid === 0);
    assert.ok(ranking);
    const props = (await rpc(fake, "get_question_properties", key, ranking.qid, ["subquestions", "answeroptions"], "de")) as Json;
    if (generation === 7) {
      assert.equal(Object.keys(props.subquestions).length, 3);
      assert.equal(props.answeroptions, "No available answer options");
    } else {
      assert.equal(props.subquestions, "No available answers");
      assert.equal(Object.keys(props.answeroptions).length, 3);
    }
  }
});

test("[GEN-FAKE] a survey with two languages keeps CDATA-split text and answers per language", async () => {
  const fake = new FakeLimeSurvey();
  const key = await login(fake);
  const lss = await readFile(path.resolve("test", "fixtures", "lss-parity", "p04-languages-settings.lss"));
  const sid = (await rpc(fake, "import_survey", key, b64(lss), "lss", null, null)) as number;
  assert.equal((await rpc(fake, "get_survey_properties", key, sid, ["additional_languages"])).additional_languages, "en");
  const english = (await rpc(fake, "get_language_properties", key, sid, ["surveyls_endtext", "surveyls_title"], "en")) as Json;
  assert.equal(english.surveyls_endtext, "<p>Danke! ]]> Ende</p>");
  assert.equal(english.surveyls_title, "Kundenbefragung „Service“ 2026");
  assert.equal((await questionsOf(fake, key, sid, "en")).length, 6);
  const choice = fake.questions.find((item) => item.title === "S01");
  assert.ok(choice);
  assert.equal(choice.other, "Y");
  const props = (await rpc(fake, "get_question_properties", key, choice.qid, ["attributes", "answeroptions"], "en")) as Json;
  assert.equal(props.attributes.display_columns, "2");
  assert.equal(props.attributes.answer_order, "random");
  assert.equal(props.answeroptions["2"].answer, "sehr");
  assert.equal(props.answeroptions["1"].assessment_value, "-1");
  assert.deepEqual(await rpc(fake, "list_questions", key, sid, null, "fr"), { status: "Error: Invalid language", error_code: "ERR_INVALID_LANGUAGE" });
});

test("[GEN-FAKE] get_fieldmap names fields like LimeSurvey 7 and reports defaults", async () => {
  const fake = new FakeLimeSurvey();
  const key = await login(fake);
  const lss = await readFile(path.resolve("test", "fixtures", "lss-parity", "p01-plugin-example.lss"));
  const sid = (await rpc(fake, "import_survey", key, b64(lss), "lss", null, null)) as number;
  const multiple = fake.questions.find((item) => item.title === "A04");
  assert.ok(multiple);
  fake.defaults.push({ dvid: 1, qid: multiple.qid, sqid: fake.questions.find((item) => item.parent_qid === multiple.qid)?.qid ?? 0, scale_id: 0, specialtype: "", l10n: { de: "Y" } });
  const map = (await rpc(fake, "get_fieldmap", key, sid, "de")) as Json;
  const subs = fake.questions.filter((item) => item.parent_qid === multiple.qid);
  assert.equal(subs.length, 3);
  const first = map[`Q${multiple.qid}_S${subs[0]?.qid}`];
  assert.ok(first, Object.keys(map).join(", "));
  assert.equal(first.defaultvalue, "Y");
  assert.equal(first.aid, "SQ001");
  assert.ok(map[`Q${multiple.qid}_Cother`], "the other field of a multiple choice question with other=Y");
  assert.equal(map[`Q${multiple.qid}_S${subs[1]?.qid}`].defaultvalue, undefined);
});

test("[GEN-FAKE] import_question: order MAX+2, mandatory override, code collisions and the active lock", async () => {
  const { fake, key, sid } = await withP03();
  const gid = fake.groups[0]?.gid;
  assert.ok(gid);
  const data = await lsqForGerman();

  const qid = (await rpc(fake, "import_question", key, sid, gid, data, "lsq", "S")) as number;
  const created = fake.questions.find((item) => item.qid === qid);
  assert.ok(created);
  assert.equal(created.title, "Q00");
  assert.equal(created.question_order, 3, "MAX(question_order)+2: the existing question has order 1");
  assert.equal(created.mandatory, "S", "the file says Y, the call overrides it");
  assert.equal(created.gid, gid);

  const clash = (await rpc(fake, "import_question", key, sid, gid, data, "lsq", "N")) as Json;
  assert.equal(clash.error_code, "ERR_CREATION_FAILED");
  assert.match(clash.status, /could not be imported/);
  const taken = (await rpc(fake, "import_question", key, sid, gid, data, "lsq", "N", "Q00")) as Json;
  assert.equal(taken.error_code, "ERR_ALREADY_EXISTS");
  const renamed = (await rpc(fake, "import_question", key, sid, gid, data, "lsq", "N", "Q99")) as number;
  assert.equal(fake.questions.find((item) => item.qid === renamed)?.title, "Q99");
  assert.equal(fake.questions.find((item) => item.qid === renamed)?.question_order, 5);

  fake.setActive(sid, true);
  const locked = (await rpc(fake, "import_question", key, sid, gid, data, "lsq", "N", "Q98")) as Json;
  assert.equal(locked.error_code, "ERR_SURVEY_ACTIVE");
  assert.equal(((await rpc(fake, "delete_question", key, qid)) as Json).error_code, "ERR_SURVEY_ACTIVE");
});

test("[GEN-FAKE] import_group appends with MAX+1 and renames colliding question codes silently", async () => {
  const { fake, key, sid } = await withP03();
  const gid = (await rpc(fake, "import_group", key, sid, b64(LSG), "lsg")) as number;
  const group = fake.groups.find((item) => item.gid === gid);
  assert.ok(group);
  assert.equal(group.group_order, 2, "the existing group has group_order 1");
  assert.equal(group.l10n.de?.group_name, "Neue Gruppe");
  const imported = fake.questions.find((item) => item.gid === gid);
  assert.ok(imported);
  assert.notEqual(imported.title, "A01");
  assert.equal(fake.questions.filter((item) => item.parent_qid === 0 && item.title === imported.title).length, 1);
  assert.equal(imported.l10n.de?.question, "Gruppentext");
});

test("[GEN-FAKE] set_question_properties renumbers the group after every base field and validates the code", async () => {
  const { fake, key, sid } = await withP03();
  const gid = fake.groups[0]?.gid;
  const data = await lsqForGerman();
  const second = (await rpc(fake, "import_question", key, sid, gid, data, "lsq", "N")) as number;
  const first = fake.questions.find((item) => item.title === "A01");
  assert.ok(first);
  const orders = () => fake.questions.filter((item) => item.parent_qid === 0).sort((a, b) => a.question_order - b.question_order).map((item) => `${item.question_order}:${item.title}`);
  assert.deepEqual(orders(), ["1:A01", "3:Q00"]);

  assert.deepEqual(await rpc(fake, "set_question_properties", key, second, { question_order: -1000000 }), { question_order: true });
  assert.deepEqual(orders(), ["1:Q00", "2:A01"], "numbered again from 1 after the save");

  const result = (await rpc(fake, "set_question_properties", key, second, { title: "1X", mandatory: "Y", gid: 5 })) as Json;
  assert.deepEqual(result, { title: false, mandatory: true }, "an invalid code is refused, gid is not writable");
  assert.equal(fake.questions.find((item) => item.qid === second)?.title, "Q00");
  assert.deepEqual(await rpc(fake, "set_question_properties", key, second, { title: "A01" }), { title: false }, "duplicate code");
});

test("[GEN-FAKE] set_question_properties text writes: questionl10ns keeps the other parts, the old form depends on the generation", async () => {
  for (const generation of [7, 6] as const) {
    const { fake, key } = await withP03(generation);
    const main = fake.questions.find((item) => item.title === "A01");
    assert.ok(main);
    const text = () => fake.questions.find((item) => item.qid === main.qid)?.l10n.de;
    await rpc(fake, "set_question_properties", key, main.qid, { questionl10ns: { de: { help: "Hilfe" } } });
    assert.equal(text()?.help, "Hilfe");
    assert.equal(text()?.question, "Wie bewerten Sie die folgenden Aspekte des Seminars?");
    await rpc(fake, "set_question_properties", key, main.qid, { language: "de", question: "Neu" });
    assert.equal(text()?.question, "Neu");
    assert.equal(text()?.help, generation === 7 ? "Hilfe" : "", "7.5.1 keeps the help text, 6.17.11 empties it");
  }
});

test("[GEN-FAKE] set_group_properties writes group texts and renumbers the groups from 0", async () => {
  const { fake, key, sid } = await withP03();
  const original = fake.groups[0];
  assert.ok(original);
  const added = (await rpc(fake, "import_group", key, sid, b64(LSG), "lsg")) as number;
  assert.deepEqual(await rpc(fake, "set_group_properties", key, added, { group_order: -1000000 }), { group_order: true });
  assert.equal(fake.groups.find((item) => item.gid === added)?.group_order, 0);
  assert.equal(original.group_order, 1);
  await rpc(fake, "set_group_properties", key, added, { questiongroupl10ns: { de: { description: "Beschreibung" } } });
  assert.deepEqual(fake.groups.find((item) => item.gid === added)?.l10n.de, { group_name: "Neue Gruppe", description: "Beschreibung" });
  const listed = (await rpc(fake, "list_groups", key, sid, "de")) as Json[];
  assert.ok(listed.length === 2 && Number(listed[0]?.gid) > Number(listed[1]?.gid), "list_groups is not sorted by group_order");
});

test("[GEN-FAKE] delete_question removes subquestions, answers and attributes and renumbers the group", async () => {
  const { fake, key, sid } = await withP03();
  const gid = fake.groups[0]?.gid;
  const second = (await rpc(fake, "import_question", key, sid, gid, await lsqForGerman(), "lsq", "N")) as number;
  const first = fake.questions.find((item) => item.title === "A01");
  assert.ok(first);
  assert.equal(await rpc(fake, "delete_question", key, first.qid), first.qid);
  assert.equal(fake.questions.filter((item) => item.parent_qid === first.qid).length, 0);
  assert.equal(fake.answers.filter((item) => item.qid === first.qid).length, 0);
  assert.equal(fake.questions.find((item) => item.qid === second)?.question_order, 1);
});

test("[GEN-FAKE] error shapes, failNext, unknown methods and the session key", async () => {
  const { fake, key, sid } = await withP03();
  assert.deepEqual(await rpc(fake, "get_survey_properties", key, 999, ["active"]), { status: "Error: Invalid survey ID", error_code: "ERR_INVALID_SURVEY" });
  assert.deepEqual(await rpc(fake, "get_survey_properties", "other-key", sid, ["active"]), { status: "Invalid session key", error_code: "ERR_INVALID_SESSION" });
  assert.deepEqual(await rpc(fake, "list_quotas", key, sid), { status: "No quotas found", error_code: "ERR_NO_DATA" });
  fake.addQuota(sid, "Quote");
  assert.equal(((await rpc(fake, "list_quotas", key, sid)) as Json[])[0]?.name, "Quote");

  fake.failNext("list_groups", { status: "Error: simulated", error_code: "ERR_NO_DATA" });
  assert.deepEqual(await rpc(fake, "list_groups", key, sid, null), { status: "Error: simulated", error_code: "ERR_NO_DATA" });
  assert.equal(((await rpc(fake, "list_groups", key, sid, null)) as Json[]).length, 1, "only the next call fails");
  fake.failNext("list_groups", new Error("boom"));
  await assert.rejects(rpc(fake, "list_groups", key, sid, null), /boom/);

  await assert.rejects(rpc(fake, "no_such_method", key), /HTTP 500/);
  assert.equal(fake.requests.at(-1)?.method, "no_such_method");

  const six = await withP03(6);
  assert.deepEqual(await rpc(six.fake, "get_survey_properties", six.key, 999, ["active"]), { status: "Error: Invalid survey ID" });
});

test("[GEN-FAKE] get_question_properties: generation 6 fails on defaultvalue once a default exists, generation 7 reads it", async () => {
  for (const generation of [7, 6] as const) {
    const { fake, key, sid } = await withP03(generation);
    const main = (await questionsOf(fake, key, sid)).find((row) => row.parent_qid === "0");
    assert.ok(main);
    assert.equal(((await rpc(fake, "get_question_properties", key, Number(main.qid), ["defaultvalue"], "de")) as Json).defaultvalue, null);
    fake.defaults.push({ dvid: 1, qid: Number(main.qid), sqid: 0, scale_id: 0, specialtype: "", l10n: { de: "Vorgabe" } });
    const read = rpc(fake, "get_question_properties", key, Number(main.qid), ["defaultvalue"], "de");
    if (generation === 7) assert.equal(((await read) as Json).defaultvalue, "Vorgabe");
    else await assert.rejects(read, /defaultvalue/);
  }
});

test("[GEN-FAKE] import_survey: a broken file and an unknown extension fail with LimeSurvey's statuses; the option drops one answer", async () => {
  const fake = new FakeLimeSurvey();
  const key = await login(fake);
  assert.deepEqual(await rpc(fake, "import_survey", key, b64("<document>"), "lss", null, null), {
    status: "Error: This is not a valid LimeSurvey survey structure XML file.",
    error_code: "ERR_CREATION_FAILED",
  });
  assert.equal(((await rpc(fake, "import_survey", key, b64("x"), "zip", null, null)) as Json).error_code, "ERR_INVALID_EXTENSION");
  assert.equal(fake.surveys.length, 0);

  const dropping = new FakeLimeSurvey({ dropFirstAnswerOnImport: true });
  const dropKey = await login(dropping);
  await rpc(dropping, "import_survey", dropKey, b64(await parityLss("p03-minimal-matrix")), "lss", null, null);
  assert.deepEqual(dropping.answers.map((item) => item.code), ["2", "3", "4", "5"]);
});

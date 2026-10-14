import assert from "node:assert/strict";
import test from "node:test";
import { LimeSurveyClient } from "../src/client.js";
import { generateSurveyLss } from "../src/spec-generate.js";
import { readSurveySpec, type SpecRead } from "../src/spec-read.js";
import { FakeLimeSurvey } from "./helpers/fake-limesurvey.js";
import { envConfig, paritySpec } from "./helpers/mcp-session.js";

/**
 * GEN-E: readSurveySpec reads a live survey into the comparable spec. A language a text lacks is listed in
 * missing_translations; what cannot be read for that reason (answer texts of a question whose text row is missing) goes
 * to unreadable with its path, language and reason instead of being reported as a missing translation.
 */

interface Unreadable {
  path: string;
  language: string;
  reason: string;
}

/** SpecRead after the change: the result also has the list unreadable. */
type SpecReadWithUnreadable = SpecRead & { unreadable?: Unreadable[] };

async function importedSurvey(): Promise<{ fake: FakeLimeSurvey; client: LimeSurveyClient; sid: number }> {
  const fake = new FakeLimeSurvey();
  const client = new LimeSurveyClient(envConfig(), fake.fetch);
  const lss = generateSurveyLss(await paritySpec("p04-languages-settings"));
  const sid = Number(await client.call("import_survey", [Buffer.from(lss, "utf8").toString("base64"), "lss", null, null]));
  assert.ok(Number.isInteger(sid) && sid > 0, "the import answered without a survey ID");
  return { fake, client, sid };
}

test("[GEN-E] readSurveySpec reports a missing question text row only as the question text, the unreadable answers in unreadable", async () => {
  const { fake, client, sid } = await importedSurvey();
  // p04: the first main question of the first group is S01 (type L, two answers); drop its English text row.
  const first = fake.questions.find((item) => item.sid === sid && item.parent_qid === 0 && item.title === "S01");
  assert.ok(first, "the fake has no question S01");
  assert.ok(first.l10n.en, "the import must have created the English text row first");
  delete first.l10n.en;

  const read = await readSurveySpec(client, sid) as SpecReadWithUnreadable;

  assert.deepEqual(read.languages, ["de", "en"]);
  // The fields of the missing row (text, help, script) are missing translations; the answers hang on the row but are not.
  assert.ok(
    read.missing_translations.some((item) => item.path === "groups[0].questions[0].text" && item.language === "en"),
    JSON.stringify(read.missing_translations),
  );
  assert.ok(
    read.missing_translations.every((item) => item.language === "en" && /^groups\[0\]\.questions\[0\]\.(text|help|script)$/.test(item.path)),
    `the answers are not missing translations: ${JSON.stringify(read.missing_translations)}`,
  );

  assert.ok(Array.isArray(read.unreadable), `unreadable is ${JSON.stringify(read.unreadable)}`);
  const unreadable: Unreadable[] = read.unreadable ?? [];
  for (const path of ["groups[0].questions[0].answers[0].text", "groups[0].questions[0].answers[1].text"]) {
    const entry: Unreadable | undefined = unreadable.find((item) => item.path === path && item.language === "en");
    assert.ok(entry, `no unreadable entry for ${path} in en; entries: ${JSON.stringify(unreadable)}`);
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 0, `the entry for ${path} has no reason`);
  }
  assert.ok(
    !unreadable.some((item) => item.path === "groups[0].questions[0].text"),
    "the question text is a missing translation, not unreadable",
  );

  // The answers themselves stay in the spec (read in the base language).
  assert.deepEqual(read.spec.groups[0]?.questions[0]?.answers.map((answer) => answer.code), ["1", "2"]);
});

test("[GEN-E] readSurveySpec of an intact survey has no missing translation and an empty unreadable list", async () => {
  const { client, sid } = await importedSurvey();
  const read = await readSurveySpec(client, sid) as SpecReadWithUnreadable;
  assert.deepEqual(read.missing_translations, []);
  assert.deepEqual(read.unreadable, []);
});

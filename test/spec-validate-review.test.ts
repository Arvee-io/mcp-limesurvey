import assert from "node:assert/strict";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { generateSurveyLss } from "../src/spec-generate.js";
import { FakeLimeSurvey } from "./helpers/fake-limesurvey.js";
import { resultOf } from "./helpers/mcp-session.js";
import { create, createOk, readOk, validateSpec, withSession, type Json } from "./helpers/spec-tools.js";

/**
 * GEN-D and GEN-I18N, review round of PR3: what the validator and the generator accept. Attributes stored per language
 * that the theme does not define, empty texts, Ranking entries on LimeSurvey 7, and where a default value is allowed.
 */

type Spec = Record<string, any>;

interface Finding {
  path: string;
  message: string;
  fix?: string;
}

const both = (de: string, en: string) => ({ de, en });

/** A de+en survey with one short text question S01 that carries the given attributes. */
const attributeSpec = (attributes: Spec): Spec => ({
  survey: { title: both("Titel", "Title"), language: "de", additional_languages: ["en"] },
  groups: [{ title: both("Gruppe", "Group"), questions: [{ code: "S01", type: "S", text: both("Frage", "Question"), attributes }] }],
});

/** A one-language survey with one question. */
const oneQuestion = (question: Spec): Spec => ({
  survey: { title: "Titel" },
  groups: [{ title: "Gruppe", questions: [question] }],
});

const Q0 = "groups[0].questions[0]";

function errorAt(result: Json, path: string): Finding {
  assert.equal(result.valid, false, "the spec is invalid");
  const found = (result.errors as Finding[]).find((item) => item.path === path);
  assert.ok(found, `no error at ${path}; paths: ${(result.errors as Finding[]).map((item) => item.path).join(", ")}`);
  return found;
}

/** A warning at the path or at an entry below it (text.de). */
function warningAt(result: Json, path: string): Finding {
  const found = (result.warnings as Finding[]).find((item) => item.path === path || item.path.startsWith(`${path}.`));
  assert.ok(found, `no warning at ${path}; warning paths: ${(result.warnings as Finding[]).map((item) => item.path).join(", ")}`);
  return found;
}

// ---- 3: attributes stored per language that the theme does not define ----

test("[GEN-I18N] validate_spec: a map for an attribute the theme does not define (a plugin attribute) is valid, held to the languages of the survey", async () => {
  await withSession(async (session) => {
    const fine = await validateSpec(session, attributeSpec({ plugin_hint: both("Hinweis", "Hint") }));
    assert.equal(fine.valid, true, JSON.stringify(fine.errors));
    const missing = await validateSpec(session, attributeSpec({ plugin_hint: { de: "Hinweis" } }));
    const finding = errorAt(missing, `${Q0}.attributes.plugin_hint`);
    assert.match(finding.message, /\ben\b/, finding.message);
  });
});

test("[GEN-I18N] validate_spec: a map for a known language-independent attribute stays an error, one for a known language-dependent attribute stays valid", async () => {
  await withSession(async (session) => {
    const hidden = await validateSpec(session, attributeSpec({ hidden: both("1", "1") }));
    assert.match(errorAt(hidden, `${Q0}.attributes.hidden`).message, /hidden/);
    const prefix = await validateSpec(session, attributeSpec({ prefix: both("€", "EUR") }));
    assert.equal(prefix.valid, true, JSON.stringify(prefix.errors));
  });
});

/** Every section of a .lss as a list of rows (field name -> value). */
function sections(xml: string): Record<string, Array<Record<string, string>>> {
  const document = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (_name, jpath) => typeof jpath === "string" && jpath.endsWith(".row"),
  }).parse(xml).document as Record<string, unknown>;
  const result: Record<string, Array<Record<string, string>>> = {};
  for (const [name, node] of Object.entries(document)) {
    const rows = (node as { rows?: { row?: unknown } } | undefined)?.rows?.row;
    if (Array.isArray(rows)) {
      result[name] = rows.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, String(value)])));
    }
  }
  return result;
}

/** The rows of one attribute of the question S01, as [language, value] sorted. */
function attributeRows(lss: string, attribute: string): Array<[string, string]> {
  const parsed = sections(lss);
  const question = (parsed.questions ?? []).find((row) => row.title === "S01");
  assert.ok(question?.qid, "the .lss has no question S01");
  return (parsed.question_attributes ?? [])
    .filter((row) => row.qid === question.qid && row.attribute === attribute)
    .map((row): [string, string] => [row.language ?? "", row.value ?? ""])
    .sort();
}

test("[GEN-I18N] the generator writes a map at a plugin attribute as one row per language", () => {
  const lss = generateSurveyLss(attributeSpec({ plugin_hint: both("Hinweis", "Hint") }));
  assert.deepEqual(attributeRows(lss, "plugin_hint"), [["de", "Hinweis"], ["en", "Hint"]]);
});

test("[GEN-I18N] the generator writes a string at a plugin attribute as one row without a language", () => {
  const lss = generateSurveyLss(attributeSpec({ plugin_flag: "1" }));
  assert.deepEqual(attributeRows(lss, "plugin_flag"), [["", "1"]]);
});

// ---- 5: empty texts ----

test("[GEN-D] validate_spec: an empty question, subquestion or answer text is a warning, not an error", async () => {
  await withSession(async (session) => {
    const result = await validateSpec(session, {
      survey: { title: "Titel" },
      groups: [{
        title: "Gruppe",
        questions: [
          { code: "Q1", type: "M", text: "", subquestions: [{ code: "SM1", text: "" }, { code: "SM2", text: "Zwei" }] },
          { code: "Q2", type: "L", text: "Wahl", answers: [{ code: "A1", text: "" }, { code: "A2", text: "Zwei" }] },
        ],
      }],
    });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    for (const path of ["groups[0].questions[0].text", "groups[0].questions[0].subquestions[0].text", "groups[0].questions[1].answers[0].text"]) {
      warningAt(result, path);
    }
  });
});

test("[GEN-D] validate_spec: an empty entry of a text map is a warning at the entry, for a question, a subquestion and an answer", async () => {
  await withSession(async (session) => {
    const spec = attributeSpec({});
    spec.groups[0].questions = [
      { code: "Q1", type: "M", text: both("", "Auswahl"), subquestions: [{ code: "SM1", text: both("Eins", "") }] },
      { code: "Q2", type: "L", text: both("Wahl", "Pick"), answers: [{ code: "A1", text: both("", "") }] },
    ];
    const result = await validateSpec(session, spec);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    warningAt(result, "groups[0].questions[0].text");
    warningAt(result, "groups[0].questions[0].subquestions[0].text");
    warningAt(result, "groups[0].questions[1].answers[0].text");
  });
});

test("[GEN-D] validate_spec: the text fields stay required; the survey and group titles need content", async () => {
  await withSession(async (session) => {
    const missing = await validateSpec(session, {
      survey: { title: "Titel" },
      groups: [{
        title: "Gruppe",
        questions: [
          { code: "Q1", type: "M", subquestions: [{ code: "SM1" }] },
          { code: "Q2", type: "L", text: "Wahl", answers: [{ code: "A1" }] },
        ],
      }],
    });
    errorAt(missing, "groups[0].questions[0].text");
    errorAt(missing, "groups[0].questions[0].subquestions[0].text");
    errorAt(missing, "groups[0].questions[1].answers[0].text");

    const surveyTitle = await validateSpec(session, { survey: { title: "" }, groups: [{ title: "Gruppe", questions: [{ code: "Q1", type: "S", text: "x" }] }] });
    errorAt(surveyTitle, "survey.title");
    const groupTitle = await validateSpec(session, { survey: { title: "Titel" }, groups: [{ title: "", questions: [{ code: "Q1", type: "S", text: "x" }] }] });
    errorAt(groupTitle, "groups[0].title");
    const emptyEntries = attributeSpec({});
    emptyEntries.survey.title = both("Titel", "");
    emptyEntries.groups[0].title = both("Gruppe", "");
    const mapped = await validateSpec(session, emptyEntries);
    errorAt(mapped, "survey.title.en");
    errorAt(mapped, "groups[0].title.en");
  });
});

test("[GEN-D] create_survey_from_spec accepts an empty question text and reads it back as an empty text", async () => {
  const fake = new FakeLimeSurvey();
  await withSession(async (session) => {
    const created = await createOk(session, oneQuestion({ code: "Q1", type: "S", text: "" }));
    assert.equal(created.verification.ok, true, JSON.stringify(created.verification));
    const spec = (await readOk(session, { survey_id: Number(created.survey_id) })).spec;
    assert.deepEqual(spec.groups[0].questions[0].text, { de: "" });
  }, { fake });
});

// ---- 6: Ranking entries on LimeSurvey 7 ----

const rankingEntries = (first: Spec): Spec => oneQuestion({
  code: "R01",
  type: "R",
  text: "Reihenfolge",
  answers: [{ text: "Lang", ...first }, { code: "SHORT", text: "Kurz" }],
});

test("[GEN-D] validate_spec without survey_id: a Ranking entry with a long code and a relevance is a warning that names LimeSurvey 7", async () => {
  await withSession(async (session) => {
    const result = await validateSpec(session, rankingEntries({ code: "LONGCODE1", relevance: "Q1 == 'A1'" }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    for (const field of ["code", "relevance"]) {
      const finding = warningAt(result, `${Q0}.answers[0].${field}`);
      assert.match(finding.message, /only on LimeSurvey 7/i, finding.message);
    }
    assert.deepEqual(session.fake.requests, [], "without survey_id nothing is sent to LimeSurvey");
  });
});

test("[GEN-D] validate_spec: a Ranking entry code of 21 characters or with a forbidden character is an error on every version", async () => {
  await withSession(async (session) => {
    errorAt(await validateSpec(session, rankingEntries({ code: "A".repeat(21) })), `${Q0}.answers[0].code`);
    errorAt(await validateSpec(session, rankingEntries({ code: "AB-C" })), `${Q0}.answers[0].code`);
  });
});

test("[GEN-D] validate_spec: the entries of a type L question keep the limit of five characters and refuse a relevance", async () => {
  await withSession(async (session) => {
    const result = await validateSpec(session, oneQuestion({
      code: "L01",
      type: "L",
      text: "Wahl",
      answers: [{ code: "LONGCODE1", text: "Lang", relevance: "Q1 == 'A1'" }],
    }));
    errorAt(result, `${Q0}.answers[0].code`);
    errorAt(result, `${Q0}.answers[0].relevance`);
  });
});

// ---- 7: where a default value is allowed ----

const SUB = [{ code: "SQ001", text: "Zeile" }];
const ANSWERS = [{ code: "A1", text: "Ja" }];

const NO_DEFAULT_ON: Array<[type: string, extra: Spec, fix: RegExp]> = [
  ["M", { subquestions: SUB }, /subquestions/i],
  ["P", { subquestions: SUB }, /subquestions/i],
  ["Q", { subquestions: SUB }, /subquestions/i],
  ["K", { subquestions: SUB }, /subquestions/i],
  ["A", { subquestions: SUB }, /subquestions/i],
  ["F", { subquestions: SUB, answers: ANSWERS }, /subquestions/i],
  ["R", { answers: ANSWERS }, /remove/i],
  ["|", {}, /remove/i],
];

for (const [type, extra, fix] of NO_DEFAULT_ON) {
  test(`[GEN-D] validate_spec: default is refused on a type ${type} question, with a fix that says what to do instead`, async () => {
    await withSession(async (session) => {
      const result = await validateSpec(session, oneQuestion({ code: "Q01", type, text: "Frage", default: "Vorgabe", ...extra }));
      const finding = errorAt(result, `${Q0}.default`);
      assert.match(String(finding.fix), fix, `fix: ${String(finding.fix)}`);
    });
  });
}

test("[GEN-D] validate_spec: default stays valid on the types that evaluate it (S, L, X, N)", async () => {
  await withSession(async (session) => {
    for (const [type, extra] of [["S", {}], ["L", { answers: ANSWERS }], ["X", {}], ["N", {}]] as Array<[string, Spec]>) {
      const result = await validateSpec(session, oneQuestion({ code: "Q01", type, text: "Frage", default: "1", ...extra }));
      assert.equal(result.valid, true, `type ${type}: ${JSON.stringify(result.errors)}`);
    }
  });
});

test("[GEN-D] validate_spec: default_other only for L and ! with other", async () => {
  await withSession(async (session) => {
    const answers = [{ code: "A1", text: "Ja" }];
    errorAt(await validateSpec(session, oneQuestion({ code: "L01", type: "L", text: "x", answers, default_other: "Rest" })), `${Q0}.default_other`);
    errorAt(await validateSpec(session, oneQuestion({ code: "S01", type: "S", text: "x", default_other: "Rest" })), `${Q0}.default_other`);
    for (const type of ["L", "!"]) {
      const result = await validateSpec(session, oneQuestion({ code: "L01", type, text: "x", answers, other: true, default_other: "Rest" }));
      assert.equal(result.valid, true, `type ${type}: ${JSON.stringify(result.errors)}`);
    }
  });
});

test("[GEN-D] validate_spec: the default of a subquestion is valid on the types with subquestions (M, P, Q, K, A, F)", async () => {
  await withSession(async (session) => {
    const subquestions = [{ code: "SQ001", text: "Zeile", default: "1" }];
    for (const [type, extra] of [
      ["M", {}], ["P", {}], ["Q", {}], ["K", {}], ["A", {}], ["F", { answers: ANSWERS }],
    ] as Array<[string, Spec]>) {
      const result = await validateSpec(session, oneQuestion({ code: "Q01", type, text: "Frage", subquestions, ...extra }));
      assert.equal(result.valid, true, `type ${type}: ${JSON.stringify(result.errors)}`);
    }
  });
});

test("[GEN-D] create_survey_from_spec with a default on a question with subquestions answers SPEC_INVALID at default and sends no RPC", async () => {
  const fake = new FakeLimeSurvey();
  await withSession(async (session) => {
    const response = await create(session, oneQuestion({ code: "Q01", type: "M", text: "Auswahl", default: "Y", subquestions: SUB }));
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "SPEC_INVALID");
    const paths = (result.details?.errors as Array<{ path: string }>).map((item) => item.path);
    assert.ok(paths.includes(`${Q0}.default`), `paths: ${paths.join(", ")}`);
    assert.deepEqual(fake.requests, [], "an invalid spec must not reach LimeSurvey");
  }, { fake });
});

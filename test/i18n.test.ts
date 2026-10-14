import assert from "node:assert/strict";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { generateSurveyLss } from "../src/spec-generate.js";
import { FakeLimeSurvey } from "./helpers/fake-limesurvey.js";
import { connectFake, paritySpec, resultOf, type Session } from "./helpers/mcp-session.js";

/**
 * GEN-I18N: every text of a spec is one string (for all languages of the survey) or a map per language
 * ({"de": "...", "en": "..."}). The validator holds a map to exactly the languages of the survey, the generator writes
 * each language its own text, and get_survey_spec reads the maps back.
 */

const VALIDATE = "limesurvey_validate_spec";
const CREATE = "limesurvey_create_survey_from_spec";
const GET = "limesurvey_get_survey_spec";

type Spec = Record<string, any>;
type Json = Record<string, any>;
type Row = Record<string, string>;

interface Finding {
  path: string;
  message: string;
  fix: string;
}

interface Validation {
  valid: boolean;
  errors: Finding[];
}

async function withSession<T>(run: (session: Session) => Promise<T>, fake?: FakeLimeSurvey): Promise<T> {
  const session = await connectFake(fake === undefined ? {} : { fake });
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

async function validate(session: Session, spec: unknown, extra: Record<string, unknown> = {}): Promise<Validation> {
  const response = await session.client.callTool({ name: VALIDATE, arguments: { spec, ...extra } });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
  return resultOf(response) as Validation;
}

/** The error at exactly this path; message and fix must be filled. */
function errorAt(result: Validation, errorPath: string): Finding {
  assert.equal(result.valid, false, "the spec is invalid");
  const found = result.errors.find((item) => item.path === errorPath);
  assert.ok(found, `no error at ${errorPath}; paths: ${result.errors.map((item) => item.path).join(", ")}`);
  assert.ok(typeof found.message === "string" && found.message.trim().length > 0, `empty message at ${errorPath}`);
  assert.ok(typeof found.fix === "string" && found.fix.trim().length > 0, `empty fix at ${errorPath}`);
  return found;
}

/** The error at this path or at a key below it (for example text.fr). */
function errorAtOrBelow(result: Validation, errorPath: string): Finding {
  assert.equal(result.valid, false, "the spec is invalid");
  const found = result.errors.find((item) => item.path === errorPath || item.path.startsWith(`${errorPath}.`));
  assert.ok(found, `no error at or below ${errorPath}; paths: ${result.errors.map((item) => item.path).join(", ")}`);
  return found;
}

// ---- one spec in which every text is a map ----

const T = {
  surveyTitle: { de: "Kundenzufriedenheit 2026", en: "Customer satisfaction 2026" },
  surveyDescription: { de: "Eine kurze Umfrage", en: "A short survey" },
  surveyWelcome: { de: "Herzlich willkommen", en: "Welcome" },
  surveyEnd: { de: "Danke für Ihre Zeit", en: "Thank you for your time" },
  groupTitle: { de: "Allgemeines", en: "General" },
  groupDescription: { de: "Fragen zum Einstieg", en: "Opening questions" },
  questionText: { de: "Wie zufrieden sind Sie?", en: "How satisfied are you?" },
  questionHelp: { de: "Eine Antwort je Zeile", en: "One answer per row" },
  subquestionText: { de: "Freundlichkeit", en: "Friendliness" },
  answerText: { de: "sehr gut", en: "very good" },
  openText: { de: "Was sollen wir verbessern?", en: "What should we improve?" },
  prefix: { de: "€", en: "EUR" },
};

/** A de+en survey with a matrix question F01 and a short text S01; tweak edits the fresh spec before it is returned. */
function i18nSpec(tweak?: (spec: Spec) => void): Spec {
  const spec: Spec = {
    survey: {
      title: { ...T.surveyTitle },
      language: "de",
      additional_languages: ["en"],
      description: { ...T.surveyDescription },
      welcometext: { ...T.surveyWelcome },
      endtext: { ...T.surveyEnd },
    },
    groups: [{
      title: { ...T.groupTitle },
      description: { ...T.groupDescription },
      questions: [
        {
          code: "F01",
          type: "F",
          text: { ...T.questionText },
          help: { ...T.questionHelp },
          subquestions: [{ code: "SQ001", text: { ...T.subquestionText } }],
          answers: [{ code: "A1", text: { ...T.answerText }, assessment_value: 1 }],
        },
        {
          code: "S01",
          type: "S",
          text: { ...T.openText },
          attributes: { prefix: { ...T.prefix } },
        },
      ],
    }],
  };
  tweak?.(spec);
  return spec;
}

/** The same survey with one string per text: each string counts for every language of the survey (spec format 1). */
function stringSpec(tweak?: (spec: Spec) => void): Spec {
  const spec: Spec = {
    survey: {
      title: "Ein Titel",
      language: "de",
      additional_languages: ["en"],
      description: "Eine Beschreibung",
      welcometext: "Ein Willkommen",
      endtext: "Ein Ende",
    },
    groups: [{
      title: "Eine Gruppe",
      description: "Eine Gruppenbeschreibung",
      questions: [
        {
          code: "F01",
          type: "F",
          text: "Eine Frage",
          help: "Eine Hilfe",
          subquestions: [{ code: "SQ001", text: "Eine Zeile" }],
          answers: [{ code: "A1", text: "Eine Antwort", assessment_value: 1 }],
        },
        { code: "S01", type: "S", text: "Ein Feld", attributes: { prefix: "€", maximum_chars: 50 } },
      ],
    }],
  };
  tweak?.(spec);
  return spec;
}

const Q0 = "groups[0].questions[0]";

// ---- validator ----

test("[GEN-I18N] validate_spec accepts a de+en survey whose texts are maps with exactly these languages", async () => {
  await withSession(async (session) => {
    const result = await validate(session, i18nSpec());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
  });
});

test("[GEN-I18N] validate_spec: one string per text still counts for every language of a de+en survey", async () => {
  await withSession(async (session) => {
    const result = await validate(session, stringSpec());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

test("[GEN-I18N] validate_spec: one map among strings is enough to be checked against the languages of the survey", async () => {
  await withSession(async (session) => {
    const fine = await validate(session, stringSpec((spec) => { spec.groups[0].questions[0].text = { de: "Frage", en: "Question" }; }));
    assert.equal(fine.valid, true, JSON.stringify(fine.errors));
    const missing = await validate(session, stringSpec((spec) => { spec.groups[0].questions[0].text = { de: "Frage" }; }));
    errorAt(missing, `${Q0}.text`);
  });
});

test("[GEN-I18N] validate_spec: a map for a one-language survey needs exactly that language", async () => {
  await withSession(async (session) => {
    const fine = await validate(session, i18nSpec((spec) => {
      spec.survey = { title: { de: "Nur Deutsch" } };
      spec.groups[0].title = { de: "Gruppe" };
      spec.groups[0].description = { de: "" };
      spec.groups[0].questions = [{ code: "S01", type: "S", text: { de: "Frage" } }];
    }));
    assert.equal(fine.valid, true, JSON.stringify(fine.errors));

    const tooMany = await validate(session, i18nSpec((spec) => {
      spec.survey = { title: { de: "Nur Deutsch" } };
      spec.groups[0].title = { de: "Gruppe" };
      spec.groups[0].description = { de: "" };
      spec.groups[0].questions = [{ code: "S01", type: "S", text: { de: "Frage", en: "Question" } }];
    }));
    errorAtOrBelow(tooMany, Q0 + ".text");
  });
});

const MISSING_LANGUAGE: Array<[label: string, path: string, tweak: (spec: Spec) => void]> = [
  ["the survey title", "survey.title", (spec) => { spec.survey.title = { de: "Titel" }; }],
  ["the survey description", "survey.description", (spec) => { spec.survey.description = { de: "Text" }; }],
  ["the welcome text", "survey.welcometext", (spec) => { spec.survey.welcometext = { de: "Hallo" }; }],
  ["the end text", "survey.endtext", (spec) => { spec.survey.endtext = { de: "Tschüss" }; }],
  ["the group title", "groups[0].title", (spec) => { spec.groups[0].title = { de: "Gruppe" }; }],
  ["the group description", "groups[0].description", (spec) => { spec.groups[0].description = { de: "Text" }; }],
  ["the question text", `${Q0}.text`, (spec) => { spec.groups[0].questions[0].text = { de: "Frage" }; }],
  ["the question help", `${Q0}.help`, (spec) => { spec.groups[0].questions[0].help = { de: "Hilfe" }; }],
  ["a subquestion text", `${Q0}.subquestions[0].text`, (spec) => { spec.groups[0].questions[0].subquestions[0].text = { de: "Zeile" }; }],
  ["an answer text", `${Q0}.answers[0].text`, (spec) => { spec.groups[0].questions[0].answers[0].text = { de: "gut" }; }],
  ["the value of a language-dependent attribute", "groups[0].questions[1].attributes.prefix", (spec) => { spec.groups[0].questions[1].attributes.prefix = { de: "€" }; }],
];

for (const [label, path, tweak] of MISSING_LANGUAGE) {
  test(`[GEN-I18N] validate_spec: ${label} without the language en is reported at ${path} and names en`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, i18nSpec(tweak));
      const finding = errorAt(result, path);
      assert.match(finding.message, /\ben\b/, `the message does not name the missing language: ${finding.message}`);
    });
  });
}

const EXTRA_LANGUAGE: Array<[label: string, path: string, tweak: (spec: Spec) => void]> = [
  ["the survey title", "survey.title", (spec) => { spec.survey.title.fr = "Titre"; }],
  ["the question text", `${Q0}.text`, (spec) => { spec.groups[0].questions[0].text.fr = "Question"; }],
  ["an answer text", `${Q0}.answers[0].text`, (spec) => { spec.groups[0].questions[0].answers[0].text.fr = "bien"; }],
];

for (const [label, path, tweak] of EXTRA_LANGUAGE) {
  test(`[GEN-I18N] validate_spec: ${label} with the language fr, which the survey lacks, is reported at ${path} and names fr`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, i18nSpec(tweak));
      const finding = errorAtOrBelow(result, path);
      assert.match(finding.message, /\bfr\b/, `the message does not name the extra language: ${finding.message}`);
    });
  });
}

test("[GEN-I18N] validate_spec: a map for a language-independent attribute such as hidden is reported at the attribute and names it", async () => {
  await withSession(async (session) => {
    const result = await validate(session, i18nSpec((spec) => {
      spec.groups[0].questions[1].attributes.hidden = { de: "1", en: "1" };
    }));
    const finding = errorAt(result, "groups[0].questions[1].attributes.hidden");
    assert.match(finding.message, /hidden/, finding.message);
  });
});

test("[GEN-I18N] validate_spec: a map for a language-dependent attribute such as prefix is valid", async () => {
  await withSession(async (session) => {
    const result = await validate(session, stringSpec((spec) => { spec.groups[0].questions[1].attributes.prefix = { de: "€", en: "EUR" }; }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

test("[GEN-I18N] validate_spec kind question with survey_id of a de+en survey: a map without en is reported at text, a string and a complete map are valid", async () => {
  const fake = new FakeLimeSurvey();
  await withSession(async (session) => {
    const created = await session.client.callTool({ name: CREATE, arguments: { spec: await paritySpec("p04-languages-settings") } });
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent ?? created.content));
    const sid = Number(resultOf(created).survey_id);
    const question = (text: unknown): Spec => ({ code: "Z01", type: "S", text });

    const missing = await validate(session, question({ de: "Nur Deutsch" }), { kind: "question", survey_id: sid });
    const finding = errorAt(missing, "text");
    assert.match(finding.message, /\ben\b/, finding.message);

    const single = await validate(session, question("Ein Text für beide Sprachen"), { kind: "question", survey_id: sid });
    assert.equal(single.valid, true, JSON.stringify(single.errors));

    const complete = await validate(session, question({ de: "Frage", en: "Question" }), { kind: "question", survey_id: sid });
    assert.equal(complete.valid, true, JSON.stringify(complete.errors));
  }, fake);
});

// ---- defaults may name a subset of the languages ----

const defaultsSpec = (tweak: (question: Spec, sub: Spec) => void): Spec => i18nSpec((spec) => {
  const question: Spec = {
    code: "L01",
    type: "L",
    text: { ...T.questionText },
    answers: [{ code: "A1", text: { ...T.answerText } }, { code: "A2", text: { de: "gut", en: "good" } }],
  };
  const sub: Spec = { code: "SQ001", text: { ...T.subquestionText } };
  const multiple: Spec = { code: "Q01", type: "Q", text: { ...T.questionText }, subquestions: [sub] };
  tweak(question, sub);
  spec.groups[0].questions.push(question, multiple);
});

test("[GEN-I18N] validate_spec: a default may name only some of the languages (default and subquestion default)", async () => {
  await withSession(async (session) => {
    const result = await validate(session, defaultsSpec((question, sub) => {
      question.default = { de: "A1" };
      sub.default = { de: "Eins" };
    }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    const text = await validate(session, defaultsSpec((question, sub) => {
      question.default = "A1";
      sub.default = "Eins";
    }));
    assert.equal(text.valid, true, JSON.stringify(text.errors));
  });
});

test("[GEN-I18N] validate_spec: a default in a language the survey lacks is still reported", async () => {
  await withSession(async (session) => {
    const result = await validate(session, defaultsSpec((question) => {
      question.default = { fr: "A1" };
    }));
    const finding = errorAtOrBelow(result, "groups[0].questions[2].default");
    assert.match(finding.message, /\bfr\b/, finding.message);
  });
});

// ---- generator ----

/** Every section of a .lss as a list of rows (field name -> value). */
function sections(xml: string): Record<string, Row[]> {
  const document = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (_name, jpath) => typeof jpath === "string" && jpath.endsWith(".row"),
  }).parse(xml).document as Record<string, unknown>;
  const result: Record<string, Row[]> = {};
  for (const [name, node] of Object.entries(document)) {
    const rows = (node as { rows?: { row?: unknown } } | undefined)?.rows?.row;
    if (Array.isArray(rows)) {
      result[name] = rows.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, String(value)])));
    }
  }
  return result;
}

const rowsOf = (parsed: Record<string, Row[]>, name: string): Row[] => parsed[name] ?? [];

/** The texts of the rows, by language: field is the text column, languageField the column that holds the language. */
const byLanguage = (rows: Row[], field: string, languageField = "language"): Record<string, string> => Object.fromEntries(
  rows.map((row) => [row[languageField] ?? "", row[field] ?? ""]),
);

/** The qid the .lss gives a main question or subquestion (title) of a parent (0 for a main question). */
function qidOf(parsed: Record<string, Row[]>, code: string, parent = "0"): string {
  const rows = [...rowsOf(parsed, "questions"), ...rowsOf(parsed, "subquestions")];
  const row = rows.find((item) => item.title === code && item.parent_qid === parent);
  assert.ok(row?.qid, `the .lss has no question ${code}`);
  return row.qid;
}

test("[GEN-I18N] the generator writes every language its own text (survey, group, question, help, subquestion, answer)", () => {
  const parsed = sections(generateSurveyLss(i18nSpec()));

  const settings = rowsOf(parsed, "surveys_languagesettings");
  assert.deepEqual(settings.map((row) => row.surveyls_language).sort(), ["de", "en"]);
  assert.deepEqual(byLanguage(settings, "surveyls_title", "surveyls_language"), T.surveyTitle);
  assert.deepEqual(byLanguage(settings, "surveyls_description", "surveyls_language"), T.surveyDescription);
  assert.deepEqual(byLanguage(settings, "surveyls_welcometext", "surveyls_language"), T.surveyWelcome);
  assert.deepEqual(byLanguage(settings, "surveyls_endtext", "surveyls_language"), T.surveyEnd);

  const groups = rowsOf(parsed, "group_l10ns");
  assert.deepEqual(byLanguage(groups, "group_name"), T.groupTitle);
  assert.deepEqual(byLanguage(groups, "description"), T.groupDescription);

  const questionId = qidOf(parsed, "F01");
  const questionRows = rowsOf(parsed, "question_l10ns").filter((row) => row.qid === questionId);
  assert.deepEqual(byLanguage(questionRows, "question"), T.questionText);
  assert.deepEqual(byLanguage(questionRows, "help"), T.questionHelp);

  const subquestionRows = rowsOf(parsed, "question_l10ns").filter((row) => row.qid === qidOf(parsed, "SQ001", questionId));
  assert.deepEqual(byLanguage(subquestionRows, "question"), T.subquestionText);

  const answer = rowsOf(parsed, "answers").find((row) => row.qid === questionId && row.code === "A1");
  assert.ok(answer, "the .lss has no answer A1");
  const answerRows = rowsOf(parsed, "answer_l10ns").filter((row) => row.aid === answer.aid);
  assert.deepEqual(byLanguage(answerRows, "answer"), T.answerText);
});

test("[GEN-I18N] the generator gives one string to every language, as before", () => {
  const parsed = sections(generateSurveyLss(stringSpec()));
  const both = (text: string): Record<string, string> => ({ de: text, en: text });
  const settings = rowsOf(parsed, "surveys_languagesettings");
  assert.deepEqual(byLanguage(settings, "surveyls_title", "surveyls_language"), both("Ein Titel"));
  assert.deepEqual(byLanguage(settings, "surveyls_welcometext", "surveyls_language"), both("Ein Willkommen"));
  assert.deepEqual(byLanguage(rowsOf(parsed, "group_l10ns"), "group_name"), both("Eine Gruppe"));
  const questionId = qidOf(parsed, "F01");
  const questionRows = rowsOf(parsed, "question_l10ns").filter((row) => row.qid === questionId);
  assert.deepEqual(byLanguage(questionRows, "question"), both("Eine Frage"));
  assert.deepEqual(byLanguage(questionRows, "help"), both("Eine Hilfe"));
  const subquestionId = qidOf(parsed, "SQ001", questionId);
  assert.deepEqual(byLanguage(rowsOf(parsed, "question_l10ns").filter((row) => row.qid === subquestionId), "question"), both("Eine Zeile"));
  const answer = rowsOf(parsed, "answers").find((row) => row.qid === questionId);
  assert.ok(answer);
  assert.deepEqual(byLanguage(rowsOf(parsed, "answer_l10ns").filter((row) => row.aid === answer.aid), "answer"), both("Eine Antwort"));
});

/** The question_attributes rows of one attribute of one question. */
const attributeRows = (parsed: Record<string, Row[]>, code: string, attribute: string): Row[] => {
  const qid = qidOf(parsed, code);
  return rowsOf(parsed, "question_attributes").filter((row) => row.qid === qid && row.attribute === attribute);
};

test("[GEN-I18N] a string at a language-dependent attribute becomes one question_attributes row per language, with the language set", () => {
  const parsed = sections(generateSurveyLss(stringSpec()));
  const prefix = attributeRows(parsed, "S01", "prefix");
  assert.deepEqual(prefix.map((row) => [row.language, row.value]).sort(), [["de", "€"], ["en", "€"]]);
  // A language-independent attribute stays one row without a language.
  assert.deepEqual(attributeRows(parsed, "S01", "maximum_chars").map((row) => [row.language, row.value]), [["", "50"]]);
});

test("[GEN-I18N] a map at a language-dependent attribute gives each language its own value", () => {
  const parsed = sections(generateSurveyLss(i18nSpec()));
  const prefix = attributeRows(parsed, "S01", "prefix");
  assert.deepEqual(byLanguage(prefix, "value"), T.prefix);
  assert.equal(prefix.length, 2);
});

// ---- create_survey_from_spec and get_survey_spec ----

/** The fields of a survey-level answer that carry texts, as maps. */
function textsOf(spec: Json): Json {
  const group = spec.groups[0];
  const matrix = group.questions[0];
  return {
    surveyTitle: spec.survey.title,
    surveyDescription: spec.survey.description,
    surveyWelcome: spec.survey.welcometext,
    surveyEnd: spec.survey.endtext,
    groupTitle: group.title,
    groupDescription: group.description,
    questionText: matrix.text,
    questionHelp: matrix.help,
    subquestionText: matrix.subquestions[0].text,
    answerText: matrix.answers[0].text,
    openText: group.questions[1].text,
    prefix: group.questions[1].attributes.prefix,
  };
}

test("[GEN-I18N] create_survey_from_spec with maps in every text field verifies cleanly and get_survey_spec returns the same maps", async () => {
  const fake = new FakeLimeSurvey();
  await withSession(async (session) => {
    const created = await session.client.callTool({ name: CREATE, arguments: { spec: i18nSpec() } });
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent ?? created.content));
    const result = resultOf(created);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    assert.deepEqual(result.verification.differences, []);
    assert.deepEqual(result.languages, ["de", "en"]);

    // The fake holds each language's own text.
    const survey = fake.surveys[0];
    assert.ok(survey);
    assert.equal(survey.languagesettings.en?.surveyls_title, T.surveyTitle.en);
    assert.equal(survey.languagesettings.de?.surveyls_title, T.surveyTitle.de);

    const read = await session.client.callTool({ name: GET, arguments: { survey_id: Number(result.survey_id) } });
    assert.equal(read.isError, undefined, JSON.stringify(read.structuredContent ?? read.content));
    const spec = resultOf(read);
    assert.deepEqual(textsOf(spec.spec), T);
    assert.deepEqual(spec.missing_translations, []);
  }, fake);
});

test("[GEN-I18N] script and default values are texts per language too: create_survey_from_spec writes them and get_survey_spec returns the same maps", async () => {
  const fake = new FakeLimeSurvey();
  const spec: Spec = {
    survey: { title: { ...T.surveyTitle }, language: "de", additional_languages: ["en"] },
    groups: [{
      title: { ...T.groupTitle },
      questions: [
        {
          code: "S01",
          type: "S",
          text: { ...T.openText },
          script: { de: "// Skript", en: "// Script" },
          default: { de: "Hallo", en: "Hello" },
        },
        {
          code: "Q01",
          type: "Q",
          text: { ...T.questionText },
          subquestions: [{ code: "SQ001", text: { ...T.subquestionText }, default: { de: "Eins", en: "One" } }],
        },
      ],
    }],
  };
  await withSession(async (session) => {
    const created = await session.client.callTool({ name: CREATE, arguments: { spec } });
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent ?? created.content));
    const result = resultOf(created);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));

    const read = await session.client.callTool({ name: GET, arguments: { survey_id: Number(result.survey_id) } });
    assert.equal(read.isError, undefined, JSON.stringify(read.structuredContent ?? read.content));
    const questions = resultOf(read).spec.groups[0].questions as Json[];
    assert.deepEqual(questions[0]?.script, { de: "// Skript", en: "// Script" });
    assert.deepEqual(questions[0]?.default, { de: "Hallo", en: "Hello" });
    assert.deepEqual(questions[1]?.subquestions[0]?.default, { de: "Eins", en: "One" });
  }, fake);
});

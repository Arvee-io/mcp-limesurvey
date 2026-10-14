import assert from "node:assert/strict";
import test from "node:test";
import { generateSurveyLss } from "../src/spec-generate.js";
import { LimeSurveyError } from "../src/types.js";
import { FakeLimeSurvey } from "./helpers/fake-limesurvey.js";
import { connectFake, envConfig, paritySpec, resultOf, type Session } from "./helpers/mcp-session.js";

/**
 * GEN-E: limesurvey_validate_spec checks a survey description locally and reports every problem at once with its
 * path, a message and a fix. It never talks to LimeSurvey (not even for a session key).
 */

const TOOL = "limesurvey_validate_spec";

type Spec = Record<string, any>;

interface Finding {
  path: string;
  message: string;
  fix: string;
}

interface Validation {
  valid: boolean;
  kind: string;
  errors: Finding[];
  warnings: unknown[];
  summary: unknown;
}

async function withSession<T>(run: (session: Session) => Promise<T>, config?: ReturnType<typeof envConfig>): Promise<T> {
  const session = await connectFake(config === undefined ? {} : { config });
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

async function validate(session: Session, spec: unknown, extra: Record<string, unknown> = {}): Promise<Validation> {
  const response = await session.client.callTool({ name: TOOL, arguments: { spec, ...extra } });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
  assert.equal((response.structuredContent as { workflow?: string } | undefined)?.workflow, "validate_spec");
  assert.deepEqual(session.fake.requests, [], "validate_spec must not send any RPC, not even get_session_key");
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

const question = (code: string, extra: Spec = {}): Spec => ({ code, type: "S", text: `Text ${code}`, ...extra });
const surveyWith = (questions: Spec[], survey: Spec = { title: "Titel" }): Spec => ({
  survey,
  groups: [{ title: "Gruppe", questions }],
});
const Q0 = "groups[0].questions[0]";
const Q1 = "groups[0].questions[1]";

test("[GEN-E] validate_spec accepts the plugin example spec", async () => {
  await withSession(async (session) => {
    const result = await validate(session, await paritySpec("p01-plugin-example"));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
    assert.equal(result.kind, "survey");
    assert.ok(Array.isArray(result.warnings));
  });
});

test("[GEN-E] validate_spec never sends an RPC, for valid and invalid specs", async () => {
  await withSession(async (session) => {
    await validate(session, await paritySpec("p01-plugin-example"));
    await validate(session, { survey: {}, groups: [] });
    assert.equal(session.fake.requests.length, 0);
  });
});

test("[GEN-E] validate_spec: a missing survey.title is reported at survey.title", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01")], { language: "de" }));
    errorAt(result, "survey.title");
  });
});

test("[GEN-E] validate_spec: empty groups are reported at groups", async () => {
  await withSession(async (session) => {
    const result = await validate(session, { survey: { title: "Titel" }, groups: [] });
    errorAt(result, "groups");
  });
});

test("[GEN-E] validate_spec: the question code 1A is reported at groups[0].questions[1].code", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01"), question("1A")]));
    errorAt(result, `${Q1}.code`);
    assert.ok(!result.errors.some((item) => item.path === `${Q0}.code`));
  });
});

test("[GEN-E] validate_spec: codes that differ only in case are duplicates, reported at the second one", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("A01"), question("a01")]));
    errorAt(result, `${Q1}.code`);
    assert.ok(!result.errors.some((item) => item.path === `${Q0}.code`), "the first occurrence is fine");
  });
});

test("[GEN-E] validate_spec: the reserved code SID is reported at the code", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("SID")]));
    errorAt(result, `${Q0}.code`);
  });
});

test("[GEN-E] validate_spec: the unknown type Z is reported at the type", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", { type: "Z" })]));
    errorAt(result, `${Q0}.type`);
  });
});

test("[GEN-E] validate_spec: type L without answers is reported at answers", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", { type: "L" })]));
    errorAt(result, `${Q0}.answers`);
  });
});

test("[GEN-E] validate_spec: type M with answers is reported at answers", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", {
      type: "M",
      subquestions: [{ code: "SQ001", text: "Eins" }],
      answers: [{ code: "A1", text: "Ja" }],
    })]));
    errorAt(result, `${Q0}.answers`);
  });
});

test("[GEN-E] validate_spec: type F without subquestions is reported at subquestions", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", {
      type: "F",
      answers: [{ code: "A1", text: "Ja" }],
    })]));
    errorAt(result, `${Q0}.subquestions`);
  });
});

test("[GEN-E] validate_spec: other=true on type S is reported at other", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", { other: true })]));
    errorAt(result, `${Q0}.other`);
  });
});

test("[GEN-E] validate_spec: an answer code of six characters is reported at the answer code", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", {
      type: "L",
      answers: [{ code: "ABCDEF", text: "Zu lang" }],
    })]));
    errorAt(result, "groups[0].questions[0].answers[0].code");
  });
});

test("[GEN-E] validate_spec: the subquestion code time is reported at the subquestion code", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", {
      type: "M",
      subquestions: [{ code: "time", text: "Zeit" }],
    })]));
    errorAt(result, `${Q0}.subquestions[0].code`);
  });
});

test("[GEN-E] validate_spec: an embedded data URI in a text is reported at the text", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", {
      text: 'Bild: <img src="data:image/png;base64,AAAA">',
    })]));
    errorAt(result, `${Q0}.text`);
  });
});

test("[GEN-E] validate_spec: survey.expires in the format 31.12.2026 is reported at survey.expires", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01")], { title: "Titel", expires: "31.12.2026" }));
    errorAt(result, "survey.expires");
  });
});

test("[GEN-E] validate_spec: an unknown key such as mandatroy is reported at its own path", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", { mandatroy: true })]));
    errorAt(result, `${Q0}.mandatroy`);
  });
});

test("[GEN-E] validate_spec reports several problems at once", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("1A", { type: "Z" })], { language: "de" }));
    assert.ok(result.errors.length >= 3, JSON.stringify(result.errors));
    errorAt(result, "survey.title");
    errorAt(result, `${Q0}.code`);
    errorAt(result, `${Q0}.type`);
  });
});

test("[GEN-E] validate_spec with kind question accepts a single valid question", async () => {
  await withSession(async (session) => {
    const result = await validate(session, question("Q01"), { kind: "question" });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.kind, "question");
    assert.deepEqual(result.errors, []);
  });
});

const unsupportedTypes: Array<[string, Spec]> = [
  ["1", {
    subquestions: [{ code: "SQ001", text: "Zeile" }],
    answers: [{ code: "A1", text: "Links", scale_id: 0 }, { code: "B1", text: "Rechts", scale_id: 1 }],
  }],
  [":", {
    subquestions: [{ code: "SQ001", text: "Zeile", scale_id: 0 }, { code: "SQ002", text: "Spalte", scale_id: 1 }],
  }],
  [";", {
    subquestions: [{ code: "SQ001", text: "Zeile", scale_id: 0 }, { code: "SQ002", text: "Spalte", scale_id: 1 }],
  }],
];

for (const [type, extra] of unsupportedTypes) {
  test(`[GEN-E] validate_spec rejects the type ${type} in this version, at the type path, naming the type`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, surveyWith([question("Q01", { type, ...extra })]));
      const finding = errorAt(result, `${Q0}.type`);
      assert.ok(finding.message.includes(type), `the message does not name the type: ${finding.message}`);
    });
  });
}

test("[GEN-E] validate_spec rejects a language code that would break the XML, at survey.language", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01")], {
      title: "Titel",
      language: "de</language></languages><plugin_settings/><languages><language>de",
    }));
    errorAt(result, "survey.language");
  });
});

test("[GEN-E] validate_spec rejects an invalid additional language at its index", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01")], { title: "Titel", additional_languages: ["en", "x y"] }));
    errorAt(result, "survey.additional_languages[1]");
    assert.ok(!result.errors.some((item) => item.path === "survey.additional_languages[0]"));
  });
});

test("[GEN-E] validate_spec rejects control characters that XML 1.0 forbids, at the text", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", { text: "Hallo\u0001Welt" })]));
    errorAt(result, `${Q0}.text`);
  });
});

test("[GEN-E] the generator refuses an invalid spec with SPEC_INVALID instead of writing broken XML", () => {
  assert.throws(
    () => generateSurveyLss(surveyWith([question("Q01")], { title: "Titel", language: "de</language>" })),
    (error: unknown) => error instanceof LimeSurveyError && error.code === "SPEC_INVALID",
  );
});

test("[GEN-E] validate_spec without survey_id says which survey checks it skipped", async () => {
  await withSession(async (session) => {
    const result = await validate(session, question("Q01"), { kind: "question" }) as Validation & {
      checked_against_survey?: boolean;
      skipped_checks?: unknown[];
    };
    assert.equal(result.checked_against_survey, false);
    assert.ok(Array.isArray(result.skipped_checks) && result.skipped_checks.length > 0, JSON.stringify(result));
  });
});

test("[GEN-E] validate_spec with survey_id reads the survey (read methods only, also under write scope none) and reports a taken code", async () => {
  const fake = new FakeLimeSurvey();
  // Put a survey into the fake with the content scope, then validate under none.
  const writer = await connectFake({ fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "content" }) });
  let sid: number;
  try {
    const created = await writer.client.callTool({ name: "limesurvey_create_survey_from_spec", arguments: { spec: await paritySpec("p03-minimal-matrix") } });
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent ?? created.content));
    sid = Number(resultOf(created).survey_id);
  } finally {
    await writer.close();
  }
  const reader = await connectFake({ fake, config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) });
  try {
    const before = fake.requests.length;
    const response = await reader.client.callTool({
      name: TOOL,
      arguments: { kind: "question", survey_id: sid, spec: question("A01") },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    const result = resultOf(response) as Validation & { checked_against_survey?: boolean };
    assert.equal(result.checked_against_survey, true);
    errorAt(result, "code");
    const methods = fake.requests.slice(before).map((request) => request.method);
    assert.ok(methods.length > 0, "validate_spec with survey_id reads the survey");
    for (const method of methods) {
      assert.match(method, /^(get_session_key|release_session_key|get_[a-z_]+|list_[a-z_]+)$/, `${method} is not a read method`);
    }
  } finally {
    await reader.close();
  }
});

// ---- Review of PR2, finding 1: a language code may appear once, and not as the base language ----

const duplicateLanguageCases: Array<{ label: string; survey: Spec; path: string; fineAt?: string }> = [
  {
    label: "a language listed twice",
    survey: { title: "Titel", additional_languages: ["en", "en"] },
    path: "survey.additional_languages[1]",
    fineAt: "survey.additional_languages[0]",
  },
  {
    label: "a language listed twice in another case",
    survey: { title: "Titel", additional_languages: ["en", "EN"] },
    path: "survey.additional_languages[1]",
    fineAt: "survey.additional_languages[0]",
  },
  {
    label: "the base language as additional language",
    survey: { title: "Titel", language: "de", additional_languages: ["de"] },
    path: "survey.additional_languages[0]",
  },
  {
    label: "the base language as additional language in another case",
    survey: { title: "Titel", language: "de", additional_languages: ["en", "DE"] },
    path: "survey.additional_languages[1]",
    fineAt: "survey.additional_languages[0]",
  },
  {
    label: "the default base language de as additional language",
    survey: { title: "Titel", additional_languages: ["de"] },
    path: "survey.additional_languages[0]",
  },
];

for (const { label, survey, path, fineAt } of duplicateLanguageCases) {
  test(`[GEN-E] validate_spec rejects ${label}, at ${path}`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, surveyWith([question("Q01")], survey));
      errorAt(result, path);
      if (fineAt !== undefined) assert.ok(!result.errors.some((item) => item.path === fineAt), `${fineAt} is the first occurrence and fine`);
    });
  });
}

test("[GEN-E] validate_spec accepts different additional languages", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01")], { title: "Titel", language: "de", additional_languages: ["en", "fr", "pt-BR"] }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ---- Review of PR2, finding 5: the error list stays within LIMESURVEY_MAX_RESPONSE_CHARS ----

/** A survey spec whose every question has an invalid code (a digit first): one error per question. */
const manyBadQuestions = (count: number): Spec => surveyWith(
  Array.from({ length: count }, (_unused, index) => question(`${index}A`)),
);

test("[GEN-E] validate_spec keeps the error list within LIMESURVEY_MAX_RESPONSE_CHARS and reports errors_total and truncated", async () => {
  const limit = 4000;
  await withSession(async (session) => {
    const response = await session.client.callTool({ name: TOOL, arguments: { spec: manyBadQuestions(300) } });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 500));
    const size = JSON.stringify(response.structuredContent).length;
    assert.ok(size <= limit, `the result has ${size} characters, the limit is ${limit}`);
    const result = resultOf(response) as Validation & { errors_total?: number; truncated?: boolean };
    assert.equal(result.valid, false);
    assert.ok(typeof result.errors_total === "number" && result.errors_total >= 300, `errors_total: ${String(result.errors_total)}`);
    assert.equal(result.truncated, true);
    assert.ok(result.errors.length >= 1, "the cut list still shows the first errors");
    assert.ok(result.errors.length < (result.errors_total ?? 0), "the list is shorter than the total");
    assert.equal(result.errors[0]?.path, `${Q0}.code`, "the cut keeps the errors from the start");
    assert.deepEqual(session.fake.requests, []);
  }, envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }));
});

test("[GEN-E] validate_spec reports errors_total equal to the list and truncated false when nothing is cut", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("1A"), question("Q02", { type: "Z" })])) as Validation & {
      errors_total?: number;
      truncated?: boolean;
    };
    assert.ok(result.errors.length >= 2, JSON.stringify(result.errors));
    assert.equal(result.errors_total, result.errors.length);
    assert.equal(result.truncated, false);
  });
});

// ---- Review of PR2, finding 7: texts, attribute names, survey.format and survey.expires ----

const BAD_TEXTS: Array<[string, string]> = [
  ["U+FFFE", "a￾b"],
  ["U+FFFF", "a￿b"],
  ["a lone high surrogate", "a\uD800b"],
  ["a lone low surrogate", "a\uDC00b"],
  ["a high surrogate at the end", "ab\uD83D"],
];

for (const [label, text] of BAD_TEXTS) {
  test(`[GEN-E] validate_spec rejects a text with ${label}, at the text`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, surveyWith([question("Q01", { text })]));
      errorAt(result, `${Q0}.text`);
    });
  });
}

test("[GEN-E] validate_spec accepts a text with a complete surrogate pair (an emoji)", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01", { text: "Gut \u{1F600} und \u{1F44D}" })]));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

const BAD_ATTRIBUTE_NAMES: Array<[string, string]> = [
  ["a control character", "a\u0001b"],
  ["an empty name", ""],
  ["a leading digit", "1abc"],
  ["a hyphen", "a-b"],
  ["51 characters", `a${"b".repeat(50)}`],
];

for (const [label, name] of BAD_ATTRIBUTE_NAMES) {
  test(`[GEN-E] validate_spec rejects an attribute name with ${label}, at attributes.<name>`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, surveyWith([question("Q01", { attributes: { [name]: "1" } })]));
      errorAt(result, `${Q0}.attributes.${name}`);
    });
  });
}

test("[GEN-E] validate_spec accepts attribute names of 1 to 50 letters, digits and underscores that start with a letter", async () => {
  await withSession(async (session) => {
    const names = ["maximum_chars", "A1_b", "x", `a${"b".repeat(49)}`];
    const result = await validate(session, surveyWith([question("Q01", { attributes: Object.fromEntries(names.map((name) => [name, "1"])) })]));
    assert.ok(!result.errors.some((item) => item.path.startsWith(`${Q0}.attributes`)), JSON.stringify(result.errors));
  });
});

test("[GEN-E] validate_spec rejects survey.format X at survey.format", async () => {
  await withSession(async (session) => {
    const result = await validate(session, surveyWith([question("Q01")], { title: "Titel", format: "X" }));
    errorAt(result, "survey.format");
  });
});

for (const format of ["G", "A", "S"]) {
  test(`[GEN-E] validate_spec accepts survey.format ${format}`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, surveyWith([question("Q01")], { title: "Titel", format }));
      assert.ok(!result.errors.some((item) => item.path === "survey.format"), JSON.stringify(result.errors));
    });
  });
}

for (const expires of ["2026-13-45", "2026-02-30 10:00:00", "2026-02-29", "2026-06-15 10:61:00"]) {
  test(`[GEN-E] validate_spec rejects survey.expires ${expires} (not a valid date), at survey.expires`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, surveyWith([question("Q01")], { title: "Titel", expires }));
      errorAt(result, "survey.expires");
    });
  });
}

for (const expires of ["2028-02-29", "2026-12-31", "2026-12-31 23:59:59", "2026-01-01 00:00:00"]) {
  test(`[GEN-E] validate_spec accepts the real date survey.expires ${expires}`, async () => {
    await withSession(async (session) => {
      const result = await validate(session, surveyWith([question("Q01")], { title: "Titel", expires }));
      assert.ok(!result.errors.some((item) => item.path === "survey.expires"), JSON.stringify(result.errors));
    });
  });
}

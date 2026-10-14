import assert from "node:assert/strict";
import test from "node:test";
import { FakeLimeSurvey } from "./helpers/fake-limesurvey.js";
import { connectFake, envConfig, paritySpec, parityLss, resultOf, type Session } from "./helpers/mcp-session.js";

/**
 * GEN-E: limesurvey_create_survey_from_spec checks the spec locally, builds the .lss, imports it with import_survey
 * and reads the survey back to compare it with the spec. GEN-NOFILE: neither new tool takes a file path.
 */

const CREATE = "limesurvey_create_survey_from_spec";
const VALIDATE = "limesurvey_validate_spec";

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

const create = (session: Session, spec: unknown) => session.client.callTool({ name: CREATE, arguments: { spec } });

const mainQuestions = (fake: FakeLimeSurvey, sid: number) => fake.questions.filter((item) => item.sid === sid && item.parent_qid === 0);

test("[GEN-E] create_survey_from_spec imports the generated .lss and the survey exists afterwards (p03)", async () => {
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p03-minimal-matrix"));
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    const result = resultOf(response);
    const survey = session.fake.surveys[0];
    assert.ok(survey, "the fake has no survey after the import");
    assert.equal(session.fake.surveys.length, 1);
    assert.equal(result.survey_id, survey.sid);
    assert.equal(result.title, "Seminarfeedback Führungstraining");
    assert.deepEqual(result.languages, ["de"]);
    assert.equal(result.groups, 1);
    assert.equal(result.questions, 1);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    assert.deepEqual(result.verification.differences, []);
    assert.equal(result.verification.differences_total, 0);
    assert.equal(result.verification.truncated, false);

    const imports = session.fake.requests.filter((request) => request.method === "import_survey");
    assert.equal(imports.length, 1, "exactly one import_survey call");
    const request = imports[0];
    assert.ok(request);
    assert.equal(request.params[2], "lss");
    assert.equal(request.params[3], null);
    assert.equal(request.params[4], null);
    const sent = Buffer.from(String(request.params[1]), "base64");
    const expected = await parityLss("p03-minimal-matrix");
    assert.ok(sent.equals(expected), "the imported file differs from the reference .lss of the Python generator");

    assert.equal(session.fake.groups.filter((group) => group.sid === survey.sid).length, 1);
    assert.equal(mainQuestions(session.fake, survey.sid).length, 1);
  });
});

test("[GEN-E] create_survey_from_spec reads the survey back and finds no difference for the 14 types of the plugin example (p01)", async () => {
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p01-plugin-example"));
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    const result = resultOf(response);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    assert.deepEqual(result.verification.differences, []);
    assert.equal(result.groups, 2);
    assert.equal(result.questions, 14);
    const survey = session.fake.surveys[0];
    assert.ok(survey);
    assert.deepEqual(
      new Set(mainQuestions(session.fake, survey.sid).map((item) => item.type)),
      new Set(["X", "L", "!", "O", "M", "Y", "N", "S", "T", "Q", "5", "F", "A", "R"]),
    );
    // The read-back used read methods only: no other write than the import.
    const writes = session.fake.requests.filter((request) => /^(import_|set_|delete_|add_)/.test(request.method));
    assert.deepEqual(writes.map((request) => request.method), ["import_survey"]);
  });
});

test("[GEN-E] create_survey_from_spec creates a survey with two languages (p04)", async () => {
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p04-languages-settings"));
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    const result = resultOf(response);
    assert.deepEqual(result.languages, ["de", "en"]);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    const survey = session.fake.surveys[0];
    assert.ok(survey);
    assert.equal(survey.language, "de");
    assert.equal(survey.additional_languages, "en");
  });
});

test("[GEN-E] create_survey_from_spec with an invalid spec answers SPEC_INVALID and sends no RPC", async () => {
  await withSession(async (session) => {
    const response = await create(session, { survey: { language: "de" }, groups: [] });
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "SPEC_INVALID");
    const errors = result.details?.errors as Array<{ path?: string; message?: string; fix?: string }> | undefined;
    assert.ok(Array.isArray(errors) && errors.length > 0, JSON.stringify(result.details));
    const first = errors[0];
    assert.ok(typeof first?.path === "string" && first.path.length > 0, "the first error has a path");
    assert.deepEqual(session.fake.requests, [], "an invalid spec must not reach LimeSurvey");
    assert.equal(session.fake.surveys.length, 0);
  });
});

test("[GEN-E] create_survey_from_spec turns a failing import_survey into CREATE_SURVEY_FAILED with the LimeSurvey text", async () => {
  const fake = new FakeLimeSurvey();
  fake.failNext("import_survey", { status: "Error: simulated import failure", error_code: "ERR_CREATION_FAILED" });
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p03-minimal-matrix"));
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "CREATE_SURVEY_FAILED");
    assert.match(String(result.message), /simulated import failure/);
    assert.equal(session.fake.surveys.length, 0);
  }, { fake });
});

test("[GEN-E] create_survey_from_spec reports a difference after the import in verification, not as an error", async () => {
  const fake = new FakeLimeSurvey({ dropFirstAnswerOnImport: true });
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p03-minimal-matrix"));
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    const result = resultOf(response);
    assert.equal(result.verification.ok, false);
    const differences = result.verification.differences as Array<{ path: string; expected: unknown; actual: unknown }>;
    assert.ok(differences.length >= 1, JSON.stringify(result.verification));
    assert.ok(differences.some((item) => String(item.path).includes("answers")), JSON.stringify(differences));
    assert.ok(result.verification.differences_total >= differences.length);
    assert.equal(result.verification.truncated, false);
    assert.ok(Number.isInteger(result.survey_id), "the created survey is still reported");
  }, { fake });
});

test("[GEN-E] create_survey_from_spec needs the write scope content; validate_spec works under none", async () => {
  const spec = await paritySpec("p03-minimal-matrix");
  await withSession(async (session) => {
    const blocked = await create(session, spec);
    assert.equal(blocked.isError, true);
    assert.equal(resultOf(blocked).code, "WRITE_SCOPE_INSUFFICIENT");
    assert.deepEqual(session.fake.requests, []);

    const validated = await session.client.callTool({ name: VALIDATE, arguments: { spec } });
    assert.equal(validated.isError, undefined, JSON.stringify(validated.structuredContent ?? validated.content));
    assert.deepEqual(session.fake.requests, []);
  }, { config: envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }) });

  await withSession(async (session) => {
    const response = await create(session, spec);
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    assert.equal(resultOf(response).verification.ok, true);
  }, { config: envConfig({ LIMESURVEY_WRITE_SCOPE: "content" }) });
});

/** Every property name anywhere in a JSON schema. */
function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (schema === null || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const own = record.properties !== null && typeof record.properties === "object" ? Object.keys(record.properties) : [];
  return [...own, ...Object.values(record).flatMap(propertyNames)];
}

test("[GEN-NOFILE] neither tool takes a path or file parameter and both work without import and export directories", async () => {
  const config = envConfig();
  assert.equal(config.importDir, undefined);
  assert.equal(config.exportDir, undefined);
  await withSession(async (session) => {
    const listed = await session.client.listTools();
    for (const name of [VALIDATE, CREATE]) {
      const tool = listed.tools.find((item) => item.name === name);
      assert.ok(tool, `${name} is not registered`);
      const offending = propertyNames(tool.inputSchema).filter((property) => /path|file/i.test(property));
      assert.deepEqual(offending, [], `${name} has file parameters`);
    }
    const spec = await paritySpec("p03-minimal-matrix");
    const validated = await session.client.callTool({ name: VALIDATE, arguments: { spec } });
    assert.equal(validated.isError, undefined, JSON.stringify(validated.structuredContent ?? validated.content));
    const created = await create(session, spec);
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent ?? created.content));
  }, { config });
});

test("[GEN-E] the tool annotations follow the design", async () => {
  await withSession(async (session) => {
    const listed = await session.client.listTools();
    const validate = listed.tools.find((item) => item.name === VALIDATE);
    const createTool = listed.tools.find((item) => item.name === CREATE);
    assert.ok(validate && createTool, "both tools must be registered");
    assert.equal(validate.annotations?.readOnlyHint, true);
    assert.equal(validate.annotations?.destructiveHint, false);
    // validate_spec reads the target survey when survey_id is given (design 9.6).
    assert.equal(validate.annotations?.openWorldHint, true);
    assert.equal(createTool.annotations?.readOnlyHint, false);
    assert.equal(createTool.annotations?.destructiveHint, false);
  });
});

// ---- Review of PR2 ----

/** Replaces the fetch of the fake (a readonly field of the class) with a wrapper; call before connectFake. */
function wrapFetch(fake: FakeLimeSurvey, wrap: (original: typeof fetch) => typeof fetch): void {
  const target = fake as unknown as { fetch: typeof fetch };
  target.fetch = wrap(target.fetch);
}

const requestMethod = (init: RequestInit | undefined): string => String((JSON.parse(String(init?.body)) as { method?: unknown }).method);

// Finding 1: a language code may appear once, and not as the base language. The tool answers SPEC_INVALID, no RPC.

async function p03WithLanguages(language: string | undefined, additional: string[]): Promise<Record<string, any>> {
  const spec = await paritySpec("p03-minimal-matrix");
  spec.survey = { ...spec.survey, ...(language !== undefined ? { language } : {}), additional_languages: additional };
  return spec;
}

const duplicateLanguageCases: Array<{ label: string; language: string | undefined; additional: string[]; path: string }> = [
  { label: "a language listed twice", language: undefined, additional: ["en", "en"], path: "survey.additional_languages[1]" },
  { label: "the base language as additional language", language: "de", additional: ["de"], path: "survey.additional_languages[0]" },
  { label: "the base language in another case", language: "de", additional: ["en", "DE"], path: "survey.additional_languages[1]" },
];

for (const { label, language, additional, path } of duplicateLanguageCases) {
  test(`[GEN-E] create_survey_from_spec answers SPEC_INVALID at ${path} for ${label} and sends no RPC`, async () => {
    await withSession(async (session) => {
      const response = await create(session, await p03WithLanguages(language, additional));
      assert.equal(response.isError, true);
      const result = resultOf(response);
      assert.equal(result.code, "SPEC_INVALID");
      const errors = (result.details?.errors ?? []) as Array<{ path?: string }>;
      assert.ok(errors.some((item) => item.path === path), `no error at ${path}; paths: ${errors.map((item) => item.path).join(", ")}`);
      assert.deepEqual(session.fake.requests, [], "an invalid spec must not reach LimeSurvey");
      assert.equal(session.fake.surveys.length, 0);
    });
  });
}

// Finding 2: CREATE_SURVEY_FAILED tells "nothing was created" (LimeSurvey answered with an error) apart from "unknown"
// (the call itself failed: transport error or JSON-RPC error, so the import may have run).

const P03_TITLE = "Seminarfeedback Führungstraining";

test("[GEN-E] CREATE_SURVEY_FAILED after a status error with error_code says created: false", async () => {
  const fake = new FakeLimeSurvey();
  fake.failNext("import_survey", { status: "Error: x", error_code: "ERR_CREATION_FAILED" });
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p03-minimal-matrix"));
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "CREATE_SURVEY_FAILED");
    assert.equal(result.details?.failed_step, "import_survey");
    assert.equal(result.details?.created, false);
    assert.notEqual(result.details?.manual_cleanup, true);
    assert.equal(session.fake.surveys.length, 0);
  }, { fake });
});

test("[GEN-E] CREATE_SURVEY_FAILED after a JSON-RPC error says created: unknown, manual_cleanup, the title and limesurvey_find_surveys", async () => {
  const fake = new FakeLimeSurvey();
  fake.failNext("import_survey", new Error("boom")); // the fake answers a JSON-RPC error
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p03-minimal-matrix"));
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "CREATE_SURVEY_FAILED");
    assert.equal(result.details?.failed_step, "import_survey");
    assert.equal(result.details?.created, "unknown");
    assert.equal(result.details?.manual_cleanup, true);
    assert.equal(result.details?.title, P03_TITLE);
    assert.match(String(result.details?.recovery), /limesurvey_find_surveys/);
  }, { fake });
});

test("[GEN-E] CREATE_SURVEY_FAILED after a lost answer (the survey exists) says created: unknown, manual_cleanup, the title and limesurvey_find_surveys", async () => {
  const fake = new FakeLimeSurvey();
  // LimeSurvey imports the survey, but the answer never arrives: a transport error.
  wrapFetch(fake, (original) => async (input, init) => {
    const response = await original(input, init);
    if (requestMethod(init) === "import_survey") throw new TypeError("fetch failed");
    return response;
  });
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p03-minimal-matrix"));
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "CREATE_SURVEY_FAILED");
    assert.equal(session.fake.surveys.length, 1, "the fake did create the survey; the tool cannot know that");
    assert.equal(result.details?.failed_step, "import_survey");
    assert.equal(result.details?.created, "unknown");
    assert.equal(result.details?.manual_cleanup, true);
    assert.equal(result.details?.title, P03_TITLE);
    assert.match(String(result.details?.recovery), /limesurvey_find_surveys/);
  }, { fake });
});

// Finding 4: every get_survey_properties call carries an explicit field list without the secret fields.

const SECRET_PROPERTIES = ["bounceaccountpass", "bounceaccountuser", "bounceaccounthost", "googleanalyticsapikey", "tokenencryptionoptions"];

/** The field lists (third RPC parameter after the session key) of the get_survey_properties calls from index `from`. */
function fieldLists(fake: FakeLimeSurvey, from: number): unknown[] {
  return fake.requests.slice(from).filter((request) => request.method === "get_survey_properties").map((request) => request.params[2]);
}

function assertSafeFieldLists(lists: unknown[], label: string): void {
  assert.ok(lists.length > 0, `${label}: no get_survey_properties call was recorded`);
  for (const list of lists) {
    assert.ok(Array.isArray(list) && list.length > 0, `${label}: the field list must be a non-empty array, got ${JSON.stringify(list)}`);
    const names = (list as unknown[]).map((item) => String(item).toLowerCase());
    for (const secret of SECRET_PROPERTIES) assert.ok(!names.includes(secret), `${label}: the field list asks for ${secret}`);
  }
}

test("[GEN-E] get_survey_properties is always called with a non-empty field list without secret fields (create p04, validate with survey_id)", async () => {
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p04-languages-settings"));
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    assertSafeFieldLists(fieldLists(session.fake, 0), "create_survey_from_spec");

    const sid = Number(resultOf(response).survey_id);
    const groupSpec = { title: "Neue Gruppe", questions: [{ code: "Z01", type: "S", text: "Frage" }] };
    for (const [kind, spec] of [["question", groupSpec.questions[0]], ["group", groupSpec]] as const) {
      const before = session.fake.requests.length;
      const validated = await session.client.callTool({ name: VALIDATE, arguments: { kind, survey_id: sid, spec } });
      assert.equal(validated.isError, undefined, JSON.stringify(validated.structuredContent ?? validated.content));
      assertSafeFieldLists(fieldLists(session.fake, before), `validate_spec kind ${kind}`);
    }
  });
});

// Finding 5: the result stays within LIMESURVEY_MAX_RESPONSE_CHARS; cut lists say so (*_total, truncated).

const manyBadSpec = (count: number) => ({
  survey: { title: "Titel" },
  groups: [{
    title: "Gruppe",
    questions: Array.from({ length: count }, (_unused, index) => ({ code: `${index}A`, type: "S", text: `Text ${index}` })),
  }],
});

test("[GEN-E] create_survey_from_spec keeps the SPEC_INVALID details within LIMESURVEY_MAX_RESPONSE_CHARS and reports errors_total and truncated", async () => {
  const limit = 4000;
  await withSession(async (session) => {
    const response = await create(session, manyBadSpec(300));
    assert.equal(response.isError, true);
    const size = JSON.stringify(response.structuredContent).length;
    assert.ok(size <= limit, `the result has ${size} characters, the limit is ${limit}`);
    const result = resultOf(response);
    assert.equal(result.code, "SPEC_INVALID");
    assert.ok(typeof result.details?.errors_total === "number" && result.details.errors_total >= 300, `errors_total: ${String(result.details?.errors_total)}`);
    assert.equal(result.details?.truncated, true);
    const errors = result.details?.errors as Array<{ path?: string }> | undefined;
    assert.ok(Array.isArray(errors) && errors.length >= 1, "the cut list still shows the first errors");
    assert.ok(errors.length < result.details?.errors_total, "the list is shorter than the total");
    assert.equal(errors[0]?.path, "groups[0].questions[0].code");
    assert.deepEqual(session.fake.requests, [], "an invalid spec must not reach LimeSurvey");
  }, { config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) });
});

test("[GEN-E] create_survey_from_spec keeps the success result within LIMESURVEY_MAX_RESPONSE_CHARS and reports the cut differences", async () => {
  const limit = 1500;
  const spec = {
    survey: { title: "Grenztest" },
    groups: [{
      title: "Gruppe",
      questions: Array.from({ length: 40 }, (_unused, index) => ({ code: `Q${String(index + 1).padStart(2, "0")}`, type: "S", text: `Text ${index + 1}` })),
    }],
  };
  const fake = new FakeLimeSurvey();
  // After the import every question text changes, so the comparison finds one difference per question (40 in all).
  wrapFetch(fake, (original) => async (input, init) => {
    const response = await original(input, init);
    if (requestMethod(init) === "import_survey") {
      for (const item of fake.questions) for (const row of Object.values(item.l10n)) row.question = "geändert";
    }
    return response;
  });
  await withSession(async (session) => {
    const response = await create(session, spec);
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 500));
    const size = JSON.stringify(response.structuredContent).length;
    assert.ok(size <= limit, `the result has ${size} characters, the limit is ${limit}`);
    const result = resultOf(response);
    assert.equal(result.verification.ok, false);
    assert.ok(result.verification.differences_total >= 40, `differences_total: ${String(result.verification.differences_total)}`);
    assert.equal(result.verification.truncated, true);
    const differences = result.verification.differences as unknown[];
    assert.ok(differences.length >= 1 && differences.length < result.verification.differences_total, `${differences.length} differences are shown`);
    assert.ok(Number.isInteger(result.survey_id), "the created survey is still reported");
  }, { fake, config: envConfig({ LIMESURVEY_MAX_RESPONSE_CHARS: String(limit) }) });
});

// Finding 9: the recovery after a failed read-back names the created survey and no tool that needs a file path.

test("[GEN-E] a failing read-back after the import names the created survey_id and does not point to limesurvey_verify_survey_against_lss", async () => {
  const fake = new FakeLimeSurvey();
  fake.failNext("list_questions", { status: "Error: x", error_code: "ERR_INVALID_SURVEY" });
  await withSession(async (session) => {
    const response = await create(session, await paritySpec("p03-minimal-matrix"));
    assert.equal(response.isError, true);
    const result = resultOf(response);
    assert.equal(result.code, "CREATE_SURVEY_FAILED");
    const survey = session.fake.surveys[0];
    assert.ok(survey, "the survey was created by the import");
    assert.equal(result.details?.created, true);
    assert.equal(result.details?.survey_id, survey.sid);
    assert.ok(typeof result.details?.recovery === "string" && result.details.recovery.length > 0, "the error carries a recovery text");
    const everything = JSON.stringify(result);
    assert.ok(everything.includes(String(survey.sid)), "the answer names the created survey_id");
    assert.ok(!everything.includes("limesurvey_verify_survey_against_lss"), "the recovery points to a tool that needs a file path");
  }, { fake });
});

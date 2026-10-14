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

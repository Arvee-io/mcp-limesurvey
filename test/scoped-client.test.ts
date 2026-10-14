import assert from "node:assert/strict";
import test from "node:test";
import { scopedClient, type ClientLevel, type RpcClient } from "../src/scoped-client.js";
import { LimeSurveyError, type JsonValue } from "../src/types.js";

/**
 * GEN-E: scopedClient is the guard between a spec tool and LimeSurvey. Level none sends reads only, level content adds
 * the content writes of the spec tools but never a delete, an activation, anything that touches participants or
 * responses, or a .lsa import. A third parameter narrows the content writes of one call to a list of methods.
 */

interface Call {
  method: string;
  params: JsonValue[];
}

/** An RpcClient that records what reaches it and answers "ok". */
function spy(): { inner: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const inner: RpcClient = {
    async call(method, params = []) {
      calls.push({ method, params });
      return "ok";
    },
  };
  return { inner, calls };
}

interface ScopeOptions {
  writeMethods?: readonly string[];
}

/** The signature after the change (third parameter options); the cast keeps the test compiling before it exists. */
const scopedWithOptions = scopedClient as unknown as (client: RpcClient, level: ClientLevel, options?: ScopeOptions) => RpcClient;

const LSS: JsonValue[] = ["QUJD", "lss", null, null];
const lsa = (type: string): JsonValue[] => ["QUJD", type, null, null];

async function assertPasses(client: RpcClient, calls: Call[], method: string, params: JsonValue[]): Promise<void> {
  const before = calls.length;
  assert.equal(await client.call(method, params), "ok", `${method} did not reach the inner client`);
  assert.equal(calls.length, before + 1, `${method}: the inner client must be called exactly once`);
  assert.deepEqual(calls[calls.length - 1], { method, params });
}

async function assertRejected(client: RpcClient, calls: Call[], method: string, params: JsonValue[]): Promise<void> {
  const before = calls.length;
  await assert.rejects(
    client.call(method, params),
    (error: unknown) => error instanceof LimeSurveyError && error.code === "METHOD_NOT_ALLOWED",
    `${method} ${JSON.stringify(params)} must be rejected with METHOD_NOT_ALLOWED`,
  );
  assert.equal(calls.length, before, `${method} ${JSON.stringify(params)} must not reach the inner client`);
}

const READS: Array<[string, JsonValue[]]> = [
  ["get_survey_properties", [1, ["language"]]],
  ["list_questions", [1, null, "de"]],
  ["get_fieldmap", [1]],
  ["release_session_key", []],
];

test("[GEN-E] scopedClient level none passes the read methods and the session release through", async () => {
  const { inner, calls } = spy();
  const client = scopedClient(inner, "none");
  for (const [method, params] of READS) await assertPasses(client, calls, method, params);
});

test("[GEN-E] scopedClient level none rejects import_survey, add_group, set_question_properties and delete_question", async () => {
  const { inner, calls } = spy();
  const client = scopedClient(inner, "none");
  await assertRejected(client, calls, "import_survey", LSS);
  await assertRejected(client, calls, "add_group", [1, "Gruppe"]);
  await assertRejected(client, calls, "set_question_properties", [7, { relevance: "1" }]);
  await assertRejected(client, calls, "delete_question", [7]);
  assert.deepEqual(calls, [], "nothing may reach the inner client");
});

test("[GEN-E] scopedClient level content passes the reads and import_survey (lss), import_group and set_survey_properties", async () => {
  const { inner, calls } = spy();
  const client = scopedClient(inner, "content");
  for (const [method, params] of READS) await assertPasses(client, calls, method, params);
  await assertPasses(client, calls, "import_survey", LSS);
  await assertPasses(client, calls, "import_group", [1, "QUJD", "lsg"]);
  await assertPasses(client, calls, "set_survey_properties", [1, { expires: "2026-12-31 23:59:59" }]);
});

const FORBIDDEN_UNDER_CONTENT: Array<[string, JsonValue[]]> = [
  ["delete_question", [7]],
  ["delete_group", [1, 2]],
  ["delete_survey", [1]],
  ["delete_language", [1, "en"]],
  ["activate_survey", [1]],
  ["activate_tokens", [1]],
  ["invite_participants", [1]],
  ["add_response", [1, { "1X2X3": "A" }]],
  ["upload_file", [1, "1X2X3", "file.txt", "QUJD"]],
  ["copy_survey", [1, "Kopie"]],
];

for (const [method, params] of FORBIDDEN_UNDER_CONTENT) {
  test(`[GEN-E] scopedClient level content rejects ${method} without reaching LimeSurvey`, async () => {
    const { inner, calls } = spy();
    await assertRejected(scopedClient(inner, "content"), calls, method, params);
  });
}

for (const type of ["lsa", " LSA ", "Lsa"]) {
  test(`[GEN-E] scopedClient level content rejects import_survey with the archive type ${JSON.stringify(type)}`, async () => {
    const { inner, calls } = spy();
    await assertRejected(scopedClient(inner, "content"), calls, "import_survey", lsa(type));
  });
}

test("[GEN-E] scopedClient with writeMethods [import_survey] passes import_survey (lss) and the reads and rejects the other content writes", async () => {
  const { inner, calls } = spy();
  const client = scopedWithOptions(inner, "content", { writeMethods: ["import_survey"] });
  await assertPasses(client, calls, "import_survey", LSS);
  for (const [method, params] of READS) await assertPasses(client, calls, method, params);

  const before = calls.length;
  await assertRejected(client, calls, "set_survey_properties", [1, { expires: "2026-12-31 23:59:59" }]);
  await assertRejected(client, calls, "import_group", [1, "QUJD", "lsg"]);
  await assertRejected(client, calls, "set_question_properties", [7, { relevance: "1" }]);
  assert.equal(calls.length, before, "a method outside the list must not reach the inner client");
});

test("[GEN-E] scopedClient: an allowlist only narrows; it opens neither a .lsa import nor a write at level none", async () => {
  const { inner, calls } = spy();
  const content = scopedWithOptions(inner, "content", { writeMethods: ["import_survey"] });
  await assertRejected(content, calls, "import_survey", lsa("lsa"));
  await assertRejected(content, calls, "import_survey", lsa(" LSA "));

  const none = scopedWithOptions(inner, "none", { writeMethods: ["import_survey"] });
  await assertRejected(none, calls, "import_survey", LSS);
  await assertPasses(none, calls, "get_survey_properties", [1, ["language"]]);
});

// ---- Review of PR4: deleting only what the call created ----

interface CreatedScope {
  writeMethods?: readonly string[];
  /** The survey of the call and the ids it created itself (its rollback may delete exactly these). */
  created?: { surveyId: number; questions: Set<number>; groups: Set<number> };
}

/** The signature with surveyId in created; the cast keeps the test compiling before it exists. */
const scopedWithCreated = scopedClient as unknown as (client: RpcClient, level: ClientLevel, options?: CreatedScope) => RpcClient;

const createdIds = (): NonNullable<CreatedScope["created"]> => ({ surveyId: 1, questions: new Set([5]), groups: new Set([9]) });

test("[GEN-A] scopedClient with created question 5 passes delete_question [5] and [\"5\"] at level content", async () => {
  const { inner, calls } = spy();
  const client = scopedWithCreated(inner, "content", { writeMethods: ["import_question"], created: createdIds() });
  await assertPasses(client, calls, "delete_question", [5]);
  await assertPasses(client, calls, "delete_question", ["5"]);
});

test("[GEN-A] scopedClient with created question 5 rejects delete_question [6], [] and [null] without reaching LimeSurvey", async () => {
  const { inner, calls } = spy();
  const client = scopedWithCreated(inner, "content", { writeMethods: ["import_question"], created: createdIds() });
  await assertRejected(client, calls, "delete_question", [6]);
  await assertRejected(client, calls, "delete_question", []);
  await assertRejected(client, calls, "delete_question", [null]);
  assert.deepEqual(calls, []);
});

test("[GEN-C] scopedClient passes delete_group only for the survey of the call and a created group: [1, 9] passes; [2, 9], [1, 8] and [9] are rejected", async () => {
  const { inner, calls } = spy();
  const client = scopedWithCreated(inner, "content", { writeMethods: ["import_group"], created: createdIds() });
  await assertRejected(client, calls, "delete_group", [2, 9]);
  await assertRejected(client, calls, "delete_group", [1, 8]);
  await assertRejected(client, calls, "delete_group", [9]);
  await assertPasses(client, calls, "delete_group", [1, 9]);
});

test("[GEN-A] scopedClient rejects delete_survey and delete_language although the call created ids", async () => {
  const { inner, calls } = spy();
  const client = scopedWithCreated(inner, "content", { created: createdIds() });
  await assertRejected(client, calls, "delete_survey", [1]);
  await assertRejected(client, calls, "delete_language", [1, "en"]);
  await assertRejected(client, calls, "delete_survey", [5]);
  assert.deepEqual(calls, []);
});

test("[GEN-A] scopedClient level none rejects delete_question [5] although 5 is a created id", async () => {
  const { inner, calls } = spy();
  const client = scopedWithCreated(inner, "none", { created: createdIds() });
  await assertRejected(client, calls, "delete_question", [5]);
  await assertRejected(client, calls, "delete_group", [1, 9]);
  assert.deepEqual(calls, []);
});

test("[GEN-E] scopedClient: an empty writeMethods list allows no write at all, only reads", async () => {
  const { inner, calls } = spy();
  const client = scopedWithOptions(inner, "content", { writeMethods: [] });
  await assertRejected(client, calls, "import_survey", LSS);
  await assertRejected(client, calls, "set_survey_properties", [1, { expires: "2026-12-31 23:59:59" }]);
  await assertPasses(client, calls, "list_questions", [1, null, "de"]);
});

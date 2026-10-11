import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LimeSurveyClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const config: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

type Responder = (request: JsonRpcRequest) => unknown;

async function connected(responder: Responder) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-1" : responder(request);
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "rpc-hints-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    rpc(method: string) {
      return requests.filter((request) => request.method === method);
    },
    async close() {
      await client.close();
      await created.server.close();
    },
  };
}

function result(structured: unknown): Record<string, unknown> {
  return ((structured as { result?: Record<string, unknown> } | undefined)?.result ?? {});
}

test("[S-03] set_question_properties with attributes is rejected before any RPC with a hint", async () => {
  const session = await connected(() => ({ title: true }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_question_properties",
      arguments: { question_id: 5, data: { title: "Q1", attributes: { hide_tip: "1" } } },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.code, "FIELD_NOT_WRITABLE");
    assert.equal(body.hint_code, "NOT_WRITABLE_VIA_REMOTECONTROL");
    assert.match(String(body.hint), /import_question/);
    assert.ok(Array.isArray(body.writable_fields));
    assert.ok((body.writable_fields as string[]).includes("relevance"));
    assert.equal(session.rpc("set_question_properties").length, 0);
  } finally {
    await session.close();
  }
});

test("[S-03] question_l10ns points to questionl10ns", async () => {
  const session = await connected(() => ({}));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_question_properties",
      arguments: { question_id: 5, data: { question_l10ns: { de: { question: "Text" } } } },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.hint_code, "NOT_WRITABLE_VIA_REMOTECONTROL");
    assert.match(String(body.hint), /questionl10ns/);
    assert.equal(session.rpc("set_question_properties").length, 0);
  } finally {
    await session.close();
  }
});

test("[S-03] question text with language is sent as questionl10ns, never as top-level fields", async () => {
  const session = await connected(() => ({ questionl10ns: { de: { question: true } } }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_question_properties",
      arguments: { question_id: 5, data: { language: "de", question: "Neuer Text" } },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const calls = session.rpc("set_question_properties");
    assert.equal(calls.length, 1);
    const data = calls[0]?.params[2] as Record<string, unknown>;
    assert.deepEqual(data, { questionl10ns: { de: { question: "Neuer Text" } } });
  } finally {
    await session.close();
  }
});

test("[S-03] the language tool parameter is used for text fields when data has no language", async () => {
  const session = await connected(() => ({ questionl10ns: { fr: { help: true } } }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_question_properties",
      arguments: { question_id: 5, data: { help: "Aide", mandatory: "Y" }, language: "fr" },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const data = session.rpc("set_question_properties")[0]?.params[2] as Record<string, unknown>;
    assert.deepEqual(data, { mandatory: "Y", questionl10ns: { fr: { help: "Aide" } } });
  } finally {
    await session.close();
  }
});

test("[S-03] question text without any language fails with LANGUAGE_REQUIRED and no RPC", async () => {
  const session = await connected(() => ({}));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_question_properties",
      arguments: { question_id: 5, data: { question: "Text" } },
    });
    assert.equal(response.isError, true);
    assert.equal(result(response.structuredContent).code, "LANGUAGE_REQUIRED");
    assert.equal(session.rpc("set_question_properties").length, 0);
  } finally {
    await session.close();
  }
});

test("[S-03] set_group_properties: group_name without language fails with LANGUAGE_REQUIRED, with language it becomes questiongroupl10ns", async () => {
  const session = await connected(() => ({ questiongroupl10ns: { de: { group_name: true } } }));
  try {
    const missing = await session.client.callTool({
      name: "limesurvey_set_group_properties",
      arguments: { group_id: 3, data: { group_name: "Neu" } },
    });
    assert.equal(missing.isError, true);
    assert.equal(result(missing.structuredContent).code, "LANGUAGE_REQUIRED");
    assert.equal(session.rpc("set_group_properties").length, 0);

    const ok = await session.client.callTool({
      name: "limesurvey_set_group_properties",
      arguments: { group_id: 3, data: { language: "de", group_name: "Neu", group_order: 2 } },
    });
    assert.equal(ok.isError, undefined, JSON.stringify(ok.structuredContent));
    const data = session.rpc("set_group_properties")[0]?.params[2] as Record<string, unknown>;
    assert.deepEqual(data, { group_order: 2, questiongroupl10ns: { de: { group_name: "Neu" } } });
  } finally {
    await session.close();
  }
});

test("[S-03] set_group_properties rejects group_l10ns and sid", async () => {
  const session = await connected(() => ({}));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_group_properties",
      arguments: { group_id: 3, data: { group_l10ns: {}, sid: 9 } },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.code, "FIELD_NOT_WRITABLE");
    assert.match(String(body.hint), /questiongroupl10ns/);
    assert.equal(session.rpc("set_group_properties").length, 0);
  } finally {
    await session.close();
  }
});

test("[S-03] set_survey_properties rejects active and language with the matching tools named", async () => {
  const session = await connected(() => ({}));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_survey_properties",
      arguments: { survey_id: 1, data: { active: "Y", additional_languages: "de" } },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.hint_code, "NOT_WRITABLE_VIA_REMOTECONTROL");
    assert.match(String(body.hint), /activate_survey/);
    assert.match(String(body.hint), /add_language/);
    assert.equal(session.rpc("set_survey_properties").length, 0);
  } finally {
    await session.close();
  }
});

test("[S-03] set_quota_properties rejects limit (the column is qlimit) and language fields", async () => {
  const session = await connected(() => ({ success: true, message: {} }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_quota_properties",
      arguments: { quota_id: 4, data: { limit: 10 } },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.code, "FIELD_NOT_WRITABLE");
    assert.match(String(body.hint), /qlimit/);
    assert.ok((body.writable_fields as string[]).includes("qlimit"));
    assert.equal(session.rpc("set_quota_properties").length, 0);
  } finally {
    await session.close();
  }
});

test("[S-03] set_participant_properties rejects tid, set_language_properties rejects surveyls_language", async () => {
  const session = await connected(() => ({}));
  try {
    const participant = await session.client.callTool({
      name: "limesurvey_set_participant_properties",
      arguments: { survey_id: 1, query: { tid: 1 }, data: { tid: 2 } },
    });
    assert.equal(participant.isError, true);
    assert.equal(result(participant.structuredContent).code, "FIELD_NOT_WRITABLE");
    const languageResponse = await session.client.callTool({
      name: "limesurvey_set_language_properties",
      arguments: { survey_id: 1, data: { surveyls_language: "de" } },
    });
    assert.equal(languageResponse.isError, true);
    assert.equal(result(languageResponse.structuredContent).code, "FIELD_NOT_WRITABLE");
    assert.equal(session.rpc("set_participant_properties").length, 0);
    assert.equal(session.rpc("set_language_properties").length, 0);
  } finally {
    await session.close();
  }
});

test("[S-03] a 'No valid Data' answer to set_survey_properties becomes a hint with writable_fields", async () => {
  const session = await connected(() => ({ status: "No valid Data" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_survey_properties",
      arguments: { survey_id: 1, data: { totally_unknown_column: "x" } },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.hint_code, "NOT_WRITABLE_VIA_REMOTECONTROL");
    assert.ok(Array.isArray(body.writable_fields));
    assert.ok((body.writable_fields as string[]).includes("format"));
    assert.ok(!(body.writable_fields as string[]).includes("active"));
    assert.equal(typeof body.hint, "string");
  } finally {
    await session.close();
  }
});

test("[S-03] the error_code ERR_NO_DATA is interpreted like 'No valid Data'", async () => {
  const session = await connected(() => ({ status: "No valid Data", error_code: "ERR_NO_DATA" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_group_properties",
      arguments: { group_id: 3, data: { nonsense: 1 } },
    });
    assert.equal(response.isError, true);
    assert.equal(result(response.structuredContent).hint_code, "NOT_WRITABLE_VIA_REMOTECONTROL");
  } finally {
    await session.close();
  }
});

test("[S-03] other 'No valid Data' answers get a NO_DATA hint", async () => {
  const session = await connected(() => ({ status: "No valid Data" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_get_survey_properties",
      arguments: { survey_id: 1, properties: ["nope"] },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.hint_code, "NO_DATA");
    assert.equal(typeof body.hint, "string");
  } finally {
    await session.close();
  }
});

test("[S-03] keys the answer does not contain are returned as a warning", async () => {
  const session = await connected(() => ({ format: true }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_survey_properties",
      arguments: { survey_id: 1, data: { format: "S", brand_new_column: "x" } },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const warnings = (response.structuredContent as { warnings?: Array<Record<string, unknown>> }).warnings;
    assert.ok(Array.isArray(warnings) && warnings.length === 1, JSON.stringify(response.structuredContent));
    assert.equal(warnings[0]?.hint_code, "NOT_WRITABLE_VIA_REMOTECONTROL");
    assert.deepEqual(warnings[0]?.ignored_fields, ["brand_new_column"]);
  } finally {
    await session.close();
  }
});

test("[S-03] set_language_properties reports fields LimeSurvey answered with false", async () => {
  const session = await connected(() => ({ surveyls_title: false, status: "OK" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_set_language_properties",
      arguments: { survey_id: 1, data: { surveyls_title: "T" } },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const warnings = (response.structuredContent as { warnings?: Array<Record<string, unknown>> }).warnings;
    assert.ok(Array.isArray(warnings) && warnings.length >= 1, JSON.stringify(response.structuredContent));
    assert.deepEqual(warnings[0]?.failed_fields, ["surveyls_title"]);
  } finally {
    await session.close();
  }
});

test("[S-03] the descriptions of the six set_* tools list writable fields and the 6.17.11 basis", async () => {
  const session = await connected(() => ({}));
  try {
    const { tools } = await session.client.listTools();
    const expectations: Record<string, RegExp[]> = {
      limesurvey_set_question_properties: [/relevance/, /questionl10ns/, /attributes/, /6\.17\.11/],
      limesurvey_set_group_properties: [/group_order/, /questiongroupl10ns/, /6\.17\.11/],
      limesurvey_set_survey_properties: [/format/, /activate_survey/, /6\.17\.11/],
      limesurvey_set_language_properties: [/surveyls_title/, /6\.17\.11/],
      limesurvey_set_quota_properties: [/qlimit/, /6\.17\.11/],
      limesurvey_set_participant_properties: [/firstname/, /tid/, /6\.17\.11/],
    };
    for (const [name, patterns] of Object.entries(expectations)) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, name);
      for (const pattern of patterns) assert.match(tool.description ?? "", pattern, name);
    }
  } finally {
    await session.close();
  }
});

test("[S-03] the client treats object statuses and success=false as API errors", async () => {
  for (const [method, payload, expected] of [
    ["set_participant_properties", { status: { email: ["Email is not valid."] } }, /set_participant_properties failed: .*email/],
    ["set_quota_properties", { success: false, message: "Error: Invalid quota ID" }, /set_quota_properties failed: Error: Invalid quota ID/],
  ] as const) {
    const mockFetch: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
      return new Response(JSON.stringify({ id: request.id, result: request.method === "get_session_key" ? "s" : payload, error: null }));
    };
    const client = new LimeSurveyClient(config, mockFetch);
    await assert.rejects(client.call(method, [1, {}, {}]), expected);
  }
});

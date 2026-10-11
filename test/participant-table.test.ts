import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

const TOOL = "limesurvey_get_participant_table_status";

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
  const client = new Client({ name: "participant-table-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    async close() {
      await client.close();
      await created.server.close();
    },
  };
}

async function callStatus(
  session: Awaited<ReturnType<typeof connected>>,
  surveyId = 77,
) {
  const listed = await session.client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === TOOL), `${TOOL} must be registered`);
  return session.client.callTool({ name: TOOL, arguments: { survey_id: surveyId } });
}

function result(structured: unknown): Record<string, unknown> {
  return ((structured as { result?: Record<string, unknown> } | undefined)?.result ?? {});
}

test("[S-04] get_participant_table_status: a numeric token_count means the table exists", async () => {
  const session = await connected((request) => {
    if (request.method === "get_summary") return 12;
    if (request.method === "get_survey_properties") return { access_mode: "C", active: "Y", allowregister: "N" };
    return true;
  });
  try {
    const response = await callStatus(session);
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.survey_id, 77);
    assert.equal(body.exists, true);
    assert.equal(body.participant_count, 12);
    assert.equal(body.survey_is_closed_access, true);
    assert.equal(body.closed_access_basis, "access_mode");
    assert.equal(typeof body.explanation, "string");
    const summary = session.requests.find((request) => request.method === "get_summary");
    assert.deepEqual(summary?.params, ["session-1", 77, "token_count"]);
    for (const request of session.requests) {
      assert.ok(["get_session_key", "get_summary", "get_survey_properties"].includes(request.method), request.method);
    }
  } finally {
    await session.close();
  }
});

test("[S-04] get_participant_table_status: a numeric string is accepted too", async () => {
  const session = await connected((request) => (request.method === "get_summary" ? "0" : { access_mode: "O" }));
  try {
    const response = await callStatus(session);
    const body = result(response.structuredContent);
    assert.equal(body.exists, true);
    assert.equal(body.participant_count, 0);
    assert.equal(body.survey_is_closed_access, false);
  } finally {
    await session.close();
  }
});

test("[S-04] get_participant_table_status: 'No available data' means no table and open access", async () => {
  const session = await connected((request) => {
    if (request.method === "get_summary") return { status: "No available data" };
    if (request.method === "get_survey_properties") return { access_mode: "O", active: "N" };
    return true;
  });
  try {
    const response = await callStatus(session);
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.exists, false);
    assert.equal(body.participant_count, 0);
    assert.equal(body.survey_is_closed_access, false);
  } finally {
    await session.close();
  }
});

test("[S-04] get_participant_table_status: without access_mode (older release) the table decides", async () => {
  const session = await connected((request) => {
    if (request.method === "get_summary") return 3;
    return { status: "No valid Data" };
  });
  try {
    const response = await callStatus(session);
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const body = result(response.structuredContent);
    assert.equal(body.exists, true);
    assert.equal(body.survey_is_closed_access, true);
    assert.equal(body.closed_access_basis, "participant_table");
  } finally {
    await session.close();
  }
});

test("[S-04] get_participant_table_status passes other errors on", async () => {
  const session = await connected((request) => (request.method === "get_summary" ? { status: "No permission" } : {}));
  try {
    const response = await callStatus(session);
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /No permission/);
  } finally {
    await session.close();
  }
});

test("[S-04] get_summary token_count on a survey without participant table is explained", async () => {
  const session = await connected(() => ({ status: "No available data" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_get_summary",
      arguments: { survey_id: 77, statistic: "token_count" },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.hint_code, "NO_PARTICIPANT_TABLE");
    assert.match(String(body.hint), /get_participant_table_status/);
    assert.match(String(body.hint), /access_mode/);
    assert.doesNotMatch(String(body.hint), /has open access/i);
  } finally {
    await session.close();
  }
});

test("[S-04] get_summary response statistics hint covers deactivated surveys", async () => {
  const session = await connected(() => ({ status: "No available data" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_get_summary",
      arguments: { survey_id: 77, statistic: "completed_responses" },
    });
    const hint = String(result(response.structuredContent).hint);
    assert.match(hint, /deactivat/i);
    assert.doesNotMatch(hint, /because it was never activated/i);
  } finally {
    await session.close();
  }
});

test("[S-04] tool descriptions do not claim open access without participant table or never-activated only", async () => {
  const session = await connected(() => ({}));
  try {
    const { tools } = await session.client.listTools();
    const summary = tools.find((tool) => tool.name === "limesurvey_get_summary")?.description ?? "";
    assert.doesNotMatch(summary, /open access/i);
    assert.match(summary, /deactivated/i);
    const status = tools.find((tool) => tool.name === "limesurvey_get_participant_table_status")?.description ?? "";
    assert.doesNotMatch(status, /A survey without a participant table has open access/);
  } finally {
    await session.close();
  }
});

test("[S-04] get_summary response statistics on a never activated survey are explained", async () => {
  const session = await connected(() => ({ status: "No available data" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_get_summary",
      arguments: { survey_id: 77, statistic: "completed_responses" },
    });
    assert.equal(response.isError, true);
    assert.equal(result(response.structuredContent).hint_code, "NO_RESPONSE_TABLE");
  } finally {
    await session.close();
  }
});

test("[S-04] the descriptions of get_survey_properties and get_summary explain usetokens and the missing table", async () => {
  const session = await connected(() => ({}));
  try {
    const { tools } = await session.client.listTools();
    const properties = tools.find((tool) => tool.name === "limesurvey_get_survey_properties");
    assert.match(properties?.description ?? "", /usetokens/);
    assert.match(properties?.description ?? "", /get_participant_table_status/);
    const summary = tools.find((tool) => tool.name === "limesurvey_get_summary");
    assert.match(summary?.description ?? "", /NO_PARTICIPANT_TABLE/);
    assert.match(summary?.description ?? "", /NO_RESPONSE_TABLE/);
  } finally {
    await session.close();
  }
});

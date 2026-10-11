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
  const client = new Client({ name: "schema-hints-test", version: "1.0.0" });
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

test("[S-09] get_group_properties with a matching survey_id passes and never sends survey_id", async () => {
  const session = await connected(() => ({ gid: 3, sid: "7", group_name: "Intro" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_get_group_properties",
      arguments: { group_id: 3, survey_id: 7 },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const calls = session.rpc("get_group_properties");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.params, ["session-1", 3]);
  } finally {
    await session.close();
  }
});

test("[S-09] get_group_properties reports GROUP_SURVEY_MISMATCH when the group belongs to another survey", async () => {
  const session = await connected(() => ({ gid: 3, sid: 9, group_name: "Intro" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_get_group_properties",
      arguments: { group_id: 3, survey_id: 7 },
    });
    assert.equal(response.isError, true);
    const body = result(response.structuredContent);
    assert.equal(body.code, "GROUP_SURVEY_MISMATCH");
    assert.match(String(body.hint), /9/);
    assert.match(String(body.hint), /7/);
  } finally {
    await session.close();
  }
});

test("[S-09] get_group_properties verifies via an extra read when sid is not in the answer", async () => {
  const session = await connected((request) => {
    const properties = request.params[2];
    return Array.isArray(properties) && properties[0] === "sid" ? { sid: "7" } : { group_name: "Intro" };
  });
  try {
    const ok = await session.client.callTool({
      name: "limesurvey_get_group_properties",
      arguments: { group_id: 3, properties: ["group_name"], survey_id: 7 },
    });
    assert.equal(ok.isError, undefined, JSON.stringify(ok.structuredContent));
    const calls = session.rpc("get_group_properties");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]?.params, ["session-1", 3, ["sid"]]);

    const mismatch = await session.client.callTool({
      name: "limesurvey_get_group_properties",
      arguments: { group_id: 3, properties: ["group_name"], survey_id: 8 },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(result(mismatch.structuredContent).code, "GROUP_SURVEY_MISMATCH");
  } finally {
    await session.close();
  }
});

test("[S-09] without survey_id there is no extra read", async () => {
  const session = await connected(() => ({ group_name: "Intro" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_get_group_properties",
      arguments: { group_id: 3, properties: ["group_name"] },
    });
    assert.equal(response.isError, undefined);
    assert.equal(session.rpc("get_group_properties").length, 1);
  } finally {
    await session.close();
  }
});

test("[S-09] get_question_properties checks survey_id against sid", async () => {
  const session = await connected((request) => {
    const properties = request.params[2];
    if (Array.isArray(properties) && properties[0] === "sid") return { sid: 7 };
    return { qid: 5, sid: 7, title: "Q1" };
  });
  try {
    const ok = await session.client.callTool({
      name: "limesurvey_get_question_properties",
      arguments: { question_id: 5, survey_id: 7 },
    });
    assert.equal(ok.isError, undefined, JSON.stringify(ok.structuredContent));
    assert.deepEqual(session.rpc("get_question_properties")[0]?.params, ["session-1", 5]);

    const mismatch = await session.client.callTool({
      name: "limesurvey_get_question_properties",
      arguments: { question_id: 5, survey_id: 8 },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(result(mismatch.structuredContent).code, "QUESTION_SURVEY_MISMATCH");
  } finally {
    await session.close();
  }
});

test("[S-09] the descriptions of both tools document the survey_id cross-check", async () => {
  const session = await connected(() => ({}));
  try {
    const { tools } = await session.client.listTools();
    for (const name of ["limesurvey_get_group_properties", "limesurvey_get_question_properties"]) {
      const tool = tools.find((item) => item.name === name);
      assert.match(tool?.description ?? "", /survey_id/, name);
      assert.match(tool?.description ?? "", /MISMATCH/, name);
      assert.ok("survey_id" in (tool?.inputSchema.properties ?? {}), name);
    }
  } finally {
    await session.close();
  }
});

async function validationText(
  session: Awaited<ReturnType<typeof connected>>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await session.client.callTool({ name, arguments: args });
  assert.equal(response.isError, true, name);
  return JSON.stringify(response.content);
}

test("[S-09] an unknown argument names itself and the expected parameters (official tool)", async () => {
  const session = await connected(() => []);
  try {
    const text = await validationText(session, "limesurvey_list_surveys", { survey_groupid: 4 });
    assert.match(text, /survey_groupid/);
    assert.match(text, /survey_group_id/);
    assert.match(text, /username/);
    assert.equal(session.requests.length, 0);
  } finally {
    await session.close();
  }
});

test("[S-09] an unknown argument names itself and the expected parameters (workflow tool)", async () => {
  const session = await connected(() => []);
  try {
    const text = await validationText(session, "limesurvey_find_surveys", { querry: "x" });
    assert.match(text, /querry/);
    assert.match(text, /query/);
    assert.match(text, /offset/);
    assert.match(text, /limit/);
  } finally {
    await session.close();
  }
});

test("[S-09] an unknown argument names itself and the expected parameters (theme tool with superRefine)", async () => {
  const session = await connected(() => []);
  try {
    const text = await validationText(session, "limesurvey_generate_survey_theme", {
      theme_name: "weit_feedback",
      title: "WEIT Feedback",
      colour: "#000000",
    });
    assert.match(text, /colour/);
    assert.match(text, /primary_color/);

    const refined = await validationText(session, "limesurvey_generate_survey_theme", {
      theme_name: "weit_feedback",
      title: "WEIT Feedback",
      logo_base64: "AAAA",
    });
    assert.match(refined, /logo_base64 and logo_file_type must be supplied together/);
  } finally {
    await session.close();
  }
});

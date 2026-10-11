import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const config: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "test-only-not-a-secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

async function connected(responder: (request: JsonRpcRequest) => unknown) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-1" : responder(request);
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "empty-lists-test", version: "1.0.0" });
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

function result(structured: unknown): unknown {
  return (structured as { result?: unknown } | undefined)?.result;
}

// The "nothing found" status texts LimeSurvey 6.17.11 returns for an empty list (RemoteControl handle).
const emptyLists: Array<{ tool: string; arguments: Record<string, unknown>; status: string }> = [
  { tool: "limesurvey_list_surveys", arguments: {}, status: "No surveys found" },
  { tool: "limesurvey_list_survey_groups", arguments: {}, status: "No survey groups found" },
  { tool: "limesurvey_list_users", arguments: {}, status: "No users found" },
  { tool: "limesurvey_list_groups", arguments: { survey_id: 1 }, status: "No groups found" },
  { tool: "limesurvey_list_questions", arguments: { survey_id: 1 }, status: "No questions found" },
  { tool: "limesurvey_list_quotas", arguments: { survey_id: 1 }, status: "No quotas found" },
  { tool: "limesurvey_list_participants", arguments: { survey_id: 1 }, status: "No survey participants found." },
];

test("[S-03] list tools return an empty array when LimeSurvey reports nothing found", async () => {
  for (const item of emptyLists) {
    const session = await connected(() => ({ status: item.status }));
    try {
      const response = await session.client.callTool({ name: item.tool, arguments: item.arguments });
      assert.equal(response.isError, undefined, `${item.tool}: ${JSON.stringify(response.structuredContent)}`);
      assert.deepEqual(result(response.structuredContent), [], item.tool);
    } finally {
      await session.close();
    }
  }
});

test("[S-03] only the matching status text of a list method counts as an empty list", async () => {
  const mismatches: Array<{ tool: string; arguments: Record<string, unknown>; status: string }> = [
    { tool: "limesurvey_list_surveys", arguments: {}, status: "No groups found" },
    { tool: "limesurvey_list_participants", arguments: { survey_id: 1 }, status: "Error: No survey participant list" },
    { tool: "limesurvey_list_participants", arguments: { survey_id: 1 }, status: "No permission" },
    { tool: "limesurvey_list_users", arguments: {}, status: "No surveys found" },
  ];
  for (const item of mismatches) {
    const session = await connected(() => ({ status: item.status }));
    try {
      const response = await session.client.callTool({ name: item.tool, arguments: item.arguments });
      assert.equal(response.isError, true, `${item.tool} with "${item.status}"`);
      assert.match(JSON.stringify(response.structuredContent), new RegExp(item.status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      await session.close();
    }
  }
  // A "No ... found" status of a method that is not a list keeps being an error.
  const session = await connected(() => ({ status: "No surveys found" }));
  try {
    const response = await session.client.callTool({ name: "limesurvey_get_survey_properties", arguments: { survey_id: 1 } });
    assert.equal(response.isError, true);
  } finally {
    await session.close();
  }
});

test("[S-03] workflow tools built on list_* treat an empty instance as empty, not as a failure", async () => {
  const session = await connected((request) => {
    if (request.method === "list_surveys") return { status: "No surveys found" };
    if (request.method === "list_participants") return { status: "No survey participants found." };
    return {};
  });
  try {
    const found = await session.client.callTool({ name: "limesurvey_find_surveys", arguments: {} });
    assert.equal(found.isError, undefined, JSON.stringify(found.structuredContent));
    assert.deepEqual(result(found.structuredContent), { items: [], total: 0, offset: 0, limit: 20 });

    const probe = await session.client.callTool({ name: "limesurvey_get_instance_info", arguments: { probe_instance: true } });
    assert.equal((result(probe.structuredContent) as Record<string, unknown>).survey_count, 0);

    const themes = await session.client.callTool({ name: "limesurvey_list_installed_themes", arguments: {} });
    assert.equal(themes.isError, undefined, JSON.stringify(themes.structuredContent));
    const themeBody = result(themes.structuredContent) as Record<string, unknown>;
    assert.equal(themeBody.total_surveys, 0);
    assert.equal(themeBody.themes_in_use_error, undefined);

    const validated = await session.client.callTool({ name: "limesurvey_validate_participants", arguments: { survey_id: 1 } });
    assert.equal(validated.isError, undefined, JSON.stringify(validated.structuredContent));
    const validation = result(validated.structuredContent) as Record<string, unknown>;
    assert.equal(validation.participant_table_exists, true);
    assert.equal(validation.participant_count, 0);

    const preview = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 1, dry_run: true },
    });
    assert.equal(preview.isError, undefined, JSON.stringify(preview.structuredContent));
    const report = result(preview.structuredContent) as Record<string, unknown>;
    assert.equal(report.participant_table_exists, true);
    assert.deepEqual(report.would_receive, []);
    assert.equal(report.real_call_would_fail_with, "Error: No candidate tokens");
  } finally {
    await session.close();
  }
});

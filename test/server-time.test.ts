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

async function instanceInfo(probe: boolean, dateHeader: string | undefined) {
  const methods: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    methods.push(request.method);
    const result = request.method === "get_session_key" ? "session-1" : request.method === "list_surveys" ? [{ sid: "1" }] : null;
    return new Response(JSON.stringify({ id: request.id, result, error: null }), {
      headers: dateHeader ? { date: dateHeader } : {},
    });
  };
  const { server } = createServer(config, mockFetch);
  const client = new Client({ name: "server-time-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "limesurvey_get_instance_info",
      arguments: probe ? { probe_instance: true } : {},
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    return { methods, result: (response.structuredContent as { result: Record<string, unknown> }).result };
  } finally {
    await client.close();
    await server.close();
  }
}

test("[S-08] probe_instance reports the server clock from the HTTP Date header as UTC", async () => {
  const { result } = await instanceInfo(true, "Sun, 11 Oct 2026 19:10:51 GMT");
  assert.equal(result.server_time, "2026-10-11T19:10:51.000Z");
  assert.equal(result.server_time_source, "http_date_header");
  assert.match(String(result.server_time_note), /UTC/);
  assert.match(String(result.server_time_note), /timeadjust/);
  assert.match(String(result.server_time_note), /superadmin/i);
});

test("[S-08] without probe_instance no RPC is made and server_time is null with a hint", async () => {
  const { methods, result } = await instanceInfo(false, "Sun, 11 Oct 2026 19:10:51 GMT");
  assert.deepEqual(methods, []);
  assert.equal(Object.hasOwn(result, "server_time"), true);
  assert.equal(result.server_time, null);
  assert.equal(result.server_time_source, null);
  assert.match(String(result.server_time_hint), /probe_instance=true/);
});

test("[S-08] a probe answer without a Date header leaves server_time null and says why", async () => {
  const { result } = await instanceInfo(true, undefined);
  assert.equal(result.server_time, null);
  assert.equal(result.server_time_source, null);
  assert.match(String(result.server_time_hint), /Date header/);
});

test("[S-08] the instance info description names the server_time fields", async () => {
  const { server } = createServer(config, async () => new Response("{}"));
  const client = new Client({ name: "server-time-description", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tool = (await client.listTools()).tools.find((item) => item.name === "limesurvey_get_instance_info");
    assert.match(String(tool?.description), /server_time/);
  } finally {
    await client.close();
    await server.close();
  }
});

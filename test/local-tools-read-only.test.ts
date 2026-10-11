import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const baseConfig: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

async function connected(config: LimeSurveyConfig, mockFetch: typeof fetch) {
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "local-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...created, mcpClient: client };
}

test("[S-06] generate_survey_theme works in read-only mode and writes into the theme directory", async () => {
  const themeDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-s06-theme-"));
  const { server, mcpClient } = await connected(
    { ...baseConfig, themeDir, readOnly: true },
    async () => {
      throw new Error("generate_survey_theme must not call LimeSurvey");
    },
  );
  try {
    const generated = await mcpClient.callTool({
      name: "limesurvey_generate_survey_theme",
      arguments: { theme_name: "readonly_local", title: "Read-only local theme" },
    });
    assert.equal(generated.isError, undefined, JSON.stringify(generated.structuredContent));
    const content = generated.structuredContent as { result: { file_name: string } };
    const info = await stat(path.join(themeDir, content.result.file_name));
    assert.ok(info.isFile());
  } finally {
    await mcpClient.close();
    await server.close();
    await rm(themeDir, { recursive: true, force: true });
  }
});

test("[S-06] export_responses_to_file works in read-only mode and writes into the export directory", async () => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-s06-export-"));
  const payload = "id,answer\n1,yes\n";
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key" ? "session-1" : Buffer.from(payload).toString("base64");
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected({ ...baseConfig, exportDir, readOnly: true }, mockFetch);
  try {
    const exported = await mcpClient.callTool({
      name: "limesurvey_export_responses_to_file",
      arguments: { survey_id: 123, document_type: "csv", file_name: "responses.csv" },
    });
    assert.equal(exported.isError, undefined, JSON.stringify(exported.structuredContent));
    assert.equal(await readFile(path.join(exportDir, "responses.csv"), "utf8"), payload);
  } finally {
    await mcpClient.close();
    await server.close();
    await rm(exportDir, { recursive: true, force: true });
  }
});

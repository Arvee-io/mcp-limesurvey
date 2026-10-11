import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest } from "../src/types.js";

const baseEnv = {
  LIMESURVEY_URL: "https://survey.example.test/index.php/admin/remotecontrol",
  LIMESURVEY_USERNAME: "rpc-user",
  LIMESURVEY_PASSWORD: "secret",
};

async function instanceInfo(env: Record<string, string>) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as JsonRpcRequest);
    throw new Error("get_instance_info without probe must not call LimeSurvey");
  };
  const { server } = createServer(loadConfig({ ...baseEnv, ...env }), mockFetch);
  const client = new Client({ name: "instance-info-scope-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({ name: "limesurvey_get_instance_info", arguments: {} });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    assert.deepEqual(requests, []);
    const result = (response.structuredContent as { result: Record<string, unknown> }).result;
    return {
      result,
      capabilities: (result.capabilities ?? {}) as Record<string, unknown>,
      blockedBy: (result.capability_blocked_by ?? {}) as Record<string, unknown>,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

test("[S-02] under READ_ONLY the info reports scope none and blocks import_via_path with a reason", async () => {
  const { result, capabilities, blockedBy } = await instanceInfo({
    LIMESURVEY_READ_ONLY: "true",
    LIMESURVEY_IMPORT_DIR: "./imports",
    LIMESURVEY_THEME_DIR: "./themes",
  });
  assert.equal(result.read_only, true);
  assert.equal(result.write_scope, "none");
  assert.equal(result.write_scope_source, "LIMESURVEY_READ_ONLY");
  assert.equal(capabilities.import_via_path, false);
  assert.match(String(blockedBy.import_via_path), /content/);
  assert.match(String(blockedBy.import_via_path), /LIMESURVEY_READ_ONLY/);
  assert.equal(capabilities.theme_generation, true);
  assert.equal(blockedBy.theme_generation, null);
  assert.equal(capabilities.theme_assignment, false);
  assert.match(String(blockedBy.theme_assignment), /content/);
});

test("[S-02] with WRITE_SCOPE=content only higher-level capabilities are blocked", async () => {
  const { result, capabilities, blockedBy } = await instanceInfo({
    LIMESURVEY_WRITE_SCOPE: "content",
    LIMESURVEY_IMPORT_DIR: "./imports",
  });
  assert.equal(result.write_scope, "content");
  assert.equal(result.write_scope_source, "LIMESURVEY_WRITE_SCOPE");
  assert.equal(result.read_only, false);
  assert.equal(capabilities.import_via_path, true);
  assert.equal(blockedBy.import_via_path, null);
  assert.equal(capabilities.content_changes, true);
  assert.equal(blockedBy.content_changes, null);
  assert.equal(capabilities.lifecycle_changes, false);
  assert.match(String(blockedBy.lifecycle_changes), /lifecycle/);
  assert.match(String(blockedBy.lifecycle_changes), /content/);
  assert.equal(capabilities.participant_outreach, false);
  assert.match(String(blockedBy.participant_outreach), /outreach/);
});

test("[S-02] without any setting the scope is outreach from the default and nothing is scope-blocked", async () => {
  const { result, capabilities, blockedBy } = await instanceInfo({
    LIMESURVEY_EXPORT_DIR: "./exports",
    LIMESURVEY_THEME_DIR: "./themes",
    LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS: "true",
  });
  assert.equal(result.write_scope, "outreach");
  assert.equal(result.write_scope_source, "default");
  assert.equal(result.read_only, false);
  assert.deepEqual(capabilities, {
    import_via_path: true,
    export_survey_to_file: true,
    list_installed_themes: true,
    theme_generation: true,
    theme_assignment: true,
    content_changes: true,
    lifecycle_changes: true,
    participant_outreach: true,
    file_exports: true,
  });
  for (const reason of Object.values(blockedBy)) assert.equal(reason, null);
});

test("[S-02] capability_blocked_by has exactly the keys of capabilities and names missing configuration", async () => {
  const { capabilities, blockedBy } = await instanceInfo({ LIMESURVEY_READ_ONLY: "true" });
  assert.deepEqual(Object.keys(blockedBy).sort(), Object.keys(capabilities).sort());
  for (const [key, value] of Object.entries(capabilities)) {
    assert.equal(typeof value, "boolean", key);
    assert.equal(value === (blockedBy[key] === null), true, `${key}: boolean and reason must agree`);
  }
  assert.equal(capabilities.file_exports, false);
  assert.match(String(blockedBy.file_exports), /LIMESURVEY_EXPORT_DIR/);
  assert.equal(capabilities.theme_generation, false);
  assert.match(String(blockedBy.theme_generation), /LIMESURVEY_THEME_DIR/);
  assert.equal(capabilities.export_survey_to_file, false);
  assert.match(String(blockedBy.export_survey_to_file), /LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS/);
  assert.match(String(blockedBy.export_survey_to_file), /LIMESURVEY_EXPORT_DIR/);
  assert.equal(capabilities.list_installed_themes, true);
  assert.equal(blockedBy.list_installed_themes, null);
  // Scope and configuration reasons are joined with "; ".
  assert.equal(capabilities.import_via_path, false);
  const importReason = String(blockedBy.import_via_path);
  assert.match(importReason, /content/);
  assert.match(importReason, /LIMESURVEY_IMPORT_DIR/);
  assert.ok(importReason.includes("; "));
});

test("[S-02] LIMESURVEY_EXPORT_DIR alone satisfies import_via_path", async () => {
  const { capabilities, blockedBy } = await instanceInfo({
    LIMESURVEY_WRITE_SCOPE: "content",
    LIMESURVEY_EXPORT_DIR: "./exports",
  });
  assert.equal(capabilities.import_via_path, true);
  assert.equal(blockedBy.import_via_path, null);
  assert.equal(capabilities.file_exports, true);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { envPreflightWarnings, loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest } from "../src/types.js";

const PASSWORD = "test-only-not-a-secret";
const ENV_PASSWORD = "test-only-env-value";

const directory = mkdtempSync(path.join(tmpdir(), "limesurvey-mcp-password-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const baseEnv = {
  LIMESURVEY_URL: "https://survey.example.test/index.php/admin/remotecontrol",
  LIMESURVEY_USERNAME: "rpc-user",
};

function passwordFile(name: string, content: Buffer, mode?: number): string {
  const file = path.join(directory, name);
  writeFileSync(file, content, mode === undefined ? {} : { mode });
  return file;
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

async function connected(config: ReturnType<typeof loadConfig>) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-1" : [];
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "password-file-test", version: "1.0.0" });
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

test("[X-01] a password file with UTF-8 BOM and CRLF reaches get_session_key without BOM and line ending", async () => {
  const file = passwordFile("bom-crlf.txt", Buffer.concat([utf8Bom, Buffer.from(`${PASSWORD}\r\n`, "utf8")]));
  const config = loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: file });
  assert.equal(config.password, PASSWORD);
  const session = await connected(config);
  try {
    const response = await session.client.callTool({ name: "limesurvey_list_surveys", arguments: {} });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const login = session.requests.find((request) => request.method === "get_session_key");
    assert.deepEqual(login?.params, ["rpc-user", PASSWORD, "Authdb"]);
  } finally {
    await session.close();
  }
});

test("[X-01] only trailing line endings are removed from the password", () => {
  const cases: Array<[string, string]> = [
    [" pw with spaces \r\n", " pw with spaces "],
    ["plain\n", "plain"],
    ["plain\r", "plain"],
    ["plain", "plain"],
  ];
  cases.forEach(([content, expected], index) => {
    const file = passwordFile(`trim-${index}.txt`, Buffer.from(content, "utf8"));
    assert.equal(loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: file }).password, expected);
  });
});

test("[X-01] a UTF-16 password file is rejected with the cause and the fix, without the password", () => {
  const littleEndian = passwordFile("utf16le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${PASSWORD}\r\n`, "utf16le")]));
  const bigEndian = passwordFile("utf16be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${PASSWORD}\r\n`, "utf16le").swap16()]));
  for (const file of [littleEndian, bigEndian]) {
    assert.throws(
      () => loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: file }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /UTF-16/);
        assert.match(message, /WriteAllText/);
        assert.ok(!message.includes(PASSWORD));
        return true;
      },
    );
  }
});

test("[X-01] a password file that is not valid UTF-8 is rejected", () => {
  const file = passwordFile("latin1.txt", Buffer.from([0x70, 0x77, 0xe4, 0x28, 0x0a]));
  assert.throws(() => loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: file }), /UTF-8/);
});

test("[X-01] an empty password file is rejected", () => {
  for (const [name, content] of [["empty.txt", ""], ["newline.txt", "\r\n"], ["bom-only.txt", "﻿"]] as const) {
    const file = passwordFile(name, Buffer.from(content, "utf8"));
    assert.throws(() => loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: file }), /empty/i, name);
  }
});

test("[X-01] a missing password file fails with the path only", () => {
  const missing = path.join(directory, "does-not-exist.txt");
  assert.throws(
    () => loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: missing, LIMESURVEY_PASSWORD: ENV_PASSWORD }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(message.includes(missing), message);
      assert.match(message, /LIMESURVEY_PASSWORD_FILE/);
      assert.ok(!message.includes(ENV_PASSWORD));
      return true;
    },
  );
});

test("[X-01] with both variables the file wins and the start-up warning names the variables, not the values", () => {
  const file = passwordFile("both.txt", Buffer.from(`${PASSWORD}\n`, "utf8"));
  const config = loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: file, LIMESURVEY_PASSWORD: ENV_PASSWORD });
  assert.equal(config.password, PASSWORD);
  const warnings = envPreflightWarnings(config).filter(
    (warning) => warning.includes("LIMESURVEY_PASSWORD_FILE") && warning.includes("LIMESURVEY_PASSWORD "),
  );
  assert.equal(warnings.length, 1, JSON.stringify(envPreflightWarnings(config)));
  for (const warning of envPreflightWarnings(config)) {
    assert.ok(!warning.includes(PASSWORD));
    assert.ok(!warning.includes(ENV_PASSWORD));
  }
});

test("[X-01] without any password source the error names both variables", () => {
  assert.throws(() => loadConfig({ ...baseEnv }), /Missing LIMESURVEY_PASSWORD or LIMESURVEY_PASSWORD_FILE\./);
  assert.throws(() => loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: "   " }), /Missing LIMESURVEY_PASSWORD or LIMESURVEY_PASSWORD_FILE\./);
});

test("[X-01] get_instance_info reports the password source but neither path nor content", async () => {
  const file = passwordFile("source.txt", Buffer.from(`${PASSWORD}\n`, "utf8"));
  const fromFile = await connected(loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: file }));
  try {
    const response = await fromFile.client.callTool({ name: "limesurvey_get_instance_info", arguments: {} });
    const text = JSON.stringify(response.structuredContent);
    assert.equal((response.structuredContent as { result: Record<string, unknown> }).result.password_source, "file");
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!text.includes(path.basename(file)));
  } finally {
    await fromFile.close();
  }

  const fromEnv = await connected(loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD: ENV_PASSWORD }));
  try {
    const response = await fromEnv.client.callTool({ name: "limesurvey_get_instance_info", arguments: {} });
    assert.equal((response.structuredContent as { result: Record<string, unknown> }).result.password_source, "env");
    assert.ok(!JSON.stringify(response.structuredContent).includes(ENV_PASSWORD));
  } finally {
    await fromEnv.close();
  }
});

test("[X-01] on POSIX a password file readable by group or others produces a chmod 600 warning", { skip: process.platform === "win32" }, () => {
  const open = passwordFile("mode-644.txt", Buffer.from(`${PASSWORD}\n`, "utf8"), 0o644);
  const closed = passwordFile("mode-600.txt", Buffer.from(`${PASSWORD}\n`, "utf8"), 0o600);
  const warned = envPreflightWarnings(loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: open }));
  assert.ok(warned.some((warning) => /chmod 600/.test(warning)), JSON.stringify(warned));
  assert.ok(warned.every((warning) => !warning.includes(PASSWORD)));
  const quiet = envPreflightWarnings(loadConfig({ ...baseEnv, LIMESURVEY_PASSWORD_FILE: closed }));
  assert.ok(!quiet.some((warning) => /chmod/.test(warning)));
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import type { LimeSurveyConfig } from "../../src/types.js";
import { FakeLimeSurvey } from "./fake-limesurvey.js";

const baseEnv = {
  LIMESURVEY_URL: "https://survey.example.test/index.php/admin/remotecontrol",
  LIMESURVEY_USERNAME: "rpc-user",
  LIMESURVEY_PASSWORD: "secret",
};

/** A config built by loadConfig from the environment (no import/export directory unless the extra variables set one). */
export function envConfig(extra: Record<string, string> = {}): LimeSurveyConfig {
  return loadConfig({ ...baseEnv, ...extra });
}

/** An MCP client connected in memory to a server whose LimeSurvey is the fake. */
export async function connectFake(options: { config?: LimeSurveyConfig; fake?: FakeLimeSurvey } = {}) {
  const fake = options.fake ?? new FakeLimeSurvey();
  const created = createServer(options.config ?? envConfig(), fake.fetch);
  const client = new Client({ name: "generator-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    fake,
    async close() {
      await client.close();
      await created.server.close();
    },
  };
}

export type Session = Awaited<ReturnType<typeof connectFake>>;

/** The structured result of a workflow tool answer ({ workflow, result }). */
export function resultOf(response: unknown): Record<string, any> {
  const content = (response as { structuredContent?: { result?: Record<string, any> } }).structuredContent;
  if (!content?.result) throw new Error(`The tool answered without structured content: ${JSON.stringify(response)}`);
  return content.result;
}

const parityDir = path.resolve("test", "fixtures", "lss-parity");

/** A spec of test/fixtures/lss-parity, e.g. "p03-minimal-matrix". */
export async function paritySpec(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(parityDir, `${name}.spec.json`), "utf8")) as Record<string, any>;
}

/** The reference .lss of the Python generator for a parity spec, as bytes. */
export async function parityLss(name: string): Promise<Buffer> {
  return readFile(path.join(parityDir, `${name}.lss`));
}

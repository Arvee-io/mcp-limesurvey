import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, JsonValue, LimeSurveyConfig } from "../src/types.js";

const config: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

/** Calls limesurvey_get_language_properties against a mock that answers it with `answer`. */
async function getLanguageProperties(properties: string[] | null, answer: JsonValue) {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key" ? "session-1" : answer;
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server } = createServer(config, mockFetch);
  const client = new Client({ name: "language-properties-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const response = await client.callTool({
      name: "limesurvey_get_language_properties",
      arguments: { survey_id: 100, ...(properties ? { properties } : {}) },
    });
    return response;
  } finally {
    await client.close();
    await server.close();
  }
}

type Structured = { result: Record<string, unknown>; warnings?: Array<Record<string, unknown>> };
const structured = (response: unknown) => (response as { structuredContent: unknown }).structuredContent as Structured;

/** PHP serialize() of a string: the length counts bytes, not characters. */
const phpString = (value: string) => `s:${Buffer.byteLength(value, "utf8")}:"${value}";`;

test("[S-07] a JSON attachments string is parsed per mail type and the raw field stays untouched", async () => {
  const raw = JSON.stringify({
    invitation: [
      { url: "/var/www/upload/surveys/100/files/flyer.pdf", size: "12345", relevance: "1" },
      { url: "/var/www/upload/global/terms.pdf", size: "99", relevance: "Q1.NAOK == 'Y'" },
    ],
    admin_notification: [{ url: "C:\\upload\\surveys\\100\\files\\note.txt", size: "7", relevance: "1" }],
  });
  const response = await getLanguageProperties(["attachments"], { attachments: raw });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const { result } = structured(response);
  assert.equal(result.attachments, raw);
  assert.deepEqual(result.attachments_parsed, {
    invitation: [
      { file_name: "flyer.pdf", url: "/var/www/upload/surveys/100/files/flyer.pdf", size: 12345, relevance: "1" },
      { file_name: "terms.pdf", url: "/var/www/upload/global/terms.pdf", size: 99, relevance: "Q1.NAOK == 'Y'" },
    ],
    admin_notification: [
      { file_name: "note.txt", url: "C:\\upload\\surveys\\100\\files\\note.txt", size: 7, relevance: "1" },
    ],
  });
});

test("[S-07] a PHP serialize attachments string of older instances is parsed with byte lengths", async () => {
  const url = "/var/www/upload/surveys/100/files/Prüfung ä.pdf";
  const raw = "a:1:{" + phpString("reminder")
    + "a:1:{i:0;a:3:{" + phpString("url") + phpString(url)
    + phpString("size") + phpString("2048")
    + phpString("relevance") + phpString("1") + "}}}";
  const response = await getLanguageProperties(["attachments"], { attachments: raw });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const { result, warnings } = structured(response);
  assert.equal(result.attachments, raw);
  assert.deepEqual(result.attachments_parsed, {
    reminder: [{ file_name: "Prüfung ä.pdf", url, size: 2048, relevance: "1" }],
  });
  assert.equal(warnings, undefined);
});

test("[S-07] an empty or missing attachments value yields an empty object", async () => {
  for (const attachments of ["", null]) {
    const response = await getLanguageProperties(["attachments"], { attachments });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const { result, warnings } = structured(response);
    assert.equal(result.attachments, attachments);
    assert.deepEqual(result.attachments_parsed, {}, `attachments ${JSON.stringify(attachments)}`);
    assert.equal(warnings, undefined);
  }
});

test("[S-07] an unparsable attachments string gives null and a warning instead of an error", async () => {
  const response = await getLanguageProperties(["attachments"], { attachments: "a:2:{s:3:\"url\";" });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const { result, warnings } = structured(response);
  assert.equal(result.attachments, "a:2:{s:3:\"url\";");
  assert.equal(result.attachments_parsed, null);
  assert.ok(warnings?.some((warning) => warning.hint_code === "ATTACHMENTS_UNPARSEABLE"), JSON.stringify(warnings));
});

test("[S-07] attachments_parsed only appears when attachments is part of the answer", async () => {
  const response = await getLanguageProperties(["surveyls_title"], { surveyls_title: "Title" });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const { result } = structured(response);
  assert.deepEqual(result, { surveyls_title: "Title" });
});

test("[S-07] requested names missing from the answer are reported as unknown_fields", async () => {
  const response = await getLanguageProperties(
    ["surveyls_title", "surveyls_nonexistent", "attachment"],
    { surveyls_title: "Title" },
  );
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const { result, warnings } = structured(response);
  assert.deepEqual(result, { surveyls_title: "Title" });
  const warning = warnings?.find((item) => item.hint_code === "UNKNOWN_FIELDS");
  assert.ok(warning, JSON.stringify(warnings));
  assert.deepEqual(warning.unknown_fields, ["surveyls_nonexistent", "attachment"]);
  assert.equal(typeof warning.hint, "string");
});

test("[S-07] when every requested name is unknown the existing no-valid-data interpretation stays", async () => {
  const response = await getLanguageProperties(["nope"], { status: "No valid Data" });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.structuredContent), /NO_DATA/);
});

test("[S-07] the tool description documents attachments_parsed and unknown fields", async () => {
  const { server } = createServer(config, async () => new Response("{}"));
  const client = new Client({ name: "language-properties-description", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tool = (await client.listTools()).tools.find((item) => item.name === "limesurvey_get_language_properties");
    assert.match(String(tool?.description), /attachments_parsed/);
    assert.match(String(tool?.description), /unknown_fields/);
  } finally {
    await client.close();
    await server.close();
  }
});

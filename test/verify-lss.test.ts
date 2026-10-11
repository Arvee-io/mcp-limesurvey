import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, JsonValue, LimeSurveyConfig } from "../src/types.js";

const baseConfig: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 200_000,
};

const TOOL = "limesurvey_verify_survey_against_lss";
const fixturePath = path.resolve("test", "fixtures", "sample-survey.lss");

type Json = Record<string, JsonValue>;

interface LiveQuestion {
  qid: number;
  gid: number;
  title: string;
  type: string;
  mandatory: string;
  relevance: string;
  other: string;
  order: number;
  text: Record<string, string>;
  help: Record<string, string>;
  attributes: Record<string, string>;
  attributesLang: Record<string, Record<string, string>>;
  answers: Record<string, Record<string, string>>;
}

interface LiveSubquestion {
  qid: number;
  parent: number;
  title: string;
  text: Record<string, string>;
}

interface Live {
  groups: Array<{ gid: number; order: number; name: Record<string, string> }>;
  questions: LiveQuestion[];
  subquestions: LiveSubquestion[];
}

/** The live survey that sample-survey.lss describes, with new IDs (an import assigns new IDs). */
function sampleLive(): Live {
  return {
    groups: [
      { gid: 901, order: 1, name: { en: "Basics", de: "Grundlagen" } },
      { gid: 902, order: 2, name: { en: "Details", de: "Einzelheiten" } },
    ],
    questions: [
      {
        qid: 801, gid: 901, title: "Q1", type: "L", mandatory: "Y", relevance: "1", other: "N", order: 1,
        text: { en: "Pick one", de: "Waehle eins" }, help: { en: "", de: "" },
        attributes: { random_order: "0", display_columns: "1", cssclass: "" },
        attributesLang: { en: { em_validation_q_tip: "Choose carefully" }, de: { em_validation_q_tip: "Bitte genau waehlen" } },
        answers: { A1: { en: "Yes", de: "Ja" }, A2: { en: "No", de: "Nein" } },
      },
      {
        qid: 802, gid: 901, title: "Q2", type: "F", mandatory: "N", relevance: "Q1.NAOK == \"A1\"", other: "N", order: 2,
        text: { en: "Rate the items", de: "Bewerte die Punkte" },
        help: { en: "One rating each", de: "Je eine Bewertung" },
        attributes: {}, attributesLang: {},
        answers: { B1: { en: "Good", de: "Gut" }, B2: { en: "Bad", de: "Schlecht" } },
      },
      {
        qid: 803, gid: 902, title: "Q3", type: "T", mandatory: "N", relevance: "1", other: "N", order: 1,
        text: { en: "Any comment?", de: "Noch eine Anmerkung?" }, help: { en: "", de: "" },
        attributes: { maximum_chars: "200" }, attributesLang: {}, answers: {},
      },
    ],
    subquestions: [
      { qid: 8021, parent: 802, title: "SQ1", text: { en: "First item", de: "Erster Punkt" } },
      { qid: 8022, parent: 802, title: "SQ2", text: { en: "Second item", de: "Zweiter Punkt" } },
    ],
  };
}

function questionRow(question: LiveQuestion, language: string): Json {
  return {
    id: question.qid, question: question.text[language] ?? "", help: question.help[language] ?? "", language,
    qid: question.qid, parent_qid: 0, sid: 555, gid: question.gid, type: question.type, title: question.title,
    mandatory: question.mandatory, relevance: question.relevance, other: question.other,
    question_order: question.order, scale_id: 0,
  };
}

function properties(question: LiveQuestion, names: JsonValue, language: string): Json {
  const answerOptions: Json = {};
  Object.entries(question.answers).forEach(([code, texts], index) => {
    answerOptions[code] = { answer: texts[language] ?? "", assessment_value: 0, scale_id: 0, order: index };
  });
  const all: Json = {
    title: question.title,
    question: question.text[language] ?? "",
    help: question.help[language] ?? "",
    type: question.type,
    mandatory: question.mandatory,
    relevance: question.relevance,
    other: question.other,
    attributes: Object.keys(question.attributes).length > 0 ? question.attributes : "No available attributes",
    attributes_lang: Object.keys(question.attributesLang[language] ?? {}).length > 0
      ? (question.attributesLang[language] as Record<string, string>)
      : "No available attributes",
    answeroptions: Object.keys(answerOptions).length > 0 ? answerOptions : "No available answer options",
  };
  if (!Array.isArray(names)) return all;
  return Object.fromEntries(names.filter((name): name is string => typeof name === "string" && name in all).map((name) => [name, all[name] as JsonValue]));
}

/** Read-only mock of the RemoteControl methods the verification may use. Any other method fails the test. */
function liveFetch(live: Live, requests: JsonRpcRequest[], baseLanguage = "en"): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const [, ...params] = request.params;
    let result: JsonValue;
    switch (request.method) {
      case "get_session_key":
        result = "session-1";
        break;
      case "get_survey_properties":
        result = { language: baseLanguage };
        break;
      case "list_groups": {
        const language = typeof params[1] === "string" ? params[1] : baseLanguage;
        result = live.groups.map((group) => ({
          id: group.gid, gid: group.gid, sid: 555, group_order: group.order, grelevance: "1",
          group_name: group.name[language] ?? "", description: "", language,
        }));
        break;
      }
      case "list_questions": {
        const language = typeof params[2] === "string" ? params[2] : baseLanguage;
        result = [
          ...live.questions.map((question) => questionRow(question, language)),
          ...live.subquestions.map((sub) => {
            const parent = live.questions.find((question) => question.qid === sub.parent) as LiveQuestion;
            return {
              id: sub.qid, question: sub.text[language] ?? "", help: "", language, qid: sub.qid, parent_qid: sub.parent,
              sid: 555, gid: parent.gid, type: "T", title: sub.title, mandatory: "N", relevance: "1", other: "N",
              question_order: 1, scale_id: 0,
            };
          }),
        ];
        break;
      }
      case "get_question_properties": {
        const question = live.questions.find((item) => item.qid === params[0]);
        const language = typeof params[2] === "string" ? params[2] : baseLanguage;
        result = question ? properties(question, params[1] ?? null, language) : { status: "Error: Invalid questionid" };
        break;
      }
      default:
        throw new Error(`verify_survey_against_lss must only read, but called ${request.method}`);
    }
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
}

async function withTool<T>(
  config: LimeSurveyConfig,
  mockFetch: typeof fetch,
  run: (call: (args: Record<string, unknown>) => Promise<{ isError?: boolean; structured: Record<string, unknown> | undefined; thrown?: string }>) => Promise<T>,
): Promise<T> {
  const { server } = createServer(config, mockFetch);
  const client = new Client({ name: "verify-lss-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(async (args) => {
      try {
        const response = await client.callTool({ name: TOOL, arguments: args });
        return {
          ...(response.isError ? { isError: true } : {}),
          structured: response.structuredContent as Record<string, unknown> | undefined,
        };
      } catch (error) {
        // An unregistered tool surfaces as a protocol error; keep the test failing at an assertion.
        return { isError: true, structured: undefined, thrown: error instanceof Error ? error.message : String(error) };
      }
    });
  } finally {
    await client.close();
    await server.close();
  }
}

async function importDirWith(lss?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-lss-"));
  if (lss === undefined) await copyFile(fixturePath, path.join(dir, "sample.lss"));
  else await writeFile(path.join(dir, "sample.lss"), lss, "utf8");
  return dir;
}

type Difference = { kind: string; group: string | null; question: string | null; item: string | null; field: string | null; lss: unknown; live: unknown };
type Report = {
  survey_id: number;
  lss_file: string;
  language: string;
  summary: Record<string, unknown> & { attributes: Record<string, number> };
  differences: Difference[];
  differences_total: number;
  truncated: boolean;
  limitations: string[];
};

function reportOf(structured: Record<string, unknown> | undefined): Report {
  assert.ok(structured, "the tool must return structured content");
  assert.equal(structured.workflow, "verify_survey_against_lss");
  return structured.result as Report;
}

async function verify(live: Live, args: Record<string, unknown> = {}, lss?: string) {
  const dir = await importDirWith(lss);
  const requests: JsonRpcRequest[] = [];
  try {
    return await withTool({ ...baseConfig, importDir: dir }, liveFetch(live, requests), async (call) => {
      const response = await call({ survey_id: 555, lss_path: "sample.lss", ...args });
      return { response, requests };
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("[S-10] an identical live survey has no differences and only read RPCs are used", async () => {
  const { response, requests } = await verify(sampleLive());
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const report = reportOf(response.structured);
  assert.equal(report.survey_id, 555);
  assert.equal(report.lss_file, "sample.lss");
  assert.equal(report.language, "en");
  assert.deepEqual(report.differences, []);
  assert.equal(report.truncated, false);
  assert.equal(report.differences_total, 0);
  assert.deepEqual(report.summary.attributes, { missing_in_live: 0, extra_in_live: 0, changed: 0 });
  assert.ok(report.limitations.length > 0);
  assert.match(report.limitations.join(" "), /quota/i);
  assert.match(report.limitations.join(" "), /condition/i);
  const methods = requests.map((request) => request.method);
  assert.deepEqual(
    [...new Set(methods)].sort(),
    ["get_question_properties", "get_session_key", "get_survey_properties", "list_groups", "list_questions"],
  );
  assert.equal(methods.filter((method) => method === "get_question_properties").length, 3);
});

test("[S-10] a changed text, a changed attribute, a missing answer and an extra question are reported", async () => {
  const live = sampleLive();
  const [q1, , q3] = live.questions as [LiveQuestion, LiveQuestion, LiveQuestion];
  q1.text.en = "Pick exactly one";
  delete q1.answers.A2;
  q3.attributes.maximum_chars = "250";
  live.questions.push({
    qid: 899, gid: 902, title: "Q9", type: "T", mandatory: "N", relevance: "1", other: "N", order: 2,
    text: { en: "Surprise", de: "Ueberraschung" }, help: { en: "", de: "" },
    attributes: {}, attributesLang: {}, answers: {},
  });
  const { response } = await verify(live);
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const report = reportOf(response.structured);

  const text = report.differences.find((item) => item.kind === "question_field" && item.question === "Q1" && item.field === "question");
  assert.ok(text, JSON.stringify(report.differences));
  assert.equal(text.lss, "Pick one");
  assert.equal(text.live, "Pick exactly one");
  assert.equal(text.group, "Basics");

  const answer = report.differences.find((item) => item.kind === "answer_missing_in_live");
  assert.ok(answer, JSON.stringify(report.differences));
  assert.equal(answer.question, "Q1");
  assert.equal(answer.item, "A2");

  const attribute = report.differences.find((item) => item.kind === "attribute_changed");
  assert.ok(attribute, JSON.stringify(report.differences));
  assert.equal(attribute.question, "Q3");
  assert.equal(attribute.item, "maximum_chars");
  assert.equal(attribute.lss, "200");
  assert.equal(attribute.live, "250");

  const extra = report.differences.find((item) => item.kind === "question_extra_in_live");
  assert.ok(extra, JSON.stringify(report.differences));
  assert.equal(extra.question, "Q9");

  assert.equal(report.differences.length, 4, JSON.stringify(report.differences));
  assert.equal(report.summary.attributes.changed, 1);
  assert.equal(report.differences_total, 4);
});

test("[S-10] missing and extra subquestions, a missing question and a renamed group are reported by code", async () => {
  const live = sampleLive();
  live.subquestions = [
    { qid: 8021, parent: 802, title: "SQ1", text: { en: "First thing", de: "Erster Punkt" } },
    { qid: 8023, parent: 802, title: "SQ3", text: { en: "Third item", de: "Dritter Punkt" } },
  ];
  live.questions = live.questions.filter((question) => question.title !== "Q3");
  (live.groups[1] as Live["groups"][number]).name.en = "More details";
  const { response } = await verify(live);
  const report = reportOf(response.structured);
  const kinds = report.differences.map((item) => `${item.kind}:${item.question ?? ""}:${item.item ?? ""}`);
  assert.ok(kinds.includes("subquestion_field:Q2:SQ1"), kinds.join(", "));
  assert.ok(kinds.includes("subquestion_missing_in_live:Q2:SQ2"), kinds.join(", "));
  assert.ok(kinds.includes("subquestion_extra_in_live:Q2:SQ3"), kinds.join(", "));
  assert.ok(kinds.includes("question_missing_in_live:Q3:"), kinds.join(", "));
  const group = report.differences.find((item) => item.kind === "group_field");
  assert.ok(group, JSON.stringify(report.differences));
  assert.equal(group.field, "group_name");
  assert.equal(group.lss, "Details");
  assert.equal(group.live, "More details");
});

test("[S-10] the comparison uses the requested language for both sides", async () => {
  const requests: JsonRpcRequest[] = [];
  const dir = await importDirWith();
  try {
    await withTool({ ...baseConfig, importDir: dir }, liveFetch(sampleLive(), requests), async (call) => {
      const response = await call({ survey_id: 555, lss_path: "sample.lss", language: "de" });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      const report = reportOf(response.structured);
      assert.equal(report.language, "de");
      assert.deepEqual(report.differences, []);
      const groupsCall = requests.find((request) => request.method === "list_groups");
      assert.equal(groupsCall?.params[2], "de");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[S-10] more than 500 differences are cut with truncated=true and the full count", async () => {
  const live = sampleLive();
  for (let index = 0; index < 510; index += 1) {
    live.questions.push({
      qid: 5000 + index, gid: 902, title: `X${index}`, type: "T", mandatory: "N", relevance: "1", other: "N", order: 10 + index,
      text: { en: "Extra", de: "Extra" }, help: { en: "", de: "" }, attributes: {}, attributesLang: {}, answers: {},
    });
  }
  const { response } = await verify(live);
  const report = reportOf(response.structured);
  assert.equal(report.differences.length, 500);
  assert.equal(report.truncated, true);
  assert.equal(report.differences_total, 510);
});

test("[S-10] a path outside the import directory fails without any RPC", async () => {
  const requests: JsonRpcRequest[] = [];
  const dir = await importDirWith();
  try {
    await withTool({ ...baseConfig, importDir: dir }, liveFetch(sampleLive(), requests), async (call) => {
      for (const lssPath of ["../package.json", path.resolve("package.json")]) {
        const response = await call({ survey_id: 555, lss_path: lssPath });
        assert.equal(response.isError, true, lssPath);
        assert.match(JSON.stringify(response.structured), /IMPORT_PATH_OUTSIDE_DIR/);
      }
    });
    assert.deepEqual(requests, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[S-10] without an import directory the export directory is the fallback, and neither set fails without RPC", async () => {
  const requests: JsonRpcRequest[] = [];
  const dir = await importDirWith();
  try {
    await withTool({ ...baseConfig, exportDir: dir }, liveFetch(sampleLive(), requests), async (call) => {
      const response = await call({ survey_id: 555, lss_path: "sample.lss" });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      assert.deepEqual(reportOf(response.structured).differences, []);
    });
    const before = requests.length;
    await withTool(baseConfig, liveFetch(sampleLive(), requests), async (call) => {
      const response = await call({ survey_id: 555, lss_path: "sample.lss" });
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response.structured), /IMPORT_DIR_NOT_CONFIGURED/);
    });
    assert.equal(requests.length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[S-10] a file that is not a LimeSurvey structure fails with LSS_INVALID before any RPC", async () => {
  const requests: JsonRpcRequest[] = [];
  const dir = await importDirWith("<html><body>not a survey</body></html>");
  try {
    await withTool({ ...baseConfig, importDir: dir }, liveFetch(sampleLive(), requests), async (call) => {
      const response = await call({ survey_id: 555, lss_path: "sample.lss" });
      assert.equal(response.isError, true, JSON.stringify(response));
      assert.match(JSON.stringify(response.structured), /LSS_INVALID/);
    });
    assert.deepEqual(requests, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[S-10] the tool is a read tool that stays usable under LIMESURVEY_READ_ONLY", async () => {
  const dir = await importDirWith();
  try {
    await withTool({ ...baseConfig, importDir: dir, readOnly: true }, liveFetch(sampleLive(), []), async (call) => {
      const response = await call({ survey_id: 555, lss_path: "sample.lss" });
      assert.equal(response.isError, undefined, JSON.stringify(response));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[S-10] the LSS fixture is the generic sample without customer data", async () => {
  const text = await readFile(fixturePath, "utf8");
  assert.match(text, /<LimeSurveyDocType>Survey<\/LimeSurveyDocType>/);
});

// export_survey_to_file: try export_survey_structure first, then export_survey

function exportFetch(methods: string[], handlers: Record<string, (id: number) => Response>): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    methods.push(request.method);
    if (request.method === "get_session_key") {
      return new Response(JSON.stringify({ id: request.id, result: "session-1", error: null }));
    }
    const handler = handlers[request.method];
    return handler ? handler(request.id) : new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
  };
}

async function exportSurvey(config: LimeSurveyConfig, fetchImpl: typeof fetch, args: Record<string, unknown> = {}) {
  const { server } = createServer(config, fetchImpl);
  const client = new Client({ name: "export-structure-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name: "limesurvey_export_survey_to_file", arguments: { survey_id: 123, ...args } });
  } finally {
    await client.close();
    await server.close();
  }
}

test("[S-10] export_survey_to_file asks export_survey_structure first and writes the decoded file", async () => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-export-structure-"));
  try {
    const methods: string[] = [];
    const lss = "<document>structure</document>";
    const response = await exportSurvey(
      { ...baseConfig, exportDir, enableExperimentalMethods: true },
      exportFetch(methods, {
        export_survey_structure: (id) => new Response(JSON.stringify({ id, result: Buffer.from(lss).toString("base64"), error: null })),
      }),
      { file_name: "survey.lss" },
    );
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    assert.equal(await readFile(path.join(exportDir, "survey.lss"), "utf8"), lss);
    assert.deepEqual(methods, ["get_session_key", "export_survey_structure"]);
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
});

test("[S-10] export_survey_to_file falls back to export_survey when export_survey_structure is unknown", async () => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-export-fallback-"));
  try {
    const methods: string[] = [];
    const lss = "<document>fallback</document>";
    const response = await exportSurvey(
      { ...baseConfig, exportDir, enableExperimentalMethods: true },
      exportFetch(methods, {
        export_survey: (id) => new Response(JSON.stringify({ id, result: Buffer.from(lss).toString("base64"), error: null })),
      }),
      { file_name: "survey.lss" },
    );
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    assert.equal(await readFile(path.join(exportDir, "survey.lss"), "utf8"), lss);
    assert.deepEqual(methods, ["get_session_key", "export_survey_structure", "export_survey"]);
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
});

test("[S-10] export_survey_to_file names the facts and the verification alternative when nothing works", async () => {
  const methods: string[] = [];
  const response = await exportSurvey(
    { ...baseConfig, exportDir: "./exports", enableExperimentalMethods: true },
    exportFetch(methods, {}),
  );
  assert.equal(response.isError, true);
  const text = JSON.stringify(response.structuredContent);
  assert.match(text, /EXPORT_UNSUPPORTED/);
  assert.match(text, /export_survey_structure/);
  assert.match(text, /no known 6\.x plugin|no verified plugin/i);
  assert.match(text, /7\.x/);
  assert.match(text, /limesurvey_verify_survey_against_lss/);
  assert.deepEqual(methods, ["get_session_key", "export_survey_structure", "export_survey"]);
});

test("[S-10] export_survey_to_file without the experimental switch points to the verification tool", async () => {
  const methods: string[] = [];
  const response = await exportSurvey({ ...baseConfig, exportDir: "./exports" }, exportFetch(methods, {}));
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.structuredContent), /limesurvey_verify_survey_against_lss/);
  assert.deepEqual(methods, []);
});

test("[S-10] the tool descriptions state the plugin situation and the verification alternative", async () => {
  const { server } = createServer(baseConfig, async () => new Response("{}"));
  const client = new Client({ name: "verify-descriptions", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = (await client.listTools()).tools;
    const exportTool = tools.find((tool) => tool.name === "limesurvey_export_survey_to_file");
    assert.match(String(exportTool?.description), /export_survey_structure/);
    assert.match(String(exportTool?.description), /limesurvey_verify_survey_against_lss/);
    const verifyTool = tools.find((tool) => tool.name === TOOL);
    assert.ok(verifyTool, "the verification tool must be registered");
    assert.equal(verifyTool.annotations?.readOnlyHint, true);
    assert.match(String(verifyTool.description), /LIMESURVEY_IMPORT_DIR/);
  } finally {
    await client.close();
    await server.close();
  }
});

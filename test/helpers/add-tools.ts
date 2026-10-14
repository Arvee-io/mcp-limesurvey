import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { XMLParser } from "fast-xml-parser";
import type { FakeLimeSurvey } from "./fake-limesurvey.js";
import type { Session } from "./mcp-session.js";
import { groupsOf, mainQuestionsOf, type Json } from "./spec-tools.js";

/**
 * Shared by the tests of limesurvey_add_question_from_spec (GEN-A) and limesurvey_add_group_from_spec (GEN-C): calls of
 * the two tools, the structure file they import, the answers of the fake and outlines of a survey to compare.
 */

export const ADD_QUESTION = "limesurvey_add_question_from_spec";
export const ADD_GROUP = "limesurvey_add_group_from_spec";

export const both = (de: string, en: string) => ({ de, en });

/** The result of a workflow answer ({ workflow, result }); a missing result fails as an assertion. */
export function toolResult(response: unknown): Json {
  const result = (response as { structuredContent?: { result?: Json } }).structuredContent?.result;
  assert.ok(result, `the tool answered without a structured result: ${JSON.stringify(response).slice(0, 800)}`);
  return result;
}

const describe = (response: unknown): string => {
  const { structuredContent, content } = response as { structuredContent?: unknown; content?: unknown };
  return JSON.stringify(structuredContent ?? content).slice(0, 2500);
};

export const addQuestion = (session: Session, args: Json) => session.client.callTool({ name: ADD_QUESTION, arguments: args });
export const addGroup = (session: Session, args: Json) => session.client.callTool({ name: ADD_GROUP, arguments: args });

/** add_question_from_spec that must succeed; returns the result of the tool. */
export async function addQuestionOk(session: Session, args: Json): Promise<Json> {
  const response = await addQuestion(session, args);
  assert.equal(response.isError, undefined, describe(response));
  return toolResult(response);
}

/** add_question_from_spec that must fail; returns the error result ({ status, message, code, details }). */
export async function addQuestionError(session: Session, args: Json): Promise<Json> {
  const response = await addQuestion(session, args);
  assert.equal(response.isError, true, describe(response));
  return toolResult(response);
}

/** add_group_from_spec that must succeed; returns the result of the tool. */
export async function addGroupOk(session: Session, args: Json): Promise<Json> {
  const response = await addGroup(session, args);
  assert.equal(response.isError, undefined, describe(response));
  return toolResult(response);
}

/** add_group_from_spec that must fail; returns the error result ({ status, message, code, details }). */
export async function addGroupError(session: Session, args: Json): Promise<Json> {
  const response = await addGroup(session, args);
  assert.equal(response.isError, true, describe(response));
  return toolResult(response);
}

/** The paths of the errors of a SPEC_INVALID result. */
export function errorPaths(result: Json): string[] {
  assert.equal(result.code, "SPEC_INVALID", JSON.stringify(result).slice(0, 1500));
  const errors = result.details?.errors as Array<{ path?: unknown }> | undefined;
  assert.ok(Array.isArray(errors) && errors.length > 0, JSON.stringify(result.details));
  return errors.map((item) => String(item.path));
}

/** The requests of one method from index `from` on. */
export const requestsSince = (fake: FakeLimeSurvey, from: number, method: string) => fake.requests
  .slice(from)
  .filter((request) => request.method === method);

/**
 * Records the result of every answer the fake gives to `method` (for example the new qid of import_question). Replaces the
 * fetch of the fake (a readonly field of the class), so call it before the session that sends the method is opened.
 */
export function captureResults(fake: FakeLimeSurvey, method: string): unknown[] {
  const results: unknown[] = [];
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  target.fetch = async (input, init) => {
    const response = await original(input, init);
    if ((JSON.parse(String(init?.body)) as { method?: unknown }).method === method) {
      const answer = (await response.clone().json()) as { result?: unknown };
      results.push(answer.result);
    }
    return response;
  };
  return results;
}

/** What the caller sees instead of the real answer: another result, a JSON-RPC error, an HTTP status or a lost connection. */
export type Outcome =
  | { kind: "result"; result: unknown }
  | { kind: "rpc_error"; message: string }
  | { kind: "http"; status: number }
  | { kind: "transport" };

/**
 * The first call of `method` really runs in the fake (an import creates its element), but the caller gets `outcome`
 * instead of the answer: LimeSurvey did the work, the answer says something else or never arrives. Replaces the fetch
 * of the fake, so call it before the session that sends the method is opened.
 */
export function outcomeAfterRun(fake: FakeLimeSurvey, method: string, outcome: Outcome): void {
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  let used = false;
  target.fetch = async (input, init) => {
    const response = await original(input, init);
    const body = JSON.parse(String(init?.body)) as { method?: unknown; id?: unknown };
    if (used || body.method !== method) return response;
    used = true;
    if (outcome.kind === "transport") throw new TypeError("fetch failed");
    if (outcome.kind === "http") return new Response("Internal Server Error", { status: outcome.status });
    const payload = outcome.kind === "result"
      ? { id: body.id, result: outcome.result, error: null }
      : { id: body.id, result: null, error: outcome.message };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/** A LimeSurvey structure file (.lsq, .lsg) taken apart: document type, languages and the rows of every section. */
export interface StructureFile {
  docType: string;
  languages: string[];
  sections: Record<string, Array<Record<string, string>>>;
}

export function parseStructureFile(base64: unknown): StructureFile {
  assert.equal(typeof base64, "string", "the import data is a base64 string");
  const xml = Buffer.from(String(base64), "base64").toString("utf8");
  const parsed = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (_name, jpath) => typeof jpath === "string" && (jpath.endsWith(".rows.row") || jpath === "document.languages.language"),
  }).parse(xml) as { document?: Record<string, unknown> };
  const document = parsed.document;
  assert.ok(document, "the file has no <document> root");
  const sections: Record<string, Array<Record<string, string>>> = {};
  for (const [name, node] of Object.entries(document)) {
    const rows = (node as { rows?: { row?: unknown } } | undefined)?.rows?.row;
    if (!Array.isArray(rows)) continue;
    sections[name] = rows.map((row) => Object.fromEntries(
      Object.entries(row as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("#"))
        .map(([key, value]) => [key, value === null || value === undefined ? "" : String(value)]),
    ));
  }
  const languageNode = (document.languages as { language?: unknown } | undefined)?.language;
  return {
    docType: String(document.LimeSurveyDocType ?? "").trim(),
    languages: Array.isArray(languageNode) ? languageNode.map((item) => String(item).trim()) : [],
    sections,
  };
}

/** The codes of the main questions of a group, in their order. */
export const codesOf = (fake: FakeLimeSurvey, gid: number): string[] => mainQuestionsOf(fake, gid).map((question) => question.title);

/**
 * A snapshot of a survey: its groups in their order, each with its main questions in their order. group_order and
 * question_order are left out (LimeSurvey renumbers them), everything else (ids, codes, texts, flags) is kept.
 */
export function surveyOutline(fake: FakeLimeSurvey, sid: number): Json[] {
  const outline = groupsOf(fake, sid).map(({ group_order: _groupOrder, ...group }) => ({
    ...group,
    questions: mainQuestionsOf(fake, group.gid).map(({ question_order: _questionOrder, ...question }) => question),
  }));
  return JSON.parse(JSON.stringify(outline)) as Json[];
}

/** Every property name anywhere in a JSON schema. */
export function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (schema === null || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const own = record.properties !== null && typeof record.properties === "object" ? Object.keys(record.properties) : [];
  return [...own, ...Object.values(record).flatMap(propertyNames)];
}

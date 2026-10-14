import assert from "node:assert/strict";
import type { FakeLimeSurvey } from "./fake-limesurvey.js";
import type { Session } from "./mcp-session.js";
import { toolResult } from "./add-tools.js";
import type { Json } from "./spec-tools.js";

/**
 * Shared by the tests of limesurvey_update_question_from_spec (GEN-B) and limesurvey_update_survey_texts (GEN-F): calls
 * of the two tools, the acknowledgements, and switches on the fake that act from a given moment on.
 */

export const UPDATE_QUESTION = "limesurvey_update_question_from_spec";
export const UPDATE_TEXTS = "limesurvey_update_survey_texts";

/** Every value the acknowledge enum of update_question_from_spec has. */
export const ALL_ACK = [
  "qid_bound_links",
  "quota_members",
  "other_default",
  "removals",
  "fill_translation_gaps",
  "answer_code_references",
] as const;

const describe = (response: unknown): string => {
  const { structuredContent, content } = response as { structuredContent?: unknown; content?: unknown };
  return JSON.stringify(structuredContent ?? content).slice(0, 2500);
};

/** The whole answer as text (content and structured content), for checks on messages of input errors. */
export const answerText = (response: unknown): string => {
  const { structuredContent, content } = response as { structuredContent?: unknown; content?: unknown };
  return JSON.stringify(content ?? null) + JSON.stringify(structuredContent ?? null);
};

export const updateQuestion = (session: Session, args: Json) => session.client.callTool({ name: UPDATE_QUESTION, arguments: args });
export const updateTexts = (session: Session, args: Json) => session.client.callTool({ name: UPDATE_TEXTS, arguments: args });

/** update_question_from_spec that must succeed; returns the result of the tool. */
export async function updateQuestionOk(session: Session, args: Json): Promise<Json> {
  const response = await updateQuestion(session, args);
  assert.equal(response.isError, undefined, describe(response));
  return toolResult(response);
}

/** update_question_from_spec that must fail; returns the error result ({ status, message, code, details }). */
export async function updateQuestionError(session: Session, args: Json): Promise<Json> {
  const response = await updateQuestion(session, args);
  assert.equal(response.isError, true, describe(response));
  return toolResult(response);
}

/** update_survey_texts that must succeed; returns the result of the tool. */
export async function updateTextsOk(session: Session, args: Json): Promise<Json> {
  const response = await updateTexts(session, args);
  assert.equal(response.isError, undefined, describe(response));
  return toolResult(response);
}

/** update_survey_texts that must fail; returns the error result ({ status, message, code, details }). */
export async function updateTextsError(session: Session, args: Json): Promise<Json> {
  const response = await updateTexts(session, args);
  assert.equal(response.isError, true, describe(response));
  return toolResult(response);
}

/** A deep copy of a JSON value (a spec read with get_survey_spec), to derive the desired end state from it. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The risk with this code from a list of risks ({ code, blocking, acknowledgeable, detail, locations? }). */
export function riskOf(risks: unknown, code: string): Json | undefined {
  assert.ok(Array.isArray(risks), `risks is not a list: ${JSON.stringify(risks)}`);
  return (risks as Json[]).find((item) => item.code === code);
}

/**
 * The acknowledge value of a risk whose code differs from it: translation_gaps (design 9.18) and unreadable_texts (review
 * of PR5) are both confirmed with fill_translation_gaps.
 */
const ACK_OF_RISK: Readonly<Record<string, string>> = { translation_gaps: "fill_translation_gaps", unreadable_texts: "fill_translation_gaps" };

/** What a caller confirms after reading a dry run: the acknowledge values of the risks it reports as acknowledgeable. */
export function acknowledgeable(result: Json): string[] {
  assert.ok(Array.isArray(result.risks), `the result has no risks list: ${JSON.stringify(result).slice(0, 800)}`);
  return [...new Set((result.risks as Json[])
    .filter((item) => item.acknowledgeable === true)
    .map((item) => ACK_OF_RISK[String(item.code)] ?? String(item.code)))];
}

/**
 * From now on every import of the fake silently skips the first row of the answers section (the option of the fake,
 * switched on after the survey of the test was created). dropFirstAnswerOnImport is a readonly field of the class; the
 * fake reads it at every import.
 */
export function dropFirstAnswerFromNowOn(fake: FakeLimeSurvey): void {
  (fake as unknown as { dropFirstAnswerOnImport: boolean }).dropFirstAnswerOnImport = true;
}

/**
 * The `call`-th call of `method` (counted from now, 1-based) answers `result` instead of running (failNext of the fake
 * for exactly that call). Replaces the fetch of the fake, so call it before the session that sends the method is opened.
 */
export function failOnCall(fake: FakeLimeSurvey, method: string, call: number, result: unknown): void {
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  let count = 0;
  target.fetch = async (input, init) => {
    if ((JSON.parse(String(init?.body)) as { method?: unknown }).method === method) {
      count += 1;
      if (count === call) fake.failNext(method, result);
    }
    return original(input, init);
  };
}

/** The JSON-RPC method and positional parameters of a request body (params[0] is the session key). */
function bodyOf(init: RequestInit | undefined): { method: unknown; params: unknown[] } {
  const body = JSON.parse(String(init?.body)) as { method?: unknown; params?: unknown };
  return { method: body.method, params: Array.isArray(body.params) ? body.params : [] };
}

/**
 * The first call of `method` whose parameters match answers `result` instead of running (an Error becomes a JSON-RPC
 * error). params[0] is the session key, params[1] the first argument. Call it before the session is opened.
 */
export function failWhen(fake: FakeLimeSurvey, method: string, match: (params: unknown[]) => boolean, result: unknown): void {
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  let used = false;
  target.fetch = async (input, init) => {
    const body = bodyOf(init);
    if (!used && body.method === method && match(body.params)) {
      used = true;
      fake.failNext(method, result);
    }
    return original(input, init);
  };
}

/**
 * The first call of `method` never reaches the fake: the connection fails (fetch throws), so nothing runs and the caller
 * gets no answer. Call it before the session is opened.
 */
export function transportFailureOnce(fake: FakeLimeSurvey, method: string): void {
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  let used = false;
  target.fetch = async (input, init) => {
    if (!used && bodyOf(init).method === method) {
      used = true;
      throw new TypeError("fetch failed");
    }
    return original(input, init);
  };
}

/**
 * After the first call of `trigger`, the next call of `method` answers `result` instead of running (for example a read
 * that fails after a write succeeded). Call it before the session is opened.
 */
export function failAfter(fake: FakeLimeSurvey, trigger: string, method: string, result: unknown): void {
  const target = fake as unknown as { fetch: typeof fetch };
  const original = target.fetch;
  let armed = false;
  let used = false;
  target.fetch = async (input, init) => {
    const name = bodyOf(init).method;
    if (name === trigger) armed = true;
    else if (armed && !used && name === method) {
      used = true;
      fake.failNext(method, result);
    }
    return original(input, init);
  };
}

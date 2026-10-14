import assert from "node:assert/strict";
import { FakeLimeSurvey } from "./fake-limesurvey.js";
import { connectFake, envConfig, resultOf, type Session } from "./mcp-session.js";

/** Shared by the spec tool tests: sessions on a fake, import of a spec, reading with get_survey_spec, validating. */

export const GET = "limesurvey_get_survey_spec";
export const CREATE = "limesurvey_create_survey_from_spec";
export const VALIDATE = "limesurvey_validate_spec";

export type Json = Record<string, any>;
export type Args = { survey_id: number; group_id?: number; question_id?: number };

export async function withSession<T>(
  run: (session: Session) => Promise<T>,
  options: { fake?: FakeLimeSurvey; config?: ReturnType<typeof envConfig> } = {},
): Promise<T> {
  const session = await connectFake(options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

/** create_survey_from_spec in an own session; the call must succeed and verify cleanly. Returns the survey ID. */
export async function importSpec(fake: FakeLimeSurvey, spec: unknown): Promise<number> {
  return withSession(async (session) => {
    const response = await session.client.callTool({ name: CREATE, arguments: { spec } });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
    const result = resultOf(response);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    return Number(result.survey_id);
  }, { fake });
}

export const read = (session: Session, args: Args) => session.client.callTool({ name: GET, arguments: args });

export async function readOk(session: Session, args: Args): Promise<Json> {
  const response = await read(session, args);
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 1500));
  assert.equal((response.structuredContent as { workflow?: string } | undefined)?.workflow, "get_survey_spec");
  return resultOf(response);
}

export const create = (session: Session, spec: unknown) => session.client.callTool({ name: CREATE, arguments: { spec } });

/** create_survey_from_spec that must succeed; returns the result of the tool. */
export async function createOk(session: Session, spec: unknown): Promise<Json> {
  const response = await create(session, spec);
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content).slice(0, 2500));
  return resultOf(response);
}

export async function validateSpec(session: Session, spec: unknown, extra: Record<string, unknown> = {}): Promise<Json> {
  const response = await session.client.callTool({ name: VALIDATE, arguments: { spec, ...extra } });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent ?? response.content));
  return resultOf(response);
}

export const groupsOf = (fake: FakeLimeSurvey, sid: number) => fake.groups
  .filter((group) => group.sid === sid)
  .sort((a, b) => a.group_order - b.group_order);

export const mainQuestionsOf = (fake: FakeLimeSurvey, gid: number) => fake.questions
  .filter((question) => question.gid === gid && question.parent_qid === 0)
  .sort((a, b) => a.question_order - b.question_order);

/** The methods of the requests from index `from` that write (import, set, add, delete, activate, ...). */
export const writeMethodsSince = (fake: FakeLimeSurvey, from: number): string[] => fake.requests
  .slice(from)
  .map((request) => request.method)
  .filter((method) => !/^(get_session_key|release_session_key|get_[a-z_]+|list_[a-z_]+)$/.test(method));

/** Sorted by path and language, so lists compare without depending on the order the tool found them in. */
export const sortedMissing = (list: Array<{ path: string; language: string }>): Array<{ path: string; language: string }> => [...list]
  .sort((a, b) => (a.path + a.language < b.path + b.language ? -1 : a.path + a.language > b.path + b.language ? 1 : 0));

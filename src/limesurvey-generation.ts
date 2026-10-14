/**
 * Which generation of LimeSurvey answers: 7 (7.x) or 6 (6.x). The two differ in what the generator tools have to write
 * (for example the entries of a Ranking question). RemoteControl has no version method, so the generation is read from
 * the shape of an error: get_group_properties for the group 0, which never exists, answers 7.x with a status and an
 * error_code and 6.x with a status alone. The answer is kept per client (the object that talks to one instance).
 */
import type { RpcClient } from "./scoped-client.js";
import { LimeSurveyError } from "./types.js";

export type LimeSurveyGeneration = 6 | 7;

const known = new WeakMap<object, Promise<LimeSurveyGeneration>>();

async function probe(rpc: RpcClient): Promise<LimeSurveyGeneration> {
  try {
    await rpc.call("get_group_properties", [0, ["gid"]]);
  } catch (error) {
    const answer = error instanceof LimeSurveyError ? error.details : undefined;
    // Only an answer of LimeSurvey itself (an object with a status) tells the generation; a transport or JSON-RPC error does not.
    if (answer !== null && typeof answer === "object" && !Array.isArray(answer) && typeof answer.status === "string") {
      return typeof answer.error_code === "string" ? 7 : 6;
    }
    throw error;
  }
  // The group 0 cannot exist, so an answer without an error says nothing: assume the older, stricter generation.
  return 6;
}

/**
 * The generation of the instance behind `client`, probed once: the next call with the same client object answers from
 * memory. `rpc` sends the probe (a read), so it may be a client limited to read methods. A failed probe is not kept.
 */
export function limeSurveyGeneration(rpc: RpcClient, client: object = rpc): Promise<LimeSurveyGeneration> {
  const cached = known.get(client);
  if (cached !== undefined) return cached;
  const pending = probe(rpc).catch((error: unknown) => {
    known.delete(client);
    throw error;
  });
  known.set(client, pending);
  return pending;
}

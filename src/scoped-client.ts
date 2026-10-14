import { LimeSurveyError, type JsonValue } from "./types.js";

/** What the spec tools need from a LimeSurvey client: one RemoteControl call without the session key. */
export interface RpcClient {
  call(method: string, params?: JsonValue[]): Promise<JsonValue>;
}

/** The levels a tool call can run at: nothing but reads, or reads plus the content writes of one tool. */
export type ClientLevel = "none" | "content";

/** Reads (get_fieldmap included) and session handling. */
const READ_METHOD = /^(?:get_[a-z_]+|list_[a-z_]+|release_session_key)$/;

/**
 * The only writes a content-level call may send. Not included: activate_*, participant, mail, response, upload and
 * quota methods, copy_survey, delete_survey, delete_language and every other delete. Deleting is left out on purpose:
 * a call may only delete what it created itself (the id comes from the import answer) or the one question it checked
 * first, so a tool that deletes opens that door explicitly with its own rule (see write-scope.ts), not here.
 */
const CONTENT_WRITE_METHODS: ReadonlySet<string> = new Set([
  "add_survey",
  "add_group",
  "add_language",
  "import_survey",
  "import_group",
  "import_question",
  "set_survey_properties",
  "set_language_properties",
  "set_group_properties",
  "set_question_properties",
]);

function isAllowed(level: ClientLevel, method: string, params: JsonValue[]): boolean {
  if (READ_METHOD.test(method)) return true;
  if (level === "none" || !CONTENT_WRITE_METHODS.has(method)) return false;
  // A .lsa archive activates the survey and imports participants and responses.
  if (method === "import_survey" && String(params[1]).trim().toLowerCase() === "lsa") return false;
  return true;
}

/** A client that refuses every method outside the level, so a tool cannot do more than its write scope grants. */
export function scopedClient(client: RpcClient, level: ClientLevel): RpcClient {
  return {
    async call(method, params = []) {
      if (!isAllowed(level, method, params)) {
        throw new LimeSurveyError(
          `The RemoteControl method ${method} is not available to this tool at the level "${level}".`,
          "METHOD_NOT_ALLOWED",
          { method, level },
        );
      }
      return client.call(method, params);
    },
  };
}

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
 * first, so a tool that deletes opens that door explicitly with its own rule (ScopeOptions.created, see write-scope.ts).
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

/** The ids a tool call created itself (taken from its own import answer, not in the survey before): its rollback. */
export interface CreatedIds {
  questions: Set<number>;
  groups: Set<number>;
}

/** What a tool call may narrow further than its level. */
export interface ScopeOptions {
  /**
   * The only write methods this call may send (reads always pass). An empty list allows no write. The list only narrows:
   * a method the level does not allow stays refused, and so does a .lsa import.
   */
  writeMethods?: readonly string[];
  /**
   * Opens delete_question and delete_group at the level content for exactly these ids and nothing else. The tool adds an
   * id only after its own import answered it and the id was not in the survey before.
   */
  created?: CreatedIds;
}

const idOf = (value: JsonValue | undefined): number => (typeof value === "number" ? value : Number(value));

function isAllowed(level: ClientLevel, method: string, params: JsonValue[], writes: ReadonlySet<string>, created?: CreatedIds): boolean {
  if (READ_METHOD.test(method)) return true;
  if (level === "none") return false;
  // delete_question(qid) and delete_group(sid, gid): only what this call created.
  if (method === "delete_question") return created?.questions.has(idOf(params[0])) === true;
  if (method === "delete_group") return created?.groups.has(idOf(params[1])) === true;
  if (!writes.has(method)) return false;
  // A .lsa archive activates the survey and imports participants and responses.
  if (method === "import_survey" && String(params[1]).trim().toLowerCase() === "lsa") return false;
  return true;
}

/** A client that refuses every method outside the level, so a tool cannot do more than its write scope grants. */
export function scopedClient(client: RpcClient, level: ClientLevel, options: ScopeOptions = {}): RpcClient {
  const writes: ReadonlySet<string> = options.writeMethods === undefined
    ? CONTENT_WRITE_METHODS
    : new Set(options.writeMethods.filter((method) => CONTENT_WRITE_METHODS.has(method)));
  return {
    async call(method, params = []) {
      if (!isAllowed(level, method, params, writes, options.created)) {
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

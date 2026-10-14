import {
  LimeSurveyError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonValue,
  type LimeSurveyConfig,
} from "./types.js";
import { interpretNoData } from "./rpc-hints.js";

export type FetchImplementation = typeof fetch;

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusMessage(value: JsonValue | undefined): string | undefined {
  if (!isObject(value)) return undefined;
  const status = value.status;
  return typeof status === "string" ? status : undefined;
}

function errorCode(value: JsonValue | undefined): string | undefined {
  if (!isObject(value)) return undefined;
  const code = value.error_code;
  return typeof code === "string" ? code : undefined;
}

function describeErrorMap(map: { [key: string]: JsonValue }): string {
  return Object.entries(map)
    .map(([field, problem]) => {
      const text = Array.isArray(problem) ? problem.map(String).join(" ") : typeof problem === "string" ? problem : JSON.stringify(problem);
      return `${field}: ${text}`;
    })
    .join("; ");
}

/**
 * LimeSurvey 6.17.11 reports errors in more shapes than a status string: set_participant_properties puts the
 * validation errors object into status (RemoteControl handle, set_participant_properties), and
 * set_quota_properties answers {success: false, message}. Neither carries an error_code.
 */
function structuredErrorMessage(value: JsonValue | undefined): string | undefined {
  if (!isObject(value)) return undefined;
  if (value.success === false) {
    const message = value.message;
    if (typeof message === "string") return message;
    if (isObject(message)) return describeErrorMap(message);
    return "Unknown LimeSurvey error";
  }
  if (isObject(value.status) && Object.keys(value.status).length > 0) return describeErrorMap(value.status);
  return undefined;
}

/**
 * The statuses LimeSurvey 6.17.11 returns instead of [] when a list_* method finds nothing (RemoteControl handle:
 * list_surveys, list_survey_groups, list_users, list_groups, list_questions, list_quotas, list_participants).
 * LimeSurvey 7 adds error_code "ERR_NO_DATA" to the same answer. Only these exact texts of exactly these methods
 * count; "Error: No survey participant list" (no participant table) and every other status stay errors.
 */
const EMPTY_LIST_STATUS: Readonly<Record<string, string>> = {
  list_surveys: "no surveys found",
  list_survey_groups: "no survey groups found",
  list_users: "no users found",
  list_groups: "no groups found",
  list_questions: "no questions found",
  list_quotas: "no quotas found",
  list_participants: "no survey participants found.",
};

function isEmptyListAnswer(method: string, value: JsonValue): boolean {
  const expected = EMPTY_LIST_STATUS[method];
  if (expected === undefined || !isObject(value)) return false;
  const keys = Object.keys(value);
  const shapeMatches = keys.length === 1
    || (keys.length === 2 && "error_code" in value && errorCode(value) === "ERR_NO_DATA");
  return shapeMatches && statusMessage(value)?.trim().toLowerCase() === expected;
}

function hasApiError(value: JsonValue | undefined): boolean {
  if (!isObject(value)) return false;
  if (errorCode(value)) return true;
  if (structuredErrorMessage(value) !== undefined) return true;
  if (isObject(value.errors) && Object.keys(value.errors).length > 0) return true;
  const status = statusMessage(value);
  return typeof status === "string"
    && /^(?:error\b|invalid\b|no\b|unable\b|can(?:not|'t)\b|sorry\b)|\bfailed\b/i.test(status);
}

export class LimeSurveyClient {
  private requestId = 0;
  private sessionKey: string | undefined;
  private sessionPromise: Promise<string> | undefined;
  private serverDate: Date | undefined;

  constructor(
    private readonly config: LimeSurveyConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
  ) {}

  /**
   * The HTTP Date header (the web server's clock, UTC) of the last answer. RemoteControl has no clock method,
   * so this is the only source of the LimeSurvey server time.
   */
  get lastServerDate(): Date | undefined {
    return this.serverDate;
  }

  async openSession(): Promise<{ status: "connected"; auth_plugin: string }> {
    await this.getSessionKey();
    return { status: "connected", auth_plugin: this.config.authPlugin };
  }

  async releaseSession(): Promise<JsonValue> {
    if (!this.sessionKey) return { status: "not_connected" };
    const key = this.sessionKey;
    this.sessionKey = undefined;
    this.sessionPromise = undefined;
    return this.rpc("release_session_key", [key]);
  }

  async call(method: string, params: JsonValue[] = []): Promise<JsonValue> {
    if (method === "get_session_key") return this.openSession();
    if (method === "release_session_key") return this.releaseSession();

    let key = await this.getSessionKey();
    let result = await this.rpc(method, [key, ...params]);
    if (
      errorCode(result) === "ERR_INVALID_SESSION"
      || statusMessage(result) === "Invalid session key"
      // set_quota_properties reports an expired key as {success: false, message: "Invalid session key"}.
      || (isObject(result) && result.success === false && result.message === "Invalid session key")
    ) {
      this.sessionKey = undefined;
      this.sessionPromise = undefined;
      key = await this.getSessionKey();
      result = await this.rpc(method, [key, ...params]);
    }
    // An empty list is not an error: LimeSurvey answers it with a status text instead of an array.
    if (isEmptyListAnswer(method, result)) return [];
    this.throwForApiError(method, params, result);
    return result;
  }

  private async getSessionKey(): Promise<string> {
    if (this.sessionKey) return this.sessionKey;
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession().finally(() => {
        this.sessionPromise = undefined;
      });
    }
    return this.sessionPromise;
  }

  private async createSession(): Promise<string> {
    const result = await this.rpc("get_session_key", [
      this.config.username,
      this.config.password,
      this.config.authPlugin,
    ]);
    this.throwForApiError("get_session_key", [], result);
    if (typeof result !== "string" || result.length === 0) {
      throw new LimeSurveyError(
        "LimeSurvey did not return a session key. Verify the URL, credentials, auth plugin, and that JSON-RPC is enabled.",
      );
    }
    this.sessionKey = result;
    return result;
  }

  private async rpc(method: string, params: JsonValue[]): Promise<JsonValue> {
    const request: JsonRpcRequest = { method, params, id: ++this.requestId };
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new LimeSurveyError(`Could not reach LimeSurvey for ${method}: ${reason}`);
    }

    const parsedDate = Date.parse(response.headers.get("date") ?? "");
    this.serverDate = Number.isNaN(parsedDate) ? undefined : new Date(parsedDate);

    if (!response.ok) {
      throw new LimeSurveyError(
        `LimeSurvey HTTP request for ${method} failed with ${response.status} ${response.statusText}.`,
      );
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await response.json()) as JsonRpcResponse;
    } catch {
      throw new LimeSurveyError(
        `LimeSurvey returned a non-JSON response for ${method}. Confirm that the RemoteControl endpoint and JSON-RPC interface are enabled.`,
      );
    }

    if (payload.id !== request.id) {
      throw new LimeSurveyError(`LimeSurvey returned an unexpected JSON-RPC response id for ${method}.`);
    }
    if (payload.error !== undefined && payload.error !== null) {
      throw new LimeSurveyError(`LimeSurvey JSON-RPC error while calling ${method}.`, undefined, payload.error);
    }
    if (payload.result === undefined) {
      throw new LimeSurveyError(`LimeSurvey returned no result for ${method}.`);
    }
    return payload.result;
  }

  private throwForApiError(method: string, params: JsonValue[], result: JsonValue): void {
    const code = errorCode(result);
    if (!hasApiError(result)) return;
    const message = statusMessage(result) ?? structuredErrorMessage(result) ?? "Unknown LimeSurvey error";
    const hints = interpretNoData(method, params, statusMessage(result), code);
    throw new LimeSurveyError(`${method} failed: ${message}`, code, result, hints);
  }
}

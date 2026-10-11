import type { WriteScope, WriteScopeSource } from "./write-scope.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  id: number;
  method: string;
  params: JsonValue[];
}

export interface JsonRpcResponse {
  id: number | string | null;
  result?: JsonValue;
  error?: JsonValue;
}

export interface LimeSurveyConfig {
  url: URL;
  username: string;
  password: string;
  authPlugin: string;
  timeoutMs: number;
  maxResponseChars: number;
  readOnly?: boolean;
  writeScope?: WriteScope;
  writeScopeSource?: WriteScopeSource;
  writeScopeWarning?: string;
  enableExperimentalMethods?: boolean;
  exportDir?: string;
  maxExportBytes?: number;
  importDir?: string;
  maxImportBytes?: number;
  themeDir?: string;
  maxThemeAssetBytes?: number;
  transport?: "stdio" | "http";
  httpHost?: string;
  httpPort?: number;
  httpPath?: string;
  httpBearerToken?: string;
  httpAllowedHosts?: string[];
  httpAllowedOrigins?: string[];
}

export interface LimeSurveyToolResult {
  [key: string]: unknown;
  method: string;
  result: JsonValue;
  truncated?: boolean;
  truncation_message?: string;
  warnings?: JsonValue[];
}

/** Machine-readable interpretation attached to an error: what happened, why, and how to get around it. */
export interface ErrorHints {
  hint_code: string;
  hint: string;
  writable_fields?: string[];
}

export class LimeSurveyError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: JsonValue,
    public readonly hints?: ErrorHints,
  ) {
    super(message);
    this.name = "LimeSurveyError";
  }
}

/**
 * The error object every tool returns on failure: message, code, details and, when the error carries
 * an interpretation, hint_code/hint/writable_fields on the top level next to them.
 */
export function describeError(error: unknown): {
  message: string;
  code?: string;
  details?: JsonValue;
  hint_code?: string;
  hint?: string;
  writable_fields?: string[];
} {
  if (error instanceof LimeSurveyError) {
    return {
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.hints ? error.hints : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

import { readFileSync, statSync } from "node:fs";
import { LimeSurveyError, type LimeSurveyConfig } from "./types.js";
import { WRITE_SCOPES, type WriteScope, type WriteScopeSource } from "./write-scope.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new LimeSurveyError(`Missing required environment variable ${name}.`);
  }
  return value;
}

/**
 * Reads LIMESURVEY_PASSWORD_FILE. Messages name the variable and the path, never the content. Only a UTF-8 BOM and
 * trailing line endings are removed; everything else, including blanks at the edges, belongs to the password.
 */
function readPasswordFile(file: string): { password: string; warnings: string[] } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? ` (${String(error.code)})` : "";
    throw new LimeSurveyError(`LIMESURVEY_PASSWORD_FILE could not be read${code}: ${file}`);
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new LimeSurveyError(
      `LIMESURVEY_PASSWORD_FILE ${file} is encoded as UTF-16 (byte order mark FF FE or FE FF). That is what Windows `
        + 'PowerShell 5.1 writes for ">" and Out-File. Write the file again as UTF-8 without BOM, for example in '
        + "PowerShell 7: [IO.File]::WriteAllText(<path>, <password>, [Text.UTF8Encoding]::new($false)).",
    );
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LimeSurveyError(`LIMESURVEY_PASSWORD_FILE ${file} is not valid UTF-8. Save it as UTF-8 without BOM.`);
  }
  const password = content.replace(/[\r\n]+$/, "");
  if (password === "") throw new LimeSurveyError(`LIMESURVEY_PASSWORD_FILE ${file} is empty.`);

  const warnings: string[] = [];
  if (process.platform !== "win32") {
    try {
      const mode = statSync(file).mode;
      if ((mode & 0o077) !== 0) {
        warnings.push(
          `LIMESURVEY_PASSWORD_FILE ${file} is readable by group or others (mode ${(mode & 0o777).toString(8)}). `
            + `Restrict it with: chmod 600 ${file}`,
        );
      }
    } catch {
      // The content was readable; a failing stat only means no permission warning.
    }
  }
  return { password, warnings };
}

function resolvePassword(env: NodeJS.ProcessEnv): {
  password: string;
  source: "file" | "env";
  warnings: string[];
} {
  const file = env.LIMESURVEY_PASSWORD_FILE?.trim();
  const inline = env.LIMESURVEY_PASSWORD?.trim();
  if (file) {
    const read = readPasswordFile(file);
    const warnings = [...read.warnings];
    if (inline) {
      warnings.unshift(
        "Both LIMESURVEY_PASSWORD_FILE and LIMESURVEY_PASSWORD are set; the file wins and LIMESURVEY_PASSWORD is "
          + "ignored. Remove LIMESURVEY_PASSWORD from the MCP client configuration.",
      );
    }
    return { password: read.password, source: "file", warnings };
  }
  if (!inline) throw new LimeSurveyError("Missing LIMESURVEY_PASSWORD or LIMESURVEY_PASSWORD_FILE.");
  return { password: inline, source: "env", warnings: [] };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LimeSurveyError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new LimeSurveyError(`${name} must be true or false.`);
}

function writeScopeValue(value: string | undefined): WriteScope | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  const scope = WRITE_SCOPES.find((candidate) => candidate === trimmed);
  if (!scope) {
    throw new LimeSurveyError(`LIMESURVEY_WRITE_SCOPE must be one of ${WRITE_SCOPES.join(", ")}.`);
  }
  return scope;
}

/** Combines the legacy read-only switch and the write scope; the stricter level wins. */
function resolveScope(
  readOnly: boolean,
  requested: WriteScope | undefined,
): { scope: WriteScope; source: WriteScopeSource } {
  if (requested === undefined) {
    return readOnly ? { scope: "none", source: "LIMESURVEY_READ_ONLY" } : { scope: "outreach", source: "default" };
  }
  if (readOnly && requested !== "none") return { scope: "none", source: "LIMESURVEY_READ_ONLY" };
  return { scope: requested, source: "LIMESURVEY_WRITE_SCOPE" };
}

function commaSeparated(value: string | undefined): string[] | undefined {
  const values = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return values && values.length > 0 ? values : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LimeSurveyConfig {
  const rawUrl = required(env, "LIMESURVEY_URL");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LimeSurveyError("LIMESURVEY_URL must be a valid absolute URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LimeSurveyError("LIMESURVEY_URL must use HTTP or HTTPS.");
  }
  const allowInsecure = env.LIMESURVEY_ALLOW_INSECURE_HTTP?.toLowerCase() === "true";
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
  if (url.protocol === "http:" && !allowInsecure && !localHostnames.has(url.hostname)) {
    throw new LimeSurveyError(
      "Plain HTTP is disabled. Use HTTPS or set LIMESURVEY_ALLOW_INSECURE_HTTP=true for a trusted development instance.",
    );
  }

  const transport = (env.MCP_TRANSPORT?.trim().toLowerCase() || "stdio") as "stdio" | "http";
  if (transport !== "stdio" && transport !== "http") {
    throw new LimeSurveyError("MCP_TRANSPORT must be stdio or http.");
  }
  const httpHost = env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const bearerToken = env.MCP_HTTP_BEARER_TOKEN?.trim();
  if (transport === "http" && !localHostnames.has(httpHost) && !bearerToken) {
    throw new LimeSurveyError(
      "MCP_HTTP_BEARER_TOKEN is required when MCP_HTTP_HOST is not a loopback address.",
    );
  }

  const rawReadOnly = env.LIMESURVEY_READ_ONLY ?? env.READONLY_MODE;
  const readOnly = booleanValue(rawReadOnly, false, "LIMESURVEY_READ_ONLY");
  const readOnlySet = rawReadOnly !== undefined && rawReadOnly.trim() !== "";
  const requestedScope = writeScopeValue(env.LIMESURVEY_WRITE_SCOPE);
  const effective = resolveScope(readOnly, requestedScope);

  url.hash = "";
  const username = required(env, "LIMESURVEY_USERNAME");
  const password = resolvePassword(env);
  const config: LimeSurveyConfig = {
    url,
    username,
    password: password.password,
    passwordSource: password.source,
    authPlugin: env.LIMESURVEY_AUTH_PLUGIN?.trim() || "Authdb",
    timeoutMs: positiveInteger(env.LIMESURVEY_TIMEOUT_MS, 30_000, "LIMESURVEY_TIMEOUT_MS"),
    maxResponseChars: positiveInteger(
      env.LIMESURVEY_MAX_RESPONSE_CHARS,
      50_000,
      "LIMESURVEY_MAX_RESPONSE_CHARS",
    ),
    readOnly: effective.scope === "none",
    writeScope: effective.scope,
    writeScopeSource: effective.source,
    enableExperimentalMethods: booleanValue(
      env.LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS,
      false,
      "LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS",
    ),
    maxExportBytes: positiveInteger(
      env.LIMESURVEY_MAX_EXPORT_BYTES,
      100 * 1024 * 1024,
      "LIMESURVEY_MAX_EXPORT_BYTES",
    ),
    maxImportBytes: positiveInteger(
      env.LIMESURVEY_MAX_IMPORT_BYTES,
      50 * 1024 * 1024,
      "LIMESURVEY_MAX_IMPORT_BYTES",
    ),
    maxThemeAssetBytes: positiveInteger(
      env.LIMESURVEY_MAX_THEME_ASSET_BYTES,
      5 * 1024 * 1024,
      "LIMESURVEY_MAX_THEME_ASSET_BYTES",
    ),
    transport,
    httpHost,
    httpPort: positiveInteger(env.MCP_HTTP_PORT, 3000, "MCP_HTTP_PORT"),
    httpPath: env.MCP_HTTP_PATH?.trim() || "/mcp",
  };
  const exportDir = env.LIMESURVEY_EXPORT_DIR?.trim();
  if (exportDir) config.exportDir = exportDir;
  const importDir = env.LIMESURVEY_IMPORT_DIR?.trim();
  if (importDir) config.importDir = importDir;
  const themeDir = env.LIMESURVEY_THEME_DIR?.trim();
  if (themeDir) config.themeDir = themeDir;
  if (readOnlySet && requestedScope !== undefined) {
    config.writeScopeWarning = `Both LIMESURVEY_READ_ONLY=${readOnly} and LIMESURVEY_WRITE_SCOPE=${requestedScope} are set; `
      + `the stricter one applies, so the effective write scope is "${effective.scope}" `
      + `(${effective.source}). Remove one of the two variables to avoid confusion.`;
  }
  if (password.warnings.length > 0) config.passwordWarnings = password.warnings;
  if (bearerToken) config.httpBearerToken = bearerToken;
  const allowedHosts = commaSeparated(env.MCP_HTTP_ALLOWED_HOSTS);
  if (allowedHosts) config.httpAllowedHosts = allowedHosts;
  const allowedOrigins = commaSeparated(env.MCP_HTTP_ALLOWED_ORIGINS);
  if (allowedOrigins) config.httpAllowedOrigins = allowedOrigins;
  return config;
}

const RESTART_HINT = "Environment changes require a full Claude Code restart; reconnecting the MCP server does not "
  + "reload environment variables.";

/**
 * Startup preflight (ISSUE-003/CAP-03): reports which optional directories are missing and what that
 * disables, before any tool call fails at runtime. Callers print these (index.ts writes them to stderr).
 */
export function envPreflightWarnings(config: LimeSurveyConfig): string[] {
  const warnings: string[] = [];
  if (config.writeScopeWarning) warnings.push(config.writeScopeWarning);
  warnings.push(...(config.passwordWarnings ?? []));
  if (!config.exportDir) {
    warnings.push(
      "LIMESURVEY_EXPORT_DIR is not set: file-export tools (export_responses_to_file, "
        + `export_statistics_to_file, export_survey_to_file, ...) are disabled until it is configured. ${RESTART_HINT}`,
    );
  }
  if (!config.importDir && !config.exportDir) {
    warnings.push(
      "LIMESURVEY_IMPORT_DIR is not set (and LIMESURVEY_EXPORT_DIR is not set as a fallback): "
        + `import_data_path is disabled for import_survey/import_group/import_question until one of them is `
        + `configured. ${RESTART_HINT}`,
    );
  }
  if (!config.themeDir) {
    warnings.push(
      "LIMESURVEY_THEME_DIR is not set: theme generation, validation, and packaging tools are disabled until "
        + `it is configured. ${RESTART_HINT}`,
    );
  }
  return warnings;
}

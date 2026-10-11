import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { enrichLanguageProperties, languagePropertiesWarnings } from "./attachments.js";
import type { LimeSurveyClient } from "./client.js";
import { strictInput } from "./input-schema.js";
import { previewInvitation } from "./participant-checks.js";
import { describeWriteSpec, prepareWriteInput, writeWarnings } from "./rpc-hints.js";
import { LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";

export type ResponseFormat = "json" | "markdown";

export interface ParameterDefinition {
  key: string;
  schema: z.ZodTypeAny;
  defaultValue?: JsonValue;
}

export interface ToolDefinition {
  method: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  parameters: ParameterDefinition[];
  prepare?: (input: Record<string, unknown>, config: LimeSurveyConfig) => Promise<Record<string, unknown>>;
  /**
   * Runs after a successful RPC with the prepared input. Returns warnings to attach to the result, or throws a
   * LimeSurveyError to turn the answer into an error.
   */
  afterCall?: (result: JsonValue, input: Record<string, unknown>, client: LimeSurveyClient) => Promise<JsonValue[] | undefined>;
  /**
   * Runs after a successful RPC and returns the result to report (for example the answer plus derived fields).
   * afterCall still sees the unchanged RPC answer.
   */
  enrich?: (result: JsonValue, input: Record<string, unknown>) => JsonValue;
  /**
   * Runs after the write-scope check and prepare, before the RPC. A returned value is the tool result and the
   * RPC (and afterCall) is skipped; undefined continues with the RPC.
   */
  override?: (input: Record<string, unknown>, client: LimeSurveyClient, config: LimeSurveyConfig) => Promise<JsonValue | undefined>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: true;
  };
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
) as z.ZodType<JsonValue>;

const responseFormatSchema = z
  .enum(["json", "markdown"])
  .default("json")
  .describe("Output format. JSON preserves the complete structured result; Markdown is optimized for reading.");

const string = (description: string) => z.string().min(1).describe(description);
const optionalString = (description: string) => z.string().min(1).nullable().optional().describe(description);
const integer = (description: string) => z.number().int().nonnegative().describe(description);
const positiveInteger = (description: string) => z.number().int().positive().describe(description);
const optionalInteger = (description: string) => z.number().int().nonnegative().nullable().optional().describe(description);
const jsonObject = (description: string) => z.record(z.string(), jsonValueSchema).describe(description);
const stringArray = (description: string) => z.array(z.string()).describe(description);
const optionalStringArray = (description: string) => z.array(z.string()).nullable().optional().describe(description);

function p(key: string, schema: z.ZodTypeAny, defaultValue?: JsonValue): ParameterDefinition {
  return defaultValue === undefined ? { key, schema } : { key, schema, defaultValue };
}

function define(
  method: string,
  title: string,
  summary: string,
  access: "read" | "write" | "delete",
  parameters: ParameterDefinition[] = [],
  options: {
    prepare?: ToolDefinition["prepare"];
    afterCall?: ToolDefinition["afterCall"];
    enrich?: ToolDefinition["enrich"];
    override?: ToolDefinition["override"];
    extraSchema?: Record<string, z.ZodTypeAny>;
  } = {},
): ToolDefinition {
  const shape: Record<string, z.ZodTypeAny> = { response_format: responseFormatSchema };
  for (const parameter of parameters) shape[parameter.key] = parameter.schema;
  if (options.extraSchema) {
    for (const [key, schema] of Object.entries(options.extraSchema)) shape[key] = schema;
  }
  let confirmation = "";
  let dryRunPreview = false;
  if (access === "delete") {
    shape.confirm_destructive_action = z.literal(true).describe("Required acknowledgement of the permanent deletion.");
    confirmation = " Requires confirm_destructive_action=true.";
  } else if (method === "invite_participants") {
    // A dry run sends nothing, so only a real invitation needs the acknowledgement (checked below).
    shape.confirm_send_email = z.literal(true).optional().describe("Required acknowledgement that email may be sent to participants; not needed with dry_run=true.");
    confirmation = " Requires confirm_send_email=true unless dry_run=true.";
    dryRunPreview = true;
  } else if (["mail_registered_participants", "remind_participants"].includes(method)) {
    shape.confirm_send_email = z.literal(true).describe("Required acknowledgement that email may be sent to participants.");
    confirmation = " Requires confirm_send_email=true.";
  } else if (method === "activate_survey") {
    shape.confirm_activation = z.literal(true).describe("Required acknowledgement that survey activation changes its structure and behavior.");
    confirmation = " Requires confirm_activation=true.";
  }
  return {
    method,
    title,
    description: `${summary}${confirmation}\n\nCalls LimeSurvey RemoteControl method \`${method}\`. Authentication uses the configured service account; do not provide a session key.`,
    inputSchema: dryRunPreview
      ? strictInput(shape).superRefine((value, context) => {
        if (value.dry_run !== true && value.confirm_send_email !== true) {
          context.addIssue({
            code: "custom",
            path: ["confirm_send_email"],
            message: "confirm_send_email=true is required unless dry_run=true.",
          });
        }
      })
      : strictInput(shape),
    parameters,
    ...(options.prepare ? { prepare: options.prepare } : {}),
    ...(options.afterCall ? { afterCall: options.afterCall } : {}),
    ...(options.enrich ? { enrich: options.enrich } : {}),
    ...(options.override ? { override: options.override } : {}),
    annotations: {
      readOnlyHint: access === "read",
      destructiveHint: access === "delete",
      idempotentHint: access === "read",
      openWorldHint: true,
    },
  };
}

const surveyId = () => p("survey_id", positiveInteger("Numeric LimeSurvey survey ID."));
const groupId = () => p("group_id", positiveInteger("Numeric question-group ID."));
const questionId = () => p("question_id", positiveInteger("Numeric question ID."));
const language = (key = "language") => p(key, optionalString("LimeSurvey language code; null uses the survey default."), null);
const propertyNames = (key: string, resource: string) =>
  p(key, optionalStringArray(`Properties to return for the ${resource}; null returns all available properties.`), null);

/** prepare/afterCall pair for the six set_*_properties tools (write hints, L10n routing, dropped-key warnings). */
function writeChecks(method: string): Pick<NonNullable<Parameters<typeof define>[5]>, "prepare" | "afterCall"> {
  return {
    prepare: (input) => prepareWriteInput(method, input),
    afterCall: async (result, input) => writeWarnings(method, result, input),
  };
}

const surveyIdCheckSchema = (resource: string) =>
  z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Optional survey ID the ${resource} is expected to belong to. MCP-only: it is never sent to LimeSurvey; the server ` +
        `compares it with the sid of the result (reading sid with one extra request when the result has none) and fails ` +
        `with a *_SURVEY_MISMATCH error when they differ.`,
    );

/**
 * afterCall hook for get_group_properties and get_question_properties: neither RPC takes a survey ID, so a wrong
 * ID silently reads another survey's object. When survey_id is given, compare it with the object's sid.
 */
function surveyIdCrossCheck(
  method: "get_group_properties" | "get_question_properties",
  idKey: "group_id" | "question_id",
  mismatchCode: "GROUP_SURVEY_MISMATCH" | "QUESTION_SURVEY_MISMATCH",
  label: string,
): NonNullable<ToolDefinition["afterCall"]> {
  return async (result, input, client) => {
    const expected = input.survey_id;
    if (typeof expected !== "number") return undefined;
    const sidOf = (value: JsonValue): JsonValue | undefined =>
      value !== null && typeof value === "object" && !Array.isArray(value) ? value.sid : undefined;
    let actual = sidOf(result);
    if (actual === undefined || actual === null) {
      actual = sidOf(await client.call(method, [input[idKey] as JsonValue, ["sid"]]));
    }
    if (actual === undefined || actual === null || String(actual).trim() === "") {
      return [{
        hint_code: "SURVEY_ID_NOT_VERIFIED",
        hint: `LimeSurvey returned no sid for this ${label}, so survey_id=${expected} could not be verified.`,
      }];
    }
    if (Number(actual) !== expected) {
      throw new LimeSurveyError(
        `The ${label} ${String(input[idKey])} belongs to survey ${String(actual)}, not to survey ${expected}.`,
        mismatchCode,
        { [idKey]: input[idKey] as JsonValue, expected_survey_id: expected, actual_survey_id: actual },
        {
          hint_code: mismatchCode,
          hint: `${label === "group" ? "Group" : "Question"} ${String(input[idKey])} is in survey ${String(actual)}, but survey_id=${expected} was expected. ` +
            `The result was discarded; look up the correct ${idKey} with limesurvey_list_${label === "group" ? "groups" : "questions"} for survey ${expected}.`,
        },
      );
    }
    return undefined;
  };
}

export const serverUtcOffsetSchema = z
  .number()
  .int()
  .min(-14 * 60)
  .max(14 * 60)
  .optional()
  .describe(
    "MCP-only, never sent to LimeSurvey. UTC offset of the LimeSurvey server's local time in minutes (for example 120 " +
      "for UTC+2). validfrom and validuntil are stored without a zone in that local time; without this value the " +
      "timezone of the MCP host is assumed (reported as time_basis.offset_source).",
  );

const maxInlineImportChars = 200_000;

const importDataPathSchema = (resource: string) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      `Local file path to a ${resource} file. The server reads and base64-encodes it, so use this instead of inline ` +
        `import_data for files at or above roughly 50 KB. The file must live inside LIMESURVEY_IMPORT_DIR (or ` +
        `LIMESURVEY_EXPORT_DIR as a fallback). Exactly one of import_data or import_data_path must be set.`,
    );

/**
 * Shared prepare() hook for import_survey, import_group, and import_question: resolves the
 * MCP-only import_data_path into an inline base64 import_data before buildRpcParams runs.
 */
async function prepareImportData(
  input: Record<string, unknown>,
  config: LimeSurveyConfig,
): Promise<Record<string, unknown>> {
  const importData = input.import_data;
  const importDataPath = input.import_data_path;
  const hasData = typeof importData === "string";
  const hasPath = typeof importDataPath === "string";
  if (hasData === hasPath) {
    throw new LimeSurveyError(
      "Exactly one of import_data or import_data_path must be provided.",
      "IMPORT_PARAM_CONFLICT",
      { recovery: "Set import_data for a small inline base64 payload, or import_data_path for a local file; never both or neither." },
    );
  }

  if (hasData) {
    if (importData.length > maxInlineImportChars) {
      throw new LimeSurveyError(
        `import_data is ${importData.length} characters, which is too large to inline.`,
        "IMPORT_PAYLOAD_TOO_LARGE",
        { recovery: "Use import_data_path with a local file inside LIMESURVEY_IMPORT_DIR instead of inline base64." },
      );
    }
    return input;
  }

  if (typeof importDataPath !== "string") {
    // Unreachable: the hasData === hasPath check above guarantees a string here.
    throw new LimeSurveyError(
      "Exactly one of import_data or import_data_path must be provided.",
      "IMPORT_PARAM_CONFLICT",
    );
  }

  const buffer = await readImportFile(config, importDataPath);
  const { import_data_path: _omit, ...rest } = input;
  return { ...rest, import_data: buffer.toString("base64") };
}

/**
 * Reads a file from LIMESURVEY_IMPORT_DIR (fallback LIMESURVEY_EXPORT_DIR). The path must stay inside that
 * directory and the file must not exceed LIMESURVEY_MAX_IMPORT_BYTES. Shared by the import tools and
 * verify_survey_against_lss; every failure happens before any RPC.
 */
export async function readImportFile(
  config: LimeSurveyConfig,
  relativePath: string,
  parameter = "import_data_path",
): Promise<Buffer> {
  const importDir = config.importDir ?? config.exportDir;
  if (!importDir) {
    throw new LimeSurveyError(
      "No import directory is configured.",
      "IMPORT_DIR_NOT_CONFIGURED",
      {
        recovery:
          "Set LIMESURVEY_IMPORT_DIR (or LIMESURVEY_EXPORT_DIR as a fallback) and fully restart Claude Code; " +
          "reconnecting the MCP server alone does not reload environment variables.",
      },
    );
  }

  const root = path.resolve(importDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LimeSurveyError(
      `${parameter} resolves outside the configured import directory.`,
      "IMPORT_PATH_OUTSIDE_DIR",
      { recovery: `Use a path inside ${root}.` },
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(target);
  } catch {
    throw new LimeSurveyError(
      "The import file was not found or could not be read.",
      "IMPORT_FILE_NOT_FOUND",
      { recovery: `Verify that ${target} exists and is readable by the server process.` },
    );
  }

  const maxBytes = config.maxImportBytes ?? 50 * 1024 * 1024;
  if (buffer.byteLength > maxBytes) {
    throw new LimeSurveyError(
      `The import file is ${buffer.byteLength} bytes, which exceeds the configured limit.`,
      "IMPORT_FILE_TOO_LARGE",
      { recovery: `Limit is ${maxBytes} bytes (LIMESURVEY_MAX_IMPORT_BYTES). Reduce the file size or raise the limit.` },
    );
  }
  return buffer;
}

export const toolDefinitions: ToolDefinition[] = [
  define("get_session_key", "Connect to LimeSurvey", "Open and cache an authenticated RemoteControl session without exposing its key.", "write"),
  define("release_session_key", "Disconnect from LimeSurvey", "Release the cached RemoteControl session.", "write"),
  define("get_available_site_settings", "List available site settings", "List global setting names available to a super administrator.", "read"),
  define("get_site_settings", "Get site setting", "Read one global LimeSurvey setting.", "read", [p("setting_name", string("Global setting name."))]),

  define("add_survey", "Create survey", "Create an empty survey with minimum settings.", "write", [
    p("survey_id", integer("Desired survey ID. Use 0 to let LimeSurvey choose.")),
    p("title", string("Title of the new survey.")),
    p("language", string("Base language code for the survey.")),
    p("format", z.enum(["A", "G", "S"]).optional().describe("Question display format: all, group-by-group, or single question."), "G"),
  ]),
  define("delete_survey", "Delete survey", "Permanently delete a survey.", "delete", [surveyId()]),
  define(
    "import_survey",
    "Import survey",
    "Import an LSA, CSV, TXT, or LSS survey. Use import_data_path for files at or above roughly 50 KB so the " +
      "server reads and base64-encodes them itself; reserve inline import_data for small files under 200,000 " +
      "characters of base64 text. The returned sid is the survey ID LimeSurvey actually used: it keeps the ID " +
      "embedded in the file when that ID is free, destination_survey_id overrides it when set, and on an ID " +
      "collision LimeSurvey silently assigns a random 6-digit sid instead of failing (verified against the " +
      "LimeSurvey XMLImportSurvey/insertNewSurvey source).",
    "write",
    [
      p("import_data", string("Base64-encoded survey file contents; omit when using import_data_path.").optional()),
      p("import_data_type", z.enum(["lsa", "csv", "txt", "lss"]).describe("Import file type.")),
      p("new_survey_name", optionalString("Optional replacement survey name."), null),
      p("destination_survey_id", optionalInteger("Optional desired ID for the imported survey."), null),
    ],
    { prepare: prepareImportData, extraSchema: { import_data_path: importDataPathSchema("survey") } },
  ),
  define("copy_survey", "Copy survey", "Copy an existing survey under a new name.", "write", [
    p("source_survey_id", positiveInteger("ID of the survey to copy.")),
    p("new_name", string("Name for the copied survey.")),
    p("destination_survey_id", optionalInteger("Optional desired ID for the copy."), null),
  ]),
  define(
    "get_survey_properties",
    "Get survey properties",
    "Read selected survey properties (any column of the surveys table; unknown names are dropped silently). " +
      "usetokens is only a stored column in LimeSurvey 6.17.11: the core never evaluates it, so it neither tells " +
      "whether a participant table exists nor whether the survey is closed. Closed access follows access_mode " +
      "(\"C\" closed, \"O\" open) and the participant table; use limesurvey_get_participant_table_status for a " +
      "ready-made answer. Verified against the LimeSurvey 6.17.11 source; older releases may differ.",
    "read",
    [surveyId(), propertyNames("properties", "survey")],
  ),
  define("set_survey_properties", "Set survey properties", `Update editable survey properties.${describeWriteSpec("set_survey_properties")}`, "write", [surveyId(), p("data", jsonObject("Survey property names mapped to new values."))], writeChecks("set_survey_properties")),
  define("activate_survey", "Activate survey", "Activate a survey after LimeSurvey consistency checks.", "write", [
    surveyId(),
    p("activation_settings", jsonObject("Optional activation settings such as anonymized, datestamp, ipaddr, ipanonymize, refurl, and savetimings.").optional(), {}),
  ]),
  define("export_statistics", "Export survey statistics", "Export survey statistics as a base64-encoded PDF, XLS, or HTML document.", "read", [
    surveyId(),
    p("document_type", z.enum(["pdf", "xls", "html"]).optional().describe("Statistics document type."), "pdf"),
    language(),
    p("include_graphs", z.enum(["0", "1"]).optional().describe("Whether to include graphs."), "0"),
    p("group_ids", z.union([positiveInteger("One group ID."), z.array(z.number().int().positive())]).nullable().optional().describe("Optional group ID or list of group IDs."), null),
  ]),
  define("export_timeline", "Export response timeline", "Return response counts by day or hour for a date range.", "read", [
    surveyId(),
    p("period", z.enum(["day", "hour"]).describe("Timeline aggregation period.")),
    p("start", string("Start date/time accepted by LimeSurvey.")),
    p("end", string("End date/time accepted by LimeSurvey.")),
  ]),
  define("get_summary", "Get survey summary", "Read response and participant summary counters. The answer \"No available data\" " +
    "is not a call error: for token_* statistics it means the survey has no participant table (no participant statistics; error hint_code " +
    "NO_PARTICIPANT_TABLE; access is decided by access_mode, check limesurvey_get_participant_table_status), for response " +
    "statistics it means the survey has no response table: never activated or deactivated (hint_code NO_RESPONSE_TABLE). With statistic=all only the available parts are returned.", "read", [
    surveyId(),
    p("statistic", z.enum(["all", "completed_responses", "incomplete_responses", "full_responses", "token_count", "token_invalid", "token_sent", "token_opted_out", "token_completed", "token_screenout"]).optional().describe("Summary statistic to return."), "all"),
  ]),

  define("add_language", "Add survey language", "Add a language to a survey.", "write", [surveyId(), p("language", string("Language code to add."))]),
  define("delete_language", "Delete survey language", "Remove a non-base language from a survey.", "delete", [surveyId(), p("language", string("Language code to remove."))]),
  define(
    "get_language_properties",
    "Get language properties",
    "Read localized survey properties. The attachments field is returned exactly as LimeSurvey stores it (a JSON " +
      "string since DB version 647, a PHP serialize string on older instances; keep it unchanged for a round trip " +
      "to set_language_properties). When it is part of the answer, attachments_parsed is added: { <mail type>: " +
      "[ { file_name, url, size, relevance } ] } with the mail types invitation, reminder, registration, " +
      "confirmation, admin_notification and admin_detailed_notification; an empty value gives {} and an " +
      "unparsable one gives null plus a warning. LimeSurvey drops requested property names that are not a column " +
      "of the survey language settings without saying so: such names are listed in the warning unknown_fields " +
      "(if every name is unknown the call fails with the no-data hint). An unknown or missing language silently " +
      "falls back to the base language. RemoteControl has no method that lists the uploaded survey files " +
      "themselves; attachments only references them by server path.",
    "read",
    [surveyId(), propertyNames("properties", "survey language"), language()],
    {
      enrich: (result) => enrichLanguageProperties(result),
      afterCall: async (result, input) => languagePropertiesWarnings(result, input),
    },
  ),
  define("set_language_properties", "Set language properties", `Update localized survey properties.${describeWriteSpec("set_language_properties")}`, "write", [surveyId(), p("data", jsonObject("Localized property names mapped to new values.")), language()], writeChecks("set_language_properties")),

  define("add_group", "Create question group", "Add an empty question group to a survey.", "write", [surveyId(), p("title", string("Question-group title.")), p("description", z.string().optional().describe("Question-group description."), "")]),
  define("delete_group", "Delete question group", "Delete a question group from a survey.", "delete", [surveyId(), groupId()]),
  define(
    "import_group",
    "Import question group",
    "Import a question group into a survey. Use import_data_path for files at or above roughly 50 KB instead of " +
      "inline import_data.",
    "write",
    [
      surveyId(),
      p("import_data", string("Base64-encoded group file contents; omit when using import_data_path.").optional()),
      p("import_data_type", string("Import type supported by the LimeSurvey instance, normally lsg.")),
      p("new_group_name", optionalString("Optional replacement group name."), null),
      p("new_group_description", optionalString("Optional replacement group description."), null),
    ],
    { prepare: prepareImportData, extraSchema: { import_data_path: importDataPathSchema("question group") } },
  ),
  define(
    "get_group_properties",
    "Get group properties",
    "Read selected question-group properties. LimeSurvey identifies the group by group_id alone, so a wrong ID reads " +
      "another survey's group. Pass the optional survey_id to cross-check: the result's sid must match, otherwise the " +
      "call fails with GROUP_SURVEY_MISMATCH (survey_id is never sent to LimeSurvey).",
    "read",
    [groupId(), propertyNames("properties", "question group"), language()],
    {
      extraSchema: { survey_id: surveyIdCheckSchema("group") },
      afterCall: surveyIdCrossCheck("get_group_properties", "group_id", "GROUP_SURVEY_MISMATCH", "group"),
    },
  ),
  define("set_group_properties", "Set group properties", `Update question-group properties.${describeWriteSpec("set_group_properties")}`, "write", [groupId(), p("data", jsonObject("Group property names mapped to new values."))], writeChecks("set_group_properties")),

  define("delete_question", "Delete question", "Delete a question from its survey.", "delete", [questionId()]),
  define(
    "import_question",
    "Import question",
    "Import a question into a survey group. Use import_data_path for files at or above roughly 50 KB instead of " +
      "inline import_data.",
    "write",
    [
      surveyId(), groupId(),
      p("import_data", string("Base64-encoded question file contents; omit when using import_data_path.").optional()),
      p("import_data_type", string("Import type supported by the LimeSurvey instance, normally lsq.")),
      p("mandatory", z.enum(["Y", "N"]).optional().describe("Whether the imported question is mandatory."), "N"),
      p("new_question_title", optionalString("Optional replacement question code/title."), null),
      p("new_question_text", optionalString("Optional replacement question text."), null),
      p("new_question_help", optionalString("Optional replacement help text."), null),
    ],
    { prepare: prepareImportData, extraSchema: { import_data_path: importDataPathSchema("question") } },
  ),
  define(
    "get_question_properties",
    "Get question properties",
    "Read selected question properties. LimeSurvey identifies the question by question_id alone, so a wrong ID reads " +
      "another survey's question. Pass the optional survey_id to cross-check: the result's sid must match, otherwise the " +
      "call fails with QUESTION_SURVEY_MISMATCH (survey_id is never sent to LimeSurvey).",
    "read",
    [questionId(), propertyNames("properties", "question"), language()],
    {
      extraSchema: { survey_id: surveyIdCheckSchema("question") },
      afterCall: surveyIdCrossCheck("get_question_properties", "question_id", "QUESTION_SURVEY_MISMATCH", "question"),
    },
  ),
  define("set_question_properties", "Set question properties", `Update question properties.${describeWriteSpec("set_question_properties")}`, "write", [questionId(), p("data", jsonObject("Question property names mapped to new values.")), language()], writeChecks("set_question_properties")),

  define("activate_tokens", "Activate participant table", "Create the survey participant table and optional custom attributes.", "write", [surveyId(), p("attribute_fields", z.array(z.number().int().positive()).optional().describe("Additional participant attribute field numbers."), [])]),
  define("add_participants", "Add survey participants", "Add one or more participants to a survey.", "write", [
    surveyId(),
    p("participants", z.array(jsonObject("Participant data.")).min(1).describe("Participant records.")),
    p("create_token", z.boolean().optional().describe("Generate missing participant tokens."), true),
  ]),
  define("delete_participants", "Delete survey participants", "Delete participants by token-table row IDs.", "delete", [surveyId(), p("token_ids", z.array(z.number().int().positive()).min(1).describe("Participant token-table row IDs."))]),
  define("get_participant_properties", "Get participant properties", "Read selected properties for a participant matched by token or token-table ID.", "read", [
    surveyId(),
    p("query", jsonObject("Participant lookup properties, such as token or tid.")),
    propertyNames("properties", "participant"),
  ]),
  define("set_participant_properties", "Set participant properties", `Update a participant matched by token or token-table ID.${describeWriteSpec("set_participant_properties")}`, "write", [surveyId(), p("query", jsonObject("Participant lookup properties.")), p("data", jsonObject("Participant properties to update."))], writeChecks("set_participant_properties")),
  define("list_participants", "List survey participants", "List and filter survey participants with server-side pagination.", "read", [
    surveyId(),
    p("start", z.number().int().nonnegative().optional().describe("Lower bound for the participant row ID (tid): LimeSurvey returns rows with tid >= start, ordered by tid. It is not a row offset; page with the last tid + 1."), 0),
    p("limit", z.number().int().min(1).max(1000).optional().describe("Maximum participants to return."), 10),
    p("unused", z.boolean().optional().describe("Return only unused participants."), false),
    p("attributes", z.union([z.literal(false), stringArray("Participant fields to return.")]).optional().describe("Fields to return, or false for defaults."), false),
    p("conditions", z.union([jsonObject("Participant filter conditions."), z.array(jsonValueSchema)]).optional().describe("Participant filter conditions as an object or positional condition list."), {}),
  ]),
  define("mail_registered_participants", "Email registered participants", "Send registration emails to survey participants.", "write", [surveyId(), p("override_conditions", z.union([jsonObject("Email selection/override conditions."), z.array(jsonValueSchema)]).optional().describe("Replacement email conditions as an object or positional condition list."), {})]),
  define(
    "invite_participants",
    "Invite survey participants",
    "Send survey invitation emails to selected or eligible participants. Preview first with dry_run=true: it sends " +
      "nothing and never calls invite_participants, it simulates the selection from the participant list and reports " +
      "would_receive and would_not_receive with a reason for every participant who is skipped (completed, " +
      "already_invited, emailstatus_not_ok, invalid_email_address, not_valid_yet, expired, ...). Without " +
      "continue_on_error LimeSurvey stops at the first participant whose validity window fails; the preview names " +
      "that participant as stops_at_tid. The report stays within LIMESURVEY_MAX_RESPONSE_CHARS regardless of the " +
      "table size: unselected participants (token_ids) are only counted as not_selected, and would_receive, " +
      "would_not_receive and not_reached list at most 100 entries each (truncated_lists says which were cut, " +
      "counts hold the full numbers). send_email=false is NOT a dry run: it resends the invitation to those who " +
      "were already invited. Verified against the LimeSurvey 6.17.11 source; older releases may differ.",
    "write",
    [
      surveyId(),
      p("token_ids", z.array(z.number().int().positive()).nullable().optional().describe("Optional participant row IDs; null (or an empty list) selects eligible participants."), null),
      p("send_email", z.boolean().optional().describe(
        "Which participants get an email. true (default): invite only participants who were not invited yet (sent = N " +
          "or empty). false: resend the invitation ONLY to participants who are already invited (sent holds a date) - " +
          "it does not turn the sending off. Emails are sent in both cases. To see who would be mailed without " +
          "sending, use dry_run=true.",
      ), true),
      p("continue_on_error", z.boolean().optional().describe("Continue after a participant whose validity window (validfrom/validuntil) fails; by default LimeSurvey stops at the first one."), false),
    ],
    {
      override: async (input, client) => (input.dry_run === true ? previewInvitation(input, client) : undefined),
      extraSchema: {
        dry_run: z.boolean().default(false).describe(
          "MCP-only, never sent to LimeSurvey. true: send nothing and do not call invite_participants; read the " +
            "participants (list_participants) and report who would receive an invitation and why the others would not. " +
            "Allowed under every write scope; confirm_send_email is not needed.",
        ),
        server_utc_offset_minutes: serverUtcOffsetSchema,
      },
    },
  ),
  define("remind_participants", "Remind survey participants", "Send reminder emails to selected or eligible participants.", "write", [
    surveyId(),
    p("minimum_days_between", optionalInteger("Minimum days since the previous reminder."), null),
    p("maximum_reminders", optionalInteger("Maximum reminders per participant."), null),
    p("token_ids", z.union([z.literal(false), z.array(z.number().int().positive())]).optional().describe("Participant row IDs, or false for eligible participants."), false),
    p("continue_on_error", z.boolean().optional().describe("Continue after individual email errors."), false),
  ]),

  define("list_groups", "List question groups", "List question groups in a survey.", "read", [surveyId(), language()]),
  define("list_questions", "List questions", "List questions and subquestions in a survey or group.", "read", [surveyId(), p("group_id", optionalInteger("Optional question-group ID."), null), language()]),
  define("list_quotas", "List quotas", "List quotas configured for a survey.", "read", [surveyId()]),
  define("add_quota", "Create quota", "Create a quota with minimum details.", "write", [
    surveyId(), p("name", string("Quota name.")), p("limit", z.number().int().positive().describe("Maximum responses allowed.")),
    p("active", z.boolean().optional().describe("Activate the quota immediately."), true),
    p("action", z.enum(["terminate", "confirm_terminate"]).optional().describe("Quota action."), "terminate"),
    p("autoload_url", z.boolean().optional().describe("Automatically load the quota URL."), false),
    p("message", z.string().optional().describe("Quota message."), ""),
    p("url", z.string().optional().describe("Quota redirect URL."), ""),
    p("url_description", z.string().optional().describe("Quota URL label."), ""),
  ]),
  define("delete_quota", "Delete quota", "Delete a survey quota.", "delete", [p("quota_id", positiveInteger("Numeric quota ID."))]),
  define("get_quota_properties", "Get quota properties", "Read selected quota properties.", "read", [p("quota_id", positiveInteger("Numeric quota ID.")), propertyNames("properties", "quota"), language()]),
  define("set_quota_properties", "Set quota properties", `Update quota properties.${describeWriteSpec("set_quota_properties")}`, "write", [p("quota_id", positiveInteger("Numeric quota ID.")), p("data", jsonObject("Quota properties to update."))], writeChecks("set_quota_properties")),

  define("list_surveys", "List surveys", "List surveys visible to a user, optionally filtered by survey group.", "read", [
    p("username", optionalString("Optional administration username; null uses the current service account."), null),
    p("survey_group_id", optionalInteger("Optional survey-group ID."), null),
  ]),
  define("list_survey_groups", "List survey groups", "List survey groups visible to a user.", "read", [p("username", optionalString("Optional administration username; null uses the current service account."), null)]),
  define("list_users", "List administration users", "List administration users, optionally filtered by ID or username.", "read", [
    p("user_id", optionalInteger("Optional administration user ID."), null),
    p("username", optionalString("Optional administration username."), null),
  ]),

  define("add_response", "Add survey response", "Insert a response into a survey response table.", "write", [surveyId(), p("response", jsonObject("Response fields mapped to values."))]),
  define("update_response", "Update survey response", "Update a response; include its response ID in the data.", "write", [surveyId(), p("response", jsonObject("Response fields, including the response ID, mapped to new values."))]),
  define("delete_response", "Delete survey response", "Permanently delete a response.", "delete", [surveyId(), p("response_id", positiveInteger("Numeric response ID."))]),
  define("upload_file", "Upload response file", "Upload a base64-encoded file for a file-upload question.", "write", [
    surveyId(), p("field_name", string("Survey response field name.")), p("file_name", string("Original file name.")), p("file_content", string("Base64-encoded file contents.")),
  ]),
  define("export_responses", "Export survey responses", "Export responses as a base64-encoded document.", "read", [
    surveyId(), p("document_type", string("Export type such as csv, html, pdf, xls, or json.")), language("language_code"),
    p("completion_status", z.enum(["all", "complete", "incomplete"]).optional().describe("Completion filter."), "all"),
    p("heading_type", z.enum(["code", "full", "abbreviated"]).optional().describe("Column heading style."), "code"),
    p("response_type", z.enum(["short", "long"]).optional().describe("Answer text format."), "short"),
    p("from_response_id", optionalInteger("Optional first response ID."), null),
    p("to_response_id", optionalInteger("Optional last response ID."), null),
    p("fields", optionalStringArray("Optional response fields to export."), null),
    p("additional_options", jsonObject("Additional exporter options.").nullable().optional(), null),
  ]),
  define("export_responses_by_token", "Export responses by token", "Export responses for selected participant tokens as a base64-encoded document.", "read", [
    surveyId(), p("document_type", string("Export type such as csv, html, pdf, xls, or json.")), p("tokens", z.union([string("One participant token."), z.array(z.string()).min(1)]).describe("One participant token or a list of tokens to export.")), language("language_code"),
    p("completion_status", z.enum(["all", "complete", "incomplete"]).optional().describe("Completion filter."), "all"),
    p("heading_type", z.enum(["code", "full", "abbreviated"]).optional().describe("Column heading style."), "code"),
    p("response_type", z.enum(["short", "long"]).optional().describe("Answer text format."), "short"),
    p("fields", optionalStringArray("Optional response fields to export."), null),
  ]),
  define("get_response_ids", "Find response IDs", "Find response IDs for a participant token.", "read", [surveyId(), p("token", string("Participant token."))]),
  define("get_uploaded_files", "Get uploaded response files", "Return uploaded file metadata and base64 content for a token or response.", "read", [surveyId(), p("token", string("Participant token.")), p("response_id", optionalInteger("Optional response ID."), null)]),
  define("get_fieldmap", "Get survey field map", "Return the survey response field map.", "read", [surveyId(), language()]),
  define("cpd_importParticipants", "Import central participants", "Import records into the central participant database.", "write", [
    p("participants", z.array(jsonObject("Central participant record.")).min(1).describe("Central participant records.")),
    p("update_existing", z.boolean().optional().describe("Update matching existing records."), false),
  ]),
];

export function buildRpcParams(
  definition: ToolDefinition,
  input: Record<string, unknown>,
): JsonValue[] {
  let lastIndex = -1;
  for (let index = 0; index < definition.parameters.length; index += 1) {
    const parameter = definition.parameters[index];
    if (parameter && input[parameter.key] !== undefined) lastIndex = index;
  }

  const result: JsonValue[] = [];
  for (let index = 0; index <= lastIndex; index += 1) {
    const parameter = definition.parameters[index];
    if (!parameter) continue;
    const value = input[parameter.key] ?? parameter.defaultValue;
    if (value === undefined) {
      throw new Error(`Missing positional parameter ${parameter.key} for ${definition.method}.`);
    }
    result.push(value as JsonValue);
  }
  return result;
}

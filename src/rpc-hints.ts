import { LimeSurveyError, type ErrorHints, type JsonValue } from "./types.js";

/**
 * Knowledge about what LimeSurvey RemoteControl really writes, so the server can tell the caller
 * before (or right after) an RPC instead of letting LimeSurvey drop fields silently.
 *
 * Every list below was verified against the LimeSurvey 6.17.11 source
 * (application/helpers/remotecontrol/remotecontrol_handle.php, installer/create-database.php,
 * application/models/*.php). Older and newer releases may differ.
 */

export const HINT_NOT_WRITABLE = "NOT_WRITABLE_VIA_REMOTECONTROL";
export const HINT_NO_DATA = "NO_DATA";
export const HINT_NO_PARTICIPANT_TABLE = "NO_PARTICIPANT_TABLE";
export const HINT_NO_RESPONSE_TABLE = "NO_RESPONSE_TABLE";
export const HINT_FIELD_SAVE_FAILED = "FIELD_SAVE_FAILED";

export const SOURCE_NOTE = "Verified against the LimeSurvey 6.17.11 source; older releases may differ.";

type JsonObject = { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface WriteSpec {
  /** Official RemoteControl method name. */
  method: string;
  /** Full MCP tool name, used in hint texts. */
  tool: string;
  /** Fields that reach the database through this method (including L10n fields the server routes). */
  writable: string[];
  /** Known keys that LimeSurvey drops or rejects, mapped to the reason and the way around it. */
  blocked: Record<string, string>;
  /** General way around the limits, appended to every hint. */
  solution: string;
  /** Extra remarks for the tool description only. */
  notes?: string;
}

const QUESTION_ATTRIBUTES_REASON =
  "question attributes are not written by set_question_properties (RemoteControl has no code path for them)";
const QUESTION_ANSWERS_REASON =
  "answer options are not written by set_question_properties (RemoteControl has no code path for them)";

const SURVEY_COLUMNS = [
  "owner_id", "gsid", "admin", "expires", "startdate", "adminemail", "anonymized", "format", "savetimings",
  "template", "datestamp", "usecookie", "allowregister", "allowsave", "autonumber_start", "autoredirect",
  "allowprev", "printanswers", "ipaddr", "ipanonymize", "refurl", "datecreated", "showsurveypolicynotice",
  "showregisterpolicy", "showtokenpolicy", "publicstatistics", "publicgraphs", "listpublic", "htmlemail",
  "sendconfirmation", "tokenanswerspersistence", "assessments", "usecaptcha", "usetokens", "bounce_email",
  "attributedescriptions", "emailresponseto", "emailnotificationto", "tokenlength", "showxquestions",
  "showgroupinfo", "shownoanswer", "showqnumcode", "bouncetime", "bounceprocessing", "bounceaccounttype",
  "bounceaccounthost", "bounceaccountpass", "bounceaccountencryption", "bounceaccountuser", "showwelcome",
  "showprogress", "questionindex", "navigationdelay", "nokeyboard", "alloweditaftercompletion",
  "googleanalyticsstyle", "googleanalyticsapikey", "tokenencryptionoptions", "access_mode", "lastmodified",
];

const LANGUAGE_SETTING_COLUMNS = [
  "surveyls_title", "surveyls_description", "surveyls_welcometext", "surveyls_endtext", "surveyls_policy_notice",
  "surveyls_policy_error", "surveyls_policy_notice_label", "surveyls_url", "surveyls_urldescription",
  "surveyls_email_invite_subj", "surveyls_email_invite", "surveyls_email_remind_subj", "surveyls_email_remind",
  "surveyls_email_register_subj", "surveyls_email_register", "surveyls_email_confirm_subj",
  "surveyls_email_confirm", "surveyls_dateformat", "surveyls_attributecaptions", "surveyls_alias",
  "email_admin_notification_subj", "email_admin_notification", "email_admin_responses_subj",
  "email_admin_responses", "surveyls_numberformat", "attachments",
];

const PARTICIPANT_COLUMNS = [
  "participant_id", "firstname", "lastname", "email", "emailstatus", "token", "language", "blacklisted", "sent",
  "remindersent", "remindercount", "completed", "usesleft", "validfrom", "validuntil", "mpid", "attribute_N",
];

const WRITE_SPECS: Record<string, WriteSpec> = {
  set_question_properties: {
    method: "set_question_properties",
    tool: "limesurvey_set_question_properties",
    writable: [
      "title", "preg", "other", "mandatory", "encrypted", "question_order", "scale_id", "same_default",
      "relevance", "question_theme_name", "modulename", "same_script", "question", "help", "script",
    ],
    blocked: {
      attributes: QUESTION_ATTRIBUTES_REASON,
      question_attributes: QUESTION_ATTRIBUTES_REASON,
      questionattributes: QUESTION_ATTRIBUTES_REASON,
      answers: QUESTION_ANSWERS_REASON,
      answeroptions: QUESTION_ANSWERS_REASON,
      answer_options: QUESTION_ANSWERS_REASON,
      subquestions:
        "subquestions are separate questions with their own question_id; change an existing subquestion by calling this tool with ITS question_id, new subquestions need a re-import",
      defaultvalues: "default values are not written by set_question_properties",
      default_values: "default values are not written by set_question_properties",
      conditions: "legacy conditions are not written by set_question_properties (use the relevance field)",
      qid: "the question ID cannot be changed",
      gid: "the question group cannot be changed",
      sid: "the survey cannot be changed",
      parent_qid: "the parent question cannot be changed",
      type: "the question type cannot be changed",
      question_l10ns: "the key is questionl10ns (no underscore before l10ns); simply passing question/help/script together with language also works",
    },
    solution:
      "Question attributes, answer options and subquestions can only be changed by re-importing the question " +
      "(limesurvey_import_question, or limesurvey_import_group / limesurvey_import_survey, all with import_data_path) " +
      "or in the LimeSurvey admin UI; limesurvey_replace_question, if available, can replace a question of an " +
      "inactive survey. Localized texts (question, help, script) are written with a language: " +
      "{\"language\": \"de\", \"question\": \"...\"} or {\"questionl10ns\": {\"de\": {\"question\": \"...\"}}}.",
    notes:
      "question, help and script are localized: pass them with data.language (or the language parameter); the server " +
      "moves them into questionl10ns[language], so the other text fields are never blanked (LimeSurvey's legacy form " +
      "would reset a field you did not send to an empty string). question_order is refused for questions that have " +
      "legacy condition dependencies, and the group is renumbered after each change.",
  },
  set_group_properties: {
    method: "set_group_properties",
    tool: "limesurvey_set_group_properties",
    writable: ["group_order", "randomization_group", "grelevance", "group_name", "description"],
    blocked: {
      sid: "the survey cannot be changed",
      gid: "the group ID cannot be changed",
      group_l10ns: "the key is questiongroupl10ns; simply passing group_name/description together with language also works",
    },
    solution:
      "A group cannot be moved to another survey or restructured through RemoteControl; re-import it " +
      "(limesurvey_import_group with import_data_path) or use the LimeSurvey admin UI. Localized texts (group_name, " +
      "description) need a language: {\"language\": \"de\", \"group_name\": \"...\"}.",
    notes:
      "group_name and description are localized: pass them with data.language (this tool has no language parameter); " +
      "the server moves them into questiongroupl10ns[language], so the other text field is never blanked.",
  },
  set_survey_properties: {
    method: "set_survey_properties",
    tool: "limesurvey_set_survey_properties",
    writable: SURVEY_COLUMNS,
    blocked: {
      sid: "the survey ID cannot be changed",
      active: "activation is a separate step: use limesurvey_activate_survey (deactivation is not available through RemoteControl)",
      language: "the base language cannot be changed; use limesurvey_add_language / limesurvey_delete_language for additional languages",
      additional_languages: "use limesurvey_add_language / limesurvey_delete_language",
    },
    solution:
      "Titles, descriptions and texts are per-language settings: use limesurvey_set_language_properties. Activation: " +
      "limesurvey_activate_survey. Languages: limesurvey_add_language / limesurvey_delete_language.",
    notes:
      "While the survey is active, anonymized, datestamp, savetimings, ipaddr and refurl are refused. access_mode and " +
      "usetokens are plain column writes: they do not create or remove the participant table.",
  },
  set_language_properties: {
    method: "set_language_properties",
    tool: "limesurvey_set_language_properties",
    writable: LANGUAGE_SETTING_COLUMNS,
    blocked: {
      surveyls_language: "the language identifies the row; select it with the language parameter",
      surveyls_survey_id: "the survey identifies the row; select it with survey_id",
    },
    solution: "Select the language row with the language parameter and send only the localized settings.",
    notes:
      "LimeSurvey answers status OK even when single fields could not be saved; such fields are reported in warnings.",
  },
  set_quota_properties: {
    method: "set_quota_properties",
    tool: "limesurvey_set_quota_properties",
    writable: ["name", "qlimit", "action", "active", "autoload_url"],
    blocked: {
      id: "the quota ID cannot be changed",
      sid: "the survey cannot be changed",
      limit: "the column is called qlimit (LimeSurvey silently ignores limit)",
      quotals_message: "localized quota texts are not writable through RemoteControl (read-only via get_quota_properties)",
      quotals_url: "localized quota texts are not writable through RemoteControl (read-only via get_quota_properties)",
      quotals_urldescrip: "localized quota texts are not writable through RemoteControl (read-only via get_quota_properties)",
    },
    solution: "Localized quota texts (message, URL, URL description) can only be edited in the LimeSurvey admin UI.",
    notes: "Unknown keys are ignored silently by LimeSurvey; the server reports them in warnings.",
  },
  set_participant_properties: {
    method: "set_participant_properties",
    tool: "limesurvey_set_participant_properties",
    writable: PARTICIPANT_COLUMNS,
    blocked: {
      tid: "tid only identifies a participant (use it in query); it cannot be changed",
    },
    solution:
      "Participant rows are changed by token or tid in query; the participant table must exist " +
      "(check limesurvey_get_participant_table_status).",
    notes:
      "attribute_N stands for the custom attribute columns of the participant table (attribute_1, attribute_2, ...). " +
      "Validation errors (for example an invalid email) are returned as an error.",
  },
};

/** The text that set_*_properties tool descriptions append: writable fields, blocked fields and the way around. */
export function describeWriteSpec(method: string): string {
  const spec = WRITE_SPECS[method];
  if (!spec) return "";
  const blocked = Object.keys(spec.blocked).join(", ");
  return (
    ` Writable fields: ${spec.writable.join(", ")}.` +
    ` NOT writable through RemoteControl (the call is rejected before any request is sent): ${blocked}.` +
    ` ${spec.solution}` +
    (spec.notes ? ` ${spec.notes}` : "") +
    ` Keys LimeSurvey does not report back are returned in warnings. ${SOURCE_NOTE}`
  );
}

function notWritableHints(spec: WriteSpec, headline: string): ErrorHints {
  return {
    hint_code: HINT_NOT_WRITABLE,
    hint: `${headline} ${spec.solution} Writable fields: ${spec.writable.join(", ")}. ${SOURCE_NOTE}`,
    writable_fields: [...spec.writable],
  };
}

/** Rejects keys that RemoteControl is known to drop, before any RPC is made. */
export function assertWritableFields(method: string, data: Record<string, JsonValue>): void {
  const spec = WRITE_SPECS[method];
  if (!spec) return;
  const found = Object.keys(data).filter((key) => Object.hasOwn(spec.blocked, key));
  if (found.length === 0) return;
  const reasons = found.map((key) => `${key} (${spec.blocked[key]})`).join("; ");
  throw new LimeSurveyError(
    `${spec.tool} cannot write ${found.join(", ")} through RemoteControl. No request was sent.`,
    "FIELD_NOT_WRITABLE",
    { tool: spec.tool, fields: found },
    notWritableHints(spec, `Not writable: ${reasons}.`),
  );
}

const L10N_ROUTING: Record<string, { target: string; fields: string[] }> = {
  set_question_properties: { target: "questionl10ns", fields: ["question", "help", "script"] },
  set_group_properties: { target: "questiongroupl10ns", fields: ["group_name", "description"] },
};

/**
 * Moves top-level localized texts into the explicit L10n structure of the handler. Without this,
 * LimeSurvey 6.17.11 either drops question/help silently (language only as a parameter) or, in its legacy
 * form (data.language plus text), resets the text field that was not sent to an empty string.
 * On a conflict between a top-level text and the same field inside an existing L10n entry the explicit
 * L10n entry wins.
 */
export function normalizeLocalizedInput(
  method: string,
  data: Record<string, JsonValue>,
  toolLanguage: unknown,
): Record<string, JsonValue> {
  const routing = L10N_ROUTING[method];
  if (!routing) return data;
  const { language: dataLanguage, ...rest } = data;
  const present = routing.fields.filter((field) => Object.hasOwn(rest, field));
  if (present.length === 0) {
    // A bare language key would trigger the legacy form and blank the texts.
    return Object.hasOwn(data, "language") ? rest : data;
  }

  const language =
    typeof dataLanguage === "string" && dataLanguage.length > 0
      ? dataLanguage
      : typeof toolLanguage === "string" && toolLanguage.length > 0
        ? toolLanguage
        : undefined;
  if (!language) {
    throw new LimeSurveyError(
      `${present.join(", ")} must be written for one language, but no language was given. No request was sent.`,
      "LANGUAGE_REQUIRED",
      { fields: present },
      {
        hint_code: "LANGUAGE_REQUIRED",
        hint:
          `Add "language": "<code>" to data${method === "set_question_properties" ? " (or set the language parameter)" : ""}, ` +
          `e.g. {"language": "de", "${present[0]}": "..."}. The text is then sent as ${routing.target}.<code>.`,
      },
    );
  }

  const normalized: Record<string, JsonValue> = { ...rest };
  const existing = isRecord(rest[routing.target]) ? { ...(rest[routing.target] as JsonObject) } : {};
  const entry: JsonObject = isRecord(existing[language]) ? { ...(existing[language] as JsonObject) } : {};
  for (const field of present) {
    delete normalized[field];
    if (!Object.hasOwn(entry, field)) entry[field] = rest[field] as JsonValue;
  }
  existing[language] = entry;
  normalized[routing.target] = existing;
  return normalized;
}

/** prepare() hook shared by the six set_*_properties tools. */
export async function prepareWriteInput(
  method: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = input.data;
  if (!isRecord(data)) return input;
  assertWritableFields(method, data);
  const normalized = normalizeLocalizedInput(method, data, input.language);
  return normalized === data ? input : { ...input, data: normalized };
}

function flattenRequested(method: string, data: Record<string, JsonValue>): string[] {
  const target = L10N_ROUTING[method]?.target;
  const names: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === target && isRecord(value)) {
      for (const [language, entry] of Object.entries(value)) {
        if (isRecord(entry)) for (const field of Object.keys(entry)) names.push(`${key}.${language}.${field}`);
        else names.push(`${key}.${language}`);
      }
    } else {
      names.push(key);
    }
  }
  return names;
}

/** Looks up one requested name in the answer: undefined = missing, otherwise the value LimeSurvey reported. */
function lookupAnswered(method: string, answer: JsonObject, name: string): JsonValue | undefined {
  const parts = name.split(".");
  if (parts.length === 3) {
    const [target, language, field] = parts as [string, string, string];
    const group = answer[target];
    if (!isRecord(group)) return undefined;
    const entry = group[language];
    if (isRecord(entry)) return entry[field];
    return entry === undefined ? undefined : (entry as JsonValue);
  }
  if (method === "set_quota_properties") {
    const message = answer.message;
    return isRecord(message) ? message[name] : undefined;
  }
  return answer[name];
}

/**
 * Compares what was requested with what LimeSurvey reported and returns warnings for keys that were
 * silently dropped (ignored_fields) or that LimeSurvey could not save (failed_fields).
 */
export function writeWarnings(method: string, result: JsonValue, input: Record<string, unknown>): JsonValue[] {
  const spec = WRITE_SPECS[method];
  const data = input.data;
  if (!spec || !isRecord(data) || !isRecord(result)) return [];

  const ignored: string[] = [];
  const failed: string[] = [];
  const reasons: JsonObject = {};
  for (const name of flattenRequested(method, data)) {
    const answered = lookupAnswered(method, result, name);
    if (answered === undefined) ignored.push(name);
    else if (method !== "set_quota_properties" && method !== "set_participant_properties" && answered !== true) {
      failed.push(name);
      if (typeof answered === "string") reasons[name] = answered;
    }
  }

  const warnings: JsonValue[] = [];
  if (ignored.length > 0) {
    warnings.push({
      hint_code: HINT_NOT_WRITABLE,
      ignored_fields: ignored,
      hint:
        "LimeSurvey did not report these keys back: it drops keys it does not know or may not write (some settings " +
        "are also locked while a survey is active). " +
        `${spec.solution} Writable fields: ${spec.writable.join(", ")}. ${SOURCE_NOTE}`,
    });
  }
  if (failed.length > 0) {
    warnings.push({
      hint_code: HINT_FIELD_SAVE_FAILED,
      failed_fields: failed,
      ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
      hint:
        "LimeSurvey reported that these fields were not saved (failed validation, a dependency, or a missing " +
        "language row). The status of the call itself can still be OK.",
    });
  }
  return warnings;
}

const NO_DATA_STATUS = /^no (?:valid data|available data)\b/i;

const NO_DATA_TEXT: Record<string, string> = {
  get_survey_properties:
    "None of the requested property names is a column of the surveys table; LimeSurvey drops unknown names silently. Omit properties to read all.",
  get_language_properties:
    "None of the requested names is a column of the survey language settings; LimeSurvey drops unknown names silently. Omit properties to read all.",
  get_group_properties:
    "None of the requested names is a group property; LimeSurvey drops unknown names silently. Omit properties to read all.",
  get_question_properties:
    "None of the requested names is a question property; LimeSurvey drops unknown names silently. Omit properties to read all.",
  get_quota_properties:
    "None of the requested names is a quota property; LimeSurvey drops unknown names silently. Omit properties to read all.",
  get_participant_properties:
    "None of the requested names is a column of the participant table; LimeSurvey drops unknown names silently. Omit properties to read all.",
  export_statistics:
    "LimeSurvey reports no statistics data for this survey. In LimeSurvey 6.17.11 this status is only returned when the question list of the survey cannot be loaded; a survey without responses or without a response table does not produce it.",
  export_timeline:
    "There is nothing to count: typically the survey was never activated (no response table) or has no responses in the range.",
};

/** Interprets "no data" answers (status text or error_code) for the given method; undefined if it is not one. */
export function interpretNoData(
  method: string,
  params: JsonValue[],
  status: string | undefined,
  code: string | undefined,
): ErrorHints | undefined {
  const noData = code === "ERR_NO_DATA" || (status !== undefined && NO_DATA_STATUS.test(status));
  if (!noData) return undefined;

  const spec = WRITE_SPECS[method];
  if (spec) {
    return notWritableHints(
      spec,
      `LimeSurvey answered "No valid Data": none of the keys in data is a field that ${spec.tool} can write.`,
    );
  }
  if (method === "get_summary") {
    const statistic = typeof params[1] === "string" ? params[1] : "all";
    if (statistic.startsWith("token_")) {
      return {
        hint_code: HINT_NO_PARTICIPANT_TABLE,
        hint:
          "This survey has no participant table, so participant statistics do not exist. That is not a call error: " +
          "whether access is open depends on access_mode on LimeSurvey 6.x (a closed survey without a table admits nobody). " +
          "Check limesurvey_get_participant_table_status.",
      };
    }
    return {
      hint_code: HINT_NO_RESPONSE_TABLE,
      hint:
        "This survey has no response table: it is not active (never activated, or deactivated - deactivation archives " +
        "the responses into an old_survey_* table), so there are no response statistics.",
    };
  }
  return {
    hint_code: HINT_NO_DATA,
    hint:
      NO_DATA_TEXT[method] ??
      `LimeSurvey reports that ${method} has no data for this request. This is not a transport error: check the IDs, the activation state of the survey and, for participant tools, that the participant table exists.`,
  };
}

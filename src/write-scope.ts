import { LimeSurveyError, type LimeSurveyConfig } from "./types.js";

/** Cumulative write scopes: each level also allows everything below it. */
export const WRITE_SCOPES = ["none", "content", "lifecycle", "outreach"] as const;
export type WriteScope = (typeof WRITE_SCOPES)[number];
export type WriteScopeSource = "default" | "LIMESURVEY_WRITE_SCOPE" | "LIMESURVEY_READ_ONLY";

export function scopeAllows(current: WriteScope, required: WriteScope): boolean {
  return WRITE_SCOPES.indexOf(current) >= WRITE_SCOPES.indexOf(required);
}

/**
 * Minimum write scope per full MCP tool name. This table is the single source of truth: the server
 * and the workflow/theme tools all enforce through assertWriteScope(), and a tool missing here is
 * treated as "outreach" (fail closed). One argument-dependent exception lives in requiredWriteScope():
 * limesurvey_import_survey with import_data_type "lsa" needs "outreach" (a .lsa activates the survey and
 * imports participants and responses), and limesurvey_invite_participants with dry_run=true needs only "none".
 *
 * - none: reads, session handling, and local-only tools (theme generation/validation, *_to_file exports).
 * - content: creates or changes survey content (structure, texts, quotas, theme assignment).
 * - lifecycle: activation and deletion of survey structure.
 * - outreach: touches participants, responses, uploads, or sends email.
 */
export const TOOL_WRITE_SCOPES: Readonly<Record<string, WriteScope>> = {
  // none: official read tools and session handling
  limesurvey_get_session_key: "none",
  limesurvey_release_session_key: "none",
  limesurvey_get_available_site_settings: "none",
  limesurvey_get_site_settings: "none",
  limesurvey_get_survey_properties: "none",
  limesurvey_export_statistics: "none",
  limesurvey_export_timeline: "none",
  limesurvey_get_summary: "none",
  limesurvey_get_language_properties: "none",
  limesurvey_get_group_properties: "none",
  limesurvey_get_question_properties: "none",
  limesurvey_get_participant_properties: "none",
  limesurvey_list_participants: "none",
  limesurvey_list_groups: "none",
  limesurvey_list_questions: "none",
  limesurvey_list_quotas: "none",
  limesurvey_get_quota_properties: "none",
  limesurvey_list_surveys: "none",
  limesurvey_list_survey_groups: "none",
  limesurvey_list_users: "none",
  limesurvey_export_responses: "none",
  limesurvey_export_responses_by_token: "none",
  limesurvey_get_response_ids: "none",
  limesurvey_get_uploaded_files: "none",
  limesurvey_get_fieldmap: "none",
  // none: workflow reads and local-only file exports
  limesurvey_find_surveys: "none",
  limesurvey_get_survey_languages: "none",
  limesurvey_list_filtered_participants: "none",
  limesurvey_get_participant_table_status: "none",
  limesurvey_validate_participants: "none",
  limesurvey_list_response_export_formats: "none",
  limesurvey_get_instance_info: "none",
  limesurvey_export_responses_to_file: "none",
  limesurvey_export_responses_by_token_to_file: "none",
  limesurvey_export_statistics_to_file: "none",
  limesurvey_export_survey_to_file: "none",
  // none: local-only theme tools and theme reads
  limesurvey_generate_survey_theme: "none",
  limesurvey_validate_survey_theme: "none",
  limesurvey_get_theme_publication_guide: "none",
  limesurvey_list_installed_themes: "none",

  // content
  limesurvey_import_survey: "content",
  limesurvey_import_group: "content",
  limesurvey_import_question: "content",
  limesurvey_add_survey: "content",
  limesurvey_copy_survey: "content",
  limesurvey_add_group: "content",
  limesurvey_add_language: "content",
  limesurvey_add_quota: "content",
  limesurvey_set_survey_properties: "content",
  limesurvey_set_language_properties: "content",
  limesurvey_set_group_properties: "content",
  limesurvey_set_question_properties: "content",
  limesurvey_set_quota_properties: "content",
  limesurvey_assign_survey_theme: "content",

  // lifecycle
  limesurvey_activate_survey: "lifecycle",
  limesurvey_activate_tokens: "lifecycle",
  limesurvey_delete_survey: "lifecycle",
  limesurvey_delete_group: "lifecycle",
  limesurvey_delete_question: "lifecycle",
  limesurvey_delete_language: "lifecycle",
  limesurvey_delete_quota: "lifecycle",

  // outreach
  limesurvey_add_participant: "outreach",
  limesurvey_add_participants: "outreach",
  limesurvey_set_participant_properties: "outreach",
  limesurvey_delete_participants: "outreach",
  limesurvey_invite_participants: "outreach",
  limesurvey_remind_participants: "outreach",
  limesurvey_mail_registered_participants: "outreach",
  limesurvey_cpd_importParticipants: "outreach",
  limesurvey_add_response: "outreach",
  limesurvey_update_response: "outreach",
  limesurvey_delete_response: "outreach",
  limesurvey_upload_file: "outreach",
};

/**
 * The effective scope of a config. Configs that were not built by loadConfig (for example in tests)
 * have no writeScope field: readOnly=true then means "none", otherwise everything is allowed.
 */
export function effectiveWriteScope(config: LimeSurveyConfig): { scope: WriteScope; source: WriteScopeSource } {
  if (config.readOnly === true && config.writeScope !== undefined && config.writeScope !== "none") {
    return { scope: "none", source: "LIMESURVEY_READ_ONLY" };
  }
  if (config.writeScope !== undefined) {
    return { scope: config.writeScope, source: config.writeScopeSource ?? "LIMESURVEY_WRITE_SCOPE" };
  }
  if (config.readOnly === true) return { scope: "none", source: "LIMESURVEY_READ_ONLY" };
  return { scope: "outreach", source: "default" };
}

/** Minimum scope a tool call needs. Unknown tool names fail closed. */
export function requiredWriteScope(toolName: string, input?: Record<string, unknown>): WriteScope {
  // A .lsa archive activates the survey and imports participants and responses.
  if (toolName === "limesurvey_import_survey" && String(input?.import_data_type).trim().toLowerCase() === "lsa") {
    return "outreach";
  }
  // A dry run only reads the participant list and never calls invite_participants.
  if (toolName === "limesurvey_invite_participants" && input?.dry_run === true) return "none";
  return TOOL_WRITE_SCOPES[toolName] ?? "outreach";
}

function sourceDescription(scope: WriteScope, source: WriteScopeSource): string {
  if (source === "LIMESURVEY_READ_ONLY") return "set by LIMESURVEY_READ_ONLY=true";
  if (source === "LIMESURVEY_WRITE_SCOPE") return `set by LIMESURVEY_WRITE_SCOPE=${scope}`;
  return "the default";
}

export function assertWriteScope(config: LimeSurveyConfig, toolName: string, input?: Record<string, unknown>): void {
  const { scope, source } = effectiveWriteScope(config);
  const required = requiredWriteScope(toolName, input);
  if (scopeAllows(scope, required)) return;
  throw new LimeSurveyError(
    `The tool ${toolName} needs the write scope "${required}", but the current write scope is "${scope}" `
      + `(${sourceDescription(scope, source)}). If this change is intended, deliberately raise LIMESURVEY_WRITE_SCOPE `
      + `to "${required}" (or higher) and fully restart the MCP client; reconnecting does not reload environment `
      + "variables. Do NOT work around this block by calling the LimeSurvey RemoteControl API directly outside "
      + "this server.",
    "WRITE_SCOPE_INSUFFICIENT",
    { tool: toolName, current_scope: scope, required_scope: required, scope_source: source },
  );
}

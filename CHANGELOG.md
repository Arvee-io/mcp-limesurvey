# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-10-14

Surveys, groups and single questions can now be created, read and changed from
a JSON description, without any local file; 82 tools (75 before).

### Added

- Surveys from a JSON description (spec), without any local file:
  `limesurvey_validate_spec` (write scope `none`) checks a survey, group, or
  question description and reports every problem with `path`, `message`, and
  `fix`; with `survey_id` it also checks against the live survey using read
  methods only. `limesurvey_create_survey_from_spec` (`content`) generates the
  `.lss` in memory, imports it, reads the survey back, and reports the
  differences in `verification`. Based on user feedback.
- The `.lss` generator is a byte-for-byte port of the Python generator of the
  `limesurvey` Claude Code plugin (`test/fixtures/lss-parity` holds the reference
  cases for all 26 question types it supports).
- `tools/build-attribute-defaults.mjs` and `tools/build-html-entities.py` generate
  the attribute default table and the HTML entity table (not part of the package).
- `limesurvey_get_survey_spec` (write scope `none`) reads a survey, one group, or
  one question as a spec in the format the write tools take, with `ids`,
  `position`, a `fingerprint`, `unreadable` (what RemoteControl cannot read) and
  `missing_translations`; too large surveys give `SPEC_TOO_LARGE` with an outline
  per group. Surveys built in the admin UI read back with their extended question
  themes, non-default attributes, default values and scripts.
- `limesurvey_add_question_from_spec` and `limesurvey_add_group_from_spec` (write
  scope `content`) insert one question or one group with its questions into an
  inactive survey at a given position, without a file. Only the new element is
  moved; the result is read back and compared; a failure after the import deletes
  the new element again by its id, while an unclear import outcome is reported
  with read-only candidates instead of being cleaned up. Translation gaps that a
  question import would fill need `acknowledge: ["fill_translation_gaps"]`.
- `limesurvey_update_question_from_spec` changes one question to a given end state
  (answers, subquestions, attributes, type, mandatory, texts): a dry run under
  write scope `none` shows the changes, the mode and the risks; the real run needs
  the fingerprint, a confirmation and the acknowledgement of the reported risks,
  writes texts or columns in place or replaces the question at the same place,
  compares the new question in full before the old one is deleted, and rolls back
  otherwise. On active surveys only texts change.
- `limesurvey_update_survey_texts` changes texts of the survey, groups, questions
  and subquestions per language, also on active surveys, and refuses what
  RemoteControl cannot write before anything is written.
- Attributes that the theme of a question does not define, and a question theme
  of another question type, are errors before anything is written
  (`ATTRIBUTE_NAMES` and `THEME_TYPES`, generated from LimeSurvey 6.17.11 and
  7.5.1).
- The question types `1` (array dual scale), `:` (array numbers) and `;` (array
  texts) in every spec tool, with `scale_id` for the second scale; all 29 core
  question types are supported.
- Texts per language: every text field of a spec takes a string or a map per
  language; new structure must cover exactly the survey languages.
  Language-dependent attributes are written once per language.

### Changed

- Compared with the Python generator, the validation is stricter where LimeSurvey
  would otherwise change or drop data silently: answer codes have at most five
  characters, question codes must not be reserved words and are unique without
  regard to case, language codes and XML control characters are checked, and
  embedded `data:` URIs are rejected. HTML entities that stand for markup
  characters, or that lack the closing semicolon, are no longer decoded.
- Language-dependent attributes such as `prefix` or `em_validation_q_tip` are
  written with one row per language. The Python generator wrote them without a
  language, and LimeSurvey ignores such rows, so the setting had no effect.
- Ranking (`R`) items are written as subquestions on LimeSurvey 7, where they may
  have codes of up to 20 characters and their own relevance; one read call tells
  the version. On LimeSurvey 6 they stay answers.
- An empty question, subquestion or answer text is a warning instead of an error;
  `default` is rejected on question types where LimeSurvey never uses it.

### Fixed

- Survey themes on LimeSurvey 7, based on user feedback. LimeSurvey installs an
  uploaded theme under the ZIP file name without `.zip` and without dots, so a
  generated package `weit_feedback-1.0.0-ls7.zip` becomes
  `weit_feedback-100-ls7`, which `limesurvey_assign_survey_theme` could not take;
  assigning `weit_feedback` reported success while LimeSurvey kept the default
  theme.
  - `limesurvey_generate_survey_theme` returns `installed_theme_name`, writes it
    as `metadata/name`, and refuses a `theme_name` whose installed name would
    exceed LimeSurvey's 45 characters (`THEME_NAME_TOO_LONG`) before writing. A
    version component with more than one digit gives a warning, because the
    installed name drops the dots (`1.10.0` and `11.0.0` both become `1100`).
    `THEME_NAME_TOO_LONG` asks for a shorter `theme_version` when the version
    alone is too long. A JPEG logo is checked by its first bytes only.
  - `limesurvey_assign_survey_theme` takes installed names (1–45 ASCII letters,
    digits, `_`, `-`; `inherit` is refused, because the read-back cannot confirm
    the theme a survey group passes on). It reads the current theme first and
    writes nothing when that fails (`THEME_PREVIOUS_UNKNOWN`, `written: false`),
    reads the template back after `set_survey_properties`, and fails with
    `THEME_NOT_APPLIED` when LimeSurvey stored another theme or refused to save
    the survey (`{"template": false}`), or with `THEME_NOT_VERIFIED`
    (`written: true`) when the read-back fails or has no template; a match
    returns `verified: true`. Results and `THEME_NOT_APPLIED` name
    `previous_theme` and `changed`, with a restore hint (for `inherit` through
    `limesurvey_set_survey_properties`).
  - `limesurvey_validate_survey_theme` follows the LimeSurvey 7.5.1 import and
    returns `installed_theme_name`; `valid` means LimeSurvey imports and uses the
    package. Errors remain only for archive safety (more than 1000 entries,
    unsafe paths, size limits, CRC-32 mismatches, content signatures) and real
    import obstacles: an installed name over 45 characters or with other
    characters, files the import would skip (such as `.html` in `views/`), a
    `config.xml` that is not well-formed or not at the root, a missing
    `metadata/title` or `views/`. The archive checks use the ZIP metadata and
    stop before anything is decompressed; entries are then read one at a time
    with a size cap. Now allowed: web fonts (`woff2`, `woff`, `ttf`, `otf` with a
    signature check, `eot`), `txt`/`md` anywhere, `gif`/`ico`, and subfolders in
    `css/` and `files/`. The generator's own rules are `policy:` warnings
    instead of errors: JavaScript, source maps, JSON, Twig templates, files
    without an extension, a parent other than `vanilla`, a `type` other than
    `theme`, a missing 7.x compatibility entry, a missing `css/mcp-theme.css`,
    `LICENSE.txt` or GPL license, missing small-screen, reduced-motion or focus
    rules, more than 50 entries, and `@import`, expressions or external URLs in
    any CSS file.
  - `limesurvey_get_theme_publication_guide` returns `installed_theme_name` and
    explains the import through the theme list: review every `policy:` warning
    first, do not rename the ZIP, avoid the replacement upload form behind "This
    theme type ('') is not allowed.", delete a theme folder left behind by a
    failed import, treat a new version as a new theme, and mind versions with the
    same digits. `current_reference` keeps `current_ce_release` next to the new
    fields.
  - Verified on LimeSurvey CE 7.5.1: a generated package imports with Upload &
    install, installs as `<theme_name>-<version without dots>-ls7`, is assigned
    with that name, and renders.

## [1.5.1] - 2026-10-14

### Fixed

- LimeSurvey 7 compatibility: LimeSurvey 7.x answers an empty list with
  `{"status": "No ... found", "error_code": "ERR_NO_DATA"}`. The `list_*` tools
  (and the workflow tools built on them, such as `find_surveys`,
  `get_instance_info` with `probe_instance=true`, `validate_participants` and the
  `invite_participants` dry run) now return `[]` for this answer as they already
  did for the LimeSurvey 6 form without `error_code`. Found in a live run against
  LimeSurvey 7.5.1.

## [1.5.0] - 2026-10-12

This release has 75 tools (two new: `verify_survey_against_lss` and
`replace_question`). The additions are based on user feedback.

### Added

- `get_language_properties` adds `attachments_parsed` next to the unchanged raw
  `attachments` field, based on user feedback: `{ <mail type>: [ { file_name,
  url, size, relevance } ] }`. Both storage formats are parsed (JSON string
  since DB version 647, PHP serialize string on older instances). An empty value
  gives `{}`; an unparsable one gives `null` and the warning
  `ATTACHMENTS_UNPARSEABLE`.
- `get_language_properties` reports requested property names that LimeSurvey
  dropped silently in the warning `UNKNOWN_FIELDS` (`unknown_fields`).
- `get_instance_info` with `probe_instance=true` reports `server_time` (UTC) and
  `server_time_source` (`http_date_header`), based on user feedback; without the
  probe both are `null` and `server_time_hint` says so. `server_time_note`
  explains that the value is the web server's clock in UTC; the PHP time zone
  is not readable through RemoteControl, only the `timeadjust` offset is (and
  only by superadmins).

- New read tool `verify_survey_against_lss` (write scope `none`), based on user
  feedback that a survey cannot be exported over RemoteControl: it compares a
  `.lss` file inside `LIMESURVEY_IMPORT_DIR` (fallback `LIMESURVEY_EXPORT_DIR`,
  same path check and size limit as `import_data_path`) with the live survey
  using only `list_groups`, `list_questions`, and `get_question_properties`.
  Groups, questions, subquestions, answer options, and attributes are matched by
  code, not by ID. The result has `summary`, `differences` (at most 500, then
  `truncated=true` and the full `differences_total`), and `limitations`. This
  makes 74 tools (73 before); tests, README, docs, the live runner, and the
  S-01 scope table (scope `none`) were adjusted. Without `language` the base
  language is read from the `list_groups` rows (no `get_survey_properties`, so
  no survey-settings permission is needed), and the answer options of
  dual-scale questions (type `1`) are requested as `answeroptions_multiscale`
  and compared per scale instead of being reported as missing.
- `export_survey_to_file` asks `export_survey_structure` first and `export_survey`
  second; the `EXPORT_UNSUPPORTED` error lists why each failed. Researched on
  2026-10-11: no verified LimeSurvey 6.x plugin exports a `.lss` over
  RemoteControl; upstream pull request #5384 adds `export_survey_structure` for
  the 7.x line. A plugin can answer additional methods on the core URL, so the
  earlier statement that RemoteControl cannot be extended is corrected in the
  tool description and the README. The description names
  `verify_survey_against_lss` as the alternative.

- New write tool `replace_question` (write scope `content`), based on user
  feedback that question attributes and answer options cannot be changed with
  `set_question_properties`: it replaces one main question of an inactive survey
  by the question in a `.lsq` file (`import_data` or `import_data_path`), in the
  same group and at the same position. It requires
  `confirm_destructive_action=true` and uses only official RemoteControl methods
  (`get_survey_properties`, `get_question_properties`, `list_questions`,
  `set_question_properties`, `import_question`, `delete_question`). The survey
  must be inactive (`SURVEY_ACTIVE`), the question must belong to `survey_id`
  (`QUESTION_SURVEY_MISMATCH`) and be a main question (`NOT_A_MAIN_QUESTION`);
  the old question is the only one that can be deleted. A failure after the
  first write is rolled back (the imported question is deleted, the old code is
  restored); `REPLACE_QUESTION_FAILED` names the step and lists `manual_cleanup`
  if a rollback step failed too. The position is taken from the old question
  after the rename, because `set_question_properties` renumbers the group, and
  an unclear answer of `delete_question` (timeout, 5xx) is checked against the
  old question before anything is rolled back; if its state cannot be read, the
  imported question is kept and `manual_cleanup` names both questions. Question IDs change; legacy conditions that
  reference the old ID are not migrated. This makes 75 tools (74 before); tests,
  README (scope table), `docs/LIVE_TESTING.md`, the live runner (it replaces the
  question of its inactive test survey), and the S-01 scope table were adjusted.
  The hint for question attributes and answer options that
  `set_question_properties` cannot write now names `replace_question`.

### Documentation

- README section "Limits of RemoteControl": no mail send log, no list of survey
  files, server time only from the HTTP `Date` header.

## [1.4.0] - 2026-10-12

This release has 73 tools (72 before the participant validation tool). Most
changes are based on user feedback.

### Added

- `LIMESURVEY_WRITE_SCOPE` (`none`, `content`, `lifecycle`, `outreach`;
  cumulative), based on user feedback: the previous all-or-nothing
  `LIMESURVEY_READ_ONLY` switch pushed people to call RemoteControl directly,
  outside the server's confirmations. `content` allows building and correcting
  surveys (imports, structure, texts, quotas, theme assignment); `lifecycle`
  adds activation and deletion; `outreach` adds participants, responses,
  uploads, and email. Every one of the 73 tools has a documented minimum scope
  (new `src/write-scope.ts`, single source of truth); a tool without an entry is
  treated as `outreach`. Blocked calls fail before any file read or RPC request
  with `WRITE_SCOPE_INSUFFICIENT`, naming the current and required scope and
  the variable that set it. `import_survey` with `import_data_type=lsa`
  requires `outreach`, because a `.lsa` archive activates the survey and
  imports participants and responses.
- A startup warning when `LIMESURVEY_READ_ONLY` and `LIMESURVEY_WRITE_SCOPE`
  are both set; the stricter level applies.
- `get_instance_info` reports `write_scope` and `write_scope_source` and adds
  `capability_blocked_by` (same keys as `capabilities`; `null` or the reason,
  naming the required and current scope or the missing environment variable).
  New capabilities: `theme_assignment`, `content_changes`,
  `lifecycle_changes`, `participant_outreach`, `file_exports`.

- Based on user feedback, error hints for the `set_*_properties` tools of
  questions, groups, surveys, language settings, quotas, and participants
  (new `src/rpc-hints.ts`, verified against the LimeSurvey 6.17.11 source):
  keys that RemoteControl cannot write (for example question `attributes`,
  `answeroptions`, `subquestions`, survey `active`, quota `limit`) are rejected
  before any request with `FIELD_NOT_WRITABLE`, `hint_code`
  `NOT_WRITABLE_VIA_REMOTECONTROL`, a `hint`, and `writable_fields` on the top
  level of the error. Other keys that the answer does not contain are returned
  in a new optional `warnings` output field. Tool descriptions list the
  writable and non-writable fields.
- Question and group texts (`question`, `help`, `script`, `group_name`,
  `description`) are sent as `questionl10ns` / `questiongroupl10ns` for the
  language in `data.language` (questions: or the `language` parameter), so a
  text correction no longer blanks the other text field; without a language the
  call fails with `LANGUAGE_REQUIRED`.
- "No data" answers (`No valid Data`, `No available data`, `ERR_NO_DATA`) get a
  `hint_code` and `hint`; `hint_code`, `hint`, and `writable_fields` appear on
  the top level of errors from official, workflow, and theme tools.

- New read tool `get_participant_table_status` (write scope `none`), based on user feedback that `usetokens` and the missing participant
  table were misread: it reports `exists`, `participant_count` and
  `survey_is_closed_access` with an explanation and its basis. Existence comes
  from `get_summary(token_count)`; closed access follows `access_mode` where the
  LimeSurvey release has it and the participant table otherwise
  (`closed_access_basis`). `usetokens` is not evaluated by LimeSurvey 6.17.11 and
  is documented as such in `get_survey_properties`.
- `get_summary` answers "No available data" with `NO_PARTICIPANT_TABLE`
  (`token_*` statistics, no participant table; access follows `access_mode`) or
  `NO_RESPONSE_TABLE` (survey not active: never activated or deactivated).

- Optional MCP-only `survey_id` for `get_group_properties` and
  `get_question_properties` (never sent to LimeSurvey): the server compares it
  with the result's `sid` (one extra read when the result has none) and fails
  with `GROUP_SURVEY_MISMATCH` / `QUESTION_SURVEY_MISMATCH`, based on user
  feedback about reading another survey's object by a wrong ID. Tool
  definitions gained an optional `afterCall` hook for this.
- Unknown tool arguments now fail with `Unknown argument: <names>. This tool
  accepts: <parameters>.` for official, workflow, and theme tools (new
  `src/input-schema.ts`); other validation messages are unchanged.

- Based on user feedback, `invite_participants` has an MCP-only `dry_run`
  (never sent to LimeSurvey) that previews an invitation run: with
  `dry_run=true` the RemoteControl method `invite_participants` is never
  called, not even with `send_email=false`, which means "resend to those
  already invited" and mails them. The server reads the participants and
  simulates the selection of LimeSurvey 6.17.11 (completed, missing token or
  email, already invited, `emailstatus`, address pattern, validity window,
  `token_ids`, `maxemails`). The report lists `would_receive` and
  `would_not_receive` with reasons, `stops_at_tid` and `not_reached` (without
  `continue_on_error` LimeSurvey stops at the first participant whose validity
  fails), `warnings`, `limitations`, `time_basis`, and `borderline`. The report
  stays within `LIMESURVEY_MAX_RESPONSE_CHARS` for tables of any size:
  participants outside `token_ids` are only counted (`not_selected`), and the
  lists are capped (100 entries; `warnings` and `borderline` 25) with
  `truncated_lists` and complete `counts`. A dry run
  needs write scope `none` and no `confirm_send_email`. Tool definitions gained
  an optional `override` hook for this; `server_utc_offset_minutes` states the
  UTC offset of the LimeSurvey server.
- New read tool `validate_participants` (write scope `none`, 73 tools in
  total): checks the whole participant table for whitespace at the edges,
  duplicate addresses and tokens, invalid addresses, `validfrom`/`validuntil`
  against the server time, `validfrom` after `validuntil`, `emailstatus` other
  than `OK`, and missing email or token. The server time is the HTTP `Date`
  header, which the client now remembers; `validfrom`/`validuntil` are read in
  the server's local time (`server_utc_offset_minutes`, or the timezone of the
  MCP host as an assumption that `time_basis` states).
- New `LIMESURVEY_PASSWORD_FILE`, based on user feedback: the password can live
  in a file that only the account can read instead of in the MCP client
  configuration. A UTF-8 BOM and trailing line endings are removed; UTF-16
  (Windows PowerShell 5.1 `>`/`Out-File`), invalid UTF-8, and empty or missing
  files fail with a message that names the path and never the password. The
  file wins over `LIMESURVEY_PASSWORD`, and a startup warning names both
  variables. On POSIX a warning appears for files readable by group or others.
  `get_instance_info` reports `password_source` (`file` or `env`) without path
  or content. `docs/INSTALLATION.md` shows how to create the file without
  typing the password into a command line.

### Changed

- Empty lists are no longer errors: `list_surveys`, `list_survey_groups`,
  `list_users`, `list_groups`, `list_questions`, `list_quotas`, and
  `list_participants` return `[]` when LimeSurvey answers with its nothing-found
  status (`No surveys found`, `No survey groups found`, `No users found`,
  `No groups found`, `No questions found`, `No quotas found`,
  `No survey participants found.`). Found by an early live run against a fresh
  instance, where `list_surveys` failed with `No surveys found`. Other
  statuses, such as `Error: No survey participant list`, stay errors.
- The description of `send_email` of `invite_participants` follows the
  LimeSurvey source: `true` (default) invites only participants who were not
  invited yet, `false` resends only to those already invited; emails are sent
  in both cases. `confirm_send_email` is required unless `dry_run=true`.
- `docs/LIVE_TESTING.md` explains that LimeSurvey 6 source trees have no
  `docs/demosurveys` and which sample survey to supply; the live runner covers
  `validate_participants` and the invitation dry run (73 tools).

- `set_group_properties` with `group_name` or `description` now needs a
  language (`data.language`); without one LimeSurvey dropped the text
  silently.
- The client now raises errors for an object in `status` (validation errors of
  `set_participant_properties`) and for `{success: false}` (`set_quota_properties`),
  which it previously returned as results.
- `LIMESURVEY_READ_ONLY=true` is now an alias for `LIMESURVEY_WRITE_SCOPE=none`.
  Without either variable behavior is unchanged (everything allowed).
- Based on user feedback, tools that only work locally no longer count as
  writes and are available in read-only mode and under every scope:
  `generate_survey_theme`, `validate_survey_theme`,
  `get_theme_publication_guide`, `export_responses_to_file`,
  `export_responses_by_token_to_file`, `export_statistics_to_file`, and
  `export_survey_to_file`. Their directory checks are unchanged.
- `get_session_key` and `release_session_key` are allowed under every scope
  (they were previously blocked in read-only mode).
- `get_instance_info` computes `capabilities` after the write scope and the
  configuration (still booleans). `import_via_path` was always `true` before,
  even in read-only mode or without an import directory; it is now `false` with
  a reason in `capability_blocked_by` in those cases.

## [1.3.1] - 2026-07-25

### Fixed

- `generate_survey_theme` now ships a `views/` directory (placeholder
  `views/README.txt`) in the generated package. Without it, LimeSurvey 7 adds
  the theme's own Twig view path to its `FilesystemLoader` and raises a
  `Twig\Error\LoaderError` ("... /views/ directory does not exist") when a
  survey using the theme is rendered, even though the layouts should inherit
  from the vanilla parent. Found during a 360°-feedback end-to-end test on
  LimeSurvey CE 7.0.6 (2026-07-24). The generated theme render fix still needs
  confirmation against a live LimeSurvey 7 instance.
- The manifest now emits `<apiVersion>3</apiVersion>` (integer template API
  version) instead of `<apiVersion>3.0</apiVersion>`, matching working
  hand-authored themes.
- `validate_survey_theme` now accepts `views/` entries and reports an error
  when an inheriting theme (`<extends>` set) is missing its `views/`
  directory, so the render-blocking defect above is caught before upload.



### Added

- `import_data_path` parameter for `import_survey`, `import_group`, and
  `import_question`: the server reads and base64-encodes a local file from
  `LIMESURVEY_IMPORT_DIR` (falling back to `LIMESURVEY_EXPORT_DIR`), so a
  survey, group, or question file of any size can be imported in a single
  tool call instead of an inline base64 payload. New `LIMESURVEY_IMPORT_DIR`
  and `LIMESURVEY_MAX_IMPORT_BYTES` (default 50 MiB) environment variables,
  and dedicated `IMPORT_*` error codes with `recovery` guidance.
- `get_instance_info` workflow tool: makes no RemoteControl call by default,
  reporting `server_version` (new exported `SERVER_VERSION` constant in
  `server.ts`), `instance_host`, `transport`, `read_only`,
  `experimental_methods_enabled`, per-directory
  `{configured, path, exists, writable}` checks for
  `LIMESURVEY_EXPORT_DIR`/`LIMESURVEY_IMPORT_DIR`/`LIMESURVEY_THEME_DIR`, and
  a `capabilities` summary. An optional `probe_instance=true` additionally
  calls `list_surveys` (count only) and `get_site_settings("versionnumber")`,
  degrading to `permission_level: "standard"` and `instance_version: null`
  when the service account is not a superadmin.
- `list_installed_themes` tool (moved to `theme-tools.ts`): combines
  `generated_packages` (a non-recursive local scan of `LIMESURVEY_THEME_DIR`)
  with `themes_in_use` (distinct `template` values from `get_survey_properties`
  across up to `survey_scan_limit` surveys returned by `list_surveys`, which
  works without a superadmin account, unlike `get_site_settings`), tracking
  `"inherit"` separately as `inherit_count`. Always includes the documented
  LimeSurvey admin-UI fallback, since RemoteControl2 has no official method
  to enumerate installed themes.
- `export_survey_to_file` workflow tool (experimental, gated behind
  `LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS`, same precedent as
  `list_response_exports`): attempts to export a survey's structure and write
  it inside `LIMESURVEY_EXPORT_DIR`, returning a path instead of base64. Core
  LimeSurvey RemoteControl2 has no `export_survey` method (verified
  2026-07-24 against api.limesurvey.org and the LimeSurvey source), so this
  only works against an instance with a custom plugin providing an
  equivalent method; it otherwise always fails with a structured
  `EXPORT_UNSUPPORTED` error recommending property-based verification
  (`list_groups`, `list_questions`, `get_survey_properties`,
  `get_group_properties`, `get_question_properties`) instead of round-trip
  diffing.
- `envPreflightWarnings(config)` in `config.ts`: called from `index.ts` after
  `loadConfig()` and printed to stderr, naming every missing optional
  directory, which tools it disables, and that changing it requires a full
  restart (ISSUE-003/CAP-03 preflight, before any tool call fails at runtime).

### Changed

- Document that `import_survey` returns the survey ID LimeSurvey actually
  assigned: it keeps the ID embedded in the file when free, honors
  `destination_survey_id` when provided, and silently assigns a random
  6-digit ID on collision instead of failing.
- The `LIMESURVEY_EXPORT_DIR`/`LIMESURVEY_THEME_DIR` "not configured" errors
  now mention that changing the environment requires a full MCP client
  restart; reconnecting alone does not reload environment variables.
- Generated survey themes now extend the official `vanilla` ("Bootstrap
  Vanilla") base theme instead of `fruity_twentythree` (verified against the
  vanilla 3.0.1 manifest, 2026-07-24). `vanilla` is the minimal official base
  theme shipped and installed with every LimeSurvey instance and is explicitly
  designed as the extension base for custom themes, so generated themes no
  longer depend on `fruity_twentythree` being installed. **Breaking change for
  re-generated themes:** packages produced before this change declared
  `<extends>fruity_twentythree</extends>` and `limesurvey_validate_survey_theme`
  now rejects that parent; regenerate any existing theme package with
  `limesurvey_generate_survey_theme` before re-validating or re-importing it.

### Fixed

- Workflow-tool errors (`workflow-tools.ts`) now include the `LimeSurveyError`
  `details` object (for example a `recovery` hint) in their structured
  output, matching the official-tool error path in `server.ts`.

## [1.2.3] - 2026-07-23

### Changed

- Re-publish to npm via OIDC Trusted Publishing so the release carries build
  provenance and is attributed to the GitHub Actions publisher. No functional
  or API changes.

## [1.2.2] - 2026-07-23

### Added

- Public npm distribution documentation for Codex CLI, MCP JSON clients,
  global npm, source, and Docker installations.
- Installation verification, update, removal, and troubleshooting guidance.

### Changed

- Upgrade to Zod 4, TypeScript 7, Node.js 26 type definitions, and current
  GitHub Actions majors.
- Harden the npm Trusted Publishing workflow with release-tag validation and
  serialized publishes.

### Fixed

- Adapt recursive JSON and record schemas to Zod 4 while preserving MCP input
  validation for participant filters and workflow tools.

## [1.2.1] - 2026-07-23

### Added

- Guarded opt-in live integration runner covering all 68 MCP tools with
  prefixed test records, automatic cleanup, and explicit CPD cleanup reporting.
- Live integration testing documentation.

### Fixed

- Detect LimeSurvey API failures that contain a failure `status` or non-empty
  `errors` object but omit `error_code`.

## [1.2.0] - 2026-07-22

### Added

- Responsive LimeSurvey 7/6 survey theme generator based on the official
  `fruity_twentythree` Bootstrap 5 theme.
- Theme ZIP validation for manifests, compatibility, archive paths, asset
  signatures, size limits, licensing, responsive CSS, and risky external CSS.
- Version-aware theme installation, acceptance, rollback, and community
  publication guidance.
- Workflow for assigning an installed theme to a survey.
- Public repository metadata, security policy, contribution guide, Dependabot,
  and expanded CI for Node.js 20, 22, and 24.

## [1.1.0] - 2026-07-21

### Added

- Server-enforced read-only mode and explicit confirmations for destructive,
  email, activation, and overwrite operations.
- Eight workflow tools for survey discovery, languages, participants, export
  format discovery, and secure file exports.
- Authenticated MCP Streamable HTTP transport, Docker/Compose, healthcheck, and CI.

## [1.0.0] - 2026-07-21

### Added

- Complete coverage of all 56 documented LimeSurvey RemoteControl 2 methods.
- JSON-RPC 1.0 client with session reuse, retry, timeouts, structured MCP output,
  Zod validation, annotations, stdio transport, and mocked endpoint tests.

[1.6.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.5.1...v1.6.0
[1.4.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.3.1...v1.4.0
[1.3.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/releases/tag/v1.0.0

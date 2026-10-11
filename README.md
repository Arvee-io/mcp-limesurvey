# LimeSurvey MCP Server

[![npm version](https://img.shields.io/npm/v/limesurvey-mcp-server.svg)](https://www.npmjs.com/package/limesurvey-mcp-server)
[![CI](https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/limesurvey-mcp-server.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)

A production-oriented [Model Context Protocol](https://modelcontextprotocol.io/)
server for the [LimeSurvey RemoteControl 2 API](https://www.limesurvey.org/manual/RemoteControl_2_API).
It exposes all 56 documented RemoteControl methods plus 17 guarded workflow tools
for discovery, participants, exports, capability detection, and responsive
survey themes.

This community project is not affiliated with or endorsed by LimeSurvey GmbH.

## Features

- **Complete RemoteControl coverage:** all 56 documented JSON-RPC methods
- **74 MCP tools:** official methods plus focused workflow and theme tools
- **Modern MCP contracts:** strict Zod schemas, structured output, and annotations
- **Safe write access:** server-enforced write scopes (`none`, `content`, `lifecycle`,
  outreach), a legacy read-only switch, and explicit confirmations
- **Session management:** cached credentials, one retry after an invalid session,
  graceful release, timeouts, and sanitized errors
- **Two transports:** stdio for local clients and authenticated Streamable HTTP
- **Secure exports:** bounded base64 decoding into a dedicated directory
- **Survey theme workflow:** generate, validate, publish, and assign responsive themes
- **Deployment ready:** Docker, Compose, healthcheck, CI, and Dependabot

## Tool Catalog

| Area | Tools | Count |
|---|---|---:|
| Official RemoteControl 2 API | Sessions, settings, surveys, languages, groups, questions, participants, quotas, users, responses, files, exports | 56 |
| Workflow helpers | Survey search, language normalization, participant helpers, export format discovery, secure file exports, experimental survey-structure export, capability/instance info, participant table status, participant validation, survey-vs-.lss verification | 13 |
| Survey themes | Generate, validate, publication guide, assign to survey, best-effort theme listing | 5 |
| **Total** | | **74** |

Official tools are named `limesurvey_<remotecontrol_method>`. Run the MCP
Inspector to view every current schema:

```bash
npm run inspect
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer, or Docker
- A reachable LimeSurvey instance
- A dedicated LimeSurvey service account with only the required permissions
- In LimeSurvey: enable the API and select JSON-RPC under
  **Configuration > Global settings > Interfaces**

### Option A: npm

```bash
npx -y limesurvey-mcp-server@latest
```

The server uses stdio by default. Supply credentials through the MCP client
configuration shown below. `@latest` receives the newest release whenever the
MCP process starts; pin an exact version (for example
`limesurvey-mcp-server@1.4.0`) for reproducible deployments.

> **`npx` prefers an existing global installation** over a registry download,
> even a broken or outdated one, so `@latest` does not update a machine that
> also has the package installed globally. If the server fails to start, see
> [Troubleshooting](docs/INSTALLATION.md#troubleshooting).

### Option B: from source

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
npm ci
npm test
```

### Option C: Docker

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
cp .env.example .env
# Edit .env and use a long random MCP_HTTP_BEARER_TOKEN.
docker compose up --build -d
```

Compose binds `127.0.0.1:3000`, starts in read-only mode, and stores exports and
theme packages in separate named volumes.

See [Installation and Updates](docs/INSTALLATION.md) for Codex CLI, Claude
Desktop, global npm, source, Docker, verification, update, and removal steps.

## Configuration

Required:

| Variable | Description |
|---|---|
| `LIMESURVEY_URL` | Exact RemoteControl URL, for example `https://survey.example.com/index.php/admin/remotecontrol` |
| `LIMESURVEY_USERNAME` | LimeSurvey service account |
| `LIMESURVEY_PASSWORD` or `LIMESURVEY_PASSWORD_FILE` | Service account password, or the path to a file that holds only the password (UTF-8 without BOM). If both are set, the file wins and `LIMESURVEY_PASSWORD` is ignored with a startup warning |

Important optional variables:

| Variable | Default | Description |
|---|---:|---|
| `LIMESURVEY_AUTH_PLUGIN` | `Authdb` | LimeSurvey authentication plugin |
| `LIMESURVEY_WRITE_SCOPE` | unset (= `outreach`, everything allowed) | `none`, `content`, `lifecycle`, or `outreach`; blocks every tool above the chosen level before any file read or RPC call (see [Write Safety](#write-safety)) |
| `LIMESURVEY_READ_ONLY` | `false` | `true` equals `LIMESURVEY_WRITE_SCOPE=none`; when both are set the stricter level wins and a startup warning is printed |
| `LIMESURVEY_TIMEOUT_MS` | `30000` | RemoteControl request timeout |
| `LIMESURVEY_MAX_RESPONSE_CHARS` | `50000` | Maximum inline result size |
| `LIMESURVEY_EXPORT_DIR` | unset | Dedicated output directory for decoded exports |
| `LIMESURVEY_MAX_EXPORT_BYTES` | `104857600` | Maximum decoded export size |
| `LIMESURVEY_IMPORT_DIR` | unset (falls back to `LIMESURVEY_EXPORT_DIR`) | Dedicated input directory for `import_data_path` reads |
| `LIMESURVEY_MAX_IMPORT_BYTES` | `52428800` | Maximum file size accepted via `import_data_path` |
| `LIMESURVEY_THEME_DIR` | unset | Dedicated output directory for generated theme ZIPs |
| `LIMESURVEY_MAX_THEME_ASSET_BYTES` | `5242880` | Maximum logo and theme entry size |
| `LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS` | `false` | Enable non-standard `list_response_exports` |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | Streamable HTTP bind address |
| `MCP_HTTP_PORT` | `3000` | Streamable HTTP port |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP endpoint |
| `MCP_HTTP_BEARER_TOKEN` | unset | Required for every non-loopback HTTP binding |
| `MCP_HTTP_ALLOWED_HOSTS` | unset | Comma-separated exact Host allowlist |
| `MCP_HTTP_ALLOWED_ORIGINS` | unset | Comma-separated exact browser Origin allowlist |

The server intentionally does not load `.env` itself. The MCP client, process
manager, or container runtime owns secret injection.

### Keeping the password out of the client configuration

With `LIMESURVEY_PASSWORD_FILE` the password lives in a file that only your own
account can read, instead of in the MCP client configuration (which is often a
readable JSON file or a shell command that ends up in the history). The server
reads the file once at start-up, removes a UTF-8 BOM and the trailing line
ending, and rejects an empty file, invalid UTF-8, and UTF-16 (what Windows
PowerShell 5.1 writes with `>` or `Out-File`). It never prints the password or
any part of it: error messages name only the variable and the path, and
`limesurvey_get_instance_info` reports just `password_source` (`file` or
`env`). On POSIX systems a start-up warning appears when the file is readable
by group or others (`chmod 600`); on Windows restrict the file with `icacls`.
Step-by-step commands that never put the password into a command line:
[Store the password in a file](docs/INSTALLATION.md#store-the-password-in-a-file).
After switching, remove `LIMESURVEY_PASSWORD` from the client configuration.

## MCP Client Setup

Codex CLI:

```powershell
codex mcp add limesurvey `
  --env "LIMESURVEY_URL=https://survey.example.com/index.php/admin/remotecontrol" `
  --env "LIMESURVEY_USERNAME=rpc-user" `
  --env "LIMESURVEY_PASSWORD=replace-me" `
  --env "LIMESURVEY_WRITE_SCOPE=content" `
  -- npx -y limesurvey-mcp-server@latest
```

`content` lets an assistant build and correct surveys; use `none` for read-only
access (see [Write Safety](#write-safety)).

Example for clients that support `mcpServers` configuration:

```json
{
  "mcpServers": {
    "limesurvey": {
      "command": "npx",
      "args": ["-y", "limesurvey-mcp-server@latest"],
      "env": {
        "LIMESURVEY_URL": "https://survey.example.com/index.php/admin/remotecontrol",
        "LIMESURVEY_USERNAME": "rpc-user",
        "LIMESURVEY_PASSWORD": "replace-me",
        "LIMESURVEY_WRITE_SCOPE": "content",
        "LIMESURVEY_THEME_DIR": "C:/limesurvey-mcp/themes"
      }
    }
  }
}
```

For a local build, replace `npx` with `node` and use the absolute path to
`dist/src/index.js` as the first argument.

Restart the MCP client after changing its configuration. Then call
`limesurvey_get_session_key` and `limesurvey_list_surveys` to verify
authentication and read access before enabling writes.

## Streamable HTTP

```bash
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=3000 \
MCP_HTTP_BEARER_TOKEN='replace-with-a-long-random-token' \
npm start
```

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health endpoint: `http://127.0.0.1:3000/health`

Non-loopback bindings fail fast without a bearer token. Use a reverse proxy for
TLS and configure Host and Origin allowlists when exposing the server remotely.

## Write Safety

`LIMESURVEY_WRITE_SCOPE` limits what the server may change. The scopes are
cumulative, from narrowest to widest: `none` < `content` < `lifecycle` <
`outreach`. A tool runs only when the configured scope is at least the tool's
minimum scope. The check is enforced by the server before any file is read or
any RemoteControl request is sent, and it cannot be bypassed through MCP tool
arguments. A blocked call fails with the error code `WRITE_SCOPE_INSUFFICIENT`
and names the current scope, the required scope, and which variable set it.
Raise the scope deliberately and restart the MCP client completely; do not work
around a block by calling the RemoteControl API directly.

- Unset: everything is allowed (effective scope `outreach`, the historical default).
- `LIMESURVEY_READ_ONLY=true` (or the legacy `READONLY_MODE=true`) equals `none`.
- If both variables are set, the stricter level wins and the server prints a
  startup warning naming both variables and the effective scope.
- For building and correcting surveys, `content` is usually the right level.

| Write scope | Tools |
|---|---|
| `none` (allowed under every scope) | `limesurvey_get_session_key`, `limesurvey_release_session_key`, `limesurvey_get_available_site_settings`, `limesurvey_get_site_settings`, `limesurvey_get_survey_properties`, `limesurvey_export_statistics`, `limesurvey_export_timeline`, `limesurvey_get_summary`, `limesurvey_get_language_properties`, `limesurvey_get_group_properties`, `limesurvey_get_question_properties`, `limesurvey_get_participant_properties`, `limesurvey_list_participants`, `limesurvey_list_groups`, `limesurvey_list_questions`, `limesurvey_list_quotas`, `limesurvey_get_quota_properties`, `limesurvey_list_surveys`, `limesurvey_list_survey_groups`, `limesurvey_list_users`, `limesurvey_export_responses`, `limesurvey_export_responses_by_token`, `limesurvey_get_response_ids`, `limesurvey_get_uploaded_files`, `limesurvey_get_fieldmap`, `limesurvey_find_surveys`, `limesurvey_get_survey_languages`, `limesurvey_list_filtered_participants`, `limesurvey_get_participant_table_status`, `limesurvey_validate_participants`, `limesurvey_list_response_export_formats`, `limesurvey_get_instance_info`, `limesurvey_list_installed_themes`; local-only tools that read the instance and write only into their configured directory: `limesurvey_export_responses_to_file`, `limesurvey_export_responses_by_token_to_file`, `limesurvey_export_statistics_to_file`, `limesurvey_export_survey_to_file`, `limesurvey_verify_survey_against_lss`, `limesurvey_generate_survey_theme`, `limesurvey_validate_survey_theme`, `limesurvey_get_theme_publication_guide` |
| `content` | `limesurvey_import_survey`, `limesurvey_import_group`, `limesurvey_import_question`, `limesurvey_add_survey`, `limesurvey_copy_survey`, `limesurvey_add_group`, `limesurvey_add_language`, `limesurvey_add_quota`, `limesurvey_set_survey_properties`, `limesurvey_set_language_properties`, `limesurvey_set_group_properties`, `limesurvey_set_question_properties`, `limesurvey_set_quota_properties`, `limesurvey_assign_survey_theme` |
| `lifecycle` | `limesurvey_activate_survey`, `limesurvey_activate_tokens`, `limesurvey_delete_survey`, `limesurvey_delete_group`, `limesurvey_delete_question`, `limesurvey_delete_language`, `limesurvey_delete_quota` |
| `outreach` | `limesurvey_add_participant`, `limesurvey_add_participants`, `limesurvey_set_participant_properties`, `limesurvey_delete_participants`, `limesurvey_invite_participants`, `limesurvey_remind_participants`, `limesurvey_mail_registered_participants`, `limesurvey_cpd_importParticipants`, `limesurvey_add_response`, `limesurvey_update_response`, `limesurvey_delete_response`, `limesurvey_upload_file` |

All 74 tools are listed (41 + 14 + 7 + 12). A tool that is missing from the
server's scope table is treated as `outreach`. Two calls are argument-dependent:
`limesurvey_import_survey` with `import_data_type=lsa` requires `outreach`,
because a `.lsa` archive activates the survey and imports participants and
responses; `lss`, `csv`, and `txt` imports stay at `content`. And
`limesurvey_invite_participants` with `dry_run=true` needs only `none`, because
it sends nothing and never calls `invite_participants` (see
[Checking an invitation run first](#checking-an-invitation-run-first)).

`content` covers every survey setting that LimeSurvey lets
`set_survey_properties` change, including start and expiry dates, notification
and administrator addresses, and public registration. Choose `none` when an
assistant should only read.

Additional confirmation literals are required for high-impact actions:

| Action | Required argument |
|---|---|
| All `delete_*` tools | `confirm_destructive_action=true` |
| Participant email tools | `confirm_send_email=true` (not needed for `limesurvey_invite_participants` with `dry_run=true`) |
| Survey activation | `confirm_activation=true` |
| Replacing an export or theme ZIP | `overwrite=true` and `confirm_overwrite=true` |
| Assigning a survey theme | `confirm_theme_assignment=true` |

These MCP-only confirmation fields are never forwarded to LimeSurvey.

## Error Hints and Write Limits

LimeSurvey's `set_*_properties` methods silently drop every key they cannot
write, and `error_code` does not exist in LimeSurvey 6.17.11. The server
therefore checks and explains instead of passing the silence through (all
lists were verified against the LimeSurvey 6.17.11 source; older releases may
differ):

- **Known non-writable keys are rejected before any request is sent** by
  `set_question_properties`, `set_group_properties`, `set_survey_properties`,
  `set_language_properties`, `set_quota_properties`, and
  `set_participant_properties`. The error has `code: "FIELD_NOT_WRITABLE"` and,
  on the top level next to `message`, `hint_code:
  "NOT_WRITABLE_VIA_REMOTECONTROL"`, a `hint` with the way around it (for
  example: question attributes, answer options, and subquestions can only be
  changed by re-importing the question or in the admin UI), and
  `writable_fields`. Unknown keys that are not on the list are not blocked,
  because releases may add columns; keys the answer does not contain are
  returned afterwards in `warnings` (`ignored_fields`, or `failed_fields` for
  fields LimeSurvey reported as not saved).
- **Localized texts are routed safely.** `question`, `help`, and `script`
  (questions) and `group_name` and `description` (groups) are moved into
  `questionl10ns[<language>]` / `questiongroupl10ns[<language>]`, using
  `data.language` (questions also the `language` parameter). Without a language
  the call fails with `LANGUAGE_REQUIRED`. This avoids LimeSurvey's legacy
  form, which resets the text field you did not send to an empty string.
- **"No data" answers are interpreted.** `No valid Data`, `No available data`,
  and `ERR_NO_DATA` carry `hint_code` `NOT_WRITABLE_VIA_REMOTECONTROL` (writes),
  `NO_PARTICIPANT_TABLE` / `NO_RESPONSE_TABLE` (`get_summary`), or `NO_DATA`
  (everything else) plus a method-specific `hint`.
- **More error shapes are detected.** An object in `status`
  (`set_participant_properties` validation errors) and `{success: false,
  message}` (`set_quota_properties`) now raise errors; `error_code` is still
  honored for newer LimeSurvey versions.

Each `set_*_properties` tool description lists its writable and non-writable
fields.

Argument errors are explicit: an unknown argument fails with
`Unknown argument: <names>. This tool accepts: <parameters>.` for every tool.
`limesurvey_get_group_properties` and `limesurvey_get_question_properties`
accept an optional MCP-only `survey_id` (never sent to LimeSurvey, whose
methods take no survey ID): the result's `sid` must match, otherwise the call
fails with `GROUP_SURVEY_MISMATCH` or `QUESTION_SURVEY_MISMATCH` instead of
silently returning another survey's object.

`limesurvey_get_language_properties` returns the `attachments` field exactly as
LimeSurvey stores it (keep it unchanged for a round trip to
`set_language_properties`) and, when `attachments` is part of the answer, adds
`attachments_parsed`: `{ <mail type>: [ { file_name, url, size, relevance } ] }`.
LimeSurvey stores a JSON string since DB version 647; older instances hold a PHP
serialize string; both are parsed. An empty value gives `{}`, an unparsable one
`null` plus the warning `ATTACHMENTS_UNPARSEABLE`. Requested property names that
are not a column are dropped silently by LimeSurvey; the server lists them in the
warning `UNKNOWN_FIELDS` (`unknown_fields`).

`limesurvey_get_participant_table_status` answers "does this survey have a
participant table, and is access closed?" without guessing: `exists` and
`participant_count` come from `get_summary(token_count)`, and
`survey_is_closed_access` follows the survey property `access_mode` (`C`) where
the release has it, otherwise the participant table
(`closed_access_basis` names which). The survey property `usetokens` is not
evaluated by LimeSurvey 6.17.11 and says nothing about either. A `get_summary`
answer "No available data" is reported as `NO_PARTICIPANT_TABLE` (no participant
table; access follows `access_mode`) or `NO_RESPONSE_TABLE` (survey not active:
never activated or deactivated).

An empty list is not an error: when `list_surveys`, `list_survey_groups`,
`list_users`, `list_groups`, `list_questions`, `list_quotas`, or
`list_participants` find nothing, LimeSurvey answers with a status text such as
`No surveys found`; the server returns `[]` for exactly these methods and
texts. Other statuses, such as `Error: No survey participant list` (no
participant table), stay errors.

## Checking an invitation run first

`limesurvey_invite_participants` with `dry_run=true` sends nothing and never
calls `invite_participants`. It reads the participants (`list_participants`) and
simulates the selection of LimeSurvey 6.17.11, so you see before the real run who
would be mailed and why the others would not. `send_email=false` is not a
preview: in LimeSurvey it means "resend the invitation only to participants who
were already invited" and mails them. `confirm_send_email` is not needed for a
dry run, and a dry run is allowed under every write scope.

The report contains:

- `would_receive` (`tid`, `email`, `firstname`, `lastname`) in sending order;
- `would_not_receive` (`tid`, `email`, `reasons`, optional `details`) with the
  reasons `completed`, `missing_token`, `missing_email`, `already_invited`
  (`send_email=true`, participant was invited) or `not_invited_yet`
  (`send_email=false`), `emailstatus_not_ok` (the value is in `details`),
  `invalid_email_address`, `not_valid_yet` (`validfrom` is after the server
  time), `expired` (`validuntil` is before it), `not_selected` (`token_ids` set,
  `tid` not in it; these participants are only counted, never listed one by
  one), and `beyond_maxemails` (only when `maxemails` could be read);
- without `continue_on_error`: `stops_at_tid`, the first participant whose
  validity window fails (LimeSurvey stops sending there), and `not_reached`;
- `warnings` (blanks at the edges, duplicate addresses among the recipients),
  `limitations`, `time_basis`, and `borderline` (validity limits within 60
  minutes of the server time);
- `counts` with the full numbers (`would_receive`, `would_not_receive`,
  `not_reached`, `not_selected`, `by_reason`).

The report stays within `LIMESURVEY_MAX_RESPONSE_CHARS` whatever the table size:
`would_receive`, `would_not_receive` and `not_reached` list at most 100 entries
each, `warnings` and `borderline` at most 25. When a list is cut,
`truncated_lists` names it with `returned` and `total`; `counts` always holds
the complete numbers. Use `token_ids` to check specific participants.

Known limits, also listed in `limitations`: the block list of the central
participant database cannot be read through RemoteControl; `maxemails` (default
50 emails per call) is readable only by super administrators; the address check
is a port of LimeSurvey's own pattern and an approximation of PHP's result; mail
transport errors cannot be simulated. RemoteControl has no clock method, so the
server time is the HTTP `Date` header of the last answer. `validfrom` and
`validuntil` are stored without a zone in the local time of the LimeSurvey
server: pass `server_utc_offset_minutes` (for example `120` for UTC+2), otherwise
the timezone of the machine running the MCP server is assumed (`time_basis`
reports the source).

`limesurvey_validate_participants` checks the whole participant table with the
same code before you invite: whitespace at the edges (`WHITESPACE`), duplicate
addresses (`DUPLICATE_EMAIL`, trimmed and case-insensitive) and tokens
(`DUPLICATE_TOKEN`), address format (`INVALID_EMAIL`), `NOT_YET_VALID`,
`EXPIRED`, `INVALID_VALIDITY_RANGE`, `EMAILSTATUS_NOT_OK`, `MISSING_EMAIL`, and
`MISSING_TOKEN`. It returns `issues` (`tid`, `field`, `code`, `detail`) and
`counts_by_code`. The answer is bound to `LIMESURVEY_MAX_RESPONSE_CHARS`: when
there are too many issues, `issues` and `borderline` are cut to fit and marked
with `issues_truncated`, `issues_total`, `issues_returned` and a
`truncation_note`; `counts_by_code`, `participant_count` and `time_basis` are
always complete.

## Responsive Survey Themes

The theme generator was verified on **2026-07-22** against the current
**LimeSurvey CE 7.0.5** release, and on **2026-07-24** against the official
**vanilla 3.0.1** ("Bootstrap Vanilla") manifest. LimeSurvey 7 is the default
target; LimeSurvey 6 can be selected explicitly.

Generated themes:

- inherit the installed `vanilla` core theme instead of copying it — `vanilla`
  is the minimal official base theme shipped and installed with every
  LimeSurvey instance, so generated themes no longer depend on
  `fruity_twentythree` being present;
- contain responsive CSS, fixed mobile breakpoints, print styles, visible focus,
  reduced-motion support, and minimum 44 px controls;
- validate WCAG contrast for body, muted, focus, and primary-button colors;
- use local system font stacks with no third-party font requests;
- contain no JavaScript, tracking, remote CSS imports, or data URLs;
- optionally include a signature-checked PNG or JPEG logo;
- are licensed **GPL-2.0-or-later**, matching the inherited LimeSurvey theme.

Recommended tool sequence:

1. `limesurvey_generate_survey_theme`
2. `limesurvey_validate_survey_theme`; continue only with `valid=true`
3. `limesurvey_get_theme_publication_guide` using the installed version shown in LimeSurvey
4. Import the ZIP under **Configuration > Advanced > Themes > Survey themes**
5. Test an inactive survey on phone, tablet, desktop, keyboard, zoom, RTL, and print
6. `limesurvey_assign_survey_theme` with `confirm_theme_assignment=true`

See [Survey Theme Guide](docs/SURVEY_THEMES.md) for complete examples,
acceptance criteria, Cloud restrictions, community publication, and rollback.

## Secure File Exports

File export tools require `LIMESURVEY_EXPORT_DIR`. File names cannot contain
directories, traversal segments, or null bytes. The server enforces decoded size
limits, creates restrictive files, refuses replacement by default, and returns
the path, size, MIME type, and SHA-256 digest instead of base64 content.

The original RemoteControl export methods remain available for compatibility.
Oversized inline responses are replaced by a marked preview that is not a valid
export file.

## Secure File Imports

`limesurvey_import_survey`, `limesurvey_import_group`, and
`limesurvey_import_question` accept an `import_data_path` argument as an
alternative to inline `import_data`. Set exactly one of the two; the server
reads the file at `import_data_path` from `LIMESURVEY_IMPORT_DIR` (falling
back to `LIMESURVEY_EXPORT_DIR` when unset) and base64-encodes it itself, so a
survey file of any size can be imported with a single tool call instead of an
inline base64 payload. Use `import_data_path` for files at or above roughly
50 KB; reserve inline `import_data` for small files under 200,000 characters
of base64 text.

The path is resolved and checked the same way as export file names: it must
stay inside the configured import directory. Oversized files, missing files,
paths outside the directory, and conflicting/missing parameters all fail with
a distinct error `code` (`IMPORT_FILE_TOO_LARGE`, `IMPORT_FILE_NOT_FOUND`,
`IMPORT_PATH_OUTSIDE_DIR`, `IMPORT_PARAM_CONFLICT`,
`IMPORT_PAYLOAD_TOO_LARGE`, `IMPORT_DIR_NOT_CONFIGURED`) plus a `recovery`
hint. Changing `LIMESURVEY_IMPORT_DIR` or `LIMESURVEY_MAX_IMPORT_BYTES`
requires a full restart of the MCP client process; reconnecting alone does not
reload environment variables.

`import_survey` returns the survey ID LimeSurvey actually used: it keeps the
ID embedded in the file when that ID is free, `destination_survey_id`
overrides it when set, and on an ID collision LimeSurvey silently assigns a
random 6-digit `sid` instead of failing.

## Capability Detection

The server prints a startup preflight to stderr for every optional directory
(`LIMESURVEY_EXPORT_DIR`/`LIMESURVEY_IMPORT_DIR`/`LIMESURVEY_THEME_DIR`) that
is not configured, naming the tools that stay disabled until it is set and
that changing it requires a full restart.

`limesurvey_get_instance_info` makes **no RemoteControl call** by default: it
reports `server_version`, `instance_host` (host only, never credentials),
`password_source` (`file` or `env`; never the path or the content),
`transport`, `read_only` (true only for write scope `none`), `write_scope` and
`write_scope_source` (`default`, `LIMESURVEY_WRITE_SCOPE` or
`LIMESURVEY_READ_ONLY`), `experimental_methods_enabled`, per-directory
`{configured, path, exists, writable}` checks, and a `capabilities` summary.
`capabilities` stays a map of booleans (`import_via_path`,
`export_survey_to_file`, `list_installed_themes`, `theme_generation`,
`theme_assignment`, `content_changes`, `lifecycle_changes`,
`participant_outreach`, `file_exports`), computed after the write scope and
the configured directories. `capability_blocked_by` has exactly the same keys
and holds `null` when a capability is available, otherwise the reason (the
required and current write scope with its source, and/or the missing environment
variable; several reasons are joined with `; `).
Set `probe_instance=true` to additionally call `list_surveys` (connectivity/
auth proof, count only) and `get_site_settings("versionnumber")`, which
requires a superadmin service account and degrades to
`permission_level: "standard"` with `instance_version: null` otherwise. The
probe also fills `server_time` (ISO-8601 UTC) and `server_time_source`
(`"http_date_header"`); without it both are `null` and `server_time_hint` says to
use `probe_instance=true`. `server_time_note` states that this is the web
server's clock in UTC, not a time zone (the PHP time zone is not readable
through RemoteControl). Call this before relying on
file export/import or theming tools.

### Limits of RemoteControl

These gaps are in LimeSurvey 6.17.11 itself (verified against its source), not
in this server:

- No mail send log. The delivery state is only visible in the participant
  fields `sent`, `remindersent`, `remindercount`, and `emailstatus`.
- No list of the survey's uploaded files (attachments, images).
  `get_uploaded_files` only returns files that respondents uploaded in file
  upload questions. `get_language_properties` shows which server paths the mail
  attachments reference.
- No clock method. The server time is only available from the HTTP `Date`
  header (`get_instance_info` with `probe_instance=true`). The server's PHP time
  zone is not readable through RemoteControl. Only the `timeadjust` offset (hours
  between web server time and local time) is readable, and only by superadmins
  through `get_site_settings('timeadjust')`.

`limesurvey_list_installed_themes` combines two best-effort signals, since
RemoteControl2 has no official method to enumerate installed themes:
`generated_packages` lists ZIPs/folders already generated locally in
`LIMESURVEY_THEME_DIR`, and `themes_in_use` lists the distinct `template`
values actually assigned to up to `survey_scan_limit` visible surveys (via
`list_surveys` + `get_survey_properties`), which works without a superadmin
account — `"inherit"` is tracked separately as `inherit_count`, not as a
theme. The response always includes the documented admin-UI fallback
(Configuration > Themes) for the complete list.

## Experimental Extension

`list_response_exports` is not part of the official RemoteControl method list.
Its workflow tool is disabled unless the matching LimeSurvey extension is
installed and `LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS=true` is set.

`limesurvey_export_survey_to_file` is likewise experimental: core LimeSurvey 6
RemoteControl has neither `export_survey` nor `export_survey_structure`
(verified against the LimeSurvey 6.17.11 source). The tool requires
`LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS=true`, asks
`export_survey_structure` first and `export_survey` second, and only succeeds if
a plugin on the LimeSurvey side serves one of them; otherwise it fails with a
structured `EXPORT_UNSUPPORTED` error that lists why each method failed.

State of the art as of 2026-10-11 (research, see the CHANGELOG): there is **no
verified LimeSurvey 6.x plugin** that exports a `.lss` over RemoteControl. The
`extendRemoteControl` plugin only offers demo functions and declares LimeSurvey
3/4; `RemoteManageResponse` and `rcAddReponseCode` only handle responses; the
REST API (`survey-detail`) returns the editor's JSON model, not an `.lss`. The
RemoteControl handler class itself cannot be extended by a plugin, but a plugin
can answer additional methods on the core URL (the `replaceDefaultLink` pattern
of `RemoteManageResponse`), so an own small plugin offering
`export_survey_structure(sessionKey, surveyId)` returning the base64 `.lss`
works with this tool. Upstream, LimeSurvey pull request #5384 (bug #17747, open,
targeting the 7.x line) adds exactly that method.

Without an export, use `limesurvey_verify_survey_against_lss` (next section).

## Comparing a Survey with a `.lss` File

`limesurvey_verify_survey_against_lss(survey_id, lss_path[, language])` is a
read-only tool (write scope `none`) for checking an import or a hand-edited
survey against its source file. `lss_path` must point to a file inside
`LIMESURVEY_IMPORT_DIR` (or `LIMESURVEY_EXPORT_DIR` as a fallback; same path
check and size limit as `import_data_path`). The file is read locally; the live
survey is read with `list_groups`, `list_questions`, and
`get_question_properties` only.

Groups (name and order), questions (code, type, mandatory, relevance, other,
text, help, position), subquestions, answer options, and question attributes
are matched by code, never by ID, because IDs change on import. The result has
`summary` (counts per area and `attributes.missing_in_live`, `extra_in_live`,
`changed`), `differences` (`kind`, `group`, `question`, `item`, `field`, `lss`,
`live`), `differences_total`, `truncated` (at most 500 differences are listed,
never cut silently), and `limitations` (conditions, quotas, assessments, default
values, and survey settings are not compared). `language` defaults to the base
language of the live survey. Both the LimeSurvey 6 file layout and older
exports with the texts in the entity rows are read.

## Development

```bash
npm ci
npm test
npm run inspect
npm pack --dry-run
```

The 39 automated tests use mocked LimeSurvey JSON-RPC responses and cover:

- JSON-RPC 1.0 ordering, session reuse, renewal, and secret handling
- MCP handshake, schemas, annotations, confirmations, and read-only enforcement
- Streamable HTTP bearer authentication and session isolation
- workflow filtering and secure export files
- survey theme ZIP generation, validation, publication guidance, and assignment
- secure file imports via `import_data_path` for survey, group, and question tools
- environment preflight warnings (`envPreflightWarnings`)
- capability detection (`get_instance_info` with and without `probe_instance`,
  `list_installed_themes`) and the experimental, permission-degrading
  `export_survey_to_file` tool

No live LimeSurvey credentials are required. Content evaluations must be created
against a stable test instance; see [evaluations/README.md](evaluations/README.md).

An opt-in live integration runner exercises all 74 tools against disposable,
prefixed test records:

```bash
npm run test:live
```

It requires explicit environment confirmation and an external official
LimeSurvey fixture checkout. Never run it against a production instance.
`cpd_importParticipants` has no matching RemoteControl delete method, so the
runner reports the uniquely named central participant for manual removal. See
[Live Integration Testing](docs/LIVE_TESTING.md).

## Project Structure

```text
src/
  client.ts             JSON-RPC client and session handling
  config.ts             environment validation and secure defaults
  tool-definitions.ts   56 official RemoteControl tools
  workflow-tools.ts     survey, participant, and export workflows
  theme-tools.ts        theme generator, validator, guide, and assignment
  server.ts             MCP registration and central safety enforcement
  http-server.ts        authenticated Streamable HTTP transport
  index.ts              stdio/HTTP entry point
test/                   mocked unit, protocol, transport, workflow, and theme tests
scripts/                opt-in guarded live integration test
docs/                   detailed operational documentation
```

## Compatibility

- Node.js 20, 22, and 24 are tested in CI.
- RemoteControl uses JSON-RPC 1.0 positional parameters as required by LimeSurvey.
- Theme generation supports LimeSurvey 7.x and 6.x with `vanilla`; always
  validate against the exact installed patch release.
- LimeSurvey Cloud may restrict custom theme import by account or plan. The MCP
  server does not attempt unsupported filesystem installation.

## Security

Read [SECURITY.md](SECURITY.md) before remote deployment. Report vulnerabilities
privately via [GitHub private vulnerability reporting](https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/security/advisories/new),
not through public issues.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CHANGELOG.md](CHANGELOG.md).

## License

The MCP server source code is licensed under the [MIT License](LICENSE),
Copyright (c) 2026 Wagner-Emden IT Services.

Survey theme ZIPs generated by the server are separately marked and licensed
under **GPL-2.0-or-later** because they are designed to inherit LimeSurvey's GPL
`vanilla` theme. Customer logos and other supplied assets retain their
own applicable rights and must not be redistributed without permission.

## References

- [LimeSurvey RemoteControl 2](https://www.limesurvey.org/manual/RemoteControl_2_API)
- [RemoteControl API reference](https://api.limesurvey.org/classes/remotecontrol-handle.html)
- [LimeSurvey Themes](https://www.limesurvey.org/manual/Themes/en)
- [Extension compatibility](https://www.limesurvey.org/manual/Extension_compatibility)
- [Current LimeSurvey CE downloads](https://community.limesurvey.org/downloads/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

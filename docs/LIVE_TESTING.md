# Live Integration Testing

The live integration runner exercises all 82 MCP tools against a dedicated
LimeSurvey test instance. It is intentionally separate from `npm test`, which
uses mocked JSON-RPC responses and is safe for CI.

## Safety model

- Run only against a disposable or explicitly approved test instance.
- Every survey and local artifact uses the `MCP_LIVE_TEST_` prefix.
- Survey edits and deletions are limited to records created by the current run.
- Cleanup runs in a `finally` block, including surveys, responses, participants,
  generated exports, and generated theme ZIPs.
- No credentials, session keys, response contents, or existing survey titles
  are included in the JSON report.
- The runner refuses to start without the exact confirmation literal.

The `cpd_importParticipants` method is the only cleanup exception. LimeSurvey
RemoteControl can import central participants but does not expose a matching
delete method. The final JSON report lists the unique `@example.invalid`
address under `manual_cleanup` for deletion in LimeSurvey's central participant
management screen.

## Prerequisites

- A dedicated LimeSurvey instance with JSON-RPC enabled.
- A dedicated Super Administrator service account.
- An official LimeSurvey source checkout matching the installed major version.
- A configured local export and theme directory.

The runner currently uses these official fixture paths:

```text
docs/demosurveys/ls7_Samplesurvey_en_de.lss
tests/data/file_upload/limesurvey_group_472.lsg
tests/data/surveys/limesurvey_question_import_question_test.lsq
```

LimeSurvey 6 source trees do not ship `docs/demosurveys` (it exists in the
LimeSurvey 7 tree). For a LimeSurvey 6 test instance, place a sample survey
exported from LimeSurvey 6 (`.lss`, base language `en`) at
`docs/demosurveys/ls7_Samplesurvey_en_de.lss` below
`LIMESURVEY_LIVE_FIXTURE_ROOT`, or the fixture check fails before any test data
is created.

Besides the individual tools, the runner exercises the participant checks: the
read-only `limesurvey_validate_participants` and `limesurvey_invite_participants`
with `dry_run=true`, which must not send any mail and must not call the
RemoteControl method `invite_participants`.

The spec tools are exercised on a separate two-language test survey created by
`limesurvey_create_survey_from_spec` (with a type `:` question): it is read with
`limesurvey_get_survey_spec`, a question and a group are inserted, one question
gets one more answer through `limesurvey_update_question_from_spec` (dry run, then
the real run with the reported acknowledgements), and texts are changed with
`limesurvey_update_survey_texts`. The survey is deleted in the cleanup.

`limesurvey_replace_question` is exercised on the inactive test survey: it
replaces the imported test question with the same `.lsq` fixture (the new
question must keep the code and the position of the old one, and the old
question ID must be gone). It is also part of the live check before a release,
against the local LimeSurvey 6.17.11 instance only.

## Environment

Set credentials in the process environment, not in source files or shell
history committed to the repository:

```text
LIMESURVEY_URL=https://survey.example.com/index.php/admin/remotecontrol
LIMESURVEY_USERNAME=mcp-live-test
LIMESURVEY_PASSWORD=replace-me
LIMESURVEY_AUTH_PLUGIN=Authdb
LIMESURVEY_WRITE_SCOPE=outreach
LIMESURVEY_EXPORT_DIR=./exports
LIMESURVEY_THEME_DIR=./themes
LIMESURVEY_LIVE_FIXTURE_ROOT=/path/to/LimeSurvey
LIMESURVEY_LIVE_TEST_EMAIL=mcp-live-test@example.invalid
LIMESURVEY_LIVE_TEST_CONFIRM=I_UNDERSTAND_THIS_CREATES_AND_DELETES_TEST_DATA
```

`LIMESURVEY_LIVE_TEST_EMAIL` receives invitation, reminder, and registration
test messages. Use a controlled mailbox or an intentionally non-routable
address according to the purpose of the test.

## Run

```bash
npm run test:live
```

Success requires:

- `unique_tools_exercised` equals `82`;
- `failed` equals `0`;
- `untested_tools` equals `0`.

Review `manual_cleanup` even after a successful run. Also verify that no surveys
with the reported `run` prefix remain before ending the test window.

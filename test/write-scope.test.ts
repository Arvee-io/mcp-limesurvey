import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { envPreflightWarnings, loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

type Scope = "none" | "content" | "lifecycle" | "outreach";
const rank: Record<Scope, number> = { none: 0, content: 1, lifecycle: 2, outreach: 3 };

const baseEnv = {
  LIMESURVEY_URL: "https://survey.example.test/index.php/admin/remotecontrol",
  LIMESURVEY_USERNAME: "rpc-user",
  LIMESURVEY_PASSWORD: "secret",
};

function envConfig(extra: Record<string, string> = {}): LimeSurveyConfig {
  return loadConfig({ ...baseEnv, ...extra });
}

async function connected(config: LimeSurveyConfig) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-1" : true;
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "write-scope-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    async close() {
      await client.close();
      await created.server.close();
    },
  };
}

function errorResult(structured: unknown): Record<string, unknown> {
  return ((structured as { result?: Record<string, unknown> } | undefined)?.result ?? {});
}

const importArgs = { import_data: "AAAA", import_data_type: "lss" };

test("[S-01] WRITE_SCOPE=content lets content tools reach the RPC and rejects lifecycle tools without any RPC", async () => {
  const session = await connected(envConfig({ LIMESURVEY_WRITE_SCOPE: "content" }));
  try {
    const imported = await session.client.callTool({ name: "limesurvey_import_survey", arguments: importArgs });
    assert.equal(imported.isError, undefined, JSON.stringify(imported.structuredContent));
    assert.ok(session.requests.some((request) => request.method === "import_survey"));

    const before = session.requests.length;
    const deleted = await session.client.callTool({
      name: "limesurvey_delete_survey",
      arguments: { survey_id: 1, confirm_destructive_action: true },
    });
    assert.equal(deleted.isError, true);
    const text = JSON.stringify(deleted.structuredContent);
    assert.match(text, /WRITE_SCOPE_INSUFFICIENT/);
    assert.match(text, /content/);
    assert.match(text, /lifecycle/);
    assert.equal(session.requests.length, before);
  } finally {
    await session.close();
  }
});

test("[S-01] the rejection explains source, restart and the no-bypass rule", async () => {
  const session = await connected(envConfig({ LIMESURVEY_WRITE_SCOPE: "content" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_add_response",
      arguments: { survey_id: 1, response: { Q1: "a" } },
    });
    assert.equal(response.isError, true);
    const result = errorResult(response.structuredContent);
    assert.equal(result.code, "WRITE_SCOPE_INSUFFICIENT");
    const message = String(result.message);
    assert.match(message, /LIMESURVEY_WRITE_SCOPE=content/);
    assert.match(message, /outreach/);
    assert.match(message, /restart/i);
    assert.match(message, /RemoteControl/);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.tool, "limesurvey_add_response");
    assert.equal(details.current_scope, "content");
    assert.equal(details.required_scope, "outreach");
    assert.equal(details.scope_source, "LIMESURVEY_WRITE_SCOPE");
  } finally {
    await session.close();
  }
});

test("[S-01] READ_ONLY maps to scope none", async () => {
  for (const env of [{ LIMESURVEY_READ_ONLY: "true" }, { READONLY_MODE: "true" }]) {
    const config = envConfig(env);
    assert.equal(config.readOnly, true);
    const session = await connected(config);
    try {
      const response = await session.client.callTool({
        name: "limesurvey_add_survey",
        arguments: { survey_id: 0, title: "T", language: "en" },
      });
      assert.equal(response.isError, true);
      const result = errorResult(response.structuredContent);
      assert.equal(result.code, "WRITE_SCOPE_INSUFFICIENT");
      assert.match(String(result.message), /LIMESURVEY_READ_ONLY/);
      const details = result.details as Record<string, unknown>;
      assert.equal(details.current_scope, "none");
      assert.equal(details.required_scope, "content");
      assert.equal(details.scope_source, "LIMESURVEY_READ_ONLY");
      assert.deepEqual(session.requests, []);
    } finally {
      await session.close();
    }
  }
});

test("[S-01] both READ_ONLY=true and WRITE_SCOPE set: stricter scope wins and preflight warns", async () => {
  const config = envConfig({ LIMESURVEY_READ_ONLY: "true", LIMESURVEY_WRITE_SCOPE: "outreach" });
  assert.equal(config.readOnly, true);
  const warnings = envPreflightWarnings(config).filter(
    (warning) => warning.includes("LIMESURVEY_READ_ONLY") && warning.includes("LIMESURVEY_WRITE_SCOPE"),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /none/);
  const session = await connected(config);
  try {
    const response = await session.client.callTool({
      name: "limesurvey_add_survey",
      arguments: { survey_id: 0, title: "T", language: "en" },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /WRITE_SCOPE_INSUFFICIENT/);
    assert.deepEqual(session.requests, []);
  } finally {
    await session.close();
  }
});

test("[S-01] READ_ONLY=false with a narrower WRITE_SCOPE keeps the narrower scope and warns", async () => {
  const config = envConfig({ LIMESURVEY_READ_ONLY: "false", LIMESURVEY_WRITE_SCOPE: "lifecycle" });
  assert.equal(config.readOnly, false);
  assert.ok(envPreflightWarnings(config).some(
    (warning) => warning.includes("LIMESURVEY_READ_ONLY") && warning.includes("LIMESURVEY_WRITE_SCOPE") && warning.includes("lifecycle"),
  ));
  const session = await connected(config);
  try {
    const response = await session.client.callTool({
      name: "limesurvey_add_response",
      arguments: { survey_id: 1, response: { Q1: "a" } },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /WRITE_SCOPE_INSUFFICIENT/);
    assert.deepEqual(session.requests, []);
  } finally {
    await session.close();
  }
});

test("[S-01] a single variable produces no scope conflict warning", () => {
  for (const env of [{ LIMESURVEY_READ_ONLY: "true" }, { LIMESURVEY_WRITE_SCOPE: "content" }, {}]) {
    const warnings = envPreflightWarnings(envConfig(env));
    assert.ok(!warnings.some((warning) => warning.includes("LIMESURVEY_WRITE_SCOPE") && warning.includes("LIMESURVEY_READ_ONLY")));
  }
});

test("[S-01] WRITE_SCOPE is trimmed and case-insensitive; an empty value counts as unset", () => {
  const config = envConfig({ LIMESURVEY_WRITE_SCOPE: "  Lifecycle " });
  assert.equal(config.readOnly, false);
  const empty = envConfig({ LIMESURVEY_WRITE_SCOPE: "  " });
  assert.equal(empty.readOnly, false);
  assert.ok(!envPreflightWarnings(envConfig({ LIMESURVEY_READ_ONLY: "true", LIMESURVEY_WRITE_SCOPE: "" }))
    .some((warning) => warning.includes("LIMESURVEY_WRITE_SCOPE")));
});

test("[S-01] WRITE_SCOPE=none behaves like read-only", () => {
  assert.equal(envConfig({ LIMESURVEY_WRITE_SCOPE: "none" }).readOnly, true);
});

test("[S-01] an invalid WRITE_SCOPE fails at startup", () => {
  assert.throws(
    () => envConfig({ LIMESURVEY_WRITE_SCOPE: "admin" }),
    /LIMESURVEY_WRITE_SCOPE must be one of none, content, lifecycle, outreach\./,
  );
});

test("[S-01] without any setting every write tool stays allowed", async () => {
  const session = await connected(envConfig());
  try {
    const response = await session.client.callTool({
      name: "limesurvey_add_response",
      arguments: { survey_id: 1, response: { Q1: "a" } },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    assert.ok(session.requests.some((request) => request.method === "add_response"));
  } finally {
    await session.close();
  }
});

// Literal expectation: the documented minimum write scope of every registered tool.
const expectedScopes: Record<string, Scope> = {
  limesurvey_get_session_key: "none",
  limesurvey_release_session_key: "none",
  limesurvey_get_available_site_settings: "none",
  limesurvey_get_site_settings: "none",
  limesurvey_add_survey: "content",
  limesurvey_delete_survey: "lifecycle",
  limesurvey_import_survey: "content",
  limesurvey_copy_survey: "content",
  limesurvey_get_survey_properties: "none",
  limesurvey_set_survey_properties: "content",
  limesurvey_activate_survey: "lifecycle",
  limesurvey_export_statistics: "none",
  limesurvey_export_timeline: "none",
  limesurvey_get_summary: "none",
  limesurvey_add_language: "content",
  limesurvey_delete_language: "lifecycle",
  limesurvey_get_language_properties: "none",
  limesurvey_set_language_properties: "content",
  limesurvey_add_group: "content",
  limesurvey_delete_group: "lifecycle",
  limesurvey_import_group: "content",
  limesurvey_get_group_properties: "none",
  limesurvey_set_group_properties: "content",
  limesurvey_delete_question: "lifecycle",
  limesurvey_import_question: "content",
  limesurvey_get_question_properties: "none",
  limesurvey_set_question_properties: "content",
  limesurvey_activate_tokens: "lifecycle",
  limesurvey_add_participants: "outreach",
  limesurvey_delete_participants: "outreach",
  limesurvey_get_participant_properties: "none",
  limesurvey_set_participant_properties: "outreach",
  limesurvey_list_participants: "none",
  limesurvey_mail_registered_participants: "outreach",
  limesurvey_invite_participants: "outreach",
  limesurvey_remind_participants: "outreach",
  limesurvey_list_groups: "none",
  limesurvey_list_questions: "none",
  limesurvey_list_quotas: "none",
  limesurvey_add_quota: "content",
  limesurvey_delete_quota: "lifecycle",
  limesurvey_get_quota_properties: "none",
  limesurvey_set_quota_properties: "content",
  limesurvey_list_surveys: "none",
  limesurvey_list_survey_groups: "none",
  limesurvey_list_users: "none",
  limesurvey_add_response: "outreach",
  limesurvey_update_response: "outreach",
  limesurvey_delete_response: "outreach",
  limesurvey_upload_file: "outreach",
  limesurvey_export_responses: "none",
  limesurvey_export_responses_by_token: "none",
  limesurvey_get_response_ids: "none",
  limesurvey_get_uploaded_files: "none",
  limesurvey_get_fieldmap: "none",
  limesurvey_cpd_importParticipants: "outreach",
  limesurvey_find_surveys: "none",
  limesurvey_get_survey_languages: "none",
  limesurvey_add_participant: "outreach",
  limesurvey_list_filtered_participants: "none",
  limesurvey_get_participant_table_status: "none",
  limesurvey_validate_participants: "none",
  limesurvey_list_response_export_formats: "none",
  limesurvey_export_responses_to_file: "none",
  limesurvey_export_responses_by_token_to_file: "none",
  limesurvey_export_statistics_to_file: "none",
  limesurvey_get_instance_info: "none",
  limesurvey_export_survey_to_file: "none",
  limesurvey_verify_survey_against_lss: "none",
  limesurvey_generate_survey_theme: "none",
  limesurvey_validate_survey_theme: "none",
  limesurvey_get_theme_publication_guide: "none",
  limesurvey_assign_survey_theme: "content",
  limesurvey_list_installed_themes: "none",
  limesurvey_replace_question: "content",
  limesurvey_validate_spec: "none",
  limesurvey_get_survey_spec: "none",
  limesurvey_create_survey_from_spec: "content",
  limesurvey_add_question_from_spec: "content",
  limesurvey_add_group_from_spec: "content",
  limesurvey_update_question_from_spec: "content",
  limesurvey_update_survey_texts: "content",
};

// Minimal valid arguments (including confirmation literals) for every tool above "none".
const minimalArguments: Record<string, Record<string, unknown>> = {
  limesurvey_add_survey: { survey_id: 0, title: "T", language: "en" },
  limesurvey_delete_survey: { survey_id: 1, confirm_destructive_action: true },
  limesurvey_import_survey: importArgs,
  limesurvey_copy_survey: { source_survey_id: 1, new_name: "Copy" },
  limesurvey_set_survey_properties: { survey_id: 1, data: { format: "G" } },
  limesurvey_activate_survey: { survey_id: 1, confirm_activation: true },
  limesurvey_add_language: { survey_id: 1, language: "de" },
  limesurvey_delete_language: { survey_id: 1, language: "de", confirm_destructive_action: true },
  limesurvey_set_language_properties: { survey_id: 1, data: { surveyls_title: "T" } },
  limesurvey_add_group: { survey_id: 1, title: "G" },
  limesurvey_delete_group: { survey_id: 1, group_id: 1, confirm_destructive_action: true },
  limesurvey_import_group: { survey_id: 1, import_data: "AAAA", import_data_type: "lsg" },
  limesurvey_set_group_properties: { group_id: 1, data: { language: "en", group_name: "G" } },
  limesurvey_delete_question: { question_id: 1, confirm_destructive_action: true },
  limesurvey_import_question: { survey_id: 1, group_id: 1, import_data: "AAAA", import_data_type: "lsq" },
  limesurvey_set_question_properties: { question_id: 1, data: { mandatory: "N" } },
  limesurvey_activate_tokens: { survey_id: 1 },
  limesurvey_add_participants: { survey_id: 1, participants: [{ email: "a@example.test" }] },
  limesurvey_delete_participants: { survey_id: 1, token_ids: [1], confirm_destructive_action: true },
  limesurvey_set_participant_properties: { survey_id: 1, query: { tid: 1 }, data: { firstname: "A" } },
  limesurvey_mail_registered_participants: { survey_id: 1, confirm_send_email: true },
  limesurvey_invite_participants: { survey_id: 1, confirm_send_email: true },
  limesurvey_remind_participants: { survey_id: 1, confirm_send_email: true },
  limesurvey_add_quota: { survey_id: 1, name: "Q", limit: 5 },
  limesurvey_delete_quota: { quota_id: 1, confirm_destructive_action: true },
  limesurvey_set_quota_properties: { quota_id: 1, data: { name: "Q" } },
  limesurvey_add_response: { survey_id: 1, response: { Q1: "a" } },
  limesurvey_update_response: { survey_id: 1, response: { id: 1, Q1: "b" } },
  limesurvey_delete_response: { survey_id: 1, response_id: 1, confirm_destructive_action: true },
  limesurvey_upload_file: { survey_id: 1, field_name: "Q1", file_name: "a.txt", file_content: "AAAA" },
  limesurvey_cpd_importParticipants: { participants: [{ email: "a@example.test" }] },
  limesurvey_add_participant: { survey_id: 1, participant: { email: "a@example.test" } },
  limesurvey_assign_survey_theme: { survey_id: 1, theme_name: "acme_theme", confirm_theme_assignment: true },
  limesurvey_replace_question: {
    survey_id: 1,
    question_id: 1,
    import_data: "AAAA",
    import_data_type: "lsq",
    confirm_destructive_action: true,
  },
  // The generic mock answers import_survey with `true`, so the tool may end with an error after the RPC; the test
  // only checks that the request reaches the RPC and is not blocked by the write scope.
  limesurvey_create_survey_from_spec: {
    spec: {
      survey: { title: "T" },
      groups: [{ title: "G", questions: [{ code: "Q01", type: "S", text: "Frage" }] }],
    },
  },
  // The generic mock answers every read with `true`, so these tools may end with an error after their first RPC; it is
  // enough that a request is sent and not blocked by the write scope.
  limesurvey_add_question_from_spec: {
    survey_id: 1,
    group_id: 1,
    question: { code: "Q01", type: "S", text: "Frage" },
  },
  limesurvey_add_group_from_spec: {
    survey_id: 1,
    group: { title: "G", questions: [{ code: "Q01", type: "S", text: "Frage" }] },
  },
  // The real run (dry_run false) needs the fingerprint and the confirmation; a dry run would only need "none".
  limesurvey_update_question_from_spec: {
    survey_id: 1,
    question_id: 1,
    question: { code: "Q01", type: "S", text: "Frage" },
    dry_run: false,
    expected_fingerprint: "0".repeat(64),
    confirm_destructive_action: true,
  },
  limesurvey_update_survey_texts: {
    survey_id: 1,
    texts: { survey: { title: "T" } },
  },
};

test("[S-01] every registered tool is gated by its documented write scope", async () => {
  assert.equal(Object.keys(expectedScopes).length, 82);
  const writeTools = Object.entries(expectedScopes).filter(([, scope]) => scope !== "none").map(([name]) => name);
  assert.deepEqual(Object.keys(minimalArguments).sort(), [...writeTools].sort());

  for (const current of ["none", "content", "lifecycle", "outreach"] as const) {
    const session = await connected(envConfig({ LIMESURVEY_WRITE_SCOPE: current }));
    try {
      const listed = await session.client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), Object.keys(expectedScopes).sort());

      for (const name of writeTools) {
        const required = expectedScopes[name] as Scope;
        const before = session.requests.length;
        const response = await session.client.callTool({ name, arguments: minimalArguments[name] ?? {} });
        const text = JSON.stringify(response.structuredContent ?? response.content);
        if (rank[required] > rank[current]) {
          assert.equal(response.isError, true, `${name} under ${current}`);
          assert.equal(errorResult(response.structuredContent).code, "WRITE_SCOPE_INSUFFICIENT", `${name} under ${current}`);
          assert.equal(session.requests.length, before, `${name} under ${current} must not send an RPC request`);
        } else {
          assert.ok(!text.includes("WRITE_SCOPE_INSUFFICIENT"), `${name} under ${current}: ${text}`);
          assert.ok(session.requests.length > before, `${name} under ${current} should reach the RPC`);
        }
      }
    } finally {
      await session.close();
    }
  }
});

test("[S-01] import_survey with import_data_type lsa needs outreach, lss stays content", async () => {
  for (const scope of ["content", "lifecycle"]) {
    const session = await connected(envConfig({ LIMESURVEY_WRITE_SCOPE: scope }));
    try {
      for (const args of [
        { import_data: "AAAA", import_data_type: "lsa" },
        { import_data_path: "does-not-exist.lsa", import_data_type: "lsa" },
      ]) {
        const response = await session.client.callTool({ name: "limesurvey_import_survey", arguments: args });
        assert.equal(response.isError, true, `${scope} ${JSON.stringify(args)}`);
        const result = errorResult(response.structuredContent);
        assert.equal(result.code, "WRITE_SCOPE_INSUFFICIENT");
        const details = result.details as Record<string, unknown>;
        assert.equal(details.required_scope, "outreach");
        assert.equal(details.current_scope, scope);
      }
      assert.deepEqual(session.requests, []);
      const lss = await session.client.callTool({ name: "limesurvey_import_survey", arguments: importArgs });
      assert.equal(lss.isError, undefined, JSON.stringify(lss.structuredContent));
    } finally {
      await session.close();
    }
  }
  const session = await connected(envConfig({ LIMESURVEY_WRITE_SCOPE: "outreach" }));
  try {
    const lsa = await session.client.callTool({
      name: "limesurvey_import_survey",
      arguments: { import_data: "AAAA", import_data_type: "lsa" },
    });
    assert.equal(lsa.isError, undefined, JSON.stringify(lsa.structuredContent));
    assert.ok(session.requests.some((request) => request.method === "import_survey"));
  } finally {
    await session.close();
  }
});

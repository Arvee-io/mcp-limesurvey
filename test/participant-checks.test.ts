import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const SERVER_DATE = "Sun, 11 Oct 2026 12:00:00 GMT";

const baseConfig: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "test-only-not-a-secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 500_000,
};

type Responder = (request: JsonRpcRequest) => unknown;
type Fixture = Record<string, unknown>;

function participant(tid: number, overrides: Fixture = {}, info: Fixture = {}): Fixture {
  return {
    tid,
    token: `tok${tid}`,
    participant_info: { firstname: `First${tid}`, lastname: `Last${tid}`, email: `p${tid}@example.test`, ...info },
    emailstatus: "OK",
    sent: "N",
    completed: "N",
    validfrom: null,
    validuntil: null,
    ...overrides,
  };
}

/** The table of the dry-run scenarios; the server time is 2026-10-11 12:00 UTC. */
const table: Fixture[] = [
  participant(1),
  participant(2, { sent: "2026-10-01 09:00" }),
  participant(3, { completed: "2026-10-02 10:00" }),
  participant(4, { emailstatus: "OptOut" }),
  participant(5, {}, { email: "not-an-address" }),
  participant(6, { validfrom: "2026-12-01 00:00:00" }),
  participant(7, { validuntil: "2026-09-01 00:00:00" }),
  participant(8),
];

function listParticipants(rows: Fixture[]): Responder {
  return (request) => {
    const [, , start, limit] = request.params as [string, number, number, number];
    const page = rows.filter((row) => Number(row.tid) >= start).slice(0, limit);
    return page.length > 0 ? page : { status: "No survey participants found." };
  };
}

async function connected(config: LimeSurveyConfig, responder: Responder) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-1" : responder(request);
    return new Response(JSON.stringify({ id: request.id, result, error: null }), { headers: { date: SERVER_DATE } });
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "participant-checks-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    methods: () => requests.map((request) => request.method),
    async close() {
      await client.close();
      await created.server.close();
    },
  };
}

function body(structured: unknown): Record<string, unknown> {
  return ((structured as { result?: Record<string, unknown> } | undefined)?.result ?? {});
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return value as Array<Record<string, unknown>>;
}

function reasonsOf(report: Record<string, unknown>, tid: number): string[] {
  const entry = rows(report.would_not_receive).find((item) => item.tid === tid);
  return (entry?.reasons as string[] | undefined) ?? [];
}

const siteSettings = (value: unknown): Responder => (request) =>
  request.method === "get_site_settings" ? value : listParticipants(table)(request);

test("[S-05] dry_run never reaches invite_participants, not even with send_email=false", async () => {
  const session = await connected(baseConfig, siteSettings({ status: "No permission" }));
  try {
    for (const sendEmail of [true, false]) {
      const response = await session.client.callTool({
        name: "limesurvey_invite_participants",
        arguments: { survey_id: 5, dry_run: true, send_email: sendEmail, server_utc_offset_minutes: 0 },
      });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      assert.equal(body(response.structuredContent).dry_run, true);
    }
    assert.ok(!session.methods().includes("invite_participants"), session.methods().join(","));
    for (const method of session.methods()) {
      assert.ok(["get_session_key", "list_participants", "get_site_settings"].includes(method), method);
    }
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run reports who would receive an invitation and why the others would not", async () => {
  const session = await connected(baseConfig, siteSettings({ status: "No permission" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true, server_utc_offset_minutes: 0 },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const report = body(response.structuredContent);
    assert.equal(report.participant_table_exists, true);
    assert.deepEqual(rows(report.would_receive).map((item) => item.tid), [1]);
    assert.deepEqual(rows(report.would_receive)[0], {
      tid: 1, email: "p1@example.test", firstname: "First1", lastname: "Last1",
    });
    assert.deepEqual(reasonsOf(report, 2), ["already_invited"]);
    assert.deepEqual(reasonsOf(report, 3), ["completed"]);
    assert.deepEqual(reasonsOf(report, 4), ["emailstatus_not_ok"]);
    assert.match(JSON.stringify(rows(report.would_not_receive).find((item) => item.tid === 4)), /OptOut/);
    assert.deepEqual(reasonsOf(report, 5), ["invalid_email_address"]);
    assert.deepEqual(reasonsOf(report, 6), ["not_valid_yet"]);
    // Without continue_on_error LimeSurvey stops at the first participant whose validity fails.
    assert.equal(report.stops_at_tid, 6);
    assert.deepEqual(rows(report.not_reached).map((item) => item.tid), [7, 8]);
    assert.ok(Array.isArray(report.limitations));
    assert.match(JSON.stringify(report.limitations), /CPDB|central participant/i);
    assert.equal((report.time_basis as Record<string, unknown>).server_time_utc, "2026-10-11T12:00:00.000Z");
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run with continue_on_error lists every expired and not-yet-valid participant", async () => {
  const session = await connected(baseConfig, siteSettings({ status: "No permission" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true, continue_on_error: true, server_utc_offset_minutes: 0 },
    });
    const report = body(response.structuredContent);
    assert.deepEqual(rows(report.would_receive).map((item) => item.tid), [1, 8]);
    assert.deepEqual(reasonsOf(report, 6), ["not_valid_yet"]);
    assert.deepEqual(reasonsOf(report, 7), ["expired"]);
    assert.equal(report.stops_at_tid, null);
    assert.deepEqual(report.not_reached, []);
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run with send_email=false selects only participants who were invited before", async () => {
  const session = await connected(baseConfig, siteSettings({ status: "No permission" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true, send_email: false, server_utc_offset_minutes: 0 },
    });
    const report = body(response.structuredContent);
    assert.deepEqual(rows(report.would_receive).map((item) => item.tid), [2]);
    assert.deepEqual(reasonsOf(report, 1), ["not_invited_yet"]);
    assert.ok(!session.methods().includes("invite_participants"));
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run applies a readable maxemails and names the participants beyond it", async () => {
  const session = await connected(baseConfig, siteSettings("2"));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true, continue_on_error: true, server_utc_offset_minutes: 0 },
    });
    const report = body(response.structuredContent);
    // Eligible by SQL: 1, 5, 6, 7, 8 -> the first two are taken, tid 5 then fails the address check.
    assert.deepEqual(rows(report.would_receive).map((item) => item.tid), [1]);
    assert.deepEqual(reasonsOf(report, 6), ["beyond_maxemails"]);
    assert.deepEqual(reasonsOf(report, 8), ["beyond_maxemails"]);
    assert.deepEqual(report.max_emails, { value: 2, known: true });
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run without a readable maxemails reports no beyond_maxemails reasons", async () => {
  const session = await connected(baseConfig, siteSettings({ status: "No permission" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true, continue_on_error: true, server_utc_offset_minutes: 0 },
    });
    const report = body(response.structuredContent);
    assert.ok(!JSON.stringify(report.would_not_receive).includes("beyond_maxemails"));
    assert.equal((report.max_emails as Record<string, unknown>).known, false);
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run reports a survey without a participant table", async () => {
  const session = await connected(baseConfig, () => ({ status: "Error: No survey participant list" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const report = body(response.structuredContent);
    assert.equal(report.participant_table_exists, false);
    assert.deepEqual(report.would_receive, []);
    assert.ok(!session.methods().includes("invite_participants"));
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run warns about whitespace and duplicate addresses among the recipients", async () => {
  const rowsWithProblems = [
    participant(1, {}, { email: "dup@example.test" }),
    participant(2, {}, { email: "DUP@example.test" }),
    participant(3, {}, { firstname: " Padded" }),
  ];
  const session = await connected(baseConfig, listParticipants(rowsWithProblems));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true, server_utc_offset_minutes: 0 },
    });
    const report = body(response.structuredContent);
    const codes = rows(report.warnings).map((item) => item.code);
    assert.ok(codes.includes("DUPLICATE_EMAIL"), codes.join(","));
    assert.ok(codes.includes("WHITESPACE"), codes.join(","));
  } finally {
    await session.close();
  }
});

test("[S-05] dry_run is allowed under LIMESURVEY_WRITE_SCOPE=none, the real call is blocked", async () => {
  const config = loadConfig({
    LIMESURVEY_URL: "https://survey.example.test/index.php/admin/remotecontrol",
    LIMESURVEY_USERNAME: "rpc-user",
    LIMESURVEY_PASSWORD: "test-only-not-a-secret",
    LIMESURVEY_WRITE_SCOPE: "none",
  });
  const session = await connected(config, siteSettings({ status: "No permission" }));
  try {
    const dry = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true, server_utc_offset_minutes: 0 },
    });
    assert.equal(dry.isError, undefined, JSON.stringify(dry.structuredContent));
    const before = session.requests.length;
    const real = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, confirm_send_email: true },
    });
    assert.equal(real.isError, true);
    assert.match(JSON.stringify(real.structuredContent), /WRITE_SCOPE_INSUFFICIENT/);
    assert.equal(session.requests.length, before);
  } finally {
    await session.close();
  }
});

test("[S-05] confirm_send_email is optional for dry_run and still required for a real invitation", async () => {
  const session = await connected(baseConfig, () => ({ "1": { status: "OK" }, status: "0 left to send" }));
  try {
    const unconfirmed = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5 },
    });
    assert.equal(unconfirmed.isError, true);
    assert.match(JSON.stringify(unconfirmed.content), /confirm_send_email/);
    const explicitFalse = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: false },
    });
    assert.equal(explicitFalse.isError, true);
    assert.equal(session.requests.length, 0);

    const preview = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, dry_run: true },
    });
    assert.equal(preview.isError, undefined, JSON.stringify(preview.structuredContent));
    assert.ok(!session.methods().includes("invite_participants"));

    const real = await session.client.callTool({
      name: "limesurvey_invite_participants",
      arguments: { survey_id: 5, confirm_send_email: true },
    });
    assert.equal(real.isError, undefined, JSON.stringify(real.structuredContent));
    const invite = session.requests.find((request) => request.method === "invite_participants");
    // dry_run and server_utc_offset_minutes are MCP-only: they are never part of the positional RPC parameters.
    assert.deepEqual(invite?.params, ["session-1", 5]);
  } finally {
    await session.close();
  }
});

test("[S-05] the invite_participants schema documents send_email by the LimeSurvey source and offers dry_run", async () => {
  const session = await connected(baseConfig, () => ({}));
  try {
    const { tools } = await session.client.listTools();
    const invite = tools.find((tool) => tool.name === "limesurvey_invite_participants");
    assert.ok(invite);
    assert.match(invite.description ?? "", /dry_run/);
    const properties = (invite.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    assert.ok(properties.dry_run, "dry_run must be in the input schema");
    assert.ok(properties.server_utc_offset_minutes, "server_utc_offset_minutes must be in the input schema");
    const sendEmail = properties.send_email?.description ?? "";
    assert.match(sendEmail, /already invited/i);
    assert.match(sendEmail, /resend/i);
    assert.match(sendEmail, /dry_run/);
    assert.doesNotMatch(sendEmail, /Actually send/i);
  } finally {
    await session.close();
  }
});

test("[S-05] validate_participants finds whitespace, duplicates, bad addresses, validity and status problems", async () => {
  const problems = [
    participant(1, {}, { email: " spaced@example.test" }),
    participant(2, {}, { email: "twin@example.test" }),
    participant(3, {}, { email: "Twin@Example.test " }),
    participant(4, { token: "samesame" }),
    participant(5, { token: "samesame" }),
    participant(6, {}, { email: "no-at-sign" }),
    participant(7, { validfrom: "2026-10-12 00:00:00" }),
    participant(8, { validuntil: "2026-10-10 23:59:00" }),
    participant(9, { validfrom: "2026-10-05 00:00:00", validuntil: "2026-10-01 00:00:00" }),
    participant(10, { emailstatus: "bounced" }),
    participant(11, { token: "" }),
    participant(12, {}, { email: "" }),
    participant(13),
  ];
  const session = await connected(baseConfig, listParticipants(problems));
  try {
    const listed = await session.client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "limesurvey_validate_participants"));
    const response = await session.client.callTool({
      name: "limesurvey_validate_participants",
      arguments: { survey_id: 5, server_utc_offset_minutes: 0 },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const report = body(response.structuredContent);
    assert.equal(report.survey_id, 5);
    assert.equal(report.participant_count, 13);
    assert.equal(report.server_time_utc, "2026-10-11T12:00:00.000Z");
    const issues = rows(report.issues);
    const has = (tid: number, code: string) => issues.some((item) => item.tid === tid && item.code === code);
    assert.ok(has(1, "WHITESPACE"));
    assert.ok(has(1, "INVALID_EMAIL"));
    assert.ok(has(2, "DUPLICATE_EMAIL") && has(3, "DUPLICATE_EMAIL"));
    assert.ok(has(3, "WHITESPACE"));
    assert.ok(has(4, "DUPLICATE_TOKEN") && has(5, "DUPLICATE_TOKEN"));
    assert.ok(has(6, "INVALID_EMAIL"));
    assert.ok(has(7, "NOT_YET_VALID"));
    assert.ok(has(8, "EXPIRED"));
    assert.ok(has(9, "INVALID_VALIDITY_RANGE"));
    assert.ok(has(10, "EMAILSTATUS_NOT_OK"));
    assert.ok(has(11, "MISSING_TOKEN"));
    assert.ok(has(12, "MISSING_EMAIL"));
    assert.ok(!issues.some((item) => item.tid === 13));
    for (const item of issues) {
      assert.equal(typeof item.field, "string");
      assert.equal(typeof item.detail, "string");
    }
    const counts = report.counts_by_code as Record<string, number>;
    assert.equal(counts.DUPLICATE_TOKEN, 2);
    assert.equal(counts.EXPIRED, 2);
    assert.deepEqual(session.methods().filter((method) => method !== "list_participants" && method !== "get_session_key"), []);
  } finally {
    await session.close();
  }
});

test("[S-05] the validity check uses the Date header and the given server offset", async () => {
  const timed = [participant(1, { validfrom: "2026-10-11 13:00:00" })];
  const session = await connected(baseConfig, listParticipants(timed));
  try {
    const utc = await session.client.callTool({
      name: "limesurvey_validate_participants",
      arguments: { survey_id: 5, server_utc_offset_minutes: 0 },
    });
    const utcReport = body(utc.structuredContent);
    assert.ok(rows(utcReport.issues).some((item) => item.code === "NOT_YET_VALID"));
    const timeBasis = utcReport.time_basis as Record<string, unknown>;
    assert.equal(timeBasis.offset_source, "parameter");
    assert.equal(timeBasis.assumed_server_utc_offset_minutes, 0);
    assert.equal(rows(utcReport.borderline).length, 1);

    // 13:00 in a server at UTC+2 is 11:00 UTC, one hour before the server time.
    const shifted = await session.client.callTool({
      name: "limesurvey_validate_participants",
      arguments: { survey_id: 5, server_utc_offset_minutes: 120 },
    });
    assert.deepEqual(rows(body(shifted.structuredContent).issues), []);

    const hostZone = await session.client.callTool({
      name: "limesurvey_validate_participants",
      arguments: { survey_id: 5 },
    });
    assert.equal((body(hostZone.structuredContent).time_basis as Record<string, unknown>).offset_source, "mcp_host_timezone");
  } finally {
    await session.close();
  }
});

test("[S-05] validate_participants pages through large tables by tid and runs under write scope none", async () => {
  const many = Array.from({ length: 1200 }, (_, index) => participant(index + 1));
  const config = loadConfig({
    LIMESURVEY_URL: "https://survey.example.test/index.php/admin/remotecontrol",
    LIMESURVEY_USERNAME: "rpc-user",
    LIMESURVEY_PASSWORD: "test-only-not-a-secret",
    LIMESURVEY_WRITE_SCOPE: "none",
  });
  const session = await connected(config, listParticipants(many));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_validate_participants",
      arguments: { survey_id: 5, server_utc_offset_minutes: 0 },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    assert.equal(body(response.structuredContent).participant_count, 1200);
    const starts = session.requests.filter((request) => request.method === "list_participants").map((request) => request.params[2]);
    assert.deepEqual(starts, [0, 501, 1001]);
  } finally {
    await session.close();
  }
});

test("[S-05] validate_participants on a survey without participant table reports it instead of failing", async () => {
  const session = await connected(baseConfig, () => ({ status: "Error: No survey participant list" }));
  try {
    const response = await session.client.callTool({
      name: "limesurvey_validate_participants",
      arguments: { survey_id: 5 },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const report = body(response.structuredContent);
    assert.equal(report.participant_table_exists, false);
    assert.equal(report.participant_count, 0);
  } finally {
    await session.close();
  }
});

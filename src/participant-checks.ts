import type { LimeSurveyClient } from "./client.js";
import { LimeSurveyError, type JsonValue } from "./types.js";

/**
 * Read-only participant checks: the invite_participants dry run and limesurvey_validate_participants share
 * this code. Everything here only calls list_participants and get_site_settings; it never sends email.
 *
 * The selection rules mirror LimeSurvey 6.17.11 (remotecontrol_handle.php invite_participants,
 * models/TokenDynamic.php findUninvited, helpers/admin/token_helper.php emailTokens).
 */

type JsonObject = { [key: string]: JsonValue };

export interface ParticipantRow {
  tid: number;
  token: string;
  email: string;
  firstname: string;
  lastname: string;
  emailstatus: string;
  sent: string;
  completed: string;
  validfrom: string;
  validuntil: string;
}

export type IssueCode =
  | "WHITESPACE"
  | "DUPLICATE_EMAIL"
  | "DUPLICATE_TOKEN"
  | "INVALID_EMAIL"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "INVALID_VALIDITY_RANGE"
  | "EMAILSTATUS_NOT_OK"
  | "MISSING_EMAIL"
  | "MISSING_TOKEN";

export interface Issue {
  tid: number;
  field: string;
  code: IssueCode;
  detail: string;
}

export interface TimeContext {
  nowMs: number;
  offsetMinutes: number;
  basis: JsonObject;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 400;
const ROW_ATTRIBUTES = ["emailstatus", "sent", "completed", "validfrom", "validuntil"];
const BORDERLINE_MINUTES = 60;
/** LimeSurvey's config-defaults.php value; the real value is only readable by super administrators. */
const DEFAULT_MAX_EMAILS = 50;

/**
 * Pattern of invite_participants (taken there from PHP's php_filter_validate_email) applied to every address of
 * the email field after splitting at "," and ";". It is NOT trimmed first, so an address with a blank at the
 * edge is invalid and LimeSurvey drops the participant silently.
 */
const EMAIL_PATTERN = /^(?!(?:(?:\x22?\x5C[\x00-\x7E]\x22?)|(?:\x22?[^\x5C\x22]\x22?)){255,})(?!(?:(?:\x22?\x5C[\x00-\x7E]\x22?)|(?:\x22?[^\x5C\x22]\x22?)){65,}@)(?:(?:[\x21\x23-\x27\x2A\x2B\x2D\x2F-\x39\x3D\x3F\x5E-\x7E]+)|(?:\x22(?:[\x01-\x08\x0B\x0C\x0E-\x1F\x21\x23-\x5B\x5D-\x7F]|(?:\x5C[\x00-\x7F]))*\x22))(?:\.(?:(?:[\x21\x23-\x27\x2A\x2B\x2D\x2F-\x39\x3D\x3F\x5E-\x7E]+)|(?:\x22(?:[\x01-\x08\x0B\x0C\x0E-\x1F\x21\x23-\x5B\x5D-\x7F]|(?:\x5C[\x00-\x7F]))*\x22)))*@(?:(?:(?!.*[^.]{64,})(?:(?:(?:xn--)?[a-z0-9]+(?:-+[a-z0-9]+)*\.){1,126}){1,}(?:(?:[a-z][a-z0-9]*)|(?:(?:xn--)[a-z0-9]+))(?:-+[a-z0-9]+)*)|(?:\[(?:(?:IPv6:(?:(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){7})|(?:(?!(?:.*[a-f0-9][:\]]){7,})(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,5})?::(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,5})?)))|(?:(?:IPv6:(?:(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){5}:)|(?:(?!(?:.*[a-f0-9]:){5,})(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,3})?::(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,3}:)?)))?(?:(?:25[0-5])|(?:2[0-4][0-9])|(?:1[0-9]{2})|(?:[1-9]?[0-9]))(?:\.(?:(?:25[0-5])|(?:2[0-4][0-9])|(?:1[0-9]{2})|(?:[1-9]?[0-9]))){3}))\]))$/i;

/** The addresses of an email field that LimeSurvey's invite pattern rejects (empty list = all valid). */
export function invalidAddresses(email: string): string[] {
  return email.split(/[,;]/).filter((address) => !EMAIL_PATTERN.test(address));
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function text(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseRow(value: JsonValue): ParticipantRow {
  const object = isObject(value) ? value : {};
  const info = isObject(object.participant_info) ? object.participant_info : {};
  const tid = Number(object.tid);
  if (!Number.isFinite(tid)) {
    throw new LimeSurveyError("list_participants returned a participant without a numeric tid.", "UNEXPECTED_RESPONSE", value);
  }
  return {
    tid,
    token: text(object.token),
    email: text(info.email),
    firstname: text(info.firstname),
    lastname: text(info.lastname),
    emailstatus: text(object.emailstatus),
    sent: text(object.sent),
    completed: text(object.completed),
    validfrom: text(object.validfrom),
    validuntil: text(object.validuntil),
  };
}

export interface ParticipantList {
  exists: boolean;
  rows: ParticipantRow[];
  truncated: boolean;
}

/**
 * Reads the whole participant table with list_participants. LimeSurvey's iStart is a lower bound for tid, not an
 * offset, so the next page starts at the last tid + 1.
 */
export async function fetchParticipants(client: LimeSurveyClient, surveyId: number): Promise<ParticipantList> {
  const rows: ParticipantRow[] = [];
  let start = 0;
  let truncated = false;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    let value: JsonValue;
    try {
      value = await client.call("list_participants", [surveyId, start, PAGE_SIZE, false, ROW_ATTRIBUTES, {}]);
    } catch (error) {
      if (error instanceof LimeSurveyError && /No survey participant list/i.test(error.message)) {
        return { exists: false, rows: [], truncated: false };
      }
      throw error;
    }
    if (!Array.isArray(value) || value.length === 0) break;
    const parsed = value.map(parseRow);
    rows.push(...parsed);
    const lastTid = Math.max(...parsed.map((row) => row.tid));
    if (value.length < PAGE_SIZE) break;
    if (lastTid + 1 <= start) {
      throw new LimeSurveyError("list_participants did not advance; stopping to avoid an endless loop.", "UNEXPECTED_RESPONSE");
    }
    start = lastTid + 1;
  }
  rows.sort((a, b) => a.tid - b.tid);
  return { exists: true, rows, truncated };
}

/** Naive "YYYY-MM-DD[ HH:MM[:SS]]" timestamp of the LimeSurvey server -> epoch milliseconds, or null. */
export function parseServerTimestamp(value: string, offsetMinutes: number): number | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (Number(year) === 0) return null;
  const utc = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0),
  );
  return Number.isNaN(utc) ? null : utc - offsetMinutes * 60_000;
}

/**
 * The reference for validfrom/validuntil. RemoteControl has no clock method: the HTTP Date header of the last
 * JSON-RPC answer is the server time (UTC); the naive timestamps are read in the server's local time, whose UTC
 * offset is unknown and is taken from the parameter or, failing that, from the timezone of the MCP host.
 */
export function resolveTime(client: LimeSurveyClient, offsetParameter: number | undefined): TimeContext {
  const header = client.lastServerDate;
  const nowMs = header ? header.getTime() : Date.now();
  const offsetMinutes = offsetParameter ?? 0 - new Date(nowMs).getTimezoneOffset();
  return {
    nowMs,
    offsetMinutes,
    basis: {
      server_time_utc: new Date(nowMs).toISOString(),
      server_time_source: header ? "http_date_header" : "mcp_host_clock",
      assumed_server_utc_offset_minutes: offsetMinutes,
      offset_source: offsetParameter !== undefined ? "parameter" : "mcp_host_timezone",
      note:
        (header
          ? "server_time_utc is the HTTP Date header of the last LimeSurvey answer. "
          : "The LimeSurvey answer had no Date header, so server_time_utc is the clock of the MCP host. ")
        + "validfrom and validuntil are timestamps without a zone in the local time of the LimeSurvey server; they are "
        + `read with the UTC offset above (${offsetParameter !== undefined ? "given as server_utc_offset_minutes" : "assumed: the timezone of the MCP host"}). `
        + "If the server runs in another timezone, pass server_utc_offset_minutes. Values within "
        + `${BORDERLINE_MINUTES} minutes of the current time are listed under borderline.`,
    },
  };
}

export interface Borderline {
  tid: number;
  field: "validfrom" | "validuntil";
  value: string;
  minutes_from_server_time: number;
}

/** Row-level checks plus the duplicate checks across all rows. */
export function checkRows(rows: ParticipantRow[], time: TimeContext): { issues: Issue[]; borderline: Borderline[] } {
  const issues: Issue[] = [];
  const borderline: Borderline[] = [];
  const add = (row: ParticipantRow, field: string, code: IssueCode, detail: string) =>
    issues.push({ tid: row.tid, field, code, detail });

  for (const row of rows) {
    for (const field of ["email", "firstname", "lastname", "token"] as const) {
      const value = row[field];
      if (value !== value.trim()) {
        add(row, field, "WHITESPACE", `${field} has leading or trailing whitespace: ${JSON.stringify(value)}.`);
      }
    }
    if (row.email.trim() === "") add(row, "email", "MISSING_EMAIL", "The participant has no email address and is never invited.");
    else {
      const bad = invalidAddresses(row.email);
      if (bad.length > 0) {
        add(row, "email", "INVALID_EMAIL", `LimeSurvey's invite pattern rejects ${bad.map((a) => JSON.stringify(a)).join(", ")}; invite_participants drops the participant silently.`);
      }
    }
    if (row.token.trim() === "") add(row, "token", "MISSING_TOKEN", "The participant has no token and is never invited.");
    if (row.emailstatus !== "OK") {
      add(row, "emailstatus", "EMAILSTATUS_NOT_OK", `emailstatus is ${JSON.stringify(row.emailstatus)}; only OK is invited.`);
    }

    const from = row.validfrom.trim() === "" ? null : parseServerTimestamp(row.validfrom, time.offsetMinutes);
    const until = row.validuntil.trim() === "" ? null : parseServerTimestamp(row.validuntil, time.offsetMinutes);
    if (from !== null && from > time.nowMs) {
      add(row, "validfrom", "NOT_YET_VALID", `validfrom ${row.validfrom} is after the server time.`);
    }
    if (until !== null && until < time.nowMs) {
      add(row, "validuntil", "EXPIRED", `validuntil ${row.validuntil} is before the server time.`);
    }
    if (from !== null && until !== null && from > until) {
      add(row, "validfrom", "INVALID_VALIDITY_RANGE", `validfrom ${row.validfrom} is after validuntil ${row.validuntil}.`);
    }
    for (const [field, epoch, value] of [["validfrom", from, row.validfrom], ["validuntil", until, row.validuntil]] as const) {
      if (epoch !== null && Math.abs(epoch - time.nowMs) <= BORDERLINE_MINUTES * 60_000) {
        borderline.push({ tid: row.tid, field, value, minutes_from_server_time: Math.round((epoch - time.nowMs) / 60_000) });
      }
    }
  }

  const duplicates = (key: (row: ParticipantRow) => string, field: string, code: IssueCode, label: string) => {
    const groups = new Map<string, ParticipantRow[]>();
    for (const row of rows) {
      const normalized = key(row);
      if (normalized === "") continue;
      groups.set(normalized, [...(groups.get(normalized) ?? []), row]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const row of group) {
        const others = group.filter((other) => other.tid !== row.tid).map((other) => other.tid).join(", ");
        add(row, field, code, `${label} is shared with tid ${others}.`);
      }
    }
  };
  duplicates((row) => row.email.trim().toLowerCase(), "email", "DUPLICATE_EMAIL", "The email address (trimmed, case-insensitive)");
  duplicates((row) => row.token.trim(), "token", "DUPLICATE_TOKEN", "The token");

  issues.sort((a, b) => a.tid - b.tid);
  return { issues, borderline };
}

function countBy(values: string[]): JsonObject {
  const counts: JsonObject = {};
  for (const value of values) counts[value] = ((counts[value] as number | undefined) ?? 0) + 1;
  return counts;
}

export async function validateParticipants(
  client: LimeSurveyClient,
  surveyId: number,
  offsetParameter: number | undefined,
): Promise<JsonValue> {
  const list = await fetchParticipants(client, surveyId);
  const time = resolveTime(client, offsetParameter);
  const { issues, borderline } = checkRows(list.rows, time);
  return {
    survey_id: surveyId,
    participant_table_exists: list.exists,
    participant_count: list.rows.length,
    server_time_utc: time.basis.server_time_utc as string,
    time_basis: time.basis,
    issues: issues as unknown as JsonValue,
    counts_by_code: countBy(issues.map((issue) => issue.code)),
    borderline: borderline as unknown as JsonValue,
    ...(list.truncated ? { truncated: true, truncation_note: `Only the first ${MAX_PAGES * PAGE_SIZE} participants were checked.` } : {}),
    ...(list.exists ? {} : { note: "The survey has no participant table (limesurvey_activate_tokens creates it)." }),
  };
}

async function readMaxEmails(client: LimeSurveyClient): Promise<number | null> {
  try {
    const value = await client.call("get_site_settings", ["maxemails"]);
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function tidList(value: unknown): number[] | null {
  return Array.isArray(value) && value.length > 0 ? value.filter((item): item is number => typeof item === "number") : null;
}

/**
 * Simulates limesurvey_invite_participants without calling it. Not even send_email=false is usable as a dry run:
 * it means "resend to those already invited", not "send nothing".
 */
export async function previewInvitation(input: Record<string, unknown>, client: LimeSurveyClient): Promise<JsonValue> {
  const surveyId = Number(input.survey_id);
  const selected = tidList(input.token_ids);
  const sendEmail = input.send_email !== false;
  const continueOnError = input.continue_on_error === true;
  const offsetParameter = typeof input.server_utc_offset_minutes === "number" ? input.server_utc_offset_minutes : undefined;

  const list = await fetchParticipants(client, surveyId);
  const mode = sendEmail ? "invite_pending" : "resend_invites";
  if (!list.exists) {
    return {
      dry_run: true,
      invite_participants_called: false,
      survey_id: surveyId,
      mode,
      participant_table_exists: false,
      participant_count: 0,
      would_receive: [],
      would_not_receive: [],
      real_call_would_fail_with: "Error: No survey participant list",
      limitations: [],
      note: "The survey has no participant table, so nobody can be invited (limesurvey_activate_tokens creates it).",
    };
  }

  const maxEmails = await readMaxEmails(client);
  const time = resolveTime(client, offsetParameter);
  const selectedSet = selected ? new Set(selected) : null;

  const notReceiving = new Map<number, { row: ParticipantRow; reasons: string[]; details: JsonObject }>();
  const reject = (row: ParticipantRow, reason: string, detail?: JsonObject) => {
    const entry = notReceiving.get(row.tid) ?? { row, reasons: [], details: {} };
    entry.reasons.push(reason);
    if (detail) Object.assign(entry.details, detail);
    notReceiving.set(row.tid, entry);
  };

  // 1. The SQL conditions of TokenDynamic::findUninvited.
  const eligible: ParticipantRow[] = [];
  for (const row of list.rows) {
    let rejected = false;
    const fail = (reason: string, detail?: JsonObject) => {
      rejected = true;
      reject(row, reason, detail);
    };
    if (row.completed !== "N" && row.completed !== "") fail("completed", { completed: row.completed });
    if (row.token === "") fail("missing_token");
    if (row.email === "") fail("missing_email");
    const invited = row.sent !== "N" && row.sent !== "";
    if (sendEmail && invited) fail("already_invited", { sent: row.sent });
    if (!sendEmail && !invited) fail("not_invited_yet");
    if (row.emailstatus !== "OK") fail("emailstatus_not_ok", { emailstatus: row.emailstatus });
    if (selectedSet && !selectedSet.has(row.tid)) fail("not_selected");
    if (!rejected) eligible.push(row);
  }

  // 2. LIMIT maxemails (applied by the SQL query, before the address check).
  let taken = eligible;
  if (maxEmails !== null && maxEmails > 0) {
    taken = eligible.slice(0, maxEmails);
    for (const row of eligible.slice(maxEmails)) reject(row, "beyond_maxemails", { maxemails: maxEmails });
  }

  // 3. The address pattern of invite_participants.
  const addressed: ParticipantRow[] = [];
  for (const row of taken) {
    const bad = invalidAddresses(row.email);
    if (bad.length > 0) reject(row, "invalid_email_address", { invalid_addresses: bad });
    else addressed.push(row);
  }

  // 4. emailTokens: validity window, stopping at the first failure unless continue_on_error.
  const would: ParticipantRow[] = [];
  let stopsAtTid: number | null = null;
  const notReached: ParticipantRow[] = [];
  for (let index = 0; index < addressed.length; index += 1) {
    const row = addressed[index] as ParticipantRow;
    const from = row.validfrom.trim() === "" ? null : parseServerTimestamp(row.validfrom, time.offsetMinutes);
    const until = row.validuntil.trim() === "" ? null : parseServerTimestamp(row.validuntil, time.offsetMinutes);
    let reason: "not_valid_yet" | "expired" | null = null;
    if (from !== null && from > time.nowMs) reason = "not_valid_yet";
    else if (until !== null && until < time.nowMs) reason = "expired";
    if (reason === null) {
      would.push(row);
      continue;
    }
    reject(row, reason, reason === "not_valid_yet" ? { validfrom: row.validfrom } : { validuntil: row.validuntil });
    if (!continueOnError) {
      stopsAtTid = row.tid;
      notReached.push(...(addressed.slice(index + 1) as ParticipantRow[]));
      break;
    }
  }

  const checks = checkRows(list.rows, time);
  const receivingTids = new Set(would.map((row) => row.tid));
  const warnings: JsonValue[] = checks.issues
    .filter((issue) => receivingTids.has(issue.tid) && ["WHITESPACE", "DUPLICATE_EMAIL", "DUPLICATE_TOKEN"].includes(issue.code))
    .map((issue) => ({ ...issue }));
  if (maxEmails === null && eligible.length > DEFAULT_MAX_EMAILS) {
    warnings.push({
      code: "MAXEMAILS_UNKNOWN",
      detail: `${eligible.length} participants qualify, but one invite_participants call sends at most maxemails (LimeSurvey default ${DEFAULT_MAX_EMAILS}, readable only by super administrators). The real value is unknown, so all qualifying participants are listed under would_receive; further calls would be needed beyond the limit.`,
    });
  }

  const wouldNotReceive = [...notReceiving.values()]
    .sort((a, b) => a.row.tid - b.row.tid)
    .map(({ row, reasons, details }) => ({ tid: row.tid, email: row.email, reasons, ...(Object.keys(details).length > 0 ? { details } : {}) }));
  const empty = eligible.length === 0 || addressed.length === 0;

  const limitations = [
    "The block list of the central participant database (CPDB) cannot be read through RemoteControl; LimeSurvey skips participants on it, so they may appear under would_receive.",
    maxEmails === null
      ? `maxemails (the number of emails per call) is readable only by super administrators; it is unknown here, so no beyond_maxemails reasons are reported (LimeSurvey default: ${DEFAULT_MAX_EMAILS}).`
      : `maxemails is ${maxEmails}${maxEmails === 0 ? " (no limit)" : ""}; read with get_site_settings.`,
    "The email check is a port of the pattern in LimeSurvey's invite_participants (derived from PHP FILTER_VALIDATE_EMAIL) and an approximation of the PHP result.",
    "Mail transport errors (SMTP rejections, demo mode, missing attachments) cannot be simulated.",
    "validfrom/validuntil depend on the time basis (see time_basis): the server time comes from the HTTP Date header and the zone of the LimeSurvey server is assumed.",
  ];

  return {
    dry_run: true,
    invite_participants_called: false,
    survey_id: surveyId,
    mode,
    continue_on_error: continueOnError,
    participant_table_exists: true,
    participant_count: list.rows.length,
    would_receive: would.map((row) => ({ tid: row.tid, email: row.email, firstname: row.firstname, lastname: row.lastname })),
    would_not_receive: wouldNotReceive as unknown as JsonValue,
    stops_at_tid: stopsAtTid,
    not_reached: notReached.map((row) => ({ tid: row.tid, email: row.email })),
    real_call_would_fail_with: empty ? "Error: No candidate tokens" : null,
    counts: {
      would_receive: would.length,
      would_not_receive: wouldNotReceive.length,
      not_reached: notReached.length,
      by_reason: countBy(wouldNotReceive.flatMap((entry) => entry.reasons)),
    },
    max_emails: maxEmails !== null
      ? { value: maxEmails, known: true }
      : { value: DEFAULT_MAX_EMAILS, known: false, assumption: "LimeSurvey default; not applied to the lists above" },
    time_basis: time.basis,
    borderline: checks.borderline as unknown as JsonValue,
    warnings,
    limitations,
    ...(list.truncated ? { truncated: true, truncation_note: `Only the first ${MAX_PAGES * PAGE_SIZE} participants were read.` } : {}),
  };
}

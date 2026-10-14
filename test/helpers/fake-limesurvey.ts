import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ATTRIBUTE_DEFAULTS, BASE_THEME_BY_TYPE, I18N_ATTRIBUTES } from "../../src/attribute-defaults.js";

/**
 * In-memory LimeSurvey for tests: answers the RemoteControl 2 JSON-RPC methods the spec generator needs and keeps the
 * survey content in public arrays, so tests can assert on the state. Behaviour follows the source reports under
 * .work/ls7 (research-gen-read-api.md, research-gen-import.md, research-gen-types.md, research-gen-risks.md):
 *
 * - generation 7 (LimeSurvey 7.5.1): errors are {status, error_code}; Ranking (R) answers become subquestions;
 *   .lsq texts and attributes in languages the survey lacks are skipped; defaultvalue is readable.
 * - generation 6 (LimeSurvey 6.17.11): errors are {status} only; Ranking keeps answer options; get_question_properties
 *   throws a JSON-RPC error for "defaultvalue" as soon as the question has a default value.
 *
 * Imports normalise line endings (CRLF and CR become LF in every text of the file, as libxml2 does). Stored attributes the
 * theme table does not list are language dependent when their row has a language (plugin attributes).
 *
 * Deliberate approximations: every language code from a small list counts as globally valid, users and permissions do
 * not exist, ids are numbers in the state and strings on the wire (like PDO), and the surveys/quota columns are the
 * ones of the imported file.
 */

export type Generation = 6 | 7;

export interface FakeOptions {
  generation?: Generation;
  /** Test switch: import_survey/import_group/import_question silently skip the first row of the answers section. */
  dropFirstAnswerOnImport?: boolean;
}

export interface FakeSurvey {
  sid: number;
  active: "Y" | "N";
  language: string;
  /** Space separated, as get_survey_properties returns it. */
  additional_languages: string;
  /** Every other column of the surveys table (raw strings). */
  settings: Record<string, string>;
  /** surveys_languagesettings: per language the surveyls_* columns (null = not set). */
  languagesettings: Record<string, Record<string, string | null>>;
}

export interface FakeGroup {
  gid: number;
  sid: number;
  group_order: number;
  randomization_group: string;
  grelevance: string;
  l10n: Record<string, { group_name: string; description: string }>;
}

export interface FakeQuestion {
  qid: number;
  parent_qid: number;
  sid: number;
  gid: number;
  type: string;
  title: string;
  preg: string;
  other: string;
  mandatory: string;
  encrypted: string;
  question_order: number;
  scale_id: number;
  same_default: string;
  relevance: string;
  question_theme_name: string;
  modulename: string;
  same_script: string;
  l10n: Record<string, { id: number; question: string; help: string; script: string }>;
}

export interface FakeAnswer {
  aid: number;
  qid: number;
  code: string;
  sortorder: number;
  assessment_value: number;
  scale_id: number;
  /** Answer text per language. */
  l10n: Record<string, string>;
}

export interface FakeAttribute {
  qid: number;
  attribute: string;
  value: string;
  language: string;
}

export interface FakeDefault {
  dvid: number;
  qid: number;
  sqid: number;
  scale_id: number;
  specialtype: string;
  /** Default value per language. */
  l10n: Record<string, string>;
}

export interface FakeQuota {
  id: number;
  sid: number;
  name: string;
  qlimit: number;
  action: number;
  active: number;
  autoload_url: number;
}

type Row = Record<string, string>;
type Handler = (params: unknown[]) => unknown;

const SESSION_KEY = "fake-session";
const GLOBAL_LANGUAGES = new Set([
  "ar", "bg", "cs", "da", "de", "de-informal", "el", "en", "es", "et", "fi", "fr", "he", "hr", "hu", "it", "ja", "ko",
  "lt", "lv", "nl", "no", "pl", "pt", "pt-BR", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "zh-Hans", "zh-Hant",
]);
const ALLOWS_OTHER = new Set(["L", "!", "M", "P"]);
const RESERVED_TITLES = new Set(["LANG", "SID", "SAVEDID", "TOKEN", "QID", "GID", "SGQ", "self", "that", "this"]);

const QUESTION_COLUMNS = [
  "qid", "parent_qid", "sid", "gid", "type", "title", "preg", "other", "mandatory", "encrypted", "question_order",
  "scale_id", "same_default", "relevance", "question_theme_name", "modulename", "same_script",
];
/** Columns set_question_properties accepts (RR 5.2); gid, type, sid, qid and parent_qid are dropped silently. */
const QUESTION_BASE_FIELDS = [
  "title", "preg", "other", "mandatory", "encrypted", "question_order", "scale_id", "same_default", "relevance",
  "question_theme_name", "modulename", "same_script",
];
const GROUP_COLUMNS = ["gid", "sid", "group_order", "randomization_group", "grelevance"];
const GROUP_BASE_FIELDS = ["group_order", "randomization_group", "grelevance"];
const SURVEYLS_COLUMNS = [
  "surveyls_survey_id", "surveyls_language", "surveyls_title", "surveyls_description", "surveyls_welcometext",
  "surveyls_endtext", "surveyls_policy_notice", "surveyls_policy_error", "surveyls_policy_notice_label", "surveyls_url",
  "surveyls_urldescription", "surveyls_email_invite_subj", "surveyls_email_invite", "surveyls_email_remind_subj",
  "surveyls_email_remind", "surveyls_email_register_subj", "surveyls_email_register", "surveyls_email_confirm_subj",
  "surveyls_email_confirm", "surveyls_dateformat", "surveyls_attributecaptions", "surveyls_alias",
  "email_admin_notification_subj", "email_admin_notification", "email_admin_responses_subj", "email_admin_responses",
  "surveyls_numberformat", "attachments",
];

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined);

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

const intOf = (value: string | undefined, fallback: number): number => toInt(value) ?? fallback;

/** PHP array semantics: keys exactly "0".."n-1" in order become a JSON list, everything else stays an object. */
function phpArray(entries: Array<[string, unknown]>): unknown {
  const isList = entries.every(([key], index) => key === String(index));
  return isList ? entries.map(([, value]) => value) : Object.fromEntries(entries);
}

function rowsOf(document: Record<string, unknown>, section: string): Row[] {
  const container = (document[section] as { rows?: unknown } | undefined)?.rows;
  if (!isRecord(container)) return [];
  const list = container.row;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const row: Row = {};
    if (isRecord(entry)) {
      for (const [key, value] of Object.entries(entry)) {
        // An XML parser turns CRLF (and a lone CR) into LF in every text, CDATA included (XML 1.0, 2.11); libxml2, which
        // LimeSurvey imports with, does the same.
        if (!key.startsWith("#")) row[key] = value === null || value === undefined ? "" : String(value).replace(/\r\n?/g, "\n");
      }
    }
    return row;
  });
}

interface ParsedFile {
  docType: string;
  languages: string[];
  has(section: string): boolean;
  rows(section: string): Row[];
}

function parseFile(data: unknown): ParsedFile | null {
  if (typeof data !== "string") return null;
  const xml = Buffer.from(data, "base64").toString("utf8").replace(/^﻿/, "");
  if (XMLValidator.validate(xml) !== true) return null;
  const parsed = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (_name, jpath) => typeof jpath === "string" && (jpath.endsWith(".rows.row") || jpath === "document.languages.language"),
  }).parse(xml) as { document?: unknown };
  if (!isRecord(parsed.document)) return null;
  const document = parsed.document;
  const languageNode = (document.languages as { language?: unknown } | undefined)?.language;
  return {
    docType: String(document.LimeSurveyDocType ?? ""),
    languages: Array.isArray(languageNode) ? languageNode.map((item) => String(item)) : [],
    has: (section) => section in document,
    rows: (section) => rowsOf(document, section),
  };
}

interface ImportContext {
  file: ParsedFile;
  sid: number;
  /** Target group of a question row, by the gid the file gives it; undefined skips the row. */
  groupFor: (oldGid: string) => number | undefined;
  /** Languages whose texts are imported; null keeps every language of the file. */
  textLanguages: Set<string> | null;
  /** Same for attribute rows that carry a language. */
  attributeLanguages: Set<string> | null;
  /** What happens when a main question code is already used in the survey. */
  renameTitles: boolean;
  /** true: question_order comes from the file (.lss, .lsg); false: MAX(question_order)+2 (.lsq). */
  keepFileOrder: boolean;
  dropFirstAnswer: boolean;
}

export class FakeLimeSurvey {
  readonly generation: Generation;
  readonly dropFirstAnswerOnImport: boolean;
  /** Every request the fake received, session methods included; params are the JSON-RPC positional parameters. */
  readonly requests: Array<{ method: string; params: unknown[] }> = [];

  readonly surveys: FakeSurvey[] = [];
  readonly groups: FakeGroup[] = [];
  readonly questions: FakeQuestion[] = [];
  readonly answers: FakeAnswer[] = [];
  readonly attributes: FakeAttribute[] = [];
  readonly defaults: FakeDefault[] = [];
  readonly quotas: FakeQuota[] = [];

  private nextSid = 100001;
  private nextGid = 2001;
  private nextQid = 3001;
  private nextAid = 4001;
  private nextDvid = 5001;
  private nextL10nId = 6001;
  private nextQuotaId = 7001;
  private sessionKey: string | null = null;
  private readonly failures = new Map<string, unknown[]>();
  private readonly methods: Record<string, Handler>;

  constructor(options: FakeOptions = {}) {
    this.generation = options.generation ?? 7;
    this.dropFirstAnswerOnImport = options.dropFirstAnswerOnImport ?? false;
    this.methods = {
      get_session_key: () => {
        this.sessionKey = SESSION_KEY;
        return SESSION_KEY;
      },
      release_session_key: () => {
        this.sessionKey = null;
        return "OK";
      },
      list_surveys: () => this.listSurveys(),
      get_survey_properties: (params) => this.getSurveyProperties(params),
      get_language_properties: (params) => this.getLanguageProperties(params),
      set_language_properties: (params) => this.setLanguageProperties(params),
      list_groups: (params) => this.listGroups(params),
      get_group_properties: (params) => this.getGroupProperties(params),
      set_group_properties: (params) => this.setGroupProperties(params),
      list_questions: (params) => this.listQuestions(params),
      get_question_properties: (params) => this.getQuestionProperties(params),
      set_question_properties: (params) => this.setQuestionProperties(params),
      import_survey: (params) => this.importSurvey(params),
      import_group: (params) => this.importGroup(params),
      import_question: (params) => this.importQuestion(params),
      delete_question: (params) => this.deleteQuestion(params),
      delete_group: (params) => this.deleteGroup(params),
      delete_survey: (params) => this.deleteSurvey(params),
      get_fieldmap: (params) => this.getFieldmap(params),
      list_quotas: (params) => this.listQuotas(params),
    };
  }

  /** The fetch implementation to hand to createServer(config, fake.fetch). */
  readonly fetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[]; id: number };
    const params = body.params ?? [];
    this.requests.push({ method: body.method, params });
    const handler = this.methods[body.method];
    if (!handler) return new Response("Internal Server Error", { status: 500 });
    try {
      const queue = this.failures.get(body.method);
      let result: unknown;
      if (queue && queue.length > 0) {
        const queued = queue.shift();
        if (queued instanceof Error) throw queued;
        result = queued;
      } else if (body.method !== "get_session_key" && params[0] !== this.sessionKey) {
        result = this.fail("Invalid session key", "ERR_INVALID_SESSION");
      } else {
        result = handler(params);
      }
      return new Response(JSON.stringify({ id: body.id, result, error: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ id: body.id, result: null, error: error instanceof Error ? error.message : String(error) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  };

  /** Switches a survey between active and inactive (activation itself is not simulated). */
  setActive(sid: number, active: boolean): void {
    const survey = this.surveys.find((item) => item.sid === sid);
    if (!survey) throw new Error(`The fake has no survey ${sid}.`);
    survey.active = active ? "Y" : "N";
  }

  /** The next call of this method answers exactly this result (an Error becomes a JSON-RPC error) and changes nothing. */
  failNext(method: string, result: unknown): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(result);
    this.failures.set(method, queue);
  }

  /** Adds a quota to a survey (the generator never writes quotas; list_quotas and the risk checks read them). */
  addQuota(sid: number, name: string): FakeQuota {
    const quota: FakeQuota = { id: this.nextQuotaId++, sid, name, qlimit: 10, action: 1, active: 1, autoload_url: 0 };
    this.quotas.push(quota);
    return quota;
  }

  // ---------------------------------------------------------------- helpers

  private fail(status: string, code: string): Record<string, unknown> {
    return this.generation === 7 ? { status, error_code: code } : { status };
  }

  private surveyOf(value: unknown): FakeSurvey | undefined {
    const sid = toInt(value);
    return sid === undefined ? undefined : this.surveys.find((survey) => survey.sid === sid);
  }

  private questionOf(value: unknown): FakeQuestion | undefined {
    const qid = toInt(value);
    return qid === undefined ? undefined : this.questions.find((question) => question.qid === qid);
  }

  private groupOf(value: unknown): FakeGroup | undefined {
    const gid = toInt(value);
    return gid === undefined ? undefined : this.groups.find((group) => group.gid === gid);
  }

  private languagesOf(survey: FakeSurvey): string[] {
    return [survey.language, ...survey.additional_languages.split(/\s+/).filter(Boolean)];
  }

  private subquestionsOf(question: FakeQuestion): FakeQuestion[] {
    return this.questions.filter((item) => item.parent_qid === question.qid);
  }

  private questionColumns(question: FakeQuestion): Record<string, string> {
    return {
      qid: String(question.qid),
      parent_qid: String(question.parent_qid),
      sid: String(question.sid),
      gid: String(question.gid),
      type: question.type,
      title: question.title,
      preg: question.preg,
      other: question.other,
      mandatory: question.mandatory,
      encrypted: question.encrypted,
      question_order: String(question.question_order),
      scale_id: String(question.scale_id),
      same_default: question.same_default,
      relevance: question.relevance,
      question_theme_name: question.question_theme_name,
      modulename: question.modulename,
      same_script: question.same_script,
    };
  }

  /** updateQuestionOrder: main questions of a group are numbered from 1 by (question_order, title). */
  private renumberQuestions(gid: number): void {
    this.questions
      .filter((question) => question.gid === gid && question.parent_qid === 0)
      .sort((a, b) => a.question_order - b.question_order || compare(a.title, b.title))
      .forEach((question, index) => {
        question.question_order = index + 1;
      });
  }

  /** updateGroupOrder: groups are numbered from 0 by (group_order, group name of the base language). */
  private renumberGroups(sid: number): void {
    const survey = this.surveys.find((item) => item.sid === sid);
    const base = survey?.language ?? "";
    this.groups
      .filter((group) => group.sid === sid)
      .sort((a, b) => a.group_order - b.group_order || compare(a.l10n[base]?.group_name ?? "", b.l10n[base]?.group_name ?? ""))
      .forEach((group, index) => {
        group.group_order = index;
      });
  }

  private titleTaken(sid: number, title: string, except?: FakeQuestion): boolean {
    return this.questions.some((question) => question.sid === sid && question.parent_qid === 0 && question !== except && question.title === title);
  }

  private uniqueTitle(sid: number, title: string): string {
    if (!this.titleTaken(sid, title)) return title;
    let candidate = `q${title}`.slice(0, 20);
    for (let counter = 1; this.titleTaken(sid, candidate); counter += 1) candidate = `q${title}`.slice(0, 17) + `r${counter}`;
    return candidate;
  }

  /** fixLanguageConsistency: additional languages get the base language text where a row is missing. */
  private fixLanguageConsistency(sid: number): void {
    const survey = this.surveys.find((item) => item.sid === sid);
    if (!survey) return;
    const base = survey.language;
    const others = this.languagesOf(survey).filter((language) => language !== base);
    for (const group of this.groups.filter((item) => item.sid === sid)) {
      const source = group.l10n[base];
      if (source) for (const language of others) group.l10n[language] ??= { ...source };
    }
    for (const question of this.questions.filter((item) => item.sid === sid)) {
      const source = question.l10n[base];
      if (source) for (const language of others) question.l10n[language] ??= { ...source, id: this.nextL10nId++ };
    }
    const qids = new Set(this.questions.filter((item) => item.sid === sid).map((item) => item.qid));
    for (const answer of this.answers.filter((item) => qids.has(item.qid))) {
      const source = answer.l10n[base];
      if (source !== undefined) for (const language of others) answer.l10n[language] ??= source;
    }
    for (const language of this.languagesOf(survey)) {
      survey.languagesettings[language] ??= { surveyls_survey_id: String(sid), surveyls_language: language, surveyls_title: "" };
    }
  }

  private removeQuestion(question: FakeQuestion): void {
    const doomed = new Set([question.qid, ...this.subquestionsOf(question).map((item) => item.qid)]);
    const keep = <T>(array: T[], predicate: (item: T) => boolean): void => {
      const kept = array.filter(predicate);
      array.splice(0, array.length, ...kept);
    };
    keep(this.questions, (item) => !doomed.has(item.qid));
    keep(this.answers, (item) => !doomed.has(item.qid));
    keep(this.attributes, (item) => !doomed.has(item.qid));
    keep(this.defaults, (item) => !doomed.has(item.qid));
  }

  // ---------------------------------------------------------------- reading

  private listSurveys(): unknown {
    if (this.surveys.length === 0) return this.fail("No surveys found", "ERR_NO_DATA");
    return this.surveys.map((survey) => ({
      sid: String(survey.sid),
      surveyls_title: survey.languagesettings[survey.language]?.surveyls_title ?? "",
      startdate: survey.settings.startdate ?? null,
      expires: survey.settings.expires ?? null,
      active: survey.active,
    }));
  }

  private surveyColumns(survey: FakeSurvey): Record<string, string> {
    return {
      sid: String(survey.sid),
      active: survey.active,
      language: survey.language,
      additional_languages: survey.additional_languages,
      ...survey.settings,
    };
  }

  private getSurveyProperties(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const columns = this.surveyColumns(survey);
    const requested = Array.isArray(params[2]) && params[2].length > 0 ? params[2].map(String) : Object.keys(columns);
    const result: Record<string, string> = {};
    for (const name of requested) {
      const value = columns[name];
      if (value !== undefined) result[name] = value;
    }
    return Object.keys(result).length > 0 ? result : this.fail("No valid Data", "ERR_NO_DATA");
  }

  private getLanguageProperties(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const requested = Array.isArray(params[2]) && params[2].length > 0 ? params[2].map(String) : SURVEYLS_COLUMNS;
    const asked = typeof params[3] === "string" ? params[3] : "";
    // An unknown language falls back to the base language; a known one the survey lacks yields only nulls.
    const language = GLOBAL_LANGUAGES.has(asked) ? asked : survey.language;
    const row = survey.languagesettings[language];
    const result: Record<string, string | null> = {};
    for (const name of requested) {
      if (SURVEYLS_COLUMNS.includes(name)) result[name] = row?.[name] ?? null;
    }
    return Object.keys(result).length > 0 ? result : this.fail("No valid Data", "ERR_NO_DATA");
  }

  private listGroups(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const language = typeof params[2] === "string" && params[2] !== "" ? params[2] : survey.language;
    const groups = this.groups.filter((group) => group.sid === survey.sid);
    if (groups.length === 0) return this.fail("No groups found", "ERR_NO_DATA");
    // Not sorted by group_order on purpose: LimeSurvey does not sort either (descending gid here).
    return [...groups].sort((a, b) => b.gid - a.gid).map((group) => ({
      id: String(group.gid),
      gid: String(group.gid),
      sid: String(group.sid),
      group_order: String(group.group_order),
      randomization_group: group.randomization_group,
      grelevance: group.grelevance,
      group_name: group.l10n[language]?.group_name ?? null,
      description: group.l10n[language]?.description ?? null,
      language,
    }));
  }

  private getGroupProperties(params: unknown[]): unknown {
    const group = this.groupOf(params[1]);
    if (!group) return this.fail("Error: Invalid group ID", "ERR_INVALID_GROUP");
    const survey = this.surveyOf(group.sid);
    const language = params[3] === null || params[3] === undefined ? (survey?.language ?? "") : String(params[3]);
    if (!GLOBAL_LANGUAGES.has(language)) return this.fail("Error: Invalid language", "ERR_INVALID_LANGUAGE");
    const columns: Record<string, string | undefined> = {
      gid: String(group.gid),
      sid: String(group.sid),
      group_order: String(group.group_order),
      randomization_group: group.randomization_group,
      grelevance: group.grelevance,
      group_name: group.l10n[language]?.group_name,
      description: group.l10n[language]?.description,
    };
    const available = [...GROUP_COLUMNS, "group_name", "description"];
    const requested = Array.isArray(params[2]) && params[2].length > 0 ? params[2].map(String) : available;
    const result: Record<string, string> = {};
    for (const name of requested.filter((item) => available.includes(item))) {
      const value = columns[name];
      if (value !== undefined) result[name] = value;
    }
    return Object.keys(result).length > 0 ? result : this.fail("No valid Data", "ERR_NO_DATA");
  }

  private listQuestions(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const language = typeof params[3] === "string" && params[3] !== "" ? params[3] : survey.language;
    if (!GLOBAL_LANGUAGES.has(language) || !this.languagesOf(survey).includes(language)) {
      return this.fail("Error: Invalid language", "ERR_INVALID_LANGUAGE");
    }
    let candidates = this.questions.filter((question) => question.sid === survey.sid);
    if (params[2] !== null && params[2] !== undefined) {
      const group = this.groupOf(params[2]);
      if (!group || group.sid !== survey.sid) return this.fail("Error: group not found", "ERR_INVALID_GROUP");
      candidates = candidates.filter((question) => question.gid === group.gid);
    }
    if (candidates.length === 0) return this.fail("No questions found", "ERR_NO_DATA");
    // Main questions and subquestions, unsorted (descending qid here).
    return [...candidates].sort((a, b) => b.qid - a.qid).map((question) => ({
      id: String(question.qid),
      question: question.l10n[language]?.question ?? null,
      help: question.l10n[language]?.help ?? null,
      language,
      ...this.questionColumns(question),
    }));
  }

  private getQuestionProperties(params: unknown[]): unknown {
    const question = this.questionOf(params[1]);
    if (!question) return this.fail("Error: Invalid questionid", "ERR_INVALID_QUESTION");
    const survey = this.surveyOf(question.sid);
    const language = typeof params[3] === "string" && params[3] !== "" ? params[3] : (survey?.language ?? "");
    if (!GLOBAL_LANGUAGES.has(language)) return this.fail("Error: Invalid language", "ERR_INVALID_LANGUAGE");
    if (!question.l10n[language]) return this.fail("Error: Invalid questionid", "ERR_INVALID_QUESTION");
    const available = [
      ...QUESTION_COLUMNS,
      "question", "help", "script", "questionl10ns", "available_answers", "subquestions", "attributes", "attributes_lang",
      ...(question.type === "1" ? ["answeroptions_multiscale"] : ["answeroptions", "defaultvalue"]),
    ];
    const requested = Array.isArray(params[2]) && params[2].length > 0 ? params[2].map(String) : available;
    const names = requested.filter((name) => available.includes(name));
    if (names.length === 0) return this.fail("No valid Data", "ERR_NO_DATA");
    const result: Record<string, unknown> = {};
    for (const name of names) {
      // Dual scale answer options come back under the key "answeroptions".
      result[name === "answeroptions_multiscale" ? "answeroptions" : name] = this.questionProperty(question, name, language);
    }
    return result;
  }

  private questionProperty(question: FakeQuestion, name: string, language: string): unknown {
    const columns = this.questionColumns(question);
    const text = question.l10n[language];
    const column = columns[name];
    if (column !== undefined) return column;
    const subquestions = this.subquestionsOf(question)
      .filter((item) => item.l10n[language] !== undefined)
      .sort(this.generation === 7 ? (a, b) => compare(a.title, b.title) : (a, b) => a.qid - b.qid);
    const options = this.answers
      .filter((answer) => answer.qid === question.qid && answer.l10n[language] !== undefined)
      .sort((a, b) => a.sortorder - b.sortorder || compare(a.code, b.code));
    const optionOf = (answer: FakeAnswer, withCode: boolean) => ({
      ...(withCode ? { code: answer.code } : {}),
      answer: answer.l10n[language] ?? "",
      assessment_value: String(answer.assessment_value),
      scale_id: String(answer.scale_id),
      order: String(answer.sortorder),
    });
    switch (name) {
      case "question":
        return text?.question ?? null;
      case "help":
        return text?.help ?? null;
      case "script":
        return text?.script ?? null;
      case "questionl10ns":
        return text ? { id: String(text.id), qid: String(question.qid), question: text.question, help: text.help, script: text.script, language } : null;
      case "available_answers":
        return subquestions.length === 0
          ? "No available answers"
          : phpArray(subquestions.map((item): [string, unknown] => [item.title, item.l10n[language]?.question ?? ""]));
      case "subquestions":
        return subquestions.length === 0
          ? "No available answers"
          : Object.fromEntries(subquestions.map((item) => [String(item.qid), {
            title: item.title,
            question: item.l10n[language]?.question ?? "",
            scale_id: String(item.scale_id),
          }]));
      case "attributes":
      case "attributes_lang": {
        const values = this.attributeValues(question, name === "attributes_lang" ? language : null);
        return Object.keys(values).length === 0 ? "No available attributes" : values;
      }
      case "answeroptions":
        return options.length === 0
          ? "No available answer options"
          : phpArray(options.map((answer): [string, unknown] => [answer.code, optionOf(answer, false)]));
      case "answeroptions_multiscale": {
        if (options.length === 0) return "No available answer options";
        const scales = [...new Set(options.map((answer) => answer.scale_id))].sort((a, b) => a - b);
        return phpArray(scales.map((scale): [string, unknown] => [
          String(scale),
          phpArray(options.filter((answer) => answer.scale_id === scale).map((answer): [string, unknown] => [answer.code, optionOf(answer, true)])),
        ]));
      }
      case "defaultvalue": {
        const mine = this.defaults.filter((item) => item.qid === question.qid).sort((a, b) => a.dvid - b.dvid);
        if (this.generation === 6) {
          if (mine.length > 0) throw new Error('Property "DefaultValue.defaultvalue" is not defined.');
          return null;
        }
        return mine.find((item) => item.l10n[language] !== undefined)?.l10n[language] ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Attribute values as get_question_properties reports them: the definitions of the question theme with the
   * stored values over the defaults. language null gives the language independent attributes, a language code the
   * language dependent ones. A stored attribute with the wrong language class (for example a language dependent
   * attribute without language) is ignored, like LimeSurvey does. Approximation: stored attributes the theme
   * table does not list are reported as well, because the table omits attributes whose default differs between
   * LimeSurvey 6 and 7.
   */
  private attributeValues(question: FakeQuestion, language: string | null): Record<string, string> {
    const theme = question.question_theme_name || BASE_THEME_BY_TYPE[question.type] || "";
    const defaults = ATTRIBUTE_DEFAULTS[theme] ?? {};
    const wanted = (name: string): boolean => (language === null ? !I18N_ATTRIBUTES.has(name) : I18N_ATTRIBUTES.has(name));
    // The language class of a stored row: the 16 core attributes stored per language are language dependent; an
    // attribute the theme table does not list (a plugin or custom theme attribute) is language dependent when its row
    // has a language (only an attribute defined per language can have one), otherwise language independent.
    const perLanguage = (item: FakeAttribute): boolean => I18N_ATTRIBUTES.has(item.attribute)
      || (!Object.hasOwn(defaults, item.attribute) && item.language !== "");
    const stored = this.attributes.filter((item) => item.qid === question.qid
      && perLanguage(item) === (language !== null) && item.language === (language ?? ""));
    // HiddenQuestionAttributeProvider adds "image" to every question type (default ""); live 6.17.11 and 7.5.1 report it.
    const hidden = language === null ? ["image"] : [];
    const names = new Set([...Object.keys(defaults).filter(wanted), ...hidden, ...stored.map((item) => item.attribute)]);
    const values: Record<string, string> = {};
    for (const name of [...names].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }))) {
      values[name] = stored.find((item) => item.attribute === name)?.value ?? defaults[name] ?? "";
    }
    return values;
  }

  private getFieldmap(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const language = typeof params[2] === "string" && params[2] !== "" ? params[2] : survey.language;
    const seven = this.generation === 7;
    const fields: Record<string, unknown> = {};
    const groups = this.groups.filter((group) => group.sid === survey.sid).sort((a, b) => a.group_order - b.group_order);
    for (const group of groups) {
      const mains = this.questions
        .filter((question) => question.gid === group.gid && question.parent_qid === 0)
        .sort((a, b) => a.question_order - b.question_order);
      for (const question of mains) {
        const root = seven ? `Q${question.qid}` : `${survey.sid}X${group.gid}X${question.qid}`;
        const textLanguage = question.same_default === "1" ? survey.language : language;
        const defaultFor = (sqid: number, specialtype: string): string | undefined => this.defaults
          .find((item) => item.qid === question.qid && item.sqid === sqid && item.specialtype === specialtype)?.l10n[textLanguage];
        const add = (suffix: string, aid: string, extra: Record<string, unknown> = {}, defaultvalue?: string): void => {
          fields[`${root}${suffix}`] = {
            fieldname: `${root}${suffix}`,
            type: question.type,
            sid: String(survey.sid),
            gid: String(group.gid),
            qid: String(question.qid),
            aid,
            ...extra,
            ...(defaultvalue !== undefined ? { defaultvalue } : {}),
          };
        };
        const subs = this.subquestionsOf(question).sort((a, b) => a.scale_id - b.scale_id || a.question_order - b.question_order);
        const rows = subs.filter((item) => item.scale_id === 0);
        const columnsOfMatrix = subs.filter((item) => item.scale_id === 1);
        const suffixFor = (sub: FakeQuestion): string => (seven ? `_S${sub.qid}` : sub.title);
        if ("MPABCEFHKQ".includes(question.type)) {
          for (const sub of rows) {
            add(suffixFor(sub), sub.title, { sqid: String(sub.qid) }, defaultFor(sub.qid, ""));
            if (question.type === "P") add(`${suffixFor(sub)}${seven ? "_Ccomment" : "comment"}`, `${sub.title}comment`, { sqid: String(sub.qid) });
          }
          if ("MP".includes(question.type) && question.other === "Y") {
            add(seven ? "_Cother" : "other", "other");
            if (question.type === "P") add(seven ? "_Cothercomment" : "othercomment", "othercomment");
          }
        } else if (":;".includes(question.type)) {
          for (const row of rows) {
            for (const column of columnsOfMatrix) {
              add(seven ? `_S${row.qid}_S${column.qid}` : `${row.title}_${column.title}`, `${row.title}_${column.title}`, { sqid: String(row.qid) });
            }
          }
        } else if (question.type === "1") {
          for (const sub of rows) {
            add(seven ? `_S${sub.qid}#0` : `${sub.title}#0`, `${sub.title}#0`, { sqid: String(sub.qid) });
            add(seven ? `_S${sub.qid}#1` : `${sub.title}#1`, `${sub.title}#1`, { sqid: String(sub.qid) });
          }
        } else if (question.type === "R") {
          if (seven) {
            for (const sub of rows) add(`_S${sub.qid}`, sub.title, { sqid: String(sub.qid) });
          } else {
            this.answers.filter((answer) => answer.qid === question.qid).forEach((answer, index) => add(String(index + 1), answer.code));
          }
        } else {
          add("", "", {}, defaultFor(0, ""));
          if (question.type === "O") add(seven ? "_Ccomment" : "comment", "comment");
          if ("L!".includes(question.type) && question.other === "Y") add(seven ? "_Cother" : "other", "other", {}, defaultFor(0, "other"));
          if (question.type === "|") add(seven ? "_Cfilecount" : "filecount", "filecount");
        }
      }
    }
    return Object.keys(fields).length > 0 ? fields : this.fail("Can not obtain field map", "ERR_NO_DATA");
  }

  private listQuotas(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const quotas = this.quotas.filter((quota) => quota.sid === survey.sid);
    if (quotas.length === 0) return this.fail("No quotas found", "ERR_NO_DATA");
    return quotas.map((quota) => ({
      id: String(quota.id),
      name: quota.name,
      action: String(quota.action),
      limit: String(quota.qlimit),
      active: String(quota.active),
      autoload_url: String(quota.autoload_url),
    }));
  }

  // ---------------------------------------------------------------- writing

  private setLanguageProperties(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const language = typeof params[3] === "string" && params[3] !== "" ? params[3] : survey.language;
    if (!this.languagesOf(survey).includes(language)) return this.fail("Error: Invalid language", "ERR_INVALID_LANGUAGE");
    const data = isRecord(params[2]) ? params[2] : {};
    const row = survey.languagesettings[language] ?? { surveyls_survey_id: String(survey.sid), surveyls_language: language };
    survey.languagesettings[language] = row;
    const result: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(data)) {
      if (!SURVEYLS_COLUMNS.includes(name) || name === "surveyls_language" || name === "surveyls_survey_id") continue;
      row[name] = String(value ?? "");
      result[name] = true;
    }
    return Object.keys(result).length > 0 ? result : this.fail("No valid Data", "ERR_NO_DATA");
  }

  private setGroupProperties(params: unknown[]): unknown {
    const group = this.groupOf(params[1]);
    if (!group) return this.fail("Error: Invalid group ID", "ERR_INVALID_GROUP");
    const survey = this.surveyOf(group.sid);
    const base = survey?.language ?? "";
    const data = isRecord(params[2]) ? params[2] : {};
    const result: Record<string, boolean> = {};
    if (isRecord(data.questiongroupl10ns)) {
      for (const [language, value] of Object.entries(data.questiongroupl10ns)) {
        if (!isRecord(value)) continue;
        const row = group.l10n[language] ?? { group_name: "", description: "" };
        if (typeof value.group_name === "string") row.group_name = value.group_name;
        if (typeof value.description === "string") row.description = value.description;
        group.l10n[language] = row;
      }
      result.questiongroupl10ns = true;
    }
    // Old form: group_name/description (+ language) write one language, the part not given becomes empty.
    if ("group_name" in data || "description" in data || "language" in data) {
      const language = asText(data.language) || base;
      group.l10n[language] = { group_name: asText(data.group_name) ?? "", description: asText(data.description) ?? "" };
      result.group_name = true;
    }
    for (const name of GROUP_BASE_FIELDS.filter((field) => field in data)) {
      const value = data[name];
      if (name === "group_order") {
        const order = toInt(value);
        if (order === undefined) {
          result[name] = false;
          continue;
        }
        group.group_order = order;
      } else if (name === "randomization_group") {
        group.randomization_group = String(value ?? "");
      } else {
        group.grelevance = String(value ?? "");
      }
      result[name] = true;
      this.renumberGroups(group.sid);
    }
    return Object.keys(result).length > 0 ? result : this.fail("No valid Data", "ERR_NO_DATA");
  }

  private setQuestionProperties(params: unknown[]): unknown {
    const question = this.questionOf(params[1]);
    if (!question) return this.fail("Error: Invalid questionid", "ERR_INVALID_QUESTION");
    const survey = this.surveyOf(question.sid);
    const language = typeof params[3] === "string" && params[3] !== "" ? params[3] : (survey?.language ?? "");
    const data = isRecord(params[2]) ? params[2] : {};
    const result: Record<string, unknown> = {};

    const updates: Record<string, { question?: string; help?: string; script?: string }> = {};
    if (isRecord(data.questionl10ns)) {
      for (const [lang, value] of Object.entries(data.questionl10ns)) {
        if (!isRecord(value)) continue;
        const update: { question?: string; help?: string; script?: string } = {};
        if (typeof value.question === "string") update.question = value.question;
        if (typeof value.help === "string") update.help = value.help;
        if (typeof value.script === "string") update.script = value.script;
        updates[lang] = update;
      }
    }
    const legacyLanguage = asText(data.language) ?? "";
    const legacy = this.generation === 7 ? legacyLanguage !== "" || "question" in data || "help" in data : legacyLanguage !== "";
    if (legacy) {
      // 7.5.1 keeps the part that is not given; 6.17.11 sets it to an empty string.
      const target = legacyLanguage || language;
      const existing = question.l10n[target];
      const keep = this.generation === 7;
      updates[target] = {
        question: asText(data.question) ?? (keep ? existing?.question : undefined) ?? "",
        help: asText(data.help) ?? (keep ? existing?.help : undefined) ?? "",
      };
    }
    for (const [lang, update] of Object.entries(updates)) {
      const row = question.l10n[lang] ?? { id: this.nextL10nId++, question: "", help: "", script: "" };
      Object.assign(row, update);
      question.l10n[lang] = row;
    }
    if (Object.keys(updates).length > 0) result.questionl10ns = true;

    for (const name of QUESTION_BASE_FIELDS.filter((field) => field in data)) {
      const accepted = this.setQuestionField(question, name, data[name]);
      result[name] = accepted;
      // Every saved base field renumbers the main questions of the group, also when a subquestion is edited.
      if (accepted) this.renumberQuestions(question.gid);
    }
    return Object.keys(result).length > 0 ? result : this.fail("No valid Data", "ERR_NO_DATA");
  }

  private setQuestionField(question: FakeQuestion, name: string, raw: unknown): boolean {
    const value = raw === null || raw === undefined ? "" : String(raw);
    switch (name) {
      case "title": {
        const main = question.parent_qid === 0;
        const valid = main
          ? /^[A-Za-z][A-Za-z0-9]*$/.test(value) && value.length <= 20 && !RESERVED_TITLES.has(value) && !this.titleTaken(question.sid, value, question)
          : /^[A-Za-z0-9]{1,20}$/.test(value) && value.toLowerCase() !== "time" && !this.questions.some((item) => item !== question
            && item.parent_qid === question.parent_qid && item.scale_id === question.scale_id && item.title.toLowerCase() === value.toLowerCase());
        if (valid) question.title = value;
        return valid;
      }
      case "question_order":
      case "scale_id": {
        const number = toInt(raw);
        if (number === undefined) return false;
        if (name === "question_order") question.question_order = number;
        else question.scale_id = number;
        return true;
      }
      case "mandatory":
        if (!["Y", "S", "N"].includes(value)) return false;
        question.mandatory = value;
        return true;
      case "other":
        if (!["Y", "N"].includes(value)) return false;
        question.other = value === "Y" && !ALLOWS_OTHER.has(question.type) ? "N" : value;
        return true;
      case "encrypted":
        if (!["Y", "N"].includes(value)) return false;
        question.encrypted = value;
        return true;
      case "preg":
        question.preg = value;
        return true;
      case "same_default":
        question.same_default = value;
        return true;
      case "relevance":
        question.relevance = value;
        return true;
      case "question_theme_name":
        question.question_theme_name = value;
        return true;
      case "modulename":
        question.modulename = value;
        return true;
      case "same_script":
        question.same_script = value;
        return true;
      default:
        return false;
    }
  }

  private deleteQuestion(params: unknown[]): unknown {
    const question = this.questionOf(params[1]);
    if (!question) return this.fail("Error: Invalid question ID", "ERR_INVALID_QUESTION");
    if (this.surveyOf(question.sid)?.active === "Y") return this.fail("Survey is active and not editable", "ERR_SURVEY_ACTIVE");
    this.removeQuestion(question);
    this.renumberQuestions(question.gid);
    return question.qid;
  }

  private deleteGroup(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    const group = this.groupOf(params[2]);
    if (!group || group.sid !== survey.sid) return this.fail("Error: Invalid group ID", "ERR_INVALID_GROUP");
    if (survey.active === "Y") return this.fail("Survey is active and not editable", "ERR_SURVEY_ACTIVE");
    for (const question of this.questions.filter((item) => item.gid === group.gid && item.parent_qid === 0)) this.removeQuestion(question);
    this.groups.splice(this.groups.indexOf(group), 1);
    this.renumberGroups(survey.sid);
    return group.gid;
  }

  private deleteSurvey(params: unknown[]): unknown {
    const survey = this.surveyOf(params[1]);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    for (const question of this.questions.filter((item) => item.sid === survey.sid && item.parent_qid === 0)) this.removeQuestion(question);
    const drop = <T extends { sid: number }>(array: T[]): void => {
      const kept = array.filter((item) => item.sid !== survey.sid);
      array.splice(0, array.length, ...kept);
    };
    drop(this.groups);
    drop(this.quotas);
    this.surveys.splice(this.surveys.indexOf(survey), 1);
    return { status: "OK" };
  }

  // ---------------------------------------------------------------- import

  private importSurvey(params: unknown[]): unknown {
    const [, data, type, name, destination] = params;
    const kind = String(type).trim().toLowerCase();
    if (!["lsa", "csv", "txt", "lss"].includes(kind)) return this.fail("Invalid extension", "ERR_INVALID_EXTENSION");
    const file = parseFile(data);
    if (kind !== "lss" || !file || file.docType !== "Survey") {
      return this.fail("Error: This is not a valid LimeSurvey survey structure XML file.", "ERR_CREATION_FAILED");
    }
    const row = file.rows("surveys")[0];
    if (!row || !row.language) return this.fail("Error: The survey structure file has no survey with a base language.", "ERR_CREATION_FAILED");

    let sid = toInt(destination) ?? 0;
    while (sid <= 0 || this.surveys.some((survey) => survey.sid === sid)) sid = this.nextSid++;
    const settings: Record<string, string> = { ...row };
    for (const column of ["sid", "language", "additional_languages", "active"]) delete settings[column];
    if (this.generation === 7) {
      delete settings.nokeyboard;
      settings.preselectnoanswer ??= "N";
      settings.savequotaexit ??= "N";
    } else {
      delete settings.preselectnoanswer;
      delete settings.savequotaexit;
      settings.nokeyboard ??= "I";
    }
    const survey: FakeSurvey = {
      sid,
      active: "N",
      language: row.language,
      additional_languages: (row.additional_languages ?? "").trim(),
      settings,
      languagesettings: {},
    };
    const languages = this.languagesOf(survey);
    const newTitle = typeof name === "string" ? name : "";
    for (const settingsRow of file.rows("surveys_languagesettings")) {
      const language = settingsRow.surveyls_language ?? "";
      if (!languages.includes(language)) continue;
      survey.languagesettings[language] = {
        ...settingsRow,
        surveyls_survey_id: String(sid),
        ...(newTitle !== "" ? { surveyls_title: newTitle } : {}),
      };
    }
    this.surveys.push(survey);

    const gidMap = this.createGroups(file, sid, "file", file.languages.length > 0 ? new Set(file.languages) : null);
    this.createContent({
      file, sid, groupFor: (oldGid) => gidMap.get(oldGid), textLanguages: null, attributeLanguages: null,
      renameTitles: false, keepFileOrder: true, dropFirstAnswer: this.dropFirstAnswerOnImport,
    });
    for (const quotaRow of file.rows("quota")) {
      this.quotas.push({
        id: this.nextQuotaId++, sid, name: quotaRow.name ?? "", qlimit: intOf(quotaRow.qlimit, 0), action: intOf(quotaRow.action, 1),
        active: intOf(quotaRow.active, 1), autoload_url: intOf(quotaRow.autoload_url, 0),
      });
    }
    this.fixLanguageConsistency(sid);
    return sid;
  }

  private importGroup(params: unknown[]): unknown {
    const [, sidValue, data, type, newName, newDescription] = params;
    const survey = this.surveyOf(sidValue);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    if (survey.active === "Y") return this.fail("Error:Survey is active and not editable", "ERR_SURVEY_ACTIVE");
    if (String(type).trim().toLowerCase() !== "lsg") return this.fail("Invalid extension", "ERR_INVALID_EXTENSION");
    const file = parseFile(data);
    if (!file) return this.fail("Error: Invalid LimeSurvey group structure XML ", "ERR_INVALID_XML");
    if (file.docType !== "Group") throw new Error("This is not a valid LimeSurvey group structure XML file.");
    if (!file.languages.includes(survey.language)) {
      return this.fail("Error: The languages of the imported group file must at least include the base language of this survey.", "ERR_CREATION_FAILED");
    }
    const created: FakeGroup[] = [];
    const gidMap = this.createGroups(file, survey.sid, "append", null, created);
    this.createContent({
      file, sid: survey.sid, groupFor: (oldGid) => gidMap.get(oldGid), textLanguages: null,
      attributeLanguages: null, renameTitles: true, keepFileOrder: true, dropFirstAnswer: this.dropFirstAnswerOnImport,
    });
    const group = created[0];
    if (!group) return this.fail("Error: The group structure file has no group.", "ERR_CREATION_FAILED");
    const row = group.l10n[survey.language];
    if (row && typeof newName === "string" && newName !== "") row.group_name = newName;
    if (row && typeof newDescription === "string" && newDescription !== "") row.description = newDescription;
    return group.gid;
  }

  private importQuestion(params: unknown[]): unknown {
    const [, sidValue, gidValue, data, type, mandatory, newTitle, newText, newHelp] = params;
    const survey = this.surveyOf(sidValue);
    if (!survey) return this.fail("Error: Invalid survey ID", "ERR_INVALID_SURVEY");
    if (survey.active === "Y") return this.fail("Error:Survey is Active and not editable", "ERR_SURVEY_ACTIVE");
    const group = this.groupOf(gidValue);
    if (!group || group.sid !== survey.sid) return this.fail("Error: Invalid group ID", "ERR_INVALID_GROUP");
    const wantedTitle = typeof newTitle === "string" && newTitle !== "" ? newTitle : null;
    if (wantedTitle !== null && this.titleTaken(survey.sid, wantedTitle)) {
      return this.fail("Error: Question title already exist in this survey.", "ERR_ALREADY_EXISTS");
    }
    if (String(type).trim().toLowerCase() !== "lsq") return this.fail("Really Invalid extension", "ERR_INVALID_EXTENSION");
    const file = parseFile(data);
    if (!file) return this.fail("Error: Invalid LimeSurvey question structure XML ", "ERR_INVALID_XML");
    if (file.docType !== "Question") throw new Error("This is not a valid LimeSurvey question structure XML file.");
    if (!file.languages.includes(survey.language)) {
      return this.fail("Error: The languages of the imported question file must at least include the base language of this survey.", "ERR_CREATION_FAILED");
    }
    if (wantedTitle === null) {
      const clash = file.rows("questions").find((row) => this.titleTaken(survey.sid, row.title ?? ""));
      if (clash) {
        return this.fail(`Error: The question could not be imported for the following reasons: Question code (${clash.title ?? ""}) is not unique.`, "ERR_CREATION_FAILED");
      }
    }
    // 7.5.1 skips texts and attributes in languages the survey does not have; 6.17.11 imports them as orphans.
    const languages = this.generation === 7 ? new Set(this.languagesOf(survey)) : null;
    const created = this.createContent({
      file, sid: survey.sid, groupFor: () => group.gid, textLanguages: languages, attributeLanguages: languages,
      renameTitles: true, keepFileOrder: false, dropFirstAnswer: this.dropFirstAnswerOnImport,
    });
    const question = created[0];
    if (!question) return this.fail("Error: The question structure file has no question.", "ERR_CREATION_FAILED");
    this.fixLanguageConsistency(survey.sid);
    // import_question always overwrites the mandatory flag of the file.
    const flag = typeof mandatory === "string" ? mandatory : "N";
    question.mandatory = ["Y", "S", "N"].includes(flag) ? flag : "N";
    if (wantedTitle !== null) question.title = wantedTitle;
    for (const row of Object.values(question.l10n)) {
      if (typeof newText === "string" && newText !== "") row.question = newText;
      if (typeof newHelp === "string" && newHelp !== "") row.help = newHelp;
    }
    return question.qid;
  }

  private createGroups(file: ParsedFile, sid: number, order: "file" | "append", languages: Set<string> | null, created: FakeGroup[] = []): Map<string, number> {
    const gidMap = new Map<string, number>();
    const existing = this.groups.filter((group) => group.sid === sid).map((group) => group.group_order);
    const appendOrder = (existing.length > 0 ? Math.max(...existing) : 0) + 1;
    const groupRows = file.rows("groups");
    for (const row of groupRows) {
      const group: FakeGroup = {
        gid: this.nextGid++,
        sid,
        group_order: order === "file" ? intOf(row.group_order, 0) : appendOrder,
        randomization_group: row.randomization_group ?? "",
        grelevance: row.grelevance ?? "1",
        l10n: {},
      };
      gidMap.set(row.gid ?? "", group.gid);
      this.groups.push(group);
      created.push(group);
    }
    const textRows = file.has("group_l10ns") ? file.rows("group_l10ns") : groupRows;
    for (const row of textRows) {
      const gid = gidMap.get(row.gid ?? "");
      const language = row.language ?? "";
      if (gid === undefined || language === "" || (languages !== null && !languages.has(language))) continue;
      this.groups.find((group) => group.gid === gid)!.l10n[language] = { group_name: row.group_name ?? "", description: row.description ?? "" };
    }
    return gidMap;
  }

  /** Questions, subquestions, texts, answers, attributes and default values of a file; returns the new main questions. */
  private createContent(context: ImportContext): FakeQuestion[] {
    const { file, sid } = context;
    const qidMap = new Map<string, number>();
    const mains: FakeQuestion[] = [];
    const textAllowed = (language: string): boolean => language !== "" && (context.textLanguages === null || context.textLanguages.has(language));

    for (const row of file.rows("questions")) {
      const gid = context.groupFor(row.gid ?? "");
      if (gid === undefined) continue;
      const type = row.type ?? "T";
      const existing = this.questions.filter((item) => item.gid === gid && item.parent_qid === 0).map((item) => item.question_order);
      const title = context.renameTitles ? this.uniqueTitle(sid, row.title ?? "") : (row.title ?? "");
      const question: FakeQuestion = {
        qid: this.nextQid++,
        parent_qid: 0,
        sid,
        gid,
        type,
        title,
        preg: row.preg ?? "",
        other: ALLOWS_OTHER.has(type) && row.other === "Y" ? "Y" : "N",
        mandatory: row.mandatory ?? "N",
        encrypted: row.encrypted ?? "N",
        question_order: context.keepFileOrder ? intOf(row.question_order, 0) : (existing.length > 0 ? Math.max(...existing) : 0) + 2,
        scale_id: intOf(row.scale_id, 0),
        same_default: row.same_default ?? "0",
        relevance: row.relevance === undefined || row.relevance === "" ? "1" : row.relevance,
        question_theme_name: row.question_theme_name ? row.question_theme_name : (BASE_THEME_BY_TYPE[type] ?? ""),
        modulename: row.modulename ?? "",
        same_script: row.same_script ?? "0",
        l10n: {},
      };
      qidMap.set(row.qid ?? "", question.qid);
      this.questions.push(question);
      mains.push(question);
    }

    const subRows = file.rows("subquestions");
    for (const row of subRows) {
      if ((row.gid ?? "") === "" || row.gid === "0") continue;
      const parent = this.questions.find((item) => item.qid === qidMap.get(row.parent_qid ?? ""));
      if (!parent) continue;
      const sub: FakeQuestion = {
        qid: this.nextQid++, parent_qid: parent.qid, sid, gid: parent.gid,
        type: this.generation === 7 && parent.type === "R" ? "R" : (row.type ?? "T"),
        title: row.title ?? "", preg: row.preg ?? "", other: "N", mandatory: row.mandatory ?? "N", encrypted: row.encrypted ?? "N",
        question_order: intOf(row.question_order, 0), scale_id: intOf(row.scale_id, 0), same_default: row.same_default ?? "0",
        relevance: row.relevance === undefined || row.relevance === "" ? "1" : row.relevance,
        question_theme_name: "", modulename: row.modulename ?? "", same_script: row.same_script ?? "0", l10n: {},
      };
      qidMap.set(row.qid ?? "", sub.qid);
      this.questions.push(sub);
    }

    // Texts: question_l10ns when the file has the section, otherwise the inline columns of the question rows.
    const textRows = file.has("question_l10ns") ? file.rows("question_l10ns") : [...file.rows("questions"), ...subRows];
    for (const row of textRows) {
      const target = this.questions.find((item) => item.qid === qidMap.get(row.qid ?? ""));
      const language = row.language ?? "";
      if (!target || !textAllowed(language)) continue;
      target.l10n[language] = { id: this.nextL10nId++, question: row.question ?? "", help: row.help ?? "", script: row.script ?? "" };
    }

    // Answers (and, in generation 7, the answers of Ranking questions as subquestions).
    const answerTexts = new Map<string, Record<string, string>>();
    if (file.has("answer_l10ns")) {
      for (const row of file.rows("answer_l10ns")) {
        const language = row.language ?? "";
        if (!textAllowed(language)) continue;
        const texts = answerTexts.get(row.aid ?? "") ?? {};
        texts[language] = row.answer ?? "";
        answerTexts.set(row.aid ?? "", texts);
      }
    }
    let dropped = !context.dropFirstAnswer;
    for (const row of file.rows("answers")) {
      if (!dropped) {
        dropped = true;
        continue;
      }
      const parent = this.questions.find((item) => item.qid === qidMap.get(row.qid ?? ""));
      if (!parent) continue;
      const texts = file.has("answer_l10ns")
        ? { ...(answerTexts.get(row.aid ?? "") ?? {}) }
        : (textAllowed(row.language ?? "") ? { [row.language ?? ""]: row.answer ?? "" } : {});
      const code = row.code ?? "";
      const scale = intOf(row.scale_id, 0);
      if (this.generation === 7 && parent.type === "R") {
        const sub: FakeQuestion = {
          qid: this.nextQid++, parent_qid: parent.qid, sid, gid: parent.gid, type: "R", title: code, preg: "", other: "N", mandatory: "N",
          encrypted: "N", question_order: intOf(row.sortorder, 0), scale_id: 0, same_default: "0", relevance: "1",
          question_theme_name: "", modulename: "", same_script: "0", l10n: {},
        };
        for (const [language, answer] of Object.entries(texts)) sub.l10n[language] = { id: this.nextL10nId++, question: answer, help: "", script: "" };
        this.questions.push(sub);
        continue;
      }
      const same = this.answers.find((item) => item.qid === parent.qid && item.scale_id === scale && item.code === code);
      if (same) {
        // Inline layout: one row per language of the same answer.
        if (!file.has("answer_l10ns")) Object.assign(same.l10n, texts);
        continue;
      }
      // LimeSurvey drops an answer that fails validation without a message.
      if (!/^[A-Za-z0-9]{1,5}$/.test(code)) continue;
      this.answers.push({
        aid: this.nextAid++, qid: parent.qid, code, sortorder: intOf(row.sortorder, 0), assessment_value: intOf(row.assessment_value, 0),
        scale_id: scale, l10n: texts,
      });
    }

    for (const row of file.rows("question_attributes")) {
      const qid = qidMap.get(row.qid ?? "");
      const language = row.language ?? "";
      if (qid === undefined) continue;
      if (language !== "" && context.attributeLanguages !== null && !context.attributeLanguages.has(language)) continue;
      this.attributes.push({ qid, attribute: row.attribute ?? "", value: row.value ?? "", language });
    }

    const defaultsByKey = new Map<string, FakeDefault>();
    const defaultTexts = file.has("defaultvalue_l10ns") ? file.rows("defaultvalue_l10ns") : null;
    for (const row of file.rows("defaultvalues")) {
      const qid = qidMap.get(row.qid ?? "");
      if (qid === undefined) continue;
      const sqidValue = row.sqid ?? "0";
      const key = row.dvid ?? `${row.qid}|${row.scale_id}|${sqidValue}|${row.specialtype}`;
      let entry = defaultsByKey.get(key);
      if (!entry) {
        entry = {
          dvid: this.nextDvid++, qid, sqid: sqidValue === "0" || sqidValue === "" ? 0 : (qidMap.get(sqidValue) ?? intOf(sqidValue, 0)),
          scale_id: intOf(row.scale_id, 0), specialtype: row.specialtype ?? "", l10n: {},
        };
        defaultsByKey.set(key, entry);
        this.defaults.push(entry);
      }
      if (defaultTexts === null && textAllowed(row.language ?? "")) entry.l10n[row.language ?? ""] = row.defaultvalue ?? "";
    }
    if (defaultTexts !== null) {
      for (const row of defaultTexts) {
        const entry = defaultsByKey.get(row.dvid ?? "");
        if (entry && textAllowed(row.language ?? "")) entry.l10n[row.language ?? ""] = row.defaultvalue ?? "";
      }
    }

    return mains;
  }
}

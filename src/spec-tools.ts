import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LimeSurveyClient } from "./client.js";
import { strictInput } from "./input-schema.js";
import { capLists, structuredSize } from "./response-limit.js";
import { scopedClient, type ClientLevel, type RpcClient, type ScopeOptions } from "./scoped-client.js";
import { diffSpecs, fingerprint, normalizeSpec, type SpecDifference } from "./spec-compare.js";
import { generateSurveyLss, specInvalidError } from "./spec-generate.js";
import { isRecord, normalizeSurveySpec, unescapeStrings } from "./spec-model.js";
import { readSurveyContext, readSurveySpec, type ReadScope } from "./spec-read.js";
import { validateSpec, type SpecFinding, type SpecWarning } from "./spec-validate.js";
import { describeError, LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";
import { assertWriteScope, requiredWriteScope } from "./write-scope.js";
import { error as workflowError, outputSchema, text as workflowText, type WorkflowResult } from "./workflow-tools.js";

const surveyId = z.number().int().positive().describe("Numeric LimeSurvey survey ID.");

/**
 * The spec as a loose object: the fields are described for the model, but nothing is rejected here, so the validator
 * can answer every mistake with a path and a fix instead of a generic schema error.
 */
const specSchema = z.looseObject({
  survey: z.unknown().optional().describe(
    "Kind survey: survey settings { title (required), language (default de), additional_languages, description, welcometext, "
    + "endtext, anonymized, datestamp, ipaddr, savetimings (true, false or \"inherit\"), format (G, A, S or I), adminemail, "
    + "showprogress (true, false or \"inherit\"), expires (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS), template, showqnumcode }. "
    + "Every text is one string (for all languages of the survey) or a map per language such as {\"de\": \"...\", \"en\": \"...\"}.",
  ),
  groups: z.unknown().optional().describe("Kind survey: list of groups, each { title, description, relevance, randomization_group, questions }."),
  title: z.unknown().optional().describe("Kind group: group name (required), a string or a map per language."),
  description: z.unknown().optional().describe("Kind group: group description, a string or a map per language."),
  relevance: z.unknown().optional().describe("Kind group or question: ExpressionScript relevance, default 1."),
  randomization_group: z.unknown().optional().describe("Kind group: name of the randomization group."),
  questions: z.unknown().optional().describe("Kind group: list of questions."),
  code: z.unknown().optional().describe("Kind question: question code, a letter first, then letters or digits, at most 20."),
  type: z.unknown().optional().describe("Kind question: question type code, one of X L ! O M Y N S T Q 5 F A R K B C E H P D G U I * |."),
  text: z.unknown().optional().describe("Kind question: question text (required), a string or a map per language."),
  help: z.unknown().optional().describe("Kind question: help text, a string or a map per language."),
  script: z.unknown().optional().describe("Kind question: JavaScript of the question, a string or a map per language."),
  mandatory: z.unknown().optional().describe("Kind question: true, false or \"soft\"."),
  other: z.unknown().optional().describe("Kind question: add an \"Other\" option (types L ! M P only)."),
  attributes: z.unknown().optional().describe(
    "Kind question: question attributes { name: string or number }; the attributes stored per language (prefix, suffix, "
    + "placeholder, ...) also take a map per language.",
  ),
  subquestions: z.unknown().optional().describe(
    "Kind question: list of { code, text, relevance, default } (rows, or the options of M and P).",
  ),
  answers: z.unknown().optional().describe("Kind question: list of { code (1-5 letters or digits), text, assessment_value }."),
  default: z.unknown().optional().describe(
    "Kind question: default value of a question without subquestions, a string or a map per language (it may name only some languages).",
  ),
  default_other: z.unknown().optional().describe("Kind question: default value of the \"Other\" option (types L and ! with other)."),
  preg: z.unknown().optional().describe("Kind question: regular expression the answer must match."),
  question_theme_name: z.unknown().optional().describe("Kind question: question theme when it is not the base theme of the type."),
  encrypted: z.unknown().optional().describe("Kind question: true to store the answers encrypted."),
  same_default: z.unknown().optional().describe("Kind question: true when the default value is the same for every language."),
  same_script: z.unknown().optional().describe("Kind question: true when the script is the same for every language."),
  modulename: z.unknown().optional().describe("Kind question: name of the module that provides the question."),
}).describe("The survey description. Its fields depend on kind; unknown fields are reported by the check, not rejected.");

type ToolInput = Record<string, unknown>;

/**
 * Like the run() of the workflow tools, but the write scope is checked with the parsed input and the operation gets a
 * client that can send no more than the scope of this call allows (read methods only for scope none; with
 * options.writeMethods only those write methods).
 */
async function runScoped(
  config: LimeSurveyConfig,
  client: RpcClient,
  workflow: string,
  input: ToolInput,
  operation: (scoped: RpcClient) => Promise<JsonValue>,
  options: ScopeOptions = {},
): Promise<WorkflowResult> {
  try {
    const name = `limesurvey_${workflow}`;
    assertWriteScope(config, name, input);
    const level: ClientLevel = requiredWriteScope(name, input) === "none" ? "none" : "content";
    const result = await operation(scopedClient(client, level, options));
    // Drops undefined values and anything else JSON cannot hold.
    return workflowText(workflow, JSON.parse(JSON.stringify(result)) as JsonValue);
  } catch (value) {
    return workflowError(workflow, value);
  }
}

/** The spec as plain JSON (drops keys that are undefined). */
const plainSpec = (spec: unknown): unknown => JSON.parse(JSON.stringify(spec ?? null));

const findingList = (findings: Array<SpecFinding | SpecWarning>): JsonValue => findings as unknown as JsonValue;

const SKIPPED_WITHOUT_SURVEY = [
  "Question codes are not compared with the codes the target survey already uses (give survey_id).",
  "A language map is not held to the languages of the target survey, only to being a map of language codes (give survey_id).",
];

export function registerSpecTools(server: McpServer, client: LimeSurveyClient, config: LimeSurveyConfig): void {
  server.registerTool(
    "limesurvey_validate_spec",
    {
      title: "Validate a survey description",
      description: "Check a survey description (spec) and report every problem at once. kind says what the spec is: survey "
        + "({ survey, groups }), group (one group with its questions) or question (one question). Returns { valid, kind, "
        + "errors [{ path, message, fix }], errors_total, warnings [{ path, message }], warnings_total, truncated, summary, "
        + "checked_against_survey, skipped_checks }. errors and warnings show at most 200 entries and are cut further to "
        + "stay within LIMESURVEY_MAX_RESPONSE_CHARS; errors_total and warnings_total hold the full numbers and truncated "
        + "says whether a list was cut. "
        + "Paths are 0-based, for example groups[1].questions[3].answers[0].code; for kind group and question they are "
        + "relative to the checked object (for example code). The check covers keys, question codes (pattern, length, "
        + "reserved words, duplicates), question types and the subquestions and answers each type needs, answer and "
        + "subquestion codes, attribute names, language codes (each once, none equal to the base language), "
        + "survey.format, survey.expires (a real date and time), XML-forbidden characters and embedded data URIs. A text "
        + "is one string (for every language) or a map per language; the map must name exactly the languages of the "
        + "survey (a default value may name fewer), and only the attributes stored per language take a map. Without "
        + "survey_id nothing is sent to LimeSurvey and skipped_checks lists the checks that need the survey (for kind "
        + "survey the languages come from the spec itself); with survey_id the tool reads the survey (read methods only) "
        + "and also reports question codes that already exist in it and holds language maps to its languages. In this "
        + "version the question types 1, : and ; are reported as not supported yet. The tool does not create or change "
        + "anything; limesurvey_create_survey_from_spec creates a survey from a valid survey spec and "
        + "limesurvey_get_survey_spec reads a survey, group or question as a spec.",
      inputSchema: strictInput({
        spec: specSchema,
        kind: z.enum(["survey", "group", "question"]).default("survey")
          .describe("What the spec describes: survey (default), group or question."),
        survey_id: surveyId.optional()
          .describe("Optional ID of an existing survey; for kind group and question its existing question codes are checked as well."),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => runScoped(config, client, "validate_spec", input, async (scoped) => {
      const { kind, survey_id } = input;
      let context: Awaited<ReturnType<typeof readSurveyContext>> | undefined;
      if (survey_id !== undefined && kind !== "survey") context = await readSurveyContext(scoped, survey_id);
      const validation = validateSpec(
        kind,
        plainSpec(input.spec),
        context ? { existingQuestionCodes: context.questionCodes, languages: context.languages } : {},
      );
      const warnings: Array<SpecFinding | SpecWarning> = [...validation.warnings];
      if (survey_id !== undefined && kind === "survey") {
        warnings.push({ path: "survey_id", message: "survey_id is not used for kind survey: a new survey has no existing survey to compare with." });
      }
      const build = (cut: { errors: SpecFinding[]; warnings: Array<SpecFinding | SpecWarning> }): JsonValue => ({
        valid: validation.valid,
        kind,
        errors: findingList(cut.errors),
        errors_total: validation.errors.length,
        warnings: findingList(cut.warnings),
        warnings_total: warnings.length,
        truncated: cut.errors.length < validation.errors.length || cut.warnings.length < warnings.length,
        summary: validation.summary as JsonValue,
        checked_against_survey: context !== undefined,
        skipped_checks: context !== undefined || kind === "survey" ? [] : SKIPPED_WITHOUT_SURVEY,
        ...(context !== undefined
          ? { survey: { survey_id: survey_id ?? null, languages: context.languages, groups: context.groups, questions_total: context.questionCodes.length } }
          : {}),
      });
      const cut = capLists(
        { errors: validation.errors, warnings },
        (lists) => structuredSize("validate_spec", build(lists)) <= config.maxResponseChars,
      );
      return build(cut);
    }),
  );

  server.registerTool(
    "limesurvey_create_survey_from_spec",
    {
      title: "Create a survey from a description",
      description: "Create a new survey from a survey description (spec { survey, groups }). The spec is checked first: an "
        + "invalid spec answers SPEC_INVALID with errors [{ path, message, fix }] and sends nothing to LimeSurvey. A valid "
        + "spec becomes a LimeSurvey structure file (.lss) that import_survey imports; the new survey stays inactive and is "
        + "not activated. The tool then reads the survey back (read methods only) and compares it with the spec. Returns "
        + "{ survey_id, title, languages, groups, questions, active, verification { ok, differences [{ path, expected, "
        + "actual }], differences_total, truncated }, truncated }, plus warnings, missing_translations and unreadable "
        + "(each with a _total) when there are any. A list shows at most 200 entries and is cut further to stay within "
        + "LIMESURVEY_MAX_RESPONSE_CHARS; the _total fields hold the full numbers and truncated says whether a list was "
        + "cut. A difference is a finding of the comparison, not an error of the call. If LimeSurvey answers the import "
        + "with an error, the tool answers CREATE_SURVEY_FAILED with LimeSurvey's message and details.created false "
        + "(nothing was created). If the import call itself fails (transport or JSON-RPC error, or no survey ID in the "
        + "answer), details.created is \"unknown\" with manual_cleanup, the title and a recovery that names "
        + "limesurvey_find_surveys: look for the survey before calling again. If only the read-back fails, "
        + "CREATE_SURVEY_FAILED names the created survey_id. The tool takes no file path, adds nothing to existing "
        + "surveys, activates nothing and deletes nothing. A spec can be checked beforehand with "
        + "limesurvey_validate_spec; limesurvey_get_survey_spec returns the spec of an existing survey in this format. "
        + "A text is one string (for every language) or a map per language. The question types 1, : and ; are not "
        + "supported yet. Needs the write scope content.",
      inputSchema: strictInput({ spec: specSchema }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => runScoped(config, client, "create_survey_from_spec", input, async (scoped) => {
      const spec = plainSpec(input.spec);
      const validation = validateSpec("survey", spec);
      if (!validation.valid) {
        throw specInvalidError(validation.errors, { workflow: "create_survey_from_spec", maxChars: config.maxResponseChars });
      }
      const lss = generateSurveyLss(spec);
      const { languages } = normalizeSurveySpec(unescapeStrings(spec));
      const expectedSpec = normalizeSpec(spec, languages);
      const title = expectedSpec.survey.title[expectedSpec.survey.language] ?? "";

      // The import call failed or answered without a survey ID: LimeSurvey may have created the survey anyway.
      const importUnknown = (message: string, extra: Record<string, JsonValue> = {}): LimeSurveyError => new LimeSurveyError(
        message,
        "CREATE_SURVEY_FAILED",
        {
          failed_step: "import_survey",
          created: "unknown",
          manual_cleanup: true,
          title,
          recovery: "It is not known whether LimeSurvey created the survey. Do not repeat the call blindly: first look for a "
            + "survey with this title with limesurvey_find_surveys. If one exists, check it in the LimeSurvey admin and "
            + "delete it (by hand, or with limesurvey_delete_survey and the write scope lifecycle) before calling the "
            + "tool again; if none exists, the call can be repeated.",
          ...extra,
        },
      );

      let importAnswer: JsonValue;
      try {
        importAnswer = await scoped.call("import_survey", [Buffer.from(lss, "utf8").toString("base64"), "lss", null, null]);
      } catch (value) {
        const detail = describeError(value);
        // Only an answer of LimeSurvey itself (an object with a status, also without error_code in 6.x) proves that
        // nothing was created; JSON-RPC errors, HTTP and transport errors and non-JSON answers prove nothing.
        const answered = value instanceof LimeSurveyError && isRecord(value.details) && "status" in value.details;
        if (!answered) {
          throw importUnknown(
            `It is unknown whether the survey was created: ${detail.message}`,
            detail.details !== undefined ? { cause: detail.details } : {},
          );
        }
        throw new LimeSurveyError(
          `The survey could not be created: ${detail.message}`,
          "CREATE_SURVEY_FAILED",
          {
            failed_step: "import_survey",
            created: false,
            recovery: "Nothing was created. Read the message of LimeSurvey, fix the cause (for example the write permission "
              + "of the service account or a language the instance does not offer) and call the tool again.",
            ...(detail.details !== undefined ? { cause: detail.details } : {}),
          },
        );
      }
      const sid = typeof importAnswer === "number" ? importAnswer : typeof importAnswer === "string" && /^\d+$/.test(importAnswer) ? Number(importAnswer) : 0;
      if (!Number.isInteger(sid) || sid <= 0) {
        throw importUnknown(
          "import_survey answered without a positive survey ID, so it is unknown whether a survey was created.",
          { answer: importAnswer },
        );
      }

      let live: Awaited<ReturnType<typeof readSurveySpec>>;
      try {
        live = await readSurveySpec(scoped, sid);
      } catch (value) {
        throw new LimeSurveyError(
          `The survey was created (survey_id ${sid}), but reading it back failed: ${describeError(value).message}`,
          "CREATE_SURVEY_FAILED",
          {
            failed_step: "verify",
            created: true,
            survey_id: sid,
            recovery: `The survey exists as survey_id ${sid} and was not compared with the spec. Look at it in the LimeSurvey `
              + "admin or read it with limesurvey_get_survey_properties, limesurvey_list_groups and limesurvey_list_questions. "
              + "Calling the tool again creates a second survey; deleting this one needs limesurvey_delete_survey and the "
              + "write scope lifecycle.",
          },
        );
      }
      const differences = diffSpecs(expectedSpec, normalizeSpec(live.spec, languages));
      const questions = live.spec.groups.reduce((total, group) => total + group.questions.length, 0);
      const lists = {
        differences,
        warnings: validation.warnings,
        missing: live.missing_translations,
        unreadable: live.unreadable,
      };
      type Lists = { differences: SpecDifference[]; warnings: SpecWarning[]; missing: typeof live.missing_translations; unreadable: typeof live.unreadable };
      const build = (cut: Lists): JsonValue => ({
        survey_id: sid,
        title,
        languages,
        groups: live.spec.groups.length,
        questions,
        active: live.active,
        verification: {
          ok: differences.length === 0,
          differences: cut.differences as unknown as JsonValue,
          differences_total: differences.length,
          truncated: cut.differences.length < differences.length,
        },
        ...(lists.warnings.length > 0 ? { warnings: cut.warnings as unknown as JsonValue, warnings_total: lists.warnings.length } : {}),
        ...(lists.missing.length > 0 ? { missing_translations: cut.missing as unknown as JsonValue, missing_translations_total: lists.missing.length } : {}),
        ...(lists.unreadable.length > 0 ? { unreadable: cut.unreadable as unknown as JsonValue, unreadable_total: lists.unreadable.length } : {}),
        truncated: cut.differences.length < lists.differences.length
          || cut.warnings.length < lists.warnings.length
          || cut.missing.length < lists.missing.length
          || cut.unreadable.length < lists.unreadable.length,
      });
      const cut = capLists<Lists>(lists, (shown) => structuredSize("create_survey_from_spec", build(shown)) <= config.maxResponseChars);
      return build(cut);
    }, { writeMethods: ["import_survey"] }),
  );

  server.registerTool(
    "limesurvey_get_survey_spec",
    {
      title: "Read a survey, group or question as a description",
      description: "Read a survey, one group or one question as a survey description (spec), with read methods only. With "
        + "survey_id alone the whole survey is read (level survey); with group_id one group (level group); with question_id "
        + "one question (level question); group_id and question_id exclude each other. Returns { level, survey_id, "
        + "group_id (level group), question_id (level question), languages, active, spec, ids, position, fingerprint, "
        + "unreadable [{ code, detail }], missing_translations [{ path, language }] }. spec has the format of "
        + "limesurvey_create_survey_from_spec: level survey { survey, groups }, level group one group, level question one "
        + "question; every text is a map per language, line breaks are \\n and HTML entities are decoded except the "
        + "markup characters; attribute values equal to the default of the question theme are left out. spec holds no "
        + "IDs: ids lists them by path (level survey: groups [{ path, group_id }] and questions [{ path, code, "
        + "question_id }]; level group: group_id and questions; level question: question_id and group_id) and position "
        + "gives the 1-based place of a group in the survey or of a question in its group. fingerprint is the SHA-256 of "
        + "the spec. unreadable lists what RemoteControl cannot read and the spec therefore lacks (conditions of the old "
        + "condition table, quota members, URL parameter assignments, the default of the \"Other\" option of M and P "
        + "questions, texts of a question that has no text row in a language); missing_translations lists the texts "
        + "that have no row in a survey language, which the map then lacks. The spec can be checked with "
        + "limesurvey_validate_spec and, at level survey, creates a copy with limesurvey_create_survey_from_spec. The "
        + "tool never shortens the answer: if it would exceed LIMESURVEY_MAX_RESPONSE_CHARS it answers SPEC_TOO_LARGE "
        + "with an outline (level survey: group_id, title, questions and estimated_chars per group) so that groups can "
        + "be read one by one. An ID of another survey answers GROUP_SURVEY_MISMATCH or QUESTION_SURVEY_MISMATCH. The "
        + "tool changes nothing and needs no write scope.",
      inputSchema: strictInput({
        survey_id: surveyId,
        group_id: z.number().int().positive().optional().describe("Optional ID of a group of this survey: read this group only."),
        question_id: z.number().int().positive().optional().describe("Optional ID of a main question of this survey: read this question only."),
      }).superRefine((value, context) => {
        if (value.group_id !== undefined && value.question_id !== undefined) {
          context.addIssue({
            code: "custom",
            message: "group_id and question_id exclude each other: give at most one of them.",
            path: ["question_id"],
          });
        }
      }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => runScoped(config, client, "get_survey_spec", input, async (scoped) => {
      const { survey_id, group_id, question_id } = input;
      const scope: ReadScope = {
        ...(group_id !== undefined ? { groupId: group_id } : {}),
        ...(question_id !== undefined ? { questionId: question_id } : {}),
      };
      const level = question_id !== undefined ? "question" : group_id !== undefined ? "group" : "survey";
      const read = await readSurveySpec(scoped, survey_id, scope);
      const { layout } = read;
      const groupIndex = question_id !== undefined
        ? layout.groups.findIndex((group) => group.questions.some((question) => question.question_id === question_id))
        : layout.groups.findIndex((group) => group.group_id === group_id);
      const layoutGroup = layout.groups[groupIndex];
      const specGroups = read.spec.groups;

      // The spec, the ids and the position of the level, with paths relative to the spec.
      let spec: unknown;
      let ids: JsonValue;
      let position: JsonValue | undefined;
      let prefix = "";
      if (level === "survey") {
        spec = read.spec;
        ids = {
          groups: layout.groups.map((group, index) => ({ path: `groups[${index}]`, group_id: group.group_id })),
          questions: layout.groups.flatMap((group, groupPos) => group.questions.map((question, index) => ({
            path: `groups[${groupPos}].questions[${index}]`,
            code: question.code,
            question_id: question.question_id,
          }))),
        };
      } else if (level === "group") {
        spec = specGroups[0];
        ids = {
          group_id: layoutGroup?.group_id ?? null,
          questions: (layoutGroup?.questions ?? []).map((question, index) => ({
            path: `questions[${index}]`,
            code: question.code,
            question_id: question.question_id,
          })),
        };
        position = { index: groupIndex + 1 };
        prefix = `groups[${groupIndex}].`;
      } else {
        const questionIndex = (layoutGroup?.questions ?? []).findIndex((question) => question.question_id === question_id);
        spec = specGroups[0]?.questions[0];
        ids = { question_id: question_id ?? null, group_id: layoutGroup?.group_id ?? null };
        position = { group_id: layoutGroup?.group_id ?? null, index: questionIndex + 1 };
        prefix = `groups[${groupIndex}].questions[${questionIndex}].`;
      }

      const relative = (path: string): string | undefined => (path.startsWith(prefix) ? path.slice(prefix.length) : undefined);
      const missingTranslations = read.missing_translations.flatMap((item) => {
        const path = relative(item.path);
        return path === undefined ? [] : [{ path, language: item.language }];
      });
      const unreadable: Array<{ code: string; detail: string }> = [
        ...UNREADABLE_BY_REMOTE_CONTROL,
        ...read.unreadable.flatMap((item) => {
          const path = relative(item.path);
          return path === undefined ? [] : [{ code: "no_text_row", detail: `${path} (${item.language}): ${item.reason}` }];
        }),
      ];
      if (questionsOf(level, spec).some((question) => (question.type === "M" || question.type === "P") && question.other)) {
        unreadable.push(OTHER_DEFAULT_UNREADABLE);
      }

      const envelope = {
        level,
        survey_id,
        ...(level === "group" ? { group_id } : {}),
        ...(level === "question" ? { question_id } : {}),
        languages: read.languages,
        active: read.active,
        spec,
        ids,
        ...(position !== undefined ? { position } : {}),
        fingerprint: fingerprint(spec),
        unreadable,
        missing_translations: missingTranslations,
      };
      const result = JSON.parse(JSON.stringify(envelope)) as JsonValue;
      const size = structuredSize("get_survey_spec", result);
      if (size > config.maxResponseChars) {
        const base = read.languages[0] ?? "";
        const titleOf = (texts: Record<string, string>): string => texts[base] ?? Object.values(texts)[0] ?? "";
        const outline: Array<Record<string, JsonValue>> = level === "survey"
          ? read.spec.groups.map((group, index) => ({
            group_id: layout.groups[index]?.group_id ?? null,
            title: titleOf(group.title),
            questions: group.questions.length,
            estimated_chars: JSON.stringify(group).length,
          }))
          : level === "group"
            ? (specGroups[0]?.questions ?? []).map((question, index) => ({
              question_id: layoutGroup?.questions[index]?.question_id ?? null,
              code: question.code,
              estimated_chars: JSON.stringify(question).length,
            }))
            : [];
        throw specTooLarge(level, size, config.maxResponseChars, outline);
      }
      return result;
    }),
  );
}

/** What RemoteControl cannot read, whatever the survey: the spec lacks it, so a copy built from the spec lacks it too. */
const UNREADABLE_BY_REMOTE_CONTROL: ReadonlyArray<{ code: string; detail: string }> = [
  {
    code: "legacy_conditions",
    detail: "Conditions of the old condition table cannot be read. Conditions that were entered as ExpressionScript are in the "
      + "stored relevance and part of the spec; a survey that still has old conditions behaves differently than its spec says.",
  },
  {
    code: "quota_members",
    detail: "Quotas and their members (the answers a quota counts) cannot be read, so they are not in the spec. A survey created "
      + "from the spec has no quotas, and replacing a question removes it from the quotas that count it.",
  },
  {
    code: "url_parameters",
    detail: "URL parameter assignments (survey parameters that fill a question) cannot be read, so they are not in the spec and "
      + "a survey created from the spec has none.",
  },
];

const OTHER_DEFAULT_UNREADABLE = {
  code: "other_default",
  detail: "The default value of the \"Other\" option of an M or P question cannot be read, so default_other is missing for these "
    + "questions even if the survey has one.",
};

/** The questions a spec of this level holds. */
function questionsOf(level: string, spec: unknown): Array<{ type: string; other: boolean }> {
  const asQuestion = (value: unknown): Array<{ type: string; other: boolean }> => (
    isRecord(value) ? [{ type: String(value.type ?? ""), other: value.other === true }] : []
  );
  const ofGroup = (group: unknown): Array<{ type: string; other: boolean }> => (
    isRecord(group) && Array.isArray(group.questions) ? group.questions.flatMap(asQuestion) : []
  );
  if (level === "question") return asQuestion(spec);
  if (level === "group") return ofGroup(spec);
  return isRecord(spec) && Array.isArray(spec.groups) ? spec.groups.flatMap(ofGroup) : [];
}

/** SPEC_TOO_LARGE: the answer would be longer than LIMESURVEY_MAX_RESPONSE_CHARS; the outline shows what to read piece by piece. */
function specTooLarge(
  level: string,
  size: number,
  maxChars: number,
  outline: Array<Record<string, JsonValue>>,
): LimeSurveyError {
  const message = `The answer would have ${size} characters, more than LIMESURVEY_MAX_RESPONSE_CHARS (${maxChars}); nothing was cut.`;
  const recovery = level === "survey"
    ? "Read the survey group by group: call limesurvey_get_survey_spec with survey_id and one group_id of the outline. If a group "
      + "is too large as well, its answer outlines the questions to read one by one with question_id. Alternatively raise "
      + "LIMESURVEY_MAX_RESPONSE_CHARS."
    : level === "group"
      ? "Read the questions of the group one by one with question_id (see the outline), or raise LIMESURVEY_MAX_RESPONSE_CHARS."
      : "Raise LIMESURVEY_MAX_RESPONSE_CHARS; a single question cannot be read in parts.";
  const details = (shown: Array<Record<string, JsonValue>>): JsonValue => ({
    level,
    estimated_chars: size,
    max_response_chars: maxChars,
    outline: shown,
    outline_total: outline.length,
    truncated: shown.length < outline.length,
    recovery,
  });
  const fits = (cut: { outline: Array<Record<string, JsonValue>> }): boolean => (
    structuredSize("get_survey_spec", { status: "error", message, code: "SPEC_TOO_LARGE", details: details(cut.outline) }) <= maxChars
  );
  return new LimeSurveyError(message, "SPEC_TOO_LARGE", details(capLists({ outline }, fits).outline));
}

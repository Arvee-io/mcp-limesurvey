import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LimeSurveyClient } from "./client.js";
import { strictInput } from "./input-schema.js";
import { scopedClient, type ClientLevel, type RpcClient } from "./scoped-client.js";
import { diffSpecs, normalizeSpec } from "./spec-compare.js";
import { generateSurveyLss } from "./spec-generate.js";
import { normalizeSurveySpec, unescapeStrings } from "./spec-model.js";
import { readSurveyContext, readSurveySpec } from "./spec-read.js";
import { validateSpec, type SpecFinding, type SpecWarning } from "./spec-validate.js";
import { describeError, LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";
import { assertWriteScope, requiredWriteScope } from "./write-scope.js";
import { error as workflowError, outputSchema, text as workflowText, type WorkflowResult } from "./workflow-tools.js";

const MAX_DIFFERENCES = 200;

const surveyId = z.number().int().positive().describe("Numeric LimeSurvey survey ID.");

/**
 * The spec as a loose object: the fields are described for the model, but nothing is rejected here, so the validator
 * can answer every mistake with a path and a fix instead of a generic schema error.
 */
const specSchema = z.looseObject({
  survey: z.unknown().optional().describe(
    "Kind survey: survey settings { title (required), language (default de), additional_languages, description, welcometext, "
    + "endtext, anonymized, datestamp, ipaddr, savetimings, format (G, A or S), adminemail, showprogress, expires "
    + "(YYYY-MM-DD or YYYY-MM-DD HH:MM:SS), template, showqnumcode }. Texts are plain strings.",
  ),
  groups: z.unknown().optional().describe("Kind survey: list of groups, each { title, description, relevance, questions }."),
  title: z.unknown().optional().describe("Kind group: group name (required)."),
  description: z.unknown().optional().describe("Kind group: group description."),
  relevance: z.unknown().optional().describe("Kind group or question: ExpressionScript relevance, default 1."),
  questions: z.unknown().optional().describe("Kind group: list of questions."),
  code: z.unknown().optional().describe("Kind question: question code, a letter first, then letters or digits, at most 20."),
  type: z.unknown().optional().describe("Kind question: question type code, one of X L ! O M Y N S T Q 5 F A R K B C E H P D G U I * |."),
  text: z.unknown().optional().describe("Kind question: question text (required)."),
  help: z.unknown().optional().describe("Kind question: help text."),
  mandatory: z.unknown().optional().describe("Kind question: true, false or \"soft\"."),
  other: z.unknown().optional().describe("Kind question: add an \"Other\" option (types L ! M P only)."),
  attributes: z.unknown().optional().describe("Kind question: question attributes { name: string or number }."),
  subquestions: z.unknown().optional().describe("Kind question: list of { code, text } (rows, or the options of M and P)."),
  answers: z.unknown().optional().describe("Kind question: list of { code (1-5 letters or digits), text, assessment_value }."),
}).describe("The survey description. Its fields depend on kind; unknown fields are reported by the check, not rejected.");

type ToolInput = Record<string, unknown>;

/**
 * Like the run() of the workflow tools, but the write scope is checked with the parsed input and the operation gets a
 * client that can send no more than the scope of this call allows (read methods only for scope none).
 */
async function runScoped(
  config: LimeSurveyConfig,
  client: RpcClient,
  workflow: string,
  input: ToolInput,
  operation: (scoped: RpcClient) => Promise<JsonValue>,
): Promise<WorkflowResult> {
  try {
    const name = `limesurvey_${workflow}`;
    assertWriteScope(config, name, input);
    const level: ClientLevel = requiredWriteScope(name, input) === "none" ? "none" : "content";
    const result = await operation(scopedClient(client, level));
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
];

export function registerSpecTools(server: McpServer, client: LimeSurveyClient, config: LimeSurveyConfig): void {
  server.registerTool(
    "limesurvey_validate_spec",
    {
      title: "Validate a survey description",
      description: "Check a survey description (spec) and report every problem at once. kind says what the spec is: survey "
        + "({ survey, groups }), group (one group with its questions) or question (one question). Returns { valid, kind, "
        + "errors [{ path, message, fix }], warnings [{ path, message }], summary, checked_against_survey, skipped_checks }. "
        + "Paths are 0-based, for example groups[1].questions[3].answers[0].code; for kind group and question they are "
        + "relative to the checked object (for example code). The check covers keys, question codes (pattern, length, "
        + "reserved words, duplicates), question types and the subquestions and answers each type needs, answer and "
        + "subquestion codes, language codes, survey.expires, XML control characters and embedded data URIs. Without "
        + "survey_id nothing is sent to LimeSurvey and skipped_checks lists the checks that need the survey; with "
        + "survey_id the tool reads the survey (read methods only) and also reports question codes that already exist "
        + "in it. In this version the question types 1, : and ; and texts per language are reported as not supported "
        + "yet. The tool does not create or change anything; limesurvey_create_survey_from_spec creates a survey from "
        + "a valid survey spec.",
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
      const validation = validateSpec(kind, plainSpec(input.spec), context ? { existingQuestionCodes: context.questionCodes } : {});
      const warnings: Array<SpecFinding | SpecWarning> = [...validation.warnings];
      if (survey_id !== undefined && kind === "survey") {
        warnings.push({ path: "survey_id", message: "survey_id is not used for kind survey: a new survey has no existing survey to compare with." });
      }
      return {
        valid: validation.valid,
        kind,
        errors: findingList(validation.errors),
        warnings: findingList(warnings),
        summary: validation.summary as JsonValue,
        checked_against_survey: context !== undefined,
        skipped_checks: context !== undefined || kind === "survey" ? [] : SKIPPED_WITHOUT_SURVEY,
        ...(context !== undefined
          ? { survey: { survey_id: survey_id ?? null, languages: context.languages, groups: context.groups, questions_total: context.questionCodes.length } }
          : {}),
      };
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
        + "actual }], differences_total, truncated } }; differences lists at most 200 entries, differences_total holds the "
        + "full number, and a difference is a finding of the comparison, not an error of the call. A failing import answers "
        + "CREATE_SURVEY_FAILED with LimeSurvey's message; nothing was created then. The tool takes no file path, adds "
        + "nothing to existing surveys, activates nothing and deletes nothing. A spec can be checked beforehand with "
        + "limesurvey_validate_spec. The question types 1, : and ; and texts per language are not supported yet. Needs "
        + "the write scope content.",
      inputSchema: strictInput({ spec: specSchema }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => runScoped(config, client, "create_survey_from_spec", input, async (scoped) => {
      const spec = plainSpec(input.spec);
      const validation = validateSpec("survey", spec);
      const lss = generateSurveyLss(spec); // throws SPEC_INVALID for an invalid spec, before any RPC
      const { survey } = normalizeSurveySpec(unescapeStrings(spec));
      const languages = [survey.language, ...survey.additional_languages.filter((language) => language !== survey.language)];
      const expectedSpec = normalizeSpec(spec, languages);

      let importAnswer: JsonValue;
      try {
        importAnswer = await scoped.call("import_survey", [Buffer.from(lss, "utf8").toString("base64"), "lss", null, null]);
      } catch (value) {
        const detail = describeError(value);
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
        throw new LimeSurveyError(
          "import_survey answered without a survey ID, so it is unknown whether a survey was created.",
          "CREATE_SURVEY_FAILED",
          {
            failed_step: "import_survey",
            created: false,
            recovery: "Look for the survey in LimeSurvey (limesurvey_find_surveys) before calling the tool again.",
            answer: importAnswer,
          },
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
            recovery: "The survey exists. Check it with limesurvey_verify_survey_against_lss or in the LimeSurvey admin; "
              + "deleting it needs limesurvey_delete_survey and the write scope lifecycle.",
          },
        );
      }
      const differences = diffSpecs(expectedSpec, normalizeSpec(live.spec, languages));
      const questions = live.spec.groups.reduce((total, group) => total + group.questions.length, 0);
      return {
        survey_id: sid,
        title: expectedSpec.survey.title[expectedSpec.survey.language] ?? "",
        languages,
        groups: live.spec.groups.length,
        questions,
        active: live.active,
        verification: {
          ok: differences.length === 0,
          differences: differences.slice(0, MAX_DIFFERENCES) as unknown as JsonValue,
          differences_total: differences.length,
          truncated: differences.length > MAX_DIFFERENCES,
        },
        ...(validation.warnings.length > 0 ? { warnings: findingList(validation.warnings) } : {}),
        ...(live.missing_translations.length > 0 ? { missing_translations: live.missing_translations as unknown as JsonValue } : {}),
      };
    }),
  );
}

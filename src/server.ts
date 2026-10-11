import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LimeSurveyClient, type FetchImplementation } from "./client.js";
import {
  buildRpcParams,
  jsonValueSchema,
  toolDefinitions,
  type ResponseFormat,
} from "./tool-definitions.js";
import { describeError, type JsonValue, type LimeSurveyConfig, type LimeSurveyToolResult } from "./types.js";
import { registerWorkflowTools } from "./workflow-tools.js";
import { registerThemeTools } from "./theme-tools.js";
import { assertWriteScope } from "./write-scope.js";

const outputSchema = z.object({
  method: z.string(),
  result: jsonValueSchema,
  truncated: z.boolean().optional(),
  truncation_message: z.string().optional(),
  warnings: z.array(jsonValueSchema).optional(),
});

function markdownValue(value: JsonValue): string {
  if (value === null) return "`null`";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``;
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function prepareResult(
  method: string,
  result: JsonValue,
  maxResponseChars: number,
): LimeSurveyToolResult {
  const serialized = JSON.stringify(result);
  if (serialized.length <= maxResponseChars) return { method, result };

  const previewLength = Math.max(100, Math.min(2_000, Math.floor(maxResponseChars / 4)));
  return {
    method,
    result: {
      status: "response_too_large",
      original_characters: serialized.length,
      preview: serialized.slice(0, previewLength),
    },
    truncated: true,
    truncation_message: `The result exceeded ${maxResponseChars} characters. Narrow the request or increase LIMESURVEY_MAX_RESPONSE_CHARS. Base64 previews are not valid files.`,
  };
}

function textResult(result: LimeSurveyToolResult, format: ResponseFormat): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const suffix = result.truncation_message ? `\n\n${result.truncation_message}` : "";
  const warnings = result.warnings?.length
    ? `\n\n### Warnings\n\n${markdownValue(result.warnings)}`
    : "";
  return `## ${result.method}\n\n${markdownValue(result.result)}${suffix}${warnings}`;
}

export const SERVER_VERSION = "1.4.0";

export function createServer(
  config: LimeSurveyConfig,
  fetchImpl?: FetchImplementation,
): { server: McpServer; client: LimeSurveyClient } {
  const server = new McpServer({ name: "limesurvey-mcp-server", version: SERVER_VERSION });
  const client = new LimeSurveyClient(config, fetchImpl);

  for (const definition of toolDefinitions) {
    server.registerTool(
      `limesurvey_${definition.method}`,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema,
        annotations: definition.annotations,
      },
      async (input) => {
        const rawInput = input as Record<string, unknown>;
        const format = (rawInput.response_format ?? "json") as ResponseFormat;
        try {
          assertWriteScope(config, `limesurvey_${definition.method}`, rawInput);
          const preparedInput = definition.prepare ? await definition.prepare(rawInput, config) : rawInput;
          const overridden = definition.override ? await definition.override(preparedInput, client, config) : undefined;
          const answer = overridden !== undefined
            ? overridden
            : await client.call(definition.method, buildRpcParams(definition, preparedInput));
          const warnings = overridden === undefined && definition.afterCall
            ? await definition.afterCall(answer, preparedInput, client)
            : undefined;
          const result = overridden === undefined && definition.enrich
            ? definition.enrich(answer, preparedInput)
            : answer;
          const output: LimeSurveyToolResult = {
            ...prepareResult(definition.method, result, config.maxResponseChars),
            ...(warnings && warnings.length > 0 ? { warnings } : {}),
          };
          return {
            content: [{ type: "text" as const, text: textResult(output, format) }],
            structuredContent: output,
          };
        } catch (error) {
          const detail = describeError(error);
          const output: LimeSurveyToolResult = {
            method: definition.method,
            result: { status: "error", ...detail } as JsonValue,
          };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }
      },
    );
  }

  registerWorkflowTools(server, client, config);
  registerThemeTools(server, client, config);

  return { server, client };
}

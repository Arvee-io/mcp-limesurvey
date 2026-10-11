import { z } from "zod";

/**
 * A strict input object whose "unrecognized keys" error names the unknown keys AND the parameters the tool
 * expects, so a typo like `survey_groupid` is fixable from the error alone.
 *
 * zod 4: z.strictObject(shape, params) accepts `error` (a function of the issue); it is consulted for the
 * object's own issues, and only the unrecognized_keys issue is customized here, every other issue keeps zod's
 * default message. Checks added afterwards (for example .superRefine) stay on the returned ZodObject.
 */
export function strictInput<T extends z.ZodRawShape>(shape: T) {
  const expected = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined;
      const unknown = issue.keys.join(", ");
      const accepted = expected.length > 0 ? expected.join(", ") : "none (this tool takes no arguments)";
      return `Unknown argument${issue.keys.length > 1 ? "s" : ""}: ${unknown}. This tool accepts: ${accepted}.`;
    },
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { generateSurveyLss } from "../src/spec-generate.js";

/**
 * GEN-PARITY: the TypeScript generator produces the same .lss as the Python generator of the plugin
 * (scripts/lss_tools.py, plugin 1.2.1) for the reference specs in test/fixtures/lss-parity.
 */

const root = path.resolve("test", "fixtures", "lss-parity");
const PYTHON_TYPES = "XL!OMYNSTQ5FARKBCEHPDGUI*|".split("");

interface ParityCase {
  spec: string;
  lss?: string | null;
  types: string[];
}

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { cases: ParityCase[] };

/** Every section of a .lss as a list of rows (field name -> value), for a readable diff before the byte check. */
function sections(xml: string): Record<string, Array<Record<string, string>>> {
  const document = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (_name, jpath) => typeof jpath === "string" && jpath.endsWith(".row"),
  }).parse(xml).document as Record<string, unknown>;
  const result: Record<string, Array<Record<string, string>>> = {};
  for (const [name, node] of Object.entries(document)) {
    const rows = (node as { rows?: { row?: unknown } } | undefined)?.rows?.row;
    if (Array.isArray(rows)) {
      result[name] = rows.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, String(value)])));
    } else {
      result[name] = [{ value: JSON.stringify(node) }];
    }
  }
  return result;
}

test("[GEN-PARITY] the manifest covers every Python question type with a reference .lss", () => {
  const withReference = new Set(manifest.cases.filter((item) => item.lss).flatMap((item) => item.types));
  assert.deepEqual(PYTHON_TYPES.filter((type) => !withReference.has(type)), []);
});

for (const item of manifest.cases.filter((entry) => entry.lss)) {
  test(`[GEN-PARITY] ${item.spec} generates the same .lss as the Python generator`, async () => {
    const spec = JSON.parse(await readFile(path.join(root, item.spec), "utf8")) as unknown;
    const expected = await readFile(path.join(root, item.lss as string), "utf8");
    const actual = generateSurveyLss(spec);
    assert.deepEqual(sections(actual), sections(expected), "rows differ");
    assert.equal(actual, expected, "bytes differ");
  });
}

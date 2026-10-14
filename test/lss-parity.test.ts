import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { I18N_ATTRIBUTES } from "../src/attribute-defaults.js";
import { generateSurveyLss } from "../src/spec-generate.js";
import { parseStructureFile } from "./helpers/add-tools.js";

/**
 * GEN-PARITY: the TypeScript generator produces the same .lss as the Python generator of the plugin
 * (scripts/lss_tools.py, plugin 1.2.1) for the reference specs in test/fixtures/lss-parity. GEN-TYPES: the types the
 * Python generator cannot produce (1, : and ;) have cases without a reference .lss; their file is generated, parsed and
 * checked against the spec.
 */

const root = path.resolve("test", "fixtures", "lss-parity");
const PYTHON_TYPES = "XL!OMYNSTQ5FARKBCEHPDGUI*|".split("");
const CORE_TYPES = "XL!OMYNSTQ5FARKBCEHPDGUI*|1:;".split("");

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

// ---- GEN-TYPES: cases without a reference .lss ----

test("[GEN-PARITY] [GEN-TYPES] the manifest covers all 29 core question types; 1, : and ; are the cases without a reference .lss", () => {
  const covered = new Set(manifest.cases.flatMap((item) => item.types));
  assert.deepEqual(CORE_TYPES.filter((type) => !covered.has(type)), []);
  const withoutReference = new Set(manifest.cases.filter((item) => !item.lss).flatMap((item) => item.types));
  assert.deepEqual(withoutReference, new Set(["1", ":", ";"]));
});

type TextValue = string | Record<string, string>;

interface SpecItem {
  code: string;
  text: TextValue;
  scale_id?: number;
}

interface SpecQuestion {
  code: string;
  type: string;
  text: TextValue;
  subquestions?: SpecItem[];
  answers?: SpecItem[];
  attributes?: Record<string, TextValue>;
}

interface SpecDocument {
  survey: { language?: string; additional_languages?: string[] };
  groups: Array<{ questions: SpecQuestion[] }>;
}

const textIn = (value: TextValue, language: string): string => (typeof value === "string" ? value : value[language] ?? "");

/** The items of the spec as the file must number them: code, scale (0 when not given) and the place within the scale (from 0). */
function numbered(items: readonly SpecItem[] | undefined): Array<[code: string, scale: string, order: string]> {
  const next = new Map<number, number>();
  return (items ?? []).map((item) => {
    const scale = item.scale_id ?? 0;
    const order = next.get(scale) ?? 0;
    next.set(scale, order + 1);
    return [item.code, String(scale), String(order)];
  });
}

/** The generated .lss against its spec: languages, questions and types, subquestions and answers with scale and order, texts per language, attributes. */
function assertStructure(spec: SpecDocument, lss: string, types: readonly string[]): void {
  const file = parseStructureFile(Buffer.from(lss, "utf8").toString("base64"));
  const rows = (section: string): Array<Record<string, string>> => file.sections[section] ?? [];
  const textOf = (section: string, idField: string, id: string | undefined, field: string, language: string): string | undefined => (
    rows(section).find((row) => row[idField] === id && row.language === language)?.[field]
  );
  const languages = [spec.survey.language ?? "de", ...(spec.survey.additional_languages ?? [])];
  assert.deepEqual(file.languages, languages, "the languages of the file are the survey languages");

  const questions = spec.groups.flatMap((group) => group.questions);
  assert.deepEqual(new Set(questions.map((question) => question.type)), new Set(types), "the case holds exactly its types");
  for (const question of questions) {
    const row = rows("questions").find((item) => item.title === question.code);
    assert.ok(row, `the file has no question row for ${question.code}`);
    assert.equal(row.type, question.type, `${question.code}: type`);
    const qid = row.qid;
    for (const language of languages) {
      assert.equal(textOf("question_l10ns", "qid", qid, "question", language), textIn(question.text, language), `${question.code}: text (${language})`);
    }

    const subquestions = rows("subquestions").filter((item) => item.parent_qid === qid);
    assert.deepEqual(
      subquestions.map((item) => [item.title, item.scale_id, item.question_order]),
      numbered(question.subquestions),
      `${question.code}: subquestions (code, scale_id, question_order within the scale)`,
    );
    (question.subquestions ?? []).forEach((sub, index) => {
      for (const language of languages) {
        assert.equal(
          textOf("question_l10ns", "qid", subquestions[index]?.qid, "question", language),
          textIn(sub.text, language),
          `${question.code}: subquestion ${sub.code} (scale ${sub.scale_id ?? 0}) text (${language})`,
        );
      }
    });

    const answers = rows("answers").filter((item) => item.qid === qid);
    assert.deepEqual(
      answers.map((item) => [item.code, item.scale_id, item.sortorder]),
      numbered(question.answers),
      `${question.code}: answers (code, scale_id, sortorder within the scale)`,
    );
    (question.answers ?? []).forEach((answer, index) => {
      for (const language of languages) {
        assert.equal(
          textOf("answer_l10ns", "aid", answers[index]?.aid, "answer", language),
          textIn(answer.text, language),
          `${question.code}: answer ${answer.code} (scale ${answer.scale_id ?? 0}) text (${language})`,
        );
      }
    });

    for (const [name, value] of Object.entries(question.attributes ?? {})) {
      const stored = rows("question_attributes").filter((item) => item.qid === qid && item.attribute === name);
      // An attribute stored per language has one row per survey language; any other one row without a language.
      const expected = I18N_ATTRIBUTES.has(name) || typeof value !== "string"
        ? languages.map((language) => [language, textIn(value, language)])
        : [["", value]];
      assert.deepEqual(stored.map((item) => [item.language, item.value]), expected, `${question.code}: attribute ${name}`);
    }
  }
}

for (const item of manifest.cases.filter((entry) => !entry.lss)) {
  test(`[GEN-PARITY] [GEN-TYPES] ${item.spec} (no Python reference) generates a .lss whose structure matches the spec`, async () => {
    const spec = JSON.parse(await readFile(path.join(root, item.spec), "utf8")) as SpecDocument;
    let lss = "";
    assert.doesNotThrow(() => {
      lss = generateSurveyLss(spec);
    }, `the generator accepts ${item.spec}`);
    assertStructure(spec, lss, item.types);
  });
}

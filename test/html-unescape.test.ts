import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { unescapeHtml, unescapeHtmlSafe } from "../src/html-unescape.js";

/**
 * GEN-PARITY: unescapeHtml decodes exactly like Python's html.unescape (the expectations in
 * test/fixtures/html-unescape-cases.json were computed with Python 3.14). unescapeHtmlSafe decodes a reference only when
 * it ends with ";" (a numeric reference or an exact HTML5 name) and the result has none of & < > " ', so decoded markup
 * never appears and URLs like ?a=1&copy=2 stay intact; the field "safe" holds the result of a Python reference
 * implementation of that rule.
 */

const cases = JSON.parse(
  await readFile(path.resolve("test", "fixtures", "html-unescape-cases.json"), "utf8"),
) as Array<{ input: string; python: string; safe: string }>;

const MARKUP_CHARACTERS = /[&<>"']/;

test("[GEN-PARITY] the case file is not empty and every case has input and python", () => {
  assert.ok(cases.length >= 50, `only ${cases.length} cases`);
  for (const item of cases) {
    assert.equal(typeof item.input, "string");
    assert.equal(typeof item.python, "string");
  }
});

test("[GEN-PARITY] unescapeHtml equals Python html.unescape for every case", () => {
  for (const { input, python } of cases) {
    assert.equal(unescapeHtml(input), python, `input ${JSON.stringify(input)}`);
  }
});

const safeExamples: Array<[string, string]> = [
  ["&amp;amp;", "&amp;amp;"],
  ["a&lt;b", "a&lt;b"],
  ["&quot;x&quot;", "&quot;x&quot;"],
  ["&#39;", "&#39;"],
  ["&#60;", "&#60;"],
  ["&lt;b&gt;bold&lt;/b&gt;", "&lt;b&gt;bold&lt;/b&gt;"],
  ["&ampx;", "&ampx;"],
  ["&AMP", "&AMP"],
  ["&gt", "&gt"],
  ["&auml;", "ä"],
  ["Gr&ouml;&szlig;e", "Größe"],
  ["&nbsp;", " "],
  ["&#8211;", "–"],
  ["&bdquo;Zitat&ldquo;", "„Zitat“"],
  ["&apos;", "&apos;"],
  ["&#x3C;", "&#x3C;"],
  ["&GT;", "&GT;"],
  ["&ltx", "&ltx"],
  ["&auml; &lt; &ouml;", "ä &lt; ö"],
];

test("[GEN-PARITY] unescapeHtmlSafe leaves references to & < > \" ' alone and decodes the others", () => {
  for (const [input, expected] of safeExamples) {
    assert.equal(unescapeHtmlSafe(input), expected, `input ${JSON.stringify(input)}`);
  }
});

test("[GEN-PARITY] unescapeHtmlSafe equals Python wherever Python's result has none of & < > \" ' and every reference ends with ;", () => {
  const relevant = cases.filter((item) => !MARKUP_CHARACTERS.test(item.python) && item.safe === item.python);
  assert.ok(relevant.length > 20);
  for (const { input, python } of relevant) {
    assert.equal(unescapeHtmlSafe(input), python, `input ${JSON.stringify(input)}`);
  }
});

test("[GEN-PARITY] unescapeHtmlSafe equals the reference rule for every case (decode only name; or numeric; without markup)", () => {
  for (const { input, safe } of cases) {
    assert.equal(unescapeHtmlSafe(input), safe, `input ${JSON.stringify(input)}`);
  }
});

test("[GEN-PARITY] unescapeHtmlSafe keeps references without a closing semicolon, so URLs and expressions stay intact", () => {
  for (const [input, expected] of [
    ["&auml", "&auml"],
    ["?a=1&copy=2", "?a=1&copy=2"],
    ["&notit;", "&notit;"],
    ["&#8226", "&#8226"],
    ["x &&notes y", "x &&notes y"],
  ] as Array<[string, string]>) {
    assert.equal(unescapeHtmlSafe(input), expected, `input ${JSON.stringify(input)}`);
  }
});

test("[GEN-PARITY] unescapeHtmlSafe is idempotent for every case", () => {
  for (const { input } of cases) {
    const once = unescapeHtmlSafe(input);
    assert.equal(unescapeHtmlSafe(once), once, `input ${JSON.stringify(input)}`);
  }
});

// Builds src/attribute-defaults.ts from the question theme definitions of two LimeSurvey source trees.
// Usage: node tools/build-attribute-defaults.mjs <limesurvey-6-root> <limesurvey-7-root> <output.ts>
//
// RemoteControl's get_question_properties reports every attribute the question type and theme define, filled with
// the definition's default when nothing is stored, so stored values and defaults look the same. The table lets the
// spec reader drop values that equal the default. Only names and default values are taken from the definitions
// (application/views/survey/questions/answer/**/config.xml and themes/question/*/survey/questions/answer/*/config.xml):
// the <attributes> section (RemoteControl reads it with advancedOnly=true, so <generalattributes> is not reported),
// extended themes override core attributes of the same name, and an extended attribute with an empty inputtype
// removes the core attribute. A default is listed only when both versions agree (or only one version defines the
// attribute); differing defaults are left out, so such values always stay explicit.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

const [, , root6, root7, output] = process.argv;
if (!root6 || !root7 || !output) {
  console.error("usage: node tools/build-attribute-defaults.mjs <limesurvey-6-root> <limesurvey-7-root> <output.ts>");
  process.exit(2);
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name, jpath) => jpath === "config.attributes.attribute",
});

async function findConfigs(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findConfigs(full)));
    else if (entry.name === "config.xml") found.push(full);
  }
  return found;
}

const text = (value) => (value === undefined || value === null || typeof value === "object" ? "" : String(value));

async function readTheme(file) {
  const config = parser.parse(await readFile(file, "utf8")).config ?? {};
  const meta = config.metadata ?? {};
  const attributes = {};
  for (const attribute of config.attributes?.attribute ?? []) {
    const name = text(attribute?.name);
    if (!name) continue;
    attributes[name] = { default: text(attribute.default), i18n: text(attribute.i18n) === "1", inputtype: text(attribute.inputtype) };
  }
  return { name: text(meta.name), type: text(meta.questionType), attributes };
}

async function load(root) {
  const core = {};
  const baseThemeByType = {};
  for (const file of await findConfigs(path.join(root, "application", "views", "survey", "questions", "answer"))) {
    const theme = await readTheme(file);
    if (!theme.type) continue;
    core[theme.name] = theme.attributes;
    baseThemeByType[theme.type] = theme.name;
  }
  const effective = { ...core };
  const i18n = new Set();
  for (const attributes of Object.values(core)) for (const [name, def] of Object.entries(attributes)) if (def.i18n) i18n.add(name);
  for (const file of await findConfigs(path.join(root, "themes", "question"))) {
    const theme = await readTheme(file);
    const base = core[baseThemeByType[theme.type]];
    if (!theme.type || !base) continue;
    const merged = { ...base };
    for (const [name, def] of Object.entries(theme.attributes)) {
      if (def.inputtype === "") delete merged[name];
      else merged[name] = def;
    }
    effective[theme.name] = merged;
  }
  return { effective, baseThemeByType, i18n };
}

const v6 = await load(root6);
const v7 = await load(root7);

// HiddenQuestionAttributeProvider adds "image" (default "") to every question type outside the XML definitions;
// get_question_properties reports it for every question in 6.17.11 and 7.5.1 (live runs).
const HIDDEN_ATTRIBUTES = { image: "" };

const themes = [...new Set([...Object.keys(v6.effective), ...Object.keys(v7.effective)])].sort();
const table = {};
let dropped = 0;
for (const theme of themes) {
  const a = v6.effective[theme] ?? {};
  const b = v7.effective[theme] ?? {};
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const entries = { ...HIDDEN_ATTRIBUTES };
  for (const name of names) {
    if (a[name] && b[name] && a[name].default !== b[name].default) { dropped += 1; continue; }
    entries[name] = (b[name] ?? a[name]).default;
  }
  table[theme] = entries;
}

// The names of the attributes a theme defines in either version, whatever their default (the defaults table above leaves
// out names whose default differs). The spec check uses them: an attribute some theme defines but the theme of the
// question does not is not used by that question.
const names = {};
let nameCount = 0;
for (const theme of themes) {
  const a = v6.effective[theme] ?? {};
  const b = v7.effective[theme] ?? {};
  names[theme] = [...new Set([...Object.keys(HIDDEN_ATTRIBUTES), ...Object.keys(a), ...Object.keys(b)])].sort();
  nameCount += names[theme].length;
}
const distinctNames = new Set(Object.values(names).flat()).size;

const types = [...new Set([...Object.keys(v6.baseThemeByType), ...Object.keys(v7.baseThemeByType)])].sort();
const baseThemes = {};
for (const type of types) {
  const x = v6.baseThemeByType[type];
  const y = v7.baseThemeByType[type];
  if (x && y && x !== y) throw new Error(`base theme of ${type} differs: ${x} / ${y}`);
  baseThemes[type] = y ?? x;
}
const i18n = [...new Set([...v6.i18n, ...v7.i18n])].sort();

const q = (value) => JSON.stringify(value);
const lines = [
  "// Generated by tools/build-attribute-defaults.mjs from the question theme definitions (config.xml) of",
  "// LimeSurvey 6.17.11 and 7.5.1: attribute names and default values only. Do not edit by hand.",
  "",
  "/** Base question theme per question type (question_theme_name when no extended theme is used). */",
  `export const BASE_THEME_BY_TYPE: Readonly<Record<string, string>> = ${q(baseThemes)};`,
  "",
  "/** Attributes stored per language (one question_attributes row per survey language). */",
  `export const I18N_ATTRIBUTES: ReadonlySet<string> = new Set(${q(i18n)});`,
  "",
  "/**",
  " * Default value per question theme and attribute. Missing: the attribute is unknown (for example a plugin",
  " * attribute) or its default differs between LimeSurvey 6 and 7; such values are always kept explicit.",
  " */",
  "export const ATTRIBUTE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
];
for (const theme of themes) lines.push(`  ${q(theme)}: ${q(table[theme])},`);
lines.push("};", "");
lines.push(
  "/**",
  " * Names of the attributes each question theme defines in LimeSurvey 6 or 7 (the union, whatever the default; image",
  " * included). An attribute that some theme defines but the theme of a question does not is not used by that question.",
  " */",
  "export const ATTRIBUTE_NAMES: Readonly<Record<string, readonly string[]>> = {",
);
for (const theme of themes) lines.push(`  ${q(theme)}: ${q(names[theme])},`);
lines.push("};", "");
await writeFile(output, lines.join("\n"), "utf8");
console.log(`themes=${themes.length} types=${types.length} i18n=${i18n.length} version-dependent defaults left out=${dropped} `
  + `attribute names=${nameCount} distinct names=${distinctNames}`);

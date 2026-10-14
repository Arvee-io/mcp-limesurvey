import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { z } from "zod";
import type { LimeSurveyClient } from "./client.js";
import { strictInput } from "./input-schema.js";
import { jsonValueSchema } from "./tool-definitions.js";
import { describeError, LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";
import { assertWriteScope } from "./write-scope.js";

const outputSchema = z.object({ workflow: z.string(), result: jsonValueSchema });
const themeNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,63}$/, "Use 3-64 lowercase ASCII letters, digits, and underscores; start with a letter.")
  .describe(
    "Base name of the theme package, for example acme_feedback. LimeSurvey installs the package as "
      + "installed_theme_name: <theme_name>-<theme_version without dots>-ls<major>, at most 45 characters.",
  );

// LimeSurvey refuses a theme name longer than 45 characters or containing one of #$%^&*()+=[]';,./{}|:<>?~
// (Template::$sTemplateNameIllegalChars, Template.php:51; validateTemplateName, Template.php:97-108). The pattern
// allows none of these characters and is stricter still: ASCII letters, digits, "_" and "-", starting with a letter
// or digit, which covers every name LimeSurvey derives from a generated package.
const maxInstalledThemeNameLength = 45;
const installedThemeNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,44}$/;
const installedThemeNameSchema = z
  .string()
  .regex(
    installedThemeNamePattern,
    "Use the installed theme name: 1-45 ASCII letters, digits, '_' or '-', starting with a letter or digit, "
      + "for example acme_feedback-100-ls7.",
  )
  .describe(
    "Installed LimeSurvey theme name as shown in the theme list, for example acme_feedback-100-ls7 "
      + "(installed_theme_name of limesurvey_generate_survey_theme) or a core theme such as vanilla.",
  );

/**
 * The name LimeSurvey 7.5.1 installs an uploaded survey theme under: the uploaded ZIP file name without ".zip" and
 * with every dot removed (Themes.php:365, :1430-1438; sanitize_dirname, sanitize_helper.php:190-194). LimeSurvey does
 * not read config.xml metadata/name for this (TemplateConfig.php:1050-1051).
 */
function installedThemeName(fileName: string): string {
  return fileName.replace(/\.zip$/i, "").replaceAll(".", "");
}

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hexadecimal color such as #0B6B57.");

type WorkflowResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { workflow: string; result: JsonValue };
  isError?: true;
};

function response(workflow: string, result: JsonValue, isError = false): WorkflowResult {
  const structuredContent = { workflow, result };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true as const } : {}),
  };
}

async function run(
  config: LimeSurveyConfig,
  workflow: string,
  operation: () => Promise<JsonValue>,
): Promise<WorkflowResult> {
  try {
    // The scope check runs before the operation, so nothing is read or sent when a tool is blocked.
    assertWriteScope(config, `limesurvey_${workflow}`);
    return response(workflow, await operation());
  } catch (value) {
    return response(workflow, { status: "error", ...describeError(value) } as JsonValue, true);
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

function foreground(background: string): string {
  return contrast(background, "#FFFFFF") >= contrast(background, "#111111") ? "#FFFFFF" : "#111111";
}

function darken(hex: string, factor = 0.82): string {
  return `#${rgb(hex).map((value) => Math.round(value * factor).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function safeThemeTarget(config: LimeSurveyConfig, fileName: string): { root: string; target: string } {
  if (!config.themeDir) {
    throw new LimeSurveyError(
      "LIMESURVEY_THEME_DIR is not configured. Set it to a dedicated directory for generated theme packages, then "
        + "fully restart the MCP client process; reconnecting alone does not reload environment variables.",
    );
  }
  if (
    fileName !== path.basename(fileName)
    || fileName.includes("/")
    || fileName.includes("\\")
    || fileName.includes("\0")
    || !fileName.toLowerCase().endsWith(".zip")
  ) {
    throw new LimeSurveyError("Theme package file names must be plain .zip names without directories.");
  }
  const root = path.resolve(config.themeDir);
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LimeSurveyError("The theme package path is outside LIMESURVEY_THEME_DIR.");
  }
  return { root, target };
}

function decodeLogo(base64: string, type: "png" | "jpeg", maxBytes: number): Buffer {
  const normalized = base64.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new LimeSurveyError("logo_base64 is not valid base64.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength > maxBytes) {
    throw new LimeSurveyError(`The logo exceeds LIMESURVEY_MAX_THEME_ASSET_BYTES (${maxBytes}).`);
  }
  const valid = type === "png"
    ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : isJpeg(buffer);
  if (!valid) throw new LimeSurveyError(`The logo content does not match logo_file_type=${type}.`);
  return buffer;
}

function startsWith(buffer: Buffer, signature: string | number[]): boolean {
  const expected = typeof signature === "string" ? Buffer.from(signature, "latin1") : Buffer.from(signature);
  return buffer.subarray(0, expected.length).equals(expected);
}

// Start of image plus the first marker. The end-of-image marker is not checked: encoders and editors may append
// padding or metadata after it.
const isJpeg = (buffer: Buffer): boolean => startsWith(buffer, [0xff, 0xd8, 0xff]);
// TrueType and OpenType share the sfnt container; either extension may hold TrueType (0x00010000, "true") or
// CFF ("OTTO") outlines.
const isSfnt = (buffer: Buffer): boolean =>
  startsWith(buffer, [0x00, 0x01, 0x00, 0x00]) || startsWith(buffer, "OTTO") || startsWith(buffer, "true");

// First bytes of the file types the validator checks by content. EOT has no leading signature and is not checked.
const contentSignatures: Record<string, { kind: "Image" | "Font"; matches: (buffer: Buffer) => boolean }> = {
  png: { kind: "Image", matches: (buffer) => startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { kind: "Image", matches: isJpeg },
  jpeg: { kind: "Image", matches: isJpeg },
  gif: { kind: "Image", matches: (buffer) => startsWith(buffer, "GIF87a") || startsWith(buffer, "GIF89a") },
  ico: { kind: "Image", matches: (buffer) => startsWith(buffer, [0x00, 0x00, 0x01, 0x00]) },
  woff2: { kind: "Font", matches: (buffer) => startsWith(buffer, "wOF2") },
  woff: { kind: "Font", matches: (buffer) => startsWith(buffer, "wOFF") },
  ttf: { kind: "Font", matches: isSfnt },
  otf: { kind: "Font", matches: isSfnt },
};

// Default allowedthemeuploads and allowedthemeimageformats of LimeSurvey 7.5.1 (config-defaults.php:98-99) plus twig,
// which templateExtractFilter always adds (template_helper.php:130-141). The import silently skips every other file
// and ends as a "Partial import"; folders and files without an extension always pass. An instance can change both
// lists in its config.php; these are the defaults.
const limeSurveyThemeExtensions = new Set([
  "css", "js", "map", "json", "eot", "otf", "ttf", "woff", "txt", "md", "xml", "woff2", "twig", "lss", "lsa", "lsq",
  "lsg", "gif", "ico", "jpg", "jpeg", "png",
]);

// The file types of the generator's own policy. LimeSurvey also imports the rest of its list (JavaScript, source maps,
// JSON, XML, Twig templates, survey exports) and files without an extension; those only give a "policy:" warning.
// The generator ships no Twig templates: generated themes inherit every layout from vanilla.
const policyThemeExtensions = new Set([
  "css", "txt", "md", "png", "jpg", "jpeg", "gif", "ico", "woff2", "woff", "ttf", "otf", "eot",
]);

// Upper bound for the number of archive entries the validator looks at; the policy warning starts at 50.
const maxThemeEntries = 1000;

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ (crc32Table[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Size and CRC-32 as the ZIP central directory declares them (JSZip keeps them on the entry). */
function entryMetadata(entry: JSZip.JSZipObject): { uncompressedSize: number; crc32: number | undefined } {
  const internal = entry as unknown as { _data?: { uncompressedSize?: number; crc32?: number } };
  return { uncompressedSize: internal._data?.uncompressedSize ?? 0, crc32: internal._data?.crc32 };
}

/**
 * Decompresses one entry as a stream and stops once it exceeds maxBytes, so an entry whose declared size is wrong
 * cannot fill the memory. The content must match the CRC-32 the archive declares.
 */
async function readEntry(
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<{ content: Buffer; error?: undefined } | { content?: undefined; error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  try {
    // JSZip's node stream is not async-iterable; its events are.
    const stream = entry.nodeStream("nodebuffer");
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer | string) => {
        if (exceeded) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > maxBytes) {
          exceeded = true;
          stream.pause();
          resolve();
          return;
        }
        chunks.push(bytes);
      });
      stream.on("end", () => resolve());
      stream.on("error", (error: Error) => reject(error));
    });
  } catch (value) {
    return { error: `Theme entry cannot be decompressed (${value instanceof Error ? value.message : String(value)}): ${entry.name}` };
  }
  if (exceeded) return { error: `Theme entry exceeds LIMESURVEY_MAX_THEME_ASSET_BYTES when decompressed: ${entry.name}` };
  const content = Buffer.concat(chunks);
  const expected = entryMetadata(entry).crc32;
  // JSZip keeps the declared CRC-32 as a signed 32-bit integer.
  if (expected !== undefined && crc32(content) !== expected >>> 0) {
    return { error: `Theme entry does not match its CRC-32 checksum; the archive is damaged: ${entry.name}` };
  }
  return { content };
}

/** The extension as PHP's pathinfo() reports it: the text after the last dot of the base name, undefined without one. */
function fileExtension(entryName: string): string | undefined {
  const base = entryName.slice(entryName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? undefined : base.slice(dot + 1).toLowerCase();
}

/** Mirrors templateExtractFilter with the default lists: true for a file the LimeSurvey import leaves out. */
function skippedByLimeSurvey(entry: JSZip.JSZipObject): boolean {
  if (entry.dir) return false;
  const extension = fileExtension(entry.name);
  return extension !== undefined && !limeSurveyThemeExtensions.has(extension);
}

const generatedThemeLicenseNotice = `GNU GENERAL PUBLIC LICENSE
Version 2, June 1991, or (at your option) any later version

This generated LimeSurvey survey theme is licensed under GPL-2.0-or-later.
It is designed to inherit the GPL-licensed LimeSurvey vanilla theme.

License text and terms:
https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

SPDX-License-Identifier: GPL-2.0-or-later
`;

// LimeSurvey 7 adds every survey theme's own views/ path to the Twig FilesystemLoader and raises a
// Twig LoaderError ("... /views/ directory does not exist") when it is absent -- even for an inheriting
// theme that overrides no templates. Shipping this placeholder guarantees the directory exists after
// extraction; the actual layout templates are still resolved from the inherited vanilla parent.
const generatedThemeViewsNotice = `This directory makes LimeSurvey register the theme's own Twig view path.
An inheriting survey theme must ship a views/ directory even when it overrides no
templates: LimeSurvey 7 adds this path to the Twig FilesystemLoader and raises a
Twig LoaderError when it is absent, while the actual layout templates are still
resolved from the inherited vanilla parent theme.
`;

function manifest(input: {
  themeName: string;
  title: string;
  description: string;
  author: string;
  authorEmail?: string;
  authorUrl?: string;
  themeVersion: string;
  targetMajor: "7" | "6";
}): string {
  const date = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <metadata>
    <name>${xmlEscape(input.themeName)}</name>
    <title>${xmlEscape(input.title)}</title>
    <type>theme</type>
    <creationDate>${date}</creationDate>
    <author>${xmlEscape(input.author)}</author>
    <authorEmail>${xmlEscape(input.authorEmail ?? "")}</authorEmail>
    <authorUrl>${xmlEscape(input.authorUrl ?? "")}</authorUrl>
    <copyright>Copyright (C) ${new Date().getUTCFullYear()} ${xmlEscape(input.author)}</copyright>
    <license>GNU General Public License version 2 or later</license>
    <version>${xmlEscape(input.themeVersion)}</version>
    <apiVersion>3</apiVersion>
    <description>${xmlEscape(input.description)}</description>
    <lastUpdate>${date}</lastUpdate>
    <extends>vanilla</extends>
  </metadata>
  <compatibility>
    <version>${input.targetMajor}.0</version>
  </compatibility>
  <files>
    <css>
      <add>css/mcp-theme.css</add>
    </css>
  </files>
</config>
`;
}

function themeCss(input: {
  themeName: string;
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  focus: string;
  font: "system" | "humanist" | "serif";
  radius: number;
  maxWidth: number;
  density: "comfortable" | "compact";
}): string {
  const primaryRgb = rgb(input.primary).join(", ");
  const primaryText = foreground(input.primary);
  const border = contrast(input.surface, input.muted) > 3 ? input.muted : "#CBD2D9";
  const fonts = {
    system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    humanist: '"Trebuchet MS", "Segoe UI", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
  };
  const spacing = input.density === "compact" ? "1rem" : "1.5rem";
  return `/* SPDX-License-Identifier: GPL-2.0-or-later
 * Responsive LimeSurvey theme generated by limesurvey-mcp-server.
 * Inherits the official vanilla (Bootstrap Vanilla) Bootstrap 5 survey theme.
 */
:root {
  --bs-primary: ${input.primary};
  --bs-primary-rgb: ${primaryRgb};
  --bs-body-color: ${input.text};
  --bs-body-bg: ${input.background};
  --bs-body-font-family: ${fonts[input.font]};
  --mcp-theme-accent: ${input.accent};
  --mcp-theme-surface: ${input.surface};
  --mcp-theme-muted: ${input.muted};
  --mcp-theme-border: ${border};
  --mcp-theme-radius: ${input.radius}px;
  --mcp-theme-max-width: ${input.maxWidth}px;
  --mcp-theme-primary-text: ${primaryText};
}

html { font-size: 100%; }
body {
  color: var(--bs-body-color);
  background: var(--bs-body-bg);
  font-family: var(--bs-body-font-family);
  font-size: 1rem;
  line-height: 1.6;
  letter-spacing: 0;
}

#outerframeContainer {
  width: min(100%, var(--mcp-theme-max-width));
  margin-inline: auto;
  padding-inline: 1.25rem;
}

.survey-name { font-size: 2rem; line-height: 1.2; font-weight: 700; letter-spacing: 0; }
.group-title {
  padding-inline-start: 0.75rem;
  border-inline-start: 4px solid var(--mcp-theme-accent);
  font-size: 1.5rem;
  line-height: 1.3;
  font-weight: 650;
  letter-spacing: 0;
}
.question-title-container { font-size: 1.125rem; line-height: 1.45; }

.question-container {
  margin-block: 1rem;
  padding: ${spacing};
  color: var(--bs-body-color);
  background: var(--mcp-theme-surface);
  border: 1px solid var(--mcp-theme-border);
  border-radius: var(--mcp-theme-radius);
  box-shadow: 0 2px 8px rgb(31 41 51 / 8%);
}

.text-muted, .question-help-container, .ls-questionhelp { color: var(--mcp-theme-muted) !important; }
.asterisk, .required { color: #B42318; }

.btn, .form-control, .form-select, .input-group-text {
  min-height: 44px;
  border-radius: var(--mcp-theme-radius);
}
.btn-primary {
  color: var(--mcp-theme-primary-text);
  background-color: var(--bs-primary);
  border-color: var(--bs-primary);
}
.btn-primary:hover, .btn-primary:active {
  color: var(--mcp-theme-primary-text);
  background-color: ${darken(input.primary)};
  border-color: ${darken(input.primary)};
}
.btn-outline-secondary { color: var(--bs-body-color); border-color: var(--mcp-theme-muted); }
.form-check-input:checked { background-color: var(--bs-primary); border-color: var(--bs-primary); }

a { color: ${darken(input.primary, 0.68)}; text-underline-offset: 0.18em; }
a:hover { color: ${darken(input.primary, 0.5)}; }

:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 3px solid ${input.focus};
  outline-offset: 2px;
  box-shadow: none !important;
}

.progress { height: 0.75rem; background-color: #E4E7EB; border-radius: 999px; }
.progress-bar { background-color: var(--bs-primary); }

.table-responsive { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.ls-answers th, .ls-answers td { vertical-align: middle; }
img { max-width: 100%; height: auto; }

@media (max-width: 575.98px) {
  #outerframeContainer { padding-inline: 0.75rem; }
  .survey-name { font-size: 1.75rem; }
  .group-title { font-size: 1.3rem; }
  .question-container { padding: 1rem; box-shadow: none; }
  .navigator .btn { width: 100%; margin-block: 0.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}

@media print {
  body { background: #FFFFFF; color: #000000; }
  #outerframeContainer { width: 100%; max-width: none; padding: 0; }
  .question-container { border: 1px solid #777777; box-shadow: none; break-inside: avoid; }
}
`;
}

async function validateZip(config: LimeSurveyConfig, fileName: string): Promise<JsonValue> {
  const { target } = safeThemeTarget(config, fileName);
  const maxAssetBytes = config.maxThemeAssetBytes ?? 5 * 1024 * 1024;
  const archive = await readFile(target);
  if (archive.byteLength > maxAssetBytes * 3 + 1024 * 1024) {
    throw new LimeSurveyError("The compressed theme package is larger than the configured validation limit.");
  }
  // Loading reads the central directory only. checkCRC32 would decompress every entry at once, before the size checks
  // below; readEntry checks the CRC-32 of each entry it reads instead.
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files);
  const errors: string[] = [];
  const warnings: string[] = [];
  const installedName = installedThemeName(fileName);
  if (installedName.length > maxInstalledThemeNameLength) {
    errors.push(
      `The installed theme name ${installedName} (taken from the ZIP file name) has ${installedName.length} characters; `
        + `LimeSurvey allows at most ${maxInstalledThemeNameLength} and stops the import after extracting the files. `
        + "Generate the package again with a shorter theme_name.",
    );
  } else if (!installedThemeNamePattern.test(installedName)) {
    errors.push(
      `The installed theme name ${installedName} (taken from the ZIP file name) may only contain ASCII letters, digits, `
        + "'_' and '-' and must start with a letter or digit; LimeSurvey rejects or changes other characters. Give the "
        + "ZIP such a name, validate it again, and upload it under that name.",
    );
  }
  let metadata: Record<string, JsonValue> = {};
  const report = (): JsonValue => ({
    valid: errors.length === 0,
    file_name: fileName,
    installed_theme_name: installedName,
    path: target,
    entries: entries.filter((entry) => !entry.dir).slice(0, maxThemeEntries).map((entry) => entry.name),
    metadata,
    errors,
    warnings,
    sha256: createHash("sha256").update(archive).digest("hex"),
  });

  // Archive safety from the ZIP metadata alone. Any finding ends the validation before an entry is decompressed.
  if (entries.length > maxThemeEntries) {
    errors.push(`The package has ${entries.length} entries; the validator reads at most ${maxThemeEntries}.`);
    return report();
  }
  let unsafeArchive = false;
  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const original = entry.unsafeOriginalName ?? entry.name;
    if (original.startsWith("/") || original.includes("\\") || original.split("/").includes("..")) {
      errors.push(`Unsafe archive path: ${original}`);
      unsafeArchive = true;
    }
    const { uncompressedSize } = entryMetadata(entry);
    totalUncompressedBytes += uncompressedSize;
    if (!entry.dir && uncompressedSize > maxAssetBytes) {
      errors.push(`Theme entry exceeds LIMESURVEY_MAX_THEME_ASSET_BYTES: ${entry.name}`);
      unsafeArchive = true;
    }
  }
  if (totalUncompressedBytes > maxAssetBytes * 3) {
    errors.push("The uncompressed theme package exceeds the configured limit.");
    unsafeArchive = true;
  }
  if (unsafeArchive) return report();

  if (entries.length > 50) {
    warnings.push(`policy: the package has ${entries.length} entries; generated packages stay at 50 entries or fewer. LimeSurvey has no such limit.`);
  }
  for (const entry of entries) {
    if (entry.dir || entry.name === "config.xml") continue;
    const extension = fileExtension(entry.name);
    if (skippedByLimeSurvey(entry)) {
      errors.push(
        `LimeSurvey skips ${entry.name} on import (.${extension} is not an allowed theme file type), so the import `
          + "ends as a partial import without it. Remove the file.",
      );
    } else if (extension === undefined || !policyThemeExtensions.has(extension)) {
      warnings.push(
        `policy: ${entry.name} (${extension === undefined ? "no extension" : `.${extension}`}) is outside the `
          + "generator's file set; LimeSurvey imports it. Review it before the import, because theme files are "
          + "served to every participant.",
      );
    }
  }
  const configEntry = zip.file("config.xml");
  const cssEntry = zip.file("css/mcp-theme.css");
  const licenseEntry = zip.file("LICENSE.txt");
  if (!configEntry) errors.push("config.xml must be at the archive root.");
  if (!cssEntry) {
    warnings.push(
      "policy: css/mcp-theme.css is missing; generated packages keep their styles there. LimeSurvey loads the CSS files "
        + "config.xml lists, or those of the parent theme.",
    );
  }
  if (!licenseEntry) {
    warnings.push(
      "policy: LICENSE.txt is missing; generated packages ship the GPL-2.0-or-later notice of a theme that inherits "
        + "the GPL-licensed vanilla. LimeSurvey does not need the file.",
    );
  }

  const manifestRead = configEntry ? await readEntry(configEntry, maxAssetBytes) : undefined;
  const xml = manifestRead?.content?.toString("utf8");
  if (manifestRead?.error !== undefined) errors.push(manifestRead.error);
  // LimeSurvey reads config.xml with SimpleXML, which refuses XML that is not well-formed.
  const wellFormed = xml === undefined ? true : XMLValidator.validate(xml);
  if (wellFormed !== true) {
    errors.push(
      `config.xml is not well-formed XML (line ${wellFormed.err.line}): ${wellFormed.err.msg} LimeSurvey cannot read `
        + "such a manifest; escape & and < in texts as &amp; and &lt;.",
    );
  }
  if (xml !== undefined && wellFormed === true) {
    try {
      const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml) as {
        config?: { metadata?: Record<string, unknown>; compatibility?: { version?: string | string[] }; engine?: unknown };
      };
      const raw = parsed.config?.metadata ?? {};
      const name = String(raw.name ?? "");
      const title = String(raw.title ?? "").trim();
      const parent = String(raw.extends ?? "");
      const type = String(raw.type ?? "");
      const license = String(raw.license ?? "");
      const versionsRaw = parsed.config?.compatibility?.version;
      const versions = Array.isArray(versionsRaw) ? versionsRaw.map(String) : versionsRaw ? [String(versionsRaw)] : [];
      // LimeSurvey ignores metadata/name; the generator writes the installed name there.
      if (name !== installedName) {
        warnings.push(
          `policy: metadata/name is "${name}", but LimeSurvey installs the theme as ${installedName} (from the ZIP file `
            + "name) and ignores metadata/name.",
        );
      }
      // The templates table requires a title of at most 100 characters (Template.php:70, :74); otherwise saving the
      // theme throws after the files are extracted (TemplateConfig.php:1052, :1094-1096).
      if (!title) {
        errors.push("Manifest metadata/title is missing; LimeSurvey requires it and stops the import after extracting the files.");
      } else if (title.length > 100) {
        errors.push("Manifest metadata/title is longer than 100 characters; LimeSurvey stops the import after extracting the files.");
      }
      if (!parent) {
        // Without a parent, the engine section (view and files folders, CSS framework) comes from the theme itself
        // (TemplateManifest.php:726-734); without it LimeSurvey has no view folder to render from.
        if (!parsed.config?.engine) {
          errors.push(
            "Manifest has neither metadata/extends nor an engine section; LimeSurvey cannot render such a theme. "
              + "Extend vanilla as generated packages do.",
          );
        } else {
          warnings.push(
            "policy: the theme has no parent (metadata/extends); generated packages extend vanilla. This validator "
              + "does not check that views/ holds every template a standalone theme needs.",
          );
        }
      } else if (parent !== "vanilla") {
        warnings.push(
          `policy: the theme extends ${parent} instead of vanilla; LimeSurvey imports it only where ${parent} is installed.`,
        );
      }
      // LimeSurvey does not check metadata/type for survey themes (only for question themes, QuestionTheme.php:884-885).
      if (type !== "theme") {
        warnings.push(`policy: metadata/type is "${type}"; generated packages use theme. LimeSurvey does not check it.`);
      }
      if (!license.toLowerCase().includes("general public license")) {
        warnings.push(
          "policy: metadata/license does not name the GNU General Public License; generated packages declare "
            + "GPL-2.0-or-later because they inherit the GPL-licensed vanilla. LimeSurvey does not check it.",
        );
      }
      const has7 = versions.some((version) => version === "7" || version.startsWith("7."));
      // LimeSurvey 7 uninstalls a theme whose compatibility entries all name a major version below 6
      // (TemplateConfig::validateTheme and isThemeTooOldToKeep, TemplateConfig.php:930-1016); a theme without any
      // entry is kept.
      const tooOld = versions.length > 0 && versions.every((version) => Number.parseInt(version, 10) < 6);
      if (tooOld) {
        errors.push(
          "Manifest compatibility names only LimeSurvey versions below 6; LimeSurvey 7 uninstalls such a theme. "
            + "Add a 7.x (or 6.x) entry.",
        );
      } else if (!has7 && !/-ls6\.zip$/i.test(fileName)) {
        // A theme is compatible when an entry has the major version of LimeSurvey (ExtensionConfig.php:130-150); a
        // 6.x-only theme runs on LimeSurvey 7 through a transition rule only (TemplateConfig.php:963-966).
        warnings.push(
          "policy: compatibility has no 7.x entry, so LimeSurvey 7 lists the theme as incompatible. Generate the "
            + "package with target_limesurvey_major 7 for LimeSurvey 7.",
        );
      }
      // Only entries the import extracts count: views/x.html alone would leave no views/ folder behind.
      const hasViews = entries.some(
        (item) => (item.name === "views/" || item.name.startsWith("views/")) && !skippedByLimeSurvey(item),
      );
      if (parent && !hasViews) {
        errors.push(
          "Inherit themes must include a views/ directory; LimeSurvey 7 raises a Twig LoaderError "
            + "(\"... /views/ directory does not exist\") when it is missing.",
        );
      }
      metadata = { name, title, parent, type, license, compatibility: versions };
    } catch (value) {
      errors.push(`config.xml cannot be parsed: ${value instanceof Error ? value.message : String(value)}`);
    }
  }
  // The CSS rules are the generator's policy: LimeSurvey serves every CSS file unchanged. Each file is read and checked
  // on its own; only the findings are kept. The style rules count in css/mcp-theme.css, or in any CSS file when it is
  // missing.
  const styles = { smallScreen: false, reducedMotion: false, focus: false };
  for (const entry of entries.filter((item) => !item.dir && fileExtension(item.name) === "css")) {
    const read = await readEntry(entry, maxAssetBytes);
    if (read.error !== undefined) {
      errors.push(read.error);
      continue;
    }
    const css = read.content.toString("utf8");
    if (css.length > 200_000) warnings.push(`policy: ${entry.name} exceeds 200,000 characters.`);
    if (/@import\b|javascript\s*:|expression\s*\(|url\s*\(\s*['"]?(?:https?:|\/\/|data:)/i.test(css)) {
      warnings.push(
        `policy: ${entry.name} contains an @import, an executable expression, or an embedded or external URL; `
          + "LimeSurvey serves it unchanged, so every participant's browser loads what it references. Review it.",
      );
    }
    if (!cssEntry || entry.name === "css/mcp-theme.css") {
      styles.smallScreen ||= css.includes("@media (max-width: 575.98px)");
      styles.reducedMotion ||= css.includes("prefers-reduced-motion");
      styles.focus ||= css.includes(":focus-visible");
    }
  }
  const styleScope = cssEntry ? "css/mcp-theme.css" : "the CSS files";
  if (!styles.smallScreen) {
    warnings.push(`policy: responsive small-screen rules (@media (max-width: 575.98px)) are missing in ${styleScope}.`);
  }
  if (!styles.reducedMotion) {
    warnings.push(`policy: reduced-motion handling (prefers-reduced-motion) is missing in ${styleScope}.`);
  }
  if (!styles.focus) warnings.push(`policy: visible keyboard focus styling (:focus-visible) is missing in ${styleScope}.`);
  for (const entry of entries.filter((item) => !item.dir)) {
    const signature = contentSignatures[fileExtension(entry.name) ?? ""];
    if (!signature) continue;
    const read = await readEntry(entry, maxAssetBytes);
    if (read.error !== undefined) errors.push(read.error);
    else if (!signature.matches(read.content)) errors.push(`${signature.kind} content does not match its extension: ${entry.name}`);
  }
  if (!entries.some((entry) => /^files\/logo\.(png|jpe?g)$/.test(entry.name))) {
    warnings.push("No logo is bundled. This is valid; the parent theme or a later Theme Options upload can provide one.");
  }
  return report();
}

/** How to put back the theme a survey used before; this tool refuses inherit, set_survey_properties takes it. */
function restoreInstruction(previousTheme: string): string {
  return previousTheme === "inherit"
    ? "To restore the previous state (the survey inherited its theme from its survey group), call "
      + "limesurvey_set_survey_properties with data {\"template\": \"inherit\"}, or choose Inherit as the theme in the "
      + "survey's general settings in the admin interface."
    : `To restore the previous state, assign previous_theme ${previousTheme} again with this tool.`;
}

function objectValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Part A of limesurvey_list_installed_themes: local ZIPs/folders already generated in LIMESURVEY_THEME_DIR. */
async function listGeneratedThemePackages(themeDir: string | undefined): Promise<{ packages: JsonValue; note: JsonValue }> {
  if (!themeDir) {
    return { packages: [], note: "LIMESURVEY_THEME_DIR is not configured; no locally generated theme packages to list." };
  }
  let entries;
  try {
    entries = await readdir(themeDir, { withFileTypes: true });
  } catch (value) {
    return {
      packages: [],
      note: `LIMESURVEY_THEME_DIR (${themeDir}) could not be read: ${value instanceof Error ? value.message : String(value)}`,
    };
  }
  const packages = entries
    .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")))
    .map((entry) => ({ name: entry.name, path: path.join(themeDir, entry.name) }));
  return { packages, note: null };
}

/**
 * Part B of limesurvey_list_installed_themes: RemoteControl2 cannot enumerate installed themes, but
 * get_survey_properties(["template"]) works without a superadmin account, so this reports the distinct
 * templates actually assigned to visible surveys instead. Never throws; degrades to empty results with
 * scanError on failure, and skips (rather than fails on) individual surveys it cannot read.
 */
async function scanThemesInUse(client: LimeSurveyClient, scanLimit: number): Promise<{
  themesInUse: string[];
  inheritCount: number;
  scannedSurveys: number;
  totalSurveys: number;
  scanError: string | null;
}> {
  try {
    const surveysValue = await client.call("list_surveys", [null, null]);
    const surveys = Array.isArray(surveysValue) ? surveysValue : [];
    const totalSurveys = surveys.length;
    const scanned = surveys.slice(0, scanLimit);
    const templates = new Set<string>();
    let inheritCount = 0;
    for (const survey of scanned) {
      const object = objectValue(survey);
      const sidValue = object ? object.sid ?? object.survey_id : undefined;
      const sid = typeof sidValue === "number" ? sidValue : typeof sidValue === "string" ? Number(sidValue) : NaN;
      if (!Number.isFinite(sid)) continue;
      try {
        const properties = await client.call("get_survey_properties", [sid, ["template"]]);
        const propsObject = objectValue(properties);
        const template = propsObject && typeof propsObject.template === "string" ? propsObject.template : undefined;
        if (!template) continue;
        if (template === "inherit") inheritCount += 1;
        else templates.add(template);
      } catch {
        // One survey's properties failing to read must not fail the whole scan.
      }
    }
    return { themesInUse: [...templates], inheritCount, scannedSurveys: scanned.length, totalSurveys, scanError: null };
  } catch (value) {
    return {
      themesInUse: [],
      inheritCount: 0,
      scannedSurveys: 0,
      totalSurveys: 0,
      scanError: value instanceof Error ? value.message : String(value),
    };
  }
}

export function registerThemeTools(server: McpServer, client: LimeSurveyClient, config: LimeSurveyConfig): void {
  const generateSchema = strictInput({
    theme_name: themeNameSchema,
    title: z.string().min(3).max(100).describe("Human-readable title shown in LimeSurvey."),
    description: z.string().min(3).max(500).default("Responsive survey theme generated with LimeSurvey MCP."),
    author: z.string().min(2).max(100).default("LimeSurvey MCP user"),
    author_email: z.string().email().optional(),
    author_url: z.string().url().optional(),
    theme_version: z.string().regex(/^\d+\.\d+\.\d+$/).default("1.0.0"),
    target_limesurvey_major: z.enum(["7", "6"]).default("7"),
    primary_color: colorSchema.default("#0B6B57"),
    accent_color: colorSchema.default("#C84B31"),
    background_color: colorSchema.default("#F5F7F6"),
    surface_color: colorSchema.default("#FFFFFF"),
    text_color: colorSchema.default("#1F2933"),
    muted_text_color: colorSchema.default("#52606D"),
    focus_color: colorSchema.default("#005FCC"),
    font_style: z.enum(["system", "humanist", "serif"]).default("system"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
    corner_radius_px: z.number().int().min(0).max(8).default(6),
    content_max_width_px: z.number().int().min(720).max(1440).default(960),
    logo_base64: z.string().optional().describe("Optional base64 PNG or JPEG logo without a data URL prefix."),
    logo_file_type: z.enum(["png", "jpeg"]).optional(),
    overwrite: z.boolean().default(false),
    confirm_overwrite: z.boolean().default(false),
  }).superRefine((value, context) => {
    if ((value.logo_base64 && !value.logo_file_type) || (!value.logo_base64 && value.logo_file_type)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "logo_base64 and logo_file_type must be supplied together." });
    }
  });

  server.registerTool(
    "limesurvey_generate_survey_theme",
    {
      title: "Generate a responsive LimeSurvey survey theme",
      description: "Create a validated GPL-2.0-or-later ZIP theme that inherits the official Bootstrap 5 vanilla theme for LimeSurvey 7 or 6. "
        + "LimeSurvey installs the theme under the ZIP file name without .zip and dots: the result's installed_theme_name "
        + "(for example acme_feedback-100-ls7), at most 45 characters. Upload the ZIP unrenamed and assign that name.",
      inputSchema: generateSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => run(config, "generate_survey_theme", async () => {
      if (contrast(input.text_color, input.background_color) < 4.5) {
        throw new LimeSurveyError("text_color and background_color must have a WCAG contrast ratio of at least 4.5:1.");
      }
      if (contrast(input.text_color, input.surface_color) < 4.5) {
        throw new LimeSurveyError("text_color and surface_color must have a WCAG contrast ratio of at least 4.5:1.");
      }
      if (contrast(input.muted_text_color, input.background_color) < 4.5
        || contrast(input.muted_text_color, input.surface_color) < 4.5) {
        throw new LimeSurveyError("muted_text_color must have a WCAG contrast ratio of at least 4.5:1 on both backgrounds.");
      }
      if (contrast(input.focus_color, input.background_color) < 3
        || contrast(input.focus_color, input.surface_color) < 3) {
        throw new LimeSurveyError("focus_color must have a contrast ratio of at least 3:1 on both backgrounds.");
      }
      if (input.overwrite && !input.confirm_overwrite) {
        throw new LimeSurveyError("confirm_overwrite=true is required when overwrite=true.");
      }
      const fileName = `${input.theme_name}-${input.theme_version}-ls${input.target_limesurvey_major}.zip`;
      const installedName = installedThemeName(fileName);
      if (installedName.length > maxInstalledThemeNameLength) {
        const suffixLength = installedName.length - input.theme_name.length;
        const maxThemeName = maxInstalledThemeNameLength - suffixLength;
        // theme_name has at least 3 characters; below that only a shorter theme_version helps.
        const recovery = maxThemeName >= 3
          ? `Shorten theme_name to at most ${maxThemeName} characters, or shorten theme_version.`
          : `Shorten theme_version: with it the installed name needs ${suffixLength} characters besides theme_name.`;
        throw new LimeSurveyError(
          `LimeSurvey would install this package as ${installedName} (${installedName.length} characters), but it allows `
            + `at most ${maxInstalledThemeNameLength} and stops the import after extracting the files. ${recovery} `
            + "Nothing was written.",
          "THEME_NAME_TOO_LONG",
          {
            installed_theme_name: installedName,
            length: installedName.length,
            max_length: maxInstalledThemeNameLength,
            recovery,
          },
        );
      }
      const warnings: string[] = [];
      // The installed name drops the dots, so a component with more than one digit makes the digits ambiguous:
      // 1.10.0 and 11.0.0 both install as <theme_name>-1100-ls<major>, and LimeSurvey refuses to import a name that is
      // already installed (Themes.php:381, :419-423).
      if (input.theme_version.split(".").some((component) => component.length > 1)) {
        warnings.push(
          `theme_version ${input.theme_version} installs as ${installedName}; other versions with the same digits (for `
            + "example 1.10.0 and 11.0.0) give the same installed name, and LimeSurvey refuses to import a theme whose "
            + "name is already installed. Check the theme list before the import, or prefer one digit per version "
            + "component.",
        );
      }
      const { root, target } = safeThemeTarget(config, fileName);
      const zip = new JSZip();
      zip.file("config.xml", manifest({
        // LimeSurvey takes the theme name from the ZIP file name; writing the same value keeps both consistent.
        themeName: installedName,
        title: input.title,
        description: input.description,
        author: input.author,
        ...(input.author_email ? { authorEmail: input.author_email } : {}),
        ...(input.author_url ? { authorUrl: input.author_url } : {}),
        themeVersion: input.theme_version,
        targetMajor: input.target_limesurvey_major,
      }));
      zip.file("css/mcp-theme.css", themeCss({
        themeName: input.theme_name,
        primary: input.primary_color.toUpperCase(),
        accent: input.accent_color.toUpperCase(),
        background: input.background_color.toUpperCase(),
        surface: input.surface_color.toUpperCase(),
        text: input.text_color.toUpperCase(),
        muted: input.muted_text_color.toUpperCase(),
        focus: input.focus_color.toUpperCase(),
        font: input.font_style,
        radius: input.corner_radius_px,
        maxWidth: input.content_max_width_px,
        density: input.density,
      }));
      zip.file("LICENSE.txt", generatedThemeLicenseNotice);
      // Ship a views/ directory so LimeSurvey 7 can register the theme's Twig view path (renders instead
      // of raising a Twig LoaderError). Layouts inherit from the vanilla parent; see the notice text.
      zip.file("views/README.txt", generatedThemeViewsNotice);
      if (input.logo_base64 && input.logo_file_type) {
        const logo = decodeLogo(
          input.logo_base64,
          input.logo_file_type,
          config.maxThemeAssetBytes ?? 5 * 1024 * 1024,
        );
        const extension = input.logo_file_type === "jpeg" ? "jpg" : input.logo_file_type;
        zip.file(`files/logo.${extension}`, logo);
      }
      const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
      await mkdir(root, { recursive: true });
      try {
        await writeFile(target, archive, { flag: input.overwrite ? "w" : "wx", mode: 0o600 });
        await chmod(target, 0o600);
      } catch (value) {
        const code = value && typeof value === "object" && "code" in value ? String(value.code) : undefined;
        if (code === "EEXIST") {
          throw new LimeSurveyError("The theme package already exists. Increase theme_version or confirm an overwrite.");
        }
        throw value;
      }
      return {
        status: "generated",
        theme_name: input.theme_name,
        installed_theme_name: installedName,
        title: input.title,
        file_name: fileName,
        path: target,
        bytes: archive.byteLength,
        sha256: createHash("sha256").update(archive).digest("hex"),
        license: "GPL-2.0-or-later",
        parent_theme: "vanilla",
        compatibility: [`${input.target_limesurvey_major}.0`],
        tested_reference: "LimeSurvey CE 7.5.1 (2026-10-14): imported, installed as installed_theme_name, assigned and "
          + "rendered; earlier LimeSurvey CE 7.0.5 / vanilla 3.0.1 manifest checked 2026-07-24",
        contrast: {
          text_on_background: Number(contrast(input.text_color, input.background_color).toFixed(2)),
          text_on_surface: Number(contrast(input.text_color, input.surface_color).toFixed(2)),
          button_text_on_primary: Number(contrast(foreground(input.primary_color), input.primary_color).toFixed(2)),
        },
        warnings,
        next_tools: ["limesurvey_validate_survey_theme", "limesurvey_get_theme_publication_guide"],
      };
    }),
  );

  server.registerTool(
    "limesurvey_validate_survey_theme",
    {
      title: "Validate a generated LimeSurvey survey theme",
      description: "Validate a ZIP inside LIMESURVEY_THEME_DIR against the LimeSurvey 7.5.1 import: valid=true means "
        + "LimeSurvey imports and uses the package. errors cover archive safety (more than 1000 entries, unsafe paths, "
        + "size limits, CRC-32 mismatches, content signatures of images and fonts; the archive checks stop before "
        + "anything is decompressed) and real import obstacles (installed name from the ZIP file name over 45 "
        + "characters or with other characters, files the import would silently skip, a config.xml that is not "
        + "well-formed or not at the root, a missing metadata/title or views/ directory). Warnings starting with "
        + "\"policy:\" mark what LimeSurvey accepts but the generator does not produce, for example JavaScript, Twig "
        + "templates, a parent other than vanilla, a missing css/mcp-theme.css, LICENSE.txt or GPL license, more than 50 "
        + "entries, or external URLs in CSS; review them before the import. Returns installed_theme_name.",
      inputSchema: strictInput({ file_name: z.string().min(5) }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ file_name }) => run(config, "validate_survey_theme", () => validateZip(config, file_name)),
  );

  server.registerTool(
    "limesurvey_get_theme_publication_guide",
    {
      title: "Get LimeSurvey theme publication instructions",
      description: "Return version-aware installation, preview, assignment, accessibility, rollback, and optional community-publication steps for a survey theme, "
        + "including installed_theme_name, the name LimeSurvey gives the package on import.",
      inputSchema: strictInput({
        theme_name: themeNameSchema,
        package_file_name: z.string().min(5).describe("Generated ZIP file name."),
        installed_limesurvey_version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).describe("Version shown in the LimeSurvey administration footer."),
        hosting: z.enum(["self_hosted", "limesurvey_cloud"]),
        publication_scope: z.enum(["instance", "community"]).default("instance"),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => run(config, "get_theme_publication_guide", async () => {
      const major = Number(input.installed_limesurvey_version.split(".")[0]);
      const packageMajor = /-ls([67])\.zip$/i.exec(input.package_file_name)?.[1];
      const compatibility = (major === 7 || major === 6) && (!packageMajor || packageMajor === String(major))
        ? "supported"
        : "unsupported";
      const installedName = installedThemeName(input.package_file_name);
      const steps: JsonValue[] = [
        "Run limesurvey_validate_survey_theme and continue only when valid=true after reviewing every policy: warning (JavaScript, @import, and external or data URLs in CSS are served to every participant).",
        `Confirm that the installed LimeSurvey version is ${input.installed_limesurvey_version} and that the generated package targets major version ${major}.`,
        "Sign in with a trusted account that has the global Templates import permission. Theme import can execute presentation code and must not be delegated broadly.",
        "Open Configuration > Advanced > Themes and select the Survey themes section.",
        `In this theme list, choose Upload & install (Import) and upload ${input.package_file_name}. Do not rename the ZIP before uploading: LimeSurvey takes the theme name from the uploaded file name without .zip and without dots, so this package installs as ${installedName}. Review every imported file; config.xml must be at the ZIP root.`,
        "Import only through the theme list. After a failed import LimeSurvey shows a replacement upload form that does not send the theme type, and every upload there fails with \"This theme type ('') is not allowed.\" (the empty type may also show as \"\"). Go back to the theme list instead.",
        "A failed import can leave the theme folder behind, and the next upload of the same file then stops because the theme already exists. Delete the leftover theme under Available survey themes or Broken survey themes (needs the global Templates delete permission) before trying again.",
        `Confirm that the parent theme vanilla is installed. The imported theme appears as ${installedName} and extends vanilla.`,
        "Open the Theme Editor preview and check welcome, question, completion, token, error, print-answers, and public-statistics screens at phone, tablet, and desktop widths.",
        `Create or use an inactive test survey. Run limesurvey_assign_survey_theme with theme_name ${installedName} for that survey; it reads the template back and reports THEME_NOT_APPLIED if LimeSurvey kept another theme. Then preview every language before activation.`,
        "Test keyboard-only navigation, visible focus, validation errors, 200% zoom, long labels, matrix questions, right-to-left languages where applicable, reduced motion, and print output.",
        "Publish to production only after acceptance. An installed theme cannot be overwritten by a new upload: a new version is a new package with its own installed name. The installed name drops the dots of the version, so versions with the same digits (for example 1.10.0 and 11.0.0) collide; check the theme list before importing a new version. Keep the ZIP and the previous installed theme name so rollback only requires assigning the previous theme again.",
      ];
      if (input.hosting === "limesurvey_cloud") {
        steps.splice(3, 0, "If the Themes import control is unavailable in LimeSurvey Cloud, verify that custom theme upload is included for the account or contact LimeSurvey support; do not attempt filesystem installation.");
      }
      if (input.publication_scope === "community") {
        steps.push(
          "For public distribution, keep GPL-2.0-or-later, remove all customer logos and confidential assets, document supported LimeSurvey majors, and test on a clean current LimeSurvey installation.",
          "Publish source and reproducible ZIP checksums, then use the Templates contribution/upload area linked from the official LimeSurvey Community downloads page. Include screenshots and installation/rollback instructions.",
        );
      }
      return {
        compatibility,
        installed_version: input.installed_limesurvey_version,
        installed_theme_name: installedName,
        current_reference: {
          checked_on: "2026-10-14",
          // Kept for existing consumers: the release of the last check, not necessarily the newest one.
          current_ce_release: "7.5.1",
          tested_ce_release: "7.5.1",
          tested_steps: "import through Upload & install, installed name, assignment with read-back, rendering",
          earlier_checks: [{ checked_on: "2026-07-22", current_ce_release: "7.0.5" }],
          supported_generator_majors: ["7", "6"],
          parent_theme: "vanilla",
          documentation: [
            "https://www.limesurvey.org/manual/Themes/en",
            "https://www.limesurvey.org/manual/Extension_compatibility",
            "https://community.limesurvey.org/downloads/",
          ],
        },
        steps,
        stop_conditions: [
          "Validation reports errors.",
          "A policy: warning is not reviewed, in particular JavaScript, @import, or external or data URLs in CSS.",
          "The installed major version does not match the package compatibility entry.",
          "vanilla is unavailable.",
          "The preview has inaccessible contrast, hidden focus, clipped content, or broken question layouts.",
        ],
        ...(packageMajor ? { package_major: packageMajor } : {}),
      };
    }),
  );

  server.registerTool(
    "limesurvey_assign_survey_theme",
    {
      title: "Assign an installed theme to a survey",
      description: "Assign an already imported LimeSurvey survey theme: read the current template (previous_theme), set "
        + "the new one through set_survey_properties, and read it back with get_survey_properties. theme_name is the "
        + "installed name (for a generated package its installed_theme_name, such as acme_feedback-100-ls7). LimeSurvey "
        + "answers {\"template\": true} even when it keeps another theme; a different read-back value, or a refused "
        + "save ({\"template\": false}), fails with THEME_NOT_APPLIED; a failed or empty read-back with "
        + "THEME_NOT_VERIFIED (written: true); an unreadable previous theme with THEME_PREVIOUS_UNKNOWN (written: "
        + "false). Results and THEME_NOT_APPLIED name previous_theme and changed. inherit is refused; set it with "
        + "limesurvey_set_survey_properties or in the admin interface. This does not upload or install the theme package.",
      inputSchema: strictInput({
        survey_id: z.number().int().positive(),
        theme_name: installedThemeNameSchema.refine((name) => name !== "inherit", {
          message: "inherit is not accepted: the read-back would only confirm the stored value inherit, not the theme "
            + "the survey group passes on. Choose Inherit as the theme in the survey's general settings in the "
            + "LimeSurvey admin interface, use limesurvey_set_survey_properties with data {\"template\": \"inherit\"}, "
            + "or assign an installed theme name.",
        }),
        confirm_theme_assignment: z.literal(true).describe("Required acknowledgement that the survey appearance will change."),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ survey_id, theme_name }) => run(config, "assign_survey_theme", async () => {
      // Read the current template first; without it a failed assignment could not be undone.
      let previous: JsonValue | undefined;
      let previousError: ReturnType<typeof describeError> | undefined;
      try {
        previous = objectValue(await client.call("get_survey_properties", [survey_id, ["template"]]))?.template;
      } catch (value) {
        previousError = describeError(value);
      }
      if (typeof previous !== "string") {
        throw new LimeSurveyError(
          `The current theme of survey ${survey_id} could not be read${previousError ? `: ${previousError.message}` : "."} `
            + "Nothing was written.",
          "THEME_PREVIOUS_UNKNOWN",
          {
            survey_id,
            requested_theme: theme_name,
            written: false,
            ...(previousError?.code !== undefined ? { cause_code: previousError.code } : {}),
            recovery: "Check the survey in the admin interface (it must exist and be readable for this account) and retry.",
          },
        );
      }
      const previousTheme = previous;
      const rpcResult = await client.call("set_survey_properties", [survey_id, { template: theme_name }]);
      // set_survey_properties reports the save() result per field: false when the survey fails validation. LimeSurvey
      // replaces a theme that is not installed, not readable for the account, or not valid with the previous or the
      // default theme (Survey.php:573, :626-643; Template::templateNameFilter, Template.php:166-220) and still answers
      // true; reading applies the same filter, so the read-back shows the theme the survey really uses
      // (Survey.php:613-615).
      const refused = objectValue(rpcResult)?.template === false;
      let stored: JsonValue | undefined;
      let readError: ReturnType<typeof describeError> | undefined;
      try {
        stored = objectValue(await client.call("get_survey_properties", [survey_id, ["template"]]))?.template;
      } catch (value) {
        readError = describeError(value);
      }
      if (typeof stored !== "string") {
        throw new LimeSurveyError(
          `Theme ${theme_name} was sent to survey ${survey_id}, but the template could not be read back`
            + `${readError ? `: ${readError.message}` : " (the answer has no template)."}`,
          "THEME_NOT_VERIFIED",
          {
            survey_id,
            requested_theme: theme_name,
            previous_theme: previousTheme,
            written: !refused,
            rpc_result: rpcResult,
            ...(readError?.code !== undefined ? { cause_code: readError.code } : {}),
            recovery: "Do not repeat the assignment blindly: check the template in the admin interface or call "
              + "limesurvey_get_survey_properties with the property template.",
          },
        );
      }
      const changed = stored !== previousTheme;
      if (stored !== theme_name) {
        const cause = refused
          ? "LimeSurvey refused to save the survey (validation): set_survey_properties answered {\"template\": false}."
          : "Possible causes: no theme with this installed name (a generated package is installed under its "
            + "installed_theme_name, for example acme_feedback-100-ls7), the RemoteControl account lacks the Templates "
            + "permission for it, or the theme is incompatible or broken; LimeSurvey then silently keeps the previous "
            + "or the default theme.";
        throw new LimeSurveyError(
          `LimeSurvey did not apply theme ${theme_name} to survey ${survey_id}: the survey uses ${stored}`
            + `${changed ? ` instead of ${previousTheme}` : ""}. ${cause}`,
          "THEME_NOT_APPLIED",
          {
            survey_id,
            requested_theme: theme_name,
            stored_theme: stored,
            previous_theme: previousTheme,
            changed,
            rpc_result: rpcResult,
            recovery: `${changed ? `${restoreInstruction(previousTheme)} ` : ""}Take the installed name from the theme `
              + "list (Configuration > Advanced > Themes) or from installed_theme_name of "
              + "limesurvey_generate_survey_theme or limesurvey_validate_survey_theme, and assign that name.",
          },
        );
      }
      return {
        survey_id,
        theme_name,
        previous_theme: previousTheme,
        changed,
        rpc_result: rpcResult,
        verified: true,
        verification: "The template read back with get_survey_properties matches theme_name. Preview the survey in "
          + "every language before activation.",
        rollback: restoreInstruction(previousTheme),
      };
    }),
  );

  server.registerTool(
    "limesurvey_list_installed_themes",
    {
      title: "List installed LimeSurvey themes (best effort)",
      description: "LimeSurvey RemoteControl2 has no official method to enumerate installed survey themes "
        + "(verified 2026-07-24 against api.limesurvey.org and the LimeSurvey source). This tool combines two "
        + "best-effort signals instead: generated_packages lists ZIPs/folders already generated locally in "
        + "LIMESURVEY_THEME_DIR, and themes_in_use lists the distinct template names actually assigned to surveys "
        + "visible to this account (via list_surveys + get_survey_properties), which works without a superadmin "
        + "account. Always includes the documented admin-UI fallback for the complete installed-theme list.",
      inputSchema: strictInput({
        survey_scan_limit: z.number().int().min(1).max(100).default(25)
          .describe("Maximum number of visible surveys to inspect for their assigned theme."),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ survey_scan_limit }) => run(config, "list_installed_themes", async () => {
      const local = await listGeneratedThemePackages(config.themeDir);
      const remote = await scanThemesInUse(client, survey_scan_limit);
      return {
        generated_packages: local.packages,
        generated_packages_note: local.note,
        themes_in_use: remote.themesInUse,
        inherit_count: remote.inheritCount,
        scanned_surveys: remote.scannedSurveys,
        total_surveys: remote.totalSurveys,
        ...(remote.scanError ? { themes_in_use_error: remote.scanError } : {}),
        limitations: "The LimeSurvey RemoteControl API cannot enumerate installed themes; themes_in_use only "
          + "covers templates referenced by surveys visible to this account.",
        admin_fallback: "Admin UI: Configuration > Themes; or read the name from the survey admin URL segment "
          + "templatename/<name>.",
      };
    }),
  );
}

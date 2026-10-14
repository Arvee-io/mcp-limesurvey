/**
 * HTML entity decoding for spec texts: an exact port of Python's html.unescape (CPython 3.14, html/__init__.py),
 * plus a variant that never produces markup characters.
 */
import { DROPPED_CODE_POINTS, HTML5_NAMED_REFERENCES, INVALID_NUMERIC_REFERENCES } from "./html-entities.js";

/** Python: _charref. Group 1 is the reference without the leading "&". */
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

const MARKUP_CHARACTERS = /[&<>"']/;

function namedReference(name: string): string | undefined {
  return Object.hasOwn(HTML5_NAMED_REFERENCES, name) ? HTML5_NAMED_REFERENCES[name] : undefined;
}

/** Python: _replace_charref, numeric branch. */
function decodeNumeric(reference: string): string {
  const hex = reference[1] === "x" || reference[1] === "X";
  const digits = reference.slice(hex ? 2 : 1).replace(/;+$/, "");
  const codePoint = hex ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
  const mapped = INVALID_NUMERIC_REFERENCES[codePoint];
  if (mapped !== undefined) return mapped;
  if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) return "�";
  if (DROPPED_CODE_POINTS.has(codePoint)) return "";
  return String.fromCodePoint(codePoint);
}

/** Python: _replace_charref, named branch: exact match, else the longest known prefix, else unchanged. */
function decodeNamed(name: string): string {
  const exact = namedReference(name);
  if (exact !== undefined) return exact;
  const points = Array.from(name);
  for (let length = points.length - 1; length > 1; length -= 1) {
    const found = namedReference(points.slice(0, length).join(""));
    if (found !== undefined) return found + points.slice(length).join("");
  }
  return `&${name}`;
}

/** Decodes character references exactly like Python's html.unescape. */
export function unescapeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (_match, reference: string) => (
    reference.startsWith("#") ? decodeNumeric(reference) : decodeNamed(reference)
  ));
}

/**
 * Like unescapeHtml, but only a reference that ends with ";" and is a numeric reference or an exact HTML5 name is
 * decoded, and only when the result has none of & < > " '. Everything else stays as written, so decoded markup never
 * appears, URLs like ?a=1&copy=2 stay intact and a second pass changes nothing.
 */
export function unescapeHtmlSafe(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (match, reference: string) => {
    if (!reference.endsWith(";")) return match;
    let decoded: string | undefined;
    if (reference.startsWith("#")) decoded = decodeNumeric(reference);
    else decoded = namedReference(reference);
    if (decoded === undefined || MARKUP_CHARACTERS.test(decoded)) return match;
    return decoded;
  });
}

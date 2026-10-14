/**
 * HTML entity decoding for spec texts. Placeholder until the port of Python's html.unescape lands.
 */

/** Decodes character references exactly like Python's html.unescape. */
export function unescapeHtml(_text: string): string {
  throw new Error("not implemented");
}

/** Like unescapeHtml, but a reference that decodes to & < > " or ' stays as it is. */
export function unescapeHtmlSafe(_text: string): string {
  throw new Error("not implemented");
}

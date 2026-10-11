import type { JsonValue } from "./types.js";

/**
 * Parsing of the survey language setting `attachments` (get_language_properties).
 *
 * LimeSurvey 6.17.11 stores the column as a JSON string since DB version 647 (Update_647.php migrated older PHP
 * serialize() values); instances below that version still hold PHP-serialize strings. Both are parsed here. The
 * structure is { "<mail type>": [ { url, size, relevance } ] } with the mail types of LimeMailer: invitation,
 * reminder, registration, confirmation, admin_notification, admin_detailed_notification.
 */

type JsonObject = { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Minimal PHP unserialize for a/s/i/d/b/N. String lengths are UTF-8 byte counts. Anything else is rejected. */
class PhpReader {
  private position = 0;

  constructor(private readonly buffer: Buffer) {}

  parse(): JsonValue {
    const value = this.value();
    while (this.position < this.buffer.length && /\s/.test(String.fromCharCode(this.buffer[this.position] ?? 0))) {
      this.position += 1;
    }
    if (this.position !== this.buffer.length) throw new Error("trailing data after the serialized value");
    return value;
  }

  private char(): string {
    const byte = this.buffer[this.position];
    if (byte === undefined) throw new Error("unexpected end of the serialized value");
    return String.fromCharCode(byte);
  }

  private expect(expected: string): void {
    if (this.char() !== expected) throw new Error(`expected "${expected}" at byte ${this.position}`);
    this.position += 1;
  }

  /** Reads up to (and consumes) the terminator character. */
  private until(terminator: string): string {
    const start = this.position;
    while (this.char() !== terminator) this.position += 1;
    const text = this.buffer.toString("utf8", start, this.position);
    this.position += 1;
    return text;
  }

  private value(): JsonValue {
    const type = this.char();
    this.position += 1;
    if (type === "N") {
      this.expect(";");
      return null;
    }
    this.expect(":");
    switch (type) {
      case "b": {
        const flag = this.until(";");
        if (flag !== "0" && flag !== "1") throw new Error("invalid boolean");
        return flag === "1";
      }
      case "i": {
        const text = this.until(";");
        if (!/^[+-]?\d+$/.test(text)) throw new Error("invalid integer");
        return Number(text);
      }
      case "d": {
        const number = Number(this.until(";"));
        if (!Number.isFinite(number)) throw new Error("invalid float");
        return number;
      }
      case "s": {
        const length = Number(this.until(":"));
        if (!Number.isInteger(length) || length < 0) throw new Error("invalid string length");
        this.expect("\"");
        const end = this.position + length;
        if (end > this.buffer.length) throw new Error("string longer than the remaining data");
        const text = this.buffer.toString("utf8", this.position, end);
        this.position = end;
        this.expect("\"");
        this.expect(";");
        return text;
      }
      case "a": {
        const count = Number(this.until(":"));
        if (!Number.isInteger(count) || count < 0) throw new Error("invalid array length");
        this.expect("{");
        const entries: Array<[string, JsonValue]> = [];
        for (let index = 0; index < count; index += 1) {
          const key = this.value();
          if (typeof key !== "string" && typeof key !== "number") throw new Error("invalid array key");
          entries.push([String(key), this.value()]);
        }
        this.expect("}");
        const isList = entries.every(([key], index) => key === String(index));
        return isList ? entries.map(([, item]) => item) : Object.fromEntries(entries);
      }
      default:
        throw new Error(`unsupported serialized type "${type}"`);
    }
  }
}

function decode(raw: string): JsonValue {
  const text = raw.trim();
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    // Not JSON: fall through to the legacy PHP format.
  }
  if (!/^(?:a|N|b|i|d|s):?/.test(text)) throw new Error("neither JSON nor a PHP serialize string");
  return new PhpReader(Buffer.from(text, "utf8")).parse();
}

function baseName(url: string): string {
  const parts = url.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : url;
}

function numeric(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function entryList(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.values(value);
  throw new Error("an attachment list is neither an array nor an object");
}

export interface ParsedAttachments {
  /** { mail type: [ { file_name, url, size, relevance } ] }, or null when the value could not be parsed. */
  parsed: JsonValue | null;
  error?: string;
}

/** Parses the raw `attachments` column value. Empty or missing values give {}. Never throws. */
export function parseAttachments(raw: JsonValue | undefined): ParsedAttachments {
  try {
    let structure: JsonValue;
    if (raw === null || raw === undefined) return { parsed: {} };
    if (typeof raw === "string") {
      if (raw.trim() === "") return { parsed: {} };
      structure = decode(raw);
    } else {
      structure = raw;
    }
    if (structure === null) return { parsed: {} };
    if (Array.isArray(structure)) {
      if (structure.length === 0) return { parsed: {} };
      throw new Error("the top level is a list, not a map of mail types");
    }
    if (!isObject(structure)) throw new Error("the top level is not a map of mail types");

    const parsed: JsonObject = {};
    for (const [mailType, list] of Object.entries(structure)) {
      parsed[mailType] = entryList(list).map((entry): JsonValue => {
        if (!isObject(entry) || typeof entry.url !== "string") throw new Error(`an entry of ${mailType} has no url`);
        return {
          file_name: baseName(entry.url),
          url: entry.url,
          size: numeric(entry.size),
          relevance: typeof entry.relevance === "string" ? entry.relevance : null,
        };
      });
    }
    return { parsed };
  } catch (error) {
    return { parsed: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** enrich hook of get_language_properties: adds attachments_parsed next to the untouched raw attachments field. */
export function enrichLanguageProperties(result: JsonValue): JsonValue {
  if (!isObject(result) || !Object.hasOwn(result, "attachments")) return result;
  return { ...result, attachments_parsed: parseAttachments(result.attachments).parsed };
}

/** afterCall hook of get_language_properties: unparsable attachments and requested names LimeSurvey dropped. */
export function languagePropertiesWarnings(result: JsonValue, input: Record<string, unknown>): JsonValue[] {
  if (!isObject(result)) return [];
  const warnings: JsonValue[] = [];

  if (Object.hasOwn(result, "attachments")) {
    const { error } = parseAttachments(result.attachments);
    if (error !== undefined) {
      warnings.push({
        hint_code: "ATTACHMENTS_UNPARSEABLE",
        hint: `The attachments value is neither JSON nor a PHP serialize string that this server understands (${error}), `
          + "so attachments_parsed is null. The raw attachments field is unchanged.",
      });
    }
  }

  const requested = Array.isArray(input.properties)
    ? input.properties.filter((name): name is string => typeof name === "string")
    : [];
  const unknown = requested.filter((name) => !Object.hasOwn(result, name));
  if (unknown.length > 0) {
    warnings.push({
      hint_code: "UNKNOWN_FIELDS",
      unknown_fields: unknown,
      hint: "LimeSurvey drops requested names that are not a column of the survey language settings without saying so. "
        + "These names are missing from the answer; omit properties to read all columns.",
    });
  }
  return warnings;
}

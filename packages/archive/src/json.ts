// Strict JSON for archive files: UTF-8 without BOM, no duplicate keys, no null (the format never
// uses null), integers within +-(2^53-1), bounded nesting. A key such as "__proto__" becomes an
// ordinary own property.

import { printable } from "./paths.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Not well-formed JSON (ARCHIVE_INVALID_JSON). */
export class JsonSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (offset ${offset})`);
    this.name = "JsonSyntaxError";
    this.offset = offset;
  }
}
/** Well-formed JSON that the format forbids: null or a number outside the allowed integers (SCHEMA_VIOLATION). */
export class JsonValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonValueError";
  }
}

export const MAX_DEPTH = 128;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes UTF-8 strictly. Returns undefined for invalid UTF-8. A BOM is kept in the string. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function parseJson(text: string): Json {
  return new Parser(text).document();
}

class Parser {
  private pos = 0;
  private readonly s: string;
  /** Path to the value being parsed (keys and array indexes); the JSON pointer text is built only when a message needs it. */
  private readonly segments: (string | number)[] = [];
  constructor(s: string) {
    this.s = s;
  }

  private pointer(): string {
    const text = this.segments.map((x) => `/${typeof x === "number" ? x : printable(x).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
    return printable(text);
  }
  private fail(message: string): never {
    throw new JsonSyntaxError(message, this.pos);
  }
  private skip(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.pos++;
      else break;
    }
  }
  document(): Json {
    this.skip();
    const v = this.value(0);
    this.skip();
    if (this.pos !== this.s.length) this.fail("unexpected content after the JSON value");
    return v;
  }
  private value(depth: number): Json {
    if (this.pos >= this.s.length) this.fail("unexpected end of input");
    const c = this.s[this.pos]!;
    switch (c) {
      case "{": return this.object(depth + 1);
      case "[": return this.array(depth + 1);
      case '"': return this.string();
      case "t": this.literal("true"); return true;
      case "f": this.literal("false"); return false;
      case "n": this.literal("null"); throw new JsonValueError(`null at ${this.pointer() || "the top level"}; the format never uses null`);
      default:
        if (c === "-" || (c >= "0" && c <= "9")) return this.number();
        return this.fail("unexpected character");
    }
  }
  private literal(word: string): void {
    if (!this.s.startsWith(word, this.pos)) this.fail("invalid literal");
    this.pos += word.length;
  }
  private object(depth: number): JsonObject {
    if (depth > MAX_DEPTH) this.fail(`nesting is deeper than ${MAX_DEPTH}`);
    this.pos++;
    const out: JsonObject = {};
    this.skip();
    if (this.s[this.pos] === "}") { this.pos++; return out; }
    for (;;) {
      this.skip();
      if (this.s[this.pos] !== '"') this.fail("expected a property name");
      const key = this.string();
      this.skip();
      if (this.s[this.pos] !== ":") this.fail("expected ':'");
      this.pos++;
      this.skip();
      this.segments.push(key);
      const v = this.value(depth);
      this.segments.pop();
      if (Object.hasOwn(out, key)) this.fail(`duplicate property "${printable(key)}"`);
      // defineProperty makes "__proto__" an ordinary own property instead of setting the prototype.
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      this.skip();
      const c = this.s[this.pos];
      if (c === ",") { this.pos++; continue; }
      if (c === "}") { this.pos++; return out; }
      this.fail(c === undefined ? "unexpected end of input" : "expected ',' or '}'");
    }
  }
  private array(depth: number): Json[] {
    if (depth > MAX_DEPTH) this.fail(`nesting is deeper than ${MAX_DEPTH}`);
    this.pos++;
    const out: Json[] = [];
    this.skip();
    if (this.s[this.pos] === "]") { this.pos++; return out; }
    for (;;) {
      this.skip();
      this.segments.push(out.length);
      out.push(this.value(depth));
      this.segments.pop();
      this.skip();
      const c = this.s[this.pos];
      if (c === ",") { this.pos++; continue; }
      if (c === "]") { this.pos++; return out; }
      this.fail(c === undefined ? "unexpected end of input" : "expected ',' or ']'");
    }
  }
  private string(): string {
    const s = this.s;
    this.pos++;
    let out = "";
    let run = this.pos;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 0x22) {
        out += s.slice(run, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) this.fail("unescaped control character in a string");
      if (c !== 0x5c) { this.pos++; continue; }
      out += s.slice(run, this.pos);
      this.pos++;
      const e = s[this.pos];
      switch (e) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          this.pos++;
          const unit = this.hex4();
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (s[this.pos] !== "\\" || s[this.pos + 1] !== "u") this.fail("unpaired surrogate escape");
            this.pos += 2;
            const low = this.hex4();
            if (low < 0xdc00 || low > 0xdfff) this.fail("unpaired surrogate escape");
            out += String.fromCharCode(unit, low);
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            this.fail("unpaired surrogate escape");
          } else out += String.fromCharCode(unit);
          run = this.pos;
          continue;
        }
        default: this.fail("invalid escape");
      }
      this.pos++;
      run = this.pos;
    }
    return this.fail("unterminated string");
  }
  private hex4(): number {
    const h = this.s.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail("invalid \\u escape");
    this.pos += 4;
    return parseInt(h, 16);
  }
  private number(): number {
    const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.s.slice(this.pos, this.pos + 400));
    if (!m) this.fail("invalid number");
    const token = m[0];
    this.pos += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) this.fail("number out of range");
    if (m[1] === undefined && m[2] === undefined) {
      if (Object.is(value, -0) || !Number.isSafeInteger(value)) {
        throw new JsonValueError(`integer ${printable(token)} at ${this.pointer()} is outside +-(2^53-1)`);
      }
    } else if (Number.isInteger(value)) {
      throw new JsonValueError(`number ${printable(token)} at ${this.pointer()} is a whole number written as a fraction or exponent; write an integer`);
    }
    return value;
  }
}

/** Code point order, which equals UTF-8 byte order (UTF-16 code unit order differs only around surrogate pairs). */
const cmpCodePoints = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    return xs !== ys ? (xs ? 1 : -1) : x - y; // a supplementary character sorts after every BMP character
  }
  return a.length - b.length;
};

/** Compact JSON with object keys sorted by UTF-8 bytes. Deterministic: the same value gives the same bytes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined) throw new TypeError("undefined is not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmpCodePoints);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

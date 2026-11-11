// Shape checking against archive-v1.schema.json (a copy of Spec/schemas; test/schema-copy.test.ts
// fails if it drifts from the vendored one). Supports the JSON Schema subset the schema uses: type,
// const, enum, pattern, minLength, maxLength, minimum, maximum, minItems, minProperties, required,
// properties, additionalProperties, items, oneOf and local $ref ("#/$defs/...").

import { readFileSync } from "node:fs";
import { IssueList } from "./errors.ts";
import type { Json } from "./json.ts";
import { printable } from "./paths.ts";

type Schema = { [k: string]: any };
const schema: Schema = JSON.parse(readFileSync(new URL("./archive-v1.schema.json", import.meta.url), "utf8"));
const defs: Record<string, Schema> = schema.$defs;

/** Which $def describes each archive JSON file. */
export const DEFINITION_FOR_PATH: Readonly<Record<string, string>> = Object.freeze({
  "manifest.json": "manifest",
  "checksums.json": "checksums",
  "library.json": "library",
  "references.json": "references",
  "notes.json": "notes",
  "attachments.json": "attachments",
  "bible/entries.json": "entries",
  "bible/templates.json": "templates",
  "bible/fields.json": "fields",
  "bible/relationships.json": "relationships",
  "bible/facts.json": "facts",
  "bible/questions.json": "questions",
  "continuity/events.json": "events",
  "continuity/state_changes.json": "stateChanges",
});

const regexCache = new Map<string, RegExp>();
const regex = (p: string): RegExp => {
  let r = regexCache.get(p);
  if (!r) regexCache.set(p, (r = new RegExp(p, "u")));
  return r;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i++;
    n++;
  }
  return n;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Where problems go: a bounded list plus the file path that prefixes each message. */
interface Sink { list: IssueList; prefix: string }
const add = (out: Sink, message: string): void => out.list.add({ code: "SCHEMA_VIOLATION", message: `${out.prefix}${message}` });
/** Stops the walk once the list is full; the list then says it is incomplete. */
const stop = (out: Sink): boolean => {
  if (!out.list.full) return false;
  out.list.truncated = true;
  return true;
};

function check(s: Schema, value: unknown, pointer: string, out: Sink): void {
  if (stop(out)) return;
  if (s.$ref !== undefined) {
    const target = defs[String(s.$ref).replace(/^#\/\$defs\//, "")];
    if (!target) throw new Error(`unresolved $ref ${s.$ref}`);
    return check(target, value, pointer, out);
  }
  const t = typeOf(value);
  if (s.type !== undefined) {
    const allowed: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!allowed.some((a) => a === t || (a === "number" && t === "integer"))) {
      add(out, `${pointer}: expected ${allowed.join("|")}, got ${t}`);
      return;
    }
  }
  if ("const" in s && !same(s.const, value)) add(out, `${pointer}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e: unknown) => same(e, value))) add(out, `${pointer}: not one of the allowed values`);
  if (t === "string") {
    const str = value as string;
    if (s.minLength !== undefined || s.maxLength !== undefined) {
      const len = codePoints(str);
      if (s.minLength !== undefined && len < s.minLength) add(out, `${pointer}: shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && len > s.maxLength) add(out, `${pointer}: longer than ${s.maxLength}`);
    }
    if (s.pattern && !regex(s.pattern).test(str)) add(out, `${pointer}: does not match ${s.pattern}`);
  }
  if (t === "integer" || t === "number") {
    const n = value as number;
    if (s.minimum !== undefined && n < s.minimum) add(out, `${pointer}: below ${s.minimum}`);
    if (s.maximum !== undefined && n > s.maximum) add(out, `${pointer}: above ${s.maximum}`);
  }
  if (t === "array") {
    const a = value as unknown[];
    if (s.minItems !== undefined && a.length < s.minItems) add(out, `${pointer}: fewer than ${s.minItems} items`);
    if (s.items) for (let i = 0; i < a.length && !stop(out); i++) check(s.items, a[i], `${pointer}/${i}`, out);
  }
  if (t === "object") {
    const o = value as Record<string, unknown>;
    for (const key of s.required ?? []) if (!Object.hasOwn(o, key)) add(out, `${pointer}: missing ${key}`);
    if (s.minProperties !== undefined && Object.keys(o).length < s.minProperties) add(out, `${pointer}: fewer than ${s.minProperties} properties`);
    const props: Schema = s.properties ?? {};
    for (const [key, v] of Object.entries(o)) {
      if (Object.hasOwn(props, key)) check(props[key], v, `${pointer}/${key}`, out);
      else if (s.additionalProperties === false) add(out, `${pointer}: unexpected property ${printable(key)}`);
      else if (typeof s.additionalProperties === "object") check(s.additionalProperties, v, `${pointer}/${printable(key)}`, out);
      if (stop(out)) return;
    }
  }
  if (s.oneOf) {
    const passing = (s.oneOf as Schema[]).filter((branch) => {
      const branchSink: Sink = { list: new IssueList(), prefix: "" };
      check(branch, value, pointer, branchSink);
      return branchSink.list.items.length === 0;
    }).length;
    if (passing !== 1) add(out, `${pointer}: matched ${passing} of the allowed shapes, expected exactly 1`);
  }
}

/**
 * Shape problems of one archive JSON file, as SCHEMA_VIOLATION issues, added to `into` (which holds at
 * most MAX_ISSUES; check `into.truncated`). Nothing is added when the shape is right.
 */
export function checkShape(path: string, value: Json, into: IssueList = new IssueList()): IssueList {
  const name = DEFINITION_FOR_PATH[path];
  if (!name) throw new Error(`no schema definition for ${path}`);
  const def = defs[name];
  if (!def) throw new Error(`schema has no definition ${name}`);
  check(def, value, "", { list: into, prefix: path });
  checkNoNul(path, value, into);
  return into;
}

/**
 * U+0000 is refused in every string value and property name of every archive JSON file (owner decision,
 * 2026-11-10): PostgreSQL text cannot hold it, and no editor writes it. It is reported as a shape problem
 * (SCHEMA_VIOLATION). The message names the file, the record id and the field, never the text. Manuscript
 * documents are not walked here: their canonical rules already refuse it (DOCUMENT_INVALID).
 */
function checkNoNul(file: string, root: Json, into: IssueList): void {
  const stack: { value: Json; pointer: string; recordId?: string }[] = [{ value: root, pointer: "" }];
  while (stack.length > 0 && !into.full) {
    const { value, pointer, recordId } = stack.pop()!;
    const report = (what: string) => into.add({
      code: "SCHEMA_VIOLATION",
      message: `${file}${pointer}: ${what} contains a NUL character${recordId ? ` (record ${recordId})` : ""}`,
      ...(recordId ? { recordId } : {}),
    });
    if (typeof value === "string") {
      if (value.includes("\u0000")) report("the value");
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i]!, pointer: `${pointer}/${i}`, recordId });
    } else if (value !== null && typeof value === "object") {
      const own = typeof value.id === "string" && UUID_OR_HASH.test(value.id) ? value.id : typeof value.sha256 === "string" && UUID_OR_HASH.test(value.sha256) ? value.sha256 : recordId;
      for (const [k, v] of Object.entries(value)) {
        if (k.includes("\u0000")) { into.add({ code: "SCHEMA_VIOLATION", message: `${file}${pointer}: a property name contains a NUL character${own ? ` (record ${own})` : ""}`, ...(own ? { recordId: own } : {}) }); continue; }
        stack.push({ value: v, pointer: `${pointer}/${printable(k)}`, recordId: own });
      }
    }
  }
}
const UUID_OR_HASH = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/;

/** The record kinds of the archive (the sync protocol names them the same way). */
export const RECORD_KINDS = [
  "library", "universe", "series", "book", "manuscriptNode", "reference", "note", "template", "field",
  "entry", "fact", "question", "relationshipType", "relationship", "event", "stateChange",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** The schema of one record of a kind: the def itself, or the items of the file's array. */
function recordDef(kind: RecordKind): Schema {
  switch (kind) {
    case "library": return defs.library!.properties.library;
    case "universe": case "series": case "book": case "manuscriptNode": return defs[kind]!;
    case "reference": return defs.references!.items;
    case "note": return defs.notes!.items;
    case "template": return defs.templates!.items;
    case "field": return defs.fields!.items;
    case "entry": return defs.entries!.items;
    case "fact": return defs.facts!.items;
    case "question": return defs.questions!.items;
    case "event": return defs.events!.items;
    case "stateChange": return defs.stateChanges!.items;
    case "relationshipType": return defs.relationships!.properties.relationshipTypes.items;
    case "relationship": return defs.relationships!.properties.relationships.items;
  }
}

/**
 * Shape problems of one record against its archive def (the same schema and NUL rule as the whole file), as
 * SCHEMA_VIOLATION issues added to `into`. Nothing is added when the shape is right.
 */
export function checkRecordShape(kind: RecordKind, value: Json, into: IssueList = new IssueList()): IssueList {
  check(recordDef(kind), value, "", { list: into, prefix: kind });
  checkNoNul(kind, value, into);
  return into;
}

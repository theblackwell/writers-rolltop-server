// Story bible records in the browser's model: reading entries, the built-in templates, and the value rules of
// archive-format-v1.md ("bible/fields.json" and "bible/entries.json"). Nothing here touches the network. The server
// validates every value again; these checks only keep a value of the wrong type from being sent.
import { BUILTIN_FIELDS, BUILTIN_TEMPLATES } from "./bible-builtins.ts";
import type { Model, Rec } from "./model.ts";

export type EntryType = "character" | "location" | "term";
export const ENTRY_NOUN: Record<string, string> = {
  character: "character", location: "place", term: "term", organization: "organization", object: "object",
  event: "event", plotline: "plotline", worldRule: "world rule", research: "research note",
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const entryNoun = (type: string): string => ENTRY_NOUN[type] ?? type;
export const entryNounCap = (type: string): string => cap(entryNoun(type));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const stamp = (): string => new Date().toISOString().replace(/\.\d+Z$/, "Z");

const records = (m: Model, kind: string): Rec[] => [...(m.records.get(kind)?.values() ?? [])];
const byOrder = (a: Rec, b: Rec): number => {
  const x = String(a.orderKey ?? ""), y = String(b.orderKey ?? "");
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// ---------- built-in templates ----------

/** The built-in template of an entry type: ours by id if the library has it, otherwise any built-in one of that type. One in the trash is not used. */
export function builtInTemplate(m: Model, type: string): Rec | undefined {
  const mine = BUILTIN_TEMPLATES.find((t) => t.entryType === type);
  const found = records(m, "template").filter((t) => t.builtIn === true && t.entryType === type && !t.deletedAt);
  return found.find((t) => t.id === mine?.id) ?? found.sort(byOrder)[0];
}

/**
 * The create ops that give a library its built-in templates and their fields, only for what is missing. A type that
 * already has a built-in template (ours or another) gets no second one. Calling it again after the ops were applied
 * gives no ops. Templates come before their fields.
 */
export function seedOps(m: Model, newOpId: () => string): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  const op = (recordKind: string, value: Record<string, unknown>) =>
    ops.push({ opId: newOpId(), op: "create", recordKind, recordId: value.id, value });
  const known = (kind: string, id: unknown): boolean => typeof id === "string" && (m.records.get(kind)?.has(id) ?? false);
  const madeNow = new Set<string>();
  for (const t of BUILTIN_TEMPLATES) {
    const have = builtInTemplate(m, String(t.entryType));
    // A template of ours that is in the trash is not made again (its id is taken) and gets no fields: entries cannot use it.
    if (!have && !known("template", t.id)) { op("template", { ...t }); madeNow.add(String(t.id)); }
  }
  for (const f of BUILTIN_FIELDS) {
    const type = String(BUILTIN_TEMPLATES.find((t) => t.id === f.templateId)?.entryType);
    const have = builtInTemplate(m, type);
    // Fields go only into our own template (made in this batch or already there): another built-in template of the same type has its own fields.
    if ((have ? have.id === f.templateId : madeNow.has(String(f.templateId))) && !known("field", f.id)) op("field", { ...f });
  }
  return ops;
}

export const bibleReady = (m: Model): boolean => seedOps(m, () => "x").length === 0;

// ---------- reading entries ----------

export interface FieldDef {
  id: string; key: string; label: string; fieldType: string; multiple: boolean; required: boolean;
  options: Array<{ id: string; label: string }>; targetEntryTypes: string[];
}

export function fieldsOf(m: Model, templateId: unknown): FieldDef[] {
  return records(m, "field").filter((f) => f.templateId === templateId && !f.deletedAt).sort(byOrder).map((f) => ({
    id: f.id, key: String(f.key), label: String(f.label), fieldType: String(f.fieldType), multiple: f.multiple === true, required: f.required === true,
    options: Array.isArray(f.options) ? (f.options as Array<{ id: string; label: string }>) : [],
    targetEntryTypes: Array.isArray(f.targetEntryTypes) ? (f.targetEntryTypes as string[]) : [],
  }));
}

/** An entry is visible from a book when its scope is that book, or the book's series or universe. */
export function visibleFrom(m: Model, entry: Rec, bookId: string | undefined): boolean {
  const scope = entry.scope;
  if (!isObj(scope) || !bookId) return false;
  const book = m.records.get("book")?.get(bookId);
  if (scope.kind === "book") return scope.id === bookId;
  if (scope.kind === "series") return book?.seriesId === scope.id;
  if (scope.kind === "universe") return book?.universeId === scope.id;
  return false;
}

export function entriesOfType(m: Model, types: readonly string[], bookId: string | undefined): Rec[] {
  return records(m, "entry").filter((e) => !e.deletedAt && types.includes(String(e.entryType)) && visibleFrom(m, e, bookId))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1));
}

export const scopeName = (m: Model, scope: unknown): string => {
  if (!isObj(scope)) return "";
  const kind = scope.kind === "book" ? "book" : scope.kind === "series" ? "series" : "universe";
  const r = m.records.get(kind)?.get(String(scope.id));
  return typeof r?.title === "string" ? r.title : typeof r?.name === "string" ? r.name : "";
};

/** Plain words for who shares an entry (slice 1 edits the shared canon only). */
export function scopeSentence(m: Model, entry: Rec): string {
  const scope = isObj(entry.scope) ? entry.scope : {};
  const name = scopeName(m, scope);
  const noun = entryNoun(String(entry.entryType));
  const where = scope.kind === "book" ? `the book${name ? ` "${name}"` : ""}` : scope.kind === "series" ? `the series${name ? ` "${name}"` : ""}` : `the universe${name ? ` "${name}"` : ""}`;
  return `This ${noun} belongs to ${where}. What you change here is shared by every book in that scope. Changes for one book only are not available yet.`;
}

/** The text of a summary, cut for a list. */
export const shortSummary = (s: unknown, max = 90): string => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The built-in display of a value for read-only fields. */
export function readOnlyText(m: Model, f: FieldDef, value: unknown): string {
  if (value === undefined) return "Nothing set";
  if (f.fieldType === "attachment") return typeof value === "string" ? `File ${value}` : "Nothing set";
  if (f.fieldType === "entryReferences" && Array.isArray(value)) {
    const names = value.map((id) => String(m.records.get("entry")?.get(String(id))?.name ?? "A missing entry"));
    return names.length ? names.join(", ") : "Nothing set";
  }
  if (f.fieldType === "table" && isObj(value) && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    return `A table with ${value.columns.length} columns and ${value.rows.length} rows`;
  }
  return "Cannot be shown here";
}

// ---------- value encoding and validation ----------

export type Encoded = { ok: true; value: unknown } | { ok: false; message: string };
/** `undefined` as the value of an ok result means "remove the value". */

export function realDateOk(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

/** A string the server could not keep: U+0000 or a lone surrogate. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const storableText = (s: string): boolean => !LONE_SURROGATE.test(s) && !s.includes("\u0000");

/**
 * What the author typed, as the JSON value of the field. Empty text is "no value" (ok with value undefined).
 * `current` is the value now stored, so a fictional date keeps its calendar and number when only the label changes.
 */
export function encodeText(f: FieldDef, text: string, current?: unknown): Encoded {
  const t = text;
  if (!storableText(t)) return { ok: false, message: "This text has a character that cannot be stored." };
  switch (f.fieldType) {
    case "shortText": case "longText": return { ok: true, value: t.trim() === "" ? undefined : t };
    case "integer": {
      const s = t.trim();
      if (s === "") return { ok: true, value: undefined };
      if (!/^-?\d+$/.test(s) || !Number.isSafeInteger(Number(s))) return { ok: false, message: "Enter a whole number, such as 24." };
      return { ok: true, value: Number(s) };
    }
    case "decimal": {
      const s = t.trim();
      if (s === "") return { ok: true, value: undefined };
      if (!DECIMAL.test(s)) return { ok: false, message: "Enter a number with digits and at most one point, such as 1.68." };
      return { ok: true, value: s };
    }
    case "realDate": {
      const s = t.trim();
      if (s === "") return { ok: true, value: undefined };
      if (!realDateOk(s)) return { ok: false, message: "Enter a real date as year-month-day, such as 2000-02-29." };
      return { ok: true, value: s };
    }
    case "fictionalDate": {
      const label = t.trim();
      const rest = isObj(current) ? Object.fromEntries(Object.entries(current).filter(([k]) => k !== "label")) : {};
      if (label === "") {
        if (Object.keys(rest).length > 0) return { ok: false, message: "This date also has a calendar or a number, so its label cannot be empty." };
        return { ok: true, value: undefined };
      }
      return { ok: true, value: { ...rest, label } };
    }
    default: return { ok: false, message: "This field cannot be changed here." };
  }
}

/** Whether a JSON value is valid for the field type. Returns a plain message, or undefined when it is valid. */
export function validateValue(f: FieldDef, value: unknown, m?: Model): string | undefined {
  const bad = (what: string): string => `This is not ${what}.`;
  switch (f.fieldType) {
    case "shortText": case "longText":
      if (typeof value !== "string") return bad("text");
      return storableText(value) ? undefined : "This text has a character that cannot be stored.";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) ? undefined : bad("a whole number");
    case "decimal":
      return typeof value === "string" && DECIMAL.test(value) ? undefined : bad("a decimal number written as text");
    case "boolean":
      return typeof value === "boolean" ? undefined : bad("yes or no");
    case "selection": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return bad("a list of options");
      if (new Set(value).size !== value.length) return "An option is chosen twice.";
      if (!f.multiple && value.length > 1) return "Only one option can be chosen.";
      return value.every((v) => f.options.some((o) => o.id === v)) ? undefined : "This is not one of the options.";
    }
    case "realDate":
      return typeof value === "string" && realDateOk(value) ? undefined : bad("a real date");
    case "fictionalDate": {
      if (!isObj(value) || typeof value.label !== "string" || value.label === "") return "A fictional date needs a label.";
      if (!Object.keys(value).every((k) => k === "label" || k === "calendar" || k === "ordinal")) return bad("a fictional date");
      if (value.calendar !== undefined && (typeof value.calendar !== "string" || value.calendar === "")) return bad("a fictional date");
      if (value.ordinal !== undefined && !(typeof value.ordinal === "number" && Number.isSafeInteger(value.ordinal))) return bad("a fictional date");
      return storableText(value.label) ? undefined : "This text has a character that cannot be stored.";
    }
    case "entryReference": {
      if (typeof value !== "string" || !UUID.test(value)) return bad("an entry");
      const target = m?.records.get("entry")?.get(value);
      if (m && !target) return "This entry is not in the library.";
      if (target && f.targetEntryTypes.length > 0 && !f.targetEntryTypes.includes(String(target.entryType))) return "This entry is of a type this field does not take.";
      return undefined;
    }
    case "entryReferences":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && UUID.test(v)) && new Set(value).size === value.length ? undefined : bad("a list of entries");
    case "attachment":
      return typeof value === "string" && SHA256.test(value) ? undefined : bad("a file");
    case "table": return isObj(value) ? undefined : bad("a table");
    default: return "This field type is not known.";
  }
}

// ---------- what a field shows, and what it sends ----------

export type Input = string | string[];

/** What the control for a template field shows for the value stored now. */
export function inputOf(f: FieldDef, value: unknown): Input {
  switch (f.fieldType) {
    case "integer": return typeof value === "number" ? String(value) : "";
    case "boolean": return value === true ? "yes" : value === false ? "no" : "";
    case "selection": {
      const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return f.multiple ? ids : (ids[0] ?? "");
    }
    case "fictionalDate": return isObj(value) && typeof value.label === "string" ? value.label : "";
    default: return typeof value === "string" ? value : "";
  }
}

/** The JSON value (or undefined for "no value") for what a control shows. A refusal is a plain message. */
export function encodeInput(f: FieldDef, input: Input, current?: unknown): Encoded {
  switch (f.fieldType) {
    case "boolean": return { ok: true, value: input === "yes" ? true : input === "no" ? false : undefined };
    case "selection": {
      const ids = Array.isArray(input) ? input : input === "" ? [] : [input];
      return { ok: true, value: ids.length === 0 ? undefined : ids };
    }
    case "entryReference": return { ok: true, value: input === "" || Array.isArray(input) ? undefined : input };
    default: return encodeText(f, Array.isArray(input) ? input.join("\n") : input, current);
  }
}

// ---------- the fields of an entry that are not template fields ----------

export type TopField = "name" | "givenName" | "familyName" | "aliases" | "summary" | "toBeNamed";

/** The top-level fields as controls show them, and as values: one alias per line; an empty name part or summary is removed. */
export function topInputOf(field: TopField, entry: Rec): string {
  if (field === "aliases") return Array.isArray(entry.aliases) ? entry.aliases.join("\n") : "";
  const v = entry[field];
  return typeof v === "string" ? v : "";
}
export function encodeTop(field: TopField, input: string): unknown {
  if (field === "aliases") return [...new Set(input.split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== ""))];
  const t = input.trim();
  if (field === "name") return t;
  return t === "" ? undefined : t;
}

/** The check before a top-level field is sent. A missing value (undefined) is allowed only where the field can be removed. */
export function validateTop(field: TopField, value: unknown): string | undefined {
  switch (field) {
    case "name":
      if (typeof value !== "string" || value.trim() === "") return "A name is needed. If it has none yet, tick \"No name yet\" and keep a placeholder.";
      return storableText(value) ? undefined : "This text has a character that cannot be stored.";
    case "givenName": case "familyName": case "summary":
      if (value === undefined) return undefined;
      if (typeof value !== "string" || (field !== "summary" && value === "")) return "This is not text.";
      return storableText(value) ? undefined : "This text has a character that cannot be stored.";
    case "aliases":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && storableText(v))) return "Aliases must be text.";
      return undefined;
    case "toBeNamed":
      return value === undefined || value === true ? undefined : "This is not yes or no.";
  }
}

/** Every check that applies to one field of an entry, by its sync field name. Returns a plain message, or undefined. */
export function checkEntryField(m: Model, entry: Rec, field: string, value: unknown): string | undefined {
  const values = /^values\/([0-9a-f-]{36})$/.exec(field);
  if (values) {
    const def = fieldsOf(m, entry.templateId).find((f) => f.id === values[1]);
    if (!def) return "This field is not in the entry's template.";
    if (value === undefined) return undefined;
    return validateValue(def, value, m);
  }
  if (field === "name" || field === "givenName" || field === "familyName" || field === "aliases" || field === "summary" || field === "toBeNamed") {
    if ((field === "givenName" || field === "familyName") && entry.entryType !== "character") return "Given and family names belong to characters only.";
    return validateTop(field, value);
  }
  return "This field cannot be changed here.";
}

/** The whole record for a create op. Values and overrides start empty: slice 1 edits shared canon only. */
export function newEntryValue(m: Model, p: { id: string; type: EntryType; name: string; toBeNamed: boolean; bookId: string }): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const tpl = builtInTemplate(m, p.type);
  if (!tpl) {
    const trashed = records(m, "template").some((t) => t.builtIn === true && t.entryType === p.type && t.deletedAt);
    return { ok: false, error: trashed ? "The template for this kind of entry is in the trash on the server, so no entry can be made from it here." : "The story bible is not set up yet." };
  }
  const name = p.name.trim();
  if (!storableText(name)) return { ok: false, error: "This name has a character that cannot be stored." };
  if (name === "" && !p.toBeNamed) return { ok: false, error: "A name is needed. If it has none yet, tick \"No name yet\"." };
  const now = stamp();
  return {
    ok: true,
    value: {
      id: p.id, entryType: p.type, templateId: tpl.id, name: name === "" ? `Unnamed ${entryNoun(p.type)}` : name,
      ...(p.toBeNamed ? { toBeNamed: true } : {}), aliases: [], scope: { kind: "book", id: p.bookId }, values: {}, overrides: [], attachments: [],
      createdAt: now, updatedAt: now,
    },
  };
}

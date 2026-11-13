// Story bible records in the browser's model: reading entries, the built-in templates, and the value rules of
// archive-format-v1.md ("bible/fields.json" and "bible/entries.json"). Nothing here touches the network. The server
// validates every value again; these checks only keep a value of the wrong type from being sent.
import { BUILTIN_FIELDS, BUILTIN_TEMPLATES } from "./bible-builtins.ts";
import { outline } from "./model.ts";
import type { Model, Rec } from "./model.ts";

/** The entry types the studio can make. "event" has a built-in template too; the timeline's events are their own records (slice 3). */
export type EntryType = "character" | "location" | "term" | "organization" | "object" | "plotline" | "worldRule" | "research";
export type RecordKind = "entry" | "fact" | "question" | "event" | "stateChange";
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
export function scopeSentence(m: Model, entry: Rec, nounOverride?: string): string {
  const scope = isObj(entry.scope) ? entry.scope : {};
  const name = scopeName(m, scope);
  const noun = nounOverride ?? entryNoun(String(entry.entryType));
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

// ---------- facts and questions (slice 2) ----------
// Records of the archive's bible/facts.json and bible/questions.json. Arrays (entryIds, knowledge) are always sent whole.

const cp = (s: string): number => [...s].length;
export const FACT_TRUTH = [["true", "True"], ["false", "False"], ["undecided", "Not decided"]] as const;
export const QUESTION_STATUS = [["open", "Open"], ["decided", "Decided"]] as const;
export const TEXT_MAX = 20000, TOPIC_MAX = 64;

const listOf = (m: Model, kind: "fact" | "question", bookId: string | undefined): Rec[] =>
  records(m, kind).filter((r) => !r.deletedAt && visibleFrom(m, r, bookId)).sort(byOrder);
export const factsOf = (m: Model, bookId: string | undefined): Rec[] => listOf(m, "fact", bookId);
export const questionsOf = (m: Model, bookId: string | undefined): Rec[] => listOf(m, "question", bookId);

/** A key that sorts after every key of this kind now: the clock in base 36, or after the largest key if the clock is behind. */
function nextOrderKey(m: Model, kind: string): string {
  const stamp36 = Date.now().toString(36).replace(/0+$/, "");
  const top = records(m, kind).map((r) => String(r.orderKey ?? "")).sort().at(-1) ?? "";
  return stamp36 > top ? stamp36 : `${top}m`;
}

/** The text a new fact or question needs: 1 to 20,000 characters. */
function textProblem(text: string, noun: string): string | undefined {
  if (!storableText(text)) return "This text has a character that cannot be stored.";
  if (text.trim() === "") return `The text of the ${noun} is needed.`;
  if (cp(text.trim()) > TEXT_MAX) return `The text of the ${noun} can be at most 20,000 characters.`;
  return undefined;
}

type Made = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
export function newFactValue(m: Model, p: { id: string; text: string; bookId: string }): Made {
  const bad = textProblem(p.text, "fact");
  if (bad) return { ok: false, error: bad };
  const now = stamp();
  return { ok: true, value: { id: p.id, scope: { kind: "book", id: p.bookId }, text: p.text.trim(), truth: "undecided", entryIds: [], knowledge: [], orderKey: nextOrderKey(m, "fact"), createdAt: now, updatedAt: now } };
}
export function newQuestionValue(m: Model, p: { id: string; text: string; bookId: string }): Made {
  const bad = textProblem(p.text, "question");
  if (bad) return { ok: false, error: bad };
  const now = stamp();
  return { ok: true, value: { id: p.id, scope: { kind: "book", id: p.bookId }, text: p.text.trim(), status: "open", entryIds: [], orderKey: nextOrderKey(m, "question"), createdAt: now, updatedAt: now } };
}

export type RecordField = "text" | "truth" | "status" | "topic" | "decision" | "nodeId" | "entryIds" | "knowledge";

/** A chapter or scene in a book inside the record's scope. */
export function nodesInScope(m: Model, scope: unknown, scenesOnly = false): Array<{ id: string; label: string }> {
  const books = records(m, "book").filter((b) => !b.deletedAt && isObj(scope) && (scope.kind === "book" ? b.id === scope.id : scope.kind === "series" ? b.seriesId === scope.id : b.universeId === scope.id)).sort(byOrder);
  const out: Array<{ id: string; label: string }> = [];
  for (const b of books) {
    for (const { node } of outline(m, b.id)) {
      if (node.kind !== "chapter" && node.kind !== "scene") continue;
      if (scenesOnly && node.kind !== "scene") continue;
      const title = String(node.title) || (node.kind === "scene" ? "Untitled scene" : "Untitled chapter");
      out.push({ id: node.id, label: books.length > 1 ? `${String(b.title)}: ${title}` : title });
    }
  }
  return out;
}

/** What the control for a fact or question field shows for the value stored now. */
export function recordInputOf(field: RecordField, rec: Rec): Input {
  switch (field) {
    case "entryIds": return Array.isArray(rec.entryIds) ? rec.entryIds.filter((v): v is string => typeof v === "string") : [];
    case "knowledge": return Array.isArray(rec.knowledge) ? rec.knowledge.map((k) => (isObj(k) ? String(k.knower) : "")).filter((v) => v !== "") : [];
    default: return typeof rec[field] === "string" ? (rec[field] as string) : "";
  }
}

/** The JSON value (undefined means "remove the field") for what a control shows. `current` keeps each knower's scene. */
export function encodeRecordInput(field: RecordField, input: Input, current: unknown): Encoded {
  const list = Array.isArray(input) ? input : [];
  switch (field) {
    case "entryIds": return { ok: true, value: list };
    case "knowledge": {
      const have = new Map((Array.isArray(current) ? current : []).filter(isObj).map((k) => [String(k.knower), k] as const));
      return { ok: true, value: list.map((k) => ({ knower: k, ...(typeof have.get(k)?.nodeId === "string" ? { nodeId: have.get(k)!.nodeId } : {}) })) };
    }
    case "text": case "truth": case "status": return { ok: true, value: String(input).trim() };
    default: { const t = String(input).trim(); return { ok: true, value: t === "" ? undefined : t }; }
  }
}

/** Every check that applies to one field of a fact or a question, by its sync field name. Returns a plain message, or undefined. */
export function checkRecordField(m: Model, kind: "fact" | "question", rec: Rec, field: string, value: unknown): string | undefined {
  const noun = kind;
  const known = kind === "fact" ? ["text", "truth", "nodeId", "entryIds", "knowledge"] : ["text", "topic", "status", "decision", "nodeId", "entryIds"];
  if (!known.includes(field)) return "This field cannot be changed here.";
  const text = (v: unknown, min: number, max: number, what: string): string | undefined => {
    if (typeof v !== "string") return "This is not text.";
    if (!storableText(v)) return "This text has a character that cannot be stored.";
    if (cp(v) < min) return `The ${what} is needed.`;
    if (cp(v) > max) return `The ${what} can be at most ${max.toLocaleString("en-US")} characters.`;
    return undefined;
  };
  const node = (id: unknown): string | undefined => {
    if (typeof id !== "string" || !UUID.test(id)) return "This is not a scene or chapter.";
    const n = m.records.get("manuscriptNode")?.get(id);
    if (!n) return "This scene or chapter is not in the library.";
    if (n.kind !== "chapter" && n.kind !== "scene") return "Choose a chapter or a scene.";
    // Like the server: the node's book is looked up among all books, trashed or not; a trashed scene is only a warning there.
    const book = typeof n.bookId === "string" ? m.records.get("book")?.get(n.bookId) : undefined;
    const sc = rec.scope;
    const inScope = !!book && isObj(sc) && (sc.kind === "book" ? book.id === sc.id : sc.kind === "series" ? book.seriesId === sc.id : sc.kind === "universe" && book.universeId === sc.id);
    return inScope ? undefined : `This scene is in a book outside the ${noun}'s scope.`;
  };
  switch (field) {
    case "text": return text(value, 1, TEXT_MAX, `text of the ${noun}`);
    case "topic": return value === undefined ? undefined : text(value, 1, TOPIC_MAX, "topic");
    case "decision": return value === undefined ? undefined : text(value, 0, TEXT_MAX, "decision");
    case "truth": return FACT_TRUTH.some(([v]) => v === value) ? undefined : "Choose true, false or not decided.";
    case "status": return QUESTION_STATUS.some(([v]) => v === value) ? undefined : "Choose open or decided.";
    case "nodeId": return value === undefined ? undefined : node(value);
    case "entryIds": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && UUID.test(v))) return "This is not a list of entries.";
      if (new Set(value).size !== value.length) return "An entry is chosen twice.";
      return value.every((v) => m.records.get("entry")?.has(v)) ? undefined : "An entry here is not in the library.";
    }
    case "knowledge": {
      if (!Array.isArray(value)) return "This is not a list of who knows it.";
      const seen = new Set<string>();
      for (const k of value) {
        if (!isObj(k) || typeof k.knower !== "string" || !Object.keys(k).every((x) => x === "knower" || x === "nodeId")) return "This is not a list of who knows it.";
        if (seen.has(k.knower)) return "Someone is listed twice.";
        seen.add(k.knower);
        if (k.knower !== "reader" && m.records.get("entry")?.get(k.knower)?.entryType !== "character") return "Only the reader or a character can know a fact.";
        if (k.nodeId !== undefined) { const bad = node(k.nodeId); if (bad) return bad; }
      }
      return undefined;
    }
  }
  return undefined;
}

// ---------- events and state changes (slice 3) ----------
// Records of the archive's bible/events.json and bible/state-changes.json. Arrays (sceneIds, participants) are always sent whole.
// Not here on purpose: overrides, dismissed warnings and continuity warnings (later slices).

/** A timeline is the events of one scope ordered by orderKey, then id (archive format). Scopes are kept apart: the book's own, then its series, then its universe. */
const SCOPE_RANK: Record<string, number> = { book: 0, series: 1, universe: 2 };
export const eventsOf = (m: Model, bookId: string | undefined): Rec[] => {
  const rank = (e: Rec): number => (isObj(e.scope) ? (SCOPE_RANK[String(e.scope.kind)] ?? 3) : 3);
  return records(m, "event").filter((r) => !r.deletedAt && visibleFrom(m, r, bookId)).sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const x = String(a.orderKey ?? ""), y = String(b.orderKey ?? "");
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
};
export const removedEventsOf = (m: Model, bookId: string | undefined): Rec[] =>
  records(m, "event").filter((r) => !!r.deletedAt && visibleFrom(m, r, bookId)).sort(byOrder);

export const eventTitle = (e: Rec | undefined): string => (typeof e?.title === "string" && e.title.trim() !== "" ? e.title : "Untitled event");

/** The when label of an event, for a list. */
export const whenLabel = (e: Rec): string => (isObj(e.when) && typeof e.when.label === "string" ? e.when.label : "");

export const sceneTitle = (m: Model, id: unknown): string => {
  const n = m.records.get("manuscriptNode")?.get(String(id));
  return typeof n?.title === "string" && n.title.trim() !== "" ? n.title : n ? "Untitled scene" : "A scene that is not available";
};

export function newEventValue(m: Model, p: { id: string; title: string; bookId: string }): Made {
  const title = p.title.trim();
  if (title === "") return { ok: false, error: "The title of the event is needed." };
  if (!storableText(title)) return { ok: false, error: "This text has a character that cannot be stored." };
  const now = stamp();
  return { ok: true, value: { id: p.id, scope: { kind: "book", id: p.bookId }, title, orderKey: nextOrderKey(m, "event"), sceneIds: [], participants: [], createdAt: now, updatedAt: now } };
}

export type EventField = "title" | "summary" | "when" | "entryId" | "sceneIds" | "participants";

/** A participant is shown to a control as JSON text, so a list of them is a list of strings like the other controls. */
export const participantItem = (entryId: string, role: string): string => JSON.stringify({ entryId, role });
export function participantsOf(input: Input): Array<{ entryId: string; role: string }> {
  const out: Array<{ entryId: string; role: string }> = [];
  for (const raw of Array.isArray(input) ? input : []) {
    try { const o = JSON.parse(raw) as { entryId?: unknown; role?: unknown }; out.push({ entryId: String(o.entryId), role: typeof o.role === "string" ? o.role : "" }); } catch { /* not ours */ }
  }
  return out;
}

/** What the control for an event field shows for the value stored now. The date is [label, number, calendar]. */
export function eventInputOf(field: EventField, e: Rec): Input {
  switch (field) {
    case "when": {
      const w = isObj(e.when) ? e.when : {};
      return [typeof w.label === "string" ? w.label : "", typeof w.ordinal === "number" ? String(w.ordinal) : "", typeof w.calendar === "string" ? w.calendar : ""];
    }
    case "sceneIds": return Array.isArray(e.sceneIds) ? e.sceneIds.filter((v): v is string => typeof v === "string") : [];
    case "participants": return Array.isArray(e.participants) ? e.participants.filter(isObj).map((p) => participantItem(String(p.entryId), typeof p.role === "string" ? p.role : "")) : [];
    default: return typeof e[field] === "string" ? (e[field] as string) : "";
  }
}

/** The JSON value (undefined means "remove the field") for what a control shows. A refusal is a plain message. */
export function encodeEventInput(field: EventField, input: Input): Encoded {
  const list = Array.isArray(input) ? input : [];
  switch (field) {
    case "title": return { ok: true, value: String(input).trim() };
    case "sceneIds": return { ok: true, value: list };
    case "participants": return { ok: true, value: participantsOf(input).map((p) => ({ entryId: p.entryId, ...(p.role.trim() !== "" ? { role: p.role.trim() } : {}) })) };
    case "when": {
      const [label = "", number = "", calendar = ""] = list.map((x) => x.trim());
      if (label === "" && number === "" && calendar === "") return { ok: true, value: undefined };
      if (label === "") return { ok: false, message: "A date label is needed when a number or a calendar is set." };
      if (number !== "" && (!/^-?\d+$/.test(number) || !Number.isSafeInteger(Number(number)))) return { ok: false, message: "Enter a whole number, such as 388." };
      return { ok: true, value: { label, ...(calendar !== "" ? { calendar } : {}), ...(number !== "" ? { ordinal: Number(number) } : {}) } };
    }
    default: { const t = String(input).trim(); return { ok: true, value: t === "" ? undefined : t }; }
  }
}

/** A node the way the server reads the scope rule: looked up among all books (a trashed one is only a warning there). */
function nodeProblem(m: Model, id: unknown, scope: unknown, kinds: string[], what: string): string | undefined {
  if (typeof id !== "string" || !UUID.test(id)) return `This is not a ${what}.`;
  const n = m.records.get("manuscriptNode")?.get(id);
  if (!n) return `This ${what} is not in the library.`;
  if (!kinds.includes(String(n.kind))) return kinds.length === 1 ? "Choose a scene." : "Choose a chapter or a scene.";
  const book = typeof n.bookId === "string" ? m.records.get("book")?.get(n.bookId) : undefined;
  const inScope = !!book && isObj(scope) && (scope.kind === "book" ? book.id === scope.id : scope.kind === "series" ? book.seriesId === scope.id : scope.kind === "universe" && book.universeId === scope.id);
  return inScope ? undefined : `This ${what} is in a book outside the scope.`;
}

export function validWhen(value: unknown): string | undefined {
  if (!isObj(value) || typeof value.label !== "string" || value.label === "") return "A date needs a label.";
  if (!Object.keys(value).every((k) => k === "label" || k === "calendar" || k === "ordinal")) return "This is not a date.";
  if (value.calendar !== undefined && (typeof value.calendar !== "string" || value.calendar === "")) return "This is not a date.";
  if (value.ordinal !== undefined && !(typeof value.ordinal === "number" && Number.isSafeInteger(value.ordinal))) return "Enter a whole number, such as 388.";
  return storableText(value.label) && storableText(String(value.calendar ?? "")) ? undefined : "This text has a character that cannot be stored.";
}

/** Every check that applies to one field of an event, by its sync field name. Returns a plain message, or undefined. */
export function checkEventField(m: Model, rec: Rec, field: string, value: unknown): string | undefined {
  switch (field) {
    case "title":
      if (typeof value !== "string" || value.trim() === "") return "The title of the event is needed.";
      return storableText(value) ? undefined : "This text has a character that cannot be stored.";
    case "summary":
      if (value === undefined) return undefined;
      return typeof value === "string" && storableText(value) ? undefined : "This text has a character that cannot be stored.";
    case "when": return value === undefined ? undefined : validWhen(value);
    case "entryId": {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !UUID.test(value)) return "This is not an entry.";
      const target = m.records.get("entry")?.get(value);
      if (!target) return "This entry is not in the library.";
      return target.entryType === "event" ? undefined : "Only an entry of the type event can be linked.";
    }
    case "sceneIds": {
      if (!Array.isArray(value)) return "This is not a list of scenes.";
      if (new Set(value).size !== value.length) return "A scene is chosen twice.";
      for (const id of value) { const bad = nodeProblem(m, id, rec.scope, ["scene"], "scene"); if (bad) return bad; }
      return undefined;
    }
    case "participants": {
      if (!Array.isArray(value)) return "This is not a list of participants.";
      const seen = new Set<string>();
      for (const p of value) {
        if (!isObj(p) || typeof p.entryId !== "string" || !Object.keys(p).every((k) => k === "entryId" || k === "role")) return "This is not a list of participants.";
        if (p.role !== undefined && (typeof p.role !== "string" || !storableText(p.role))) return "A role has a character that cannot be stored.";
        if (seen.has(p.entryId)) return "Someone is listed twice.";
        seen.add(p.entryId);
        if (!m.records.get("entry")?.has(p.entryId)) return "A participant is not in the library.";
      }
      return undefined;
    }
  }
  return "This field cannot be changed here.";
}

/** The template field types a state change can hold in this version: the ones the studio has a control for. */
export const STATE_FIELD_TYPES = new Set(["shortText", "longText", "integer", "decimal", "boolean", "selection", "realDate", "fictionalDate", "entryReference"]);

export const stateChangesOf = (m: Model, entryId: string, removed = false): Rec[] =>
  records(m, "stateChange").filter((c) => c.entryId === entryId && (removed ? !!c.deletedAt : !c.deletedAt))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || (a.id < b.id ? -1 : 1));

/** The field definition a state change's value must match, or undefined when the entry or its template no longer has it. */
export function stateChangeDef(m: Model, c: Rec): FieldDef | undefined {
  const entry = m.records.get("entry")?.get(String(c.entryId));
  return entry ? fieldsOf(m, entry.templateId).find((f) => f.id === c.fieldId) : undefined;
}

/** The value problem of a state change, or undefined. A state change always has a value. */
export function stateValueProblem(m: Model, def: FieldDef, value: unknown): string | undefined {
  if (value === undefined) return "A value is needed.";
  return validateValue(def, value, m);
}

export type Target = { eventId: string } | { nodeId: string };

export const EARLIER_MOVE_FIRST = "Finish the earlier move first: remove one of the two copies, or choose the same place again.";
export const EARLIER_MOVE_MAY_HAVE_WORKED = "The earlier move may have gone through. Choose the same place again to check it, or reload the page.";
export interface MoveAttempt { key: string; id: string; opId: string; created?: boolean; lost?: boolean }

/**
 * The attempt for moving a state change to the target `key`. The same ids for the same target, so a lost answer is a safe
 * retry; a different target is refused while an earlier move left two copies, or while its create may have been applied.
 */
export function nextMoveAttempt(prev: MoveAttempt | undefined, key: string, mint: () => string): { ok: true; attempt: MoveAttempt } | { ok: false; message: string } {
  if (prev && prev.key !== key) {
    if (prev.created) return { ok: false, message: EARLIER_MOVE_FIRST };
    if (prev.lost) return { ok: false, message: EARLIER_MOVE_MAY_HAVE_WORKED }; // the server may have the copy: a second target would leave two
  }
  return { ok: true, attempt: prev?.key === key ? prev : { key, id: mint(), opId: mint() } };
}

/**
 * The attempt after a failed move. Cleared only when the outcome is definitive (`clear`: the new copy is gone, or the
 * server refused the create). Otherwise the earlier state is kept, so a refused retry never forgets a copy that may exist.
 */
export function attemptAfterFailedMove(prev: MoveAttempt, out: { created?: boolean; lost?: boolean; clear?: boolean }): MoveAttempt | undefined {
  if (out.clear) return undefined;
  if (out.created) return { ...prev, created: true, lost: false };
  return { ...prev, created: prev.created || out.created, lost: prev.lost || out.lost };
}

export function newStateChangeValue(m: Model, p: { id: string; entryId: string; fieldId: string; input: Input; note: string; target: Target | undefined }): Made {
  const entry = m.records.get("entry")?.get(p.entryId);
  if (!entry || entry.deletedAt) return { ok: false, error: "This entry is not in the library any more." };
  if (typeof entry.templateId !== "string") return { ok: false, error: "This entry has no template, so it cannot have state changes." };
  const def = fieldsOf(m, entry.templateId).find((f) => f.id === p.fieldId);
  if (!def) return { ok: false, error: "Choose a field of this entry's template." };
  if (!STATE_FIELD_TYPES.has(def.fieldType)) return { ok: false, error: "This kind of field cannot be changed here yet." };
  if (!p.target) return { ok: false, error: "Choose the event or scene where it changes." };
  if ("eventId" in p.target) { if (!m.records.get("event")?.has(p.target.eventId)) return { ok: false, error: "This event is not in the library." }; }
  else { const bad = nodeProblem(m, p.target.nodeId, entry.scope, ["chapter", "scene"], "scene"); if (bad) return { ok: false, error: bad }; }
  const enc = encodeInput(def, p.input);
  if (!enc.ok) return { ok: false, error: enc.message };
  const bad = stateValueProblem(m, def, enc.value);
  if (bad) return { ok: false, error: bad };
  const note = p.note.trim();
  if (!storableText(note)) return { ok: false, error: "This text has a character that cannot be stored." };
  const now = stamp();
  return { ok: true, value: { id: p.id, entryId: p.entryId, fieldId: p.fieldId, value: enc.value, ...("eventId" in p.target ? { eventId: p.target.eventId } : { nodeId: p.target.nodeId }), ...(note !== "" ? { note } : {}), createdAt: now, updatedAt: now } };
}

/** Every check that applies to one field of a state change, by its sync field name. Returns a plain message, or undefined. */
export function checkStateChangeField(m: Model, rec: Rec, field: string, value: unknown): string | undefined {
  if (field === "note") return value === undefined || (typeof value === "string" && storableText(value)) ? undefined : "This text has a character that cannot be stored.";
  if (field === "value") {
    const def = stateChangeDef(m, rec);
    return def ? stateValueProblem(m, def, value) : "This field is not in the entry's template any more.";
  }
  return "This field cannot be changed here.";
}

/** The record for a state change moved to another event or scene: the same entry, field, value and note, a new id. */
export function movedStateChangeValue(m: Model, old: Rec, id: string, target: Target): Made {
  const entry = m.records.get("entry")?.get(String(old.entryId));
  if (!entry) return { ok: false, error: "This entry is not in the library any more." };
  if ("eventId" in target) { if (!m.records.get("event")?.has(target.eventId)) return { ok: false, error: "This event is not in the library." }; }
  else { const bad = nodeProblem(m, target.nodeId, entry.scope, ["chapter", "scene"], "scene"); if (bad) return { ok: false, error: bad }; }
  const now = stamp();
  return {
    ok: true,
    value: {
      id, entryId: old.entryId, fieldId: old.fieldId, value: old.value, ...("eventId" in target ? { eventId: target.eventId } : { nodeId: target.nodeId }),
      ...(typeof old.note === "string" ? { note: old.note } : {}), createdAt: now, updatedAt: now,
    },
  };
}

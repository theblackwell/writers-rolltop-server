// The library tables as archive records, one kind at a time. Archive import and export (archive-io.ts) and the sync
// protocol (sync.ts) all read and write records through this file, so a record has exactly one current state and one
// column mapping. A record here is the archive's own JSON form (an open object): known properties live in columns,
// unknown ones in extra_json and come back unchanged.
import type pg from "pg";
import type { Rec, RecordKind } from "@writers-rolltop/archive";

type Row = Record<string, any>;
export type Db = pg.PoolClient;

// ---- column mapping helpers ----

const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const js = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/** Unknown properties of an open record, as JSON text (null when there are none). */
export function extraOf(rec: Rec, known: readonly string[]): string | null {
  const skip = new Set(known);
  const extra: Rec = {};
  let any = false;
  for (const [k, v] of Object.entries(rec)) {
    if (!skip.has(k)) { Object.defineProperty(extra, k, { value: v, enumerable: true, writable: true, configurable: true }); any = true; }
  }
  return any ? JSON.stringify(extra) : null;
}

const S = ["createdAt", "updatedAt", "deletedAt"] as const;
const stamps = (r: Rec): unknown[] => [r.createdAt, r.updatedAt, nul(r.deletedAt)];
const scopeCols = (s: { kind: string; id: string }): unknown[] => [
  s.kind === "universe" ? s.id : null, s.kind === "series" ? s.id : null, s.kind === "book" ? s.id : null];

const MAX_PARAMS = 30_000;

export async function insertMany(db: Db, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const per = Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / columns.length)));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`);
    await db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`, params);
  }
}

// ---- the kinds ----

interface Desc {
  table: string;
  /** Columns of the record's own row, `id` first and extra_json last. `row` returns the values in this order. */
  columns: string[];
  row(r: Rec): unknown[];
  /** True when the table has deleted_at. */
  trash: boolean;
}

const COMMON = ["created_at", "updated_at", "deleted_at", "extra_json"];
const bookKnown = ["id", "universeId", "seriesId", "title", "subtitle", "authorName", "description", "language", "coverAttachment",
  "targetWordCount", "targetDate", "logline", "premise", "themes", "arcs", "principles", "bibleVersion", "orderKey", ...S];
const nodeKnown = ["id", "bookId", "parentId", "kind", "title", "synopsis", "status", "povEntryId", "settingEntryId", "targetWordCount", "plan", "orderKey", ...S];
const entryKnown = ["id", "entryType", "templateId", "name", "givenName", "familyName", "toBeNamed", "aliases", "summary", "scope", "values", "overrides", "attachments", ...S];
const factKnown = ["id", "scope", "text", "truth", "nodeId", "entryIds", "knowledge", "overrides", "dismissedWarnings", "orderKey", ...S];
const questionKnown = ["id", "scope", "text", "topic", "status", "decision", "entryIds", "nodeId", "overrides", "dismissedWarnings", "orderKey", ...S];
const eventKnown = ["id", "scope", "title", "summary", "when", "orderKey", "entryId", "sceneIds", "participants", "overrides", "dismissedWarnings", ...S];

const DESCS: Record<RecordKind, Desc> = {
  library: {
    table: "library", trash: false, columns: ["id", "title", "created_at", "updated_at", "extra_json"],
    row: (r) => [r.id, r.title, r.createdAt, r.updatedAt, extraOf(r, ["id", "title", "createdAt", "updatedAt"])],
  },
  universe: {
    table: "universe", trash: true, columns: ["id", "title", "summary", "order_key", ...COMMON],
    row: (r) => [r.id, r.title, nul(r.summary), r.orderKey, ...stamps(r), extraOf(r, ["id", "title", "summary", "orderKey", ...S])],
  },
  series: {
    table: "series", trash: true, columns: ["id", "universe_id", "title", "summary", "order_key", ...COMMON],
    row: (r) => [r.id, nul(r.universeId), r.title, nul(r.summary), r.orderKey, ...stamps(r), extraOf(r, ["id", "universeId", "title", "summary", "orderKey", ...S])],
  },
  book: {
    table: "book", trash: true,
    columns: ["id", "universe_id", "series_id", "title", "subtitle", "author_name", "description", "language", "cover_attachment",
      "target_word_count", "target_date", "logline", "premise", "themes", "arcs", "principles", "bible_version", "order_key", ...COMMON],
    row: (r) => [r.id, nul(r.universeId), nul(r.seriesId), r.title, nul(r.subtitle), nul(r.authorName), nul(r.description), nul(r.language),
      nul(r.coverAttachment), nul(r.targetWordCount), nul(r.targetDate), nul(r.logline), nul(r.premise), nul(r.themes), nul(r.arcs), nul(r.principles),
      nul(r.bibleVersion), r.orderKey, ...stamps(r), extraOf(r, bookKnown)],
  },
  manuscriptNode: {
    table: "manuscript_node", trash: true,
    columns: ["id", "book_id", "parent_id", "kind", "title", "synopsis", "status", "pov_entry_id", "setting_entry_id", "target_word_count", "plan", "order_key", ...COMMON],
    row: (r) => [r.id, r.bookId, nul(r.parentId), r.kind, r.title, nul(r.synopsis), nul(r.status), nul(r.povEntryId), nul(r.settingEntryId),
      nul(r.targetWordCount), nul(r.plan), r.orderKey, ...stamps(r), extraOf(r, nodeKnown)],
  },
  template: {
    table: "entry_template", trash: true, columns: ["id", "name", "entry_type", "built_in", "order_key", ...COMMON],
    row: (r) => [r.id, r.name, r.entryType, r.builtIn, r.orderKey, ...stamps(r), extraOf(r, ["id", "name", "entryType", "builtIn", "orderKey", ...S])],
  },
  field: {
    table: "entry_field", trash: true,
    columns: ["id", "template_id", "key", "label", "field_type", "required", "multiple", "options_json", "target_entry_types_json", "order_key", ...COMMON],
    row: (r) => [r.id, r.templateId, r.key, r.label, r.fieldType, r.required, nul(r.multiple), js(r.options), js(r.targetEntryTypes), r.orderKey,
      ...stamps(r), extraOf(r, ["id", "templateId", "key", "label", "fieldType", "required", "multiple", "options", "targetEntryTypes", "orderKey", ...S])],
  },
  entry: {
    table: "bible_entry", trash: true,
    columns: ["id", "entry_type", "template_id", "name", "given_name", "family_name", "to_be_named", "aliases_json", "summary",
      "universe_id", "series_id", "book_id", ...COMMON],
    row: (r) => [r.id, r.entryType, nul(r.templateId), r.name, nul(r.givenName), nul(r.familyName), nul(r.toBeNamed), js(r.aliases), nul(r.summary),
      ...scopeCols(r.scope), ...stamps(r), extraOf(r, entryKnown)],
  },
  reference: {
    table: "manuscript_reference", trash: true, columns: ["id", "node_id", "anchor_id", "entry_id", ...COMMON],
    row: (r) => [r.id, r.nodeId, r.anchorId, r.entryId, ...stamps(r), extraOf(r, ["id", "nodeId", "anchorId", "entryId", ...S])],
  },
  note: {
    table: "note", trash: true, columns: ["id", "book_id", "node_id", "text", "order_key", ...COMMON],
    row: (r) => [r.id, r.bookId, nul(r.nodeId), r.text, r.orderKey, ...stamps(r), extraOf(r, ["id", "bookId", "nodeId", "text", "orderKey", ...S])],
  },
  relationshipType: {
    table: "relationship_type", trash: true, columns: ["id", "label", "inverse_label", "order_key", ...COMMON],
    row: (r) => [r.id, r.label, r.inverseLabel, r.orderKey, ...stamps(r), extraOf(r, ["id", "label", "inverseLabel", "orderKey", ...S])],
  },
  relationship: {
    table: "relationship", trash: true, columns: ["id", "type_id", "from_entry_id", "to_entry_id", "book_id", "note", ...COMMON],
    row: (r) => [r.id, r.typeId, r.fromEntryId, r.toEntryId, nul(r.bookId), nul(r.note), ...stamps(r),
      extraOf(r, ["id", "typeId", "fromEntryId", "toEntryId", "bookId", "note", ...S])],
  },
  fact: {
    table: "fact", trash: true,
    columns: ["id", "universe_id", "series_id", "book_id", "text", "truth", "node_id", "knowledge_json", "overrides_json", "dismissed_warnings_json", "order_key", ...COMMON],
    row: (r) => [r.id, ...scopeCols(r.scope), r.text, r.truth, nul(r.nodeId), js(r.knowledge), js(r.overrides), js(r.dismissedWarnings), r.orderKey,
      ...stamps(r), extraOf(r, factKnown)],
  },
  question: {
    table: "question", trash: true,
    columns: ["id", "universe_id", "series_id", "book_id", "text", "topic", "status", "decision", "node_id", "overrides_json", "dismissed_warnings_json", "order_key", ...COMMON],
    row: (r) => [r.id, ...scopeCols(r.scope), r.text, nul(r.topic), r.status, nul(r.decision), nul(r.nodeId), js(r.overrides), js(r.dismissedWarnings),
      r.orderKey, ...stamps(r), extraOf(r, questionKnown)],
  },
  event: {
    table: "continuity_event", trash: true,
    columns: ["id", "universe_id", "series_id", "book_id", "title", "summary", "when_json", "entry_id", "overrides_json", "dismissed_warnings_json", "order_key", ...COMMON],
    row: (r) => [r.id, ...scopeCols(r.scope), r.title, nul(r.summary), js(r.when), nul(r.entryId), js(r.overrides), js(r.dismissedWarnings), r.orderKey,
      ...stamps(r), extraOf(r, eventKnown)],
  },
  stateChange: {
    table: "state_change", trash: true,
    columns: ["id", "event_id", "node_id", "entry_id", "field_id", "value_json", "note", ...COMMON],
    row: (r) => [r.id, nul(r.eventId), nul(r.nodeId), r.entryId, r.fieldId, JSON.stringify(r.value), nul(r.note), ...stamps(r),
      extraOf(r, ["id", "eventId", "nodeId", "entryId", "fieldId", "value", "note", ...S])],
  },
};

export const recordTable = (kind: RecordKind): string => DESCS[kind].table;
/** True when records of the kind can be in the trash (the library cannot). */
export const canTrash = (kind: RecordKind): boolean => DESCS[kind].trash;

// ---- write ----

const rank: Record<string, number> = { part: 0, frontMatter: 0, backMatter: 0, chapter: 1, scene: 2 };

/** Insert records of one kind (and their child rows). Manuscript nodes go parents first. */
export async function insertRecords(db: Db, kind: RecordKind, recs: Rec[]): Promise<void> {
  const d = DESCS[kind];
  const ordered = kind === "manuscriptNode" ? [...recs].sort((a, b) => rank[a.kind]! - rank[b.kind]!) : recs;
  await insertMany(db, d.table, d.columns, ordered.map((r) => d.row(r)));
  await insertChildren(db, kind, ordered);
}

async function insertChildren(db: Db, kind: RecordKind, recs: Rec[]): Promise<void> {
  switch (kind) {
    case "entry": {
      const values: unknown[][] = [], overrides: unknown[][] = [], overrideValues: unknown[][] = [], attachments: unknown[][] = [];
      for (const e of recs) {
        for (const [fieldId, v] of Object.entries(e.values as Rec)) values.push([e.id, fieldId, JSON.stringify(v)]);
        (e.overrides as Rec[]).forEach((o, i) => {
          overrides.push([e.id, o.bookId, i]);
          for (const [fieldId, v] of Object.entries(o.values as Rec)) overrideValues.push([e.id, o.bookId, fieldId, JSON.stringify(v)]);
        });
        (e.attachments as string[]).forEach((sha, i) => attachments.push([e.id, sha, i]));
      }
      await insertMany(db, "entry_value", ["entry_id", "field_id", "value_json"], values);
      await insertMany(db, "entry_override", ["entry_id", "book_id", "position"], overrides);
      await insertMany(db, "entry_override_value", ["entry_id", "book_id", "field_id", "value_json"], overrideValues);
      await insertMany(db, "entry_attachment", ["entry_id", "sha256", "position"], attachments);
      return;
    }
    case "fact":
      return insertMany(db, "fact_entry", ["fact_id", "entry_id", "position"], recs.flatMap((f) => (f.entryIds as string[]).map((id, i) => [f.id, id, i])));
    case "question":
      return insertMany(db, "question_entry", ["question_id", "entry_id", "position"], recs.flatMap((q) => (q.entryIds as string[]).map((id, i) => [q.id, id, i])));
    case "event":
      await insertMany(db, "event_scene", ["event_id", "node_id", "position"], recs.flatMap((e) => (e.sceneIds as string[]).map((id, i) => [e.id, id, i])));
      return insertMany(db, "event_participant", ["event_id", "entry_id", "role", "position"],
        recs.flatMap((e) => (e.participants as Rec[]).map((p, i) => [e.id, p.entryId, nul(p.role), i])));
    default:
  }
}

const CHILD_PROPS: Partial<Record<RecordKind, string[]>> = {
  entry: ["values", "overrides", "attachments"], fact: ["entryIds"], question: ["entryIds"], event: ["sceneIds", "participants"],
};

async function deleteChildren(db: Db, kind: RecordKind, id: string): Promise<void> {
  const del = (table: string, col: string) => db.query(`DELETE FROM ${table} WHERE ${col} = $1`, [id]);
  switch (kind) {
    case "entry":
      await del("entry_override_value", "entry_id"); await del("entry_override", "entry_id");
      await del("entry_value", "entry_id"); await del("entry_attachment", "entry_id");
      return;
    case "fact": await del("fact_entry", "fact_id"); return;
    case "question": await del("question_entry", "question_id"); return;
    case "event": await del("event_scene", "event_id"); await del("event_participant", "event_id"); return;
    default:
  }
}

/**
 * Change a record to `next` (the same record as `old`, read from the table): only the columns whose value differs are
 * written, and child rows are rewritten only when a child property differs.
 */
export async function updateRecord(db: Db, kind: RecordKind, old: Rec, next: Rec): Promise<void> {
  const d = DESCS[kind];
  const was = d.row(old), now = d.row(next);
  const changed: number[] = [];
  for (let i = 1; i < d.columns.length; i++) if (!sameColumn(was[i], now[i])) changed.push(i);
  const childProps = CHILD_PROPS[kind] ?? [];
  const childrenChanged = childProps.some((p) => JSON.stringify(old[p]) !== JSON.stringify(next[p]));
  if (childrenChanged) await deleteChildren(db, kind, next.id);
  if (changed.length > 0) {
    const sets = changed.map((i, n) => `${d.columns[i]} = $${n + 2}`).join(", ");
    await db.query(`UPDATE ${d.table} SET ${sets} WHERE id = $1`, [next.id, ...changed.map((i) => now[i])]);
  }
  if (childrenChanged) await insertChildren(db, kind, [next]);
}

/** Columns compare as JSON; a needless write of an equal value is harmless, a missed difference is not. */
const sameColumn = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Put a record in the trash (deleted_at set) or take it out, stamping updated_at. The kind must be trashable. */
export async function setTrash(db: Db, kind: RecordKind, id: string, deletedAt: Date | null, updatedAt: Date): Promise<void> {
  await db.query(`UPDATE ${DESCS[kind].table} SET deleted_at = $2, updated_at = $3 WHERE id = $1`, [id, deletedAt, updatedAt]);
}

// ---- read ----

/** Timestamps leave as RFC 3339 UTC with the shortest fraction that holds the stored microseconds. */
export const T = (col: string): string =>
  `regexp_replace(to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '\\.?0+Z$', 'Z')`;
const stampSql = `${T("created_at")} AS created_at, ${T("updated_at")} AS updated_at, ${T("deleted_at")} AS deleted_at`;

export function build(extra: unknown, known: Record<string, unknown>): Rec {
  const out: Rec = {};
  if (extra && typeof extra === "object") for (const [k, v] of Object.entries(extra as Rec)) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  for (const [k, v] of Object.entries(known)) if (v !== null && v !== undefined) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}
const stampsOut = (r: Row) => ({ createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at });
const scopeOut = (r: Row) =>
  r.universe_id ? { kind: "universe", id: r.universe_id } : r.series_id ? { kind: "series", id: r.series_id } : { kind: "book", id: r.book_id };
const group = <R extends Row>(rows: R[], key: string): Map<string, R[]> => {
  const m = new Map<string, R[]>();
  for (const r of rows) { const k = r[key] as string; const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
  return m;
};

/**
 * The records of one kind in the archive's form, ordered by id: all of them, or those whose id is in `ids`. Reads with
 * the caller's transaction, so inside a repeatable-read transaction it is one consistent snapshot.
 */
export async function readRecords(db: Db, kind: RecordKind, ids?: readonly string[]): Promise<Rec[]> {
  if (ids && ids.length === 0) return [];
  const p: unknown[] = ids ? [ids] : [];
  const where = (col: string): string => (ids ? `WHERE ${col} = ANY($1::uuid[])` : "");
  const q = async (sql: string): Promise<Row[]> => (await db.query(sql, p)).rows;
  const star = (table: string): Promise<Row[]> => q(`SELECT *, ${stampSql} FROM ${table} ${where("id")} ORDER BY id`);
  switch (kind) {
    case "library":
      return (await q(`SELECT id, title, ${T("created_at")} AS created_at, ${T("updated_at")} AS updated_at, extra_json FROM library ${where("id")}`))
        .map((r) => build(r.extra_json, { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
    case "universe":
      return (await q(`SELECT id, title, summary, order_key, ${stampSql}, extra_json FROM universe ${where("id")} ORDER BY id`))
        .map((r) => build(r.extra_json, { id: r.id, title: r.title, summary: r.summary, orderKey: r.order_key, ...stampsOut(r) }));
    case "series":
      return (await q(`SELECT id, universe_id, title, summary, order_key, ${stampSql}, extra_json FROM series ${where("id")} ORDER BY id`))
        .map((r) => build(r.extra_json, { id: r.id, universeId: r.universe_id, title: r.title, summary: r.summary, orderKey: r.order_key, ...stampsOut(r) }));
    case "book":
      return (await star("book")).map((r) => build(r.extra_json, {
        id: r.id, universeId: r.universe_id, seriesId: r.series_id, title: r.title, subtitle: r.subtitle, authorName: r.author_name, description: r.description,
        language: r.language, coverAttachment: r.cover_attachment, targetWordCount: r.target_word_count, targetDate: r.target_date, logline: r.logline,
        premise: r.premise, themes: r.themes, arcs: r.arcs, principles: r.principles, bibleVersion: r.bible_version, orderKey: r.order_key, ...stampsOut(r) }));
    case "manuscriptNode":
      return (await star("manuscript_node")).map((r) => build(r.extra_json, {
        id: r.id, bookId: r.book_id, parentId: r.parent_id, kind: r.kind, title: r.title, synopsis: r.synopsis, status: r.status, povEntryId: r.pov_entry_id,
        settingEntryId: r.setting_entry_id, targetWordCount: r.target_word_count, plan: r.plan, orderKey: r.order_key, ...stampsOut(r) }));
    case "template":
      return (await star("entry_template")).map((r) => build(r.extra_json, { id: r.id, name: r.name, entryType: r.entry_type, builtIn: r.built_in, orderKey: r.order_key, ...stampsOut(r) }));
    case "field":
      return (await star("entry_field")).map((r) => build(r.extra_json, {
        id: r.id, templateId: r.template_id, key: r.key, label: r.label, fieldType: r.field_type, required: r.required, multiple: r.multiple,
        options: r.options_json, targetEntryTypes: r.target_entry_types_json, orderKey: r.order_key, ...stampsOut(r) }));
    case "entry": {
      const rows = await star("bible_entry");
      const ofEntry = ids ? "WHERE entry_id = ANY($1::uuid[])" : "";
      const values = group(await q(`SELECT entry_id, field_id, value_json FROM entry_value ${ofEntry} ORDER BY entry_id, field_id`), "entry_id");
      const overrideRows = group(await q(`SELECT entry_id, book_id, position FROM entry_override ${ofEntry} ORDER BY entry_id, position`), "entry_id");
      const overrideValues = group(await q(`SELECT entry_id, book_id, field_id, value_json FROM entry_override_value ${ofEntry} ORDER BY entry_id, book_id, field_id`), "entry_id");
      const attachments = group(await q(`SELECT entry_id, sha256 FROM entry_attachment ${ofEntry} ORDER BY entry_id, position`), "entry_id");
      return rows.map((r) => {
        const vals: Rec = {};
        for (const v of values.get(r.id) ?? []) Object.defineProperty(vals, v.field_id, { value: v.value_json, enumerable: true, writable: true, configurable: true });
        const ovs = (overrideRows.get(r.id) ?? []).map((o) => {
          const ov: Rec = {};
          for (const v of (overrideValues.get(r.id) ?? []).filter((x) => x.book_id === o.book_id)) Object.defineProperty(ov, v.field_id, { value: v.value_json, enumerable: true, writable: true, configurable: true });
          return { bookId: o.book_id, values: ov };
        });
        return build(r.extra_json, {
          id: r.id, entryType: r.entry_type, templateId: r.template_id, name: r.name, givenName: r.given_name, familyName: r.family_name, toBeNamed: r.to_be_named,
          aliases: r.aliases_json, summary: r.summary, scope: scopeOut(r), values: vals, overrides: ovs,
          attachments: (attachments.get(r.id) ?? []).map((a) => a.sha256), ...stampsOut(r) });
      });
    }
    case "reference":
      return (await star("manuscript_reference")).map((r) => build(r.extra_json, { id: r.id, nodeId: r.node_id, anchorId: r.anchor_id, entryId: r.entry_id, ...stampsOut(r) }));
    case "note":
      return (await star("note")).map((r) => build(r.extra_json, { id: r.id, bookId: r.book_id, nodeId: r.node_id, text: r.text, orderKey: r.order_key, ...stampsOut(r) }));
    case "relationshipType":
      return (await star("relationship_type")).map((r) => build(r.extra_json, { id: r.id, label: r.label, inverseLabel: r.inverse_label, orderKey: r.order_key, ...stampsOut(r) }));
    case "relationship":
      return (await star("relationship")).map((r) => build(r.extra_json, {
        id: r.id, typeId: r.type_id, fromEntryId: r.from_entry_id, toEntryId: r.to_entry_id, bookId: r.book_id, note: r.note, ...stampsOut(r) }));
    case "fact": {
      const entries = group(await q(`SELECT fact_id, entry_id FROM fact_entry ${ids ? "WHERE fact_id = ANY($1::uuid[])" : ""} ORDER BY fact_id, position`), "fact_id");
      return (await star("fact")).map((r) => build(r.extra_json, {
        id: r.id, scope: scopeOut(r), text: r.text, truth: r.truth, nodeId: r.node_id, entryIds: (entries.get(r.id) ?? []).map((x) => x.entry_id),
        knowledge: r.knowledge_json, overrides: r.overrides_json, dismissedWarnings: r.dismissed_warnings_json, orderKey: r.order_key, ...stampsOut(r) }));
    }
    case "question": {
      const entries = group(await q(`SELECT question_id, entry_id FROM question_entry ${ids ? "WHERE question_id = ANY($1::uuid[])" : ""} ORDER BY question_id, position`), "question_id");
      return (await star("question")).map((r) => build(r.extra_json, {
        id: r.id, scope: scopeOut(r), text: r.text, topic: r.topic, status: r.status, decision: r.decision, entryIds: (entries.get(r.id) ?? []).map((x) => x.entry_id),
        nodeId: r.node_id, overrides: r.overrides_json, dismissedWarnings: r.dismissed_warnings_json, orderKey: r.order_key, ...stampsOut(r) }));
    }
    case "event": {
      const ofEvent = ids ? "WHERE event_id = ANY($1::uuid[])" : "";
      const scenes = group(await q(`SELECT event_id, node_id FROM event_scene ${ofEvent} ORDER BY event_id, position`), "event_id");
      const participants = group(await q(`SELECT event_id, entry_id, role FROM event_participant ${ofEvent} ORDER BY event_id, position`), "event_id");
      return (await star("continuity_event")).map((r) => build(r.extra_json, {
        id: r.id, scope: scopeOut(r), title: r.title, summary: r.summary, when: r.when_json, orderKey: r.order_key, entryId: r.entry_id,
        sceneIds: (scenes.get(r.id) ?? []).map((x) => x.node_id),
        participants: (participants.get(r.id) ?? []).map((p) => build(null, { entryId: p.entry_id, role: p.role })),
        overrides: r.overrides_json, dismissedWarnings: r.dismissed_warnings_json, ...stampsOut(r) }));
    }
    case "stateChange":
      return (await star("state_change")).map((r) => build(r.extra_json, {
        id: r.id, eventId: r.event_id, nodeId: r.node_id, entryId: r.entry_id, fieldId: r.field_id, value: r.value_json, note: r.note, ...stampsOut(r) }));
  }
}

/** The kind each of `ids` lives as, for the ids that name a record. (Ids are never shared between kinds.) */
export async function kindsOf(db: Db, ids: readonly string[]): Promise<Map<string, RecordKind>> {
  const out = new Map<string, RecordKind>();
  if (ids.length === 0) return out;
  const kinds = Object.keys(DESCS) as RecordKind[];
  const sql = kinds.map((k) => `SELECT id, '${k}' AS kind FROM ${DESCS[k].table} WHERE id = ANY($1::uuid[])`).join(" UNION ALL ");
  for (const r of (await db.query(sql, [ids])).rows) out.set(r.id, r.kind);
  return out;
}

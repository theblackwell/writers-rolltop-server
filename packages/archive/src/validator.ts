// Integrity rules of archive-format-v1.md that the JSON Schema cannot express: hierarchy, scope,
// override and field-typing rules, reference resolution, and the four W_* warnings. A port of the
// reference validator's rules (Apple RolltopKit SnapshotValidator); it reports every problem found.
//
// Documents are validated and normalized by the reader (and the writer) before they reach here.
// The continuity warnings keyed by dismissal key are computed in continuity.ts; of them only W_STATE_CONFLICT is an archive warning.

import { IssueList } from "./errors.ts";
import type { Issue } from "./errors.ts";
import { checkRecordShape } from "./schema.ts";
import type { RecordKind } from "./schema.ts";
import { continuityWarnings } from "./continuity.ts";
import type { ArchiveData, Rec } from "./model.ts";
import { printable } from "./paths.ts";

export interface ValidationReport {
  /** At most MAX_ISSUES; see `errorsTruncated`. */
  errors: Issue[];
  warnings: Issue[];
  /** True when more errors exist than `errors` lists. */
  errorsTruncated: boolean;
  warningsTruncated: boolean;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HAS_DOCUMENT = new Set(["scene", "frontMatter", "backMatter"]);
const cp = (s: string): number => { let n = 0; for (const _ of s) n++; return n; };
const index = (records: Rec[]): Map<string, Rec> => {
  const m = new Map<string, Rec>();
  for (const r of records) if (typeof r.id === "string" && !m.has(r.id)) m.set(r.id, r);
  return m;
};
const cmpCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isValidRealDate(text: string): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= days;
}
const isExactDecimal = (s: string): boolean => /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s);
const isObject = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isSafeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

interface Src { id: string; live: boolean; label: string }

export function validateArchiveData(data: ArchiveData): ValidationReport {
  return new Run(data).run();
}

/**
 * The records a record can point at, as archive records. Only what the rules read is needed (see
 * validateRecord); a list may be absent or partial.
 */
export interface RecordContext {
  universes?: Rec[]; series?: Rec[]; books?: Rec[]; manuscriptNodes?: Rec[]; templates?: Rec[]; fields?: Rec[]; entries?: Rec[];
  relationshipTypes?: Rec[]; relationships?: Rec[]; facts?: Rec[]; questions?: Rec[]; events?: Rec[]; stateChanges?: Rec[];
  references?: Rec[]; notes?: Rec[];
  /** The hashes of the attachments that exist. */
  attachmentHashes?: string[];
}

/**
 * Validate one record against everything the archive says about a record of its kind: the archive schema, then the
 * integrity rules (scope, hierarchy, references, field typing, uniqueness among `context`). It is the whole-archive
 * validator run on `context` plus the record, reporting only the problems of the record itself, so the rules are
 * the same ones and cannot drift. Returns no issues when the record is valid.
 *
 * What it does not check: that a scene, front matter or back matter node has its document (a node is created before
 * its text arrives, so the rule belongs to the archive as a whole); the advisory warnings; and the records in
 * `context`, which are not re-validated. The caller supplies the records the rules read: for a node its book, parent
 * and point-of-view and setting entries; for an entry its template, the fields its values name, its override books
 * and the entries it points at; and so on for the other kinds. A record the context lacks is reported as unresolved.
 */
export function validateRecord(kind: RecordKind, record: Rec, context: RecordContext = {}): Issue[] {
  const shape = checkRecordShape(kind, record);
  if (shape.items.length > 0) return shape.items;
  if (kind === "library") return [];
  const id = record.id as string;
  const rest = (list: Rec[] | undefined): Rec[] => (list ?? []).filter((r) => r.id !== id);
  const lists = {
    universes: rest(context.universes), series: rest(context.series), books: rest(context.books),
    manuscriptNodes: rest(context.manuscriptNodes), templates: rest(context.templates), fields: rest(context.fields),
    entries: rest(context.entries), relationshipTypes: rest(context.relationshipTypes), relationships: rest(context.relationships),
    facts: rest(context.facts), questions: rest(context.questions), events: rest(context.events),
    stateChanges: rest(context.stateChanges), references: rest(context.references), notes: rest(context.notes),
  };
  const slot: Record<string, keyof typeof lists> = {
    universe: "universes", series: "series", book: "books", manuscriptNode: "manuscriptNodes", template: "templates", field: "fields",
    entry: "entries", relationshipType: "relationshipTypes", relationship: "relationships", fact: "facts", question: "questions",
    event: "events", stateChange: "stateChanges", reference: "references", note: "notes",
  };
  lists[slot[kind]!].push(record);
  const data: ArchiveData = {
    manifestExtra: {},
    library: { library: {}, universes: lists.universes, series: lists.series, books: lists.books, manuscriptNodes: lists.manuscriptNodes },
    references: lists.references, notes: lists.notes,
    attachments: (context.attachmentHashes ?? []).map((sha256) => ({ sha256 })),
    entries: lists.entries, templates: lists.templates, fields: lists.fields,
    relationships: { relationshipTypes: lists.relationshipTypes, relationships: lists.relationships },
    facts: lists.facts, questions: lists.questions, events: lists.events, stateChanges: lists.stateChanges,
    documents: new Map(),
  };
  return new Run(data, { only: id }).run().errors;
}

/** Untrusted text in a message: sanitised and short (ids, keys, names from the archive). */
const sh = printable;

class Run {
  private errors = new IssueList();
  private warnings = new IssueList();
  private universes: Map<string, Rec>;
  private series: Map<string, Rec>;
  private books: Map<string, Rec>;
  private nodes: Map<string, Rec>;
  private templates: Map<string, Rec>;
  private fields: Map<string, Rec>;
  private entries: Map<string, Rec>;
  private relationshipTypes: Map<string, Rec>;
  private events: Map<string, Rec>;
  private attachmentHashes: Set<string>;
  // Indexes built once, so no rule rescans a list per record (the cost stays linear in the input).
  /** eventId -> (bookId -> first override of that book), for events that have overrides. */
  private eventOverrides = new Map<string, Map<string, Rec>>();
  /** nodeId -> anchor ids used in its document; filled on first use. */
  private anchors = new Map<string, Set<string>>();
  /** field -> ids of its options (selection fields). */
  private optionIds = new Map<Rec, Set<string>>();
  /** field -> accepted entry types, absent when the field accepts any. */
  private targetTypes = new Map<Rec, Set<string>>();

  private readonly d: ArchiveData;
  /** Set by validateRecord: only the problems of this record are collected, and the document-presence rule is skipped. */
  private readonly only: string | undefined;

  constructor(d: ArchiveData, options: { only?: string } = {}) {
    this.d = d;
    this.only = options.only;
    this.universes = index(d.library.universes ?? []);
    this.series = index(d.library.series ?? []);
    this.books = index(d.library.books ?? []);
    this.nodes = index(d.library.manuscriptNodes ?? []);
    this.templates = index(d.templates);
    this.fields = index(d.fields);
    this.entries = index(d.entries);
    this.relationshipTypes = index(d.relationships.relationshipTypes ?? []);
    this.events = index(d.events);
    this.attachmentHashes = new Set(d.attachments.map((a) => a.sha256));
    for (const e of d.events) {
      if (!Array.isArray(e.overrides) || e.overrides.length === 0 || this.eventOverrides.has(e.id)) continue;
      const byBook = new Map<string, Rec>();
      for (const o of e.overrides) if (!byBook.has(o.bookId)) byBook.set(o.bookId, o);
      this.eventOverrides.set(e.id, byBook);
    }
    for (const f of d.fields) {
      // The schema bounds neither the length nor the uniqueness of options or targetEntryTypes, so membership uses a Set.
      if (Array.isArray(f.options)) this.optionIds.set(f, new Set(f.options.map((o: Rec) => o.id)));
      if (Array.isArray(f.targetEntryTypes) && f.targetEntryTypes.length > 0) this.targetTypes.set(f, new Set(f.targetEntryTypes));
    }
  }

  run(): ValidationReport {
    this.checkUniqueIds();
    this.checkLibrary();
    this.checkNodes();
    this.checkDocuments();
    this.checkTemplatesAndFields();
    this.checkEntries();
    this.checkRelationships();
    this.checkFacts();
    this.checkQuestions();
    this.checkEvents();
    this.checkStateChanges();
    this.checkReferences();
    this.checkNotes();
    this.checkAttachments();
    // The advisory passes only matter for an archive that is otherwise acceptable; a failing archive is refused anyway.
    if (this.errors.items.length === 0 && this.only === undefined) {
      this.checkAnchorWarnings();
      this.checkStateConflicts();
      this.checkChronology();
    }
    return { errors: this.errors.items, warnings: this.warnings.items, errorsTruncated: this.errors.truncated, warningsTruncated: this.warnings.truncated };
  }

  // ---- reporting ----
  private err(code: string, message: string, recordId?: string): void {
    if (this.only !== undefined && recordId !== this.only) return;
    this.errors.add(recordId === undefined ? { code, message } : { code, message, recordId });
  }
  private warn(code: string, message: string, recordId?: string, bookId?: string): void {
    if (this.only !== undefined) return;
    const w: Issue = { code, message };
    if (recordId !== undefined) w.recordId = recordId;
    if (bookId !== undefined) w.bookId = bookId;
    this.warnings.add(w);
  }
  private live = (r: Rec): boolean => r.deletedAt === undefined;

  /** An unknown id is REFERENCE_UNRESOLVED; a live record pointing at a tombstoned one is W_REFERENCE_TO_DELETED. */
  private resolve(id: string, table: Map<string, Rec>, src: Src, what: string): Rec | undefined {
    const r = table.get(id);
    if (!r) {
      this.err("REFERENCE_UNRESOLVED", `${src.label} ${sh(src.id)}: ${what} ${sh(id)} does not exist`, src.id);
      return undefined;
    }
    if (src.live && r.deletedAt !== undefined) this.warn("W_REFERENCE_TO_DELETED", `${src.label} ${sh(src.id)}: ${what} ${sh(id)} is in the trash`, src.id);
    return r;
  }
  private srcOf(r: Rec, label: string): Src { return { id: r.id, live: this.live(r), label }; }

  // ---- scope helpers ----
  private bookInScope(book: Rec, scope: Rec): boolean {
    switch (scope.kind) {
      case "universe": return book.universeId === scope.id;
      case "series": return book.seriesId === scope.id;
      default: return book.id === scope.id;
    }
  }
  private checkScope(scope: Rec, src: Src): void {
    const table = scope.kind === "universe" ? this.universes : scope.kind === "series" ? this.series : this.books;
    this.resolve(scope.id, table, src, `scope ${scope.kind}`);
  }
  private checkNodeInScope(nodeId: string, scope: Rec, src: Src, what: string, allowed: string[] = ["chapter", "scene"]): void {
    const node = this.resolve(nodeId, this.nodes, src, what);
    if (!node) return;
    if (!allowed.includes(node.kind)) {
      this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: ${what} must be a ${sh([...allowed].sort().join(" or "))}, not a ${sh(node.kind)}`, src.id);
    }
    const book = this.books.get(node.bookId);
    if (book && !this.bookInScope(book, scope)) {
      this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: ${what} is in a book outside the record's scope`, src.id);
    }
  }
  private textLength(text: unknown, min: number, max: number, src: Src, what: string): void {
    if (typeof text !== "string") return;
    const n = cp(text);
    if (n < min || n > max) this.err("SCHEMA_VIOLATION", `${src.label} ${sh(src.id)}: ${what} must be ${min} to ${max} characters`, src.id);
  }

  // ---- rules ----
  private checkUniqueIds(): void {
    const seen = new Set<string>();
    const d = this.d, lib = d.library;
    const ids: string[] = [lib.library?.id];
    const add = (rs: Rec[] | undefined) => { for (const r of rs ?? []) ids.push(r.id); };
    add(lib.universes); add(lib.series); add(lib.books); add(lib.manuscriptNodes);
    add(d.templates); add(d.fields); add(d.entries);
    add(d.relationships.relationshipTypes); add(d.relationships.relationships);
    add(d.facts); add(d.questions); add(d.events); add(d.stateChanges); add(d.references); add(d.notes);
    for (const id of ids) {
      if (seen.has(id)) this.err("INTEGRITY_VIOLATION", `Duplicate id ${sh(id)}`, id);
      seen.add(id);
    }
  }

  private checkLibrary(): void {
    const lib = this.d.library;
    for (const sr of lib.series ?? []) {
      const src = this.srcOf(sr, "Series");
      if (sr.universeId !== undefined) this.resolve(sr.universeId, this.universes, src, "universeId");
    }
    for (const b of lib.books ?? []) {
      const src = this.srcOf(b, "Book");
      if (b.universeId !== undefined) this.resolve(b.universeId, this.universes, src, "universeId");
      if (b.seriesId !== undefined) {
        const sr = this.resolve(b.seriesId, this.series, src, "seriesId");
        if (sr && sr.universeId !== undefined) {
          if (b.universeId === undefined) this.err("INTEGRITY_VIOLATION", `Book ${sh(b.id)}: its series has a universe, so the book's universeId is required`, b.id);
          else if (b.universeId !== sr.universeId) this.err("INTEGRITY_VIOLATION", `Book ${sh(b.id)}: universeId differs from its series' universeId`, b.id);
        }
      }
      if (b.targetDate !== undefined && !isValidRealDate(b.targetDate)) this.err("SCHEMA_VIOLATION", `Book ${sh(b.id)}: targetDate must be a valid YYYY-MM-DD date`, b.id);
      if (b.coverAttachment !== undefined && !this.attachmentHashes.has(b.coverAttachment)) {
        this.err("REFERENCE_UNRESOLVED", `Book ${sh(b.id)}: coverAttachment ${sh(b.coverAttachment)} is not in attachments`, b.id);
      }
    }
  }

  private checkNodes(): void {
    for (const n of this.d.library.manuscriptNodes ?? []) {
      const src = this.srcOf(n, "Node");
      const book = this.resolve(n.bookId, this.books, src, "bookId");
      let parent: Rec | undefined;
      if (n.parentId !== undefined) {
        parent = this.resolve(n.parentId, this.nodes, src, "parentId");
        if (parent && parent.bookId !== n.bookId) this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: parent is in a different book`, n.id);
      }
      switch (n.kind) {
        case "part": case "frontMatter": case "backMatter":
          if (n.parentId !== undefined) this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: a ${sh(n.kind)} has no parent`, n.id);
          break;
        case "chapter":
          if (n.parentId !== undefined && parent && parent.kind !== "part") this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: a chapter's parent must be a part`, n.id);
          break;
        case "scene":
          if (n.parentId === undefined) this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: a scene must be under a chapter`, n.id);
          else if (parent && parent.kind !== "chapter") this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: a scene's parent must be a chapter`, n.id);
          break;
      }
      for (const [key, type] of [["povEntryId", "character"], ["settingEntryId", "location"]] as const) {
        const id = n[key];
        if (id === undefined) continue;
        if (n.kind !== "chapter" && n.kind !== "scene") this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: ${sh(key)} is only allowed on a chapter or scene`, n.id);
        const entry = this.resolve(id, this.entries, src, key);
        if (!entry) continue;
        if (entry.entryType !== type) this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: ${sh(key)} must be a ${sh(type)} entry`, n.id);
        if (book && !this.bookInScope(book, entry.scope)) this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: ${sh(key)} entry is not visible from the node's book`, n.id);
      }
    }
  }

  /** Every scene, frontMatter and backMatter node has exactly one document naming it; other kinds have none. */
  private checkDocuments(): void {
    for (const n of this.only !== undefined ? [] : this.d.library.manuscriptNodes ?? []) {
      if (HAS_DOCUMENT.has(n.kind) && !this.d.documents.has(n.id)) this.err("INTEGRITY_VIOLATION", `Node ${sh(n.id)}: a ${sh(n.kind)} needs a document`, n.id);
    }
    for (const [key, doc] of [...this.d.documents].sort((a, b) => cmpCodeUnits(a[0], b[0]))) {
      const node = this.nodes.get(key);
      if (!node) { this.err("INTEGRITY_VIOLATION", `Document ${sh(key)} belongs to no manuscript node`, key); continue; }
      if (!HAS_DOCUMENT.has(node.kind)) this.err("INTEGRITY_VIOLATION", `Node ${sh(key)}: a ${sh(node.kind)} has no document`, key);
      if (doc.nodeId !== key) this.err("INTEGRITY_VIOLATION", `Document under key ${sh(key)} names node ${sh(doc.nodeId)}`, key);
    }
  }

  private checkTemplatesAndFields(): void {
    const keys = new Set<string>();
    for (const f of this.d.fields) {
      const src = this.srcOf(f, "Field");
      this.resolve(f.templateId, this.templates, src, "templateId");
      if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(f.key)) this.err("SCHEMA_VIOLATION", `Field ${sh(f.id)}: key ${sh(f.key)} does not match ^[a-z][a-zA-Z0-9_]{0,63}$`, f.id);
      const k = `${f.templateId}\0${f.key}`;
      if (keys.has(k)) this.err("INTEGRITY_VIOLATION", `Field ${sh(f.id)}: key ${sh(f.key)} is used twice in its template`, f.id);
      keys.add(k);
      if (f.fieldType === "selection") {
        if (f.options === undefined) this.err("SCHEMA_VIOLATION", `Field ${sh(f.id)}: a selection field needs options`, f.id);
      } else if (f.options !== undefined) this.err("SCHEMA_VIOLATION", `Field ${sh(f.id)}: options are only allowed on a selection field`, f.id);
      if (Array.isArray(f.options)) {
        const ids = new Set<string>();
        for (const o of f.options) {
          if (ids.has(o.id)) this.err("INTEGRITY_VIOLATION", `Field ${sh(f.id)}: option id ${sh(o.id)} is repeated`, f.id);
          ids.add(o.id);
        }
      }
    }
  }

  private checkEntries(): void {
    for (const e of this.d.entries) {
      const src = this.srcOf(e, "Entry");
      this.checkScope(e.scope, src);
      let template: Rec | undefined;
      if (e.templateId !== undefined) {
        template = this.resolve(e.templateId, this.templates, src, "templateId");
        if (template && template.entryType !== e.entryType) this.err("INTEGRITY_VIOLATION", `Entry ${sh(e.id)}: template is for ${sh(template.entryType)}, the entry is ${sh(e.entryType)}`, e.id);
      }
      if ((e.givenName !== undefined || e.familyName !== undefined) && e.entryType !== "character") {
        this.err("INTEGRITY_VIOLATION", `Entry ${sh(e.id)}: givenName and familyName are only allowed on a character`, e.id);
      }
      const shas = new Set<string>();
      for (const sha of e.attachments) {
        if (shas.has(sha)) this.err("INTEGRITY_VIOLATION", `Entry ${sh(e.id)}: attachment ${sh(sha)} is listed twice`, e.id);
        shas.add(sha);
        if (!this.attachmentHashes.has(sha)) this.err("REFERENCE_UNRESOLVED", `Entry ${sh(e.id)}: attachment ${sh(sha)} is not in attachments`, e.id);
      }
      const templateKnown = e.templateId === undefined || template !== undefined;
      if (templateKnown) this.checkEntryValues(e.values, template, src, "values");
      if (e.scope.kind === "book" && e.overrides.length > 0) this.err("INTEGRITY_VIOLATION", `Entry ${sh(e.id)}: a book-scoped entry cannot have overrides`, e.id);
      const seen = new Set<string>();
      for (const o of e.overrides) {
        if (seen.has(o.bookId)) this.err("INTEGRITY_VIOLATION", `Entry ${sh(e.id)}: more than one override for book ${sh(o.bookId)}`, e.id);
        seen.add(o.bookId);
        const book = this.books.get(o.bookId);
        if (!book) { this.err("REFERENCE_UNRESOLVED", `Entry ${sh(e.id)}: override book ${sh(o.bookId)} does not exist`, e.id); continue; }
        if (e.scope.kind !== "book" && !this.bookInScope(book, e.scope)) this.err("INTEGRITY_VIOLATION", `Entry ${sh(e.id)}: override book ${sh(o.bookId)} is outside the entry's scope`, e.id);
        if (templateKnown) this.checkEntryValues(o.values, template, src, "override values");
      }
    }
  }

  /** Every key must be a field of the entry's template (no template means no values), and typed. */
  private checkEntryValues(values: Rec, template: Rec | undefined, src: Src, what: string): void {
    for (const fieldId of Object.keys(values).sort(cmpCodeUnits)) {
      const field = this.fields.get(fieldId);
      if (!template || !field || field.templateId !== template.id) {
        this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: ${what} key ${sh(fieldId)} is not a field of the entry's template`, src.id);
        continue;
      }
      this.checkValue(values[fieldId], field, src, what);
    }
  }

  private checkValue(value: unknown, field: Rec, src: Src, what: string): void {
    const bad = (detail: string): void => this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: ${what} for field ${sh(field.key)} ${detail}`, src.id);
    switch (field.fieldType) {
      case "shortText": case "longText":
        if (typeof value !== "string") bad("must be a string");
        return;
      case "integer":
        if (!isSafeInt(value)) bad("must be an integer within +-(2^53-1)");
        return;
      case "decimal":
        if (typeof value !== "string" || !isExactDecimal(value)) bad('must be a decimal string such as "-12.50"');
        return;
      case "boolean":
        if (typeof value !== "boolean") bad("must be a boolean");
        return;
      case "selection": {
        if (!Array.isArray(value)) return bad("must be an array of option ids");
        const optionIds = this.optionIds.get(field);
        for (const item of value) if (typeof item !== "string" || !optionIds?.has(item)) return bad("names an option that does not exist");
        if (value.length > 1 && field.multiple !== true) bad("allows one selection (multiple is not set)");
        return;
      }
      case "realDate":
        if (typeof value !== "string" || !isValidRealDate(value)) bad("must be a valid YYYY-MM-DD date");
        return;
      case "fictionalDate":
        if (!this.isFictionalDate(value)) bad("must be a fictional date {label, calendar?, ordinal?}");
        return;
      case "entryReference":
        if (typeof value !== "string") return bad("must be an entry id");
        this.checkEntryTarget(value, field, src, what);
        return;
      case "entryReferences": {
        if (!Array.isArray(value)) return bad("must be an array of entry ids");
        const seen = new Set<string>();
        for (const item of value) {
          if (typeof item !== "string") return bad("must be an array of entry ids");
          if (seen.has(item)) bad(`lists entry ${sh(item)} twice`);
          seen.add(item);
          this.checkEntryTarget(item, field, src, what);
        }
        return;
      }
      case "attachment":
        if (typeof value !== "string") return bad("must be an attachment hash");
        if (!this.attachmentHashes.has(value)) this.err("REFERENCE_UNRESOLVED", `${src.label} ${sh(src.id)}: ${what} for field ${sh(field.key)} names attachment ${sh(value)}, which is not in attachments`, src.id);
        return;
      case "table": {
        const problem = tableProblem(value);
        if (problem) bad(`is not a valid table: ${problem}`);
        return;
      }
      default:
        bad(`has an unknown field type ${sh(String(field.fieldType))}`);
    }
  }
  private checkEntryTarget(id: string, field: Rec, src: Src, what: string): void {
    const target = this.resolve(id, this.entries, src, `${what} entry reference`);
    if (!target) return;
    const types = this.targetTypes.get(field);
    if (types && !types.has(target.entryType)) {
      this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: ${what} for field ${sh(field.key)} refers to a ${sh(target.entryType)}, which the field does not accept`, src.id);
    }
  }
  private isFictionalDate(v: unknown): boolean {
    if (!isObject(v)) return false;
    if (Object.keys(v).some((k) => k !== "label" && k !== "calendar" && k !== "ordinal")) return false;
    if (typeof v.label !== "string" || v.label === "") return false;
    if (v.calendar !== undefined && (typeof v.calendar !== "string" || v.calendar === "")) return false;
    if (v.ordinal !== undefined && !isSafeInt(v.ordinal)) return false;
    return true;
  }

  private checkRelationships(): void {
    for (const r of this.d.relationships.relationships ?? []) {
      const src = this.srcOf(r, "Relationship");
      this.resolve(r.typeId, this.relationshipTypes, src, "typeId");
      this.resolve(r.fromEntryId, this.entries, src, "fromEntryId");
      this.resolve(r.toEntryId, this.entries, src, "toEntryId");
      if (r.fromEntryId === r.toEntryId) this.err("INTEGRITY_VIOLATION", `Relationship ${sh(r.id)}: fromEntryId and toEntryId are the same`, r.id);
      if (r.bookId !== undefined) this.resolve(r.bookId, this.books, src, "bookId");
    }
  }

  private checkEntryIds(ids: string[], src: Src): void {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: entry ${sh(id)} is listed twice`, src.id);
      seen.add(id);
      this.resolve(id, this.entries, src, "entryIds");
    }
  }

  /** Dismissed-warning lists: unique keys (the shape rules are in the schema). */
  private checkDismissed(list: Rec[] | undefined, src: Src): void {
    if (!list) return;
    const seen = new Set<string>();
    for (const d of list) {
      if (seen.has(d.warning)) this.err("SCHEMA_VIOLATION", `${src.label} ${sh(src.id)}: dismissed warning key ${sh(d.warning)} is repeated`, src.id);
      seen.add(d.warning);
    }
  }

  /** Record overrides: one per book, the book exists, the record is not book-scoped, the book lies inside its scope. */
  private checkRecordOverrides(overrides: Rec[], scope: Rec, src: Src): void {
    if (scope.kind === "book" && overrides.length > 0) this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: a book-scoped record cannot have overrides`, src.id);
    const seen = new Set<string>();
    for (const o of overrides) {
      if (seen.has(o.bookId)) this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: more than one override for book ${sh(o.bookId)}`, src.id);
      seen.add(o.bookId);
      const book = this.books.get(o.bookId);
      if (!book) { this.err("REFERENCE_UNRESOLVED", `${src.label} ${sh(src.id)}: override book ${sh(o.bookId)} does not exist`, src.id); continue; }
      if (scope.kind !== "book" && !this.bookInScope(book, scope)) this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: override book ${sh(o.bookId)} is outside the record's scope`, src.id);
    }
  }

  private checkFacts(): void {
    for (const f of this.d.facts) {
      const src = this.srcOf(f, "Fact");
      this.checkScope(f.scope, src);
      if (f.nodeId !== undefined) this.checkNodeInScope(f.nodeId, f.scope, src, "nodeId");
      this.checkEntryIds(f.entryIds, src);
      const knowers = new Set<string>();
      for (const k of f.knowledge) {
        if (knowers.has(k.knower)) this.err("INTEGRITY_VIOLATION", `Fact ${sh(f.id)}: knower ${sh(k.knower)} is listed twice`, f.id);
        knowers.add(k.knower);
        if (k.knower !== "reader") {
          const entry = this.resolve(k.knower, this.entries, src, "knower");
          if (entry && entry.entryType !== "character") this.err("INTEGRITY_VIOLATION", `Fact ${sh(f.id)}: knower ${sh(k.knower)} is not a character`, f.id);
        }
        if (k.nodeId !== undefined) this.checkNodeInScope(k.nodeId, f.scope, src, "knowledge nodeId");
      }
      if (f.overrides) this.checkRecordOverrides(f.overrides, f.scope, src);
      this.checkDismissed(f.dismissedWarnings, src);
    }
  }

  private checkQuestions(): void {
    for (const q of this.d.questions) {
      const src = this.srcOf(q, "Question");
      this.checkScope(q.scope, src);
      this.textLength(q.decision, 0, 20000, src, "decision");
      if (q.nodeId !== undefined) this.checkNodeInScope(q.nodeId, q.scope, src, "nodeId");
      this.checkEntryIds(q.entryIds, src);
      if (q.overrides) {
        this.checkRecordOverrides(q.overrides, q.scope, src);
        for (const o of q.overrides) {
          this.textLength(o.text, 1, 20000, src, "override text");
          this.textLength(o.decision, 0, 20000, src, "override decision");
        }
      }
      this.checkDismissed(q.dismissedWarnings, src);
    }
  }

  private checkParticipants(list: Rec[], src: Src, what: string): void {
    const seen = new Set<string>();
    for (const p of list) {
      if (seen.has(p.entryId)) this.err("INTEGRITY_VIOLATION", `${src.label} ${sh(src.id)}: ${what} lists entry ${sh(p.entryId)} twice`, src.id);
      seen.add(p.entryId);
      this.resolve(p.entryId, this.entries, src, what);
    }
  }

  private checkEvents(): void {
    for (const e of this.d.events) {
      const src = this.srcOf(e, "Event");
      this.checkScope(e.scope, src);
      if (e.entryId !== undefined) {
        const entry = this.resolve(e.entryId, this.entries, src, "entryId");
        if (entry && entry.entryType !== "event") this.err("INTEGRITY_VIOLATION", `Event ${sh(e.id)}: entryId must be an entry of type event`, e.id);
      }
      const scenes = new Set<string>();
      for (const sceneId of e.sceneIds) {
        if (scenes.has(sceneId)) this.err("INTEGRITY_VIOLATION", `Event ${sh(e.id)}: scene ${sh(sceneId)} is listed twice`, e.id);
        scenes.add(sceneId);
        this.checkNodeInScope(sceneId, e.scope, src, "sceneIds", ["scene"]);
      }
      this.checkParticipants(e.participants, src, "participants");
      if (e.overrides) {
        this.checkRecordOverrides(e.overrides, e.scope, src);
        for (const o of e.overrides) if (o.participants) this.checkParticipants(o.participants, src, "override participants");
      }
      this.checkDismissed(e.dismissedWarnings, src);
    }
  }

  private checkStateChanges(): void {
    for (const c of this.d.stateChanges) {
      const src = this.srcOf(c, "StateChange");
      const entry = this.resolve(c.entryId, this.entries, src, "entryId");
      const field = this.resolve(c.fieldId, this.fields, src, "fieldId");
      if ((c.eventId === undefined) === (c.nodeId === undefined)) this.err("INTEGRITY_VIOLATION", `StateChange ${sh(c.id)}: exactly one of eventId and nodeId is required`, c.id);
      if (c.eventId !== undefined) this.resolve(c.eventId, this.events, src, "eventId");
      if (c.nodeId !== undefined) {
        if (entry) this.checkNodeInScope(c.nodeId, entry.scope, src, "nodeId");
        else this.resolve(c.nodeId, this.nodes, src, "nodeId");
      }
      if (!entry || !field) continue;
      if (entry.templateId === undefined || field.templateId !== entry.templateId) this.err("INTEGRITY_VIOLATION", `StateChange ${sh(c.id)}: field is not a field of the entry's template`, c.id);
      else this.checkValue(c.value, field, src, "value");
    }
  }

  private checkReferences(): void {
    const triples = new Set<string>();
    for (const r of this.d.references) {
      const src = this.srcOf(r, "Reference");
      const node = this.resolve(r.nodeId, this.nodes, src, "nodeId");
      this.resolve(r.entryId, this.entries, src, "entryId");
      const t = `${r.nodeId}\0${r.anchorId}\0${r.entryId}`;
      if (triples.has(t)) this.err("INTEGRITY_VIOLATION", `Reference ${sh(r.id)}: (nodeId, anchorId, entryId) is not unique`, r.id);
      triples.add(t);
      if (!node) continue;
      if (!HAS_DOCUMENT.has(node.kind)) { this.err("INTEGRITY_VIOLATION", `Reference ${sh(r.id)}: node ${sh(r.nodeId)} has no document`, r.id); continue; }
    }
  }

  /** W_REFERENCE_ANCHOR_MISSING: a live reference whose anchor is no longer in its document. */
  private checkAnchorWarnings(): void {
    for (const r of this.d.references) {
      if (r.deletedAt !== undefined) continue;
      const node = this.nodes.get(r.nodeId);
      if (!node || !HAS_DOCUMENT.has(node.kind)) continue;
      const doc = this.d.documents.get(r.nodeId);
      if (doc && !this.anchorsOf(r.nodeId, doc).has(r.anchorId)) {
        this.warn("W_REFERENCE_ANCHOR_MISSING", `Reference ${sh(r.id)}: anchor ${sh(r.anchorId)} is no longer in the document`, r.id);
      }
    }
  }
  private anchorsOf(nodeId: string, doc: { blocks: readonly any[] }): Set<string> {
    let set = this.anchors.get(nodeId);
    if (!set) this.anchors.set(nodeId, (set = anchorIds(doc)));
    return set;
  }

  private checkNotes(): void {
    for (const n of this.d.notes) {
      const src = this.srcOf(n, "Note");
      this.resolve(n.bookId, this.books, src, "bookId");
      this.textLength(n.text, 0, 20000, src, "text");
      if (n.nodeId !== undefined) {
        const node = this.resolve(n.nodeId, this.nodes, src, "nodeId");
        if (node && node.bookId !== n.bookId) this.err("INTEGRITY_VIOLATION", `Note ${sh(n.id)}: its node is in a different book`, n.id);
      }
    }
  }

  private checkAttachments(): void {
    const seen = new Set<string>();
    for (const a of this.d.attachments) {
      if (seen.has(a.sha256)) this.err("INTEGRITY_VIOLATION", `Attachment ${sh(a.sha256)} is listed twice`, a.sha256);
      seen.add(a.sha256);
    }
  }

  // ---- warnings ----

  /** W_STATE_CONFLICT: the rule lives in continuity.ts, shared with the server's warnings route, so the two cannot disagree. */
  private checkStateConflicts(): void {
    for (const w of continuityWarnings(this.d)) {
      if (w.kind === "stateConflict") this.warn("W_STATE_CONFLICT", `Event ${sh(w.recordId)} sets field ${sh(w.fieldId!)} of entry ${sh(w.entryId!)} to different values`, w.recordId);
    }
  }

  /**
   * W_CHRONOLOGY_ORDINAL: two live events of one timeline (same scope) with the same calendar whose
   * orderKey order contradicts their ordinal order. Each event that breaks the order is reported once,
   * against the earlier-ordered event with the highest ordinal so far (same reading as the Swift engine).
   */
  private checkChronology(): void {
    const timelines = new Map<string, Rec[]>();
    for (const e of this.d.events) {
      if (e.deletedAt !== undefined) continue;
      const key = `${e.scope.kind}:${e.scope.id}`;
      const t = timelines.get(key);
      if (t) t.push(e); else timelines.set(key, [e]);
    }
    for (const key of [...timelines.keys()].sort(cmpCodeUnits)) {
      if (this.warnings.full) return; // nothing more can be listed
      const timeline = timelines.get(key)!.sort((a, b) => cmpCodeUnits(a.orderKey, b.orderKey) || cmpCodeUnits(a.id, b.id));
      this.chronology(timeline, undefined);
      const books = new Set<string>();
      for (const e of timeline) for (const o of e.overrides ?? []) if (o.when !== undefined) books.add(o.bookId);
      for (const book of [...books].sort(cmpCodeUnits)) {
        if (this.warnings.full) return;
        this.chronology(timeline, book);
      }
    }
  }
  private chronology(timeline: Rec[], book: string | undefined): void {
    const override = (e: Rec): Rec | undefined => (book === undefined ? undefined : this.eventOverrides.get(e.id)?.get(book)?.when);
    const when = (e: Rec): Rec | undefined => override(e) ?? e.when;
    const highest = new Map<string, Rec>();
    for (const e of timeline) {
      const w = when(e);
      if (!w || w.calendar === undefined || w.ordinal === undefined) continue;
      const holder = highest.get(w.calendar);
      const holderOrdinal = holder ? when(holder)?.ordinal : undefined;
      if (holder && holderOrdinal !== undefined && w.ordinal < holderOrdinal) {
        if (book === undefined || override(e) !== undefined || override(holder) !== undefined) {
          this.warn("W_CHRONOLOGY_ORDINAL", `Event ${sh(e.id)} (ordinal ${w.ordinal}) follows event ${sh(holder.id)} (ordinal ${holderOrdinal}) in the timeline but is earlier in ${sh(w.calendar)}`, e.id, book);
        }
      } else highest.set(w.calendar, e);
    }
  }
}

/** `{ columns, rows }`: 1-20 column headings, up to 500 rows, one string per column, each at most 1,000 characters. */
function tableProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "needs exactly columns and rows";
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "columns" || keys[1] !== "rows") return "needs exactly columns and rows";
  const { columns, rows } = value;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return "needs exactly columns and rows";
  if (columns.length < 1 || columns.length > 20) return "1 to 20 columns";
  if (rows.length > 500) return "at most 500 rows";
  const text = (v: unknown): boolean => typeof v === "string" && cp(v) <= 1000;
  if (!columns.every(text)) return "column headings are strings of at most 1,000 characters";
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length || !row.every(text)) return "each row needs one string (at most 1,000 characters) per column";
  }
  return undefined;
}

/** The anchor ids used in a document. */
function anchorIds(doc: { blocks: readonly any[] }): Set<string> {
  const ids = new Set<string>();
  for (const b of doc.blocks) {
    if (b.type === "sceneBreak") continue;
    for (const i of b.content) {
      if (i.type !== "text") continue;
      for (const m of i.marks ?? []) if (m.type === "anchor") ids.add(m.id);
    }
  }
  return ids;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Schema subset follows Spec/tools/check-schemas.mjs (Apache-2.0, The Black Well Foundry).
import { readFileSync } from "node:fs";
import { decode } from "../../document-adapter/src/canonical.ts";
import {
  archiveFail as fail,
  archiveFiles,
  archiveJSON,
  hash,
  readZIP,
} from "./archive-zip.ts";
import { structuredValueError } from "./structured-values.ts";
import { inScope } from "./state-values.ts";
const root = JSON.parse(
  readFileSync(
    new URL("../schemas/archive-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
function matches(s: any, v: any): boolean {
  if (s.$ref) return matches(root.$defs[s.$ref.split("/").at(-1)], v);
  const type =
    v === null
      ? "null"
      : Array.isArray(v)
        ? "array"
        : typeof v === "number" && Number.isInteger(v)
          ? "integer"
          : typeof v;
  if (
    s.type &&
    !(Array.isArray(s.type) ? s.type : [s.type]).some(
      (t: string) => t === type || (t === "number" && type === "integer"),
    )
  )
    return false;
  if (
    Object.hasOwn(s, "const") &&
    JSON.stringify(s.const) !== JSON.stringify(v)
  )
    return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (
    type === "string" &&
    ((s.minLength !== undefined && [...v].length < s.minLength) ||
      (s.maxLength !== undefined && [...v].length > s.maxLength) ||
      (s.pattern && !new RegExp(s.pattern + "(?![\\s\\S])", "u").test(v)))
  )
    return false;
  if (type === "integer" || type === "number") {
    if (
      !Number.isFinite(v) ||
      (Number.isInteger(v) && !Number.isSafeInteger(v)) ||
      (s.minimum !== undefined && v < s.minimum) ||
      (s.maximum !== undefined && v > s.maximum)
    )
      return false;
  }
  if (type === "array") {
    if (s.minItems !== undefined && v.length < s.minItems) return false;
    if (s.items && !v.every((i: any) => matches(s.items, i))) return false;
  }
  if (type === "object") {
    if ((s.required ?? []).some((k: string) => !Object.hasOwn(v, k)))
      return false;
    if (
      s.minProperties !== undefined &&
      Object.keys(v).length < s.minProperties
    )
      return false;
    for (const [k, x] of Object.entries(v)) {
      if (Object.hasOwn(s.properties ?? {}, k)) {
        if (!matches(s.properties[k], x)) return false;
      } else if (s.additionalProperties === false) return false;
      else if (
        typeof s.additionalProperties === "object" &&
        !matches(s.additionalProperties, x)
      )
        return false;
    }
  }
  if (s.oneOf && s.oneOf.filter((p: any) => matches(p, v)).length !== 1)
    return false;
  return true;
}
export const checkArchiveSchema = (name: string, v: any) => {
  if (!matches(root.$defs[name], v))
    fail("SCHEMA_VIOLATION", "Invalid " + name + " record shape or value.");
};
export type Portable = {
  manifest: any;
  library: any;
  universes: any[];
  series: any[];
  books: any[];
  nodes: any[];
  templates: any[];
  fields: any[];
  entries: any[];
  relationshipTypes: any[];
  relationships: any[];
  events: any[];
  stateChanges: any[];
  references: any[];
  notes: any[];
  facts: any[];
  questions: any[];
  attachments: any[];
  documents: Map<string, any>;
  blobs: Map<string, Buffer>;
  warnings: { code: string; message: string }[];
};
const unique = (xs: any[], code = "INTEGRITY_VIOLATION") => {
  if (new Set(xs).size !== xs.length)
    fail(code, "Duplicate identifiers or values.");
};
export function validatePortable(s: Portable) {
  const collections = [
      s.universes,
      s.series,
      s.books,
      s.nodes,
      s.templates,
      s.fields,
      s.entries,
      s.relationshipTypes,
      s.relationships,
      s.events,
      s.stateChanges,
      s.references,
      s.notes,
      s.facts,
      s.questions,
    ],
    all = [s.library, ...collections.flat()],
    ids = new Set<string>();
  for (const r of all) {
    if (ids.has(r.id))
      fail("INTEGRITY_VIOLATION", "Record IDs must be globally unique.");
    ids.add(r.id);
    for (const key of ["createdAt", "updatedAt", "deletedAt"])
      if (r[key]) {
        const d = r[key];
        if (
          !Number.isFinite(Date.parse(d)) ||
          new Date(d).toISOString().slice(0, 19) !== d.slice(0, 19)
        )
          fail("SCHEMA_VIOLATION", "Invalid UTC timestamp.");
      }
  }
  const maps = collections.map((a) => new Map(a.map((r) => [r.id, r])));
  const [
    universes,
    series,
    books,
    nodes,
    templates,
    fields,
    entries,
    relTypes,
    ,
    events,
  ] = maps;
  const ref = (map: Map<string, any>, id: string) => {
    const v = map.get(id);
    if (!v) fail("REFERENCE_UNRESOLVED", "Unresolved reference: " + id);
    return v;
  };
  const scope = (v: any) =>
    ref(
      v.kind === "book" ? books : v.kind === "series" ? series : universes,
      v.id,
    );
  const point = (id: string, sc: any) => {
    const n = ref(nodes, id);
    if (
      !["chapter", "scene"].includes(n.kind) ||
      !inScope(sc, ref(books, n.bookId))
    )
      fail(
        "INTEGRITY_VIOLATION",
        "Story point is outside scope or is not a chapter/scene.",
      );
  };
  const attachments = new Map(s.attachments.map((a) => [a.sha256, a]));
  unique(s.attachments.map((a) => a.sha256));
  const attachment = (sha: string) => {
    if (!attachments.has(sha))
      fail("REFERENCE_UNRESOLVED", "Unknown attachment: " + sha);
  };
  for (const ser of s.series)
    if (ser.universeId) ref(universes, ser.universeId);
  for (const b of s.books) {
    if (b.universeId) ref(universes, b.universeId);
    if (b.seriesId) {
      const ser = ref(series, b.seriesId);
      if (ser.universeId && b.universeId !== ser.universeId)
        fail("INTEGRITY_VIOLATION", "Book and series worlds disagree.");
    }
    if (b.coverAttachment) attachment(b.coverAttachment);
    if (
      b.targetDate &&
      structuredValueError({ fieldType: "realDate" }, b.targetDate)
    )
      fail("SCHEMA_VIOLATION", "Invalid target date.");
  }
  for (const n of s.nodes) {
    const b = ref(books, n.bookId);
    if (
      (n.targetWordCount !== undefined || n.plan !== undefined) &&
      !["part", "chapter"].includes(n.kind)
    )
      fail("INTEGRITY_VIOLATION", "Only parts/chapters have plans.");
    for (const [key, type] of [
      ["povEntryId", "character"],
      ["settingEntryId", "location"],
    ])
      if (n[key]) {
        const e = ref(entries, n[key]);
        if (
          !["chapter", "scene"].includes(n.kind) ||
          e.entryType !== type ||
          !inScope(e.scope, b)
        )
          fail("INTEGRITY_VIOLATION", "Invalid point of view or setting.");
      }
    if (!n.parentId) {
      if (n.kind === "scene")
        fail("INTEGRITY_VIOLATION", "A scene needs a chapter.");
    } else {
      const p = ref(nodes, n.parentId);
      if (
        p.bookId !== n.bookId ||
        !(
          (n.kind === "chapter" && p.kind === "part") ||
          (n.kind === "scene" && p.kind === "chapter")
        )
      )
        fail("INTEGRITY_VIOLATION", "Invalid manuscript hierarchy.");
    }
    const doc = s.documents.get(n.id);
    if (["scene", "frontMatter", "backMatter"].includes(n.kind) !== !!doc)
      fail(
        "INTEGRITY_VIOLATION",
        "Manuscript document set does not match nodes.",
      );
  }
  for (const [id, d] of s.documents) {
    ref(nodes, id);
    if (d.nodeId !== id)
      fail("INTEGRITY_VIOLATION", "Document node ID differs from its path.");
  }
  const fieldKeys: string[] = [];
  for (const f of s.fields) {
    ref(templates, f.templateId);
    fieldKeys.push(f.templateId + "/" + f.key);
    if (f.fieldType === "selection") {
      if (!f.options?.length)
        fail("SCHEMA_VIOLATION", "Selection requires options.");
      unique(f.options.map((o: any) => o.id));
    } else if (f.options !== undefined || f.multiple !== undefined)
      fail("SCHEMA_VIOLATION", "Options/multiple require a selection field.");
    if (
      f.targetEntryTypes !== undefined &&
      !["entryReference", "entryReferences"].includes(f.fieldType)
    )
      fail(
        "SCHEMA_VIOLATION",
        "Target types require an entry-reference field.",
      );
  }
  unique(fieldKeys);
  const value = (f: any, v: any) => {
    if (v === null)
      fail("INTEGRITY_VIOLATION", "Saved field values must not be null.");
    let invalid = false;
    switch (f.fieldType) {
      case "shortText":
      case "longText":
        invalid = typeof v !== "string";
        break;
      case "integer":
        invalid = !Number.isSafeInteger(v);
        break;
      case "decimal":
        invalid =
          typeof v !== "string" ||
          !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$(?![\s\S])/.test(v);
        break;
      case "boolean":
        invalid = typeof v !== "boolean";
        break;
      case "selection":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          invalid = true;
          break;
        }
        unique(v);
        if (!f.multiple && v.length > 1) invalid = true;
        for (const id of v)
          if (!f.options.some((o: any) => o.id === id))
            fail("REFERENCE_UNRESOLVED", "Unknown selection option.");
        break;
      case "entryReference":
      case "entryReferences": {
        const list = f.fieldType === "entryReference" ? [v] : v;
        if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
          invalid = true;
          break;
        }
        unique(list);
        for (const id of list) {
          const e = ref(entries, id);
          if (f.targetEntryTypes && !f.targetEntryTypes.includes(e.entryType))
            invalid = true;
        }
        break;
      }
      case "attachment":
        invalid = typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v);
        if (!invalid) attachment(v);
        break;
      default:
        invalid = !!structuredValueError(f, v);
    }
    if (invalid)
      fail("INTEGRITY_VIOLATION", "Invalid typed field value: " + f.label);
  };
  const values = (e: any, vs: any) => {
    for (const [id, v] of Object.entries(vs)) {
      const f = ref(fields, id);
      if (f.templateId !== e.templateId)
        fail("INTEGRITY_VIOLATION", "Field is outside entry template.");
      value(f, v);
    }
  };
  for (const e of s.entries) {
    scope(e.scope);
    if (e.templateId && ref(templates, e.templateId).entryType !== e.entryType)
      fail("INTEGRITY_VIOLATION", "Entry and template types differ.");
    if (
      e.toBeNamed === false ||
      ((e.givenName !== undefined || e.familyName !== undefined) &&
        e.entryType !== "character")
    )
      fail("SCHEMA_VIOLATION", "Invalid character name or naming flag.");
    values(e, e.values);
    unique(e.overrides.map((o: any) => o.bookId));
    for (const o of e.overrides) {
      const b = ref(books, o.bookId);
      if (e.scope.kind === "book" || !inScope(e.scope, b))
        fail("INTEGRITY_VIOLATION", "Override outside entry scope.");
      values(e, o.values);
    }
    unique(e.attachments);
    e.attachments.forEach(attachment);
  }
  for (const r of s.relationships) {
    ref(relTypes, r.typeId);
    ref(entries, r.fromEntryId);
    ref(entries, r.toEntryId);
    if (r.fromEntryId === r.toEntryId)
      fail("INTEGRITY_VIOLATION", "Self relationship.");
    if (r.bookId) ref(books, r.bookId);
  }
  // Book overrides on facts, questions and events (spec: "Book overrides on records").
  const recordOverrides = (r: any) => {
    if (!r.overrides) return;
    unique(r.overrides.map((o: any) => o.bookId));
    for (const o of r.overrides) {
      const b = ref(books, o.bookId);
      if (r.scope.kind === "book" || !inScope(r.scope, b))
        fail("INTEGRITY_VIOLATION", "Override outside record scope.");
      if (o.participants) {
        unique(o.participants.map((p: any) => p.entryId));
        for (const p of o.participants) ref(entries, p.entryId);
      }
    }
  };
  const dismissed = (r: any) => {
    if (r.dismissedWarnings)
      unique(
        r.dismissedWarnings.map((d: any) => d.warning),
        "SCHEMA_VIOLATION",
      );
  };
  for (const e of s.events) {
    scope(e.scope);
    if (e.entryId && ref(entries, e.entryId).entryType !== "event")
      fail("INTEGRITY_VIOLATION", "Event link is not an event entry.");
    unique(e.sceneIds);
    for (const id of e.sceneIds) {
      const n = ref(nodes, id);
      if (n.kind !== "scene" || !inScope(e.scope, ref(books, n.bookId)))
        fail("INTEGRITY_VIOLATION", "Event scene outside scope.");
    }
    unique(e.participants.map((p: any) => p.entryId));
    for (const p of e.participants) ref(entries, p.entryId);
    dismissed(e);
    recordOverrides(e);
  }
  for (const c of s.stateChanges) {
    if ((c.eventId === undefined) === (c.nodeId === undefined))
      fail("SCHEMA_VIOLATION", "State change needs exactly one placement.");
    if (c.eventId) ref(events, c.eventId);
    const e = ref(entries, c.entryId);
    if (c.nodeId) point(c.nodeId, e.scope);
    const f = ref(fields, c.fieldId);
    if (e.templateId !== f.templateId)
      fail("INTEGRITY_VIOLATION", "State field outside entry template.");
    value(f, c.value);
  }
  const refs: string[] = [];
  for (const r of s.references) {
    ref(entries, r.entryId);
    if (!s.documents.has(r.nodeId))
      fail("REFERENCE_UNRESOLVED", "Reference has no manuscript document.");
    refs.push([r.nodeId, r.anchorId, r.entryId].join("/"));
    const anchors = JSON.stringify(s.documents.get(r.nodeId));
    if (!r.deletedAt && !anchors.includes(r.anchorId))
      s.warnings.push({
        code: "W_REFERENCE_ANCHOR_MISSING",
        message: "Linked passage is missing: " + r.id,
      });
  }
  unique(refs);
  for (const n of s.notes) {
    ref(books, n.bookId);
    if (n.nodeId && ref(nodes, n.nodeId).bookId !== n.bookId)
      fail("INTEGRITY_VIOLATION", "Note pin is in another book.");
  }
  for (const f of [...s.facts, ...s.questions]) {
    scope(f.scope);
    if (f.nodeId) point(f.nodeId, f.scope);
    unique(f.entryIds, "SCHEMA_VIOLATION");
    f.entryIds.forEach((id: string) => ref(entries, id));
    dismissed(f);
    recordOverrides(f);
  }
  for (const f of s.facts) {
    unique(
      f.knowledge.map((k: any) => k.knower),
      "SCHEMA_VIOLATION",
    );
    for (const k of f.knowledge) {
      if (
        k.knower !== "reader" &&
        ref(entries, k.knower).entryType !== "character"
      )
        fail("INTEGRITY_VIOLATION", "Knower is not a character.");
      if (k.nodeId) point(k.nodeId, f.scope);
    }
  }
  const deletedIds = new Set(all.filter((r) => r.deletedAt).map((r) => r.id));
  for (const r of all.filter((r) => !r.deletedAt))
    for (const [key, v] of Object.entries(r))
      if (typeof v === "string" && key !== "id" && deletedIds.has(v))
        s.warnings.push({
          code: "W_REFERENCE_TO_DELETED",
          message: "Live record references Trash: " + r.id,
        });
  const timelines = new Map<string, any[]>();
  for (const e of s.events.filter(
    (e) => !e.deletedAt && e.when?.ordinal !== undefined,
  )) {
    const key = e.scope.kind + "/" + e.scope.id + "/" + (e.when.calendar ?? "");
    timelines.set(key, [...(timelines.get(key) ?? []), e]);
  }
  for (const es of timelines.values()) {
    es.sort((a, b) =>
      a.orderKey < b.orderKey
        ? -1
        : a.orderKey > b.orderKey
          ? 1
          : a.id.localeCompare(b.id),
    );
    for (let i = 1; i < es.length; i++)
      if (es[i - 1].when.ordinal > es[i].when.ordinal)
        s.warnings.push({
          code: "W_CHRONOLOGY_ORDINAL",
          message: "Timeline order and ordinal disagree.",
        });
  }
  const changes = new Map<string, string>();
  const stable = (x: any): string =>
    x && typeof x === "object" && !Array.isArray(x)
      ? JSON.stringify(
          Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, JSON.parse(stable(x[k]))]),
          ),
        )
      : JSON.stringify(x);
  for (const c of s.stateChanges.filter((c) => !c.deletedAt && c.eventId)) {
    const k = [c.eventId, c.entryId, c.fieldId].join("/"),
      v = stable(c.value);
    if (changes.has(k) && changes.get(k) !== v)
      s.warnings.push({
        code: "W_STATE_CONFLICT",
        message: "Conflicting state values at event " + c.eventId,
      });
    changes.set(k, v);
  }
}
export function readArchive(bytes: Buffer): Portable {
  const files = readZIP(bytes),
    get = (p: string) => {
      const b = files.get(p);
      if (!b) fail("ARCHIVE_MISSING_FILE", "Required file missing: " + p);
      return b!;
    };
  const manifest = archiveJSON(get("manifest.json"), "manifest.json");
  if (manifest?.format !== "writers-rolltop-archive")
    fail("ARCHIVE_NOT_ROLLTOP", "Not a Writers Rolltop archive.");
  if (manifest.formatVersion > 1)
    fail(
      "ARCHIVE_UNSUPPORTED_VERSION",
      "Created by a newer Writers Rolltop; update to open this archive.",
    );
  checkArchiveSchema("manifest", manifest);
  const cb = get("checksums.json");
  if (
    hash(cb) !== manifest.checksums.sha256 ||
    cb.length !== manifest.checksums.byteLength
  )
    fail("ARCHIVE_CHECKSUM_MISMATCH", "Checksum index mismatch.");
  const checksums = archiveJSON(cb, "checksums.json");
  checkArchiveSchema("checksums", checksums);
  unique(checksums.files.map((f: any) => f.path));
  const present = [...files.keys()].filter(
    (p) => !["manifest.json", "checksums.json"].includes(p),
  );
  for (const p of present)
    if (!checksums.files.some((f: any) => f.path === p))
      fail("ARCHIVE_CHECKSUM_MISMATCH", "Unlisted archive entry.");
  for (const f of checksums.files) {
    const b = get(f.path);
    if (hash(b) !== f.sha256 || b.length !== f.byteLength)
      fail("ARCHIVE_CHECKSUM_MISMATCH", "File checksum mismatch: " + f.path);
  }
  const data: any = {};
  for (const [p, name] of Object.entries(archiveFiles)) {
    data[name] = archiveJSON(get(p), p);
    checkArchiveSchema(name, data[name]);
  }
  const l = data.library;
  if (l.library.id !== manifest.libraryId)
    fail(
      "INTEGRITY_VIOLATION",
      "Manifest library ID differs from library.json.",
    );
  const s: Portable = {
    manifest,
    library: l.library,
    universes: l.universes,
    series: l.series,
    books: l.books,
    nodes: l.manuscriptNodes,
    templates: data.templates,
    fields: data.fields,
    entries: data.entries,
    ...data.relationships,
    events: data.events,
    stateChanges: data.stateChanges,
    references: data.references,
    notes: data.notes,
    facts: data.facts,
    questions: data.questions,
    attachments: data.attachments,
    documents: new Map(),
    blobs: new Map(),
    warnings: [],
  };
  for (const [p, b] of files)
    if (p.startsWith("manuscript/")) {
      const d = decode(archiveJSON(b, p)),
        id = p.slice(11, -5);
      if (d.nodeId !== id) fail("INTEGRITY_VIOLATION", "Document ID mismatch.");
      s.documents.set(id, d);
    }
  for (const a of s.attachments) {
    if (
      a.extension !== undefined &&
      (typeof a.extension !== "string" ||
        !/^[a-z0-9]{1,10}$(?![\s\S])/.test(a.extension))
    )
      fail("INTEGRITY_VIOLATION", "Invalid attachment extension.");
    if (!Number.isFinite(Date.parse(a.createdAt)))
      fail("INTEGRITY_VIOLATION", "Invalid attachment timestamp.");
    const p =
        "attachments/" + a.sha256 + (a.extension ? "." + a.extension : ""),
      b = get(p);
    if (hash(b) !== a.sha256 || b.length !== a.byteLength)
      fail("ARCHIVE_CHECKSUM_MISMATCH", "Attachment does not match its index.");
    s.blobs.set(a.sha256, b);
  }
  if (
    [...files.keys()].filter((p) => p.startsWith("attachments/")).length !==
    s.attachments.length
  )
    fail("INTEGRITY_VIOLATION", "Attachment files do not match their index.");
  validatePortable(s);
  return s;
}

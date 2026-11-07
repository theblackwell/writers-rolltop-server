// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { StudioError } from "./store.ts";
import type { StudioStore, Query } from "./store.ts";
import {
  backupTables,
  captureLibrary,
  insertRecoveryRows,
  writeBookBackup,
} from "./backup.ts";
import type { BookBackup } from "./backup.ts";
import { archiveFiles, hash, writeZIP } from "./archive-zip.ts";
import {
  readArchive,
  validatePortable,
  checkArchiveSchema,
} from "./archive-validation.ts";
import type { Portable } from "./archive-validation.ts";
import { wordCount } from "../../document-adapter/src/text.ts";
const mapping: Record<string, string> = {
  universes: "universes",
  series: "series",
  books: "books",
  nodes: "manuscript_nodes",
  templates: "bible_templates",
  fields: "bible_fields",
  entries: "bible_entries",
  relationshipTypes: "relationship_types",
  relationships: "relationships",
  events: "continuity_events",
  stateChanges: "state_changes",
  references: "manuscript_references",
  notes: "notes",
  facts: "facts",
  questions: "questions",
};
const canonical = (v: any): string =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
/** Same bytes as canonical() of the sorted tables, but each row is serialized once. */
export const digest = (b: BookBackup) =>
  hash(
    Buffer.from(
      "{" +
        Object.keys(b.tables)
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) +
              ":[" +
              b.tables[k]
                .map((r) => canonical(r))
                .sort((x, y) => x.localeCompare(y))
                .join(",") +
              "]",
          )
          .join(",") +
        "}",
    ),
  );
export function portableFromBackup(b: BookBackup): Portable {
  const t = b.tables,
    s: any = {
      manifest: t.library_portable?.[0]?.data?.manifest ?? {},
      library: t.libraries[0].data,
      attachments: (t.library_attachments ?? []).map((r) => r.data),
      documents: new Map(t.documents.map((r) => [r.node_id, r.document])),
      blobs: new Map(
        (t.library_attachments ?? []).map((r) => [
          r.sha256,
          Buffer.from(r.content_base64, "base64"),
        ]),
      ),
      warnings: [],
    };
  for (const [key, table] of Object.entries(mapping))
    s[key] = t[table].map((r) => r.data);
  return s;
}
export function encodePortable(s: Portable): Buffer {
  validatePortable({ ...s, warnings: [] });
  for (const a of s.attachments) {
    const b = s.blobs.get(a.sha256);
    if (!b || b.length !== a.byteLength || hash(b) !== a.sha256)
      throw new StudioError(
        500,
        "ATTACHMENT_CHECKSUM",
        "Stored attachment bytes failed verification.",
      );
  }
  const files = new Map<string, Uint8Array>(),
    json = (path: string, value: any) =>
      files.set(path, Buffer.from(JSON.stringify(value)));
  json("library.json", {
    library: s.library,
    universes: s.universes,
    series: s.series,
    books: s.books,
    manuscriptNodes: s.nodes,
  });
  json("bible/relationships.json", {
    relationshipTypes: s.relationshipTypes,
    relationships: s.relationships,
  });
  for (const [path, key] of Object.entries(archiveFiles))
    if (!["manifest", "checksums", "library", "relationships"].includes(key))
      json(path, (s as any)[key]);
  for (const [id, doc] of s.documents) json("manuscript/" + id + ".json", doc);
  for (const a of s.attachments)
    files.set(
      "attachments/" + a.sha256 + (a.extension ? "." + a.extension : ""),
      s.blobs.get(a.sha256)!,
    );
  const checksums = {
    algorithm: "sha256",
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, bytes]) => ({
        path,
        byteLength: bytes.length,
        sha256: hash(bytes),
      })),
  };
  json("checksums.json", checksums);
  const bytes = files.get("checksums.json")!;
  json("manifest.json", {
    ...s.manifest,
    format: "writers-rolltop-archive",
    formatVersion: 1,
    archiveId: randomUUID(),
    libraryId: s.library.id,
    createdAt: new Date().toISOString(),
    generator: {
      ...(s.manifest.generator ?? {}),
      name: "Writers Rolltop Studio",
      version: "M3",
    },
    checksums: {
      path: "checksums.json",
      byteLength: bytes.length,
      sha256: hash(bytes),
    },
  });
  // Export must pass the very same reader, including schema/size/path rules.
  const result = writeZIP(files);
  readArchive(result);
  return result;
}
export async function exportPortable(store: StudioStore, libraryId: string) {
  return store.db.transaction(async (q) => {
    if (
      !(await q("SELECT id FROM libraries WHERE id=$1", [libraryId])).rows
        .length
    )
      throw new StudioError(404, "NOT_FOUND", "Library no longer exists.");
    return encodePortable(
      portableFromBackup(await captureLibrary(q, libraryId, libraryId, true)),
    );
  });
}
function backupFor(s: Portable): BookBackup {
  const tables: Record<string, any[]> = Object.fromEntries(
    backupTables.map((t) => [t, []]),
  );
  tables.libraries = [{ id: s.library.id, data: s.library }];
  for (const [key, table] of Object.entries(mapping))
    tables[table] = (s as any)[key].map((r: any) => ({
      id: r.id,
      ...(key === "nodes"
        ? { book_id: r.bookId, parent_id: r.parentId ?? null, kind: r.kind }
        : key === "notes"
          ? { book_id: r.bookId }
          : key === "references"
            ? { node_id: r.nodeId, entry_id: r.entryId }
            : { library_id: s.library.id }),
      ...(key === "fields" ? { template_id: r.templateId } : {}),
      ...(key === "entries"
        ? { book_id: r.scope.kind === "book" ? r.scope.id : null }
        : {}),
      data: r,
    }));
  tables.documents = [...s.documents].map(([node_id, document]) => ({
    node_id,
    revision: 1,
    document,
    updated_at: s.nodes.find((n) => n.id === node_id)!.updatedAt,
  }));
  tables.document_revisions = tables.documents.map((d) => ({
    node_id: d.node_id,
    revision: 1,
    document: d.document,
    saved_at: d.updated_at,
  }));
  tables.library_attachments = s.attachments.map((a) => ({
    library_id: s.library.id,
    sha256: a.sha256,
    data: a,
    content_base64: s.blobs.get(a.sha256)!.toString("base64"),
  }));
  tables.library_portable = [
    { library_id: s.library.id, data: { manifest: s.manifest } },
  ];
  return {
    format: "writers-rolltop/book-recovery",
    version: 11,
    schemaVersion: 13,
    createdAt: new Date().toISOString(),
    bookId: s.books[0]?.id ?? s.library.id,
    tables,
  };
}
async function collision(q: Query, s: Portable) {
  const ids = [
    s.library.id,
    ...Object.keys(mapping).flatMap((k) => (s as any)[k].map((r: any) => r.id)),
  ];
  for (const table of ["libraries", ...Object.values(mapping)]) {
    const rows = (
      await q(
        `SELECT id${["manuscript_nodes", "notes", "manuscript_references"].includes(table) ? "" : table === "libraries" ? ",id AS library_id" : ",library_id"} FROM ${table} WHERE id=ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    for (const r of rows) {
      let lib = r.library_id;
      if (!lib) {
        const owner =
          table === "manuscript_references"
            ? "SELECT b.library_id FROM manuscript_references r JOIN manuscript_nodes n ON n.id=r.node_id JOIN books b ON b.id=n.book_id WHERE r.id=$1"
            : `SELECT b.library_id FROM ${table} n JOIN books b ON b.id=n.book_id WHERE n.id=$1`;
        lib = (await q(owner, [r.id])).rows[0]?.library_id;
      }
      if (lib !== s.library.id) return true;
    }
  }
  return false;
}
async function deleteLibrary(q: Query, b: BookBackup) {
  for (const table of [...backupTables].reverse()) {
    const rows = b.tables[table];
    if (!rows.length) continue;
    if (
      ["documents", "document_revisions", "manuscript_references"].includes(
        table,
      )
    )
      await q(`DELETE FROM ${table} WHERE node_id=ANY($1::uuid[])`, [
        b.tables.manuscript_nodes.map((r) => r.id),
      ]);
    else if (["manuscript_nodes", "notes"].includes(table))
      await q(`DELETE FROM ${table} WHERE book_id=ANY($1::uuid[])`, [
        b.tables.books.map((r) => r.id),
      ]);
    else if (table === "libraries")
      await q("DELETE FROM libraries WHERE id=$1", [b.tables.libraries[0].id]);
    else
      await q(`DELETE FROM ${table} WHERE library_id=$1`, [
        b.tables.libraries[0].id,
      ]);
  }
}
export class PortableImports {
  private pending = new Map<
    string,
    {
      source: Portable;
      expires: number;
      targetDigest?: string;
      result?: any;
      committing?: Promise<any>;
    }
  >();
  private store: StudioStore;
  constructor(store: StudioStore) {
    this.store = store;
  }
  private sweep() {
    for (const [id, p] of this.pending)
      if (p.expires < Date.now() && !p.committing) this.pending.delete(id);
  }
  cancel(id: string) {
    // A commit in flight cannot be recalled; deleting would let a retry see "expired".
    if (this.pending.get(id)?.committing) return { cancelled: false };
    this.pending.delete(id);
    return { cancelled: true };
  }
  async preview(bytes: Buffer) {
    this.sweep();
    if ([...this.pending.values()].filter((p) => !p.result).length >= 2)
      throw new StudioError(
        429,
        "IMPORT_BUSY",
        "Cancel a pending preview before uploading another archive.",
      );
    const s = readArchive(bytes),
      id = randomUUID();
    const target = await this.store.db.transaction(async (q) => {
      const exists =
        (await q("SELECT id FROM libraries WHERE id=$1", [s.library.id])).rows
          .length > 0;
      const captured = exists
        ? await captureLibrary(q, s.library.id, s.library.id, true)
        : undefined;
      return {
        exists,
        title: captured?.tables.libraries[0].data.title,
        conflictingIds: await collision(q, s),
        digest: captured ? digest(captured) : undefined,
      };
    });
    this.pending.set(id, {
      source: s,
      expires: Date.now() + 15 * 60000,
      targetDigest: target.digest,
    });
    return {
      id,
      libraryId: s.library.id,
      libraryTitle: s.library.title,
      counts: Object.fromEntries(
        Object.keys(mapping).map((k) => [k, (s as any)[k].length]),
      ),
      attachments: s.attachments.length,
      words: [...s.documents.values()].reduce((n, d) => n + wordCount(d), 0),
      warnings: s.warnings,
      targetExists: target.exists,
      targetTitle: target.title,
      conflictingIds: target.conflictingIds,
      expiresInMinutes: 15,
    };
  }
  async commit(id: string, input: any) {
    this.sweep();
    const pending = this.pending.get(id);
    if (!pending)
      throw new StudioError(
        410,
        "IMPORT_EXPIRED",
        "Preview expired. Upload the original archive again.",
      );
    if (pending.result) return pending.result;
    // A duplicate request while the first is installing shares its outcome.
    if (pending.committing) return pending.committing;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !["mode", "confirmTitle", "confirmed"].includes(k),
      ) ||
      !["new", "replace"].includes(input.mode)
    )
      throw new StudioError(
        400,
        "INVALID_INPUT",
        "Choose new library or explicitly confirmed replacement.",
      );
    const run = this.install(pending, input);
    pending.committing = run;
    try {
      const result = await run;
      pending.result = result;
      pending.source = undefined as any;
      return result;
    } finally {
      pending.committing = undefined;
    }
  }
  private install(
    pending: { source: Portable; targetDigest?: string },
    input: any,
  ) {
    const s = pending.source;
    return this.store.db.transaction(async (q) => {
      // Serializes installers without taking an exclusive content-table lock (ordinary writers retain book→library ordering).
      await q("SELECT pg_advisory_xact_lock(1801163361)");
      const exists =
        (await q("SELECT id FROM libraries WHERE id=$1", [s.library.id])).rows
          .length > 0;
      if (await collision(q, s))
        throw new StudioError(
          409,
          "IMPORT_ID_CONFLICT",
          "Record IDs already belong to another library. Import into a separate server; IDs were not changed.",
        );
      let backup: string | undefined;
      if (exists) {
        if (input.mode !== "replace")
          throw new StudioError(
            409,
            "TARGET_EXISTS",
            "This library already exists. Choose replacement explicitly, or use a separate server.",
          );
        if (input.confirmed !== true || input.confirmTitle !== s.library.title)
          throw new StudioError(
            400,
            "CONFIRMATION_REQUIRED",
            "Confirm replacement and type the library title exactly.",
          );
        if (!this.store.backupDirectory)
          throw new StudioError(
            503,
            "BACKUP_REQUIRED",
            "Configure durable recovery backup storage before replacing a library.",
          );
        const captured = await captureLibrary(q, s.library.id);
        if (!pending.targetDigest || digest(captured) !== pending.targetDigest)
          throw new StudioError(
            409,
            "IMPORT_CONFLICT",
            "The target changed since preview. Upload again to review a fresh preview.",
          );
        backup = basename(
          await writeBookBackup(this.store.backupDirectory, captured),
        );
        await deleteLibrary(q, captured);
      } else if (input.mode === "replace" || pending.targetDigest)
        throw new StudioError(
          409,
          "IMPORT_CONFLICT",
          "The target changed since preview. Upload again.",
        );
      await insertRecoveryRows(q, backupFor(s));
      const actual = portableFromBackup(await captureLibrary(q, s.library.id));
      const expectedJSON = (p: Portable) =>
        canonical({
          library: p.library,
          ...Object.fromEntries(
            Object.keys(mapping).map((k) => [
              k,
              [...(p as any)[k]].sort((a: any, b: any) =>
                a.id.localeCompare(b.id),
              ),
            ]),
          ),
          attachments: [...p.attachments].sort((a, b) =>
            a.sha256.localeCompare(b.sha256),
          ),
          documents: [...p.documents].sort(([a], [b]) => a.localeCompare(b)),
          manifest: p.manifest,
        });
      if (expectedJSON(actual) !== expectedJSON(s))
        throw new StudioError(
          500,
          "IMPORT_VERIFICATION",
          "Imported records differ from the validated archive. Nothing was committed.",
        );
      return { library: s.library, backup, warnings: s.warnings };
    });
  }
}

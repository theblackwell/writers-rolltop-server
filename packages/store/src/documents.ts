// Scene documents: validation and the compare-and-swap writes that Store.createDocument, Store.saveDocument and the
// sync protocol share. The functions take the caller's transaction, so each caller decides what the write is atomic
// with (the sync engine: its change row and stored result).
import type pg from "pg";
import { DocumentError, normalizeDocument } from "@writers-rolltop/document-adapter/canonical";
import type { CanonicalDocument } from "@writers-rolltop/document-adapter/canonical";
import { StoreError } from "./errors.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True if any string in the value (or any key) holds a lone UTF-16 surrogate or U+0000, neither of which jsonb can store. */
export function hasLoneSurrogate(v: unknown): boolean {
  if (typeof v === "string") return !v.isWellFormed() || v.includes("\u0000");
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (v !== null && typeof v === "object") {
    return Object.entries(v).some(([k, x]) => !k.isWellFormed() || k.includes("\u0000") || hasLoneSurrogate(x));
  }
  return false;
}

/**
 * SQL predicate: the node `idExpr` and all its ancestors are undeleted. Hiding is by ancestry, so deleting a
 * parent hides its descendants and clearing the parent's deleted_at restores them with no further write.
 */
export const live = (idExpr: string): string =>
  `NOT EXISTS (WITH RECURSIVE chain(parent_id, deleted_at) AS (
     SELECT m.parent_id, m.deleted_at FROM manuscript_node m WHERE m.id = ${idExpr}
     UNION ALL SELECT p.parent_id, p.deleted_at FROM manuscript_node p JOIN chain c ON p.id = c.parent_id)
   SELECT 1 FROM chain WHERE deleted_at IS NOT NULL)`;

function toDocumentError(e: unknown): unknown {
  return e instanceof DocumentError
    ? new StoreError("DOCUMENT_INVALID", e.message.replace(/^[A-Z_]+: /, ""))
    : e;
}

/** Validate and normalize a document for a node. Throws NOT_FOUND (not a uuid) or DOCUMENT_INVALID. */
export function prepareDocument(nodeId: string, input: unknown): CanonicalDocument {
  if (!UUID.test(nodeId)) throw new StoreError("NOT_FOUND", "document not found");
  let doc: CanonicalDocument;
  try { doc = normalizeDocument(input); } catch (e) { throw toDocumentError(e); }
  if (doc.nodeId !== nodeId) throw new StoreError("DOCUMENT_INVALID", "document nodeId does not match the node");
  // jsonb cannot hold a lone surrogate; refuse it here instead of failing inside PostgreSQL.
  if (hasLoneSurrogate(doc)) throw new StoreError("DOCUMENT_INVALID", "document text contains an unpaired surrogate or NUL");
  return doc;
}

/** Insert revision 1 (head and history rows). False when the node already has a document. */
export async function insertFirstRevision(c: pg.PoolClient, nodeId: string, doc: CanonicalDocument, at: Date): Promise<boolean> {
  const ins = await c.query(
    `INSERT INTO scene_document (node_id, revision, document, updated_at) VALUES ($1, 1, $2::jsonb, $3)
     ON CONFLICT (node_id) DO NOTHING RETURNING revision`, [nodeId, JSON.stringify(doc), at]);
  if (ins.rowCount === 0) return false;
  await c.query(
    "INSERT INTO document_revision (node_id, revision, document, created_at) VALUES ($1, 1, $2::jsonb, $3)",
    [nodeId, JSON.stringify(doc), at]);
  return true;
}

/**
 * The compare-and-swap: write the next revision only if the head is still at `expectedRevision` and the node is live
 * (itself and its ancestors). Returns the new revision, or undefined when nothing changed.
 */
export async function swapRevision(c: pg.PoolClient, nodeId: string, expectedRevision: number, doc: CanonicalDocument, at: Date): Promise<number | undefined> {
  const upd = await c.query(
    `UPDATE scene_document sd SET revision = sd.revision + 1, document = $3::jsonb, updated_at = $4
     WHERE sd.node_id = $1 AND sd.revision = $2
       AND ${live("sd.node_id")}
     RETURNING sd.revision`, [nodeId, expectedRevision, JSON.stringify(doc), at]);
  const row = upd.rows[0];
  if (!row) return undefined;
  await c.query(
    "INSERT INTO document_revision (node_id, revision, document, created_at) VALUES ($1, $2, $3::jsonb, $4)",
    [nodeId, row.revision, JSON.stringify(doc), at]);
  return row.revision as number;
}

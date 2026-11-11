import type pg from "pg";
import { attachmentPath, hashFile } from "./attachments.ts";

export type IntegrityProblemCode =
  | "HEAD_REVISION_ROW_MISSING"
  | "REVISION_ROWS_NOT_CONTIGUOUS"
  | "REVISION_ROW_WITHOUT_DOCUMENT"
  | "HEAD_DOCUMENT_MISMATCH"
  | "ATTACHMENT_FILE_MISSING"
  | "ATTACHMENT_HASH_MISMATCH"
  | "ATTACHMENT_LENGTH_MISMATCH"
  | "INVALID_INDEX";

/** Codes and ids only: never document text. */
export interface IntegrityProblem { code: IntegrityProblemCode; id: string }
export interface IntegrityReport { ok: boolean; problems: IntegrityProblem[] }

export async function checkIntegrity(pool: pg.Pool, attachmentsDir: string): Promise<IntegrityReport> {
  const problems: IntegrityProblem[] = [];
  const add = (code: IntegrityProblemCode, id: string) => problems.push({ code, id });

  // (a) Every head has its revision row, and the rows run 1..revision without gaps.
  for (const r of (await pool.query(
    `SELECT sd.node_id FROM scene_document sd
     LEFT JOIN document_revision dr ON dr.node_id = sd.node_id AND dr.revision = sd.revision
     WHERE dr.node_id IS NULL ORDER BY sd.node_id`)).rows) add("HEAD_REVISION_ROW_MISSING", r.node_id);
  for (const r of (await pool.query(
    `SELECT sd.node_id FROM scene_document sd WHERE
       (SELECT count(*) FROM document_revision r WHERE r.node_id = sd.node_id) <> sd.revision
       OR (SELECT max(r.revision) FROM document_revision r WHERE r.node_id = sd.node_id) IS DISTINCT FROM sd.revision
     ORDER BY sd.node_id`)).rows) add("REVISION_ROWS_NOT_CONTIGUOUS", r.node_id);
  for (const r of (await pool.query(
    `SELECT DISTINCT r.node_id FROM document_revision r
     WHERE NOT EXISTS (SELECT 1 FROM scene_document sd WHERE sd.node_id = r.node_id) ORDER BY r.node_id`)).rows) {
    add("REVISION_ROW_WITHOUT_DOCUMENT", r.node_id);
  }

  // (b) The head equals its revision row.
  for (const r of (await pool.query(
    `SELECT sd.node_id FROM scene_document sd JOIN document_revision dr
       ON dr.node_id = sd.node_id AND dr.revision = sd.revision
     WHERE sd.document <> dr.document ORDER BY sd.node_id`)).rows) add("HEAD_DOCUMENT_MISMATCH", r.node_id);

  // (c) Attachment files exist and match hash and length.
  for (const r of (await pool.query("SELECT sha256, byte_length FROM attachment ORDER BY sha256")).rows) {
    let actual: { sha256: string; byteLength: number };
    try { actual = await hashFile(attachmentPath(attachmentsDir, r.sha256)); } catch {
      add("ATTACHMENT_FILE_MISSING", r.sha256);
      continue;
    }
    if (actual.sha256 !== r.sha256) add("ATTACHMENT_HASH_MISMATCH", r.sha256);
    else if (actual.byteLength !== Number(r.byte_length)) add("ATTACHMENT_LENGTH_MISMATCH", r.sha256);
  }

  // (d) No invalid indexes.
  for (const r of (await pool.query(
    `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid ORDER BY c.relname`)).rows) add("INVALID_INDEX", r.relname);

  return { ok: problems.length === 0, problems };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Write API for book overrides on facts, questions and timeline events
// (archive-format-v1, "Book overrides on records").
import { StudioError } from "./store.ts";
import type { Database } from "./store.ts";
import { inScope } from "./state-values.ts";
import { whenProblem } from "./record-overrides.ts";

export type OverrideKind = "facts" | "questions" | "events";
const table = {
  facts: "facts",
  questions: "questions",
  events: "continuity_events",
} as const;
const keys: Record<OverrideKind, string[]> = {
  facts: ["text", "truth"],
  questions: ["text", "status", "decision"],
  events: ["title", "summary", "when", "participants"],
};
const noun = { facts: "fact", questions: "question", events: "event" } as const;
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const stamp = (old?: string) =>
  new Date(Math.max(Date.now(), Date.parse(old ?? "") + 1 || 0)).toISOString();
const text = (v: any, min: number, what: string) => {
  if (typeof v !== "string" || v.length < min || [...v].length > 20000)
    invalid(
      `Use ${what} of ${min ? "1–20000 characters" : "at most 20000 characters"}.`,
    );
};

/**
 * Set and/or clear this book's override keys on one record.
 * Body: only keys valid for the record, plus `expectedUpdatedAt` and an
 * optional `clear` list of keys. Values replace, never remove (no nulls);
 * `clear` is the only way to drop a key. Same book->library lock order as
 * the canon saves.
 */
export async function saveRecordOverride(
  db: Database,
  kind: OverrideKind,
  bookId: string,
  id: string,
  input: any,
) {
  const valid = keys[kind];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => ![...valid, "clear", "expectedUpdatedAt"].includes(k),
    )
  )
    invalid(
      `Provide only ${noun[kind]} override values (${valid.join(", ")}).`,
    );
  const clear: string[] = input.clear ?? [];
  if (
    !Array.isArray(clear) ||
    clear.some((k) => typeof k !== "string" || !valid.includes(k)) ||
    new Set(clear).size !== clear.length
  )
    invalid(`Clear only these keys, once each: ${valid.join(", ")}.`);
  const set = valid.filter((k) => Object.hasOwn(input, k));
  if (set.some((k) => input[k] === null))
    invalid("An override cannot remove a value. Use clear to drop a key.");
  if (set.some((k) => clear.includes(k)))
    invalid("A key cannot be both set and cleared.");
  if (!set.length && !clear.length)
    invalid("Provide at least one override value to set or clear.");
  return db.transaction(async (q) => {
    const book = (
      await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
        bookId,
      ])
    ).rows[0];
    if (!book)
      throw new StudioError(404, "NOT_FOUND", "Book no longer exists.");
    await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
      book.library_id,
    ]);
    if (book.data.deletedAt)
      invalid(`Restore the book before editing ${noun[kind]} overrides.`);
    const data = (
      await q(`SELECT data FROM ${table[kind]} WHERE id=$1 AND library_id=$2`, [
        id,
        book.library_id,
      ])
    ).rows[0]?.data;
    if (!data || !inScope(data.scope, book.data))
      throw new StudioError(
        404,
        "NOT_FOUND",
        `${noun[kind][0].toUpperCase()}${noun[kind].slice(1)} is not visible here.`,
      );
    if (data.updatedAt !== input.expectedUpdatedAt)
      throw new StudioError(
        409,
        `${noun[kind].toUpperCase()}_CONFLICT`,
        `This ${noun[kind]} changed. Keep your draft and reopen ${kind}.`,
      );
    if (data.scope.kind === "book")
      invalid(
        "Only shared records can have book overrides. Edit this one directly.",
      );
    if (data.deletedAt)
      invalid(`Restore this ${noun[kind]} before editing its overrides.`);
    const parent = (
      await q(
        `SELECT data FROM ${data.scope.kind === "universe" ? "universes" : "series"} WHERE id=$1 AND library_id=$2`,
        [data.scope.id, book.library_id],
      )
    ).rows[0]?.data;
    if (!parent || parent.deletedAt)
      invalid(`Restore the ${noun[kind]} scope first.`);

    for (const k of set) {
      const v = input[k];
      if (k === "text") text(v, 1, `${noun[kind]} text`);
      else if (k === "decision") text(v, 0, "a decision");
      else if (k === "truth") {
        if (!["true", "false", "undecided"].includes(v))
          invalid("Use a valid truth.");
      } else if (k === "status") {
        if (!["open", "decided"].includes(v)) invalid("Use a valid status.");
      } else if (k === "title") {
        if (typeof v !== "string" || !v.length)
          invalid("Use a non-empty event title.");
      } else if (k === "summary") {
        if (typeof v !== "string") invalid("Use plain text for the summary.");
      } else if (k === "when") {
        const problem = whenProblem(v);
        if (problem) invalid(problem);
      } else if (k === "participants") {
        if (
          !Array.isArray(v) ||
          !v.length ||
          v.some(
            (p: any) =>
              !p ||
              typeof p !== "object" ||
              Array.isArray(p) ||
              typeof p.entryId !== "string" ||
              Object.keys(p).some((x) => !["entryId", "role"].includes(x)) ||
              (p.role !== undefined && typeof p.role !== "string"),
          ) ||
          new Set(v.map((p: any) => p.entryId)).size !== v.length
        )
          invalid(
            "Choose at least one unique participant with an optional plain-text role.",
          );
        const entries = (
          await q("SELECT data FROM bible_entries WHERE library_id=$1", [
            book.library_id,
          ])
        ).rows.map((r) => r.data);
        for (const p of v) {
          const e = entries.find((e) => e.id === p.entryId);
          if (!e || e.deletedAt || !inScope(e.scope, book.data))
            invalid("Choose live participants visible to this book.");
        }
      }
    }

    const overrides: any[] = [...(data.overrides ?? [])];
    const at = overrides.findIndex((o) => o.bookId === bookId);
    const entry: any = { ...(at < 0 ? { bookId } : overrides[at]) };
    for (const k of clear) delete entry[k];
    for (const k of set) entry[k] = input[k];
    const next = { ...data };
    const rest = overrides.filter((o) => o.bookId !== bookId);
    if (Object.keys(entry).some((k) => k !== "bookId"))
      rest.splice(at < 0 ? rest.length : at, 0, entry);
    if (rest.length) next.overrides = rest;
    else delete next.overrides;
    // Clearing keys that are not set changes nothing: keep the record and its updatedAt.
    if (JSON.stringify(next) === JSON.stringify(data)) return data;
    next.updatedAt = stamp(data.updatedAt);
    await q(`UPDATE ${table[kind]} SET data=$2 WHERE id=$1`, [id, next]);
    return next;
  });
}

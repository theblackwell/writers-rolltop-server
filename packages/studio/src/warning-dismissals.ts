// SPDX-License-Identifier: AGPL-3.0-only
import { StudioError } from "./store.ts";
import type { Database } from "./store.ts";
import { readContinuitySnapshot, continuityResult } from "./continuity.ts";
import { continuityWarnings } from "./continuity-values.ts";
import { inScope } from "./state-values.ts";
const invalid = (s: string): never => {
  throw new StudioError(400, "INVALID_INPUT", s);
};
export async function changeWarningDismissal(
  db: Database,
  bookId: string,
  input: any,
) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "subjectKind",
          "subjectId",
          "key",
          "note",
          "restore",
          "expectedUpdatedAt",
          "editSharedCanon",
        ].includes(k),
    )
  )
    invalid("Provide only the warning, subject version and optional note.");
  if (
    !["fact", "question", "event"].includes(input.subjectKind) ||
    typeof input.subjectId !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.subjectId)
  )
    invalid("Choose a valid warning subject.");
  if (
    typeof input.key !== "string" ||
    input.key.length > 400 ||
    !/^[A-Za-z]+(:[0-9A-Za-z-]+)*$(?![\s\S])/.test(input.key)
  )
    invalid("Choose a valid continuity warning key.");
  if (input.restore !== undefined && typeof input.restore !== "boolean")
    invalid("Choose whether to show this warning again.");
  if (
    input.note !== undefined &&
    input.note !== null &&
    typeof input.note !== "string"
  )
    invalid("Use a plain-text note.");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if ([...note].length > 2000)
    invalid("Use a note of at most 2,000 characters.");
  if (input.restore && Object.hasOwn(input, "note"))
    invalid("Restore the warning separately from editing its note.");
  if (
    typeof input.expectedUpdatedAt !== "string" ||
    (input.editSharedCanon !== undefined &&
      typeof input.editSharedCanon !== "boolean")
  )
    invalid("Provide the saved subject version and explicit shared consent.");
  return db.transaction(async (q) => {
    const s = await readContinuitySnapshot(q, bookId);
    const collection =
      input.subjectKind === "fact"
        ? s.facts
        : input.subjectKind === "question"
          ? s.questions
          : s.events;
    const owner = collection.find(
      (r) =>
        r.id === input.subjectId && !r.deletedAt && inScope(r.scope, s.book),
    );
    if (!owner)
      throw new StudioError(
        404,
        "NOT_FOUND",
        "That warning subject is not visible here.",
      );
    if (owner.updatedAt !== input.expectedUpdatedAt)
      throw new StudioError(
        409,
        "WARNING_CONFLICT",
        "This record changed. Keep your note and check warnings again before marking it.",
      );
    if (owner.scope.kind !== "book" && input.editSharedCanon !== true)
      invalid(
        "Confirm changing this shared record's warning for all books in its scope.",
      );
    const existing = owner.dismissedWarnings ?? [];
    if (input.restore) {
      if (!existing.some((d: any) => d.warning === input.key))
        throw new StudioError(
          409,
          "WARNING_CHANGED",
          "This warning is no longer marked intentional. Check warnings again.",
        );
    } else if (
      !continuityWarnings(s).some(
        (w) =>
          w.subject.id === owner.id &&
          w.subject.kind === input.subjectKind &&
          w.key === input.key,
      )
    )
      throw new StudioError(
        409,
        "WARNING_CHANGED",
        "This warning no longer applies. Keep your note and check warnings again.",
      );
    const stamp = new Date(
      Math.max(Date.now(), Date.parse(owner.updatedAt) + 1),
    ).toISOString();
    const next = existing.filter((d: any) => d.warning !== input.key);
    if (!input.restore)
      next.push({
        warning: input.key,
        ...(note ? { note } : {}),
        dismissedAt: stamp,
      });
    if (next.length) owner.dismissedWarnings = next;
    else delete owner.dismissedWarnings;
    owner.updatedAt = stamp;
    const table =
      input.subjectKind === "fact"
        ? "facts"
        : input.subjectKind === "question"
          ? "questions"
          : "continuity_events";
    await q(`UPDATE ${table} SET data=$2 WHERE id=$1`, [owner.id, owner]);
    return continuityResult(s);
  });
}

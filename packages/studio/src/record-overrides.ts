// SPDX-License-Identifier: AGPL-3.0-only
// Book overrides on facts, questions and timeline events (archive-format-v1, "Book overrides on records").

/** True when the record has a book override for this book. */
export function hasRecordOverride(record: any, bookId: string): boolean {
  return (record.overrides ?? []).some((o: any) => o.bookId === bookId);
}

/**
 * Remove one book's override. The format has no empty arrays, so the
 * `overrides` key goes when nothing is left. Shared fields are untouched.
 */
export function withoutRecordOverride(record: any, bookId: string): any {
  if (!hasRecordOverride(record, bookId)) return record;
  const next = { ...record };
  const rest = record.overrides.filter((o: any) => o.bookId !== bookId);
  if (rest.length) next.overrides = rest;
  else delete next.overrides;
  return next;
}

/**
 * Drop purged entries from event overrides' participants. An override whose
 * only other keys were participants is removed, as entry overrides are.
 */
export function withoutOverrideParticipants(
  record: any,
  entries: string[],
): any {
  const hit = (record.overrides ?? []).some((o: any) =>
    (o.participants ?? []).some((p: any) => entries.includes(p.entryId)),
  );
  if (!hit) return record;
  const overrides = record.overrides.flatMap((o: any) => {
    if (!o.participants) return [o];
    const participants = o.participants.filter(
      (p: any) => !entries.includes(p.entryId),
    );
    if (participants.length) return [{ ...o, participants }];
    const { participants: _gone, ...rest } = o;
    return Object.keys(rest).some((k) => k !== "bookId") ? [rest] : [];
  });
  const next = { ...record };
  if (overrides.length) next.overrides = overrides;
  else delete next.overrides;
  return next;
}

/** Same story-date rule as the top-level event `when`. Throws a message for the caller to wrap. */
export function whenProblem(w: any): string | undefined {
  if (
    !w ||
    typeof w !== "object" ||
    Array.isArray(w) ||
    Object.keys(w).some((k) => !["label", "calendar", "ordinal"].includes(k)) ||
    typeof w.label !== "string" ||
    !w.label.length ||
    (w.calendar !== undefined &&
      (typeof w.calendar !== "string" || !w.calendar.length)) ||
    (w.ordinal !== undefined && !Number.isSafeInteger(w.ordinal))
  )
    return "Use a story date label, optional calendar and safe whole-number ordinal.";
}

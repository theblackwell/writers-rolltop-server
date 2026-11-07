import { AttachmentField } from "./attachments.tsx";
// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { ScalarForm } from "./entry-fields.tsx";
import { StructuredForm, structuredSummary } from "./structured-fields.tsx";
import {
  ReferenceField,
  referenceSummary,
  referenceTypes,
} from "./reference-field.tsx";
import { structuredTypes } from "../../../packages/studio/src/structured-values.ts";
import {
  inScope,
  eventInStory,
  stateFieldTypes,
} from "../../../packages/studio/src/state-values.ts";
import { scopeAllowsTarget } from "../../../packages/studio/src/scope-values.ts";
import type { Entry } from "./entries.tsx";
import type { Field } from "./entry-fields.tsx";
export function placeTitle(c: any, change: any) {
  if (!change) return "Unavailable point";
  if (change.nodeId) {
    const n = c.nodes.find((n: any) => n.id === change.nodeId);
    return n
      ? (c.books.find((b: any) => b.id === n.bookId)?.title ??
          "Unavailable book") +
          " › " +
          n.title +
          (n.inTrash ? " (in Trash)" : "")
      : "Unavailable chapter or scene";
  }
  const e = c.events.find((e: any) => e.id === change.eventId);
  return e
    ? "Event: " +
        (e.title || "Untitled event") +
        (e.deletedAt ? " (in Trash)" : "")
    : "Unavailable event";
}
export function valueTitle(f: Field, v: any, entries: Entry[]) {
  return referenceTypes.includes(f.fieldType)
    ? referenceSummary(v, entries)
    : structuredSummary(f, v);
}
export function StateChangeForm({
  catalog,
  entry,
  change,
  mode,
  canon,
  busy,
  onCancel,
  onSave,
}: {
  catalog: any;
  entry: any;
  change?: any;
  mode: "edit" | "trash" | "restore";
  /** The entry page is already in canon mode, so no separate confirmation. */
  canon?: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (v: object) => Promise<void>;
}) {
  const fields = catalog.fields.filter(
    (f: Field) =>
      f.templateId === entry.templateId &&
      !f.deletedAt &&
      stateFieldTypes.includes(f.fieldType),
  );
  const [fieldId, setFieldId] = useState(
      change?.fieldId ?? fields[0]?.id ?? "",
    ),
    [place, setPlace] = useState(change?.eventId ? "event" : "node"),
    [nodeId, setNodeId] = useState(change?.nodeId ?? ""),
    [eventId, setEventId] = useState(change?.eventId ?? ""),
    [note, setNote] = useState(change?.note ?? ""),
    [hasNote, setHasNote] = useState(change?.note !== undefined),
    [ack, setAck] = useState(false),
    [error, setError] = useState("");
  const field = fields.find((f: Field) => f.id === fieldId),
    shared = entry.scope.kind !== "book";
  const nodes = catalog.nodes.filter(
    (n: any) =>
      ["chapter", "scene"].includes(n.kind) &&
      inScope(
        entry.scope,
        catalog.books.find((b: any) => b.id === n.bookId) ?? {},
      ),
  );
  const events = catalog.events.filter(
    (e: any) =>
      eventInStory(e, entry, catalog.books) &&
      (!e.deletedAt || e.id === eventId),
  );
  const validPoint =
    place === "node"
      ? nodes.some((n: any) => n.id === nodeId)
      : events.some((e: any) => e.id === eventId && !e.deletedAt);
  const confirmed = !!canon || ack;
  const gated =
    busy ||
    (shared && !confirmed) ||
    (mode === "edit" && (!field || !validPoint));
  const save = async (value: unknown) => {
    if (gated) return;
    if (value === null) {
      setError("A change needs a value; use Trash to remove a change.");
      return;
    }
    setError("");
    await onSave({
      entryId: entry.id,
      fieldId,
      value,
      nodeId: place === "node" ? nodeId : null,
      eventId: place === "event" ? eventId : null,
      note: hasNote ? note : null,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
      ...(shared ? { editSharedCanon: true } : {}),
    });
  };
  const targetWorld =
    entry.scope.kind === "series"
      ? catalog.books.find((b: any) => b.seriesId === entry.scope.id)
          ?.universeId
      : undefined;
  const candidates = catalog.entries.filter((e: any) =>
    scopeAllowsTarget(entry, e, catalog.book, targetWorld),
  );
  return (
    <section
      aria-label={
        mode === "edit"
          ? "State Change Form"
          : mode === "trash"
            ? "Move Change to Trash"
            : "Restore Change"
      }
    >
      <h3>
        {mode === "edit"
          ? change
            ? "Edit Change"
            : "Add Change"
          : mode === "trash"
            ? "Move Change to Trash"
            : "Restore Change"}
      </h3>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy}>
        {mode === "edit" ? (
          <>
            <label>
              Field
              <select
                value={fieldId}
                onChange={(e) => setFieldId(e.target.value)}
              >
                {!fields.some((f: Field) => f.id === fieldId) && (
                  <option value={fieldId}>Unavailable saved field</option>
                )}
                {fields.map((f: Field) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Change from
              <select value={place} onChange={(e) => setPlace(e.target.value)}>
                <option value="node">Chapter or scene</option>
                <option value="event">Timeline event</option>
              </select>
            </label>
            {place === "node" ? (
              <label>
                From chapter or scene
                <select
                  value={nodeId}
                  onChange={(e) => setNodeId(e.target.value)}
                >
                  <option value="">Choose a chapter or scene</option>
                  {nodeId && !nodes.some((n: any) => n.id === nodeId) && (
                    <option value={nodeId}>
                      {placeTitle(catalog, { nodeId })} · outside entry scope
                    </option>
                  )}
                  {nodes.map((n: any) => (
                    <option
                      key={n.id}
                      value={n.id}
                      disabled={n.inTrash && n.id !== nodeId}
                    >
                      {placeTitle(catalog, { nodeId: n.id })}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                From event
                <select
                  value={eventId}
                  onChange={(e) => setEventId(e.target.value)}
                >
                  <option value="">Choose an event</option>
                  {eventId && !events.some((e: any) => e.id === eventId) && (
                    <option value={eventId}>
                      {placeTitle(catalog, { eventId })} · unavailable here
                    </option>
                  )}
                  {events.map((e: any) => (
                    <option key={e.id} value={e.id} disabled={!!e.deletedAt}>
                      {placeTitle(catalog, { eventId: e.id })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="entry-toggle">
              <input
                type="checkbox"
                checked={hasNote}
                onChange={(e) => setHasNote(e.target.checked)}
              />
              Include a note
            </label>
            {hasNote && (
              <label>
                Note
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            )}
            {!validPoint && (
              <p>
                Choose a valid point. Saved unavailable points remain until you
                replace them.
              </p>
            )}
          </>
        ) : (
          <p>{placeTitle(catalog, change)}</p>
        )}
        {shared && !canon && (
          <label className="entry-toggle" style={{ margin: "1rem 0" }}>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            Apply this state change to the shared entry for all books in its
            scope
          </label>
        )}
      </fieldset>
      {mode !== "edit" ? (
        <>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel Change
          </button>
          <button
            disabled={gated}
            onClick={() =>
              void onSave({
                deleted: mode === "trash",
                ...(shared ? { editSharedCanon: true } : {}),
              })
            }
          >
            {mode === "trash" ? "Move Change to Trash" : "Restore Change"}
          </button>
        </>
      ) : field ? (
        field.fieldType === "attachment" ? (
          <AttachmentField
            bookId={catalog.book.id}
            value={change?.fieldId === fieldId ? change.value : undefined}
            busy={gated}
            allowClear={false}
            onCancel={onCancel}
            onSave={save}
          />
        ) : referenceTypes.includes(field.fieldType) ? (
          <ReferenceField
            key={fieldId}
            field={field}
            value={change?.fieldId === fieldId ? change.value : undefined}
            entries={candidates}
            busy={gated}
            allowClear={false}
            onCancel={onCancel}
            onSave={save}
          />
        ) : structuredTypes.includes(field.fieldType) ? (
          <StructuredForm
            key={fieldId}
            field={field}
            value={change?.fieldId === fieldId ? change.value : undefined}
            busy={gated}
            allowClear={false}
            onCancel={onCancel}
            onSave={save}
          />
        ) : (
          <ScalarForm
            key={fieldId}
            field={field}
            value={change?.fieldId === fieldId ? change.value : undefined}
            busy={gated}
            allowClear={false}
            onCancel={onCancel}
            onSave={save}
          />
        )
      ) : (
        <button type="button" onClick={onCancel}>
          Cancel Change
        </button>
      )}
      {mode === "edit" && gated && (
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel Change
        </button>
      )}
    </section>
  );
}

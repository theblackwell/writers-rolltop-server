// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
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
  orderedChanges,
  resolveState,
  stateFieldTypes,
} from "../../../packages/studio/src/state-values.ts";
import { scopeAllowsTarget } from "../../../packages/studio/src/scope-values.ts";
import type { Entry } from "./entries.tsx";
import type { Field } from "./entry-fields.tsx";
export function StateChanges({ bookId }: { bookId: string }) {
  const [catalog, setCatalog] = useState<any>(),
    [entryId, setEntryId] = useState(""),
    [asOf, setAsOf] = useState(""),
    [trash, setTrash] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState<{
      change?: any;
      mode: "edit" | "trash" | "restore";
    }>();
  useEffect(() => {
    let live = true;
    api("/books/" + bookId + "/state-changes")
      .then((c) => {
        if (live) {
          setCatalog(c);
          setEntryId(
            c.entries.find((e: any) => inScope(e.scope, c.book) && !e.deletedAt)
              ?.id ?? "",
          );
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId]);
  const entry = catalog?.entries.find((e: any) => e.id === entryId);
  const fields =
    catalog?.fields.filter(
      (f: Field) => f.templateId === entry?.templateId && !f.deletedAt,
    ) ?? [];
  const describe = (c: any) => {
    const f = catalog.fields.find((f: Field) => f.id === c.fieldId);
    return f ? valueTitle(f, c.value, catalog.entries) : "Unavailable field";
  };
  async function save(value: object) {
    setBusy(true);
    setError("");
    try {
      const c = edit?.change,
        result = await api(
          "/books/" + bookId + "/state-changes" + (c ? "/" + c.id : ""),
          c ? "PUT" : "POST",
          { ...value, ...(c ? { expectedUpdatedAt: c.updatedAt } : {}) },
        );
      setCatalog((old: any) => ({
        ...old,
        stateChanges: c
          ? old.stateChanges.map((x: any) => (x.id === c.id ? result : x))
          : [...old.stateChanges, result],
      }));
      setEdit(undefined);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "This change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Changing State">
      <p>
        Record a field taking a new value from an event, chapter or scene
        onward. Earlier books apply before this book's override and its own
        changes. Prose and canon stay as saved.
      </p>
      {error && <p role="alert">{error}</p>}
      {!catalog ? (
        <p>Loading…</p>
      ) : (
        <>
          <label>
            Entry
            <select
              value={entryId}
              disabled={!!edit || busy}
              onChange={(e) => {
                setEntryId(e.target.value);
                setError("");
              }}
            >
              <option value="">Choose an entry</option>
              {catalog.entries
                .filter((e: any) => inScope(e.scope, catalog.book))
                .map((e: any) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.deletedAt ? " (in Trash)" : ""}
                  </option>
                ))}
            </select>
          </label>
          {entry &&
            (edit ? (
              <StateChangeForm
                key={(edit.change?.id ?? "new") + edit.mode}
                catalog={catalog}
                entry={entry}
                change={edit.change}
                mode={edit.mode}
                busy={busy}
                onCancel={() => {
                  setEdit(undefined);
                  setError("");
                }}
                onSave={save}
              />
            ) : (
              <>
                <h3>As of</h3>
                <label>
                  As of chapter or scene
                  <select
                    value={asOf}
                    onChange={(e) => setAsOf(e.target.value)}
                  >
                    <option value="">Current book values</option>
                    {catalog.nodes
                      .filter(
                        (n: any) =>
                          n.bookId === bookId &&
                          !n.inTrash &&
                          ["chapter", "scene"].includes(n.kind),
                      )
                      .map((n: any) => (
                        <option key={n.id} value={n.id}>
                          {n.title}
                        </option>
                      ))}
                  </select>
                </label>
                <ul className="search-results">
                  {fields.map((f: Field) => {
                    const resolved = resolveState(
                      entry,
                      f.id,
                      bookId,
                      asOf,
                      catalog,
                    );
                    return (
                      <li key={f.id}>
                        <strong>{f.label}</strong>
                        <p style={{ whiteSpace: "pre-wrap" }}>
                          {resolved.value === undefined
                            ? "Not set"
                            : valueTitle(f, resolved.value, catalog.entries)}
                        </p>
                        <p>
                          {resolved.source === "change"
                            ? "Set by change at " +
                              placeTitle(
                                catalog,
                                catalog.stateChanges.find(
                                  (c: any) => c.id === resolved.changeId,
                                ),
                              )
                            : resolved.source === "override"
                              ? "This book's override"
                              : "Shared canon"}
                        </p>
                      </li>
                    );
                  })}
                </ul>
                {!fields.length && (
                  <p>
                    Assign a template with fields in Bible Entries before adding
                    changes.
                  </p>
                )}
                <h3>Changes over the story</h3>
                <button
                  disabled={
                    !!entry.deletedAt ||
                    !fields.some((f: Field) =>
                      stateFieldTypes.includes(f.fieldType),
                    )
                  }
                  onClick={() => {
                    setError("");
                    setEdit({ mode: "edit" });
                  }}
                >
                  Add Change…
                </button>
                <label className="entry-toggle">
                  <input
                    type="checkbox"
                    checked={trash}
                    onChange={(e) => setTrash(e.target.checked)}
                  />
                  Show State Change Trash
                </label>
                <ul className="search-results">
                  {(trash
                    ? catalog.stateChanges.filter(
                        (c: any) => c.entryId === entryId && c.deletedAt,
                      )
                    : orderedChanges(entry, catalog).map((x: any) => x.change)
                  ).map((c: any) => (
                    <li key={c.id}>
                      <strong>
                        {catalog.fields.find((f: Field) => f.id === c.fieldId)
                          ?.label ?? "Unavailable field"}{" "}
                        → {describe(c)}
                      </strong>
                      <p>
                        {placeTitle(catalog, c)}
                        {c.note !== undefined ? " · " + c.note : ""}
                      </p>
                      {!c.deletedAt && (
                        <button
                          onClick={() => {
                            setError("");
                            setEdit({ change: c, mode: "edit" });
                          }}
                        >
                          Edit Change…
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setError("");
                          setEdit({
                            change: c,
                            mode: c.deletedAt ? "restore" : "trash",
                          });
                        }}
                      >
                        {c.deletedAt
                          ? "Restore Change…"
                          : "Move Change to Trash…"}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ))}
        </>
      )}
    </section>
  );
}
function placeTitle(c: any, change: any) {
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
function valueTitle(f: Field, v: any, entries: Entry[]) {
  return referenceTypes.includes(f.fieldType)
    ? referenceSummary(v, entries)
    : structuredSummary(f, v);
}
export function StateChangeForm({
  catalog,
  entry,
  change,
  mode,
  busy,
  onCancel,
  onSave,
}: {
  catalog: any;
  entry: any;
  change?: any;
  mode: "edit" | "trash" | "restore";
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
  const gated =
    busy || (shared && !ack) || (mode === "edit" && (!field || !validPoint));
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
        {shared && (
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
        referenceTypes.includes(field.fieldType) ? (
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

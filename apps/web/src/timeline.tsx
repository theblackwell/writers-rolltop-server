// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { orderedEvents } from "../../../packages/studio/src/timeline-order.ts";
export type TimelineEvent = {
  id: string;
  scope: { kind: string; id: string };
  title: string;
  summary?: string;
  when?: { label: string; calendar?: string; ordinal?: number };
  entryId?: string;
  sceneIds: string[];
  participants: { entryId: string; role?: string }[];
  orderKey: string;
  updatedAt: string;
  deletedAt?: string;
};
export type TimelineEventCatalog = {
  readingPositions: Record<string, number>;
  book: any;
  scopes: { kind: string; id: string; title: string }[];
  events: TimelineEvent[];
  entries: {
    id: string;
    name: string;
    entryType: string;
    scope: { kind: string; id: string };
    scopeTitle?: string;
    deletedAt?: string;
  }[];
  books: {
    id: string;
    title: string;
    universeId?: string;
    seriesId?: string;
    deletedAt?: string;
  }[];
  nodes: {
    id: string;
    bookId: string;
    title: string;
    kind: string;
    inTrash: boolean;
  }[];
};
export function Timeline({
  bookId,
  initialId,
}: {
  bookId: string;
  initialId?: string;
}) {
  const [byReading, setByReading] = useState(false);
  const [catalog, setCatalog] = useState<TimelineEventCatalog>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [trash, setTrash] = useState(false);
  const [edit, setEdit] = useState<{
    event?: TimelineEvent;
    mode: "edit" | "trash" | "restore";
  }>();
  useEffect(() => {
    let live = true;
    api<TimelineEventCatalog>(`/books/${bookId}/events`)
      .then((c) => {
        if (live) {
          setCatalog(c);
          if (initialId) {
            const target = c.events.find((r) => r.id === initialId);
            if (target && !target.deletedAt)
              setEdit({ event: target, mode: "edit" });
            else {
              setTrash(!!target?.deletedAt);
              setError(
                "This record is no longer live here. Review its Trash or reopen continuity.",
              );
            }
          }
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId, initialId]);
  function open(value: typeof edit) {
    setError("");
    setEdit(value);
  }
  async function save(value: object) {
    setBusy(true);
    setError("");
    try {
      const f = edit?.event;
      const result = await api<TimelineEvent>(
        `/books/${bookId}/events${f ? `/${f.id}` : ""}`,
        f ? "PUT" : "POST",
        { ...value, ...(f ? { expectedUpdatedAt: f.updatedAt } : {}) },
      );
      setCatalog((c) =>
        c
          ? {
              ...c,
              events: f
                ? c.events.map((old) => (old.id === f.id ? result : old))
                : [...c.events, result],
            }
          : c,
      );
      setEdit(undefined);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The event could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Timeline">
      <p>
        Record story events and where the reader meets them. Shared events apply
        across their world or series.
      </p>
      {error && <p role="alert">{error}</p>}
      {!catalog ? (
        <p>Loading…</p>
      ) : edit ? (
        <TimelineEventForm
          key={(edit.event?.id ?? "new") + edit.mode}
          catalog={catalog}
          event={edit.event}
          mode={edit.mode}
          busy={busy}
          onCancel={() => open(undefined)}
          onSave={save}
        />
      ) : (
        <>
          <button disabled={busy} onClick={() => open({ mode: "edit" })}>
            New Event…
          </button>
          <label style={{ display: "block", marginTop: "1rem" }}>
            Order
            <select
              value={byReading ? "reading" : "story"}
              onChange={(e) => setByReading(e.target.value === "reading")}
            >
              <option value="story">Story Date</option>
              <option value="reading">Reading Order</option>
            </select>
          </label>
          <p>
            Story Date uses the order number, with undated events last. Reading
            Order uses the earliest live scene in this book, with unplaced
            events last.
          </p>
          <label className="entry-toggle">
            <input
              type="checkbox"
              checked={trash}
              onChange={(e) => setTrash(e.target.checked)}
            />
            Show Event Trash
          </label>
          <ul className="search-results">
            {orderedEvents(
              catalog.events.filter((f) => !!f.deletedAt === trash),
              catalog.readingPositions,
              byReading,
            ).map((f) => (
              <li key={f.id}>
                <strong style={{ whiteSpace: "pre-wrap" }}>
                  {f.title || "Untitled event"}
                </strong>
                <p>
                  {scopeTitle(catalog, f.scope)} ·{" "}
                  {f.when?.label ?? "Not dated"}
                  {f.when?.calendar ? " (" + f.when.calendar + ")" : ""}
                </p>
                {f.summary !== undefined && (
                  <p style={{ whiteSpace: "pre-wrap" }}>{f.summary}</p>
                )}
                {f.sceneIds.map((id) => (
                  <p key={id}>Appears in: {pointTitle(catalog, id)}</p>
                ))}
                {!f.deletedAt && (
                  <button
                    aria-label={`Edit event ${f.title || "Untitled event"}`}
                    onClick={() => open({ event: f, mode: "edit" })}
                  >
                    Edit Event…
                  </button>
                )}
                <button
                  aria-label={`${f.deletedAt ? "Restore" : "Trash"} event ${f.title || "Untitled event"}`}
                  onClick={() =>
                    open({
                      event: f,
                      mode: f.deletedAt ? "restore" : "trash",
                    })
                  }
                >
                  {f.deletedAt ? "Restore Event…" : "Move Event to Trash…"}
                </button>
              </li>
            ))}
          </ul>
          {!catalog.events.some((f) => !!f.deletedAt === trash) && (
            <p>{trash ? "No events in Trash." : "No events yet."}</p>
          )}
        </>
      )}
    </section>
  );
}
function scopeTitle(c: TimelineEventCatalog, s: TimelineEvent["scope"]) {
  return (
    c.scopes.find((x) => x.id === s.id && x.kind === s.kind)?.title ??
    (s.kind === "book" ? "Book" : "Unavailable shared scope")
  );
}
function entryTitle(c: TimelineEventCatalog, id: string) {
  const e = c.entries.find((x) => x.id === id);
  if (!e) return `Unavailable entry (${id})`;
  const scope =
    e.scopeTitle ??
    (e.scope.kind === "book"
      ? `Book: ${c.books.find((b) => b.id === e.scope.id)?.title ?? e.scope.id}`
      : e.scope.kind === "universe"
        ? "Shared world"
        : "Shared series");
  return `${e.name} (${e.entryType}; ${scope}${e.deletedAt ? "; in Trash" : ""})`;
}
function pointTitle(c: TimelineEventCatalog, id: string) {
  const n = c.nodes.find((x) => x.id === id);
  return n
    ? `${c.books.find((b) => b.id === n.bookId)?.title ?? "Unavailable book"} › ${n.title}${n.inTrash ? " (in Trash)" : ""}`
    : `Unavailable scene (${id})`;
}
export function TimelineEventForm({
  catalog,
  event,
  mode,
  busy,
  onCancel,
  onSave,
}: {
  catalog: TimelineEventCatalog;
  event?: TimelineEvent;
  mode: "edit" | "trash" | "restore";
  busy: boolean;
  onCancel: () => void;
  onSave: (value: object) => Promise<void>;
}) {
  const [title, setTitle] = useState(event?.title ?? ""),
    [summary, setSummary] = useState(event?.summary ?? ""),
    [hasSummary, setHasSummary] = useState(event?.summary !== undefined),
    [date, setDate] = useState(event?.when?.label ?? ""),
    [calendar, setCalendar] = useState(event?.when?.calendar ?? ""),
    [ordinal, setOrdinal] = useState(event?.when?.ordinal?.toString() ?? ""),
    [hasDate, setHasDate] = useState(event?.when !== undefined),
    [entry, setEntry] = useState(event?.entryId ?? ""),
    [kind, setKind] = useState(event?.scope.kind ?? "book"),
    [scenes, setScenes] = useState(event?.sceneIds ?? []),
    [participants, setParticipants] = useState(event?.participants ?? []),
    [addScene, setAddScene] = useState(""),
    [addParticipant, setAddParticipant] = useState(""),
    [ack, setAck] = useState(false);
  const scope = event?.scope ?? catalog.scopes.find((s) => s.kind === kind),
    shared = kind !== "book";
  const scopedScenes = catalog.nodes.filter((n) => {
    const b = catalog.books.find((b) => b.id === n.bookId);
    return (
      b &&
      scope &&
      n.kind === "scene" &&
      (scope.kind === "book"
        ? b.id === scope.id
        : scope.kind === "universe"
          ? b.universeId === scope.id
          : b.seriesId === scope.id)
    );
  });
  const invalidScene = scenes.some(
    (id) => !scopedScenes.some((n) => n.id === id),
  );
  const invalidDate =
    hasDate &&
    (!date.length ||
      (ordinal !== "" &&
        (!/^-?\d+$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)))));
  const unavailableEntry =
    !!entry &&
    !catalog.entries.some((e) => e.id === entry && e.entryType === "event");
  const unavailableParticipant = participants.some(
    (p) => !catalog.entries.some((e) => e.id === p.entryId),
  );
  const invalid =
    busy ||
    !scope ||
    (shared && !ack) ||
    (mode === "edit" &&
      (invalidScene ||
        invalidDate ||
        unavailableEntry ||
        unavailableParticipant));
  const heading =
    mode === "edit"
      ? event
        ? "Edit Event"
        : "New Event"
      : mode === "trash"
        ? "Move Event to Trash"
        : "Restore Event";
  return (
    <form
      aria-label={heading}
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        void onSave(
          mode !== "edit"
            ? {
                deleted: mode === "trash",
                ...(shared ? { editSharedCanon: true } : {}),
              }
            : {
                title,
                summary: hasSummary ? summary : null,
                when: hasDate
                  ? {
                      label: date,
                      ...(calendar ? { calendar } : {}),
                      ...(ordinal !== "" ? { ordinal: Number(ordinal) } : {}),
                    }
                  : null,
                entryId: entry || null,
                sceneIds: scenes,
                participants,
                ...(event
                  ? shared
                    ? { editSharedCanon: true }
                    : {}
                  : { scopeKind: kind }),
              },
        );
      }}
    >
      <h3>{heading}</h3>
      <fieldset disabled={busy}>
        {mode === "edit" ? (
          <>
            <label>
              Event
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="entry-toggle">
              <input
                type="checkbox"
                checked={hasSummary}
                onChange={(e) => setHasSummary(e.target.checked)}
              />
              Include a summary
            </label>
            {hasSummary && (
              <label>
                Summary
                <textarea
                  rows={3}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </label>
            )}
            {event ? (
              <p>Scope: {scopeTitle(catalog, event.scope)}</p>
            ) : (
              <label>
                Scope
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setAddScene("");
                  }}
                >
                  {catalog.scopes.map((s) => (
                    <option key={s.kind} value={s.kind}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Event entry
              <select value={entry} onChange={(e) => setEntry(e.target.value)}>
                <option value="">None</option>
                {entry &&
                  !catalog.entries.some(
                    (e) => e.id === entry && e.entryType === "event",
                  ) && (
                    <option value={entry}>
                      {entryTitle(catalog, entry)} · unavailable event entry
                    </option>
                  )}
                {catalog.entries
                  .filter(
                    (e) =>
                      e.entryType === "event" &&
                      (!e.deletedAt || e.id === entry),
                  )
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {entryTitle(catalog, e.id)}
                    </option>
                  ))}
              </select>
            </label>
            <h4>Story date</h4>
            <label className="entry-toggle">
              <input
                type="checkbox"
                checked={hasDate}
                onChange={(e) => setHasDate(e.target.checked)}
              />
              Include a story date
            </label>
            {hasDate && (
              <>
                <label>
                  As written
                  <input
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <label>
                  Calendar
                  <input
                    value={calendar}
                    onChange={(e) => setCalendar(e.target.value)}
                  />
                </label>
                <label>
                  Order number
                  <input
                    inputMode="numeric"
                    value={ordinal}
                    onChange={(e) => setOrdinal(e.target.value)}
                  />
                </label>
                <p>
                  The optional whole number sorts story dates. It must be within
                  ±9,007,199,254,740,991.
                </p>
              </>
            )}
            {invalidDate && (
              <p role="alert">
                Enter a date label and a valid whole-number order, or clear
                Include a story date.
              </p>
            )}
            <h4>Appears in</h4>
            {!scenes.length && <p>Not placed in a scene yet.</p>}
            <ul>
              {scenes.map((id) => (
                <li key={id}>
                  {pointTitle(catalog, id)}
                  {!scopedScenes.some((n) => n.id === id)
                    ? " · outside selected scope"
                    : ""}{" "}
                  <button
                    type="button"
                    aria-label={"Remove scene " + pointTitle(catalog, id)}
                    onClick={() => setScenes(scenes.filter((x) => x !== id))}
                  >
                    Remove Scene
                  </button>
                </li>
              ))}
            </ul>
            <label>
              Add scene
              <select
                value={addScene}
                onChange={(e) => setAddScene(e.target.value)}
              >
                <option value="">Choose a scene</option>
                {scopedScenes
                  .filter((n) => !n.inTrash && !scenes.includes(n.id))
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {pointTitle(catalog, n.id)}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!addScene}
              onClick={() => {
                setScenes([...scenes, addScene]);
                setAddScene("");
              }}
            >
              Add Scene
            </button>
            {invalidScene && (
              <p role="alert">
                A saved scene is outside the selected scope. Remove it
                explicitly or restore the scope; your selections have been kept.
              </p>
            )}
            <h4>Who's involved</h4>
            <ul>
              {participants.map((p) => (
                <li key={p.entryId}>
                  <p>{entryTitle(catalog, p.entryId)}</p>
                  <label>
                    {"Role for " + entryTitle(catalog, p.entryId)}
                    <input
                      value={p.role ?? ""}
                      onChange={(e) =>
                        setParticipants(
                          participants.map((x) =>
                            x.entryId === p.entryId
                              ? { ...x, role: e.target.value }
                              : x,
                          ),
                        )
                      }
                    />
                  </label>
                  {p.role !== undefined && (
                    <button
                      type="button"
                      aria-label={
                        "Clear role for " + entryTitle(catalog, p.entryId)
                      }
                      onClick={() =>
                        setParticipants(
                          participants.map((x) => {
                            if (x.entryId !== p.entryId) return x;
                            const { role, ...rest } = x;
                            return rest;
                          }),
                        )
                      }
                    >
                      Clear Role
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={
                      "Remove participant " + entryTitle(catalog, p.entryId)
                    }
                    onClick={() =>
                      setParticipants(
                        participants.filter((x) => x.entryId !== p.entryId),
                      )
                    }
                  >
                    Remove Participant
                  </button>
                </li>
              ))}
            </ul>
            <label>
              Add participant
              <select
                value={addParticipant}
                onChange={(e) => setAddParticipant(e.target.value)}
              >
                <option value="">Choose an entry</option>
                {catalog.entries
                  .filter(
                    (e) =>
                      !e.deletedAt &&
                      !participants.some((p) => p.entryId === e.id),
                  )
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {entryTitle(catalog, e.id)}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!addParticipant}
              onClick={() => {
                setParticipants([...participants, { entryId: addParticipant }]);
                setAddParticipant("");
              }}
            >
              Add Participant
            </button>
            {(unavailableEntry || unavailableParticipant) && (
              <p role="alert">
                A saved entry is unavailable. Clear its link explicitly before
                saving; your selections have been kept.
              </p>
            )}
          </>
        ) : (
          <p style={{ whiteSpace: "pre-wrap" }}>
            {event?.title || "Untitled event"}
          </p>
        )}
        {shared && (
          <label className="entry-toggle" style={{ margin: "1rem 0" }}>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {event
              ? "Apply this change to the shared event for all books in its scope"
              : "Create this shared event for all books in its scope"}
          </label>
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button disabled={invalid}>
          {mode === "edit" ? "Save Event" : heading}
        </button>
      </fieldset>
    </form>
  );
}

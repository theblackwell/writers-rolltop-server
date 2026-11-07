// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useFormDraft } from "./record-editing.tsx";
import type { RecordHost } from "./record-editing.tsx";
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
  host,
}: {
  catalog: TimelineEventCatalog;
  event?: TimelineEvent;
  host: RecordHost;
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
    [addParticipant, setAddParticipant] = useState("");
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
  const { onShared } = host;
  useEffect(() => {
    if (!event) onShared?.(shared);
  }, [event, shared, onShared]);
  const payload = {
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
    ...(event ? {} : { scopeKind: kind }),
  };
  const canSave =
    !!scope &&
    (!shared || host.canon) &&
    !invalidScene &&
    !invalidDate &&
    !unavailableEntry &&
    !unavailableParticipant;
  const { dirty, submit, autosave } = useFormDraft(host, payload, {
    canSave,
    isNew: !event,
  });
  const readOnly = !!event && shared && !host.canon;
  return (
    <form
      aria-label={event ? "Edit Event" : "New Event"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!event) {
          if (canSave && !host.busy) void submit();
        } else autosave();
      }}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (
          e.key === "Enter" &&
          event &&
          t.tagName === "INPUT" &&
          (t as HTMLInputElement).type === "text"
        ) {
          e.preventDefault();
          autosave();
        }
      }}
    >
      <fieldset disabled={host.busy || readOnly}>
        <>
          <label>
            Event
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={autosave}
            />
          </label>
          <label className="entry-toggle">
            <input
              type="checkbox"
              checked={hasSummary}
              onChange={(e) => {
                setHasSummary(e.target.checked);
                autosave();
              }}
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
                onBlur={autosave}
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
            <select
              value={entry}
              onChange={(e) => {
                setEntry(e.target.value);
                autosave();
              }}
            >
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
                    e.entryType === "event" && (!e.deletedAt || e.id === entry),
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
              onChange={(e) => {
                setHasDate(e.target.checked);
                autosave();
              }}
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
                  onBlur={autosave}
                />
              </label>
              <label>
                Calendar
                <input
                  value={calendar}
                  onChange={(e) => setCalendar(e.target.value)}
                  onBlur={autosave}
                />
              </label>
              <label>
                Order number
                <input
                  inputMode="numeric"
                  value={ordinal}
                  onChange={(e) => setOrdinal(e.target.value)}
                  onBlur={autosave}
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
                  onClick={() => {
                    setScenes(scenes.filter((x) => x !== id));
                    autosave();
                  }}
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
              autosave();
            }}
          >
            Add Scene
          </button>
          {invalidScene && (
            <p role="alert">
              A saved scene is outside the selected scope. Remove it explicitly
              or restore the scope; your selections have been kept.
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
                    onBlur={autosave}
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
                    onClick={() => {
                      setParticipants(
                        participants.map((x) => {
                          if (x.entryId !== p.entryId) return x;
                          const { role, ...rest } = x;
                          return rest;
                        }),
                      );
                      autosave();
                    }}
                  >
                    Clear Role
                  </button>
                )}
                <button
                  type="button"
                  aria-label={
                    "Remove participant " + entryTitle(catalog, p.entryId)
                  }
                  onClick={() => {
                    setParticipants(
                      participants.filter((x) => x.entryId !== p.entryId),
                    );
                    autosave();
                  }}
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
              autosave();
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
        {!event && shared && !host.canon && (
          <p className="hint">
            Choose Edit shared details above to create a shared event.
          </p>
        )}
        <div className="dialog-actions">
          {(!event || dirty) && (
            <button type="button" onClick={host.discard}>
              {event ? "Discard Changes" : "Cancel"}
            </button>
          )}
          {!event && (
            <button className="primary" disabled={!canSave || host.busy}>
              Create Event
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

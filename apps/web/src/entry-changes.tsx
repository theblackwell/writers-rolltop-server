// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Entry } from "./entries.tsx";
import type { Field } from "./entry-fields.tsx";
import { directionLabel, linksFor } from "./entry-relationships.tsx";
import type { useRelationshipData } from "./relationships.tsx";
import { StateChangeForm, placeTitle, valueTitle } from "./state-changes.tsx";
import {
  manuscriptPositions,
  orderedChanges,
  resolveState,
  stateFieldTypes,
} from "../../../packages/studio/src/state-values.ts";

type Rel = ReturnType<typeof useRelationshipData>;

// Two sections of the entry page: the entry's state changes over the story,
// and a read-only "As of" view of its values and links at a chapter or scene.
// Writes use the existing state-change endpoints and their stale-write checks.
export function EntryChanges({
  entry,
  bookId,
  canon,
  rel,
  flush,
  onOpenEntry,
}: {
  entry: Entry;
  bookId: string;
  /** True when the page edits shared canon. */
  canon: boolean;
  rel: Rel;
  flush: () => Promise<boolean>;
  onOpenEntry?: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<any>();
  const [loadError, setLoadError] = useState("");
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [trash, setTrash] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [edit, setEdit] = useState<{
    change?: any;
    mode: "edit" | "trash" | "restore";
  }>();
  useEffect(() => {
    let live = true;
    setLoadError("");
    api("/books/" + bookId + "/state-changes")
      .then((c) => {
        if (live) setCatalog(c);
      })
      .catch((e) => {
        if (live) setLoadError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId, tick]);
  const shared = entry.scope?.kind !== "book";
  const trashed = !!entry.deletedAt;
  const locked = shared && !canon;
  const fields: Field[] =
    catalog?.fields.filter(
      (f: Field) => f.templateId === entry.templateId && !f.deletedAt,
    ) ?? [];
  const canAdd = fields.some((f) => stateFieldTypes.includes(f.fieldType));
  const fieldLabel = (id: string) =>
    catalog.fields.find((f: Field) => f.id === id)?.label ??
    "Unavailable field";
  const describe = (c: any) => {
    const f = catalog.fields.find((f: Field) => f.id === c.fieldId);
    return f ? valueTitle(f, c.value, catalog.entries) : "Unavailable field";
  };
  async function begin(next: typeof edit) {
    setError("");
    setSaved("");
    if (!(await flush())) {
      setError("Save or cancel your changes to this entry first.");
      return;
    }
    setEdit(next);
  }
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
      setSaved(
        edit?.mode === "trash"
          ? "Change moved to Trash."
          : edit?.mode === "restore"
            ? "Change restored."
            : "Change saved.",
      );
      setEdit(undefined);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "This change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  const nodes: any[] = catalog
    ? (() => {
        const pos = manuscriptPositions(catalog.nodes, bookId);
        return catalog.nodes
          .filter(
            (n: any) =>
              n.bookId === bookId &&
              !n.inTrash &&
              ["chapter", "scene"].includes(n.kind) &&
              pos[n.id] !== undefined,
          )
          .sort((a: any, b: any) => pos[a.id] - pos[b.id]);
      })()
    : [];
  const live = !!catalog;
  return (
    <>
      <section className="entry-section" aria-label="Changes over the story">
        <h3>Changes over the story</h3>
        <p className="hint">
          A change gives a field a new value from an event, chapter or scene
          onward. Earlier books apply before this book's override and its own
          changes.
        </p>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">{saved}</p>}
        {loadError ? (
          <div role="alert">
            <p>Could not load changes. {loadError}</p>
            <button type="button" onClick={() => setTick((t) => t + 1)}>
              Try Again
            </button>
          </div>
        ) : !live ? (
          <p role="status">Loading changes…</p>
        ) : edit ? (
          <StateChangeForm
            key={(edit.change?.id ?? "new") + edit.mode}
            catalog={catalog}
            entry={entry}
            change={edit.change}
            mode={edit.mode}
            canon={canon}
            busy={busy}
            onCancel={() => {
              setEdit(undefined);
              setError("");
            }}
            onSave={save}
          />
        ) : (
          <>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={trashed || !canAdd || locked}
                onClick={() => void begin({ mode: "edit" })}
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
            </div>
            {!fields.length && !trashed && (
              <p className="hint">
                Assign a template with fields before adding changes.
              </p>
            )}
            {locked && !trashed && (
              <p className="hint">
                This entry is shared. Turn on Edit shared details to add or
                change its state changes for every book in its scope.
              </p>
            )}
            {(() => {
              const list = trash
                ? catalog.stateChanges.filter(
                    (c: any) => c.entryId === entry.id && c.deletedAt,
                  )
                : orderedChanges(entry, catalog).map((x: any) => x.change);
              return (
                <>
                  {!list.length && (
                    <p className="hint">
                      {trash ? "No changes in Trash." : "No changes yet."}
                    </p>
                  )}
                  <ul className="search-results">
                    {list.map((c: any) => (
                      <li key={c.id}>
                        <strong>
                          {fieldLabel(c.fieldId)} → {describe(c)}
                        </strong>
                        <p>
                          {placeTitle(catalog, c)}
                          {c.note !== undefined ? " · " + c.note : ""}
                        </p>
                        {!c.deletedAt && (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() =>
                              void begin({ change: c, mode: "edit" })
                            }
                          >
                            Edit Change…
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() =>
                            void begin({
                              change: c,
                              mode: c.deletedAt ? "restore" : "trash",
                            })
                          }
                        >
                          {c.deletedAt
                            ? "Restore Change…"
                            : "Move Change to Trash…"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              );
            })()}
          </>
        )}
      </section>
      <section className="entry-section" aria-label="As of">
        <h3>As of</h3>
        {loadError ? (
          <p className="hint">Unavailable until changes load.</p>
        ) : !live ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            <label>
              As of chapter or scene
              <select value={asOf} onChange={(e) => setAsOf(e.target.value)}>
                <option value="">From the start</option>
                {nodes.map((n: any) => (
                  <option key={n.id} value={n.id}>
                    {n.kind === "scene" ? "— " : ""}
                    {n.title}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              Read-only. Shows this entry's values at that point in the book.
              Nothing here changes your data.
            </p>
            <ul className="search-results" aria-label="Values as of">
              {fields.map((f) => {
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
                    <p className="hint">
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
            {!fields.length && <p className="hint">No fields to show.</p>}
            <h4>Relationships</h4>
            {!rel.loaded ? (
              <p role="status">Loading relationships…</p>
            ) : (
              (() => {
                const mine = linksFor(entry.id, rel.data.relationships).filter(
                  (r) => !r.deletedAt,
                );
                return (
                  <>
                    <p className="hint">
                      Links are not tied to a point in the book, so the same
                      links show at every point.
                    </p>
                    {!mine.length && <p className="hint">No relationships.</p>}
                    <ul className="search-results" aria-label="Links as of">
                      {mine.map((r) => {
                        const t = rel.data.relationshipTypes.find(
                          (x) => x.id === r.typeId,
                        );
                        const otherId =
                          r.fromEntryId === entry.id
                            ? r.toEntryId
                            : r.fromEntryId;
                        const other = catalog.entries.find(
                          (e: Entry) => e.id === otherId,
                        );
                        return (
                          <li key={r.id}>
                            {directionLabel(entry.id, r, t)}{" "}
                            {other ? (
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => onOpenEntry?.(other.id)}
                              >
                                {other.name}
                              </button>
                            ) : (
                              `Unavailable entry (${otherId})`
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                );
              })()
            )}
          </>
        )}
      </section>
    </>
  );
}

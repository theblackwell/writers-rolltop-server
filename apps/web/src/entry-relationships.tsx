// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { api } from "./api.ts";
import type { Entry } from "./entries.tsx";
import { LinkForm } from "./relationships.tsx";
import type {
  Relation,
  RelationType,
  useRelationshipData,
} from "./relationships.tsx";

type Data = ReturnType<typeof useRelationshipData>;

/** The links that touch one entry, from that entry's point of view. */
export function linksFor(entryId: string, relationships: Relation[]) {
  return relationships.filter(
    (r) => r.fromEntryId === entryId || r.toEntryId === entryId,
  );
}
/** "parent of Tom" or, read from the other end, "child of Mira". */
export function directionLabel(
  entryId: string,
  r: Relation,
  type: RelationType | undefined,
) {
  if (!type) return "Unavailable type";
  return r.fromEntryId === entryId ? type.label : type.inverseLabel;
}

// Relationships section of the entry page. Links are written with the existing
// book relationship endpoints (stale-write checks via expectedUpdatedAt).
export function EntryLinks({
  entry,
  entries,
  bookId,
  rel,
  canonOk,
  flush,
  onOpenEntry,
}: {
  entry: Entry;
  entries: Entry[];
  bookId: string;
  rel: Data;
  /** Shared links may change only when the page is in canon mode (or the
   * entry is not shared). */
  canonOk: boolean;
  flush: () => Promise<boolean>;
  onOpenEntry?: (id: string) => void;
}) {
  const { data, loaded } = rel;
  const [edit, setEdit] = useState<{ item?: Relation } | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [trash, setTrash] = useState(false);
  const trashed = !!entry.deletedAt;
  const find = (id: string) => entries.find((e) => e.id === id);
  const action = async (work: () => Promise<void>, done: string) => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await work();
      setSaved(done);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The relationship could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const send = async (item: Relation | undefined, value: object) => {
    await api(
      `/books/${bookId}/relationships${item ? `/${item.id}` : ""}`,
      item ? "PUT" : "POST",
      { ...value, ...(item ? { expectedUpdatedAt: item.updatedAt } : {}) },
    );
    await rel.reload();
  };
  const open = async (item?: Relation) => {
    setError("");
    setSaved("");
    if (!(await flush())) {
      setError("Save or cancel your changes to this entry first.");
      return;
    }
    setEdit({ item });
  };
  const mine = linksFor(entry.id, data.relationships).filter(
    (r) => !!r.deletedAt === trash,
  );
  const hasLive = data.relationshipTypes.some((t) => !t.deletedAt);
  const others = entries.filter((e) => !e.deletedAt && e.id !== entry.id);
  return (
    <>
      <h3>Relationships</h3>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void rel.reload().catch((e) => setError(e.message))}
          >
            Reload Relationships
          </button>
        </div>
      )}
      {rel.error && !error && <p role="alert">{rel.error}</p>}
      {saved && <p role="status">{saved}</p>}
      {!loaded && !rel.error ? (
        <p role="status">Loading relationships…</p>
      ) : edit ? (
        <LinkForm
          key={edit.item?.id ?? "new-link"}
          item={edit.item}
          types={data.relationshipTypes}
          entries={entries}
          fromId={edit.item ? undefined : entry.id}
          sharedAllowed={canonOk}
          busy={busy}
          onCancel={() => {
            setError("");
            setEdit(null);
          }}
          onSave={(value) =>
            action(async () => {
              await send(edit.item, value);
              setEdit(null);
            }, "Relationship saved.")
          }
        />
      ) : (
        loaded && (
          <>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={busy || trashed || !hasLive || !others.length}
                onClick={() => void open()}
              >
                Add Relationship…
              </button>
              <label className="entry-toggle">
                <input
                  type="checkbox"
                  checked={trash}
                  onChange={(e) => setTrash(e.target.checked)}
                />
                Show Relationship Trash
              </label>
            </div>
            {!hasLive && !trashed && (
              <p className="hint">
                Create a relationship type in Bible settings first.
              </p>
            )}
            {!mine.length && (
              <p className="hint">
                {trash ? "No relationships in Trash." : "No relationships yet."}
              </p>
            )}
            <ul className="search-results entry-links">
              {mine.map((r) => {
                const t = data.relationshipTypes.find((x) => x.id === r.typeId);
                const otherId =
                  r.fromEntryId === entry.id ? r.toEntryId : r.fromEntryId;
                const other = find(otherId);
                const locked = !r.bookId && !canonOk;
                return (
                  <li key={r.id}>
                    <p>
                      <strong>{entry.name}</strong>{" "}
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
                      {other?.deletedAt ? " (in Trash)" : ""}
                    </p>
                    <p className="hint">
                      {r.bookId ? "This book only" : "Shared relationship"}
                      {t?.deletedAt ? " · Type in Trash" : ""}
                    </p>
                    {r.note && (
                      <p style={{ whiteSpace: "pre-wrap" }}>{r.note}</p>
                    )}
                    {!r.deletedAt && (
                      <button
                        type="button"
                        disabled={busy || locked}
                        aria-label={`Edit note for relationship ${entry.name} to ${other?.name ?? otherId}`}
                        onClick={() => void open(r)}
                      >
                        Edit Note…
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy || locked}
                      aria-label={`${r.deletedAt ? "Restore" : "Trash"} relationship ${entry.name} to ${other?.name ?? otherId}`}
                      onClick={() =>
                        void (async () => {
                          if (!(await flush())) {
                            setError(
                              "Save or cancel your changes to this entry first.",
                            );
                            return;
                          }
                          await action(
                            () =>
                              send(r, {
                                deleted: !r.deletedAt,
                                expectedTypeUpdatedAt: t?.updatedAt,
                                editSharedCanon: !r.bookId,
                              }),
                            r.deletedAt
                              ? "Relationship restored."
                              : "Relationship moved to Trash.",
                          );
                        })()
                      }
                    >
                      {r.deletedAt
                        ? "Restore Relationship"
                        : r.bookId
                          ? "Move Relationship to Trash"
                          : "Trash Shared Relationship"}
                    </button>
                    {locked && (
                      <p className="hint">
                        Turn on Edit shared details to change this shared
                        relationship.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )
      )}
    </>
  );
}

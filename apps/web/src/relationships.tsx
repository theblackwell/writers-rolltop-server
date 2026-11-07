// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
type RelationType = {
  id: string;
  label: string;
  inverseLabel: string;
  updatedAt: string;
  deletedAt?: string;
};
type Relation = {
  id: string;
  typeId: string;
  fromEntryId: string;
  toEntryId: string;
  bookId?: string;
  note?: string;
  updatedAt: string;
  deletedAt?: string;
};
type Catalog = { relationshipTypes: RelationType[]; relationships: Relation[] };
export type { RelationType, Relation };
/** Loads the book's relationship types and links; reload keeps the last data
 * on screen if it fails. */
export function useRelationshipData(bookId: string) {
  const [data, setData] = useState<Catalog>({
      relationshipTypes: [],
      relationships: [],
    }),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true);
  const reload = async () => {
    const next = await api<Catalog>(`/books/${bookId}/relationships`);
    if (live.current) {
      setData(next);
      setLoaded(true);
      setError("");
    }
  };
  useEffect(() => {
    live.current = true;
    setLoaded(false);
    reload().catch((e) => {
      if (live.current) setError(e.message);
    });
    return () => {
      live.current = false;
    };
  }, [bookId]);
  return { data, loaded, error, reload, setError };
}
// Bible settings: relationship types are shared by the whole library. Links
// between entries are managed on the entry pages.
export function RelationshipTypes({
  bookId,
  libraryId,
  onClose,
}: {
  bookId: string;
  libraryId: string;
  onClose: () => void;
}) {
  const {
    data,
    loaded,
    error: loadError,
    reload,
  } = useRelationshipData(bookId);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [edit, setEditState] = useState<{ item?: RelationType } | null>(null);
  function setEdit(value: typeof edit) {
    setError("");
    setEditState(value);
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The type could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function save(item: RelationType | undefined, value: object) {
    await api(
      `/libraries/${libraryId}/relationship-types${item ? `/${item.id}` : ""}`,
      item ? "PUT" : "POST",
      { ...value, ...(item ? { expectedUpdatedAt: item.updatedAt } : {}) },
    );
    await reload();
    setEdit(null);
  }
  return (
    <section aria-label="Bible settings">
      <h2>Bible settings</h2>
      <h3>Relationship types</h3>
      <p>
        Direction matters: the forward label reads from the first entry to the
        second; the inverse label reads back. Types are shared throughout this
        library. Add the links themselves from an entry's page.
      </p>
      {(loadError || error) && <p role="alert">{error || loadError}</p>}
      {!loaded && !loadError ? (
        <p role="status">Loading…</p>
      ) : edit ? (
        <TypeForm
          key={edit.item?.id ?? "new-type"}
          item={edit.item}
          busy={busy}
          onCancel={() => setEdit(null)}
          onSave={(value) => action(() => save(edit.item, value))}
        />
      ) : (
        loaded && (
          <fieldset disabled={busy}>
            <button onClick={() => setEdit({})}>New Relationship Type…</button>
            {!data.relationshipTypes.length && (
              <p>Create a type with forward and inverse labels first.</p>
            )}
            <ul className="search-results">
              {data.relationshipTypes.map((t) => (
                <li key={t.id}>
                  <strong>
                    {t.label} / {t.inverseLabel}
                  </strong>
                  {t.deletedAt ? " (in Trash)" : ""}
                  {!t.deletedAt && (
                    <button
                      aria-label={`Edit relationship type ${t.label}`}
                      onClick={() => setEdit({ item: t })}
                    >
                      Edit Type…
                    </button>
                  )}
                  <button
                    aria-label={`${t.deletedAt ? "Restore" : "Trash"} relationship type ${t.label}`}
                    onClick={() =>
                      void action(() => save(t, { deleted: !t.deletedAt }))
                    }
                  >
                    {t.deletedAt ? "Restore Type" : "Move Type to Trash"}
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
        )
      )}
      <button disabled={busy || !!edit} onClick={onClose}>
        Close Bible Settings
      </button>
    </section>
  );
}
function TypeForm({
  item,
  busy,
  onSave,
  onCancel,
}: {
  item?: RelationType;
  busy: boolean;
  onSave: (value: object) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(item?.label ?? ""),
    [inverse, setInverse] = useState(item?.inverseLabel ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ label, inverseLabel: inverse });
      }}
    >
      <h4>{item ? "Edit" : "New"} Relationship Type</h4>
      <p>Type labels are shared throughout this library.</p>
      <fieldset disabled={busy}>
        <label>
          Forward label
          <input
            autoFocus
            required
            maxLength={500}
            placeholder="parent of"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Inverse label
          <input
            required
            maxLength={500}
            placeholder="child of"
            value={inverse}
            onChange={(e) => setInverse(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel Type Edit
          </button>
          <button>{busy ? "Saving…" : "Save Relationship Type"}</button>
        </div>
      </fieldset>
    </form>
  );
}
export function LinkForm({
  item,
  types,
  entries,
  fromId,
  sharedAllowed = true,
  busy,
  onSave,
  onCancel,
}: {
  item?: Relation;
  types: RelationType[];
  entries: { id: string; name: string; deletedAt?: string }[];
  /** Fixes the first entry (the entry page the link is added from). */
  fromId?: string;
  /** False keeps a shared link out of reach until canon mode is on. */
  sharedAllowed?: boolean;
  busy: boolean;
  onSave: (value: object) => Promise<void>;
  onCancel: () => void;
}) {
  const live = entries.filter((e) => !e.deletedAt),
    [from, setFrom] = useState(fromId ?? live[0]?.id ?? ""),
    [to, setTo] = useState(
      live.find((e) => e.id !== (fromId ?? live[0]?.id))?.id ?? "",
    ),
    [type, setType] = useState(types.find((t) => !t.deletedAt)?.id ?? ""),
    [bookSpecific, setBookSpecific] = useState(true),
    [note, setNote] = useState(item?.note ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(
          item
            ? { note, editSharedCanon: !item.bookId }
            : {
                typeId: type,
                fromEntryId: from,
                toEntryId: to,
                bookSpecific,
                note,
                editSharedCanon: !bookSpecific,
                expectedTypeUpdatedAt: types.find((t) => t.id === type)
                  ?.updatedAt,
              },
        );
      }}
    >
      <h4>{item ? "Edit Relationship Note" : "New Relationship"}</h4>
      <fieldset disabled={busy}>
        {!item && (
          <>
            <label>
              First entry
              <select
                value={from}
                disabled={!!fromId}
                onChange={(e) => {
                  const id = e.target.value;
                  setFrom(id);
                  if (to === id)
                    setTo(live.find((entry) => entry.id !== id)?.id ?? "");
                }}
              >
                {live.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Relationship type
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {types
                  .filter((t) => !t.deletedAt)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} / {t.inverseLabel}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Second entry
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {live
                  .filter((e) => e.id !== from)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Applies to
              <select
                value={bookSpecific ? "book" : "shared"}
                onChange={(e) => setBookSpecific(e.target.value === "book")}
              >
                <option value="book">This book only</option>
                <option value="shared" disabled={!sharedAllowed}>
                  All books that can see both entries
                </option>
              </select>
            </label>
            {!sharedAllowed && (
              <p className="hint">
                Turn on Edit shared details to add a link that applies to every
                book.
              </p>
            )}
            <p>
              {live.find((e) => e.id === from)?.name}{" "}
              {types.find((t) => t.id === type)?.label}{" "}
              {live.find((e) => e.id === to)?.name}
            </p>
          </>
        )}
        {(item ? !item.bookId : !bookSpecific) && (
          <p>
            This changes a shared relationship for every book that can see both
            entries.
          </p>
        )}
        <label>
          Note
          <textarea
            maxLength={20000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel Relationship Edit
          </button>
          <button disabled={!item && (!from || !to || from === to || !type)}>
            {busy ? "Saving…" : "Save Relationship"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Entry } from "./entries.tsx";
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
export function Relationships({
  bookId,
  libraryId,
  entries,
  onClose,
}: {
  bookId: string;
  libraryId: string;
  entries: Entry[];
  onClose: () => void;
}) {
  const [data, setData] = useState<Catalog>({
      relationshipTypes: [],
      relationships: [],
    }),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [trash, setTrash] = useState(false);
  const [edit, setEditState] = useState<{
    kind: "type" | "link";
    item?: RelationType | Relation;
  } | null>(null);
  function setEdit(value: typeof edit) {
    setError("");
    setEditState(value);
  }
  const reload = async () => {
    setData(await api(`/books/${bookId}/relationships`));
    setLoaded(true);
  };
  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, [bookId]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Relationships could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save(
    kind: "type" | "link",
    item: RelationType | Relation | undefined,
    value: object,
  ) {
    await api(
      kind === "type"
        ? `/libraries/${libraryId}/relationship-types${item ? `/${item.id}` : ""}`
        : `/books/${bookId}/relationships${item ? `/${item.id}` : ""}`,
      item ? "PUT" : "POST",
      { ...value, ...(item ? { expectedUpdatedAt: item.updatedAt } : {}) },
    );
    await reload();
    setEdit(null);
  }
  const name = (id: string) => {
    const e = entries.find((e) => e.id === id);
    return e
      ? e.name + (e.deletedAt ? " (in Trash)" : "")
      : `Unavailable entry (${id})`;
  };
  return (
    <section aria-label="Relationships">
      <h3>Relationships</h3>
      <p>
        Direction matters: the forward label reads from the first entry to the
        second; the inverse label reads back. Shared relationships appear in
        every book that can see both entries.
      </p>
      {error && <p role="alert">{error}</p>}
      {!loaded ? (
        <p>Loading…</p>
      ) : edit ? (
        edit.kind === "type" ? (
          <TypeForm
            key={edit.item?.id ?? "new-type"}
            item={edit.item as RelationType | undefined}
            busy={busy}
            onCancel={() => setEdit(null)}
            onSave={(value) => action(() => save("type", edit.item, value))}
          />
        ) : (
          <LinkForm
            key={edit.item?.id ?? "new-link"}
            item={edit.item as Relation | undefined}
            types={data.relationshipTypes}
            entries={entries}
            busy={busy}
            onCancel={() => setEdit(null)}
            onSave={(value) => action(() => save("link", edit.item, value))}
          />
        )
      ) : (
        <fieldset disabled={busy}>
          <h4>Relationship Types</h4>
          <button onClick={() => setEdit({ kind: "type" })}>
            New Relationship Type…
          </button>
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
                    onClick={() => setEdit({ kind: "type", item: t })}
                  >
                    Edit Type…
                  </button>
                )}
                <button
                  aria-label={`${t.deletedAt ? "Restore" : "Trash"} relationship type ${t.label}`}
                  onClick={() =>
                    void action(() =>
                      save("type", t, { deleted: !t.deletedAt }),
                    )
                  }
                >
                  {t.deletedAt ? "Restore Type" : "Move Type to Trash"}
                </button>
              </li>
            ))}
          </ul>
          <h4>Entry Links</h4>
          <button
            disabled={
              !data.relationshipTypes.some((t) => !t.deletedAt) ||
              entries.filter((e) => !e.deletedAt).length < 2
            }
            onClick={() => setEdit({ kind: "link" })}
          >
            New Relationship…
          </button>
          <label className="entry-toggle">
            <input
              type="checkbox"
              checked={trash}
              onChange={(e) => setTrash(e.target.checked)}
            />
            Show Relationship Trash
          </label>
          {!data.relationships.some((r) => !!r.deletedAt === trash) && (
            <p>
              {trash ? "No relationships in Trash." : "No relationships yet."}
            </p>
          )}
          <ul className="search-results">
            {data.relationships
              .filter((r) => !!r.deletedAt === trash)
              .map((r) => {
                const t = data.relationshipTypes.find((t) => t.id === r.typeId);
                return (
                  <li key={r.id}>
                    <strong>
                      {name(r.fromEntryId)} {t?.label ?? "Unavailable type"}{" "}
                      {name(r.toEntryId)}
                    </strong>
                    <p>
                      {name(r.toEntryId)}{" "}
                      {t?.inverseLabel ?? "Unavailable inverse label"}{" "}
                      {name(r.fromEntryId)}
                    </p>
                    <p>
                      {r.bookId ? "This book only" : "Shared relationship"}
                      {t?.deletedAt ? " · Type in Trash" : ""}
                    </p>
                    {r.note && (
                      <p style={{ whiteSpace: "pre-wrap" }}>{r.note}</p>
                    )}
                    {!r.deletedAt && (
                      <button
                        aria-label={`Edit note for relationship ${name(r.fromEntryId)} to ${name(r.toEntryId)}`}
                        onClick={() => setEdit({ kind: "link", item: r })}
                      >
                        Edit Note…
                      </button>
                    )}
                    <button
                      onClick={() =>
                        void action(() =>
                          save("link", r, {
                            deleted: !r.deletedAt,
                            expectedTypeUpdatedAt: t?.updatedAt,
                            editSharedCanon: !r.bookId,
                          }),
                        )
                      }
                    >
                      {r.deletedAt
                        ? "Restore Relationship"
                        : r.bookId
                          ? "Move Relationship to Trash"
                          : "Trash Shared Relationship"}
                    </button>
                  </li>
                );
              })}
          </ul>
        </fieldset>
      )}
      <button disabled={busy || !!edit} onClick={onClose}>
        Close Relationships
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
function LinkForm({
  item,
  types,
  entries,
  busy,
  onSave,
  onCancel,
}: {
  item?: Relation;
  types: RelationType[];
  entries: Entry[];
  busy: boolean;
  onSave: (value: object) => Promise<void>;
  onCancel: () => void;
}) {
  const live = entries.filter((e) => !e.deletedAt),
    [from, setFrom] = useState(live[0]?.id ?? ""),
    [to, setTo] = useState(live[1]?.id ?? ""),
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
                <option value="shared">
                  All books that can see both entries
                </option>
              </select>
            </label>
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

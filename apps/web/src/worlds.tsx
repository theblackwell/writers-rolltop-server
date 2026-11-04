// SPDX-License-Identifier: AGPL-3.0-only
import React, { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Item } from "./api.ts";
type Catalog = { universes: Item[]; series: Item[]; books: Item[] };
type Edit =
  { kind: "universes" | "series"; item?: Item } | { kind: "book"; item: Item };
export function Worlds({
  libraryId,
  onBookSaved,
}: {
  libraryId: string;
  onBookSaved: (book: Item) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () =>
    setCatalog(await api(`/libraries/${libraryId}/worlds`));
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [libraryId]);
  async function trash(kind: "universes" | "series", item: Item) {
    setBusy(true);
    setError("");
    try {
      await api(`/libraries/${libraryId}/${kind}/${item.id}`, "PUT", {
        expectedUpdatedAt: item.updatedAt,
        deleted: !item.deletedAt,
      });
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The item could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p>Organize books into worlds and series.</p>
      {error && <p role="alert">{error}</p>}
      {!catalog ? (
        <p>Loading…</p>
      ) : edit ? (
        <WorldForm
          key={`${edit.kind}-${edit.item?.id ?? "new"}`}
          edit={edit}
          catalog={catalog}
          libraryId={libraryId}
          onCancel={() => setEdit(null)}
          onSaved={async (book) => {
            if (book) onBookSaved(book);
            setEdit(null);
            await load();
          }}
        />
      ) : (
        <fieldset disabled={busy}>
          {(["universes", "series"] as const).map((kind) => (
            <section key={kind}>
              <h3>{kind === "universes" ? "Worlds" : "Series"}</h3>
              <button
                onClick={() => {
                  setError("");
                  setEdit({ kind });
                }}
              >
                New {kind === "universes" ? "World" : "Series"}…
              </button>
              {catalog[kind].length === 0 && <p>None yet.</p>}
              <ul>
                {catalog[kind].map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    {item.deletedAt ? " (in Trash)" : ""}
                    {item.universeId && (
                      <span>
                        {" "}
                        ·{" "}
                        {catalog.universes.find((w) => w.id === item.universeId)
                          ?.title ?? "Unavailable world"}
                      </span>
                    )}
                    {!item.deletedAt && (
                      <button
                        aria-label={`Rename ${item.title}`}
                        onClick={() => {
                          setError("");
                          setEdit({ kind, item });
                        }}
                      >
                        Rename…
                      </button>
                    )}
                    <button
                      aria-label={`${item.deletedAt ? "Restore" : "Trash"} ${item.title}`}
                      onClick={() => void trash(kind, item)}
                    >
                      {item.deletedAt ? "Restore" : "Move to Trash"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section>
            <h3>Book Memberships</h3>
            <p>
              World and series changes preserve the book's manuscript and
              entries.
            </p>
            <ul>
              {catalog.books.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  {item.deletedAt ? " (in Trash)" : ""}
                  <p>
                    World:{" "}
                    {catalog.universes.find((w) => w.id === item.universeId)
                      ?.title ?? "None"}{" "}
                    · Series:{" "}
                    {catalog.series.find((s) => s.id === item.seriesId)
                      ?.title ?? "None"}
                  </p>
                  <button
                    disabled={!!item.deletedAt}
                    onClick={() => {
                      setError("");
                      setEdit({ kind: "book", item });
                    }}
                  >
                    Change World or Series for {item.title}…
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </fieldset>
      )}
    </>
  );
}
function WorldForm({
  edit,
  catalog,
  libraryId,
  onCancel,
  onSaved,
}: {
  edit: Edit;
  catalog: Catalog;
  libraryId: string;
  onCancel: () => void;
  onSaved: (book?: Item) => Promise<void>;
}) {
  const [name, setName] = useState(edit.item?.title ?? "");
  const [world, setWorld] = useState(edit.item?.universeId ?? "");
  const [series, setSeries] = useState(
    edit.kind === "book" ? (edit.item.seriesId ?? "") : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          if (edit.kind === "book") {
            const updated = await api(
              `/books/${edit.item.id}/membership`,
              "PUT",
              {
                universeId: world || null,
                seriesId: series || null,
                expectedUpdatedAt: edit.item.updatedAt,
              },
            );
            await onSaved(updated);
          } else {
            await api(
              `/libraries/${libraryId}/${edit.kind}${edit.item ? `/${edit.item.id}` : ""}`,
              edit.item ? "PUT" : "POST",
              {
                title: name,
                ...(edit.item
                  ? { expectedUpdatedAt: edit.item.updatedAt }
                  : edit.kind === "series"
                    ? { universeId: world || null }
                    : {}),
              },
            );
            await onSaved();
          }
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Changes could not be saved.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        <h3>
          {edit.kind === "book"
            ? `Membership for ${edit.item.title}`
            : `${edit.item ? "Rename" : "New"} ${edit.kind === "universes" ? "World" : "Series"}`}
        </h3>
        {edit.kind !== "book" && (
          <label>
            Name
            <input
              autoFocus
              required
              maxLength={500}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {(edit.kind === "book" || (edit.kind === "series" && !edit.item)) && (
          <label>
            World
            <select
              value={world}
              onChange={(e) => {
                setWorld(e.target.value);
                const selected = catalog.series.find((s) => s.id === series);
                if ((selected?.universeId ?? "") !== e.target.value)
                  setSeries("");
              }}
            >
              <option value="">None</option>
              {catalog.universes
                .filter((w) => !w.deletedAt)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {edit.kind === "series" && !edit.item && (
          <p>A series' world is fixed when created.</p>
        )}
        {edit.kind === "book" && (
          <>
            <label>
              Series
              <select
                value={series}
                onChange={(e) => setSeries(e.target.value)}
              >
                <option value="">None</option>
                {catalog.series
                  .filter(
                    (s) =>
                      !s.deletedAt && (!s.universeId || s.universeId === world),
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </label>
            <p>
              Changing worlds clears an incompatible series. Save applies both
              choices together.
            </p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button>{busy ? "Saving…" : "Save"}</button>
        </div>
      </fieldset>
    </form>
  );
}

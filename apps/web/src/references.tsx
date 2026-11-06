// SPDX-License-Identifier: AGPL-3.0-only
import { EntryContext } from "./entry-context.tsx";
import { sameFamilyName } from "../../../packages/studio/src/family-values.ts";
import { Relationships } from "./relationships.tsx";
import { TemplateManager } from "./template-manager.tsx";
import React, { useEffect, useState } from "react";
import { api } from "./api.ts";
import { EntryList } from "./entries.tsx";
import type { Catalog } from "./entry-fields.tsx";
import type { Entry } from "./entries.tsx";
type Reference = {
  id: string;
  entryId: string;
  anchorId: string;
  updatedAt: string;
  deletedAt?: string;
};
export function References({
  bookId,
  nodeId,
  onReveal,
  onOpenAppearance,
  initialEntryId,
}: {
  initialEntryId?: string;
  bookId: string;
  nodeId?: string;
  onReveal?: (id: string) => void;
  onOpenAppearance?: (nodeId: string, anchorId: string) => Promise<void>;
}) {
  const [inspect, setInspect] = useState<string>();
  const [book, setBook] = useState<any>(null);
  const [seriesWorld, setSeriesWorld] = useState<string>();
  const [libraryId, setLibraryId] = useState("");
  const [relationshipsOpen, setRelationshipsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>({
    templates: [],
    fields: [],
  });
  const [entries, setEntries] = useState<Entry[]>([]);
  const inspected = entries.find((e) => e.id === inspect);
  const [refs, setRefs] = useState<Reference[]>([]);
  const [anchors, setAnchors] = useState<[string, string][]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<Entry[]>(`/books/${bookId}/entries`),
      nodeId
        ? api<Reference[]>(`/nodes/${nodeId}/references`)
        : Promise.resolve([]),
      nodeId ? api(`/documents/${nodeId}`) : Promise.resolve(null),
      api(`/books/${bookId}`).then(async (data) => {
        const [c, worlds] = await Promise.all([
          api<Catalog>(`/libraries/${data.libraryId}/templates`),
          api(`/libraries/${data.libraryId}/worlds`),
        ]);
        return {
          ...c,
          libraryId: data.libraryId,
          book: data.book,
          seriesWorld: worlds.series.find(
            (s: any) => s.id === data.book.seriesId,
          )?.universeId,
        };
      }),
    ])
      .then(([e, r, d, c]) => {
        if (!live) return;
        setEntries(e);
        setCatalog(c);
        setLibraryId(c.libraryId);
        setBook(c.book);
        setSeriesWorld(c.seriesWorld);
        setRefs(r);
        if (d) {
          const passages = new Map<string, string>();
          for (const block of d.document.blocks)
            for (const run of block.content ?? [])
              for (const mark of run.marks ?? [])
                if (mark.type === "anchor")
                  passages.set(
                    mark.id,
                    (passages.get(mark.id) ?? "") + (run.text ?? ""),
                  );
          setAnchors([...passages]);
          setRevision(d.revision);
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId, nodeId]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      {error && <p role="alert">{error}</p>}
      {inspected && (
        <EntryContext
          key={inspected.id}
          entry={inspected}
          bookId={bookId}
          onClose={() => setInspect(undefined)}
          onOpen={onOpenAppearance}
        />
      )}
      {relationshipsOpen && (
        <Relationships
          bookId={bookId}
          libraryId={libraryId}
          entries={entries}
          onClose={() => setRelationshipsOpen(false)}
        />
      )}
      {templatesOpen && (
        <TemplateManager
          libraryId={libraryId}
          catalog={catalog}
          busy={busy}
          action={action}
          reload={async () =>
            setCatalog(await api<Catalog>(`/libraries/${libraryId}/templates`))
          }
          onClose={() => {
            setTemplatesOpen(false);
            setError("");
          }}
        />
      )}
      <div hidden={templatesOpen || relationshipsOpen || !!inspected}>
        <p>
          Edit book entries here, or use Fields to edit their saved values.
          Shared canon changes apply to every book in its scope. Use This book
          only in Fields for values specific to this book. Customize definitions
          with Templates and Fields.
        </p>
        {!loaded && <p>Loading…</p>}
        {!nodeId && (
          <button
            disabled={busy || !loaded}
            onClick={() => {
              setError("");
              setTemplatesOpen(true);
            }}
          >
            Templates and Fields…
          </button>
        )}
        {!nodeId && (
          <button
            disabled={busy || !loaded}
            onClick={() => setRelationshipsOpen(true)}
          >
            Relationships…
          </button>
        )}
        <details>
          <summary>Add Bible Entry</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const input = Object.fromEntries(new FormData(form));
              void action(async () => {
                const entry = await api<Entry>(
                  `/books/${bookId}/entries`,
                  "POST",
                  input,
                );
                setEntries((es) => [...es, entry]);
                form.reset();
                if (
                  !nodeId &&
                  entries.some(
                    (other) => !other.deletedAt && sameFamilyName(entry, other),
                  )
                )
                  setInspect(entry.id);
              });
            }}
          >
            <fieldset disabled={busy || !loaded}>
              <label>
                Name
                <input name="name" required maxLength={500} />
              </label>
              <label>
                Type
                <select name="entryType">
                  {[
                    "character",
                    "location",
                    "organization",
                    "object",
                    "event",
                    "plotline",
                    "worldRule",
                    "research",
                    "term",
                  ].map((t) => (
                    <option key={t} value={t}>
                      {t === "worldRule"
                        ? "World rule"
                        : t[0].toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Scope
                <select name="scopeKind">
                  <option value="book">This book</option>
                  {book?.universeId && (
                    <option value="universe">Shared world</option>
                  )}
                  {book?.seriesId && (
                    <option value="series">Shared series</option>
                  )}
                </select>
              </label>
              <label>
                Summary
                <textarea name="summary" maxLength={20000} />
              </label>
              <button>Add Entry</button>
            </fieldset>
          </form>
        </details>
        {!nodeId && (
          <EntryList
            initialId={initialEntryId}
            bookId={bookId}
            catalog={catalog}
            book={book}
            seriesWorld={seriesWorld}
            entries={entries}
            busy={busy || !loaded}
            action={action}
            onPurged={async (id) => {
              setEntries((es) => es.filter((e) => e.id !== id));
              setRefs((rs) => rs.filter((r) => r.entryId !== id));
              if (inspect === id) setInspect(undefined);
              // Keep controls busy until dependent values are refreshed.
              setEntries(await api<Entry[]>(`/books/${bookId}/entries`));
            }}
            onInspect={(id) => {
              setError("");
              setInspect(id);
            }}
            onSaved={(entry) =>
              setEntries((es) => es.map((e) => (e.id === entry.id ? entry : e)))
            }
          />
        )}
        {nodeId && (
          <>
            <p>
              Mark a selected passage in Writing tools, then link its saved
              anchor to an entry. Removing passage text leaves its reference
              visible as a missing passage.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = Object.fromEntries(new FormData(e.currentTarget));
                void action(async () => {
                  const ref = await api<Reference>(
                    `/nodes/${nodeId}/references`,
                    "POST",
                    { ...input, expectedRevision: revision },
                  );
                  setRefs((rs) => [...rs, ref]);
                });
              }}
            >
              <fieldset
                disabled={
                  busy ||
                  !loaded ||
                  !anchors.length ||
                  !entries.some((e) => !e.deletedAt)
                }
              >
                <label>
                  Saved passage
                  <select name="anchorId">
                    {anchors.map(([id, text]) => (
                      <option key={id} value={id}>
                        {text.slice(0, 100) || "Marked passage"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Bible entry
                  <select name="entryId">
                    {entries
                      .filter((e) => !e.deletedAt)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} ({e.entryType})
                        </option>
                      ))}
                  </select>
                </label>
                <button>Link Reference</button>
              </fieldset>
            </form>
            {!anchors.length && loaded && <p>No saved passage anchors yet.</p>}
            <ul className="search-results">
              {refs.map((r) => {
                const entry = entries.find((e) => e.id === r.entryId);
                const passage = anchors.find(([id]) => id === r.anchorId);
                return (
                  <li key={r.id}>
                    <strong>
                      {entry?.name ?? "Missing entry"}
                      {entry?.deletedAt ? " (in Trash)" : ""}
                    </strong>
                    <p>{passage?.[1] ?? "Passage no longer present"}</p>
                    {entry?.summary && <p>{entry.summary}</p>}
                    {passage && (
                      <button
                        disabled={busy}
                        onClick={() => onReveal?.(r.anchorId)}
                      >
                        Show Passage
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const saved = await api<Reference>(
                            `/nodes/${nodeId}/references/${r.id}`,
                            "PUT",
                            {
                              deleted: !r.deletedAt,
                              expectedUpdatedAt: r.updatedAt,
                            },
                          );
                          setRefs((rs) =>
                            rs.map((x) => (x.id === r.id ? saved : x)),
                          );
                        })
                      }
                    >
                      {r.deletedAt
                        ? "Restore Reference"
                        : "Move Reference to Trash"}
                    </button>
                    {r.deletedAt && <span> In Trash</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

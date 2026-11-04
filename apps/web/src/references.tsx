// SPDX-License-Identifier: AGPL-3.0-only
import React, { useEffect, useState } from "react";
import { api } from "./api.ts";
import { EntryList } from "./entries.tsx";
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
}: {
  bookId: string;
  nodeId?: string;
  onReveal?: (id: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
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
    ])
      .then(([e, r, d]) => {
        if (!live) return;
        setEntries(e);
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
      <p>
        Book-scoped bible entries. Edit names, aliases and summaries here.
        Shared worlds, templates and custom fields are coming in later sections.
      </p>
      {error && <p role="alert">{error}</p>}
      {!loaded && <p>Loading…</p>}
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
              Summary
              <textarea name="summary" maxLength={20000} />
            </label>
            <button>Add Entry</button>
          </fieldset>
        </form>
      </details>
      {!nodeId && (
        <EntryList
          bookId={bookId}
          entries={entries}
          busy={busy || !loaded}
          action={action}
          onSaved={(entry) =>
            setEntries((es) => es.map((e) => (e.id === entry.id ? entry : e)))
          }
        />
      )}
      {nodeId && (
        <>
          <p>
            Mark a selected passage in Writing tools, then link its saved anchor
            to an entry. Removing passage text leaves its reference visible as a
            missing passage.
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
    </section>
  );
}

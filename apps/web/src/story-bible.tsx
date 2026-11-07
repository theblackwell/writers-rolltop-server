// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Dialog } from "./dialog.tsx";
import { EntryPage } from "./entry-page.tsx";
import type { Catalog } from "./entry-fields.tsx";
import { entryTypeLabel, entryTypes } from "./entries.tsx";
import type { Entry } from "./entries.tsx";
import { Relationships } from "./relationships.tsx";
import { TemplateManager } from "./template-manager.tsx";

export type BibleTool = "relationships" | "templates" | null;
type Context = {
  libraryId: string;
  book: { id: string; universeId?: string; seriesId?: string };
  seriesWorld?: string;
  names: Record<string, string>;
  catalog: Catalog;
};
const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);

// Third workspace tab: a binder of entries on the left, one entry page on the
// right. Selection lives in the app so other tools can route into it.
export function StoryBible({
  bookId,
  selectedId,
  onSelect,
  tool,
  onTool,
  onOpenAppearance,
}: {
  bookId: string;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  tool: BibleTool;
  onTool: (tool: BibleTool) => void;
  onOpenAppearance?: (nodeId: string, anchorId: string) => Promise<void>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [context, setContext] = useState<Context>();
  const [loadError, setLoadError] = useState("");
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [filter, setFilter] = useState("");
  const [namesOnly, setNamesOnly] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showList, setShowList] = useState(!selectedId);
  useEffect(() => {
    let live = true;
    setContext(undefined);
    setLoadError("");
    Promise.all([
      api<Entry[]>(`/books/${bookId}/entries`),
      api(`/books/${bookId}`).then(async (data) => {
        const [catalog, worlds] = await Promise.all([
          api<Catalog>(`/libraries/${data.libraryId}/templates`),
          api(`/libraries/${data.libraryId}/worlds`),
        ]);
        const names: Record<string, string> = {};
        for (const item of [...worlds.universes, ...worlds.series])
          names[item.id] = item.title;
        return {
          libraryId: data.libraryId,
          book: data.book,
          catalog,
          names,
          seriesWorld: worlds.series.find(
            (s: any) => s.id === data.book.seriesId,
          )?.universeId,
        } as Context;
      }),
    ])
      .then(([e, c]) => {
        if (!live) return;
        setEntries(e);
        setContext(c);
      })
      .catch((e) => {
        if (live) setLoadError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId, tick]);
  useEffect(() => {
    if (selectedId) {
      setShowList(false);
      setReceipt("");
    }
  }, [selectedId]);
  const selected = entries.find((e) => e.id === selectedId);
  useEffect(() => {
    if (selected?.deletedAt) setTrashOpen(true);
  }, [selected?.deletedAt]);
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
  const query = filter.trim().toLocaleLowerCase();
  const shown = entries
    .filter(
      (e) =>
        (!namesOnly || e.toBeNamed === true) &&
        [e.name, ...e.aliases].some((s) =>
          s.toLocaleLowerCase().includes(query),
        ),
    )
    .sort(byName);
  const live = shown.filter((e) => !e.deletedAt);
  const trashed = shown.filter((e) => e.deletedAt);
  const total = entries.filter((e) => !e.deletedAt).length;
  const pick = (id: string) => {
    onSelect(id);
    setShowList(false);
  };
  function row(e: Entry) {
    return (
      <li key={e.id}>
        <button
          type="button"
          className={`bible-row${e.id === selectedId ? " current" : ""}`}
          aria-current={e.id === selectedId ? "true" : undefined}
          onClick={() => pick(e.id)}
        >
          <span>{e.name}</span>
          {e.toBeNamed && <small>name to decide</small>}
          {e.scope && e.scope.kind !== "book" && <small>shared</small>}
        </button>
      </li>
    );
  }
  const toolOpen = tool !== null && !!context;
  return (
    <div
      className={`writing-workspace bible-workspace${showList ? "" : " showing-page"}`}
    >
      <aside className="binder bible-binder" aria-label="Story Bible entries">
        <p className="eyebrow">STORY BIBLE</p>
        <div className="bible-binder-actions">
          <button
            className="primary"
            disabled={!context}
            onClick={() => setCreating(true)}
          >
            ＋ New
          </button>
          <button
            disabled={!context}
            onClick={() =>
              onTool(tool === "relationships" ? null : "relationships")
            }
          >
            Relationships…
          </button>
          <button
            disabled={!context}
            onClick={() => onTool(tool === "templates" ? null : "templates")}
          >
            Templates and Fields…
          </button>
        </div>
        <label>
          Find name or alias
          <input value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <label className="entry-toggle">
          <input
            type="checkbox"
            checked={namesOnly}
            onChange={(e) => setNamesOnly(e.target.checked)}
          />
          Only names still needed
        </label>
        {loadError ? (
          <div role="alert">
            <p>Could not load the Story Bible. {loadError}</p>
            <button onClick={() => setTick((t) => t + 1)}>Try Again</button>
          </div>
        ) : !context ? (
          <p role="status">Loading entries…</p>
        ) : (
          <>
            {!total && !trashed.length && (
              <p className="hint">
                No entries yet. Choose New to add a character, place or idea.
              </p>
            )}
            {!!total && !live.length && !trashed.length && (
              <p className="hint">No entries match.</p>
            )}
            {entryTypes
              .filter((t) => live.some((e) => e.entryType === t))
              .map((t) => (
                <section key={t} aria-label={entryTypeLabel(t, true)}>
                  <h3 className="bible-group">
                    {entryTypeLabel(t, true)} (
                    {live.filter((e) => e.entryType === t).length})
                  </h3>
                  <ul className="bible-list">
                    {live.filter((e) => e.entryType === t).map(row)}
                  </ul>
                </section>
              ))}
            <details
              className="node-trash"
              open={trashOpen}
              onToggle={(e) => setTrashOpen(e.currentTarget.open)}
            >
              <summary>
                Trash ({entries.filter((e) => e.deletedAt).length})
              </summary>
              {!trashed.length && <p className="hint">Nothing in Trash.</p>}
              <ul className="bible-list">{trashed.map(row)}</ul>
            </details>
          </>
        )}
      </aside>
      <main className="manuscript-area bible-area">
        {error && <p role="alert">{error}</p>}
        {toolOpen && tool === "relationships" ? (
          <Relationships
            bookId={bookId}
            libraryId={context.libraryId}
            entries={entries}
            onClose={() => onTool(null)}
          />
        ) : toolOpen && tool === "templates" ? (
          <TemplateManager
            libraryId={context.libraryId}
            catalog={context.catalog}
            busy={busy}
            action={action}
            reload={async () => {
              const catalog = await api<Catalog>(
                `/libraries/${context.libraryId}/templates`,
              );
              setContext((c) => c && { ...c, catalog });
            }}
            onClose={() => {
              onTool(null);
              setError("");
            }}
          />
        ) : selected && context ? (
          <EntryPage
            key={selected.id}
            entry={selected}
            entries={entries}
            bookId={bookId}
            book={context.book}
            seriesWorld={context.seriesWorld}
            catalog={context.catalog}
            scopeName={selected.scope && context.names[selected.scope.id]}
            busy={busy}
            action={action}
            onBack={() => setShowList(true)}
            onOpenAppearance={onOpenAppearance}
            onSaved={(entry) =>
              setEntries((es) => es.map((e) => (e.id === entry.id ? entry : e)))
            }
            onPurged={async (id, backup) => {
              setEntries((es) => es.filter((e) => e.id !== id));
              onSelect(undefined);
              setReceipt(backup);
              setShowList(true);
              // Keep controls busy until dependent values are refreshed.
              setEntries(await api<Entry[]>(`/books/${bookId}/entries`));
            }}
          />
        ) : (
          <div className="empty">
            {receipt && (
              <p role="status">
                Deleted permanently. Recovery backup: {receipt}. Keep this
                filename for your administrator.
              </p>
            )}
            {selectedId && context ? (
              <p role="alert">
                This entry is no longer available here. Review Trash or check
                names again.
              </p>
            ) : null}
            <p className="eyebrow">STORY BIBLE</p>
            <h1>Pick an entry to open its page.</h1>
            <p>
              Entries gather names, details, family and appearances in one
              place. Shared canon changes apply to every book in their scope.
            </p>
          </div>
        )}
      </main>
      {creating && context && (
        <Dialog title="New Bible Entry" close={() => setCreating(false)}>
          <NewEntryForm
            bookId={bookId}
            book={context.book}
            onCancel={() => setCreating(false)}
            onCreated={(entry) => {
              setEntries((es) => [...es, entry]);
              setFilter("");
              setNamesOnly(false);
              onTool(null);
              pick(entry.id);
              setCreating(false);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

export function NewEntryForm({
  bookId,
  book,
  onCancel,
  onCreated,
}: {
  bookId: string;
  book: { universeId?: string; seriesId?: string };
  onCancel: () => void;
  onCreated: (entry: Entry) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const input = Object.fromEntries(new FormData(e.currentTarget));
        setBusy(true);
        setError("");
        try {
          onCreated(
            await api<Entry>(`/books/${bookId}/entries`, "POST", input),
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not create.");
          setBusy(false);
        }
      }}
    >
      <label>
        Name
        <input name="name" required autoFocus maxLength={500} />
      </label>
      <label>
        Type
        <select name="entryType">
          {entryTypes.map((t) => (
            <option key={t} value={t}>
              {entryTypeLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Scope
        <select name="scopeKind">
          <option value="book">This book</option>
          {book.universeId && <option value="universe">Shared world</option>}
          {book.seriesId && <option value="series">Shared series</option>}
        </select>
      </label>
      <label>
        Summary
        <textarea name="summary" maxLength={20000} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

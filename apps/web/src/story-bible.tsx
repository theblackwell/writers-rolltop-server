// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { api } from "./api.ts";
import { Dialog } from "./dialog.tsx";
import { EntryPage } from "./entry-page.tsx";
import type { Catalog } from "./entry-fields.tsx";
import { entryTypeLabel, entryTypes } from "./entries.tsx";
import type { Entry } from "./entries.tsx";
import { RelationshipTypes } from "./relationships.tsx";
import { TemplateManager } from "./template-manager.tsx";
import {
  RecordList,
  RecordPage,
  recordKindList,
  recordKinds,
  recordsOf,
  useRecordCatalogs,
} from "./records.tsx";
import type { RecordKind } from "./records.tsx";

export type BibleTool = "relationshipTypes" | "templates" | null;
/** The list in the sidebar: entries, or one kind of record. */
export type BibleSection = "entries" | RecordKind;
type Context = {
  libraryId: string;
  book: { id: string; title?: string; universeId?: string; seriesId?: string };
  seriesWorld?: string;
  names: Record<string, string>;
  catalog: Catalog;
};
const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);

// A small menu button (the iPhone's "+" and "..." menus). Escape and a click
// elsewhere close it; arrow keys move between items.
function BibleMenu({
  label,
  glyph,
  disabled,
  items,
}: {
  label: string;
  glyph: string;
  disabled?: boolean;
  items: { label: string; run: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div
      className="bible-menu"
      ref={box}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const all = Array.from(
            box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
              [],
          );
          const at = all.indexOf(document.activeElement as HTMLElement);
          const step = e.key === "ArrowDown" ? 1 : -1;
          all[(at + step + all.length) % all.length]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="bible-menu-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {glyph}
      </button>
      {open && (
        <ul role="menu" aria-label={label} className="bible-menu-list">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Third workspace tab: a binder of entries on the left, one entry page on the
// right. Selection lives in the app so other tools can route into it.
export function StoryBible({
  bookId,
  selectedId,
  onSelect,
  tool,
  onTool,
  onOpenAppearance,
  flushRef,
  section = "entries",
  onSection,
  recordId,
  onRecord,
  back,
  onRecordsChanged,
}: {
  bookId: string;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  tool: BibleTool;
  onTool: (tool: BibleTool) => void;
  onOpenAppearance?: (nodeId: string, anchorId: string) => Promise<void>;
  /** The app calls this before it leaves the tab; false means stay here. */
  flushRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  section?: BibleSection;
  onSection?: (section: BibleSection) => void;
  /** The selected fact, question or event when a record section is showing. */
  recordId?: string;
  onRecord?: (id: string | undefined) => void;
  /** Shown on a record page opened from elsewhere, such as the warnings list. */
  back?: { label: string; onClick: () => void };
  /** A record was saved; the app refreshes anything derived from records. */
  onRecordsChanged?: () => void;
}) {
  const pageFlush = useRef<(() => Promise<boolean>) | null>(null);
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
  // The type preset by the "+" menu; the dialog stays the same form.
  const [creating, setCreating] = useState<string | false>(false);
  const [showList, setShowList] = useState(
    !(section === "entries" ? selectedId : recordId),
  );
  const [drafting, setDrafting] = useState(false);
  const records = useRecordCatalogs(bookId, tick);
  const recordKind = section === "entries" ? undefined : section;
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
  useEffect(() => {
    if (recordId) {
      setShowList(false);
      setDrafting(false);
    }
  }, [recordId]);
  useEffect(() => {
    setDrafting(false);
    setShowList(!(section === "entries" ? selectedId : recordId));
    // Only a change of section resets the view; selections have their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
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
  // Save the open entry's drafts before anything replaces its page. If that
  // fails the page stays, with its draft and error visible.
  const leavePage = async () => {
    const ok = (await pageFlush.current?.()) ?? true;
    setError(
      ok
        ? ""
        : "This page has changes that are not saved. Fix or discard them before leaving it.",
    );
    return ok;
  };
  useEffect(() => {
    if (!flushRef) return;
    const flush = async () => (await pageFlush.current?.()) ?? true;
    flushRef.current = flush;
    return () => {
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flushRef]);
  const pick = async (id: string) => {
    if ((id !== selectedId || section !== "entries") && !(await leavePage()))
      return;
    // A tool (Relationship types, Templates) covers the entry page, so close it.
    onTool(null);
    onSection?.("entries");
    onSelect(id);
    setShowList(false);
  };
  const pickRecord = async (kind: RecordKind, id: string) => {
    if ((kind !== section || id !== recordId) && !(await leavePage())) return;
    onTool(null);
    setDrafting(false);
    onSection?.(kind);
    onRecord?.(id);
    setShowList(false);
  };
  const switchSection = async (next: BibleSection) => {
    if (next === section) return;
    if (!(await leavePage())) return;
    onTool(null);
    setDrafting(false);
    onRecord?.(undefined);
    onSection?.(next);
    setShowList(next === "entries" ? !selectedId : true);
  };
  const startNewRecord = async () => {
    if (!(await leavePage())) return;
    onTool(null);
    onRecord?.(undefined);
    setDrafting(true);
    setShowList(false);
  };
  const openTool = async (next: BibleTool) => {
    if (await leavePage()) onTool(next);
  };
  function row(e: Entry) {
    return (
      <li key={e.id}>
        <button
          type="button"
          className={`bible-row${e.id === selectedId ? " current" : ""}`}
          aria-current={e.id === selectedId ? "true" : undefined}
          onClick={() => void pick(e.id)}
        >
          <span>{e.name}</span>
          {e.toBeNamed && <small>name to decide</small>}
          {e.scope && e.scope.kind !== "book" && <small>shared</small>}
        </button>
      </li>
    );
  }
  const toolOpen = tool !== null && !!context;
  const renderRecordArea = () => {
    if (!recordKind) return null;
    const cfg = recordKinds[recordKind];
    const catalogLoaded = records.catalogs[recordKind];
    const failure = records.errors[recordKind];
    if (failure)
      return (
        <div className="empty" role="alert">
          <p>
            Could not load {cfg.section.toLowerCase()}. {failure}
          </p>
          <button onClick={records.reload}>Try Again</button>
        </div>
      );
    if (!catalogLoaded) return <p role="status">Loading…</p>;
    const record = recordsOf(recordKind, records.catalogs).find(
      (r) => r.id === recordId,
    );
    if (drafting || record)
      return (
        <RecordPage
          key={`${recordKind}:${drafting ? "new" : recordId}`}
          kind={recordKind}
          bookId={bookId}
          record={drafting ? undefined : record}
          catalogs={records.catalogs}
          flushRef={pageFlush}
          onBack={() => setShowList(true)}
          returnTo={back}
          onOpenEntry={(id) => void pick(id)}
          onCancelNew={() => {
            setDrafting(false);
            setShowList(true);
          }}
          onSaved={(kind, saved, created) => {
            records.apply(kind, saved, created);
            onRecordsChanged?.();
            if (created) {
              setDrafting(false);
              onRecord?.(saved.id);
            }
          }}
        />
      );
    return (
      <div className="empty">
        {recordId && (
          <p role="alert">
            This {cfg.label.toLowerCase()} is no longer available here. Review
            its Trash or check the warnings again.
          </p>
        )}
        {back && (
          <button type="button" onClick={back.onClick}>
            ← {back.label}
          </button>
        )}
        <p className="eyebrow">STORY BIBLE</p>
        <h1>Pick a {cfg.label.toLowerCase()} to open its page.</h1>
        <p>
          Each page shows the entries it names, and each entry page lists the
          records that mention it. Shared records apply to every book in their
          scope.
        </p>
      </div>
    );
  };
  return (
    <div
      className={`writing-workspace bible-workspace${showList ? "" : " showing-page"}`}
    >
      <aside
        className="binder bible-binder"
        aria-label={
          recordKind
            ? `Story Bible ${recordKinds[recordKind].section.toLowerCase()}`
            : "Story Bible entries"
        }
      >
        <p className="eyebrow">STORY BIBLE</p>
        <div
          className="bible-sections"
          role="group"
          aria-label="Story Bible sections"
        >
          {(["entries", ...recordKindList] as BibleSection[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === section}
              onClick={() => void switchSection(s)}
            >
              {s === "entries" ? "Entries" : recordKinds[s].section}
            </button>
          ))}
        </div>
        <p className="bible-caption">
          Showing what {context?.book.title ?? "this book"} can see
        </p>
        <div className="bible-binder-actions">
          {recordKind ? (
            <button
              className="primary"
              disabled={!records.catalogs[recordKind]}
              aria-label={`New ${recordKinds[recordKind].label.toLowerCase()}`}
              onClick={() => void startNewRecord()}
            >
              ＋ New
            </button>
          ) : (
            <BibleMenu
              label="New entry"
              glyph="＋"
              disabled={!context}
              items={entryTypes.map((t) => ({
                label: `New ${entryTypeLabel(t)}`,
                run: () => setCreating(t),
              }))}
            />
          )}
          <BibleMenu
            label="Bible settings"
            glyph="⋯"
            disabled={!context}
            items={[
              {
                label: "Relationship types…",
                run: () =>
                  void openTool(
                    tool === "relationshipTypes" ? null : "relationshipTypes",
                  ),
              },
              {
                label: "Templates and Fields…",
                run: () =>
                  void openTool(tool === "templates" ? null : "templates"),
              },
            ]}
          />
        </div>
        {recordKind ? (
          <RecordList
            key={recordKind}
            kind={recordKind}
            catalogs={records.catalogs}
            error={records.errors[recordKind]}
            selectedId={drafting ? undefined : recordId}
            onPick={(id) => void pickRecord(recordKind, id)}
            onRetry={records.reload}
          />
        ) : (
          <>
            <label>
              Find name or alias
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
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
                    No entries yet. Choose ＋ to add a character, place or idea.
                  </p>
                )}
                {!!total && !live.length && !trashed.length && (
                  <p className="hint">No entries match.</p>
                )}
                {entryTypes
                  .filter((t) => live.some((e) => e.entryType === t))
                  .map((t) => (
                    <section
                      key={t}
                      className="bible-card"
                      aria-label={entryTypeLabel(t, true)}
                    >
                      <h3 className="bible-group">
                        {entryTypeLabel(t, true)}{" "}
                        <span className="bible-count">
                          {live.filter((e) => e.entryType === t).length}
                        </span>
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
          </>
        )}
      </aside>
      <main className="manuscript-area bible-area">
        {error && <p role="alert">{error}</p>}
        {toolOpen && tool === "relationshipTypes" ? (
          <RelationshipTypes
            bookId={bookId}
            libraryId={context.libraryId}
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
        ) : recordKind ? (
          renderRecordArea()
        ) : selected && context ? (
          <EntryPage
            key={selected.id}
            flushRef={pageFlush}
            onReloadCatalog={async () => {
              const catalog = await api<Catalog>(
                `/libraries/${context.libraryId}/templates`,
              );
              setContext((c) => c && { ...c, catalog });
            }}
            entry={selected}
            entries={entries}
            bookId={bookId}
            book={context.book}
            seriesWorld={context.seriesWorld}
            catalog={context.catalog}
            scopeName={selected.scope && context.names[selected.scope.id]}
            bookTitle={context.book.title}
            busy={busy}
            action={action}
            onBack={() => setShowList(true)}
            onOpenAppearance={onOpenAppearance}
            onOpenEntry={(id) => void pick(id)}
            records={records.catalogs}
            recordErrors={records.errors}
            onOpenRecord={(kind, id) => void pickRecord(kind, id)}
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
        <Dialog
          sheet
          title="New Bible Entry"
          close={() => setCreating(false)}
        >
          <NewEntryForm
            initialType={creating}
            bookId={bookId}
            book={context.book}
            onCancel={() => setCreating(false)}
            onCreated={(entry) => {
              setEntries((es) => [...es, entry]);
              setFilter("");
              setNamesOnly(false);
              setCreating(false);
              void pick(entry.id);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

export function NewEntryForm({
  initialType,
  bookId,
  book,
  onCancel,
  onCreated,
}: {
  initialType?: string;
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
        <select name="entryType" defaultValue={initialType}>
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

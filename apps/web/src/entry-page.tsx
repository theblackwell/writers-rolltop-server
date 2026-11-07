// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import { api } from "./api.ts";
import { EntryContext } from "./entry-context.tsx";
import {
  EntryEditingContext,
  SaveStatus,
  useEntryWriter,
} from "./entry-editing.tsx";
import { EntryChanges } from "./entry-changes.tsx";
import { EntryLinks } from "./entry-relationships.tsx";
import { useRelationshipData } from "./relationships.tsx";
import { EntryFields } from "./entry-fields.tsx";
import type { Catalog } from "./entry-fields.tsx";
import {
  EntryHeader,
  EntryHeaderReadOnly,
  EntryPurge,
  entryTypeLabel,
} from "./entries.tsx";
import type { Entry } from "./entries.tsx";

export function scopeLabel(entry: Entry, scopeName?: string) {
  if (!entry.scope || entry.scope.kind === "book") return "This book only";
  const kind = entry.scope.kind === "universe" ? "world" : "series";
  return `Shared ${kind}${scopeName ? `: ${scopeName}` : ""}`;
}

// One bible entry assembled from the editors, top to bottom: header, fields
// (template, values, attachments), family and appearances, then Trash and
// permanent Delete. Text saves when you leave a field. A shared entry opens in
// "This book only" mode; Edit shared details switches the whole page to canon.
export function EntryPage({
  entry,
  entries,
  bookId,
  book,
  seriesWorld,
  catalog,
  scopeName,
  busy,
  action,
  onSaved,
  onPurged,
  onBack,
  onOpenAppearance,
  onOpenEntry,
  flushRef,
  onReloadCatalog,
}: {
  entry: Entry;
  entries: Entry[];
  bookId: string;
  book: { id: string; universeId?: string; seriesId?: string };
  seriesWorld?: string;
  catalog: Catalog;
  scopeName?: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  onSaved: (entry: Entry) => void;
  onPurged: (id: string, backup: string) => Promise<void>;
  onBack?: () => void;
  onOpenAppearance?: (nodeId: string, anchorId: string) => Promise<void>;
  /** Opens another entry's page (the app saves this page's drafts first). */
  onOpenEntry?: (id: string) => void;
  /** Receives a function that saves open drafts; false means stay here. */
  flushRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  onReloadCatalog?: () => Promise<void>;
}) {
  const [purging, setPurging] = useState(false);
  const shared = entry.scope?.kind !== "book";
  const trashed = !!entry.deletedAt;
  // Canon mode belongs to one entry and never carries over to another.
  const [canonFor, setCanonFor] = useState<string>();
  const canon = shared && canonFor === entry.id;
  const writer = useEntryWriter({
    entry,
    bookId,
    canon,
    onSaved,
    onReload: onReloadCatalog,
  });
  const { flush } = writer;
  const rel = useRelationshipData(bookId);
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => {
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flushRef, flush]);
  const template = catalog.templates.find((t) => t.id === entry.templateId);
  const switchMode = async (on: boolean) => {
    if (await flush()) setCanonFor(on ? entry.id : undefined);
  };
  const scopeWord = entry.scope?.kind === "universe" ? "world" : "series";
  const trash = () =>
    action(async () => {
      if (!(await flush()))
        throw new Error("Save or cancel your changes first.");
      const result = await writer.write({
        key: "trash",
        label: trashed ? "Restore" : "Move to Trash",
        run: writer.context.put("", { deleted: !trashed }),
      });
      if (!result.ok) throw new Error(result.message);
    });
  const conflict = writer.conflict;
  return (
    <EntryEditingContext.Provider value={writer.context}>
      <article className="entry-page" aria-label={`Entry ${entry.name}`}>
        <header className="entry-page-header">
          {onBack && (
            <button type="button" className="back-to-list" onClick={onBack}>
              ← Back to list
            </button>
          )}
          <div className="entry-title-row">
            <p className="eyebrow">{entryTypeLabel(entry.entryType)}</p>
            <SaveStatus status={writer.status} />
          </div>
          <h1>{entry.name}</h1>
          <p className="entry-badges">
            <span className="entry-badge">{scopeLabel(entry, scopeName)}</span>
            {entry.toBeNamed && (
              <span className="entry-badge">Name still to be decided</span>
            )}
            {trashed && <span className="entry-badge">In Trash</span>}
          </p>
          <p>
            Type: {entryTypeLabel(entry.entryType)} · Template:{" "}
            {entry.templateId
              ? (template?.name ?? "Current template unavailable")
              : "None"}
          </p>
          {trashed && (
            <>
              {!!entry.aliases.length && (
                <p>Also known as: {entry.aliases.join(", ")}</p>
              )}
              {entry.summary && (
                <p style={{ whiteSpace: "pre-wrap" }}>{entry.summary}</p>
              )}
              <p>Restore this entry to edit it.</p>
            </>
          )}
        </header>
        {shared &&
          (canon ? (
            <div
              className="entry-banner canon"
              role="region"
              aria-label="Shared canon"
            >
              <p>
                <strong>Editing shared canon.</strong> Changes apply to every
                book in this {scopeWord}
                {scopeName ? `, ${scopeName}` : ""}.
              </p>
              <button type="button" onClick={() => void switchMode(false)}>
                Back to This Book Only
              </button>
            </div>
          ) : (
            <div
              className="entry-banner"
              role="region"
              aria-label="Shared canon"
            >
              <p>
                This entry is shared across this {scopeWord}
                {scopeName ? `, ${scopeName}` : ""}. Field values you change
                save for this book only.
              </p>
              <button type="button" onClick={() => void switchMode(true)}>
                Edit shared details
              </button>
            </div>
          ))}
        {conflict && (
          <div className="entry-banner conflict" role="alert">
            {conflict.reloaded ? (
              <>
                <p>
                  <strong>Latest version loaded.</strong> Your unsaved changes
                  are still in the fields below.
                </p>
                <div className="dialog-actions">
                  <button type="button" onClick={() => void writer.saveHeld()}>
                    Save My Changes
                  </button>
                  <button type="button" onClick={writer.discard}>
                    Discard My Changes
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  <strong>This entry changed somewhere else</strong> (another
                  tab or browser), so your changes were not saved.{" "}
                  {conflict.message}
                </p>
                <div className="dialog-actions">
                  <button type="button" onClick={() => void writer.reload()}>
                    Reload entry
                  </button>
                </div>
              </>
            )}
            {!!conflict.drafts.length && (
              <label>
                Copy of your unsaved text
                <textarea
                  readOnly
                  value={conflict.drafts
                    .map((d) => `${d.label}:\n${d.text}`)
                    .join("\n\n")}
                />
              </label>
            )}
            {!!conflict.drafts.length && (
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(
                    conflict.drafts
                      .map((d) => `${d.label}:\n${d.text}`)
                      .join("\n\n"),
                  )
                }
              >
                Copy Draft
              </button>
            )}
            {writer.reloadError && <p role="alert">{writer.reloadError}</p>}
          </div>
        )}
        {writer.note && !conflict && <p role="alert">{writer.note}</p>}
        <Fragment key={writer.generation}>
          {!trashed && (
            <section className="entry-section" aria-label="Names and summary">
              {shared && !canon ? (
                <EntryHeaderReadOnly entry={entry} />
              ) : (
                <EntryHeader entry={entry} />
              )}
            </section>
          )}
          {!trashed && (
            <section
              className="entry-section"
              aria-label="Fields and attachments"
            >
              <EntryFields
                entry={entry}
                entries={entries}
                bookId={bookId}
                book={book}
                seriesWorld={seriesWorld}
                catalog={catalog}
              />
            </section>
          )}
        </Fragment>
        <section className="entry-section" aria-label="Relationships">
          <EntryLinks
            entry={entry}
            entries={entries}
            bookId={bookId}
            rel={rel}
            canonOk={!shared || canon}
            flush={flush}
            onOpenEntry={onOpenEntry}
          />
        </section>
        <EntryChanges
          entry={entry}
          bookId={bookId}
          canon={canon}
          rel={rel}
          flush={flush}
          onOpenEntry={onOpenEntry}
        />
        <section className="entry-section" aria-label="Family and appearances">
          <EntryContext
            key={entry.id}
            entry={entry}
            bookId={bookId}
            onOpen={onOpenAppearance}
          />
        </section>
        <section className="entry-section" aria-label="Trash and deletion">
          <h3>{trashed ? "Entry in Trash" : "Trash"}</h3>
          {purging && (
            <EntryPurge
              entry={entry}
              busy={busy}
              onCancel={() => setPurging(false)}
              onDelete={(confirmName, editSharedCanon) =>
                action(async () => {
                  const result = await api<{ backup: string }>(
                    `/books/${bookId}/entries/${entry.id}/purge`,
                    "POST",
                    {
                      confirmName,
                      expectedUpdatedAt: entry.updatedAt,
                      expectedDeletedAt: entry.deletedAt,
                      editSharedCanon,
                    },
                  );
                  setPurging(false);
                  await onPurged(entry.id, result.backup);
                })
              }
            />
          )}
          <button
            disabled={busy || purging || (shared && !canon)}
            onClick={() => void trash()}
            aria-label={`${trashed ? "Restore" : "Trash"} entry ${entry.name}`}
          >
            {trashed ? "Restore Entry" : "Move Entry to Trash"}
          </button>
          {shared && !canon && (
            <p className="hint">
              This entry is shared. Choose Edit shared details to{" "}
              {trashed ? "restore" : "move it to Trash"} for every book in this{" "}
              {scopeWord}.
            </p>
          )}
          {trashed && (
            <button
              disabled={busy || purging}
              aria-label={`Delete entry ${entry.name} permanently`}
              onClick={() => setPurging(true)}
            >
              Delete Entry Permanently…
            </button>
          )}
        </section>
      </article>
    </EntryEditingContext.Provider>
  );
}

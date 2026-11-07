// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { api } from "./api.ts";
import { EntryContext } from "./entry-context.tsx";
import { EntryFields } from "./entry-fields.tsx";
import type { Catalog } from "./entry-fields.tsx";
import { EntryForm, EntryPurge, entryTypeLabel } from "./entries.tsx";
import type { Entry } from "./entries.tsx";

export function scopeLabel(entry: Entry, scopeName?: string) {
  if (!entry.scope || entry.scope.kind === "book") return "This book only";
  const kind = entry.scope.kind === "universe" ? "world" : "series";
  return `Shared ${kind}${scopeName ? `: ${scopeName}` : ""}`;
}

// One bible entry assembled from the existing editors, top to bottom:
// header, fields (template, values, attachments), family and appearances,
// then Trash and permanent Delete. Saving stays per section in U1.
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
}) {
  const [purging, setPurging] = useState(false);
  const shared = entry.scope?.kind !== "book";
  const trashed = !!entry.deletedAt;
  const template = catalog.templates.find((t) => t.id === entry.templateId);
  const save = async (patch: object) => {
    onSaved(
      await api<Entry>(`/books/${bookId}/entries/${entry.id}`, "PUT", {
        ...patch,
        expectedUpdatedAt: entry.updatedAt,
        ...(shared ? { editSharedCanon: true } : {}),
      }),
    );
  };
  return (
    <article className="entry-page" aria-label={`Entry ${entry.name}`}>
      <header className="entry-page-header">
        {onBack && (
          <button type="button" className="back-to-list" onClick={onBack}>
            ← Back to list
          </button>
        )}
        <p className="eyebrow">{entryTypeLabel(entry.entryType)}</p>
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
      {!trashed && (
        <section className="entry-section" aria-label="Names and summary">
          <EntryForm
            key={entry.id + entry.updatedAt}
            entry={entry}
            busy={busy}
            onSave={(patch) => action(() => save(patch))}
          />
        </section>
      )}
      {!trashed && (
        <section className="entry-section" aria-label="Fields and attachments">
          <EntryFields
            entry={entry}
            entries={entries}
            bookId={bookId}
            book={book}
            seriesWorld={seriesWorld}
            catalog={catalog}
            busy={busy}
            action={action}
            onSaved={onSaved}
          />
        </section>
      )}
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
          disabled={busy || purging}
          onClick={() => void action(() => save({ deleted: !trashed }))}
          aria-label={`${trashed ? "Restore" : "Trash"} entry ${entry.name}`}
        >
          {trashed
            ? "Restore Entry"
            : shared
              ? "Trash Shared Entry for All Books"
              : "Move Entry to Trash"}
        </button>
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
  );
}

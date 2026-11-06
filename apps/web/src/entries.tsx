// SPDX-License-Identifier: AGPL-3.0-only
import { sameFamilyName } from "../../../packages/studio/src/family-values.ts";
import { useEffect, useRef, useState } from "react";
import { EntryFields } from "./entry-fields.tsx";
import type { Catalog } from "./entry-fields.tsx";
import { api } from "./api.ts";
export type Entry = {
  id: string;
  name: string;
  entryType: string;
  aliases: string[];
  summary?: string;
  givenName?: string;
  familyName?: string;
  toBeNamed?: true;
  updatedAt: string;
  deletedAt?: string;
  scope?: { kind: string; id: string };
  templateId?: string;
  values?: Record<string, unknown>;
  overrides?: {
    bookId: string;
    values: Record<string, unknown>;
    [key: string]: unknown;
  }[];
};
export function EntryList({
  bookId,
  catalog,
  book,
  seriesWorld,
  entries,
  onSaved,
  onPurged,
  onInspect,
  busy,
  action,
  initialId,
}: {
  initialId?: string;
  bookId: string;
  catalog: Catalog;
  book: { id: string; universeId?: string; seriesId?: string };
  seriesWorld?: string;
  entries: Entry[];
  onSaved: (entry: Entry) => void;
  onPurged: (id: string) => Promise<void>;
  onInspect: (entryId: string) => void;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
}) {
  const [namesOnly, setNamesOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("");
  const [trash, setTrash] = useState(false);
  const [purging, setPurging] = useState<Entry>();
  const [receipt, setReceipt] = useState("");
  const [editing, setEditing] = useState<string>();
  const [fieldsEditing, setFieldsEditing] = useState<string>();
  const opened = useRef<string | undefined>(undefined);
  const [navigationError, setNavigationError] = useState("");
  useEffect(() => {
    if (initialId && !busy && opened.current !== initialId) {
      opened.current = initialId;
      const target = entries.find((e) => e.id === initialId);
      if (target && !target.deletedAt) setEditing(initialId);
      else
        setNavigationError(
          "This entry is no longer live here. Review Trash or check names again.",
        );
    }
  }, [initialId, entries, busy]);
  const fieldEntry = entries.find((e) => e.id === fieldsEditing);
  const selected = entries.find((e) => e.id === editing);
  const shown = entries
    .filter(
      (e) =>
        Boolean(e.deletedAt) === trash &&
        (!namesOnly || e.toBeNamed === true) &&
        (!kind || e.entryType === kind) &&
        [e.name, ...e.aliases].some((s) =>
          s.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const save = async (entry: Entry, patch: object) => {
    const updated = await api<Entry>(
      `/books/${bookId}/entries/${entry.id}`,
      "PUT",
      {
        ...patch,
        expectedUpdatedAt: entry.updatedAt,
        ...(entry.scope?.kind !== "book" ? { editSharedCanon: true } : {}),
      },
    );
    onSaved(updated);
    setEditing(undefined);
    if (
      (updated.name !== entry.name ||
        updated.familyName !== entry.familyName) &&
      !updated.deletedAt &&
      entries.some(
        (other) =>
          other.id !== updated.id &&
          !other.deletedAt &&
          sameFamilyName(updated, other),
      )
    )
      onInspect(updated.id);
  };
  return (
    <section aria-label="Bible entry details">
      {navigationError && <p role="alert">{navigationError}</p>}
      <label>
        Find name or alias
        <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <label>
        Entry type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {[...new Set(entries.map((e) => e.entryType))].sort().map((t) => (
            <option key={t} value={t}>
              {t === "worldRule"
                ? "World rule"
                : t[0].toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={namesOnly}
          onChange={(e) => setNamesOnly(e.target.checked)}
        />
        Only names still needed
      </label>
      <label className="entry-toggle">
        <input
          type="checkbox"
          checked={trash}
          onChange={(e) => setTrash(e.target.checked)}
        />
        Show Entry Trash
      </label>
      {receipt && (
        <p role="status">
          Deleted permanently. Recovery backup: {receipt}. Keep this filename
          for your administrator.
        </p>
      )}
      {purging && (
        <EntryPurge
          entry={purging}
          busy={busy}
          onCancel={() => setPurging(undefined)}
          onDelete={(confirmName, editSharedCanon) =>
            action(async () => {
              const result = await api<{ backup: string }>(
                `/books/${bookId}/entries/${purging.id}/purge`,
                "POST",
                {
                  confirmName,
                  expectedUpdatedAt: purging.updatedAt,
                  expectedDeletedAt: purging.deletedAt,
                  editSharedCanon,
                },
              );
              setReceipt(result.backup);
              setPurging(undefined);
              await onPurged(purging.id);
            })
          }
        />
      )}
      {selected && (
        <EntryForm
          key={selected.id + selected.updatedAt}
          entry={selected}
          busy={busy}
          onCancel={() => setEditing(undefined)}
          onSave={(patch) => action(() => save(selected, patch))}
        />
      )}
      {fieldEntry && (
        <EntryFields
          entry={fieldEntry}
          entries={entries}
          bookId={bookId}
          book={book}
          seriesWorld={seriesWorld}
          catalog={catalog}
          busy={busy}
          action={action}
          onSaved={onSaved}
          onClose={() => setFieldsEditing(undefined)}
        />
      )}
      {!shown.length && (
        <p>{trash ? "No entries in Trash match." : "No entries match."}</p>
      )}
      <ul className="search-results">
        {shown.map((entry) => (
          <li key={entry.id}>
            <strong>{entry.name}</strong> ({entry.entryType})
            {entry.scope && entry.scope.kind !== "book" && (
              <span>
                {" "}
                · Shared {entry.scope.kind === "universe"
                  ? "world"
                  : "series"}{" "}
                entry
              </span>
            )}
            {entry.toBeNamed && <span> · Name still to be decided</span>}
            {!!entry.aliases.length && (
              <p>Also known as: {entry.aliases.join(", ")}</p>
            )}
            <p style={{ whiteSpace: "pre-wrap" }}>{entry.summary}</p>
            {!entry.deletedAt && (
              <button
                disabled={busy || !!editing || !!fieldsEditing || !!purging}
                onClick={() => setEditing(entry.id)}
                aria-label={`Edit ${entry.name}`}
              >
                {entry.scope?.kind !== "book" ? "Edit Shared Canon…" : "Edit…"}
              </button>
            )}
            {!entry.deletedAt && (
              <button
                disabled={busy || !!editing || !!fieldsEditing || !!purging}
                onClick={() => setFieldsEditing(entry.id)}
                aria-label={`Fields for ${entry.name}`}
              >
                Fields…
              </button>
            )}
            <button
              disabled={busy || !!editing || !!fieldsEditing || !!purging}
              onClick={() => onInspect(entry.id)}
              aria-label={`Family and appearances for ${entry.name}`}
            >
              {entry.entryType === "character"
                ? "Family and Appearances…"
                : "Appearances…"}
            </button>
            <button
              disabled={busy || !!editing || !!fieldsEditing || !!purging}
              onClick={() =>
                void action(() => save(entry, { deleted: !entry.deletedAt }))
              }
              aria-label={`${entry.deletedAt ? "Restore" : "Trash"} entry ${entry.name}`}
            >
              {entry.deletedAt
                ? "Restore Entry"
                : entry.scope?.kind !== "book"
                  ? "Trash Shared Entry for All Books"
                  : "Move Entry to Trash"}
            </button>
            {entry.deletedAt && (
              <button
                disabled={busy || !!editing || !!fieldsEditing || !!purging}
                aria-label={`Delete entry ${entry.name} permanently`}
                onClick={() => {
                  setReceipt("");
                  setPurging(entry);
                }}
              >
                Delete Entry Permanently…
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
function EntryForm({
  entry,
  busy,
  onCancel,
  onSave,
}: {
  entry: Entry;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: object) => Promise<void>;
}) {
  const [name, setName] = useState(entry.name);
  const split = entry.name.lastIndexOf(" ");
  const initialGiven =
    entry.givenName ??
    (entry.familyName !== undefined
      ? ""
      : split < 0
        ? entry.name
        : entry.name.slice(0, split));
  const initialFamily =
    entry.familyName ??
    (entry.givenName !== undefined || split < 0
      ? ""
      : entry.name.slice(split + 1));
  const [given, setGiven] = useState(initialGiven);
  const [family, setFamily] = useState(initialFamily);
  const [aliases, setAliases] = useState(entry.aliases.join("\n"));
  const [summary, setSummary] = useState(entry.summary ?? "");
  const [toBeNamed, setToBeNamed] = useState(!!entry.toBeNamed);
  const character = entry.entryType === "character";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const patch: Record<string, unknown> = {};
        if (character) {
          if (given !== initialGiven || family !== initialFamily) {
            patch.givenName = given;
            patch.familyName = family;
          }
        } else if (name !== entry.name) patch.name = name;
        if (aliases !== entry.aliases.join("\n"))
          patch.aliases = aliases
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        if (summary !== (entry.summary ?? "")) patch.summary = summary;
        if (toBeNamed !== !!entry.toBeNamed) patch.toBeNamed = toBeNamed;
        void onSave(patch);
      }}
    >
      <h3>Edit {entry.name}</h3>
      {entry.scope?.kind !== "book" && (
        <p>
          These details are shared canon. Saving changes them for every book in
          this scope.
        </p>
      )}
      <fieldset disabled={busy}>
        {character ? (
          <>
            <label>
              First name
              <input
                autoFocus
                maxLength={500}
                value={given}
                onChange={(e) => setGiven(e.target.value)}
              />
            </label>
            <label>
              Last name
              <input
                maxLength={500}
                value={family}
                onChange={(e) => setFamily(e.target.value)}
              />
            </label>
            <p>
              Display name:{" "}
              {[given.trim(), family.trim()].filter(Boolean).join(" ") ||
                "Enter a name"}
            </p>
          </>
        ) : (
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
        <label>
          Aliases (one per line)
          <textarea
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
          />
        </label>
        <label>
          Summary
          <textarea
            maxLength={20000}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <label className="entry-toggle">
          <input
            type="checkbox"
            checked={toBeNamed}
            onChange={(e) => setToBeNamed(e.target.checked)}
          />
          Name still to be decided
        </label>
        <p>Changes save explicitly. Entry type and scope stay the same.</p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel Edit
          </button>
          <button
            className="primary"
            disabled={
              character ? !(given.trim() || family.trim()) : !name.trim()
            }
          >
            {busy
              ? "Saving…"
              : entry.scope?.kind !== "book"
                ? "Save Shared Canon"
                : "Save Entry"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function EntryPurge({
  entry,
  busy,
  onCancel,
  onDelete,
}: {
  entry: Entry;
  busy: boolean;
  onCancel: () => void;
  onDelete: (name: string, shared: boolean) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const isShared = entry.scope?.kind !== "book";
  return (
    <form
      aria-label={`Delete ${entry.name} permanently`}
      onSubmit={(e) => {
        e.preventDefault();
        void onDelete(name, shared);
      }}
    >
      <h3>Delete {entry.name} Permanently</h3>
      <p>
        This removes the entry, its relationships and passage links, and clears
        references to it in other entries and manuscript details. Manuscript
        text stays. A verified library recovery backup is required first.
      </p>
      {isShared && (
        <label className="entry-toggle" style={{ marginBottom: "1rem" }}>
          <input
            type="checkbox"
            checked={shared}
            disabled={busy}
            onChange={(e) => setShared(e.target.checked)}
          />
          Delete this shared entry for every book in its scope
        </label>
      )}
      <label>
        Type the exact entry name to confirm
        <input
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </label>
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button disabled={busy || name !== entry.name || (isShared && !shared)}>
        Delete Permanently
      </button>
    </form>
  );
}

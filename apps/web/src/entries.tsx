// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
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
  busy,
  action,
}: {
  bookId: string;
  catalog: Catalog;
  book: { id: string; universeId?: string; seriesId?: string };
  seriesWorld?: string;
  entries: Entry[];
  onSaved: (entry: Entry) => void;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("");
  const [trash, setTrash] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [fieldsEditing, setFieldsEditing] = useState<string>();
  const fieldEntry = entries.find((e) => e.id === fieldsEditing);
  const selected = entries.find((e) => e.id === editing);
  const shown = entries
    .filter(
      (e) =>
        Boolean(e.deletedAt) === trash &&
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
  };
  return (
    <section aria-label="Bible entry details">
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
      <label className="entry-toggle">
        <input
          type="checkbox"
          checked={trash}
          onChange={(e) => setTrash(e.target.checked)}
        />
        Show Entry Trash
      </label>
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
                disabled={busy || !!editing || !!fieldsEditing}
                onClick={() => setEditing(entry.id)}
                aria-label={`Edit ${entry.name}`}
              >
                {entry.scope?.kind !== "book" ? "Edit Shared Canon…" : "Edit…"}
              </button>
            )}
            {!entry.deletedAt && (
              <button
                disabled={busy || !!editing || !!fieldsEditing}
                onClick={() => setFieldsEditing(entry.id)}
                aria-label={`Fields for ${entry.name}`}
              >
                Fields…
              </button>
            )}
            <button
              disabled={busy || !!editing || !!fieldsEditing}
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

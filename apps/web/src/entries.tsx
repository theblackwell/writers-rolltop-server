// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { FieldError, useDraftSave, useEntryEditing } from "./entry-editing.tsx";
export type Entry = {
  attachments?: string[];
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
export const entryTypes = [
  "character",
  "location",
  "organization",
  "object",
  "event",
  "plotline",
  "worldRule",
  "research",
  "term",
] as const;
const typeLabels: Record<string, [string, string]> = {
  character: ["Character", "Characters"],
  location: ["Location", "Locations"],
  organization: ["Organization", "Organizations"],
  object: ["Object", "Objects"],
  event: ["Event", "Events"],
  plotline: ["Plotline", "Plotlines"],
  worldRule: ["World rule", "World rules"],
  research: ["Research", "Research"],
  term: ["Term", "Terms"],
};
export const entryTypeLabel = (type: string, plural = false) =>
  typeLabels[type]?.[plural ? 1 : 0] ?? type;
const trimmed = (a: string, b: string) => a.trim() === b.trim();
const aliasList = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
const sameAliases = (a: string, b: string) =>
  JSON.stringify(aliasList(a)) === JSON.stringify(aliasList(b));

// Header details of one entry. Text saves when you leave a field (or press
// Enter in a single-line field); the checkbox saves when you change it.
export function EntryHeader({ entry }: { entry: Entry }) {
  const ctx = useEntryEditing();
  const character = entry.entryType === "character";
  const split = entry.name.lastIndexOf(" ");
  const savedNames = {
    given:
      entry.givenName ??
      (entry.familyName !== undefined
        ? ""
        : split < 0
          ? entry.name
          : entry.name.slice(0, split)),
    family:
      entry.familyName ??
      (entry.givenName !== undefined || split < 0
        ? ""
        : entry.name.slice(split + 1)),
  };
  const names = useDraftSave({
    key: "names",
    label: "First and last name",
    saved: savedNames,
    same: (a, b) => trimmed(a.given, b.given) && trimmed(a.family, b.family),
    show: (d) => `First name: ${d.given}\nLast name: ${d.family}`,
    validate: (d) =>
      d.given.trim() || d.family.trim()
        ? undefined
        : "Enter a first or last name.",
    send: (d) => ctx.put("", { givenName: d.given, familyName: d.family }),
  });
  const name = useDraftSave({
    key: "name",
    label: "Name",
    saved: entry.name,
    same: trimmed,
    show: (d) => d,
    validate: (d) => (d.trim() ? undefined : "Enter a name."),
    send: (d) => ctx.put("", { name: d }),
  });
  const aliases = useDraftSave({
    key: "aliases",
    label: "Aliases",
    saved: entry.aliases.join("\n"),
    same: sameAliases,
    show: (d) => d,
    send: (d) => ctx.put("", { aliases: aliasList(d) }),
  });
  const summary = useDraftSave({
    key: "summary",
    label: "Summary",
    saved: entry.summary ?? "",
    same: (a, b) => a === b,
    show: (d) => d,
    send: (d) => ctx.put("", { summary: d }),
  });
  const toBeNamed = useDraftSave({
    key: "toBeNamed",
    label: "Name still to be decided",
    saved: !!entry.toBeNamed,
    same: (a, b) => a === b,
    show: (d) => (d ? "Name still to be decided" : "Name decided"),
    send: (d) => ctx.put("", { toBeNamed: d }),
  });
  const enter =
    (commit: () => Promise<boolean>) => (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      }
    };
  return (
    <div className="entry-edit">
      <h3>Edit {entry.name}</h3>
      {character ? (
        <div
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              void names.commit();
          }}
        >
          <label>
            First name
            <input
              maxLength={500}
              value={names.draft.given}
              aria-invalid={!!names.error}
              onKeyDown={enter(names.commit)}
              onChange={(e) =>
                names.setDraft({ ...names.draft, given: e.target.value })
              }
            />
          </label>
          <label>
            Last name
            <input
              maxLength={500}
              value={names.draft.family}
              aria-invalid={!!names.error}
              onKeyDown={enter(names.commit)}
              onChange={(e) =>
                names.setDraft({ ...names.draft, family: e.target.value })
              }
            />
          </label>
          <p>
            Display name:{" "}
            {[names.draft.given.trim(), names.draft.family.trim()]
              .filter(Boolean)
              .join(" ") || "Enter a name"}
          </p>
          <FieldError id="entry-names-error" message={names.error} />
        </div>
      ) : (
        <label>
          Name
          <input
            maxLength={500}
            value={name.draft}
            aria-invalid={!!name.error}
            aria-describedby={name.error ? "entry-name-error" : undefined}
            onKeyDown={enter(name.commit)}
            onBlur={() => void name.commit()}
            onChange={(e) => name.setDraft(e.target.value)}
          />
        </label>
      )}
      {!character && <FieldError id="entry-name-error" message={name.error} />}
      <label>
        Aliases (one per line)
        <textarea
          value={aliases.draft}
          aria-invalid={!!aliases.error}
          onBlur={() => void aliases.commit()}
          onChange={(e) => aliases.setDraft(e.target.value)}
        />
      </label>
      <FieldError id="entry-aliases-error" message={aliases.error} />
      <label>
        Summary
        <textarea
          maxLength={20000}
          value={summary.draft}
          aria-invalid={!!summary.error}
          onBlur={() => void summary.commit()}
          onChange={(e) => summary.setDraft(e.target.value)}
        />
      </label>
      <FieldError id="entry-summary-error" message={summary.error} />
      <label className="entry-toggle">
        <input
          type="checkbox"
          checked={toBeNamed.draft}
          onChange={(e) => {
            toBeNamed.setDraft(e.target.checked);
            void toBeNamed.commit(e.target.checked);
          }}
        />
        Name still to be decided
      </label>
      <FieldError id="entry-tobenamed-error" message={toBeNamed.error} />
      <p className="hint">
        Changes save when you leave a field. Entry type and scope stay the same.
      </p>
    </div>
  );
}

/** Shared details while the page is in "This book only" mode. */
export function EntryHeaderReadOnly({ entry }: { entry: Entry }) {
  return (
    <div className="entry-edit">
      <h3>{entry.name}</h3>
      {!!entry.aliases.length && (
        <p>Also known as: {entry.aliases.join(", ")}</p>
      )}
      {entry.summary && (
        <p style={{ whiteSpace: "pre-wrap" }}>{entry.summary}</p>
      )}
      {entry.toBeNamed && <p>Name still to be decided.</p>}
      <p className="hint">
        These details are shared canon. Choose Edit shared details to change
        them for every book in this scope.
      </p>
    </div>
  );
}

export function EntryPurge({
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

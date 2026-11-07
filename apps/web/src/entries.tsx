// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
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
export function EntryForm({
  entry,
  busy,
  onCancel,
  onSave,
}: {
  entry: Entry;
  busy: boolean;
  onCancel?: () => void;
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
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Cancel Edit
            </button>
          )}
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

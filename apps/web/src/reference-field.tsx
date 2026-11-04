// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { Entry } from "./entries.tsx";
import type { Field } from "./entry-fields.tsx";
export const referenceTypes = ["entryReference", "entryReferences"];
export function referenceSummary(value: unknown, entries: Entry[]) {
  return (
    (Array.isArray(value) ? value : [value])
      .map((id) => {
        const e = entries.find((e) => e.id === id);
        return e
          ? e.name + (e.deletedAt ? " (in Trash)" : "")
          : `Unavailable entry (${id})`;
      })
      .join(", ") || "No linked entries"
  );
}
export function ReferenceField({
  field,
  value,
  entries,
  busy,
  onCancel,
  onSave,
}: {
  field: Field;
  value: unknown;
  entries: Entry[];
  busy: boolean;
  onCancel: () => void;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [ids, setIds] = useState<string[]>(
    Array.isArray(value) ? value : typeof value === "string" ? [value] : [],
  );
  const candidates = entries.filter(
    (e) =>
      !e.deletedAt &&
      (!field.targetEntryTypes || field.targetEntryTypes.includes(e.entryType)),
  );
  const options = [
    ...candidates,
    ...ids
      .filter((id) => !candidates.some((e) => e.id === id))
      .map((id) => ({ id, name: referenceSummary(id, entries) })),
  ];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(
          field.fieldType === "entryReference" ? (ids[0] ?? null) : ids,
        );
      }}
    >
      <h4>Edit {field.label}</h4>
      <fieldset disabled={busy}>
        {field.fieldType === "entryReference" ? (
          <label>
            {field.label}
            <select
              autoFocus
              value={ids[0] ?? ""}
              onChange={(e) => setIds(e.target.value ? [e.target.value] : [])}
            >
              <option value="">No linked entry</option>
              {options.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <fieldset>
            <legend>{field.label}</legend>
            {options.map((e) => (
              <label className="entry-toggle" key={e.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(e.id)}
                  onChange={(v) =>
                    setIds(
                      v.target.checked
                        ? [...ids, e.id]
                        : ids.filter((id) => id !== e.id),
                    )
                  }
                />
                {e.name}
              </label>
            ))}
          </fieldset>
        )}
        <p>
          Choose live entries in this book. Saved links to entries in Trash stay
          visible until you clear or replace them.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel Field Edit
          </button>
          <button type="button" onClick={() => void onSave(null)}>
            Clear Value
          </button>
          <button className="primary">Save Value</button>
        </div>
      </fieldset>
    </form>
  );
}

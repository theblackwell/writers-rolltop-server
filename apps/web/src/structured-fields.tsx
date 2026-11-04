// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { structuredValueError } from "../../../packages/studio/src/structured-values.ts";
import type { Field } from "./entry-fields.tsx";
export function structuredSummary(field: Field, value: any): string {
  if (field.fieldType === "selection" && Array.isArray(value))
    return value.length
      ? value
          .map(
            (id) =>
              field.options?.find((o) => o.id === id)?.label ??
              `Unavailable choice (${id})`,
          )
          .join(", ")
      : "No choices";
  if (field.fieldType === "fictionalDate" && value && typeof value === "object")
    return [
      value.label,
      value.calendar,
      value.ordinal === undefined ? undefined : `Ordinal ${value.ordinal}`,
    ]
      .filter((v) => v !== undefined)
      .join(" · ");
  if (
    field.fieldType === "table" &&
    Array.isArray(value?.columns) &&
    Array.isArray(value?.rows)
  )
    return `${value.rows.length} rows × ${value.columns.length} columns: ${value.columns.join(", ")}`;
  return String(value);
}
export function StructuredForm({
  field,
  value,
  busy,
  onCancel,
  onSave,
}: {
  field: Field;
  value: any;
  busy: boolean;
  onCancel: () => void;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>(
    Array.isArray(value) ? value : [],
  );
  const [date, setDate] = useState(typeof value === "string" ? value : "");
  const [label, setLabel] = useState(value?.label ?? "");
  const [calendar, setCalendar] = useState(value?.calendar ?? "");
  const [ordinal, setOrdinal] = useState(
    value?.ordinal === undefined ? "" : String(value.ordinal),
  );
  const [table, setTable] = useState<{ columns: string[]; rows: string[][] }>(
    field.fieldType === "table" && value
      ? value
      : { columns: ["Column 1"], rows: [] },
  );
  const [error, setError] = useState("");
  const options = [
    ...(field.options ?? []),
    ...selected
      .filter((id) => !field.options?.some((o) => o.id === id))
      .map((id) => ({ id, label: `Unavailable choice (${id})` })),
  ];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        let next: any;
        switch (field.fieldType) {
          case "selection":
            next = selected;
            break;
          case "realDate":
            next = date;
            break;
          case "fictionalDate":
            if (
              ordinal !== "" &&
              (!/^-?\d+$(?![\s\S])/.test(ordinal) ||
                !Number.isSafeInteger(Number(ordinal)))
            ) {
              setError(
                "Enter an integer ordinal within ±(2^53−1), or leave it unset.",
              );
              return;
            }
            next = {
              label,
              ...(calendar !== "" ? { calendar } : {}),
              ...(ordinal !== "" ? { ordinal: Number(ordinal) } : {}),
            };
            break;
          case "table":
            next = table;
            break;
        }
        const problem = structuredValueError(field, next);
        setError(problem ?? "");
        if (!problem) void onSave(next);
      }}
    >
      <h4>Edit {field.label}</h4>
      <fieldset disabled={busy}>
        {field.fieldType === "selection" &&
          (field.multiple ? (
            <fieldset>
              <legend>{field.label} choices</legend>
              {options.map((o) => (
                <label className="entry-toggle" key={o.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(o.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, o.id]
                          : selected.filter((id) => id !== o.id),
                      )
                    }
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
          ) : (
            <label>
              {field.label}
              <select
                autoFocus
                value={selected[0] ?? ""}
                onChange={(e) =>
                  setSelected(e.target.value ? [e.target.value] : [])
                }
              >
                <option value="">No choice</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        {field.fieldType === "realDate" && (
          <label>
            {field.label}
            <input
              autoFocus
              value={date}
              placeholder="YYYY-MM-DD"
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        )}
        {field.fieldType === "fictionalDate" && (
          <>
            <label>
              Date label
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label>
              Calendar (optional)
              <input
                value={calendar}
                onChange={(e) => setCalendar(e.target.value)}
              />
            </label>
            <label>
              Ordinal (optional)
              <input
                inputMode="numeric"
                value={ordinal}
                onChange={(e) => setOrdinal(e.target.value)}
              />
            </label>
            <p>
              The label uses your story's calendar. The ordinal is an optional
              position for sorting.
            </p>
          </>
        )}
        {field.fieldType === "table" && (
          <>
            <p>
              Up to 20 columns and 500 rows. Each heading or cell allows 1,000
              characters. Removing a row or column removes its contents when you
              save.
            </p>
            <div className="bible-table">
              <table>
                <thead>
                  <tr>
                    {table.columns.map((c, i) => (
                      <th key={i}>
                        <input
                          aria-label={`Column ${i + 1} heading`}
                          value={c}
                          onChange={(e) =>
                            setTable((t) => ({
                              ...t,
                              columns: t.columns.map((c, j) =>
                                i === j ? e.target.value : c,
                              ),
                            }))
                          }
                        />
                        <button
                          type="button"
                          disabled={table.columns.length === 1}
                          aria-label={`Remove column ${i + 1}`}
                          onClick={() =>
                            setTable((t) => ({
                              columns: t.columns.filter((_, j) => i !== j),
                              rows: t.rows.map((r) =>
                                r.filter((_, j) => i !== j),
                              ),
                            }))
                          }
                        >
                          Remove Column
                        </button>
                      </th>
                    ))}
                    <th>Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td key={j}>
                          <textarea
                            aria-label={`Row ${i + 1} column ${j + 1}`}
                            value={c}
                            onChange={(e) =>
                              setTable((t) => ({
                                ...t,
                                rows: t.rows.map((r, k) =>
                                  k === i
                                    ? r.map((c, n) =>
                                        n === j ? e.target.value : c,
                                      )
                                    : r,
                                ),
                              }))
                            }
                          />
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          aria-label={`Remove row ${i + 1}`}
                          onClick={() =>
                            setTable((t) => ({
                              ...t,
                              rows: t.rows.filter((_, j) => i !== j),
                            }))
                          }
                        >
                          Remove Row
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={table.columns.length >= 20}
                onClick={() =>
                  setTable((t) => ({
                    columns: [...t.columns, `Column ${t.columns.length + 1}`],
                    rows: t.rows.map((r) => [...r, ""]),
                  }))
                }
              >
                Add Column
              </button>
              <button
                type="button"
                disabled={table.rows.length >= 500}
                onClick={() =>
                  setTable((t) => ({
                    ...t,
                    rows: [...t.rows, t.columns.map(() => "")],
                  }))
                }
              >
                Add Row
              </button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
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

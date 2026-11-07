// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { structuredValueError } from "../../../packages/studio/src/structured-values.ts";
import { AttachmentField } from "./attachments.tsx";
import type { Entry } from "./entries.tsx";
import {
  FieldError,
  useBlockingDraft,
  useDraftSave,
  useEntryEditing,
} from "./entry-editing.tsx";
import type { Field } from "./entry-fields.tsx";
import { referenceTypes } from "./reference-field.tsx";
import { StructuredForm } from "./structured-fields.tsx";

export const inlineTypes = [
  "shortText",
  "longText",
  "integer",
  "decimal",
  "boolean",
  "selection",
  "realDate",
  "fictionalDate",
  ...referenceTypes,
];
type DateDraft = { label: string; calendar: string; ordinal: string };
type Draft = string | string[] | DateDraft;

function draftOf(field: Field, value: unknown): Draft {
  switch (field.fieldType) {
    case "selection":
    case "entryReferences":
      return Array.isArray(value) ? value : [];
    case "entryReference":
      return typeof value === "string" ? [value] : [];
    case "fictionalDate": {
      const v = (value ?? {}) as Record<string, unknown>;
      return {
        label: typeof v.label === "string" ? v.label : "",
        calendar: typeof v.calendar === "string" ? v.calendar : "",
        ordinal: v.ordinal === undefined ? "" : String(v.ordinal),
      };
    }
    default:
      return value === undefined ? "" : String(value);
  }
}
const integer = /^-?\d+$/;
const decimal = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$(?![\s\S])/;
/** The value to send for a draft, or the message that explains why not. */
function build(field: Field, d: Draft): { value: unknown } | { error: string } {
  const text = typeof d === "string" ? d : "";
  switch (field.fieldType) {
    case "integer":
      return integer.test(text) && Number.isSafeInteger(Number(text))
        ? { value: Number(text) }
        : {
            error: "Enter an integer within ±(2^53−1), or choose Clear Value.",
          };
    case "decimal":
      return text.length <= 1000 && decimal.test(text)
        ? { value: text }
        : {
            error:
              "Use an exact decimal such as 12.50, without exponent notation, or choose Clear Value.",
          };
    case "boolean":
      return { value: text === "" ? null : text === "true" };
    case "entryReference":
      return { value: (d as string[])[0] ?? null };
    case "entryReferences":
      return { value: d };
    case "selection":
    case "realDate": {
      const problem = structuredValueError(field, d);
      return problem ? { error: problem } : { value: d };
    }
    case "fictionalDate": {
      const v = d as DateDraft;
      if (
        v.ordinal !== "" &&
        (!/^-?\d+$(?![\s\S])/.test(v.ordinal) ||
          !Number.isSafeInteger(Number(v.ordinal)))
      )
        return {
          error:
            "Enter an integer ordinal within ±(2^53−1), or leave it unset.",
        };
      const next = {
        label: v.label,
        ...(v.calendar !== "" ? { calendar: v.calendar } : {}),
        ...(v.ordinal !== "" ? { ordinal: Number(v.ordinal) } : {}),
      };
      const problem = structuredValueError(field, next);
      return problem ? { error: problem } : { value: next };
    }
    default:
      return { value: text };
  }
}
function normal(field: Field, d: Draft) {
  return field.fieldType === "integer" &&
    typeof d === "string" &&
    integer.test(d) &&
    Number.isSafeInteger(Number(d))
    ? String(Number(d))
    : d;
}
const sameDraft = (field: Field) => (a: Draft, b: Draft) =>
  JSON.stringify(normal(field, a)) === JSON.stringify(normal(field, b));
const showDraft = (field: Field, d: Draft, names: (id: string) => string) =>
  Array.isArray(d)
    ? d.map(names).join(", ")
    : typeof d === "object"
      ? [d.label, d.calendar, d.ordinal].filter(Boolean).join(" · ")
      : d;

/**
 * One template field as an inline editor. `value` is what this page edits:
 * canon (or the book's own value) or, in this-book mode, the book's override
 * over canon. Text, numbers and dates save when left; choices on change.
 */
export function InlineField({
  field,
  value,
  clearable,
  layer,
  candidates,
  readValue,
}: {
  field: Field;
  value: unknown;
  clearable: boolean;
  layer: "canon" | "book";
  candidates: Entry[];
  readValue: (entry: Entry) => unknown;
}) {
  const ctx = useEntryEditing();
  const type = field.fieldType;
  const names = (id: string) =>
    field.options?.find((o) => o.id === id)?.label ??
    candidates.find((e) => e.id === id)?.name ??
    id;
  const f = useDraftSave<Draft>({
    key: `field:${field.id}`,
    label: field.label,
    saved: draftOf(field, value),
    same: sameDraft(field),
    show: (d) => showDraft(field, d, names),
    validate: (d) =>
      "error" in build(field, d)
        ? (build(field, d) as { error: string }).error
        : undefined,
    send: (d) =>
      ctx.put(`values/${field.id}`, {
        value: (build(field, d) as { value: unknown }).value,
        expectedFieldUpdatedAt: field.updatedAt,
      }),
  });
  const [clearing, setClearing] = useState(false);
  const clear = async () => {
    setClearing(true);
    const result = await ctx.write({
      key: `field:${field.id}:clear`,
      label: field.label,
      run: ctx.put(`values/${field.id}`, {
        value: null,
        expectedFieldUpdatedAt: field.updatedAt,
      }),
    });
    setClearing(false);
    if (result.ok) f.adopt(draftOf(field, readValue(result.entry)));
    else if (result.status !== 409) f.setError(result.message);
  };
  const errorId = `field-error-${field.id}`;
  const text = typeof f.draft === "string" ? f.draft : "";
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void f.commit();
    }
  };
  const label = `${field.label}${field.required ? " (suggested)" : ""}`;
  const choose = (next: Draft) => {
    f.setDraft(next);
    void f.commit(next);
  };
  const ids = Array.isArray(f.draft) ? f.draft : [];
  const selectionOptions = [
    ...(type === "selection"
      ? (field.options ?? [])
      : candidates
          .filter(
            (e) =>
              !e.deletedAt &&
              (!field.targetEntryTypes ||
                field.targetEntryTypes.includes(e.entryType)),
          )
          .map((e) => ({ id: e.id, label: e.name }))),
  ];
  for (const id of ids)
    if (!selectionOptions.some((o) => o.id === id))
      selectionOptions.push({
        id,
        label:
          type === "selection"
            ? `Unavailable choice (${id})`
            : `Unavailable entry (${id})`,
      });
  let control;
  if (type === "boolean")
    control = (
      <label>
        {label}
        <select
          value={text}
          aria-describedby={f.error ? errorId : undefined}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="">Not set</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      </label>
    );
  else if (type === "selection" || type === "entryReferences") {
    const multiple = type === "entryReferences" || field.multiple;
    control = multiple ? (
      <fieldset>
        <legend>{label}</legend>
        {selectionOptions.map((o) => (
          <label className="entry-toggle" key={o.id}>
            <input
              type="checkbox"
              checked={ids.includes(o.id)}
              onChange={(e) =>
                choose(
                  e.target.checked
                    ? [...ids, o.id]
                    : ids.filter((id) => id !== o.id),
                )
              }
            />
            {o.label}
          </label>
        ))}
      </fieldset>
    ) : (
      <label>
        {label}
        <select
          value={ids[0] ?? ""}
          onChange={(e) => choose(e.target.value ? [e.target.value] : [])}
        >
          <option value="">No choice</option>
          {selectionOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  } else if (type === "entryReference")
    control = (
      <label>
        {label}
        <select
          value={ids[0] ?? ""}
          onChange={(e) => choose(e.target.value ? [e.target.value] : [])}
        >
          <option value="">No linked entry</option>
          {selectionOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  else if (type === "fictionalDate") {
    const d = f.draft as DateDraft;
    const set = (patch: Partial<DateDraft>) => f.setDraft({ ...d, ...patch });
    control = (
      <div
        role="group"
        aria-label={label}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            void f.commit();
        }}
      >
        <label>
          {field.label}: date label
          <input
            value={d.label}
            onKeyDown={enter}
            onChange={(e) => set({ label: e.target.value })}
          />
        </label>
        <label>
          Calendar (optional)
          <input
            value={d.calendar}
            onKeyDown={enter}
            onChange={(e) => set({ calendar: e.target.value })}
          />
        </label>
        <label>
          Ordinal (optional)
          <input
            inputMode="numeric"
            value={d.ordinal}
            onKeyDown={enter}
            onChange={(e) => set({ ordinal: e.target.value })}
          />
        </label>
      </div>
    );
  } else if (type === "longText")
    control = (
      <label>
        {label}
        <textarea
          maxLength={20000}
          value={text}
          aria-invalid={!!f.error}
          aria-describedby={f.error ? errorId : undefined}
          onBlur={() => void f.commit()}
          onChange={(e) => f.setDraft(e.target.value)}
        />
      </label>
    );
  else
    control = (
      <label>
        {label}
        <input
          type="text"
          inputMode={
            type === "integer" || type === "decimal" ? "decimal" : undefined
          }
          placeholder={type === "realDate" ? "YYYY-MM-DD" : undefined}
          maxLength={type === "decimal" ? 1000 : 20000}
          value={text}
          aria-invalid={!!f.error}
          aria-describedby={f.error ? errorId : undefined}
          onKeyDown={enter}
          onBlur={() => void f.commit()}
          onChange={(e) => f.setDraft(e.target.value)}
        />
      </label>
    );
  return (
    <>
      {control}
      {type === "decimal" && (
        <p className="hint">
          Use an exact decimal such as 12.50. Exponent notation is not accepted.
        </p>
      )}
      <FieldError id={errorId} message={f.error} />
      {clearable && (
        <button
          type="button"
          disabled={clearing}
          aria-label={
            layer === "book"
              ? `Use Canon Again for ${field.label}`
              : `Clear value of ${field.label}`
          }
          onClick={() => void clear()}
        >
          {layer === "book"
            ? `Use Canon Again for ${field.label}`
            : "Clear Value"}
        </button>
      )}
    </>
  );
}

/** Tables and attachments keep an explicit form with Save and Cancel. */
export function FormField({
  field,
  bookId,
  value,
  onClose,
  open,
}: {
  field: Field;
  bookId: string;
  value: unknown;
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useEntryEditing();
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  useBlockingDraft(`form:${field.id}`, open && dirty);
  if (!open) return null;
  const save = async (next: unknown) => {
    setError("");
    const result = await ctx.write({
      key: `field:${field.id}`,
      label: field.label,
      draft: JSON.stringify(next),
      run: ctx.put(`values/${field.id}`, {
        value: next,
        expectedFieldUpdatedAt: field.updatedAt,
      }),
    });
    if (result.ok) onClose();
    else if (result.status !== 409) setError(result.message);
  };
  return (
    <>
      {field.fieldType === "attachment" ? (
        <AttachmentField
          bookId={bookId}
          value={value}
          onCancel={onClose}
          onSave={(v) => void save(v)}
        />
      ) : (
        <StructuredForm
          field={field}
          value={value}
          busy={false}
          onCancel={onClose}
          onDirtyChange={setDirty}
          onSave={save}
        />
      )}
      <FieldError id={`field-error-${field.id}`} message={error} />
    </>
  );
}

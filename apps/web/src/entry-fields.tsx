// SPDX-License-Identifier: AGPL-3.0-only
import { EntryAttachments } from "./attachments.tsx";
import { FieldError, useEntryEditing } from "./entry-editing.tsx";
import { FormField, InlineField, inlineTypes } from "./field-editors.tsx";
import { structuredSummary } from "./structured-fields.tsx";
import { scopeAllowsTarget } from "../../../packages/studio/src/scope-values.ts";
import { useState } from "react";
import type { Entry } from "./entries.tsx";
export type Template = {
  id: string;
  name: string;
  entryType: string;
  updatedAt: string;
  deletedAt?: string;
};
export type Field = {
  id: string;
  templateId: string;
  label: string;
  fieldType: string;
  required: boolean;
  targetEntryTypes?: string[];
  multiple?: boolean;
  options?: { id: string; label: string }[];
  updatedAt: string;
  deletedAt?: string;
};
export type Catalog = { templates: Template[]; fields: Field[] };
const layered = (
  e: Entry,
  bookId: string,
  shared: boolean,
  canon: boolean,
): Record<string, unknown> =>
  shared && !canon
    ? { ...e.values, ...e.overrides?.find((o) => o.bookId === bookId)?.values }
    : (e.values ?? {});
const formTypes = ["attachment", "table"];
export function EntryFields({
  entry,
  entries,
  bookId,
  book,
  seriesWorld,
  catalog,
}: {
  entry: Entry;
  entries: Entry[];
  bookId: string;
  book: { id: string; universeId?: string; seriesId?: string };
  seriesWorld?: string;
  catalog: Catalog;
}) {
  const ctx = useEntryEditing();
  const { shared, canon } = ctx;
  const override = entry.overrides?.find((o) => o.bookId === bookId);
  const values = layered(entry, bookId, shared, canon);
  const targetOwner =
    shared && !canon ? { scope: { kind: "book", id: bookId } } : entry;
  const candidateEntries = entries.filter((target) =>
    scopeAllowsTarget(targetOwner, target, book, seriesWorld),
  );
  const [templateId, setTemplateId] = useState(entry.templateId ?? "");
  const [templateError, setTemplateError] = useState("");
  const [formFieldId, setFormFieldId] = useState("");
  const compatible = catalog.templates.filter(
    (t) => !t.deletedAt && t.entryType === entry.entryType,
  );
  const fields = catalog.fields.filter(
    (f) => !f.deletedAt && f.templateId === entry.templateId,
  );
  const hasValues =
    Object.keys(entry.values ?? {}).length > 0 || !!entry.overrides?.length;
  const locked = hasValues || (shared && !canon);
  const assign = async (next: string) => {
    setTemplateId(next);
    setTemplateError("");
    const result = await ctx.write({
      key: "template",
      label: "Template",
      run: ctx.put("template", {
        templateId: next || null,
        expectedTemplateUpdatedAt: compatible.find((t) => t.id === next)
          ?.updatedAt,
      }),
    });
    if (!result.ok) {
      setTemplateId(entry.templateId ?? "");
      if (result.status !== 409) setTemplateError(result.message);
    }
  };
  return (
    <section aria-label={`Fields for ${entry.name}`}>
      <h3>Fields for {entry.name}</h3>
      <EntryAttachments
        bookId={bookId}
        entry={entry}
        readOnly={shared && !canon}
      />
      <label>
        Template
        <select
          value={templateId}
          disabled={locked}
          onChange={(e) => void assign(e.target.value)}
        >
          <option value="">No template</option>
          {entry.templateId &&
            !compatible.some((t) => t.id === entry.templateId) && (
              <option value={entry.templateId}>
                Current template unavailable
              </option>
            )}
          {compatible.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <FieldError id="entry-template-error" message={templateError} />
      {shared && !canon && (
        <p>
          Templates belong to shared canon. Choose Edit shared details to assign
          one.
        </p>
      )}
      {hasValues && (
        <p>
          Template changes are locked while saved values or overrides exist, so
          they are preserved.
        </p>
      )}
      {!entry.templateId && (
        <p>Choose a compatible template to start filling in fields.</p>
      )}
      {entry.templateId &&
        !compatible.some((t) => t.id === entry.templateId) && (
          <p>The saved template is unavailable. Existing values are kept.</p>
        )}
      <ul className="search-results entry-fields">
        {fields.map((f) => {
          const own = Object.hasOwn(
            shared && !canon ? (override?.values ?? {}) : values,
            f.id,
          );
          return (
            <li key={f.id}>
              {inlineTypes.includes(f.fieldType) ? (
                <InlineField
                  field={f}
                  value={values[f.id]}
                  clearable={own}
                  layer={shared && !canon ? "book" : "canon"}
                  candidates={candidateEntries}
                  readValue={(e) => layered(e, bookId, shared, canon)[f.id]}
                />
              ) : formTypes.includes(f.fieldType) ? (
                <>
                  <strong>{f.label}</strong>
                  {f.required && " (suggested)"}
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    {Object.hasOwn(values, f.id)
                      ? structuredSummary(f, values[f.id])
                      : "Not set"}
                  </p>
                  <button
                    type="button"
                    disabled={!!formFieldId}
                    onClick={() => setFormFieldId(f.id)}
                    aria-label={`Edit field ${f.label}`}
                  >
                    Edit {f.label}…
                  </button>
                  {shared && !canon && own && (
                    <button
                      type="button"
                      onClick={() =>
                        void ctx.write({
                          key: `field:${f.id}:clear`,
                          label: f.label,
                          run: ctx.put(`values/${f.id}`, {
                            value: null,
                            expectedFieldUpdatedAt: f.updatedAt,
                          }),
                        })
                      }
                    >
                      Use Canon Again for {f.label}
                    </button>
                  )}
                  <FormField
                    field={f}
                    bookId={bookId}
                    value={values[f.id]}
                    open={formFieldId === f.id}
                    onClose={() => setFormFieldId("")}
                  />
                </>
              ) : (
                <>
                  <strong>{f.label}</strong>
                  <p>
                    This field type is not editable yet. Its saved value is
                    kept.
                  </p>
                </>
              )}
              {shared && (
                <p className="hint">
                  {canon
                    ? "Shared canon"
                    : own
                      ? "This book overrides canon"
                      : "Inherited from canon"}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
export function ScalarForm({
  allowClear = true,
  field,
  value,
  busy,
  onCancel,
  onSave,
}: {
  allowClear?: boolean;
  field: Field;
  value: unknown;
  busy: boolean;
  onCancel: () => void;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        let next: unknown = text;
        if (field.fieldType === "integer") {
          if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
            setError(
              allowClear
                ? "Enter an integer within ±(2^53−1), or choose Clear Value."
                : "Enter an integer within ±(2^53−1).",
            );
            return;
          }
          next = Number(text);
        }
        if (field.fieldType === "boolean") {
          if (text === "") {
            setError(
              allowClear
                ? "Choose true or false, or choose Clear Value."
                : "Choose true or false.",
            );
            return;
          }
          next = text === "true";
        }
        void onSave(next);
      }}
    >
      <h4>Edit {field.label}</h4>
      <fieldset disabled={busy}>
        <label>
          {field.label}
          {field.fieldType === "boolean" ? (
            <select
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
            >
              <option value="">Not set</option>
              <option value="true">True</option>
              <option value="false">False</option>
            </select>
          ) : field.fieldType === "longText" ? (
            <textarea
              autoFocus
              maxLength={20000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <input
              autoFocus
              type="text"
              inputMode={
                ["integer", "decimal"].includes(field.fieldType)
                  ? "decimal"
                  : undefined
              }
              maxLength={field.fieldType === "decimal" ? 1000 : 20000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </label>
        {field.fieldType === "decimal" && (
          <p>
            Use an exact decimal such as 12.50. Exponent notation is not
            accepted.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel Field Edit
          </button>
          {allowClear && (
            <button type="button" onClick={() => void onSave(null)}>
              Clear Value
            </button>
          )}
          <button className="primary">Save Value</button>
        </div>
      </fieldset>
    </form>
  );
}

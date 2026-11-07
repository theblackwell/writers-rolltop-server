import { AttachmentField, EntryAttachments } from "./attachments.tsx";
// SPDX-License-Identifier: AGPL-3.0-only
import {
  ReferenceField,
  referenceTypes,
  referenceSummary,
} from "./reference-field.tsx";
import { StructuredForm, structuredSummary } from "./structured-fields.tsx";
import { structuredTypes } from "../../../packages/studio/src/structured-values.ts";
import { scopeAllowsTarget } from "../../../packages/studio/src/scope-values.ts";
import { useState } from "react";
import { api } from "./api.ts";
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
export function EntryFields({
  entry,
  entries,
  bookId,
  book,
  seriesWorld,
  catalog,
  busy,
  action,
  onSaved,
  onClose,
}: {
  entry: Entry;
  entries: Entry[];
  bookId: string;
  book: { id: string; universeId?: string; seriesId?: string };
  seriesWorld?: string;
  catalog: Catalog;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  onSaved: (e: Entry) => void;
  onClose: () => void;
}) {
  const shared = entry.scope?.kind !== "book";
  const [mode, setMode] = useState<"canon" | "book">(shared ? "book" : "canon");
  const override = entry.overrides?.find((o) => o.bookId === bookId);
  const values =
    shared && mode === "book"
      ? { ...entry.values, ...override?.values }
      : (entry.values ?? {});
  const targetOwner =
    mode === "book" ? { scope: { kind: "book", id: bookId } } : entry;
  const candidateEntries = entries.filter((target) =>
    scopeAllowsTarget(targetOwner, target, book, seriesWorld),
  );
  const [templateId, setTemplateId] = useState(entry.templateId ?? "");
  const [fieldId, setFieldId] = useState("");
  const compatible = catalog.templates.filter(
    (t) => !t.deletedAt && t.entryType === entry.entryType,
  );
  const fields = catalog.fields.filter(
    (f) => !f.deletedAt && f.templateId === entry.templateId,
  );
  const field = fields.find((f) => f.id === fieldId);
  const save = (path: string, payload: object) =>
    action(async () => {
      const result = await api<Entry>(
        `/books/${bookId}/entries/${entry.id}/${path}`,
        "PUT",
        {
          ...payload,
          expectedUpdatedAt: entry.updatedAt,
          ...(path.startsWith("values/") ? { mode } : {}),
          ...(shared && (path === "template" || mode === "canon")
            ? { editSharedCanon: true }
            : {}),
        },
      );
      onSaved(result);
      setFieldId("");
    });
  const hasValues =
    Object.keys(entry.values ?? {}).length > 0 || !!entry.overrides?.length;
  return (
    <section aria-label={`Fields for ${entry.name}`}>
      <h3>Fields for {entry.name}</h3>
      {shared && (
        <>
          <label>
            Edit values for
            <select
              aria-label="Edit values for"
              disabled={busy || !!fieldId}
              value={mode}
              onChange={(e) => setMode(e.target.value as "canon" | "book")}
            >
              <option value="book">This book only</option>
              <option value="canon">Shared canon (all books)</option>
            </select>
          </label>
          <p>
            {mode === "book"
              ? "Saved overrides affect this book only. Clear Value or Use Canon Again removes its override and inherits canon."
              : "These values are shared canon. Changes affect every book without its own override."}
          </p>
        </>
      )}

      <EntryAttachments bookId={bookId} entry={entry} onSaved={onSaved} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save("template", {
            templateId: templateId || null,
            expectedTemplateUpdatedAt: compatible.find(
              (t) => t.id === templateId,
            )?.updatedAt,
          });
        }}
      >
        <fieldset disabled={busy || !!fieldId || (shared && mode === "book")}>
          <label>
            Template
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
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
          <button
            disabled={
              templateId === (entry.templateId ?? "") ||
              (hasValues && templateId !== (entry.templateId ?? ""))
            }
          >
            {shared ? "Assign Shared Template" : "Assign Template"}
          </button>
        </fieldset>
      </form>
      {shared && mode === "book" && (
        <p>
          Templates belong to shared canon. Choose Shared canon to assign one.
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
      <ul className="search-results">
        {fields.map((f) => (
          <li key={f.id}>
            <strong>{f.label}</strong>
            {f.required && " (suggested)"}
            <p style={{ whiteSpace: "pre-wrap" }}>
              {Object.hasOwn(values, f.id)
                ? referenceTypes.includes(f.fieldType)
                  ? referenceSummary(values[f.id], entries)
                  : structuredSummary(f, values[f.id])
                : "Not set"}
            </p>
            {shared && (
              <p>
                {mode === "canon"
                  ? "Shared canon"
                  : Object.hasOwn(override?.values ?? {}, f.id)
                    ? "This book overrides canon"
                    : "Inherited from canon"}
              </p>
            )}
            {shared &&
              mode === "book" &&
              Object.hasOwn(override?.values ?? {}, f.id) && (
                <button
                  disabled={busy || !!fieldId}
                  onClick={() =>
                    void save(`values/${f.id}`, {
                      value: null,
                      expectedFieldUpdatedAt: f.updatedAt,
                    })
                  }
                >
                  Use Canon Again for {f.label}
                </button>
              )}
            {[
              "attachment",
              "shortText",
              "longText",
              "integer",
              "decimal",
              "boolean",
              ...structuredTypes,
              ...referenceTypes,
            ].includes(f.fieldType) ? (
              <button
                disabled={busy || !!fieldId}
                onClick={() => setFieldId(f.id)}
                aria-label={`Edit field ${f.label}`}
              >
                Edit {f.label}…
              </button>
            ) : (
              <p>
                This field type is not editable yet. Its saved value is kept.
              </p>
            )}
          </li>
        ))}
      </ul>
      {field &&
        (field.fieldType === "attachment" ? (
          <AttachmentField
            key={field.id}
            bookId={bookId}
            value={values[field.id]}
            busy={busy}
            onCancel={() => setFieldId("")}
            onSave={(value) =>
              save(`values/${field.id}`, {
                value,
                expectedFieldUpdatedAt: field.updatedAt,
              })
            }
          />
        ) : referenceTypes.includes(field.fieldType) ? (
          <ReferenceField
            key={field.id}
            field={field}
            value={values[field.id]}
            entries={candidateEntries}
            busy={busy}
            onCancel={() => setFieldId("")}
            onSave={(value) =>
              save(`values/${field.id}`, {
                value,
                expectedFieldUpdatedAt: field.updatedAt,
              })
            }
          />
        ) : structuredTypes.includes(field.fieldType) ? (
          <StructuredForm
            key={field.id}
            field={field}
            value={values[field.id]}
            busy={busy}
            onCancel={() => setFieldId("")}
            onSave={(value) =>
              save(`values/${field.id}`, {
                value,
                expectedFieldUpdatedAt: field.updatedAt,
              })
            }
          />
        ) : (
          <ScalarForm
            key={field.id}
            field={field}
            value={values[field.id]}
            busy={busy}
            onCancel={() => setFieldId("")}
            onSave={(value) =>
              save(`values/${field.id}`, {
                value,
                expectedFieldUpdatedAt: field.updatedAt,
              })
            }
          />
        ))}
      <button disabled={busy} onClick={onClose}>
        Close Fields
      </button>
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

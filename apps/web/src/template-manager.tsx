// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { api } from "./api.ts";
import type { Catalog } from "./entry-fields.tsx";
const entryTypes = [
  "character",
  "location",
  "organization",
  "object",
  "event",
  "plotline",
  "worldRule",
  "research",
  "term",
];
const fieldTypes = [
  "shortText",
  "longText",
  "integer",
  "decimal",
  "boolean",
  "selection",
  "realDate",
  "fictionalDate",
  "entryReference",
  "entryReferences",
  "attachment",
  "table",
];
const names: Record<string, string> = {
  shortText: "Short text",
  longText: "Long text",
  integer: "Integer",
  decimal: "Exact decimal",
  boolean: "Yes / no",
  selection: "Choice",
  realDate: "Real-world date",
  fictionalDate: "Story date",
  entryReference: "Single entry link",
  entryReferences: "Multiple entry links",
  attachment: "Attachment (values coming later)",
  table: "Table",
  worldRule: "World rule",
};
const display = (t: string) => names[t] ?? t[0].toUpperCase() + t.slice(1);
type Draft = { kind: "template" | "field"; item?: any };
export function TemplateManager({
  libraryId,
  catalog,
  busy,
  action,
  reload,
  onClose,
}: {
  libraryId: string;
  catalog: Catalog;
  busy: boolean;
  action: (fn: () => Promise<void>) => Promise<void>;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(
    catalog.templates.find((t) => !t.deletedAt)?.id ?? "",
  );
  const [draft, setDraft] = useState<Draft>();
  const templates = catalog.templates.filter((t) => !t.deletedAt),
    template = templates.find((t) => t.id === selected),
    fields = catalog.fields.filter(
      (f) => f.templateId === selected && !f.deletedAt,
    );
  const write = (kind: string, item: any, patch: object) =>
    action(async () => {
      await api(
        `/libraries/${libraryId}/${kind}${item ? "/" + item.id : ""}`,
        item ? "PUT" : "POST",
        { ...patch, ...(item ? { expectedUpdatedAt: item.updatedAt } : {}) },
      );
      setDraft(undefined);
      try {
        await reload();
      } catch {
        throw new Error(
          "The definition was saved, but the list could not reload. Close and reopen Bible Entries to review it before making another change.",
        );
      }
    });
  const move = (kind: string, item: any, peers: any[], up: boolean) => {
    const i = peers.findIndex((x) => x.id === item.id);
    return write(kind, item, {
      beforeId: up ? peers[i - 1].id : (peers[i + 2]?.id ?? null),
    });
  };
  return (
    <section className="definition-manager">
      <h3>Templates and Fields</h3>
      <p>
        Definitions belong to this library. Changes apply wherever the template
        is used. Create a new field to use a different type. Attachment values
        remain unavailable.
      </p>
      <button
        disabled={busy || !!draft}
        onClick={() => setDraft({ kind: "template" })}
      >
        New Template…
      </button>
      <label>
        Template to customize
        <select
          disabled={busy || !!draft}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({display(t.entryType)})
            </option>
          ))}
        </select>
      </label>
      {template && (
        <>
          <button
            disabled={busy || !!draft}
            onClick={() => setDraft({ kind: "template", item: template })}
          >
            Rename Template…
          </button>
          <button
            disabled={busy || !!draft || templates[0]?.id === selected}
            onClick={() => void move("templates", template, templates, true)}
          >
            Move Template Up
          </button>
          <button
            disabled={busy || !!draft || templates.at(-1)?.id === selected}
            onClick={() => void move("templates", template, templates, false)}
          >
            Move Template Down
          </button>
          <button
            disabled={busy || !!draft}
            onClick={() => setDraft({ kind: "field" })}
          >
            New Field…
          </button>
        </>
      )}
      {draft && (
        <DefinitionForm
          key={draft.kind + (draft.item?.id ?? "new")}
          draft={draft}
          busy={busy}
          onCancel={() => setDraft(undefined)}
          onSave={(patch) =>
            write(
              draft.kind === "template" ? "templates" : "fields",
              draft.item,
              {
                ...patch,
                ...(draft.kind === "field" && !draft.item
                  ? { templateId: selected }
                  : {}),
              },
            )
          }
        />
      )}
      <ul className="search-results">
        {fields.map((f, i) => (
          <li key={f.id}>
            <strong>{f.label}</strong> ({display(f.fieldType)})
            <button
              disabled={busy || !!draft}
              onClick={() => setDraft({ kind: "field", item: f })}
              aria-label={`Customize field ${f.label}`}
            >
              Customize…
            </button>
            <button
              disabled={busy || !!draft || i === 0}
              onClick={() => void move("fields", f, fields, true)}
              aria-label={`Move field ${f.label} up`}
            >
              Move Up
            </button>
            <button
              disabled={busy || !!draft || i === fields.length - 1}
              onClick={() => void move("fields", f, fields, false)}
              aria-label={`Move field ${f.label} down`}
            >
              Move Down
            </button>
          </li>
        ))}
      </ul>
      <button disabled={busy || !!draft} onClick={onClose}>
        Back to Entries
      </button>
    </section>
  );
}
function DefinitionForm({
  draft,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: object) => Promise<void>;
}) {
  const old = draft.item;
  const [label, setLabel] = useState(old?.name ?? old?.label ?? "");
  const [entryType, setEntryType] = useState(old?.entryType ?? "character");
  const [fieldType, setFieldType] = useState(old?.fieldType ?? "shortText");
  const [required, setRequired] = useState(!!old?.required);
  const [multiple, setMultiple] = useState(!!old?.multiple);
  const [options, setOptions] = useState<{ id?: string; label: string }[]>(
    old?.options ?? [{ label: "" }],
  );
  const [any, setAny] = useState(old?.targetEntryTypes === undefined);
  const [targets, setTargets] = useState<string[]>(old?.targetEntryTypes ?? []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const patch: any =
          draft.kind === "template"
            ? { name: label, ...(!old ? { entryType } : {}) }
            : {
                label,
                required,
                ...(!old ? { fieldType } : {}),
                ...(fieldType === "selection"
                  ? {
                      multiple,
                      options: options.map((o) => ({
                        ...(o.id ? { id: o.id } : {}),
                        label: o.label,
                      })),
                    }
                  : {}),
                ...(["entryReference", "entryReferences"].includes(fieldType)
                  ? { targetEntryTypes: any ? null : targets }
                  : {}),
              };
        void onSave(patch);
      }}
    >
      <h4>
        {old ? "Edit" : "New"} {draft.kind}
      </h4>
      <fieldset disabled={busy}>
        <label>
          {draft.kind === "template" ? "Template name" : "Field label"}
          <input
            autoFocus
            required
            maxLength={500}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        {draft.kind === "template" ? (
          !old && (
            <label>
              Entry type
              <select
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
              >
                {entryTypes.map((t) => (
                  <option key={t} value={t}>
                    {display(t)}
                  </option>
                ))}
              </select>
            </label>
          )
        ) : (
          <>
            <label>
              Field type
              <select
                disabled={!!old}
                value={fieldType}
                onChange={(e) => setFieldType(e.target.value)}
              >
                {fieldTypes.map((t) => (
                  <option key={t} value={t}>
                    {display(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="entry-toggle">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Suggest filling in this field
            </label>
            {fieldType === "selection" && (
              <>
                <label className="entry-toggle">
                  <input
                    type="checkbox"
                    checked={multiple}
                    onChange={(e) => setMultiple(e.target.checked)}
                  />
                  Allow multiple choices
                </label>
                {options.map((o, i) => (
                  <div key={o.id ?? i}>
                    <label>
                      Option {i + 1}
                      <input
                        required
                        maxLength={500}
                        value={o.label}
                        onChange={(e) =>
                          setOptions((os) =>
                            os.map((o, j) =>
                              i === j ? { ...o, label: e.target.value } : o,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={options.length <= 1}
                      onClick={() =>
                        setOptions((os) => os.filter((_, j) => i !== j))
                      }
                      aria-label={`Remove option ${i + 1}`}
                    >
                      Remove Option
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={options.length >= 200}
                  onClick={() => setOptions((os) => [...os, { label: "" }])}
                >
                  Add Option
                </button>
                <p>
                  Renaming preserves saved choices. Options used by saved values
                  cannot be removed.
                </p>
              </>
            )}
            {["entryReference", "entryReferences"].includes(fieldType) && (
              <>
                <label className="entry-toggle">
                  <input
                    type="checkbox"
                    checked={any}
                    onChange={(e) => setAny(e.target.checked)}
                  />
                  Allow any entry type
                </label>
                {!any && (
                  <fieldset>
                    <legend>Allowed target types</legend>
                    {entryTypes.map((t) => (
                      <label className="entry-toggle" key={t}>
                        <input
                          type="checkbox"
                          checked={targets.includes(t)}
                          onChange={(e) =>
                            setTargets((ts) =>
                              e.target.checked
                                ? [...ts, t]
                                : ts.filter((v) => v !== t),
                            )
                          }
                        />
                        {t}
                      </label>
                    ))}
                  </fieldset>
                )}
              </>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel Definition Edit
          </button>
          <button className="primary">Save Definition</button>
        </div>
      </fieldset>
    </form>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useFormDraft } from "./record-editing.tsx";
import type { RecordHost } from "./record-editing.tsx";
export type Fact = {
  id: string;
  scope: { kind: string; id: string };
  text: string;
  truth: "true" | "false" | "undecided";
  nodeId?: string;
  entryIds: string[];
  knowledge: { knower: string; nodeId?: string }[];
  updatedAt: string;
  deletedAt?: string;
};
export type FactCatalog = {
  book: any;
  scopes: { kind: string; id: string; title: string }[];
  facts: Fact[];
  entries: {
    id: string;
    name: string;
    entryType: string;
    scope: { kind: string; id: string };
    scopeTitle?: string;
    deletedAt?: string;
  }[];
  books: {
    id: string;
    title: string;
    universeId?: string;
    seriesId?: string;
    deletedAt?: string;
  }[];
  nodes: {
    id: string;
    bookId: string;
    title: string;
    kind: string;
    inTrash: boolean;
  }[];
};
const truthTitle = (truth: string) =>
  truth === "false" ? "Not true" : truth === "true" ? "True" : "Undecided";
function scopeTitle(c: FactCatalog, s: Fact["scope"]) {
  return (
    c.scopes.find((x) => x.id === s.id && x.kind === s.kind)?.title ??
    (s.kind === "book" ? "Book" : "Unavailable shared scope")
  );
}
function entryTitle(c: FactCatalog, id: string) {
  if (id === "reader") return "The reader";
  const e = c.entries.find((x) => x.id === id);
  if (!e) return `Unavailable entry (${id})`;
  const scope =
    e.scopeTitle ??
    (e.scope.kind === "book"
      ? `Book: ${c.books.find((b) => b.id === e.scope.id)?.title ?? e.scope.id}`
      : e.scope.kind === "universe"
        ? "Shared world"
        : "Shared series");
  return `${e.name} (${e.entryType}; ${scope}${e.deletedAt ? "; in Trash" : ""})`;
}
function pointTitle(c: FactCatalog, id: string) {
  const n = c.nodes.find((x) => x.id === id);
  return n
    ? `${c.books.find((b) => b.id === n.bookId)?.title ?? "Unavailable book"} › ${n.title}${n.inTrash ? " (in Trash)" : ""}`
    : `Unavailable chapter or scene (${id})`;
}
export function FactForm({
  catalog,
  fact,
  host,
}: {
  catalog: FactCatalog;
  fact?: Fact;
  host: RecordHost;
}) {
  const [text, setText] = useState(fact?.text ?? ""),
    [truth, setTruth] = useState(fact?.truth ?? "true"),
    [kind, setKind] = useState(fact?.scope.kind ?? "book"),
    [node, setNode] = useState(fact?.nodeId ?? "");
  const [about, setAbout] = useState(fact?.entryIds ?? []),
    [knowledge, setKnowledge] = useState(fact?.knowledge ?? []),
    [addEntry, setAddEntry] = useState(""),
    [addKnower, setAddKnower] = useState("");
  const scope = fact?.scope ?? catalog.scopes.find((s) => s.kind === kind);
  const shared = kind !== "book";
  const scopedNodes = catalog.nodes.filter((n) => {
    const b = catalog.books.find((b) => b.id === n.bookId);
    return (
      b &&
      scope &&
      (scope.kind === "book"
        ? b.id === scope.id
        : scope.kind === "universe"
          ? b.universeId === scope.id
          : b.seriesId === scope.id)
    );
  });
  const pointPicker = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    none: string,
  ) => (
    <label>
      {label}
      <select
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          autosave();
        }}
      >
        <option value="">{none}</option>
        {value && !scopedNodes.some((n) => n.id === value) && (
          <option value={value}>
            {pointTitle(catalog, value)} · outside selected scope
          </option>
        )}
        {scopedNodes.map((n) => (
          <option
            key={n.id}
            value={n.id}
            disabled={n.inTrash && n.id !== value}
          >
            {pointTitle(catalog, n.id)}
          </option>
        ))}
      </select>
    </label>
  );
  const missingScope = !scope;
  const availableKnowers = [
    "reader",
    ...catalog.entries
      .filter((e) => !e.deletedAt && e.entryType === "character")
      .map((e) => e.id),
  ].filter((id) => !knowledge.some((k) => k.knower === id));
  const invalidPoint = [node, ...knowledge.map((k) => k.nodeId)].some(
    (id) => id && !scopedNodes.some((n) => n.id === id),
  );
  const { onShared } = host;
  useEffect(() => {
    if (!fact) onShared?.(shared);
  }, [fact, shared, onShared]);
  const payload = {
    text,
    truth,
    nodeId: node || null,
    entryIds: about,
    knowledge,
    ...(fact ? {} : { scopeKind: kind }),
  };
  const canSave =
    !missingScope && !!text.length && !invalidPoint && (!shared || host.canon);
  const { dirty, submit, autosave } = useFormDraft(host, payload, {
    canSave,
    isNew: !fact,
  });
  const readOnly = !!fact && shared && !host.canon;
  return (
    <form
      aria-label={fact ? "Edit Fact" : "New Fact"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!fact) {
          if (canSave && !host.busy) void submit();
        } else autosave();
      }}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (
          e.key === "Enter" &&
          fact &&
          t.tagName === "INPUT" &&
          (t as HTMLInputElement).type === "text"
        ) {
          e.preventDefault();
          autosave();
        }
      }}
    >
      <fieldset disabled={host.busy || readOnly}>
        <>
          <label>
            Fact
            <textarea
              required
              maxLength={20000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={autosave}
              rows={3}
            />
          </label>
          <label>
            Truth
            <select
              value={truth}
              onChange={(e) => {
                setTruth(e.target.value as Fact["truth"]);
                autosave();
              }}
            >
              <option value="true">True</option>
              <option value="false">Not true</option>
              <option value="undecided">Undecided</option>
            </select>
          </label>
          <p>
            Not true means a lie or mistaken belief that someone can still
            learn.
          </p>
          {fact ? (
            <p>Scope: {scopeTitle(catalog, fact.scope)}</p>
          ) : (
            <label>
              Scope
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {catalog.scopes.map((s) => (
                  <option key={s.kind} value={s.kind}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {pointPicker("Established in", node, setNode, "Not placed")}
          <h4>About</h4>
          <ul>
            {about.map((id) => (
              <li key={id}>
                {entryTitle(catalog, id)}{" "}
                <button
                  type="button"
                  aria-label={`Remove about ${entryTitle(catalog, id)}`}
                  onClick={() => {
                    setAbout(about.filter((x) => x !== id));
                    autosave();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <label>
            About entry
            <select
              value={addEntry}
              onChange={(e) => setAddEntry(e.target.value)}
            >
              <option value="">Choose an entry</option>
              {catalog.entries
                .filter((e) => !e.deletedAt && !about.includes(e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {entryTitle(catalog, e.id)}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!addEntry}
            onClick={() => {
              setAbout([...about, addEntry]);
              setAddEntry("");
              autosave();
            }}
          >
            Add About Entry
          </button>
          <h4>Who knows it, from when</h4>
          {!knowledge.length && <p>Nobody is listed yet.</p>}
          {knowledge.map((k) => (
            <div key={k.knower} className="fact-knower">
              {pointPicker(
                `${entryTitle(catalog, k.knower)} learns it`,
                k.nodeId ?? "",
                (value) =>
                  setKnowledge(
                    knowledge.map((x) =>
                      x.knower === k.knower
                        ? {
                            knower: x.knower,
                            ...(value ? { nodeId: value } : {}),
                          }
                        : x,
                    ),
                  ),
                "From the start",
              )}
              <button
                type="button"
                aria-label={`Remove knower ${entryTitle(catalog, k.knower)}`}
                onClick={() => {
                  setKnowledge(knowledge.filter((x) => x.knower !== k.knower));
                  autosave();
                }}
              >
                Remove Knower
              </button>
            </div>
          ))}
          <label>
            Add knower
            <select
              value={addKnower}
              onChange={(e) => setAddKnower(e.target.value)}
            >
              <option value="">Choose the reader or a character</option>
              {availableKnowers.map((id) => (
                <option key={id} value={id}>
                  {entryTitle(catalog, id)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!addKnower}
            onClick={() => {
              setKnowledge([
                ...knowledge,
                {
                  knower: addKnower,
                  ...(addKnower === "reader" && node ? { nodeId: node } : {}),
                },
              ]);
              setAddKnower("");
              autosave();
            }}
          >
            Add Knower
          </button>
          {invalidPoint && (
            <p role="alert">
              A saved chapter or scene is outside the selected scope. Choose a
              valid point or explicitly clear it; your selections have been
              kept.
            </p>
          )}
        </>
        {!fact && shared && !host.canon && (
          <p className="hint">
            Choose Edit shared details above to create a shared fact.
          </p>
        )}
        <div className="dialog-actions">
          {(!fact || dirty) && (
            <button type="button" onClick={host.discard}>
              {fact ? "Discard Changes" : "Cancel"}
            </button>
          )}
          {!fact && (
            <button className="primary" disabled={!canSave || host.busy}>
              Create Fact
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

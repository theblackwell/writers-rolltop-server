// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useFormDraft } from "./record-editing.tsx";
import type { RecordHost } from "./record-editing.tsx";
export type Question = {
  id: string;
  scope: { kind: string; id: string };
  text: string;
  topic?: string;
  status: "open" | "decided";
  decision?: string;
  nodeId?: string;
  entryIds: string[];
  updatedAt: string;
  deletedAt?: string;
};
export type QuestionCatalog = {
  book: any;
  scopes: { kind: string; id: string; title: string }[];
  questions: Question[];
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
function scopeTitle(c: QuestionCatalog, s: Question["scope"]) {
  return (
    c.scopes.find((x) => x.id === s.id && x.kind === s.kind)?.title ??
    (s.kind === "book" ? "Book" : "Unavailable shared scope")
  );
}
function entryTitle(c: QuestionCatalog, id: string) {
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
function pointTitle(c: QuestionCatalog, id: string) {
  const n = c.nodes.find((x) => x.id === id);
  return n
    ? `${c.books.find((b) => b.id === n.bookId)?.title ?? "Unavailable book"} › ${n.title}${n.inTrash ? " (in Trash)" : ""}`
    : `Unavailable chapter or scene (${id})`;
}
export function QuestionForm({
  catalog,
  question,
  host,
}: {
  catalog: QuestionCatalog;
  question?: Question;
  host: RecordHost;
}) {
  const [text, setText] = useState(question?.text ?? ""),
    [topic, setTopic] = useState(question?.topic ?? ""),
    [status, setStatus] = useState(question?.status ?? "open"),
    [decision, setDecision] = useState(question?.decision ?? ""),
    [hasDecision, setHasDecision] = useState(question?.decision !== undefined),
    [kind, setKind] = useState(question?.scope.kind ?? "book"),
    [node, setNode] = useState(question?.nodeId ?? "");
  const [about, setAbout] = useState(question?.entryIds ?? []),
    [addEntry, setAddEntry] = useState("");
  const scope = question?.scope ?? catalog.scopes.find((s) => s.kind === kind);
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
      <select value={value} onChange={(e) => onChange(e.target.value)}>
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
  const invalidPoint = !!node && !scopedNodes.some((n) => n.id === node);
  const { onShared } = host;
  useEffect(() => {
    if (!question) onShared?.(shared);
  }, [question, shared, onShared]);
  const payload = {
    text,
    topic: topic || null,
    status,
    decision: hasDecision ? decision : null,
    nodeId: node || null,
    entryIds: about,
    ...(question ? {} : { scopeKind: kind }),
  };
  const canSave =
    !missingScope && !!text.length && !invalidPoint && (!shared || host.canon);
  const { dirty, submit } = useFormDraft(host, payload, {
    canSave,
    isNew: !question,
  });
  const readOnly = !!question && shared && !host.canon;
  return (
    <form
      aria-label={question ? "Edit Question" : "New Question"}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !host.busy) void submit();
      }}
    >
      <fieldset disabled={host.busy || readOnly}>
        <>
          <label>
            Question
            <textarea
              required
              maxLength={20000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
            />
          </label>
          <label>
            Topic
            <input
              maxLength={64}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
          <label>
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Question["status"])}
            >
              <option value="open">Open</option>
              <option value="decided">Decided</option>
            </select>
          </label>
          <label className="entry-toggle">
            <input
              type="checkbox"
              checked={hasDecision}
              onChange={(e) => setHasDecision(e.target.checked)}
            />
            Include a decision
          </label>
          {hasDecision && (
            <label>
              Decision
              <textarea
                maxLength={20000}
                rows={3}
                value={decision}
                onChange={(e) => setDecision(e.target.value)}
              />
            </label>
          )}
          <p>
            A question may be decided without an answer. Reopening keeps its
            saved decision; clear Include a decision to remove it.
          </p>
          {question ? (
            <p>Scope: {scopeTitle(catalog, question.scope)}</p>
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
          {pointPicker("Decide by", node, setNode, "No deadline")}
          <h4>About</h4>
          <ul>
            {about.map((id) => (
              <li key={id}>
                {entryTitle(catalog, id)}{" "}
                <button
                  type="button"
                  aria-label={`Remove about ${entryTitle(catalog, id)}`}
                  onClick={() => setAbout(about.filter((x) => x !== id))}
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
            }}
          >
            Add About Entry
          </button>
          {invalidPoint && (
            <p role="alert">
              A saved chapter or scene is outside the selected scope. Choose a
              valid point or explicitly clear it; your selections have been
              kept.
            </p>
          )}
        </>
        {!question && shared && !host.canon && (
          <p className="hint">
            Choose Edit shared details above to create a shared question.
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={host.discard}>
            {question ? "Discard Changes" : "Cancel"}
          </button>
          <button
            className="primary"
            disabled={!canSave || host.busy || (!!question && !dirty)}
          >
            Save Question
          </button>
        </div>
      </fieldset>
    </form>
  );
}

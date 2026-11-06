// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
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
export function Questions({
  bookId,
  initialId,
}: {
  bookId: string;
  initialId?: string;
}) {
  const [catalog, setCatalog] = useState<QuestionCatalog>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [trash, setTrash] = useState(false);
  const [edit, setEdit] = useState<{
    question?: Question;
    mode: "edit" | "trash" | "restore";
  }>();
  useEffect(() => {
    let live = true;
    api<QuestionCatalog>(`/books/${bookId}/questions`)
      .then((c) => {
        if (live) {
          setCatalog(c);
          if (initialId) {
            const target = c.questions.find((r) => r.id === initialId);
            if (target && !target.deletedAt)
              setEdit({ question: target, mode: "edit" });
            else {
              setTrash(!!target?.deletedAt);
              setError(
                "This record is no longer live here. Review its Trash or reopen continuity.",
              );
            }
          }
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId, initialId]);
  function open(value: typeof edit) {
    setError("");
    setEdit(value);
  }
  async function save(value: object) {
    setBusy(true);
    setError("");
    try {
      const f = edit?.question;
      const result = await api<Question>(
        `/books/${bookId}/questions${f ? `/${f.id}` : ""}`,
        f ? "PUT" : "POST",
        { ...value, ...(f ? { expectedUpdatedAt: f.updatedAt } : {}) },
      );
      setCatalog((c) =>
        c
          ? {
              ...c,
              questions: f
                ? c.questions.map((old) => (old.id === f.id ? result : old))
                : [...c.questions, result],
            }
          : c,
      );
      setEdit(undefined);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The question could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Questions and Decisions">
      <p>
        Track open questions and decisions, what they concern, and when an
        answer is needed. Shared questions apply across their world or series.
      </p>
      {error && <p role="alert">{error}</p>}
      {!catalog ? (
        <p>Loading…</p>
      ) : edit ? (
        <QuestionForm
          key={(edit.question?.id ?? "new") + edit.mode}
          catalog={catalog}
          question={edit.question}
          mode={edit.mode}
          busy={busy}
          onCancel={() => open(undefined)}
          onSave={save}
        />
      ) : (
        <>
          <button disabled={busy} onClick={() => open({ mode: "edit" })}>
            New Question…
          </button>
          <label className="entry-toggle">
            <input
              type="checkbox"
              checked={trash}
              onChange={(e) => setTrash(e.target.checked)}
            />
            Show Question Trash
          </label>
          <ul className="search-results">
            {catalog.questions
              .filter((f) => !!f.deletedAt === trash)
              .map((f) => (
                <li key={f.id}>
                  <strong style={{ whiteSpace: "pre-wrap" }}>{f.text}</strong>
                  <p>
                    {f.status === "decided" ? "Decided" : "Open"} ·{" "}
                    {scopeTitle(catalog, f.scope)}
                  </p>
                  {f.topic && <p>Topic: {f.topic}</p>}
                  {f.decision !== undefined && (
                    <p style={{ whiteSpace: "pre-wrap" }}>
                      Decision: {f.decision || "(empty)"}
                    </p>
                  )}
                  {f.nodeId && (
                    <p>Decide by: {pointTitle(catalog, f.nodeId)}</p>
                  )}
                  {!f.deletedAt && (
                    <button
                      aria-label={`Edit question ${f.text}`}
                      onClick={() => open({ question: f, mode: "edit" })}
                    >
                      Edit Question…
                    </button>
                  )}
                  <button
                    aria-label={`${f.deletedAt ? "Restore" : "Trash"} question ${f.text}`}
                    onClick={() =>
                      open({
                        question: f,
                        mode: f.deletedAt ? "restore" : "trash",
                      })
                    }
                  >
                    {f.deletedAt
                      ? "Restore Question…"
                      : "Move Question to Trash…"}
                  </button>
                </li>
              ))}
          </ul>
          {!catalog.questions.some((f) => !!f.deletedAt === trash) && (
            <p>{trash ? "No questions in Trash." : "No questions yet."}</p>
          )}
        </>
      )}
    </section>
  );
}
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
  mode,
  busy,
  onCancel,
  onSave,
}: {
  catalog: QuestionCatalog;
  question?: Question;
  mode: "edit" | "trash" | "restore";
  busy: boolean;
  onCancel: () => void;
  onSave: (value: object) => Promise<void>;
}) {
  const [text, setText] = useState(question?.text ?? ""),
    [topic, setTopic] = useState(question?.topic ?? ""),
    [status, setStatus] = useState(question?.status ?? "open"),
    [decision, setDecision] = useState(question?.decision ?? ""),
    [hasDecision, setHasDecision] = useState(question?.decision !== undefined),
    [kind, setKind] = useState(question?.scope.kind ?? "book"),
    [node, setNode] = useState(question?.nodeId ?? "");
  const [about, setAbout] = useState(question?.entryIds ?? []),
    [ack, setAck] = useState(false),
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
  return (
    <form
      aria-label={
        mode === "edit"
          ? question
            ? "Edit Question"
            : "New Question"
          : mode === "trash"
            ? "Move Question to Trash"
            : "Restore Question"
      }
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(
          mode !== "edit"
            ? {
                deleted: mode === "trash",
                ...(shared ? { editSharedCanon: ack } : {}),
              }
            : {
                text,
                topic: topic || null,
                status,
                decision: hasDecision ? decision : null,
                nodeId: node || null,
                entryIds: about,
                ...(question
                  ? shared
                    ? { editSharedCanon: ack }
                    : {}
                  : { scopeKind: kind }),
              },
        );
      }}
    >
      <h3>
        {mode === "edit"
          ? question
            ? "Edit Question"
            : "New Question"
          : mode === "trash"
            ? "Move Question to Trash"
            : "Restore Question"}
      </h3>
      <fieldset disabled={busy}>
        {mode === "edit" ? (
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
                onChange={(e) =>
                  setStatus(e.target.value as Question["status"])
                }
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
        ) : (
          <p style={{ whiteSpace: "pre-wrap" }}>{question?.text}</p>
        )}
        {shared && (
          <label className="entry-toggle" style={{ margin: "1rem 0" }}>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {question
              ? "Apply this change to the shared question for all books in its scope"
              : "Create this shared question for all books in its scope"}
          </label>
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          disabled={
            missingScope ||
            (shared && !ack) ||
            (mode === "edit" && (!text.length || invalidPoint))
          }
        >
          {mode === "edit"
            ? "Save Question"
            : mode === "trash"
              ? "Move Question to Trash"
              : "Restore Question"}
        </button>
      </fieldset>
    </form>
  );
}

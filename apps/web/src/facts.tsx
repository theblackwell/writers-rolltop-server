// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
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
export function Facts({
  bookId,
  initialId,
}: {
  bookId: string;
  initialId?: string;
}) {
  const [catalog, setCatalog] = useState<FactCatalog>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [trash, setTrash] = useState(false);
  const [edit, setEdit] = useState<{
    fact?: Fact;
    mode: "edit" | "trash" | "restore";
  }>();
  useEffect(() => {
    let live = true;
    api<FactCatalog>(`/books/${bookId}/facts`)
      .then((c) => {
        if (live) {
          setCatalog(c);
          if (initialId) {
            const target = c.facts.find((r) => r.id === initialId);
            if (target && !target.deletedAt)
              setEdit({ fact: target, mode: "edit" });
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
      const f = edit?.fact;
      const result = await api<Fact>(
        `/books/${bookId}/facts${f ? `/${f.id}` : ""}`,
        f ? "PUT" : "POST",
        { ...value, ...(f ? { expectedUpdatedAt: f.updatedAt } : {}) },
      );
      setCatalog((c) =>
        c
          ? {
              ...c,
              facts: f
                ? c.facts.map((old) => (old.id === f.id ? result : old))
                : [...c.facts, result],
            }
          : c,
      );
      setEdit(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The fact could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Facts and Knowledge">
      <p>
        Record what is true, a mistaken belief or still undecided, and who knows
        it from when. Anyone not listed does not know it. Shared facts apply
        across their world or series.
      </p>
      {error && <p role="alert">{error}</p>}
      {!catalog ? (
        <p>Loading…</p>
      ) : edit ? (
        <FactForm
          key={(edit.fact?.id ?? "new") + edit.mode}
          catalog={catalog}
          fact={edit.fact}
          mode={edit.mode}
          busy={busy}
          onCancel={() => open(undefined)}
          onSave={save}
        />
      ) : (
        <>
          <button disabled={busy} onClick={() => open({ mode: "edit" })}>
            New Fact…
          </button>
          <label className="entry-toggle">
            <input
              type="checkbox"
              checked={trash}
              onChange={(e) => setTrash(e.target.checked)}
            />
            Show Fact Trash
          </label>
          <ul className="search-results">
            {catalog.facts
              .filter((f) => !!f.deletedAt === trash)
              .map((f) => (
                <li key={f.id}>
                  <strong style={{ whiteSpace: "pre-wrap" }}>{f.text}</strong>
                  <p>
                    {truthTitle(f.truth)} · {scopeTitle(catalog, f.scope)} ·{" "}
                    {f.knowledge.length} know it
                  </p>
                  {f.nodeId && (
                    <p>Established in: {pointTitle(catalog, f.nodeId)}</p>
                  )}
                  {!f.deletedAt && (
                    <button
                      aria-label={`Edit fact ${f.text}`}
                      onClick={() => open({ fact: f, mode: "edit" })}
                    >
                      Edit Fact…
                    </button>
                  )}
                  <button
                    aria-label={`${f.deletedAt ? "Restore" : "Trash"} fact ${f.text}`}
                    onClick={() =>
                      open({ fact: f, mode: f.deletedAt ? "restore" : "trash" })
                    }
                  >
                    {f.deletedAt ? "Restore Fact…" : "Move Fact to Trash…"}
                  </button>
                </li>
              ))}
          </ul>
          {!catalog.facts.some((f) => !!f.deletedAt === trash) && (
            <p>{trash ? "No facts in Trash." : "No facts yet."}</p>
          )}
        </>
      )}
    </section>
  );
}
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
  mode,
  busy,
  onCancel,
  onSave,
}: {
  catalog: FactCatalog;
  fact?: Fact;
  mode: "edit" | "trash" | "restore";
  busy: boolean;
  onCancel: () => void;
  onSave: (value: object) => Promise<void>;
}) {
  const [text, setText] = useState(fact?.text ?? ""),
    [truth, setTruth] = useState(fact?.truth ?? "true"),
    [kind, setKind] = useState(fact?.scope.kind ?? "book"),
    [node, setNode] = useState(fact?.nodeId ?? "");
  const [about, setAbout] = useState(fact?.entryIds ?? []),
    [knowledge, setKnowledge] = useState(fact?.knowledge ?? []),
    [ack, setAck] = useState(false),
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
  const availableKnowers = [
    "reader",
    ...catalog.entries
      .filter((e) => !e.deletedAt && e.entryType === "character")
      .map((e) => e.id),
  ].filter((id) => !knowledge.some((k) => k.knower === id));
  const invalidPoint = [node, ...knowledge.map((k) => k.nodeId)].some(
    (id) => id && !scopedNodes.some((n) => n.id === id),
  );
  return (
    <form
      aria-label={
        mode === "edit"
          ? fact
            ? "Edit Fact"
            : "New Fact"
          : mode === "trash"
            ? "Move Fact to Trash"
            : "Restore Fact"
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
                truth,
                nodeId: node || null,
                entryIds: about,
                knowledge,
                ...(fact
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
          ? fact
            ? "Edit Fact"
            : "New Fact"
          : mode === "trash"
            ? "Move Fact to Trash"
            : "Restore Fact"}
      </h3>
      <fieldset disabled={busy}>
        {mode === "edit" ? (
          <>
            <label>
              Fact
              <textarea
                required
                maxLength={20000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
              />
            </label>
            <label>
              Truth
              <select
                value={truth}
                onChange={(e) => setTruth(e.target.value as Fact["truth"])}
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
                  onClick={() =>
                    setKnowledge(knowledge.filter((x) => x.knower !== k.knower))
                  }
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
        ) : (
          <p style={{ whiteSpace: "pre-wrap" }}>{fact?.text}</p>
        )}
        {shared && (
          <label className="entry-toggle" style={{ margin: "1rem 0" }}>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {fact
              ? "Apply this change to the shared fact for all books in its scope"
              : "Create this shared fact for all books in its scope"}
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
            ? "Save Fact"
            : mode === "trash"
              ? "Move Fact to Trash"
              : "Restore Fact"}
        </button>
      </fieldset>
    </form>
  );
}

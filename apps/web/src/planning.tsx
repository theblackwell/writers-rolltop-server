// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Item } from "./api.ts";
type Entry = {
  id: string;
  name: string;
  entryType: string;
  deletedAt?: string;
};
export type PlanningCatalog = {
  book: Item;
  nodes: Item[];
  entries: Entry[];
  words: number;
  nodeWords: Record<string, number>;
};
const overview = [
  "logline",
  "premise",
  "themes",
  "arcs",
  "principles",
] as const;
export function Planning({
  bookId,
  initialId,
  onSaved,
}: {
  bookId: string;
  initialId?: string;
  onSaved?: (item: Item, isBook: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<PlanningCatalog>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState<Item>(),
    [isBook, setIsBook] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setCatalog(await api("/books/" + bookId + "/planning"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let live = true;
    setBusy(true);
    api<PlanningCatalog>("/books/" + bookId + "/planning")
      .then((c) => {
        if (!live) return;
        setCatalog(c);
        if (initialId) {
          const n = c.nodes.find((n) => n.id === initialId);
          if (n) {
            setEdit(n);
            setIsBook(false);
          } else
            setError(
              "This item is no longer available. Review the live structure below.",
            );
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [bookId, initialId]);
  const open = (item: Item, book = false) => {
    setError("");
    setEdit(item);
    setIsBook(book);
  };
  return (
    <section aria-label="Story Overview and Planning">
      <p>
        Plans guide the story. Word totals include saved writing in live
        manuscript items.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading planning…</p>}
      {catalog && (
        <>
          <p>
            {catalog.words.toLocaleString()} words written
            {catalog.book.targetWordCount !== undefined
              ? ` · book goal ${catalog.book.targetWordCount.toLocaleString()}`
              : ""}
          </p>
          {edit ? (
            <PlanningForm
              key={edit.id}
              item={edit}
              isBook={isBook}
              entries={catalog.entries}
              bookId={bookId}
              onCancel={() => setEdit(undefined)}
              onSaved={(item) => {
                setCatalog((c) =>
                  c
                    ? {
                        ...c,
                        book: isBook ? item : c.book,
                        nodes: isBook
                          ? c.nodes
                          : c.nodes.map((n) => (n.id === item.id ? item : n)),
                      }
                    : c,
                );
                onSaved?.(item, isBook);
                setEdit(undefined);
              }}
            />
          ) : (
            <>
              <h3>{catalog.book.title}</h3>
              {overview.map(
                (k) =>
                  catalog.book[k] !== undefined && (
                    <div key={k}>
                      <h4>{k[0].toUpperCase() + k.slice(1)}</h4>
                      <p style={{ whiteSpace: "pre-wrap" }}>
                        {catalog.book[k]}
                      </p>
                    </div>
                  ),
              )}
              <button onClick={() => open(catalog.book, true)}>
                Edit Story Overview
              </button>
              <h3>Structure and Plans</h3>
              {!catalog.nodes.length && (
                <p>
                  Add parts, chapters or scenes in the binder to plan them here.
                </p>
              )}
              <ul className="search-results">
                {catalog.nodes.map((n) => (
                  <li key={n.id}>
                    <h4>
                      {n.kind}: {n.title}
                    </h4>
                    <p>
                      {(catalog.nodeWords[n.id] ?? 0).toLocaleString()} words
                      written
                      {n.targetWordCount !== undefined
                        ? ` / ${n.targetWordCount.toLocaleString()} planned · ${Math.round(((catalog.nodeWords[n.id] ?? 0) / n.targetWordCount) * 100)}%`
                        : ""}
                    </p>
                    {n.plan !== undefined && (
                      <p style={{ whiteSpace: "pre-wrap" }}>Plan: {n.plan}</p>
                    )}
                    {n.synopsis !== undefined && (
                      <p style={{ whiteSpace: "pre-wrap" }}>
                        Synopsis: {n.synopsis}
                      </p>
                    )}
                    {n.status !== undefined && <p>Status: {n.status}</p>}
                    {(["povEntryId", "settingEntryId"] as const).map(
                      (k) =>
                        n[k] && (
                          <p key={k}>
                            {k === "povEntryId" ? "POV" : "Setting"}:{" "}
                            {catalog.entries.find((e) => e.id === n[k])?.name ??
                              "Unavailable entry"}
                            {catalog.entries.find((e) => e.id === n[k])
                              ?.deletedAt
                              ? " (in Trash)"
                              : ""}
                          </p>
                        ),
                    )}
                    <button onClick={() => open(n)}>Edit {n.title}</button>
                  </li>
                ))}
              </ul>
              <button disabled={busy} onClick={() => void load()}>
                Refresh Saved Totals
              </button>
            </>
          )}
        </>
      )}
      {!catalog && !busy && (
        <button onClick={() => void load()}>Try Again</button>
      )}
    </section>
  );
}
function PlanningForm({
  item,
  isBook,
  entries,
  bookId,
  onCancel,
  onSaved,
}: {
  item: Item;
  isBook: boolean;
  entries: Entry[];
  bookId: string;
  onCancel: () => void;
  onSaved: (item: Item) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        [
          ...overview,
          "targetWordCount",
          "plan",
          "synopsis",
          "status",
          "povEntryId",
          "settingEntryId",
        ].map((k) => [k, String((item as any)[k] ?? "")]),
      ),
    ),
    [present, setPresent] = useState({
      synopsis: item.synopsis !== undefined,
      status: item.status !== undefined,
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const plan = !isBook && ["part", "chapter"].includes(item.kind ?? ""),
    point = !isBook && ["chapter", "scene"].includes(item.kind ?? "");
  const text = (key: string, label: string, max = 20000) => (
    <label key={key}>
      {label}
      <textarea
        value={draft[key]}
        maxLength={max}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </label>
  );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const input: any = { expectedUpdatedAt: item.updatedAt };
    if (isBook) for (const k of overview) input[k] = draft[k];
    if (plan) {
      if (draft.targetWordCount && !/^\d+$/.test(draft.targetWordCount)) {
        setError("Use a positive whole number for the word target.");
        return;
      }
      input.targetWordCount = draft.targetWordCount
        ? Number(draft.targetWordCount)
        : null;
      input.plan = draft.plan;
    }
    if (point) {
      for (const k of ["synopsis", "status"] as const)
        input[k] = present[k] ? draft[k] : null;
      for (const k of ["povEntryId", "settingEntryId"])
        input[k] = draft[k] || null;
    }
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api(
          "/books/" +
            bookId +
            (isBook ? "" : "/nodes/" + item.id) +
            "/planning",
          "PUT",
          input,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      aria-label={isBook ? "Edit Story Overview" : "Edit Manuscript Planning"}
      onSubmit={(e) => void save(e)}
    >
      <h3>{isBook ? "Story Overview" : item.title}</h3>
      <fieldset disabled={busy}>
        {isBook &&
          overview.map((k) => text(k, k[0].toUpperCase() + k.slice(1)))}
        {plan && (
          <>
            <label>
              Planned words
              <input
                inputMode="numeric"
                value={draft.targetWordCount}
                onChange={(e) =>
                  setDraft({ ...draft, targetWordCount: e.target.value })
                }
              />
            </label>
            {text("plan", "Plan")}
            <p>Leave planned words or plan blank to remove it.</p>
          </>
        )}
        {point && (
          <>
            {(["synopsis", "status"] as const).map((k) => (
              <div key={k}>
                <label>
                  <input
                    type="checkbox"
                    checked={present[k]}
                    onChange={(e) =>
                      setPresent({ ...present, [k]: e.target.checked })
                    }
                  />
                  Include {k}
                </label>
                {present[k] &&
                  text(
                    k,
                    k === "synopsis" ? "Synopsis" : "Status",
                    k === "status" ? 64 : 1000000,
                  )}
              </div>
            ))}
            {(["povEntryId", "settingEntryId"] as const).map((k) => {
              const type = k === "povEntryId" ? "character" : "location",
                current = entries.find((e) => e.id === draft[k]),
                available = entries.filter(
                  (e) => !e.deletedAt && e.entryType === type,
                );
              return (
                <label key={k}>
                  {k === "povEntryId" ? "Point of view" : "Setting"}
                  <select
                    value={draft[k]}
                    onChange={(e) =>
                      setDraft({ ...draft, [k]: e.target.value })
                    }
                  >
                    <option value="">Not set</option>
                    {draft[k] && !available.some((e) => e.id === draft[k]) && (
                      <option value={draft[k]} disabled>
                        {current?.name ?? "Unavailable entry"} (unavailable;
                        kept until cleared)
                      </option>
                    )}
                    {available.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit">{busy ? "Saving…" : "Save Planning"}</button>
        </div>
      </fieldset>
    </form>
  );
}

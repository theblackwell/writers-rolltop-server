// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { NameNeeded } from "../../../packages/studio/src/names.ts";
export function NamesNeeded({
  bookId,
  onOpen,
}: {
  bookId: string;
  onOpen: (item: NameNeeded) => Promise<void>;
}) {
  const [items, setItems] = useState<NameNeeded[]>(),
    [source, setSource] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setItems(
        (
          await api<{ items: NameNeeded[] }>(
            "/books/" + bookId + "/names-needed",
          )
        ).items,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let live = true;
    setBusy(true);
    api<{ items: NameNeeded[] }>("/books/" + bookId + "/names-needed")
      .then((c) => {
        if (live) setItems(c.items);
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
  }, [bookId]);
  const shown = items?.filter(
    (n) =>
      (!source || n.source === source) &&
      [n.text, n.title].some((t) =>
        t.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
  );
  async function open(n: NameNeeded) {
    setBusy(true);
    setError("");
    try {
      await onOpen(n);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Names Still Needed">
      <p>
        Mark a bible entry “Name still to be decided”, or write a [placeholder]
        in the manuscript, an entry name or summary, or a fact. Each distinct
        placeholder is listed once per source.
      </p>
      <label>
        Find name or source
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <label>
        Show
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          <option value="flag">Flagged entries</option>
          <option value="manuscript">Manuscript placeholders</option>
          <option value="entry">Bible placeholders</option>
          <option value="fact">Fact placeholders</option>
        </select>
      </label>
      <button disabled={busy} onClick={() => void refresh()}>
        Check Again
      </button>
      {busy && <p role="status">Checking names…</p>}
      {error && <p role="alert">{error}</p>}
      {items && (
        <>
          <p>
            {items.length} names still needed
            {shown?.length !== items.length ? ` · ${shown?.length} shown` : ""}.
          </p>
          {!shown?.length && (
            <p>
              {items.length
                ? "No names match these filters."
                : "Nothing waiting. Mark an entry or add a [placeholder] to keep track of names still needed."}
            </p>
          )}
          <ul className="search-results">
            {shown?.map((n) => (
              <li key={n.id}>
                <strong style={{ whiteSpace: "pre-wrap" }}>{n.text}</strong>
                <p>
                  {n.source === "flag"
                    ? "Name still to be decided"
                    : n.source === "manuscript"
                      ? "Manuscript"
                      : n.source === "entry"
                        ? "Bible entry"
                        : "Fact"}{" "}
                  · {n.title}
                </p>
                <button disabled={busy} onClick={() => void open(n)}>
                  Open{" "}
                  {n.source === "manuscript"
                    ? "Manuscript"
                    : n.source === "fact"
                      ? "Fact"
                      : "Entry"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import React, { useState } from "react";
import { api } from "./api.ts";
import type { Item } from "./api.ts";
type Results = {
  results: { nodeId: string; title: string; snippet: string }[];
  truncated: boolean;
};
export function ManuscriptSearch({
  book,
  onOpen,
}: {
  book: Item;
  onOpen: (id: string) => Promise<void>;
}) {
  const [result, setResult] = useState<Results | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section>
      <p>
        Search saved scene and front/back matter titles and text in {book.title}
        . Matches are literal and ignore case.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const query = String(new FormData(event.currentTarget).get("query"));
          setBusy(true);
          setError("");
          setResult(null);
          try {
            setResult(
              await api(
                `/books/${book.id}/search?q=${encodeURIComponent(query)}`,
              ),
            );
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Search could not finish.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Find text
          <input name="query" required maxLength={200} autoFocus />
        </label>
        <button disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite">
        {result && (
          <p>
            {result.results.length} matching items
            {result.truncated ? " (first 50; narrow your search)" : ""}.
          </p>
        )}
      </div>
      <ul className="search-results">
        {result?.results.map((hit) => (
          <li key={hit.nodeId}>
            <button
              onClick={async () => {
                try {
                  await onOpen(hit.nodeId);
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "The item could not open.",
                  );
                }
              }}
            >
              {hit.title}
            </button>
            <p>{hit.snippet}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

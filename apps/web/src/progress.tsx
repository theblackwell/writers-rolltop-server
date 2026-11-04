// SPDX-License-Identifier: AGPL-3.0-only
import React, { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Item } from "./api.ts";
import { readingOrder, liveNodes } from "./manuscript.ts";
export function BookProgress({
  book,
  nodes,
  refresh,
}: {
  book: Item;
  nodes: Item[];
  refresh: number;
}) {
  const [data, setData] = useState<{
    words: number;
    nodeWords: Record<string, number>;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    api(`/books/${book.id}/progress`)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [book.id, refresh, nodes]);
  return (
    <section aria-label="Word goals and progress">
      <p>
        Saved manuscript totals, including front and back matter. Trash is
        excluded. Counts refresh after saves; Unicode word counts are
        informational.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading totals…</p>}
      {data && (
        <>
          <p>
            <strong>{data.words.toLocaleString()} saved words</strong>
            {book.targetWordCount
              ? ` of ${book.targetWordCount.toLocaleString()} (${Math.floor((data.words / book.targetWordCount) * 100)}%)`
              : ""}
          </p>
          {book.targetWordCount && (
            <>
              <progress
                aria-label="Book word goal"
                max={book.targetWordCount}
                value={Math.min(data.words, book.targetWordCount)}
              />
              <p>
                {Math.max(
                  0,
                  book.targetWordCount - data.words,
                ).toLocaleString()}{" "}
                words remaining.
              </p>
            </>
          )}
          {book.targetDate && <p>Target date: {book.targetDate}</p>}
          <ul className="search-results">
            {readingOrder(liveNodes(nodes)).map((n) => (
              <li key={n.id}>
                {n.title}: {(data.nodeWords[n.id] ?? 0).toLocaleString()} words
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

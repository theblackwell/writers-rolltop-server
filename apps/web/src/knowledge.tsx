// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { KnowerFacts } from "../../../packages/studio/src/continuity-values.ts";
type KnowledgeCatalog = {
  pointId?: string;
  nodes: { id: string; title: string; kind: string }[];
  groups: KnowerFacts[];
};
export function Knowledge({
  bookId,
  initialPoint,
  onOpenFact,
}: {
  bookId: string;
  initialPoint?: string;
  onOpenFact?: (id: string) => Promise<void>;
}) {
  const [point, setPoint] = useState(initialPoint ?? ""),
    [catalog, setCatalog] = useState<KnowledgeCatalog>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    api<KnowledgeCatalog>(
      "/books/" +
        bookId +
        "/knowledge" +
        (point ? "?asOf=" + encodeURIComponent(point) : ""),
    )
      .then((c) => {
        if (live) setCatalog(c);
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
  }, [bookId, point]);
  const open = async (id: string) => {
    try {
      await onOpenFact?.(id);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The fact could not be opened.",
      );
    }
  };
  return (
    <section aria-label="Who Knows What">
      <p>
        Includes facts learned by this chapter or scene, in earlier books of
        their story, or known from the start.
      </p>
      {error && <p role="alert">{error}</p>}
      {error && point && (
        <button onClick={() => setPoint("")}>Choose Another Point</button>
      )}
      {catalog && (
        <label>
          As of
          <select
            disabled={busy}
            value={catalog.pointId ?? ""}
            onChange={(e) => setPoint(e.target.value)}
          >
            <option value="">Choose a chapter or scene</option>
            {catalog.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {busy && <p role="status">Checking saved knowledge…</p>}
      {catalog && !busy && !error && (
        <>
          {!catalog.nodes.length ? (
            <p>No live chapters or scenes yet.</p>
          ) : !catalog.groups.length ? (
            <p>Nobody knows any recorded facts yet at this point.</p>
          ) : (
            catalog.groups.map((g) => (
              <section key={g.id} aria-label={"Facts known by " + g.name}>
                <h3>{g.name}</h3>
                <ul className="search-results">
                  {g.facts.map((f) => (
                    <li key={f.id}>
                      <strong style={{ whiteSpace: "pre-wrap" }}>
                        {f.text}
                      </strong>
                      <p>
                        {f.learnedIn
                          ? "Learned in " + f.learnedIn.title
                          : "Known from the start"}
                        {f.truth === "false"
                          ? " · Believes something that isn't true"
                          : f.truth === "undecided"
                            ? " · Not decided yet"
                            : ""}
                      </p>
                      {onOpenFact && (
                        <button onClick={() => void open(f.id)}>
                          Open Fact
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </section>
  );
}

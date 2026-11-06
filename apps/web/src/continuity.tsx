// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { ContinuityWarning } from "../../../packages/studio/src/continuity-values.ts";
export type ContinuityCatalog = {
  warnings: ContinuityWarning[];
  intentionalCount: number;
  checkedAt: string;
  subjects: { id: string; title?: string }[];
};
export function Continuity({ bookId }: { bookId: string }) {
  const [catalog, setCatalog] = useState<ContinuityCatalog>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setBusy(true);
    api<ContinuityCatalog>("/books/" + bookId + "/continuity")
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
  }, [bookId]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setCatalog(await api("/books/" + bookId + "/continuity"));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Continuity could not be checked.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Continuity Warnings">
      <p>
        Advisory checks of recorded facts, questions and state changes. Review
        the records before changing your story.
      </p>
      <button disabled={busy} onClick={() => void refresh()}>
        {busy ? "Checking…" : "Check Again"}
      </button>
      {error && <p role="alert">{error}</p>}
      {catalog && (
        <>
          <p role="status">
            {catalog.warnings.length === 0
              ? "No continuity warnings."
              : catalog.warnings.length === 1
                ? "1 continuity warning."
                : catalog.warnings.length + " continuity warnings."}
            {busy ? " Checking saved records again." : ""}
          </p>
          <p>
            These checks use saved records and whether a chapter or scene has
            words. They do not infer meaning from prose.
          </p>
          {catalog.intentionalCount > 0 && (
            <p>
              {catalog.intentionalCount} matching{" "}
              {catalog.intentionalCount === 1 ? "warning is" : "warnings are"}{" "}
              already marked intentional and hidden.
            </p>
          )}
          <ul className="search-results">
            {catalog.warnings.map((w) => (
              <li key={w.id}>
                <strong>
                  {w.subject.kind === "fact"
                    ? "Fact"
                    : w.subject.kind === "question"
                      ? "Question"
                      : "Event"}
                  :{" "}
                  {catalog.subjects.find((s) => s.id === w.id)?.title ||
                    "Unavailable record"}
                </strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{w.message}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      {!catalog && busy && <p role="status">Checking saved records…</p>}
    </section>
  );
}

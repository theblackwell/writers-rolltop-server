// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { ContinuityWarning } from "../../../packages/studio/src/continuity-values.ts";
export type ContinuityCatalog = {
  warnings: ContinuityWarning[];
  intentionalWarnings?: ContinuityWarning[];
  intentionalCount: number;
  checkedAt: string;
  nodes?: { id: string; bookId: string; title: string }[];
  subjects: {
    id: string;
    title?: string;
    updatedAt?: string;
    shared?: boolean;
  }[];
};
export function Continuity({
  bookId,
  nodeFilter,
  onCatalog,
  onOpenSubject,
  onOpenPlace,
}: {
  bookId: string;
  nodeFilter?: string;
  onCatalog?: (c: ContinuityCatalog) => void;
  onOpenSubject?: (
    kind: "fact" | "question" | "event",
    id: string,
  ) => Promise<void>;
  onOpenPlace?: (p: { id: string; bookId: string }) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<ContinuityCatalog>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [marking, setMarking] = useState<ContinuityWarning>(),
    [restore, setRestore] = useState(false),
    [note, setNote] = useState(""),
    [ack, setAck] = useState(false),
    [filtered, setFiltered] = useState(!!nodeFilter);
  const accept = (c: ContinuityCatalog) => {
    setCatalog(c);
    onCatalog?.(c);
  };
  useEffect(() => {
    let live = true;
    setBusy(true);
    api<ContinuityCatalog>("/books/" + bookId + "/continuity")
      .then((c) => {
        if (live) accept(c);
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
      accept(await api("/books/" + bookId + "/continuity"));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Continuity could not be checked.",
      );
    } finally {
      setBusy(false);
    }
  }
  const meta = catalog?.subjects.find((s) => s.id === marking?.id);
  async function save() {
    if (!marking || !meta?.updatedAt || (meta.shared && !ack)) return;
    setBusy(true);
    setError("");
    try {
      accept(
        await api("/books/" + bookId + "/continuity/dismissals", "PUT", {
          subjectKind: marking.subject.kind,
          subjectId: marking.subject.id,
          key: marking.key,
          expectedUpdatedAt: meta.updatedAt,
          ...(restore ? { restore: true } : { note }),
          ...(meta.shared ? { editSharedCanon: true } : {}),
        }),
      );
      setMarking(undefined);
      setNote("");
      setAck(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The warning could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function navigate(work: () => Promise<void>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "That record could not be opened.",
      );
    }
  }
  const row = (w: ContinuityWarning) => {
    const subject = catalog!.subjects.find((s) => s.id === w.id);
    return (
      <li key={w.id}>
        <strong>
          {w.subject.kind === "fact"
            ? "Fact"
            : w.subject.kind === "question"
              ? "Question"
              : "Event"}
          : {subject?.title || "Unavailable record"}
        </strong>
        <p style={{ whiteSpace: "pre-wrap" }}>{w.message}</p>
        {w.dismissal?.note && (
          <p style={{ whiteSpace: "pre-wrap" }}>
            Intentional: {w.dismissal.note}
          </p>
        )}
        {onOpenSubject && (
          <button
            disabled={busy || !!marking}
            onClick={() =>
              void navigate(() => onOpenSubject(w.subject.kind, w.subject.id))
            }
          >
            Open{" "}
            {w.subject.kind === "fact"
              ? "Fact"
              : w.subject.kind === "question"
                ? "Question"
                : "Event"}
          </button>
        )}
        {onOpenPlace &&
          w.nodeIds.map((id) => {
            const p = catalog!.nodes?.find((n) => n.id === id);
            return p ? (
              <button
                key={id}
                disabled={busy || !!marking}
                onClick={() => void navigate(() => onOpenPlace(p))}
              >
                Go to {p.title}
              </button>
            ) : null;
          })}
        <button
          disabled={busy || !!marking || !subject?.updatedAt}
          onClick={() => {
            setError("");
            setMarking(w);
            setRestore(!!w.dismissal);
            setNote(w.dismissal?.note ?? "");
            setAck(false);
          }}
        >
          {w.dismissal ? "Show Again" : "Mark as Intentional…"}
        </button>
      </li>
    );
  };
  const visible = (rows: ContinuityWarning[]) =>
    filtered && nodeFilter
      ? rows.filter((w) => w.nodeIds.includes(nodeFilter))
      : rows;
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
          {nodeFilter && (
            <label className="entry-toggle">
              <input
                type="checkbox"
                checked={filtered}
                onChange={(e) => setFiltered(e.target.checked)}
              />
              Only warnings about this chapter or scene
            </label>
          )}
          {marking && (
            <form
              aria-label={
                restore ? "Show Warning Again" : "Mark Warning as Intentional"
              }
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <h3>
                {restore ? "Show this warning again?" : "Mark as intentional"}
              </h3>
              <p>{marking.message}</p>
              {!meta?.updatedAt && (
                <p role="alert">
                  This warning no longer applies. Your note is kept; cancel to
                  review the updated list.
                </p>
              )}
              <fieldset disabled={busy}>
                {!restore && (
                  <label>
                    Why it's intentional (optional)
                    <textarea
                      maxLength={2000}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                )}
                {meta?.shared && (
                  <label className="entry-toggle">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    Apply this warning change to all books sharing this record
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMarking(undefined);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button disabled={!meta?.updatedAt || (meta.shared && !ack)}>
                  {restore ? "Show Warning Again" : "Mark as Intentional"}
                </button>
              </fieldset>
            </form>
          )}
          <ul className="search-results">
            {visible(catalog.warnings).map(row)}
          </ul>
          {(catalog.intentionalWarnings ?? []).length > 0 && (
            <section aria-label="Marked as intentional">
              <h3>Marked as intentional</h3>
              <p>A warning returns if the places named by its key change.</p>
              <ul className="search-results">
                {visible(catalog.intentionalWarnings ?? []).map(row)}
              </ul>
            </section>
          )}
        </>
      )}
      {!catalog && busy && <p role="status">Checking saved records…</p>}
    </section>
  );
}

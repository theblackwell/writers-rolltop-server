// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import { api } from "./api.ts";
import { orderedEvents } from "../../../packages/studio/src/timeline-order.ts";
import { SaveStatus } from "./entry-editing.tsx";
import { useRecordWriter } from "./record-editing.tsx";
import type { RecordHost } from "./record-editing.tsx";
import { FactForm } from "./facts.tsx";
import type { Fact, FactCatalog } from "./facts.tsx";
import { QuestionForm } from "./questions.tsx";
import type { Question, QuestionCatalog } from "./questions.tsx";
import { TimelineEventForm } from "./timeline.tsx";
import type { TimelineEvent, TimelineEventCatalog } from "./timeline.tsx";
import { entryTypeLabel } from "./entries.tsx";

// Facts, questions and timeline events share one list-and-page shape in the
// Story Bible tab. This file holds what the three have in common.

export type RecordKind = "event" | "fact" | "question";
export type AnyRecord = Fact | Question | TimelineEvent;
export type RecordCatalogs = {
  fact?: FactCatalog;
  question?: QuestionCatalog;
  event?: TimelineEventCatalog;
};
type AnyCatalog = FactCatalog | QuestionCatalog | TimelineEventCatalog;
export const recordKindList: RecordKind[] = ["event", "fact", "question"];
export const recordKinds: Record<
  RecordKind,
  {
    /** Name of one record, used in headings and labels. */
    label: string;
    /** Sidebar switch and list heading. */
    section: string;
    path: string;
    listKey: string;
  }
> = {
  event: {
    label: "Timeline event",
    section: "Timeline",
    path: "events",
    listKey: "events",
  },
  fact: {
    label: "Fact",
    section: "Facts",
    path: "facts",
    listKey: "facts",
  },
  question: {
    label: "Question",
    section: "Questions",
    path: "questions",
    listKey: "questions",
  },
};

export function recordsOf(kind: RecordKind, c: RecordCatalogs): AnyRecord[] {
  if (kind === "fact") return c.fact?.facts ?? [];
  if (kind === "question") return c.question?.questions ?? [];
  return c.event?.events ?? [];
}
export function recordTitle(kind: RecordKind, r: AnyRecord) {
  if (kind === "event") return (r as TimelineEvent).title || "Untitled event";
  return (r as Fact | Question).text;
}
const clip = (text: string, max = 140) =>
  [...text].length > max ? [...text].slice(0, max).join("") + "…" : text;
const truthTitle = (truth: string) =>
  truth === "false" ? "Not true" : truth === "true" ? "True" : "Undecided";

/** Loads the three catalogs for a book; saves from record pages merge in. */
export function useRecordCatalogs(bookId: string, tick = 0) {
  const [catalogs, setCatalogs] = useState<RecordCatalogs>({});
  const [errors, setErrors] = useState<Partial<Record<RecordKind, string>>>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setCatalogs({});
    setErrors({});
    for (const kind of recordKindList) {
      const { path, listKey } = recordKinds[kind];
      api<AnyCatalog>(`/books/${bookId}/${path}`)
        .then((c) => {
          if (!live) return;
          if (!Array.isArray((c as any)?.[listKey]))
            throw new Error("The server sent an unreadable list.");
          setCatalogs((prev) => ({ ...prev, [kind]: c }));
        })
        .catch((e) => {
          if (live)
            setErrors((prev) => ({
              ...prev,
              [kind]: e instanceof Error ? e.message : "Could not load.",
            }));
        });
    }
    return () => {
      live = false;
    };
  }, [bookId, tick, version]);
  const apply = useCallback(
    (kind: RecordKind, record: AnyRecord, created: boolean) =>
      setCatalogs((prev) => {
        const catalog: any = prev[kind];
        if (!catalog) return prev;
        const key = recordKinds[kind].listKey;
        const list: AnyRecord[] = catalog[key];
        return {
          ...prev,
          [kind]: {
            ...catalog,
            [key]: created
              ? [...list, record]
              : list.map((r) => (r.id === record.id ? record : r)),
          },
        };
      }),
    [],
  );
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { catalogs, errors, apply, reload };
}

/* ---------------------------------------------------------------- links */

type Named = { entryId: string; note?: string };
/** Entries a record names, from the saved record (not the open draft). */
export function entriesNamed(kind: RecordKind, r: AnyRecord): Named[] {
  if (kind === "fact") {
    const f = r as Fact;
    const named: Named[] = f.entryIds.map((entryId) => ({
      entryId,
      note: "About",
    }));
    for (const k of f.knowledge)
      if (k.knower !== "reader") {
        const same = named.find((n) => n.entryId === k.knower);
        if (same) same.note = "About, and knows it";
        else named.push({ entryId: k.knower, note: "Knows it" });
      }
    return named;
  }
  if (kind === "question")
    return (r as Question).entryIds.map((entryId) => ({
      entryId,
      note: "About",
    }));
  const e = r as TimelineEvent;
  const named: Named[] = e.entryId
    ? [{ entryId: e.entryId, note: "Event entry" }]
    : [];
  for (const p of e.participants) {
    const same = named.find((n) => n.entryId === p.entryId);
    const note = p.role ? `Involved: ${p.role}` : "Involved";
    if (same) same.note = `${same.note}; ${note}`;
    else named.push({ entryId: p.entryId, note });
  }
  return named;
}
export type Mention = {
  kind: RecordKind;
  id: string;
  title: string;
  note: string;
};
/** Live records that name an entry. Trashed records are not listed. */
export function mentionsOf(entryId: string, c: RecordCatalogs): Mention[] {
  const out: Mention[] = [];
  for (const kind of recordKindList)
    for (const r of recordsOf(kind, c)) {
      if (r.deletedAt) continue;
      const hit = entriesNamed(kind, r).find((n) => n.entryId === entryId);
      if (hit)
        out.push({
          kind,
          id: r.id,
          title: recordTitle(kind, r),
          note: hit.note ?? "",
        });
    }
  return out;
}

// "Mentioned in" on an entry page: the records that name this entry.
export function EntryMentions({
  entryId,
  catalogs,
  errors,
  onOpenRecord,
}: {
  entryId: string;
  catalogs: RecordCatalogs;
  errors: Partial<Record<RecordKind, string>>;
  onOpenRecord?: (kind: RecordKind, id: string) => void;
}) {
  const mentions = mentionsOf(entryId, catalogs);
  const failed = recordKindList.filter((k) => errors[k]);
  const loading = recordKindList.some((k) => !catalogs[k] && !errors[k]);
  return (
    <section className="entry-section" aria-label="Mentioned in">
      <h3>Mentioned in</h3>
      {recordKindList.map((kind) => {
        const items = mentions.filter((m) => m.kind === kind);
        if (!items.length) return null;
        return (
          <section key={kind} aria-label={recordKinds[kind].section}>
            <h4>{recordKinds[kind].section}</h4>
            <ul className="record-links">
              {items.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpenRecord?.(kind, m.id)}
                  >
                    {clip(m.title, 100)}
                  </button>{" "}
                  <small>{m.note}</small>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {failed.map((k) => (
        <p key={k} role="alert">
          Could not load {recordKinds[k].section.toLowerCase()}. {errors[k]}
        </p>
      ))}
      {loading && <p role="status">Loading records…</p>}
      {!loading && !failed.length && !mentions.length && (
        <p className="hint">
          No facts, questions or timeline events name this entry yet.
        </p>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- list */

const factFacets = [
  ["", "All"],
  ["true", "True"],
  ["false", "Not true"],
  ["undecided", "Undecided"],
];
const questionFacets = [
  ["", "All"],
  ["open", "Open"],
  ["decided", "Decided"],
];

export function RecordList({
  kind,
  catalogs,
  error,
  selectedId,
  onPick,
  onRetry,
}: {
  kind: RecordKind;
  catalogs: RecordCatalogs;
  error?: string;
  selectedId?: string;
  onPick: (id: string) => void;
  onRetry: () => void;
}) {
  const cfg = recordKinds[kind];
  const [filter, setFilter] = useState("");
  const [facet, setFacet] = useState("");
  const [byReading, setByReading] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const loaded =
    kind === "fact"
      ? catalogs.fact
      : kind === "question"
        ? catalogs.question
        : catalogs.event;
  const all = recordsOf(kind, catalogs);
  const selected = all.find((r) => r.id === selectedId);
  useEffect(() => {
    if (selected?.deletedAt) setTrashOpen(true);
  }, [selected?.deletedAt]);
  const query = filter.trim().toLocaleLowerCase();
  const matches = (r: AnyRecord) => {
    const q = r as any;
    const hay = [recordTitle(kind, r), q.topic ?? "", q.summary ?? ""];
    const facetValue = kind === "fact" ? q.truth : q.status;
    return (
      hay.some((s: string) => s.toLocaleLowerCase().includes(query)) &&
      (!facet || kind === "event" || facetValue === facet)
    );
  };
  const ordered = (list: AnyRecord[]) =>
    kind === "event" && catalogs.event
      ? orderedEvents(
          list as TimelineEvent[],
          catalogs.event.readingPositions,
          byReading,
        )
      : list;
  const live = ordered(all.filter((r) => !r.deletedAt && matches(r)));
  const trashed = ordered(all.filter((r) => r.deletedAt && matches(r)));
  const meta = (r: AnyRecord) => {
    const scope = r.scope.kind === "book" ? "" : " · shared";
    if (kind === "fact") return truthTitle((r as Fact).truth) + scope;
    if (kind === "question")
      return (
        ((r as Question).status === "decided" ? "Decided" : "Open") + scope
      );
    const when = (r as TimelineEvent).when?.label;
    return (when ?? "Not dated") + scope;
  };
  const row = (r: AnyRecord) => (
    <li key={r.id}>
      <button
        type="button"
        className={`bible-row${r.id === selectedId ? " current" : ""}`}
        aria-current={r.id === selectedId ? "true" : undefined}
        onClick={() => onPick(r.id)}
      >
        <span className="record-row-title">
          {clip(recordTitle(kind, r), 120)}
        </span>
        <small>{meta(r)}</small>
      </button>
    </li>
  );
  if (error)
    return (
      <div role="alert">
        <p>
          Could not load {cfg.section.toLowerCase()}. {error}
        </p>
        <button onClick={onRetry}>Try Again</button>
      </div>
    );
  if (!loaded) return <p role="status">Loading {cfg.section.toLowerCase()}…</p>;
  const liveTotal = all.filter((r) => !r.deletedAt).length;
  return (
    <>
      <label>
        {`Find ${cfg.label.toLowerCase()}`}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      {kind === "event" ? (
        <label>
          Order
          <select
            value={byReading ? "reading" : "story"}
            onChange={(e) => setByReading(e.target.value === "reading")}
          >
            <option value="story">Story Date</option>
            <option value="reading">Reading Order</option>
          </select>
        </label>
      ) : (
        <label>
          Show
          <select value={facet} onChange={(e) => setFacet(e.target.value)}>
            {(kind === "fact" ? factFacets : questionFacets).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "event" && (
        <p className="hint">
          {byReading
            ? "Reading Order uses the earliest live scene in this book; unplaced events last."
            : "Story Date uses the order number; undated events last."}
        </p>
      )}
      {!liveTotal && !trashed.length && (
        <p className="hint">
          No {cfg.section.toLowerCase()} yet. Choose New to add one.
        </p>
      )}
      {!!liveTotal && !live.length && <p className="hint">Nothing matches.</p>}
      <ul className="bible-list" aria-label={cfg.section}>
        {live.map(row)}
      </ul>
      <details
        className="node-trash"
        open={trashOpen}
        onToggle={(e) => setTrashOpen(e.currentTarget.open)}
      >
        <summary>Trash ({all.filter((r) => r.deletedAt).length})</summary>
        {!trashed.length && <p className="hint">Nothing in Trash.</p>}
        <ul className="bible-list">{trashed.map(row)}</ul>
      </details>
    </>
  );
}

/* ----------------------------------------------------------------- page */

function scopeWord(kind: string) {
  return kind === "universe" ? "world" : "series";
}
function scopeTitle(
  scopes: { kind: string; id: string; title: string }[],
  s: { kind: string; id: string },
) {
  return (
    scopes.find((x) => x.id === s.id && x.kind === s.kind)?.title ??
    (s.kind === "book" ? "This book" : "Unavailable shared scope")
  );
}

export function RecordPage({
  kind,
  bookId,
  record,
  catalogs,
  onSaved,
  onOpenEntry,
  onBack,
  returnTo,
  onCancelNew,
  flushRef,
}: {
  kind: RecordKind;
  bookId: string;
  /** Missing means a new record. */
  record?: AnyRecord;
  catalogs: RecordCatalogs;
  onSaved: (kind: RecordKind, record: AnyRecord, created: boolean) => void;
  onOpenEntry?: (id: string) => void;
  onBack?: () => void;
  /** Where this record was opened from (for example the warnings list). */
  returnTo?: { label: string; onClick: () => void };
  onCancelNew: () => void;
  flushRef?: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const cfg = recordKinds[kind];
  const catalog = (
    kind === "fact"
      ? catalogs.fact
      : kind === "question"
        ? catalogs.question
        : catalogs.event
  ) as AnyCatalog;
  const isNew = !record;
  const [newShared, setNewShared] = useState(false);
  const shared = record ? record.scope.kind !== "book" : newShared;
  const trashed = !!record?.deletedAt;
  // Canon mode belongs to this record page (the app keys the page by record).
  const [canonOn, setCanonOn] = useState(false);
  const canon = shared && canonOn;
  const writer = useRecordWriter<any>({
    bookId,
    path: cfg.path,
    listKey: cfg.listKey,
    record,
    canon,
    onSaved: (saved, created) => onSaved(kind, saved, created),
  });
  const { flush } = writer;
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => {
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flushRef, flush]);
  const [busy, setBusy] = useState(false);
  const switchMode = async (on: boolean) => {
    if (isNew || (await flush())) setCanonOn(on);
  };
  const [trashError, setTrashError] = useState("");
  const trash = async () => {
    if (!record) return;
    setTrashError("");
    if (!(await flush())) return;
    setBusy(true);
    const result = await writer.write({ deleted: !trashed });
    setBusy(false);
    if (!result.ok && result.status !== 409) setTrashError(result.message);
  };
  const host: RecordHost = {
    canon,
    busy,
    held: !!writer.conflict && !writer.conflict.reloaded,
    save: writer.save,
    register: writer.register,
    setDirty: writer.setDirty,
    discard: isNew ? onCancelNew : writer.discard,
    onShared: isNew ? setNewShared : undefined,
  };
  const word = scopeWord(record?.scope.kind ?? "universe");
  const sharedScope = record ? scopeTitle(catalog.scopes, record.scope) : "";
  const title = record
    ? recordTitle(kind, record)
    : `New ${cfg.label.toLowerCase()}`;
  const named = record ? entriesNamed(kind, record) : [];
  const conflict = writer.conflict;
  const q = record as any;
  const badges: string[] = [];
  if (record) {
    badges.push(sharedScope);
    if (kind === "fact") badges.push(truthTitle(q.truth));
    if (kind === "question")
      badges.push(q.status === "decided" ? "Decided" : "Open");
    if (kind === "event") badges.push(q.when?.label ?? "Not dated");
  }
  return (
    <article className="entry-page" aria-label={`${cfg.label} page`}>
      <header className="entry-page-header">
        {onBack && (
          <button type="button" className="back-to-list" onClick={onBack}>
            ← Back to list
          </button>
        )}
        {returnTo && (
          <button
            type="button"
            className="return-link"
            onClick={returnTo.onClick}
          >
            ← {returnTo.label}
          </button>
        )}
        <div className="entry-title-row">
          <p className="eyebrow">{cfg.label}</p>
          <SaveStatus status={writer.status} />
        </div>
        <h1 style={{ whiteSpace: "pre-wrap" }}>{clip(title, 160)}</h1>
        <p className="entry-badges">
          {badges.map((b) => (
            <span key={b} className="entry-badge">
              {b}
            </span>
          ))}
          {trashed && <span className="entry-badge">In Trash</span>}
        </p>
      </header>
      {shared &&
        (canon ? (
          <div
            className="entry-banner canon"
            role="region"
            aria-label="Shared canon"
          >
            <p>
              <strong>Editing shared canon.</strong> Changes apply to every book
              in this {word}.
            </p>
            <button type="button" onClick={() => void switchMode(false)}>
              Back to This Book Only
            </button>
          </div>
        ) : (
          <div className="entry-banner" role="region" aria-label="Shared canon">
            <p>
              {isNew
                ? `This ${cfg.label.toLowerCase()} will be shared across the ${word}.`
                : `This ${cfg.label.toLowerCase()} is shared across this ${word}, so it is read-only here.`}
            </p>
            <button type="button" onClick={() => void switchMode(true)}>
              Edit shared details
            </button>
          </div>
        ))}
      {conflict && (
        <div className="entry-banner conflict" role="alert">
          {conflict.reloaded ? (
            <>
              <p>
                <strong>Latest version loaded.</strong> Your unsaved changes are
                still in the fields below. They save when you leave a field, or
                you can discard them.
              </p>
              <div className="dialog-actions">
                <button type="button" onClick={writer.discard}>
                  Discard My Changes
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                <strong>
                  This {cfg.label.toLowerCase()} changed somewhere else
                </strong>{" "}
                (another tab or browser), so your changes were not saved.{" "}
                {conflict.message}
              </p>
              <div className="dialog-actions">
                <button type="button" onClick={() => void writer.reload()}>
                  Reload {cfg.label.toLowerCase()}
                </button>
              </div>
            </>
          )}
          {writer.reloadError && <p role="alert">{writer.reloadError}</p>}
        </div>
      )}
      {writer.note && !conflict && <p role="alert">{writer.note}</p>}
      {writer.error && !conflict && <p role="alert">{writer.error}</p>}
      <section
        className="entry-section"
        aria-label="Details"
        key={writer.generation}
      >
        {trashed && record ? (
          <>
            <p style={{ whiteSpace: "pre-wrap" }}>{title}</p>
            <p>Restore this {cfg.label.toLowerCase()} to edit it.</p>
          </>
        ) : kind === "fact" ? (
          <FactForm
            catalog={catalog as FactCatalog}
            fact={record as Fact | undefined}
            host={host}
          />
        ) : kind === "question" ? (
          <QuestionForm
            catalog={catalog as QuestionCatalog}
            question={record as Question | undefined}
            host={host}
          />
        ) : (
          <TimelineEventForm
            catalog={catalog as TimelineEventCatalog}
            event={record as TimelineEvent | undefined}
            host={host}
          />
        )}
      </section>
      {record && (
        <section className="entry-section" aria-label="Entries named">
          <h3>Entries named</h3>
          {!named.length && (
            <p className="hint">
              This {cfg.label.toLowerCase()} does not name any entries yet.
            </p>
          )}
          <ul className="record-links">
            {named.map((n) => {
              const e = catalog.entries.find((x) => x.id === n.entryId);
              return (
                <li key={n.entryId}>
                  {e ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onOpenEntry?.(e.id)}
                    >
                      {e.name}
                    </button>
                  ) : (
                    <span>Unavailable entry</span>
                  )}{" "}
                  <small>
                    {e ? entryTypeLabel(e.entryType) : ""}
                    {e?.deletedAt ? " · in Trash" : ""}
                    {n.note ? ` · ${n.note}` : ""}
                  </small>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {record && (
        <section className="entry-section" aria-label="Trash">
          <h3>{trashed ? `${cfg.label} in Trash` : "Trash"}</h3>
          <button
            disabled={busy || (shared && !canon)}
            onClick={() => void trash()}
            aria-label={`${trashed ? "Restore" : "Trash"} ${cfg.label.toLowerCase()}`}
          >
            {trashed ? `Restore ${cfg.label}` : `Move ${cfg.label} to Trash`}
          </button>
          {shared && !canon && (
            <p className="hint">
              This {cfg.label.toLowerCase()} is shared. Choose Edit shared
              details to {trashed ? "restore" : "move it to Trash"} for every
              book in this {word}.
            </p>
          )}
          {trashError && <p role="alert">{trashError}</p>}
        </section>
      )}
    </article>
  );
}

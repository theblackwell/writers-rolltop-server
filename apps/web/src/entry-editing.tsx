// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, ApiError } from "./api.ts";
import type { Entry } from "./entries.tsx";

// Save-on-leave for one entry page. Every write for the entry goes through one
// queue so each request carries the newest updatedAt the server returned. The
// API's stale-write check covers the whole entry, so two overlapping writes
// built from the same page state would otherwise reject each other.

export type WriteResult =
  { ok: true; entry: Entry } | { ok: false; message: string; status?: number };
export type EntryWrite = {
  key: string;
  label: string;
  /** The user's text, kept in the conflict banner if the server rejects it. */
  draft?: string;
  run: (expectedUpdatedAt: string) => Promise<Entry>;
};
type Draft = {
  dirty: () => boolean;
  commit: () => Promise<boolean>;
};
export type EntryEditing = {
  /** True while the page edits shared canon (always false for book entries). */
  canon: boolean;
  shared: boolean;
  write: (write: EntryWrite) => Promise<WriteResult>;
  /** Builds a PUT for this entry; the queue supplies expectedUpdatedAt. */
  put: (path: string, payload: object) => (updatedAt: string) => Promise<Entry>;
  register: (key: string, draft: Draft) => () => void;
  setDirty: (key: string, dirty: boolean) => void;
};
export type Conflict = {
  message: string;
  drafts: { key: string; label: string; text: string }[];
  reloaded: boolean;
};
export const EntryEditingContext = createContext<EntryEditing | null>(null);
export function useEntryEditing() {
  const value = useContext(EntryEditingContext);
  if (!value) throw new Error("Entry editors must be inside an entry page.");
  return value;
}

export function useEntryWriter({
  entry,
  bookId,
  canon,
  onSaved,
  onReload,
}: {
  entry: Entry;
  bookId: string;
  canon: boolean;
  onSaved: (entry: Entry) => void;
  onReload?: () => Promise<void>;
}) {
  const shared = entry.scope?.kind !== "book";
  const latest = useRef(entry.updatedAt);
  const inflight = useRef(0);
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const drafts = useRef(new Map<string, Draft>());
  const held = useRef(false);
  const conflicted = useRef(false);
  const callbacks = useRef({ onSaved, onReload });
  callbacks.current = { onSaved, onReload };
  const [pending, setPending] = useState(0);
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [note, setNote] = useState("");
  const [reloadError, setReloadError] = useState("");
  const [generation, setGeneration] = useState(0);
  // A newer version from outside the queue (Reload entry) replaces ours, but
  // only while nothing is in flight; our own writes already advance it.
  useEffect(() => {
    if (inflight.current === 0) latest.current = entry.updatedAt;
  }, [entry.updatedAt]);

  const write = useCallback((w: EntryWrite): Promise<WriteResult> => {
    inflight.current++;
    setPending((n) => n + 1);
    const job = tail.current.then(async (): Promise<WriteResult> => {
      try {
        const result = await w.run(latest.current);
        latest.current = result.updatedAt;
        callbacks.current.onSaved(result);
        return { ok: true, entry: result };
      } catch (e) {
        const status = e instanceof ApiError ? e.status : undefined;
        const message =
          e instanceof Error ? e.message : "Could not save this change.";
        if (status === 409) {
          conflicted.current = true;
          setConflict((c) => ({
            message,
            reloaded: false,
            drafts: [
              ...(c?.drafts ?? []).filter((d) => d.key !== w.key),
              ...(w.draft === undefined
                ? []
                : [{ key: w.key, label: w.label, text: w.draft }]),
            ],
          }));
        }
        return { ok: false, message, status };
      } finally {
        inflight.current--;
        setPending((n) => n - 1);
      }
    });
    tail.current = job;
    return job;
  }, []);

  const setDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((keys) => {
      if (keys.has(key) === dirty) return keys;
      const next = new Set(keys);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const register = useCallback(
    (key: string, draft: Draft) => {
      drafts.current.set(key, draft);
      return () => {
        if (drafts.current.get(key) === draft) drafts.current.delete(key);
        setDirty(key, false);
      };
    },
    [setDirty],
  );

  /** Save every open draft in order. False means stay on this entry. */
  const flush = useCallback(async () => {
    if (held.current) {
      setNote(
        "Your changes are held after a reload. Choose Save My Changes or Discard My Changes first.",
      );
      return false;
    }
    setNote("");
    let ok = true;
    for (const draft of [...drafts.current.values()])
      if (draft.dirty() && !(await draft.commit())) ok = false;
    await tail.current;
    if (conflicted.current) ok = false;
    if (!ok)
      setNote(
        "Some changes are not saved. Fix or cancel them, then try again.",
      );
    return ok;
  }, []);

  const reload = useCallback(async () => {
    setReloadError("");
    try {
      const all = await api<Entry[]>(`/books/${bookId}/entries`);
      const next = all.find((e) => e.id === entry.id);
      if (!next) throw new Error("This entry is no longer available here.");
      await tail.current;
      latest.current = next.updatedAt;
      callbacks.current.onSaved(next);
      await callbacks.current.onReload?.();
      conflicted.current = false;
      // Drafts stay in their fields; the user decides what to do with them.
      held.current = [...drafts.current.values()].some((d) => d.dirty());
      setConflict((c) => (held.current && c ? { ...c, reloaded: true } : null));
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : "Could not reload.");
    }
  }, [bookId, entry.id]);
  // A reload can make a held draft equal to the server's copy.
  useEffect(() => {
    if (conflict?.reloaded && dirtyKeys.size === 0) {
      held.current = false;
      setConflict(null);
    }
  }, [conflict, dirtyKeys]);

  useEffect(() => {
    if (dirtyKeys.size === 0 && !conflict) setNote("");
  }, [dirtyKeys, conflict]);

  const discard = useCallback(() => {
    held.current = false;
    conflicted.current = false;
    setConflict(null);
    setNote("");
    setGeneration((g) => g + 1);
  }, []);
  const saveHeld = useCallback(async () => {
    held.current = false;
    setConflict(null);
    await flush();
  }, [flush]);

  const status: "saved" | "saving" | "unsaved" =
    pending > 0
      ? "saving"
      : dirtyKeys.size > 0 || conflict || note
        ? "unsaved"
        : "saved";
  useEffect(() => {
    if (status === "saved") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  const put = useCallback(
    (path: string, payload: object) => (updatedAt: string) =>
      api<Entry>(
        `/books/${bookId}/entries/${entry.id}${path ? `/${path}` : ""}`,
        "PUT",
        {
          ...payload,
          expectedUpdatedAt: updatedAt,
          ...(path.startsWith("values/")
            ? { mode: shared && !canon ? "book" : "canon" }
            : {}),
          ...(shared && canon ? { editSharedCanon: true } : {}),
        },
      ),
    [bookId, entry.id, shared, canon],
  );
  const context = useMemo<EntryEditing>(
    () => ({ canon: shared && canon, shared, write, put, register, setDirty }),
    [shared, canon, write, put, register, setDirty],
  );
  return {
    context,
    status,
    conflict,
    note,
    reloadError,
    generation,
    flush,
    reload,
    discard,
    saveHeld,
    write,
  };
}

/**
 * One editable value with a draft. Text saves when the field is left, choices
 * save on change; both call commit. The draft follows the saved value until
 * the user edits it, and survives the entry's own saves and a stale write.
 */
export function useDraftSave<T>(options: {
  key: string;
  label: string;
  saved: T;
  same: (a: T, b: T) => boolean;
  show: (draft: T) => string;
  /** Returns a message when the draft cannot be sent. */
  validate?: (draft: T) => string | undefined;
  send: (draft: T) => (expectedUpdatedAt: string) => Promise<Entry>;
}) {
  const ctx = useEntryEditing();
  const [draft, setDraftState] = useState<T>(options.saved);
  const [seen, setSeen] = useState<T>(options.saved);
  if (!options.same(seen, options.saved)) {
    setSeen(options.saved);
    if (options.same(seen, draft)) setDraftState(options.saved);
  }
  const [error, setError] = useState("");
  const current = useRef(options);
  current.current = options;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sent = useRef<{ value: T; promise: Promise<boolean> } | null>(null);
  const dirty = !options.same(options.saved, draft);

  const setDraft = useCallback((next: T) => {
    sent.current = null;
    draftRef.current = next;
    setError("");
    setDraftState(next);
  }, []);
  const commit = useCallback(
    async (override?: T): Promise<boolean> => {
      const o = current.current;
      const value = override === undefined ? draftRef.current : override;
      if (sent.current && o.same(sent.current.value, value))
        return sent.current.promise;
      if (o.same(o.saved, value)) return true;
      const problem = o.validate?.(value);
      if (problem) {
        setError(problem);
        return false;
      }
      setError("");
      const promise: Promise<boolean> = ctx
        .write({
          key: o.key,
          label: o.label,
          draft: o.show(value),
          run: o.send(value),
        })
        .then((result) => {
          if (result.ok) return true;
          if (sent.current?.promise === promise) sent.current = null;
          // A stale write is explained once by the page banner.
          if (result.status !== 409) setError(result.message);
          return false;
        });
      sent.current = { value, promise };
      return promise;
    },
    [ctx],
  );
  const dirtyNow = useCallback(() => {
    const o = current.current;
    if (sent.current && o.same(sent.current.value, draftRef.current))
      return false;
    return !o.same(o.saved, draftRef.current);
  }, []);
  useEffect(
    () =>
      ctx.register(options.key, { dirty: dirtyNow, commit: () => commit() }),
    [ctx, options.key, dirtyNow, commit],
  );
  useEffect(() => ctx.setDirty(options.key, dirty), [ctx, options.key, dirty]);
  /** Replace the draft with a value the server just confirmed. */
  const adopt = useCallback((value: T) => {
    sent.current = null;
    draftRef.current = value;
    setError("");
    setDraftState(value);
  }, []);
  return { draft, setDraft, dirty, error, commit, adopt, setError };
}

/** An open form that cannot be saved on leave (tables): navigation waits for it. */
export function useBlockingDraft(key: string, dirty: boolean) {
  const ctx = useEntryEditing();
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(
    () =>
      ctx.register(key, {
        dirty: () => ref.current,
        commit: async () => false,
      }),
    [ctx, key],
  );
  useEffect(() => ctx.setDirty(key, dirty), [ctx, key, dirty]);
}

export function SaveStatus({
  status,
}: {
  status: "saved" | "saving" | "unsaved";
}) {
  return (
    <span
      className={"save-status" + (status === "saved" ? "" : " pending")}
      role="status"
    >
      {status === "saved"
        ? "Saved"
        : status === "saving"
          ? "Saving…"
          : "Not saved"}
    </span>
  );
}

export function FieldError({ id, message }: { id: string; message: string }) {
  return message ? (
    <p id={id} role="alert" className="field-error">
      {message}
    </p>
  ) : null;
}

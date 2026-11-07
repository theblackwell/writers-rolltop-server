// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.ts";

// Writes for one fact, question or timeline event page. Like an entry page,
// every write goes through one queue so each request carries the newest
// updatedAt the server returned, and a stale write (409) keeps the form.

export type RecordDraft = {
  dirty: () => boolean;
  commit: () => Promise<boolean>;
};
/** What a record form needs from the page that hosts it. */
export type RecordHost = {
  /** The page is in shared-canon mode (never true for book records). */
  canon: boolean;
  busy: boolean;
  /** An unreloaded 409 holds the page; field saves wait for Reload or Discard. */
  held?: boolean;
  /** Sends the form's value. True means the server accepted it. */
  save: (value: object) => Promise<boolean>;
  register: (draft: RecordDraft) => () => void;
  setDirty: (dirty: boolean) => void;
  /** Throws away the form's changes (or leaves a new record's form). */
  discard: () => void;
  /** A new record's form reports whether its chosen scope is shared. */
  onShared?: (shared: boolean) => void;
};
export type WritableRecord = {
  id: string;
  scope: { kind: string; id: string };
  updatedAt: string;
  deletedAt?: string;
};
export type RecordWriteResult<R> =
  { ok: true; record: R } | { ok: false; message: string; status?: number };

export function useRecordWriter<R extends WritableRecord>({
  bookId,
  path,
  listKey,
  record,
  canon,
  onSaved,
}: {
  bookId: string;
  /** "facts", "questions" or "events". */
  path: string;
  listKey: string;
  record?: R;
  canon: boolean;
  onSaved: (record: R, created: boolean) => void;
}) {
  const latest = useRef(record?.updatedAt);
  const inflight = useRef(0);
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const draft = useRef<RecordDraft | null>(null);
  const props = useRef({ record, canon, onSaved });
  props.current = { record, canon, onSaved };
  const [pending, setPending] = useState(0);
  const [dirty, setDirtyState] = useState(false);
  const [conflict, setConflict] = useState<{
    message: string;
    reloaded: boolean;
  } | null>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [reloadError, setReloadError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (inflight.current === 0) latest.current = record?.updatedAt;
  }, [record?.updatedAt]);

  const write = useCallback(
    (value: object): Promise<RecordWriteResult<R>> => {
      inflight.current++;
      setPending((n) => n + 1);
      const job = tail.current.then(async (): Promise<RecordWriteResult<R>> => {
        try {
          const { record, canon } = props.current;
          const shared = !!record && record.scope.kind !== "book";
          const base = `/books/${bookId}/${path}`;
          const result = record
            ? await api<R>(`${base}/${record.id}`, "PUT", {
                ...value,
                expectedUpdatedAt: latest.current,
                ...(shared && canon ? { editSharedCanon: true } : {}),
              })
            : await api<R>(base, "POST", value);
          latest.current = result.updatedAt;
          props.current.onSaved(result, !record);
          setConflict(null);
          return { ok: true, record: result };
        } catch (e) {
          const status = e instanceof ApiError ? e.status : undefined;
          const message =
            e instanceof Error ? e.message : "Could not save this change.";
          if (status === 409) setConflict({ message, reloaded: false });
          return { ok: false, message, status };
        } finally {
          inflight.current--;
          setPending((n) => n - 1);
        }
      });
      tail.current = job;
      return job;
    },
    [bookId, path],
  );
  const save = useCallback(
    async (value: object) => {
      setError("");
      const result = await write(value);
      // A stale write is explained once by the page banner.
      if (!result.ok && result.status !== 409) setError(result.message);
      return result.ok;
    },
    [write],
  );
  const register = useCallback((next: RecordDraft) => {
    draft.current = next;
    return () => {
      if (draft.current === next) draft.current = null;
      setDirtyState(false);
    };
  }, []);

  /** Save an open draft. False means stay on this record. */
  const flush = useCallback(async () => {
    const blocked = () => conflictRef.current && !conflictRef.current.reloaded;
    if (blocked()) {
      setNote(
        "This record changed somewhere else. Reload it, then save or discard your changes.",
      );
      return false;
    }
    setNote("");
    let ok = true;
    if (draft.current?.dirty()) ok = await draft.current.commit();
    await tail.current;
    if (!ok)
      setNote(
        "Some changes are not saved. Fix or discard them, then try again.",
      );
    return ok;
  }, []);

  const reload = useCallback(async () => {
    setReloadError("");
    try {
      const id = props.current.record?.id;
      const all = await api<Record<string, R[]>>(`/books/${bookId}/${path}`);
      const next = all[listKey]?.find((r) => r.id === id);
      if (!next) throw new Error("This record is no longer available here.");
      await tail.current;
      latest.current = next.updatedAt;
      props.current.onSaved(next, false);
      const held = !!draft.current?.dirty();
      setConflict((c) => (held && c ? { ...c, reloaded: true } : null));
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : "Could not reload.");
    }
  }, [bookId, path, listKey]);
  // A reload can make a held draft equal to the server's copy.
  useEffect(() => {
    if (conflict?.reloaded && !dirty) setConflict(null);
  }, [conflict, dirty]);
  useEffect(() => {
    if (!dirty && !conflict) setNote("");
  }, [dirty, conflict]);
  const discard = useCallback(() => {
    setConflict(null);
    setNote("");
    setError("");
    setGeneration((g) => g + 1);
  }, []);

  const status: "saved" | "saving" | "unsaved" =
    pending > 0
      ? "saving"
      : dirty || conflict || note || error
        ? "unsaved"
        : "saved";
  useEffect(() => {
    if (status === "saved") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);
  return {
    write,
    save,
    register,
    setDirty: setDirtyState,
    flush,
    reload,
    discard,
    generation,
    status,
    conflict,
    note,
    error,
    setError,
    reloadError,
  };
}

/**
 * Tracks one record form. The form's value is compared with what it looked
 * like when it opened (or was last saved); leaving the record saves an
 * existing record's changes, but never creates a new record by accident.
 */
export function useFormDraft(
  host: RecordHost,
  payload: object,
  options: { canSave: boolean; isNew: boolean },
) {
  const json = JSON.stringify(payload);
  const [base, setBase] = useState(json);
  const dirty = json !== base;
  const current = useRef({ json, base, payload, ...options, host });
  current.current = { json, base, payload, ...options, host };
  const sending = useRef<{ json: string; job: Promise<boolean> } | null>(null);
  const submit = useCallback(async () => {
    const { payload, canSave, host } = current.current;
    if (!canSave) return false;
    const sent = JSON.stringify(payload);
    // A blur and an Enter for the same value send one request.
    if (sending.current?.json === sent) return sending.current.job;
    const job = (async () => {
      const ok = await host.save(payload);
      if (ok) {
        current.current.base = sent;
        setBase(sent);
      }
      return ok;
    })();
    const mine = { json: sent, job };
    sending.current = mine;
    try {
      return await job;
    } finally {
      if (sending.current === mine) sending.current = null;
    }
  }, []);
  // Save on leave: a field asks for a save when it loses focus, on Enter, or
  // when a choice changes. The ask is served after the render that holds the
  // new value. A new record is only created by its Create button.
  const [asked, setAsked] = useState(0);
  const autosave = useCallback(() => {
    if (!current.current.isNew) setAsked((n) => n + 1);
  }, []);
  useEffect(() => {
    const c = current.current;
    if (asked && !c.isNew && c.json !== c.base && !c.host.held && !c.host.busy)
      void submit();
  }, [asked, submit]);
  const { register, setDirty } = host;
  useEffect(
    () =>
      register({
        dirty: () => current.current.json !== current.current.base,
        commit: () =>
          current.current.isNew ? Promise.resolve(false) : submit(),
      }),
    [register, submit],
  );
  useEffect(() => setDirty(dirty), [setDirty, dirty]);
  return { dirty, submit, autosave };
}

// Calls to the sync routes (protocol v1). Same origin: the browser sends the session cookie by itself, and nothing here
// reads or stores it. Every function returns a plain result for the cases the protocol names, and throws only for
// "no answer" (NetworkError) and "not signed in" (SessionError).
import type { SyncChange } from "./model.ts";

export class NetworkError extends Error {}
export class SessionError extends Error {}

export interface OpResult {
  opId: string; status: "applied" | "conflict" | "rejected" | "duplicate";
  seq?: number; revision?: number; conflictId?: string; code?: string; message?: string; firstStatus?: string;
  current?: { seq: number; revision?: number };
}
export interface Conflict {
  conflictId: string; kind: "field" | "tombstone" | "document"; recordKind: string; recordId: string; field?: string;
  losing: { opId: string; deviceId: string; change: string; baseRevision?: number; value?: unknown };
  current: { seq: number; revision?: number };
}
export type Resync = { kind: "resync"; epoch: string; head: number };
export type Op = Record<string, unknown> & { opId: string; op: string };

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new NetworkError("Cannot reach the server.");
  }
  if (res.status === 401) throw new SessionError("Not signed in.");
  return res;
}

async function resyncOf(res: Response): Promise<Resync | undefined> {
  if (res.status !== 409) return undefined;
  try {
    const j = (await res.json()) as { error?: { code?: string }; epoch?: unknown; head?: unknown };
    if (j.error?.code === "RESYNC_REQUIRED" && typeof j.epoch === "string" && typeof j.head === "number") return { kind: "resync", epoch: j.epoch, head: j.head };
  } catch { /* fall through */ }
  return undefined;
}

export type ChangesAnswer = { kind: "ok"; epoch: string; head: number; changes: SyncChange[]; next: number } | Resync;

export async function getChanges(epoch: string, after: number, signal?: AbortSignal): Promise<ChangesAnswer> {
  const res = await send(`/api/sync/v1/changes?epoch=${encodeURIComponent(epoch)}&after=${after}&limit=200`, signal ? { signal } : {});
  if (res.ok) {
    const j = (await res.json()) as { epoch: string; head: number; changes: SyncChange[]; next: number };
    return { kind: "ok", epoch: j.epoch, head: j.head, changes: j.changes, next: j.next };
  }
  const r = await resyncOf(res);
  if (r) return r;
  throw new NetworkError(`The server answered ${res.status}.`);
}

export async function getConflicts(epoch: string, signal?: AbortSignal): Promise<{ kind: "ok"; conflicts: Conflict[] } | Resync> {
  const res = await send(`/api/sync/v1/conflicts?epoch=${encodeURIComponent(epoch)}`, signal ? { signal } : {});
  if (res.ok) return { kind: "ok", conflicts: ((await res.json()) as { conflicts: Conflict[] }).conflicts };
  const r = await resyncOf(res);
  if (r) return r;
  throw new NetworkError(`The server answered ${res.status}.`);
}

export type PushAnswer =
  | { kind: "ok"; epoch: string; head: number; results: OpResult[] }
  | { kind: "invalid" } | { kind: "too-large" } | Resync;

/** A keepalive request may carry 64 KiB. The size is counted in bytes of the body as sent, with room to spare. */
export const KEEPALIVE_LIMIT_BYTES = 60_000;
export function fitsKeepalive(epoch: string, deviceId: string, ops: Op[]): boolean {
  return new TextEncoder().encode(JSON.stringify({ epoch, deviceId, ops })).length <= KEEPALIVE_LIMIT_BYTES;
}

export async function pushOps(epoch: string, deviceId: string, ops: Op[], keepalive = false): Promise<PushAnswer> {
  const res = await send("/api/sync/v1/push", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ epoch, deviceId, ops }), ...(keepalive ? { keepalive: true } : {}),
  });
  if (res.ok) {
    const j = (await res.json()) as { epoch: string; head: number; results: OpResult[] };
    return { kind: "ok", epoch: j.epoch, head: j.head, results: j.results };
  }
  const r = await resyncOf(res);
  if (r) return r;
  if (res.status === 400) return { kind: "invalid" };
  if (res.status === 413) return { kind: "too-large" };
  throw new NetworkError(`The server answered ${res.status}.`);
}

/**
 * Whether the server holds a library at all, asked of GET /api/export (404 means none). Only the answer's status is
 * read: the body is cancelled at once. Used only when the change feed shows no library, to tell a new empty server from
 * an imported library, whose records are not in the feed.
 */
export async function libraryExists(): Promise<"yes" | "no" | "unknown"> {
  const ctl = new AbortController();
  try {
    const res = await send("/api/export", { signal: ctl.signal });
    if (res.status === 404) return "no";
    if (res.ok) return "yes";
    return "unknown";
  } catch (e) {
    if (e instanceof SessionError) throw e;
    return "unknown";
  } finally {
    ctl.abort();
  }
}

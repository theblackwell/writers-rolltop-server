// What stays on this device: the device id (localStorage, one per browser profile, not a secret) and, per library, an
// IndexedDB database with two stores:
//   held      one entry per scene: the author's newest text that the server has not yet confirmed (key: sceneId)
//   recovery  one entry per copy waiting for the author's decision (key: [sceneId, conflictId])
// The database is named after the library id, so one library's copies never mix with another's.
import { newId } from "../editor/rolltop-editor.ts";
import type { CanonicalDocument } from "@writers-rolltop/document-adapter";

const DEVICE_KEY = "rolltop.deviceId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let memoryId: string | undefined;

/** The device id, made on first use (a push). Fresh when missing or not a uuid. */
export function getDeviceId(): string {
  if (memoryId) return memoryId;
  try {
    const have = localStorage.getItem(DEVICE_KEY);
    if (have && UUID.test(have)) return (memoryId = have);
    const id = newId();
    localStorage.setItem(DEVICE_KEY, id);
    return (memoryId = id);
  } catch {
    return (memoryId = newId()); // storage blocked: an id for this page only
  }
}

export interface Held {
  sceneId: string;
  doc: CanonicalDocument;
  baseRevision: number;
  /** Set when the text has been sent: a retry after a lost answer uses the same op id (protocol rule 4). */
  opId?: string;
  /** "draft": not sent. "sent": sent, no answer seen. "review": the server refused it, or it cannot be sent as it is. */
  status: "draft" | "sent" | "review";
  reason?: string;
  savedAt: string;
}

/**
 * The op ids of one choice, kept with the item so a retry after a lost answer repeats the same ops. Slots:
 * 0 create the copy, 1 the copy's document, 2 the scene's document, 3 resolve. `sceneBase` is the revision the scene's
 * document op was made against: the same op id is only reused for the same content. `savedRev` is the revision of the saved text a "both" copy was made from.
 */
export interface Attempt { choice: "mine" | "saved" | "both" | "copy"; opIds: string[]; copyId?: string; sceneBase?: number; savedRev?: number }

export interface RecoveryItem {
  sceneId: string;
  /** The server's conflict id, or "held:<opId>" for a copy the server refused or never saw. */
  conflictId: string;
  /** conflict: another device saved first. refused: the server refused the text. history: the library was replaced. unsent: typed here and not sent when another copy arrived. */
  source: "conflict" | "refused" | "history" | "unsent";
  reason?: string;
  sceneTitle: string;
  /** This device's text. */
  mine: CanonicalDocument;
  /** The saved text, as the server had it when the item was made; null if the scene no longer exists. */
  theirs: CanonicalDocument | null;
  createdAt: string;
  attempt?: Attempt;
}

export interface LibraryDb {
  allHeld(): Promise<Held[]>;
  putHeld(h: Held): Promise<void>;
  deleteHeld(sceneId: string): Promise<void>;
  allRecovery(): Promise<RecoveryItem[]>;
  putRecovery(r: RecoveryItem): Promise<void>;
  deleteRecovery(sceneId: string, conflictId: string): Promise<void>;
  close(): void;
}

const wrap = <T,>(r: IDBRequest<T>): Promise<T> => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (t: IDBTransaction): Promise<void> => new Promise((ok, no) => { t.oncomplete = () => ok(); t.onerror = () => no(t.error); t.onabort = () => no(t.error); });

export const dbName = (libraryId: string): string => `rolltop-library-${libraryId}`;

export async function openLibraryDb(libraryId: string): Promise<LibraryDb> {
  const req = indexedDB.open(dbName(libraryId), 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("held", { keyPath: "sceneId" });
    db.createObjectStore("recovery", { keyPath: ["sceneId", "conflictId"] });
  };
  const db = await wrap(req);
  const run = async (store: string, f: (s: IDBObjectStore) => IDBRequest | void): Promise<void> => {
    const t = db.transaction(store, "readwrite");
    f(t.objectStore(store));
    await done(t);
  };
  const all = async <T,>(store: string): Promise<T[]> => wrap(db.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>);
  return {
    allHeld: () => all<Held>("held"),
    putHeld: (h) => run("held", (s) => s.put(h)),
    deleteHeld: (id) => run("held", (s) => s.delete(id)),
    allRecovery: () => all<RecoveryItem>("recovery"),
    putRecovery: (r) => run("recovery", (s) => s.put(r)),
    deleteRecovery: (sceneId, conflictId) => run("recovery", (s) => s.delete([sceneId, conflictId])),
    close: () => db.close(),
  };
}

// The sync client (sync-protocol-v1.md, "Client rules"). It keeps the epoch and the cursor, pulls the change feed into
// the local model, pushes scene documents with a baseRevision, and keeps every text it has not seen the server accept:
//   - the newest unconfirmed text of a scene is held in IndexedDB before it is sent (store "held");
//   - a copy waiting for the author's decision is kept in IndexedDB (store "recovery") before anything is resolved.
// A 409 for a base problem, a refused op or a changed epoch never re-sends the text by itself: it goes to the author.
import { newId } from "../editor/rolltop-editor.ts";
import type { CanonicalDocument } from "@writers-rolltop/document-adapter";
import { SessionError, fitsKeepalive, getChanges, getConflicts, libraryExists, pushOps } from "./http.ts";
import type { ChangesAnswer } from "./http.ts";
import type { Conflict, Op, OpResult, PushAnswer } from "./http.ts";
import { applyChange, emptyModel, fieldBase, hasAnyRecord, sceneDocument, sceneIsLive } from "./model.ts";
import type { Model, Rec } from "./model.ts";
import { DB_BLOCKED_MESSAGE, DB_WAIT_MS, DbBlockedError, getDeviceId, openLibraryDb } from "./local.ts";
import type { Attempt, FieldDraft, Held, LibraryDb, RecoveryItem } from "./local.ts";
import { bibleReady, checkEntryField, checkEventField, checkRecordField, checkStateChangeField, newEntryValue, newEventValue, newFactValue, movedStateChangeValue, newQuestionValue, newStateChangeValue, seedOps } from "./bible.ts";
import type { EntryType, Input, RecordKind, Target } from "./bible.ts";

export type Phase = "loading" | "ready" | "empty" | "no-baseline" | "unreachable";
export type SceneStatus = "idle" | "saving" | "saved" | "unsaved" | "review";
export type RecoveryChoice = "mine" | "saved" | "both" | "copy";

export interface ClientState {
  phase: Phase;
  message: string | undefined;
  libraryId: string | undefined;
  /** Bumped on every change to the model, so views know to read it again. */
  version: number;
  recovery: readonly RecoveryItem[];
  status: ReadonlyMap<string, SceneStatus>;
  /** Open conflicts of kinds other than a scene document. The browser cannot settle those yet. */
  otherConflicts: number;
  /** False if this browser cannot keep a copy on the device (IndexedDB blocked). */
  keepsCopies: boolean;
  /** Why this device cannot keep copies, when the reason is something the author can fix (a second tab holds the database). */
  storageMessage: string | undefined;
  /** The history the studio is reading. A change of it means the server's library was restored or replaced. */
  epoch: string | undefined;
  /** Whether the built-in templates are in the library. They are made when the story bible is first opened. */
  bible: "idle" | "setting-up" | "ready" | "failed";
  bibleMessage: string | undefined;
  /** The save state of each bible field the author has edited, by "<entryId>/<field>". */
  fields: ReadonlyMap<string, FieldStatus>;
}

export interface FieldStatus { state: "saving" | "saved" | "unsaved" | "refused" | "conflict" | "invalid"; message?: string }
export type FieldOutcome = { kind: "saved" | "nothing" | "unsaved" | "invalid" | "refused" | "conflict"; message?: string };
/** `lost`: the server may have applied the create and its answer was lost (offline): a retry must use the same op id. */
export type CreateOutcome = { ok: true; id: string } | { ok: false; message: string; lost?: boolean; definitive?: boolean };
/** What one open bible field holds, read when the epoch changes or the session ends. Undefined when the field has nothing unsent. */
export type FieldSnapshot = { entryId: string; field: string; input: unknown; base: number } | undefined;
export const HISTORY_REASON = "The server's library was restored or replaced.";
export const RETRY_MESSAGE = "The server did not have the version it was expecting. Try again.";
export const HISTORY_MESSAGE = "The server's library changed while you were typing. Your text is kept on this device. Choose which text to keep.";

export type SaveOutcome = { kind: "saved"; revision: number } | { kind: "unsaved" } | { kind: "recovery" } | { kind: "nothing" };
export type ResolveOutcome = { ok: true } | { ok: false; message: string };
/** A move: `lost` is a create whose answer never came (retry with the same ids); `created` is a create that was applied (retry removes only the old record). */
export type MoveOutcome = { ok: true } | { ok: false; message: string; lost?: boolean; created?: boolean; clear?: boolean };
/** What the studio tells the author when the session ends: whether text that was not saved is kept on this device. */
export interface SessionEndInfo { kept: boolean; lost: boolean }
/** Holds the dirty text of one open scene on this device (without sending it). Resolves true if there was some. */
export type Keeper = () => Promise<boolean>;

const MESSAGES: Record<string, string> = {
  RECORD_UNKNOWN: "This scene is not in the library any more.",
  RECORD_DELETED: "This scene is in the trash.",
  DOCUMENT_INVALID: "The server could not accept this text as it is.",
  INVALID_VALUE: "The server could not accept this text as it is.",
  INTEGRITY_VIOLATION: "The server could not accept this change.",
  REFERENCE_UNRESOLVED: "The server could not accept this change.",
  RECORD_EXISTS: "The server already has this record.",
};
const why = (code: string | undefined): string => MESSAGES[code ?? ""] ?? "The server refused this text.";

const stamp = (): string => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export function sameDoc(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameDoc((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const docOp = (opId: string, sceneId: string, baseRevision: number, doc: CanonicalDocument): Op =>
  ({ opId, op: "document", recordKind: "document", recordId: sceneId, baseRevision, value: { ...doc, nodeId: sceneId } });

/** The calls the client makes to the outside. Tests pass stubs; the studio uses the real ones. */
export interface ClientIo {
  getChanges: (epoch: string, after: number) => Promise<ChangesAnswer>;
  getConflicts: typeof getConflicts;
  pushOps: typeof pushOps;
  libraryExists: typeof libraryExists;
  openLibraryDb: (libraryId: string) => Promise<LibraryDb>;
}

export class SyncClient {
  readonly model: Model = emptyModel();
  onSessionEnded: ((info: SessionEndInfo) => void) | undefined;

  private epoch = newId(); // a guess: the first answer is a 409 that names the real one
  private epochKnown = false;
  private epochGen = 0; // counts the epoch changes seen
  private epochRouted = 0; // the last one whose held texts were sent to the author
  private routing = false;
  private routingRun: Promise<void> | undefined; // the routing in progress, so a save can wait for it
  private db: LibraryDb | undefined;
  private holding: Array<{ sceneId: string; mine: CanonicalDocument }> = []; // holdForAuthor calls in progress
  private held = new Map<string, Held>();
  private bases = new Map<string, number>();
  private keepers = new Map<string, Keeper>();
  private fieldKeepers = new Map<string, () => FieldSnapshot>(); // mounted bible fields, by "<entryId>/<field>"
  private dbWaitMs = DB_WAIT_MS;
  // Saves of one bible field run one after another, each with the newest input (see saveEntryField).
  private fieldChains = new Map<string, Promise<unknown>>();
  private fieldLatest = new Map<string, { entryId: string; field: string; value: unknown; input: unknown; base: number; gen: number }>();
  private fieldPending = new Map<string, number>();
  private fieldOwnSeq = new Map<string, number>();
  private epochHolds: Promise<unknown>[] = [];
  private active = false;
  private chains = new Map<string, Promise<unknown>>();
  private pulling: Promise<void> | undefined;
  private pullNext: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private runId = 0;
  private state: ClientState = {
    phase: "loading", message: undefined, libraryId: undefined, version: 0, recovery: [], status: new Map(), otherConflicts: 0, keepsCopies: true, storageMessage: undefined, epoch: undefined,
    bible: "idle", bibleMessage: undefined, fields: new Map(),
  };
  private drafts = new Map<string, FieldDraft>();
  private seeding: Promise<void> | undefined;

  private readonly pollMs: number;
  private readonly io: ClientIo;
  constructor(pollMs = 20_000, io: Partial<ClientIo> = {}) {
    this.pollMs = pollMs;
    this.io = { getChanges: (e, a) => getChanges(e, a), getConflicts, pushOps, libraryExists, openLibraryDb, ...io };
  }

  // ----- subscription (useSyncExternalStore) -----
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getState = (): ClientState => this.state;
  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }
  private setStatus(sceneId: string, s: SceneStatus): void {
    const status = new Map(this.state.status);
    status.set(sceneId, s);
    this.set({ status });
  }

  // ----- start and stop -----
  async start(): Promise<void> {
    const run = ++this.runId;
    this.active = true;
    this.set({ phase: "loading", message: undefined });
    try {
      await this.pull();
      if (run !== this.runId) return; // stopped, or started again
      if (this.model.sawLibraryCreate) {
        await this.becomeReady(run);
      } else {
        // The feed shows no library. Either the server is new and empty, or the library was imported (an import writes
        // the baseline feed, so the feed would show it; a feed that is empty for another reason is not shown as an empty manuscript). Ask the export route which one it is.
        const has = await this.io.libraryExists();
        if (run !== this.runId) return;
        if (has === "unknown") {
          this.set({ phase: "unreachable", message: "The studio could not check what the server holds. Try again." });
        } else if (has === "no" && !hasAnyRecord(this.model)) {
          this.set({ phase: "empty" });
        } else {
          this.set({ phase: "no-baseline" });
        }
      }
    } catch (e) {
      if (run !== this.runId) return;
      if (e instanceof SessionError) { await this.endSession(); return; }
      this.set({ phase: "unreachable", message: "Cannot reach the server. Check that it is running, then try again." });
    }
  }

  stop(): void {
    this.active = false;
    this.runId++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.db?.close();
    this.db = undefined;
  }

  /** Every await is followed by a check of the run id: a client that was stopped must not open a database or start a timer. */
  private async becomeReady(run: number): Promise<void> {
    const library = this.model.records.get("library")?.values().next().value as Rec | undefined;
    const libraryId = library?.id ?? "unknown";
    await this.openDb(libraryId, run);
    if (run !== this.runId) return;
    this.set({ phase: "ready", libraryId });
    await this.refreshConflicts().catch(() => {});
    if (run !== this.runId) return;
    if (this.pollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { if (document.visibilityState === "visible") void this.refresh(); }, this.pollMs);
    }
  }

  private async openDb(libraryId: string, run = this.runId): Promise<void> {
    if (run !== this.runId) return; // stopped: no database is opened
    this.db?.close();
    this.db = undefined;
    let db: LibraryDb | undefined;
    try {
      db = await this.openWithin(libraryId);
      if (run !== this.runId) { db.close(); return; } // stopped while the database was opening
      this.db = db;
      const held = await db.allHeld();
      const stored = await db.allRecovery();
      const drafts = await db.allDrafts();
      if (run !== this.runId) return;
      for (const d of drafts) if (!this.drafts.has(d.key)) this.drafts.set(d.key, d);
      for (const h of held) if (!this.held.has(h.sceneId)) this.held.set(h.sceneId, h);
      for (const h of held) if (h.status === "review") this.bases.set(h.sceneId, h.baseRevision);
      const keys = new Set(this.state.recovery.map((r) => `${r.sceneId}/${r.conflictId}`));
      this.set({ recovery: [...this.state.recovery, ...stored.filter((r) => !keys.has(`${r.sceneId}/${r.conflictId}`))], keepsCopies: true, storageMessage: undefined });
    } catch (e) {
      if (run === this.runId) this.set({ keepsCopies: false, storageMessage: e instanceof DbBlockedError ? DB_BLOCKED_MESSAGE : undefined });
    }
  }

  /** Opens the database, but never waits for it for long: a database that opens late is closed and the studio goes on without it. */
  private openWithin(libraryId: string): Promise<LibraryDb> {
    return new Promise<LibraryDb>((ok, no) => {
      let late = false;
      const timer = setTimeout(() => { late = true; no(new DbBlockedError("The database did not open in time.")); }, this.dbWaitMs);
      this.io.openLibraryDb(libraryId).then(
        (db) => { clearTimeout(timer); if (late) db.close(); else ok(db); },
        (e) => { clearTimeout(timer); if (!late) no(e); },
      );
    });
  }

  // ----- pulling the feed -----
  /**
   * Pulls until the cursor reaches head. A different epoch rebuilds the model from seq 0 (client rule 2). A pull asked
   * for while one is running is not dropped: it runs after it, because the one running may have been answered before
   * the change that made the caller ask (a save).
   */
  pull(): Promise<void> {
    if (!this.pulling) return this.startPull();
    // Another pull may have started between the end of the one running and this callback: then this one waits for it too.
    this.pullNext ??= this.pulling.catch(() => {}).then(() => { this.pullNext = undefined; return this.pulling ? this.pull() : this.startPull(); });
    return this.pullNext;
  }

  private startPull(): Promise<void> {
    const p: Promise<void> = this.pullLoop().finally(() => { if (this.pulling === p) this.pulling = undefined; });
    this.pulling = p;
    // What follows a changed epoch runs outside the pull, so it can pull again without waiting for itself.
    return p.then(() => this.routeEpochChange());
  }

  /** True from the moment the epoch changes until the held texts are with the author. No push is made meanwhile. */
  private get epochPending(): boolean { return this.epochGen !== this.epochRouted; }

  private routeEpochChange(): Promise<void> {
    if (this.routing) return Promise.resolve();
    this.routing = true;
    const run = this.runId; // a client that is stopped meanwhile opens nothing
    const p = (async () => {
      try {
        while (this.epochPending) {
          if (run !== this.runId) return;
          const gen = this.epochGen;
          await this.afterEpochChange(run);
          if (run !== this.runId) return;
          this.epochRouted = gen;
        }
      } finally {
        this.routing = false; this.routingRun = undefined;
        // A stop and start during the routing: this run returned early, and the new run's call found routing set. Route again for it.
        if (this.epochPending && run !== this.runId && this.active) void this.routeEpochChange();
      }
    })();
    if (this.routing) this.routingRun = p;
    return p;
  }

  private async pullLoop(): Promise<void> {
    for (let round = 0; round < 10_000; round++) {
      const a = await this.io.getChanges(this.epoch, this.model.cursor);
      if (a.kind === "resync") { this.adoptEpoch(a.epoch); continue; }
      for (const c of a.changes) applyChange(this.model, c);
      if (a.changes.length === 0 || a.next >= a.head) break;
    }
    this.set({});
  }

  private adoptEpoch(epoch: string): void {
    const wasKnown = this.epochKnown;
    const sameEpoch = epoch === this.epoch;
    if (wasKnown && !sameEpoch) {
      // Client rule 2: the text on screen was made against the old history. Every open editor puts its unsaved text into
      // held now (the calls start at once, while the old bases are still known), and the old bases are forgotten.
      this.epochGen++;
      this.epochHolds.push(this.holdOpenText("history"));
      this.bases.clear();
      this.fieldOwnSeq.clear();
    }
    this.epoch = epoch;
    this.epochKnown = true;
    Object.assign(this.model, emptyModel());
    // The templates and entries are read again from the new history, so the story bible is set up again if it lacks them.
    if (wasKnown && !sameEpoch) this.set({ epoch, bible: "idle", bibleMessage: undefined });
    else if (!sameEpoch) this.set({ epoch });
  }

  /** The server's library was restored or replaced. Texts that were never confirmed go to the author; none is re-sent. */
  private async afterEpochChange(run: number): Promise<void> {
    await Promise.all(this.epochHolds.splice(0)); // the text on screen is in held before anything is routed
    if (run !== this.runId) return;
    const library = this.model.records.get("library")?.values().next().value as Rec | undefined;
    if (library && library.id !== this.state.libraryId) await this.openDb(library.id, run);
    // The network call comes first: nothing may be awaited between the last empty scan below and epochRouted being set.
    await this.refreshConflicts().catch(() => {});
    if (run !== this.runId) return;
    // A save that ran while this was awaiting has put a new entry into held: look again until nothing new is there.
    const seen = new Set<Held>();
    for (;;) {
      if (run !== this.runId) return;
      const next = [...this.held.values()].filter((h) => !seen.has(h));
      if (next.length === 0) break;
      for (const h of next) {
        seen.add(h);
        await this.sendToAuthor(h, "history", "The server's library was restored or replaced, so this text was not sent.");
      }
    }
  }

  async refresh(): Promise<void> {
    if (this.state.phase !== "ready") return;
    try { await this.pull(); await this.refreshConflicts(); } catch (e) { if (e instanceof SessionError) await this.endSession(); }
  }

  /** Lists open conflicts. A scene-document conflict not yet on this device is kept here before it is shown. */
  private async refreshConflicts(): Promise<void> {
    const a = await this.io.getConflicts(this.epoch);
    if (a.kind === "resync") { await this.pull(); return; }
    let other = 0;
    for (const c of a.conflicts) {
      if (c.kind !== "document" || c.losing.value === undefined) { other++; continue; }
      if (this.state.recovery.some((r) => r.conflictId === c.conflictId)) continue;
      await this.addRecovery(this.itemFor(c.recordId, c.conflictId, "conflict", c.losing.value as CanonicalDocument));
    }
    if (other !== this.state.otherConflicts) this.set({ otherConflicts: other });
  }

  // ----- local copies -----
  itemFor(sceneId: string, conflictId: string, source: RecoveryItem["source"], mine: CanonicalDocument, reason?: string): RecoveryItem {
    const node = this.model.records.get("manuscriptNode")?.get(sceneId);
    const live = sceneIsLive(this.model, sceneId) && this.model.docs.has(sceneId);
    return {
      sceneId, conflictId, source, sceneTitle: typeof node?.title === "string" ? node.title : "Untitled scene", mine,
      theirs: live ? (this.model.docs.get(sceneId)!.doc as CanonicalDocument) : null, createdAt: stamp(), ...(reason ? { reason } : {}),
    };
  }

  /** Stores the item on this device first, then shows it. */
  async addRecovery(item: RecoveryItem): Promise<void> {
    if (this.state.recovery.some((r) => r.sceneId === item.sceneId && r.conflictId === item.conflictId)) return;
    try { await this.db?.putRecovery(item); } catch { this.set({ keepsCopies: false }); }
    this.set({ recovery: [...this.state.recovery, item] });
    this.setStatus(item.sceneId, "review");
  }

  /**
   * Text typed on this device and not saved, put aside as its own recovery item before another copy of the scene is
   * shown in its place. It is on this device first, and shown in the panel with the other copy.
   */
  async holdForAuthor(sceneId: string, doc: CanonicalDocument, source: "unsent" | "refused", reason: string): Promise<void> {
    // Overlapping calls for the same text (a cancelled run and its successor) add one item, not two.
    const has = (r: { sceneId: string; mine: CanonicalDocument }) => r.sceneId === sceneId && sameDoc(r.mine, doc);
    if (this.state.recovery.some(has) || this.holding.some(has)) return;
    const mine = { sceneId, mine: doc };
    this.holding.push(mine);
    try { await this.addRecovery(this.itemFor(sceneId, `held:${newId()}`, source, doc, reason)); }
    finally { this.holding = this.holding.filter((x) => x !== mine); }
    const h = this.held.get(sceneId);
    if (h && sameDoc(h.doc, doc)) await this.dropHeld(sceneId, h.opId); // it moved into recovery: it is not held twice
  }

  private async removeRecovery(item: RecoveryItem): Promise<void> {
    await this.db?.deleteRecovery(item.sceneId, item.conflictId);
    this.set({ recovery: this.state.recovery.filter((r) => !(r.sceneId === item.sceneId && r.conflictId === item.conflictId)) });
    if (!this.state.recovery.some((r) => r.sceneId === item.sceneId)) this.setStatus(item.sceneId, "idle");
  }

  private async putHeld(h: Held): Promise<void> {
    this.held.set(h.sceneId, h);
    try { await this.db?.putHeld(h); } catch { this.set({ keepsCopies: false }); }
  }

  private async dropHeld(sceneId: string, opId?: string): Promise<void> {
    const h = this.held.get(sceneId);
    if (!h || (opId !== undefined && h.opId !== opId)) return; // newer text is waiting: keep it
    this.held.delete(sceneId);
    try { await this.db?.deleteHeld(sceneId); } catch { /* a stale entry is retried or reviewed later */ }
  }

  /** The unconfirmed text of a scene, if this device has some (from this session or an earlier one). */
  heldFor(sceneId: string): Held | undefined { return this.held.get(sceneId); }
  recoveryFor(sceneId: string): RecoveryItem | undefined { return this.state.recovery.find((r) => r.sceneId === sceneId); }

  /** An open editor tells the client how to put its unsaved text into held. */
  registerKeeper(sceneId: string, keep: Keeper | undefined): void {
    if (keep) this.keepers.set(sceneId, keep); else this.keepers.delete(sceneId);
  }

  /** A mounted bible field tells the client how to read its unsent input. Mounted fields are held like open editors. */
  registerFieldKeeper(key: string, read: (() => FieldSnapshot) | undefined): void {
    if (read) this.fieldKeepers.set(key, read); else this.fieldKeepers.delete(key);
  }

  /**
   * Every open editor and every open bible field holds its unsaved text on this device. Returns how many had some.
   * The calls start at once: they read what is on screen before anything else changes. A field's text is held as
   * "unsent" when the session ends, and as "conflict" when the history changed (its base belongs to the old history, so
   * it is never sent as it is: the author chooses).
   */
  private async holdOpenText(why: "session" | "history" = "session"): Promise<number> {
    const done = [...this.keepers.values()].map((keep) => keep().catch(() => false));
    for (const read of this.fieldKeepers.values()) {
      const snap = read();
      if (!snap) continue;
      const key = `${snap.entryId}/${snap.field}`;
      const history = why === "history";
      done.push(this.putDraft({
        key, entryId: snap.entryId, field: snap.field, input: snap.input, base: snap.base, state: history ? "conflict" : "unsent", epoch: this.epoch, // read now: still the old history's epoch
        ...(history ? { reason: HISTORY_REASON } : {}), savedAt: stamp(),
      }).then(() => { if (history) this.setField(key, { state: "conflict", message: HISTORY_MESSAGE }); return true; }, () => false));
    }
    return (await Promise.all(done)).filter(Boolean).length;
  }

  /** Whether any text typed into this entry is kept on this device and not yet in the library. */
  hasDraftsFor(entryId: string): boolean {
    for (const d of this.drafts.values()) if (d.entryId === entryId) return true;
    return false;
  }

  /** The session ended: unsaved text goes into held first, then the studio is told what is kept. */
  private async endSession(): Promise<void> {
    const dirty = await this.holdOpenText();
    // "Kept" means written to the database. An entry that exists only in memory is lost when the page goes.
    const writes = this.state.keepsCopies && this.db !== undefined;
    const have = dirty > 0 || this.held.size + this.state.recovery.length > 0;
    const lost = have && !writes;
    const kept = have && writes;
    this.onSessionEnded?.({ kept, lost });
  }

  /** The editor tells the client which revision the text on screen was made from. */
  setBase(sceneId: string, revision: number): void { this.bases.set(sceneId, revision); }
  baseOf(sceneId: string): number { return this.bases.get(sceneId) ?? sceneDocument(this.model, sceneId).revision; }

  /** Keeps the author's newest text on this device without sending it (local safety net while typing). */
  async keepDraft(sceneId: string, doc: CanonicalDocument): Promise<void> {
    const have = this.held.get(sceneId);
    if (have?.status === "review" || (have && sameDoc(have.doc, doc))) return;
    await this.putHeld({ sceneId, doc, baseRevision: this.baseOf(sceneId), status: "draft", savedAt: stamp() });
  }

  // ----- saving a scene -----
  private enqueue<T>(sceneId: string, job: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(sceneId) ?? Promise.resolve()).then(job, job);
    this.chains.set(sceneId, run.catch(() => {}));
    return run;
  }

  /** One document op per node per push, one push at a time per scene (client rule 1). */
  saveScene(sceneId: string, doc: CanonicalDocument): Promise<SaveOutcome> {
    const epoch = this.epoch; // the text is made under this history, whenever the save runs
    const gen = this.epochGen;
    return this.enqueue(sceneId, () => this.doSave(sceneId, doc, epoch, gen));
  }

  private async doSave(sceneId: string, doc: CanonicalDocument, epoch: string, gen = this.epochGen): Promise<SaveOutcome> {
    if (this.state.phase !== "ready" || !this.active) return { kind: "unsaved" };
    const have = this.held.get(sceneId);
    if (have?.status === "review" || this.recoveryFor(sceneId)) return { kind: "recovery" };
    if (gen !== this.epochGen) {
      // The history changed after this text was handed over: it is stale, and goes to the author, never to the server.
      await this.sendToAuthor({ sceneId, doc, baseRevision: this.baseOf(sceneId), opId: newId(), status: "sent", savedAt: stamp() }, "unsent", "The server's library was restored or replaced after this text was typed, so it was not sent.");
      return { kind: "recovery" };
    }
    const baseRevision = this.baseOf(sceneId);
    const server = sceneDocument(this.model, sceneId);
    if (!have && baseRevision === server.revision && sameDoc(server.doc, doc)) { this.setStatus(sceneId, "saved"); return { kind: "nothing" }; }
    const same = have?.status === "sent" && have.opId && have.baseRevision === baseRevision && sameDoc(have.doc, doc);
    const opId = same ? have.opId! : newId();
    const held: Held = { sceneId, doc, baseRevision, opId, status: "sent", savedAt: stamp() };
    await this.putHeld(held); // on this device first
    if (this.epochPending) {
      // The library's history just changed: afterEpochChange sends every held text to the author. Wait for it, then look
      // at this entry again: it was put into held after, or while, the routing took its list.
      if (this.routingRun) await this.routingRun.catch(() => {});
      if (this.epochPending) {
        this.setStatus(sceneId, "unsaved"); // routing has not run yet; it will find this entry
        return { kind: "unsaved" };
      }
      const now = this.held.get(sceneId);
      if (!now) return { kind: "recovery" }; // routed to the author
      if (now.opId !== opId) { this.setStatus(sceneId, "unsaved"); return { kind: "unsaved" }; } // newer text waits
    }
    if (epoch !== this.epoch) {
      // A push carries the epoch its text was made under. This one was made under an older history: it is not sent.
      await this.sendToAuthor(held, "unsent", "The server's library was restored or replaced after this text was typed, so it was not sent.");
      return { kind: "recovery" };
    }
    this.setStatus(sceneId, "saving");
    let ans: PushAnswer;
    try {
      ans = await this.io.pushOps(epoch, getDeviceId(), [docOp(opId, sceneId, baseRevision, doc)]);
    } catch (e) {
      if (e instanceof SessionError) await this.endSession();
      this.setStatus(sceneId, "unsaved");
      return { kind: "unsaved" };
    }
    return this.afterDocPush(held, ans);
  }

  private async afterDocPush(held: Held, ans: PushAnswer): Promise<SaveOutcome> {
    const { sceneId } = held;
    switch (ans.kind) {
      case "ok": {
        const r = ans.results[0]!;
        const first = r.status === "duplicate" ? r.firstStatus : r.status;
        if (first === "applied") {
          const revision = r.revision ?? held.baseRevision + 1;
          this.model.docs.set(sceneId, { revision, seq: r.seq ?? 0, doc: held.doc });
          if (this.bases.get(sceneId) === held.baseRevision) this.bases.set(sceneId, revision);
          await this.dropHeld(sceneId, held.opId);
          this.setStatus(sceneId, "saved");
          void this.pull().catch(() => {});
          return { kind: "saved", revision };
        }
        if (first === "conflict" && r.conflictId) {
          await this.pull().catch(() => {});
          await this.addRecovery(this.itemFor(sceneId, r.conflictId, "conflict", held.doc));
          await this.dropHeld(sceneId, held.opId);
          return { kind: "recovery" };
        }
        await this.sendToAuthor(held, "refused", why(r.code));
        return { kind: "recovery" };
      }
      case "resync":
        if (ans.epoch !== this.epoch) {
          // Rule 3: the answer was for another history. The text is shown to the author, not re-sent.
          this.adoptEpoch(ans.epoch);
          await this.pull().catch(() => {});
          return { kind: "recovery" };
        }
        // Rule 7: the text was made against a history the server does not have. Held for the author, never re-based.
        await this.sendToAuthor(held, "refused", "The server does not have the version this text was written on.");
        return { kind: "recovery" };
      case "invalid":
      case "too-large":
        await this.sendToAuthor(held, "refused", "The server could not accept this text as it is.");
        return { kind: "recovery" };
    }
  }

  /** A text the server will not take, or never saw: it becomes a recovery item for the author to review (rule 8). */
  private async sendToAuthor(held: Held, source: RecoveryItem["source"], reason: string): Promise<void> {
    await this.addRecovery(this.itemFor(held.sceneId, `held:${held.opId ?? newId()}`, source, held.doc, reason));
    await this.dropHeld(held.sceneId, held.opId);
  }

  /**
   * Called as the page is going away. Sends the text with keepalive where the browser allows it, under an op id that is
   * kept on this device, so a lost answer is a safe retry on the next visit. Not awaited by anyone.
   */
  saveOnHide(sceneId: string, doc: CanonicalDocument): void {
    if (this.state.phase !== "ready" || !this.active || this.recoveryFor(sceneId) || this.held.get(sceneId)?.status === "review") return;
    const baseRevision = this.baseOf(sceneId);
    const have = this.held.get(sceneId);
    const same = have?.status === "sent" && have.opId && have.baseRevision === baseRevision && sameDoc(have.doc, doc);
    const opId = same ? have!.opId! : newId();
    const held: Held = { sceneId, doc, baseRevision, opId, status: "sent", savedAt: stamp() };
    this.held.set(sceneId, held);
    void this.db?.putHeld(held).catch(() => {});
    if (this.epochPending) return; // the held copy is routed to the author after the epoch change
    const ops = [docOp(opId, sceneId, baseRevision, doc)];
    // Keepalive requests are limited to 64 KiB of bytes (not characters); the held copy covers anything larger.
    if (!fitsKeepalive(this.epoch, getDeviceId(), ops)) return;
    void this.io.pushOps(this.epoch, getDeviceId(), ops, true).catch(() => {});
  }

  // ----- recovery -----
  /** The saved text of a scene as the client last saw it, or the copy stored with the item if the scene is gone. */
  savedTextFor(item: RecoveryItem): CanonicalDocument | null {
    if (sceneIsLive(this.model, item.sceneId) && this.model.docs.has(item.sceneId)) return this.model.docs.get(item.sceneId)!.doc as CanonicalDocument;
    return item.theirs;
  }

  /**
   * Which choices the server's records allow for this item. A copy (keep both, or save as a new scene) is offered only
   * for a scene: front matter and back matter have no parent and the archive rules do not let a scene copy stand in.
   */
  choicesFor(item: RecoveryItem): RecoveryChoice[] {
    const live = sceneIsLive(this.model, item.sceneId);
    const node = this.model.records.get("manuscriptNode")?.get(item.sceneId);
    const canCreate = node?.kind === "scene" && typeof node.bookId === "string" && typeof node.orderKey === "string" && typeof node.parentId === "string";
    if (live) return canCreate ? ["mine", "saved", "both"] : ["mine", "saved"];
    return canCreate ? ["copy"] : [];
  }

  /**
   * Applies the author's choice. The item is on this device before anything is sent (rule 9) and is removed only after
   * the server has answered for every op of the choice, `resolve` included.
   */
  resolveItem(item: RecoveryItem, choice: RecoveryChoice): Promise<ResolveOutcome> {
    const epoch = this.epoch;
    return this.enqueue(item.sceneId, () => this.doResolve(item, choice, epoch));
  }

  /** Keeps the attempt (op ids) with the item, on this device and on screen. */
  private async keepAttempt(item: RecoveryItem, attempt: Attempt): Promise<RecoveryItem> {
    const current: RecoveryItem = { ...item, attempt };
    try { await this.db?.putRecovery(current); } catch { this.set({ keepsCopies: false }); }
    this.set({ recovery: this.state.recovery.map((r) => (r.sceneId === item.sceneId && r.conflictId === item.conflictId ? current : r)) });
    return current;
  }

  /** A refused op id is permanent. After a refusal the ops that were refused get new ids, so a retry is a new request. */
  private renewed(attempt: Attempt, refused: number[]): Attempt {
    const opIds = attempt.opIds.map((id, i) => (refused.includes(i) ? newId() : id));
    let copyId = attempt.copyId;
    if (refused.includes(0) && copyId) { copyId = newId(); opIds[1] = newId(); } // the copy's document belongs to the copy's id
    const next: Attempt = { choice: attempt.choice, opIds, ...(copyId ? { copyId } : {}), ...(attempt.savedRev !== undefined ? { savedRev: attempt.savedRev } : {}) };
    // The scene's document op keeps the revision it was made against, unless that op was itself refused.
    if (attempt.sceneBase !== undefined && !refused.includes(2)) next.sceneBase = attempt.sceneBase;
    return next;
  }

  private async doResolve(item: RecoveryItem, choice: RecoveryChoice, epoch: string): Promise<ResolveOutcome> {
    const { sceneId } = item;
    const isConflict = item.source === "conflict";
    const node = this.model.records.get("manuscriptNode")?.get(sceneId);
    const saved = this.savedTextFor(item);
    if (!this.choicesFor(item).includes(choice) || !node) return { ok: false, message: "This choice is not available for this text. Your copy is still kept on this device." };
    if (choice === "both" && !saved) return { ok: false, message: "The saved text could not be read, so no copy can be made. Your copy is still kept on this device." };
    const makesCopy = choice === "both" || choice === "copy";
    const writesScene = choice === "mine" || choice === "both";
    // The attempt (its op ids) is stored with the item, so a retry after a lost answer repeats the same ops.
    const savedRev = sceneDocument(this.model, sceneId).revision;
    let attempt: Attempt = item.attempt?.choice === choice ? item.attempt
      : { choice, opIds: [newId(), newId(), newId(), newId()], ...(makesCopy ? { copyId: newId() } : {}), ...(choice === "both" ? { savedRev } : {}) };
    // The copy's document (slot 1) has no base guard: its op id is reused only for the same saved text.
    if (choice === "both" && attempt.savedRev !== savedRev) attempt = { ...this.renewed(attempt, [0]), savedRev };
    let current = await this.keepAttempt(item, attempt);

    const now = stamp();
    const createCopy = (title: string): Op => ({
      opId: attempt.opIds[0]!, op: "create", recordKind: "manuscriptNode", recordId: attempt.copyId!,
      value: {
        id: attempt.copyId!, bookId: node.bookId, ...(typeof node.parentId === "string" ? { parentId: node.parentId } : {}),
        kind: node.kind, title, orderKey: `${String(node.orderKey)}m`, createdAt: now, updatedAt: now,
      },
    });
    type Entry = { slot: number; op: Op };
    const status = (r: OpResult | undefined): string => (r ? (r.status === "duplicate" ? r.firstStatus ?? "" : r.status) : "missing");

    /** One push. Gives the answer's results, or the message for the author if there is none. */
    const send = async (entries: Entry[]): Promise<{ results: OpResult[] } | { message: string }> => {
      if (epoch !== this.epoch || this.epochPending) return { message: "The server's library changed while you were deciding. Your copy is still kept on this device. Look at both versions again." };
      let ans: PushAnswer;
      try {
        ans = await this.io.pushOps(epoch, getDeviceId(), entries.map((e) => e.op));
      } catch (e) {
        if (e instanceof SessionError) { await this.endSession(); return { message: "You are signed out. Sign in again; your copy is still kept on this device." }; }
        return { message: "Could not reach the server. Your copy is still kept on this device. Try again." };
      }
      if (ans.kind === "resync") {
        if (ans.epoch !== this.epoch) { this.adoptEpoch(ans.epoch); await this.pull().catch(() => {}); }
        return { message: "The server's library changed. Your copy is still kept on this device. Look at both versions again." };
      }
      if (ans.kind !== "ok") return { message: "The server could not accept this choice. Your copy is still kept on this device." };
      return { results: ans.results };
    };
    /** After a refusal: new op ids for what was refused, kept with the item. */
    const refuse = async (entries: Entry[], results: OpResult[], what: string): Promise<ResolveOutcome> => {
      const slots = entries.filter((_, i) => status(results[i]) === "rejected").map((e) => e.slot);
      const bad = results.find((r) => status(r) === "rejected");
      if (slots.length > 0) {
        attempt = this.renewed(attempt, slots);
        current = await this.keepAttempt(current, attempt);
      }
      return { ok: false, message: `${why(bad?.code)} ${what} Your copy is still kept on this device.${slots.length > 0 ? " If you try again, it is sent as a new request." : ""}` };
    };

    // Step 1, for a copy: the copy and its text must both be on the server before the scene itself is touched.
    if (makesCopy) {
      const entries: Entry[] = [
        { slot: 0, op: createCopy(`${item.sceneTitle} ${choice === "both" ? "(saved copy)" : "(from this device)"}`) },
        { slot: 1, op: docOp(attempt.opIds[1]!, attempt.copyId!, 0, choice === "both" ? saved! : item.mine) },
      ];
      const out = await send(entries);
      if ("message" in out) return { ok: false, message: out.message };
      if (!entries.every((_, i) => status(out.results[i]) === "applied")) {
        return refuse(entries, out.results, choice === "both" ? "The copy of the saved text was not made, so the scene was left as it was." : "The new scene was not made.");
      }
    }

    // Step 2: this device's text over the scene (mine, both), and the closing of the conflict.
    const entries: Entry[] = [];
    let baseRevision = 0;
    if (writesScene) {
      if (attempt.sceneBase === undefined) { attempt = { ...attempt, sceneBase: sceneDocument(this.model, sceneId).revision }; current = await this.keepAttempt(current, attempt); }
      baseRevision = attempt.sceneBase!;
      entries.push({ slot: 2, op: docOp(attempt.opIds[2]!, sceneId, baseRevision, item.mine) });
    }
    if (isConflict) entries.push({ slot: 3, op: { opId: attempt.opIds[3]!, op: "resolve", conflictId: item.conflictId } });
    let results: OpResult[] = [];
    if (entries.length > 0) {
      const out = await send(entries);
      if ("message" in out) return { ok: false, message: out.message };
      results = out.results;
    }

    const resolveIndex = entries.findIndex((e) => e.slot === 3);
    const resolveR = resolveIndex >= 0 ? results[resolveIndex] : undefined;
    const resolveClosed = resolveIndex < 0 || status(resolveR) === "applied" || resolveR?.code === "CONFLICT_UNKNOWN";
    const dataEntries = entries.filter((e) => e.slot !== 3);
    const dataResults = dataEntries.map((_, i) => results[i]);
    const conflicted = dataResults.find((r) => status(r) === "conflict");
    const refused = dataResults.some((r) => status(r) === "rejected");

    if (conflicted?.conflictId) {
      // Someone saved the scene again while the author was deciding. The old item is settled; a new one replaces it.
      await this.pull().catch(() => {});
      const next = this.itemFor(sceneId, conflicted.conflictId, "conflict", item.mine);
      await this.addRecovery(next);
      if (resolveClosed) await this.removeRecovery(item);
      return { ok: false, message: "The scene was saved again while you were deciding. Look at both versions once more." };
    }
    if (refused) return refuse(entries, results, "The scene was not changed.");
    if (!resolveClosed) {
      if (status(resolveR) === "rejected") return refuse(entries, results, "The server did not close this item.");
      return { ok: false, message: "The server did not close this item. Your copy is still kept on this device. Try again." };
    }

    // The server has answered for everything: now the item can go.
    await this.removeRecovery(item);
    if (choice !== "saved") this.setStatus(sceneId, "saved");
    await this.pull().catch(() => {});
    return { ok: true };
  }

  // ===== story bible (M1-10, slice 1): entries, through ordinary create, set and unset ops =====

  /** One push of record ops, with the same handling of session, epoch and answer as a scene save. */
  private async sendRecordOps(ops: Op[]): Promise<{ kind: "ok"; results: OpResult[] } | { kind: "offline" } | { kind: "changed" } | { kind: "retry" } | { kind: "refused" }> {
    if (this.state.phase !== "ready" || !this.active) return { kind: "offline" };
    if (this.epochPending) return { kind: "changed" };
    let ans: PushAnswer;
    try {
      ans = await this.io.pushOps(this.epoch, getDeviceId(), ops);
    } catch (e) {
      if (e instanceof SessionError) await this.endSession();
      return { kind: "offline" };
    }
    if (ans.kind === "resync") {
      if (ans.epoch !== this.epoch) { this.adoptEpoch(ans.epoch); await this.pull().catch(() => {}); return { kind: "changed" }; }
      return { kind: "retry" }; // the same history: the server did not have the version this was made against
    }
    if (ans.kind !== "ok") return { kind: "refused" };
    return { kind: "ok", results: ans.results };
  }

  /**
   * Gives the library its built-in templates and fields if they are missing, through create ops. This client decides
   * when: the first time the story bible is opened (the spec does not say). One run at a time; calling it again when
   * everything is there sends nothing.
   */
  seedBible(): Promise<void> {
    if (this.seeding) return this.seeding;
    // An epoch change during a run makes it a run for the old history: it runs again for the new one.
    const run = async (): Promise<void> => {
      for (let round = 0; round < 5; round++) {
        const gen = this.epochGen;
        await this.doSeed();
        if (gen === this.epochGen || !this.active) return;
      }
    };
    const p = run().finally(() => { if (this.seeding === p) this.seeding = undefined; });
    this.seeding = p;
    return p;
  }

  private async doSeed(): Promise<void> {
    // After a changed epoch the model is read again first: seeding against a half-loaded model would send creates for records that exist.
    while (this.pulling || this.routingRun) { await Promise.all([this.pulling, this.routingRun].map((p) => p?.catch(() => {}))); }
    if (this.state.phase !== "ready") return;
    if (bibleReady(this.model)) { if (this.state.bible !== "ready") this.set({ bible: "ready", bibleMessage: undefined }); return; }
    this.set({ bible: "setting-up", bibleMessage: undefined });
    const ops = seedOps(this.model, newId) as Op[];
    const out = await this.sendRecordOps(ops);
    if (out.kind !== "ok") {
      const message = out.kind === "offline" ? "Could not reach the server to set up the story bible."
        : out.kind === "changed" ? "The server's library changed. Try again."
        : out.kind === "retry" ? RETRY_MESSAGE
        : "The story bible could not be set up. The server did not accept the request. Try again.";
      this.set({ bible: "failed", bibleMessage: message });
      return;
    }
    // A record that already exists was made by another tab or device a moment ago: that is what was wanted.
    const bad = out.results.find((r) => (r.status === "rejected" && r.code !== "RECORD_EXISTS") || r.status === "conflict");
    await this.pull().catch(() => {});
    if (bad) { this.set({ bible: "failed", bibleMessage: `The story bible could not be set up. ${bad.message ?? ""}`.trim() }); return; }
    this.set(bibleReady(this.model) ? { bible: "ready", bibleMessage: undefined } : { bible: "failed", bibleMessage: "The story bible could not be set up. Try again." });
  }

  private setField(key: string, status: FieldStatus | undefined): void {
    const fields = new Map(this.state.fields);
    if (status) fields.set(key, status); else fields.delete(key);
    this.set({ fields });
  }
  clearFieldStatus(key: string): void { if (this.state.fields.has(key)) this.setField(key, undefined); }
  /**
   * The draft of a field. One written under another epoch than the current one belongs to an older history: it is shown
   * as a conflict (the author chooses) and never sent as unsent text.
   */
  draftFor(key: string): FieldDraft | undefined {
    const d = this.drafts.get(key);
    if (!d || !this.epochKnown || d.epoch === this.epoch) return d;
    return { ...d, state: "conflict", reason: HISTORY_REASON };
  }
  /** The count of epoch changes seen so far. A field's base is valid only under the count it was read under. */
  get generation(): number { return this.epochGen; }
  /** The generation a field shown from this draft may save under: never the current one when the draft is from an older history. */
  generationFor(d: FieldDraft | undefined): number { return d && this.epochKnown && d.epoch !== this.epoch ? -1 : this.epochGen; }
  /** The base for a set or unset of an entry's field: the newest change on it that this device has seen. */
  baseOfField(entryId: string, field: string, kind: RecordKind = "entry"): number { return fieldBase(this.model, kind, entryId, field); }

  private async putDraft(d: FieldDraft): Promise<void> {
    d = { ...d, epoch: d.epoch ?? this.epoch };
    this.drafts.set(d.key, d);
    try { await this.db?.putDraft(d); } catch { this.set({ keepsCopies: false }); }
  }
  async discardDraft(key: string): Promise<void> {
    this.drafts.delete(key);
    this.clearFieldStatus(key);
    try { await this.db?.deleteDraft(key); } catch { /* a stale draft is shown again and can be discarded again */ }
  }

  /** Text the author typed that cannot be sent as it is: it stays on this device and the message is shown. Nothing is sent. */
  async holdField(p: { entryId: string; field: string; input: unknown; base: number; gen?: number }, message: string): Promise<FieldOutcome> {
    const key = `${p.entryId}/${p.field}`;
    await this.putDraft({ key, entryId: p.entryId, field: p.field, input: p.input, base: p.base, state: "refused", reason: message, savedAt: stamp(), ...(p.gen !== undefined && p.gen !== this.epochGen ? { epoch: "" } : {}) });
    this.setField(key, { state: "invalid", message });
    return { kind: "invalid", message };
  }

  /** Creates an entry of a built-in type, shared by the book's scope. The id and op id come from the caller so that a retry is the same op. */
  async createEntry(p: { id: string; opId: string; type: EntryType; name: string; toBeNamed: boolean; bookId: string }): Promise<CreateOutcome> {
    const made = newEntryValue(this.model, p);
    if (!made.ok) return { ok: false, message: made.error };
    const value = made.value;
    const out = await this.sendRecordOps([{ opId: p.opId, op: "create", recordKind: "entry", recordId: p.id, value }]);
    if (out.kind === "offline") return { ok: false, message: "Could not reach the server. What you typed is still here. Try again.", lost: true };
    if (out.kind === "changed") return { ok: false, message: "The server's library changed. What you typed is still here. Try again." };
    if (out.kind === "retry") return { ok: false, message: `${RETRY_MESSAGE} What you typed is still here.` };
    if (out.kind === "refused") return { ok: false, message: "The server could not accept this. What you typed is still here." };
    const r = out.results[0]!;
    const first = r.status === "duplicate" ? r.firstStatus : r.status;
    if (first === "applied") { await this.pull().catch(() => {}); return { ok: true, id: p.id }; }
    return { ok: false, message: `${entryWhy(r)} What you typed is still here.` };
  }

  /** Creates a fact or a question for the book's scope (slice 2). Same id and op id rules as createEntry. */
  async createStoryRecord(p: { kind: "fact" | "question"; id: string; opId: string; text: string; bookId: string }): Promise<CreateOutcome> {
    const made = p.kind === "fact" ? newFactValue(this.model, p) : newQuestionValue(this.model, p);
    if (!made.ok) return { ok: false, message: made.error };
    const noun = NOUN[p.kind];
    const out = await this.sendRecordOps([{ opId: p.opId, op: "create", recordKind: p.kind, recordId: p.id, value: made.value }]);
    if (out.kind === "offline") return { ok: false, message: "Could not reach the server. What you typed is still here. Try again.", lost: true };
    if (out.kind === "changed") return { ok: false, message: "The server's library changed. What you typed is still here. Try again." };
    if (out.kind === "retry") return { ok: false, message: `${RETRY_MESSAGE} What you typed is still here.` };
    if (out.kind === "refused") return { ok: false, message: "The server could not accept this. What you typed is still here." };
    const r = out.results[0]!;
    const first = r.status === "duplicate" ? r.firstStatus : r.status;
    if (first === "applied") { await this.pull().catch(() => {}); return { ok: true, id: p.id }; }
    return { ok: false, message: `${entryWhy(r, noun)} What you typed is still here.` };
  }

  /**
   * Saves one field of an entry: `field` is the sync field name ("name", "summary", "values/<fieldId>", ...) and `value`
   * is its new value, or undefined to remove it. The typed `input` is kept on this device first and removed only after
   * the server has applied the change. "saved" means the server answered.
   */
  saveEntryField(q: { entryId: string; field: string; value: unknown; input: unknown; base: number; gen?: number; kind?: RecordKind }): Promise<FieldOutcome> {
    const key = `${q.entryId}/${q.field}`;
    // The generation the base was read under; without one, the caller is taken to have read it just now.
    const p = { ...q, gen: q.gen ?? this.epochGen };
    // Saves of one field are made one after another, and each runs with the newest input (never the value it was asked
    // with), so two answers cannot arrive in the wrong order and an older value cannot overwrite a newer one.
    this.fieldLatest.set(key, p);
    const queued = this.fieldPending.get(key) ?? 0;
    this.fieldPending.set(key, queued + 1);
    // A newer input waits for the one in flight: it is kept on this device now, not only when its turn comes.
    const early = queued > 0
      ? this.putDraft({ key, entryId: p.entryId, field: p.field, input: p.input, base: p.base, state: "unsent", savedAt: stamp() }) : Promise.resolve();
    const job = async (): Promise<FieldOutcome> => {
      await early;
      try { return await this.runFieldSave(key, this.fieldLatest.get(key)!); }
      finally {
        const left = (this.fieldPending.get(key) ?? 1) - 1;
        if (left <= 0) { this.fieldPending.delete(key); this.fieldLatest.delete(key); } else this.fieldPending.set(key, left);
      }
    };
    const run = (this.fieldChains.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    this.fieldChains.set(key, tail);
    void tail.then(() => { if (this.fieldChains.get(key) === tail) this.fieldChains.delete(key); });
    return run;
  }

  private async runFieldSave(key: string, q: { entryId: string; field: string; value: unknown; input: unknown; base: number; gen: number; kind?: RecordKind }): Promise<FieldOutcome> {
    const p = { ...q, base: Math.max(q.base, this.fieldOwnSeq.get(key) ?? 0) }; // after an earlier save of this field, the base is that save
    const newest = (): boolean => { // false once a newer, different input was asked for
      const latest = this.fieldLatest.get(key);
      return latest === q || (latest !== undefined && latest.gen === q.gen && sameDoc(latest.input, q.input));
    };
    const kind: RecordKind = q.kind ?? "entry";
    const noun = NOUN[kind];
    const entry = this.model.records.get(kind)?.get(p.entryId);
    const keep = async (state: FieldDraft["state"], reason?: string, opId?: string, epoch?: string): Promise<void> => {
      if (!newest()) return; // a newer input owns the copy on this device
      await this.putDraft({ key, entryId: p.entryId, field: p.field, input: p.input, base: p.base, state, ...(epoch !== undefined ? { epoch } : {}), ...(reason ? { reason } : {}), ...(opId ? { opId } : {}), savedAt: stamp() });
    };
    const fail = (kind: FieldOutcome["kind"], state: FieldStatus["state"], message: string): FieldOutcome => {
      if (newest()) this.setField(key, { state, message }); // for an older input, the newer one's turn shows its own state
      return { kind, message };
    };
    const stale = async (): Promise<FieldOutcome | undefined> => {
      if (q.gen === this.epochGen) return undefined;
      // The base was read under an older history: it is never sent. The author chooses ("Keep my text" takes a fresh base).
      await keep("conflict", HISTORY_REASON, undefined, ""); // "" : under no epoch the library has now
      return fail("conflict", "conflict", HISTORY_MESSAGE);
    };
    const old = await stale();
    if (old) return old;
    if (!entry || entry.deletedAt) {
      await keep("refused", `This ${noun} is not in the library any more.`);
      return fail("refused", "refused", `This ${noun} is not in the library any more. What you typed is kept on this device.`);
    }
    const bad = kind === "entry" ? checkEntryField(this.model, entry, p.field, p.value)
      : kind === "event" ? checkEventField(this.model, entry, p.field, p.value)
      : kind === "stateChange" ? checkStateChangeField(this.model, entry, p.field, p.value)
      : checkRecordField(this.model, kind, entry, p.field, p.value);
    if (bad) { await keep("refused", bad); return fail("invalid", "invalid", bad); } // never sent
    const current = kind === "entry" && /^values\/(.+)$/.test(p.field) ? (entry.values as Record<string, unknown> | undefined)?.[p.field.slice(7)] : entry[p.field];
    if (sameDoc(current, p.value)) {
      // The saved value is already this one (an earlier save of the same input just applied): "Saved" stays on the field.
      if (newest()) { const shown = this.state.fields.get(key); await this.discardDraft(key); if (shown?.state === "saved") this.setField(key, shown); }
      return { kind: "nothing" };
    }
    const have = this.drafts.get(key);
    const same = have?.opId && JSON.stringify(have.input) === JSON.stringify(p.input) && have.base === p.base;
    const opId = same ? have!.opId! : newId();
    await keep("unsent", undefined, opId); // on this device first
    const old2 = await stale(); // the epoch may have changed while the copy was being written
    if (old2) return old2;
    this.setField(key, { state: "saving" });
    const op: Op = p.value === undefined
      ? { opId, op: "unset", recordKind: kind, recordId: p.entryId, field: p.field, baseSeq: p.base }
      : { opId, op: "set", recordKind: kind, recordId: p.entryId, field: p.field, baseSeq: p.base, value: p.value };
    const out = await this.sendRecordOps([op]);
    if (out.kind === "offline" || out.kind === "refused") return fail("unsaved", "unsaved", "Not saved yet. Your text is kept on this device.");
    if (out.kind === "retry") return fail("unsaved", "unsaved", `${RETRY_MESSAGE} Your text is kept on this device.`);
    if (out.kind === "changed") {
      await keep("conflict", "The server's library was restored or replaced.", opId);
      return fail("conflict", "conflict", "The server's library changed while you were typing. Your text is kept on this device. Choose which text to keep.");
    }
    const r = out.results[0]!;
    const first = r.status === "duplicate" ? r.firstStatus : r.status;
    if (first === "applied") {
      if (newest()) await this.discardDraft(key); // a draft of a newer input stays
      await this.pull().catch(() => {});
      if (q.gen === this.epochGen) this.fieldOwnSeq.set(key, r.seq ?? this.baseOfField(p.entryId, p.field, kind)); // not after an epoch change: that seq is of the old history
      if (newest()) this.setField(key, { state: "saved" }); // Saved only for the newest input
      return { kind: "saved" };
    }
    if (first === "conflict") {
      await keep("conflict", "Changed on another device.", opId);
      await this.pull().catch(() => {});
      // The losing text is on this device now (rule 9), so the open conflict can be closed; the author chooses next.
      if (r.conflictId) await this.sendRecordOps([{ opId: newId(), op: "resolve", conflictId: r.conflictId }]);
      return fail("conflict", "conflict", "This was changed on another device while you were typing. Your text is kept on this device. Choose which text to keep.");
    }
    const message = `${entryWhy(r, noun)} Your text is still here and kept on this device.`;
    await keep("refused", message);
    return fail("refused", "refused", message);
  }
  // ----- events and state changes (slice 3) -----

  /** Sends one create op and gives the author's outcome. The same id and op id make a retry after a lost answer safe. */
  private async createRecord(kind: RecordKind, p: { id: string; opId: string }, value: Record<string, unknown>): Promise<CreateOutcome> {
    const out = await this.sendRecordOps([{ opId: p.opId, op: "create", recordKind: kind, recordId: p.id, value }]);
    if (out.kind === "offline") return { ok: false, message: "Could not reach the server. What you typed is still here. Try again.", lost: true };
    if (out.kind === "changed") return { ok: false, message: "The server's library changed. What you typed is still here. Try again." };
    if (out.kind === "retry") return { ok: false, message: `${RETRY_MESSAGE} What you typed is still here.` };
    if (out.kind === "refused") return { ok: false, message: "The server could not accept this. What you typed is still here." };
    const r = out.results[0]!;
    const first = r.status === "duplicate" ? r.firstStatus : r.status;
    if (first === "applied") { await this.pull().catch(() => {}); return { ok: true, id: p.id }; }
    return { ok: false, message: `${entryWhy(r, NOUN[kind])} What you typed is still here.`, definitive: true }; // a server result that says it was not made
  }

  /** Creates an event in the book's scope (the title only; the rest is edited after). */
  async createEvent(p: { id: string; opId: string; title: string; bookId: string }): Promise<CreateOutcome> {
    const made = newEventValue(this.model, p);
    if (!made.ok) return { ok: false, message: made.error };
    return this.createRecord("event", p, made.value);
  }

  /** Creates a state change on an entry's template field, attached to an event or a scene. */
  async createStateChange(p: { id: string; opId: string; entryId: string; fieldId: string; input: Input; note: string; target: Target | undefined }): Promise<CreateOutcome> {
    const made = newStateChangeValue(this.model, p);
    if (!made.ok) return { ok: false, message: made.error };
    return this.createRecord("stateChange", p, made.value);
  }

  /**
   * Moves a state change to another event or scene. The spec has no combined op and the server applies ops one at a time,
   * so: the new record is made first, and only when the server has applied that is the old one tombstoned. If the second
   * step fails the change exists twice, which is said plainly; nothing is lost.
   */
  async moveStateChange(p: { id: string; opId: string; oldId: string; target: Target; created?: boolean }): Promise<MoveOutcome> {
    const old = this.model.records.get("stateChange")?.get(p.oldId);
    if (p.created && old?.deletedAt) return { ok: true }; // an earlier try removed it, and only the answer was lost
    if (!old || old.deletedAt) return { ok: false, message: "This state change is not in the library any more." };
    // Text typed on the old row that is not saved yet would be stranded when the old record goes to the trash.
    const pending = [...this.fieldPending.keys()].some((k) => k.startsWith(`${p.oldId}/`));
    const stuck = [...this.drafts.values()].find((d) => d.entryId === p.oldId && d.state !== "unsent");
    if (stuck) {
      return { ok: false, message: stuck.state === "conflict"
        ? "This change has text that was changed on another device. Choose which text to keep (Keep my text or Use the saved text), then move it."
        : "This change has text that cannot be saved as it is. Correct the text so it can be saved, then move it." };
    }
    if (p.created) {
      // A copy missing from the local model is unknown, not removed: the pull after the create may have failed. Check the server's feed first.
      let pulled = true;
      await this.pull().catch(() => { pulled = false; });
      const fresh = this.model.records.get("stateChange")?.get(p.id);
      if (!pulled) return { ok: false, created: true, message: "Could not check whether the new copy is there. Try again when the connection is back." };
      if (!fresh || fresh.deletedAt) {
        // The new copy is confirmed gone: removing the old one now would leave no copy. The view clears its attempt.
        return { ok: false, message: "The new copy was removed, so the move was not finished. The old one is still here. Choose the place again to move it.", clear: true };
      }
    }
    if (this.hasDraftsFor(p.oldId) || pending) return { ok: false, message: "This change has text that is not saved yet. Save it first, then move it." };
    if (!p.created) {
      const moved = movedStateChangeValue(this.model, old, p.id, p.target);
      if (!moved.ok) return { ok: false, message: moved.error };
      const out = await this.createRecord("stateChange", p, moved.value);
      if (!out.ok) return { ok: false, message: out.message.replace(" What you typed is still here.", ""), ...(out.lost ? { lost: true } : out.definitive ? { clear: true } : {}) }; // clear only when a server result says it was not made; changed or retry sent nothing, or may have sent it
    }
    const gone = await this.tombstoneRecord("stateChange", p.oldId);
    if (!gone.ok) return { ok: false, created: true, message: `The change was moved, but the old copy could not be removed: ${gone.message} It now shows twice; remove one.` };
    return { ok: true };
  }

  /** Puts a record in the trash (an event or a state change). baseSeq is the newest change this device has seen. */
  async tombstoneRecord(kind: "event" | "stateChange", id: string): Promise<ResolveOutcome> {
    return this.trashOp(kind, id, "tombstone");
  }
  async restoreRecord(kind: "event" | "stateChange", id: string): Promise<ResolveOutcome> {
    return this.trashOp(kind, id, "restore");
  }

  private async trashOp(kind: "event" | "stateChange", id: string, op: "tombstone" | "restore"): Promise<ResolveOutcome> {
    const noun = NOUN[kind];
    const rec = this.model.records.get(kind)?.get(id);
    if (!rec) return { ok: false, message: `This ${noun} is not in the library any more.` };
    const body: Op = op === "tombstone"
      ? { opId: newId(), op, recordKind: kind, recordId: id, baseSeq: this.model.cursor }
      : { opId: newId(), op, recordKind: kind, recordId: id };
    const out = await this.sendRecordOps([body]);
    if (out.kind === "offline") return { ok: false, message: "Could not reach the server. Try again." };
    if (out.kind === "changed") return { ok: false, message: "The server's library changed. Try again." };
    if (out.kind === "retry") return { ok: false, message: RETRY_MESSAGE };
    if (out.kind === "refused") return { ok: false, message: "The server could not accept this. Try again." };
    const r = out.results[0]!;
    const first = r.status === "duplicate" ? r.firstStatus : r.status;
    // Already in the state asked for (another device did it): that is what was wanted.
    if (first === "applied" || r.code === (op === "tombstone" ? "RECORD_DELETED" : "RECORD_NOT_DELETED")) { await this.pull().catch(() => {}); return { ok: true }; }
    if (first === "conflict") {
      await this.pull().catch(() => {});
      return { ok: false, message: `This ${noun} was changed on another device. Look at it again, then try again.` };
    }
    return { ok: false, message: `${entryWhy(r, noun)}` };
  }
}

/** The server's own plain message for a refused op on an entry, with entry wording for the record codes. */
const NOUN: Record<RecordKind, string> = { entry: "entry", fact: "fact", question: "question", event: "event", stateChange: "state change" };
const entryWhy = (r: OpResult, noun = "entry"): string =>
  r.code === "RECORD_UNKNOWN" ? `This ${noun} is not in the library any more.`
  : r.code === "RECORD_DELETED" ? `This ${noun} is in the trash.`
  : r.message ? r.message
  : r.code === "INVALID_VALUE" ? "The server could not accept this value."
  : r.code === "INTEGRITY_VIOLATION" ? "This does not fit the rest of the library, so the server did not accept it."
  : r.code === "REFERENCE_UNRESOLVED" ? "Something this points to is not in the library."
  : "The server refused this.";

export type { Conflict };

// The story bible in the studio, slices 1 to 3 (M1-10): entries, facts, questions, and the timeline (events and state changes). The list sits in the left panel; an
// entry opens in the centre. Every field saves when the author leaves it (a choice saves when it is chosen), and shows
// "Saved" only after the server has answered. Text the server has not confirmed stays on this device.
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HISTORY_MESSAGE, HISTORY_REASON } from "./sync/client.ts";
import type { ClientState, SyncClient } from "./sync/client.ts";
import { newId } from "./editor/rolltop-editor.ts";
import { NetworkError, SessionError, getContinuityWarnings } from "./sync/http.ts";
import type { ContinuityWarning } from "./sync/http.ts";
import { describeWarning, warningsForBook } from "./sync/continuity.ts";
import type { Model, Rec } from "./sync/model.ts";
import {
  FACT_TRUTH, QUESTION_STATUS, STATE_FIELD_TYPES, TEXT_MAX, TOPIC_MAX, encodeEventInput, encodeInput, encodeRecordInput, encodeTop, entriesOfType, entryNoun, entryNounCap,
  eventInputOf, eventTitle, eventsOf, factsOf, fieldsOf, inputOf, nodesInScope, participantItem, participantsOf, questionsOf, readOnlyText, recordInputOf,
  attemptAfterFailedMove, nextMoveAttempt, removedEventsOf, scopeSentence, shortSummary, stateChangeDef, stateChangesOf, topInputOf, whenLabel,
} from "./sync/bible.ts";
import type { EntryType, FieldDef, Input, RecordField, RecordKind, TopField } from "./sync/bible.ts";

export type BibleSection = "Characters" | "Worldbuilding";
export type StoryKind = "fact" | "question";
/** What opens in the centre by id, and what can be made new. A state change has no page of its own: it is edited on its entry. */
export type ViewKind = "entry" | "fact" | "question" | "event";
export type NewKind = EntryType | StoryKind | "event";
export type BibleView = { kind: ViewKind; id: string } | { kind: "new"; type: NewKind } | undefined;

const SECTION_TYPES: Record<BibleSection, EntryType[]> = {
  Characters: ["character"], Worldbuilding: ["location", "term", "organization", "object", "plotline", "worldRule", "research"],
};
const PLURAL: Record<string, string> = {
  character: "Characters", location: "Places", term: "Terms", organization: "Organizations", object: "Objects", plotline: "Plotlines",
  worldRule: "World rules", research: "Research notes", fact: "Facts", question: "Questions",
};
const ENTRY_TYPES_FOR_LINKS = ["character", "location", "term", "organization", "object", "event", "plotline", "worldRule", "research"];

// ---------- the left panel ----------

interface ListProps {
  client: SyncClient; cstate: ClientState; section: BibleSection; bookId: string | undefined;
  view: BibleView; onOpen: (kind: ViewKind, id: string) => void; onNew: (type: NewKind) => void;
}

export function BibleList({ client, cstate, section, bookId, view, onOpen, onNew }: ListProps) {
  void cstate.version; // the list is read again whenever the model changes
  if (!bookId) return <><h2 className="outline__title">{section}</h2><p className="hint">Make a book first. Entries belong to a book, a series or a universe.</p></>;
  if (cstate.bible !== "ready") return <><h2 className="outline__title">{section}</h2><SetupNotice client={client} cstate={cstate} /></>;
  const types = SECTION_TYPES[section];
  return (
    <>
      <h2 className="outline__title">{section}</h2>
      {section === "Worldbuilding" && <ContinuityList client={client} epoch={cstate.epoch} bookId={bookId} onOpen={onOpen} />}
      {types.map((type) => {
        const entries = entriesOfType(client.model, [type], bookId);
        const labelId = `bl-${type}`;
        return (
          <section key={type} className="biblelist" aria-labelledby={section === "Worldbuilding" ? labelId : undefined}>
            {section === "Worldbuilding" && <h3 id={labelId} className="biblelist__title">{PLURAL[type]}</h3>}
            <button type="button" className="btn btn--wood biblelist__new" onClick={() => onNew(type)}
              aria-pressed={view?.kind === "new" && view.type === type}>New {entryNoun(type)}</button>
            {entries.length === 0 ? <p className="hint">No {PLURAL[type]!.toLowerCase()} yet.</p> : (
              <ul className="outline" aria-label={PLURAL[type]}>
                {entries.map((e) => (
                  <li key={e.id}>
                    <button type="button" className="biblelist__item" aria-current={view?.kind === "entry" && view.id === e.id ? "true" : undefined} onClick={() => onOpen("entry", e.id)}>
                      <span className="biblelist__name">{String(e.name) || "No name"}</span>
                      <span className="biblelist__meta">{entryNounCap(type)}{e.toBeNamed === true ? ", to be named" : ""}</span>
                      {shortSummary(e.summary) && <span className="biblelist__summary">{shortSummary(e.summary)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {section === "Worldbuilding" && (["fact", "question"] as const).map((kind) => {
        const items = kind === "fact" ? factsOf(client.model, bookId) : questionsOf(client.model, bookId);
        const labelId = `bl-${kind}`;
        return (
          <section key={kind} className="biblelist" aria-labelledby={labelId}>
            <h3 id={labelId} className="biblelist__title">{PLURAL[kind]}</h3>
            <button type="button" className="btn btn--wood biblelist__new" onClick={() => onNew(kind)}
              aria-pressed={view?.kind === "new" && view.type === kind}>New {kind}</button>
            {items.length === 0 ? <p className="hint">No {PLURAL[kind]!.toLowerCase()} yet.</p> : (
              <ul className="outline" aria-label={PLURAL[kind]}>
                {items.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="biblelist__item" aria-current={view?.kind === kind && view.id === r.id ? "true" : undefined} onClick={() => onOpen(kind, r.id)}>
                      <span className="biblelist__name">{shortSummary(r.text, 70) || "No text"}</span>
                      <span className="biblelist__meta">{kind === "fact" ? factTruthLabel(r.truth) : `${r.status === "decided" ? "Decided" : "Open"}${typeof r.topic === "string" ? `, ${r.topic}` : ""}`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {section === "Worldbuilding" && <TimelineList client={client} bookId={bookId} view={view} onOpen={onOpen} onNew={onNew} />}
    </>
  );
}

// ---------- continuity warnings (slice 4) ----------

type Continuity = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; warnings: ContinuityWarning[] };

/**
 * The server's warnings, asked for when the list is shown and again whenever the library changes (a save of the author's,
 * or a change from another device, moves the model's cursor). A request still running is cancelled by the next one.
 */
function useContinuity(client: SyncClient, epoch: string | undefined): { value: Continuity; retry: () => void } {
  const [value, setValue] = useState<Continuity>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const cursor = client.model.cursor;
  useEffect(() => {
    const ctl = new AbortController();
    getContinuityWarnings(ctl.signal).then(
      (warnings) => { if (!ctl.signal.aborted) setValue({ state: "ready", warnings }); },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        setValue({ state: "error", message: e instanceof SessionError ? "You are signed out. Sign in again to see the warnings." : e instanceof NetworkError ? `Could not get the warnings. ${e.message}` : "Could not get the warnings." });
      },
    );
    return () => ctl.abort();
  }, [client, epoch, cursor, attempt]);
  return { value, retry: () => { setValue({ state: "loading" }); setAttempt((n) => n + 1); } };
}

function ContinuityList({ client, epoch, bookId, onOpen }: { client: SyncClient; epoch: string | undefined; bookId: string; onOpen: ListProps["onOpen"] }) {
  const { value, retry } = useContinuity(client, epoch);
  const base = useId();
  const m = client.model;
  const shown = value.state === "ready" ? warningsForBook(m, value.warnings, bookId) : [];
  return (
    <section className="biblelist" aria-labelledby="bl-continuity">
      <h3 id="bl-continuity" className="biblelist__title">Continuity</h3>
      {value.state === "loading" && <p role="status" className="hint">Checking the story…</p>}
      {value.state === "error" && (
        <>
          <p role="alert" className="error">{value.message}</p>
          <button type="button" className="btn btn--wood biblelist__new" onClick={retry}>Try again</button>
        </>
      )}
      {value.state === "ready" && (shown.length === 0 ? (
        <p className="hint">Nothing to check. No facts, questions or events in this book clash with each other or with the manuscript.</p>
      ) : (
        <>
          <p className="hint">{shown.length === 1 ? "1 thing to check." : `${shown.length} things to check.`}</p>
          <ul className="outline continuity" aria-label="Continuity warnings">
            {shown.map((w, i) => {
              const { heading, sentence } = describeWarning(m, w);
              const id = `${base}-${i}`;
              return (
                <li key={`${w.recordId}/${w.key}/${w.bookId ?? ""}`} className="continuity__item">
                  <h4 className="continuity__heading">Check: {heading}</h4>
                  <p id={id} className="continuity__text">{sentence}</p>
                  <button type="button" className="btn btn--wood" aria-describedby={id} onClick={() => onOpen(w.recordKind, w.recordId)}>Open the {w.recordKind}</button>
                </li>
              );
            })}
          </ul>
        </>
      ))}
    </section>
  );
}

function TimelineList({ client, bookId, view, onOpen, onNew }: { client: SyncClient; bookId: string; view: BibleView; onOpen: ListProps["onOpen"]; onNew: ListProps["onNew"] }) {
  const m = client.model;
  const events = eventsOf(m, bookId);
  const removed = removedEventsOf(m, bookId);
  return (
    <section className="biblelist" aria-labelledby="bl-event">
      <h3 id="bl-event" className="biblelist__title">Timeline</h3>
      <button type="button" className="btn btn--wood biblelist__new" onClick={() => onNew("event")} aria-pressed={view?.kind === "new" && view.type === "event"}>New event</button>
      {events.length === 0 ? <p className="hint">No events yet. An event is something that happens in the story, such as a storm or a meeting.</p> : (
        <ul className="outline" aria-label="Timeline">
          {events.map((e) => {
            const scenes = (Array.isArray(e.sceneIds) ? e.sceneIds : []).map((id) => sceneName(m, id));
            return (
              <li key={e.id}>
                <button type="button" className="biblelist__item" aria-current={view?.kind === "event" && view.id === e.id ? "true" : undefined} onClick={() => onOpen("event", e.id)}>
                  <span className="biblelist__name">{eventTitle(e)}</span>
                  <span className="biblelist__meta">{whenLabel(e) || "No date"}</span>
                  <span className="biblelist__summary">{scenes.length === 0 ? "No scenes" : `Scenes: ${scenes.join(", ")}`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {removed.length > 0 && (
        <>
          <p className="hint">Removed events</p>
          <ul className="outline" aria-label="Removed events">
            {removed.map((e) => (
              <li key={e.id}>
                <button type="button" className="biblelist__item" aria-current={view?.kind === "event" && view.id === e.id ? "true" : undefined} onClick={() => onOpen("event", e.id)}>
                  <span className="biblelist__name">{eventTitle(e)}</span><span className="biblelist__meta">Removed</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const sceneName = (m: Model, id: unknown): string => {
  const n = m.records.get("manuscriptNode")?.get(String(id));
  return typeof n?.title === "string" && n.title.trim() !== "" ? n.title : n ? (n.kind === "chapter" ? "Untitled chapter" : "Untitled scene") : "A scene that is not available";
};

const factTruthLabel = (v: unknown): string => FACT_TRUTH.find(([x]) => x === v)?.[1] ?? "Not decided";

/** Shown while the built-in templates are being made, and when that failed. */
export function SetupNotice({ client, cstate }: { client: SyncClient; cstate: ClientState }) {
  if (cstate.bible === "failed") {
    return (
      <>
        <p role="alert" className="error">{cstate.bibleMessage}</p>
        <button type="button" className="btn btn--primary" onClick={() => { void client.seedBible(); }}>Try again</button>
      </>
    );
  }
  return <p role="status" className="hint">Setting up the story bible…</p>;
}

// ---------- the centre ----------

interface CentreProps {
  client: SyncClient; cstate: ClientState; bookId: string | undefined; view: BibleView; section: BibleSection;
  onCreated: (kind: ViewKind, id: string) => void; onCancel: () => void;
}

export function BibleCentre({ client, cstate, bookId, view, section, onCreated, onCancel }: CentreProps) {
  if (cstate.bible !== "ready") {
    return (
      <section className="card page page--empty" aria-labelledby="bible-title">
        <h2 id="bible-title">{section}</h2>
        <SetupNotice client={client} cstate={cstate} />
      </section>
    );
  }
  if (view?.kind === "new" && bookId) {
    const t = view.type;
    if (t === "event") return <NewEvent key={t} client={client} bookId={bookId} onCreated={(id) => onCreated("event", id)} onCancel={onCancel} />;
    if (t === "fact" || t === "question") return <NewStoryRecord key={t} client={client} kind={t} bookId={bookId} onCreated={(id) => onCreated(t, id)} onCancel={onCancel} />;
    return <NewEntry key={t} client={client} type={t} bookId={bookId} onCreated={(id) => onCreated("entry", id)} onCancel={onCancel} />;
  }
  if (view?.kind === "entry") return <EntryView key={view.id} client={client} cstate={cstate} entryId={view.id} bookId={bookId} />;
  if (view?.kind === "event") return <EventView key={view.id} client={client} cstate={cstate} eventId={view.id} bookId={bookId} />;
  if (view?.kind === "fact" || view?.kind === "question") return <StoryRecordView key={view.id} client={client} cstate={cstate} kind={view.kind} recordId={view.id} bookId={bookId} />;
  return (
    <section className="card page page--empty" aria-labelledby="bible-title">
      <h2 id="bible-title">{section}</h2>
      <p>{section === "Characters" ? "Choose a character on the left, or create a new one." : "Choose something on the left, or create a new one: a place, term, organization, object, plotline, world rule, research note, fact, question or event."}</p>
    </section>
  );
}

function NewEntry({ client, type, bookId, onCreated, onCancel }: { client: SyncClient; type: EntryType; bookId: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [toBeNamed, setToBeNamed] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; id: string; opId: string; created?: boolean; lost?: boolean } | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const nameId = useId(), tbnId = useId();
  useEffect(() => { heading.current?.focus(); }, []);

  async function create() {
    if (busy) return;
    setBusy(true); setError(undefined);
    // The same id and op id are used again only for the same content, so a lost answer is a safe retry; a second entry gets a new id.
    const key = JSON.stringify([name.trim(), toBeNamed]);
    if (attempt.current?.key !== key) attempt.current = { key, id: newId(), opId: newId() };
    const out = await client.createEntry({ ...attempt.current, type, name, toBeNamed, bookId });
    setBusy(false);
    if (out.ok) { attempt.current = undefined; onCreated(out.id); return; }
    // Only a lost answer is retried with the same op id. A refusal is a new attempt: the server has answered it.
    if (!out.lost) attempt.current = undefined;
    setError(out.message);
  }

  return (
    <section className="card page" aria-labelledby="entry-title">
      <div className="page__body">
        <h2 id="entry-title" className="page__title" tabIndex={-1} ref={heading}>New {entryNoun(type)}</h2>
        <p className="hint">This {entryNoun(type)} is made for the current book and is shared by every book in that scope. You can fill in the details after it is made.</p>
        <form className="entry__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input id={nameId} value={name} onChange={(e) => { setName(e.target.value); setError(undefined); }} autoComplete="off" aria-describedby="new-entry-error" />
          </div>
          <div className="check">
            <input id={tbnId} type="checkbox" checked={toBeNamed} onChange={(e) => setToBeNamed(e.target.checked)} />
            <label htmlFor={tbnId}>No name yet (to be named)</label>
          </div>
          <p id="new-entry-error" role="alert" className="error">{error}</p>
          <div className="entry__actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Creating…" : `Create ${entryNoun(type)}`}</button>
            <button type="button" className="btn btn--wood" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </section>
  );
}

// ---------- one entry ----------

function EntryView({ client, cstate, entryId, bookId }: { client: SyncClient; cstate: ClientState; entryId: string; bookId: string | undefined }) {
  const m = client.model;
  const entry = m.records.get("entry")?.get(entryId);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  if (!entry || entry.deletedAt) {
    return (
      <section className="card page page--empty" aria-labelledby="bible-title">
        <h2 id="bible-title">This entry is gone</h2>
        <p>{entry ? "It is in the trash." : "It is not in the library any more."}</p>
        {client.hasDraftsFor(entryId) && <p role="status">Text you typed here is kept on this device.</p>}
      </section>
    );
  }
  const type = String(entry.entryType);
  const fields = fieldsOf(m, entry.templateId);
  return (
    <section className="card page" aria-labelledby="entry-title">
      <div className="page__body">
        <h2 id="entry-title" className="page__title" tabIndex={-1} ref={heading}>{String(entry.name) || "No name"}</h2>
        <p className="entry__type">{entryNounCap(type)}{entry.toBeNamed === true ? ", to be named" : ""}</p>
        <p className="hint" id="entry-scope">{scopeSentence(m, entry)}</p>
        <form className="entry__form" onSubmit={(e) => e.preventDefault()} aria-describedby="entry-scope">
          <TopTextField client={client} cstate={cstate} entry={entry} field="name" label="Name" />
          {type === "character" && <TopTextField client={client} cstate={cstate} entry={entry} field="givenName" label="Given name" />}
          {type === "character" && <TopTextField client={client} cstate={cstate} entry={entry} field="familyName" label="Family name" />}
          <ToBeNamed client={client} cstate={cstate} entry={entry} />
          <TopTextField client={client} cstate={cstate} entry={entry} field="aliases" label="Aliases" area hint="One alias on each line." />
          <TopTextField client={client} cstate={cstate} entry={entry} field="summary" label="Summary" area />
          <h3 className="entry__sub">Details</h3>
          {fields.length === 0 && <p className="hint">This template has no fields.</p>}
          {fields.map((f) => <TemplateField key={f.id} client={client} cstate={cstate} entry={entry} def={f} bookId={bookId} />)}
        </form>
        <StateChanges client={client} cstate={cstate} entry={entry} bookId={bookId} />
      </div>
    </section>
  );
}

/** The save state of one field and its controls: the same for every kind of field. */
function useField(client: SyncClient, cstate: ClientState, entryId: string, syncField: string, serverInput: Input, kind: RecordKind = "entry") {
  const key = `${entryId}/${syncField}`;
  const draft = client.draftFor(key);
  const [input, setInput] = useState<Input>(() => (draft ? (draft.input as Input) : serverInput));
  const same = (a: Input, b: Input) => JSON.stringify(a) === JSON.stringify(b);
  const synced = useRef<Input>(serverInput); // the stored value the text was last in step with
  const base = useRef(draft ? draft.base : client.baseOfField(entryId, syncField, kind));
  const gen = useRef(client.generationFor(draft)); // the epoch count the base was read under; refreshed only where the base is
  const latestServer = useRef(serverInput); latestServer.current = serverInput;
  const latestInput = useRef(input); latestInput.current = input;
  const status = cstate.fields.get(key);

  // While this field is on screen, the client can read its unsent text: it holds it on this device when the epoch changes or the session ends.
  useEffect(() => {
    client.registerFieldKeeper(key, () => (same(latestInput.current, synced.current) ? undefined : { entryId, field: syncField, input: latestInput.current, base: base.current }));
    return () => client.registerFieldKeeper(key, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  // The stored value changed (a poll): follow it only if the author has not changed the text meanwhile.
  useEffect(() => {
    if (same(synced.current, serverInput)) return;
    if (same(latestInput.current, synced.current) && !client.draftFor(key)) { setInput(serverInput); base.current = client.baseOfField(entryId, syncField, kind); gen.current = client.generation; }
    synced.current = serverInput;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(serverInput)]);

  return { key, kind, input, setInput, base, gen, synced, status, draft, latestInput, latestServer, same };
}

type Encode = (input: Input) => { ok: true; value: unknown } | { ok: false; message: string };

function useSaver(client: SyncClient, entry: Rec, syncField: string, h: ReturnType<typeof useField>, encode: Encode) {
  async function save(next: Input = h.latestInput.current, freshBase = false): Promise<void> {
    if (freshBase) { h.base.current = client.baseOfField(entry.id, syncField, h.kind); h.gen.current = client.generation; }
    if (h.same(next, h.synced.current) && !client.draftFor(h.key)) { client.clearFieldStatus(h.key); return; } // nothing changed
    const enc = encode(next);
    const p = { entryId: entry.id, field: syncField, input: next, base: h.base.current, kind: h.kind };
    const gen = h.gen.current;
    const out = enc.ok ? await client.saveEntryField({ ...p, gen, value: enc.value }) : await client.holdField({ ...p, gen }, enc.message);
    if (out.kind === "saved" || out.kind === "nothing") {
      // Show what the server now holds (it may differ in spacing), unless the author has typed again meanwhile.
      if (h.same(h.latestInput.current, next)) h.setInput(h.latestServer.current);
      h.synced.current = h.latestServer.current;
      h.base.current = client.baseOfField(entry.id, syncField, h.kind);
    }
  }
  function change(next: Input, saveAtOnce: boolean): void {
    h.setInput(next);
    if (h.status && h.status.state !== "saving") client.clearFieldStatus(h.key);
    if (saveAtOnce) void save(next);
  }
  async function useSaved(): Promise<void> {
    await client.discardDraft(h.key);
    h.setInput(h.latestServer.current);
    h.synced.current = h.latestServer.current;
    h.base.current = client.baseOfField(entry.id, syncField, h.kind);
    h.gen.current = client.generation;
  }
  return { save, change, useSaved };
}

/** The line under a field: what is going on with its saving, and what the author can do. */
function FieldStatusLine({ id, h, onSaveNow, onKeepMine, onUseSaved }: {
  id: string; h: ReturnType<typeof useField>; onSaveNow: () => void; onKeepMine: () => void; onUseSaved: () => void;
}) {
  const st = h.status;
  const draft = h.draft;
  // Text that cannot be saved as it is: the author may need to give it up, not only fix it.
  const refused = !!draft && draft.state === "refused" || st?.state === "invalid" || st?.state === "refused";
  let text = "", tone: "ok" | "warn" | "" = "", conflict = false, saveNow = false;
  if (st) {
    if (st.state === "saving") text = "Saving";
    else if (st.state === "saved") { text = "Saved"; tone = "ok"; }
    else if (st.state === "unsaved") { text = st.message ?? ""; tone = "warn"; saveNow = true; }
    else if (st.state === "conflict") { text = st.message ?? ""; tone = "warn"; conflict = true; }
    else { text = st.message ?? ""; tone = "warn"; }
  } else if (draft && !h.same(h.input, h.synced.current)) {
    // From an earlier visit: the text was kept on this device.
    if (draft.state === "conflict") { text = draft.reason === HISTORY_REASON ? HISTORY_MESSAGE : "This was changed on another device. Your text is kept on this device. Choose which text to keep."; conflict = true; }
    else { text = "Not saved yet. Your text is kept on this device."; saveNow = true; }
    tone = "warn";
  }
  return (
    <div className="field__status" id={id}>
      <p role="status" className="field__line">{tone === "warn" ? "" : text}</p>
      {tone === "warn" && <p role="alert" className="field__line field__line--warn">{text}</p>}
      {conflict && (
        <div className="entry__actions">
          <button type="button" className="btn btn--primary" onClick={onKeepMine}>Keep my text</button>
          <button type="button" className="btn btn--wood" onClick={onUseSaved}>Use the saved text</button>
        </div>
      )}
      {saveNow && <button type="button" className="btn btn--wood" onClick={onSaveNow}>Save now</button>}
      {refused && <button type="button" className="btn btn--wood" onClick={onUseSaved}>Discard my text</button>}
    </div>
  );
}

function TopTextField({ client, cstate, entry, field, label, area, hint }: {
  client: SyncClient; cstate: ClientState; entry: Rec; field: TopField; label: string; area?: boolean; hint?: string;
}) {
  const id = useId();
  const h = useField(client, cstate, entry.id, field, topInputOf(field, entry));
  const s = useSaver(client, entry, field, h, (i) => ({ ok: true, value: encodeTop(field, String(i)) }));
  const common = {
    id, value: String(h.input), "aria-describedby": `${id}-status${hint ? ` ${id}-hint` : ""}`,
    onChange: (e: { target: { value: string } }) => s.change(e.target.value, false), onBlur: () => { void s.save(); },
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
      {area ? <textarea rows={field === "summary" ? 4 : 3} {...common} /> : <input autoComplete="off" {...common} />}
      <FieldStatusLine id={`${id}-status`} h={h} onSaveNow={() => void s.save()} onKeepMine={() => void s.save(undefined, true)} onUseSaved={() => void s.useSaved()} />
    </div>
  );
}

function ToBeNamed({ client, cstate, entry }: { client: SyncClient; cstate: ClientState; entry: Rec }) {
  const id = useId();
  const h = useField(client, cstate, entry.id, "toBeNamed", entry.toBeNamed === true ? "yes" : "");
  const s = useSaver(client, entry, "toBeNamed", h, (i) => ({ ok: true, value: i === "yes" ? true : undefined }));
  return (
    <div className="field">
      <div className="check">
        <input id={id} type="checkbox" checked={h.input === "yes"} aria-describedby={`${id}-status`} onChange={(e) => s.change(e.target.checked ? "yes" : "", true)} />
        <label htmlFor={id}>No name yet (to be named)</label>
      </div>
      <FieldStatusLine id={`${id}-status`} h={h} onSaveNow={() => void s.save()} onKeepMine={() => void s.save(undefined, true)} onUseSaved={() => void s.useSaved()} />
    </div>
  );
}

const TEXT_KINDS = new Set(["shortText", "longText", "integer", "decimal", "realDate", "fictionalDate"]);
const HINTS: Record<string, string> = {
  integer: "A whole number, such as 24.", decimal: "A number with a point, such as 1.68.", realDate: "Year-month-day, such as 2000-02-29.",
  fictionalDate: "The date as the story writes it, such as Third Moon, Year 388.",
};

/** The control for one value of a template field (text, number, date, yes or no, choices, an entry). Used by entries and by state changes. */
interface ControlProps {
  def: FieldDef; id: string; label: string; input: Input; onChange: (next: Input, saveAtOnce: boolean) => void; onBlur: () => void;
  describedBy: string; hint: ReactNode; status: ReactNode; client: SyncClient; bookId: string | undefined; stored?: unknown; notSet?: string;
}

function FieldControl({ def, id, label, input, onChange, onBlur, describedBy, hint, status, client, bookId, stored, notSet = "Not set" }: ControlProps) {
  const m = client.model;
  if (TEXT_KINDS.has(def.fieldType)) {
    const common = { id, value: String(input), "aria-describedby": describedBy, onChange: (e: { target: { value: string } }) => onChange(e.target.value, false), onBlur };
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>{hint}
        {def.fieldType === "longText" ? <textarea rows={5} {...common} /> : <input autoComplete="off" inputMode={def.fieldType === "integer" ? "numeric" : "text"} {...common} />}
        {status}
      </div>
    );
  }
  if (def.fieldType === "boolean") {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>{hint}
        <select id={id} value={String(input)} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value, true)}>
          <option value="">{notSet}</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
        {status}
      </div>
    );
  }
  if (def.fieldType === "selection" && def.multiple) {
    const chosen = Array.isArray(input) ? input : [];
    return (
      <fieldset className="field field--group" aria-describedby={describedBy}>
        <legend>{label}</legend>{hint}
        {def.options.map((o) => (
          <div className="check" key={o.id}>
            <input id={`${id}-${o.id}`} type="checkbox" checked={chosen.includes(o.id)}
              onChange={(e) => onChange(def.options.map((x) => x.id).filter((x) => (x === o.id ? e.target.checked : chosen.includes(x))), true)} />
            <label htmlFor={`${id}-${o.id}`}>{o.label}</label>
          </div>
        ))}
        {status}
      </fieldset>
    );
  }
  if (def.fieldType === "selection") {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>{hint}
        <select id={id} value={String(input)} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value, true)}>
          <option value="">{notSet}</option>
          {def.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {status}
      </div>
    );
  }
  // entryReference
  const target = def.targetEntryTypes.length > 0 ? def.targetEntryTypes : ["character", "location", "term", "organization", "object", "event", "plotline", "worldRule", "research"];
  const options = entriesOfType(m, target, bookId);
  const have = typeof stored === "string" ? stored : "";
  const missing = have !== "" && !options.some((o) => o.id === have);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>{hint}
      <select id={id} value={String(input)} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value, true)}>
        <option value="">{notSet}</option>
        {missing && <option value={have}>{String(m.records.get("entry")?.get(have)?.name ?? "An entry that is not in the library")}</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{String(o.name)}</option>)}
      </select>
      {status}
    </div>
  );
}

function TemplateField({ client, cstate, entry, def, bookId }: { client: SyncClient; cstate: ClientState; entry: Rec; def: FieldDef; bookId: string | undefined }) {
  const m = client.model;
  const values = (entry.values ?? {}) as Record<string, unknown>;
  const current = values[def.id];
  const syncField = `values/${def.id}`;
  const id = useId();
  const h = useField(client, cstate, entry.id, syncField, inputOf(def, current));
  const s = useSaver(client, entry, syncField, h, (i) => encodeInput(def, i, (entry.values as Record<string, unknown> | undefined)?.[def.id]));
  const status = <FieldStatusLine id={`${id}-status`} h={h} onSaveNow={() => void s.save()} onKeepMine={() => void s.save(undefined, true)} onUseSaved={() => void s.useSaved()} />;
  const describedBy = `${id}-status${HINTS[def.fieldType] ? ` ${id}-hint` : ""}`;
  const hint = HINTS[def.fieldType] ? <p className="hint" id={`${id}-hint`}>{HINTS[def.fieldType]}</p> : null;

  if (STATE_FIELD_TYPES.has(def.fieldType)) {
    return (
      <FieldControl def={def} id={id} label={def.label} input={h.input} onChange={(n, now) => s.change(n, now)} onBlur={() => { void s.save(); }}
        describedBy={describedBy} hint={hint} status={status} client={client} bookId={bookId} stored={current} />
    );
  }
  // attachment, entryReferences and table are shown, not edited, in this version
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span className="field__label" id={id}>{def.label}</span>
      <p className="entry__readonly">{readOnlyText(m, def, current)}</p>
      <p className="hint">Shown here only. It cannot be changed in the web studio yet.</p>
    </div>
  );
}

// ---------- facts and questions (slice 2) ----------

const STORY_COPY: Record<StoryKind, { noun: string; hint: string; textHint: string }> = {
  fact: { noun: "fact", hint: "Something the story must stay consistent with, or a secret. You can fill in the details after it is made.", textHint: "Write it as plain text, for example: The bridge is closed after dark." },
  question: { noun: "question", hint: "Something the story has not settled yet. You can add a topic, and later the decision, after it is made.", textHint: "Write it as plain text, for example: Who sent the letter?" },
};

function NewStoryRecord({ client, kind, bookId, onCreated, onCancel }: { client: SyncClient; kind: StoryKind; bookId: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; id: string; opId: string; created?: boolean; lost?: boolean } | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const textId = useId(), hintId = useId(), errId = useId();
  const copy = STORY_COPY[kind];
  useEffect(() => { heading.current?.focus(); }, []);

  async function create() {
    if (busy) return;
    setBusy(true); setError(undefined);
    // The same id and op id are used again only for the same text, so a lost answer is a safe retry.
    const key = text.trim();
    if (attempt.current?.key !== key) attempt.current = { key, id: newId(), opId: newId() };
    const out = await client.createStoryRecord({ ...attempt.current, kind, text, bookId });
    setBusy(false);
    if (out.ok) { attempt.current = undefined; onCreated(out.id); return; }
    if (!out.lost) attempt.current = undefined;
    setError(out.message);
  }

  return (
    <section className="card page" aria-labelledby="entry-title">
      <div className="page__body">
        <h2 id="entry-title" className="page__title" tabIndex={-1} ref={heading}>New {copy.noun}</h2>
        <p className="hint">{copy.hint}</p>
        <form className="entry__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="field">
            <label htmlFor={textId}>Text</label>
            <p className="hint" id={hintId}>{copy.textHint}</p>
            <textarea id={textId} rows={4} value={text} onChange={(e) => { setText(e.target.value); setError(undefined); }} aria-describedby={`${hintId} ${errId}`} />
          </div>
          <p id={errId} role="alert" className="error">{error}</p>
          <div className="entry__actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Creating…" : `Create ${copy.noun}`}</button>
            <button type="button" className="btn btn--wood" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </section>
  );
}

function StoryRecordView({ client, cstate, kind, recordId, bookId }: { client: SyncClient; cstate: ClientState; kind: StoryKind; recordId: string; bookId: string | undefined }) {
  const m = client.model;
  const rec = m.records.get(kind)?.get(recordId);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const noun = STORY_COPY[kind].noun;
  if (!rec || rec.deletedAt) {
    return (
      <section className="card page page--empty" aria-labelledby="bible-title">
        <h2 id="bible-title">This {noun} is gone</h2>
        <p>{rec ? "It is in the trash." : "It is not in the library any more."}</p>
        {client.hasDraftsFor(recordId) && <p role="status">Text you typed here is kept on this device.</p>}
      </section>
    );
  }
  const f = (field: RecordField) => ({ client, cstate, rec, kind, field });
  return (
    <section className="card page" aria-labelledby="entry-title">
      <div className="page__body">
        <h2 id="entry-title" className="page__title" tabIndex={-1} ref={heading}>{shortSummary(rec.text, 70) || `No ${noun} text`}</h2>
        <p className="entry__type">{noun === "fact" ? "Fact" : "Question"}</p>
        <p className="hint" id="entry-scope">{scopeSentence(m, rec, noun)}</p>
        <form className="entry__form" onSubmit={(e) => e.preventDefault()} aria-describedby="entry-scope">
          <RecordText {...f("text")} label="Text" area rows={5} hint={`Plain text, up to ${TEXT_MAX.toLocaleString("en-US")} characters.`} />
          {kind === "fact" && <RecordSelect {...f("truth")} label="Truth" options={FACT_TRUTH.map(([v, l]) => ({ id: v, label: l }))} required
            hint="False means characters are told or believe it, but it is not so." />}
          {kind === "question" && <RecordText {...f("topic")} label="Topic" hint={`A short label to group questions, up to ${TOPIC_MAX} characters.`} />}
          {kind === "question" && <RecordSelect {...f("status")} label="Status" options={QUESTION_STATUS.map(([v, l]) => ({ id: v, label: l }))} required />}
          {kind === "question" && <RecordText {...f("decision")} label="Decision" area rows={4} hint={`The answer, once the question is decided. Up to ${TEXT_MAX.toLocaleString("en-US")} characters.`} />}
          <RecordNode {...f("nodeId")} label={kind === "fact" ? "Scene where it is established" : "Scene to decide it by"} />
          <RecordLinks {...f("entryIds")} label="About these entries" bookId={bookId} />
          {kind === "fact" && <RecordLinks {...f("knowledge")} label="Who knows it" bookId={bookId} hint="The reader or characters who know this fact. A scene where someone learns it is kept if it was set elsewhere, but cannot be changed here yet." />}
        </form>
      </div>
    </section>
  );
}

interface RecordProps { client: SyncClient; cstate: ClientState; rec: Rec; kind: StoryKind; field: RecordField; label: string; hint?: string }

/** The save state and the saver of one field of a fact or a question. */
function useRecordField(p: RecordProps, serverInput: Input) {
  const h = useField(p.client, p.cstate, p.rec.id, p.field, serverInput, p.kind);
  const s = useSaver(p.client, p.rec, p.field, h, (i) => encodeRecordInput(p.field, i, p.rec[p.field]));
  const id = useId();
  const status = <FieldStatusLine id={`${id}-status`} h={h} onSaveNow={() => void s.save()} onKeepMine={() => void s.save(undefined, true)} onUseSaved={() => void s.useSaved()} />;
  const describedBy = `${id}-status${p.hint ? ` ${id}-hint` : ""}`;
  const hint = p.hint ? <p className="hint" id={`${id}-hint`}>{p.hint}</p> : null;
  return { h, s, id, status, describedBy, hint };
}

function RecordText(p: RecordProps & { area?: boolean; rows?: number }) {
  const { h, s, id, status, describedBy, hint } = useRecordField(p, recordInputOf(p.field, p.rec));
  const common = { id, value: String(h.input), "aria-describedby": describedBy, onChange: (e: { target: { value: string } }) => s.change(e.target.value, false), onBlur: () => { void s.save(); } };
  return (
    <div className="field">
      <label htmlFor={id}>{p.label}</label>{hint}
      {p.area ? <textarea rows={p.rows ?? 3} {...common} /> : <input autoComplete="off" {...common} />}
      {status}
    </div>
  );
}

function RecordSelect(p: RecordProps & { options: Array<{ id: string; label: string }>; required?: boolean }) {
  const { h, s, id, status, describedBy, hint } = useRecordField(p, recordInputOf(p.field, p.rec));
  return (
    <div className="field">
      <label htmlFor={id}>{p.label}</label>{hint}
      <select id={id} value={String(h.input)} aria-describedby={describedBy} onChange={(e) => s.change(e.target.value, true)}>
        {!p.required && <option value="">Not set</option>}
        {p.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {status}
    </div>
  );
}

/** A chapter or scene in the books of the record's scope. */
function RecordNode(p: RecordProps) {
  const have = typeof p.rec.nodeId === "string" ? p.rec.nodeId : "";
  const options = nodesInScope(p.client.model, p.rec.scope);
  const missing = have !== "" && !options.some((o) => o.id === have);
  return <RecordSelect {...p} options={[...(missing ? [{ id: have, label: "A scene that is not available" }] : []), ...options]} />;
}

/** Entries chosen with checkboxes. The whole list is sent each time (the server sets an array whole). */
function RecordLinks(p: RecordProps & { bookId: string | undefined }) {
  const m = p.client.model;
  const { h, s, id, status, describedBy, hint } = useRecordField(p, recordInputOf(p.field, p.rec));
  const chosen = Array.isArray(h.input) ? h.input : [];
  const isKnow = p.field === "knowledge";
  const entries = entriesOfType(m, isKnow ? ["character"] : ENTRY_TYPES_FOR_LINKS, p.bookId);
  const options = [
    ...(isKnow ? [{ id: "reader", label: "The reader" }] : []),
    ...entries.map((e) => ({ id: e.id, label: isKnow ? String(e.name) || "No name" : `${String(e.name) || "No name"} (${entryNoun(String(e.entryType))})` })),
  ];
  // Something already chosen that this book cannot list (another scope, or trashed) stays visible so it can be unchecked.
  for (const c of chosen) if (!options.some((o) => o.id === c)) options.push({ id: c, label: `${String(m.records.get("entry")?.get(c)?.name ?? "An entry that is not in the library")} (not listed for this book)` });
  const order = options.map((o) => o.id);
  return (
    <fieldset className="field field--group" aria-describedby={describedBy}>
      <legend>{p.label}</legend>
      {hint}
      {options.length === 0 && <p className="hint">There are no entries to choose from yet.</p>}
      {options.map((o) => (
        <div className="check" key={o.id}>
          <input id={`${id}-${o.id}`} type="checkbox" checked={chosen.includes(o.id)}
            onChange={(e) => s.change(order.filter((x) => (x === o.id ? e.target.checked : chosen.includes(x))), true)} />
          <label htmlFor={`${id}-${o.id}`}>{o.label}</label>
        </div>
      ))}
      {status}
    </fieldset>
  );
}

// ---------- the timeline: events (slice 3) ----------

function NewEvent({ client, bookId, onCreated, onCancel }: { client: SyncClient; bookId: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; id: string; opId: string; created?: boolean; lost?: boolean } | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId(), hintId = useId(), errId = useId();
  useEffect(() => { heading.current?.focus(); }, []);

  async function create() {
    if (busy) return;
    setBusy(true); setError(undefined);
    // The same id and op id are used again only for the same title, so a lost answer is a safe retry.
    const key = title.trim();
    if (attempt.current?.key !== key) attempt.current = { key, id: newId(), opId: newId() };
    const out = await client.createEvent({ ...attempt.current, title, bookId });
    setBusy(false);
    if (out.ok) { attempt.current = undefined; onCreated(out.id); return; }
    if (!out.lost) attempt.current = undefined;
    setError(out.message);
  }

  return (
    <section className="card page" aria-labelledby="entry-title">
      <div className="page__body">
        <h2 id="entry-title" className="page__title" tabIndex={-1} ref={heading}>New event</h2>
        <p className="hint">An event is something that happens in the story. It is made for the current book. You can add the date, scenes and people after it is made.</p>
        <form className="entry__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="field">
            <label htmlFor={titleId}>Title</label>
            <p className="hint" id={hintId}>For example: The storm breaks the bridge.</p>
            <input id={titleId} value={title} onChange={(e) => { setTitle(e.target.value); setError(undefined); }} autoComplete="off" aria-describedby={`${hintId} ${errId}`} />
          </div>
          <p id={errId} role="alert" className="error">{error}</p>
          <div className="entry__actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Creating…" : "Create event"}</button>
            <button type="button" className="btn btn--wood" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </section>
  );
}

/** The panel for an event or a state change that is in the trash or not in the library, with the way back when it is in the trash. */
function GonePanel({ client, kind, rec, noun, id }: { client: SyncClient; kind: "event" | "stateChange"; rec: Rec | undefined; noun: string; id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  async function back() {
    setBusy(true); setError(undefined);
    const out = await client.restoreRecord(kind, id);
    setBusy(false);
    if (!out.ok) setError(out.message);
  }
  return (
    <section className="card page page--empty" aria-labelledby="bible-title">
      <h2 id="bible-title" tabIndex={-1} ref={heading}>This {noun} is gone</h2>
      <p>{rec ? "It is in the trash." : "It is not in the library any more."}</p>
      {client.hasDraftsFor(id) && <p role="status">Text you typed here is kept on this device.</p>}
      {rec && <button type="button" className="btn btn--primary" onClick={() => { void back(); }} disabled={busy}>{busy ? "Putting it back…" : "Put it back"}</button>}
      <p role="alert" className="error">{error}</p>
    </section>
  );
}

function EventView({ client, cstate, eventId, bookId }: { client: SyncClient; cstate: ClientState; eventId: string; bookId: string | undefined }) {
  const m = client.model;
  const rec = m.records.get("event")?.get(eventId);
  const heading = useRef<HTMLHeadingElement>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | undefined>();
  useEffect(() => { heading.current?.focus(); }, []);
  if (!rec || rec.deletedAt) return <GonePanel client={client} kind="event" rec={rec} noun="event" id={eventId} />;
  const attached = [...(m.records.get("stateChange")?.values() ?? [])].filter((c) => c.eventId === rec.id && !c.deletedAt);
  async function remove() {
    setRemoving(true); setRemoveError(undefined);
    const out = await client.tombstoneRecord("event", eventId);
    setRemoving(false);
    if (!out.ok) setRemoveError(out.message);
  }
  return (
    <section className="card page" aria-labelledby="entry-title">
      <div className="page__body">
        <h2 id="entry-title" className="page__title" tabIndex={-1} ref={heading}>{eventTitle(rec)}</h2>
        <p className="entry__type">Event</p>
        <p className="hint" id="entry-scope">{scopeSentence(m, rec, "event")}</p>
        <form className="entry__form" onSubmit={(e) => e.preventDefault()} aria-describedby="entry-scope">
          <EventText client={client} cstate={cstate} rec={rec} field="title" label="Title" />
          <EventText client={client} cstate={cstate} rec={rec} field="summary" label="Summary" area />
          <EventWhen client={client} cstate={cstate} rec={rec} />
          <EventEntry client={client} cstate={cstate} rec={rec} bookId={bookId} />
          <EventScenes client={client} cstate={cstate} rec={rec} />
          <EventParticipants client={client} cstate={cstate} rec={rec} bookId={bookId} />
        </form>
        <section className="entry__form" aria-labelledby="event-changes">
          <h3 id="event-changes" className="entry__sub">State changes at this event</h3>
          {attached.length === 0 ? <p className="hint">None yet. Add a state change on an entry, and choose this event.</p> : (
            <ul className="bullets" aria-label="State changes at this event">
              {attached.map((c) => {
                const def = stateChangeDef(m, c);
                const entryName = String(m.records.get("entry")?.get(String(c.entryId))?.name ?? "An entry that is not in the library");
                return <li key={c.id}>{entryName}: {def?.label ?? "A field that is not in the template"} becomes {def ? valueLabel(m, def, c.value) : "a value that cannot be shown"}</li>;
              })}
            </ul>
          )}
          <div className="entry__actions">
            <button type="button" className="btn btn--wood" onClick={() => { void remove(); }} disabled={removing}>{removing ? "Removing…" : "Remove this event"}</button>
          </div>
          <p role="alert" className="error">{removeError}</p>
        </section>
      </div>
    </section>
  );
}

/** The save state and the saver of one field of an event or a state change. */
function useKindField(client: SyncClient, cstate: ClientState, rec: Rec, kind: "event" | "stateChange", field: string, serverInput: Input, encode: Encode, hintText?: string) {
  const h = useField(client, cstate, rec.id, field, serverInput, kind);
  const s = useSaver(client, rec, field, h, encode);
  const id = useId();
  const status = <FieldStatusLine id={`${id}-status`} h={h} onSaveNow={() => void s.save()} onKeepMine={() => void s.save(undefined, true)} onUseSaved={() => void s.useSaved()} />;
  const describedBy = `${id}-status${hintText ? ` ${id}-hint` : ""}`;
  const hint = hintText ? <p className="hint" id={`${id}-hint`}>{hintText}</p> : null;
  return { h, s, id, status, describedBy, hint };
}

interface EventProps { client: SyncClient; cstate: ClientState; rec: Rec }

function EventText({ client, cstate, rec, field, label, area }: EventProps & { field: "title" | "summary"; label: string; area?: boolean }) {
  const { h, s, id, status, describedBy } = useKindField(client, cstate, rec, "event", field, eventInputOf(field, rec), (i) => encodeEventInput(field, i));
  const common = { id, value: String(h.input), "aria-describedby": describedBy, onChange: (e: { target: { value: string } }) => s.change(e.target.value, false), onBlur: () => { void s.save(); } };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {area ? <textarea rows={4} {...common} /> : <input autoComplete="off" {...common} />}
      {status}
    </div>
  );
}

/** The date of an event: a label, a number for ordering, and a calendar. They are one value on the server, saved together. */
function EventWhen({ client, cstate, rec }: EventProps) {
  const { h, s, id, status, describedBy } = useKindField(client, cstate, rec, "event", "when", eventInputOf("when", rec), (i) => encodeEventInput("when", i));
  const parts = Array.isArray(h.input) ? h.input : ["", "", ""];
  const set = (i: number, v: string) => s.change([0, 1, 2].map((k) => (k === i ? v : (parts[k] ?? ""))), false);
  const rows: Array<[string, string, string]> = [
    ["Date label", "The date as the story writes it, such as Third Moon, Year 388.", "text"],
    ["Number for ordering", "A whole number, such as 388. It is only compared with other events that name the same calendar.", "numeric"],
    ["Calendar", "The name of the calendar the number belongs to. Without a calendar the number is not checked.", "text"],
  ];
  return (
    <fieldset className="field field--group" aria-describedby={describedBy}>
      <legend>When</legend>
      {rows.map(([label, hint, mode], i) => (
        <div className="field" key={label}>
          <label htmlFor={`${id}-${i}`}>{label}</label>
          <p className="hint" id={`${id}-hint-${i}`}>{hint}</p>
          <input id={`${id}-${i}`} autoComplete="off" inputMode={mode as "text" | "numeric"} value={parts[i] ?? ""} aria-describedby={`${id}-hint-${i} ${id}-status`}
            onChange={(e) => set(i, e.target.value)} onBlur={() => { void s.save(); }} />
        </div>
      ))}
      {status}
    </fieldset>
  );
}

/** The entry of type event this event is linked to, if any. */
function EventEntry({ client, cstate, rec, bookId }: EventProps & { bookId: string | undefined }) {
  const m = client.model;
  const { h, s, id, status, describedBy, hint } = useKindField(client, cstate, rec, "event", "entryId", eventInputOf("entryId", rec), (i) => encodeEventInput("entryId", i),
    "An entry of the type event, if you keep one for this. Most events do not need one.");
  const options = entriesOfType(m, ["event"], bookId);
  const have = typeof rec.entryId === "string" ? rec.entryId : "";
  const missing = have !== "" && !options.some((o) => o.id === have);
  return (
    <div className="field">
      <label htmlFor={id}>Linked entry</label>{hint}
      <select id={id} value={String(h.input)} aria-describedby={describedBy} onChange={(e) => s.change(e.target.value, true)}>
        <option value="">Not linked</option>
        {missing && <option value={have}>{String(m.records.get("entry")?.get(have)?.name ?? "An entry that is not in the library")}</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{String(o.name) || "No name"}</option>)}
      </select>
      {status}
    </div>
  );
}

/** The scenes of the event, with checkboxes. The whole list is sent each time (the server sets an array whole). */
function EventScenes({ client, cstate, rec }: EventProps) {
  const m = client.model;
  const { h, s, id, status, describedBy } = useKindField(client, cstate, rec, "event", "sceneIds", eventInputOf("sceneIds", rec), (i) => encodeEventInput("sceneIds", i));
  const chosen = Array.isArray(h.input) ? h.input : [];
  const options = nodesInScope(m, rec.scope, true);
  // A scene already chosen that cannot be listed (trashed, or in another scope) stays visible so it can be unchecked.
  for (const c of chosen) if (!options.some((o) => o.id === c)) options.push({ id: c, label: `${sceneName(m, c)} (not listed for this book)` });
  const order = options.map((o) => o.id);
  return (
    <fieldset className="field field--group" aria-describedby={describedBy}>
      <legend>Scenes</legend>
      {options.length === 0 && <p className="hint">This book has no scenes yet.</p>}
      {options.map((o) => (
        <div className="check" key={o.id}>
          <input id={`${id}-${o.id}`} type="checkbox" checked={chosen.includes(o.id)}
            onChange={(e) => s.change(order.filter((x) => (x === o.id ? e.target.checked : chosen.includes(x))), true)} />
          <label htmlFor={`${id}-${o.id}`}>{o.label}</label>
        </div>
      ))}
      {status}
    </fieldset>
  );
}

/** The entries that take part, each with an optional role. Nobody is listed twice. The whole list is sent each time. */
function EventParticipants({ client, cstate, rec, bookId }: EventProps & { bookId: string | undefined }) {
  const m = client.model;
  const { h, s, id, status, describedBy, hint } = useKindField(client, cstate, rec, "event", "participants", eventInputOf("participants", rec), (i) => encodeEventInput("participants", i),
    "Characters and other entries that take part. The role is optional, such as witness or victim.");
  const list = participantsOf(h.input);
  const nameOf = (entryId: string): string => String(m.records.get("entry")?.get(entryId)?.name ?? "An entry that is not in the library") || "No name";
  const free = entriesOfType(m, ENTRY_TYPES_FOR_LINKS, bookId).filter((e) => !list.some((p) => p.entryId === e.id));
  const write = (next: Array<{ entryId: string; role: string }>, now: boolean) => s.change(next.map((p) => participantItem(p.entryId, p.role)), now);
  return (
    <fieldset className="field field--group" aria-describedby={describedBy}>
      <legend>Participants</legend>{hint}
      {list.length === 0 && <p className="hint">Nobody is listed yet.</p>}
      {list.map((p, i) => (
        <div className="participant" key={p.entryId} role="group" aria-label={nameOf(p.entryId)}>
          <span className="participant__name">{nameOf(p.entryId)}</span>
          <div className="field">
            <label htmlFor={`${id}-role-${p.entryId}`}>Role of {nameOf(p.entryId)}</label>
            <input id={`${id}-role-${p.entryId}`} autoComplete="off" value={p.role} aria-describedby={`${id}-status`}
              onChange={(e) => write(list.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)), false)} onBlur={() => { void s.save(); }} />
          </div>
          <button type="button" className="btn btn--wood" onClick={() => write(list.filter((_, k) => k !== i), true)}>Remove {nameOf(p.entryId)}</button>
        </div>
      ))}
      <div className="field">
        <label htmlFor={`${id}-add`}>Add a participant</label>
        <select id={`${id}-add`} value="" aria-describedby={`${id}-status`} onChange={(e) => { if (e.target.value) write([...list, { entryId: e.target.value, role: "" }], true); }}>
          <option value="">{free.length === 0 ? "No more entries to add" : "Choose an entry"}</option>
          {free.map((e) => <option key={e.id} value={e.id}>{`${String(e.name) || "No name"} (${entryNoun(String(e.entryType))})`}</option>)}
        </select>
      </div>
      {status}
    </fieldset>
  );
}

// ---------- state changes on an entry (slice 3) ----------

/** The value of a state change in plain words. */
function valueLabel(m: Model, def: FieldDef, v: unknown): string {
  switch (def.fieldType) {
    case "boolean": return v === true ? "Yes" : v === false ? "No" : "not set";
    case "selection": return Array.isArray(v) ? v.map((x) => def.options.find((o) => o.id === x)?.label ?? "an option that is gone").join(", ") : "";
    case "entryReference": return typeof v === "string" ? String(m.records.get("entry")?.get(v)?.name ?? "an entry that is not in the library") : "";
    case "fictionalDate": return typeof v === "object" && v !== null && typeof (v as { label?: unknown }).label === "string" ? (v as { label: string }).label : "";
    default: return typeof v === "string" || typeof v === "number" ? String(v) : "";
  }
}

const targetValue = (c: Rec | undefined): string => (typeof c?.eventId === "string" ? `event:${c.eventId}` : typeof c?.nodeId === "string" ? `node:${c.nodeId}` : "");
const targetOf = (v: string): { eventId: string } | { nodeId: string } | undefined =>
  v.startsWith("event:") ? { eventId: v.slice(6) } : v.startsWith("node:") ? { nodeId: v.slice(5) } : undefined;
const targetName = (m: Model, c: Rec): string =>
  typeof c.eventId === "string" ? `the event ${eventTitle(m.records.get("event")?.get(c.eventId))}` : `the scene ${sceneName(m, c.nodeId)}`;

/** Where a state change takes effect: an event of this book, or a chapter or scene in the entry's scope. */
function TargetSelect({ client, entry, bookId, id, value, onChange, describedBy, notSet }: {
  client: SyncClient; entry: Rec; bookId: string | undefined; id: string; value: string; onChange: (v: string) => void; describedBy?: string; notSet: string;
}) {
  const m = client.model;
  const events = eventsOf(m, bookId);
  const nodes = nodesInScope(m, entry.scope);
  const extraEvent = value.startsWith("event:") && !events.some((e) => `event:${e.id}` === value) ? value.slice(6) : undefined;
  const extraNode = value.startsWith("node:") && !nodes.some((n) => `node:${n.id}` === value) ? value.slice(5) : undefined;
  return (
    <select id={id} value={value} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)}>
      <option value="">{notSet}</option>
      <optgroup label="Events">
        {extraEvent && <option value={value}>{eventTitle(m.records.get("event")?.get(extraEvent))} (not listed for this book)</option>}
        {events.map((e) => <option key={e.id} value={`event:${e.id}`}>{eventTitle(e)}</option>)}
      </optgroup>
      <optgroup label="Scenes and chapters">
        {extraNode && <option value={value}>{sceneName(m, extraNode)} (not listed)</option>}
        {nodes.map((n) => <option key={n.id} value={`node:${n.id}`}>{n.label}</option>)}
      </optgroup>
    </select>
  );
}

function StateChanges({ client, cstate, entry, bookId }: { client: SyncClient; cstate: ClientState; entry: Rec; bookId: string | undefined }) {
  const m = client.model;
  const heading = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const live = stateChangesOf(m, entry.id);
  const removed = stateChangesOf(m, entry.id, true);
  const hasTemplate = typeof entry.templateId === "string" && m.records.get("template")?.has(entry.templateId);
  const done = (text: string) => { setError(undefined); setNotice(text); heading.current?.focus(); };
  const labelOf = (c: Rec): string => `${stateChangeDef(m, c)?.label ?? "A field that is not in the template"} at ${targetName(m, c)}`;
  return (
    <section className="entry__form" aria-labelledby="state-changes-title">
      <h3 id="state-changes-title" className="entry__sub" tabIndex={-1} ref={heading}>State changes</h3>
      {!hasTemplate ? <p className="hint">This entry has no template, so it cannot have state changes.</p> : (
        <>
          <p className="hint">A state change says that a detail of this entry changes at an event or in a scene, such as a new eye colour or a new home.</p>
          <p role="status" className="field__line">{notice}</p>
          {live.length === 0 && <p className="hint">No state changes yet.</p>}
          {live.map((c) => (
            <StateChangeRow key={c.id} client={client} cstate={cstate} entry={entry} change={c} bookId={bookId} label={labelOf(c)}
              onDone={done} onError={setError} />
          ))}
          <p role="alert" className="error">{error}</p>
          <AddStateChange client={client} entry={entry} bookId={bookId} onDone={done} />
          {removed.length > 0 && (
            <>
              <h4 className="entry__sub">Removed state changes</h4>
              <ul className="bullets" aria-label="Removed state changes">
                {removed.map((c) => (
                  <li key={c.id}>
                    {labelOf(c)}{" "}
                    <button type="button" className="btn btn--wood" onClick={() => { void client.restoreRecord("stateChange", c.id).then((out) => (out.ok ? done("State change put back.") : setError(out.message))); }}>
                      Put back {labelOf(c)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function StateChangeRow({ client, cstate, entry, change, bookId, label, onDone, onError }: {
  client: SyncClient; cstate: ClientState; entry: Rec; change: Rec; bookId: string | undefined; label: string; onDone: (text: string) => void; onError: (m: string | undefined) => void;
}) {
  const m = client.model;
  const def = stateChangeDef(m, change);
  const legendId = useId(), atId = useId();
  const [busy, setBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | undefined>();
  const attempt = useRef<{ key: string; id: string; opId: string; created?: boolean; lost?: boolean } | undefined>(undefined);
  const current = targetValue(change);

  async function move(v: string) {
    const target = targetOf(v);
    if (!target || v === current || busy) return;
    const next = nextMoveAttempt(attempt.current, v, newId);
    if (!next.ok) { setMoveError(next.message); return; }
    setBusy(true); setMoveError(undefined); onError(undefined);
    // The same new id and op id only for the same target, so a lost answer is a safe retry.
    attempt.current = next.attempt;
    const out = await client.moveStateChange({ id: attempt.current.id, opId: attempt.current.opId, created: attempt.current.created, oldId: change.id, target });
    setBusy(false);
    if (out.ok) { attempt.current = undefined; onDone("State change moved."); return; }
    // Only a definitive outcome clears the attempt; otherwise it keeps what it knew, so no second copy is made.
    attempt.current = attemptAfterFailedMove(attempt.current, out);
    setMoveError(out.message);
  }
  async function remove() {
    setBusy(true); onError(undefined);
    const out = await client.tombstoneRecord("stateChange", change.id);
    setBusy(false);
    if (out.ok) onDone("State change removed."); else onError(out.message);
  }

  return (
    <fieldset className="field field--group statechange" aria-labelledby={legendId}>
      <legend id={legendId}>{label}</legend>
      {def ? <StateValue client={client} cstate={cstate} change={change} def={def} bookId={bookId} /> : <p className="hint">This field is not in the entry's template any more, so its value cannot be changed here.</p>}
      <StateNote client={client} cstate={cstate} change={change} />
      <div className="field">
        <label htmlFor={atId}>Changes at</label>
        <TargetSelect client={client} entry={entry} bookId={bookId} id={atId} value={current} onChange={(v) => { void move(v); }} describedBy={`${atId}-line`} notSet="Choose an event or scene" />
        <p id={`${atId}-line`} role="status" className={moveError ? "field__line field__line--warn" : "field__line"}>{busy ? "Working" : moveError}</p>
      </div>
      <div className="entry__actions">
        <button type="button" className="btn btn--wood" disabled={busy} onClick={() => { void remove(); }}>Remove {label}</button>
      </div>
    </fieldset>
  );
}

function StateValue({ client, cstate, change, def, bookId }: { client: SyncClient; cstate: ClientState; change: Rec; def: FieldDef; bookId: string | undefined }) {
  const { h, s, id, status, describedBy, hint } = useKindField(client, cstate, change, "stateChange", "value", inputOf(def, change.value), (i) => encodeInput(def, i, change.value), HINTS[def.fieldType]);
  if (!STATE_FIELD_TYPES.has(def.fieldType)) return <p className="entry__readonly">{valueLabel(client.model, def, change.value)}</p>;
  return <FieldControl def={def} id={id} label="Value" input={h.input} onChange={(n, now) => s.change(n, now)} onBlur={() => { void s.save(); }}
    describedBy={describedBy} hint={hint} status={status} client={client} bookId={bookId} stored={change.value} notSet="Choose a value" />;
}

function StateNote({ client, cstate, change }: { client: SyncClient; cstate: ClientState; change: Rec }) {
  const { h, s, id, status, describedBy } = useKindField(client, cstate, change, "stateChange", "note", typeof change.note === "string" ? change.note : "",
    (i) => { const t = String(i).trim(); return { ok: true, value: t === "" ? undefined : t }; });
  return (
    <div className="field">
      <label htmlFor={id}>Note</label>
      <textarea id={id} rows={3} value={String(h.input)} aria-describedby={describedBy} onChange={(e) => s.change(e.target.value, false)} onBlur={() => { void s.save(); }} />
      {status}
    </div>
  );
}

function AddStateChange({ client, entry, bookId, onDone }: { client: SyncClient; entry: Rec; bookId: string | undefined; onDone: (text: string) => void }) {
  const m = client.model;
  const defs = fieldsOf(m, entry.templateId).filter((f) => STATE_FIELD_TYPES.has(f.fieldType));
  const [fieldId, setFieldId] = useState("");
  const [target, setTarget] = useState("");
  const [input, setInput] = useState<Input>("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; id: string; opId: string; created?: boolean; lost?: boolean } | undefined>(undefined);
  const fieldSel = useId(), targetSel = useId(), noteId = useId(), valueId = useId(), errId = useId();
  const def = defs.find((f) => f.id === fieldId);
  const touch = () => setError(undefined);

  async function add() {
    if (busy) return;
    setBusy(true); setError(undefined);
    const key = JSON.stringify([fieldId, target, input, note.trim()]);
    if (attempt.current?.key !== key) attempt.current = { key, id: newId(), opId: newId() };
    const out = await client.createStateChange({ ...attempt.current, entryId: entry.id, fieldId, input, note, target: targetOf(target) });
    setBusy(false);
    if (out.ok) {
      attempt.current = undefined;
      setFieldId(""); setTarget(""); setInput(""); setNote("");
      onDone("State change added.");
      return;
    }
    if (!out.lost) attempt.current = undefined;
    setError(out.message);
  }

  return (
    <fieldset className="field field--group addchange" aria-describedby={errId}>
      <legend>Add a state change</legend>
      {defs.length === 0 ? <p className="hint">This entry's template has no field a state change can use.</p> : (
        <>
          <div className="field">
            <label htmlFor={fieldSel}>Field</label>
            <select id={fieldSel} value={fieldId} onChange={(e) => { const d = defs.find((f) => f.id === e.target.value); setFieldId(e.target.value); setInput(d?.fieldType === "selection" && d.multiple ? [] : ""); touch(); }}>
              <option value="">Choose a field</option>
              {defs.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
          {def && <FieldControl key={def.id} def={def} id={valueId} label="Value" input={input} onChange={(n) => { setInput(n); touch(); }} onBlur={() => {}}
            describedBy={HINTS[def.fieldType] ? `${valueId}-hint` : ""} hint={HINTS[def.fieldType] ? <p className="hint" id={`${valueId}-hint`}>{HINTS[def.fieldType]}</p> : null}
            status={null} client={client} bookId={bookId} notSet="Choose a value" />}
          <div className="field">
            <label htmlFor={targetSel}>Changes at</label>
            <TargetSelect client={client} entry={entry} bookId={bookId} id={targetSel} value={target} onChange={(v) => { setTarget(v); touch(); }} notSet="Choose an event or scene" />
          </div>
          <div className="field">
            <label htmlFor={noteId}>Note</label>
            <textarea id={noteId} rows={2} value={note} onChange={(e) => { setNote(e.target.value); touch(); }} />
          </div>
          <p id={errId} role="alert" className="error">{error}</p>
          <div className="entry__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => { void add(); }}>{busy ? "Adding…" : "Add state change"}</button>
          </div>
        </>
      )}
    </fieldset>
  );
}

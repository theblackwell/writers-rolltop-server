// The story bible in the studio, slice 1 (M1-10): characters, places and terms. The list sits in the left panel; an
// entry opens in the centre. Every field saves when the author leaves it (a choice saves when it is chosen), and shows
// "Saved" only after the server has answered. Text the server has not confirmed stays on this device.
import { useEffect, useId, useRef, useState } from "react";
import { HISTORY_MESSAGE, HISTORY_REASON } from "./sync/client.ts";
import type { ClientState, SyncClient } from "./sync/client.ts";
import { newId } from "./editor/rolltop-editor.ts";
import type { Rec } from "./sync/model.ts";
import {
  encodeInput, encodeTop, entriesOfType, entryNoun, entryNounCap, fieldsOf, inputOf, readOnlyText, scopeSentence, shortSummary, topInputOf,
} from "./sync/bible.ts";
import type { EntryType, FieldDef, Input, TopField } from "./sync/bible.ts";

export type BibleSection = "Characters" | "Worldbuilding";
export type BibleView = { kind: "entry"; id: string } | { kind: "new"; type: EntryType } | undefined;

const SECTION_TYPES: Record<BibleSection, EntryType[]> = { Characters: ["character"], Worldbuilding: ["location", "term"] };
const PLURAL: Record<string, string> = { character: "Characters", location: "Places", term: "Terms" };

// ---------- the left panel ----------

interface ListProps {
  client: SyncClient; cstate: ClientState; section: BibleSection; bookId: string | undefined;
  view: BibleView; onOpen: (id: string) => void; onNew: (type: EntryType) => void;
}

export function BibleList({ client, cstate, section, bookId, view, onOpen, onNew }: ListProps) {
  void cstate.version; // the list is read again whenever the model changes
  if (!bookId) return <><h2 className="outline__title">{section}</h2><p className="hint">Make a book first. Entries belong to a book, a series or a universe.</p></>;
  if (cstate.bible !== "ready") return <><h2 className="outline__title">{section}</h2><SetupNotice client={client} cstate={cstate} /></>;
  const types = SECTION_TYPES[section];
  return (
    <>
      <h2 className="outline__title">{section}</h2>
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
                    <button type="button" className="biblelist__item" aria-current={view?.kind === "entry" && view.id === e.id ? "true" : undefined} onClick={() => onOpen(e.id)}>
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
    </>
  );
}

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
  onCreated: (id: string) => void; onCancel: () => void;
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
  if (view?.kind === "new" && bookId) return <NewEntry key={view.type} client={client} type={view.type} bookId={bookId} onCreated={onCreated} onCancel={onCancel} />;
  if (view?.kind === "entry") return <EntryView key={view.id} client={client} cstate={cstate} entryId={view.id} bookId={bookId} />;
  return (
    <section className="card page page--empty" aria-labelledby="bible-title">
      <h2 id="bible-title">{section}</h2>
      <p>{section === "Characters" ? "Choose a character on the left, or create a new one." : "Choose a place or a term on the left, or create a new one."}</p>
    </section>
  );
}

function NewEntry({ client, type, bookId, onCreated, onCancel }: { client: SyncClient; type: EntryType; bookId: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [toBeNamed, setToBeNamed] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; id: string; opId: string } | undefined>(undefined);
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
      </div>
    </section>
  );
}

/** The save state of one field and its controls: the same for every kind of field. */
function useField(client: SyncClient, cstate: ClientState, entryId: string, syncField: string, serverInput: Input) {
  const key = `${entryId}/${syncField}`;
  const draft = client.draftFor(key);
  const [input, setInput] = useState<Input>(() => (draft ? (draft.input as Input) : serverInput));
  const same = (a: Input, b: Input) => JSON.stringify(a) === JSON.stringify(b);
  const synced = useRef<Input>(serverInput); // the stored value the text was last in step with
  const base = useRef(draft ? draft.base : client.baseOfField(entryId, syncField));
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
    if (same(latestInput.current, synced.current) && !client.draftFor(key)) { setInput(serverInput); base.current = client.baseOfField(entryId, syncField); gen.current = client.generation; }
    synced.current = serverInput;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(serverInput)]);

  return { key, input, setInput, base, gen, synced, status, draft, latestInput, latestServer, same };
}

type Encode = (input: Input) => { ok: true; value: unknown } | { ok: false; message: string };

function useSaver(client: SyncClient, entry: Rec, syncField: string, h: ReturnType<typeof useField>, encode: Encode) {
  async function save(next: Input = h.latestInput.current, freshBase = false): Promise<void> {
    if (freshBase) { h.base.current = client.baseOfField(entry.id, syncField); h.gen.current = client.generation; }
    if (h.same(next, h.synced.current) && !client.draftFor(h.key)) { client.clearFieldStatus(h.key); return; } // nothing changed
    const enc = encode(next);
    const p = { entryId: entry.id, field: syncField, input: next, base: h.base.current };
    const gen = h.gen.current;
    const out = enc.ok ? await client.saveEntryField({ ...p, gen, value: enc.value }) : await client.holdField({ ...p, gen }, enc.message);
    if (out.kind === "saved" || out.kind === "nothing") {
      // Show what the server now holds (it may differ in spacing), unless the author has typed again meanwhile.
      if (h.same(h.latestInput.current, next)) h.setInput(h.latestServer.current);
      h.synced.current = h.latestServer.current;
      h.base.current = client.baseOfField(entry.id, syncField);
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
    h.base.current = client.baseOfField(entry.id, syncField);
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

  if (TEXT_KINDS.has(def.fieldType)) {
    const common = { id, value: String(h.input), "aria-describedby": describedBy, onChange: (e: { target: { value: string } }) => s.change(e.target.value, false), onBlur: () => { void s.save(); } };
    return (
      <div className="field">
        <label htmlFor={id}>{def.label}</label>{hint}
        {def.fieldType === "longText" ? <textarea rows={5} {...common} /> : <input autoComplete="off" inputMode={def.fieldType === "integer" ? "numeric" : "text"} {...common} />}
        {status}
      </div>
    );
  }
  if (def.fieldType === "boolean") {
    return (
      <div className="field">
        <label htmlFor={id}>{def.label}</label>
        <select id={id} value={String(h.input)} aria-describedby={describedBy} onChange={(e) => s.change(e.target.value, true)}>
          <option value="">Not set</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
        {status}
      </div>
    );
  }
  if (def.fieldType === "selection" && def.multiple) {
    const chosen = Array.isArray(h.input) ? h.input : [];
    return (
      <fieldset className="field field--group" aria-describedby={describedBy}>
        <legend>{def.label}</legend>
        {def.options.map((o) => (
          <div className="check" key={o.id}>
            <input id={`${id}-${o.id}`} type="checkbox" checked={chosen.includes(o.id)}
              onChange={(e) => s.change(def.options.map((x) => x.id).filter((x) => (x === o.id ? e.target.checked : chosen.includes(x))), true)} />
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
        <label htmlFor={id}>{def.label}</label>
        <select id={id} value={String(h.input)} aria-describedby={describedBy} onChange={(e) => s.change(e.target.value, true)}>
          <option value="">Not set</option>
          {def.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {status}
      </div>
    );
  }
  if (def.fieldType === "entryReference") {
    const target = def.targetEntryTypes.length > 0 ? def.targetEntryTypes : ["character", "location", "term", "organization", "object", "event", "plotline", "worldRule", "research"];
    const options = entriesOfType(m, target, bookId);
    const have = typeof current === "string" ? current : "";
    const missing = have !== "" && !options.some((o) => o.id === have);
    return (
      <div className="field">
        <label htmlFor={id}>{def.label}</label>
        <select id={id} value={String(h.input)} aria-describedby={describedBy} onChange={(e) => s.change(e.target.value, true)}>
          <option value="">Not set</option>
          {missing && <option value={have}>{String(m.records.get("entry")?.get(have)?.name ?? "An entry that is not in the library")}</option>}
          {options.map((o) => <option key={o.id} value={o.id}>{String(o.name)}</option>)}
        </select>
        {status}
      </div>
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

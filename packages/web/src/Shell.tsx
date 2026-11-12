import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Plaque } from "./Plaque.tsx";
import {
  BibleIcon, BookIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, GlobeIcon,
  HistoryIcon, HomeIcon, LayersIcon, NoteIcon, PeopleIcon, PinIcon, PlusIcon, ShelfIcon, ToolsIcon,
} from "./icons.tsx";
import { SceneEditor } from "./SceneEditor.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { SyncClient } from "./sync/client.ts";
import type { SessionEndInfo } from "./sync/client.ts";
import { pollInterval } from "./sync/poll.ts";
import { liveBooks, outline, sceneIsLive } from "./sync/model.ts";
import {
  PLACEHOLDER_BIBLE, PLACEHOLDER_BOOKS, PLACEHOLDER_FIRST_TAB, PLACEHOLDER_QUICK_NOTES, SECTIONS, TOP_BAR,
} from "./placeholder.ts";

type TopItem = (typeof TOP_BAR)[number];
type Section = (typeof SECTIONS)[number];

const TOP_ICONS: Record<TopItem, ReactNode> = {
  Home: <HomeIcon />, Write: <BookIcon />, Notes: <NoteIcon />, "Book Bible": <BibleIcon />, Tools: <ToolsIcon />, Resources: <ShelfIcon />,
};
const SECTION_ICONS: Record<Section, ReactNode> = {
  Manuscript: <NoteIcon />, Notes: <NoteIcon />, Characters: <PeopleIcon />, Worldbuilding: <GlobeIcon />, Scenes: <LayersIcon />, Revisions: <HistoryIcon />,
};

interface Tab { id: number; title: string }

interface ShellProps {
  onSignOut: () => void | Promise<void>;
  signOutError: string | undefined;
  /** The server no longer accepts the session (it expired). */
  onSessionEnded: (info: SessionEndInfo) => void;
}

export function Shell({ onSignOut, signOutError, onSessionEnded }: ShellProps) {
  const [client] = useState(() => new SyncClient(pollInterval(import.meta.env.DEV ? window.__ROLLTOP_POLL_MS__ : undefined)));
  const cstate = useSyncExternalStore(client.subscribe, client.getState);
  const [startAttempt, setStartAttempt] = useState(0);
  const flushers = useRef(new Map<string, () => Promise<void>>());
  const register = useCallback((id: string, f: (() => Promise<void>) | undefined) => {
    if (f) flushers.current.set(id, f); else flushers.current.delete(id);
  }, []);
  client.onSessionEnded = onSessionEnded;
  useEffect(() => {
    void client.start();
    return () => client.stop();
  }, [client, startAttempt]);
  const sample = cstate.phase === "empty";
  const live = cstate.phase === "ready";

  const [bookId, setBookId] = useState<string | undefined>();
  const [openScenes, setOpenScenes] = useState<string[]>([]);
  const [activeScene, setActiveScene] = useState<string | undefined>();
  const books = live ? liveBooks(client.model) : [];
  const currentBook = books.find((b) => b.id === bookId) ?? books[0];
  const items = live && currentBook ? outline(client.model, currentBook.id) : [];
  const [top, setTop] = useState<TopItem>("Write");
  const [section, setSection] = useState<Section>("Manuscript");
  const [book, setBook] = useState<string>(PLACEHOLDER_BOOKS[0]);
  const [bookOpen, setBookOpen] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, title: PLACEHOLDER_FIRST_TAB }]);
  const [activeTab, setActiveTab] = useState<number | undefined>(1);
  const nextTabId = useRef(2);
  const [expanded, setExpanded] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const bookMenuId = useId();
  const bookButton = useRef<HTMLButtonElement>(null);

  const active = tabs.find((t) => t.id === activeTab);

  function addTab() {
    const id = nextTabId.current++;
    setTabs((t) => [...t, { id, title: `Untitled ${id - 1}` }]);
    setActiveTab(id);
    setTop("Write");
  }
  function closeTab(id: number) {
    const i = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (activeTab === id) setActiveTab(rest[Math.min(i, rest.length - 1)]?.id);
  }

  // Escape closes the book switcher and returns focus to its button.
  useEffect(() => {
    if (!bookOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setBookOpen(false); bookButton.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bookOpen]);

  async function signOut() {
    setSigningOut(true);
    // Leaving: every open scene saves first. A save that fails stays on this device.
    await Promise.all([...flushers.current.values()].map((f) => f().catch(() => {})));
    await Promise.resolve(onSignOut());
    setSigningOut(false);
  }

  function openScene(id: string) {
    setOpenScenes((s) => (s.includes(id) ? s : [...s, id]));
    setActiveScene(id);
    setTop("Write");
    setLeftOpen(false);
  }
  function closeScene(id: string) {
    const i = openScenes.indexOf(id);
    const rest = openScenes.filter((s) => s !== id);
    setOpenScenes(rest);
    if (activeScene === id) setActiveScene(rest[Math.min(i, rest.length - 1)]);
  }
  const sceneTitle = (id: string): string => {
    const n = client.model.records.get("manuscriptNode")?.get(id);
    return typeof n?.title === "string" && n.title !== "" ? n.title : "Untitled scene";
  };
  // A scene that has gone from the library (trashed on another device) closes its tab; its text, if unsaved, is in recovery.
  const liveScenes = openScenes.filter((id) => sceneIsLive(client.model, id) || client.recoveryFor(id) !== undefined);

  const bibleJump = () => setTop("Book Bible");

  const bookLabel = live ? (currentBook ? String(currentBook.title) : "No book yet") : sample ? book : "No book open";
  const bookNames: string[] = sample ? [...PLACEHOLDER_BOOKS] : [];

  return (
    <div className={`frame${expanded ? " frame--expanded" : ""}`}>
      <a className="skip" href="#main">Skip to the editor</a>
      <header className="top">
        <Plaque />
        <div className="top__account">
          <button type="button" className="btn btn--brass" onClick={signOut} disabled={signingOut}>Sign out</button>
        </div>
        <nav className="topbar" aria-label="Main">
          <ul>
            {TOP_BAR.map((item) => (
              <li key={item}>
                <button type="button" className="topbar__item" aria-current={top === item ? "page" : undefined}
                  onClick={() => setTop(item)}>
                  {TOP_ICONS[item]}<span>{item}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {signOutError && <p role="alert" className="top__error">{signOutError}</p>}
      </header>

      {cstate.phase !== "loading" && (
        <section className="sample-notice" aria-label="Sample content notice">
          {live ? (
            <p><strong>Sample content.</strong> Quick Notes, Book Bible and every section except Manuscript are not connected to your library yet.
              The manuscript on the left is your real library.</p>
          ) : (
            <p><strong>Sample content.</strong> This is not connected to your library, and nothing here is saved.</p>
          )}
        </section>
      )}
      {live && cstate.otherConflicts > 0 && (
        <p role="status" className="sample-notice">
          {cstate.otherConflicts === 1 ? "1 other conflict is" : `${cstate.otherConflicts} other conflicts are`} open on the server.
          The browser cannot settle those yet; use an app that can.
        </p>
      )}

      <div className="panel-toggles">
        <button type="button" className="btn btn--wood" aria-expanded={leftOpen} aria-controls="left-panel"
          onClick={() => setLeftOpen((v) => !v)}>Book and sections</button>
        <button type="button" className="btn btn--wood" aria-expanded={rightOpen} aria-controls="right-panel"
          onClick={() => setRightOpen((v) => !v)}>Quick Notes and Book Bible</button>
      </div>

      <div className="workspace">
        <nav className="card side side--left" id="left-panel" aria-label="Book and sections" data-open={leftOpen}>
          <div className="switcher">
            <button type="button" ref={bookButton} className="switcher__button" aria-expanded={bookOpen}
              aria-controls={bookMenuId} aria-label={sample ? `Book: ${bookLabel} (sample). Change book` : `Book: ${bookLabel}. Change book`}
              onClick={() => setBookOpen((v) => !v)}>
              <BookIcon /><span className="switcher__name">{bookLabel}{sample && <> <small>(sample)</small></>}</span><ChevronDownIcon />
            </button>
            {bookOpen && (
              <ul className="switcher__menu" id={bookMenuId} aria-label="Books">
                {(live ? books.map((b) => ({ key: b.id, name: String(b.title) })) : bookNames.map((n) => ({ key: n, name: n }))).map((b) => (
                  <li key={b.key}>
                    <button type="button" aria-current={b.name === bookLabel ? "true" : undefined}
                      onClick={() => {
                        if (live) setBookId(b.key); else setBook(b.name);
                        setBookOpen(false); bookButton.current?.focus();
                      }}>{b.name}{sample && " (sample)"}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <h2 className="sr-only">Sections</h2>
          <ul className="sections">
            {SECTIONS.map((s) => (
              <li key={s}>
                <button type="button" className="sections__item" aria-current={section === s ? "true" : undefined}
                  onClick={() => { setSection(s); setTop("Write"); }}>
                  {SECTION_ICONS[s]}<span>{s}</span>
                </button>
              </li>
            ))}
          </ul>
          {live && (
            section === "Manuscript" ? (
              <>
                <h2 className="outline__title">Manuscript</h2>
                {items.length === 0 ? <p className="hint">This book has no scenes yet.</p> : (
                  <ul className="outline" aria-label="Manuscript outline">
                    {items.map(({ node, depth, hasDocument }) => (
                      <li key={node.id} style={{ paddingLeft: `${depth * 14}px` }}>
                        {hasDocument ? (
                          <button type="button" className="outline__scene" aria-current={node.id === activeScene ? "true" : undefined}
                            onClick={() => openScene(node.id)}>{String(node.title) || "Untitled scene"}</button>
                        ) : <span className="outline__group">{String(node.title)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : <p className="hint">{section} is not connected to your library yet.</p>
          )}
        </nav>

        <main className="centre" id="main" tabIndex={-1}>
          {top !== "Write" ? (
            <section className="card page page--empty" aria-labelledby="page-title">
              <h2 id="page-title">{top}</h2>
              <p>{top} is not ready yet. Use Write to open the editor.</p>
            </section>
          ) : cstate.phase === "loading" ? (
            <section className="card page page--empty" aria-labelledby="page-title">
              <h2 id="page-title">Opening your library</h2>
              <p role="status">Loading your manuscript from the server…</p>
            </section>
          ) : cstate.phase === "unreachable" ? (
            <section className="card page page--empty" aria-labelledby="page-title">
              <h2 id="page-title">Cannot open your library</h2>
              <p role="alert" className="error">{cstate.message}</p>
              <button type="button" className="btn btn--primary" onClick={() => setStartAttempt((n) => n + 1)}>Try again</button>
            </section>
          ) : cstate.phase === "no-baseline" ? (
            <section className="card page page--empty" aria-labelledby="page-title">
              <h2 id="page-title">This library needs a baseline</h2>
              <p role="alert">
                This library was imported, so its changes are not on record and the browser cannot show its manuscript.
                Editing is turned off so that nothing is overwritten. Ask the person who runs the server to give the library a baseline, then reload this page.
              </p>
            </section>
          ) : live ? (
            <>
              <div className="tabs" role="group" aria-label="Open documents">
                {liveScenes.map((id) => (
                  <div key={id} className="tab" data-active={id === activeScene}>
                    <button type="button" className="tab__title" aria-current={id === activeScene ? "true" : undefined}
                      onClick={() => setActiveScene(id)}>{sceneTitle(id)}</button>
                    <button type="button" className="tab__close" aria-label={`Close ${sceneTitle(id)}`} onClick={() => closeScene(id)}>
                      <CloseIcon />
                    </button>
                  </div>
                ))}
              </div>
              <section className="card page" aria-labelledby="page-title">
                {activeScene && liveScenes.includes(activeScene) ? (
                  <SceneEditor key={activeScene} client={client} cstate={cstate} sceneId={activeScene} title={sceneTitle(activeScene)}
                    expanded={expanded} onExpand={() => setExpanded((v) => !v)} register={register} />
                ) : (
                  <>
                    <Toolbar live={false} expanded={expanded} onExpand={() => setExpanded((v) => !v)} />
                    <div className="page__body">
                      <h2 id="page-title" className="page__title">No scene open</h2>
                      <p id="editor-note" className="page__note">Choose a scene in the manuscript on the left to write in it.</p>
                    </div>
                  </>
                )}
              </section>
            </>
          ) : (
            <>
              <div className="tabs" role="group" aria-label="Open documents">
                {tabs.map((t) => (
                  <div key={t.id} className="tab" data-active={t.id === activeTab}>
                    <button type="button" className="tab__title" aria-current={t.id === activeTab ? "true" : undefined}
                      onClick={() => setActiveTab(t.id)}>{t.title}</button>
                    <button type="button" className="tab__close" aria-label={`Close ${t.title}`} onClick={() => closeTab(t.id)}>
                      <CloseIcon />
                    </button>
                  </div>
                ))}
                <button type="button" className="tab tab--add" aria-label="New document" onClick={addTab}><PlusIcon /></button>
              </div>
              <section className="card page" aria-labelledby="page-title">
                <Toolbar live={false} expanded={expanded} onExpand={() => setExpanded((v) => !v)} />
                {active ? (
                  <div className="page__body">
                    <h2 id="page-title" className="page__title">{active.title}</h2>
                    <div className="orn" aria-hidden="true"><span /><i /><span /></div>
                    <div className="page__text" role="region" aria-label={`${active.title} text`}>
                      <p id="editor-note" className="page__note">The editor is not ready yet. Writing opens in a later release.</p>
                    </div>
                  </div>
                ) : (
                  <div className="page__body">
                    <h2 id="page-title" className="page__title">No document open</h2>
                    <p id="editor-note" className="page__note">Choose New document to open one.</p>
                  </div>
                )}
              </section>
            </>
          )}
        </main>

        <aside className="side side--right" id="right-panel" aria-label="Quick Notes and Book Bible" data-open={rightOpen}>
          <section className="card" aria-labelledby="qn-title">
            <h2 id="qn-title" className="card__title"><PinIcon />Quick Notes <small>(sample)</small></h2>
            <ul className="bullets">
              {PLACEHOLDER_QUICK_NOTES.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </section>
          <section className="card" aria-labelledby="bb-title">
            <h2 id="bb-title" className="card__title"><BibleIcon />Book Bible <small>(sample)</small></h2>
            <ul className="links">
              {PLACEHOLDER_BIBLE.map((b) => (
                <li key={b}>
                  <button type="button" onClick={bibleJump}><span>{b}</span><ChevronRightIcon /></button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

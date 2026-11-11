import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Plaque } from "./Plaque.tsx";
import {
  BibleIcon, BookIcon, BulletListIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, CompressIcon, ExpandIcon, GlobeIcon,
  HistoryIcon, HomeIcon, LayersIcon, NoteIcon, NumberListIcon, PeopleIcon, PinIcon, PlusIcon, RedoIcon, ShelfIcon,
  ToolsIcon, UndoIcon,
} from "./icons.tsx";
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

export function Shell({ onSignOut, signOutError }: { onSignOut: () => void; signOutError: string | undefined }) {
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
    await Promise.resolve(onSignOut());
    setSigningOut(false);
  }

  const bibleJump = () => setTop("Book Bible");

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

      <section className="sample-notice" aria-label="Sample content notice">
        <p><strong>Sample content.</strong> This is not connected to your library, and nothing here is saved.</p>
      </section>

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
              aria-controls={bookMenuId} aria-label={`Book: ${book} (sample). Change book`} onClick={() => setBookOpen((v) => !v)}>
              <BookIcon /><span className="switcher__name">{book} <small>(sample)</small></span><ChevronDownIcon />
            </button>
            {bookOpen && (
              <ul className="switcher__menu" id={bookMenuId} aria-label="Books">
                {PLACEHOLDER_BOOKS.map((b) => (
                  <li key={b}>
                    <button type="button" aria-current={b === book ? "true" : undefined}
                      onClick={() => { setBook(b); setBookOpen(false); bookButton.current?.focus(); }}>{b} (sample)</button>
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
        </nav>

        <main className="centre" id="main" tabIndex={-1}>
          {top !== "Write" ? (
            <section className="card page page--empty" aria-labelledby="page-title">
              <h2 id="page-title">{top}</h2>
              <p>{top} is not ready yet. Use Write to open the editor.</p>
            </section>
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
                <div className="toolbar" role="toolbar" aria-label="Formatting" aria-describedby="editor-note">
                  <ToolButton label="Undo"><UndoIcon /></ToolButton>
                  <ToolButton label="Redo"><RedoIcon /></ToolButton>
                  <span className="toolbar__gap" aria-hidden="true" />
                  <ToolButton label="Bold"><b>B</b></ToolButton>
                  <ToolButton label="Italic"><i>I</i></ToolButton>
                  <ToolButton label="Underline"><u>U</u></ToolButton>
                  <span className="toolbar__gap" aria-hidden="true" />
                  <ToolButton label="Bulleted list"><BulletListIcon /></ToolButton>
                  <ToolButton label="Numbered list"><NumberListIcon /></ToolButton>
                  <button type="button" className="tool tool--end" aria-pressed={expanded}
                    aria-label={expanded ? "Restore panels" : "Expand editor"} onClick={() => setExpanded((v) => !v)}>
                    {expanded ? <CompressIcon /> : <ExpandIcon />}
                  </button>
                </div>
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

/** A formatting button. Editing arrives with the editor (M1-9), so it is focusable but does nothing yet. */
function ToolButton({ label, children }: { label: string; children: ReactNode }) {
  return <button type="button" className="tool" aria-label={label} aria-disabled="true" onClick={(e) => e.preventDefault()}>{children}</button>;
}

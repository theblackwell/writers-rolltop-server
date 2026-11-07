import { PortableLibraries } from "./portable.tsx";
import { LibraryAttachments } from "./attachments.tsx";
// SPDX-License-Identifier: AGPL-3.0-only
import { BibleExports } from "./bible-exports.tsx";
import { NamesNeeded } from "./names.tsx";
import { prepareNamesPlace } from "./names-navigation.ts";
import type { NameNeeded } from "../../../packages/studio/src/names.ts";
import { Planning } from "./planning.tsx";
import { Worlds } from "./worlds.tsx";
import React, {
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  toProseMirror,
  fromProseMirror,
} from "../../../packages/document-adapter/src/prosemirror.ts";
import { draftKey, writeDraft, readDrafts } from "./drafts.ts";
import type { BrowserDraft } from "./drafts.ts";
import type { CanonicalDocument } from "../../../packages/document-adapter/src/canonical.ts";
import { extensions } from "./editor.ts";
import { api, ApiError, onUnauthorized } from "./api.ts";
import type { Item } from "./api.ts";
import { BinderTree, ItemActions, ManagementForm } from "./management.tsx";
import type { Target } from "./management.tsx";
import { children, liveNodes, firstDocument, itemLabel } from "./manuscript.ts";
import { BookProgress } from "./progress.tsx";
import { wordCount } from "../../../packages/document-adapter/src/text.ts";
import { References } from "./references.tsx";
import { Knowledge } from "./knowledge.tsx";
import { prepareContinuityPlace } from "./continuity-navigation.ts";
import { warningCountsByNode } from "../../../packages/studio/src/continuity-values.ts";
import type { ContinuityCatalog } from "./continuity.tsx";
import { Continuity } from "./continuity.tsx";
import { StateChanges } from "./state-changes.tsx";
import { Timeline } from "./timeline.tsx";
import { Questions } from "./questions.tsx";
import { Facts } from "./facts.tsx";
import { QuickNotes } from "./notes.tsx";
import { ManuscriptSearch } from "./search.tsx";
import { BookDetails } from "./book-details.tsx";
import "./style.css";

type Layout = "desk" | "writing" | "focus";
type Draft = BrowserDraft;
type BlockKind = "" | "draft" | "conflict" | "conversion";
type PaneHandle = { flush: () => Promise<boolean>; dirty: () => boolean };
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "The operation did not finish.";
const plain = (doc: CanonicalDocument) =>
  doc.blocks
    .map((b) =>
      b.type === "sceneBreak"
        ? "⁂"
        : b.content.map((i) => (i.type === "text" ? i.text : "\n")).join(""),
    )
    .join("\n\n");
function download(doc: CanonicalDocument) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `scene-draft-${doc.nodeId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={close} aria-label="Close dialog">
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
// Sign-in after a 401. A real modal <dialog> so it enters the browser top
// layer above any open Dialog; it lives outside the app wrapper so the editor
// stays mounted. Escape is swallowed: the user must sign in.
function SessionDialog({
  open,
  onLogin,
}: {
  open: boolean;
  onLogin: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="session-overlay"
      aria-label="Session ended"
      onCancel={(e) => e.preventDefault()}
      onClose={() => {
        // Chromium can close the dialog on a second Escape even after cancel
        // is prevented; reopen it while the session is still expired.
        const d = dialog.current;
        if (open && d && !d.open) d.showModal();
      }}
    >
      {open && (
        <>
          <p role="status">
            Your session ended. Your open scene stays here; sign in again to
            keep saving.
          </p>
          <Login onLogin={onLogin} />
        </>
      )}
    </dialog>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="brand-mark" aria-hidden="true">
        ▤
      </div>
      <p className="eyebrow">YOUR PRIVATE WRITING STUDIO</p>
      <h1>Writers Rolltop</h1>
      <p>Your stories have a place.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/login", "POST", { password });
            setPassword("");
            onLogin();
          } catch (e) {
            setMessage(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Studio password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Opening…" : "Open your desk →"}
        </button>
        <p role="alert">{message}</p>
      </form>
      <small>Hosted by you. No outside account required.</small>
    </main>
  );
}
function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  // A 401 after sign-in keeps the app (and any editor holding unsaved text)
  // mounted behind a sign-in overlay instead of replacing it.
  const [expired, setExpired] = useState(false);
  const authRef = useRef(false);
  const [error, setError] = useState("");
  const [libraries, setLibraries] = useState<Item[]>([]);
  const [library, setLibrary] = useState<Item | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressVersion, setProgressVersion] = useState(0);
  const [portableOpen, setPortableOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [worldsOpen, setWorldsOpen] = useState(false);
  const [appearance, setAppearance] = useState<{
    nodeId: string;
    anchorId: string;
    requestId: string;
  } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const [bibleTarget, setBibleTarget] = useState<string>();
  const [bibleOpen, setBibleOpen] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [planningPoint, setPlanningPoint] = useState<string>();
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [continuityPoint, setContinuityPoint] = useState<string>();
  const [recordTarget, setRecordTarget] = useState<{
    kind: "fact" | "question" | "event";
    id: string;
  }>();
  const [warningSnapshot, setWarningSnapshot] = useState<{
    bookId: string;
    catalog: ContinuityCatalog;
  }>();
  const [warningError, setWarningError] = useState("");
  const [continuityOpen, setContinuityOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [factsOpen, setFactsOpen] = useState(false);
  const [noting, setNoting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [details, setDetails] = useState<Item | null>(null);
  const [books, setBooks] = useState<Item[]>([]);
  const [book, setBook] = useState<Item | null>(null);
  const [nodes, setNodes] = useState<Item[]>([]);
  const [scene, setScene] = useState<Item | null>(null);
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const saved = localStorage.getItem("rolltop-layout");
      return saved === "writing" || saved === "focus" ? saved : "desk";
    } catch {
      return "desk";
    }
  });
  const [view, setView] = useState<"projects" | "manuscript">("projects");
  const [dialog, setDialog] = useState<
    | "library"
    | "book"
    | "part"
    | "chapter"
    | "scene"
    | "frontMatter"
    | "backMatter"
    | null
  >(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [creating, setCreating] = useState(false);
  const pane = useRef<PaneHandle>(null);
  const [management, setManagement] = useState<Target | null>(null);
  const [mutating, setMutating] = useState(false);
  const mutationLock = useRef(false);
  const warningCounts =
    warningSnapshot && warningSnapshot.bookId === book?.id
      ? warningCountsByNode(warningSnapshot.catalog.warnings)
      : {};
  useEffect(() => {
    let live = true;
    if (!book) {
      setWarningSnapshot(undefined);
      setWarningError("");
      return;
    }
    if (
      continuityOpen ||
      factsOpen ||
      questionsOpen ||
      timelineOpen ||
      stateOpen
    )
      return;
    api<ContinuityCatalog>("/books/" + book.id + "/continuity")
      .then((c) => {
        if (live) {
          setWarningSnapshot({ bookId: book.id, catalog: c });
          setWarningError("");
        }
      })
      .catch((e) => {
        if (live) {
          setWarningSnapshot(undefined);
          setWarningError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [
    book?.id,
    progressVersion,
    nodes,
    continuityOpen,
    factsOpen,
    questionsOpen,
    timelineOpen,
    stateOpen,
  ]);
  function showWarnings(point?: string) {
    setContinuityPoint(point);
    setContinuityOpen(true);
  }
  async function openName(n: NameNeeded) {
    if (!book) return;
    if (n.source === "fact") await openWarningSubject("fact", n.sourceId);
    else if (n.source === "manuscript") {
      const data = await prepareNamesPlace(n.sourceId, leave, () =>
        api("/books/" + book.id),
      );
      setBook(data.book);
      setNodes(data.nodes);
      setScene(data.target);
      setView("manuscript");
    } else {
      if (!(await leave()))
        throw new Error(
          "Resolve the current scene's draft or save conflict before opening this entry.",
        );
      const entries = await api<any[]>("/books/" + book.id + "/entries");
      if (!entries.some((e) => e.id === n.sourceId && !e.deletedAt))
        throw new Error(
          "This entry is no longer live here. Review Trash or check names again.",
        );
      setBibleTarget(n.sourceId);
      setBibleOpen(true);
    }
    setNamesOpen(false);
  }
  async function openWarningSubject(
    kind: "fact" | "question" | "event",
    id: string,
  ) {
    if (!(await leave()))
      throw new Error(
        "Resolve the current scene's draft or save conflict before opening this record.",
      );
    setRecordTarget({ kind, id });
    setContinuityOpen(false);
    setKnowledgeOpen(false);
    if (kind === "fact") setFactsOpen(true);
    else if (kind === "question") setQuestionsOpen(true);
    else setTimelineOpen(true);
  }
  async function openWarningPlace(point: { id: string; bookId: string }) {
    const data = await prepareContinuityPlace(point, leave, (id) =>
      api("/books/" + id),
    );
    setBook(data.book);
    setNodes(data.nodes);
    setScene(data.target);
    setView("manuscript");
    setContinuityOpen(false);
    setKnowledgeOpen(false);
  }
  useEffect(() => {
    api("/session")
      .then(() => setAuth(true))
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401)
          setError(errorText(e));
        setAuth(false);
      });
  }, []);
  useEffect(() => {
    // The editor stays mounted: edits that could not reach browser storage
    // (full or unavailable) would be lost if the pane unmounted.
    onUnauthorized(() => {
      // Late 401s from in-flight requests after sign-out must not flag expiry.
      if (!authRef.current) return;
      setExpired(true);
      setError("");
    });
    return () => onUnauthorized(undefined);
  }, []);
  useEffect(() => {
    authRef.current = auth === true;
  }, [auth]);
  useEffect(() => {
    if (auth) void loadLibraries();
  }, [auth]);
  useEffect(() => {
    try {
      localStorage.setItem("rolltop-layout", layout);
    } catch {
      /* Keep layout usable when browser storage is unavailable. */
    }
  }, [layout]);
  async function loadLibraries() {
    try {
      const list = await api<Item[]>("/libraries");
      setLibraries(list);
      if (list.length) await openLibrary(list[0]);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function leave() {
    return (await pane.current?.flush()) ?? true;
  }
  async function openLibrary(item: Item) {
    if (!(await leave())) return;
    try {
      const data = await api("/libraries/" + item.id);
      setLibrary(data.library);
      setBooks(data.books);
      setBook(null);
      setScene(null);
      setNodes([]);
      setView("projects");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function openBook(item: Item) {
    if (!(await leave())) return;
    try {
      const data = await api("/books/" + item.id);
      setBook(data.book);
      setNodes(data.nodes);
      setScene(firstDocument(data.nodes));
      setView("manuscript");
    } catch (e) {
      setError(errorText(e));
    }
  }
  function newItem(kind: typeof dialog) {
    setName("");
    setParent(
      scene?.parentId ??
        liveNodes(nodes).find((n) => n.kind === "chapter")?.id ??
        "",
    );
    if (kind === "chapter") setParent("");
    setDialog(kind);
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!(await leave())) return;
    setCreating(true);
    try {
      if (dialog === "library") {
        const result = await api("/libraries", "POST", { title: name });
        setLibraries([...libraries, result]);
        await openLibrary(result);
      } else if (dialog === "book" && library) {
        const result = await api(`/libraries/${library.id}/books`, "POST", {
          title: name,
        });
        setBooks([...books, result]);
        await openBook(result);
      } else if (book) {
        const result = await api(`/books/${book.id}/nodes`, "POST", {
          title: name,
          kind: dialog,
          ...((dialog === "scene" || dialog === "chapter") && parent
            ? { parentId: parent }
            : {}),
        });
        setNodes([...nodes, result]);
        if (["scene", "frontMatter", "backMatter"].includes(dialog ?? "")) {
          setScene(result);
          setView("manuscript");
        }
      }
      setDialog(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  }
  async function reloadWorkspace() {
    if (!library) return;
    const refreshed = await api(`/libraries/${library.id}`);
    setBooks(refreshed.books);
    if (book) {
      const current = refreshed.books.find((b: Item) => b.id === book.id);
      if (!current || current.deletedAt) {
        setBook(null);
        setNodes([]);
        setScene(null);
        setView("projects");
        return;
      }
      const state = await api(`/books/${book.id}`);
      setBook(state.book);
      setNodes(state.nodes);
      const live = liveNodes(state.nodes);
      setScene(
        live.find((n) => n.id === scene?.id) ?? firstDocument(state.nodes),
      );
    }
  }
  async function applyManagement(
    target: Target,
    payload: unknown,
  ): Promise<string | undefined> {
    if (mutationLock.current) return "Another change is still being saved.";
    mutationLock.current = true;
    setMutating(true);
    try {
      if (!(await leave()))
        return "The current scene could not be saved. Close this dialog to review it.";
      const resource = target.type === "book" ? "books" : "nodes";
      const result = await api(
        `/${resource}/${target.item.id}${target.action === "rename" ? "" : "/" + target.action}`,
        target.action === "rename" ? "PUT" : "POST",
        payload,
      );
      setManagement(null);
      if (target.action === "purge")
        setError(
          `Deleted permanently. Recovery backup: ${result.backup}. Keep this filename for your administrator.`,
        );
      try {
        await reloadWorkspace();
      } catch (e) {
        setError(
          (target.action === "purge"
            ? `Deleted permanently. Recovery backup: ${result.backup}. `
            : "The change was saved. ") +
            "The workspace could not reload. " +
            errorText(e),
        );
      }
    } catch (e) {
      return errorText(e);
    } finally {
      mutationLock.current = false;
      setMutating(false);
    }
  }
  async function manage(target: Target) {
    if (mutating) return;
    if (target.action === "up" || target.action === "down") {
      const peers = children(liveNodes(nodes), target.item.parentId ?? null);
      const index = peers.findIndex((n) => n.id === target.item.id);
      const beforeId =
        target.action === "up"
          ? peers[index - 1]?.id
          : (peers[index + 2]?.id ?? null);
      if (
        index < 0 ||
        (target.action === "up" && index === 0) ||
        (target.action === "down" && index === peers.length - 1)
      )
        return;
      const message = await applyManagement(
        { ...target, action: "move" },
        { parentId: target.item.parentId ?? null, beforeId },
      );
      if (message) setError(message);
    } else if (target.action === "restore") {
      const message = await applyManagement(target, {});
      if (message) setError(message);
    } else setManagement(target);
  }
  if (auth === null)
    return (
      <main className="login" role="status">
        Opening the studio…
      </main>
    );
  if (!auth)
    return (
      <>
        <Login
          onLogin={() => {
            setError("");
            setExpired(false);
            authRef.current = true;
            setAuth(true);
          }}
        />
        {error && (
          <p className="global-error" role="alert">
            {error}
          </p>
        )}
      </>
    );
  const activeNodes = liveNodes(nodes);
  const chapters = activeNodes.filter((n) => n.kind === "chapter");
  const liveBooks = books.filter((b) => !b.deletedAt);
  const trashedBooks = books.filter((b) => b.deletedAt);
  const trashedNodes = nodes.filter((n) => n.deletedAt);
  return (
    <>
      <div className={`app layout-${layout}`}>
        <header className="app-header">
          <a
            className="brand"
            href="#"
            onClick={async (e) => {
              e.preventDefault();
              if (await leave()) setView("projects");
            }}
          >
            <span aria-hidden="true">▤</span> Writers Rolltop
          </a>
          <span className="edition">SELF-HOSTED STUDIO</span>
          <div className="header-actions">
            <details className="action-menu">
              <summary>Library ▾</summary>
              <div>
                <button
                  onClick={async () => {
                    if (await leave()) setPortableOpen(true);
                  }}
                >
                  Portable Archives…
                </button>
                <button
                  disabled={!library}
                  onClick={async () => {
                    if (await leave()) setAttachmentsOpen(true);
                  }}
                >
                  Library Attachments…
                </button>
                <button onClick={() => newItem("library")}>New Library…</button>
                <button disabled={!library} onClick={() => newItem("book")}>
                  New Book…
                </button>
                <button disabled={!library} onClick={() => setWorldsOpen(true)}>
                  Worlds and Series…
                </button>
                <button
                  disabled={!book}
                  onClick={async () => {
                    if (await leave()) setExportOpen(true);
                  }}
                >
                  Export Story Bible…
                </button>
                <button
                  disabled={!book}
                  onClick={async () => {
                    if (await leave()) setNamesOpen(true);
                  }}
                >
                  Names Still Needed…
                </button>
                <button
                  disabled={!book}
                  onClick={async () => {
                    if (await leave()) {
                      setPlanningPoint(undefined);
                      setPlanningOpen(true);
                    }
                  }}
                >
                  Story Overview and Planning…
                </button>
                <button disabled={!book} onClick={() => setDetails(book)}>
                  Book Details and Goals…
                </button>
                <button
                  disabled={!book}
                  onClick={async () => {
                    if (await leave()) setSearching(true);
                  }}
                >
                  Search Manuscript…
                </button>
                <button disabled={!book} onClick={() => setNoting(true)}>
                  Quick Notes…
                </button>
                <button
                  disabled={!book}
                  onClick={() => {
                    setBibleTarget(undefined);
                    setBibleOpen(true);
                  }}
                >
                  Bible Entries…
                </button>
                <button disabled={!book} onClick={() => showWarnings()}>
                  Continuity Warnings…
                </button>
                <button disabled={!book} onClick={() => setKnowledgeOpen(true)}>
                  Who Knows What…
                </button>
                <button disabled={!book} onClick={() => setStateOpen(true)}>
                  Changing State…
                </button>
                <button
                  disabled={!book}
                  onClick={() => {
                    setRecordTarget(undefined);
                    setTimelineOpen(true);
                  }}
                >
                  Timeline…
                </button>
                <button
                  disabled={!book}
                  onClick={() => {
                    setRecordTarget(undefined);
                    setQuestionsOpen(true);
                  }}
                >
                  Questions and Decisions…
                </button>
                <button
                  disabled={!book}
                  onClick={() => {
                    setRecordTarget(undefined);
                    setFactsOpen(true);
                  }}
                >
                  Facts and Knowledge…
                </button>
                <button
                  disabled={!book}
                  onClick={async () => {
                    if (await leave()) setProgressOpen(true);
                  }}
                >
                  Word Goals and Progress…
                </button>
                <hr />
                {libraries.map((l) => (
                  <button key={l.id} onClick={() => void openLibrary(l)}>
                    {l.title}
                  </button>
                ))}
                <hr />
                <button
                  onClick={async () => {
                    if (await leave()) {
                      try {
                        try {
                          await api("/logout", "POST", {});
                        } catch (error) {
                          // An expired session is already signed out on the server.
                          if (!(
                            error instanceof ApiError && error.status === 401
                          ))
                            throw error;
                        }
                        authRef.current = false;
                        setExpired(false);
                        setAuth(false);
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }
                  }}
                >
                  Sign Out
                </button>
              </div>
            </details>
            <label className="layout-picker">
              Layout
              <select
                aria-label="Writing layout"
                value={layout}
                onChange={(e) => setLayout(e.target.value as Layout)}
              >
                <option value="desk">Desk</option>
                <option value="writing">Writing</option>
                <option value="focus">Focus</option>
              </select>
            </label>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss message">
              ×
            </button>
          </div>
        )}
        <nav className="workspace-nav" aria-label="Workspace">
          <button
            className={view === "projects" ? "selected" : ""}
            onClick={async () => {
              if (await leave()) setView("projects");
            }}
          >
            Projects
          </button>
          <button
            disabled={!book}
            className={view === "manuscript" ? "selected" : ""}
            onClick={() => setView("manuscript")}
          >
            Manuscript
          </button>
          <span>Private by design. Yours to write.</span>
        </nav>
        {view === "projects" ? (
          <main className="projects">
            <p className="eyebrow">YOUR BOOKSHELF</p>
            <div className="section-heading">
              <div>
                <h1>{library?.title ?? "A place for your next story"}</h1>
                <p>
                  {library
                    ? "Pick up where you left off, or begin something new."
                    : "Create a library to hold your books."}
                </p>
              </div>
              <button
                className="primary"
                onClick={() => newItem(library ? "book" : "library")}
              >
                ＋ New {library ? "Book" : "Library"}
              </button>
            </div>
            <div className="book-grid">
              {liveBooks.map((b, index) => (
                <article className="book-card" key={b.id}>
                  <button
                    className="open-book"
                    onClick={() => void openBook(b)}
                    disabled={mutating}
                  >
                    <div className={`cover cover-${index % 3}`}>
                      <span>WRITERS ROLLTOP</span>
                      <h2>{b.title}</h2>
                      <i aria-hidden="true">✧</i>
                    </div>
                    <footer>
                      <strong>{b.title}</strong>
                      <span>Open manuscript →</span>
                    </footer>
                  </button>
                  <div className="book-card-actions">
                    <ItemActions
                      item={b}
                      type="book"
                      onAction={(t) => void manage(t)}
                      disabled={mutating}
                    />
                  </div>
                </article>
              ))}
              {library && !liveBooks.length && (
                <div className="empty">
                  <span aria-hidden="true">✧</span>
                  <h2>Every book starts with a blank page.</h2>
                  <p>Add your first book to begin.</p>
                </div>
              )}
            </div>
            {!!trashedBooks.length && (
              <section className="book-trash">
                <h2>Book Trash</h2>
                {trashedBooks.map((b) => (
                  <div className="trash-row" key={b.id}>
                    <span>{b.title}</span>
                    <button
                      disabled={mutating}
                      onClick={() =>
                        void manage({
                          item: b,
                          type: "book",
                          action: "restore",
                        })
                      }
                      aria-label={`Restore book ${b.title}`}
                    >
                      Restore
                    </button>
                    <button
                      disabled={mutating}
                      onClick={() =>
                        void manage({ item: b, type: "book", action: "purge" })
                      }
                      aria-label={`Delete book ${b.title} permanently`}
                    >
                      Delete Permanently…
                    </button>
                  </div>
                ))}
              </section>
            )}
          </main>
        ) : (
          <div className="writing-workspace">
            <aside className="binder" aria-label="Manuscript binder">
              <p className="eyebrow">MANUSCRIPT</p>
              <h2>{book?.title}</h2>
              <button
                onClick={async () => {
                  if (await leave()) {
                    setPlanningPoint(undefined);
                    setPlanningOpen(true);
                  }
                }}
              >
                Story Overview and Planning…
              </button>
              <button onClick={() => setDetails(book)}>
                Book Details and Goals…
              </button>
              {book?.targetWordCount && (
                <p>
                  Goal: {book.targetWordCount.toLocaleString()} words
                  {book.targetDate ? ` by ${book.targetDate}` : ""}
                </p>
              )}
              <div className="binder-actions">
                <details className="action-menu">
                  <summary>＋ Add</summary>
                  <div>
                    {(
                      [
                        "part",
                        "chapter",
                        "scene",
                        "frontMatter",
                        "backMatter",
                      ] as const
                    ).map((kind) => (
                      <button
                        key={kind}
                        disabled={
                          mutating || (kind === "scene" && !chapters.length)
                        }
                        aria-label={`New ${kind === "frontMatter" ? "Front Matter" : kind === "backMatter" ? "Back Matter" : kind[0].toUpperCase() + kind.slice(1)}`}
                        onClick={(e) => {
                          e.currentTarget
                            .closest("details")
                            ?.removeAttribute("open");
                          newItem(kind);
                        }}
                      >
                        New{" "}
                        {kind === "frontMatter"
                          ? "Front Matter"
                          : kind === "backMatter"
                            ? "Back Matter"
                            : kind[0].toUpperCase() + kind.slice(1)}
                        …
                      </button>
                    ))}
                  </div>
                </details>
                {book && (
                  <ItemActions
                    item={book}
                    type="book"
                    onAction={(t) => void manage(t)}
                    disabled={mutating}
                  />
                )}
              </div>
              <BinderTree
                nodes={nodes}
                selected={scene?.id}
                onSelect={async (n) => {
                  if (await leave()) setScene(n);
                }}
                onAction={(t) => void manage(t)}
                disabled={mutating}
                warningCounts={warningCounts}
                onWarnings={(id) => showWarnings(id)}
              />
              {!activeNodes.length && (
                <p className="hint">
                  Add a chapter, then a scene. Your manuscript grows from here.
                </p>
              )}
              {!!trashedNodes.length && (
                <details className="node-trash">
                  <summary>Trash ({trashedNodes.length})</summary>
                  {trashedNodes.map((n) => (
                    <div className="trash-row" key={n.id}>
                      <span>{itemLabel(n)}</span>
                      <button
                        disabled={mutating}
                        onClick={() =>
                          void manage({
                            item: n,
                            type: "node",
                            action: "restore",
                          })
                        }
                        aria-label={`Restore ${itemLabel(n)}`}
                      >
                        Restore
                      </button>
                      <button
                        disabled={mutating}
                        onClick={() =>
                          void manage({
                            item: n,
                            type: "node",
                            action: "purge",
                          })
                        }
                        aria-label={`Delete ${itemLabel(n)} permanently`}
                      >
                        Delete Permanently…
                      </button>
                    </div>
                  ))}
                </details>
              )}
            </aside>
            <main className="manuscript-area">
              {scene &&
                ["part", "chapter", "scene"].includes(scene.kind ?? "") && (
                  <button
                    onClick={async () => {
                      if (await leave()) {
                        setPlanningPoint(scene.id);
                        setPlanningOpen(true);
                      }
                    }}
                  >
                    Plan This{" "}
                    {scene.kind === "part"
                      ? "Part"
                      : scene.kind === "chapter"
                        ? "Chapter"
                        : "Scene"}
                    …
                  </button>
                )}
              {scene && ["scene", "chapter"].includes(scene.kind ?? "") && (
                <div className="story-continuity-actions">
                  <button onClick={() => showWarnings(scene.id)}>
                    {warningSnapshot?.bookId === book?.id
                      ? `${warningCounts[scene.id] ?? 0} continuity warnings here`
                      : "Check Continuity Here"}
                  </button>
                  <button onClick={() => setKnowledgeOpen(true)}>
                    Who Knows What Here
                  </button>
                </div>
              )}
              {warningError && (
                <p role="alert">
                  Continuity badges could not be refreshed. {warningError}
                </p>
              )}
              {["chapter", "part"].includes(scene?.kind ?? "") && scene ? (
                <section aria-label="Manuscript location">
                  <h1>{scene.title}</h1>
                  <p>Items in this {scene.kind}</p>
                  {children(liveNodes(nodes), scene.id)
                    .filter((n) => ["chapter", "scene"].includes(n.kind ?? ""))
                    .map((n) => (
                      <button key={n.id} onClick={() => setScene(n)}>
                        {n.title}
                      </button>
                    ))}
                </section>
              ) : scene ? (
                <EditorPane
                  key={scene.id}
                  ref={pane}
                  reveal={
                    appearance?.nodeId === scene.id ? appearance : undefined
                  }
                  onRevealed={() => setAppearance(null)}
                  onSaved={() => setProgressVersion((v) => v + 1)}
                  layout={layout}
                  node={scene}
                  chapter={
                    nodes.find((n) => n.id === scene.parentId)?.title ?? ""
                  }
                />
              ) : (
                <div className="empty">
                  <p className="eyebrow">THE PAGE IS YOURS</p>
                  <h1>Make room for the first words.</h1>
                  <p>Add a chapter and a scene using the binder.</p>
                  {layout !== "desk" && (
                    <button onClick={() => setLayout("desk")}>
                      Show Desk and binder
                    </button>
                  )}
                </div>
              )}
            </main>
          </div>
        )}
        <footer className="app-footer">
          <span>Writers Rolltop</span>
          <span>M3 in development · Manuscript foundation</span>
          <span>Your server · Your work</span>
        </footer>
        {portableOpen && (
          <Dialog
            title="Portable Archives"
            close={() => setPortableOpen(false)}
          >
            <PortableLibraries
              library={library}
              onImported={async (item) => {
                setLibraries(await api("/libraries"));
                await openLibrary(item);
              }}
            />
          </Dialog>
        )}
        {attachmentsOpen && library && (
          <Dialog
            title="Library Attachments"
            close={() => setAttachmentsOpen(false)}
          >
            <LibraryAttachments
              library={library}
              book={book}
              onBookSaved={(b) => {
                setBook(b);
                setBooks((bs) => bs.map((x) => (x.id === b.id ? b : x)));
              }}
            />
          </Dialog>
        )}
        {progressOpen && book && (
          <Dialog
            title="Word Goals and Progress"
            close={() => setProgressOpen(false)}
          >
            <BookProgress book={book} nodes={nodes} refresh={progressVersion} />
          </Dialog>
        )}
        {book && exportOpen && (
          <Dialog title="Export Story Bible" close={() => setExportOpen(false)}>
            <BibleExports
              key={book.id}
              bookId={book.id}
              onSaved={(b) => {
                setBook(b);
                setBooks((bs) => bs.map((x) => (x.id === b.id ? b : x)));
              }}
            />
          </Dialog>
        )}
        {book && namesOpen && (
          <Dialog title="Names Still Needed" close={() => setNamesOpen(false)}>
            <NamesNeeded bookId={book.id} onOpen={openName} />
          </Dialog>
        )}
        {book && planningOpen && (
          <Dialog
            title="Story Overview and Planning"
            close={() => setPlanningOpen(false)}
          >
            <Planning
              bookId={book.id}
              initialId={planningPoint}
              onSaved={(item, isBook) => {
                if (isBook) {
                  setBook(item);
                  setBooks((bs) =>
                    bs.map((b) => (b.id === item.id ? item : b)),
                  );
                } else {
                  setNodes((ns) =>
                    ns.map((n) => (n.id === item.id ? item : n)),
                  );
                  setScene((n) => (n?.id === item.id ? item : n));
                }
              }}
            />
          </Dialog>
        )}
        {continuityOpen && book && (
          <Dialog
            title="Continuity Warnings"
            close={() => setContinuityOpen(false)}
          >
            <Continuity
              key={book.id + ":" + (continuityPoint ?? "all")}
              bookId={book.id}
              nodeFilter={continuityPoint}
              onCatalog={(c) =>
                setWarningSnapshot({ bookId: book.id, catalog: c })
              }
              onOpenSubject={openWarningSubject}
              onOpenPlace={openWarningPlace}
            />
          </Dialog>
        )}
        {knowledgeOpen && book && (
          <Dialog title="Who Knows What" close={() => setKnowledgeOpen(false)}>
            <Knowledge
              key={book.id}
              bookId={book.id}
              initialPoint={
                scene && ["chapter", "scene"].includes(scene.kind ?? "")
                  ? scene.id
                  : undefined
              }
              onOpenFact={(id) => openWarningSubject("fact", id)}
            />
          </Dialog>
        )}
        {stateOpen && book && (
          <Dialog title="Changing State" close={() => setStateOpen(false)}>
            <StateChanges key={book.id} bookId={book.id} />
          </Dialog>
        )}
        {timelineOpen && book && (
          <Dialog title="Timeline" close={() => setTimelineOpen(false)}>
            <Timeline
              key={
                book.id +
                ":" +
                (recordTarget?.kind === "event" ? recordTarget.id : "list")
              }
              bookId={book.id}
              initialId={
                recordTarget?.kind === "event" ? recordTarget.id : undefined
              }
            />
          </Dialog>
        )}
        {questionsOpen && book && (
          <Dialog
            title="Questions and Decisions"
            close={() => setQuestionsOpen(false)}
          >
            <Questions
              key={
                book.id +
                ":" +
                (recordTarget?.kind === "question" ? recordTarget.id : "list")
              }
              bookId={book.id}
              initialId={
                recordTarget?.kind === "question" ? recordTarget.id : undefined
              }
            />
          </Dialog>
        )}
        {factsOpen && book && (
          <Dialog title="Facts and Knowledge" close={() => setFactsOpen(false)}>
            <Facts
              key={
                book.id +
                ":" +
                (recordTarget?.kind === "fact" ? recordTarget.id : "list")
              }
              bookId={book.id}
              initialId={
                recordTarget?.kind === "fact" ? recordTarget.id : undefined
              }
            />
          </Dialog>
        )}
        {bibleOpen && book && (
          <Dialog title="Bible Entries" close={() => setBibleOpen(false)}>
            <References
              key={book.id + ":" + (bibleTarget ?? "list")}
              initialEntryId={bibleTarget}
              bookId={book.id}
              onOpenAppearance={async (nodeId, anchorId) => {
                if (!(await leave()))
                  throw new Error(
                    "Resolve the current scene's draft or save conflict before opening another passage.",
                  );
                const data = await api(`/books/${book.id}`);
                const target = liveNodes(data.nodes).find(
                  (n) => n.id === nodeId,
                );
                if (!target || data.book.deletedAt)
                  throw new Error(
                    "This scene is no longer available. Restore it from Trash before opening it.",
                  );
                setBook(data.book);
                setNodes(data.nodes);
                setScene(target);
                setView("manuscript");
                setAppearance({
                  nodeId,
                  anchorId,
                  requestId: crypto.randomUUID(),
                });
                setBibleOpen(false);
              }}
            />
          </Dialog>
        )}
        {noting && book && (
          <Dialog title="Quick Notes" close={() => setNoting(false)}>
            <QuickNotes book={book} nodes={nodes} />
          </Dialog>
        )}
        {searching && book && (
          <Dialog title="Search Manuscript" close={() => setSearching(false)}>
            <ManuscriptSearch
              book={book}
              onOpen={async (id) => {
                if (!(await leave())) return;
                const node = nodes.find((n) => n.id === id);
                if (node) {
                  setScene(node);
                  setView("manuscript");
                  setSearching(false);
                }
              }}
            />
          </Dialog>
        )}
        {worldsOpen && library && (
          <Dialog title="Worlds and Series" close={() => setWorldsOpen(false)}>
            <Worlds
              libraryId={library.id}
              onBookSaved={(updated) => {
                setBooks((items) =>
                  items.map((item) =>
                    item.id === updated.id ? updated : item,
                  ),
                );
                setBook((current) =>
                  current?.id === updated.id ? updated : current,
                );
              }}
            />
          </Dialog>
        )}
        {details && (
          <Dialog title="Book Details and Goals" close={() => setDetails(null)}>
            <BookDetails
              book={details}
              onCancel={() => setDetails(null)}
              onSaved={(updated) => {
                setBooks((items) =>
                  items.map((item) =>
                    item.id === updated.id ? updated : item,
                  ),
                );
                setBook((current) =>
                  current?.id === updated.id ? updated : current,
                );
                setDetails(null);
              }}
            />
          </Dialog>
        )}
        {management && (
          <Dialog
            title={`${management.action === "purge" ? "Delete Permanently" : management.action === "rename" ? "Rename" : management.action === "trash" ? "Move to Trash" : "Move"} ${management.item.title}`}
            close={() => {
              if (!mutating) setManagement(null);
            }}
          >
            <ManagementForm
              target={management}
              nodes={nodes}
              onCancel={() => setManagement(null)}
              onApply={(payload) => applyManagement(management, payload)}
            />
          </Dialog>
        )}
        {dialog && (
          <Dialog
            title={`New ${dialog === "frontMatter" ? "Front Matter" : dialog === "backMatter" ? "Back Matter" : dialog[0].toUpperCase() + dialog.slice(1)}`}
            close={() => setDialog(null)}
          >
            <form onSubmit={create}>
              <label>
                Title
                <input
                  autoFocus
                  required
                  maxLength={500}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {(dialog === "scene" || dialog === "chapter") && (
                <label>
                  {dialog === "scene" ? "Chapter" : "Part (optional)"}
                  <select
                    required={dialog === "scene"}
                    value={parent}
                    onChange={(e) => setParent(e.target.value)}
                  >
                    {dialog === "chapter" && (
                      <option value="">Book root</option>
                    )}
                    {(dialog === "scene"
                      ? chapters
                      : activeNodes.filter((n) => n.kind === "part")
                    ).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="dialog-actions">
                <button type="button" onClick={() => setDialog(null)}>
                  Cancel
                </button>
                <button className="primary" disabled={creating || !name.trim()}>
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </Dialog>
        )}
      </div>
      <SessionDialog
        open={expired}
        onLogin={() => {
          setError("");
          setExpired(false);
        }}
      />
    </>
  );
}

const EditorPane = forwardRef<
  PaneHandle,
  {
    node: Item;
    chapter: string;
    layout: Layout;
    onSaved: () => void;
    reveal?: { anchorId: string; requestId: string };
    onRevealed: () => void;
  }
>(function EditorPane(
  { node, chapter, layout, onSaved, reveal, onRevealed },
  ref,
) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [message, setMessage] = useState("");
  const [revealNotice, setRevealNotice] = useState("");
  const [browserDraft, setBrowserDraft] = useState<Draft | null>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [preview, setPreview] = useState<Draft | null>(null);
  const revision = useRef(0);
  const dirty = useRef(false);
  const blocked = useRef(false);
  const blockKind = useRef<BlockKind>("");
  const [blockState, setBlockState] = useState<BlockKind>("");
  const [loadTick, setLoadTick] = useState(0);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const pending = useRef<CanonicalDocument | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const change = useRef(0);
  const editorId = useRef(crypto.randomUUID());
  const key = draftKey(node.id, editorId.current);
  const recoveredKey = useRef<string | undefined>(undefined);
  const ready = useRef(false);
  const editor = useEditor({
    extensions: extensions(),
    content: "",
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: { "aria-label": "Manuscript", spellcheck: "true" },
    },
    onUpdate: ({ editor }) => {
      if (!ready.current) return;
      try {
        pending.current = fromProseMirror(editor.getJSON(), node.id);
        dirty.current = true;
        change.current++;
        setStatus("Editing…");
        try {
          writeDraft(localStorage, key, revision.current, pending.current);
        } catch {
          setMessage(
            "Browser draft storage is unavailable. Keep this page open until the server confirms your save.",
          );
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), 700);
        if (blockKind.current === "conversion") {
          // The edit now converts again, so the whole current text is saveable.
          unblock();
          setMessage("");
        }
      } catch (e) {
        // Keep the editor editable so a later edit can clear this block.
        block("conversion");
        setMessage(
          "The last edit could not be prepared for saving, so it is not saved. " +
            errorText(e),
        );
        setStatus("Not saved");
      }
    },
  });
  editorRef.current = editor;
  function block(kind: Exclude<BlockKind, "">) {
    blocked.current = true;
    blockKind.current = kind;
    setBlockState(kind);
    // Draft and conflict states must not accept edits that cannot be saved.
    if (kind !== "conversion") editorRef.current?.setEditable(false, false);
  }
  function unblock() {
    blocked.current = false;
    blockKind.current = "";
    setBlockState("");
    if (ready.current) editorRef.current?.setEditable(true, false);
  }
  useEffect(() => {
    let live = true;
    api(`/documents/${node.id}`)
      .then((data) => {
        if (!live || !editor) return;
        revision.current = data.revision;
        editor.commands.setContent(toProseMirror(data.document), {
          emitUpdate: false,
        });
        pending.current = data.document;
        ready.current = true;
        editor.setEditable(true, false);
        setLoaded(true);
        setStatus("Saved on your server");
        try {
          const { drafts, unreadable } = readDrafts(
            localStorage,
            data.document,
          );
          if (drafts.length) {
            setBrowserDraft(drafts[0]);
            block("draft");
            setStatus("Browser draft waiting");
          }
          if (unreadable)
            setMessage(
              "Some browser drafts could not be read and were left in storage.",
            );
        } catch {
          setMessage(
            "A browser draft could not be read. It has been left in storage.",
          );
        }
      })
      .catch((e) => {
        if (live) {
          setMessage(errorText(e));
          setStatus("Could not load");
        }
      });
    return () => {
      live = false;
      ready.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [editor, node.id, loadTick]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  useEffect(() => {
    if (!loaded || !editor || !reveal) return;
    if (blocked.current) {
      onRevealed();
      return;
    }
    setRevealNotice("");
    let start: number | undefined,
      end = 0;
    editor.state.doc.descendants((n, pos) => {
      if (
        n.isText &&
        n.marks.some(
          (m) =>
            m.type.name === "rolltopAnchor" && m.attrs.id === reveal.anchorId,
        )
      ) {
        start ??= pos;
        end = pos + n.nodeSize;
      }
    });
    if (start !== undefined)
      editor
        .chain()
        .focus()
        .setTextSelection({ from: start, to: end })
        .scrollIntoView()
        .run();
    else
      setRevealNotice(
        "The linked passage is no longer present. The scene is open for review.",
      );
    onRevealed();
  }, [loaded, editor, reveal?.requestId]);
  useImperativeHandle(ref, () => ({ flush, dirty: () => dirty.current }));
  async function flush(): Promise<boolean> {
    if (timer.current) clearTimeout(timer.current);
    if (blocked.current) {
      setMessage(
        blockKind.current === "conversion"
          ? "The last edit could not be prepared for saving. Change or undo it before leaving this scene."
          : "Review the recovered draft or save conflict before leaving this scene.",
      );
      setStatus("Not saved");
      return false;
    }
    if (running.current) return running.current;
    const work = async () => {
      while (dirty.current && pending.current) {
        const version = change.current;
        const doc = pending.current;
        setStatus("Saving…");
        try {
          const result = await api(`/documents/${node.id}`, "PUT", {
            document: doc,
            expectedRevision: revision.current,
          });
          revision.current = result.revision;
          onSaved();
          if (version === change.current) {
            dirty.current = false;
            try {
              localStorage.removeItem(key);
              if (recoveredKey.current)
                localStorage.removeItem(recoveredKey.current);
              recoveredKey.current = undefined;
            } catch {
              /* Server save is already confirmed. */
            }
            setStatus("Saved on your server");
            setMessage("");
          } else
            writeDraft(localStorage, key, revision.current, pending.current);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) block("conflict");
          setStatus(
            e instanceof ApiError && e.status === 409
              ? "Needs review"
              : "Not saved",
          );
          setMessage(errorText(e));
          return false;
        }
      }
      return true;
    };
    running.current = work();
    try {
      return await running.current;
    } finally {
      running.current = null;
    }
  }
  async function recoverDraft() {
    if (!browserDraft || !editor) return;
    // A recovered draft is never silently saved over a newer server revision.
    if (browserDraft.revision !== revision.current) {
      setMessage(
        "The server has another revision. Download this browser draft before choosing a version.",
      );
      return;
    }
    editor.commands.setContent(toProseMirror(browserDraft.document), {
      emitUpdate: false,
    });
    recoveredKey.current = browserDraft.storageKey;
    pending.current = browserDraft.document;
    dirty.current = true;
    change.current++;
    unblock();
    setBrowserDraft(null);
    await flush();
  }
  function applyServerVersion(latest: Draft) {
    let kept = false;
    try {
      kept = localStorage.getItem(key) !== null;
    } catch {
      /* Storage unavailable. */
    }
    revision.current = latest.revision;
    editor?.commands.setContent(toProseMirror(latest.document), {
      emitUpdate: false,
    });
    if (timer.current) clearTimeout(timer.current);
    pending.current = latest.document;
    dirty.current = false;
    change.current++;
    unblock();
    setPreview(null);
    setBrowserDraft(null);
    setMessage(
      browserDraft?.storageKey || kept
        ? "Using the server version. The previous browser draft remains separately in storage."
        : "Using the server version. Your unsaved text on this page was replaced and was not kept in browser storage.",
    );
    setStatus("Saved on your server");
  }
  async function useServerVersion() {
    if (browserDraft?.storageKey) {
      // The editor already shows the server's copy; the stored draft stays put.
      unblock();
      setBrowserDraft(null);
      setMessage(
        "Browser draft kept separately in storage. It remains available for recovery.",
      );
      setStatus("Saved on your server");
      return;
    }
    try {
      applyServerVersion(await api(`/documents/${node.id}`));
    } catch (e) {
      setMessage(errorText(e));
    }
  }
  async function openReferences(markSelection = false) {
    if (!editor || blocked.current) {
      setMessage("Resolve the draft or conflict before linking a passage.");
      return;
    }
    if (markSelection) {
      const { from, to, $from, $to } = editor.state.selection;
      if (
        from === to ||
        !$from.sameParent($to) ||
        !editor.state.doc.textBetween(from, to).trim()
      ) {
        setMessage("Select text within one paragraph to mark a passage.");
        return;
      }
      editor
        .chain()
        .setMark("rolltopAnchor", { id: crypto.randomUUID() })
        .run();
    }
    if (await flush()) {
      editor.setEditable(false);
      setReferencesOpen(true);
    }
  }
  const words = pending.current ? wordCount(pending.current) : 0;
  const selectionDepth = editor?.state.selection.$from;
  let listDepth = 0;
  if (selectionDepth)
    for (let depth = 1; depth <= selectionDepth.depth; depth++)
      if (selectionDepth.node(depth).type.name === "listItem") listDepth++;

  return (
    <div className="editor-pane">
      {linkOpen && (
        <Dialog title="Passage Link" close={() => setLinkOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const href = String(
                new FormData(event.currentTarget).get("href"),
              ).trim();
              if (!/^(https?:\/\/|mailto:)/i.test(href)) {
                setLinkError("Use an http, https, or mailto link.");
                return;
              }
              try {
                new URL(href);
              } catch {
                setLinkError("Enter a valid link.");
                return;
              }
              editor?.chain().extendMarkRange("link").setLink({ href }).run();
              setLinkOpen(false);
            }}
          >
            <label>
              Address
              <input
                name="href"
                type="text"
                required
                maxLength={4000}
                defaultValue={editor?.getAttributes("link").href ?? ""}
                autoFocus
              />
            </label>
            {linkError && <p role="alert">{linkError}</p>}
            <button>Save Link</button>
            <button
              type="button"
              onClick={() => {
                editor?.chain().extendMarkRange("link").unsetLink().run();
                setLinkOpen(false);
              }}
            >
              Remove Link
            </button>
          </form>
        </Dialog>
      )}
      {referencesOpen && (
        <Dialog
          title="Passage References"
          close={() => {
            setReferencesOpen(false);
            editor?.setEditable(!blocked.current);
          }}
        >
          <References
            bookId={node.bookId!}
            nodeId={node.id}
            onReveal={(id) => {
              if (!editor) return;
              let start: number | undefined;
              let end = 0;
              editor.state.doc.descendants((n, pos) => {
                if (
                  n.isText &&
                  n.marks.some(
                    (m) => m.type.name === "rolltopAnchor" && m.attrs.id === id,
                  )
                ) {
                  start ??= pos;
                  end = pos + n.nodeSize;
                }
              });
              setReferencesOpen(false);
              editor.setEditable(!blocked.current);
              if (start !== undefined)
                editor
                  .chain()
                  .focus()
                  .setTextSelection({ from: start, to: end })
                  .scrollIntoView()
                  .run();
            }}
          />
        </Dialog>
      )}
      <div className="scene-heading">
        <div>
          <p className="eyebrow">{chapter || "MANUSCRIPT"}</p>
          <h1>{node.title}</h1>
        </div>
        <span
          className={"save-status " + (dirty.current ? "pending" : "")}
          role="status"
        >
          {status}
        </span>
      </div>
      {revealNotice && <p role="status">{revealNotice}</p>}
      {browserDraft && (
        <div className="recovery" role="alert">
          <strong>A browser draft is waiting.</strong>
          <p>It has not replaced the server's copy.</p>
          <button onClick={() => void recoverDraft()}>Recover draft</button>
          <button onClick={() => download(browserDraft.document)}>
            Download draft JSON
          </button>
          <button onClick={() => void useServerVersion()}>
            Use server version
          </button>
        </div>
      )}
      {message && (
        <div className="recovery" role="alert">
          <p>{message}</p>
          {!loaded ? (
            <button
              onClick={() => {
                setMessage("");
                setStatus("Loading…");
                setLoadTick((n) => n + 1);
              }}
            >
              Retry loading
            </button>
          ) : (
            blockState !== "conversion" && (
              <button onClick={() => void flush()}>Retry Save</button>
            )
          )}
          <button
            disabled={
              !loaded || !pending.current || blockState === "conversion"
            }
            onClick={() => pending.current && download(pending.current)}
          >
            Download current draft
          </button>
          {blockState !== "" &&
            blockState !== "conversion" &&
            !browserDraft && (
              <button
                onClick={async () => {
                  try {
                    const latest = await api(`/documents/${node.id}`);
                    setBrowserDraft({
                      revision: revision.current,
                      document: pending.current!,
                    });
                    setPreview(latest);
                  } catch (e) {
                    setMessage(errorText(e));
                  }
                }}
              >
                Compare server version
              </button>
            )}
        </div>
      )}
      <details className="writing-tools" open={layout !== "focus"}>
        <summary>Writing tools</summary>
        <div
          className="format-toolbar"
          role="toolbar"
          aria-label="Manuscript formatting"
        >
          <button
            disabled={!loaded}
            aria-label="Undo"
            onClick={() => editor?.chain().focus().undo().run()}
          >
            ↶
          </button>
          <button
            disabled={!loaded}
            aria-label="Redo"
            onClick={() => editor?.chain().focus().redo().run()}
          >
            ↷
          </button>
          <button
            disabled={!loaded}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openReferences(true)}
          >
            Mark Passage for Reference
          </button>
          <button disabled={!loaded} onClick={() => void openReferences()}>
            References…
          </button>
          <span className="tool-divider" />
          <button
            disabled={!loaded}
            aria-label="Bold"
            aria-pressed={editor?.isActive("bold") ?? false}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <b>B</b>
          </button>
          <button
            disabled={!loaded}
            aria-label="Italic"
            aria-pressed={editor?.isActive("italic") ?? false}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <i>I</i>
          </button>
          <button
            disabled={!loaded}
            aria-label="Underline"
            aria-pressed={editor?.isActive("underline") ?? false}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
          >
            <u>U</u>
          </button>
          <select
            aria-label="Paragraph style"
            value={
              editor?.isActive("heading")
                ? `h${editor.getAttributes("heading").level}`
                : "body"
            }
            onChange={(e) =>
              e.target.value === "body"
                ? editor?.chain().focus().setParagraph().run()
                : editor
                    ?.chain()
                    .focus()
                    .setHeading({
                      level: Number(e.target.value.slice(1)) as
                        1 | 2 | 3 | 4 | 5 | 6,
                    })
                    .run()
            }
          >
            <option value="body">Body text</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            {[3, 4, 5, 6].map((level) => (
              <option key={level} value={`h${level}`}>
                Heading {level}
              </option>
            ))}
          </select>
          <button
            disabled={!loaded}
            aria-label="Bulleted list"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            ☷
          </button>
          <button
            disabled={!loaded}
            aria-label="Block quote"
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            ❞
          </button>
          <button
            disabled={!loaded}
            aria-label="Scene break"
            onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          >
            ⁂
          </button>
          <button
            disabled={!loaded}
            aria-label="Numbered list"
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            Numbered List
          </button>
          <button
            disabled={!loaded || listDepth >= 8}
            aria-label="Indent list item"
            onClick={() =>
              listDepth < 8 &&
              editor?.chain().focus().sinkListItem("listItem").run()
            }
          >
            Indent
          </button>
          <button
            disabled={!loaded}
            aria-label="Outdent list item"
            onClick={() =>
              editor?.chain().focus().liftListItem("listItem").run()
            }
          >
            Outdent
          </button>
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              disabled={!loaded}
              aria-label={`Align ${align}`}
              aria-pressed={editor?.isActive({ textAlign: align }) ?? false}
              onClick={() => editor?.chain().focus().setTextAlign(align).run()}
            >
              {align[0].toUpperCase() + align.slice(1)}
            </button>
          ))}
          <button
            disabled={!loaded}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setLinkError("");
              setLinkOpen(true);
            }}
          >
            Link…
          </button>
          <span className="toolbar-spacer" />
          <button disabled={!loaded} onClick={() => void flush()}>
            Save
          </button>
          <button
            disabled={!loaded}
            onClick={async () => {
              if (await flush())
                try {
                  setHistory(await api(`/documents/${node.id}/revisions`));
                } catch (e) {
                  setMessage(errorText(e));
                }
            }}
          >
            History
          </button>
        </div>
      </details>
      <div className="paper">
        <EditorContent editor={editor} />
      </div>
      <div className="scene-footer">
        <span>{words.toLocaleString()} words</span>
        <span>One scene. Part of something bigger.</span>
      </div>
      {history && (
        <Dialog
          title="Version history"
          close={() => {
            setHistory(null);
            setPreview(null);
          }}
        >
          <p>
            Restoring creates a new saved revision. Earlier versions remain
            available.
          </p>
          <div className="history-list">
            {history.map((r) => (
              <button
                key={r.revision}
                onClick={async () => {
                  try {
                    setPreview(
                      await api(
                        `/documents/${node.id}/revisions/${r.revision}`,
                      ),
                    );
                  } catch (e) {
                    setMessage(errorText(e));
                  }
                }}
              >
                Revision {r.revision} · {new Date(r.savedAt).toLocaleString()}
              </button>
            ))}
          </div>
          {preview && (
            <>
              <pre className="version-preview">{plain(preview.document)}</pre>
              <button
                className="primary"
                onClick={async () => {
                  if (!(await flush())) return;
                  try {
                    const result = await api(`/documents/${node.id}`, "PUT", {
                      document: preview.document,
                      expectedRevision: revision.current,
                    });
                    revision.current = result.revision;
                    editor?.commands.setContent(
                      toProseMirror(preview.document),
                      { emitUpdate: false },
                    );
                    pending.current = preview.document;
                    setHistory(null);
                    setPreview(null);
                    setStatus("Saved on your server");
                  } catch (e) {
                    setMessage(errorText(e));
                  }
                }}
              >
                Restore as a new revision
              </button>
            </>
          )}
        </Dialog>
      )}
      {preview && !history && (
        <Dialog title="Server version" close={() => setPreview(null)}>
          <pre className="version-preview">{plain(preview.document)}</pre>
          <p>Your browser draft remains available to download.</p>
          <button
            className="primary"
            onClick={() => applyServerVersion(preview)}
          >
            Use this server version
          </button>
        </Dialog>
      )}
    </div>
  );
});
createRoot(document.getElementById("root")!).render(<App />);

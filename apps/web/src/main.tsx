// SPDX-License-Identifier: AGPL-3.0-only
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
import { api, ApiError } from "./api.ts";
import type { Item } from "./api.ts";
import "./style.css";

type Layout = "desk" | "writing" | "focus";
type Draft = BrowserDraft;
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
    <dialog ref={dialog} onCancel={close} aria-label={title}>
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
  const [error, setError] = useState("");
  const [libraries, setLibraries] = useState<Item[]>([]);
  const [library, setLibrary] = useState<Item | null>(null);
  const [books, setBooks] = useState<Item[]>([]);
  const [book, setBook] = useState<Item | null>(null);
  const [nodes, setNodes] = useState<Item[]>([]);
  const [scene, setScene] = useState<Item | null>(null);
  const [layout, setLayout] = useState<Layout>(() => {
    const saved = localStorage.getItem("rolltop-layout");
    return saved === "writing" || saved === "focus" ? saved : "desk";
  });
  const [view, setView] = useState<"projects" | "manuscript">("projects");
  const [dialog, setDialog] = useState<
    "library" | "book" | "chapter" | "scene" | null
  >(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [creating, setCreating] = useState(false);
  const pane = useRef<PaneHandle>(null);
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
    if (auth) void loadLibraries();
  }, [auth]);
  useEffect(() => {
    localStorage.setItem("rolltop-layout", layout);
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
      const chapters = data.nodes.filter((n: Item) => n.kind === "chapter");
      setScene(
        chapters.flatMap((c: Item) =>
          data.nodes.filter(
            (n: Item) => n.parentId === c.id && n.kind === "scene",
          ),
        )[0] ?? null,
      );
      setView("manuscript");
    } catch (e) {
      setError(errorText(e));
    }
  }
  function newItem(kind: typeof dialog) {
    setName("");
    setParent(
      scene?.parentId ?? nodes.find((n) => n.kind === "chapter")?.id ?? "",
    );
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
          ...(dialog === "scene" ? { parentId: parent } : {}),
        });
        setNodes([...nodes, result]);
        if (dialog === "scene") {
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
  const chapters = nodes.filter((n) => n.kind === "chapter");
  return (
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
              <button onClick={() => newItem("library")}>New Library…</button>
              <button disabled={!library} onClick={() => newItem("book")}>
                New Book…
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
                      await api("/logout", "POST", {});
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
            {books.map((b, index) => (
              <button
                className="book-card"
                key={b.id}
                onClick={() => void openBook(b)}
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
            ))}
            {library && !books.length && (
              <div className="empty">
                <span aria-hidden="true">✧</span>
                <h2>Every book starts with a blank page.</h2>
                <p>Add your first book to begin.</p>
              </div>
            )}
          </div>
        </main>
      ) : (
        <div className="writing-workspace">
          <aside className="binder" aria-label="Manuscript binder">
            <p className="eyebrow">MANUSCRIPT</p>
            <h2>{book?.title}</h2>
            <div className="binder-actions">
              <button onClick={() => newItem("chapter")}>＋ Chapter</button>
              <button
                disabled={!chapters.length}
                onClick={() => newItem("scene")}
              >
                ＋ Scene
              </button>
            </div>
            <div className="tree">
              {chapters.map((chapter, index) => (
                <section key={chapter.id}>
                  <h3>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {chapter.title}
                  </h3>
                  {nodes
                    .filter(
                      (n) => n.parentId === chapter.id && n.kind === "scene",
                    )
                    .map((n) => (
                      <button
                        className={n.id === scene?.id ? "current" : ""}
                        key={n.id}
                        onClick={async () => {
                          if (await leave()) setScene(n);
                        }}
                      >
                        <span aria-hidden="true">▤</span>
                        {n.title}
                      </button>
                    ))}
                </section>
              ))}
              {!chapters.length && (
                <p className="hint">
                  Add a chapter, then a scene. Your manuscript grows from here.
                </p>
              )}
            </div>
          </aside>
          <main className="manuscript-area">
            {scene ? (
              <EditorPane
                key={scene.id}
                ref={pane}
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
      {dialog && (
        <Dialog
          title={`New ${dialog[0].toUpperCase() + dialog.slice(1)}`}
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
            {dialog === "scene" && (
              <label>
                Chapter
                <select
                  required
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                >
                  {chapters.map((c) => (
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
  );
}

const EditorPane = forwardRef<
  PaneHandle,
  { node: Item; chapter: string; layout: Layout }
>(function EditorPane({ node, chapter, layout }, ref) {
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [message, setMessage] = useState("");
  const [browserDraft, setBrowserDraft] = useState<Draft | null>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [preview, setPreview] = useState<Draft | null>(null);
  const revision = useRef(0);
  const dirty = useRef(false);
  const blocked = useRef(false);
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
      } catch (e) {
        blocked.current = true;
        setMessage(errorText(e));
        setStatus("Not saved");
      }
    },
  });
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
            blocked.current = true;
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
  }, [editor, node.id]);
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
  useImperativeHandle(ref, () => ({ flush, dirty: () => dirty.current }));
  async function flush(): Promise<boolean> {
    if (timer.current) clearTimeout(timer.current);
    if (blocked.current) {
      setMessage(
        "Review the recovered draft or save conflict before leaving this scene.",
      );
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
          if (e instanceof ApiError && e.status === 409) blocked.current = true;
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
    blocked.current = false;
    setBrowserDraft(null);
    await flush();
  }
  const words =
    editor?.getText().trim().split(/\s+/u).filter(Boolean).length ?? 0;
  return (
    <div className="editor-pane">
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
      {browserDraft && (
        <div className="recovery" role="alert">
          <strong>A browser draft is waiting.</strong>
          <p>It has not replaced the server's copy.</p>
          <button onClick={() => void recoverDraft()}>Recover draft</button>
          <button onClick={() => download(browserDraft.document)}>
            Download draft JSON
          </button>
          <button
            onClick={() => {
              blocked.current = false;
              setBrowserDraft(null);
              setMessage(
                "Browser draft kept separately in storage. It remains available for recovery.",
              );
            }}
          >
            Use server version
          </button>
        </div>
      )}
      {message && (
        <div className="recovery" role="alert">
          <p>{message}</p>
          <button onClick={() => void flush()}>Retry Save</button>
          <button
            disabled={!pending.current}
            onClick={() => pending.current && download(pending.current)}
          >
            Download current draft
          </button>
          {blocked.current && !browserDraft && (
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
              editor?.isActive("heading", { level: 1 })
                ? "h1"
                : editor?.isActive("heading", { level: 2 })
                  ? "h2"
                  : "body"
            }
            onChange={(e) =>
              e.target.value === "body"
                ? editor?.chain().focus().setParagraph().run()
                : editor
                    ?.chain()
                    .focus()
                    .toggleHeading({ level: e.target.value === "h1" ? 1 : 2 })
                    .run()
            }
          >
            <option value="body">Body text</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
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
            onClick={() => {
              revision.current = preview.revision;
              editor?.commands.setContent(toProseMirror(preview.document), {
                emitUpdate: false,
              });
              pending.current = preview.document;
              dirty.current = false;
              blocked.current = false;
              setPreview(null);
              setBrowserDraft(null);
              setMessage(
                "Using the server version. The previous browser draft remains separately in storage.",
              );
              setStatus("Saved on your server");
            }}
          >
            Use this server version
          </button>
        </Dialog>
      )}
    </div>
  );
});
createRoot(document.getElementById("root")!).render(<App />);

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CanonicalDocument } from "@writers-rolltop/document-adapter";
import { canonicalFromState, commands, stateFromCanonical, toolbarState } from "./editor/rolltop-editor.ts";
import { mountEditor } from "./editor/mount.ts";
import type { RolltopView } from "./editor/mount.ts";
import { sameDoc } from "./sync/client.ts";
import type { ClientState, SyncClient } from "./sync/client.ts";
import { sceneDocument } from "./sync/model.ts";
import { RecoveryDialog } from "./RecoveryDialog.tsx";
import { Toolbar } from "./Toolbar.tsx";
import type { ToolName } from "./Toolbar.tsx";

interface Props {
  client: SyncClient;
  cstate: ClientState;
  sceneId: string;
  title: string;
  expanded: boolean;
  onExpand: () => void;
  /** Lets the shell save this scene before a sign-out. */
  register: (sceneId: string, flush: (() => Promise<void>) | undefined) => void;
}

const DRAFT_MS = 800;

/** One scene: the toolbar, the text, and a status line. The text saves when the editor loses focus. */
export function SceneEditor({ client, cstate, sceneId, title, expanded, onExpand, register }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<RolltopView | undefined>(undefined);
  const changes = useRef(0);
  const clean = useRef(0);
  const loadedRev = useRef(-1);
  /** The text as it was last saved or loaded: what "unsaved" is measured against. */
  const cleanDoc = useRef<CanonicalDocument | undefined>(undefined);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [dialogOpen, setDialogOpen] = useState(true);
  const [toolbar, setToolbar] = useState<ReturnType<typeof toolbarState> | undefined>();

  const item = cstate.recovery.find((r) => r.sceneId === sceneId);
  const itemKey = item ? item.conflictId : "";
  const status = cstate.status.get(sceneId) ?? "idle";

  const markClean = useCallback(() => { clean.current = changes.current; setDirty(false); }, []);

  /** Replaces the text on screen with a canonical document. The document, not the editor, is the source of truth. */
  const load = useCallback((doc: CanonicalDocument, revision: number) => {
    const v = view.current;
    if (!v) return;
    try {
      v.updateState(stateFromCanonical(doc));
      setProblem(undefined);
    } catch {
      setProblem("This scene's text could not be opened. It has not been changed.");
    }
    loadedRev.current = revision;
    cleanDoc.current = doc;
    client.setBase(sceneId, revision);
    markClean();
    setToolbar(toolbarState(v.state));
  }, [client, sceneId, markClean]);

  const saveNow = useCallback(async (): Promise<void> => {
    const v = view.current;
    if (!v || changes.current === clean.current) return;
    const snap = changes.current;
    clearTimeout(draftTimer.current); // the save below keeps the text on this device itself
    let doc: CanonicalDocument;
    try {
      doc = canonicalFromState(v.state);
    } catch {
      setProblem("This text cannot be stored as it is. It is still on this page; change it and try again.");
      return;
    }
    setProblem(undefined);
    const out = await client.saveScene(sceneId, doc);
    if (out.kind === "saved") loadedRev.current = out.revision;
    if (out.kind === "nothing") loadedRev.current = sceneDocument(client.model, sceneId).revision;
    if ((out.kind === "saved" || out.kind === "nothing") && changes.current === snap) { cleanDoc.current = doc; markClean(); }
  }, [client, sceneId, markClean]);
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;

  // Mount: take the held text of an earlier visit if there is one, otherwise the scene as the server has it.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const held = client.heldFor(sceneId);
    const server = sceneDocument(client.model, sceneId);
    const doc = held && held.status !== "review" ? held.doc : server.doc;
    let initial;
    try {
      initial = stateFromCanonical(doc);
    } catch {
      setProblem("This scene's text could not be opened. It has not been changed.");
      initial = stateFromCanonical({ schema: "writers-rolltop/document", version: 1, nodeId: sceneId, blocks: [] });
    }
    cleanDoc.current = server.doc;
    const v = mountEditor(el, initial, {
      label: `${title} text`,
      readOnly: false,
      onTransaction: (s, tr) => {
        if (tr.docChanged) {
          changes.current += 1;
          setDirty(true);
          clearTimeout(draftTimer.current);
          draftTimer.current = setTimeout(() => {
            try { void client.keepDraft(sceneId, canonicalFromState(s)); } catch { /* shown when the author leaves the field */ }
          }, DRAFT_MS);
        }
        setToolbar(toolbarState(s));
      },
      onBlur: () => { void saveRef.current(); },
    }) as RolltopView;
    view.current = v;
    if (held && held.status !== "review") {
      client.setBase(sceneId, held.baseRevision);
      loadedRev.current = held.baseRevision;
      changes.current = 1; clean.current = 0;
      setDirty(true);
    } else {
      client.setBase(sceneId, server.revision);
      loadedRev.current = server.revision;
    }
    setToolbar(toolbarState(v.state));
    register(sceneId, async () => { clearTimeout(draftTimer.current); await saveRef.current(); });
    // The client calls this when it must keep the text on screen at once (the epoch changed, the session ended).
    client.registerKeeper(sceneId, async () => {
      const cur = view.current;
      if (!cur || changes.current === clean.current) return false;
      clearTimeout(draftTimer.current);
      let typed: CanonicalDocument;
      try { typed = canonicalFromState(cur.state); } catch { return false; }
      await client.keepDraft(sceneId, typed);
      return true;
    });
    return () => {
      // Leaving the scene (another tab, a closed tab, sign-out): save what is there.
      clearTimeout(draftTimer.current);
      void saveRef.current();
      register(sceneId, undefined);
      client.registerKeeper(sceneId, undefined);
      v.destroy();
      view.current = undefined;
    };
    // The editor is made once per scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

  // The page is going away: send what is typed, where the browser allows it.
  useEffect(() => {
    const hide = () => {
      const v = view.current;
      if (!v || changes.current === clean.current) return;
      try { client.saveOnHide(sceneId, canonicalFromState(v.state)); } catch { /* the draft on this device remains */ }
    };
    window.addEventListener("pagehide", hide);
    return () => window.removeEventListener("pagehide", hide);
  }, [client, sceneId]);

  // A copy is waiting for the author: the text on screen becomes the saved text, read only, and the dialog opens.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.setReadOnly(item !== undefined);
    if (!item) return;
    setDialogOpen(true);
    let cancelled = false; // the item changed or the scene closed while the text was being put aside
    void (async () => {
      // Text typed here and not saved must not be hidden by the other copy: it becomes its own item first, and is on
      // this device before the saved text is loaded over it.
      if (changes.current !== clean.current) {
        clearTimeout(draftTimer.current);
        try {
          const typed = canonicalFromState(v.state);
          const known = client.getState().recovery.some((r) => r.sceneId === sceneId && sameDoc(r.mine, typed));
          if (!known && !sameDoc(typed, cleanDoc.current)) {
            await client.holdForAuthor(sceneId, typed, "unsent", "This text was typed on this device and had not been saved when another copy of this scene came in.");
          }
        } catch {
          // It cannot be made into a saved text, so it stays on the page, read only, rather than be replaced.
          if (!cancelled) setProblem("This text cannot be stored as it is. It is still on this page, and is not replaced.");
          return;
        }
      }
      if (cancelled || view.current !== v) return;
      const saved = client.savedTextFor(item) ?? item.mine;
      load(saved, sceneDocument(client.model, sceneId).revision);
    })();
    return () => { cancelled = true; };
  }, [itemKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server's text changed (another device saved, or a choice was made) and nothing here is unsaved: show it.
  useEffect(() => {
    // Read the refs, not the state: text held from an earlier visit is marked unsaved in the same commit.
    if (item || dirty || changes.current !== clean.current || status === "saving") return;
    const server = sceneDocument(client.model, sceneId);
    if (server.revision !== loadedRev.current) load(server.doc, server.revision);
  }, [cstate.version, dirty, item, status, client, sceneId, load]);

  const run = (t: ToolName) => {
    const v = view.current;
    if (!v) return;
    commands[t](v.state, v.dispatch, v);
    v.focus();
    redraw();
  };

  const closeDialog = (resolved: boolean) => {
    // Another text of this scene may be waiting (one typed here when a copy came in): it opens next, not behind a button.
    const more = resolved && client.recoveryFor(sceneId) !== undefined;
    setDialogOpen(more);
    if (resolved && !more) view.current?.focus();
  };

  let line: string;
  if (status === "saving") line = "Saving";
  else if (problem || dirty || status === "unsaved" || status === "review") {
    line = cstate.keepsCopies ? "Not saved yet. Your text is kept on this device." : "Not saved yet. This browser cannot keep a copy, so keep this page open.";
  } else if (status === "saved") line = "Saved";
  else line = "No changes yet.";
  const unsaved = line.startsWith("Not saved");

  return (
    <>
      <Toolbar live state={toolbar} run={run} expanded={expanded} onExpand={onExpand} />
      <div className="page__body">
        <h2 id="page-title" className="page__title">{title}</h2>
        <div className="orn" aria-hidden="true"><span /><i /><span /></div>
        <div className="page__text" role="region" aria-label={`${title} text`}>
          <div ref={host} className="rt-host" />
        </div>
        <div className="savebar">
          <p id="editor-note" role="status" className={`savebar__line${unsaved ? " savebar__line--warn" : ""}`}>{line}</p>
          {unsaved && !item && (
            <button type="button" className="btn btn--wood" onClick={() => void saveNow()} disabled={status === "saving" || !dirty && status !== "unsaved"}>Save now</button>
          )}
          {item && !dialogOpen && (
            <button type="button" className="btn btn--primary" onClick={() => setDialogOpen(true)}>Review the other copy</button>
          )}
        </div>
        {problem && <p role="alert" className="error">{problem}</p>}
      </div>
      {item && dialogOpen && (
        <RecoveryDialog key={itemKey} client={client} item={item} others={cstate.recovery.filter((r) => r.sceneId === sceneId && r !== item && r.conflictId !== item.conflictId)} onClose={closeDialog} />
      )}
    </>
  );
}

export { sameDoc };

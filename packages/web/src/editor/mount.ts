// Puts the editor on the page. Kept apart from rolltop-editor.ts so the state logic can be tested without a browser.
import { EditorView } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { clipboardSerializer, markViews, nodeViews, paragraphsFromText } from "./rolltop-editor.ts";

export interface MountOptions {
  label: string;
  readOnly: boolean;
  /** Called after every transaction (the toolbar redraws from the new state). */
  onTransaction: (state: EditorState, tr: Transaction) => void;
  onBlur: () => void;
}

export function mountEditor(el: HTMLElement, state: EditorState, o: MountOptions): EditorView {
  let view: EditorView;
  let readOnly = o.readOnly;
  view = new EditorView(el, {
    state,
    editable: () => !readOnly,
    nodeViews, markViews,
    clipboardSerializer: clipboardSerializer(),
    clipboardTextParser: (text) => paragraphsFromText(text),
    // Only plain text comes in from outside: HTML from other pages is not read.
    handlePaste: (v, event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined || text === "") return true;
      v.dispatch(v.state.tr.replaceSelection(paragraphsFromText(text)).scrollIntoView().setMeta("paste", true));
      return true;
    },
    handleDrop: (_v, _event, _slice, moved) => !moved,
    attributes: { role: "textbox", "aria-multiline": "true", "aria-label": o.label, spellcheck: "true", class: "rt-doc" },
    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      o.onTransaction(next, tr);
    },
    handleDOMEvents: {
      blur: () => { o.onBlur(); return false; },
    },
  });
  Object.defineProperty(view, "setReadOnly", { value: (v: boolean) => { readOnly = v; view.setProps({ editable: () => !readOnly }); } });
  return view;
}

export type RolltopView = EditorView & { setReadOnly(v: boolean): void };

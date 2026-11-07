// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";

test("Story Bible tab groups entries by type, selects an entry into its page, creates entries and mounts none of the retired dialogs", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "http://localhost",
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
    "FormData",
  ]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[key],
    });
  }
  // Node strips .ts but does not load JSX. Compile the actual app component,
  // leaving its imports intact; no duplicate test implementation of the form.
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith(".tsx")) return nextLoad(url, context);
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      };
    },
  });
  let root: any;
  try {
    const React = await import("react"),
      { createRoot } = await import("react-dom/client");
    const { StoryBible } =
      await import("../../../apps/web/src/story-bible.tsx");
    // jsdom has no modal <dialog>; the shared Dialog only needs showModal.
    (dom.window as any).HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    root = createRoot(dom.window.document.getElementById("root")!);
    const now = "2026-11-06T00:00:00.000Z";
    const make = (name: string, entryType: string, extra: object = {}) => ({
      id: name.toLowerCase().replace(/\W/g, "-"),
      name,
      entryType,
      aliases: [],
      updatedAt: now,
      scope: { kind: "book", id: "book" },
      ...extra,
    });
    let entries: any[] = [
      make("Mira Vale", "character", { toBeNamed: true }),
      make("Old Mill", "location"),
      make("Gone Person", "character", { deletedAt: now }),
    ];
    const posts: any[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: string, options: any) => {
        const path = new URL(url, "http://localhost").pathname;
        const json = (body: unknown) => new Response(JSON.stringify(body));
        if (options?.method === "POST") {
          const input = JSON.parse(options.body);
          posts.push({ path, input });
          const entry = make(input.name, input.entryType);
          entries = [...entries, entry];
          return json(entry);
        }
        if (path.endsWith("/entries")) return json(entries);
        if (path.endsWith("/relationships"))
          return json({ relationshipTypes: [], relationships: [] });
        if (path.endsWith("/state-changes"))
          return json({
            book: { id: "book" },
            books: [],
            entries,
            fields: [],
            events: [],
            nodes: [],
            stateChanges: [],
          });
        if (path.endsWith("/appearances")) return json({ appearances: [] });
        if (path.endsWith("/family")) return json({ matches: [] });
        if (path.endsWith("/templates"))
          return json({ templates: [], fields: [] });
        if (path.endsWith("/worlds"))
          return json({ universes: [], series: [] });
        return json({ libraryId: "lib", book: { id: "book" }, nodes: [] });
      },
    });
    const doc = dom.window.document;
    const text = () => doc.body.textContent ?? "";
    const click = async (el: Element | undefined | null) =>
      React.act(async () => (el as HTMLElement).click());
    const button = (label: string) =>
      Array.from(doc.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(label),
      );
    const type = async (el: HTMLInputElement, value: string) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(el, value);
        el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    let selected: string | undefined;
    const render = () =>
      root.render(
        React.createElement(StoryBible, {
          bookId: "book",
          selectedId: selected,
          onSelect: (id: string | undefined) => {
            selected = id;
            render();
          },
          tool: null,
          onTool: () => {},
        }),
      );
    await React.act(async () => render());
    await React.act(async () => {});
    // Grouped sidebar, a collapsed Trash group and an empty page state.
    assert.ok(doc.querySelector('section[aria-label="Characters"]'));
    assert.ok(doc.querySelector('section[aria-label="Locations"]'));
    assert.equal(doc.querySelector('section[aria-label="Terms"]'), null);
    assert.equal(
      doc.querySelector("details.node-trash")!.hasAttribute("open"),
      false,
    );
    assert.match(text(), /Pick an entry to open its page/);
    // Removed flat dialogs and their controls are not mounted.
    assert.equal(doc.querySelector("dialog"), null);
    assert.equal(button("Add Bible Entry"), undefined);
    assert.equal(button("Show Entry Trash"), undefined);
    // Selecting an entry opens its page with the existing editors.
    await click(button("Mira Vale"));
    assert.equal(selected, "mira-vale");
    assert.equal(doc.querySelector("article h1")!.textContent, "Mira Vale");
    assert.match(text(), /This book only/);
    assert.match(text(), /Name still to be decided/);
    assert.ok(
      doc.querySelector('section[aria-label="Fields and attachments"]'),
    );
    assert.ok(
      doc.querySelector('section[aria-label="Family and appearances"]'),
    );
    assert.ok(button("Move Entry to Trash"));
    assert.equal(
      doc.querySelector('[aria-current="true"]')!.textContent,
      "Mira Valename to decide",
    );
    // The filter narrows the list.
    await type(doc.querySelector("aside input")! as HTMLInputElement, "mill");
    assert.equal(doc.querySelector('section[aria-label="Characters"]'), null);
    await type(doc.querySelector("aside input")! as HTMLInputElement, "");
    // A trashed entry opens read-only with Restore and permanent Delete.
    await click(doc.querySelector("details.node-trash summary"));
    await click(button("Gone Person"));
    assert.ok(button("Restore Entry"));
    assert.ok(button("Delete Entry Permanently…"));
    assert.equal(
      doc.querySelector('section[aria-label="Fields and attachments"]'),
      null,
    );
    // New opens the create form in a dialog and selects the new entry.
    await click(button("＋ New"));
    assert.ok(doc.querySelector("dialog[aria-label='New Bible Entry']"));
    await type(
      doc.querySelector("dialog input[name='name']") as HTMLInputElement,
      "Harbor",
    );
    await React.act(async () => {
      doc
        .querySelector("dialog form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await React.act(async () => {});
    assert.equal(posts.length, 1);
    assert.equal(posts[0].input.name, "Harbor");
    assert.equal(selected, "harbor");
    assert.equal(doc.querySelector("dialog"), null);
    assert.equal(doc.querySelector("article h1")!.textContent, "Harbor");
    // Back to list returns to the sidebar (visible via CSS at narrow width).
    assert.equal(doc.querySelector(".showing-page") !== null, true);
    await click(button("Back to list"));
    assert.equal(doc.querySelector(".showing-page"), null);
  } finally {
    if (root) {
      const { act } = await import("react");
      await act(async () => root.unmount());
    }
    hooks.deregister();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

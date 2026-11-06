// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted names view filters sources/search, retains failed navigation and refresh, and opens exact sources; entry filter/direct editor loads once", async () => {
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
    const { NamesNeeded } = await import("../../../apps/web/src/names.tsx"),
      { EntryList } = await import("../../../apps/web/src/entries.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const doc = dom.window.document;
    const items = [
      {
        id: "flag/e",
        source: "flag",
        sourceId: "e",
        text: "Keeper",
        title: "Keeper",
      },
      {
        id: "manuscript/s/place",
        source: "manuscript",
        sourceId: "s",
        text: "[place]",
        title: "Scene",
      },
      {
        id: "entry/e/name",
        source: "entry",
        sourceId: "e",
        text: "[name]",
        title: "Keeper",
      },
      {
        id: "fact/f/place",
        source: "fact",
        sourceId: "f",
        text: "[place]",
        title: "Fact text",
      },
    ];
    let failed = false;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () =>
        new Response(
          JSON.stringify(
            failed ? { error: { message: "Refresh unavailable" } } : { items },
          ),
          { status: failed ? 500 : 200 },
        ),
    });
    const button = (name: string) =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === name,
      )!;
    const click = async (el: HTMLElement) => React.act(async () => el.click());
    const change = async (
      el: HTMLInputElement | HTMLSelectElement,
      value: string,
    ) =>
      React.act(async () => {
        const proto =
          el.tagName === "SELECT"
            ? dom.window.HTMLSelectElement.prototype
            : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
        el.dispatchEvent(
          new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", {
            bubbles: true,
          }),
        );
      });
    const opened: any[] = [];
    await React.act(async () =>
      root.render(
        React.createElement(NamesNeeded, {
          bookId: "book",
          onOpen: async (n: any) => {
            opened.push(n);
            throw Error("Resolve draft before opening");
          },
        }),
      ),
    );
    assert.match(doc.body.textContent!, /4 names still needed/);
    await change(doc.querySelector("select")!, "manuscript");
    assert.equal(doc.querySelectorAll("li").length, 1);
    await click(button("Open Manuscript"));
    assert.equal(opened[0].sourceId, "s");
    assert.match(doc.body.textContent!, /Resolve draft/);
    assert.equal(doc.querySelectorAll("li").length, 1);
    await change(doc.querySelector("select")!, "");
    await change(doc.querySelector("input")!, "Keeper");
    assert.equal(doc.querySelectorAll("li").length, 2);
    failed = true;
    await click(button("Check Again"));
    assert.match(doc.body.textContent!, /Refresh unavailable/);
    assert.equal(doc.querySelectorAll("li").length, 2);
    const entries = [
      {
        id: "e",
        name: "Keeper",
        aliases: [],
        entryType: "term",
        updatedAt: "one",
        scope: { kind: "book", id: "book" },
        toBeNamed: true as const,
      },
      {
        id: "other",
        name: "Other",
        aliases: [],
        entryType: "term",
        updatedAt: "two",
        scope: { kind: "book", id: "book" },
      },
    ];
    const props = {
      bookId: "book",
      catalog: { templates: [], fields: [] },
      book: { id: "book" },
      entries: [],
      initialId: "e",
      busy: true,
      onSaved: () => {},
      onPurged: async () => {},
      onInspect: () => {},
      action: async (w: any) => w(),
    };
    await React.act(async () =>
      root.render(React.createElement(EntryList, props)),
    );
    await React.act(async () =>
      root.render(
        React.createElement(EntryList, { ...props, entries, busy: false }),
      ),
    );
    assert.match(doc.body.textContent!, /Edit Keeper/);
    await click(button("Cancel Edit"));
    await React.act(async () =>
      root.render(
        React.createElement(EntryList, {
          ...props,
          entries: [...entries],
          busy: false,
        }),
      ),
    );
    assert.equal(button("Cancel Edit"), undefined);
    const label = Array.from(doc.querySelectorAll("label")).find(
      (l) => l.textContent === "Only names still needed",
    )!;
    await click(label.querySelector("input")!);
    assert.equal(
      doc.querySelectorAll(".entry-row").length ||
        Array.from(doc.querySelectorAll("button")).filter((b) =>
          b.getAttribute("aria-label")?.startsWith("Edit "),
        ).length,
      1,
    );
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

// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted facts preserve stale text/about/knowledge draft, explicit shared consent and Trash/restore", async () => {
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
    const { Facts, FactForm } = await import("../../../apps/web/src/facts.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const book = { id: "book", title: "Book", universeId: "world" },
      character = {
        id: "char",
        name: "Keeper",
        entryType: "character",
        scope: { kind: "book", id: "other" },
      };
    const catalog: any = {
      book,
      scopes: [
        { kind: "book", id: "book", title: "This book" },
        { kind: "universe", id: "world", title: "Shared world: World" },
      ],
      facts: [],
      entries: [character],
      books: [book, { id: "other", title: "Other", universeId: "world" }],
      nodes: [
        {
          id: "scene",
          bookId: "book",
          title: "Scene",
          kind: "scene",
          inTrash: false,
        },
        {
          id: "chapter",
          bookId: "other",
          title: "Chapter",
          kind: "chapter",
          inTrash: false,
        },
      ],
    };
    let failure = true,
      calls: any[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (_url: string, options: any) => {
        if (options.method === "GET")
          return new Response(JSON.stringify(catalog));
        const v = JSON.parse(options.body);
        calls.push(v);
        if (failure)
          return new Response(
            JSON.stringify({
              error: { message: "This fact changed. Keep your draft." },
            }),
            { status: 409 },
          );
        const fact = {
          id: "fact",
          scope: { kind: "universe", id: "world" },
          text: "The secret",
          truth: "false",
          entryIds: ["char"],
          knowledge: [
            { knower: "reader", nodeId: "scene" },
            { knower: "char", nodeId: "chapter" },
          ],
          updatedAt: "new",
          ...v,
        };
        if (v.deleted === false) delete fact.deletedAt;
        else if (v.deleted) fact.deletedAt = "trash";
        return new Response(JSON.stringify(fact));
      },
    });
    const doc = dom.window.document;
    const button = (name: string) =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === name,
      )!;
    const click = async (el: HTMLElement) => React.act(async () => el.click());
    const control = (label: string) =>
      Array.from(doc.querySelectorAll("label"))
        .find((l) => l.firstChild?.textContent?.trim() === label)!
        .querySelector("input,select,textarea") as
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const fill = async (label: string, value: string) =>
      React.act(async () => {
        const el = control(label),
          proto =
            el.tagName === "SELECT"
              ? dom.window.HTMLSelectElement.prototype
              : el.tagName === "TEXTAREA"
                ? dom.window.HTMLTextAreaElement.prototype
                : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
        el.dispatchEvent(
          new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", {
            bubbles: true,
          }),
        );
      });
    await React.act(async () =>
      root.render(React.createElement(Facts, { bookId: "book" })),
    );
    await click(button("New Fact…"));
    await fill("Fact", "The secret");
    await fill("Truth", "false");
    await fill("Scope", "universe");
    await fill("Established in", "scene");
    await fill("About entry", "char");
    await click(button("Add About Entry"));
    await fill("Add knower", "reader");
    await click(button("Add Knower"));
    await fill("Add knower", "char");
    await click(button("Add Knower"));
    const charLabel = Array.from(doc.querySelectorAll("label")).find(
      (l) =>
        l.textContent?.includes("Keeper") &&
        l.textContent?.includes("learns it"),
    )!;
    await React.act(async () => {
      const el = charLabel.querySelector("select")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLSelectElement.prototype,
        "value",
      )!.set!.call(el, "chapter");
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(button("Save Fact").disabled, true);
    await click(doc.querySelector('form input[type="checkbox"]')!);
    await click(button("Save Fact"));
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /changed/);
    assert.equal(control("Fact").value, "The secret");
    assert.equal(control("Truth").value, "false");
    assert.equal(control("Established in").value, "scene");
    assert.deepEqual(calls[0].knowledge, [
      { knower: "reader", nodeId: "scene" },
      { knower: "char", nodeId: "chapter" },
    ]);
    assert.deepEqual(calls[0].entryIds, ["char"]);
    assert.equal(
      (doc.querySelector('form input[type="checkbox"]') as HTMLInputElement)
        .checked,
      true,
    );
    failure = false;
    await click(button("Save Fact"));
    assert.equal(doc.querySelector("textarea"), null);
    assert.match(doc.body.textContent!, /Not true/);
    await click(button("Move Fact to Trash…"));
    assert.equal(button("Move Fact to Trash").disabled, true);
    await click(doc.querySelector('form input[type="checkbox"]')!);
    await click(button("Move Fact to Trash"));
    assert.equal(calls.at(-1).editSharedCanon, true);
    assert.equal(calls.at(-1).expectedUpdatedAt, "new");
    await click(doc.querySelector('input[type="checkbox"]')!);
    await click(button("Restore Fact…"));
    assert.equal(button("Restore Fact").disabled, true);
    await click(doc.querySelector('form input[type="checkbox"]')!);
    await click(button("Restore Fact"));
    assert.equal(calls.at(-1).deleted, false);
    // A saved point outside selected scope is shown and kept until explicitly cleared.
    const odd = {
      id: "odd",
      scope: { kind: "book", id: "book" },
      text: "Kept",
      truth: "true" as const,
      entryIds: [],
      knowledge: [{ knower: "reader", nodeId: "chapter" }],
      nodeId: "missing",
      updatedAt: "stamp",
    };
    await React.act(async () =>
      root.render(
        React.createElement(FactForm, {
          catalog,
          fact: odd,
          mode: "edit",
          busy: false,
          onCancel: () => {},
          onSave: async () => {},
        }),
      ),
    );
    assert.equal(control("Established in").value, "missing");
    assert.equal(button("Save Fact").disabled, true);
    assert.match(doc.body.textContent!, /outside selected scope/);
    assert.equal(
      doc.querySelectorAll('option[value="chapter"]').length,
      1,
      "retained cross-scope knowledge point",
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

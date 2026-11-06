// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted intentional-warning form retains stale note/consent, updates badges and supports Show Again and navigation", async () => {
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
    const { Continuity } = await import("../../../apps/web/src/continuity.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    let failure = true,
      marked = false;
    const calls: any[] = [];
    const warning: any = {
      id: "fact/undecidedButKnown",
      kind: "undecidedButKnown",
      key: "undecidedButKnown",
      subject: { kind: "fact", id: "fact" },
      message: "The reader knows an undecided secret.",
      nodeIds: ["scene"],
    };
    const result = () => ({
      warnings: marked ? [] : [warning],
      intentionalWarnings: marked
        ? [
            {
              ...warning,
              dismissal: {
                warning: warning.key,
                note: "On purpose",
                dismissedAt: "stamp",
              },
            },
          ]
        : [],
      intentionalCount: marked ? 1 : 0,
      checkedAt: "stamp",
      nodes: [{ id: "scene", bookId: "book", title: "Book › Scene" }],
      subjects: [
        {
          id: warning.id,
          title: "Secret",
          updatedAt: marked ? "next" : "stamp",
          shared: true,
        },
      ],
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: string, options: any) => {
        calls.push({
          url,
          method: options.method,
          value: options.body ? JSON.parse(options.body) : undefined,
        });
        if (options.method === "GET")
          return new Response(JSON.stringify(result()));
        if (failure)
          return new Response(
            JSON.stringify({
              error: { message: "This record changed. Keep your note." },
            }),
            { status: 409 },
          );
        marked = !JSON.parse(options.body).restore;
        return new Response(JSON.stringify(result()));
      },
    });
    const doc = dom.window.document;
    const button = (name: string) =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === name,
      )!;
    const click = async (el: HTMLElement) => React.act(async () => el.click());
    const nav: any[] = [];
    let catalogs = 0;
    await React.act(async () =>
      root.render(
        React.createElement(Continuity, {
          bookId: "book",
          onCatalog: () => {
            catalogs++;
          },
          onOpenSubject: async (kind: string, id: string) => {
            nav.push({ kind, id });
          },
          onOpenPlace: async (p: any) => {
            nav.push(p);
          },
        }),
      ),
    );
    await click(button("Open Fact"));
    await click(button("Go to Book › Scene"));
    assert.deepEqual(nav, [
      { kind: "fact", id: "fact" },
      { id: "scene", bookId: "book", title: "Book › Scene" },
    ]);
    await click(button("Mark as Intentional…"));
    assert.equal(button("Mark as Intentional").disabled, true);
    await React.act(async () => {
      const el = doc.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(el, "On purpose");
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click(doc.querySelector('form input[type="checkbox"]')!);
    await click(button("Mark as Intentional"));
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /changed/);
    assert.equal(doc.querySelector("textarea")!.value, "On purpose");
    assert.equal(
      (doc.querySelector('form input[type="checkbox"]') as HTMLInputElement)
        .checked,
      true,
    );
    assert.equal(calls.at(-1).value.expectedUpdatedAt, "stamp");
    assert.equal(calls.at(-1).value.editSharedCanon, true);
    failure = false;
    await click(button("Mark as Intentional"));
    assert.match(doc.body.textContent!, /Marked as intentional/);
    assert.match(doc.body.textContent!, /On purpose/);
    assert.equal(doc.querySelector("textarea"), null);
    assert.match(doc.body.textContent!, /No continuity warnings/);
    await click(button("Show Again"));
    assert.equal(button("Show Warning Again").disabled, true);
    await click(doc.querySelector('form input[type="checkbox"]')!);
    await click(button("Show Warning Again"));
    assert.equal(calls.at(-1).value.restore, true);
    assert.equal(calls.at(-1).value.expectedUpdatedAt, "next");
    assert.match(doc.body.textContent!, /1 continuity warning/);
    assert.ok(catalogs >= 3);
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

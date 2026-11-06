// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted continuity controls show saved warnings, refresh, preserve last results on error and expose no mutation actions", async () => {
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
    const calls: any[] = [];
    let failure = false,
      empty = false;
    const warning = {
      id: "fact/undecidedButKnown",
      kind: "undecidedButKnown",
      key: "undecidedButKnown",
      subject: { kind: "fact", id: "fact" },
      message: "The secret is undecided but the reader knows it.",
      nodeIds: [],
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: string, options: any) => {
        calls.push({ url, method: options.method });
        if (failure)
          return new Response(
            JSON.stringify({
              error: { message: "Continuity could not be checked." },
            }),
            { status: 500 },
          );
        return new Response(
          JSON.stringify({
            warnings: empty ? [] : [warning],
            intentionalCount: 1,
            checkedAt: "stamp",
            subjects: [{ id: warning.id, title: "A secret" }],
          }),
        );
      },
    });
    const doc = dom.window.document;
    const button = (name: string) =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === name,
      )!;
    const click = async (el: HTMLElement) => React.act(async () => el.click());
    await React.act(async () =>
      root.render(React.createElement(Continuity, { bookId: "book" })),
    );
    assert.match(doc.body.textContent!, /1 continuity warning/);
    assert.match(doc.body.textContent!, /Fact: A secret/);
    assert.match(doc.body.textContent!, /reader knows/);
    assert.match(doc.body.textContent!, /already marked intentional/);
    assert.equal(button("Mark as Intentional…"), undefined);
    assert.equal(button("Show Again"), undefined);
    failure = true;
    await click(button("Check Again"));
    assert.match(
      doc.querySelector('[role="alert"]')!.textContent!,
      /could not/,
    );
    assert.match(
      doc.body.textContent!,
      /reader knows/,
      "last good results remain while refresh fails",
    );
    failure = false;
    empty = true;
    await click(button("Check Again"));
    assert.match(doc.body.textContent!, /No continuity warnings/);
    assert.equal(doc.querySelector('[role="alert"]'), null);
    assert.equal(calls.length, 3);
    assert.ok(
      calls.every(
        (c) => c.url === "/api/books/book/continuity" && c.method === "GET",
      ),
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

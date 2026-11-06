// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted knowledge view selects as-of points, labels false beliefs and opens the exact fact", async () => {
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
    const { Knowledge } = await import("../../../apps/web/src/knowledge.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const calls: any[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: string, options: any) => {
        calls.push({ url, method: options.method });
        return new Response(
          JSON.stringify({
            pointId: url.includes("later") ? "later" : "scene",
            nodes: [
              { id: "scene", kind: "scene", title: "Scene" },
              { id: "later", kind: "scene", title: "Later" },
            ],
            groups: [
              {
                id: "reader",
                name: "The reader",
                facts: [
                  {
                    id: "fact",
                    text: "A false belief",
                    truth: "false",
                    ...(url.includes("later")
                      ? {
                          learnedIn: {
                            id: "earlier",
                            title: "Earlier book › Scene",
                          },
                        }
                      : {}),
                  },
                ],
              },
            ],
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
    const opened: string[] = [];
    await React.act(async () =>
      root.render(
        React.createElement(Knowledge, {
          bookId: "book",
          initialPoint: "scene",
          onOpenFact: async (id: string) => {
            opened.push(id);
          },
        }),
      ),
    );
    assert.match(doc.body.textContent!, /The reader/);
    assert.match(doc.body.textContent!, /Believes something that isn't true/);
    assert.match(doc.body.textContent!, /Known from the start/);
    await React.act(async () => {
      const el = doc.querySelector("select")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLSelectElement.prototype,
        "value",
      )!.set!.call(el, "later");
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.match(doc.body.textContent!, /Learned in Earlier book/);
    await click(button("Open Fact"));
    assert.deepEqual(opened, ["fact"]);
    assert.equal(calls[0].url, "/api/books/book/knowledge?asOf=scene");
    assert.equal(calls[1].url, "/api/books/book/knowledge?asOf=later");
    assert.ok(calls.every((c) => c.method === "GET"));
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

// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted bible exports retain failed version/format/request IDs, refresh saved versions without dropping drafts and expose download links", async () => {
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
    const { BibleExports } =
      await import("../../../apps/web/src/bible-exports.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const doc = dom.window.document;
    const calls: any[] = [];
    let fail = true,
      stamp = "old";
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: string, o: any) => {
        if (o.method === "POST") {
          const input = JSON.parse(o.body);
          calls.push(input);
          return new Response(
            JSON.stringify(
              fail
                ? { error: { message: "Book changed. Label kept." } }
                : {
                    book: { id: "book", title: "Book", updatedAt: "new" },
                    export: {
                      id: input.id,
                      version: input.version,
                      format: input.format,
                      filename: "bible.pdf",
                      createdAt: "2026-11-06T00:00:00Z",
                      size: 100,
                    },
                  },
            ),
            { status: fail ? 409 : 201 },
          );
        }
        return new Response(
          JSON.stringify({
            book: { id: "book", title: "Book", updatedAt: stamp },
            nextVersion: "1.9",
            exports: [],
          }),
        );
      },
    });
    const button = (text: string) =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === text,
      )!;
    const click = async (el: HTMLElement) => React.act(async () => el.click());
    const set = async (
      el: HTMLInputElement | HTMLSelectElement,
      value: string,
    ) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          el.tagName === "SELECT"
            ? dom.window.HTMLSelectElement.prototype
            : dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(el, value);
        el.dispatchEvent(
          new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", {
            bubbles: true,
          }),
        );
      });
    await React.act(async () =>
      root.render(
        React.createElement(BibleExports, {
          bookId: "book",
          onSaved: () => {},
        }),
      ),
    );
    assert.equal((doc.querySelector("input") as HTMLInputElement).value, "1.9");
    await set(doc.querySelector("input")!, "2.0 draft");
    await set(doc.querySelector("select")!, "pdf");
    await click(button("Save Export"));
    assert.match(doc.body.textContent!, /Label kept/);
    assert.equal(
      (doc.querySelector("input") as HTMLInputElement).value,
      "2.0 draft",
    );
    await click(button("Save Export"));
    assert.equal(calls[0].id, calls[1].id);
    stamp = "fresh";
    await click(button("Check Saved Versions"));
    assert.equal(
      (doc.querySelector("input") as HTMLInputElement).value,
      "2.0 draft",
    );
    assert.equal(
      (doc.querySelector("select") as HTMLSelectElement).value,
      "pdf",
    );
    fail = false;
    await click(button("Save Export"));
    assert.equal(calls[2].expectedUpdatedAt, "fresh");
    assert.match(doc.querySelector("a")!.href, /bible-exports/);
    assert.equal(
      doc.querySelector("a")!.textContent,
      "Download PDF version 2.0 draft",
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

// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("Cancel Import keeps the preview and explains when the commit is already in flight", async () => {
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
    const { PortableLibraries } =
      await import("../../../apps/web/src/portable.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const doc = dom.window.document;
    let cancelled = false;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      const v = u.endsWith("/cancel")
        ? { cancelled }
        : {
            id: "preview",
            libraryTitle: "Book room",
            counts: { books: 1 },
            words: 1,
            attachments: 0,
            warnings: [],
            targetExists: false,
            conflictingIds: false,
          };
      return new Response(JSON.stringify(v), { status: 200 });
    }) as typeof fetch;
    const button = (name: string) =>
      [...doc.querySelectorAll("button")].find((b) => b.textContent === name)!;
    await React.act(async () =>
      root.render(
        React.createElement(PortableLibraries, {
          library: { id: "lib", title: "Book room" },
          onImported: async () => {},
        }),
      ),
    );
    const file = doc.querySelector("input[type=file]")!;
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [new dom.window.File(["ZIP"], "sample.rolltop")],
    });
    await React.act(async () =>
      file.dispatchEvent(new dom.window.Event("change", { bubbles: true })),
    );
    await React.act(async () => button("Cancel Import").click());
    assert.match(doc.body.textContent!, /already being installed/);
    assert.ok(button("Cancel Import"), "preview is kept");
    cancelled = true;
    await React.act(async () => button("Cancel Import").click());
    assert.equal(doc.querySelector("input[type=file]") !== null, true);
    assert.equal(
      [...doc.querySelectorAll("button")].some(
        (b) => b.textContent === "Cancel Import",
      ),
      false,
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

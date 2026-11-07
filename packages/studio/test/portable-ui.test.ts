// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted portable import defaults safely, retains replacement confirmation after errors, and attachment picker retains the exact chosen hash", async () => {
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
    const { PortableLibraries } =
      await import("../../../apps/web/src/portable.tsx");
    const { AttachmentField } =
      await import("../../../apps/web/src/attachments.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const doc = dom.window.document,
      calls: any[] = [];
    let fail = true,
      imported = false;
    const sha = "a".repeat(64);
    globalThis.fetch = async (url: any, o: any = {}) => {
      calls.push({ url, ...o });
      let v: any,
        status = 200;
      if (String(url).endsWith("/commit")) {
        if (fail) {
          v = { error: { message: "Target changed. Confirmation kept." } };
          status = 409;
        } else v = { library: { id: "lib", title: "Book room" } };
      } else if (String(url).endsWith("/archive-imports"))
        v = {
          id: "preview",
          libraryTitle: "Book room",
          counts: { books: 2 },
          words: 42,
          attachments: 1,
          warnings: [],
          targetExists: true,
          conflictingIds: false,
        };
      else if (String(url).endsWith("/attachments"))
        v = [
          {
            sha256: sha,
            originalName: "Reference.txt",
            byteLength: 8,
            mediaType: "text/plain",
          },
        ];
      else v = {};
      return new Response(JSON.stringify(v), { status });
    };
    const button = (name: string) =>
      [...doc.querySelectorAll("button")].find((b) => b.textContent === name)!;
    const click = async (el: Element) =>
      React.act(async () => {
        (el as HTMLElement).click();
      });
    await React.act(async () =>
      root.render(
        React.createElement(PortableLibraries, {
          library: { id: "lib", title: "Book room" },
          onImported: async () => {
            imported = true;
          },
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
    assert.equal(button("Import Library").disabled, true);
    assert.equal(
      calls.filter((c) => String(c.url).endsWith("/commit")).length,
      0,
    );
    await click(doc.querySelector("input[type=checkbox]")!);
    const text = doc.querySelector("input:not([type])")!;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(text, "Book room");
      text.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click(button("Import Library"));
    assert.match(doc.body.textContent!, /Confirmation kept/);
    assert.equal((text as HTMLInputElement).value, "Book room");
    assert.equal(
      (doc.querySelector("input[type=checkbox]") as HTMLInputElement).checked,
      true,
    );
    assert.deepEqual(
      JSON.parse(calls.find((c) => String(c.url).endsWith("/commit")).body),
      { mode: "replace", confirmed: true, confirmTitle: "Book room" },
    );
    fail = false;
    await click(button("Import Library"));
    assert.equal(imported, true);
    let savedValue: any;
    await React.act(async () =>
      root.render(
        React.createElement(AttachmentField, {
          libraryId: "lib",
          value: sha,
          onSave: (v: any) => {
            savedValue = v;
          },
          onCancel: () => {},
        }),
      ),
    );
    assert.equal((doc.querySelector("select") as HTMLSelectElement).value, sha);
    assert.match(doc.querySelector("a")!.href, new RegExp(sha));
    await click(button("Save Attachment"));
    assert.equal(savedValue, sha);
    await click(button("Clear Attachment"));
    assert.equal(savedValue, null);
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

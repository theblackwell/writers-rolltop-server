// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";

test("mounted Entry Trash requires exact name/shared consent, retains failed confirmation, supports cancel and shows recovery receipt", async () => {
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
    const { EntryList } = await import("../../../apps/web/src/entries.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const now = "2026-11-05T00:00:00.000Z",
      entry = {
        id: crypto.randomUUID(),
        name: "Shared Person",
        entryType: "character",
        aliases: [],
        scope: { kind: "universe", id: crypto.randomUUID() },
        updatedAt: now,
        deletedAt: now,
      };
    let entries = [entry],
      calls: any[] = [],
      failure = true,
      purged = "",
      error = "";
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (_url: string, options: any) => {
        calls.push(JSON.parse(options.body));
        return new Response(
          JSON.stringify(
            failure
              ? { error: { message: "Changed elsewhere" } }
              : { backup: "verified.book-recovery.json" },
          ),
          {
            status: failure ? 409 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });
    const render = () =>
      root.render(
        React.createElement(EntryList, {
          bookId: crypto.randomUUID(),
          book: { id: "book" },
          catalog: { templates: [], fields: [] },
          entries,
          busy: false,
          onSaved: () => {},
          onInspect: () => {},
          onPurged: async (id: string) => {
            purged = id;
            entries = [];
            render();
          },
          action: async (work: () => Promise<void>) => {
            try {
              await work();
            } catch (e) {
              error = (e as Error).message;
            }
          },
        }),
      );
    await React.act(async () => render());
    const doc = dom.window.document;
    const button = (name: string) =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === name,
      )!;
    const click = async (el: HTMLElement) => React.act(async () => el.click());
    await click(doc.querySelector('input[type="checkbox"]')!);
    await click(button("Delete Entry Permanently…"));
    assert.equal(button("Delete Permanently").disabled, true);
    const input = doc.querySelector(
      'input[autocomplete="off"]',
    ) as HTMLInputElement;
    const fill = async (value: string) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    await fill("shared person");
    assert.equal(button("Delete Permanently").disabled, true);
    await fill(entry.name);
    assert.equal(
      button("Delete Permanently").disabled,
      true,
      "shared acknowledgment still needed",
    );
    await click(doc.querySelector('form input[type="checkbox"]')!);
    assert.equal(button("Delete Permanently").disabled, false);
    await click(button("Delete Permanently"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].editSharedCanon, true);
    assert.equal(calls[0].expectedUpdatedAt, now);
    assert.equal(calls[0].expectedDeletedAt, now);
    assert.equal(input.value, entry.name);
    assert.ok(error);
    assert.equal(purged, "");
    await click(button("Cancel"));
    assert.equal(doc.querySelector("form[aria-label]"), null);
    await click(button("Delete Entry Permanently…"));
    assert.equal(
      (doc.querySelector('input[autocomplete="off"]') as HTMLInputElement)
        .value,
      "",
    );
    // The newly mounted form resets confirmation, then successful deletion
    // removes the entry and retains the administrator's recovery receipt.
    await React.act(async () => {
      const field = doc.querySelector('input[autocomplete="off"]')!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, entry.name);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click(doc.querySelector('form input[type="checkbox"]')!);
    failure = false;
    await click(button("Delete Permanently"));
    assert.equal(purged, entry.id);
    assert.match(
      doc.querySelector('[role="status"]')!.textContent!,
      /verified.book-recovery.json/,
    );
    assert.equal(button("Delete Entry Permanently…"), undefined);
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

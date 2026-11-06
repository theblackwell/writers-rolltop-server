// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted planning preserves stale drafts, explicit optional clearing, targets and unavailable links", async () => {
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
    const { Planning } = await import("../../../apps/web/src/planning.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const catalog = {
      book: { id: "book", title: "Book", updatedAt: "book-v1", logline: "Old" },
      nodes: [
        {
          id: "chapter",
          title: "Chapter",
          kind: "chapter",
          updatedAt: "node-v1",
          targetWordCount: 50,
          plan: "Old beats",
          synopsis: "",
          status: "Revision",
          povEntryId: "missing",
        },
      ],
      entries: [],
      words: 10,
      nodeWords: { chapter: 10 },
    };
    const calls: any[] = [];
    let fail = true;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: string, o: any) => {
        if (o.method === "PUT") {
          const input = JSON.parse(o.body);
          calls.push({ url, input });
          return new Response(
            JSON.stringify(
              fail
                ? {
                    error: {
                      message:
                        "This planning item changed. Your draft is kept.",
                    },
                  }
                : { ...catalog.nodes[0], ...input, updatedAt: "node-v2" },
            ),
            { status: fail ? 409 : 200 },
          );
        }
        return new Response(JSON.stringify(catalog));
      },
    });
    const doc = dom.window.document;
    const button = (text: string) =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === text,
      )!;
    const click = async (el: HTMLElement) => React.act(async () => el.click());
    const field = (text: string) =>
      Array.from(doc.querySelectorAll("label"))
        .find((l) => l.firstChild?.textContent === text)!
        .querySelector("textarea,input,select")! as HTMLInputElement;
    const fill = async (el: HTMLInputElement, value: string) =>
      React.act(async () => {
        const proto =
          el.tagName === "TEXTAREA"
            ? dom.window.HTMLTextAreaElement.prototype
            : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
        el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
    const updates: any[] = [];
    await React.act(async () =>
      root.render(
        React.createElement(Planning, {
          bookId: "book",
          onSaved: (...a: any[]) => updates.push(a),
        }),
      ),
    );
    assert.match(doc.body.textContent!, /10 words written/);
    assert.match(doc.body.textContent!, /50 planned/);
    await click(button("Edit Chapter"));
    assert.match(doc.body.textContent!, /unavailable; kept until cleared/);
    await fill(field("Plan"), "Local beats");
    await fill(field("Planned words"), "75");
    await click(button("Save Planning"));
    assert.match(doc.body.textContent!, /Your draft is kept/);
    assert.equal(field("Plan").value, "Local beats");
    assert.equal(field("Planned words").value, "75");
    assert.equal(
      (doc.querySelector("select") as HTMLSelectElement).value,
      "missing",
    );
    assert.equal(calls[0].input.expectedUpdatedAt, "node-v1");
    assert.equal(calls[0].input.synopsis, "");
    assert.equal(calls[0].input.povEntryId, "missing");
    const include = Array.from(doc.querySelectorAll("label"))
      .find((l) => l.textContent === "Include synopsis")!
      .querySelector("input")!;
    await click(include);
    fail = false;
    await click(button("Save Planning"));
    assert.equal(calls[1].input.synopsis, null);
    assert.equal(updates.length, 1);
    assert.equal(updates[0][1], false);
    await click(button("Edit Story Overview"));
    await fill(field("Logline"), "New idea");
    await click(button("Save Planning"));
    assert.equal(calls[2].input.logline, "New idea");
    assert.equal(calls[2].input.expectedUpdatedAt, "book-v1");
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

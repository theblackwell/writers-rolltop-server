// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted questions preserve stale text/topic/status/decision/about/deadline draft, explicit shared consent and Trash/restore", async () => {
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
    const { Questions, QuestionForm } =
      await import("../../../apps/web/src/questions.tsx");
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
      questions: [],
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
              error: { message: "This question changed. Keep your draft." },
            }),
            { status: 409 },
          );
        const question = {
          id: "question",
          scope: { kind: "universe", id: "world" },
          text: "The secret",
          topic: "Mystery",
          status: "decided",
          decision: "",
          entryIds: ["char"],
          updatedAt: "new",
          ...v,
        };
        if (v.deleted === false) delete question.deletedAt;
        else if (v.deleted) question.deletedAt = "trash";
        return new Response(JSON.stringify(question));
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
        .find((l) =>
          Array.from(l.childNodes).some(
            (n) => n.nodeType === 3 && n.textContent?.trim() === label,
          ),
        )!
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
      root.render(React.createElement(Questions, { bookId: "book" })),
    );
    await click(button("New Question…"));
    await fill("Question", "The secret");
    await fill("Topic", "Mystery");
    await fill("Status", "decided");
    await click(control("Include a decision"));
    await fill("Scope", "universe");
    await fill("Decide by", "scene");
    await fill("About entry", "char");
    await click(button("Add About Entry"));
    assert.equal(button("Save Question").disabled, true);
    await click(
      control("Create this shared question for all books in its scope"),
    );
    await click(button("Save Question"));
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /changed/);
    assert.equal(control("Question").value, "The secret");
    assert.equal(control("Topic").value, "Mystery");
    assert.equal(control("Status").value, "decided");
    assert.equal(control("Decision").value, "");
    assert.equal(control("Decide by").value, "scene");
    assert.deepEqual(calls[0].entryIds, ["char"]);
    assert.equal(calls[0].decision, "");
    assert.equal(calls[0].topic, "Mystery");
    failure = false;
    await click(button("Save Question"));
    assert.equal(doc.querySelector("textarea"), null);
    assert.match(doc.body.textContent!, /Decided/);
    await click(button("Move Question to Trash…"));
    assert.equal(button("Move Question to Trash").disabled, true);
    await click(
      control(
        "Apply this change to the shared question for all books in its scope",
      ),
    );
    await click(button("Move Question to Trash"));
    assert.equal(calls.at(-1).editSharedCanon, true);
    assert.equal(calls.at(-1).expectedUpdatedAt, "new");
    await click(doc.querySelector('input[type="checkbox"]')!);
    await click(button("Restore Question…"));
    assert.equal(button("Restore Question").disabled, true);
    await click(doc.querySelector('form input[type="checkbox"]')!);
    await click(button("Restore Question"));
    assert.equal(calls.at(-1).deleted, false);
    // A saved point outside selected scope is shown and kept until explicitly cleared.
    const odd = {
      id: "odd",
      scope: { kind: "book", id: "book" },
      text: "Kept",
      status: "open" as const,
      entryIds: [],
      nodeId: "missing",
      updatedAt: "stamp",
    };
    await React.act(async () =>
      root.render(
        React.createElement(QuestionForm, {
          catalog,
          question: odd,
          mode: "edit",
          busy: false,
          onCancel: () => {},
          onSave: async () => {},
        }),
      ),
    );
    assert.equal(control("Decide by").value, "missing");
    assert.equal(button("Save Question").disabled, true);
    assert.match(doc.body.textContent!, /outside selected scope/);
    const values: any[] = [];
    await React.act(async () =>
      root.render(
        React.createElement(QuestionForm, {
          catalog,
          question: odd,
          mode: "edit",
          busy: false,
          onCancel: () => {},
          onSave: async (v: object) => {
            values.push(v);
          },
        }),
      ),
    );
    await fill("Decide by", "");
    await click(button("Save Question"));
    assert.equal(values.at(-1).decision, null);
    assert.equal(values.at(-1).topic, null);
    assert.equal(values.at(-1).nodeId, null);
    await click(control("Include a decision"));
    await fill("Decision", "Keep this answer");
    await fill("Status", "decided");
    await fill("Status", "open");
    await click(button("Save Question"));
    assert.equal(values.at(-1).decision, "Keep this answer");
    assert.equal(values.at(-1).status, "open");
    await click(control("Include a decision"));
    await click(button("Save Question"));
    assert.equal(values.at(-1).decision, null);
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

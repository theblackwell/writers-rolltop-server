// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted state controls preserve typed false/note/point drafts through conflict and shared Trash/restore", async () => {
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
    const { StateChangeForm } =
      await import("../../../apps/web/src/state-changes.tsx");
    const { EntryChanges } =
      await import("../../../apps/web/src/entry-changes.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const entry: any = {
      id: "entry",
      name: "Keeper",
      scope: { kind: "universe", id: "world" },
      templateId: "template",
      updatedAt: "entry-stamp",
      values: { field: true },
      overrides: [],
      entryType: "character",
    };
    const field: any = {
      id: "field",
      label: "Has the key",
      templateId: "template",
      fieldType: "boolean",
      updatedAt: "field-stamp",
    };
    const catalog: any = {
      book: { id: "book", universeId: "world" },
      books: [
        { id: "book", title: "Book", universeId: "world", orderKey: "a" },
      ],
      entries: [entry],
      fields: [field],
      events: [
        {
          id: "event",
          title: "Discovery",
          scope: { kind: "universe", id: "world" },
          sceneIds: ["scene"],
        },
      ],
      nodes: [
        {
          id: "chapter",
          bookId: "book",
          title: "Chapter",
          kind: "chapter",
          orderKey: "a",
        },
        {
          id: "scene",
          bookId: "book",
          parentId: "chapter",
          title: "Scene",
          kind: "scene",
          orderKey: "a",
          inTrash: false,
        },
      ],
      stateChanges: [],
    };
    const calls: any[] = [];
    let failure = true;
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
              error: { message: "This change changed. Keep your draft." },
            }),
            { status: 409 },
          );
        const change: any = {
          id: "change",
          entryId: "entry",
          fieldId: "field",
          value: false,
          nodeId: "scene",
          note: "",
          createdAt: "2026-01-01",
          updatedAt: "new",
          ...v,
        };
        if (v.deleted === true) change.deletedAt = "trash";
        else delete change.deletedAt;
        return new Response(JSON.stringify(change));
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
    const rel: any = {
      data: { relationshipTypes: [], relationships: [] },
      loaded: true,
      error: "",
      reload: async () => {},
      setError: () => {},
    };
    const page = (canon: boolean) =>
      React.createElement(EntryChanges, {
        entry,
        bookId: "book",
        canon,
        rel,
        flush: async () => true,
      } as any);
    // A shared entry's changes are locked until the page is in canon mode.
    await React.act(async () => root.render(page(false)));
    assert.match(doc.body.textContent!, /Shared canon/);
    assert.equal(button("Add Change…").matches(":disabled"), true);
    await React.act(async () => root.render(page(true)));
    assert.equal(button("Add Change…").matches(":disabled"), false);
    await click(button("Add Change…"));
    // Canon mode is the confirmation: no second checkbox.
    assert.equal(
      Array.from(doc.querySelectorAll("label")).some((l) =>
        l.textContent?.includes("Apply this state change"),
      ),
      false,
    );
    await fill("From chapter or scene", "scene");
    await click(control("Include a note"));
    await fill("Note", "");
    await fill("Has the key", "false");
    await click(button("Save Value"));
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /changed/);
    assert.equal(control("Has the key").value, "false");
    assert.equal(control("From chapter or scene").value, "scene");
    assert.equal(control("Note").value, "");
    assert.equal(calls[0].value, false);
    assert.equal(calls[0].note, "");
    assert.equal(calls[0].nodeId, "scene");
    assert.equal(calls[0].entryId, "entry");
    assert.equal(calls[0].editSharedCanon, true);
    assert.equal(calls[0].expectedEntryUpdatedAt, "entry-stamp");
    assert.equal(calls[0].expectedFieldUpdatedAt, "field-stamp");
    assert.equal(button("Clear Value"), undefined);
    failure = false;
    await click(button("Save Value"));
    await fill("As of chapter or scene", "scene");
    assert.match(doc.body.textContent!, /false/);
    assert.match(doc.body.textContent!, /Set by change/);
    await click(button("Edit Change…"));
    await fill("Change from", "event");
    await fill("From event", "event");
    await click(button("Save Value"));
    assert.equal(calls.at(-1).eventId, "event");
    assert.equal(calls.at(-1).nodeId, null);
    assert.equal(calls.at(-1).expectedUpdatedAt, "new");
    await click(button("Move Change to Trash…"));
    assert.equal(button("Move Change to Trash").disabled, false);
    await click(button("Move Change to Trash"));
    assert.equal(calls.at(-1).deleted, true);
    await click(control("Show State Change Trash"));
    await click(button("Restore Change…"));
    await click(button("Restore Change"));
    assert.equal(calls.at(-1).deleted, false);
    // Outside the entry page the form still asks for its own confirmation.
    await React.act(async () =>
      root.render(
        React.createElement(StateChangeForm, {
          catalog,
          entry,
          mode: "edit",
          busy: false,
          onCancel: () => {},
          onSave: async () => {},
        }),
      ),
    );
    await fill("From chapter or scene", "scene");
    await fill("Has the key", "true");
    assert.equal(button("Save Value").matches(":disabled"), true);
    await click(
      control(
        "Apply this state change to the shared entry for all books in its scope",
      ),
    );
    assert.equal(button("Save Value").matches(":disabled"), false);
    await React.act(async () =>
      root.render(
        React.createElement(StateChangeForm, {
          key: "stale",
          catalog,
          entry,
          change: {
            id: "old",
            fieldId: "field",
            nodeId: "missing",
            value: false,
          },
          mode: "edit",
          busy: false,
          onCancel: () => {},
          onSave: async () => {},
        }),
      ),
    );
    assert.equal(control("From chapter or scene").value, "missing");
    assert.match(doc.body.textContent!, /outside entry scope/);
    assert.equal(button("Save Value").matches(":disabled"), true);
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

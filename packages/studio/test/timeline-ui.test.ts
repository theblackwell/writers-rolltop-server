// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
test("mounted timeline preserves complete failed drafts, optional clearing, shared consent, unavailable links and Trash/restore", async () => {
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
    const { Timeline, TimelineEventForm } =
      await import("../../../apps/web/src/timeline.tsx");
    root = createRoot(dom.window.document.getElementById("root")!);
    const book = { id: "book", title: "Book", universeId: "world" };
    const catalog: any = {
      book,
      scopes: [
        { kind: "book", id: "book", title: "This book" },
        { kind: "universe", id: "world", title: "Shared world: World" },
      ],
      events: [],
      readingPositions: { scene: 0 },
      entries: [
        {
          id: "char",
          name: "Keeper",
          entryType: "character",
          scope: { kind: "book", id: "other" },
        },
        {
          id: "entry",
          name: "Storm",
          entryType: "event",
          scope: { kind: "universe", id: "world" },
        },
      ],
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
          id: "elsewhere",
          bookId: "other",
          title: "Elsewhere",
          kind: "scene",
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
              error: { message: "This event changed. Keep your draft." },
            }),
            { status: 409 },
          );
        const event = {
          id: "event",
          scope: { kind: "universe", id: "world" },
          title: "Storm",
          summary: "",
          when: { label: "Third moon", calendar: "Old calendar", ordinal: -3 },
          entryId: "entry",
          sceneIds: ["scene"],
          participants: [{ entryId: "char", role: "Witness" }],
          updatedAt: "new",
          orderKey: "a",
          ...v,
        };
        if (v.deleted === false) delete event.deletedAt;
        else if (v.deleted) event.deletedAt = "trash";
        return new Response(JSON.stringify(event));
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
      root.render(React.createElement(Timeline, { bookId: "book" })),
    );
    await click(button("New Event…"));
    await fill("Event", "Storm");
    await click(control("Include a summary"));
    await fill("Scope", "universe");
    await fill("Event entry", "entry");
    await click(control("Include a story date"));
    await fill("As written", "Third moon");
    await fill("Calendar", "Old calendar");
    await fill("Order number", "-3");
    await fill("Add scene", "scene");
    await click(button("Add Scene"));
    await fill("Add participant", "char");
    await click(button("Add Participant"));
    const role = Array.from(doc.querySelectorAll("label")).find((l) =>
      l.textContent?.startsWith("Role for"),
    )!.firstChild!.textContent!;
    await fill(role, "Witness");
    assert.equal(button("Save Event").disabled, true);
    await click(control("Create this shared event for all books in its scope"));
    await click(button("Save Event"));
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /changed/);
    assert.equal(control("Event").value, "Storm");
    assert.equal(control("As written").value, "Third moon");
    assert.equal(control("Order number").value, "-3");
    assert.equal(control(role).value, "Witness");
    assert.deepEqual(calls[0].sceneIds, ["scene"]);
    assert.deepEqual(calls[0].participants, [
      { entryId: "char", role: "Witness" },
    ]);
    assert.equal(calls[0].entryId, "entry");
    assert.equal(calls[0].summary, "");
    assert.deepEqual(calls[0].when, {
      label: "Third moon",
      calendar: "Old calendar",
      ordinal: -3,
    });
    failure = false;
    await click(button("Save Event"));
    await click(button("Edit Event…"));
    assert.equal(control("As written").value, "Third moon");
    assert.equal(control(role).value, "Witness");
    assert.equal(button("Save Event").disabled, true);
    await click(
      control(
        "Apply this change to the shared event for all books in its scope",
      ),
    );
    await fill("Order number", "1.5");
    assert.equal(button("Save Event").disabled, true);
    await fill("Order number", "9007199254740992");
    assert.equal(button("Save Event").disabled, true);
    await fill("Order number", "0");
    assert.equal(button("Save Event").disabled, false);
    await click(button("Cancel"));
    await click(button("Move Event to Trash…"));
    assert.equal(button("Move Event to Trash").disabled, true);
    await click(
      control(
        "Apply this change to the shared event for all books in its scope",
      ),
    );
    await click(button("Move Event to Trash"));
    assert.equal(calls.at(-1).expectedUpdatedAt, "new");
    await click(control("Show Event Trash"));
    await click(button("Restore Event…"));
    assert.equal(button("Restore Event").disabled, true);
    await click(
      control(
        "Apply this change to the shared event for all books in its scope",
      ),
    );
    await click(button("Restore Event"));
    assert.equal(calls.at(-1).deleted, false);
    const values: any[] = [];
    const odd = {
      id: "odd",
      scope: { kind: "book", id: "book" },
      title: "Kept",
      when: { label: "Kept date", ordinal: 0 },
      summary: "",
      entryId: "missing",
      sceneIds: ["elsewhere"],
      participants: [{ entryId: "missing", role: "Kept role" }],
      updatedAt: "stamp",
      orderKey: "a",
    };
    await React.act(async () =>
      root.render(
        React.createElement(TimelineEventForm, {
          catalog,
          event: odd,
          mode: "edit",
          busy: false,
          onCancel: () => {},
          onSave: async (v: object) => {
            values.push(v);
          },
        }),
      ),
    );
    assert.equal(control("Event entry").value, "missing");
    assert.match(doc.body.textContent!, /outside selected scope/);
    assert.match(doc.body.textContent!, /Unavailable entry/);
    assert.equal(button("Save Event").disabled, true);
    await fill("Event entry", "");
    await click(button("Remove Scene"));
    await click(button("Remove Participant"));
    await click(control("Include a summary"));
    await click(control("Include a story date"));
    await click(button("Save Event"));
    assert.equal(values.at(-1).summary, null);
    assert.equal(values.at(-1).when, null);
    assert.equal(values.at(-1).entryId, null);
    assert.deepEqual(values.at(-1).sceneIds, []);
    assert.deepEqual(values.at(-1).participants, []);
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

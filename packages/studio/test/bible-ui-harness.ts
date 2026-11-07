// SPDX-License-Identifier: AGPL-3.0-only
// Shared jsdom harness for the Story Bible UI tests. It compiles and mounts the
// actual app components and fakes only the HTTP server, which keeps the entry
// version rules (expectedUpdatedAt, 409, editSharedCanon) in one place.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";

export type Call = { method: string; path: string; body?: any };
export type Fake = {
  entries: any[];
  catalog: { templates: any[]; fields: any[] };
  worlds: { universes: any[]; series: any[] };
  book: { id: string; universeId?: string; seriesId?: string };
  calls: Call[];
  version: number;
  /** Return a Response to fail a call, or undefined to let the fake handle it. */
  intercept?: (call: Call) => Response | undefined;
  /** Awaited before each non-GET response; lets a test hold a write open. */
  hold?: (call: Call) => Promise<void> | undefined;
  puts: () => Call[];
};

export const now = "u0";
export const entry = (name: string, entryType = "character", extra = {}) => ({
  id: name.toLowerCase().replace(/\W/g, "-"),
  name,
  entryType,
  aliases: [] as string[],
  updatedAt: now,
  scope: { kind: "book", id: "book" },
  ...extra,
});
export const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

export async function setup() {
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
    "FormData",
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
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { StoryBible } = await import("../../../apps/web/src/story-bible.tsx");
  (dom.window as any).HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  let root: any = createRoot(dom.window.document.getElementById("root")!);
  const doc = dom.window.document;

  const fake: Fake = {
    entries: [],
    catalog: { templates: [], fields: [] },
    worlds: { universes: [], series: [] },
    book: { id: "book" },
    calls: [],
    version: 0,
    puts: () => fake.calls.filter((c) => c.method === "PUT"),
  };
  const bump = () => `u${++fake.version}`;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (url: string, options: any = {}) => {
      const path = new URL(url, "http://localhost").pathname.replace(
        /^\/api/,
        "",
      );
      const method = options.method ?? "GET";
      const body = options.body ? JSON.parse(options.body) : undefined;
      const call = { method, path, body };
      fake.calls.push(call);
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status });
      const failure = fake.intercept?.(call);
      if (failure) return failure;
      if (method !== "GET") await fake.hold?.(call);
      if (method === "POST" && path.endsWith("/entries")) {
        const made = entry(body.name, body.entryType, {
          updatedAt: bump(),
          scope: { kind: body.scopeKind ?? "book", id: "scope" },
        });
        fake.entries = [...fake.entries, made];
        return json(made, 201);
      }
      const m = path.match(
        /^\/books\/book\/entries\/([^/]+)(?:\/(template|attachments|values\/([^/]+)))?$/,
      );
      if (method === "PUT" && m) {
        const old = fake.entries.find((e) => e.id === m[1]);
        if (!old) return jsonError(404, "Not found");
        if (body.expectedUpdatedAt !== old.updatedAt)
          return jsonError(409, "This entry changed.");
        const shared = old.scope.kind !== "book";
        const overrideWrite = m[3] && body.mode === "book";
        if (shared && !overrideWrite && body.editSharedCanon !== true)
          return jsonError(400, "Confirm editing shared canon.");
        let next: any = { ...old, updatedAt: bump() };
        if (m[3]) {
          const id = m[3];
          if (overrideWrite) {
            const prior = old.overrides?.find((o: any) => o.bookId === "book");
            const values = { ...prior?.values };
            if (body.value === null) delete values[id];
            else values[id] = body.value;
            next.overrides = Object.keys(values).length
              ? [{ bookId: "book", values }]
              : [];
          } else {
            const values = { ...old.values };
            if (body.value === null) delete values[id];
            else values[id] = body.value;
            next.values = values;
          }
        } else if (m[2] === "template") {
          if (body.templateId === null) delete next.templateId;
          else next.templateId = body.templateId;
        } else {
          const { expectedUpdatedAt, editSharedCanon, ...patch } = body;
          if (patch.deleted === true) next.deletedAt = next.updatedAt;
          else if (patch.deleted === false) delete next.deletedAt;
          delete patch.deleted;
          if (patch.givenName !== undefined || patch.familyName !== undefined) {
            next.givenName = patch.givenName;
            next.familyName = patch.familyName;
            next.name = [patch.givenName, patch.familyName]
              .filter(Boolean)
              .join(" ");
            delete patch.givenName;
            delete patch.familyName;
          }
          if (patch.summary === "") {
            delete next.summary;
            delete patch.summary;
          }
          if (patch.toBeNamed === false) {
            delete next.toBeNamed;
            delete patch.toBeNamed;
          }
          next = { ...next, ...patch };
        }
        fake.entries = fake.entries.map((e) => (e.id === next.id ? next : e));
        return json(next);
      }
      if (path === "/books/book/entries") return json(fake.entries);
      if (path.endsWith("/relationships"))
        return json({ relationshipTypes: [], relationships: [] });
      if (path.endsWith("/appearances")) return json({ appearances: [] });
      if (path.endsWith("/family")) return json({ matches: [] });
      if (path.endsWith("/templates")) return json(fake.catalog);
      if (path.endsWith("/worlds")) return json(fake.worlds);
      return json({ libraryId: "lib", book: fake.book, nodes: [] });
    },
  });

  type Mounted = { selected?: string; tool: any };
  const state: Mounted = { tool: null };
  const flushRef: { current: null | (() => Promise<boolean>) } = {
    current: null,
  };
  let epoch = 0;
  const render = () =>
    root.render(
      React.createElement(StoryBible, {
        key: epoch,
        bookId: "book",
        selectedId: state.selected,
        onSelect: (id: string | undefined) => {
          state.selected = id;
          render();
        },
        tool: state.tool,
        onTool: (tool: any) => {
          state.tool = tool;
          render();
        },
        flushRef,
      } as any),
    );
  const t = {
    dom,
    React,
    doc,
    fake,
    state,
    flushRef,
    text: () => doc.body.textContent ?? "",
    render,
    /** Remount StoryBible as a page reload would, keeping the selection. */
    remount: async () => {
      epoch++;
      await React.act(async () => render());
      await React.act(async () => {});
    },
    mount: async () => {
      await React.act(async () => render());
      await React.act(async () => {});
    },
    /** What the app's leave() does before it changes view. */
    flush: async () => {
      let ok = true;
      await React.act(async () => {
        ok = (await flushRef.current?.()) ?? true;
      });
      return ok;
    },
    settle: async () => React.act(async () => {}),
    click: async (el: Element | undefined | null) => {
      if (!el) throw new Error("Nothing to click");
      await React.act(async () => (el as HTMLElement).click());
    },
    button: (label: string, within: ParentNode = doc) =>
      Array.from(within.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(label),
      ),
    field: (label: string): any =>
      Array.from(doc.querySelectorAll("label"))
        .find((l) => l.firstChild?.textContent?.trim() === label)
        ?.querySelector("input,textarea,select"),
    type: async (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
      React.act(async () => {
        const proto =
          el instanceof dom.window.HTMLTextAreaElement
            ? dom.window.HTMLTextAreaElement.prototype
            : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
        el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }),
    choose: async (el: HTMLSelectElement, value: string) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLSelectElement.prototype,
          "value",
        )!.set!.call(el, value);
        el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      }),
    blur: async (el: Element) =>
      React.act(async () => {
        (el as HTMLElement).focus();
        (el as HTMLElement).blur();
      }),
    key: async (el: Element, key: string) =>
      React.act(async () => {
        el.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      }),
    cleanup: async () => {
      await React.act(async () => root.unmount());
      hooks.deregister();
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as any)[key];
      }
    },
  };
  return t;
}

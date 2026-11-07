// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";

// Mounts the real app shell (main.tsx) with a fake server, to prove how the
// Library menu and the warnings list reach the Story Bible record pages.
test("Library shortcuts and warnings open the Story Bible record pages, and the warnings list stays reachable", async () => {
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
    "localStorage",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "DocumentFragment",
    "Range",
    "Selection",
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
      if (url.endsWith(".css"))
        return { format: "module", shortCircuit: true, source: "export {};" };
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
  try {
    (dom.window as any).HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    const calls: string[] = [];
    const book = { id: "book", title: "Book", libraryId: "lib" };
    const fact = {
      id: "f1",
      scope: { kind: "book", id: "book" },
      text: "The moon is hollow",
      truth: "true",
      entryIds: [],
      knowledge: [],
      updatedAt: "u0",
    };
    const warning = {
      id: "f1/undecidedButKnown",
      kind: "undecidedButKnown",
      key: "undecidedButKnown",
      subject: { kind: "fact", id: "f1" },
      message: "The moon is undecided but the reader knows it.",
      nodeIds: [],
    };
    const catalogOf = (key: string, list: unknown[]) => ({
      book,
      readingPositions: {},
      scopes: [{ kind: "book", id: "book", title: "This book" }],
      [key]: list,
      entries: [],
      books: [book],
      nodes: [],
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: string, options: any = {}) => {
        const path = new URL(url, "http://localhost").pathname.replace(
          /^\/api/,
          "",
        );
        calls.push(`${options.method ?? "GET"} ${path}`);
        const json = (data: unknown) => new Response(JSON.stringify(data));
        if (path === "/session") return json({});
        if (path === "/libraries")
          return json([{ id: "lib", title: "Library" }]);
        if (path === "/libraries/lib")
          return json({
            library: { id: "lib", title: "Library" },
            books: [book],
          });
        if (path === "/books/book")
          return json({ book, nodes: [], libraryId: "lib" });
        if (path === "/books/book/continuity")
          return json({
            warnings: [warning],
            intentionalCount: 0,
            checkedAt: "stamp",
            subjects: [
              { id: warning.id, title: "The moon is hollow", updatedAt: "u0" },
            ],
          });
        if (path === "/books/book/facts")
          return json(catalogOf("facts", [fact]));
        if (path === "/books/book/questions")
          return json(catalogOf("questions", []));
        if (path === "/books/book/events") return json(catalogOf("events", []));
        if (path === "/books/book/entries") return json([]);
        if (path.endsWith("/templates"))
          return json({ templates: [], fields: [] });
        if (path.endsWith("/worlds"))
          return json({ universes: [], series: [] });
        return json([]);
      },
    });
    const React = await import("react");
    const doc = dom.window.document;
    await import("../../../apps/web/src/main.tsx");
    const settle = () => React.act(async () => {});
    const click = async (el: Element | undefined | null) => {
      assert.ok(el, "nothing to click");
      await React.act(async () => (el as HTMLElement).click());
    };
    const button = (label: string, within: ParentNode = doc) =>
      Array.from(within.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(label),
      );
    await settle();
    await settle();
    await click(button("Open", doc.querySelector("main")!));
    await settle();
    const menu = doc.querySelector("details.action-menu")!;
    // The three dialogs are gone: the shortcuts open Story Bible lists.
    for (const [label, section] of [
      ["Timeline…", "Story Bible timeline"],
      ["Questions and Decisions…", "Story Bible questions"],
      ["Facts and Knowledge…", "Story Bible facts"],
    ]) {
      await click(button(label, menu));
      await settle();
      assert.equal(
        doc.querySelector("aside")?.getAttribute("aria-label"),
        section,
        label,
      );
      assert.deepEqual(
        Array.from(doc.querySelectorAll("dialog[open]")).map((d) =>
          d.getAttribute("aria-label"),
        ),
        [],
        `${label} is not a dialog`,
      );
    }
    // Warnings open the record's page and lead back to the warnings.
    await click(button("Continuity Warnings…", menu));
    await settle();
    await click(button("Open Fact", doc.querySelector("dialog[open]")!));
    await settle();
    assert.equal(
      doc.querySelectorAll("dialog[open]").length,
      0,
      "the warnings window closed",
    );
    assert.equal(
      doc.querySelector("aside")?.getAttribute("aria-label"),
      "Story Bible facts",
    );
    assert.match(
      doc.querySelector(".bible-area")!.textContent!,
      /The moon is hollow/,
    );
    assert.ok(doc.querySelector('article[aria-label="Fact page"]'));
    await click(button("Back to warnings"));
    await settle();
    assert.ok(
      doc.querySelector('dialog[open][aria-label="Continuity Warnings"]'),
      "warnings list is back",
    );
    assert.match(
      doc.querySelector("dialog[open]")!.textContent!,
      /undecided but the reader knows it/,
    );
  } finally {
    hooks.deregister();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

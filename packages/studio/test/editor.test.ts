// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { extensions } from "../../../apps/web/src/editor.ts";
import { decode } from "../../document-adapter/src/canonical.ts";
import {
  fromProseMirror,
  toProseMirror,
} from "../../document-adapter/src/prosemirror.ts";

test("the actual Tiptap schema preserves every canonical fixture, including anchors and block IDs", () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
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
    "getComputedStyle",
  ]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: (dom.window as any)[key],
    });
  }
  try {
    const base = new URL(
      "../../document-adapter/fixtures/documents/",
      import.meta.url,
    );
    const files = ["valid", "normalize"].flatMap((dir) =>
      readdirSync(new URL(dir + "/", base))
        .filter((f) => dir === "valid" || f.endsWith(".expected.json"))
        .map((f) => dir + "/" + f),
    );
    for (const file of files) {
      const doc = decode(JSON.parse(readFileSync(new URL(file, base), "utf8")));
      const editor = new Editor({
        extensions: extensions(),
        content: toProseMirror(doc),
      });
      try {
        assert.deepEqual(
          fromProseMirror(editor.getJSON(), doc.nodeId),
          doc,
          file,
        );
      } finally {
        editor.destroy();
      }
    }
  } finally {
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

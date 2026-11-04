// SPDX-License-Identifier: AGPL-3.0-only
import type { CanonicalDocument } from "./canonical.ts";
/** Join marked runs without inserting word boundaries; breaks separate words. */
export function documentText(document: CanonicalDocument): string {
  return document.blocks
    .map((b) =>
      b.type === "sceneBreak"
        ? ""
        : b.content.map((r) => (r.type === "text" ? r.text : "\n")).join(""),
    )
    .join("\n\n");
}
const segmenter = new Intl.Segmenter("en", { granularity: "word" });
/** Informational Unicode word count, using the same rule on server and browser. */
export function wordCount(document: CanonicalDocument): number {
  let count = 0;
  for (const segment of segmenter.segment(documentText(document)))
    if (segment.isWordLike) count++;
  return count;
}

// Word count of a canonical document (Intl.Segmenter word boundaries). Shared by the archive summary and the continuity warnings.

import type { CanonicalDocument } from "@writers-rolltop/document-adapter/canonical";

const segmenter = new Intl.Segmenter("en", { granularity: "word" });
export function countWords(doc: CanonicalDocument): number {
  let text = "";
  for (const b of doc.blocks) {
    if (b.type === "sceneBreak") continue;
    for (const i of b.content) text += i.type === "text" ? i.text : "\n";
    text += "\n";
  }
  let n = 0;
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
  return n;
}

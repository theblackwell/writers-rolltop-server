// SPDX-License-Identifier: AGPL-3.0-only
import { Mark } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import UniqueID from "@tiptap/extension-unique-id";
export const Anchor = Mark.create({
  name: "rolltopAnchor",
  excludes: "",
  inclusive: false,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-rolltop-anchor"),
        renderHTML: (attrs) => ({ "data-rolltop-anchor": attrs.id }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-rolltop-anchor]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});
// No code blocks, strike marks or other editor constructs absent from canonical v1.
export const extensions = () => [
  StarterKit.configure({
    code: false,
    codeBlock: false,
    strike: false,
    trailingNode: false,
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    link: { openOnClick: false, protocols: ["http", "https", "mailto"] },
  }),
  TextAlign.configure({
    types: ["heading", "paragraph"],
    defaultAlignment: null,
  }),
  UniqueID.configure({ types: ["paragraph", "heading", "horizontalRule"] }),
  Anchor,
];

// Canonical document v1 (Spec/docs/document-format-v1.md): types, validation and normalization.

export type MarkType = "strong" | "emphasis" | "underline" | "link" | "anchor";
export type Mark =
  | { type: "strong" | "emphasis" | "underline" }
  | { type: "link"; href: string }
  | { type: "anchor"; id: string };
export type Inline =
  | { type: "text"; text: string; marks?: Mark[] }
  | { type: "hardBreak" };
export type Align = "left" | "center" | "right";
export interface ListInfo { style: "bullet" | "ordered"; level: number }
export type Block =
  | { id: string; type: "paragraph"; content: Inline[]; align?: Align; quote?: true; list?: ListInfo }
  | { id: string; type: "heading"; level: number; content: Inline[]; align?: Align; quote?: true }
  | { id: string; type: "sceneBreak" };
export interface CanonicalDocument {
  schema: "writers-rolltop/document";
  version: 1;
  nodeId: string;
  blocks: Block[];
}

export type DocumentErrorCode = "DOCUMENT_INVALID" | "DOCUMENT_UNSUPPORTED_VERSION";
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  constructor(code: DocumentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DocumentError";
    this.code = code;
  }
}
const invalid = (m: string): never => { throw new DocumentError("DOCUMENT_INVALID", m); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Rule 3: U+0000-0008, 000B, 000C, 000E-001F, 007F (after N1 removes line terminators).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_TERMINATORS = new RegExp("\\r\\n|[\\r\\n\\u2028\\u2029]");
const MARK_ORDER: Record<string, number> = { strong: 0, emphasis: 1, underline: 2, link: 3, anchor: 4 };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function closed(o: Obj, allowed: string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) invalid(`${what}: unexpected field "${k}"`);
}
function uuid(v: unknown, what: string): string {
  if (typeof v !== "string" || !UUID.test(v)) invalid(`${what}: not a lowercase UUID`);
  return v as string;
}

function parseMark(v: unknown): Mark {
  if (!isObj(v)) return invalid("mark is not an object");
  switch (v.type) {
    case "strong": case "emphasis": case "underline":
      closed(v, ["type"], "mark");
      return { type: v.type };
    case "link":
      closed(v, ["type", "href"], "link mark");
      if (typeof v.href !== "string" || v.href === "") invalid("link href must be a non-empty string");
      if ((v.href as string).includes("\u0000")) invalid("link href contains a NUL character"); // Spec rule 3 (document-format-v1.md)
      return { type: "link", href: v.href as string };
    case "anchor":
      closed(v, ["type", "id"], "anchor mark");
      return { type: "anchor", id: uuid(v.id, "anchor id") };
    default:
      return invalid(`unknown mark type ${JSON.stringify(v.type)}`);
  }
}

function parseInlines(v: unknown): Inline[] {
  if (!Array.isArray(v)) return invalid("content must be an array");
  return v.map((i): Inline => {
    if (!isObj(i)) return invalid("inline is not an object");
    if (i.type === "hardBreak") { closed(i, ["type"], "hardBreak"); return { type: "hardBreak" }; }
    if (i.type !== "text") return invalid(`unknown inline type ${JSON.stringify(i.type)}`);
    closed(i, ["type", "text", "marks"], "text");
    if (typeof i.text !== "string") invalid("text must be a string");
    const marks = i.marks === undefined ? [] : Array.isArray(i.marks) ? i.marks.map(parseMark) : invalid("marks must be an array");
    return { type: "text", text: i.text as string, marks };
  });
}

function parseBlock(v: unknown): Block {
  if (!isObj(v)) return invalid("block is not an object");
  const id = uuid(v.id, "block id");
  const common = (b: { align?: Align; quote?: true }) => {
    if (v.align !== undefined) {
      if (v.align !== "left" && v.align !== "center" && v.align !== "right") invalid("align must be left, center or right");
      b.align = v.align as Align;
    }
    if (v.quote !== undefined) {
      if (v.quote !== true) invalid("quote must be true when present");
      b.quote = true;
    }
  };
  switch (v.type) {
    case "sceneBreak":
      closed(v, ["id", "type"], "sceneBreak");
      return { id, type: "sceneBreak" };
    case "paragraph": {
      closed(v, ["id", "type", "content", "align", "quote", "list"], "paragraph");
      const b: Block = { id, type: "paragraph", content: parseInlines(v.content) };
      common(b);
      if (v.list !== undefined) {
        const l = v.list;
        if (!isObj(l)) return invalid("list must be an object");
        closed(l, ["style", "level"], "list");
        if (l.style !== "bullet" && l.style !== "ordered") invalid("list style must be bullet or ordered");
        if (!Number.isInteger(l.level) || (l.level as number) < 0 || (l.level as number) > 7) invalid("list level must be an integer 0-7");
        b.list = { style: l.style as ListInfo["style"], level: l.level as number };
      }
      if (b.list && b.quote) invalid("a block cannot have both quote and list");
      return b;
    }
    case "heading": {
      closed(v, ["id", "type", "level", "content", "align", "quote"], "heading");
      if (!Number.isInteger(v.level) || (v.level as number) < 1 || (v.level as number) > 6) invalid("heading level must be an integer 1-6");
      const b: Block = { id, type: "heading", level: v.level as number, content: parseInlines(v.content) };
      common(b);
      return b;
    }
    default:
      return invalid(`unknown block type ${JSON.stringify(v.type)}`);
  }
}

const markKey = (m: Mark) => (m.type === "link" ? `link:${m.href}` : m.type === "anchor" ? `anchor:${m.id}` : m.type);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order; ids are ASCII

function normalizeInlines(raw: Inline[]): Inline[] {
  // N1: split text on line terminators into hardBreaks. N2: drop empty text.
  const split: Inline[] = [];
  for (const i of raw) {
    if (i.type === "hardBreak") { split.push(i); continue; }
    const parts = i.text.split(LINE_TERMINATORS);
    parts.forEach((p, n) => {
      if (n > 0) split.push({ type: "hardBreak" });
      if (p !== "") split.push({ type: "text", text: p, marks: i.marks ?? [] });
    });
  }
  // N3: dedupe and sort marks. Rule 4: at most one link per text node.
  const sorted = split.map((i): Inline => {
    if (i.type === "hardBreak") return i;
    const seen = new Map<string, Mark>();
    for (const m of i.marks ?? []) seen.set(markKey(m), m);
    const marks = [...seen.values()].sort((a, b) =>
      MARK_ORDER[a.type]! - MARK_ORDER[b.type]! ||
      (a.type === "anchor" && b.type === "anchor" ? cmp(a.id, b.id) : 0));
    if (marks.filter((m) => m.type === "link").length > 1) invalid("a text node has more than one link mark");
    return { type: "text", text: i.text, marks };
  });
  // N4: merge adjacent text with equal marks.
  const out: Inline[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (i.type === "text" && last?.type === "text" &&
        (last.marks ?? []).map(markKey).join("\u0000") === (i.marks ?? []).map(markKey).join("\u0000")) {
      last.text += i.text;
    } else out.push(i.type === "text" ? { ...i, marks: [...(i.marks ?? [])] } : i);
  }
  for (const i of out) {
    if (i.type !== "text") continue;
    if (CONTROL.test(i.text)) invalid("text contains a forbidden control character");
    if (i.marks?.length === 0) delete i.marks;
  }
  return out;
}

/** Validate an untrusted canonical document and return its normalized form. Throws DocumentError. */
export function normalizeDocument(input: unknown): CanonicalDocument {
  if (!isObj(input)) return invalid("document is not an object");
  if (input.schema !== "writers-rolltop/document") invalid("wrong schema identifier");
  if (typeof input.version === "number" && Number.isInteger(input.version) && input.version > 1)
    throw new DocumentError("DOCUMENT_UNSUPPORTED_VERSION", `version ${input.version} is newer than supported (1)`);
  if (input.version !== 1) invalid("version must be 1");
  closed(input, ["schema", "version", "nodeId", "blocks"], "document");
  const nodeId = uuid(input.nodeId, "nodeId");
  if (!Array.isArray(input.blocks)) invalid("blocks must be an array");

  const blocks = (input.blocks as unknown[]).map(parseBlock);
  const ids = new Set<string>();
  const anchorBlock = new Map<string, string>();
  let prevList: ListInfo | undefined;
  for (const b of blocks) {
    if (ids.has(b.id)) invalid(`duplicate block id ${b.id}`);
    ids.add(b.id);
    if (b.type !== "sceneBreak") {
      b.content = normalizeInlines(b.content);
      // Rules 5 and 6.
      const runs = new Map<string, { first: number; last: number }>();
      b.content.forEach((i, n) => {
        if (i.type !== "text") return;
        for (const m of i.marks ?? []) if (m.type === "anchor") {
          const r = runs.get(m.id);
          if (r) r.last = n; else runs.set(m.id, { first: n, last: n });
        }
      });
      for (const [id, r] of runs) {
        const owner = anchorBlock.get(id);
        if (owner !== undefined) invalid(`anchor ${id} appears in more than one block`);
        anchorBlock.set(id, b.id);
        for (let n = r.first; n <= r.last; n++) {
          const i = b.content[n]!;
          const ok = i.type === "hardBreak" || (i.marks ?? []).some((m) => m.type === "anchor" && m.id === id);
          if (!ok) invalid(`anchor ${id} is not one contiguous run`);
        }
      }
    }
    // Rule 8.
    const list = b.type === "paragraph" ? b.list : undefined;
    if (list) {
      const max = prevList ? prevList.level + 1 : 0;
      if (list.level > max) invalid("list level jumps by more than one (or first item is indented)");
    }
    prevList = list;
  }
  return { schema: "writers-rolltop/document", version: 1, nodeId, blocks };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 The Black Well Foundry
// Canonical document format v1 (writers-rolltop-spec: docs/document-format-v1.md).
// Dependency-free TypeScript mirror of the reference implementation's
// parse → normalize → validate pipeline. Uses only erasable type syntax so it
// runs directly under Node's type stripping.

export type Mark =
  | { type: "strong" }
  | { type: "emphasis" }
  | { type: "link"; href: string }
  | { type: "anchor"; id: string };

export type Inline = { type: "text"; text: string; marks?: Mark[] } | { type: "hardBreak" };

export type Block =
  | { id: string; type: "paragraph"; content: Inline[] }
  | { id: string; type: "heading"; level: number; content: Inline[] };

export type CanonicalDocument = {
  schema: "writers-rolltop/document";
  version: 1;
  nodeId: string;
  blocks: Block[];
};

export class DocumentError extends Error {
  code: "DOCUMENT_INVALID" | "DOCUMENT_UNSUPPORTED_VERSION";
  constructor(code: "DOCUMENT_INVALID" | "DOCUMENT_UNSUPPORTED_VERSION", message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINE_TERMINATOR = /\r\n|\r|\n|\u2028|\u2029/;
// C0 controls except tab, DEL, and the line/paragraph separators.
const FORBIDDEN = /[\u0000-\u0008\u000A-\u001F\u007F\u2028\u2029]/;

const invalid = (message: string) => new DocumentError("DOCUMENT_INVALID", message);

function onlyKeys(value: unknown, path: string, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${path} must be an object`);
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid(`${path}: unexpected properties ${JSON.stringify(extra.sort())}`);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${path} must be a lowercase UUID`);
  return value;
}

/** Structural parse against the closed v1 schema (no normalization). */
export function parse(value: unknown): CanonicalDocument {
  const obj = onlyKeys(value, "document", ["schema", "version", "nodeId", "blocks"]);
  if (obj.schema !== "writers-rolltop/document") throw invalid('document.schema must be "writers-rolltop/document"');
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version)) throw invalid("document.version must be an integer");
  if (obj.version > 1) {
    throw new DocumentError("DOCUMENT_UNSUPPORTED_VERSION",
      `document version ${obj.version} is newer than this server supports (1); update Writers Rolltop`);
  }
  if (obj.version !== 1) throw invalid(`unsupported document version ${obj.version}`);
  const nodeId = uuid(obj.nodeId, "document.nodeId");
  if (!Array.isArray(obj.blocks)) throw invalid("document.blocks must be an array");
  return { schema: "writers-rolltop/document", version: 1, nodeId, blocks: obj.blocks.map((b, i) => parseBlock(b, `blocks[${i}]`)) };
}

function parseBlock(value: unknown, path: string): Block {
  const type = (value as { type?: unknown } | null)?.type;
  let obj: Record<string, unknown>;
  if (type === "paragraph") {
    obj = onlyKeys(value, path, ["id", "type", "content"]);
  } else if (type === "heading") {
    obj = onlyKeys(value, path, ["id", "type", "level", "content"]);
    if (typeof obj.level !== "number" || !Number.isInteger(obj.level) || obj.level < 1 || obj.level > 6) {
      throw invalid(`${path}.level must be an integer 1–6`);
    }
  } else {
    throw invalid(`${path}: unknown block type ${JSON.stringify(type)}`);
  }
  const id = uuid(obj.id, `${path}.id`);
  if (!Array.isArray(obj.content)) throw invalid(`${path}.content must be an array`);
  const content = obj.content.map((x, i) => parseInline(x, `${path}.content[${i}]`));
  return type === "heading" ? { id, type, level: obj.level as number, content } : { id, type: "paragraph", content };
}

function parseInline(value: unknown, path: string): Inline {
  const type = (value as { type?: unknown } | null)?.type;
  if (type === "hardBreak") {
    onlyKeys(value, path, ["type"]);
    return { type: "hardBreak" };
  }
  if (type !== "text") throw invalid(`${path}: unknown inline type ${JSON.stringify(type)}`);
  const obj = onlyKeys(value, path, ["type", "text", "marks"]);
  if (typeof obj.text !== "string") throw invalid(`${path}.text must be a string`);
  if (obj.marks === undefined) return { type: "text", text: obj.text };
  if (!Array.isArray(obj.marks)) throw invalid(`${path}.marks must be an array`);
  return { type: "text", text: obj.text, marks: obj.marks.map((m, i) => parseMark(m, `${path}.marks[${i}]`)) };
}

function parseMark(value: unknown, path: string): Mark {
  const type = (value as { type?: unknown } | null)?.type;
  switch (type) {
    case "strong":
    case "emphasis":
      onlyKeys(value, path, ["type"]);
      return { type };
    case "link": {
      const obj = onlyKeys(value, path, ["type", "href"]);
      if (typeof obj.href !== "string" || obj.href === "") throw invalid(`${path}.href must be a non-empty string`);
      return { type: "link", href: obj.href };
    }
    case "anchor": {
      const obj = onlyKeys(value, path, ["type", "id"]);
      return { type: "anchor", id: uuid(obj.id, `${path}.id`) };
    }
    default:
      throw invalid(`${path}: unknown mark type ${JSON.stringify(type)}`);
  }
}

// ---------------------------------------------------------------------------
// Normalization (N1–N4). Never changes code points (N5).

const RANK: Record<Mark["type"], number> = { strong: 0, emphasis: 1, link: 2, anchor: 3 };

const byteLess = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) < 0;

function markKey(m: Mark): string {
  return m.type === "link" ? `link:${m.href}` : m.type === "anchor" ? `anchor:${m.id}` : m.type;
}

export function canonicalMarks(marks: Mark[]): Mark[] {
  const seen = new Set<string>();
  const unique = marks.filter((m) => !seen.has(markKey(m)) && seen.add(markKey(m)));
  return unique.sort((a, b) => {
    if (RANK[a.type] !== RANK[b.type]) return RANK[a.type] - RANK[b.type];
    if (a.type === "anchor" && b.type === "anchor") return byteLess(a.id, b.id) ? -1 : byteLess(b.id, a.id) ? 1 : 0;
    if (a.type === "link" && b.type === "link") return byteLess(a.href, b.href) ? -1 : byteLess(b.href, a.href) ? 1 : 0;
    return 0;
  });
}

const sameMarks = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((m, i) => markKey(m) === markKey(b[i]));

function appendText(out: Inline[], text: string, marks: Mark[]) {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last && last.type === "text" && sameMarks(last.marks ?? [], marks)) {
    last.text += text;
  } else {
    out.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
  }
}

export function normalize(doc: CanonicalDocument): CanonicalDocument {
  return {
    ...doc,
    blocks: doc.blocks.map((block) => {
      const out: Inline[] = [];
      for (const inline of block.content) {
        if (inline.type === "hardBreak") { out.push({ type: "hardBreak" }); continue; }
        const marks = canonicalMarks(inline.marks ?? []);
        inline.text.split(LINE_TERMINATOR).forEach((piece, i) => {
          if (i > 0) out.push({ type: "hardBreak" });
          appendText(out, piece, marks);
        });
      }
      return { ...block, content: out };
    }),
  };
}

// ---------------------------------------------------------------------------
// Validation (rules 2–6). Expects a normalized document.

export function validate(doc: CanonicalDocument): void {
  const problems: string[] = [];
  const blockIds = new Set<string>();
  const anchorsInEarlierBlocks = new Set<string>();
  doc.blocks.forEach((block, bi) => {
    if (blockIds.has(block.id)) problems.push(`blocks[${bi}]: duplicate block id`);
    blockIds.add(block.id);
    const lastTextIndex = new Map<string, number>();
    let textIndex = -1;
    block.content.forEach((inline, ii) => {
      if (inline.type !== "text") return;
      textIndex++;
      const path = `blocks[${bi}].content[${ii}]`;
      const marks = inline.marks ?? [];
      if (inline.text === "") problems.push(`${path}: empty text`);
      if (FORBIDDEN.test(inline.text)) problems.push(`${path}: text contains a control or line-terminator character`);
      if (!sameMarks(marks, canonicalMarks(marks))) problems.push(`${path}: marks are not normalized`);
      if (marks.filter((m) => m.type === "link").length > 1) problems.push(`${path}: more than one link mark`);
      for (const m of marks) {
        if (m.type !== "anchor") continue;
        if (anchorsInEarlierBlocks.has(m.id)) problems.push(`${path}: anchor ${m.id} appears in more than one block`);
        const last = lastTextIndex.get(m.id);
        if (last !== undefined && last !== textIndex - 1) problems.push(`${path}: anchor ${m.id} is not contiguous`);
        lastTextIndex.set(m.id, textIndex);
      }
    });
    for (const id of lastTextIndex.keys()) anchorsInEarlierBlocks.add(id);
  });
  if (JSON.stringify(normalize(doc)) !== JSON.stringify(doc)) problems.push("document is not normalized");
  if (problems.length) throw invalid(`invalid document ${doc.nodeId}: ${problems.join("; ")}`);
}

/** parse → normalize → validate, the pipeline every reader runs. */
export function decode(value: unknown): CanonicalDocument {
  const doc = normalize(parse(value));
  validate(doc);
  return doc;
}

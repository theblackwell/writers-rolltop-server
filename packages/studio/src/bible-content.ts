// SPDX-License-Identifier: AGPL-3.0-only
import {
  inScope,
  orderedChanges,
  manuscriptPositions,
} from "./state-values.ts";
import { namesFrom } from "./names.ts";
import { wordCount } from "../../document-adapter/src/text.ts";
export type BibleBlock =
  | {
      kind:
        | "title"
        | "subtitle"
        | "heading"
        | "paragraph"
        | "note"
        | "bullet"
        | "break";
      text?: string;
      level?: number;
    }
  | { kind: "table"; header?: string[]; rows: string[][]; keyed?: boolean };
export type BibleSource = any;
const cmp = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a: any, b: any) =>
  cmp(a.orderKey, b.orderKey) || cmp(a.id, b.id);
export function nextBibleVersion(last?: string) {
  if (!last) return "1.0";
  const parts = last
      .trim()
      .replace(/^[vV]+/, "")
      .split("."),
    n = parts.at(-1);
  if (!n || !/^\d+$/.test(n)) return last + ".1";
  parts[parts.length - 1] = String(BigInt(n) + 1n);
  return parts.join(".");
}
export function buildBible(
  s: BibleSource,
  version: string,
  date: string,
): BibleBlock[] {
  const book = s.book,
    b: BibleBlock[] = [
      { kind: "title", text: book.title },
      { kind: "subtitle", text: "Book Bible and Story Reference" },
      { kind: "subtitle", text: `Version ${version} · ${date.slice(0, 10)}` },
    ];
  if (book.authorName) b.push({ kind: "subtitle", text: book.authorName });
  const entries = s.entries.filter(
      (e: any) => !e.deletedAt && inScope(e.scope, book),
    ),
    entryMap = new Map<string, any>(entries.map((e: any) => [e.id, e])),
    nodes = s.nodes.filter((n: any) => n.bookId === book.id);
  const children = (id?: string) =>
    nodes.filter((n: any) => n.parentId === id && !n.deletedAt).sort(order);
  const live: any[] = [];
  const visit = (id?: string) => {
    for (const n of children(id)) {
      live.push(n);
      visit(n.id);
    }
  };
  visit();
  const point = (id?: string): string => {
    if (!id) return "Not placed";
    const n = s.nodes.find((n: any) => n.id === id);
    if (!n) return "Unavailable place";
    const parent = s.nodes.find((p: any) => p.id === n.parentId);
    const title = (parent ? parent.title + " › " : "") + n.title;
    const other = s.books.find((b: any) => b.id === n.bookId);
    return (
      (n.bookId !== book.id
        ? (other?.title ?? "Unavailable book") + " › "
        : "") +
      title +
      (n.deletedAt || other?.deletedAt ? " (in Trash)" : "")
    );
  };
  const name = (id: string) => entryMap.get(id)?.name ?? "Unavailable entry";
  const words = (id: string): number => {
    const d = s.documents.find((d: any) => d.node_id === id);
    return d
      ? wordCount(d.document)
      : children(id).reduce((sum: number, n: any) => sum + words(n.id), 0);
  };
  const prose = (text?: string): BibleBlock[] =>
    text
      ?.split("\n")
      .filter((l) => l.trim())
      .map((l) => ({
        kind: /^\s*[-*•] /.test(l) ? "bullet" : "paragraph",
        text: l.replace(/^\s*[-*•] /, ""),
      })) ?? [];
  let section = 0;
  const add = (title: string, content: BibleBlock[]) => {
    if (content.length)
      b.push(
        { kind: "break" },
        { kind: "heading", level: 1, text: `${++section}. ${title}` },
        ...content,
      );
  };
  const heading = (text: string, level = 3): BibleBlock => ({
    kind: "heading",
    text,
    level,
  });
  const table = (
    rows: string[][],
    header?: string[],
    keyed = true,
  ): BibleBlock => ({ kind: "table", rows, header, keyed });
  const line = (text: string): BibleBlock => ({ kind: "paragraph", text });
  const bullet = (text: string): BibleBlock => ({ kind: "bullet", text });
  const display = (v: any, f: any): string => {
    if (v === undefined) return "";
    switch (f.fieldType) {
      case "boolean":
        return v ? "Yes" : "No";
      case "integer":
        return String(v);
      case "selection":
        return v
          .map(
            (id: string) =>
              f.options?.find((o: any) => o.id === id)?.label ??
              "Unavailable option",
          )
          .join(", ");
      case "fictionalDate":
        return [v.label, v.calendar]
          .filter((x) => x !== undefined && x !== "")
          .join(", ");
      case "entryReference":
        return name(v);
      case "entryReferences":
        return v.map(name).join(", ");
      case "attachment":
        return "Attachment reference: " + String(v);
      case "table":
        return JSON.stringify(v);
      default:
        return typeof v === "string" ? v : JSON.stringify(v);
    }
  };
  const premise: BibleBlock[] = [];
  for (const [key, label] of [
    ["logline", "Logline"],
    ["premise", "Premise"],
    ["themes", "Thematic Spine"],
    ["arcs", "Arcs"],
    ["principles", "Principles"],
  ])
    if (book[key] !== undefined)
      premise.push(heading(label), ...prose(book[key]));
  if (book.targetWordCount)
    premise.push(
      heading("Target Length"),
      line(
        `${book.targetWordCount} words${book.targetDate ? ", by " + book.targetDate : ""}.`,
      ),
    );
  add("Premise and Core Concept", premise);
  const top = children(),
    parts = top.filter((n: any) => n.kind === "part"),
    acts = parts.length ? parts : top.filter((n: any) => n.kind === "chapter");
  if (
    acts.some(
      (a: any) => a.plan !== undefined || a.targetWordCount !== undefined,
    )
  ) {
    const content: BibleBlock[] = [];
    for (const a of acts) content.push(heading(a.title), ...prose(a.plan));
    const sum = acts.reduce(
      (n: bigint, a: any) => n + BigInt(a.targetWordCount ?? 0),
      0n,
    );
    content.push(
      heading("Word Count Guide"),
      table(
        [
          ...acts.map((a: any) => [
            a.title,
            a.targetWordCount === undefined
              ? "Not set"
              : String(a.targetWordCount),
            String(words(a.id)),
          ]),
          [
            "Total",
            String(sum),
            String(acts.reduce((n: number, a: any) => n + words(a.id), 0)),
          ],
        ],
        ["Section", "Planned", "Written"],
      ),
    );
    add("Story Structure", content);
  }
  const entrySection = (kinds: string[]) => {
    const out: BibleBlock[] = [];
    for (const type of kinds) {
      const list = entries
        .filter((e: any) => e.entryType === type)
        .sort(
          (a: any, b: any) =>
            a.name.localeCompare(b.name, "en", { numeric: true }) ||
            cmp(a.id, b.id),
        );
      if (kinds.length > 1 && list.length)
        out.push(
          heading(
            type === "worldRule"
              ? "World Rules"
              : type[0].toUpperCase() + type.slice(1) + "s",
            2,
          ),
        );
      for (const e of list) {
        out.push(heading(e.name + (e.toBeNamed ? " (to be named)" : "")));
        if (e.summary !== undefined)
          out.push({ kind: "note", text: e.summary });
        const rows: string[][] = [];
        if (e.aliases.length)
          rows.push(["Also known as", e.aliases.join(", ")]);
        const override =
          e.overrides?.find((o: any) => o.bookId === book.id)?.values ?? {};
        const grids: any[] = [];
        for (const f of s.fields
          .filter((f: any) => f.templateId === e.templateId && !f.deletedAt)
          .sort(order)) {
          const v = Object.hasOwn(override, f.id)
            ? override[f.id]
            : e.values?.[f.id];
          if (v === undefined) continue;
          if (f.fieldType === "table") grids.push({ label: f.label, value: v });
          else rows.push([f.label, display(v, f)]);
        }
        if (rows.length) out.push(table(rows));
        for (const g of grids)
          out.push(line(g.label), table(g.value.rows, g.value.columns, false));
        const relations = s.relationships
          .filter(
            (r: any) =>
              !r.deletedAt && (r.fromEntryId === e.id || r.toEntryId === e.id),
          )
          .flatMap((r: any) => {
            const t = s.relationshipTypes.find(
                (t: any) => t.id === r.typeId && !t.deletedAt,
              ),
              outgoing = r.fromEntryId === e.id,
              other = entryMap.get(outgoing ? r.toEntryId : r.fromEntryId);
            return t && other
              ? [
                  `${outgoing ? t.label : t.inverseLabel} ${other.name}${r.bookId ? " (in " + (s.books.find((b: any) => b.id === r.bookId)?.title ?? "unavailable book") + " only)" : ""}${r.note !== undefined ? ". " + r.note : ""}`,
                ]
              : [];
          });
        if (relations.length)
          out.push(line("Relationships"), ...relations.sort().map(bullet));
        const changes = orderedChanges(e, s)
          .map((x: any) => {
            const c = x.change,
              f = s.fields.find((f: any) => f.id === c.fieldId);
            if (!f) return undefined;
            const place = c.nodeId
              ? point(c.nodeId)
              : "event: " +
                (s.events.find((ev: any) => ev.id === c.eventId)?.title ??
                  "Unavailable event");
            return bullet(
              `From ${place}: ${f.label} becomes ${display(c.value, f)}${c.note !== undefined ? ". " + c.note : ""}`,
            );
          })
          .filter(Boolean);
        if (changes.length)
          out.push(
            line("Changes over the story"),
            ...(changes as BibleBlock[]),
          );
      }
    }
    return out;
  };
  add("Characters", entrySection(["character"]));
  add(
    "The World",
    entrySection(["location", "organization", "object", "worldRule"]),
  );
  add("Glossary", entrySection(["term"]));
  add("Plotlines and Events", entrySection(["plotline", "event"]));
  const events = s.events
    .filter((e: any) => !e.deletedAt && inScope(e.scope, book))
    .sort((a: any, b: any) =>
      a.when?.ordinal === undefined
        ? b.when?.ordinal === undefined
          ? order(a, b)
          : 1
        : b.when?.ordinal === undefined
          ? -1
          : cmp(a.when.ordinal, b.when.ordinal) || order(a, b),
    );
  if (events.length)
    add("Timeline", [
      table(
        events.map((e: any) => [
          e.when?.label ?? "Undated",
          e.title + (e.summary !== undefined ? ": " + e.summary : ""),
          e.sceneIds.map(point).join("; "),
        ]),
        ["When", "Event", "Appears in"],
      ),
    ]);
  add("Research", entrySection(["research"]));
  const naming: BibleBlock[] = [];
  const established = entries.filter((e: any) => !e.toBeNamed);
  if (established.length)
    naming.push(
      heading("Established Names"),
      table(established.map((e: any) => [e.name, e.summary ?? e.entryType])),
    );
  const needed = namesFrom(s, s.documents);
  if (needed.length)
    naming.push(
      heading("Names Still Needed"),
      ...needed.map((n) => bullet(n.text + " · " + n.title)),
    );
  add("Naming Reference", naming);
  const questions = s.questions
      .filter((q: any) => !q.deletedAt && inScope(q.scope, book))
      .sort(order),
    qblocks: BibleBlock[] = [];
  for (const topic of [
    ...new Set<string>(
      questions
        .filter((q: any) => q.status === "open")
        .map((q: any) => q.topic ?? "General"),
    ),
  ].sort())
    qblocks.push(
      heading(topic),
      ...questions
        .filter(
          (q: any) => q.status === "open" && (q.topic ?? "General") === topic,
        )
        .map((q: any) =>
          bullet(
            q.text + (q.nodeId ? " Decide by " + point(q.nodeId) + "." : ""),
          ),
        ),
    );
  const decided = questions.filter((q: any) => q.status === "decided");
  if (decided.length)
    qblocks.push(
      heading("Decided"),
      ...decided.map((q: any) =>
        bullet(q.text + (q.decision !== undefined ? " → " + q.decision : "")),
      ),
    );
  add("Open Questions", qblocks);
  const positions = manuscriptPositions(s.nodes, book.id),
    facts = s.facts
      .filter((f: any) => !f.deletedAt && inScope(f.scope, book))
      .sort(
        (a: any, b: any) =>
          cmp(positions[a.nodeId] ?? -1, positions[b.nodeId] ?? -1) ||
          order(a, b),
      );
  if (facts.length)
    add("Continuity Notes", [
      heading("Established Facts"),
      ...facts.map((f: any) =>
        bullet(
          (f.truth === "false" ? "Not true (told or believed): " : "") +
            f.text +
            (f.truth === "undecided" ? " (Undecided.)" : "") +
            (f.nodeId ? " Established in " + point(f.nodeId) + "." : "") +
            (f.knowledge.length
              ? " Known by " +
                f.knowledge
                  .map(
                    (k: any) =>
                      (k.knower === "reader" ? "the reader" : name(k.knower)) +
                      (k.nodeId
                        ? " (from " + point(k.nodeId) + ")"
                        : " (from the start)"),
                  )
                  .join(", ") +
                "."
              : ""),
        ),
      ),
    ]);
  const chapters: BibleBlock[] = [];
  for (const n of live.filter(
    (n) => n.kind === "chapter" || n.kind === "scene",
  )) {
    chapters.push(heading(n.title, n.kind === "chapter" ? 2 : 3));
    const rows = [["Word count", String(words(n.id))]];
    if (n.povEntryId) rows.unshift(["POV", name(n.povEntryId)]);
    if (n.status !== undefined) rows.push(["Status", n.status]);
    if (n.settingEntryId) rows.push(["Setting", name(n.settingEntryId)]);
    chapters.push(table(rows), ...prose(n.synopsis));
    const established = facts.filter((f: any) => f.nodeId === n.id);
    if (established.length)
      chapters.push(
        line("Key details established"),
        ...established.map((f: any) => bullet(f.text)),
      );
    const notes = s.notes
      .filter((note: any) => !note.deletedAt && note.nodeId === n.id)
      .sort(order);
    if (notes.length)
      chapters.push(
        line("Continuity notes"),
        ...notes.map((n: any) => bullet(n.text)),
      );
  }
  add("Chapter Summaries", chapters);
  b.push({ kind: "note", text: `End of Bible v${version}` });
  return b;
}

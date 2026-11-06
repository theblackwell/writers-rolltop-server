// SPDX-License-Identifier: AGPL-3.0-only
import { inScope, manuscriptPositions } from "./state-values.ts";
export const warningKinds = [
  "learnedBeforeEstablished",
  "establishedInTrash",
  "learnedInTrash",
  "aboutMissingEntry",
  "knowerMissing",
  "undecidedButKnown",
  "questionOverdue",
  "stateConflict",
] as const;
export type ContinuityWarning = {
  id: string;
  kind: (typeof warningKinds)[number];
  key: string;
  subject: { kind: "fact" | "question" | "event"; id: string };
  message: string;
  entryId?: string;
  nodeIds: string[];
  dismissal?: { warning: string; note?: string; dismissedAt: string };
};
export type ContinuitySnapshot = {
  book: any;
  books: any[];
  nodes: any[];
  entries: any[];
  fields: any[];
  facts: any[];
  questions: any[];
  events: any[];
  stateChanges: any[];
  wordNodes: string[];
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
function quote(text: string) {
  const line = text.split(/[\r\n\u2028\u2029]+/).find((s) => s.length) ?? text;
  const chars = Array.from(graphemes.segment(line), (s) => s.segment);
  return (
    "“" + (chars.length > 60 ? chars.slice(0, 59).join("") + "…" : line) + "”"
  );
}
/** JSONValue equality: object key order is irrelevant; array order and exact strings matter. */
function valueKey(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(valueKey).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort(compare)
        .map((k) => JSON.stringify(k) + ":" + valueKey(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/** The eight canonical checks. No mutations, prose inference or dismissal writes. */
export function continuityWarnings(s: ContinuitySnapshot): ContinuityWarning[] {
  const nodes = new Map(s.nodes.map((n) => [n.id, n])),
    books = new Map(s.books.map((b) => [b.id, b])),
    entries = new Map(s.entries.map((e) => [e.id, e])),
    fields = new Map(s.fields.map((f) => [f.id, f])),
    positions = new Map<string, Record<string, number>>(),
    trashCache = new Map<string, boolean>();
  const order = (id: string) => {
    if (!positions.has(id)) positions.set(id, manuscriptPositions(s.nodes, id));
    return positions.get(id)!;
  };
  const inTrash = (id: string) => {
    if (trashCache.has(id)) return trashCache.get(id)!;
    let n = nodes.get(id);
    const seen = new Set<string>();
    let result = !n;
    while (n) {
      if (n.deletedAt || books.get(n.bookId)?.deletedAt || seen.has(n.id)) {
        result = true;
        break;
      }
      seen.add(n.id);
      n = nodes.get(n.parentId);
    }
    trashCache.set(id, result);
    return result;
  };
  const liveNode = (id?: string) =>
    id && nodes.has(id) && !inTrash(id) ? nodes.get(id) : undefined;
  const liveEntry = (id: string) => {
    const e = entries.get(id);
    return e && !e.deletedAt ? e : undefined;
  };
  const place = (id: string) => {
    const n = nodes.get(id);
    if (!n) return "a deleted chapter or scene";
    const parent = nodes.get(n.parentId);
    return (
      "“" +
      (n.kind === "scene" && parent?.kind === "chapter"
        ? parent.title + " › "
        : "") +
      n.title +
      "”"
    );
  };
  const who = (id: string) =>
    id === "reader"
      ? "The reader"
      : (entries.get(id)?.name ?? "A deleted character");
  const clocks = new Map<string, Map<string, number>>();
  const at = (id: string, scope: any): [number, number] | undefined => {
    const n = liveNode(id);
    if (!n) return;
    const key = scope.kind + "/" + scope.id;
    if (!clocks.has(key))
      clocks.set(
        key,
        new Map(
          s.books
            .filter((b) => !b.deletedAt && inScope(scope, b))
            .sort(
              (a, b) => compare(a.orderKey, b.orderKey) || compare(a.id, b.id),
            )
            .map((b, i) => [b.id, i]),
        ),
      );
    const rank = clocks.get(key)!.get(n.bookId),
      position = order(n.bookId)[id];
    return rank === undefined || position === undefined
      ? undefined
      : [rank, position];
  };
  const owners = new Map([
    ...s.facts.map((f) => ["fact/" + f.id, f] as const),
    ...s.questions.map((q) => ["question/" + q.id, q] as const),
    ...s.events.map((e) => ["event/" + e.id, e] as const),
  ]);
  const out: ContinuityWarning[] = [];
  const add = (
    kind: ContinuityWarning["kind"],
    subject: any,
    key: string,
    message: string,
    nodeIds: string[] = [],
    entryId?: string,
  ) => {
    const owner = owners.get(subject.kind + "/" + subject.id);
    const dismissal = owner?.dismissedWarnings?.find(
      (d: any) => d.warning === key,
    );
    out.push({
      id: subject.id + "/" + key,
      kind,
      key,
      subject,
      message,
      nodeIds: [...new Set(nodeIds.filter((id) => !!liveNode(id)))],
      ...(entryId ? { entryId } : {}),
      ...(dismissal ? { dismissal } : {}),
    });
  };
  for (const fact of s.facts.filter(
    (f) => !f.deletedAt && inScope(f.scope, s.book),
  )) {
    const quoted = quote(fact.text),
      subject = { kind: "fact", id: fact.id },
      established = fact.nodeId ? at(fact.nodeId, fact.scope) : undefined;
    if (fact.nodeId && inTrash(fact.nodeId))
      add(
        "establishedInTrash",
        subject,
        "establishedInTrash:" + fact.nodeId,
        quoted +
          " is established in " +
          place(fact.nodeId) +
          ", which is in the trash or no longer available.",
      );
    for (const id of fact.entryIds)
      if (!liveEntry(id))
        add(
          "aboutMissingEntry",
          subject,
          "aboutMissingEntry:" + id,
          quoted +
            " is about " +
            (entries.has(id)
              ? "“" + entries.get(id).name + "”, which is in the trash."
              : "an entry that no longer exists."),
          fact.nodeId ? [fact.nodeId] : [],
          id,
        );
    for (const k of fact.knowledge) {
      const knower = who(k.knower);
      if (k.knower !== "reader" && !liveEntry(k.knower))
        add(
          "knowerMissing",
          subject,
          "knowerMissing:" + k.knower,
          knower +
            " knows " +
            quoted +
            ", but " +
            (entries.has(k.knower) ? "is in the trash." : "no longer exists."),
          [],
          k.knower,
        );
      if (k.nodeId && inTrash(k.nodeId))
        add(
          "learnedInTrash",
          subject,
          "learnedInTrash:" + k.knower + ":" + k.nodeId,
          knower +
            " learns " +
            quoted +
            " in " +
            place(k.nodeId) +
            ", which is in the trash or no longer available.",
        );
      else if (k.nodeId && fact.nodeId && established) {
        const learned = at(k.nodeId, fact.scope);
        if (
          learned &&
          (learned[0] < established[0] ||
            (learned[0] === established[0] && learned[1] < established[1]))
        )
          add(
            "learnedBeforeEstablished",
            subject,
            "learnedBeforeEstablished:" +
              k.knower +
              ":" +
              k.nodeId +
              ":" +
              fact.nodeId,
            knower +
              " learns " +
              quoted +
              " in " +
              place(k.nodeId) +
              ", before it is established in " +
              place(fact.nodeId) +
              ".",
            [k.nodeId, fact.nodeId],
            k.knower === "reader" ? undefined : k.knower,
          );
      }
    }
    if (fact.truth === "undecided" && fact.knowledge.length) {
      const names = fact.knowledge.map((k: any) => who(k.knower)),
        list =
          names.length === 1
            ? names[0]
            : names.slice(0, -1).join(", ") + " and " + names.at(-1);
      add(
        "undecidedButKnown",
        subject,
        "undecidedButKnown",
        quoted +
          " is still undecided, but " +
          list +
          (names.length === 1 ? " knows" : " know") +
          " it.",
        fact.knowledge.map((k: any) => k.nodeId).filter(Boolean),
      );
    }
  }
  // Propagate word presence upward once; no semantic comparison with manuscript text.
  const hasWords = new Set<string>();
  for (const id of s.wordNodes) {
    let n = nodes.get(id);
    const seen = new Set<string>();
    while (n && !seen.has(n.id) && !n.deletedAt) {
      seen.add(n.id);
      hasWords.add(n.id);
      n = nodes.get(n.parentId);
    }
  }
  for (const q of s.questions.filter(
    (q) => !q.deletedAt && q.status === "open" && inScope(q.scope, s.book),
  )) {
    if (q.nodeId && liveNode(q.nodeId) && hasWords.has(q.nodeId))
      add(
        "questionOverdue",
        { kind: "question", id: q.id },
        "questionOverdue:" + q.nodeId,
        quote(q.text) +
          " is still open, but " +
          place(q.nodeId) +
          ", where it was to be decided, already has text.",
        [q.nodeId],
      );
  }
  const events = new Map(
    s.events
      .filter((e) => !e.deletedAt && inScope(e.scope, s.book))
      .map((e) => [e.id, e]),
  );
  const groups = new Map<string, any[]>();
  for (const c of s.stateChanges) {
    if (
      c.deletedAt ||
      !c.eventId ||
      !events.has(c.eventId) ||
      !liveEntry(c.entryId)
    )
      continue;
    const key = c.eventId + "/" + c.entryId + "/" + c.fieldId,
      group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((c) => valueKey(c.value))).size < 2) continue;
    const c = group[0],
      event = events.get(c.eventId)!;
    add(
      "stateConflict",
      { kind: "event", id: event.id },
      "stateConflict:" + c.entryId + ":" + c.fieldId,
      "“" +
        liveEntry(c.entryId)!.name +
        "” has " +
        group.length +
        " conflicting recorded changes for " +
        (fields.get(c.fieldId)?.label ?? "a field") +
        " at the event “" +
        event.title +
        "”.",
      event.sceneIds,
      c.entryId,
    );
  }
  const current = order(s.book.id),
    rank = (w: ContinuityWarning) =>
      Math.min(Infinity, ...w.nodeIds.map((id) => current[id] ?? Infinity));
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) || compare(a.message, b.message) || compare(a.id, b.id),
  );
}
export type KnowerFacts = {
  id: string;
  name: string;
  facts: {
    id: string;
    text: string;
    truth: "true" | "false" | "undecided";
    learnedIn?: { id: string; bookId: string; title: string };
  }[];
};
/** Native knowledge-as-of: facts in scope, learned by then or known from the start. */
export function knowledgeAt(
  s: ContinuitySnapshot,
  nodeId: string,
): KnowerFacts[] {
  const nodeMap = new Map(s.nodes.map((n) => [n.id, n])),
    entries = new Map(s.entries.map((e) => [e.id, e]));
  const orders = new Map<string, Record<string, number>>(),
    clocks = new Map<string, Map<string, number>>();
  const at = (id: string, scope: any): [number, number] | undefined => {
    const n = nodeMap.get(id);
    if (!n) return;
    const key = scope.kind + "/" + scope.id;
    if (!clocks.has(key))
      clocks.set(
        key,
        new Map(
          s.books
            .filter((b) => !b.deletedAt && inScope(scope, b))
            .sort(
              (a, b) => compare(a.orderKey, b.orderKey) || compare(a.id, b.id),
            )
            .map((b, i) => [b.id, i]),
        ),
      );
    if (!orders.has(n.bookId))
      orders.set(n.bookId, manuscriptPositions(s.nodes, n.bookId));
    const rank = clocks.get(key)!.get(n.bookId),
      position = orders.get(n.bookId)![id];
    return rank === undefined || position === undefined
      ? undefined
      : [rank, position];
  };
  const groups = new Map<string, KnowerFacts>();
  const facts = s.facts
    .filter((f) => !f.deletedAt && inScope(f.scope, s.book))
    .sort((a, b) => compare(a.orderKey, b.orderKey) || compare(a.id, b.id));
  for (const f of facts) {
    const limit = at(nodeId, f.scope);
    if (!limit) continue;
    for (const k of f.knowledge) {
      const e = entries.get(k.knower);
      if (k.knower !== "reader" && (!e || e.deletedAt)) continue;
      if (k.nodeId) {
        const p = at(k.nodeId, f.scope);
        if (!p || p[0] > limit[0] || (p[0] === limit[0] && p[1] > limit[1]))
          continue;
      }
      const g: KnowerFacts = groups.get(k.knower) ?? {
        id: k.knower,
        name: k.knower === "reader" ? "The reader" : e.name,
        facts: [],
      };
      const n = k.nodeId ? nodeMap.get(k.nodeId) : undefined;
      g.facts.push({
        id: f.id,
        text: f.text,
        truth: f.truth,
        ...(n
          ? {
              learnedIn: {
                id: n.id,
                bookId: n.bookId,
                title:
                  (s.books.find((b) => b.id === n.bookId)?.title ??
                    "Unavailable book") +
                  " › " +
                  n.title,
              },
            }
          : {}),
      });
      groups.set(k.knower, g);
    }
  }
  const collator = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
  });
  return [...groups.values()].sort(
    (a, b) =>
      (a.id === "reader"
        ? -1
        : b.id === "reader"
          ? 1
          : collator.compare(a.name, b.name)) || compare(a.id, b.id),
  );
}
export function warningCountsByNode(
  warnings: ContinuityWarning[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of warnings)
    if (!w.dismissal)
      for (const id of new Set(w.nodeIds)) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

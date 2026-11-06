// SPDX-License-Identifier: AGPL-3.0-only
export function bibleFixture() {
  const book = {
    id: "book",
    title: "The Orchard at Dusk",
    authorName: "A. Writer",
    orderKey: "a",
    logline: "A letter recalls a forgotten promise.",
    premise: "Elin returns to the orchard.",
    themes: "Memory and belonging",
    arcs: "From avoidance to responsibility",
    principles: "Every revelation has a cost.",
    targetWordCount: 60000,
  };
  const scope = { kind: "book", id: "book" },
    shared = { kind: "universe", id: "world" };
  Object.assign(book, { universeId: "world" });
  const nodes = [
    {
      id: "part",
      bookId: "book",
      kind: "part",
      title: "Act I",
      orderKey: "a",
      targetWordCount: 20000,
      plan: "- The letter arrives\n- The keeper returns",
    },
    {
      id: "chapter",
      parentId: "part",
      bookId: "book",
      kind: "chapter",
      title: "The Last Light",
      orderKey: "a",
      povEntryId: "character",
      settingEntryId: "location",
      status: "Revision",
      synopsis: "Elin receives the letter.",
    },
    {
      id: "scene",
      parentId: "chapter",
      bookId: "book",
      kind: "scene",
      title: "The Letter",
      orderKey: "a",
      synopsis: "An unexpected promise.",
    },
  ];
  const fields = [
    {
      id: "age",
      templateId: "template",
      fieldType: "integer",
      label: "Age",
      orderKey: "a",
    },
    {
      id: "pledge",
      templateId: "template",
      fieldType: "boolean",
      label: "Has sworn the oath",
      orderKey: "b",
    },
    {
      id: "weight",
      templateId: "template",
      fieldType: "decimal",
      label: "Exact weight",
      orderKey: "c",
    },
    {
      id: "selection",
      templateId: "template",
      fieldType: "selection",
      label: "Role",
      orderKey: "d",
      options: [{ id: "keeper", label: "Keeper" }],
    },
    {
      id: "date",
      templateId: "template",
      fieldType: "fictionalDate",
      label: "Birth",
      orderKey: "e",
    },
    {
      id: "place",
      templateId: "template",
      fieldType: "entryReference",
      label: "Home",
      orderKey: "f",
    },
    {
      id: "grid",
      templateId: "template",
      fieldType: "table",
      label: "Milestones",
      orderKey: "g",
    },
  ];
  const entries = [
    "character",
    "location",
    "organization",
    "object",
    "worldRule",
    "term",
    "plotline",
    "event",
    "research",
  ].map((entryType, i) => ({
    id: entryType,
    entryType,
    name: [
      "Elin Marín",
      "The Orchard",
      "The Keepers",
      "The Letter",
      "The Oath",
      "[harvest name]",
      "The Promise",
      "The Return",
      "Harvest research",
    ][i],
    summary: "A working reference for the story.",
    aliases: entryType === "character" ? ["The keeper"] : [],
    scope: shared,
    orderKey: String(i),
    ...(entryType === "term" ? { toBeNamed: true } : {}),
    ...(entryType === "character"
      ? {
          templateId: "template",
          values: {
            age: 40,
            pledge: false,
            weight: "1.230000000000000001",
            selection: ["keeper"],
            date: { label: "First thaw", calendar: "Orchard calendar" },
            place: "location",
            grid: {
              columns: ["Year", "Change"],
              rows: [
                ["Before", "Leaves home"],
                ["Now", "Returns to the orchard"],
              ],
            },
          },
          overrides: [{ bookId: "book", values: { age: 41 } }],
        }
      : {}),
  }));
  return {
    book,
    books: [book],
    nodes,
    entries,
    fields,
    documents: [
      {
        node_id: "scene",
        document: {
          blocks: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "A [visitor name] brings the letter." },
              ],
            },
          ],
        },
      },
    ],
    relationshipTypes: [
      { id: "kin", label: "Guardian of", inverseLabel: "Ward of" },
    ],
    relationships: [
      {
        id: "rel",
        typeId: "kin",
        fromEntryId: "character",
        toEntryId: "organization",
        note: "An old obligation.",
      },
    ],
    events: [
      {
        id: "return",
        scope,
        title: "The Return",
        summary: "Elin reaches the orchard.",
        when: { label: "First harvest", ordinal: 1 },
        sceneIds: ["scene"],
      },
    ],
    stateChanges: [
      {
        id: "change",
        entryId: "character",
        fieldId: "age",
        value: 42,
        nodeId: "scene",
        createdAt: "2026-11-06T00:00:00Z",
        note: "A birthday",
      },
    ],
    facts: [
      {
        id: "fact",
        scope,
        text: "The [harvest name] oath is remembered.",
        truth: "false",
        orderKey: "a",
        nodeId: "scene",
        knowledge: [
          { knower: "reader" },
          { knower: "character", nodeId: "scene" },
        ],
      },
    ],
    questions: [
      {
        id: "q",
        scope,
        text: "Who sent the letter?",
        topic: "The Promise",
        status: "open",
        nodeId: "chapter",
        orderKey: "a",
      },
      {
        id: "q2",
        scope,
        text: "Will Elin return?",
        status: "decided",
        decision: "Yes, before the harvest.",
        orderKey: "b",
      },
    ],
    notes: [
      {
        id: "n",
        nodeId: "scene",
        text: "The wax seal is blue.",
        orderKey: "a",
      },
    ],
  };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Development-only, volatile preview. Never imported by the production entry point.
import { PGlite } from "@electric-sql/pglite";
import { between } from "../packages/studio/src/order.ts";
import { StudioStore } from "../packages/studio/src/store.ts";
import type { Query } from "../packages/studio/src/store.ts";
import { studioServer } from "../packages/studio/src/http.ts";
import { passwordHash } from "../packages/studio/src/auth.ts";
const pg = new PGlite();
const query =
  (db: any): Query =>
  async (sql, params) =>
    !params && sql.includes(";")
      ? (await db.exec(sql)).at(-1)
      : db.query(sql, params);
const store = new StudioStore(
  {
    query: query(pg),
    transaction: (fn) => pg.transaction((tx) => fn(query(tx))),
  },
  process.env.STUDIO_BACKUP_DIRECTORY,
);
await store.migrate();
const library = await store.createLibrary("The writing room");
const book = await store.createBook(library.id, "The Orchard at Dusk");
// Optional B2c demo definitions, confined to this volatile scratch preview.
if (process.env.STUDIO_STRUCTURED_PREVIEW === "1") {
  const catalog = await store.templates(library.id);
  const template = catalog.templates.find((t) => t.entryType === "event")!;
  let order = catalog.fields
    .filter((f) => f.templateId === template.id)
    .at(-1)?.orderKey;
  for (const [key, label, fieldType] of [
    ["weather", "Weather", "selection"],
    ["recorded", "Recorded date", "realDate"],
    ["measurements", "Measurements", "table"],
  ]) {
    order = between(order);
    const now = new Date().toISOString(),
      id = crypto.randomUUID();
    const field = {
      id,
      templateId: template.id,
      key,
      label,
      fieldType,
      required: false,
      orderKey: order,
      createdAt: now,
      updatedAt: now,
      ...(fieldType === "selection"
        ? {
            multiple: true,
            options: [
              { id: crypto.randomUUID(), label: "Rain" },
              { id: crypto.randomUUID(), label: "Wind" },
            ],
          }
        : {}),
    };
    await store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
      id,
      library.id,
      template.id,
      field,
    ]);
  }
  const entry = await store.createEntry(book.id, {
    name: "Spring storm",
    entryType: "event",
  });
  await store.editEntryField(book.id, entry.id, {
    templateId: template.id,
    expectedUpdatedAt: entry.updatedAt,
    expectedTemplateUpdatedAt: template.updatedAt,
  });
}
const chapter = await store.createNode(book.id, "The last light", "chapter");
const scene = await store.createNode(
  book.id,
  "A letter in the kitchen",
  "scene",
  chapter.id,
);
await store.createNode(book.id, "The old orchard", "scene", chapter.id);
const next = await store.createNode(book.id, "Before the rain", "chapter");
await store.createNode(book.id, "The road home", "scene", next.id);
const companion = await store.createBook(library.id, "Notes from a Quiet Town");
// Optional shared-scope storage fixtures, only in this volatile development preview.
if (process.env.STUDIO_SHARED_PREVIEW === "1") {
  const { editWorld, bookMembership } =
    await import("../packages/studio/src/worlds.ts");
  const world = await editWorld(store.db, library.id, "universes", {
    title: "Orchard world",
  });
  const series = await editWorld(store.db, library.id, "series", {
    title: "Orchard stories",
    universeId: world.id,
  });
  await bookMembership(store.db, book.id, {
    universeId: world.id,
    seriesId: series.id,
    expectedUpdatedAt: book.updatedAt,
  });
  await bookMembership(store.db, companion.id, {
    universeId: world.id,
    seriesId: series.id,
    expectedUpdatedAt: companion.updatedAt,
  });
  let entry = await store.createEntry(book.id, {
    scopeKind: "universe",
    entryType: "character",
    name: "Orchard keeper",
    summary: "Shared reference record",
  });
  const catalog = await store.templates(library.id);
  const template = catalog.templates.find((t) => t.entryType === "character")!;
  entry = await store.editEntryField(book.id, entry.id, {
    templateId: template.id,
    expectedUpdatedAt: entry.updatedAt,
    expectedTemplateUpdatedAt: template.updatedAt,
    editSharedCanon: true,
  });
  for (const [key, value] of [
    ["role", "Keeper"],
    ["age", 40],
  ] as const) {
    const field = catalog.fields.find(
      (f) => f.templateId === template.id && f.key === key,
    )!;
    entry = await store.editEntryField(
      book.id,
      entry.id,
      {
        value,
        expectedUpdatedAt: entry.updatedAt,
        expectedFieldUpdatedAt: field.updatedAt,
        editSharedCanon: true,
      },
      field.id,
    );
  }
  await store.createEntry(book.id, {
    scopeKind: "series",
    entryType: "term",
    name: "The orchard secret",
  });
}
const saved = await store.document(scene.id);
const paragraph = (text: string) => ({
  id: crypto.randomUUID(),
  type: "paragraph",
  content: [{ type: "text", text }],
});
await store.save(
  scene.id,
  {
    ...saved.document,
    blocks: [
      paragraph(
        "The letter arrived on a Tuesday, folded into thirds and smelling faintly of rain. Elin left it beside the kettle while the water came to a boil.",
      ),
      paragraph(
        "Outside, the orchard had begun its slow turn toward autumn. The apples hung low over the path, their green skins catching the last of the afternoon light.",
      ),
      paragraph("She knew the handwriting before she read the name."),
      paragraph(
        "For a long time she stood at the window, listening to the house settle around her. Then she opened the envelope.",
      ),
    ],
  },
  saved.revision,
);
// Optional B4b demo stays entirely in volatile scratch storage.
if (process.env.STUDIO_FAMILY_PREVIEW === "1") {
  let character = (await store.entries(book.id)).find(
    (e) => e.entryType === "character",
  );
  character = character
    ? await store.updateEntry(book.id, character.id, {
        givenName: "Ada",
        familyName: "Vale",
        expectedUpdatedAt: character.updatedAt,
        editSharedCanon: true,
      })
    : await store.createEntry(book.id, {
        name: "Ada Vale",
        entryType: "character",
      });
  await store.createEntry(book.id, {
    name: "Ben Vále",
    entryType: "character",
    scopeKind: character.scope.kind,
  });
  const original = await store.document(scene.id),
    anchorId = crypto.randomUUID();
  if (original.document.blocks[0].type !== "sceneBreak")
    original.document.blocks[0].content[0] = {
      type: "text",
      text: "Ada Vale opened the letter.",
      marks: [{ type: "anchor", id: anchorId }],
    };
  const updated = await store.save(
    scene.id,
    original.document,
    original.revision,
  );
  await store.saveReference(scene.id, {
    entryId: character.id,
    anchorId,
    expectedRevision: updated.revision,
  });
  const missing = await store.createNode(
      book.id,
      "An erased mention",
      "scene",
      chapter.id,
    ),
    content = await store.document(missing.id),
    id = crypto.randomUUID();
  if (content.document.blocks[0].type !== "sceneBreak")
    content.document.blocks[0].content = [
      { type: "text", text: "A lost mention", marks: [{ type: "anchor", id }] },
    ];
  const revision = await store.save(
    missing.id,
    content.document,
    content.revision,
  );
  await store.saveReference(missing.id, {
    entryId: character.id,
    anchorId: id,
    expectedRevision: revision.revision,
  });
  if (content.document.blocks[0].type !== "sceneBreak")
    content.document.blocks[0].content = [
      { type: "text", text: "The mention was removed." },
    ];
  await store.save(missing.id, content.document, revision.revision);
}
// Optional B7a checker fixtures; confined to this volatile preview, never production.
if (process.env.STUDIO_CONTINUITY_PREVIEW === "1") {
  const { saveFact } = await import("../packages/studio/src/facts.ts");
  const { saveQuestion } = await import("../packages/studio/src/questions.ts");
  const { saveEvent } = await import("../packages/studio/src/events.ts");
  const { saveStateChange } =
    await import("../packages/studio/src/state-changes.ts");
  const nodes = (
    await store.db.query("SELECT data FROM manuscript_nodes WHERE book_id=$1", [
      book.id,
    ])
  ).rows.map((r) => r.data);
  const later = nodes.find((n) => n.title === "The road home");
  await saveFact(store.db, book.id, {
    text: "The letter names the keeper.",
    nodeId: later.id,
    knowledge: [{ knower: "reader", nodeId: scene.id }],
  });
  const lost = await store.createEntry(book.id, {
    name: "The missing witness",
    entryType: "character",
  });
  const trashed = await store.createNode(
    book.id,
    "An abandoned scene",
    "scene",
    chapter.id,
  );
  await saveFact(store.db, book.id, {
    text: "The orchard key is hidden.",
    truth: "undecided",
    nodeId: trashed.id,
    entryIds: [lost.id],
    knowledge: [{ knower: lost.id, nodeId: trashed.id }],
  });
  await store.updateEntry(book.id, lost.id, {
    deleted: true,
    expectedUpdatedAt: lost.updatedAt,
  });
  await store.trashNode(trashed.id);
  await saveQuestion(store.db, book.id, {
    text: "Who sent the letter?",
    nodeId: chapter.id,
  });
  const intentional = await saveFact(store.db, book.id, {
    text: "The reader's deliberate uncertainty.",
    truth: "undecided",
    knowledge: [{ knower: "reader" }],
  });
  await store.db.query("UPDATE facts SET data=data || $2::jsonb WHERE id=$1", [
    intentional.id,
    {
      dismissedWarnings: [
        {
          warning: "undecidedButKnown",
          note: "Existing intentional fixture",
          dismissedAt: intentional.updatedAt,
        },
      ],
    },
  ]);
  let person = (await store.entries(book.id)).find(
    (e) => e.name === "Orchard keeper",
  );
  if (!person) {
    person = await store.createEntry(book.id, {
      name: "Orchard keeper",
      entryType: "character",
    });
    const t = (await store.templates(library.id)).templates.find(
      (t) => t.entryType === "character",
    )!;
    person = await store.editEntryField(book.id, person.id, {
      templateId: t.id,
      expectedUpdatedAt: person.updatedAt,
      expectedTemplateUpdatedAt: t.updatedAt,
    });
  }
  const field = (await store.templates(library.id)).fields.find(
    (f) => f.templateId === person.templateId && f.fieldType === "integer",
  )!;
  const event = await saveEvent(store.db, book.id, {
    title: "The keeper's discovery",
    sceneIds: [scene.id],
  });
  for (const value of [41, 42])
    await saveStateChange(store.db, book.id, {
      entryId: person.id,
      fieldId: field.id,
      eventId: event.id,
      value,
      expectedEntryUpdatedAt: person.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
      editSharedCanon: true,
    });
}
const server = studioServer(store, {
  origin: "http://localhost:4318",
  passwordHash: await passwordHash("scratch-preview-password"),
});
server.listen(4318, "127.0.0.1", () =>
  console.log(
    "Scratch preview: http://localhost:4318 (volatile test data only)",
  ),
);
process.on("SIGTERM", () =>
  server.close(async () => {
    await pg.close();
    process.exit(0);
  }),
);

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
await store.createBook(library.id, "Notes from a Quiet Town");
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

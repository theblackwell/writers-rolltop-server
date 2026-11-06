// SPDX-License-Identifier: AGPL-3.0-only
import { PGlite } from "@electric-sql/pglite";
import { StudioStore } from "../src/store.ts";
import type { Database, Query } from "../src/store.ts";
export async function fixture() {
  const pg = new PGlite();
  const q =
    (conn: any): Query =>
    async (sql, params) => {
      if (!params && sql.includes(";")) {
        const result = await conn.exec(sql);
        return result.at(-1) ?? { rows: [] };
      }
      return conn.query(sql, params);
    };
  const db: Database = {
    query: q(pg),
    transaction: (fn) => pg.transaction((tx) => fn(q(tx))),
  };
  const store = new StudioStore(db);
  await store.migrate();
  const library = await store.createLibrary("Scratch library");
  const book = await store.createBook(library.id, "A book");
  const chapter = await store.createNode(book.id, "Chapter 1", "chapter");
  const scene = await store.createNode(book.id, "Scene 1", "scene", chapter.id);
  return { pg, store, library, book, chapter, scene };
}

export async function removeRelationshipSchema(store: StudioStore) {
  await store.db.query("DROP TABLE bible_exports; DROP TABLE state_changes");
  await store.db.query(
    "ALTER TABLE bible_fields DROP CONSTRAINT state_fields_library_identity; ALTER TABLE continuity_events DROP CONSTRAINT state_events_library_identity",
  );
  await store.db.query("DROP TABLE continuity_events");
  await store.db.query("DROP TABLE questions");
  await store.db.query("DROP TABLE facts");
  await store.db.query(
    `DROP TABLE relationships; DROP TABLE relationship_types; ALTER TABLE bible_entries DROP CONSTRAINT entries_library_identity`,
  );
}
export async function removeScopeSchema(store: StudioStore) {
  await removeRelationshipSchema(store);
  await store.db.query(`DROP TRIGGER entry_library ON bible_entries;
    DROP FUNCTION entry_library_default();
    ALTER TABLE bible_entries DROP CONSTRAINT entries_scope;
    ALTER TABLE bible_entries DROP COLUMN universe_id;
    ALTER TABLE bible_entries DROP COLUMN series_id;
    ALTER TABLE bible_entries DROP COLUMN library_id;
    ALTER TABLE bible_entries ALTER COLUMN book_id SET NOT NULL;
    ALTER TABLE books DROP CONSTRAINT books_library_identity`);
}
export async function removeWorldSchema(store: StudioStore) {
  await removeScopeSchema(store);
  await store.db.query(`DROP TRIGGER book_series_world ON books;
    DROP FUNCTION check_book_series_world();
    ALTER TABLE books DROP COLUMN universe_id;
    ALTER TABLE books DROP COLUMN series_id;
    DROP TABLE series;
    DROP TABLE universes;
    DROP FUNCTION keep_series_world()`);
}

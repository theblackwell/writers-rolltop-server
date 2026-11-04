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

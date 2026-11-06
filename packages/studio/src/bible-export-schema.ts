// SPDX-License-Identifier: AGPL-3.0-only
import type { Query } from "./store.ts";
export async function migrateBibleExports(q: Query) {
  await q(`CREATE TABLE bible_exports (
 id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES libraries(id), book_id uuid NOT NULL,
 data jsonb NOT NULL,
 FOREIGN KEY(book_id,library_id) REFERENCES books(id,library_id),
 CHECK ((data ?& ARRAY['id','bookId','version','format','createdAt','sha256','contentBase64'] AND (data->>'id')::uuid=id AND (data->>'bookId')::uuid=book_id AND data->>'format' IN ('docx','pdf')) IS TRUE));
 CREATE INDEX bible_exports_by_book ON bible_exports(book_id);
 UPDATE studio_schema SET version=12`);
}

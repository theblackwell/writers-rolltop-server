// SPDX-License-Identifier: AGPL-3.0-only
import type { Query } from "./store.ts";

/** Append-only v6: retain canonical JSON; replace accidental creator-book ownership. */
export async function migrateScopes(q: Query) {
  await q(`ALTER TABLE books ADD CONSTRAINT books_library_identity UNIQUE(id,library_id);
    ALTER TABLE bible_entries ADD COLUMN library_id uuid;
    UPDATE bible_entries e SET library_id=b.library_id FROM books b WHERE b.id=e.book_id;
    ALTER TABLE bible_entries ALTER COLUMN book_id DROP NOT NULL;
    UPDATE bible_entries SET book_id=NULL WHERE data->'scope'->>'kind' IN ('universe','series');
    ALTER TABLE bible_entries ALTER COLUMN library_id SET NOT NULL;
    ALTER TABLE bible_entries ADD COLUMN universe_id uuid GENERATED ALWAYS AS
      (CASE WHEN data->'scope'->>'kind'='universe' THEN (data->'scope'->>'id')::uuid END) STORED;
    ALTER TABLE bible_entries ADD COLUMN series_id uuid GENERATED ALWAYS AS
      (CASE WHEN data->'scope'->>'kind'='series' THEN (data->'scope'->>'id')::uuid END) STORED;
    ALTER TABLE bible_entries ADD CONSTRAINT entries_scope CHECK ((
      data ? 'scope' AND data->'scope' ?& ARRAY['kind','id'] AND
      (data->>'id')::uuid=id AND
      ((data->'scope'->>'kind'='book' AND book_id IS NOT NULL AND (data->'scope'->>'id')::uuid=book_id) OR
       (data->'scope'->>'kind' IN ('universe','series') AND book_id IS NULL AND
        (universe_id IS NOT NULL OR series_id IS NOT NULL)))) IS TRUE);
    ALTER TABLE bible_entries ADD CONSTRAINT entries_library FOREIGN KEY(library_id) REFERENCES libraries(id);
    ALTER TABLE bible_entries ADD CONSTRAINT entries_book_library FOREIGN KEY(book_id,library_id) REFERENCES books(id,library_id);
    ALTER TABLE bible_entries ADD CONSTRAINT entries_universe_library FOREIGN KEY(universe_id,library_id) REFERENCES universes(id,library_id);
    ALTER TABLE bible_entries ADD CONSTRAINT entries_series_library FOREIGN KEY(series_id,library_id) REFERENCES series(id,library_id);
    CREATE INDEX entries_by_library ON bible_entries(library_id);
    CREATE INDEX entries_by_universe ON bible_entries(universe_id);
    CREATE INDEX entries_by_series ON bible_entries(series_id);
    CREATE FUNCTION entry_library_default() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.library_id IS NULL AND NEW.book_id IS NOT NULL THEN
        SELECT library_id INTO NEW.library_id FROM books WHERE id=NEW.book_id;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER entry_library BEFORE INSERT ON bible_entries
      FOR EACH ROW EXECUTE FUNCTION entry_library_default();
    UPDATE studio_schema SET version=6`);
}

/** Native visibility is exactly the book, its series and its world. Includes Trash for review. */
export async function visibleEntries(q: Query, bookId: string) {
  return (
    await q(
      `SELECT e.data FROM bible_entries e JOIN books b ON b.id=$1
    WHERE e.library_id=b.library_id AND
      (e.book_id=b.id OR e.universe_id=b.universe_id OR e.series_id=b.series_id)
    ORDER BY e.data->>'name',e.id`,
      [bookId],
    )
  ).rows.map((r) => r.data);
}

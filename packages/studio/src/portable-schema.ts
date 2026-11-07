// SPDX-License-Identifier: AGPL-3.0-only
import type { Query } from "./store.ts";
export async function migratePortable(q: Query) {
  await q(`CREATE TABLE library_attachments(library_id uuid NOT NULL REFERENCES libraries(id),sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),data jsonb NOT NULL,content_base64 text NOT NULL,PRIMARY KEY(library_id,sha256),CHECK(data->>'sha256'=sha256));
CREATE TABLE library_portable(library_id uuid PRIMARY KEY REFERENCES libraries(id),data jsonb NOT NULL);
DROP INDEX IF EXISTS live_builtin_template;
UPDATE studio_schema SET version=13`);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readArchive } from "@writers-rolltop/archive";
import { scratch, uuid, T0 } from "./helpers.ts";

const sample = fileURLToPath(new URL("../../document-adapter/test/spec/fixtures/archives/valid/sample-library.rolltop", import.meta.url));

async function loaded() {
  const s = await scratch({ migrated: true });
  const c = await readArchive(sample);
  await s.store.importArchive(c);
  await c.close();
  return s;
}
const one = async (s: Awaited<ReturnType<typeof scratch>>, sql: string, params: unknown[] = []) => (await s.pool.query(sql, params)).rows[0];

test("the ported bible triggers refuse what the archive validator refuses", async () => {
  const s = await loaded();
  try {
    // A character entry with a template and values; a field of another template; a book outside its universe.
    const entry = await one(s, `SELECT e.id, e.template_id FROM bible_entry e JOIN entry_value v ON v.entry_id = e.id WHERE e.entry_type='character' LIMIT 1`);
    const foreignField = (await one(s, "SELECT id FROM entry_field WHERE template_id <> $1 LIMIT 1", [entry.template_id])).id;
    const ownField = (await one(s, "SELECT id FROM entry_field WHERE template_id = $1 LIMIT 1", [entry.template_id])).id;

    await assert.rejects(s.pool.query("UPDATE bible_entry SET entry_type='location' WHERE id=$1", [entry.id]), /entry type must equal its template/);
    await assert.rejects(s.pool.query("INSERT INTO entry_value (entry_id, field_id, value_json) VALUES ($1,$2,'1'::jsonb)", [entry.id, foreignField]), /value's field must belong/);
    const ov = await one(s, "SELECT entry_id, book_id FROM entry_override LIMIT 1");
    await assert.rejects(s.pool.query("INSERT INTO entry_override_value (entry_id, book_id, field_id, value_json) VALUES ($1,$2,$3,'1'::jsonb)", [ov.entry_id, ov.book_id, foreignField]), /field must belong to the entry's template/);
    const ev = await one(s, "SELECT id FROM continuity_event LIMIT 1");
    await assert.rejects(s.pool.query(
      "INSERT INTO state_change (id, event_id, entry_id, field_id, value_json, created_at, updated_at) VALUES ($1,$2,$3,$4,'1'::jsonb,now(),now())", [uuid(), ev.id, entry.id, foreignField]),
      /state change's field must belong/);
    await s.pool.query("INSERT INTO state_change (id, event_id, entry_id, field_id, value_json, created_at, updated_at) VALUES ($1,$2,$3,$4,'1'::jsonb,now(),now())", [uuid(), ev.id, entry.id, ownField]);

    // Override book outside the entry's scope (a book in no universe).
    const outside = uuid();
    await s.store.insertBook({ id: outside, title: "Outside", orderKey: "z", createdAt: T0 });
    const universeEntry = (await one(s, "SELECT id FROM bible_entry WHERE universe_id IS NOT NULL LIMIT 1")).id;
    await assert.rejects(s.pool.query("INSERT INTO entry_override (entry_id, book_id, position) VALUES ($1,$2,99)", [universeEntry, outside]), /book must be inside the entry's scope/);
    const bookScoped = await one(s, "SELECT id, book_id FROM bible_entry WHERE book_id IS NOT NULL LIMIT 1");
    if (bookScoped) await assert.rejects(s.pool.query("INSERT INTO entry_override (entry_id, book_id, position) VALUES ($1,$2,99)", [bookScoped.id, bookScoped.book_id]), /inside the entry's scope/);

    // Notes: same book; a node that notes point at cannot move; a book that overrides need cannot leave its scope.
    const note = await one(s, "SELECT n.node_id, n.book_id FROM note n WHERE n.node_id IS NOT NULL LIMIT 1");
    await assert.rejects(s.pool.query("INSERT INTO note (id, book_id, node_id, text, order_key, created_at, updated_at) VALUES ($1,$2,$3,'x','h',now(),now())", [uuid(), outside, note.node_id]), /note's node must be in the note's book/);
    await assert.rejects(s.pool.query("UPDATE manuscript_node SET book_id=$1 WHERE id=$2", [outside, note.node_id]), /notes point at cannot move/);
    await assert.rejects(s.pool.query("UPDATE book SET universe_id=NULL, series_id=NULL WHERE id=$1", [ov.book_id]), /still the target of entry overrides/);

    // An entry or field in use cannot move to another template.
    await assert.rejects(s.pool.query("UPDATE bible_entry SET template_id=NULL WHERE id=$1", [entry.id]), /still has values or state changes/);
    const usedField = (await one(s, "SELECT field_id FROM entry_value LIMIT 1")).field_id;
    const otherTemplate = (await one(s, "SELECT id FROM entry_template WHERE id <> (SELECT template_id FROM entry_field WHERE id=$1) LIMIT 1", [usedField])).id;
    await assert.rejects(s.pool.query("UPDATE entry_field SET template_id=$1 WHERE id=$2", [otherTemplate, usedField]), /field that is in use cannot move/);

    // Constraints: scope is exactly one; relationship ends differ; pov must be a real entry.
    await assert.rejects(s.pool.query("INSERT INTO fact (id, text, truth, knowledge_json, order_key, created_at, updated_at) VALUES ($1,'t','true','[]'::jsonb,'h',now(),now())", [uuid()]), /scope_exactly_one/);
    const rel = await one(s, "SELECT type_id, from_entry_id FROM relationship LIMIT 1");
    await assert.rejects(s.pool.query("INSERT INTO relationship (id, type_id, from_entry_id, to_entry_id, created_at, updated_at) VALUES ($1,$2,$3,$3,now(),now())", [uuid(), rel.type_id, rel.from_entry_id]), /relationship_distinct_ends/);
    const node = (await one(s, "SELECT id FROM manuscript_node WHERE kind='scene' LIMIT 1")).id;
    await assert.rejects(s.pool.query("UPDATE manuscript_node SET pov_entry_id=$1 WHERE id=$2", [uuid(), node]), /node_pov_entry_fk/);
    assert.deepEqual(await s.store.checkIntegrity(), { ok: true, problems: [] });
  } finally { await s.drop(); }
});

test("migration 0002 is additive: the library written by 0001 alone still migrates and keeps its data", async () => {
  const { migrate, loadMigrations } = await import("../src/index.ts");
  const { scratch: mk, pgDumpPath } = await import("./helpers.ts");
  const s = await mk();
  try {
    const all = await loadMigrations();
    assert.deepEqual(all.map((m) => m.id), ["0001-initial", "0002-archive-tables", "0003-sync", "0004-auth"]);
    await migrate({ url: s.url, backupDir: path.join(s.dir, "b"), pgDump: pgDumpPath(), migrations: [all[0]!] });
    const id = uuid();
    await s.pool.query("INSERT INTO library (id, title, created_at, updated_at) VALUES ($1,'Kept',now(),now())", [id]);
    const r = await migrate({ url: s.url, backupDir: path.join(s.dir, "b"), pgDump: pgDumpPath() });
    assert.deepEqual(r.applied, ["0002-archive-tables", "0003-sync", "0004-auth"]);
    assert.ok(r.backupFile, "a backup was taken before the pending migration");
    assert.equal((await s.pool.query("SELECT title FROM library WHERE id=$1", [id])).rows[0].title, "Kept");
  } finally { await s.drop(); }
});

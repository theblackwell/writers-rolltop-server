-- Sync protocol v1 (Spec/docs/sync-protocol-v1.md): the change log, the stored per-opId results and the open
-- conflicts. Additive only: no table of 0001 or 0002 is changed.
-- Design (M1-6, reworked): sync keeps NO copy of any record. A sync op reads and writes the library tables of 0001 and
-- 0002 (library, universe, series, book, manuscript_node, scene_document, the bible, ...), the same tables archive
-- import and export use, so every record has exactly one current state. What sync adds is only what those tables
-- cannot say: the order of changes (sync_change), the first answer to each op (sync_result), the open conflicts
-- (sync_conflict) and the epoch and head (sync_state). A tombstone is deleted_at on the record's own row; the seq and
-- device of the tombstone are read from sync_change. A scene document's text is not copied either: a `document`
-- change row carries only its revision, and the text is read from document_revision.
-- The runner wraps this file in one transaction: do not add BEGIN or COMMIT.

-- One row: the library's epoch (a uuid naming one lineage) and the last assigned seq. A new database gets
-- a new epoch here; every archive import rotates it (importContents) and writes its records as the new epoch's first
-- changes (the import baseline, sync.ts writeImportBaseline), under one import device id.
CREATE TABLE sync_state (
  singleton boolean PRIMARY KEY DEFAULT true CONSTRAINT sync_state_single CHECK (singleton),
  epoch uuid NOT NULL,
  head bigint NOT NULL DEFAULT 0 CONSTRAINT sync_head_nonnegative CHECK (head >= 0)
);
INSERT INTO sync_state (epoch) VALUES (gen_random_uuid());

-- The change log. Append-only; seq is assigned under the sync_state row lock, so it is gapless and ordered.
CREATE TABLE sync_change (
  seq bigint PRIMARY KEY CONSTRAINT sync_change_seq_positive CHECK (seq >= 1),
  at timestamptz NOT NULL,
  op_id uuid NOT NULL,
  device_id uuid NOT NULL,
  change text NOT NULL CONSTRAINT sync_change_known CHECK (change IN ('create','set','unset','tombstone','restore','document')),
  record_kind text NOT NULL,
  record_id uuid NOT NULL,
  field text,
  -- create and set: the value as sent. Null for every other change; a document change's text is in document_revision.
  value jsonb,
  revision integer
);
CREATE INDEX sync_change_by_record ON sync_change (record_id, seq);

-- The first outcome of every op, keyed by opId (one epoch lives in a database at a time). Permanent,
-- rejected results included. A duplicate is answered from this row and applies nothing.
CREATE TABLE sync_result (
  op_id uuid PRIMARY KEY,
  status text NOT NULL CONSTRAINT sync_result_status_known CHECK (status IN ('applied','conflict','rejected')),
  seq bigint,
  revision integer,
  conflict_id text,
  code text
);

-- Open conflicts only. Resolving deletes the row; the server keeps no copy of a closed conflict.
CREATE TABLE sync_conflict (
  n bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  kind text NOT NULL CONSTRAINT sync_conflict_kind_known CHECK (kind IN ('field','tombstone','document')),
  record_kind text NOT NULL,
  record_id uuid NOT NULL,
  field text,
  losing jsonb NOT NULL,
  current jsonb NOT NULL
);

CREATE FUNCTION rt_sync_change_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sync_change rows are immutable' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER sync_change_immutable_row BEFORE UPDATE OR DELETE ON sync_change
  FOR EACH ROW EXECUTE FUNCTION rt_sync_change_immutable();
CREATE TRIGGER sync_change_immutable_truncate BEFORE TRUNCATE ON sync_change
  FOR EACH STATEMENT EXECUTE FUNCTION rt_sync_change_immutable();

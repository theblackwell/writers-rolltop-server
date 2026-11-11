-- Schema v1, manuscript side (ADR-0001 D2 and D3, applied per database: one library = one database).
-- Mirrors Apple/Packages/RolltopKit/Sources/RolltopKit/Store/StoreSchema.swift. Bible, notes, continuity
-- and the pov/setting foreign keys arrive in later migrations (M1-4, M1-10).
-- The runner wraps this file in one transaction: do not add BEGIN or COMMIT.

CREATE DOMAIN sha256_hex AS text
  CONSTRAINT sha256_hex_shape CHECK (VALUE ~ '^[0-9a-f]{64}$');

-- Fractional-index keys compare bytewise, so the domain pins the C collation.
CREATE DOMAIN order_key AS text COLLATE "C"
  CONSTRAINT order_key_shape CHECK (VALUE ~ '^[0-9a-z]+$' AND VALUE !~ '0$');

CREATE TABLE library (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  extra_json jsonb
);
-- A library database holds exactly one library.
CREATE UNIQUE INDEX library_single_row ON library ((true));

CREATE TABLE attachment (
  sha256 sha256_hex PRIMARY KEY,
  media_type text NOT NULL,
  byte_length bigint NOT NULL CONSTRAINT attachment_length_nonnegative CHECK (byte_length >= 0),
  original_name text,
  extension text,
  created_at timestamptz NOT NULL,
  extra_json jsonb
);

CREATE TABLE universe (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  summary text,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  extra_json jsonb
);

CREATE TABLE series (
  id uuid PRIMARY KEY,
  universe_id uuid REFERENCES universe(id),
  title text NOT NULL,
  summary text,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  extra_json jsonb
);

CREATE TABLE book (
  id uuid PRIMARY KEY,
  universe_id uuid REFERENCES universe(id),
  series_id uuid REFERENCES series(id),
  title text NOT NULL,
  subtitle text,
  author_name text,
  description text,
  language text,
  cover_attachment sha256_hex REFERENCES attachment(sha256),
  target_word_count integer,
  target_date text,
  logline text,
  premise text,
  themes text,
  arcs text,
  principles text,
  bible_version text,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  extra_json jsonb
);

CREATE TABLE manuscript_node (
  id uuid PRIMARY KEY,
  book_id uuid NOT NULL REFERENCES book(id),
  parent_id uuid REFERENCES manuscript_node(id),
  kind text NOT NULL CONSTRAINT node_kind_known CHECK (kind IN ('part','chapter','scene','frontMatter','backMatter')),
  title text NOT NULL,
  synopsis text,
  status text,
  pov_entry_id uuid,      -- foreign key to bible_entry arrives with the bible tables
  setting_entry_id uuid,  -- same
  target_word_count integer,
  plan text,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  extra_json jsonb
);
CREATE INDEX node_by_book ON manuscript_node (book_id, parent_id, order_key, id);

CREATE TABLE scene_document (
  node_id uuid PRIMARY KEY REFERENCES manuscript_node(id),
  revision integer NOT NULL CONSTRAINT document_revision_positive CHECK (revision >= 1),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE document_revision (
  node_id uuid NOT NULL REFERENCES manuscript_node(id),
  revision integer NOT NULL CONSTRAINT document_revision_row_positive CHECK (revision >= 1),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, revision)
);

-- Triggers: a second line of defence behind the archive validator. All raise check_violation (23514).

CREATE FUNCTION rt_node_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_kind text;
  parent_book uuid;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT kind, book_id INTO parent_kind, parent_book FROM manuscript_node WHERE id = NEW.parent_id;
  END IF;
  IF NEW.kind IN ('part', 'frontMatter', 'backMatter') AND NEW.parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'hierarchy: parts, front matter and back matter sit at the book root' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'chapter' AND NEW.parent_id IS NOT NULL AND parent_kind IS DISTINCT FROM 'part' THEN
    RAISE EXCEPTION 'hierarchy: a chapter sits at the book root or under a part' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'scene' AND (NEW.parent_id IS NULL OR parent_kind IS DISTINCT FROM 'chapter') THEN
    RAISE EXCEPTION 'hierarchy: a scene sits under a chapter' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_id IS NOT NULL AND parent_book IS DISTINCT FROM NEW.book_id THEN
    RAISE EXCEPTION 'same-book: a node''s parent must be in the same book' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER node_hierarchy BEFORE INSERT OR UPDATE OF kind, parent_id, book_id ON manuscript_node
  FOR EACH ROW EXECUTE FUNCTION rt_node_hierarchy();

CREATE FUNCTION rt_node_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('part', 'chapter') AND EXISTS (SELECT 1 FROM scene_document WHERE node_id = OLD.id) THEN
    RAISE EXCEPTION 'document: a node that has a document cannot become a part or chapter' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.kind IS DISTINCT FROM OLD.kind OR NEW.book_id IS DISTINCT FROM OLD.book_id)
     AND EXISTS (SELECT 1 FROM manuscript_node WHERE parent_id = OLD.id) THEN
    RAISE EXCEPTION 'hierarchy: a node with children cannot change kind or book' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER node_change_guard BEFORE UPDATE OF kind, book_id ON manuscript_node
  FOR EACH ROW EXECUTE FUNCTION rt_node_change_guard();

CREATE FUNCTION rt_scene_document_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM manuscript_node WHERE id = NEW.node_id) IN ('part', 'chapter') THEN
    RAISE EXCEPTION 'document: only scenes, front matter and back matter carry a document' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scene_document_kind BEFORE INSERT OR UPDATE OF node_id ON scene_document
  FOR EACH ROW EXECUTE FUNCTION rt_scene_document_kind();

CREATE FUNCTION rt_book_universe_matches_series() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  series_universe uuid;
BEGIN
  IF NEW.series_id IS NOT NULL THEN
    SELECT universe_id INTO series_universe FROM series WHERE id = NEW.series_id;
    IF series_universe IS NOT NULL AND NEW.universe_id IS DISTINCT FROM series_universe THEN
      RAISE EXCEPTION 'universe-match: a book''s universe must equal its series'' universe' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER book_universe_matches_series BEFORE INSERT OR UPDATE OF universe_id, series_id ON book
  FOR EACH ROW EXECUTE FUNCTION rt_book_universe_matches_series();

CREATE FUNCTION rt_series_universe_matches_books() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.universe_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM book WHERE series_id = NEW.id AND universe_id IS DISTINCT FROM NEW.universe_id) THEN
    RAISE EXCEPTION 'universe-match: a series'' universe must equal the universe of its books' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER series_universe_matches_books AFTER UPDATE OF universe_id ON series
  FOR EACH ROW EXECUTE FUNCTION rt_series_universe_matches_books();

-- Revisions are append-only.
CREATE FUNCTION rt_document_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_revision rows are immutable' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER document_revision_immutable_row BEFORE UPDATE OR DELETE ON document_revision
  FOR EACH ROW EXECUTE FUNCTION rt_document_revision_immutable();
CREATE TRIGGER document_revision_immutable_truncate BEFORE TRUNCATE ON document_revision
  FOR EACH STATEMENT EXECUTE FUNCTION rt_document_revision_immutable();

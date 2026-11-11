-- Schema v1, the rest: everything a .rolltop archive carries that 0001 lacks (bible, notes, references,
-- continuity). Mirrors Apple/Packages/RolltopKit/Sources/RolltopKit/Store/StoreSchema.swift: same table and
-- column names, same constraints, the same triggers ported to PL/pgSQL. The archive validator stays the
-- authority; these are the second line of defence. Additive only. Moves the bible schema forward from M1-10.
-- The runner wraps this file in one transaction: do not add BEGIN or COMMIT.

-- Unknown properties of the archive manifest (the manifest is open and must survive a round trip).
ALTER TABLE library ADD COLUMN manifest_extra_json jsonb;

CREATE TABLE entry_template (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  entry_type text NOT NULL CONSTRAINT template_entry_type CHECK (entry_type IN
    ('character','location','organization','object','event','plotline','worldRule','research','term')),
  built_in boolean NOT NULL,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb
);

CREATE TABLE entry_field (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES entry_template(id),
  key text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL CONSTRAINT field_type_known CHECK (field_type IN
    ('shortText','longText','integer','decimal','boolean','selection','realDate','fictionalDate',
     'entryReference','entryReferences','attachment','table')),
  required boolean NOT NULL,
  multiple boolean,
  options_json jsonb,
  target_entry_types_json jsonb,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT field_key_unique_in_template UNIQUE (template_id, key)
);

CREATE TABLE bible_entry (
  id uuid PRIMARY KEY,
  entry_type text NOT NULL CONSTRAINT entry_entry_type CHECK (entry_type IN
    ('character','location','organization','object','event','plotline','worldRule','research','term')),
  template_id uuid REFERENCES entry_template(id),
  name text NOT NULL,
  given_name text,
  family_name text,
  to_be_named boolean,
  aliases_json jsonb NOT NULL,
  summary text,
  universe_id uuid REFERENCES universe(id), series_id uuid REFERENCES series(id), book_id uuid REFERENCES book(id),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT scope_exactly_one CHECK (num_nonnulls(universe_id, series_id, book_id) = 1)
);

CREATE TABLE entry_value (
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  field_id uuid NOT NULL REFERENCES entry_field(id),
  value_json jsonb NOT NULL,
  PRIMARY KEY (entry_id, field_id)
);

CREATE TABLE entry_override (
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  book_id uuid NOT NULL REFERENCES book(id),
  position integer NOT NULL,
  PRIMARY KEY (entry_id, book_id)
);

CREATE TABLE entry_override_value (
  entry_id uuid NOT NULL,
  book_id uuid NOT NULL,
  field_id uuid NOT NULL REFERENCES entry_field(id),
  value_json jsonb NOT NULL,
  PRIMARY KEY (entry_id, book_id, field_id),
  FOREIGN KEY (entry_id, book_id) REFERENCES entry_override(entry_id, book_id)
);

CREATE TABLE entry_attachment (
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  sha256 sha256_hex NOT NULL REFERENCES attachment(sha256),
  position integer NOT NULL,
  PRIMARY KEY (entry_id, sha256)
);

ALTER TABLE manuscript_node
  ADD CONSTRAINT node_pov_entry_fk FOREIGN KEY (pov_entry_id) REFERENCES bible_entry(id),
  ADD CONSTRAINT node_setting_entry_fk FOREIGN KEY (setting_entry_id) REFERENCES bible_entry(id);

CREATE TABLE relationship_type (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  inverse_label text NOT NULL,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb
);

CREATE TABLE relationship (
  id uuid PRIMARY KEY,
  type_id uuid NOT NULL REFERENCES relationship_type(id),
  from_entry_id uuid NOT NULL REFERENCES bible_entry(id),
  to_entry_id uuid NOT NULL REFERENCES bible_entry(id),
  book_id uuid REFERENCES book(id),
  note text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT relationship_distinct_ends CHECK (from_entry_id <> to_entry_id)
);

CREATE TABLE fact (
  id uuid PRIMARY KEY,
  universe_id uuid REFERENCES universe(id), series_id uuid REFERENCES series(id), book_id uuid REFERENCES book(id),
  text text NOT NULL,
  truth text NOT NULL CONSTRAINT fact_truth_known CHECK (truth IN ('true','false','undecided')),
  node_id uuid REFERENCES manuscript_node(id),
  knowledge_json jsonb NOT NULL,
  overrides_json jsonb,
  dismissed_warnings_json jsonb,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT scope_exactly_one CHECK (num_nonnulls(universe_id, series_id, book_id) = 1)
);

CREATE TABLE fact_entry (
  fact_id uuid NOT NULL REFERENCES fact(id),
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  position integer NOT NULL,
  PRIMARY KEY (fact_id, entry_id)
);

CREATE TABLE question (
  id uuid PRIMARY KEY,
  universe_id uuid REFERENCES universe(id), series_id uuid REFERENCES series(id), book_id uuid REFERENCES book(id),
  text text NOT NULL,
  topic text,
  status text NOT NULL CONSTRAINT question_status_known CHECK (status IN ('open','decided')),
  decision text,
  node_id uuid REFERENCES manuscript_node(id),
  overrides_json jsonb,
  dismissed_warnings_json jsonb,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT scope_exactly_one CHECK (num_nonnulls(universe_id, series_id, book_id) = 1)
);

CREATE TABLE question_entry (
  question_id uuid NOT NULL REFERENCES question(id),
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  position integer NOT NULL,
  PRIMARY KEY (question_id, entry_id)
);

CREATE TABLE continuity_event (
  id uuid PRIMARY KEY,
  universe_id uuid REFERENCES universe(id), series_id uuid REFERENCES series(id), book_id uuid REFERENCES book(id),
  title text NOT NULL,
  summary text,
  when_json jsonb,
  entry_id uuid REFERENCES bible_entry(id),
  overrides_json jsonb,
  dismissed_warnings_json jsonb,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT scope_exactly_one CHECK (num_nonnulls(universe_id, series_id, book_id) = 1)
);

CREATE TABLE event_scene (
  event_id uuid NOT NULL REFERENCES continuity_event(id),
  node_id uuid NOT NULL REFERENCES manuscript_node(id),
  position integer NOT NULL,
  PRIMARY KEY (event_id, node_id)
);

CREATE TABLE event_participant (
  event_id uuid NOT NULL REFERENCES continuity_event(id),
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  role text,
  position integer NOT NULL,
  PRIMARY KEY (event_id, entry_id)
);

CREATE TABLE state_change (
  id uuid PRIMARY KEY,
  event_id uuid REFERENCES continuity_event(id),
  node_id uuid REFERENCES manuscript_node(id),
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  field_id uuid NOT NULL REFERENCES entry_field(id),
  value_json jsonb NOT NULL,
  note text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT state_change_event_xor_node CHECK ((event_id IS NULL) <> (node_id IS NULL))
);

CREATE TABLE manuscript_reference (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES manuscript_node(id),
  anchor_id text NOT NULL,
  entry_id uuid NOT NULL REFERENCES bible_entry(id),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb,
  CONSTRAINT reference_unique UNIQUE (node_id, anchor_id, entry_id)
);

CREATE TABLE note (
  id uuid PRIMARY KEY,
  book_id uuid NOT NULL REFERENCES book(id),
  node_id uuid REFERENCES manuscript_node(id),
  text text NOT NULL,
  order_key order_key NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, extra_json jsonb
);

CREATE INDEX entry_by_scope ON bible_entry (universe_id, series_id, book_id);
CREATE INDEX fact_by_scope ON fact (universe_id, series_id, book_id, order_key, id);
CREATE INDEX question_by_scope ON question (universe_id, series_id, book_id, order_key, id);
CREATE INDEX event_by_scope ON continuity_event (universe_id, series_id, book_id, order_key, id);
CREATE INDEX note_by_book ON note (book_id, node_id, order_key, id);
CREATE INDEX reference_by_entry ON manuscript_reference (entry_id);

-- Triggers. All raise check_violation (23514), like 0001.

CREATE FUNCTION rt_entry_template_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_id IS NOT NULL
     AND (SELECT entry_type FROM entry_template WHERE id = NEW.template_id) IS DISTINCT FROM NEW.entry_type THEN
    RAISE EXCEPTION 'template: the entry type must equal its template''s entry type' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entry_template_type_matches BEFORE INSERT OR UPDATE OF entry_type, template_id ON bible_entry
  FOR EACH ROW EXECUTE FUNCTION rt_entry_template_type();

CREATE FUNCTION rt_entry_value_field_in_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT template_id FROM entry_field WHERE id = NEW.field_id)
     IS DISTINCT FROM (SELECT template_id FROM bible_entry WHERE id = NEW.entry_id) THEN
    RAISE EXCEPTION 'template-field: a value''s field must belong to the entry''s template' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entry_value_field_in_template BEFORE INSERT OR UPDATE ON entry_value
  FOR EACH ROW EXECUTE FUNCTION rt_entry_value_field_in_template();
CREATE TRIGGER override_value_field_in_template BEFORE INSERT OR UPDATE ON entry_override_value
  FOR EACH ROW EXECUTE FUNCTION rt_entry_value_field_in_template();

CREATE FUNCTION rt_state_change_field_in_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT template_id FROM entry_field WHERE id = NEW.field_id)
     IS DISTINCT FROM (SELECT template_id FROM bible_entry WHERE id = NEW.entry_id) THEN
    RAISE EXCEPTION 'template-field: a state change''s field must belong to the entry''s template' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER state_change_field_in_template BEFORE INSERT OR UPDATE OF entry_id, field_id ON state_change
  FOR EACH ROW EXECUTE FUNCTION rt_state_change_field_in_template();

CREATE FUNCTION rt_override_book_in_entry_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inside boolean;
BEGIN
  SELECT CASE WHEN e.universe_id IS NOT NULL THEN b.universe_id IS NOT DISTINCT FROM e.universe_id
              WHEN e.series_id IS NOT NULL THEN b.series_id IS NOT DISTINCT FROM e.series_id
              ELSE false END
    INTO inside
    FROM bible_entry e, book b WHERE e.id = NEW.entry_id AND b.id = NEW.book_id;
  IF inside IS NOT TRUE THEN
    RAISE EXCEPTION 'override-scope: the book must be inside the entry''s scope' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER override_book_in_entry_scope BEFORE INSERT OR UPDATE ON entry_override
  FOR EACH ROW EXECUTE FUNCTION rt_override_book_in_entry_scope();

CREATE FUNCTION rt_note_node_same_book() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.node_id IS NOT NULL
     AND (SELECT book_id FROM manuscript_node WHERE id = NEW.node_id) IS DISTINCT FROM NEW.book_id THEN
    RAISE EXCEPTION 'same-book: a note''s node must be in the note''s book' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER note_node_same_book BEFORE INSERT OR UPDATE OF book_id, node_id ON note
  FOR EACH ROW EXECUTE FUNCTION rt_note_node_same_book();

CREATE FUNCTION rt_node_book_change_with_notes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.book_id IS DISTINCT FROM OLD.book_id AND EXISTS (SELECT 1 FROM note WHERE node_id = OLD.id) THEN
    RAISE EXCEPTION 'same-book: a node that notes point at cannot move to another book' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER node_book_change_with_notes BEFORE UPDATE OF book_id ON manuscript_node
  FOR EACH ROW EXECUTE FUNCTION rt_node_book_change_with_notes();

CREATE FUNCTION rt_book_scope_change_with_overrides() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM entry_override o JOIN bible_entry e ON e.id = o.entry_id
    WHERE o.book_id = NEW.id
      AND ((e.universe_id IS NOT NULL AND NEW.universe_id IS DISTINCT FROM e.universe_id)
        OR (e.series_id IS NOT NULL AND NEW.series_id IS DISTINCT FROM e.series_id)
        OR e.book_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'override-scope: the book is still the target of entry overrides that need its current universe or series' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER book_scope_change_with_overrides BEFORE UPDATE OF universe_id, series_id ON book
  FOR EACH ROW EXECUTE FUNCTION rt_book_scope_change_with_overrides();

CREATE FUNCTION rt_entry_template_change_with_values() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_id IS DISTINCT FROM OLD.template_id AND (
       EXISTS (SELECT 1 FROM state_change s JOIN entry_field f ON f.id = s.field_id
               WHERE s.entry_id = OLD.id AND f.template_id IS DISTINCT FROM NEW.template_id)
    OR EXISTS (SELECT 1 FROM entry_value v JOIN entry_field f ON f.id = v.field_id
               WHERE v.entry_id = OLD.id AND f.template_id IS DISTINCT FROM NEW.template_id)
    OR EXISTS (SELECT 1 FROM entry_override_value v JOIN entry_field f ON f.id = v.field_id
               WHERE v.entry_id = OLD.id AND f.template_id IS DISTINCT FROM NEW.template_id)) THEN
    RAISE EXCEPTION 'template-field: the entry still has values or state changes for fields of its old template' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entry_template_change_with_state_changes BEFORE UPDATE OF template_id, entry_type ON bible_entry
  FOR EACH ROW EXECUTE FUNCTION rt_entry_template_change_with_values();

CREATE FUNCTION rt_field_template_change_with_values() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_id IS DISTINCT FROM OLD.template_id AND (
       EXISTS (SELECT 1 FROM entry_value WHERE field_id = OLD.id)
    OR EXISTS (SELECT 1 FROM entry_override_value WHERE field_id = OLD.id)
    OR EXISTS (SELECT 1 FROM state_change WHERE field_id = OLD.id)) THEN
    RAISE EXCEPTION 'template-field: a field that is in use cannot move to another template' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_template_change_with_values BEFORE UPDATE OF template_id ON entry_field
  FOR EACH ROW EXECUTE FUNCTION rt_field_template_change_with_values();

// The in-memory form of an archive: parsed, shape-checked JSON per file, plus normalized documents.
// Records are kept as parsed JSON (open objects), so unknown properties on top-level records and on
// the manifest survive a read and a write unchanged (archive-format-v1.md, "Forward compatibility").
// After the shape check the fields used by the validator have the types the schema promises, which is
// why records are typed loosely here.

import type { CanonicalDocument } from "@writers-rolltop/document-adapter/canonical";
import type { Json } from "./json.ts";

export type Rec = { [key: string]: any };

export interface ArchiveData {
  /** The manifest's unknown properties (the manifest is open). Known properties are regenerated on write. */
  manifestExtra: { [key: string]: Json };
  /** library.json as a whole. */
  library: Rec;
  references: Rec[];
  notes: Rec[];
  attachments: Rec[];
  entries: Rec[];
  templates: Rec[];
  fields: Rec[];
  /** bible/relationships.json as a whole: { relationshipTypes, relationships }. */
  relationships: Rec;
  facts: Rec[];
  questions: Rec[];
  events: Rec[];
  stateChanges: Rec[];
  /** nodeId -> normalized canonical document. */
  documents: Map<string, CanonicalDocument>;
}

/** Archive path of each JSON file and the ArchiveData field that holds it. */
export const FILE_FIELDS = [
  ["library.json", "library"],
  ["references.json", "references"],
  ["notes.json", "notes"],
  ["attachments.json", "attachments"],
  ["bible/entries.json", "entries"],
  ["bible/templates.json", "templates"],
  ["bible/fields.json", "fields"],
  ["bible/relationships.json", "relationships"],
  ["bible/facts.json", "facts"],
  ["bible/questions.json", "questions"],
  ["continuity/events.json", "events"],
  ["continuity/state_changes.json", "stateChanges"],
] as const satisfies readonly (readonly [string, keyof ArchiveData])[];

export interface ArchiveSummary {
  libraryId: string;
  title: string;
  universes: number;
  series: number;
  books: number;
  manuscriptNodes: number;
  documents: number;
  /** Informational; Intl.Segmenter word boundaries. */
  words: number;
  entries: number;
  attachments: number;
  facts: number;
  questions: number;
  events: number;
  notes: number;
}

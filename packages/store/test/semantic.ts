import { FILE_FIELDS, stableStringify } from "@writers-rolltop/archive";
import type { ArchiveData } from "@writers-rolltop/archive";

type Rec = Record<string, any>;

/** The same instant, written with the shortest fraction. */
export const normTs = (s: string): string => s.replace(/(\.\d*?)0+Z$/, "$1Z").replace(/\.Z$/, "Z");

const normRec = (r: Rec): Rec => {
  const out: Rec = { ...r };
  for (const k of ["createdAt", "updatedAt", "deletedAt"]) if (typeof out[k] === "string") out[k] = normTs(out[k]);
  return out;
};
const byKey = (a: Rec, b: Rec): number => {
  const ka = a.id ?? a.sha256, kb = b.id ?? b.sha256;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};
const normList = (l: Rec[]): Rec[] => l.map(normRec).sort(byKey);

/**
 * Canonical form of everything an archive says except per-export manifest fields. Records are compared as sets
 * (sorted by id); the order inside a record (aliases, knowledge, participants, ...) is kept.
 */
export function semantic(data: ArchiveData, libraryId: string): string {
  const out: Rec = { manifestExtra: data.manifestExtra, libraryId };
  for (const [, field] of FILE_FIELDS) {
    const v = (data as any)[field];
    if (field === "library") {
      out.library = {
        library: normRec(v.library), universes: normList(v.universes), series: normList(v.series),
        books: normList(v.books), manuscriptNodes: normList(v.manuscriptNodes),
      };
    } else if (field === "relationships") {
      out.relationships = { relationshipTypes: normList(v.relationshipTypes), relationships: normList(v.relationships) };
    } else out[field] = normList(v);
  }
  out.documents = Object.fromEntries([...data.documents].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return stableStringify(out);
}

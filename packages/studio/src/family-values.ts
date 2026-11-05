// SPDX-License-Identifier: AGPL-3.0-only
export const familyRelations = {
  parent: {
    title: "Parent",
    label: "parent of",
    inverse: "child of",
    reversed: false,
  },
  child: {
    title: "Child",
    label: "parent of",
    inverse: "child of",
    reversed: true,
  },
  sibling: {
    title: "Sibling",
    label: "sibling of",
    inverse: "sibling of",
    reversed: false,
  },
  spouse: {
    title: "Spouse",
    label: "spouse of",
    inverse: "spouse of",
    reversed: false,
  },
  grandparent: {
    title: "Grandparent",
    label: "grandparent of",
    inverse: "grandchild of",
    reversed: false,
  },
  grandchild: {
    title: "Grandchild",
    label: "grandparent of",
    inverse: "grandchild of",
    reversed: true,
  },
  auntOrUncle: {
    title: "Aunt or uncle",
    label: "aunt or uncle of",
    inverse: "niece or nephew of",
    reversed: false,
  },
  nieceOrNephew: {
    title: "Niece or nephew",
    label: "aunt or uncle of",
    inverse: "niece or nephew of",
    reversed: true,
  },
  cousin: {
    title: "Cousin",
    label: "cousin of",
    inverse: "cousin of",
    reversed: false,
  },
  otherRelative: {
    title: "Other relative",
    label: "related to",
    inverse: "related to",
    reversed: false,
  },
  notRelated: {
    title: "Not related",
    label: "not related to",
    inverse: "not related to",
    reversed: false,
  },
} as const;
export function familyName(entry: {
  entryType: string;
  name: string;
  givenName?: string;
  familyName?: string;
}) {
  if (entry.entryType !== "character") return "";
  if (entry.givenName !== undefined || entry.familyName !== undefined)
    return (entry.familyName ?? "").trim();
  const last = entry.name.lastIndexOf(" ");
  return last < 0 ? "" : entry.name.slice(last + 1).trim();
}
const names = new Intl.Collator("en", { usage: "search", sensitivity: "base" });
export function sameFamilyName(
  a: Parameters<typeof familyName>[0],
  b: Parameters<typeof familyName>[0],
) {
  const x = familyName(a),
    y = familyName(b);
  return !!x && !!y && names.compare(x, y) === 0;
}

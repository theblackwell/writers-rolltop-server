// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { entryTypes } from "./entries.ts";
import { between } from "./order.ts";
import type { Query } from "./store.ts";
// Mirrors RolltopModel.BuiltIn (Records.swift); changes require parity review.
type FieldSpec = [key: string, label: string, type: string, targets?: string[]];
export const builtInFields: Record<(typeof entryTypes)[number], FieldSpec[]> = {
  character: [
    ["role", "Role", "shortText"],
    ["biography", "Biography", "longText"],
    ["age", "Age", "integer"],
    ["home", "Home", "entryReference", ["location"]],
  ],
  location: [
    ["description", "Description", "longText"],
    ["climate", "Climate", "shortText"],
  ],
  organization: [
    ["purpose", "Purpose", "longText"],
    ["leader", "Leader", "entryReference", ["character"]],
  ],
  object: [
    ["description", "Description", "longText"],
    ["owner", "Owner", "entryReference", ["character"]],
  ],
  event: [
    ["when", "When", "fictionalDate"],
    ["whatHappens", "What happens", "longText"],
  ],
  plotline: [
    ["stakes", "Stakes", "longText"],
    ["resolution", "Resolution", "longText"],
  ],
  worldRule: [
    ["rule", "The rule", "longText"],
    ["exceptions", "Exceptions", "longText"],
  ],
  research: [
    ["source", "Source", "shortText"],
    ["notes", "Notes", "longText"],
  ],
  term: [
    ["meaning", "Meaning", "longText"],
    ["pronunciation", "Pronunciation", "shortText"],
  ],
};
/** Library lock serializes initialization; never replaces existing customizations. */
export async function initializeTemplates(q: Query, libraryId: string) {
  const library = (
    await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [libraryId])
  ).rows[0];
  if (!library) throw new Error("Library no longer exists.");
  const existing = (
    await q(
      "SELECT data FROM bible_templates WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\", id",
      [libraryId],
    )
  ).rows.map((r) => r.data);
  let orderKey: string | undefined = existing.at(-1)?.orderKey;
  let added = 0;
  for (const entryType of entryTypes) {
    if (
      existing.some(
        (t) => t.builtIn && !t.deletedAt && t.entryType === entryType,
      )
    )
      continue;
    const now = new Date().toISOString();
    orderKey = between(orderKey);
    const template = {
      id: randomUUID(),
      name:
        entryType === "worldRule"
          ? "World Rule"
          : entryType[0].toUpperCase() + entryType.slice(1),
      entryType,
      builtIn: true,
      orderKey,
      createdAt: now,
      updatedAt: now,
    };
    await q(
      "INSERT INTO bible_templates(id,library_id,data) VALUES($1,$2,$3)",
      [template.id, libraryId, template],
    );
    let fieldOrder: string | undefined;
    for (const [key, label, fieldType, targets] of builtInFields[entryType]) {
      fieldOrder = between(fieldOrder);
      const field = {
        id: randomUUID(),
        templateId: template.id,
        key,
        label,
        fieldType,
        required: false,
        ...(targets ? { targetEntryTypes: targets } : {}),
        orderKey: fieldOrder,
        createdAt: now,
        updatedAt: now,
      };
      await q(
        "INSERT INTO bible_fields(id,library_id,template_id,data) VALUES($1,$2,$3,$4)",
        [field.id, libraryId, template.id, field],
      );
    }
    added++;
  }
  return added;
}

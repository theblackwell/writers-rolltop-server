// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { StudioError, title } from "./store.ts";
import type { Database } from "./store.ts";
import { entryTypes } from "./entries.ts";
import { between } from "./order.ts";
import { structuredValueError } from "./structured-values.ts";
const types = [
  "shortText",
  "longText",
  "integer",
  "decimal",
  "boolean",
  "selection",
  "realDate",
  "fictionalDate",
  "entryReference",
  "entryReferences",
  "attachment",
  "table",
];
const fail = (s: string): never => {
  throw new StudioError(400, "INVALID_INPUT", s);
};
const now = (old?: any) =>
  new Date(
    Math.max(Date.now(), old ? Date.parse(old.updatedAt) + 1 : 0),
  ).toISOString();
export async function editDefinition(
  db: Database,
  libraryId: string,
  kind: "template" | "field",
  input: any,
  id?: string,
) {
  const allowed =
    kind === "template"
      ? id
        ? ["name", "beforeId", "expectedUpdatedAt"]
        : ["name", "entryType"]
      : id
        ? [
            "label",
            "required",
            "multiple",
            "options",
            "targetEntryTypes",
            "beforeId",
            "expectedUpdatedAt",
          ]
        : [
            "templateId",
            "label",
            "fieldType",
            "required",
            "multiple",
            "options",
            "targetEntryTypes",
          ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    return fail(
      "Provide only editable template or field details. Types and keys cannot be changed.",
    );
  return db.transaction(async (q) => {
    if (
      !(await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [libraryId]))
        .rows[0]
    )
      throw new StudioError(404, "NOT_FOUND", "Library no longer exists.");
    const table = kind === "template" ? "bible_templates" : "bible_fields";
    const all = (
      await q(
        `SELECT data FROM ${table} WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C",id`,
        [libraryId],
      )
    ).rows.map((r) => r.data);
    const old = id ? all.find((r) => r.id === id) : undefined;
    if (id && !old)
      throw new StudioError(404, "NOT_FOUND", "Definition no longer exists.");
    if (old?.deletedAt) return fail("This definition is in Trash.");
    if (old && input.expectedUpdatedAt !== old.updatedAt)
      throw new StudioError(
        409,
        "DEFINITION_CONFLICT",
        "This definition changed. Your form is kept. Close and reopen Bible Entries to review it.",
      );
    const record: any = {
      ...(old ?? { id: randomUUID(), createdAt: now() }),
      updatedAt: now(old),
    };
    if (kind === "template") {
      if (!old && !entryTypes.includes(input.entryType))
        return fail("Choose a valid entry type.");
      if (input.name !== undefined || !old) record.name = title(input.name);
      if (!old) {
        record.entryType = input.entryType;
        record.builtIn = false;
      }
    } else {
      const templateId = old?.templateId ?? input.templateId;
      const template = (
        await q(
          "SELECT data FROM bible_templates WHERE id::text=$1 AND library_id=$2",
          [typeof templateId === "string" ? templateId : "", libraryId],
        )
      ).rows[0]?.data;
      if (!template || template.deletedAt)
        return fail("Choose a live template in this library.");
      if (input.label !== undefined || !old) record.label = title(input.label);
      if (!old) {
        if (!types.includes(input.fieldType))
          return fail("Choose a valid field type.");
        record.fieldType = input.fieldType;
        record.templateId = template.id;
        record.required = false;
        const words = record.label.split(/[^a-zA-Z0-9]+/).filter(Boolean);
        let base = words
          .map((w: string, i: number) =>
            i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase(),
          )
          .join("");
        if (!/^[a-z]/.test(base)) base = "field" + base;
        base = base.slice(0, 64);
        let key = base,
          n = 2;
        while (all.some((f) => f.templateId === template.id && f.key === key)) {
          const suffix = String(n++);
          key = base.slice(0, 64 - suffix.length) + suffix;
        }
        record.key = key;
      }
      if (input.required !== undefined) {
        if (typeof input.required !== "boolean")
          return fail("Choose whether the field is suggested.");
        record.required = input.required;
      }
      if (input.multiple !== undefined) {
        if (
          record.fieldType !== "selection" ||
          typeof input.multiple !== "boolean"
        )
          return fail("Multiple choices apply only to selection fields.");
        record.multiple = input.multiple;
      }
      if (record.fieldType === "selection") {
        if (!old || input.options !== undefined) {
          if (
            !Array.isArray(input.options) ||
            input.options.length < 1 ||
            input.options.length > 200
          )
            return fail("Provide 1–200 selection options.");
          const seen = new Set();
          record.options = input.options.map((o: any) => {
            if (
              !o ||
              typeof o !== "object" ||
              Array.isArray(o) ||
              Object.keys(o).some((k) => !["id", "label"].includes(k))
            )
              return fail("Provide option labels and their existing IDs.");
            if (
              o.id !== undefined &&
              (!old?.options?.some((x: any) => x.id === o.id) || seen.has(o.id))
            )
              return fail(
                "Keep existing option IDs unique; omit IDs for new options.",
              );
            const option = {
              ...(old?.options?.find((x: any) => x.id === o.id) ?? {}),
              id: o.id ?? randomUUID(),
              label: title(o.label),
            };
            seen.add(option.id);
            return option;
          });
        }
      } else if (input.options !== undefined)
        return fail("Only selection fields have options.");
      if (input.targetEntryTypes !== undefined) {
        if (!["entryReference", "entryReferences"].includes(record.fieldType))
          return fail("Target types apply only to entry-reference fields.");
        if (input.targetEntryTypes === null) delete record.targetEntryTypes;
        else {
          if (
            !Array.isArray(input.targetEntryTypes) ||
            new Set(input.targetEntryTypes).size !==
              input.targetEntryTypes.length ||
            input.targetEntryTypes.some((t: any) => !entryTypes.includes(t))
          )
            return fail("Choose unique allowed entry types.");
          record.targetEntryTypes = input.targetEntryTypes;
        }
      }
      const ids = (options: any[]) => (options ?? []).map((o) => o.id).sort();
      const constraintsChanged =
        old &&
        ((old.multiple === true) !== (record.multiple === true) ||
          JSON.stringify(ids(old.options)) !==
            JSON.stringify(ids(record.options)) ||
          JSON.stringify(old.targetEntryTypes?.slice().sort()) !==
            JSON.stringify(record.targetEntryTypes?.slice().sort()));
      if (constraintsChanged) {
        const entries = (
          await q(
            "SELECT e.data FROM bible_entries e JOIN books b ON b.id=e.book_id WHERE b.library_id=$1",
            [libraryId],
          )
        ).rows.map((r) => r.data);
        for (const entry of entries)
          for (const map of [
            entry.values,
            ...(entry.overrides ?? []).map((o: any) => o.values),
          ]) {
            if (!map || !Object.hasOwn(map, record.id)) continue;
            const value = map[record.id];
            if (
              record.fieldType === "selection" &&
              structuredValueError(record, value)
            )
              return fail(
                "These options or choice limits are used by saved values. Keep them to preserve existing entries, including Trash.",
              );
            if (
              ["entryReference", "entryReferences"].includes(
                record.fieldType,
              ) &&
              record.targetEntryTypes
            ) {
              const ids = Array.isArray(value) ? value : [value];
              if (
                ids.some((id) => {
                  const target = entries.find((e) => e.id === id);
                  return (
                    !target ||
                    !record.targetEntryTypes.includes(target.entryType)
                  );
                })
              )
                return fail(
                  "The target restriction would invalidate saved links. Keep the allowed types.",
                );
            }
          }
      }
    }
    const peers = all.filter(
      (r) =>
        r.id !== id &&
        (kind === "template" || r.templateId === record.templateId),
    );
    if (!old || Object.hasOwn(input, "beforeId")) {
      let index = peers.length;
      if (input.beforeId != null) {
        if (
          typeof input.beforeId !== "string" ||
          (index = peers.findIndex((r) => r.id === input.beforeId)) < 0
        )
          return fail("Choose a sibling definition as the position.");
      }
      // Repair equal imported keys only when they prevent inserting at the chosen position.
      if (
        index > 0 &&
        index < peers.length &&
        peers[index - 1].orderKey === peers[index].orderKey
      ) {
        let lower: string | undefined;
        for (const peer of peers) {
          lower = between(lower);
          peer.orderKey = lower;
          peer.updatedAt = now(peer);
          await q(`UPDATE ${table} SET data=$2 WHERE id=$1`, [peer.id, peer]);
        }
      }
      record.orderKey = between(
        peers[index - 1]?.orderKey,
        peers[index]?.orderKey,
      );
    }
    if (old)
      await q(`UPDATE ${table} SET data=$3 WHERE id=$1 AND library_id=$2`, [
        id,
        libraryId,
        record,
      ]);
    else if (kind === "template")
      await q("INSERT INTO bible_templates VALUES($1,$2,$3)", [
        record.id,
        libraryId,
        record,
      ]);
    else
      await q("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
        record.id,
        libraryId,
        record.templateId,
        record,
      ]);
    return record;
  });
}

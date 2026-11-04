// SPDX-License-Identifier: AGPL-3.0-only
import { StudioError, title } from "./store.ts";
export const entryTypes = [
  "character",
  "location",
  "organization",
  "object",
  "event",
  "plotline",
  "worldRule",
  "research",
  "term",
] as const;
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
export function entryInput(input: any, updating = false) {
  const allowed = updating
    ? [
        "name",
        "givenName",
        "familyName",
        "aliases",
        "summary",
        "toBeNamed",
        "expectedUpdatedAt",
        "deleted",
      ]
    : [
        "name",
        "entryType",
        "givenName",
        "familyName",
        "aliases",
        "summary",
        "toBeNamed",
      ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    invalid("Provide only editable bible-entry details.");
  if (!updating && !entryTypes.includes(input.entryType))
    invalid("Choose a bible entry type.");
  if (updating && typeof input.expectedUpdatedAt !== "string")
    invalid("Reopen the entry before editing it.");
  if (
    input.deleted !== undefined &&
    (typeof input.deleted !== "boolean" ||
      Object.keys(input).some(
        (k) => !["deleted", "expectedUpdatedAt"].includes(k),
      ))
  )
    invalid("Choose Trash or restore separately from editing details.");
  return input;
}
export function editEntry(old: any, input: any) {
  const result = { ...old };
  if (input.name !== undefined) result.name = title(input.name);
  for (const key of ["givenName", "familyName"]) {
    if (input[key] === undefined) continue;
    if (old.entryType !== "character")
      invalid("Only characters have a first and last name.");
    if (
      input[key] !== null &&
      (typeof input[key] !== "string" || input[key].length > 500)
    )
      invalid("Use a name of at most 500 characters.");
    const value = input[key]?.trim();
    if (value) result[key] = value;
    else delete result[key];
  }
  if (input.givenName !== undefined || input.familyName !== undefined)
    result.name = title(
      [result.givenName, result.familyName].filter(Boolean).join(" "),
    );
  if (input.summary !== undefined) {
    if (typeof input.summary !== "string" || input.summary.length > 20000)
      invalid("Use a summary of at most 20,000 characters.");
    if (input.summary) result.summary = input.summary;
    else delete result.summary;
  }
  if (input.aliases !== undefined) {
    if (
      !Array.isArray(input.aliases) ||
      input.aliases.length > 100 ||
      input.aliases.some(
        (a: unknown) => typeof a !== "string" || a.length > 500,
      )
    )
      invalid("Use at most 100 aliases, each at most 500 characters.");
    result.aliases = input.aliases.map((a: string) => a.trim()).filter(Boolean);
  }
  if (input.toBeNamed !== undefined) {
    if (typeof input.toBeNamed !== "boolean")
      invalid("Choose whether the name is still to be decided.");
    if (input.toBeNamed) result.toBeNamed = true;
    else delete result.toBeNamed;
  }
  return result;
}

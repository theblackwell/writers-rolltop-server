// SPDX-License-Identifier: AGPL-3.0-only
export const structuredTypes = [
  "selection",
  "realDate",
  "fictionalDate",
  "table",
];
const object = (v: any) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function structuredValueError(
  field: { fieldType: string; multiple?: boolean; options?: { id: string }[] },
  value: any,
): string | undefined {
  if (value === null) return;
  switch (field.fieldType) {
    case "selection":
      if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== "string") ||
        new Set(value).size !== value.length
      )
        return "Choose unique selection options.";
      if (field.multiple !== true && value.length > 1)
        return "Choose at most one option.";
      if (value.some((v) => !field.options?.some((o) => o.id === v)))
        return "Choose options from the current field definition.";
      return;
    case "realDate": {
      if (
        typeof value !== "string" ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\s\S])/.test(value)
      )
        return "Use a real date in YYYY-MM-DD format.";
      const [y, m, d] = value.split("-").map(Number);
      const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
      if (
        m < 1 ||
        m > 12 ||
        d < 1 ||
        d > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
      )
        return "Use a valid Gregorian calendar date.";
      return;
    }
    case "fictionalDate":
      if (
        !object(value) ||
        Object.keys(value).some(
          (k) => !["label", "calendar", "ordinal"].includes(k),
        ) ||
        typeof value.label !== "string" ||
        value.label.length === 0
      )
        return "Enter a fictional date label.";
      if (
        Object.hasOwn(value, "calendar") &&
        (typeof value.calendar !== "string" || value.calendar.length === 0)
      )
        return "Omit the calendar or enter its name.";
      if (
        Object.hasOwn(value, "ordinal") &&
        !Number.isSafeInteger(value.ordinal)
      )
        return "Use an ordinal within ±(2^53−1), or leave it unset.";
      return;
    case "table": {
      if (
        !object(value) ||
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "columns") ||
        !Object.hasOwn(value, "rows") ||
        !Array.isArray(value.columns) ||
        !Array.isArray(value.rows)
      )
        return "Use a table with columns and rows.";
      if (
        value.columns.length < 1 ||
        value.columns.length > 20 ||
        value.rows.length > 500
      )
        return "Use 1–20 columns and at most 500 rows.";
      const valid = (s: any) =>
        typeof s === "string" && Array.from(s).length <= 1000;
      if (
        !value.columns.every(valid) ||
        value.rows.some(
          (r: any) =>
            !Array.isArray(r) ||
            r.length !== value.columns.length ||
            !r.every(valid),
        )
      )
        return "Every row needs one text cell per column; headings and cells allow at most 1,000 characters.";
      return;
    }
  }
}

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "spec", "fixtures");
export const readJSON = (...p: string[]): any => JSON.parse(readFileSync(path.join(fixtures, ...p), "utf8"));
export const jsonFiles = (...p: string[]): string[] =>
  readdirSync(path.join(fixtures, ...p)).filter((f) => f.endsWith(".json")).sort();

export function nonEmpty<T>(items: T[], what: string): T[] {
  if (items.length === 0) throw new Error(`no fixtures found for ${what}`);
  return items;
}

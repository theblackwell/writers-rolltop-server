// The path rules of archive format v1: what may be in the ZIP. Only ASCII names pass the allowlist,
// so a name can never act as anything but a name.

export const MANIFEST = "manifest.json";
export const CHECKSUMS = "checksums.json";

/** Every one of these is required. */
export const REQUIRED_FILES: readonly string[] = [
  "manifest.json", "checksums.json", "library.json", "references.json", "notes.json", "attachments.json",
  "bible/entries.json", "bible/templates.json", "bible/fields.json", "bible/relationships.json",
  "bible/facts.json", "bible/questions.json", "continuity/events.json", "continuity/state_changes.json",
];
const REQUIRED = new Set(REQUIRED_FILES);

const MANUSCRIPT = /^manuscript\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const ATTACHMENT = /^attachments\/([0-9a-f]{64})(?:\.([a-z0-9]{1,10}))?$/;

export const manuscriptNodeId = (path: string): string | undefined => MANUSCRIPT.exec(path)?.[1];
export function attachmentParts(path: string): { sha256: string; ext?: string } | undefined {
  const m = ATTACHMENT.exec(path);
  if (!m) return undefined;
  return m[2] === undefined ? { sha256: m[1]! } : { sha256: m[1]!, ext: m[2] };
}
export const attachmentPath = (sha256: string, ext?: string): string => `attachments/${sha256}${ext === undefined ? "" : `.${ext}`}`;
export const isAttachmentPath = (path: string): boolean => path.startsWith("attachments/");
export const isAllowedFile = (path: string): boolean =>
  REQUIRED.has(path) || MANUSCRIPT.test(path) || ATTACHMENT.test(path);

/** A problem with the shape of a name: absolute, "..", ".", backslash, empty segment, NUL, volume prefix. */
export function syntaxProblem(rawPath: string, isDirectory: boolean): string | undefined {
  let path = rawPath;
  if (isDirectory && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") return "empty path";
  if (path.includes("\0")) return "path contains a NUL byte";
  if (path.includes("\\")) return "path contains a backslash";
  if (path.startsWith("/")) return "absolute path";
  for (const segment of path.split("/")) {
    if (segment === "") return "empty path segment";
    if (segment === "." || segment === "..") return `path segment "${segment}"`;
  }
  const colon = path.indexOf(":");
  if (colon >= 0 && !path.slice(0, colon).includes("/")) return "path with a volume prefix";
  return undefined;
}

/**
 * The one sanitiser for untrusted text that enters a message (names, ids, keys, document-adapter messages).
 * The input is first cut to a bounded length (so a huge key costs a small, fixed amount of work), then
 * every control character (C0, DEL, C1: \p{Cc}), format character (\p{Cf}: bidi marks, embeddings,
 * isolates, zero-width, BOM), private-use (\p{Co}), unassigned (\p{Cn}), line and paragraph
 * separator and lone surrogate is replaced with "?", runs of more than 3 combining marks (\p{Mn}) are cut
 * to 3, and the text is limited to `max` characters (default 64) with "..." when anything was cut.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
const MARK_RUN = /(\p{Mn}{3})\p{Mn}+/gu;
export const MAX_SHOWN = 64;
/** The cap for a document-adapter message, which can embed attacker-chosen keys and types. */
export const DOC_MESSAGE_MAX = 300;
export function printable(s: unknown, max: number = MAX_SHOWN): string {
  const full = String(s);
  // Enough code units for `max` characters even after a mark run is cut; never split a surrogate pair.
  let cut = 2 * max + 2;
  if (full.length > cut) {
    const last = full.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut++;
  }
  const bounded = full.length > cut ? full.slice(0, cut) : full;
  const clean = bounded.replace(UNSAFE, "?").replace(MARK_RUN, "$1");
  const chars = Array.from(clean);
  return chars.length <= max && bounded === full ? clean : `${chars.slice(0, max).join("")}...`;
}

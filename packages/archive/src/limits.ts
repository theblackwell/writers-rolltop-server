// Reader safety limits (archive-format-v1.md, "Reader safety requirements"). They are defaults:
// callers may tighten them (tests do) but never raise them; the reader always applies some value.

export interface ArchiveLimits {
  maxEntries: number;
  /** Total expanded bytes of all entries. */
  maxTotalBytes: number;
  /** One JSON file (including manuscript documents). */
  maxJSONBytes: number;
  /** All JSON files together; they are held in memory while the archive is read. */
  maxTotalJSONBytes: number;
  maxAttachmentBytes: number;
  /** The ratio is only checked for entries larger than this. */
  ratioThresholdBytes: number;
  maxCompressionRatio: number;
  /** Size of the ZIP central directory. */
  maxCentralDirectoryBytes: number;
}

export const DEFAULT_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxEntries: 10_000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxJSONBytes: 100 * 1024 ** 2,
  maxTotalJSONBytes: 256 * 1024 ** 2,
  maxAttachmentBytes: 250 * 1024 ** 2,
  ratioThresholdBytes: 1024 ** 2,
  maxCompressionRatio: 200,
  maxCentralDirectoryBytes: 16 * 1024 ** 2,
});

/** Limits can be tightened but never raised or removed: an unset or invalid value falls back to the default, a larger one is clamped to it. */
export function resolveLimits(overrides: Partial<ArchiveLimits> | undefined): ArchiveLimits {
  const out: ArchiveLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ArchiveLimits)[]) {
    const v = overrides?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = Math.min(v, DEFAULT_LIMITS[key]);
  }
  return out;
}

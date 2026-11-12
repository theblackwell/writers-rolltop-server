// How often the studio asks the server for changes. A test knob can change it, but only in a dev or test build: the
// call site reads window.__ROLLTOP_POLL_MS__ only when import.meta.env.DEV is true, so a production build never reads it.
export const DEFAULT_POLL_MS = 20_000;

/** The knob's value if it is a finite number of zero or more (0 turns polling off), else the default. */
export function pollInterval(knob: unknown): number {
  return typeof knob === "number" && Number.isFinite(knob) && knob >= 0 ? knob : DEFAULT_POLL_MS;
}

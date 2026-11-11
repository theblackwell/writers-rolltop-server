export interface Closable { close(): Promise<unknown> }

export interface ShutdownOptions {
  /** Force-exit delay if close() has not finished. Default 5000 ms. */
  timeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
}

/**
 * On a signal, close the app. A failed close logs to stderr and exits 1; a close that does not finish in
 * `timeoutMs` also exits 1, so a stuck request cannot block shutdown. A clean close lets the process end on its own.
 */
export function installShutdown(app: Closable, options: ShutdownOptions = {}): void {
  const timeoutMs = options.timeoutMs ?? 5000;
  for (const signal of options.signals ?? (["SIGTERM", "SIGINT"] as const)) {
    process.once(signal, () => {
      const timer = setTimeout(() => {
        console.error(`shutdown did not finish within ${timeoutMs} ms; forcing exit`);
        process.exit(1);
      }, timeoutMs);
      timer.unref();
      app.close().catch((error: unknown) => {
        console.error("shutdown failed", error);
        process.exit(1);
      });
    });
  }
}

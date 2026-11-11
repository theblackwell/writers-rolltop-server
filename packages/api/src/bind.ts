const LOOPBACK = /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i;

export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host);

/**
 * Until authentication exists (M1-7), the library routes may only listen on a loopback address. Returns the
 * reason to refuse, or undefined when it is fine to start.
 */
export function bindRefusal(host: string, libraryRoutesEnabled: boolean, insecureBind: string | undefined): string | undefined {
  if (!libraryRoutesEnabled || isLoopbackHost(host) || insecureBind === "1") return undefined;
  return `Refusing to start: HOST=${host} is not a loopback address and the library routes (import, export) have no authentication yet. Use 127.0.0.1, or set ROLLTOP_INSECURE_BIND=1 to accept the risk.`;
}

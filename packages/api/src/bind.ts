const LOOPBACK = /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i;

export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host);

/**
 * The server speaks plain HTTP. With the library routes on, a non-loopback bind is accepted only behind a
 * TLS-terminating reverse proxy, and the operator confirms that with ROLLTOP_INSECURE_BIND=1. Returns the reason to
 * refuse, or undefined when it is fine to start.
 */
export function bindRefusal(host: string, libraryRoutesEnabled: boolean, insecureBind: string | undefined): string | undefined {
  if (!libraryRoutesEnabled || isLoopbackHost(host) || insecureBind === "1") return undefined;
  return `Refusing to start: HOST=${host} is not a loopback address, and this server speaks plain HTTP. Bind a non-loopback address only behind a TLS-terminating reverse proxy: set ROLLTOP_INSECURE_BIND=1 to confirm that, list the public host name in ROLLTOP_ALLOWED_HOSTS, and leave ROLLTOP_COOKIE_SECURE at its default. Otherwise use HOST=127.0.0.1.`;
}

/** ROLLTOP_COOKIE_SECURE: unset, "", "1" or "true" mean Secure (the default); "0" or "false" turn it off. Anything else is an error. */
export function cookieSecureSetting(value: string | undefined): { secure: boolean } | { refusal: string } {
  if (value === undefined || value === "" || value === "1" || value === "true") return { secure: true };
  if (value === "0" || value === "false") return { secure: false };
  return { refusal: "Refusing to start: ROLLTOP_COOKIE_SECURE must be 1, true, 0 or false." };
}

/** Secure off means the session cookie travels in clear text: fine on loopback, never on another address without an explicit override. */
export function cookieRefusal(host: string, secure: boolean, libraryRoutesEnabled: boolean, insecureBind: string | undefined): string | undefined {
  if (secure || !libraryRoutesEnabled || isLoopbackHost(host) || insecureBind === "1") return undefined;
  return `Refusing to start: ROLLTOP_COOKIE_SECURE is off while HOST=${host} is not a loopback address, so the session cookie could cross the network in clear text. Leave ROLLTOP_COOKIE_SECURE at its default, or set ROLLTOP_INSECURE_BIND=1 as well to accept the risk.`;
}

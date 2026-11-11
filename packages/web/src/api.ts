// Calls to the auth routes of the API (packages/api/src/auth.ts). Same-origin: the browser sends the session cookie
// by itself. This file never stores a password, token or cookie anywhere.

export interface SessionState { signedIn: boolean; setupRequired: boolean }

export class AuthFailure extends Error {
  /** A plain sentence for the person using the studio. */
  readonly kind: "network" | "wrong-password" | "too-many" | "setup-token" | "weak-password" | "server" | "other";
  constructor(kind: AuthFailure["kind"], message: string) {
    super(message);
    this.name = "AuthFailure";
    this.kind = kind;
  }
}

export const PASSWORD_MIN_CHARS = 12;

/** Same count the server uses: NFKC-normalised, counted in characters. */
export const passwordLength = (password: string): number => [...password.normalize("NFKC")].length;

/** "14 minutes" or "30 seconds", from a Retry-After value in seconds. */
export function waitText(retryAfter: string | null): string {
  const s = Number(retryAfter);
  if (!Number.isFinite(s) || s <= 0) return "a few minutes";
  if (s < 90) { const n = Math.ceil(s); return n === 1 ? "1 second" : `${n} seconds`; }
  const m = Math.ceil(s / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new AuthFailure("network", "Cannot reach the server. Check that it is running, then try again.");
  }
}

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

async function errorBody(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string }; code?: string; message?: string };
    return j.error ?? j;
  } catch {
    return {};
  }
}

export async function getSession(signal?: AbortSignal): Promise<SessionState> {
  const res = await send("/api/auth/session", { ...(signal ? { signal } : {}) });
  if (!res.ok) throw new AuthFailure("server", "The server could not check your sign-in. Try again.");
  const j = (await res.json()) as Partial<SessionState>;
  return { signedIn: j.signedIn === true, setupRequired: j.setupRequired === true };
}

export async function login(password: string, signal?: AbortSignal): Promise<void> {
  const res = await post("/api/auth/login", { password }, signal);
  if (res.ok) return;
  if (res.status === 401) throw new AuthFailure("wrong-password", "That password is not right.");
  if (res.status === 429) {
    if ((await errorBody(res)).code === "AUTH_BUSY") {
      throw new AuthFailure("too-many", `The server is busy. Try again in ${waitText(res.headers.get("retry-after"))}.`);
    }
    throw new AuthFailure("too-many", `Too many wrong passwords. Wait ${waitText(res.headers.get("retry-after"))}, then try again.`);
  }
  if (res.status >= 500) throw new AuthFailure("server", "The server had a problem. Try again.");
  throw new AuthFailure("other", (await errorBody(res)).message ?? "Sign-in did not work.");
}

export async function setup(token: string, password: string, signal?: AbortSignal): Promise<void> {
  const res = await post("/api/auth/setup", { token, password }, signal);
  if (res.ok) return;
  const body = await errorBody(res);
  if (res.status === 403 && body.code === "SETUP_UNAVAILABLE") {
    throw new AuthFailure("setup-token", "The setup token is wrong or has expired. Restart the server to get a new one from its log.");
  }
  if (res.status === 400 && body.code === "INVALID_PASSWORD") {
    throw new AuthFailure("weak-password", body.message ?? `The password must be at least ${PASSWORD_MIN_CHARS} characters.`);
  }
  if (res.status === 429) {
    throw new AuthFailure("too-many", "The server is busy with other sign-ins. Try again in a moment.");
  }
  if (res.status >= 500) throw new AuthFailure("server", "The server had a problem. Try again.");
  throw new AuthFailure("other", body.message ?? "Setup did not work.");
}

export async function logout(): Promise<void> {
  const res = await post("/api/auth/logout", {});
  if (!res.ok) throw new AuthFailure("server", "Could not sign out. Try again.");
}

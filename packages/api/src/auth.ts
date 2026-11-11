// Authentication for the self-hosted server (M1-7): one owner account per library database, a first-run setup, a
// password login, cookie sessions, a database-backed login rate limit, and the guard that every request passes.
//
// SAFE TO PUBLISH ONLY AFTER THIS SECTION, AND ONLY BEHIND HTTPS. The server speaks plain HTTP: a reverse proxy (or
// similar) must terminate TLS, forward the original Host header, and the Host must be listed in ROLLTOP_ALLOWED_HOSTS.
//
// Origin and Host: the proxy must forward Host INCLUDING the port when it is not the default (443 or 80). An Origin
// header is accepted only if its host:port equals the Host header, so a proxy that strips the port makes every
// browser POST fail with 403 FORBIDDEN_ORIGIN. The check is not to be weakened to make that go away.
//
// What this file does not cover: TLS termination; account recovery; password reset; two-factor sign-in; more than one
// account (the product is single-author); more than one server process on one database (the login queue and the
// setup token live in this process's memory). The owner resets a lost password only by re-running setup on an empty
// database, which means restoring the library from a backup. Setup also ends every existing session.
//
// Not covered (recorded, not fixed here):
//  - No query timeout on the database pool: a stalled database holds requests (availability; M1-11).
//  - A failed-login lockout can be triggered by anyone who can reach the server (it stops guessing, and also stops the
//    owner for up to 15 minutes). Operator recovery: stop the source of the failures, then DELETE FROM login_failure
//    (M1-11 documents this).
//  - The setup token stays in the container or journal log once printed (accepted; M1-11 documents it).
//  - The Spec sync error list has no UNAUTHENTICATED code (a Spec decision, made outside this package).
//  - Whether the Apple client handles Secure and __Host- cookies over http://127.0.0.1 is unconfirmed (test on the Apple side).
//  - Reverse-proxy configuration for production (M1-11).
//
// Secrets: the password is hashed with scrypt (password.ts). A session cookie holds a random 256-bit token and the
// database holds only its SHA-256. The setup token is printed once by index.ts and only its SHA-256 is kept, in memory.
// Nothing in this file logs a password, token, cookie or hash: log entries are fixed codes and messages.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Store } from "@writers-rolltop/store";
import { ApiError } from "./api-errors.ts";
import { hashPassword, normalizePassword, passwordProblem, verifyPassword, PASSWORD_MAX_BYTES } from "./password.ts";

/** A session ends after this long without a request... */
export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
/** ...and, whatever its use, this long after it was made. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
/** After this many failed sign-ins in the window, sign-in is refused (429) until the oldest of them leaves the window. */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
/** How long the setup token printed at startup stays valid. A restart prints a new one. */
export const SETUP_TOKEN_TTL_MS = 60 * 60_000;
/** Sign-ins and setups run one at a time (each hash uses about 128 MiB); this many may wait, the rest get 429. */
const MAX_QUEUED = 8;
/** Room for a 1024-byte password even when JSON escapes every character (up to 6 bytes each). */
const AUTH_BODY_LIMIT = 8192;

export const AUTH_PREFIX = "/api/auth/";
const SESSION_COOKIE = "rolltop_session";
/** With Secure the `__Host-` prefix applies: the browser then also insists on Path=/ and no Domain. */
const SECURE_SESSION_COOKIE = "__Host-rolltop_session";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

type AuthLog = (entry: { code: string; message: string }) => void;

export interface AuthOptions {
  pool: Store["pool"];
  /** Mark the session cookie Secure (browsers then send it only over HTTPS, and over http://localhost). */
  cookieSecure: boolean;
  clock?: () => Date;
  setupTokenTtlMs?: number;
  log?: AuthLog;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const unavailable = () => new ApiError(403, "SETUP_UNAVAILABLE", "Setup is not available.");
const failed = () => new ApiError(401, "INVALID_CREDENTIALS", "Sign-in failed.");
const unauthenticated = () => new ApiError(401, "UNAUTHENTICATED", "Sign in to use this server.");

export class Auth {
  readonly cookieSecure: boolean;
  readonly cookieName: string;
  private readonly pool: Store["pool"];
  private readonly clock: () => Date;
  private readonly setupTtl: number;
  private readonly log: AuthLog;
  private setupState: { hash: Buffer; expiresAt: number } | undefined;
  private dummy: Promise<string> | undefined;
  private queued = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(o: AuthOptions) {
    this.pool = o.pool;
    this.cookieSecure = o.cookieSecure;
    this.cookieName = o.cookieSecure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
    this.clock = o.clock ?? (() => new Date());
    this.setupTtl = o.setupTokenTtlMs ?? SETUP_TOKEN_TTL_MS;
    this.log = o.log ?? (() => {});
  }

  /** One sign-in or setup at a time: bounds memory, and makes the failure count exact. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queued >= MAX_QUEUED) return Promise.reject(new ApiError(429, "AUTH_BUSY", "Too many sign-in attempts at once. Try again shortly.", { headers: { "retry-after": "5" } }));
    this.queued++;
    const result = this.tail.then(fn);
    this.tail = result.then(() => {}, () => {}).then(() => { this.queued--; });
    return result;
  }

  async ownerExists(): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM owner")).rowCount === 1;
  }

  /**
   * Call once at startup. With no owner yet, makes a one-time setup token (256 bits) and returns it for the caller to
   * print ONCE; only its hash is kept. With an owner, returns undefined and setup stays closed.
   */
  async prepareSetup(): Promise<{ token: string; expiresAt: Date } | undefined> {
    if (await this.ownerExists()) { this.setupState = undefined; return undefined; }
    // Before setup a login checks a dummy hash; make it now so that path takes no longer than a real one.
    await this.dummyHash().catch(() => {});
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.clock().getTime() + this.setupTtl;
    this.setupState = { hash: sha256(token), expiresAt };
    return { token, expiresAt: new Date(expiresAt) };
  }

  /** Creates the owner. A wrong, expired, used or absent token, and an existing owner, all give the same refusal. */
  setup(token: unknown, password: unknown): Promise<void> {
    return this.serialize(async () => {
      const state = this.setupState;
      const valid = state !== undefined && typeof token === "string" && token.length <= 128
        && this.clock().getTime() < state.expiresAt && timingSafeEqual(sha256(token), state.hash);
      if (!valid) throw unavailable();
      if (await this.ownerExists()) { this.setupState = undefined; throw unavailable(); }
      const problem = passwordProblem(password);
      if (problem) throw new ApiError(400, "INVALID_PASSWORD", problem); // the token stays usable
      this.setupState = undefined; // single use from here on
      const now = this.clock();
      // Hash first: the pooled connection is not held for the ~100 ms the hash takes.
      let hash: string;
      try { hash = await hashPassword(password as string); } catch (e) { this.setupState ??= state; throw e; }
      const client = await this.pool.connect().catch((e: unknown) => { this.setupState ??= state; throw e; });
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO owner (password_hash, created_at, updated_at) VALUES ($1, $2, $2)", [hash, now]);
        await client.query("DELETE FROM login_failure");
        // A session left from before (for example in a restored backup that has no owner) must not become valid again.
        await client.query("DELETE FROM session");
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if ((e as { code?: string })?.code === "23505") throw unavailable(); // an owner appeared meanwhile
        this.setupState ??= state; // a fault of ours: let the same token try again
        throw e;
      } finally {
        client.release();
      }
      this.log({ code: "AUTH_SETUP_DONE", message: "owner account created" });
    });
  }

  private dummyHash(): Promise<string> {
    if (!this.dummy) {
      const made = hashPassword(randomBytes(18).toString("base64"));
      this.dummy = made;
      made.catch(() => { if (this.dummy === made) this.dummy = undefined; }); // a rejection is retried, not cached
    }
    return this.dummy;
  }

  /** Verifies the password and starts a session. Returns the cookie token. */
  login(password: string): Promise<string> {
    return this.serialize(async () => {
      const now = this.clock();
      const since = new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS);
      const recent = await this.pool.query<{ at: Date }>("SELECT at FROM login_failure WHERE at > $1 ORDER BY at DESC LIMIT $2", [since, LOGIN_FAILURE_LIMIT]);
      if (recent.rows.length >= LOGIN_FAILURE_LIMIT) {
        const until = recent.rows[LOGIN_FAILURE_LIMIT - 1]!.at.getTime() + LOGIN_FAILURE_WINDOW_MS;
        const seconds = Math.max(1, Math.ceil((until - now.getTime()) / 1000));
        this.log({ code: "AUTH_LOGIN_LOCKED", message: "sign-in refused: too many failures" });
        throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many failed sign-ins. Try again later.", { headers: { "retry-after": String(seconds) } });
      }
      const owner = (await this.pool.query<{ password_hash: string }>("SELECT password_hash FROM owner")).rows[0];
      let ok = false;
      // The cap applies after normalisation, as at setup: the same typed input gets the same answer in both places.
      if (Buffer.byteLength(normalizePassword(password), "utf8") <= PASSWORD_MAX_BYTES) {
        // With no owner (before setup) a dummy hash is checked, so the time and the answer match a wrong password.
        const matches = await verifyPassword(password, owner?.password_hash ?? await this.dummyHash());
        ok = matches && owner !== undefined;
      }
      if (!ok) {
        await this.pool.query("INSERT INTO login_failure (at) VALUES ($1)", [now]);
        await this.pool.query("DELETE FROM login_failure WHERE at <= $1", [since]);
        this.log({ code: "AUTH_LOGIN_FAILED", message: "sign-in failed" });
        throw failed();
      }
      const token = randomBytes(32).toString("base64url");
      await this.pool.query("DELETE FROM login_failure");
      await this.pool.query("DELETE FROM session WHERE expires_at <= $1 OR last_seen_at <= $2", [now, new Date(now.getTime() - SESSION_IDLE_MS)]);
      await this.pool.query(
        "INSERT INTO session (token_hash, created_at, last_seen_at, expires_at) VALUES ($1, $2, $2, $3)",
        [sha256(token).toString("hex"), now, new Date(now.getTime() + SESSION_ABSOLUTE_MS)],
      );
      return token;
    });
  }

  /** True if the token names a live session (and then notes that it was just used). Fails closed on any fault. */
  async validateSession(token: string): Promise<boolean> {
    if (!TOKEN_SHAPE.test(token)) return false;
    const hash = sha256(token).toString("hex");
    const now = this.clock();
    const idleLimit = new Date(now.getTime() - SESSION_IDLE_MS);
    const live = await this.pool.query(
      "UPDATE session SET last_seen_at = $2 WHERE token_hash = $1 AND expires_at > $2 AND last_seen_at > $3 AND EXISTS (SELECT 1 FROM owner)",
      [hash, now, idleLimit],
    );
    if (live.rowCount === 1) return true;
    await this.pool.query("DELETE FROM session WHERE token_hash = $1 AND (expires_at <= $2 OR last_seen_at <= $3)", [hash, now, idleLimit]);
    return false;
  }

  async endSession(token: string): Promise<void> {
    if (TOKEN_SHAPE.test(token)) await this.pool.query("DELETE FROM session WHERE token_hash = $1", [sha256(token).toString("hex")]);
  }

  sessionCookie(token: string): string {
    return `${this.cookieName}=${token}; Max-Age=${SESSION_ABSOLUTE_MS / 1000}; Path=/; HttpOnly; SameSite=Strict${this.cookieSecure ? "; Secure" : ""}`;
  }

  clearedCookie(): string {
    return `${this.cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${this.cookieSecure ? "; Secure" : ""}`;
  }

  /** The session token in a Cookie header, if there is one (the first cookie of that name). */
  tokenFrom(cookieHeader: string | undefined): string | undefined {
    for (const part of (cookieHeader ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === this.cookieName) return part.slice(eq + 1).trim();
    }
    return undefined;
  }
}

const OPEN_ROUTES = new Set([
  "GET /api/health", "HEAD /api/health", "GET /api/auth/session", "HEAD /api/auth/session",
  "POST /api/auth/login", "POST /api/auth/setup",
]);
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True if an Origin header names this server (same host and port as the request's Host header). */
function isOwnOrigin(origin: string, host: string | undefined): boolean {
  if (host === undefined) return false;
  let u: URL;
  try { u = new URL(origin); } catch { return false; } // "null" and junk are not our origin
  return (u.protocol === "http:" || u.protocol === "https:") && u.host.toLowerCase() === host.toLowerCase();
}

/**
 * Registers, after the Host and cross-site hook, the hook every request passes. Default deny: only the four open
 * routes (matched on the exact raw path) work without a session, so an unknown path or an odd encoding gets 401.
 * State-changing requests must also carry no foreign Origin (CSRF). Sec-Fetch-Site is refused in the global hook in app.ts.
 */
export function installAuthGuard(app: FastifyInstance, auth: Auth): void {
  app.addHook("onRequest", async (req) => {
    if (STATE_CHANGING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined && !isOwnOrigin(origin, req.headers.host)) throw new ApiError(403, "FORBIDDEN_ORIGIN", "Cross-site requests are not accepted.");
    }
    const path = req.url.split("?", 1)[0]!;
    if (OPEN_ROUTES.has(`${req.method} ${path}`)) return;
    const token = auth.tokenFrom(req.headers.cookie);
    if (token === undefined || !(await auth.validateSession(token))) throw unauthenticated();
  });
}

const object = (body: unknown): Record<string, unknown> => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "INVALID_REQUEST", "The request is not valid.");
  return body as Record<string, unknown>;
};
const noStore = (reply: FastifyReply): FastifyReply => reply.header("cache-control", "no-store");

export function registerAuthRoutes(app: FastifyInstance, auth: Auth): void {
  app.get("/api/auth/session", async (req, reply) => {
    const token = auth.tokenFrom(req.headers.cookie);
    const signedIn = token !== undefined && await auth.validateSession(token);
    return noStore(reply).send({ signedIn, setupRequired: !(await auth.ownerExists()) });
  });

  app.post("/api/auth/setup", { bodyLimit: AUTH_BODY_LIMIT }, async (req, reply) => {
    const body = object(req.body);
    await auth.setup(body.token, body.password);
    return noStore(reply).status(201).send({ created: true });
  });

  app.post("/api/auth/login", { bodyLimit: AUTH_BODY_LIMIT }, async (req, reply) => {
    const { password } = object(req.body);
    if (typeof password !== "string" || password === "") throw new ApiError(400, "INVALID_REQUEST", "The request is not valid.");
    const token = await auth.login(password);
    return noStore(reply).header("set-cookie", auth.sessionCookie(token)).send({ signedIn: true });
  });

  app.post("/api/auth/logout", { bodyLimit: AUTH_BODY_LIMIT }, async (req, reply) => {
    const token = auth.tokenFrom(req.headers.cookie);
    if (token !== undefined) await auth.endSession(token);
    return noStore(reply).header("set-cookie", auth.clearedCookie()).send({ signedIn: false });
  });
}

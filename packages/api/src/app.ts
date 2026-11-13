import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyError } from "fastify";
import { ArchiveError } from "@writers-rolltop/archive";
import { StoreError } from "@writers-rolltop/store";
import type { Store } from "@writers-rolltop/store";
import { ApiError, publicBody, sanitizeForLog } from "./api-errors.ts";
import { runImport } from "./import-runner.ts";
import { registerContinuityRoutes } from "./continuity-routes.ts";
import { registerSyncRoutes, SYNC_PREFIX } from "./sync-routes.ts";
import { AUTH_PREFIX, installAuthGuard, registerAuthRoutes } from "./auth.ts";
import type { Auth } from "./auth.ts";
import type { ImportConfig } from "./import-runner.ts";

export const APP_VERSION = "0.0.0";

export interface LogEntry { code: string; message: string; issues?: { code: string; recordId?: string; bookId?: string }[] }

export interface LibraryRoutes {
  store: Store;
  /** Owner account, sessions and the guard. Required: library routes are never served without it. */
  auth: Auth;
  /** Private folder for in-flight export files. */
  exportsDir: string;
  /** Largest accepted import body, in bytes. */
  maxImportBytes: number;
  import: Omit<ImportConfig, "attachmentsDir"> & { attachmentsDir: string };
}

export interface AppOptions {
  /** Library routes (import, export, sync). Without it the app serves only the health route. */
  library?: LibraryRoutes;
  /** Receives code, sanitised message and issues. Never a cause object. Default: one JSON line on stderr. */
  log?: (entry: LogEntry) => void;
  /** Extra Host header values to accept besides loopback (for example the name a reverse proxy uses). Compared without the port. */
  allowedHosts?: string[];
  /** Whole-request time limit, so a stalled upload cannot hold the import slot for ever. Default 10 minutes. */
  requestTimeoutMs?: number;
  /** Idle-socket limit. Default 2 minutes. */
  connectionTimeoutMs?: number;
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

const defaultLog = (entry: LogEntry): void => { console.error(JSON.stringify(entry)); };

const GENERIC_500 = new ApiError(500, "INTERNAL_ERROR", "The server could not complete the request.");

/** Builds the HTTP API. Library routes exist only when `options.library` is given. */
export function buildApp(options: AppOptions = {}) {
  const log = options.log ?? defaultLog;
  const app = Fastify({
    logger: false,
    requestTimeout: options.requestTimeoutMs ?? 10 * 60_000,
    connectionTimeout: options.connectionTimeoutMs ?? 2 * 60_000,
  });
  const extraHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));

  const toApiError = (error: unknown, url = ""): ApiError => {
    if (error instanceof ApiError) return error;
    const e = error as Partial<FastifyError> & { validation?: unknown };
    // Sync and auth routes speak JSON and name a malformed request INVALID_REQUEST.
    const jsonRoute = url.startsWith(SYNC_PREFIX) || url.startsWith(AUTH_PREFIX);
    if (jsonRoute && e?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request with the content type application/json.");
    if (jsonRoute && e?.code !== "FST_ERR_CTP_BODY_TOO_LARGE" && typeof e?.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      return new ApiError(400, "INVALID_REQUEST", "The request is not valid.", { logMessage: sanitizeForLog(e?.code) });
    }
    if (e?.code === "FST_ERR_CTP_BODY_TOO_LARGE") return new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is larger than this server accepts.");
    if (e?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the archive with the content type application/zip.");
    if (e?.validation || (typeof e?.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500)) {
      return new ApiError(400, "BAD_REQUEST", "The request is not valid.", { logMessage: sanitizeForLog(e?.code) });
    }
    // The archive code is only a reason to refuse an upload (that path runs in the worker). Here an ArchiveError comes
    // from exporting, which is a server fault. Log the code only: its message can hold file system paths.
    if (error instanceof ArchiveError) return new ApiError(500, "INTERNAL_ERROR", GENERIC_500.message, { logMessage: error.code });
    if (error instanceof StoreError) {
      if (error.code === "NOT_FOUND") return new ApiError(404, "LIBRARY_NOT_FOUND", "This server holds no library yet.");
      return new ApiError(500, "INTERNAL_ERROR", GENERIC_500.message, { logMessage: sanitizeForLog(`${error.code}`) });
    }
    return new ApiError(500, "INTERNAL_ERROR", GENERIC_500.message, { logMessage: sanitizeForLog((error as Error)?.name) });
  };

  app.setErrorHandler((error, req, reply) => {
    const api = toApiError(error, req.url);
    if (api.status >= 500 || api.logMessage) {
      log({ code: api.code, message: api.logMessage ?? api.message, ...(api.issues?.length ? { issues: api.issues } : {}) });
    }
    if (api.headers) reply.headers(api.headers);
    return reply.status(api.status).send(publicBody(api));
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(publicBody(new ApiError(404, "NOT_FOUND", "There is nothing at this address."))));

  // DNS-rebinding and cross-site defence (it stays with authentication, as defence in depth): only loopback names, or names the operator allowed.
  app.addHook("onRequest", async (req) => {
    const host = String(req.headers.host ?? "");
    if (!LOOPBACK_HOST.test(host) && !extraHosts.has(host.toLowerCase().replace(/:\d{1,5}$/, ""))) {
      throw new ApiError(403, "FORBIDDEN_HOST", "This server does not answer to that host name.");
    }
    // Cross-site and same-site, for every method (a GET that reads library content too). Same-origin, "none" and no
    // header at all (native clients, curl) pass.
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site" || site === "same-site") throw new ApiError(403, "FORBIDDEN_ORIGIN", "Cross-site requests are not accepted.");
  });

  // Responses under /api/ may carry library content (export, sync) or session state: no cache, shared or private, may keep them.
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });

  app.get("/api/health", async () => ({ status: "ok", version: APP_VERSION }));

  const lib = options.library;
  if (lib) {
    // After the Host check above, before every other route hook (the import slot is taken in a route hook).
    installAuthGuard(app, lib.auth);
    registerAuthRoutes(app, lib.auth);
    registerSyncRoutes(app, lib.store);
    registerContinuityRoutes(app, lib.store);
    // Both routes do heavy work, so one runs at a time.
    /** The request that holds the import slot. Only the holder ever gives it back. */
    let importHolder: object | undefined;
    let exporting = false;
    /** Requests whose handler has started: only then does the handler (not the connection) end the import lease. */
    const handlerStarted = new WeakSet<object>();

    app.addContentTypeParser("application/zip", { parseAs: "buffer", bodyLimit: lib.maxImportBytes }, (_req, body, done) => done(null, body));

    app.post("/api/import", {
      bodyLimit: lib.maxImportBytes,
      // Before the body is buffered: a busy server refuses at once, and the slot is taken for the whole upload.
      onRequest: async (req, reply) => {
        if (importHolder) throw new ApiError(429, "IMPORT_BUSY", "Another import is running. Try again when it has finished.");
        importHolder = req;
        // A request that dies before its handler starts (too large, wrong type, dropped upload) gives the slot back here.
        reply.raw.once("close", () => { if (!handlerStarted.has(req) && importHolder === req) importHolder = undefined; });
      },
    }, async (req, reply) => {
      // If the connection closed after the body was read but before this line, the close listener already gave the
      // slot back (and another import may hold it now). Without the slot, no worker may start.
      if (importHolder !== req) throw new ApiError(429, "IMPORT_BUSY", "Another import is running. Try again when it has finished.");
      handlerStarted.add(req);
      try {
        if (!Buffer.isBuffer(req.body)) {
          throw req.headers["content-type"]?.startsWith("application/zip")
            ? new ApiError(400, "BAD_REQUEST", "The request has no body.")
            : new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the archive with the content type application/zip.");
        }
        const outcome = await runImport(req.body, lib.import);
        return reply.status(201).send(outcome);
      } finally {
        if (importHolder === req) importHolder = undefined;
      }
    });

    app.get("/api/export", async (_req, reply) => {
      if (exporting) throw new ApiError(429, "EXPORT_BUSY", "Another export is running. Try again when it has finished.");
      exporting = true;
      const file = join(lib.exportsDir, `export-${randomUUID()}.rolltop`);
      // Registered before any await: a client that leaves while the file is still being built is noticed.
      let clientGone = false;
      reply.raw.once("close", () => { clientGone = true; });
      let cleaned = false;
      const done = (): void => {
        if (cleaned) return;
        cleaned = true;
        exporting = false;
        void rm(file, { force: true }).catch(() => {});
      };
      try {
        await mkdir(lib.exportsDir, { recursive: true, mode: 0o700 });
        await lib.store.exportArchive(file);
      } catch (e) {
        done();
        // "No library yet" is the client's to know; every other fault is the server's and is not described.
        if (e instanceof StoreError && e.code === "NOT_FOUND") throw e;
        if (e instanceof ArchiveError || e instanceof StoreError) throw new ApiError(500, "INTERNAL_ERROR", GENERIC_500.message, { logMessage: e.code });
        throw e;
      }
      if (clientGone || reply.raw.destroyed) {
        done();
        reply.hijack();
        return reply;
      }
      const stream = createReadStream(file);
      stream.once("close", done);
      stream.once("error", done);
      reply.raw.once("close", () => { stream.destroy(); done(); });
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", 'attachment; filename="library.rolltop"')
        .send(stream);
    });
  }
  return app;
}

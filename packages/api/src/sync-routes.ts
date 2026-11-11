// Sync protocol v1 routes (Spec/docs/sync-protocol-v1.md). The engine lives in @writers-rolltop/store; this file
// only maps HTTP to it. NO AUTHENTICATION until M1-7: these routes must not be published before then. The host
// and cross-site checks of app.ts and the bind refusal in bind.ts apply to them exactly as they do to import/export.
import type { FastifyInstance } from "fastify";
import type { Store } from "@writers-rolltop/store";
import { ApiError } from "./api-errors.ts";

export const SYNC_PREFIX = "/api/sync/v1";
/** Request body limit of POST /push (the protocol's 16 MiB). */
export const PUSH_BODY_LIMIT = 16 * 1024 ** 2;

const RESYNC_MESSAGE = "The epoch or cursor is not valid for this library. Pull again from the start.";

/** An AbortSignal that fires when the client goes away before the response has been written. */
function clientGone(reply: { raw: import("node:http").ServerResponse }): AbortSignal {
  const ctl = new AbortController();
  reply.raw.once("close", () => { if (!reply.raw.writableFinished) ctl.abort(); });
  return ctl.signal;
}

export function registerSyncRoutes(app: FastifyInstance, store: Store): void {
  const resync = (reply: import("fastify").FastifyReply, o: { epoch: string; head: number }) =>
    reply.status(409).send({ error: { code: "RESYNC_REQUIRED", message: RESYNC_MESSAGE }, epoch: o.epoch, head: o.head });
  const abandoned = (e: unknown, reply: import("fastify").FastifyReply) => {
    if (!(e instanceof Error) || e.name !== "AbortError") return false;
    reply.hijack();
    return true;
  };

  app.post(`${SYNC_PREFIX}/push`, { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    const signal = clientGone(reply);
    try {
      const out = await store.syncPush(req.body, signal);
      switch (out.kind) {
        case "invalid": throw new ApiError(400, "INVALID_REQUEST", "The request body is not a valid push.");
        case "too-large": throw new ApiError(413, "PAYLOAD_TOO_LARGE", "A document is larger than this server accepts.");
        case "resync": return resync(reply, out);
        case "ok": return reply.send({ epoch: out.epoch, head: out.head, results: out.results });
      }
    } catch (e) {
      if (abandoned(e, reply)) return reply;
      throw e;
    }
  });

  app.get(`${SYNC_PREFIX}/changes`, async (req, reply) => {
    const q = new URL(req.url, "http://sync.invalid").searchParams;
    try {
      const out = await store.syncChanges({ epoch: q.get("epoch"), after: q.has("after") ? q.get("after") : null, limit: q.has("limit") ? q.get("limit") : null }, clientGone(reply));
      switch (out.kind) {
        case "invalid": throw new ApiError(400, "INVALID_REQUEST", "Invalid query parameters.");
        case "resync": return resync(reply, out);
        case "ok": return reply.send({ epoch: out.epoch, head: out.head, changes: out.changes, next: out.next });
      }
    } catch (e) {
      if (abandoned(e, reply)) return reply;
      throw e;
    }
  });

  app.get(`${SYNC_PREFIX}/conflicts`, async (req, reply) => {
    const q = new URL(req.url, "http://sync.invalid").searchParams;
    try {
      const out = await store.syncConflicts({ epoch: q.get("epoch") }, clientGone(reply));
      switch (out.kind) {
        case "invalid": throw new ApiError(400, "INVALID_REQUEST", "Invalid query parameters.");
        case "resync": return resync(reply, out);
        case "ok": return reply.send({ epoch: out.epoch, conflicts: out.conflicts });
      }
    } catch (e) {
      if (abandoned(e, reply)) return reply;
      throw e;
    }
  });
}

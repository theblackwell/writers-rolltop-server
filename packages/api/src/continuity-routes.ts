// GET /api/continuity/warnings: the continuity warnings of the stored library (M1-10 slice 4). Computed on every request
// from a consistent snapshot with the archive's own rules (continuityWarnings), so the server and an exported archive agree.
// Behind the session guard like every /api route; /api responses are no-store (app.ts), so a change shows at once.
import type { FastifyInstance } from "fastify";
import { continuityWarnings } from "@writers-rolltop/archive";
import type { Store } from "@writers-rolltop/store";

export const CONTINUITY_PREFIX = "/api/continuity";

export function registerContinuityRoutes(app: FastifyInstance, store: Store): void {
  app.get(`${CONTINUITY_PREFIX}/warnings`, async (_req, reply) => {
    // No library yet: the store's NOT_FOUND becomes the usual 404 LIBRARY_NOT_FOUND (app.ts).
    const warnings = continuityWarnings(await store.readArchiveData());
    return reply.send({ warnings });
  });
}

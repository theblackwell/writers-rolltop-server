import Fastify from "fastify";

export const APP_VERSION = "0.0.0";

// Builds the HTTP API. M1-1 exposes a health route only; library routes arrive in later sections.
export function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/api/health", async () => ({ status: "ok", version: APP_VERSION }));
  return app;
}

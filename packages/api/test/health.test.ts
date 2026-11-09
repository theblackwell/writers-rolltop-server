import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, APP_VERSION } from "../src/app.ts";

test("health route reports ok and the version", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", version: APP_VERSION });
  await app.close();
});

test("unknown routes return 404", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/nope" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

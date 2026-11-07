// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, onUnauthorized } from "../../../apps/web/src/api.ts";
async function withFetch<T>(
  make: () => Response,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => make()) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    onUnauthorized(undefined);
  }
}
test("api client falls back to the HTTP status text for non-JSON error bodies", async () => {
  await withFetch(
    () =>
      new Response("<html>Bad gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    async () => {
      await assert.rejects(api("/books"), (e: any) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.status, 502);
        assert.equal(e.message, "Bad Gateway");
        return true;
      });
    },
  );
});
test("api client reports an unreadable success body and reads server messages", async () => {
  await withFetch(
    () => new Response("not json", { status: 200 }),
    () => assert.rejects(api("/books"), /unreadable response/),
  );
  await withFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "Nope." } }), {
        status: 409,
      }),
    () => assert.rejects(api("/books"), /Nope\./),
  );
});
test("a 401 outside login and session calls notifies the app; login failures do not", async () => {
  let calls = 0;
  onUnauthorized(() => calls++);
  await withFetch(
    () => new Response("{}", { status: 401, statusText: "Unauthorized" }),
    async () => {
      onUnauthorized(() => calls++);
      await assert.rejects(api("/books"), ApiError);
      assert.equal(calls, 1);
      await assert.rejects(api("/login", "POST", {}), ApiError);
      await assert.rejects(api("/session"), ApiError);
      assert.equal(calls, 1);
    },
  );
});

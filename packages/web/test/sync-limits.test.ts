// The knob for the poll interval, and the size rule for keepalive requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLL_MS, pollInterval } from "../src/sync/poll.ts";
import { KEEPALIVE_LIMIT_BYTES, fitsKeepalive } from "../src/sync/http.ts";

test("the poll knob must be a finite number of zero or more; anything else gives the default", () => {
  assert.equal(pollInterval(undefined), DEFAULT_POLL_MS);
  assert.equal(pollInterval(null), DEFAULT_POLL_MS);
  assert.equal(pollInterval("500"), DEFAULT_POLL_MS);
  assert.equal(pollInterval(NaN), DEFAULT_POLL_MS);
  assert.equal(pollInterval(Infinity), DEFAULT_POLL_MS);
  assert.equal(pollInterval(-5), DEFAULT_POLL_MS);
  assert.equal(pollInterval(0), 0);
  assert.equal(pollInterval(250), 250);
});

test("the keepalive limit counts bytes, not characters", () => {
  const op = (text: string) => ({ opId: "o", op: "document", value: { text } });
  const E = "00000000-0000-4000-8000-000000000001";
  assert.equal(fitsKeepalive(E, E, [op("a".repeat(1000))]), true);
  assert.equal(fitsKeepalive(E, E, [op("a".repeat(KEEPALIVE_LIMIT_BYTES))]), false);
  // 30,000 characters is far below the limit as a string length, but 90,000 bytes as sent.
  const cjk = "語".repeat(30_000);
  assert.ok(JSON.stringify(op(cjk)).length < KEEPALIVE_LIMIT_BYTES);
  assert.equal(fitsKeepalive(E, E, [op(cjk)]), false);
  assert.equal(fitsKeepalive(E, E, [op("語".repeat(55_000))]), false);
});

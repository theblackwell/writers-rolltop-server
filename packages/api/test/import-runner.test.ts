import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api-errors.ts";
import { runImport } from "../src/import-runner.ts";

const base = { databaseUrl: "postgres://unused@127.0.0.1:1/none", attachmentsDir: "/nonexistent", timeoutMs: 60_000, maxHeapMb: 1024 };
const code = (c: string) => (e: unknown) => e instanceof ApiError && e.code === c;

test("a worker stuck in a CPU loop is terminated at the time budget", async () => {
  const started = Date.now();
  await assert.rejects(runImport(Buffer.from("x"), { ...base, timeoutMs: 400, fault: "spin" }), code("IMPORT_TIMEOUT"));
  assert.ok(Date.now() - started < 5000);
});

test("a worker that allocates without end is stopped by the heap cap", async () => {
  const started = Date.now();
  await assert.rejects(runImport(Buffer.from("x"), { ...base, maxHeapMb: 64, fault: "allocate" }), code("IMPORT_MEMORY_EXCEEDED"));
  assert.ok(Date.now() - started < 20_000);
});

test("the main thread stays responsive while a worker spins", async () => {
  const run = runImport(Buffer.from("x"), { ...base, timeoutMs: 800, fault: "spin" }).catch(() => undefined);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  await run;
  clearInterval(timer);
  assert.ok(ticks >= 10, `the event loop ticked ${ticks} times while the worker ran`);
});

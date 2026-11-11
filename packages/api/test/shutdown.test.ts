import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} closes the server and exits cleanly`, async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, sig) => r({ code, signal: sig })));
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      assert.ok(up, "server did not start");
      child.kill(signal);
      assert.deepEqual(await exited, { code: 0, signal: null });
    } finally {
      child.kill("SIGKILL"); // no-op once the child has exited
    }
  });
}

for (const mode of ["fail", "hang"] as const) {
  test(`a close that ${mode === "fail" ? "fails" : "hangs"} exits non-zero within a bounded time`, async () => {
    const fixture = fileURLToPath(new URL("./fixtures/bad-close.ts", import.meta.url));
    const child = spawn(process.execPath, [fixture], { env: { ...process.env, CLOSE_MODE: mode }, stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    let timeout: NodeJS.Timeout | undefined;
    try {
      // Resolve on output or on exit, so a child that dies first cannot hang the test.
      await Promise.race([new Promise<void>((r) => child.stdout.once("data", () => r())), exited]);
      const started = Date.now();
      child.kill("SIGTERM");
      timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
      const code = await exited;
      assert.equal(code, 1);
      assert.ok(Date.now() - started < 4000);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
    }
  });
}

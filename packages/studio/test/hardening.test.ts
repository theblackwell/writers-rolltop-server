// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { fixture } from "./support.ts";
import { studioServer, ipKey, stripPort } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { PortableImports, digest } from "../src/portable.ts";
import { captureLibrary, writeBookBackup } from "../src/backup.ts";
import { postgres } from "../src/postgres.ts";

// The pre-optimization algorithm: re-serializes rows on every comparison.
const legacyCanonical = (v: any): string =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const legacyDigest = (b: any) =>
  createHash("sha256")
    .update(
      Buffer.from(
        legacyCanonical(
          Object.fromEntries(
            Object.entries(b.tables).map(([k, rows]: any) => [
              k,
              [...rows].sort((x: any, y: any) =>
                legacyCanonical(x).localeCompare(legacyCanonical(y)),
              ),
            ]),
          ),
        ),
      ),
    )
    .digest("hex");

test("import digest is unchanged by the single-serialization sort", async () => {
  const synthetic: any = {
    tables: {
      zeta: [],
      alpha: [
        { id: "b", data: { y: 1, x: [2, { d: 1, c: 2 }] } },
        { id: "a", data: { x: "é", y: null }, when: new Date(0) },
        { id: "B", data: {} },
      ],
    },
  };
  assert.equal(digest(synthetic), legacyDigest(synthetic));
  // Pinned value computed with the previous implementation.
  assert.equal(
    digest(synthetic),
    "a834d346b1d3643d2cc6ad929bc6d47896a0da15259700531fe1482e251fadec",
  );
  const f = await fixture();
  const real = await f.store.db.transaction((q) =>
    captureLibrary(q, f.library.id, f.library.id, true),
  );
  assert.equal(digest(real), legacyDigest(real));
});

test("duplicate commit while the first is installing returns the same result; cancel is a no-op meanwhile", async () => {
  const f = await fixture();
  const bytes = await readFile(
    new URL(
      "../fixtures/archives/valid/unknown-optional-fields.rolltop",
      import.meta.url,
    ),
  );
  const imports = new PortableImports(f.store);
  const preview = await imports.preview(bytes);
  const first = imports.commit(preview.id, { mode: "new" });
  const second = imports.commit(preview.id, { mode: "new" });
  assert.deepEqual(imports.cancel(preview.id), { cancelled: false });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(
    (await f.store.db.query("SELECT count(*)::int AS n FROM libraries")).rows[0]
      .n,
    2,
  );
  assert.deepEqual(imports.cancel(preview.id), { cancelled: true });
});

test("oversized backups fail with BACKUP_TOO_LARGE and leave no file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rolltop-large-"));
  try {
    const backup: any = {
      toJSON() {
        throw new RangeError("Invalid string length");
      },
    };
    await assert.rejects(writeBookBackup(dir, backup), {
      code: "BACKUP_TOO_LARGE",
      status: 413,
    });
    await assert.rejects(
      writeBookBackup(join(dir, "missing"), { tables: {} } as any),
      (e: any) => e.code !== "BACKUP_TOO_LARGE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a size failure while wrapping the backup leaves no recovery file behind", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rolltop-wrap-"));
  try {
    const real = JSON.stringify;
    t.mock.method(JSON, "stringify", (...args: any[]) => {
      const v = args[0];
      if (v && typeof v === "object" && "sha256" in v && "payload" in v)
        throw new RangeError("Invalid string length");
      return (real as any)(...args);
    });
    await assert.rejects(writeBookBackup(dir, { tables: {} } as any), {
      code: "BACKUP_TOO_LARGE",
      status: 413,
    });
    t.mock.restoreAll();
    assert.deepEqual(await readdir(dir), []);
    // Unrelated RangeErrors are not mistaken for a size failure.
    const odd: any = {
      toJSON() {
        throw new RangeError("Invalid time value");
      },
    };
    await assert.rejects(
      writeBookBackup(dir, odd),
      (e: any) => e.code !== "BACKUP_TOO_LARGE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function loginServer(trustProxy?: number) {
  const f = await fixture(),
    origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-hardening"),
      trustProxy,
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  const attempt = (password: string, forwarded?: string) =>
    fetch(base + "/login", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(forwarded ? { "X-Forwarded-For": forwarded } : {}),
      },
      body: JSON.stringify({ password }),
    });
  return { server, attempt };
}

test("login throttle returns TRY_LATER/429 after the limit and ignores X-Forwarded-For by default", async () => {
  const { server, attempt } = await loginServer();
  try {
    for (let i = 0; i < 10; i++)
      assert.equal((await attempt("wrong", "10.0.0." + i)).status, 401);
    const blocked = await attempt("wrong", "10.9.9.9");
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, "TRY_LATER");
    // Even the right password from a "different" forwarded address is throttled.
    assert.equal((await attempt("scratch-hardening", "10.8.8.8")).status, 429);
  } finally {
    server.close();
  }
});

test("with STUDIO_TRUST_PROXY=1 the throttle keys on the proxy-appended client address", async () => {
  const { server, attempt } = await loginServer(1);
  try {
    // Spoofed leftmost values do not help: the rightmost entry is the key.
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await attempt("wrong", "1.1.1." + i + ", 203.0.113.5")).status,
        401,
      );
    assert.equal((await attempt("wrong", "2.2.2.2, 203.0.113.5")).status, 429);
    // Another real client is unaffected.
    assert.equal(
      (await attempt("scratch-hardening", "203.0.113.6")).status,
      200,
    );
  } finally {
    server.close();
  }
});

test("STUDIO_TRUST_PROXY must be a whole number from 0 to 10", async () => {
  const passwordHashValue = await passwordHash("scratch-hardening");
  for (const trustProxy of [-1, 1.5, NaN, 11, 100])
    assert.throws(
      () =>
        studioServer({} as any, {
          origin: "http://localhost:4317",
          passwordHash: passwordHashValue,
          trustProxy,
        }),
      /STUDIO_TRUST_PROXY/,
    );
});

test("a global failure ceiling blocks other clients once the window total is exceeded", async () => {
  const { server, attempt } = await loginServer(1);
  try {
    // 10 per-client failures from each of 10 distinct clients = 100 total.
    for (let c = 0; c < 10; c++)
      for (let i = 0; i < 10; i++)
        assert.equal((await attempt("wrong", "198.51.100." + c)).status, 401);
    const blocked = await attempt("scratch-hardening", "203.0.113.77");
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, "TRY_LATER");
  } finally {
    server.close();
  }
});

test("IPv6 clients in the same /64 share a throttle key; other prefixes do not", async () => {
  const { server, attempt } = await loginServer(1);
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await attempt("wrong", "2001:db8:1:2::" + (i + 1))).status,
        401,
      );
    assert.equal(
      (await attempt("wrong", "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status,
      429,
    );
    assert.equal(
      (await attempt("wrong", "2001:0db8:0001:0002::9")).status,
      429,
    );
    assert.equal((await attempt("wrong", "2001:db8:1:3::1")).status, 401);
  } finally {
    server.close();
  }
});

test("postgres transaction keeps the original error when ROLLBACK fails and discards the broken client", async (t) => {
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: [] };
    },
    release: (e?: unknown) => released.push(e),
  };
  t.mock.method(pg.Pool.prototype, "connect", async () => client as any);
  const db = postgres("postgres://scratch@127.0.0.1:1/none");
  try {
    await assert.rejects(
      db.transaction(async () => {
        throw new Error("original failure");
      }),
      /original failure/,
    );
    assert.equal(released.length, 1);
    assert.match(String(released[0]), /connection lost/);
  } finally {
    await db.close();
  }
});

// Pure-helper tests: the default trustProxy=0 path now runs the socket address
// through ipKey, and a loopback test server cannot produce arbitrary IPv6 peers.
test("ipKey groups IPv6 socket addresses by /64 and normalizes IPv4-in-IPv6 forms", () => {
  assert.equal(
    ipKey("2001:db8:1:2:aaaa::1"),
    ipKey("2001:DB8:0001:0002::ffff"),
  );
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
  assert.equal(ipKey("fe80::1%eth0"), ipKey("fe80::2"));
  for (const form of [
    "::ffff:1.2.3.4",
    "::ffff:0102:0304",
    "::1.2.3.4",
    "0:0:0:0:0:ffff:1.2.3.4",
    "[::FFFF:1.2.3.4]",
  ])
    assert.equal(ipKey(form), "1.2.3.4", form);
  assert.notEqual(ipKey("::ffff:1.2.3.4"), ipKey("::ffff:1.2.3.5"));
  assert.equal(ipKey("1.2.3.4"), "1.2.3.4");
  assert.equal(stripPort("1.2.3.4:5678"), "1.2.3.4");
  assert.equal(stripPort("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(stripPort("2001:db8::1"), "2001:db8::1");
  assert.equal(ipKey(stripPort("[2001:db8::1]:443")), ipKey("2001:db8::1"));
});

test("through the login path, mapped-IPv4 and port-suffixed forwarded entries share the plain IPv4 key", async () => {
  const { server, attempt } = await loginServer(1);
  try {
    const forms = [
      "203.0.113.9",
      "::ffff:203.0.113.9",
      "203.0.113.9:1111",
      "203.0.113.9:2222",
      "[::ffff:cb00:7109]:443",
      "::ffff:203.0.113.9",
      "203.0.113.9:3333",
      "::cb00:7109",
      "203.0.113.9:4444",
      "203.0.113.9:5555",
    ];
    for (const f of forms)
      assert.equal((await attempt("wrong", f)).status, 401);
    assert.equal((await attempt("wrong", "203.0.113.9:6666")).status, 429);
  } finally {
    server.close();
  }
});

import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { Store } from "@writers-rolltop/store";
import { buildApp } from "./app.ts";
import type { LibraryRoutes } from "./app.ts";
import { installShutdown } from "./shutdown.ts";
import { sweepLeftovers } from "./sweep.ts";
import { bindRefusal, cookieRefusal, cookieSecureSetting } from "./bind.ts";
import { Auth } from "./auth.ts";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

// Library routes need a database. Without DATABASE_URL only the health route is served.
let library: LibraryRoutes | undefined;
const databaseUrl = process.env.DATABASE_URL;
// All start-up refusals come first, before the database is opened: a bad setting must not exit after migrations ran.
const cookieSetting = cookieSecureSetting(process.env.ROLLTOP_COOKIE_SECURE);
const secure = "secure" in cookieSetting ? cookieSetting.secure : true;
const refusal = ("refusal" in cookieSetting ? cookieSetting.refusal : undefined)
  ?? cookieRefusal(host, secure, Boolean(databaseUrl), process.env.ROLLTOP_INSECURE_BIND)
  ?? bindRefusal(host, Boolean(databaseUrl), process.env.ROLLTOP_INSECURE_BIND);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
if (databaseUrl) {
  const dataDir = resolve(process.env.ROLLTOP_DATA_DIR ?? "./data");
  const attachmentsDir = join(dataDir, "attachments");
  const exportsDir = join(dataDir, "exports");
  const backupDir = join(dataDir, "backups");
  for (const dir of [attachmentsDir, exportsDir, backupDir]) await mkdir(dir, { recursive: true, mode: 0o700 });
  // Store.open migrates (after a backup) and refuses a database that is ahead of this build.
  const store = await Store.open({ url: databaseUrl, attachmentsDir, backupDir });
  const swept = await sweepLeftovers({ attachmentsDir, exportsDir, dataDir });
  console.error(JSON.stringify({ code: "STARTUP_SWEEP", message: "removed leftovers", ...swept }));
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  // Owner account and sessions. With no owner yet, print a one-time setup token, once, to stderr only. It is not
  // passed to any logger, and only its hash is kept.
  const auth = new Auth({ pool: store.pool, cookieSecure: secure, log: (e) => console.error(JSON.stringify(e)) });
  const setup = await auth.prepareSetup();
  if (setup) {
    console.error(JSON.stringify({ code: "SETUP_TOKEN", message: `First-run setup token (shown once, valid until ${setup.expiresAt.toISOString()}): ${setup.token}` }));
  }
  library = {
    store, auth, exportsDir,
    maxImportBytes: num("ROLLTOP_MAX_IMPORT_BYTES", 512 * 1024 ** 2),
    import: {
      databaseUrl, attachmentsDir,
      timeoutMs: num("ROLLTOP_IMPORT_TIMEOUT_MS", 120_000),
      maxHeapMb: num("ROLLTOP_IMPORT_MAX_HEAP_MB", 1024),
    },
  };
}

const allowedHosts = (process.env.ROLLTOP_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
const app = buildApp({ ...(library ? { library } : {}), allowedHosts });
if (library) app.addHook("onClose", async () => { await library.store.close(); });
await app.listen({ port, host });
installShutdown(app);

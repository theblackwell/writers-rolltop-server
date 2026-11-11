import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { StoreError } from "./errors.ts";

export interface Migration {
  /** File name without `.sql`, e.g. `0001-initial`. */
  id: string;
  sql: string;
}

export interface MigrateOptions {
  /** Connection URL of the library database. */
  url: string;
  /** Directory for the pre-migration dump. Required once a database has applied migrations. */
  backupDir: string;
  /** pg_dump executable. Default `pg_dump`. */
  pgDump?: string;
  /** Migrations to apply. Default: the files bundled in `migrations/`. */
  migrations?: readonly Migration[];
  /** Clock for backup file names. */
  now?: () => Date;
}

export interface MigrateResult {
  applied: string[];
  backupFile?: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const FILE_PATTERN = /^(\d{4})-[a-z0-9][a-z0-9-]*\.sql$/;
/** Serialises concurrent migrators on one database. */
const ADVISORY_LOCK_KEY = 5_203_141_001;

export const checksum = (sql: string): string => createHash("sha256").update(sql, "utf8").digest("hex");

const TX_FIRST_WORDS = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT"]);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** True if a statement beginning with these words (upper-cased) is transaction control. */
const isTransactionControl = (w: string[]): boolean =>
  TX_FIRST_WORDS.has(w[0] ?? "") || ((w[0] === "START" || w[0] === "PREPARE") && w[1] === "TRANSACTION");

/**
 * The runner owns the transaction. A left-to-right scan skips comments (nested block comments too), string
 * literals ('' and, for E'...', backslash escapes), quoted identifiers and dollar-quoted bodies (so plpgsql
 * BEGIN/END is fine), splits on `;`, and checks the first keyword(s) of each statement.
 */
export function assertNoTransactionControl(m: Migration): void {
  const sql = m.sql;
  let words: string[] = [];
  const skipped = () => { if (words.length < 2) words.push("?"); };
  const finish = () => {
    if (isTransactionControl(words)) {
      throw new StoreError("MIGRATION_FAILED", `migration ${m.id} contains transaction control (BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK, ABORT or PREPARE TRANSACTION); the runner wraps each migration in a transaction`, { id: m.id });
    }
    words = [];
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
    } else if (c === "'") {
      const escapes = /^[eE]$/.test(sql[i - 1] ?? "") && !isWordChar(sql[i - 2]);
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; }
        else i++;
      }
      // An E prefix already counted as a word: drop it so the literal is the statement's first token.
      if (escapes && words.length > 0 && words[words.length - 1] === "E") words.pop();
      skipped();
    } else if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') { i++; break; }
        else i++;
      }
      skipped();
    } else if (c === "$" && !isWordChar(sql[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        skipped();
      } else i++;
    } else if (c === ";") {
      finish();
      i++;
    } else if (isWordChar(c)) {
      let j = i;
      while (isWordChar(sql[j])) j++;
      if (words.length < 2) words.push(sql.slice(i, j).toUpperCase());
      i = j;
    } else i++;
  }
  finish();
}

/** Load the bundled migrations, sorted by name. Names must be `NNNN-name.sql` with unique numbers. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const seen = new Set<string>();
  const out: Migration[] = [];
  for (const name of names) {
    const m = FILE_PATTERN.exec(name);
    if (!m) throw new Error(`migration file name must be NNNN-name.sql: ${name}`);
    if (seen.has(m[1]!)) throw new Error(`duplicate migration number ${m[1]}`);
    seen.add(m[1]!);
    const migration = { id: name.slice(0, -".sql".length), sql: await readFile(join(dir, name), "utf8") };
    assertNoTransactionControl(migration);
    out.push(migration);
  }
  return out;
}

/** Split the password out of a URL so it travels in PGPASSWORD, never in argv or logs. */
function splitPassword(url: string): { url: string; password?: string; database: string } {
  const u = new URL(url);
  let password = u.password === "" ? undefined : decodeURIComponent(u.password);
  u.password = "";
  const queryPassword = u.searchParams.get("password");
  if (queryPassword !== null) {
    password ??= queryPassword;
    u.searchParams.delete("password");
  }
  return { url: u.toString(), password, database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
}

function runPgDump(pgDump: string, args: string[], password: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (password !== undefined) env.PGPASSWORD = password;
    const child = spawn(pgDump, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
    child.on("error", (e) => reject(new Error(`could not run pg_dump: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${stderr.trim()}`))));
  });
}

async function backup(options: MigrateOptions, firstPending: string, now: Date): Promise<string> {
  const { url, password, database } = splitPassword(options.url);
  const safeDb = database.replace(/[^A-Za-z0-9_.-]/g, "_") || "db";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = join(options.backupDir, `${safeDb}-${stamp}-before-${firstPending}.dump`);
  let created = false; // only a file this call created may be removed
  try {
    await mkdir(options.backupDir, { recursive: true, mode: 0o700 });
    await chmod(options.backupDir, 0o700); // also when the directory already existed
    await (await open(file, "wx", 0o600)).close(); // private from the first byte; pg_dump truncates and fills it
    created = true;
    await runPgDump(options.pgDump ?? "pg_dump", ["--format=custom", "--file", file, "--dbname", url], password);
    await chmod(file, 0o600);
    if ((await stat(file)).size <= 0) throw new Error("backup file is empty");
  } catch (e) {
    if (created) await rm(file, { force: true }).catch(() => {});
    throw new StoreError("BACKUP_FAILED", `could not back up before migrating: ${(e as Error).message}`, { firstPending });
  }
  return file;
}

/**
 * Apply pending migrations, forward only. Refuses a database that is ahead of this build, whose applied
 * files were edited, or whose history is not a prefix of the known list. Backs up first when the database
 * already has applied migrations. Each migration and its bookkeeping row commit together.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const known = options.migrations ?? (await loadMigrations());
  known.forEach(assertNoTransactionControl);
  const client = new pg.Client({ connectionString: options.url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM schema_migrations ORDER BY id",
    );
    const byId = new Map(known.map((m) => [m.id, m]));
    for (const r of rows) {
      if (!byId.has(r.id)) {
        throw new StoreError("SCHEMA_TOO_NEW", "this library was created by a newer version of Writers Rolltop; update to open it", { id: r.id });
      }
    }
    for (const r of rows) {
      if (checksum(byId.get(r.id)!.sql) !== r.checksum) {
        throw new StoreError("MIGRATION_CHECKSUM_MISMATCH", `applied migration ${r.id} has been edited`, { id: r.id });
      }
    }
    rows.forEach((r, i) => {
      if (known[i]?.id !== r.id) {
        throw new StoreError("MIGRATION_HISTORY_MISMATCH", "applied migrations are not a prefix of the known migrations", { id: r.id });
      }
    });
    const pending = known.slice(rows.length);
    if (pending.length === 0) return { applied: [] };

    let backupFile: string | undefined;
    if (rows.length > 0) backupFile = await backup(options, pending[0]!.id, (options.now ?? (() => new Date()))());

    const applied: string[] = [];
    for (const m of pending) {
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [m.id, checksum(m.sql)]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw new StoreError("MIGRATION_FAILED", `migration ${m.id} failed and was rolled back: ${(e as Error).message}`, { id: m.id });
      }
      applied.push(m.id);
    }
    return { applied, backupFile };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}


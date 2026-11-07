// SPDX-License-Identifier: AGPL-3.0-only
import pg from "pg";
import type { Database, Query } from "./store.ts";
export function postgres(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    // Bound waits on row locks and runaway statements (values in milliseconds).
    lock_timeout: 10000,
    statement_timeout: 120000,
  });
  // An idle client can fail (server restart); without a handler Node would crash.
  // Log the error code only, never SQL, parameters or connection details.
  pool.on("error", (e: any) =>
    console.error("Database pool error:", e?.code ?? "unknown"),
  );
  const database: Database = {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const result = await fn((sql, params) => client.query(sql, params));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        // A failed ROLLBACK (dead connection) must not replace the original error.
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          broken = rollbackError as Error;
        }
        throw e;
      } finally {
        // Passing an error makes the pool discard the client instead of reusing it.
        client.release(broken);
      }
    },
  };
  return { ...database, close: () => pool.end() };
}

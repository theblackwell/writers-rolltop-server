// SPDX-License-Identifier: AGPL-3.0-only
import pg from "pg";
import type { Database, Query } from "./store.ts";
export function postgres(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
  const database: Database = {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn((sql, params) => client.query(sql, params));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
  return { ...database, close: () => pool.end() };
}

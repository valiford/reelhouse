// pg adapter for the catalog SyncExecutor.
//
// Lives apart from sync.ts so the sync logic stays database-library-agnostic
// (tests can drive it with in-process doubles). withTransaction pins a single
// pooled client for BEGIN … COMMIT so batch statements never interleave
// across pool connections; a failing batch rolls back and the original error
// always wins over rollback noise.

import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { SyncExecutor } from "./sync.ts";

export function createPgSyncExecutor(pool: Pool): SyncExecutor {
  return {
    query: async <R extends QueryResultRow>(text: string, params?: unknown[]) => {
      const result = await pool.query<R>(text, params);
      return { rows: result.rows };
    },
    withTransaction: async <R>(fn: (tx: SyncExecutor) => Promise<R>) => {
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("BEGIN");
        const value = await fn(clientExecutor(client));
        await client.query("COMMIT");
        committed = true;
        return value;
      } finally {
        if (!committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* connection already unusable; the original error propagates */
          }
        }
        client.release();
      }
    }
  };
}

function clientExecutor(client: PoolClient): SyncExecutor {
  return {
    query: async <R extends QueryResultRow>(text: string, params?: unknown[]) => {
      const result = await client.query<R>(text, params);
      return { rows: result.rows };
    },
    // Nested transactions are not needed by the sync; reject them loudly
    // rather than silently issuing a savepoint-less BEGIN inside one.
    withTransaction: () => {
      return Promise.reject(new Error("nested transactions are not supported"));
    }
  };
}

// Server-only bridge from the application pool to the read models.
//
// The read-model modules stay I/O-free so hermetic tests can drive them
// with doubles; this adapter is the one place that hands them the real
// pg pool. `server-only` keeps the import graph honest: anything that pulls
// this into a Client Component fails the build, so DATABASE_URL's
// credentials can never reach the browser bundle.
import "server-only";
import { query } from "@/lib/db/pool";
import type { QueryResultRow } from "pg";
import type { ReadExecutor } from "./items";

export const readExecutor: ReadExecutor = {
  query: async <R extends QueryResultRow>(text: string, params?: unknown[]) => {
    const result = await query<R>(text, params);
    return { rows: result.rows };
  }
};

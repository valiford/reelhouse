// Read-model executor: the read side of the database boundary.
//
// Structurally the query half of the catalog SyncExecutor / household
// HouseholdExecutor, kept as its own minimal interface so the read models
// depend on nothing but "can run a parameterized query". Read models never
// write and never open transactions; the pg adapter exists so API routes can
// hand in the shared pool while tests drive in-process doubles.

import type { Pool, QueryResultRow } from "pg";

export interface ReadExecutor {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export function createPgReadExecutor(pool: Pool): ReadExecutor {
  return {
    query: async <R extends QueryResultRow>(text: string, params?: unknown[]) => {
      const result = await pool.query<R>(text, params);
      return { rows: result.rows };
    }
  };
}

// Numbered-placeholder builder. Every read-model query grows its parameter
// array through param() so the $n index and the value position can never
// drift apart — the same failure class the write paths avoid by building
// parameter arrays from field lists.
export class SqlBuilder {
  readonly values: unknown[] = [];

  param(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

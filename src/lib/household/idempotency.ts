// Idempotent mutation execution (RH-0018).
//
// Contract: a mutating API call carrying an `Idempotency-Key` header commits
// ONE row in `idempotency_record` (scope, key, fingerprint, response) in the
// SAME transaction as the mutation itself. Therefore:
// - a crash can never leave a "done" marker without its mutation, or
//   vice versa (both roll back together);
// - a replay with the same key AND a matching fingerprint returns the
//   ORIGINAL response byte-for-byte (status + body, plus an
//   `Idempotency-Replayed: true` header);
// - the same key with a DIFFERENT fingerprint is a client bug: 409
//   `idempotency_key_reuse`, never a silent replay of the wrong operation.
//
// Without a key the mutation still runs in one transaction and relies on the
// natural idempotency of the schema (unique keys, tolerant creates) — the
// record is an optional guarantee, not a prerequisite.
//
// Scope strings separate unrelated operations that could otherwise collide
// on a client-generated key; fingerprints hash the NORMALIZED request so
// formatting differences cannot fork a key but semantic ones always do.

import type { Pool } from "pg";
import { HouseholdError } from "./errors.ts";
import type { QueryExecutor } from "./store.ts";
import { withTransaction } from "./store.ts";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAY_HEADER = "Idempotency-Replayed";

export interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface MutationResult extends StoredResponse {
  replayed: boolean;
}

interface ClaimRow {
  fingerprint: string | null;
  response_status: number | null;
  response_body: unknown;
}

// Commits `apply` either directly (no key) or under idempotency protection.
// `apply` receives an in-transaction executor and MUST only touch the
// database through it.
export async function runIdempotentMutation(
  pool: Pool,
  args: {
    scope: string;
    key?: string;
    fingerprint: string;
    apply: (db: QueryExecutor) => Promise<StoredResponse>;
  }
): Promise<MutationResult> {
  if (args.key === undefined) {
    const stored = await withTransaction(pool, args.apply);
    return { ...stored, replayed: false };
  }
  return withTransaction(pool, async (db) => {
    const claim = await db.query<{ id: string }>(
      `INSERT INTO idempotency_record (scope, idempotency_key, fingerprint)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope, idempotency_key) DO NOTHING
       RETURNING id`,
      [args.scope, args.key, args.fingerprint]
    );

    if (claim.rowCount === 1) {
      const stored = await args.apply(db);
      // Bounded response storage: only success responses are stored, and the
      // 0010 CHECK keeps them under 8 KiB of JSON — replay bodies are single
      // resources, never collections.
      if (stored.status < 200 || stored.status > 299) {
        throw new HouseholdError("idempotency_state_invalid", "Only success responses can be idempotently stored");
      }
      await db.query(
        "UPDATE idempotency_record SET response_status = $1, response_body = $2::jsonb WHERE id = $3",
        [stored.status, JSON.stringify(stored.body), claim.rows[0].id]
      );
      return { ...stored, replayed: false };
    }

    const existing = await db.query<ClaimRow>(
      "SELECT fingerprint, response_status, response_body FROM idempotency_record WHERE scope = $1 AND idempotency_key = $2",
      [args.scope, args.key]
    );
    const row = existing.rows[0];
    if (row.fingerprint !== args.fingerprint) {
      throw new HouseholdError(
        "idempotency_key_reuse",
        "This Idempotency-Key was already used for a different request",
        `scope=${args.scope}`
      );
    }
    if (
      row.response_status === null ||
      row.response_body === null ||
      typeof row.response_body !== "object"
    ) {
      // Unreachable through the API: the record and its response commit
      // atomically. Fail closed rather than re-executing on ambiguous state.
      throw new HouseholdError("idempotency_state_invalid", "Idempotency record is missing its stored response");
    }
    return {
      status: row.response_status,
      body: row.response_body as Record<string, unknown>,
      replayed: true
    };
  });
}

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
// - the same key with a DIFFERENT fingerprint is a client bug: a conflict
//   (409), never a silent replay of the wrong operation. Detection reuses
//   RH-0017's claimIdempotencyKey(), which throws HouseholdConflictError.
//
// Without a key the mutation still runs in one transaction and relies on the
// natural idempotency of the schema (unique keys, tolerant creates) — the
// record is an optional guarantee, not a prerequisite.
//
// Scopes separate unrelated operations that could otherwise collide on a
// client-generated key; fingerprints hash the NORMALIZED request so
// formatting differences cannot fork a key but semantic ones always do.
//
// Note for API consumers: RH-0017's watch-progress endpoint uses the same
// idempotency_record table with its own documented body-flag replay shape;
// this stored-response pattern is the canonical one for the RH-0018
// list/home-row endpoints.

import type { Pool } from "pg";
import { claimIdempotencyKey } from "./store.ts";
import type { SqlRunner } from "./store.ts";
import { transact } from "./store.ts";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAY_HEADER = "Idempotency-Replayed";

export interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface MutationResult extends StoredResponse {
  replayed: boolean;
}

// Commits `apply` either directly (no key) or under idempotency protection.
// `apply` receives an in-transaction runner and MUST only touch the
// database through it.
export async function runIdempotentMutation(
  pool: Pool,
  args: {
    scope: string;
    key?: string;
    fingerprint: string;
    apply: (runner: SqlRunner) => Promise<StoredResponse>;
  }
): Promise<MutationResult> {
  const key = args.key;
  if (key === undefined) {
    const stored = await transact(pool, args.apply);
    return { ...stored, replayed: false };
  }
  return transact(pool, async (runner) => {
    const claim = await claimIdempotencyKey(runner, args.scope, key, args.fingerprint);

    if (claim === "claimed") {
      const stored = await args.apply(runner);
      // Bounded response storage: only success responses are stored, and the
      // 0010 CHECK keeps them under 8 KiB of JSON — replay bodies are single
      // resources, never collections.
      if (stored.status < 200 || stored.status > 299) {
        throw new Error("only success responses can be idempotently stored");
      }
      await runner.query(
        "UPDATE idempotency_record SET response_status = $1, response_body = $2::jsonb WHERE scope = $3 AND idempotency_key = $4",
        [stored.status, JSON.stringify(stored.body), args.scope, key]
      );
      return { ...stored, replayed: false };
    }

    const stored = await runner.query<{ response_status: number; response_body: unknown }>(
      "SELECT response_status, response_body FROM idempotency_record WHERE scope = $1 AND idempotency_key = $2",
      [args.scope, args.key]
    );
    const row = stored.rows[0];
    if (
      !row ||
      row.response_status === null ||
      row.response_body === null ||
      typeof row.response_body !== "object"
    ) {
      // Unreachable through the API: the record and its response commit
      // atomically. Fail closed rather than re-executing on ambiguous state;
      // api.ts reports it as a bounded 500 with the detail only in the log.
      throw new Error("idempotency record is missing its stored response (ambiguous state)");
    }
    return {
      status: row.response_status,
      body: row.response_body as Record<string, unknown>,
      replayed: true
    };
  });
}

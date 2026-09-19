// Route plumbing shared by the household API routes (RH-0018).
//
// Server-side only by usage: every import chain reaches pool.ts, whose
// `server-only` marker keeps this out of the browser bundle. Handlers are
// wrapped so that ANY escape maps to a bounded, redacted error response
// (HouseholdError keeps its code; anything else is 503 with a generic
// message and the concrete error logged server-side only).

import { NextResponse, type NextRequest } from "next/server";
import type { Pool } from "pg";
import { redactError } from "../db/config.ts";
import { isHouseholdError, toHouseholdErrorResponse } from "./errors.ts";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAY_HEADER, runIdempotentMutation } from "./idempotency.ts";
import { parseIdempotencyKey, parseJsonObject } from "./model.ts";

const LOG_DETAIL_CAP = 2000;

export function householdHandler<Context>(
  handler: (request: NextRequest, context: Context) => Promise<NextResponse>
): (request: NextRequest, context: Context) => Promise<NextResponse> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (!isHouseholdError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("ReelHouse household API error:", redactError(message, process.env.DATABASE_URL).slice(0, LOG_DETAIL_CAP));
      }
      const { status, body } = toHouseholdErrorResponse(error);
      return NextResponse.json(body, { status });
    }
  };
}

export function readIdempotencyKey(request: NextRequest): string | undefined {
  return parseIdempotencyKey(request.headers.get(IDEMPOTENCY_KEY_HEADER));
}

export async function parseJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  return parseJsonObject(await request.text());
}

// Runs one idempotent mutation against the pool and renders its response,
// adding `Idempotency-Replayed: true` when a stored response is served.
export async function runMutation(
  pool: Pool,
  args: Parameters<typeof runIdempotentMutation>[1]
): Promise<NextResponse> {
  const result = await runIdempotentMutation(pool, args);
  const headers = result.replayed ? { [IDEMPOTENCY_REPLAY_HEADER]: "true" } : undefined;
  return NextResponse.json(result.body, { status: result.status, headers });
}

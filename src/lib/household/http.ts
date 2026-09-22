// Route plumbing shared by the household API routes (RH-0027).
//
// Server-side only by usage: every import chain reaches pool.ts, whose
// `server-only` marker keeps this out of the browser bundle. Handlers are
// wrapped so that ANY escape funnels through the single error exit
// (householdErrorResponse): typed store errors map to their category,
// PostgreSQL violations classify through classifyPgError(), and anything
// else fails closed with a redacted, truncated log-only message.

import { NextResponse, type NextRequest } from "next/server";
import type { Pool } from "pg";
import { householdErrorResponse, readBoundedJson } from "./api.ts";
import { HouseholdInputError } from "./errors.ts";
import type { SqlRunner } from "./store.ts";
import { transact } from "./store.ts";

export function householdHandler<Context>(
  handler: (request: NextRequest, context: Context) => Promise<NextResponse>
): (request: NextRequest, context: Context) => Promise<NextResponse> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return householdErrorResponse(error);
    }
  };
}

// Bounded body read (hard cap) plus the object-shape requirement every
// household payload has.
export async function parseJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  const parsed = await readBoundedJson(request);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HouseholdInputError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// Runs one mutation atomically and renders its result. Multi-step writes
// (resolve the media ref, then insert) must go through this so a failure
// can never commit half a change.
export async function runWrite(
  pool: Pool,
  apply: (db: SqlRunner) => Promise<{ status: number; body: Record<string, unknown> }>
): Promise<NextResponse> {
  const stored = await transact(pool, apply);
  return NextResponse.json(stored.body, { status: stored.status });
}

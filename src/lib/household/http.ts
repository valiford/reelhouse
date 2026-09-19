// Route plumbing shared by the RH-0018 household list/home-row API routes.
//
// Server-side only by usage: every import chain reaches pool.ts, whose
// `server-only` marker keeps this out of the browser bundle. Handlers are
// wrapped so that ANY escape funnels through RH-0017's single error exit
// (householdErrorResponse): typed store errors map to their category,
// PostgreSQL violations classify through classifyPgError(), and anything
// else fails closed with a redacted, truncated log-only message.

import { NextResponse, type NextRequest } from "next/server";
import type { Pool } from "pg";
import { householdErrorResponse, readBoundedJson } from "./api.ts";
import { HouseholdInputError } from "./errors.ts";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAY_HEADER, runIdempotentMutation } from "./idempotency.ts";
import { parseIdempotencyKey } from "./model.ts";

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

export function readIdempotencyKey(request: NextRequest): string | undefined {
  return parseIdempotencyKey(request.headers.get(IDEMPOTENCY_KEY_HEADER));
}

// Bounded body read (RH-0017's hard cap) plus the object-shape requirement
// every RH-0018 payload has.
export async function parseJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  const parsed = await readBoundedJson(request);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HouseholdInputError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
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

// HTTP glue for the household persistence routes (RH-0017).
//
// Every route handler funnels its errors through householdErrorResponse() so
// the response contract is identical everywhere: typed store errors map to
// their category, PostgreSQL violations map through classifyPgError(), and
// anything else fails closed with a redacted, truncated message. Request
// bodies are read through readBoundedJson() so one oversized payload can
// never balloon the server process.

import { NextResponse } from "next/server";
import { redactError } from "@/lib/db/config";
import { JellyfinUnavailableError } from "./reconcile.ts";
import {
  HouseholdConflictError,
  HouseholdInputError,
  HouseholdNotFoundError,
  classifyPgError,
  describePgErrorKind
} from "./errors.ts";

export const REQUEST_BODY_MAX_BYTES = 65_536;

const ERROR_MESSAGE_MAX_CHARS = 300;

function truncate(text: string): string {
  return text.length <= ERROR_MESSAGE_MAX_CHARS ? text : `${text.slice(0, ERROR_MESSAGE_MAX_CHARS)}…`;
}

// Reads and parses a JSON request body under a hard size cap. Returns a
// plain value; malformed JSON and oversize bodies raise HouseholdInputError
// with value-free messages.
export async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > REQUEST_BODY_MAX_BYTES) {
    throw new HouseholdInputError("request body exceeds the supported size");
  }
  const raw = await request.text();
  if (raw.length > REQUEST_BODY_MAX_BYTES) {
    throw new HouseholdInputError("request body exceeds the supported size");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HouseholdInputError("request body must be valid JSON");
  }
}

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

// The single error exit. Everything echoed here is bounded and value-free;
// the raw URL (if a driver message ever embedded it) is scrubbed first.
export function householdErrorResponse(error: unknown): NextResponse {
  if (error instanceof HouseholdInputError) {
    return errorResponse(400, "invalid_request", truncate(error.message));
  }
  if (error instanceof HouseholdNotFoundError) {
    return errorResponse(404, "not_found", truncate(error.message));
  }
  if (error instanceof HouseholdConflictError) {
    return errorResponse(409, "conflict", truncate(error.message));
  }
  // Jellyfin is unreachable/unconfigured for a reconciliation (RH-0022):
  // availability, reported as 503 — never demo data, never a 500.
  if (error instanceof JellyfinUnavailableError) {
    return errorResponse(503, "jellyfin_unavailable", truncate(error.message));
  }

  const classification = classifyPgError(error);
  if (classification) {
    if (classification.kind === "missing-reference") {
      return errorResponse(404, "not_found", describePgErrorKind(classification));
    }
    if (classification.kind === "input") {
      return errorResponse(400, "invalid_request", describePgErrorKind(classification));
    }
    if (classification.kind === "conflict") {
      return errorResponse(409, "conflict", describePgErrorKind(classification));
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const redacted = truncate(redactError(message, process.env.DATABASE_URL));

  // The household endpoints have no demo fallback: an unconfigured or
  // rejected database is a 503, never degraded data (fails closed).
  if (
    message.startsWith("Database is not configured") ||
    message.startsWith("Database configuration is invalid")
  ) {
    return errorResponse(503, "database_unavailable", "household persistence is unavailable (database is not configured or was rejected)");
  }
  console.error("household api error:", redacted);
  return errorResponse(500, "internal_error", "household persistence failed (see server log)");
}

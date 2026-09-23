// Shared error-mapping for the database-backed read-model API routes.
//
// The contract (mirrors /api/health's philosophy, tightened for data
// endpoints): a malformed request is 400, an unknown identity is 404, a
// database that is unconfigured/invalid/unreachable is 503 with a state
// reason — never a leaked URL or credential, every echoed message is run
// through redactError. Successful payloads are whatever the read model
// returned, serialized once.

import "server-only";
import { NextResponse } from "next/server";
import { redactError } from "@/lib/db/config";
import { getPool } from "@/lib/db/pool";
import { createPgReadExecutor, type ReadExecutor } from "./executor";
import { ReadModelParamError } from "./params";
import { CatalogItemNotFoundError } from "./search";
import { HouseholdProfileNotFoundError } from "./home";

export function databaseSecret(): string {
  return process.env.DATABASE_URL?.trim() ?? "";
}

export async function readModelResponse<T>(
  render: (executor: ReadExecutor) => Promise<T>
): Promise<NextResponse> {
  let payload: T;
  try {
    payload = await render(createPgReadExecutor(getPool()));
  } catch (error) {
    if (error instanceof ReadModelParamError) {
      return NextResponse.json({ error: "invalid_request", detail: error.message }, { status: 400 });
    }
    if (error instanceof CatalogItemNotFoundError || error instanceof HouseholdProfileNotFoundError) {
      return NextResponse.json({ error: "not_found", detail: error.message }, { status: 404 });
    }
    const message = redactError(error instanceof Error ? error.message : String(error), databaseSecret());
    return NextResponse.json(
      { error: "database_unavailable", detail: message.slice(0, 300) },
      { status: 503 }
    );
  }
  return NextResponse.json(payload);
}

// Collects query parameters, accepting both a single value and repeated
// values; missing keys yield undefined so the params module applies defaults.
// An empty value ("?profile=") is dropped entirely — a blank knob means
// "absent", and everything downstream fails closed on genuinely required
// identifiers.
export function searchParamsToObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key).filter((value) => value !== "");
    if (!values.length) continue;
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdErrorResponse, readBoundedJson } from "@/lib/household/api";
import { createProfile, listProfiles } from "@/lib/household/store.ts";
import {
  HOUSEHOLD_LIMITS,
  parseBooleanQuery,
  parseDisplayName,
  parseLimit,
  parsePreferences
} from "@/lib/household/validate.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(
      url.searchParams.get("limit"),
      HOUSEHOLD_LIMITS.profilesListDefault,
      HOUSEHOLD_LIMITS.profilesListMax
    );
    if (!limit.ok) {
      return NextResponse.json({ error: { code: "invalid_request", message: limit.errors.join("; ") } }, { status: 400 });
    }
    const profiles = await listProfiles(getPool(), {
      includeInactive: parseBooleanQuery(url.searchParams.get("includeInactive")),
      limit: limit.value
    });
    return NextResponse.json({ profiles, count: profiles.length });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "request body must be a JSON object" } },
        { status: 400 }
      );
    }
    const record = body as Record<string, unknown>;
    const displayName = parseDisplayName(record.displayName);
    if (!displayName.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: displayName.errors.join("; ") } },
        { status: 400 }
      );
    }
    let preferences: Record<string, unknown> | undefined;
    if (record.preferences !== undefined) {
      const parsed = parsePreferences(record.preferences);
      if (!parsed.ok) {
        return NextResponse.json(
          { error: { code: "invalid_request", message: parsed.errors.join("; ") } },
          { status: 400 }
        );
      }
      preferences = parsed.value;
    }
    const profile = await createProfile(getPool(), {
      displayName: displayName.value,
      preferences
    });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

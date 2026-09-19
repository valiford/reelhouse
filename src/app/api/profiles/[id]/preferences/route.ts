import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdErrorResponse, readBoundedJson } from "@/lib/household/api";
import { getProfile, replacePreferences } from "@/lib/household/store.ts";
import { parsePreferences, parseUuid } from "@/lib/household/validate.ts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profileId = parseUuid(id, "profile id");
    if (!profileId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: profileId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const profile = await getProfile(getPool(), profileId.value);
    if (!profile) {
      return NextResponse.json({ error: { code: "not_found", message: "profile not found" } }, { status: 404 });
    }
    return NextResponse.json({ preferences: profile.preferences });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

// PUT is a full replacement: the stored object becomes exactly the request
// body. Partial updates read-modify-write through GET; no merge semantics to
// guess at.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profileId = parseUuid(id, "profile id");
    if (!profileId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: profileId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const preferences = parsePreferences(await readBoundedJson(request));
    if (!preferences.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: preferences.errors.join("; ") } },
        { status: 400 }
      );
    }
    const profile = await replacePreferences(getPool(), profileId.value, preferences.value);
    if (!profile) {
      return NextResponse.json({ error: { code: "not_found", message: "profile not found" } }, { status: 404 });
    }
    return NextResponse.json({ preferences: profile.preferences });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

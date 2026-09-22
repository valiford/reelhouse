import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdErrorResponse, readBoundedJson } from "@/lib/household/api";
import { deleteProfile, getProfile, updateProfile } from "@/lib/household/store";
import { parseProfilePatch, parseUuid } from "@/lib/household/validate";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
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
    return NextResponse.json({ profile });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profileId = parseUuid(id, "profile id");
    if (!profileId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: profileId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const patch = parseProfilePatch(await readBoundedJson(request));
    if (!patch.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: patch.errors.join("; ") } },
        { status: 400 }
      );
    }
    const profile = await updateProfile(getPool(), profileId.value, patch.value);
    if (!profile) {
      return NextResponse.json({ error: { code: "not_found", message: "profile not found" } }, { status: 404 });
    }
    return NextResponse.json({ profile });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

// Deletion cascades to this profile's preferences, favorites, watchlists,
// watch state, playback history, and Jellyfin link — ReelHouse-owned
// household state only; no Jellyfin data and no media_catalog rows are
// touched. Curated collections survive: their creator column is provenance
// (ON DELETE SET NULL), not ownership.
export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profileId = parseUuid(id, "profile id");
    if (!profileId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: profileId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const deleted = await deleteProfile(getPool(), profileId.value);
    if (!deleted) {
      return NextResponse.json({ error: { code: "not_found", message: "profile not found" } }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

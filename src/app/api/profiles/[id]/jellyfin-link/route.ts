import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdErrorResponse, readBoundedJson } from "@/lib/household/api";
import { HouseholdNotFoundError } from "@/lib/household/errors";
import {
  deleteJellyfinLink,
  getJellyfinLink,
  getProfile,
  putJellyfinLink,
  transact
} from "@/lib/household/store";
import { parseJellyfinUserId, parseUuid } from "@/lib/household/validate";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// The 1:1 Jellyfin account link for a profile. Jellyfin user ids are data
// here, never credentials: no tokens are stored, ever.
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
    const runner = getPool();
    const profile = await getProfile(runner, profileId.value);
    if (!profile) {
      return NextResponse.json({ error: { code: "not_found", message: "profile not found" } }, { status: 404 });
    }
    const link = await getJellyfinLink(runner, profileId.value);
    return NextResponse.json({ link });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profileId = parseUuid(id, "profile id");
    if (!profileId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: profileId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const body = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "request body must be a JSON object" } },
        { status: 400 }
      );
    }
    const jellyfinUserId = parseJellyfinUserId((body as Record<string, unknown>).jellyfinUserId);
    if (!jellyfinUserId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: jellyfinUserId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const link = await transact(getPool(), async (tx) => {
      const profile = await getProfile(tx, profileId.value);
      if (!profile) {
        throw new HouseholdNotFoundError("profile not found");
      }
      return putJellyfinLink(tx, profileId.value, jellyfinUserId.value);
    });
    return NextResponse.json({ link });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

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
    const deleted = await transact(getPool(), async (tx) => {
      const profile = await getProfile(tx, profileId.value);
      if (!profile) {
        throw new HouseholdNotFoundError("profile not found");
      }
      return deleteJellyfinLink(tx, profileId.value);
    });
    if (!deleted) {
      return NextResponse.json({ error: { code: "not_found", message: "no jellyfin link for this profile" } }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

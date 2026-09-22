import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, runWrite } from "@/lib/household/http";
import { requireProfile, createWatchlist, listWatchlists } from "@/lib/household/lists";
import { parseName, parseUuid, requireFields } from "@/lib/household/model";

export const dynamic = "force-dynamic";

// GET /api/watchlists?profileId= — the profile's lists, oldest first.
export const GET = householdHandler(async (request: NextRequest) => {
  const profileId = parseUuid(request.nextUrl.searchParams.get("profileId"), "profileId");
  const pool = getPool();
  await requireProfile(pool, profileId);
  const watchlists = await listWatchlists(pool, profileId);
  return NextResponse.json({ watchlists, count: watchlists.length });
});

// POST /api/watchlists { profileId, name }
export const POST = householdHandler(async (request: NextRequest) => {
  const body = await parseJsonBody(request);
  requireFields(body, ["profileId", "name"]);
  const profileId = parseUuid(body.profileId, "profileId");
  const name = parseName(body.name, "name");
  const pool = getPool();
  await requireProfile(pool, profileId);
  return runWrite(pool, async (db) => {
    const { watchlist, created } = await createWatchlist(db, profileId, name);
    return { status: created ? 201 : 200, body: { created, watchlist } };
  });
});

import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, runWrite } from "@/lib/household/http";
import { requireProfile, getWatchlist, renameWatchlist, deleteWatchlist } from "@/lib/household/lists";
import { parseName, parseUuid, requireFields } from "@/lib/household/model";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function routeIds(request: NextRequest, context: RouteContext): Promise<{ profileId: string; watchlistId: string }> {
  const { id } = await context.params;
  return {
    profileId: parseUuid(request.nextUrl.searchParams.get("profileId"), "profileId"),
    watchlistId: parseUuid(id, "watchlist id")
  };
}

// GET /api/watchlists/{id}?profileId= — detail with items in read order.
export const GET = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { profileId, watchlistId } = await routeIds(request, context);
  const pool = getPool();
  await requireProfile(pool, profileId);
  const watchlist = await getWatchlist(pool, profileId, watchlistId);
  return NextResponse.json({ watchlist });
});

// PATCH /api/watchlists/{id}?profileId= { name }
export const PATCH = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { profileId, watchlistId } = await routeIds(request, context);
  const body = await parseJsonBody(request);
  requireFields(body, ["name"]);
  const name = parseName(body.name, "name");
  const pool = getPool();
  await requireProfile(pool, profileId);
  return runWrite(pool, async (db) => {
    const watchlist = await renameWatchlist(db, profileId, watchlistId, name);
    return { status: 200, body: { watchlist } };
  });
});

// DELETE /api/watchlists/{id}?profileId= — cascades items; foreign or absent
// ids are the same 404 (isolation without existence leaks).
export const DELETE = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { profileId, watchlistId } = await routeIds(request, context);
  const pool = getPool();
  await requireProfile(pool, profileId);
  return runWrite(pool, async (db) => {
    const { deleted } = await deleteWatchlist(db, profileId, watchlistId);
    return { status: 200, body: { deleted } };
  });
});

import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, runWrite } from "@/lib/household/http";
import {
  requireProfile,
  requireMediaRef,
  resolveMediaRef,
  addWatchlistItem,
  removeWatchlistItem,
  reorderWatchlistItems
} from "@/lib/household/lists";
import {
  parseMediaRef,
  parseMediaRefList,
  parseOptionalPosition,
  parseUuid,
  requireFields
} from "@/lib/household/model";

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

// POST /api/watchlists/{id}/items?profileId= { media: { source, id }, position? }
// Adds a member, or moves an existing member to the spliced position.
export const POST = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { profileId, watchlistId } = await routeIds(request, context);
  const body = await parseJsonBody(request);
  requireFields(body, ["media"]);
  const media = parseMediaRef(body.media, "media");
  const position = parseOptionalPosition(body.position, "position");
  const pool = getPool();
  await requireProfile(pool, profileId);
  return runWrite(pool, async (db) => {
    const mediaRefId = await resolveMediaRef(db, media.source, media.externalId);
    const { item, created } = await addWatchlistItem(db, profileId, watchlistId, mediaRefId, position);
    return { status: created ? 201 : 200, body: { created, item } };
  });
});

// PUT /api/watchlists/{id}/items?profileId= { ordered: [{ source, id }, ...] }
// Atomic reorder: the submitted set must equal current membership.
export const PUT = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { profileId, watchlistId } = await routeIds(request, context);
  const body = await parseJsonBody(request);
  requireFields(body, ["ordered"]);
  const ordered = parseMediaRefList(body.ordered, "ordered");
  const pool = getPool();
  await requireProfile(pool, profileId);
  return runWrite(pool, async (db) => {
    const orderedIds = [];
    for (const media of ordered) orderedIds.push(await requireMediaRef(db, media));
    const items = await reorderWatchlistItems(db, profileId, watchlistId, orderedIds);
    return { status: 200, body: { items } };
  });
});

// DELETE /api/watchlists/{id}/items?profileId=&mediaSource=&mediaId=
export const DELETE = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { profileId, watchlistId } = await routeIds(request, context);
  const params = request.nextUrl.searchParams;
  const media = parseMediaRef({ source: params.get("mediaSource"), id: params.get("mediaId") }, "media");
  const pool = getPool();
  await requireProfile(pool, profileId);
  const mediaRefId = await requireMediaRef(pool, media);
  return runWrite(pool, async (db) => {
    const { removed } = await removeWatchlistItem(db, profileId, watchlistId, mediaRefId);
    return { status: 200, body: { removed } };
  });
});

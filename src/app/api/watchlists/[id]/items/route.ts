import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import {
  requireProfile,
  requireMediaRef,
  resolveMediaRef,
  addWatchlistItem,
  removeWatchlistItem,
  reorderWatchlistItems
} from "@/lib/household/store";
import {
  fingerprintRequest,
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
  return runMutation(pool, {
    scope: "watchlists.items.add",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("watchlists.items.add", { profileId, watchlistId, media, position: position ?? null }),
    apply: async (db) => {
      const mediaRefId = await resolveMediaRef(db, media);
      const { item, created } = await addWatchlistItem(db, profileId, watchlistId, mediaRefId, position);
      return { status: created ? 201 : 200, body: { created, item } };
    }
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
  return runMutation(pool, {
    scope: "watchlists.items.reorder",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("watchlists.items.reorder", { profileId, watchlistId, ordered }),
    apply: async (db) => {
      const orderedIds = [];
      for (const media of ordered) orderedIds.push(await requireMediaRef(db, media));
      const items = await reorderWatchlistItems(db, profileId, watchlistId, orderedIds);
      return { status: 200, body: { items } };
    }
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
  return runMutation(pool, {
    scope: "watchlists.items.remove",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("watchlists.items.remove", { profileId, watchlistId, media }),
    apply: async (db) => {
      const { removed } = await removeWatchlistItem(db, profileId, watchlistId, mediaRefId);
      return { status: 200, body: { removed } };
    }
  });
});

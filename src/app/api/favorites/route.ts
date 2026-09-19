import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import { requireProfile, listFavorites, addFavorite, removeFavorite, requireMediaRef, resolveMediaRef } from "@/lib/household/store";
import {
  fingerprintRequest,
  parseLimit,
  parseMediaRef,
  parseUuid,
  requireFields
} from "@/lib/household/model";

export const dynamic = "force-dynamic";

// GET /api/favorites?profileId=&limit= — bounded, deterministic read.
export const GET = householdHandler(async (request: NextRequest) => {
  const profileId = parseUuid(request.nextUrl.searchParams.get("profileId"), "profileId");
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  const pool = getPool();
  await requireProfile(pool, profileId);
  const favorites = await listFavorites(pool, profileId, limit);
  return NextResponse.json({ favorites, count: favorites.length });
});

// POST /api/favorites { profileId, media: { source, id } }
export const POST = householdHandler(async (request: NextRequest) => {
  const body = await parseJsonBody(request);
  requireFields(body, ["profileId", "media"]);
  const profileId = parseUuid(body.profileId, "profileId");
  const media = parseMediaRef(body.media, "media");
  const pool = getPool();
  await requireProfile(pool, profileId);
  return runMutation(pool, {
    scope: "favorites.add",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("favorites.add", { profileId, media }),
    apply: async (db) => {
      const mediaRefId = await resolveMediaRef(db, media);
      const { favorite, created } = await addFavorite(db, profileId, mediaRefId);
      return { status: created ? 201 : 200, body: { created, favorite } };
    }
  });
});

// DELETE /api/favorites?profileId=&mediaSource=&mediaId=
export const DELETE = householdHandler(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const profileId = parseUuid(params.get("profileId"), "profileId");
  const media = parseMediaRef({ source: params.get("mediaSource"), id: params.get("mediaId") }, "media");
  const pool = getPool();
  await requireProfile(pool, profileId);
  // The media identity must exist even when the favorite does not: a stale
  // client deleting something ReelHouse never saw is a 404, not a shrug.
  const mediaRefId = await requireMediaRef(pool, media);
  return runMutation(pool, {
    scope: "favorites.remove",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("favorites.remove", { profileId, media }),
    apply: async (db) => {
      const { removed } = await removeFavorite(db, profileId, mediaRefId);
      return { status: 200, body: { removed } };
    }
  });
});

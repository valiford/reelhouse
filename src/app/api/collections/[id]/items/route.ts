import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import {
  requireMediaRef,
  resolveMediaRef,
  addCollectionItem,
  removeCollectionItem,
  reorderCollectionItems
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

async function collectionId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return parseUuid(id, "collection id");
}

// POST /api/collections/{id}/items { media: { source, id }, position? }
export const POST = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const id = await collectionId(context);
  const body = await parseJsonBody(request);
  requireFields(body, ["media"]);
  const media = parseMediaRef(body.media, "media");
  const position = parseOptionalPosition(body.position, "position");
  return runMutation(getPool(), {
    scope: "collections.items.add",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("collections.items.add", { id, media, position: position ?? null }),
    apply: async (db) => {
      const mediaRefId = await resolveMediaRef(db, media);
      const { item, created } = await addCollectionItem(db, id, mediaRefId, position);
      return { status: created ? 201 : 200, body: { created, item } };
    }
  });
});

// PUT /api/collections/{id}/items { ordered: [{ source, id }, ...] }
export const PUT = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const id = await collectionId(context);
  const body = await parseJsonBody(request);
  requireFields(body, ["ordered"]);
  const ordered = parseMediaRefList(body.ordered, "ordered");
  return runMutation(getPool(), {
    scope: "collections.items.reorder",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("collections.items.reorder", { id, ordered }),
    apply: async (db) => {
      const orderedIds = [];
      for (const media of ordered) orderedIds.push(await requireMediaRef(db, media));
      const items = await reorderCollectionItems(db, id, orderedIds);
      return { status: 200, body: { items } };
    }
  });
});

// DELETE /api/collections/{id}/items?mediaSource=&mediaId=
export const DELETE = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const id = await collectionId(context);
  const params = request.nextUrl.searchParams;
  const media = parseMediaRef({ source: params.get("mediaSource"), id: params.get("mediaId") }, "media");
  const pool = getPool();
  const mediaRefId = await requireMediaRef(pool, media);
  return runMutation(pool, {
    scope: "collections.items.remove",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("collections.items.remove", { id, media }),
    apply: async (db) => {
      const { removed } = await removeCollectionItem(db, id, mediaRefId);
      return { status: 200, body: { removed } };
    }
  });
});

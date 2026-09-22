import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, runWrite } from "@/lib/household/http";
import {
  requireMediaRef,
  resolveMediaRef,
  addCollectionItem,
  removeCollectionItem,
  reorderCollectionItems
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

// POST /api/collections/{id}/items { media: { source, id }, position? }
// Adds a member, or moves an existing member to the spliced position.
export const POST = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const collectionId = parseUuid(id, "collection id");
  const body = await parseJsonBody(request);
  requireFields(body, ["media"]);
  const media = parseMediaRef(body.media, "media");
  const position = parseOptionalPosition(body.position, "position");
  return runWrite(getPool(), async (db) => {
    const mediaRefId = await resolveMediaRef(db, media.source, media.externalId);
    const { item, created } = await addCollectionItem(db, collectionId, mediaRefId, position);
    return { status: created ? 201 : 200, body: { created, item } };
  });
});

// PUT /api/collections/{id}/items { ordered: [{ source, id }, ...] }
// Atomic reorder: the submitted set must equal current membership.
export const PUT = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const collectionId = parseUuid(id, "collection id");
  const body = await parseJsonBody(request);
  requireFields(body, ["ordered"]);
  const ordered = parseMediaRefList(body.ordered, "ordered");
  return runWrite(getPool(), async (db) => {
    const orderedIds = [];
    for (const media of ordered) orderedIds.push(await requireMediaRef(db, media));
    const items = await reorderCollectionItems(db, collectionId, orderedIds);
    return { status: 200, body: { items } };
  });
});

// DELETE /api/collections/{id}/items?mediaSource=&mediaId=
export const DELETE = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const collectionId = parseUuid(id, "collection id");
  const params = request.nextUrl.searchParams;
  const media = parseMediaRef({ source: params.get("mediaSource"), id: params.get("mediaId") }, "media");
  const mediaRefId = await requireMediaRef(getPool(), media);
  return runWrite(getPool(), async (db) => {
    const { removed } = await removeCollectionItem(db, collectionId, mediaRefId);
    return { status: 200, body: { removed } };
  });
});

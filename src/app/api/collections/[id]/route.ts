import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, runWrite } from "@/lib/household/http";
import { HouseholdInputError } from "@/lib/household/errors";
import { getCollection, updateCollection, deleteCollection } from "@/lib/household/lists";
import { parseName, parseOptionalDescription, parseUuid } from "@/lib/household/model";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/collections/{id} — detail with items in read order.
export const GET = householdHandler(async (
  _request: NextRequest,
  context: RouteContext
) => {
  const { id } = await context.params;
  const collectionId = parseUuid(id, "collection id");
  const collection = await getCollection(getPool(), collectionId);
  return NextResponse.json({ collection });
});

// PATCH /api/collections/{id} { name?, description? } — at least one field.
export const PATCH = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const collectionId = parseUuid(id, "collection id");
  const body = await parseJsonBody(request);
  const name = body.name === undefined ? undefined : parseName(body.name, "name");
  const description = parseOptionalDescription(body.description, "description");
  if (name === undefined && description === undefined) {
    throw new HouseholdInputError("at least one of name or description is required");
  }
  return runWrite(getPool(), async (db) => {
    const collection = await updateCollection(db, collectionId, { name, description });
    return { status: 200, body: { collection } };
  });
});

// DELETE /api/collections/{id} — cascades collection items.
export const DELETE = householdHandler(async (
  _request: NextRequest,
  context: RouteContext
) => {
  const { id } = await context.params;
  const collectionId = parseUuid(id, "collection id");
  return runWrite(getPool(), async (db) => {
    const { deleted } = await deleteCollection(db, collectionId);
    return { status: 200, body: { deleted } };
  });
});

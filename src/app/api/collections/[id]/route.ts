import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import { HouseholdError } from "@/lib/household/errors";
import { getCollection, updateCollection, deleteCollection } from "@/lib/household/store";
import { fingerprintRequest, parseName, parseOptionalDescription, parseUuid } from "@/lib/household/model";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function collectionId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return parseUuid(id, "collection id");
}

// GET /api/collections/{id} — detail with items in read order.
export const GET = householdHandler(async (_request: NextRequest, context: RouteContext) => {
  const collection = await getCollection(getPool(), await collectionId(context));
  return NextResponse.json({ collection });
});

// PATCH /api/collections/{id} { name?, description? }
export const PATCH = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const id = await collectionId(context);
  const body = await parseJsonBody(request);
  const name = body.name === undefined ? undefined : parseName(body.name, "name");
  const description = parseOptionalDescription(body.description, "description");
  if (name === undefined && description === undefined) {
    throw new HouseholdError("validation_failed", "Provide at least one of: name, description");
  }
  return runMutation(getPool(), {
    scope: "collections.update",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("collections.update", { id, name: name ?? null, description: description ?? null }),
    apply: async (db) => {
      const collection = await updateCollection(db, id, { name, description });
      return { status: 200, body: { collection } };
    }
  });
});

// DELETE /api/collections/{id} — cascades membership; home rows sourced from
// this collection cascade too (RH-0003 design: rows never dangle).
export const DELETE = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const id = await collectionId(context);
  return runMutation(getPool(), {
    scope: "collections.delete",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("collections.delete", { id }),
    apply: async (db) => {
      const { deleted } = await deleteCollection(db, id);
      return { status: 200, body: { deleted } };
    }
  });
});

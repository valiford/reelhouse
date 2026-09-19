import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import { requireProfile, createCollection, listCollections } from "@/lib/household/lists";
import {
  fingerprintRequest,
  parseName,
  parseOptionalDescription,
  parseOptionalUuid,
  requireFields
} from "@/lib/household/model";

export const dynamic = "force-dynamic";

// GET /api/collections — household-level curated collections, oldest first.
export const GET = householdHandler(async () => {
  const collections = await listCollections(getPool());
  return NextResponse.json({ collections, count: collections.length });
});

// POST /api/collections { name, description?, createdByProfileId? }
export const POST = householdHandler(async (request: NextRequest) => {
  const body = await parseJsonBody(request);
  requireFields(body, ["name"]);
  const name = parseName(body.name, "name");
  const description = parseOptionalDescription(body.description, "description") ?? "";
  const createdByProfileId = parseOptionalUuid(body.createdByProfileId, "createdByProfileId");
  const pool = getPool();
  if (createdByProfileId !== undefined) await requireProfile(pool, createdByProfileId);
  return runMutation(pool, {
    scope: "collections.create",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("collections.create", { name, description, createdByProfileId: createdByProfileId ?? null }),
    apply: async (db) => {
      const { collection, created } = await createCollection(db, { name, description, createdByProfileId });
      return { status: created ? 201 : 200, body: { created, collection } };
    }
  });
});

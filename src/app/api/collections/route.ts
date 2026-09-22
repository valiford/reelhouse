import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, runWrite } from "@/lib/household/http";
import { createCollection, listCollections } from "@/lib/household/lists";
import { parseName, parseOptionalDescription, parseOptionalUuid, requireFields } from "@/lib/household/model";

export const dynamic = "force-dynamic";

// GET /api/collections — household-level curation, oldest first.
export const GET = householdHandler(async () => {
  const collections = await listCollections(getPool());
  return NextResponse.json({ collections, count: collections.length });
});

// POST /api/collections { name, description?, createdByProfileId? }
// The creator is provenance only: deleting that profile never deletes the
// collection, so the id is validated but not required to outlive the row.
export const POST = householdHandler(async (request: NextRequest) => {
  const body = await parseJsonBody(request);
  requireFields(body, ["name"]);
  const name = parseName(body.name, "name");
  const description = parseOptionalDescription(body.description, "description");
  const createdByProfileId = parseOptionalUuid(body.createdByProfileId, "createdByProfileId");
  return runWrite(getPool(), async (db) => {
    const { collection, created } = await createCollection(db, {
      name,
      description,
      createdByProfileId
    });
    return { status: created ? 201 : 200, body: { created, collection } };
  });
});

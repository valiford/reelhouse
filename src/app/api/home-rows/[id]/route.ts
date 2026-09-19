import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import { HouseholdInputError } from "@/lib/household/errors";
import { updateHomeRow, deleteHomeRow } from "@/lib/household/lists";
import {
  fingerprintRequest,
  parseHomeRowSource,
  parseName,
  parseOptionalBoolean,
  parseUuid
} from "@/lib/household/model";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function rowId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return parseUuid(id, "home row id");
}

// PATCH /api/home-rows/{id} { title?, isEnabled?, source? }
export const PATCH = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const id = await rowId(context);
  const body = await parseJsonBody(request);
  const title = body.title === undefined ? undefined : parseName(body.title, "title");
  const isEnabled = parseOptionalBoolean(body.isEnabled, "isEnabled");
  const source = body.source === undefined ? undefined : parseHomeRowSource(body.source, "source");
  if (title === undefined && isEnabled === undefined && source === undefined) {
    throw new HouseholdInputError( "Provide at least one of: title, isEnabled, source");
  }
  return runMutation(getPool(), {
    scope: "home_rows.update",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("home_rows.update", {
      id,
      title: title ?? null,
      isEnabled: isEnabled ?? null,
      source: source ?? null
    }),
    apply: async (db) => {
      const row = await updateHomeRow(db, id, { title, isEnabled, source });
      return { status: 200, body: { row } };
    }
  });
});

// DELETE /api/home-rows/{id}
export const DELETE = householdHandler(async (request: NextRequest, context: RouteContext) => {
  const id = await rowId(context);
  return runMutation(getPool(), {
    scope: "home_rows.delete",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("home_rows.delete", { id }),
    apply: async (db) => {
      const { deleted } = await deleteHomeRow(db, id);
      return { status: 200, body: { deleted } };
    }
  });
});

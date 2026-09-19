import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import { reorderHomeRows } from "@/lib/household/lists";
import { fingerprintRequest, parseUuidList, requireFields } from "@/lib/household/model";

export const dynamic = "force-dynamic";

// PUT /api/home-rows/order { orderedIds: [uuid, ...] } — atomic renumber to
// the submitted order; the submitted set must equal the current row set.
export const PUT = householdHandler(async (request: NextRequest) => {
  const body = await parseJsonBody(request);
  requireFields(body, ["orderedIds"]);
  const orderedIds = parseUuidList(body.orderedIds, "orderedIds");
  return runMutation(getPool(), {
    scope: "home_rows.reorder",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("home_rows.reorder", { orderedIds }),
    apply: async (db) => {
      const rows = await reorderHomeRows(db, orderedIds);
      return { status: 200, body: { rows } };
    }
  });
});

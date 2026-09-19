import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdHandler, parseJsonBody, readIdempotencyKey, runMutation } from "@/lib/household/http";
import { createHomeRow, listHomeRows } from "@/lib/household/lists";
import {
  fingerprintRequest,
  parseHomeRowSource,
  parseName,
  parseOptionalPosition,
  parseRowKey,
  requireFields
} from "@/lib/household/model";

export const dynamic = "force-dynamic";

// GET /api/home-rows — the home screen's configured rows in display order.
export const GET = householdHandler(async () => {
  const rows = await listHomeRows(getPool());
  return NextResponse.json({ rows, count: rows.length });
});

// POST /api/home-rows { rowKey, title, source: { kind, sourceKey? ,
// collectionId? }, position? } — explicit position splices; default appends.
export const POST = householdHandler(async (request: NextRequest) => {
  const body = await parseJsonBody(request);
  requireFields(body, ["rowKey", "title", "source"]);
  const rowKey = parseRowKey(body.rowKey, "rowKey");
  const title = parseName(body.title, "title");
  const source = parseHomeRowSource(body.source, "source");
  const position = parseOptionalPosition(body.position, "position");
  return runMutation(getPool(), {
    scope: "home_rows.create",
    key: readIdempotencyKey(request),
    fingerprint: fingerprintRequest("home_rows.create", { rowKey, title, source, position: position ?? null }),
    apply: async (db) => {
      const { row, created } = await createHomeRow(db, { rowKey, title, source, position });
      return { status: created ? 201 : 200, body: { created, row } };
    }
  });
});

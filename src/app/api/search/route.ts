import { NextRequest, NextResponse } from "next/server";
import { searchLibrary, isAbortError } from "@/lib/jellyfin";
import { parseListQuery } from "@/lib/list-query";
import type { ReelHouseApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parsed = parseListQuery(request.nextUrl.searchParams, { requireQuery: true });
  if (!parsed.ok) {
    return NextResponse.json<ReelHouseApiError>(
      { error: { code: "invalid_query", field: parsed.error.field, message: parsed.error.message } },
      { status: 400 }
    );
  }

  try {
    const payload = await searchLibrary(parsed.query.q, parsed.query, request.signal);
    return NextResponse.json(payload);
  } catch (error) {
    if (isAbortError(error) || request.signal.aborted) {
      return new Response(null, { status: 408 });
    }
    console.error("Search failed:", error);
    return NextResponse.json<ReelHouseApiError>(
      { error: { code: "upstream_unavailable", message: "Search is temporarily unavailable. The ReelHouse Engine did not respond." } },
      { status: 502 }
    );
  }
}

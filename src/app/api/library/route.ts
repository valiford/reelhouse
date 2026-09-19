import { NextRequest, NextResponse } from "next/server";
import { getLibrary, LIBRARY_SECTIONS, isAbortError } from "@/lib/jellyfin";
import { parseListQuery } from "@/lib/list-query";
import type { ReelHouseApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

const SECTION_TITLES: readonly string[] = LIBRARY_SECTIONS;

export async function GET(request: NextRequest) {
  const parsed = parseListQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json<ReelHouseApiError>(
      { error: { code: "invalid_query", field: parsed.error.field, message: parsed.error.message } },
      { status: 400 }
    );
  }

  const rawSections = request.nextUrl.searchParams.get("sections");
  let sections: string[] | undefined;
  if (rawSections) {
    sections = [];
    for (const part of rawSections.split(",")) {
      if (!part.trim()) continue;
      const match = SECTION_TITLES.find((title) => title.toLowerCase() === part.trim().toLowerCase());
      if (!match) {
        return NextResponse.json<ReelHouseApiError>(
          { error: { code: "invalid_query", field: "sections", message: `Unknown section "${part.trim()}". Allowed sections: ${SECTION_TITLES.join(", ")}.` } },
          { status: 400 }
        );
      }
      if (!sections.includes(match)) sections.push(match);
    }
  }

  try {
    const payload = await getLibrary({ sections, limit: parsed.query.limit, signal: request.signal });
    return NextResponse.json(payload);
  } catch (error) {
    if (isAbortError(error) || request.signal.aborted) {
      return new Response(null, { status: 408 });
    }
    console.error("Library failed:", error);
    return NextResponse.json<ReelHouseApiError>(
      { error: { code: "upstream_unavailable", message: "Library is temporarily unavailable. The ReelHouse Engine did not respond." } },
      { status: 502 }
    );
  }
}

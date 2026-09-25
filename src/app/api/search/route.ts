import { NextRequest, NextResponse } from "next/server";
import { searchLibrary } from "@/lib/jellyfin";
import { loadDatabaseConfig } from "@/lib/db/config";
import { catalogHasActiveItems } from "@/lib/readmodels/home";
import { readExecutor } from "@/lib/readmodels/pg";
import { searchCatalog } from "@/lib/readmodels/search";

// Search routing (RH-0040): once the catalog holds synced rows, search is
// the bounded catalog-backed read model — zero hits on a synced catalog is
// a legitimate empty page, not a fallback trigger. Until the first sync
// (or on a database error) the legacy path answers: direct Jellyfin, demo
// fallback. The response keeps the `{ items }` shape the UI renders and
// names the serving source for observability.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") || "";
  const limit = request.nextUrl.searchParams.get("limit");
  const offset = request.nextUrl.searchParams.get("offset");

  const database = loadDatabaseConfig(process.env);
  if (database.kind === "valid") {
    try {
      if (await catalogHasActiveItems(readExecutor)) {
        const page = await searchCatalog(readExecutor, q, { limit, offset });
        return NextResponse.json({
          source: "catalog",
          items: page.items,
          limit: page.limit,
          offset: page.offset
        });
      }
      // Catalog not synced yet: fall through to the legacy path.
    } catch (error) {
      console.error("Catalog search failed; falling back:", error instanceof Error ? error.message : String(error));
    }
  }
  return NextResponse.json({ items: await searchLibrary(q) });
}

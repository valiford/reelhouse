import { NextResponse, type NextRequest } from "next/server";
import { CATALOG_URL_VAR } from "@/lib/catalog/config";
import {
  CatalogUnavailableError,
  catalogStatus,
  catalogViewToMediaItem,
  getCatalogPool,
  parseSearchQuery,
  searchCatalogItems
} from "@/lib/catalog/read-model";
import { searchLibrary } from "@/lib/jellyfin";

export const dynamic = "force-dynamic";

// Search answers from the media_catalog read model when the catalog database
// is configured, and falls back to the live Jellyfin API when it is not (or
// when the catalog cannot be reached). Every response names its source and
// carries explicit degradation facts — a fallback is never silent (RH-0020).
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const parsed = parseSearchQuery({
    q: params.get("q"),
    kind: params.get("kind"),
    genre: params.get("genre"),
    year: params.get("year"),
    sort: params.get("sort"),
    limit: params.get("limit"),
    cursor: params.get("cursor")
  });
  if (!parsed.ok) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: parsed.errors.join("; ") } },
      { status: 400 }
    );
  }
  const query = parsed.value;
  const env = process.env as Record<string, string | undefined>;

  let catalogUnavailableDetail: string | null = null;
  try {
    const pool = getCatalogPool(env);
    const [page, status] = await Promise.all([
      searchCatalogItems(pool, env, query),
      catalogStatus(pool, env, { now: new Date() })
    ]);
    return NextResponse.json({
      source: "catalog",
      query: {
        q: query.q,
        kinds: query.kinds,
        genre: query.genre,
        year: query.year,
        sort: query.sort,
        limit: query.limit
      },
      items: page.items.map(catalogViewToMediaItem),
      total: page.total,
      nextCursor: page.nextCursor,
      catalog: status
    });
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      catalogUnavailableDetail = error.message;
      console.error("Catalog search unavailable, serving Jellyfin search instead:", error.message);
    } else {
      throw error;
    }
  }

  const result = await searchLibrary(query.q);
  return NextResponse.json({
    source: "jellyfin",
    items: result.value,
    degraded: result.degraded,
    ...(catalogUnavailableDetail !== null
      ? {
          catalog: {
            // "unconfigured" (no MEDIA_CATALOG_DATABASE_URL) reads differently
            // from "unavailable" (configured but unreachable).
            state: env[CATALOG_URL_VAR] ? ("unavailable" as const) : ("unconfigured" as const),
            detail: catalogUnavailableDetail
          }
        }
      : {})
  });
}

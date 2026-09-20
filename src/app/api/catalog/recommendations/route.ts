import { NextResponse, type NextRequest } from "next/server";
import { CATALOG_URL_VAR } from "@/lib/catalog/config";
import {
  CatalogUnavailableError,
  catalogRails,
  catalogStatus,
  catalogViewToMediaItem,
  getCatalogPool,
  parseRailQuery
} from "@/lib/catalog/read-model";

export const dynamic = "force-dynamic";

// Recommendation rails are a pure catalog read model: no per-request Jellyfin
// dependency, bounded result sizes, deterministic ordering, explicit
// freshness. Stale catalog state is served but labelled — the client decides
// whether to render it. Without a catalog database the endpoint fails closed
// with 503: there is no honest recommendation to fabricate from demo data.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const parsed = parseRailQuery({ genre: params.get("genre"), limit: params.get("limit") });
  if (!parsed.ok) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: parsed.errors.join("; ") } },
      { status: 400 }
    );
  }
  const env = process.env as Record<string, string | undefined>;
  try {
    const pool = getCatalogPool(env);
    const [rails, status] = await Promise.all([
      catalogRails(pool, env, parsed.value),
      catalogStatus(pool, env, { now: new Date() })
    ]);
    return NextResponse.json({
      source: "catalog",
      rails: rails.map((rail) => ({
        key: rail.key,
        title: rail.title,
        genre: rail.genre,
        items: rail.items.map(catalogViewToMediaItem)
      })),
      catalog: status
    });
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      console.error("Catalog recommendations unavailable:", error.message);
      const code = env[CATALOG_URL_VAR] ? "catalog_unavailable" : "catalog_unconfigured";
      return NextResponse.json({ error: { code, message: error.message } }, { status: 503 });
    }
    throw error;
  }
}

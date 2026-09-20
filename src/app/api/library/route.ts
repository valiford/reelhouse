import { NextResponse } from "next/server";
import { CATALOG_URL_VAR } from "@/lib/catalog/config";
import {
  CatalogUnavailableError,
  catalogLibraryBrowse,
  catalogStatus,
  catalogViewToMediaItem,
  getCatalogPool
} from "@/lib/catalog/read-model";
import { getLibrary } from "@/lib/jellyfin";

export const dynamic = "force-dynamic";

// Section size for catalog-backed browse; bounded by construction, not by
// client input.
const BROWSE_SECTION_LIMIT = 12;

// Library browse prefers the media_catalog read model (stable ordering,
// bounded sections, freshness-labelled). Without a catalog database — or when
// it is empty or unavailable — it falls back to the live Jellyfin API (or the
// demo library), and the response carries explicit `catalog` and `degraded`
// facts so the client can say which mode it is in (RH-0020).
export async function GET() {
  const env = process.env as Record<string, string | undefined>;

  let catalogNote: Record<string, unknown> | null = null;
  try {
    const pool = getCatalogPool(env);
    const [browse, status] = await Promise.all([
      catalogLibraryBrowse(pool, env, { limit: BROWSE_SECTION_LIMIT }),
      catalogStatus(pool, env, { now: new Date() })
    ]);
    if (browse.hero !== null) {
      return NextResponse.json({
        source: "catalog",
        hero: catalogViewToMediaItem(browse.hero),
        sections: browse.sections.map((section) => ({
          title: section.title,
          items: section.items.map(catalogViewToMediaItem)
        })),
        catalog: status
      });
    }
    // Catalog reachable but empty (never synced): the honest statement is the
    // sync state itself, served alongside the fallback payload.
    catalogNote = { state: status.state, lastSucceededAt: status.lastSucceededAt };
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      catalogNote = {
        // "unconfigured" (no MEDIA_CATALOG_DATABASE_URL) reads differently
        // from "unavailable" (configured but unreachable).
        state: env[CATALOG_URL_VAR] ? "unavailable" : "unconfigured",
        detail: error.message
      };
      console.error("Catalog browse unavailable, serving Jellyfin library instead:", error.message);
    } else {
      throw error;
    }
  }

  const result = await getLibrary();
  return NextResponse.json({
    ...result.value,
    degraded: result.degraded,
    ...(catalogNote !== null ? { catalog: catalogNote } : {})
  });
}

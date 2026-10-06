import type { NextRequest } from "next/server";
import { readModelResponse, searchParamsToObject } from "@/lib/readmodels/api";
import { resolveIdentifier, resolvePage, resolveSearchFilters } from "@/lib/readmodels/params";
import { searchCatalogItems } from "@/lib/readmodels/browse";
import { resolveProfile } from "@/lib/readmodels/home-feed";

// Bounded catalog search/filter/pagination over PostgreSQL. Always live.
// ?profile=<slug> scopes the page's spoiler-shield watch state to that
// profile (watched true/false/null per item); without it the page serves
// watched = null (unknown) and clients shield conservatively. An unknown
// slug is a 404, never a silent fallback to a different profile.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = searchParamsToObject(request.nextUrl);
  return readModelResponse(async (executor) => {
    const filters = resolveSearchFilters(raw);
    const page = resolvePage(raw);
    const rawProfile = typeof raw.profile === "string" ? raw.profile : null;
    const profile =
      rawProfile === null ? null : await resolveProfile(executor, resolveIdentifier(rawProfile, "profile"));
    return {
      filters,
      page: await searchCatalogItems(executor, filters, page, {
        profileId: profile === null ? undefined : Number(profile.id)
      })
    };
  });
}

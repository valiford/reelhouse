import type { NextRequest } from "next/server";
import { readModelResponse, searchParamsToObject } from "@/lib/readmodels/api";
import { resolveIdentifier } from "@/lib/readmodels/params";
import { getCatalogItem } from "@/lib/readmodels/browse";
import { resolveProfile } from "@/lib/readmodels/home-feed";

// Catalog item detail (facets, file state, provenance stamps) by Jellyfin id.
// ?profile=<slug> scopes the spoiler-shield watch state to that profile
// (watched true/false/null); without it watched is null (unknown) and
// clients shield conservatively. An unknown slug is a 404.
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const raw = searchParamsToObject(request.nextUrl);
  return readModelResponse(async (executor) => {
    resolveIdentifier(id, "item id");
    const rawProfile = typeof raw.profile === "string" ? raw.profile : null;
    const profile =
      rawProfile === null ? null : await resolveProfile(executor, resolveIdentifier(rawProfile, "profile"));
    return getCatalogItem(executor, id, {
      profileId: profile === null ? undefined : Number(profile.id)
    });
  });
}

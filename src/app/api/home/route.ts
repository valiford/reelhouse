import type { NextRequest } from "next/server";
import { readModelResponse, searchParamsToObject } from "@/lib/readmodels/api";
import { HouseholdEmptyError, homeFeed } from "@/lib/readmodels/home";

// The profile-scoped home feed: the profile's configured home rows resolved
// into bounded item rails. ?profile=<slug> selects a profile; without it the
// household default is used. A reachable database with an empty household is
// a legitimate pre-import state and renders as an empty feed, not an error.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = searchParamsToObject(request.nextUrl);
  return readModelResponse(async (executor) => {
    try {
      return await homeFeed(executor, { profileSlug: raw.profile, limit: raw.limit });
    } catch (error) {
      if (error instanceof HouseholdEmptyError) {
        return { profile: null, rows: [], perRailLimit: null, emptyHousehold: true };
      }
      throw error;
    }
  });
}

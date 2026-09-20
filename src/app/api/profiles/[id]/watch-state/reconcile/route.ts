import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdErrorResponse } from "@/lib/household/api";
import {
  createHttpJellyfinResumeClient,
  loadReconcileJellyfinConfig,
  reconcileProfileWatchState,
  RECONCILE_LIMIT_DEFAULT,
  RECONCILE_LIMIT_MAX
} from "@/lib/household/reconcile.ts";
import { parseLimit, parseUuid } from "@/lib/household/validate.ts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// POST reconciles this profile's watch-state overlay from the linked
// Jellyfin account's resumable items (RH-0022). One bounded page per run,
// applied in one transaction: Jellyfin events newer than local state win,
// older ones never regress it, and re-running is a no-op — never duplicate
// history. `?limit=` bounds the page (default 50 / max 200).
//
// Fail-closed: an unknown profile is a 404, an unlinked profile a 409, and
// an unreachable or unconfigured Jellyfin a 503 (`jellyfin_unavailable`) —
// never demo data, never a partial import.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profileId = parseUuid(id, "profile id");
    if (!profileId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: profileId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), RECONCILE_LIMIT_DEFAULT, RECONCILE_LIMIT_MAX);
    if (!limit.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: limit.errors.join("; ") } },
        { status: 400 }
      );
    }

    // Config is validated at the edge so an unconfigured server fails before
    // any database work; the reconcile run itself only sees a working client.
    const config = loadReconcileJellyfinConfig(process.env);
    const outcome = await reconcileProfileWatchState({
      source: getPool(),
      profileId: profileId.value,
      client: createHttpJellyfinResumeClient(config),
      limit: limit.value
    });

    return NextResponse.json({
      profileId: outcome.profileId,
      jellyfinUserId: outcome.jellyfinUserId,
      scanned: outcome.scanned,
      applied: outcome.applied,
      stale: outcome.stale,
      duplicate: outcome.duplicate,
      skipped: outcome.skipped,
      cursor: outcome.cursor
    });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

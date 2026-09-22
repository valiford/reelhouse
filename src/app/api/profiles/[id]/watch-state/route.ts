import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { householdErrorResponse, readBoundedJson } from "@/lib/household/api";
import {
  WATCH_PROGRESS_IDEMPOTENCY_SCOPE,
  claimIdempotencyKey,
  fingerprintWatchProgress,
  getProfile,
  getWatchState,
  listContinueWatching,
  listWatchState,
  recordWatchProgress,
  transact
} from "@/lib/household/store";
import {
  HOUSEHOLD_LIMITS,
  parseLimit,
  parseUuid,
  parseWatchProgress
} from "@/lib/household/validate";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// GET lists this profile's watch state; `?mode=continue` answers the
// Continue Watching rail (in-progress only, newest activity first). Both are
// hard-bounded reads.
export async function GET(request: NextRequest, context: RouteContext) {
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
    const mode = url.searchParams.get("mode") ?? "all";
    if (mode !== "all" && mode !== "continue") {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "mode must be \"all\" or \"continue\"" } },
        { status: 400 }
      );
    }
    const limit = parseLimit(
      url.searchParams.get("limit"),
      mode === "continue"
        ? HOUSEHOLD_LIMITS.continueWatchingDefault
        : HOUSEHOLD_LIMITS.watchStateDefault,
      mode === "continue" ? HOUSEHOLD_LIMITS.continueWatchingMax : HOUSEHOLD_LIMITS.watchStateMax
    );
    if (!limit.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: limit.errors.join("; ") } },
        { status: 400 }
      );
    }
    const runner = getPool();
    const profile = await getProfile(runner, profileId.value);
    if (!profile) {
      return NextResponse.json({ error: { code: "not_found", message: "profile not found" } }, { status: 404 });
    }
    const items =
      mode === "continue"
        ? await listContinueWatching(runner, profileId.value, { limit: limit.value })
        : await listWatchState(runner, profileId.value, { limit: limit.value });
    return NextResponse.json({ items, count: items.length, mode });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

// PUT records progress against a stable (source, external_id) identity: the
// media ref is resolved or created, the overlay row is upserted, and the
// append-only playback event is written — atomically. An `Idempotency-Key`
// header makes retries safe: the same key with the same payload replays
// without appending duplicate history; the same key with a different payload
// is a 409.
export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profileId = parseUuid(id, "profile id");
    if (!profileId.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: profileId.errors.join("; ") } },
        { status: 400 }
      );
    }
    const progress = parseWatchProgress(await readBoundedJson(request));
    if (!progress.ok) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: progress.errors.join("; ") } },
        { status: 400 }
      );
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || undefined;
    if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "idempotency-key header must be between 1 and 200 characters" } },
        { status: 400 }
      );
    }

    const result = await transact(getPool(), async (tx) => {
      const profile = await getProfile(tx, profileId.value);
      if (!profile) {
        return { status: 404 as const, body: { error: { code: "not_found", message: "profile not found" } } };
      }
      const input = { ...progress.value, profileId: profileId.value };
      const fingerprint = fingerprintWatchProgress(input);

      if (idempotencyKey !== undefined) {
        const claim = await claimIdempotencyKey(
          tx,
          WATCH_PROGRESS_IDEMPOTENCY_SCOPE,
          idempotencyKey,
          fingerprint
        );
        if (claim !== "claimed") {
          // Replay: the original write already committed. Return the stored
          // overlay state without appending history again. (A row can only be
          // missing here if it was deleted after the first write; recording
          // again is then the caller's intent.)
          const existing = await getWatchState(tx, input.profileId, input.source, input.externalId);
          if (existing) {
            return { status: 200 as const, body: { watchState: existing, idempotentReplay: true } };
          }
        }
      }

      const watchState = await recordWatchProgress(tx, input);
      return { status: 200 as const, body: { watchState } };
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return householdErrorResponse(error);
  }
}

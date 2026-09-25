import { NextRequest, NextResponse } from "next/server";
import { getLibrary } from "@/lib/jellyfin";
import { loadDatabaseConfig } from "@/lib/db/config";
import { getHomePayload } from "@/lib/readmodels/home";
import { readExecutor } from "@/lib/readmodels/pg";

// Home payload routing (RH-0040): when a database is configured, the home
// screen is served from the PostgreSQL read models — indexed, bounded,
// household-scoped. An empty catalog (not yet synced) or a database error
// falls back to the legacy path (direct Jellyfin, demo fallback), so the
// screen degrades instead of blanking. Without a database the behavior is
// exactly the pre-RH-0040 contract.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const profile = request.nextUrl.searchParams.get("profile");
  const database = loadDatabaseConfig(process.env);
  if (database.kind === "valid") {
    try {
      const home = await getHomePayload(readExecutor, { profileSlug: profile });
      if (home.kind === "ok") return NextResponse.json(home.payload);
      if (home.kind === "profile-not-found") {
        return NextResponse.json({ error: home.detail }, { status: 404 });
      }
      // empty-catalog: fall through to the legacy path.
    } catch (error) {
      console.error("Catalog home read failed; falling back:", error instanceof Error ? error.message : String(error));
    }
  }
  return NextResponse.json(await getLibrary());
}

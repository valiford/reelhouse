import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db/pool";
import { checkJellyfin } from "@/lib/jellyfin-health";

// Health must reflect the live database and Jellyfin on every request, never
// a build-time or cached snapshot.
export const dynamic = "force-dynamic";

// Fail closed on the database: invalid or unreachable reports 503.
// "unconfigured" stays 200 — it is the legitimate no-database demo mode, same
// philosophy as the Jellyfin demo fallback. Jellyfin state is informational
// only: an unreachable Jellyfin degrades the library source, it does not make
// ReelHouse unhealthy.
export async function GET() {
  const [database, jellyfin] = await Promise.all([checkDatabase(), checkJellyfin(process.env)]);
  const healthy = database.state === "reachable" || database.state === "unconfigured";
  return NextResponse.json(
    { status: healthy ? "ok" : "error", database, jellyfin },
    { status: healthy ? 200 : 503 }
  );
}

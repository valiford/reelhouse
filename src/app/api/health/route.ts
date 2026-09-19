import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db/pool";

// Health must reflect the live database on every request, never a
// build-time or cached snapshot.
export const dynamic = "force-dynamic";

// Fail closed: invalid or unreachable database reports 503. "unconfigured"
// stays 200 — it is the legitimate no-database demo mode, same philosophy as
// the Jellyfin demo fallback.
export async function GET() {
  const database = await checkDatabase();
  const healthy = database.state === "reachable" || database.state === "unconfigured";
  return NextResponse.json(
    { status: healthy ? "ok" : "error", database },
    { status: healthy ? 200 : 503 }
  );
}

import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db/pool";
import { summarizeMigrations } from "@/lib/db/migrator";
import { query } from "@/lib/db/pool";
import { checkJellyfin } from "@/lib/jellyfin-health";

// Health must reflect the live database and Jellyfin on every request, never
// a build-time or cached snapshot.
export const dynamic = "force-dynamic";

// Fail closed on the database: invalid or unreachable reports 503.
// "unconfigured" stays 200 — it is the legitimate no-database demo mode, same
// philosophy as the Jellyfin demo fallback. Jellyfin state is informational
// only: an unreachable Jellyfin degrades the library source, it does not make
// ReelHouse unhealthy. The migration summary is diagnostic for the same
// reason: a database that is reachable but not yet migrated is reported as
// data (so an operator can see `pending` at a glance) without flipping the
// overall status, because nothing in this job reads business tables yet.
export async function GET() {
  const database = await checkDatabase();

  let migrations;
  if (database.state === "reachable") {
    migrations = await summarizeMigrations("db/migrations", async () => {
      const result = await query<{ version: number; name: string; checksum: string }>(
        "SELECT version, name, checksum FROM public.schema_migrations ORDER BY version"
      );
      return result.rows;
    });
  } else {
    migrations = { state: "unknown" as const, detail: `database ${database.state}` };
  }

  const jellyfin = await checkJellyfin(process.env);
  const healthy = database.state === "reachable" || database.state === "unconfigured";
  return NextResponse.json(
    { status: healthy ? "ok" : "error", database, migrations, jellyfin },
    { status: healthy ? 200 : 503 }
  );
}

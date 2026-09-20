// CLI entry point for ReelHouse database backups (RH-0021).
//
//   node scripts/db-backup.ts --out <directory> [--only reelhouse|media_catalog]
//
// Backs up each configured database into a fresh backup directory (manifest
// + per-table JSONL files, see docs/BACKUP_RESTORE.md). The reelhouse
// database carries household state that exists nowhere else; media_catalog
// is rebuildable from Jellyfin — backing it up is an optimization, not the
// recovery authority.
//
// Configuration is environment-only (never flags, never arguments):
//   DATABASE_URL                  reelhouse database source
//   MEDIA_CATALOG_DATABASE_URL    media_catalog database source
//
// The output directory must not exist yet or must be empty; an existing
// backup is never overwritten. Exit code 0 only for a complete backup;
// failures are bounded and redacted. Jellyfin is never contacted and no
// source database is ever written to.

import { runBackup } from "../src/lib/backup/snapshot.ts";
import { BACKUP_DATABASES, isBackupDatabaseId, type BackupDatabaseId } from "../src/lib/backup/model.ts";

function argumentFor(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const outDir = argumentFor("--out");
if (!outDir) {
  console.error("Usage: node scripts/db-backup.ts --out <directory> [--only reelhouse|media_catalog]");
  process.exit(1);
}

const onlyRaw = argumentFor("--only");
if (onlyRaw !== null && !isBackupDatabaseId(onlyRaw)) {
  console.error(`--only must be one of: ${BACKUP_DATABASES.map((spec) => spec.id).join(", ")} (got "${onlyRaw}")`);
  process.exit(1);
}

const env = process.env;
const wanted: BackupDatabaseId[] = onlyRaw ? [onlyRaw] : BACKUP_DATABASES.map((spec) => spec.id);
const databases = [];
for (const id of wanted) {
  const urlVar = BACKUP_DATABASES.find((spec) => spec.id === id)?.urlVar ?? "DATABASE_URL";
  const url = env[urlVar]?.trim();
  if (!url) {
    if (onlyRaw) {
      console.error(`${urlVar} is not configured; cannot back up ${id}`);
      process.exit(1);
    }
    console.error(`Skipping ${id}: ${urlVar} is not configured`);
    continue;
  }
  databases.push({ id, databaseUrl: url });
}

if (databases.length === 0) {
  console.error("No database is configured to back up: set DATABASE_URL (and/or MEDIA_CATALOG_DATABASE_URL)");
  process.exit(1);
}

try {
  const result = await runBackup({ databases, outDir, log: (line) => console.log(line) });
  for (const database of result.databases) {
    const rows = database.tables.reduce((sum, table) => sum + table.rowCount, 0);
    console.log(`${database.id}: ${database.tables.length} tables, ${rows} rows, PostgreSQL ${database.pgVersion}`);
  }
  console.log(`Backup complete: ${result.outDir} (manifest sha256 ${result.manifestSha256}, ${result.durationMs} ms)`);
} catch (error) {
  console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

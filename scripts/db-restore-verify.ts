// CLI entry point for ReelHouse backup restore verification (RH-0021).
//
//   node scripts/db-restore-verify.ts --from <backup-directory> [--offline]
//        [--only reelhouse|media_catalog] [--keep-on-failure]
//
// --offline   verify only the manifest, checksum sidecar, data files, and
//             freshness; no database is contacted.
// default     the full proof: restore the backup into a disposable scratch
//             database, replay migrations, reload every table, recompute
//             content checksums from the restored database, drop the scratch.
//
// Environment:
//   RESTORE_VERIFY_DATABASE_URL   disposable scratch target (required unless
//                                 --offline). Its database name must match
//                                 rh_restore_[a-z0-9_]{1,50}: the tool drops
//                                 and recreates it, so nothing else may ever
//                                 point this variable at a real database.
//   BACKUP_MAX_AGE_HOURS          freshness bound (default 168 = one week).
//
// Exit code 0 only for a passing verification. Production databases are
// never contacted by this tool: it reads the backup directory and the
// scratch URL and nothing else.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isBackupDatabaseId,
  parseBackupMaxAgeHours,
  RESTORE_VERIFY_URL_VAR
} from "../src/lib/backup/model.ts";
import { formatRestoreVerifyReport, restoreVerify, verifyBackupFiles } from "../src/lib/backup/restore.ts";

function argumentFor(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const backupDir = argumentFor("--from");
if (!backupDir) {
  console.error("Usage: node scripts/db-restore-verify.ts --from <backup-directory> [--offline] [--only reelhouse|media_catalog] [--keep-on-failure]");
  process.exit(1);
}

const onlyRaw = argumentFor("--only");
if (onlyRaw !== null && !isBackupDatabaseId(onlyRaw)) {
  console.error(`--only must be "reelhouse" or "media_catalog" (got "${onlyRaw}")`);
  process.exit(1);
}

const maxAge = parseBackupMaxAgeHours(process.env);
if (maxAge.kind === "invalid") {
  console.error(`Configuration is invalid and was rejected: ${maxAge.errors.join("; ")}`);
  process.exit(1);
}

const offlineOnly = hasFlag("--offline");
const scratchUrl = process.env[RESTORE_VERIFY_URL_VAR]?.trim() ?? "";
if (!offlineOnly && !scratchUrl) {
  console.error(`No scratch target configured: set ${RESTORE_VERIFY_URL_VAR} to a disposable rh_restore_* database (or use --offline)`);
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirs = {
  migrations: join(repoRoot, "db", "migrations"),
  "migrations-catalog": join(repoRoot, "db", "migrations-catalog")
};

try {
  if (offlineOnly) {
    const offline = await verifyBackupFiles({ backupDir, maxAgeHours: maxAge.hours });
    for (const problem of offline.problems) {
      const scope = problem.table ? `${problem.database}/${problem.table}` : problem.database ?? "backup";
      console.error(`[FAIL] ${scope}: ${problem.message}`);
    }
    if (offline.manifest) {
      console.log(`Backup age: ${offline.ageHours?.toFixed(1)} hours (bound ${maxAge.hours})`);
    }
    console.log(offline.problems.length === 0 && offline.manifest ? "OFFLINE VERIFY OK" : "OFFLINE VERIFY FAILED");
    if (!offline.manifest || offline.problems.length > 0) process.exit(1);
  } else {
    const report = await restoreVerify({
      backupDir,
      scratchUrl,
      only: onlyRaw ? [onlyRaw] : undefined,
      keepScratchOnFailure: hasFlag("--keep-on-failure"),
      migrationsDirs,
      maxAgeHours: maxAge.hours,
      log: (line) => console.log(line)
    });
    console.log(formatRestoreVerifyReport(report));
    if (!report.ok) process.exit(1);
  }
} catch (error) {
  console.error(`Restore verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

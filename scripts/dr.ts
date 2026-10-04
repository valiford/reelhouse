// Disaster-recovery CLI: backup, restore, rebuild, status.
//
//   npm run dr -- backup --out var/backups
//   npm run dr -- restore --file var/backups/reelhouse-household-....json --run-id 3
//   npm run dr -- restore --file artifact.json --sha256 <64-hex> --dry-run
//   npm run dr -- rebuild
//   npm run dr -- status
//
// Environment:
//   DATABASE_URL        Application role URL (least privilege, DML only).
//                       Required by every subcommand.
//   JELLYFIN_URL        Base URL of the Jellyfin server (rebuild only).
//   JELLYFIN_API_KEY    Jellyfin API key (rebuild only). Sent only in the
//                       X-Emby-Token header; never echoed, logged, or
//                       written to disk.
//   DR_BACKUP_DIR       Default --out directory for `backup`.
//   DR_RESTORE_FILE     Default --file for `restore` (the CLI argument wins).
// Optional:
//   CATALOG_SYNC_HTTP_TIMEOUT_MS / CATALOG_SYNC_BATCH_SIZE  (rebuild only).
//
// Migrations must already be applied (`npm run db:migrate`). The restore is
// the real household import and the rebuild is the real catalog full sync —
// this CLI adds verification and evidence around them, never a second
// write path. Jellyfin is only ever READ: no command deletes, modifies, or
// touches Jellyfin's internal database. Every echoed value is scrubbed of
// the database URL and Jellyfin secrets.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { loadDatabaseConfig, redactError } from "../src/lib/db/config.ts";
import { createPgSyncExecutor } from "../src/lib/catalog/pg-executor.ts";
import { JellyfinCatalogSource, readCatalogSyncEnv, scrub } from "../src/lib/catalog/source.ts";
import { DrBackupError, runHouseholdBackup } from "../src/lib/dr/backup.ts";
import { DrRestoreError, runHouseholdRestore } from "../src/lib/dr/restore.ts";
import { DrRebuildError, runCatalogRebuild } from "../src/lib/dr/rebuild.ts";
import { drStatus } from "../src/lib/dr/status.ts";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function fail(message: string): never {
  console.error(`dr ${message}`);
  process.exit(1);
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) fail(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      index += 1;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return flags;
}

const args = process.argv.slice(2);
const command = args[0];
const flags = parseFlags(args.slice(1));

const dbResult = loadDatabaseConfig(process.env);
if (dbResult.kind === "unconfigured") {
  fail("is not configured: DATABASE_URL (application role) is unset — see docs/DISASTER_RECOVERY.md");
}
if (dbResult.kind === "invalid") {
  fail(`database configuration was rejected: ${dbResult.errors.join("; ")}`);
}
const db = dbResult.config;

const secrets = [
  process.env.DATABASE_URL?.trim() ?? "",
  process.env.JELLYFIN_URL?.trim() ?? "",
  process.env.JELLYFIN_API_KEY?.trim() ?? ""
];

const pool = new Pool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  database: db.database,
  ssl: db.ssl,
  // Every DR command is sequential; a spare connection is enough.
  max: 2,
  connectionTimeoutMillis: db.connectionTimeoutMs,
  statement_timeout: db.statementTimeoutMs,
  application_name: "reelhouse-dr"
});

async function commandBackup(): Promise<void> {
  const outFlag = flags.get("out");
  if (outFlag !== undefined && typeof outFlag !== "string") fail("backup: --out needs a directory");
  const outDir = (typeof outFlag === "string" ? outFlag : process.env.DR_BACKUP_DIR?.trim()) ?? "";
  if (!outDir) fail("backup: requires --out <directory> (or DR_BACKUP_DIR) — see docs/DISASTER_RECOVERY.md");

  const executor = createPgSyncExecutor(pool);
  const result = await runHouseholdBackup(executor, {
    sink: async (filename, content) => {
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, filename);
      writeFileSync(path, content, "utf8");
      return { path, bytes: Buffer.byteLength(content, "utf8") };
    }
  });
  console.log(
    `dr backup succeeded — run #${result.runId}: ${result.artifactPath} ` +
      `(${result.artifactBytes} bytes, ${result.rowsCaptured} rows)`
  );
  console.log(`dr backup artifact sha256: ${result.artifactSha256}`);
  console.log(`dr backup manifest sha256: ${result.manifestSha256}`);
  console.log(
    "dr backup: record BOTH checksums in the runbook — the restore binds the artifact to one of them"
  );
  console.log(`dr backup counts: ${JSON.stringify(result.counts)}`);
}

async function commandRestore(): Promise<void> {
  const fileFlag = flags.get("file");
  if (fileFlag !== undefined && typeof fileFlag !== "string") fail("restore: --file needs a path");
  const filePath =
    (typeof fileFlag === "string" ? fileFlag : process.env.DR_RESTORE_FILE?.trim()) ?? "";
  if (!filePath) fail("restore: requires --file <artifact.json> (or DR_RESTORE_FILE)");

  const dryRun = flags.has("dry-run");
  const runIdFlag = flags.get("run-id");
  const shaFlag = flags.get("sha256");
  let backupRunId: number | undefined;
  if (runIdFlag !== undefined) {
    const parsed = Number(typeof runIdFlag === "string" ? runIdFlag : NaN);
    if (!Number.isSafeInteger(parsed) || parsed < 1) fail("restore: --run-id must be a positive integer");
    backupRunId = parsed;
  }
  const expectedSha256 = typeof shaFlag === "string" ? shaFlag : undefined;

  let bytes: string;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) fail(`restore: artifact path is not a file: ${filePath}`);
    if (stats.size > MAX_ARTIFACT_BYTES) {
      fail(`restore: artifact exceeds ${MAX_ARTIFACT_BYTES} bytes (${stats.size}) — split the household`);
    }
    bytes = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`restore: cannot read artifact: ${error instanceof Error ? error.message : String(error)}`);
  }

  const executor = createPgSyncExecutor(pool);
  const result = await runHouseholdRestore(executor, {
    bytes,
    artifactPath: filePath,
    dryRun,
    expectedSha256,
    backupRunId
  });
  const scope = result.dryRun
    ? `dry run verified (nothing written, import replay rolled back)`
    : `restored ${result.rowsImported} writes`;
  console.log(
    `dr restore succeeded — run #${result.runId}: ${scope}, ` +
      `manifest sha256 ${result.manifestSha256.slice(0, 16)}… in ${result.durationMs}ms`
  );
  console.log(`dr restore counts: ${JSON.stringify(result.counts)}`);
}

async function commandRebuild(): Promise<void> {
  const jellyfinUrl = process.env.JELLYFIN_URL?.trim() ?? "";
  const jellyfinApiKey = process.env.JELLYFIN_API_KEY?.trim() ?? "";
  if (!jellyfinUrl) fail("rebuild: JELLYFIN_URL is unset — the catalog rebuilds FROM Jellyfin");
  if (!jellyfinApiKey) fail("rebuild: JELLYFIN_API_KEY is unset");

  let tuning: { timeoutMs: number; pageSize: number };
  try {
    tuning = readCatalogSyncEnv(process.env);
  } catch (error) {
    fail(`rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const source = new JellyfinCatalogSource(jellyfinUrl, jellyfinApiKey, fetch, tuning.timeoutMs);
  const executor = createPgSyncExecutor(pool);
  const result = await runCatalogRebuild(source, executor, { pageSize: tuning.pageSize });
  console.log(
    `dr rebuild succeeded — run #${result.runId} (sync run #${result.syncRunId}) verified: ` +
      `libraries=${result.librariesCount} items=${result.itemsCount} changes=${result.changesRecorded} ` +
      `in ${result.durationMs}ms`
  );
}

async function commandStatus(): Promise<void> {
  const executor = createPgSyncExecutor(pool);
  const status = await drStatus(executor);
  console.log(JSON.stringify(status, null, 2));
  if (status.verdicts.length === 0) {
    console.log("dr status: clean — no disaster-recovery verdicts outstanding");
  } else {
    console.log(`dr status verdicts (${status.verdicts.length}): ${status.verdicts.join(", ")}`);
  }
}

try {
  if (command === "backup") await commandBackup();
  else if (command === "restore") await commandRestore();
  else if (command === "rebuild") await commandRebuild();
  else if (command === "status") await commandStatus();
  else {
    fail("requires one of: backup | restore | rebuild | status — see docs/DISASTER_RECOVERY.md");
  }
} catch (error) {
  if (error instanceof DrBackupError) {
    console.error(`dr backup failed — run #${error.summary.runId} recorded as failed`);
    console.error(`dr error: ${scrub(error.summary.errorDetail, secrets)}`);
  } else if (error instanceof DrRestoreError) {
    console.error(
      `dr restore ${error.summary.dryRun ? "(dry run) " : ""}failed — run #${error.summary.runId} recorded as failed`
    );
    console.error(`dr error: ${scrub(error.summary.errorDetail, secrets)}`);
  } else if (error instanceof DrRebuildError) {
    console.error(
      `dr rebuild failed — run #${error.summary.runId} recorded as failed` +
        (error.summary.syncRunId !== undefined ? ` (sync run #${error.summary.syncRunId})` : "")
    );
    console.error(`dr error: ${scrub(error.summary.errorDetail, secrets)}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dr failed: ${scrub(redactError(message, process.env.DATABASE_URL), secrets)}`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}

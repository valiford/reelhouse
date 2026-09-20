// Restore verification for ReelHouse backups (RH-0021).
//
// Given a backup directory produced by snapshot.ts, this module answers one
// question end to end: "does this backup restore into a working database?"
// It never answers that question against production — verification always
// runs against a disposable scratch database (name pinned to rh_restore_*)
// that is created, migrated, loaded, checksum-verified, and dropped.
//
// Phases, all fail-closed in order:
//  1. Offline: manifest validation + checksum sidecar, per-file checksums,
//     line/column shape, staleness. No database is contacted.
//  2. Migration history: the manifest's recorded migrations must equal the
//     local migration tree exactly (both directions).
//  3. Scratch restore: create the disposable database (PostgreSQL 18 is
//     enforced by the migrator itself), apply migrations, load every table
//     in one transaction per table, then recompute checksums FROM the
//     restored database and compare them against the manifest.
//
// Production databases are only ever read by the snapshot writer, never by
// this module: it needs the backup directory and a scratch URL and nothing
// else, so verifying a backup can never damage the systems it came from.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { redactError } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import {
  BACKUP_PATHS,
  backupAgeHours,
  backupDatabaseSpec,
  boundedMessage,
  diffManifestAgainstFileFacts,
  diffManifestAgainstRestoredTable,
  diffMigrationSets,
  maintenanceUrlFor,
  parseScratchDatabaseName,
  RESTORE_VERIFY_URL_VAR,
  sha256Hex,
  validateBackupManifest,
  type BackupDatabaseId,
  type BackupManifest,
  type TableFileFacts,
  type VerifyProblem
} from "./model.ts";
import { scanTableChecksums } from "./snapshot.ts";

export interface OfflineVerification {
  manifest: BackupManifest | null;
  problems: VerifyProblem[];
  ageHours: number | null;
  stale: boolean;
}

export interface VerifyBackupFilesOptions {
  backupDir: string;
  maxAgeHours: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const MAX_LINE_ERRORS_PER_TABLE = 5;

interface ParsedTableFile {
  facts: TableFileFacts;
  rows: Record<string, unknown>[];
}

async function readTableFile(backupDir: string, file: string): Promise<ParsedTableFile | null> {
  let content: string;
  try {
    content = await readFile(join(backupDir, file), "utf8");
  } catch {
    return null;
  }
  const hashLines = content.split("\n");
  if (hashLines[hashLines.length - 1] === "") hashLines.pop();
  const rows: Record<string, unknown>[] = [];
  const lineErrors: string[] = [];
  const checksumLines: string[] = [];
  let columns: string[] | null = null;
  hashLines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (lineErrors.length < MAX_LINE_ERRORS_PER_TABLE) {
        lineErrors.push(`line ${index + 1} is not valid JSON`);
      }
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (lineErrors.length < MAX_LINE_ERRORS_PER_TABLE) lineErrors.push(`line ${index + 1} is not a JSON object`);
      return;
    }
    const row = parsed as Record<string, unknown>;
    if (columns === null) columns = Object.keys(row);
    checksumLines.push(line);
    rows.push(row);
  });
  // The file checksum is recomputed from the canonical lines that parsed
  // cleanly — the same quantity the manifest recorded at snapshot time.
  const sha256 = sha256Hex(checksumLines.map((line) => line + "\n").join(""));
  return { facts: { name: "", rowCount: rows.length, sha256, columns, lineErrors }, rows };
}

export async function verifyBackupFiles(options: VerifyBackupFilesOptions): Promise<OfflineVerification> {
  const log = options.log ?? (() => {});
  const problems: VerifyProblem[] = [];
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(join(options.backupDir, BACKUP_PATHS.manifest), "utf8");
  } catch {
    return { manifest: null, problems: [{ kind: "manifest", database: null, message: `manifest not found at ${BACKUP_PATHS.manifest} under ${options.backupDir}` }], ageHours: null, stale: false };
  }

  const sidecar = await readFile(join(options.backupDir, BACKUP_PATHS.manifestChecksum), "utf8")
    .then((value) => value.trim())
    .catch(() => null);
  const actualManifestSha = sha256Hex(manifestRaw);
  if (sidecar === null) {
    problems.push({ kind: "manifest", database: null, message: `manifest checksum sidecar ${BACKUP_PATHS.manifestChecksum} is missing` });
  } else if (sidecar !== actualManifestSha) {
    problems.push({ kind: "manifest", database: null, message: `manifest checksum mismatch (sidecar ${sidecar}, actual ${actualManifestSha}); the manifest was edited or corrupted` });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    problems.push({ kind: "manifest", database: null, message: "manifest is not valid JSON" });
    return { manifest: null, problems, ageHours: null, stale: false };
  }
  const validated = validateBackupManifest(parsed);
  if (validated.kind === "invalid") {
    for (const message of validated.errors) problems.push({ kind: "manifest", database: null, message });
    return { manifest: null, problems, ageHours: null, stale: false };
  }
  const manifest = validated.manifest;

  const ageHours = backupAgeHours(manifest, options.now?.() ?? new Date());
  const stale = ageHours > options.maxAgeHours;
  if (stale) {
    problems.push({
      kind: "stale",
      database: null,
      message: `backup is ${ageHours.toFixed(1)} hours old, beyond the ${options.maxAgeHours}-hour freshness bound; restore refuses stale backups`
    });
  }

  for (const [databaseId, dbManifest] of Object.entries(manifest.databases)) {
    if (!dbManifest) continue;
    log(`Verifying ${databaseId} files…`);
    const facts = new Map<string, TableFileFacts>();
    for (const table of dbManifest.tables) {
      const parsedFile = await readTableFile(options.backupDir, table.file);
      if (!parsedFile) {
        problems.push({ kind: "file_missing", database: databaseId as BackupDatabaseId, table: table.name, message: `data file ${table.file} is missing` });
        continue;
      }
      const fact: TableFileFacts = { ...parsedFile.facts, name: table.name };
      facts.set(table.name, fact);
    }
    problems.push(...diffManifestAgainstFileFacts(databaseId as BackupDatabaseId, dbManifest, facts));
  }

  return { manifest, problems, ageHours, stale };
}

export interface RestoreVerifyOptions {
  backupDir: string;
  scratchUrl: string;
  // Subset of manifest databases to verify; default: every one in the manifest.
  only?: BackupDatabaseId[];
  keepScratchOnFailure?: boolean;
  // When true the scratch database is left in place even after a passing
  // verification (inspection, follow-on drills); the caller owns dropping it.
  keepScratchOnSuccess?: boolean;
  migrationsDirs: { migrations: string; "migrations-catalog": string };
  // Freshness bound (hours); a backup older than this fails before any
  // database is created. Same variable the offline check reports on.
  maxAgeHours: number;
  pageSize?: number;
  maxPagesPerTable?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RestoreVerifyDatabaseResult {
  id: BackupDatabaseId;
  ok: boolean;
  problems: VerifyProblem[];
  rowCount: number;
  durationMs: number;
}

export interface RestoreVerifyReport {
  ok: boolean;
  scratchDatabase: string | null;
  scratchDropped: boolean;
  offline: OfflineVerification;
  databases: RestoreVerifyDatabaseResult[];
  durationMs: number;
}

function failScratch(message: string, scratchUrl: string): never {
  throw new Error(boundedMessage(redactError(message, scratchUrl)));
}

async function withAdminClient<T>(scratchUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const maintenance = maintenanceUrlFor(scratchUrl);
  if (maintenance.kind === "invalid") failScratch(maintenance.errors.join("; "), scratchUrl);
  const client = new Client({ connectionString: maintenance.url, application_name: "reelhouse-restore-verify", connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    return await fn(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/permission denied|must be (the owner )?superuser|CREATEDB/i.test(message)) {
      failScratch(`the scratch database could not be created; the role in ${RESTORE_VERIFY_URL_VAR} needs the CREATEDB privilege (or pre-create the database): ${message}`, scratchUrl);
    }
    failScratch(`scratch database setup failed: ${message}`, scratchUrl);
  } finally {
    await client.end().catch(() => {});
  }
}

async function withScratchClient<T>(scratchUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: scratchUrl, application_name: "reelhouse-restore-verify", connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function dropScratch(scratchUrl: string, name: string): Promise<void> {
  await withAdminClient(scratchUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

async function readTableRows(backupDir: string, file: string): Promise<Record<string, unknown>[]> {
  const parsed = await readTableFile(backupDir, file);
  if (!parsed) failScratch(`data file ${file} disappeared between verification and load`, "");
  return parsed.rows;
}

async function loadAndVerifyDatabase(input: {
  databaseId: BackupDatabaseId;
  backupDir: string;
  scratchUrl: string;
  manifest: NonNullable<OfflineVerification["manifest"]>;
  migrationsDir: string;
  pageSize: number;
  maxPagesPerTable: number;
  log: (line: string) => void;
}): Promise<RestoreVerifyDatabaseResult> {
  const { databaseId, backupDir, scratchUrl, manifest, migrationsDir, pageSize, maxPagesPerTable, log } = input;
  const started = Date.now();
  const spec = backupDatabaseSpec(databaseId);
  const dbManifest = manifest.databases[databaseId];
  if (!spec || !dbManifest) {
    return { id: databaseId, ok: false, problems: [{ kind: "restore", database: databaseId, message: "database missing from backup manifest" }], rowCount: 0, durationMs: Date.now() - started };
  }

  // Migrations: the scratch database starts empty, so this both proves the
  // local migration tree applies cleanly and reproduces the schema the
  // backup was taken from (the migrator itself refuses pre-18 servers).
  try {
    await runMigrations({ databaseUrl: scratchUrl, migrationsDir, log: (line) => log(`  ${databaseId}: ${line}`) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: databaseId,
      ok: false,
      problems: [{ kind: "migration_set", database: databaseId, message: `migrations failed on the scratch database: ${boundedMessage(message)}` }],
      rowCount: 0,
      durationMs: Date.now() - started
    };
  }

  let rowCount = 0;
  const problems: VerifyProblem[] = [];
  try {
    await withScratchClient(scratchUrl, async (client) => {
      for (const table of dbManifest.tables) {
        const rows = await readTableRows(backupDir, table.file);
        const columns = table.columns;
        await client.query("BEGIN");
        try {
          const insertPrefix = `INSERT INTO "${table.name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES `;
          const batchRows = 500;
          for (let start = 0; start < rows.length; start += batchRows) {
            const batch = rows.slice(start, start + batchRows);
            const rowPlaceholders = batch.map(
              (_, rowIndex) => `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(", ")})`
            );
            const params: unknown[] = [];
            for (const row of batch) for (const column of columns) params.push(row[column] === undefined ? null : row[column]);
            await client.query({ text: insertPrefix + rowPlaceholders.join(", "), values: params });
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        log(`  ${databaseId}/${table.name}: loaded ${rows.length} rows`);
      }
      // Recompute content checksums from the database itself — the same walk
      // the snapshot used — and compare against the manifest. This is what
      // makes a passing verification an end-to-end proof.
      for (let index = 0; index < spec.tables.length; index += 1) {
        const tableSpec = spec.tables[index];
        const tableManifest = dbManifest.tables[index];
        const restored = await scanTableChecksums(client, tableSpec, scratchUrl, pageSize, maxPagesPerTable);
        problems.push(...diffManifestAgainstRestoredTable(databaseId, tableManifest, { rowCount: restored.rowCount, sha256: restored.sha256 }));
        rowCount += restored.rowCount;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push({ kind: "restore", database: databaseId, message: `restore load failed and was rolled back: ${boundedMessage(redactError(message, scratchUrl))}` });
  }

  return { id: databaseId, ok: problems.length === 0, problems, rowCount, durationMs: Date.now() - started };
}

export async function restoreVerify(options: RestoreVerifyOptions): Promise<RestoreVerifyReport> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const pageSize = options.pageSize ?? 1000;
  const maxPagesPerTable = options.maxPagesPerTable ?? 10_000;

  const offline = await verifyBackupFiles({
    backupDir: options.backupDir,
    maxAgeHours: options.maxAgeHours,
    now
  });

  const scratchName = parseScratchDatabaseName(options.scratchUrl);
  if (scratchName.kind === "invalid") {
    throw new Error(`refusing to verify: ${scratchName.errors.join("; ")}`);
  }

  const manifest = offline.manifest;
  const report: RestoreVerifyReport = {
    ok: false,
    scratchDatabase: null,
    scratchDropped: false,
    offline,
    databases: [],
    durationMs: Date.now() - started
  };
  if (!manifest) return report;

  const wanted = options.only ?? (Object.keys(manifest.databases) as BackupDatabaseId[]);
  for (const id of options.only ?? []) {
    if (!manifest.databases[id]) {
      offline.problems.push({ kind: "restore", database: null, message: `--only named "${id}" but the backup does not contain that database` });
    }
  }
  if (offline.problems.length > 0) return report;

  // Migration history must match the local tree before any database is
  // created — a backup taken by different code is not this code's to restore.
  for (const databaseId of wanted) {
    const dbManifest = manifest.databases[databaseId];
    const spec = backupDatabaseSpec(databaseId);
    if (!dbManifest || !spec) continue;
    const localFiles = await loadMigrationFiles(options.migrationsDirs[spec.migrationsDirName]);
    offline.problems.push(...diffMigrationSets(databaseId, dbManifest.migrations, localFiles));
  }
  if (offline.problems.length > 0) return report;

  // Each database gets its own scratch lifecycle (create -> migrate -> load
  // -> verify -> drop), one at a time: the reelhouse and media_catalog
  // schemas are independent migration histories and must never share a
  // database. The first failing database stops the run; its scratch is kept
  // when keepScratchOnFailure is set so the failure can be inspected. On
  // success, keepScratchOnSuccess leaves the FINAL database's scratch in
  // place (inspection, follow-on drills).
  report.scratchDatabase = scratchName.name;
  let failed = false;
  for (let index = 0; index < wanted.length; index += 1) {
    const databaseId = wanted[index];
    const spec = backupDatabaseSpec(databaseId);
    if (!spec) continue;
    log(`Creating scratch database ${scratchName.name} for ${databaseId}…`);
    await withAdminClient(options.scratchUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${scratchName.name}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${scratchName.name}"`);
    });

    let result: RestoreVerifyDatabaseResult;
    try {
      result = await loadAndVerifyDatabase({
        databaseId,
        backupDir: options.backupDir,
        scratchUrl: options.scratchUrl,
        manifest,
        migrationsDir: options.migrationsDirs[spec.migrationsDirName],
        pageSize,
        maxPagesPerTable,
        log
      });
    } catch (error) {
      // An unexpected error must not skip the cleanup decision — treat it
      // as a failure, keep the scratch under the keep flag, and rethrow.
      failed = true;
      const keep = options.keepScratchOnFailure === true;
      if (!keep) await dropScratch(options.scratchUrl, scratchName.name);
      report.scratchDropped = !keep;
      throw error;
    }

    report.databases.push(result);
    if (!result.ok) {
      failed = true;
      if (options.keepScratchOnFailure === true) {
        log(`Scratch database ${scratchName.name} kept for inspection; drop it manually when done`);
        report.scratchDropped = false;
        break;
      }
      await dropScratch(options.scratchUrl, scratchName.name);
      report.scratchDropped = true;
      break;
    }

    const isLast = index === wanted.length - 1;
    if (isLast && options.keepScratchOnSuccess === true) {
      log(`Scratch database ${scratchName.name} kept for inspection; drop it manually when done`);
      report.scratchDropped = false;
    } else {
      await dropScratch(options.scratchUrl, scratchName.name);
      report.scratchDropped = true;
    }
  }

  report.ok = !failed && report.databases.length > 0;
  report.durationMs = Date.now() - started;
  return report;
}

export function formatRestoreVerifyReport(report: RestoreVerifyReport): string {
  const lines: string[] = [];
  for (const problem of report.offline.problems) {
    const scope = problem.table ? `${problem.database}/${problem.table}` : problem.database ?? "backup";
    lines.push(`[FAIL] ${scope}: ${problem.message}`);
  }
  for (const database of report.databases) {
    lines.push(`[${database.ok ? "PASS" : "FAIL"}] ${database.id}: ${database.rowCount} rows restored and verified (${database.durationMs} ms)`);
    for (const problem of database.problems) {
      const scope = problem.table ? `${problem.database}/${problem.table}` : problem.database ?? "restore";
      lines.push(`[FAIL] ${scope}: ${problem.message}`);
    }
  }
  if (report.scratchDatabase) {
    lines.push(`Scratch database: ${report.scratchDatabase}${report.scratchDropped ? " (dropped)" : report.ok ? " (dropped)" : " (kept)"}`);
  }
  lines.push(report.ok ? "RESTORE VERIFY OK" : "RESTORE VERIFY FAILED");
  return lines.join("\n");
}

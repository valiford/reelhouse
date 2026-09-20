// Backup snapshot writer for the reelhouse and media_catalog databases.
//
// I/O half of src/lib/backup/model.ts (RH-0021): reads each registered table
// in primary-key order through a collation-pinned keyset walk, writes one
// canonical JSONL file per table, and records a self-describing manifest with
// per-table checksums, the migration history, and freshness markers. See
// docs/BACKUP_RESTORE.md.
//
// Safety model:
// - Read-only against the source databases; the only writes are the backup
//   directory files. Jellyfin is never contacted, the reelhouse database
//   never receives catalog content and vice versa.
// - Output directories must be new or empty; an existing backup is never
//   overwritten or merged into.
// - A table that cannot be read in full fails the whole backup; the manifest
//   (and its checksum sidecar) is only written after every file is complete.
// - Every error is redacted against the database URL and bounded before it
//   leaves this module.

import { createHash } from "node:crypto";
import { open, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import { redactDatabaseUrl, redactError } from "../db/config.ts";
import {
  BACKUP_PATHS,
  BACKUP_TOOL,
  backupDatabaseSpec,
  boundedMessage,
  buildBackupManifest,
  canonicalRowJson,
  JSONL_TERMINATOR,
  tableChecksum,
  tableFilePath,
  type BackupDatabaseId,
  type BackupDatabaseManifest,
  type BackupTableSpec
} from "./model.ts";

export interface RunBackupDatabaseInput {
  id: BackupDatabaseId;
  databaseUrl: string;
}

export interface RunBackupOptions {
  databases: RunBackupDatabaseInput[];
  outDir: string;
  now?: () => Date;
  log?: (line: string) => void;
  pageSize?: number;
  maxPagesPerTable?: number;
}

export interface RunBackupResult {
  outDir: string;
  manifestPath: string;
  manifestSha256: string;
  databases: {
    id: BackupDatabaseId;
    pgVersion: string;
    tables: { name: string; rowCount: number; sha256: string }[];
    freshness: BackupDatabaseManifest["freshness"];
  }[];
  durationMs: number;
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES_PER_TABLE = 10_000;

// format_type() names for columns whose ordering depends on collation.
const TEXT_TYPE_PATTERN = /^(text|character)/;

function fail(message: string, databaseUrl: string): never {
  throw new Error(boundedMessage(redactError(message, databaseUrl)));
}

async function prepareOutputDir(outDir: string): Promise<void> {
  let existing;
  try {
    existing = await stat(outDir);
  } catch {
    await mkdir(outDir, { recursive: true });
    return;
  }
  if (!existing.isDirectory()) throw new Error(`backup output path is not a directory: ${outDir}`);
  const entries = await readdir(outDir);
  if (entries.length > 0) throw new Error(`backup output directory is not empty: ${outDir}; choose a fresh directory`);
}

// Primary-key columns with their on-disk types, in key order. Text columns
// are ordered under COLLATE "C" so snapshot and restore verification sort
// identically no matter which server or collation they run against —
// checksums must be reproducible across machines.
async function loadKeyColumns(client: Client, table: BackupTableSpec, databaseUrl: string): Promise<KeyColumn[]> {
  const result = await client.query<{ name: string; type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_index i
     CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = $1::regclass AND i.indisprimary
     ORDER BY k.ord`,
    [`public.${table.name}`]
  );
  if (result.rows.length !== table.keyColumns.length) {
    fail(
      `table ${table.name}: primary key has ${result.rows.length} columns, backup registry expects ${table.keyColumns.length}; refusing to snapshot a schema the registry does not describe`,
      databaseUrl
    );
  }
  return result.rows.map((row, index) => {
    if (row.name !== table.keyColumns[index]) {
      fail(`table ${table.name}: primary key column ${index + 1} is "${row.name}", registry expects "${table.keyColumns[index]}"`, databaseUrl);
    }
    const orderExpression = TEXT_TYPE_PATTERN.test(row.type) ? `"${row.name}" COLLATE "C"` : `"${row.name}"`;
    return { name: row.name, orderExpression };
  });
}

interface KeyColumn {
  name: string;
  orderExpression: string;
}

interface TableScanResult {
  rowCount: number;
  sha256: string;
  columns: string[];
}

// Shared keyset walk: visits every row of a table in collation-pinned
// primary-key order, feeding the canonical line of each row to `onPage`.
// Both the snapshot writer and the restore verification use this, so their
// checksums are computed by exactly the same code path.
async function walkTable(
  client: Client,
  table: BackupTableSpec,
  databaseUrl: string,
  pageSize: number,
  maxPages: number,
  onPage: (pageText: string, rows: Record<string, unknown>[]) => Promise<void>
): Promise<TableScanResult> {
  const keys = await loadKeyColumns(client, table, databaseUrl);
  const checksum = tableChecksum();
  let columns: string[] | null = null;
  let rowCount = 0;
  let lastKeyValue: unknown[] | null = null;
  for (let page = 1; ; page += 1) {
    if (page > maxPages) {
      fail(`table ${table.name}: exceeded ${maxPages} pages of ${pageSize} rows; refusing to continue with a silently truncated view`, databaseUrl);
    }
    const values: unknown[] = lastKeyValue ?? [];
    const tuple = keys.map((key) => key.orderExpression).join(", ");
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
    const where = lastKeyValue === null ? "" : ` WHERE (${tuple}) > (${placeholders})`;
    const order = ` ORDER BY ${keys.map((key) => `${key.orderExpression} ASC`).join(", ")}`;
    // Explicit result annotation: the query argument embeds lastKeyValue's
    // history, and letting the compiler infer the result type from the
    // overload set makes that cycle circular.
    const result: QueryResult<Record<string, unknown>> = await client.query<Record<string, unknown>>({
      text: `SELECT * FROM "${table.name}"${where}${order} LIMIT ${pageSize}`,
      values
    });
    if (columns === null) columns = result.fields.map((field) => field.name);
    if (result.rows.length === 0) break;

    let pageText = "";
    for (const row of result.rows) {
      const line = canonicalRowJson(row);
      checksum.update(line);
      pageText += line + JSONL_TERMINATOR;
      lastKeyValue = keys.map((key) => (row[key.name] === undefined ? null : row[key.name]));
      rowCount += 1;
    }
    await onPage(pageText, result.rows);
    if (result.rows.length < pageSize) break;
  }
  return { rowCount, sha256: checksum.digest(), columns: columns ?? [] };
}

async function scanTable(
  client: Client,
  table: BackupTableSpec,
  filePath: string,
  databaseUrl: string,
  pageSize: number,
  maxPages: number
): Promise<TableScanResult> {
  // Probe the key columns before opening the file so a schema/registry
  // mismatch fails without leaving a partial data file behind.
  await loadKeyColumns(client, table, databaseUrl);
  const handle = await open(filePath, "w");
  try {
    return await walkTable(client, table, databaseUrl, pageSize, maxPages, async (pageText) => {
      await handle.write(pageText, null, "utf8");
    });
  } finally {
    await handle.close();
  }
}

// Checksum-only walk against a restored scratch database (no file writes).
export async function scanTableChecksums(
  client: Client,
  table: BackupTableSpec,
  databaseUrl: string,
  pageSize: number,
  maxPages: number
): Promise<TableScanResult> {
  return walkTable(client, table, databaseUrl, pageSize, maxPages, async () => {});
}

async function latestUpdatedAt(client: Client, tables: string[]): Promise<string | null> {
  const withColumn = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'updated_at' AND table_name = ANY($1)`,
    [tables]
  );
  let latest: Date | null = null;
  for (const row of withColumn.rows) {
    const result = await client.query<{ t: Date | null }>(`SELECT max(updated_at) AS t FROM "${row.table_name}"`);
    const value = result.rows[0]?.t ?? null;
    if (value && (latest === null || value > latest)) latest = value;
  }
  return latest === null ? null : latest.toISOString();
}

async function lastSuccessfulScanAt(client: Client): Promise<string | null> {
  const result = await client.query<{ t: Date | null }>(`SELECT max(finished_at) AS t FROM catalog_scan WHERE status = 'succeeded'`);
  const value = result.rows[0]?.t ?? null;
  return value === null ? null : value.toISOString();
}

async function readMigrationHistory(client: Client, databaseUrl: string): Promise<{ name: string; checksum: string }[]> {
  let history;
  try {
    history = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations ORDER BY name");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/relation .* does not exist/i.test(message)) {
      fail("database has no schema_migrations history; run db:migrate (or catalog:migrate) before taking a backup", databaseUrl);
    }
    fail(`failed to read migration history: ${message}`, databaseUrl);
  }
  return history.rows.map((row) => ({ name: String(row.name), checksum: String(row.checksum) }));
}

interface SnapshotDatabaseResult {
  id: BackupDatabaseId;
  pgVersion: string;
  urlLabel: string;
  migrations: { name: string; checksum: string }[];
  freshness: BackupDatabaseManifest["freshness"];
  tables: { name: string; rowCount: number; sha256: string }[];
  tableManifests: BackupDatabaseManifest["tables"];
}

async function snapshotDatabase(
  input: RunBackupDatabaseInput,
  options: { outDir: string; pageSize: number; maxPagesPerTable: number }
): Promise<SnapshotDatabaseResult> {
  const spec = backupDatabaseSpec(input.id);
  if (!spec) throw new Error(`unknown backup database "${input.id}"`);

  const client = new Client({
    connectionString: input.databaseUrl,
    application_name: `${BACKUP_TOOL}-${input.id}`,
    connectionTimeoutMillis: 10_000
  });
  try {
    try {
      await client.connect();
    } catch (error) {
      fail(`could not connect for backup: ${error instanceof Error ? error.message : String(error)}`, input.databaseUrl);
    }

    let serverVersion = "";
    try {
      const version = await client.query<QueryResultRow>("SHOW server_version");
      serverVersion = String(version.rows[0].server_version);
    } catch (error) {
      fail(`failed to read server version: ${error instanceof Error ? error.message : String(error)}`, input.databaseUrl);
    }

    const migrations = await readMigrationHistory(client, input.databaseUrl);
    await mkdir(join(options.outDir, input.id), { recursive: true });

    const tables: SnapshotDatabaseResult["tables"] = [];
    const tableManifests: BackupDatabaseManifest["tables"] = [];
    for (let index = 0; index < spec.tables.length; index += 1) {
      const tableSpec = spec.tables[index];
      const file = tableFilePath(input.id, index, tableSpec.name);
      const scan = await scanTable(client, tableSpec, join(options.outDir, file), input.databaseUrl, options.pageSize, options.maxPagesPerTable);
      tables.push({ name: tableSpec.name, rowCount: scan.rowCount, sha256: scan.sha256 });
      tableManifests.push({ name: tableSpec.name, file, rowCount: scan.rowCount, sha256: scan.sha256, columns: scan.columns });
    }

    const freshness: BackupDatabaseManifest["freshness"] = {
      latestUpdatedAt: await latestUpdatedAt(client, spec.tables.map((table) => table.name)),
      lastSuccessfulScanAt: input.id === "media_catalog" ? await lastSuccessfulScanAt(client) : null
    };

    return { id: input.id, pgVersion: serverVersion, urlLabel: redactDatabaseUrl(input.databaseUrl), migrations, freshness, tables, tableManifests };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runBackup(options: RunBackupOptions): Promise<RunBackupResult> {
  if (options.databases.length === 0) throw new Error("no database targets given for backup");
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPagesPerTable = options.maxPagesPerTable ?? DEFAULT_MAX_PAGES_PER_TABLE;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const started = Date.now();

  await prepareOutputDir(options.outDir);

  const databases: RunBackupResult["databases"] = [];
  const databaseManifests: Partial<Record<BackupDatabaseId, BackupDatabaseManifest>> = {};
  for (const input of options.databases) {
    log(`Backing up ${input.id}…`);
    const result = await snapshotDatabase(input, { outDir: options.outDir, pageSize, maxPagesPerTable });
    for (const table of result.tables) log(`  ${table.name}: ${table.rowCount} rows (${table.sha256.slice(0, 12)}…)`);
    databaseManifests[result.id] = {
      urlLabel: result.urlLabel,
      pgVersion: result.pgVersion,
      migrations: result.migrations,
      freshness: result.freshness,
      tables: result.tableManifests
    };
    databases.push({ id: result.id, pgVersion: result.pgVersion, tables: result.tables, freshness: result.freshness });
  }

  const manifest = buildBackupManifest({ createdAt: now(), databases: databaseManifests });
  const manifestJson = JSON.stringify(manifest, null, 2) + JSONL_TERMINATOR;
  const manifestPath = join(options.outDir, BACKUP_PATHS.manifest);
  await writeFile(manifestPath, manifestJson, "utf8");
  const manifestSha256 = createHash("sha256").update(manifestJson, "utf8").digest("hex");
  await writeFile(join(options.outDir, BACKUP_PATHS.manifestChecksum), manifestSha256 + JSONL_TERMINATOR, "utf8");

  log(`Manifest written (${manifestSha256.slice(0, 12)}…)`);
  return { outDir: options.outDir, manifestPath, manifestSha256, databases, durationMs: Date.now() - started };
}

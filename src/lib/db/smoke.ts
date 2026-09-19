// End-to-end database smoke check for the ReelHouse PostgreSQL 18 layer.
//
// One command that wires RH-0002's connection layer and RH-0003's migration
// system to a real target and proves, stage by stage: configuration,
// connectivity, migrations (applied + idempotent re-run), pooling, bounded
// statement cancellation, and transactional rollback/commit semantics.
//
// Split design mirrors migrator.ts: the report types, formatting, and stage
// helpers below are pure and unit-testable; only runSmoke() touches
// PostgreSQL. This module deliberately avoids `server-only` and the `@/`
// alias so the CLI (scripts/db-smoke.ts) and tests can import it under
// plain Node. The runtime app boundary (pool.ts) stays untouched — the smoke
// validates the same environment-driven configuration the app reads.
//
// Safety model (see docs/DB_SMOKE.md):
// - The only persistent change a smoke run can make is applying the
//   versioned forward-only migrations (their whole purpose).
// - Pool and transaction probes use TEMP tables and SELECT-only statements;
//   nothing they create survives the session.
// - Every message that can reach the report passes redactError() with the
//   raw URL, so credentials never appear in output; the target is only ever
//   named through describeDatabaseConfig().

import { Pool, Client } from "pg";
import {
  describeDatabaseConfig,
  loadDatabaseConfig,
  redactError,
  type DatabaseConfig
} from "./config.ts";
import {
  MIN_PG_VERSION_NUM,
  postgresVersionNum,
  runMigrations
} from "./migrator.ts";

export type SmokeStageState = "pass" | "fail" | "skip";

export interface SmokeStageResult {
  stage: string;
  state: SmokeStageState;
  /** Redacted, single-line human detail. Never carries credentials. */
  detail?: string;
  durationMs?: number;
}

export interface SmokeReport {
  /** Redacted target summary, e.g. postgresql://user:***@host:5432/db ... */
  target?: string;
  stages: SmokeStageResult[];
  ok: boolean;
}

export interface RunSmokeOptions {
  /**
   * Environment read for DATABASE_URL / MIGRATION_DATABASE_URL and the
   * bounded DATABASE_* overrides. Defaults to process.env; tests inject a
   * record instead of mutating shared state.
   */
  env?: Record<string, string | undefined>;
  migrationsDir: string;
  /** Coarse watchdog for the whole run; individual stages are bounded by
   *  the configured connect/statement timeouts. Default 120000 ms. */
  timeoutMs?: number;
  /** Statement-cancellation probe budget. Default 1500 ms. */
  statementTimeoutProbeMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_SMOKE_TIMEOUT_MS = 120_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded the ${timeoutMs} ms smoke watchdog`)),
      timeoutMs
    );
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

export function formatSmokeReport(report: SmokeReport): string {
  const lines: string[] = [];
  if (report.target) lines.push(`Target: ${report.target}`);
  for (const stage of report.stages) {
    const ms = stage.durationMs === undefined ? "" : ` (${stage.durationMs} ms)`;
    const detail = stage.detail ? ` — ${stage.detail}` : "";
    lines.push(`[${stage.state.toUpperCase()}] ${stage.stage}${ms}${detail}`);
  }
  lines.push(report.ok ? "SMOKE OK" : "SMOKE FAILED");
  return lines.join("\n");
}

/** Aggregates stage outcomes: any fail (or zero executed stages) fails the run. */
export function summarizeStages(stages: SmokeStageResult[]): { ok: boolean } {
  if (stages.length === 0) return { ok: false };
  return { ok: stages.every((stage) => stage.state === "pass") };
}

interface StageContext {
  stages: SmokeStageResult[];
  log: (line: string) => void;
  rawUrls: string[];
  watchdogMs: number;
}

async function runStage(
  context: StageContext,
  stage: string,
  execute: () => Promise<string | undefined>
): Promise<void> {
  const started = Date.now();
  try {
    const detail = await withTimeout(execute(), context.watchdogMs, stage);
    context.stages.push({
      stage,
      state: "pass",
      detail,
      durationMs: Date.now() - started
    });
    context.log(`[pass] ${stage} (${Date.now() - started} ms)${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const raw = errorMessage(error);
    const detail = redactError(raw, context.rawUrls.find((url) => raw.includes(url)));
    context.stages.push({
      stage,
      state: "fail",
      detail,
      durationMs: Date.now() - started
    });
    context.log(`[fail] ${stage} (${Date.now() - started} ms) — ${detail}`);
  }
}

function skipStage(context: StageContext, stage: string, reason: string): void {
  context.stages.push({ stage, state: "skip", detail: reason });
  context.log(`[skip] ${stage} — ${reason}`);
}

// Mirrors pool.ts createPool(): the app's exact pool semantics (bounds,
// timeouts, application_name) built from the same validated configuration,
// without importing the server-only module.
function createSmokePool(config: DatabaseConfig, applicationName: string): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs,
    application_name: applicationName
  });
}

async function executeConnectStage(config: DatabaseConfig): Promise<string> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    application_name: "reelhouse-smoke-connect"
  });
  try {
    await client.connect();
    const started = Date.now();
    await client.query("SELECT 1");
    const latencyMs = Date.now() - started;
    const version = await client.query<{ server_version: string }>("SHOW server_version");
    const serverVersion = version.rows[0].server_version;
    const versionNum = postgresVersionNum(serverVersion);
    if (versionNum < MIN_PG_VERSION_NUM) {
      throw new Error(
        `PostgreSQL 18 or newer is required (server reports ${serverVersion}); refusing to smoke this target`
      );
    }
    return `latencyMs:${latencyMs}, server:PostgreSQL ${serverVersion}`;
  } finally {
    await client.end().catch(() => {});
  }
}

async function executeMigrationsStage(
  config: DatabaseConfig,
  migrationUrl: string,
  migrationsDir: string,
  log: (line: string) => void
): Promise<string> {
  const first = await runMigrations({
    databaseUrl: migrationUrl,
    migrationsDir,
    log
  });
  // Idempotency probe: an immediate repeat must apply nothing and must not
  // report pending work — this is the duplicate/repeat regression path.
  const second = await runMigrations({
    databaseUrl: migrationUrl,
    migrationsDir,
    log: () => {}
  });
  if (second.applied.length !== 0 || second.pendingCount !== 0) {
    throw new Error(
      `Repeat migration run is not idempotent: applied ${second.applied.length}, pending ${second.pendingCount} (expected 0/0)`
    );
  }
  return `${first.applied.length} applied, ${first.alreadyApplied} already applied, repeat run clean, history verified`;
}

async function executePoolStage(config: DatabaseConfig, probeTimeoutMs: number): Promise<string> {
  const pool = createSmokePool(config, "reelhouse-smoke-pool");
  try {
    // Concurrency probe: one round-trip per pool slot, each carrying its own
    // payload so responses cannot be crossed without detection.
    const payloads = Array.from({ length: config.poolMax }, (_, index) => index);
    const results = await Promise.all(
      payloads.map(async (payload) => {
        const result = await pool.query<{ payload: number }>("SELECT $1::int AS payload", [payload]);
        if (result.rows[0].payload !== payload) {
          throw new Error(`Pool probe response crossed: sent ${payload}, got ${result.rows[0].payload}`);
        }
        return result;
      })
    );
    if (pool.totalCount > config.poolMax) {
      throw new Error(`Pool exceeded its configured max: ${pool.totalCount} > ${config.poolMax}`);
    }

    // Bounded-cancellation probe: on one dedicated session, shrink the
    // statement timeout and prove the server actually cancels work that
    // exceeds it (SQLSTATE 57014). Leaves the session-wide setting behind
    // only until the client is released.
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(probeTimeoutMs)]);
      const sleepSeconds = (probeTimeoutMs / 1000 + 0.5).toFixed(2);
      let canceled = false;
      try {
        await client.query(`SELECT pg_sleep(${sleepSeconds})`);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
        if (code !== "57014") {
          throw new Error(`Expected SQLSTATE 57014 from the cancellation probe, got: ${errorMessage(error)}`);
        }
        canceled = true;
      }
      if (!canceled) {
        throw new Error(
          `Statement ran past the ${probeTimeoutMs} ms probe timeout without being canceled`
        );
      }
    } finally {
      client.release();
    }

    return `${results.length}/${config.poolMax} concurrent queries ok, poolMax respected, statement cancellation enforced`;
  } finally {
    await pool.end();
  }
}

async function executeTransactionsStage(config: DatabaseConfig): Promise<string> {
  // TEMP tables are session-scoped and the session closes in the finally
  // block, so this stage cannot leave objects behind even on failure.
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs,
    application_name: "reelhouse-smoke-transactions"
  });
  try {
    await client.connect();
    await client.query("CREATE TEMP TABLE smoke_tx_probe (v integer NOT NULL)");
    const count = async (): Promise<number> => {
      const result = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM smoke_tx_probe");
      return Number.parseInt(result.rows[0].n, 10);
    };

    await client.query("BEGIN");
    await client.query("INSERT INTO smoke_tx_probe (v) VALUES (1), (2)");
    await client.query("ROLLBACK");
    const afterRollback = await count();
    if (afterRollback !== 0) {
      throw new Error(`ROLLBACK left ${afterRollback} row(s) behind (expected 0)`);
    }

    await client.query("BEGIN");
    await client.query("INSERT INTO smoke_tx_probe (v) VALUES (3)");
    await client.query("COMMIT");
    const afterCommit = await count();
    if (afterCommit !== 1) {
      throw new Error(`COMMIT lost rows: ${afterCommit} present (expected 1)`);
    }

    // Error path: a failure inside a transaction must not partial-apply.
    await client.query("BEGIN");
    await client.query("INSERT INTO smoke_tx_probe (v) VALUES (4)");
    try {
      await client.query("SELECT 1/0");
    } catch {
      // expected division-by-zero; the transaction is now aborted
    }
    await client.query("ROLLBACK");
    const afterError = await count();
    if (afterError !== 1) {
      throw new Error(`Aborted transaction partial-applied: ${afterError} row(s) present (expected 1)`);
    }

    return "rollback, commit, and aborted-transaction semantics verified on a session-scoped TEMP table";
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runSmoke(options: RunSmokeOptions): Promise<SmokeReport> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const watchdogMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const probeTimeoutMs = options.statementTimeoutProbeMs ?? 1_500;

  const context: StageContext = {
    stages: [],
    log,
    // Every URL the run can use is registered for redaction.
    rawUrls: [env.DATABASE_URL?.trim(), env.MIGRATION_DATABASE_URL?.trim()].filter(
      (url): url is string => Boolean(url)
    ),
    watchdogMs
  };

  const configResult = loadDatabaseConfig(env);
  let config: DatabaseConfig | undefined;
  if (configResult.kind === "valid") {
    config = configResult.config;
  }

  const databaseConfigured = configResult.kind === "valid";
  if (databaseConfigured) {
    await runStage(context, "config", async () => describeDatabaseConfig(config!));
  } else if (configResult.kind === "unconfigured") {
    context.stages.push({
      stage: "config",
      state: "fail",
      detail: "No database configured: set DATABASE_URL (smoke has no target and fails closed)"
    });
    log("[fail] config — no DATABASE_URL configured");
  } else {
    context.stages.push({
      stage: "config",
      state: "fail",
      detail: `Configuration rejected: ${configResult.errors.join("; ")}`
    });
    log(`[fail] config — ${configResult.errors.join("; ")}`);
  }

  if (!databaseConfigured) {
    for (const stage of ["connect", "migrations", "pool", "transactions"]) {
      skipStage(context, stage, "configuration failed");
    }
    return { stages: context.stages, ok: summarizeStages(context.stages).ok };
  }

  const migrationUrl = env.MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL!.trim();

  let connectDetail: string | undefined;
  await runStage(context, "connect", async () => {
    connectDetail = await executeConnectStage(config!);
    return connectDetail;
  });

  if (connectDetail === undefined) {
    for (const stage of ["migrations", "pool", "transactions"]) {
      skipStage(context, stage, "connect failed");
    }
    return { stages: context.stages, ok: summarizeStages(context.stages).ok };
  }

  await runStage(context, "migrations", () =>
    executeMigrationsStage(config!, migrationUrl, options.migrationsDir, log)
  );
  await runStage(context, "pool", () => executePoolStage(config!, probeTimeoutMs));
  await runStage(context, "transactions", () => executeTransactionsStage(config!));

  return { stages: context.stages, ok: summarizeStages(context.stages).ok };
}

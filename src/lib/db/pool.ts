import "server-only";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import {
  describeDatabaseConfig,
  loadDatabaseConfig,
  redactError,
  type DatabaseConfig
} from "./config";

// Server-side PostgreSQL boundary for ReelHouse. Importing this module from a
// Client Component fails the build ("server-only"), so DATABASE_URL and the
// credentials it carries can never reach the browser bundle. The pool is the
// only runtime object holding credentials, and it lives for the process
// lifetime; nothing here serializes connection state into any response.

export type DatabaseState = "unconfigured" | "invalid" | "reachable" | "unreachable";

export interface DatabaseHealth {
  state: DatabaseState;
  latencyMs?: number;
  detail?: string;
  configSummary?: string;
}

// Cached on globalThis so Next.js dev-mode module reloads reuse one pool
// instead of leaking a fresh pool (and its connections) per reload.
const globalForDb = globalThis as typeof globalThis & { __reelhousePool?: Pool };

function createPool(config: DatabaseConfig): Pool {
  const pool = new Pool({
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
    application_name: "reelhouse"
  });
  // Without this handler an errored idle client escapes as an unhandled
  // exception and can take the whole server process down.
  pool.on("error", (error) => {
    console.error("ReelHouse database pool error:", redactError(error.message, process.env.DATABASE_URL));
  });
  return pool;
}

// Fails closed: unconfigured or invalid configuration throws instead of
// returning a degraded pool. Never fall back to demo data here — the demo
// fallback belongs to the Jellyfin integration only, and callers that must
// degrade use checkDatabase() to branch on state as data.
export function getPool(): Pool {
  if (globalForDb.__reelhousePool) return globalForDb.__reelhousePool;
  const result = loadDatabaseConfig(process.env);
  if (result.kind === "unconfigured") {
    throw new Error("Database is not configured (DATABASE_URL is unset); database-backed features are unavailable");
  }
  if (result.kind === "invalid") {
    throw new Error(`Database configuration is invalid and was rejected: ${result.errors.join("; ")}`);
  }
  const pool = createPool(result.config);
  globalForDb.__reelhousePool = pool;
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

// Readiness probe used by /api/health. Bounded by the configured connect and
// statement timeouts; every reported string is redacted before leaving here.
export async function checkDatabase(): Promise<DatabaseHealth> {
  const result = loadDatabaseConfig(process.env);
  if (result.kind === "unconfigured") return { state: "unconfigured" };
  if (result.kind === "invalid") return { state: "invalid", detail: result.errors.join("; ") };

  const configSummary = describeDatabaseConfig(result.config);
  try {
    const started = Date.now();
    await getPool().query("SELECT 1");
    return { state: "reachable", latencyMs: Date.now() - started, configSummary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unreachable", detail: redactError(message, process.env.DATABASE_URL), configSummary };
  }
}

// For tests and graceful shutdown; the next getPool() call recreates the pool.
export async function closePool(): Promise<void> {
  const pool = globalForDb.__reelhousePool;
  globalForDb.__reelhousePool = undefined;
  if (pool) await pool.end();
}

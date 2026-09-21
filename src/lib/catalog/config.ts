// Configuration for the Jellyfin -> media_catalog synchronization.
//
// Same philosophy as src/lib/db/config.ts: pure parsing/validation, no I/O,
// fail closed. The catalog database has its own credential variable because
// it is a separate PostgreSQL database from reelhouse (docs/ARCHITECTURE.md);
// it reuses the reelhouse config rules by remapping MEDIA_CATALOG_* variables
// onto the DATABASE_URL/DATABASE_SSL names, so validation and redaction live
// in exactly one place and the sync can never silently fall back to the
// household database's credentials.
//
// Jellyfin access uses a server-scoped API key (never a user token, never
// stored in the database). Nothing here is marked `server-only`: the sync
// runs as a CLI batch job (scripts/catalog-sync.ts) and under `node --test`.

import {
  loadDatabaseConfig,
  redactDatabaseUrl,
  type DatabaseConfig,
  type DatabaseConfigResult
} from "../db/config.ts";

export const CATALOG_URL_VAR = "MEDIA_CATALOG_DATABASE_URL";
export const CATALOG_SSL_VAR = "MEDIA_CATALOG_DATABASE_SSL";
export const CATALOG_MIGRATE_URL_VAR = "MEDIA_CATALOG_MIGRATE_URL";
export const CATALOG_APP_ROLE_VAR = "MEDIA_CATALOG_APP_ROLE";

// Catalog credentials come ONLY from MEDIA_CATALOG_* variables. A blank
// MEDIA_CATALOG_DATABASE_URL means unconfigured even when DATABASE_URL is
// set: writing catalog rows into the reelhouse database would break the
// data-authority boundary, so there is deliberately no fallback.
export function loadCatalogDatabaseConfig(env: Record<string, string | undefined>): DatabaseConfigResult {
  const catalogUrl = env[CATALOG_URL_VAR]?.trim();
  if (!catalogUrl) return { kind: "unconfigured" };
  const remapped: Record<string, string | undefined> = {
    ...env,
    DATABASE_URL: catalogUrl
  };
  const catalogSsl = env[CATALOG_SSL_VAR]?.trim();
  if (catalogSsl) remapped.DATABASE_SSL = catalogSsl;
  return loadDatabaseConfig(remapped);
}

// Migrator override for the catalog database, mirroring the reelhouse
// DATABASE_MIGRATE_URL pattern: explicit owner URL wins, otherwise the sync
// role URL is used (single-role local setups).
export function loadCatalogMigrateConfig(env: Record<string, string | undefined>): DatabaseConfigResult {
  const migrateUrl = env[CATALOG_MIGRATE_URL_VAR]?.trim();
  if (migrateUrl) {
    return loadCatalogDatabaseConfig({ ...env, [CATALOG_URL_VAR]: migrateUrl });
  }
  return loadCatalogDatabaseConfig(env);
}

export function describeCatalogDatabaseConfig(config: DatabaseConfig): string {
  const ssl = config.ssl ? (config.ssl.rejectUnauthorized ? "verify" : "require") : "disable";
  return `postgresql://${config.user || "(no user)"}:***@${config.host}:${config.port}/${config.database} ssl=${ssl} poolMax=${config.poolMax} via=${CATALOG_URL_VAR}`;
}

export type JellyfinSyncConfigResult =
  | { kind: "unconfigured" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "valid"; config: JellyfinSyncConfig };

export interface JellyfinSyncConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
}

const JELLYFIN_DEFAULTS = { requestTimeoutMs: 30_000 } as const;
const JELLYFIN_LIMITS = { requestTimeoutMs: { min: 1_000, max: 120_000 } } as const;

export const JELLYFIN_URL_VAR = "JELLYFIN_URL";
export const JELLYFIN_API_KEY_VAR = "JELLYFIN_API_KEY";
export const JELLYFIN_TIMEOUT_VAR = "JELLYFIN_SYNC_TIMEOUT_MS";

export function loadJellyfinSyncConfig(env: Record<string, string | undefined>): JellyfinSyncConfigResult {
  const rawUrl = env[JELLYFIN_URL_VAR]?.trim().replace(/\/+$/, "");
  const apiKey = env[JELLYFIN_API_KEY_VAR]?.trim();
  const errors: string[] = [];

  if (!rawUrl || !apiKey) return { kind: "unconfigured" };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "invalid", errors: [`${JELLYFIN_URL_VAR} is not a valid URL`] };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push(`${JELLYFIN_URL_VAR} must use http:// or https:// (got ${url.protocol})`);
  }

  let requestTimeoutMs: number = JELLYFIN_DEFAULTS.requestTimeoutMs;
  const rawTimeout = env[JELLYFIN_TIMEOUT_VAR]?.trim();
  if (rawTimeout) {
    if (!/^\d+$/.test(rawTimeout)) {
      errors.push(`${JELLYFIN_TIMEOUT_VAR} must be a positive integer (got "${rawTimeout}")`);
    } else {
      const value = Number(rawTimeout);
      const { min, max } = JELLYFIN_LIMITS.requestTimeoutMs;
      if (value < min || value > max) {
        errors.push(`${JELLYFIN_TIMEOUT_VAR} must be between ${min} and ${max} (got ${value})`);
      } else {
        requestTimeoutMs = value;
      }
    }
  }

  if (errors.length) return { kind: "invalid", errors };
  return { kind: "valid", config: { baseUrl: rawUrl, apiKey, requestTimeoutMs } };
}

// Logs may name the Jellyfin server but never carry the key; the URL itself
// contains no credential, so host+timeout-only description keeps it that way.
export function describeJellyfinSyncConfig(config: JellyfinSyncConfig): string {
  let host: string;
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    host = "<unparsable>";
  }
  return `${host} timeoutMs=${config.requestTimeoutMs}`;
}

export type CatalogSyncPolicyResult =
  | { kind: "valid"; policy: CatalogSyncPolicy }
  | { kind: "invalid"; errors: string[] };

export interface CatalogSyncPolicy {
  // An item absent from full scans for this long is retired (non-destructive).
  retirementAfterMs: number;
  // Deterministic bound: a library reporting more items than this fails the
  // scan instead of silently truncating the catalog.
  maxItemsPerLibrary: number;
  pageSize: number;
  maxPagesPerLibrary: number;
  // Fixed pool size: the sync is a batch job, not a resident service.
  poolMax: number;
  statementTimeoutMs: number;
}

export const CATALOG_RETIREMENT_DAYS_VAR = "MEDIA_CATALOG_RETIREMENT_DAYS";

const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY_DEFAULTS = {
  retirementDays: 30,
  maxItemsPerLibrary: 50_000,
  pageSize: 500,
  maxPagesPerLibrary: 100,
  poolMax: 4,
  statementTimeoutMs: 30_000
} as const;

export function loadCatalogSyncPolicy(env: Record<string, string | undefined>): CatalogSyncPolicyResult {
  const errors: string[] = [];
  let retirementDays: number = POLICY_DEFAULTS.retirementDays;

  const rawDays = env[CATALOG_RETIREMENT_DAYS_VAR]?.trim();
  if (rawDays) {
    if (!/^\d+$/.test(rawDays)) {
      errors.push(`${CATALOG_RETIREMENT_DAYS_VAR} must be a positive integer (got "${rawDays}")`);
    } else {
      const value = Number(rawDays);
      if (value < 1 || value > 3650) {
        errors.push(`${CATALOG_RETIREMENT_DAYS_VAR} must be between 1 and 3650 days (got ${value})`);
      } else {
        retirementDays = value;
      }
    }
  }

  if (errors.length) return { kind: "invalid", errors };
  return {
    kind: "valid",
    policy: {
      retirementAfterMs: retirementDays * DAY_MS,
      maxItemsPerLibrary: POLICY_DEFAULTS.maxItemsPerLibrary,
      pageSize: POLICY_DEFAULTS.pageSize,
      maxPagesPerLibrary: POLICY_DEFAULTS.maxPagesPerLibrary,
      poolMax: POLICY_DEFAULTS.poolMax,
      statementTimeoutMs: POLICY_DEFAULTS.statementTimeoutMs
    }
  };
}

// Re-exported so every catalog module scrubs with the same helpers.
export { redactDatabaseUrl };

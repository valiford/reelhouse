// Server-side PostgreSQL connection configuration.
//
// Pure parsing/validation logic: no I/O, no imports, so it can run under
// `node --test` and is safe to reason about in isolation. The database is
// never contacted here; problems are reported as data so callers fail closed.
// This module is deliberately NOT marked `server-only` (that package throws
// under plain Node); `pool.ts` carries the runtime boundary instead.

export type DatabaseConfigResult =
  | { kind: "unconfigured" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "valid"; config: DatabaseConfig };

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  // undefined = no TLS (LAN default). rejectUnauthorized=false maps to the
  // libpq "require" semantic: encrypted, identity not verified.
  ssl?: { rejectUnauthorized: boolean };
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
}

export const DATABASE_DEFAULTS = {
  port: 5432,
  poolMax: 10,
  connectionTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 10_000
} as const;

const LIMITS = {
  poolMax: { min: 1, max: 100 },
  connectionTimeoutMs: { min: 100, max: 60_000 },
  idleTimeoutMs: { min: 1_000, max: 600_000 },
  statementTimeoutMs: { min: 100, max: 600_000 }
} as const;

const OVERRIDES = {
  poolMax: {
    env: "DATABASE_POOL_MAX",
    limit: LIMITS.poolMax,
    key: "poolMax" as const
  },
  connectionTimeoutMs: {
    env: "DATABASE_CONNECT_TIMEOUT_MS",
    limit: LIMITS.connectionTimeoutMs,
    key: "connectionTimeoutMs" as const
  },
  idleTimeoutMs: {
    env: "DATABASE_IDLE_TIMEOUT_MS",
    limit: LIMITS.idleTimeoutMs,
    key: "idleTimeoutMs" as const
  },
  statementTimeoutMs: {
    env: "DATABASE_STATEMENT_TIMEOUT_MS",
    limit: LIMITS.statementTimeoutMs,
    key: "statementTimeoutMs" as const
  }
};

// Masks the password and drops the query string; everything echoed back to
// logs must go through this or describeDatabaseConfig().
export function redactDatabaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<unparsable database url>";
  }
  const auth = url.username ? `${url.username}${url.password ? ":***" : ""}@` : "";
  const database = url.pathname.replace(/^\/+/, "");
  return `${url.protocol}//${auth}${url.hostname}${url.port ? `:${url.port}` : ""}${database ? `/${database}` : ""}`;
}

export function describeDatabaseConfig(config: DatabaseConfig): string {
  const ssl = config.ssl ? (config.ssl.rejectUnauthorized ? "verify" : "require") : "disable";
  return `postgresql://${config.user || "(no user)"}:***@${config.host}:${config.port}/${config.database} ssl=${ssl} poolMax=${config.poolMax}`;
}

// Defense in depth for error paths: if a library ever embeds the raw URL in
// an error message, scrub it before the message reaches logs or responses.
export function redactError(message: string, rawUrl: string | undefined): string {
  if (!rawUrl || !message.includes(rawUrl)) return message;
  return message.split(rawUrl).join(redactDatabaseUrl(rawUrl));
}

function decodeComponent(value: string, label: string, errors: string[]): string {
  try {
    return decodeURIComponent(value);
  } catch {
    errors.push(`${label} is not valid percent-encoding`);
    return value;
  }
}

type SslSetting = { rejectUnauthorized: boolean } | undefined;

// Only "require"-grade verification is skipped deliberately: Synology LAN
// deployments run self-signed certificates, and failing them would make TLS
// unusable in practice. verify-ca / verify-full keep full verification.
function parseSsl(value: string, source: string, errors: string[]): SslSetting {
  switch (value) {
    case "disable":
    case "false":
    case "0":
      return undefined;
    case "allow":
    case "prefer":
    case "require":
    case "true":
    case "1":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      errors.push(`${source} has unsupported SSL mode "${value}" (use disable, require, or verify-full)`);
      return undefined;
  }
}

function readSsl(
  url: URL,
  env: Record<string, string | undefined>,
  errors: string[],
  urlVar: string,
  sslVar: string
): SslSetting {
  const urlMode = url.searchParams.get("sslmode");
  const urlAlias = url.searchParams.get("ssl");
  if (urlMode) return parseSsl(urlMode, `${urlVar} sslmode`, errors);
  if (urlAlias) return parseSsl(urlAlias, `${urlVar} ssl`, errors);
  const envMode = env[sslVar]?.trim();
  if (envMode) return parseSsl(envMode, sslVar, errors);
  return undefined;
}

function readOverride(
  env: Record<string, string | undefined>,
  name: keyof typeof OVERRIDES,
  errors: string[]
): number {
  const { env: varName, limit, key } = OVERRIDES[name];
  const raw = env[varName]?.trim();
  if (!raw) return DATABASE_DEFAULTS[key];
  if (!/^\d+$/.test(raw)) {
    errors.push(`${varName} must be a positive integer (got "${raw}")`);
    return DATABASE_DEFAULTS[key];
  }
  const value = Number(raw);
  if (value < limit.min || value > limit.max) {
    errors.push(`${varName} must be between ${limit.min} and ${limit.max} (got ${value})`);
    return DATABASE_DEFAULTS[key];
  }
  return value;
}

// Which environment variables a config is read from. The reelhouse database
// uses the DATABASE_URL defaults; the media_catalog database passes its own
// names (see src/lib/catalog/config.ts) so every validation, bound, and
// redaction rule stays in exactly one place.
export interface DatabaseConfigEnvNames {
  urlVar?: string;
  sslVar?: string;
}

const CONFIG_ENV_DEFAULTS = { urlVar: "DATABASE_URL", sslVar: "DATABASE_SSL" } as const;

export function loadDatabaseConfig(
  env: Record<string, string | undefined> = {},
  names: DatabaseConfigEnvNames = {}
): DatabaseConfigResult {
  const urlVar = names.urlVar ?? CONFIG_ENV_DEFAULTS.urlVar;
  const sslVar = names.sslVar ?? CONFIG_ENV_DEFAULTS.sslVar;

  const raw = env[urlVar]?.trim();
  if (!raw) return { kind: "unconfigured" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid", errors: [`${urlVar} is not a valid URL`] };
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return { kind: "invalid", errors: [`${urlVar} must use postgres:// or postgresql:// (got ${url.protocol})`] };
  }

  const errors: string[] = [];
  if (!url.hostname) errors.push(`${urlVar} has no host`);

  const database = url.pathname.replace(/^\/+/, "");
  if (!database) errors.push(`${urlVar} has no database name`);

  const port = url.port ? Number(url.port) : DATABASE_DEFAULTS.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`${urlVar} has an invalid port`);

  const user = decodeComponent(url.username, `${urlVar} username`, errors);
  const password = decodeComponent(url.password, `${urlVar} password`, errors);

  const ssl = readSsl(url, env, errors, urlVar, sslVar);
  const poolMax = readOverride(env, "poolMax", errors);
  const connectionTimeoutMs = readOverride(env, "connectionTimeoutMs", errors);
  const idleTimeoutMs = readOverride(env, "idleTimeoutMs", errors);
  const statementTimeoutMs = readOverride(env, "statementTimeoutMs", errors);

  if (errors.length) return { kind: "invalid", errors };

  return {
    kind: "valid",
    config: {
      host: url.hostname,
      port,
      user,
      password,
      database,
      ssl,
      poolMax,
      connectionTimeoutMs,
      idleTimeoutMs,
      statementTimeoutMs
    }
  };
}

// Server-side Jellyfin reachability probe for /api/health.
//
// Jellyfin is the playback/library authority and is reached through its API,
// never its internal database. Unreachability is NOT fatal: ReelHouse's demo
// mode is a legitimate operating state (same philosophy as the blank
// DATABASE_URL), so this probe reports state as data and never throws.
//
// The probe intentionally uses only the unauthenticated
// /System/Info/Public endpoint: no API key is ever sent, so nothing
// credential-bearing can leak through this path. Host:port in error details
// is fine; query strings and credentials are never echoed.

import { redactError } from "./db/config.ts";

export type JellyfinState = "unconfigured" | "reachable" | "unreachable";

export interface JellyfinHealth {
  state: JellyfinState;
  latencyMs?: number;
  serverName?: string;
  version?: string;
  detail?: string;
}

export const JELLYFIN_HEALTH_DEFAULTS = {
  timeoutMs: 3_000
} as const;

const JELLYFIN_TIMEOUT_LIMITS = { min: 250, max: 15_000 } as const;

function readTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.JELLYFIN_HEALTH_TIMEOUT_MS?.trim();
  if (!raw) return JELLYFIN_HEALTH_DEFAULTS.timeoutMs;
  if (!/^\d+$/.test(raw)) return JELLYFIN_HEALTH_DEFAULTS.timeoutMs;
  const value = Number(raw);
  if (value < JELLYFIN_TIMEOUT_LIMITS.min || value > JELLYFIN_TIMEOUT_LIMITS.max) {
    return JELLYFIN_HEALTH_DEFAULTS.timeoutMs;
  }
  return value;
}

function probeUrl(env: Record<string, string | undefined>): string | undefined {
  const serverUrl = env.JELLYFIN_URL?.trim().replace(/\/+$/, "");
  return serverUrl ? `${serverUrl}/System/Info/Public` : undefined;
}

export async function checkJellyfin(
  env: Record<string, string | undefined> = {},
  fetchImpl: typeof fetch = fetch
): Promise<JellyfinHealth> {
  const url = probeUrl(env);
  if (!url) return { state: "unconfigured" };

  try {
    const started = Date.now();
    const response = await fetchImpl(url, {
      // AbortSignal.timeout bounds the whole probe; a hung Jellyfin must not
      // hang the health endpoint.
      signal: AbortSignal.timeout(readTimeoutMs(env)),
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) {
      return { state: "unreachable", detail: `Jellyfin responded HTTP ${response.status}`, latencyMs: Date.now() - started };
    }
    // Bound the body read too; System/Info/Public is tiny in practice.
    const text = (await response.text()).slice(0, 4096);
    let serverName: string | undefined;
    let version: string | undefined;
    try {
      const body = JSON.parse(text) as { ServerName?: string; Version?: string };
      serverName = typeof body.ServerName === "string" ? body.ServerName.slice(0, 100) : undefined;
      version = typeof body.Version === "string" ? body.Version.slice(0, 50) : undefined;
    } catch {
      // A non-JSON 2xx is still a reachable HTTP endpoint; report it.
      return { state: "reachable", detail: "Jellyfin responded with a non-JSON body", latencyMs: Date.now() - started };
    }
    return { state: "reachable", serverName, version, latencyMs: Date.now() - started };
  } catch (error) {
    const rawUrl = env.JELLYFIN_URL?.trim();
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unreachable", detail: redactError(message, rawUrl).slice(0, 300) };
  }
}

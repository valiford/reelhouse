// Jellyfin HTTP API adapter for the media catalog sync.
//
// Jellyfin is the playback/library authority and is reached strictly through
// its HTTP API — never through its internal database. This adapter is the
// only place the sync touches the network: everything else consumes the
// CatalogSource interface, which is also what deterministic tests fake.
//
// Requests are bounded (per-request abort timeout), the API key is sent only
// in the X-Emby-Token header (never in a URL), and error messages are
// scrubbed of the server URL and key before leaving this module.

export interface CatalogLibrary {
  jellyfinId: string;
  name: string;
  collectionType: string | null;
}

// Raw /Items payload entry; normalization happens in normalize.ts.
export type CatalogRawItem = Record<string, unknown>;

export interface CatalogItemsPage {
  items: CatalogRawItem[];
  totalRecordCount: number | null;
}

export interface CatalogSource {
  listLibraries(): Promise<CatalogLibrary[]>;
  fetchItemsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage>;
}

export const CATALOG_SYNC_DEFAULTS = {
  timeoutMs: 30_000,
  pageSize: 500
} as const;

export const CATALOG_SYNC_LIMITS = {
  timeoutMs: { min: 1_000, max: 300_000 },
  pageSize: { min: 50, max: 1_000 }
} as const;

// Fail-closed env reader for the sync CLI: a typo'd tuning value must stop
// the run, not silently degrade a bulk job.
export function readCatalogSyncEnv(env: Record<string, string | undefined>): {
  timeoutMs: number;
  pageSize: number;
} {
  return {
    timeoutMs: readBounded(
      env.CATALOG_SYNC_HTTP_TIMEOUT_MS,
      CATALOG_SYNC_LIMITS.timeoutMs,
      CATALOG_SYNC_DEFAULTS.timeoutMs,
      "CATALOG_SYNC_HTTP_TIMEOUT_MS"
    ),
    pageSize: readBounded(
      env.CATALOG_SYNC_BATCH_SIZE,
      CATALOG_SYNC_LIMITS.pageSize,
      CATALOG_SYNC_DEFAULTS.pageSize,
      "CATALOG_SYNC_BATCH_SIZE"
    )
  };
}

function readBounded(
  raw: string | undefined,
  limits: { min: number; max: number },
  fallback: number,
  varName: string
): number {
  if (!raw?.trim()) return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`${varName} must be a positive integer (got "${value}")`);
  }
  const parsed = Number(value);
  if (parsed < limits.min || parsed > limits.max) {
    throw new Error(`${varName} must be between ${limits.min} and ${limits.max} (got ${parsed})`);
  }
  return parsed;
}

export class JellyfinCatalogSource implements CatalogSource {
  private readonly baseUrl: string;
  private readonly secrets: string[];
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  // Explicit field declarations: Node runs this module in TS strip-only
  // mode, where constructor parameter properties are unsupported.
  constructor(
    serverUrl: string,
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = CATALOG_SYNC_DEFAULTS.timeoutMs
  ) {
    this.baseUrl = serverUrl.trim().replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.secrets = [serverUrl.trim(), this.baseUrl, apiKey].filter(Boolean);
  }

  async listLibraries(): Promise<CatalogLibrary[]> {
    const body = await this.getJson("Library/MediaFolders");
    const entries = Array.isArray(body.Items) ? body.Items : [];
    const libraries: CatalogLibrary[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const jellyfinId = typeof record.Id === "string" ? record.Id.trim() : "";
      const name = typeof record.Name === "string" ? record.Name.trim() : "";
      if (!jellyfinId || !name) {
        throw new Error("Jellyfin library listing contained an entry without a stable Id/Name");
      }
      libraries.push({
        jellyfinId,
        name,
        collectionType: typeof record.CollectionType === "string" && record.CollectionType.trim()
          ? record.CollectionType.trim()
          : null
      });
    }
    return libraries;
  }

  async fetchItemsPage(
    libraryJellyfinId: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    const params = new URLSearchParams({
      ParentId: libraryJellyfinId,
      Recursive: "true",
      // Video = Jellyfin home-video items; normalized as movies.
      IncludeItemTypes: "Movie,Series,Season,Episode,Video",
      Fields: [
        "Path",
        "Genres",
        "Studios",
        "People",
        "ProviderIds",
        "MediaSources",
        "DateCreated",
        "OriginalTitle",
        "OfficialRating",
        "PremiereDate",
        "CommunityRating",
        "Container",
        "SortName"
      ].join(","),
      StartIndex: String(startIndex),
      Limit: String(limit),
      SortBy: "SortName",
      SortOrder: "Ascending"
    });
    const body = await this.getJson(`Items?${params.toString()}`);
    const items = Array.isArray(body.Items) ? body.Items : [];
    const totalRecordCount =
      typeof body.TotalRecordCount === "number" && Number.isSafeInteger(body.TotalRecordCount)
        ? body.TotalRecordCount
        : null;
    return { items: items as CatalogRawItem[], totalRecordCount };
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "X-Emby-Token": this.apiKey, accept: "application/json" },
        cache: "no-store"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Jellyfin API request failed: ${scrub(message, this.secrets)}`);
    }
    if (!response.ok) {
      throw new Error(`Jellyfin API responded HTTP ${response.status} for ${path.split("?")[0]}`);
    }
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response is not a JSON object");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Jellyfin API returned an unreadable body: ${scrub(message, this.secrets)}`);
    }
  }
}

// Scrubs the server URL and API key out of any error text that could carry
// them (fetch layer messages embed the full URL).
export function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out.slice(0, 300);
}

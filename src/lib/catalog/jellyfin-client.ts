// Thin Jellyfin HTTP client for catalog synchronization.
//
// API-only access (worker rule 8): the internal Jellyfin database is never
// touched. The interface exists so tests can inject fixtures; the HTTP
// implementation bounds every request with a timeout and never places the
// API key in a URL. Errors are constructed key-free by design and are passed
// through redactError() by callers as defense in depth.

import type { JellyfinItemRaw, JellyfinLibraryRaw } from "./model.ts";
import type { JellyfinSyncConfig } from "./config.ts";

export interface JellyfinCatalogPage {
  items: JellyfinItemRaw[];
  totalRecorded: number;
}

export interface JellyfinCatalogClient {
  listLibraries(): Promise<JellyfinLibraryRaw[]>;
  // One bounded page of items of the given kinds for a library. The sync
  // consumes a library in kind passes (roots, then seasons, then episodes)
  // so a parent row always exists before any child is written.
  // `updatedSince` narrows to items the server has saved after that instant
  // (incremental mode).
  listItemPage(
    libraryExternalId: string,
    options: { startIndex: number; limit: number; includeTypes: string[]; updatedSince?: string }
  ): Promise<JellyfinCatalogPage>;
}

export class JellyfinSyncError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "JellyfinSyncError";
    this.status = status;
  }
}

interface JellyfinItemsResponse {
  Items?: JellyfinItemRaw[];
  TotalRecordCount?: number;
}

interface JellyfinLibrariesResponse {
  Items?: JellyfinLibraryRaw[];
}

const ITEM_FIELDS = [
  "Path",
  "Size",
  "Container",
  "ProviderIds",
  "People",
  "Genres",
  "Studios",
  "DateCreated",
  "DateLastMediaAdded",
  "DateLastSaved",
  "SortName",
  "OriginalTitle",
  "OfficialRating",
  "Overview",
  "CommunityRating",
  "PremiereDate",
  "ProductionYear",
  "RuntimeTicks",
  "Etag"
].join(",");

async function fetchJson<T>(config: JellyfinSyncConfig, path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<T> {
  const url = new URL(`${config.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { "X-Emby-Token": config.apiKey, Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // AbortError text varies by runtime; say what happened in ReelHouse terms.
    throw new JellyfinSyncError(
      controller.signal.aborted
        ? `Jellyfin request timed out after ${config.requestTimeoutMs} ms (${path})`
        : `Jellyfin request failed: ${message} (${path})`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new JellyfinSyncError(`Jellyfin API returned ${response.status} ${response.statusText} (${path})`, response.status);
  }
  return (await response.json()) as T;
}

export function createHttpJellyfinClient(config: JellyfinSyncConfig, fetchImpl: typeof fetch = fetch): JellyfinCatalogClient {
  return {
    async listLibraries(): Promise<JellyfinLibraryRaw[]> {
      const body = await fetchJson<JellyfinLibrariesResponse>(config, "/Library/MediaFolders", {}, fetchImpl);
      return body.Items ?? [];
    },
    async listItemPage(libraryExternalId, { startIndex, limit, includeTypes, updatedSince }) {
      const params: Record<string, string> = {
        ParentId: libraryExternalId,
        Recursive: "true",
        IncludeItemTypes: includeTypes.join(","),
        Fields: ITEM_FIELDS,
        StartIndex: String(startIndex),
        Limit: String(limit),
        SortBy: "SortName",
        SortOrder: "Ascending"
      };
      if (updatedSince) params.MinDateLastSaved = updatedSince;
      const body = await fetchJson<JellyfinItemsResponse>(config, "/Items", params, fetchImpl);
      return { items: body.Items ?? [], totalRecorded: body.TotalRecordCount ?? 0 };
    }
  };
}

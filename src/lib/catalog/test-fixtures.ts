// Shared fixtures for the catalog integration suites. A fixture Jellyfin:
// an in-memory read-only stand-in for the API, so the suites never require
// network access and nothing here can modify a real Jellyfin server.

import { JellyfinSyncError, type JellyfinCatalogClient } from "./jellyfin-client.ts";
import type { JellyfinItemRaw, JellyfinLibraryRaw } from "./model.ts";

export const T0 = new Date("2026-09-19T12:00:00.000Z");

export class FixtureJellyfin implements JellyfinCatalogClient {
  libraries: JellyfinLibraryRaw[] = [];
  items = new Map<string, JellyfinItemRaw[]>();
  failure: JellyfinSyncError | null = null;
  lastUpdatedSince: string | null = null;

  async listLibraries(): Promise<JellyfinLibraryRaw[]> {
    if (this.failure) throw this.failure;
    return this.libraries;
  }

  async listItemPage(
    libraryExternalId: string,
    options: { startIndex: number; limit: number; includeTypes: string[]; updatedSince?: string }
  ): Promise<{ items: JellyfinItemRaw[]; totalRecorded: number }> {
    if (this.failure) throw this.failure;
    this.lastUpdatedSince = options.updatedSince ?? this.lastUpdatedSince;
    const all = (this.items.get(libraryExternalId) ?? [])
      .filter((item) => item.Type !== undefined && options.includeTypes.includes(item.Type))
      .filter((item) => {
        if (!options.updatedSince) return true;
        const saved = typeof item.DateLastSaved === "string" ? item.DateLastSaved : "";
        return saved !== "" && saved > options.updatedSince;
      })
      .sort((a, b) => (a.Id ?? "") < (b.Id ?? "") ? -1 : 1);
    return { items: all.slice(options.startIndex, options.startIndex + options.limit), totalRecorded: all.length };
  }
}

export function movieFixture(id: string, overrides: JellyfinItemRaw = {}): JellyfinItemRaw {
  return {
    Id: id,
    Name: `Movie ${id}`,
    Type: "Movie",
    ProductionYear: 2020,
    Overview: `Overview for ${id}`,
    ProviderIds: { Imdb: `tt0000${id}` },
    Genres: ["Drama"],
    Studios: [{ Name: "Studio One" }],
    People: [{ Name: "Ada Reel", Type: "Actor", Role: "Lead" }],
    DateLastSaved: T0.toISOString(),
    ...overrides
  };
}

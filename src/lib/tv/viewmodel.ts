// Payload → view-model mappers for the TV UI (RH-0035).
//
// The living-room UI never renders a read-model row directly: every payload
// that crosses the HTTP boundary (/api/home, /api/catalog/search,
// /api/catalog/items/:id, /api/catalog/status, /api/health) is mapped here
// into plain view models first. Keeping the mapping pure means the exact
// cards, rails, and banner states the TV renders are hermetically testable,
// and the React layer only ever deals in display-ready data.
//
// Boundaries respected here:
// - PostgreSQL credentials never appear client-side; image URLs are built
//   only from the public Jellyfin base (NEXT_PUBLIC_JELLYFIN_URL), mirroring
//   the server-side jellyfin.ts image builder.
// - Playback stays Jellyfin's job: a card's play target is a Jellyfin web
//   deep link, never a ReelHouse stream.
// - Catalog state is authoritative for what is discoverable: unresolved
//   rails (missing library/collection/watchlist targets) are dropped from
//   the render set — degradation is data, and the UI renders the remainder.

export interface CatalogCardPayload {
  id: string | number;
  source: string;
  jellyfin_id: string;
  library_jellyfin_id: string;
  library_name: string;
  item_type: string;
  name: string;
  original_title?: string | null;
  production_year: number | null;
  community_rating: string | null;
  official_rating?: string | null;
  runtime_ticks?: string | null;
  primary_image_tag: string | null;
  backdrop_image_tag: string | null;
  series_jellyfin_id?: string | null;
  series_name?: string | null;
  season_number?: number | null;
  episode_number?: number | null;
}

export interface RailItemPayload extends CatalogCardPayload {
  position_ticks?: string | null;
  duration_ticks?: string | null;
}

export interface HomeRailPayload {
  slug: string;
  kind: string;
  title: string;
  position: number;
  enabled: boolean;
  resolved: boolean;
  items: RailItemPayload[];
}

export interface HomeFeedPayload {
  profile: {
    id?: string | number;
    slug: string;
    display_name: string;
    initials: string | null;
    is_default: boolean;
  } | null;
  rows: HomeRailPayload[];
  perRailLimit: number | null;
  emptyHousehold?: boolean;
}

export interface SearchPagePayload {
  items: CatalogCardPayload[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ItemDetailPayload {
  item: CatalogCardPayload;
  overview: string | null;
  container: string | null;
  filePath: string | null;
  fileSizeBytes: string | null;
  etag: string | null;
  firstSeenAt: Date | string;
  genres: string[];
  studios: string[];
  people: { name: string; personType: string; roleName: string | null }[];
  providerIds: { name: string; value: string }[];
}

export interface CatalogStatusPayload {
  state: "never_synced" | "fresh" | "stale";
  watermark: string | null;
  itemCounts: { total: number; byType: Record<string, number> };
  openQuarantines: number;
}

export interface JellyfinHealthPayload {
  state: "unconfigured" | "reachable" | "unreachable";
  detail?: string;
}

export interface UiCard {
  key: string;
  jellyfinId: string;
  libraryJellyfinId: string;
  title: string;
  subtitle: string | null;
  year: number | null;
  kindLabel: string;
  rating: number | null;
  progress: number | null;
  imageUrl: string | null;
  backdropUrl: string | null;
  playHref: string | null;
}

export interface UiRail {
  slug: string;
  kind: string;
  title: string;
  cards: UiCard[];
}

const KIND_LABELS: Record<string, string> = {
  movie: "Movie",
  series: "Series",
  season: "Season",
  episode: "Episode"
};

export function kindLabel(itemType: string): string {
  return KIND_LABELS[itemType] ?? itemType;
}

// Mirrors the server-side jellyfin.ts image builder. Returns null whenever
// there is no public Jellyfin URL or no image tag — the UI falls back to the
// letter tile instead of guessing a URL.
export function jellyfinImageUrl(
  publicUrl: string | null | undefined,
  jellyfinId: string,
  type: "Primary" | "Backdrop",
  tag: string | null | undefined
): string | null {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  if (!base || !tag) return null;
  const width = type === "Primary" ? 600 : 1600;
  return `${base}/Items/${encodeURIComponent(jellyfinId)}/Images/${type}?maxWidth=${width}&quality=90&tag=${encodeURIComponent(tag)}`;
}

export function playHref(publicUrl: string | null | undefined, jellyfinId: string): string | null {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/web/index.html#!/details?id=${encodeURIComponent(jellyfinId)}`;
}

// Watch progress as a 0–100 percentage from the household watch-state ticks.
// Null when there is nothing meaningful to draw (no duration, zero ticks).
export function progressPercent(
  positionTicks: string | number | null | undefined,
  durationTicks: string | number | null | undefined
): number | null {
  const position = Number(positionTicks ?? 0);
  const duration = Number(durationTicks ?? 0);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  if (position <= 0) return null;
  // A position past the duration is a data anomaly, not a 140% bar.
  return Math.min(100, Math.round((position / duration) * 100));
}

export function cardSubtitle(row: CatalogCardPayload): string | null {
  if (row.item_type === "episode" && row.series_name) {
    const season = row.season_number;
    const episode = row.episode_number;
    const marker =
      season !== null && season !== undefined && episode !== null && episode !== undefined
        ? ` S${season}:E${episode}`
        : "";
    return `${row.series_name} ·${marker}`;
  }
  if (row.item_type === "season" && row.series_name) return row.series_name;
  return null;
}

function toCard(
  row: CatalogCardPayload,
  keyPrefix: string,
  progress: number | null,
  publicUrl: string | null
): UiCard {
  return {
    key: `${keyPrefix}:${row.jellyfin_id}`,
    jellyfinId: row.jellyfin_id,
    libraryJellyfinId: row.library_jellyfin_id,
    title: row.name,
    subtitle: cardSubtitle(row),
    year: row.production_year,
    kindLabel: kindLabel(row.item_type),
    rating: row.community_rating === null ? null : Number(row.community_rating),
    progress,
    imageUrl: jellyfinImageUrl(publicUrl, row.jellyfin_id, "Primary", row.primary_image_tag),
    backdropUrl: jellyfinImageUrl(publicUrl, row.jellyfin_id, "Backdrop", row.backdrop_image_tag),
    playHref: playHref(publicUrl, row.jellyfin_id)
  };
}

export function cardFromCatalog(
  row: CatalogCardPayload,
  keyPrefix: string,
  publicUrl: string | null
): UiCard {
  return toCard(row, keyPrefix, null, publicUrl);
}

export function cardFromRailItem(
  row: RailItemPayload,
  keyPrefix: string,
  publicUrl: string | null
): UiCard {
  return toCard(row, keyPrefix, progressPercent(row.position_ticks, row.duration_ticks), publicUrl);
}

// The render set for the home screen: enabled + resolved rails, in the
// household's configured order, each with only its non-empty item list.
// Unresolved rails (their library/collection/watchlist target is gone) and
// disabled rows are data-level degradation and drop out here.
export function visibleRails(feed: HomeFeedPayload, publicUrl: string | null): UiRail[] {
  const rails: UiRail[] = [];
  for (const row of [...feed.rows].sort((a, b) => a.position - b.position || a.slug.localeCompare(b.slug))) {
    if (!row.enabled || !row.resolved) continue;
    if (!row.items.length) continue;
    rails.push({
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      cards: row.items.map((item) => cardFromRailItem(item, row.slug, publicUrl))
    });
  }
  return rails;
}

// Deterministic hero pick: the first card of the first visible rail,
// continuing where the household left off when a continue-watching rail
// leads the feed (the household import orders home rows by position).
export function heroCard(feed: HomeFeedPayload, publicUrl: string | null): UiCard | null {
  const rails = visibleRails(feed, publicUrl);
  for (const rail of rails) {
    if (rail.cards.length) return rail.cards[0];
  }
  return null;
}

export interface UiDetail {
  jellyfinId: string;
  title: string;
  kindLabel: string;
  year: number | null;
  rating: number | null;
  officialRating: string | null;
  overview: string | null;
  libraryName: string;
  genres: string[];
  studios: string[];
  people: string[];
  providerNames: string[];
  playHref: string | null;
  backdropUrl: string | null;
  fileSummary: string | null;
}

export function detailView(payload: ItemDetailPayload, publicUrl: string | null): UiDetail {
  const card = payload.item;
  const fileParts: string[] = [];
  if (payload.container) fileParts.push(payload.container);
  if (payload.fileSizeBytes) {
    const bytes = Number(payload.fileSizeBytes);
    if (Number.isFinite(bytes) && bytes > 0) fileParts.push(`${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`);
  }
  return {
    jellyfinId: card.jellyfin_id,
    title: card.name,
    kindLabel: kindLabel(card.item_type),
    year: card.production_year,
    rating: card.community_rating === null ? null : Number(card.community_rating),
    officialRating: card.official_rating ?? null,
    overview: payload.overview,
    libraryName: card.library_name,
    genres: payload.genres,
    studios: payload.studios,
    people: payload.people.map((person) =>
      person.roleName ? `${person.name} — ${person.roleName}` : person.name
    ),
    providerNames: payload.providerIds.map((provider) => provider.name),
    playHref: playHref(publicUrl, card.jellyfin_id),
    backdropUrl: jellyfinImageUrl(publicUrl, card.jellyfin_id, "Backdrop", card.backdrop_image_tag),
    fileSummary: fileParts.length ? fileParts.join(" · ") : null
  };
}

export type FeedTone = "ok" | "stale" | "never_synced" | "jellyfin_down";

export interface StatusBanner {
  tone: FeedTone;
  message: string;
}

// Composes /api/catalog/status + /api/health into at most one banner, in
// priority order: an unreachable Jellyfin (the playback authority) outranks
// catalog staleness; staleness outranks never-synced (a never-synced catalog
// with zero items renders as the empty-feed state instead).
export function statusBanner(
  status: CatalogStatusPayload | null,
  jellyfin: JellyfinHealthPayload | null
): StatusBanner | null {
  if (jellyfin && jellyfin.state === "unreachable") {
    return {
      tone: "jellyfin_down",
      message: "ReelHouse Engine is unreachable — playback and library updates are paused."
    };
  }
  if (!status) return null;
  if (status.state === "stale") {
    return {
      tone: "stale",
      message: "Catalog data is stale — the last successful sync is older than the freshness window."
    };
  }
  if (status.state === "never_synced" && status.itemCounts.total > 0) {
    return {
      tone: "never_synced",
      message: "Catalog has items but no successful sync run has been recorded yet."
    };
  }
  return null;
}

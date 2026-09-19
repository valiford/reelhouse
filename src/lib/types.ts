export type MediaKind = "Movie" | "Series" | "Episode" | "Video";

export type MediaItem = {
  id: string;
  title: string;
  subtitle?: string;
  year?: number;
  overview?: string;
  kind: MediaKind;
  rating?: number;
  progress?: number;
  imageUrl?: string;
  backdropUrl?: string;
  genres?: string[];
};

export type LibrarySection = {
  title: string;
  items: MediaItem[];
};

export type LibraryPayload = {
  source: "demo" | "jellyfin";
  hero: MediaItem;
  sections: LibrarySection[];
  /** True when Jellyfin was expected to serve this payload but fell back to demo data. */
  degraded?: boolean;
  /** Bounded, redacted reason for the degraded fallback; safe to render in the UI. */
  degradedReason?: string;
};

export type SearchPayload = {
  source: "demo" | "jellyfin";
  query: string;
  items: MediaItem[];
  total: number;
  limit: number;
  offset: number;
};

export type ReelHouseApiError = {
  error: {
    code: "invalid_query" | "upstream_unavailable";
    field?: string;
    message: string;
  };
};

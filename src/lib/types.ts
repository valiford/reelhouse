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

export type LibraryPayload = {
  // "catalog" = served from the PostgreSQL read models; "jellyfin" = the
  // legacy direct-Jellyfin path; "demo" = the built-in demo library.
  source: "demo" | "jellyfin" | "catalog";
  hero: MediaItem;
  sections: Array<{ title: string; items: MediaItem[] }>;
};

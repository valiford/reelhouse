export type MediaKind = "Movie" | "Series" | "Season" | "Episode" | "Video";

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
  // Catalog read-model facts (RH-0020): explicit missing-art handling and
  // full-scan visibility. Absent on live Jellyfin/demo payloads.
  hasArt?: boolean;
  missing?: boolean;
};

export type LibraryPayload = {
  source: "demo" | "jellyfin" | "catalog";
  hero: MediaItem;
  sections: Array<{ title: string; items: MediaItem[] }>;
};

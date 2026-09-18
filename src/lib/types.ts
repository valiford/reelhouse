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
  source: "demo" | "jellyfin";
  hero: MediaItem;
  sections: Array<{ title: string; items: MediaItem[] }>;
};

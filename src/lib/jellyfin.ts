import type { LibraryPayload, MediaItem } from "./types";
import { demoLibrary } from "./demo";

const serverUrl = process.env.JELLYFIN_URL?.replace(/\/$/, "");
const apiKey = process.env.JELLYFIN_API_KEY;
const userId = process.env.JELLYFIN_USER_ID;
const publicUrl = process.env.NEXT_PUBLIC_JELLYFIN_URL?.replace(/\/$/, "") || serverUrl;

type JellyfinItem = {
  Id: string;
  Name: string;
  Type: "Movie" | "Series" | "Episode" | "Video";
  ProductionYear?: number;
  Overview?: string;
  CommunityRating?: number;
  Genres?: string[];
  UserData?: { PlaybackPositionTicks?: number; PlayedPercentage?: number };
  ImageTags?: { Primary?: string };
  BackdropImageTags?: string[];
};

type JellyfinResponse = { Items?: JellyfinItem[] };

function image(id: string, type: "Primary" | "Backdrop", tag?: string) {
  if (!publicUrl || !tag) return undefined;
  const width = type === "Primary" ? 600 : 1600;
  return `${publicUrl}/Items/${id}/Images/${type}?maxWidth=${width}&quality=90&tag=${encodeURIComponent(tag)}`;
}

function mapItem(row: JellyfinItem): MediaItem {
  return {
    id: row.Id,
    title: row.Name,
    year: row.ProductionYear,
    overview: row.Overview,
    kind: row.Type,
    rating: row.CommunityRating,
    genres: row.Genres,
    progress: row.UserData?.PlayedPercentage,
    imageUrl: image(row.Id, "Primary", row.ImageTags?.Primary),
    backdropUrl: image(row.Id, "Backdrop", row.BackdropImageTags?.[0])
  };
}

async function query(params: Record<string, string>) {
  if (!serverUrl || !apiKey || !userId) return [] as MediaItem[];
  const qs = new URLSearchParams({
    Recursive: "true",
    UserId: userId,
    Fields: "Overview,Genres,ProductionYear,CommunityRating,PrimaryImageAspectRatio,UserData",
    ImageTypeLimit: "1",
    EnableImageTypes: "Primary,Backdrop",
    ...params
  });
  const response = await fetch(`${serverUrl}/Users/${userId}/Items?${qs}`, {
    headers: { "X-Emby-Token": apiKey },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Jellyfin ${response.status}`);
  const body = (await response.json()) as JellyfinResponse;
  return (body.Items || []).map(mapItem);
}

export async function getLibrary(): Promise<LibraryPayload> {
  if (!serverUrl || !apiKey || !userId) return demoLibrary;

  try {
    const [recent, movies, series, resume] = await Promise.all([
      query({ IncludeItemTypes: "Movie,Series,Video", SortBy: "DateCreated", SortOrder: "Descending", Limit: "18" }),
      query({ IncludeItemTypes: "Movie", SortBy: "SortName", SortOrder: "Ascending", Limit: "24" }),
      query({ IncludeItemTypes: "Series", SortBy: "SortName", SortOrder: "Ascending", Limit: "24" }),
      query({ IncludeItemTypes: "Movie,Episode,Video", IsResumable: "true", SortBy: "DatePlayed", SortOrder: "Descending", Limit: "12" })
    ]);

    const hero = recent.find((x) => x.backdropUrl) || recent[0] || movies[0] || demoLibrary.hero;
    return {
      source: "jellyfin",
      hero,
      sections: [
        ...(resume.length ? [{ title: "Continue Watching", items: resume }] : []),
        { title: "Recently Added", items: recent },
        { title: "Movies", items: movies },
        { title: "Shows", items: series }
      ].filter((section) => section.items.length)
    };
  } catch (error) {
    console.error("Falling back to demo library:", error);
    return demoLibrary;
  }
}

export async function searchLibrary(term: string): Promise<MediaItem[]> {
  if (!term.trim()) return [];
  if (!serverUrl || !apiKey || !userId) {
    const q = term.toLowerCase();
    return demoLibrary.sections.flatMap((s) => s.items).filter((x, i, all) =>
      all.findIndex((y) => y.id === x.id) === i &&
      `${x.title} ${x.overview || ""} ${(x.genres || []).join(" ")}`.toLowerCase().includes(q)
    );
  }
  try {
    return await query({
      IncludeItemTypes: "Movie,Series,Episode,Video",
      SearchTerm: term,
      Limit: "40"
    });
  } catch {
    return [];
  }
}

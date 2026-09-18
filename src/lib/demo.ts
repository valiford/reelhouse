import type { LibraryPayload, MediaItem } from "./types";

const posters = [
  ["The Long Weekend", "A low-key escape turns into the trip everyone remembers.", "Drama", 2024],
  ["Northern Lights", "An adventure beneath a sky that refuses to stay dark.", "Adventure", 2023],
  ["Saturday Classic", "The game-day ritual, preserved for another Saturday.", "Sports", 2026],
  ["Santorini", "A sunlit collection from the Aegean.", "Home Video", 2025],
  ["Campfire Stories", "Trails, tents, and the stories that survived the hike.", "Travel", 2026],
  ["Michigan Saturdays", "Big games, familiar voices, and fall afternoons.", "Sports", 2025],
  ["Florida Nights", "Warm evenings and the people who made them memorable.", "Home Video", 2026],
  ["Road Trip", "A few hundred miles with nowhere better to be.", "Travel", 2024],
  ["Holiday Reel", "The house fills up and the cameras come out.", "Home Video", 2025],
  ["Deep Blue", "A quiet documentary from below the surface.", "Documentary", 2022]
] as const;

function item(index: number): MediaItem {
  const [title, overview, genre, year] = posters[index % posters.length];
  const seed = encodeURIComponent(`${title}-${index}`);
  return {
    id: `demo-${index}`,
    title,
    overview,
    kind: genre === "Home Video" ? "Video" : "Movie",
    year,
    rating: 7.2 + (index % 20) / 10,
    genres: [genre],
    progress: index < 4 ? [63, 28, 82, 41][index] : undefined,
    imageUrl: `https://picsum.photos/seed/${seed}/600/900`,
    backdropUrl: `https://picsum.photos/seed/${seed}-backdrop/1600/900`
  };
}

const items = Array.from({ length: 22 }, (_, i) => item(i));

export const demoLibrary: LibraryPayload = {
  source: "demo",
  hero: { ...items[1], title: "Northern Lights", subtitle: "Featured tonight" },
  sections: [
    { title: "Continue Watching", items: items.slice(0, 4) },
    { title: "Recently Added", items: items.slice(4, 12) },
    { title: "Movies", items: items.slice(8, 16) },
    { title: "Home Videos", items: items.slice(12, 20) }
  ]
};

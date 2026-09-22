// Deterministic local Jellyfin stub for exercising the catalog sync.
//
//   node scripts/dev/jellyfin-stub.mjs
//   PORT=8097 FAULT_MODE=none|error500|error500-second-page|empty-libraries node scripts/dev/jellyfin-stub.mjs
//
// Serves the exact API surface the sync consumes (/Library/MediaFolders and
// /Items with ParentId/Recursive/IncludeItemTypes/StartIndex/Limit) from a
// small canned dataset, so `npm run catalog:sync` can be demonstrated and
// reviewed end-to-end without a real Jellyfin server. Fault modes provide
// deterministic failure/recovery evidence:
//   error500             every /Items page answers HTTP 500
//   error500-second-page the first /Items page succeeds, later pages 500
//   empty-libraries      MediaFolders reports zero libraries
//
// The API key is accepted as-is and never validated against anything real.

import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8097);
const faultMode = process.env.FAULT_MODE ?? "none";

const libraries = [
  { Id: "lib-movies", Name: "Movies", CollectionType: "movies" },
  { Id: "lib-tv", Name: "TV Shows", CollectionType: "tvshows" }
];

const movies = [
  {
    Id: "mov-arrival",
    Name: "Arrival",
    Type: "Movie",
    Overview: "A linguist works with the military to communicate with alien lifeforms.",
    ProductionYear: 2016,
    PremiereDate: "2016-11-10T00:00:00.000Z",
    CommunityRating: 7.9,
    OfficialRating: "PG-13",
    RunTimeTicks: 1_830_000_000,
    SortName: "arrival",
    Genres: ["Science fiction", "Drama"],
    Studios: ["Paramount"],
    People: [
      { Name: "Denis Villeneuve", Type: "Director" },
      { Name: "Amy Adams", Type: "Actor", Role: "Louise Banks", Id: "person-amy" }
    ],
    ProviderIds: { Imdb: "tt2543164", Tmdb: "329865" },
    ImageTags: { Primary: "arrival-primary" },
    BackdropImageTags: ["arrival-backdrop"],
    Etag: "etag-arrival",
    DateCreated: "2023-05-01T12:00:00.000Z",
    MediaSources: [
      {
        Container: "mkv",
        Path: "/media/movies/arrival.mkv",
        Size: 3_000_000_000,
        MediaStreams: [
          { Type: "Video", Codec: "hevc", DisplayTitle: "1080p HEVC", IsDefault: true },
          { Type: "Audio", Codec: "dts", Language: "eng", DisplayTitle: "English DTS" },
          { Type: "Subtitle", Codec: "srt", Language: "eng", DisplayTitle: "English SRT" }
        ]
      }
    ]
  },
  { Id: "mov-bare", Name: "Bare Movie", Type: "Movie" },
  {
    Id: "mov-blank",
    Name: "Blank Check",
    Type: "Movie",
    ProductionYear: 1994,
    CommunityRating: 6.1,
    Genres: ["Comedy", "Family"],
    RunTimeTicks: 1_620_000_000
  }
];

const tv = [
  {
    Id: "ser-demo",
    Name: "Demo Show",
    Type: "Series",
    ProductionYear: 2020,
    Overview: "A deterministic demonstration series.",
    Genres: ["Comedy"],
    Studios: ["Demo Studio"],
    ProviderIds: { Tvdb: "12345" },
    Etag: "etag-demo"
  },
  {
    Id: "sea-demo-1",
    Name: "Season 1",
    Type: "Season",
    IndexNumber: 1,
    SeriesId: "ser-demo",
    SeriesName: "Demo Show"
  },
  {
    Id: "ep-demo-1",
    Name: "Pilot",
    Type: "Episode",
    IndexNumber: 1,
    ParentIndexNumber: 1,
    SeasonId: "sea-demo-1",
    SeriesId: "ser-demo",
    SeriesName: "Demo Show",
    RunTimeTicks: 1_500_000_000,
    People: [{ Name: "Jane Creator", Type: "Writer" }],
    MediaSources: [
      {
        Container: "mp4",
        Path: "/media/tv/demo/s01e01.mp4",
        Size: 500_000_000,
        MediaStreams: [{ Type: "Video", Codec: "h264", DisplayTitle: "720p", IsDefault: true }]
      }
    ]
  },
  {
    Id: "ep-demo-2",
    Name: "Episode Two",
    Type: "Episode",
    IndexNumber: 2,
    ParentIndexNumber: 1,
    SeasonId: "sea-demo-1",
    SeriesId: "ser-demo",
    SeriesName: "Demo Show"
  },
  { Id: "vid-home", Name: "Home Video Clip", Type: "Video", Path: "/home/clips/clip.mp4" },
  { Id: "pic-album", Name: "Photo Album", Type: "PhotoAlbum" }
];

const itemsByLibrary = new Map([
  ["lib-movies", movies],
  ["lib-tv", tv]
]);

let itemsRequests = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/Library/MediaFolders") {
    const items = faultMode === "empty-libraries" ? [] : libraries;
    respond(response, 200, { Items: items, TotalRecordCount: items.length });
    return;
  }

  if (url.pathname === "/Items") {
    itemsRequests += 1;
    if (faultMode === "error500" || (faultMode === "error500-second-page" && itemsRequests > 1)) {
      respond(response, 500, { error: "simulated Jellyfin outage" });
      return;
    }
    const parentId = url.searchParams.get("ParentId") ?? "";
    const items = itemsByLibrary.get(parentId) ?? [];
    const startIndex = Number(url.searchParams.get("StartIndex") ?? "0");
    const limit = Number(url.searchParams.get("Limit") ?? "500");
    const page = items.slice(startIndex, startIndex + limit);
    respond(response, 200, { Items: page, TotalRecordCount: items.length });
    return;
  }

  respond(response, 404, { error: `not stubbed: ${url.pathname}` });
});

function respond(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

server.listen(port, "127.0.0.1", () => {
  console.log(`jellyfin-stub listening on http://127.0.0.1:${port} (FAULT_MODE=${faultMode})`);
});

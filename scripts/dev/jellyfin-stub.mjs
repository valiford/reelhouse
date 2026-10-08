// Deterministic local Jellyfin stub for exercising the catalog sync.
//
//   node scripts/dev/jellyfin-stub.mjs
//   PORT=8097 FAULT_MODE=none|error500|error500-second-page|empty-libraries \
//   DATASET=baseline|mutated|duplicates node scripts/dev/jellyfin-stub.mjs
//
// Serves the exact API surface the sync consumes (/Library/MediaFolders and
// /Items with ParentId/Recursive/IncludeItemTypes/StartIndex/Limit and, for
// the incremental pipeline, MinDateLastSaved and Fields=Id) from a small
// canned dataset, so `npm run catalog:sync` can be demonstrated and reviewed
// end-to-end without a real Jellyfin server. Fault modes provide
// deterministic failure/recovery evidence:
//   error500             every /Items page answers HTTP 500
//   error500-second-page the first /Items page succeeds, later pages 500
//   empty-libraries      MediaFolders reports zero libraries
//
// DATASET chooses the canned catalog state (each item carries a fixed
// DateLastSaved so delta windows are deterministic):
//   baseline    the original catalog (RH-0031's canned items)
//   mutated     Arrival remastered (update), mov-bare gone (sweep removal),
//               mov-citizen added (delta add)
//   duplicates  the same Jellyfin id (mov-twin) reported under both
//               libraries with differing content — exercises quarantine
//
// The API key is accepted as-is and never validated against anything real.

import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8097);
const faultMode = process.env.FAULT_MODE ?? "none";
const dataset = process.env.DATASET ?? "baseline";

// Saved-on timestamps: originals share one old instant; mutations carry
// later instants, so MinDateLastSaved windows select exactly the mutations.
const SAVED_ORIGINAL = "2024-01-01T00:00:00.000Z";

const libraries = [
  { Id: "lib-movies", Name: "Movies", CollectionType: "movies" },
  { Id: "lib-tv", Name: "TV Shows", CollectionType: "tvshows" }
];

function movie(overrides) {
  return {
    Type: "Movie",
    DateLastSaved: SAVED_ORIGINAL,
    MediaSources: [],
    ...overrides
  };
}

const baseMovies = [
  movie({
    Id: "mov-arrival",
    Name: "Arrival",
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
  }),
  movie({ Id: "mov-bare", Name: "Bare Movie" }),
  movie({
    Id: "mov-blank",
    Name: "Blank Check",
    ProductionYear: 1994,
    CommunityRating: 6.1,
    Genres: ["Comedy", "Family"],
    RunTimeTicks: 1_620_000_000
  })
];

const baseTv = [
  {
    Id: "ser-demo",
    Name: "Demo Show",
    Type: "Series",
    ProductionYear: 2020,
    Overview: "A deterministic demonstration series.",
    DateLastSaved: SAVED_ORIGINAL,
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
    SeriesName: "Demo Show",
    DateLastSaved: SAVED_ORIGINAL
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
    DateLastSaved: SAVED_ORIGINAL,
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
    SeriesName: "Demo Show",
    DateLastSaved: SAVED_ORIGINAL
  },
  { Id: "vid-home", Name: "Home Video Clip", Type: "Video", Path: "/home/clips/clip.mp4", DateLastSaved: SAVED_ORIGINAL },
  { Id: "pic-album", Name: "Photo Album", Type: "PhotoAlbum", DateLastSaved: SAVED_ORIGINAL }
];

function buildDataset(name) {
  const movies = baseMovies.map((entry) => ({ ...entry }));
  const tv = baseTv.map((entry) => ({ ...entry }));

  if (name === "mutated") {
    const arrival = movies.find((entry) => entry.Id === "mov-arrival");
    arrival.Name = "Arrival (Remastered)";
    arrival.CommunityRating = 8.0;
    arrival.Etag = "etag-arrival-rmx";
    arrival.DateLastSaved = "2025-06-01T12:00:00.000Z";
    movies.splice(movies.findIndex((entry) => entry.Id === "mov-bare"), 1);
    movies.push(
      movie({
        Id: "mov-citizen",
        Name: "Citizen Test",
        ProductionYear: 2025,
        DateLastSaved: "2025-06-02T09:30:00.000Z",
        Etag: "etag-citizen"
      })
    );
  }

  if (name === "duplicates") {
    // One Jellyfin id, two libraries, differing content: ambiguous identity.
    movies.push(movie({ Id: "mov-twin", Name: "Twin (Movies)", Etag: "etag-twin-a", DateLastSaved: "2025-07-01T00:00:00.000Z" }));
    tv.push(movie({ Id: "mov-twin", Name: "Twin (TV)", Etag: "etag-twin-b", DateLastSaved: "2025-07-01T00:00:00.000Z" }));
  }

  return new Map([
    ["lib-movies", movies],
    ["lib-tv", tv]
  ]);
}

const itemsByLibrary = buildDataset(dataset);

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
    const minDateSaved = url.searchParams.get("MinDateLastSaved");
    const fields = url.searchParams.get("Fields") ?? "";
    const idOnly = fields === "Id";
    let items = itemsByLibrary.get(parentId) ?? [];
    if (minDateSaved !== null) {
      const threshold = new Date(minDateSaved);
      items = items.filter(
        (entry) => entry.DateLastSaved && new Date(entry.DateLastSaved) >= threshold
      );
    }
    if (idOnly) items = items.map((entry) => ({ Id: entry.Id }));
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
  console.log(
    `jellyfin-stub listening on http://127.0.0.1:${port} (FAULT_MODE=${faultMode}, DATASET=${dataset})`
  );
});

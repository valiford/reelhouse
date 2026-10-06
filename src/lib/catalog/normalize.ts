// Pure normalization of Jellyfin API payloads into catalog rows.
//
// Everything Jellyfin sends is external input: fields are validated at
// runtime, never trusted by shape, and invalid optional values become NULL
// rather than being coerced or clamped. Identity is the one thing that fails
// closed — an item without a stable Id or a usable Name is an ambiguous
// media identity and aborts the run (CatalogIdentityError), while an item of
// a known-but-unsupported Type is simply out of scope and is reported as
// skipped by the caller.
//
// No I/O and no imports: fully unit-testable, and safe under `node --test`.

export type CatalogItemType = "movie" | "series" | "season" | "episode";

export class CatalogIdentityError extends Error {}

export interface NormalizedLibrary {
  source: "jellyfin";
  jellyfinId: string;
  name: string;
  collectionType: string | null;
}

export interface NormalizedPersonRef {
  name: string;
  jellyfinId: string | null;
  personType: string;
  roleName: string | null;
}

export interface NormalizedProviderId {
  name: string;
  value: string;
}

export interface NormalizedMediaStream {
  streamType: string | null;
  codec: string | null;
  language: string | null;
  displayTitle: string | null;
  isDefault: boolean | null;
}

export interface NormalizedItem {
  source: "jellyfin";
  jellyfinId: string;
  libraryJellyfinId: string;
  itemType: CatalogItemType;
  name: string;
  originalTitle: string | null;
  sortName: string | null;
  overview: string | null;
  productionYear: number | null;
  premiereDate: string | null;
  communityRating: number | null;
  officialRating: string | null;
  runtimeTicks: number | null;
  container: string | null;
  filePath: string | null;
  fileSizeBytes: number | null;
  mediaStreams: NormalizedMediaStream[];
  primaryImageTag: string | null;
  backdropImageTag: string | null;
  etag: string | null;
  dateCreated: string | null;
  // Source-provided revision marker (Jellyfin DateLastSaved): when the
  // source last saved this item. Drives the incremental delta window and the
  // observed_at provenance of change history; null when the source omits it.
  dateLastSaved: string | null;
  parentJellyfinId: string | null;
  seriesJellyfinId: string | null;
  seriesName: string | null;
  seasonJellyfinId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  genres: string[];
  studios: string[];
  people: NormalizedPersonRef[];
  providerIds: NormalizedProviderId[];
}

// Raw Jellyfin item payload as received from /Items. Every field is unknown:
// the API is an external system and its JSON is validated, never trusted.
export type JellyfinItemPayload = Record<string, unknown>;

// Stream lists on episodic content can be long; the catalog keeps the first
// streams per item so one pathological file cannot dominate a sync batch.
const MAX_MEDIA_STREAMS = 32;

function asString(value: unknown, maxLength = 20_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function asRequiredString(value: unknown, what: string): string {
  const parsed = asString(value);
  if (!parsed) throw new CatalogIdentityError(`${what} is missing or empty`);
  return parsed;
}

function asInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

// Durations and file sizes: negative values are nonsense, not clamped.
function asNonNegativeInteger(value: unknown): number | null {
  const parsed = asInteger(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const parsed = asString(entry);
    if (parsed && !out.includes(parsed)) out.push(parsed);
  }
  return out;
}

const ITEM_TYPE_BY_JELLYFIN_TYPE: Record<string, CatalogItemType> = {
  Movie: "movie",
  Video: "movie",
  Series: "series",
  Season: "season",
  Episode: "episode"
};

export function normalizeLibrary(payload: JellyfinItemPayload): NormalizedLibrary {
  return {
    source: "jellyfin",
    jellyfinId: asRequiredString(payload.Id, "Library Id"),
    name: asRequiredString(payload.Name, `Library name (${String(payload.Id)})`),
    collectionType: asString(payload.CollectionType, 50)
  };
}

// Returns null for an out-of-scope item type; throws CatalogIdentityError
// for a missing Id/Name. Callers count nulls as skipped items.
export function normalizeItem(
  payload: JellyfinItemPayload,
  libraryJellyfinId: string
): NormalizedItem | null {
  const itemType = ITEM_TYPE_BY_JELLYFIN_TYPE[asString(payload.Type, 50) ?? ""];
  if (!itemType) return null;

  const jellyfinId = asRequiredString(payload.Id, "Item Id");
  const name = asRequiredString(payload.Name, `Item name (${jellyfinId})`);

  const mediaStreams: NormalizedMediaStream[] = [];
  const sources = Array.isArray(payload.MediaSources) ? payload.MediaSources : [];
  const primarySource = sources[0];
  const sourceRecord =
    primarySource && typeof primarySource === "object"
      ? (primarySource as Record<string, unknown>)
      : undefined;
  const rawStreams = sourceRecord && Array.isArray(sourceRecord.MediaStreams) ? sourceRecord.MediaStreams : [];
  for (const raw of rawStreams.slice(0, MAX_MEDIA_STREAMS)) {
    if (!raw || typeof raw !== "object") continue;
    const stream = raw as Record<string, unknown>;
    mediaStreams.push({
      streamType: asString(stream.Type, 50),
      codec: asString(stream.Codec, 50),
      language: asString(stream.Language, 50),
      displayTitle: asString(stream.DisplayTitle, 300),
      isDefault: typeof stream.IsDefault === "boolean" ? stream.IsDefault : null
    });
  }

  const imageTags =
    payload.ImageTags && typeof payload.ImageTags === "object"
      ? (payload.ImageTags as Record<string, unknown>)
      : undefined;
  const backdropTags = Array.isArray(payload.BackdropImageTags) ? payload.BackdropImageTags : [];

  // People: name is the identity; Jellyfin's per-entry Type defaults to
  // Actor when absent; entries without a usable Name are dropped. Same
  // (name, type) pairs are deduplicated keeping the first occurrence.
  const people: NormalizedPersonRef[] = [];
  const seenPeople = new Set<string>();
  const rawPeople = Array.isArray(payload.People) ? payload.People : [];
  for (const raw of rawPeople) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const personName = asString(entry.Name);
    if (!personName) continue;
    const personType = asString(entry.Type, 100) ?? "Actor";
    const key = `${personType}\u0000${personName}`;
    if (seenPeople.has(key)) continue;
    seenPeople.add(key);
    people.push({
      name: personName,
      jellyfinId: asString(entry.Id),
      personType,
      roleName: asString(entry.Role, 500)
    });
  }

  // ProviderIds is a name→value object (Imdb, Tmdb, Tvdb, …).
  const providerIds: NormalizedProviderId[] = [];
  if (payload.ProviderIds && typeof payload.ProviderIds === "object") {
    for (const [providerName, providerValue] of Object.entries(
      payload.ProviderIds as Record<string, unknown>
    )) {
      const value = asString(providerValue);
      const key = asString(providerName, 100);
      if (value && key) providerIds.push({ name: key, value });
    }
  }

  return {
    source: "jellyfin",
    jellyfinId,
    libraryJellyfinId,
    itemType,
    name,
    originalTitle: asString(payload.OriginalTitle),
    sortName: asString(payload.SortName),
    overview: asString(payload.Overview),
    productionYear: asInteger(payload.ProductionYear),
    premiereDate: asIsoTimestamp(payload.PremiereDate),
    communityRating: asNumber(payload.CommunityRating),
    officialRating: asString(payload.OfficialRating, 20),
    runtimeTicks: asNonNegativeInteger(payload.RunTimeTicks),
    container: asString(sourceRecord?.Container ?? payload.Container, 50),
    filePath: asString(sourceRecord?.Path ?? payload.Path),
    fileSizeBytes: asNonNegativeInteger(sourceRecord?.Size),
    mediaStreams,
    primaryImageTag: asString(imageTags?.Primary, 100),
    backdropImageTag: asString(backdropTags[0], 100),
    etag: asString(payload.Etag, 100),
    dateCreated: asIsoTimestamp(payload.DateCreated),
    dateLastSaved: asIsoTimestamp(payload.DateLastSaved),
    parentJellyfinId: asString(payload.ParentId),
    seriesJellyfinId: asString(payload.SeriesId),
    seriesName: asString(payload.SeriesName),
    seasonJellyfinId: asString(payload.SeasonId),
    // Season items carry their number in IndexNumber; episodes carry the
    // episode number in IndexNumber and the season number in
    // ParentIndexNumber (the parent season).
    seasonNumber:
      itemType === "season"
        ? asInteger(payload.IndexNumber)
        : asInteger(payload.ParentIndexNumber),
    episodeNumber: itemType === "episode" ? asInteger(payload.IndexNumber) : null,
    genres: asStringArray(payload.Genres),
    studios: asStringArray(payload.Studios),
    people,
    providerIds
  };
}

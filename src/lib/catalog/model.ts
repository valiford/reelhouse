// Jellyfin API payloads -> normalized catalog model, and the content
// fingerprint that makes syncing idempotent.
//
// Pure module: no I/O, deterministic output for deterministic input, so the
// mapping and identity rules are unit-testable without a database or network.
// The fingerprint covers every stored content field EXCEPT source_revision
// (an ETag-only change is provenance, not content) and is computed over a
// canonical form (sorted taxonomy/provider arrays) so payload ordering
// cannot fabricate changes.

import { createHash } from "node:crypto";

export type CatalogKind = "movie" | "series" | "season" | "episode";

export interface CatalogLibraryModel {
  source: "jellyfin";
  externalId: string;
  name: string;
  collectionType: string | null;
  primaryImageTag: string | null;
  contentHash: string;
}

export interface CatalogProviderId {
  provider: string;
  value: string;
}

export type CatalogPersonRoleType =
  | "actor"
  | "director"
  | "writer"
  | "producer"
  | "composer"
  | "guest_star"
  | "other";

export interface CatalogPersonRef {
  name: string;
  roleType: CatalogPersonRoleType;
  roleName: string | null;
  listOrder: number;
  providerIds: Record<string, string>;
}

export interface CatalogItemModel {
  source: "jellyfin";
  externalId: string;
  kind: CatalogKind;
  parentExternalId: string | null;
  // The kind the parent row must have for this item to be writable. Derived
  // from which Jellyfin field supplied the parent id (SeasonId vs SeriesId);
  // validation metadata, not stored content, so it stays out of the hash.
  parentKind: "series" | "season" | null;
  name: string;
  sortName: string | null;
  originalTitle: string | null;
  productionYear: number | null;
  premiereDate: string | null;
  overview: string | null;
  officialRating: string | null;
  communityRating: number | null;
  runtimeSeconds: number | null;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  path: string | null;
  container: string | null;
  sizeBytes: number | null;
  dateCreated: string | null;
  primaryImageTag: string | null;
  sourceRevision: string | null;
  providerIds: CatalogProviderId[];
  genres: string[];
  studios: string[];
  people: CatalogPersonRef[];
  contentHash: string;
}

// Fields requested from Jellyfin /Items; the fixture tests pin the shapes the
// mapper actually consumes.
export interface JellyfinItemRaw {
  Id?: string;
  Name?: string;
  Type?: string;
  SortName?: string;
  OriginalTitle?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  Overview?: string;
  OfficialRating?: string;
  CommunityRating?: number;
  RuntimeTicks?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  Path?: string;
  Container?: string;
  Size?: number | string;
  DateCreated?: string;
  ETag?: string;
  DateLastSaved?: string;
  SeriesId?: string;
  SeasonId?: string;
  ImageTags?: { Primary?: string };
  ProviderIds?: Record<string, string>;
  Genres?: string[];
  Studios?: Array<{ Name?: string }>;
  People?: Array<{ Name?: string; Type?: string; Role?: string; ProviderIds?: Record<string, string> }>;
}

export interface JellyfinLibraryRaw {
  Id?: string;
  Name?: string;
  CollectionType?: string;
  ImageTags?: { Primary?: string };
}

export type MappedItem =
  | { outcome: "mapped"; model: CatalogItemModel }
  | { outcome: "skip"; reason: string }
  | { outcome: "invalid"; externalId: string; reason: string };

const KIND_BY_TYPE: Record<string, CatalogKind> = {
  Movie: "movie",
  Series: "series",
  Season: "season",
  Episode: "episode"
};

const ROLE_BY_TYPE: Record<string, CatalogPersonRoleType> = {
  Actor: "actor",
  Director: "director",
  Writer: "writer",
  Producer: "producer",
  Composer: "composer",
  GuestStar: "guest_star"
};

export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanProviderIds(raw: Record<string, string> | undefined): CatalogProviderId[] {
  const out: CatalogProviderId[] = [];
  for (const [provider, value] of Object.entries(raw ?? {})) {
    const cleanProvider = provider.trim().toLowerCase();
    const cleanValue = value.trim();
    if (cleanProvider && cleanValue) out.push({ provider: cleanProvider, value: cleanValue });
  }
  out.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return out;
}

// sha256 over the canonical JSON of stored content. Key order is fixed by
// construction; genres/studios/providers are sorted; people keep source order
// (billing order is content). source_revision deliberately excluded.
export function fingerprintItem(content: Omit<CatalogItemModel, "contentHash" | "source" | "externalId" | "sourceRevision">): string {
  const canonical = {
    kind: content.kind,
    parentExternalId: content.parentExternalId,
    name: content.name,
    sortName: content.sortName,
    originalTitle: content.originalTitle,
    productionYear: content.productionYear,
    premiereDate: content.premiereDate,
    overview: content.overview,
    officialRating: content.officialRating,
    communityRating: content.communityRating,
    runtimeSeconds: content.runtimeSeconds,
    indexNumber: content.indexNumber,
    parentIndexNumber: content.parentIndexNumber,
    path: content.path,
    container: content.container,
    sizeBytes: content.sizeBytes,
    dateCreated: content.dateCreated,
    primaryImageTag: content.primaryImageTag,
    providerIds: content.providerIds.map((p) => [p.provider, p.value]),
    genres: [...content.genres].sort(),
    studios: [...content.studios].sort(),
    people: content.people.map((p) => [p.name, p.roleType, p.roleName, p.listOrder])
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function fingerprintLibrary(content: Omit<CatalogLibraryModel, "contentHash" | "source" | "externalId">): string {
  return sha256Hex(JSON.stringify({ name: content.name, collectionType: content.collectionType, primaryImageTag: content.primaryImageTag }));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type MappedLibrary =
  | { outcome: "skip"; reason: string }
  | { outcome: "invalid"; externalId: string; reason: string }
  | { outcome: "ok"; model: CatalogLibraryModel };

export function mapJellyfinLibrary(raw: JellyfinLibraryRaw): MappedLibrary {
  const externalId = text(raw.Id);
  const name = text(raw.Name);
  if (!externalId) return { outcome: "skip", reason: "library_without_id" };
  if (!name) return { outcome: "invalid", externalId, reason: "library_without_name" };
  const content = {
    name,
    collectionType: text(raw.CollectionType),
    primaryImageTag: text(raw.ImageTags?.Primary)
  };
  return {
    outcome: "ok",
    model: { source: "jellyfin", externalId, ...content, contentHash: fingerprintLibrary(content) }
  };
}

export function mapJellyfinItem(raw: JellyfinItemRaw): MappedItem {
  const externalId = text(raw.Id);
  const kind = raw.Type === undefined ? undefined : KIND_BY_TYPE[raw.Type];
  if (!externalId || !kind) {
    return {
      outcome: "skip",
      reason: !externalId ? "item_without_id" : `unsupported_type:${raw.Type ?? "unknown"}`
    };
  }
  const name = text(raw.Name);
  if (!name) return { outcome: "invalid", externalId, reason: "item_without_name" };

  // Seasons hang off their series; episodes off their season, falling back to
  // the series for season-less shows. A child without any parent id cannot
  // satisfy the schema's FK and is quarantined by the engine.
  let parentExternalId: string | null = null;
  let parentKind: "series" | "season" | null = null;
  if (kind === "season") {
    parentExternalId = text(raw.SeriesId);
    parentKind = parentExternalId === null ? null : "series";
  } else if (kind === "episode") {
    const seasonId = text(raw.SeasonId);
    if (seasonId !== null) {
      parentExternalId = seasonId;
      parentKind = "season";
    } else {
      parentExternalId = text(raw.SeriesId);
      parentKind = parentExternalId === null ? null : "series";
    }
  }

  const sizeBytes = raw.Size === undefined ? null : Number(raw.Size);
  const runtimeSeconds =
    typeof raw.RuntimeTicks === "number" && Number.isFinite(raw.RuntimeTicks)
      ? Math.max(0, Math.round(raw.RuntimeTicks / 10_000_000))
      : null;
  const communityRating =
    typeof raw.CommunityRating === "number" && Number.isFinite(raw.CommunityRating)
      ? raw.CommunityRating
      : null;

  let listOrder = 0;
  const people: CatalogPersonRef[] = [];
  for (const person of raw.People ?? []) {
    const personName = text(person.Name);
    if (!personName) continue;
    people.push({
      name: personName,
      roleType: person.Type === undefined ? "other" : ROLE_BY_TYPE[person.Type] ?? "other",
      roleName: text(person.Role),
      listOrder,
      providerIds: cleanProviderIds(person.ProviderIds).reduce<Record<string, string>>((acc, p) => {
        acc[p.provider] = p.value;
        return acc;
      }, {})
    });
    listOrder += 1;
  }

  const genres = (raw.Genres ?? []).map((g) => g.trim()).filter((g) => g !== "");
  const studios = (raw.Studios ?? [])
    .map((s) => text(s.Name))
    .filter((s): s is string => s !== null);

  const content = {
    kind,
    parentExternalId,
    parentKind,
    name,
    sortName: text(raw.SortName),
    originalTitle: text(raw.OriginalTitle),
    productionYear: typeof raw.ProductionYear === "number" ? raw.ProductionYear : null,
    premiereDate: text(raw.PremiereDate)?.slice(0, 10) ?? null,
    overview: text(raw.Overview),
    officialRating: text(raw.OfficialRating),
    communityRating,
    runtimeSeconds,
    indexNumber: typeof raw.IndexNumber === "number" ? raw.IndexNumber : null,
    parentIndexNumber: typeof raw.ParentIndexNumber === "number" ? raw.ParentIndexNumber : null,
    path: text(raw.Path),
    container: text(raw.Container),
    sizeBytes: sizeBytes !== null && Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
    dateCreated: text(raw.DateCreated),
    primaryImageTag: text(raw.ImageTags?.Primary),
    providerIds: cleanProviderIds(raw.ProviderIds),
    genres,
    studios,
    people
  };

  return {
    outcome: "mapped",
    model: {
      source: "jellyfin",
      externalId,
      sourceRevision: text(raw.ETag) ?? text(raw.DateLastSaved),
      ...content,
      contentHash: fingerprintItem(content)
    }
  };
}

// Engine consumes models in FK-safe order.
export const KIND_RANK: Record<CatalogKind, number> = { series: 0, movie: 0, season: 1, episode: 2 };

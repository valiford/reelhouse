// Pure household-manifest validation and normalization (no I/O, no clock).
//
// The household import consumes a complete household snapshot — a JSON
// manifest describing every profile and its ReelHouse-owned state. This
// module is the fail-closed boundary between "bytes someone handed us" and
// the loader: every field is type/shape/bound checked here, so the SQL
// layer only ever sees a payload that cannot violate the schema contracts.
//
// Determinism rules (verified by unit tests):
// - First occurrence wins. Item-level duplicates inside one manifest are
//   benign when identical (collapsed) and counted as conflicts when they
//   differ (the later occurrence is skipped) — mirroring the catalog
//   duplicate policy. The run still proceeds.
// - The hard failures are ambiguous identities: two different display
//   names mapping to the same profile slug, two names per watchlist/collection
//   slug, or two profiles claiming the household default in one snapshot.
//   Those are identity collisions, not conflicts to silently resolve, and
//   they fail closed.
// - Payload order is preserved: it becomes the deterministic position of
//   favorites, list entries, and home rows.
// - Optional timestamps are canonicalized to ISO-8601 UTC or null, so the
//   same logical snapshot normalizes byte-identically.

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export const HOUSEHOLD_MANIFEST_LIMITS = {
  maxProfiles: 64,
  maxNameLength: 200,
  maxSlugLength: 64,
  maxInitialsLength: 8,
  maxJellyfinIdLength: 128,
  maxDescriptionLength: 2000,
  maxPreferencesPerProfile: 64,
  maxFavoritesPerProfile: 5000,
  maxWatchlistsPerProfile: 64,
  maxEntriesPerList: 2000,
  maxCollections: 256,
  maxHomeRowsPerProfile: 64,
  maxWatchStatePerProfile: 20000,
  maxHistoryPerProfile: 20000
} as const;

// The known preference registry: key → allowed values. An unknown key fails
// the import (typo protection, bounded contract) instead of silently
// landing an unreadable preference.
export const PREFERENCE_KEYS = {
  theme: ["dark", "light", "system"],
  autoplay_next: "boolean",
  reduced_motion: "boolean",
  preferred_audio_language: "string",
  preferred_subtitle_language: "string"
} as const;

export type PreferenceValue = string | number | boolean;

export const HOME_ROW_KINDS = [
  "continue_watching",
  "recently_added",
  "favorites",
  "library",
  "collection",
  "watchlist"
] as const;

export type HomeRowKind = (typeof HOME_ROW_KINDS)[number];

// The one config key each reference kind may carry; built-in rails carry {}.
const HOME_ROW_CONFIG_KEYS: Record<HomeRowKind, string | null> = {
  continue_watching: null,
  recently_added: null,
  favorites: null,
  library: "library_jellyfin_id",
  collection: "collection_slug",
  watchlist: "watchlist_slug"
};

export interface ManifestListEntry {
  jellyfinId: string;
  addedAt: string | null;
}

export interface ManifestWatchlist {
  slug: string;
  name: string;
  entries: ManifestListEntry[];
}

export interface ManifestHomeRow {
  slug: string;
  kind: HomeRowKind;
  title: string;
  enabled: boolean;
  config: Record<string, string>;
}

export interface ManifestWatchStateEntry {
  jellyfinId: string;
  positionTicks: number | null;
  durationTicks: number | null;
  completed: boolean;
  hiddenFromContinue: boolean;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
}

export interface ManifestHistoryEntry {
  jellyfinId: string;
  playedAt: string;
  positionTicks: number | null;
  durationTicks: number | null;
  completed: boolean;
}

export interface ManifestProfile {
  slug: string;
  name: string;
  initials: string | null;
  isDefault: boolean;
  jellyfinUserId: string | null;
  preferences: Array<{ key: string; value: PreferenceValue }>;
  favorites: ManifestListEntry[];
  watchlists: ManifestWatchlist[];
  homeRows: ManifestHomeRow[];
  watchState: ManifestWatchStateEntry[];
  playbackHistory: ManifestHistoryEntry[];
}

export interface ManifestCollection {
  slug: string;
  name: string;
  description: string | null;
  entries: ManifestListEntry[];
}

export interface NormalizedManifest {
  profiles: ManifestProfile[];
  collections: ManifestCollection[];
  // Item-level duplicate occurrences that differed and were skipped (first
  // occurrence won). The loader records this on the run row.
  conflictsSkipped: number;
}

const SLUG_PATTERN = /^[a-z0-9_]+$/;

// Derives the pinned profile identity from a display name. The slug is
// contractual: once a profile exists under a slug, renaming never rewrites
// its rows — so the derivation must be deterministic and collision-free for
// distinct names (collisions fail the import).
export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) {
    throw new ManifestError(`display name ${JSON.stringify(name)} produces an empty slug`);
  }
  if (slug.length > HOUSEHOLD_MANIFEST_LIMITS.maxSlugLength) {
    throw new ManifestError(
      `display name ${JSON.stringify(name)} produces a slug longer than ${HOUSEHOLD_MANIFEST_LIMITS.maxSlugLength} characters`
    );
  }
  return slug;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

// Optional object fields (e.g. per-profile preferences) default to empty.
function optionalObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return requireObject(value, label);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ManifestError(`${label} must be an array`);
  return value;
}

// Rejects keys outside the known contract so a typo ("favorits") can never
// silently drop part of a household snapshot.
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ManifestError(`${label} has unknown field "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ManifestError(`${label} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ManifestError(`${label} exceeds ${maxLength} characters`);
  }
  return trimmed;
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, label, maxLength);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ManifestError(`${label} must be a boolean`);
  return value;
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  return requireBoolean(value, label);
}

// Ticks are PostgreSQL bigint: bounded to the JS safe range so a value that
// would corrupt on the wire fails here instead of at the database.
function optionalTicks(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ManifestError(`${label} must be a non-negative safe integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

// Canonicalizes an optional source timestamp: parseable dates become UTC
// ISO-8601; anything else fails closed (a typo'd timestamp must never be
// silently dropped — it is provenance).
export function canonicalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ManifestError(`${label} must be an ISO-8601 string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ManifestError(`${label} is not a parseable timestamp (got ${JSON.stringify(value)})`);
  }
  return parsed.toISOString();
}

function requireTimestamp(value: unknown, label: string): string {
  const canonical = canonicalTimestamp(value, label);
  if (canonical === null) throw new ManifestError(`${label} is required`);
  return canonical;
}

function requireJellyfinId(value: unknown, label: string): string {
  return requireString(value, label, HOUSEHOLD_MANIFEST_LIMITS.maxJellyfinIdLength);
}

function validateSlug(value: unknown, label: string): string {
  const slug = requireString(value, label, HOUSEHOLD_MANIFEST_LIMITS.maxSlugLength);
  if (!SLUG_PATTERN.test(slug)) {
    throw new ManifestError(`${label} must match ${SLUG_PATTERN.source} (got "${slug}")`);
  }
  return slug;
}

function validatePreference(key: string, value: unknown, label: string): PreferenceValue {
  const rule = (PREFERENCE_KEYS as Record<string, unknown>)[key];
  if (!rule) {
    throw new ManifestError(
      `${label} uses unknown preference key "${key}" (known: ${Object.keys(PREFERENCE_KEYS).join(", ")})`
    );
  }
  if (Array.isArray(rule)) {
    if (typeof value !== "string" || !(rule as readonly string[]).includes(value)) {
      throw new ManifestError(
        `${label}.${key} must be one of: ${(rule as readonly string[]).join(", ")} (got ${JSON.stringify(value)})`
      );
    }
    return value;
  }
  if (rule === "boolean") return requireBoolean(value, `${label}.${key}`);
  return requireString(value, `${label}.${key}`, 32);
}

function validateHomeRow(raw: unknown, label: string): ManifestHomeRow {
  const record = requireObject(raw, label);
  rejectUnknownKeys(record, ["slug", "kind", "title", "enabled", "config"], label);
  const kind = requireString(record.kind, `${label}.kind`, 32) as HomeRowKind;
  if (!(HOME_ROW_KINDS as readonly string[]).includes(kind)) {
    throw new ManifestError(
      `${label}.kind must be one of: ${HOME_ROW_KINDS.join(", ")} (got "${kind}")`
    );
  }
  const configKey = HOME_ROW_CONFIG_KEYS[kind];
  let config: Record<string, string> = {};
  if (record.config !== undefined && record.config !== null) {
    const rawConfig = requireObject(record.config, `${label}.config`);
    const keys = Object.keys(rawConfig);
    if (configKey === null) {
      if (keys.length) {
        throw new ManifestError(`${label}.config must be empty for kind "${kind}"`);
      }
    } else {
      if (keys.length !== 1 || keys[0] !== configKey) {
        throw new ManifestError(
          `${label}.config for kind "${kind}" must be exactly { ${configKey}: string }`
        );
      }
      config = { [configKey]: requireString(rawConfig[configKey], `${label}.config.${configKey}`, 200) };
    }
  } else if (configKey !== null) {
    throw new ManifestError(`${label}.config for kind "${kind}" must provide ${configKey}`);
  }
  const title = requireString(record.title, `${label}.title`, HOUSEHOLD_MANIFEST_LIMITS.maxNameLength);
  return {
    slug: record.slug !== undefined && record.slug !== null
      ? validateSlug(record.slug, `${label}.slug`)
      : slugifyName(title),
    kind,
    title,
    enabled: optionalBoolean(record.enabled, `${label}.enabled`, true),
    config
  };
}

function validateListEntry(raw: unknown, label: string): ManifestListEntry {
  const record = requireObject(raw, label);
  rejectUnknownKeys(record, ["jellyfinId", "addedAt"], label);
  return {
    jellyfinId: requireJellyfinId(record.jellyfinId, `${label}.jellyfinId`),
    addedAt: canonicalTimestamp(record.addedAt, `${label}.addedAt`)
  };
}

function listEntriesEqual(a: ManifestListEntry, b: ManifestListEntry): boolean {
  return a.jellyfinId === b.jellyfinId && a.addedAt === b.addedAt;
}

// Standard item-level duplicate policy for keyed entries within one
// manifest: first occurrence wins; identical repetitions collapse; differing
// repetitions are counted (via onConflict) and skipped.
class KeyedEntries<T> {
  readonly items: T[] = [];
  private readonly index = new Map<string, T>();
  private readonly keyOf: (item: T) => string;
  private readonly equals: (a: T, b: T) => boolean;

  constructor(keyOf: (item: T) => string, equals: (a: T, b: T) => boolean) {
    this.keyOf = keyOf;
    this.equals = equals;
  }

  add(item: T, onConflict: () => void): void {
    const key = this.keyOf(item);
    const existing = this.index.get(key);
    if (existing === undefined) {
      this.index.set(key, item);
      this.items.push(item);
      return;
    }
    if (!this.equals(existing, item)) onConflict();
  }
}

// Validates and normalizes a raw manifest (parsed JSON) into the loader
// payload. Throws ManifestError on any contract violation; never touches
// the network or the clock.
export function normalizeManifest(raw: unknown): NormalizedManifest {
  const root = requireObject(raw, "manifest");
  rejectUnknownKeys(root, ["profiles", "collections"], "manifest");

  let conflictsSkipped = 0;
  const conflict = (): void => {
    conflictsSkipped += 1;
  };

  const rawProfiles = requireArray(root.profiles, "manifest.profiles");
  if (rawProfiles.length > HOUSEHOLD_MANIFEST_LIMITS.maxProfiles) {
    throw new ManifestError(
      `manifest.profiles exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxProfiles} profiles (got ${rawProfiles.length})`
    );
  }

  const profilesBySlug = new Map<string, ManifestProfile>();
  const slugToName = new Map<string, string>();
  let defaultAssigned = false;

  const childState = new Map<string, {
    preferences: KeyedEntries<{ key: string; value: PreferenceValue }>;
    favorites: KeyedEntries<ManifestListEntry>;
    watchlists: Map<string, { name: string; entries: KeyedEntries<ManifestListEntry> }>;
    watchlistOrder: string[];
    homeRows: KeyedEntries<ManifestHomeRow>;
    watchState: KeyedEntries<ManifestWatchStateEntry>;
    history: KeyedEntries<ManifestHistoryEntry>;
  }>();

  const childrenOf = (slug: string) => {
    let children = childState.get(slug);
    if (!children) {
      children = {
        preferences: new KeyedEntries(
          (entry) => entry.key,
          (a, b) => a.value === b.value
        ),
        favorites: new KeyedEntries(
          (entry) => entry.jellyfinId,
          listEntriesEqual
        ),
        watchlists: new Map(),
        watchlistOrder: [],
        homeRows: new KeyedEntries(
          (row) => row.slug,
          (a, b) =>
            a.kind === b.kind && a.title === b.title && a.enabled === b.enabled &&
            JSON.stringify(a.config) === JSON.stringify(b.config)
        ),
        watchState: new KeyedEntries(
          (entry) => entry.jellyfinId,
          (a, b) =>
            a.positionTicks === b.positionTicks && a.durationTicks === b.durationTicks &&
            a.completed === b.completed && a.hiddenFromContinue === b.hiddenFromContinue &&
            a.firstPlayedAt === b.firstPlayedAt && a.lastPlayedAt === b.lastPlayedAt
        ),
        history: new KeyedEntries(
          (entry) => `${entry.jellyfinId}\n${entry.playedAt}`,
          (a, b) =>
            a.positionTicks === b.positionTicks && a.durationTicks === b.durationTicks &&
            a.completed === b.completed
        )
      };
      childState.set(slug, children);
    }
    return children;
  };

  rawProfiles.forEach((rawProfile, index) => {
    const label = `manifest.profiles[${index}]`;
    const record = requireObject(rawProfile, label);
    rejectUnknownKeys(
      record,
      ["slug", "name", "initials", "isDefault", "jellyfinUserId", "preferences", "favorites", "watchlists", "homeRows", "watchState", "playbackHistory"],
      label
    );
    const name = requireString(record.name, `${label}.name`, HOUSEHOLD_MANIFEST_LIMITS.maxNameLength);
    const slug = record.slug !== undefined && record.slug !== null
      ? validateSlug(record.slug, `${label}.slug`)
      : slugifyName(name);

    // The one hard identity ambiguity: two different names claiming the
    // same profile slug.
    const existingName = slugToName.get(slug);
    if (existingName !== undefined && existingName !== name) {
      throw new ManifestError(
        `ambiguous household identity: display names ${JSON.stringify(existingName)} and ${JSON.stringify(name)} both map to profile slug "${slug}"`
      );
    }
    slugToName.set(slug, name);

    let isDefault = optionalBoolean(record.isDefault, `${label}.isDefault`, false);
    if (isDefault) {
      if (defaultAssigned) {
        // One active default is a schema invariant; the first claim wins
        // deterministically and later claims are counted, not fatal.
        conflictsSkipped += 1;
        isDefault = false;
      } else {
        defaultAssigned = true;
      }
    }

    const profile: ManifestProfile = {
      slug,
      name,
      initials: optionalString(record.initials, `${label}.initials`, HOUSEHOLD_MANIFEST_LIMITS.maxInitialsLength),
      isDefault,
      jellyfinUserId: optionalString(
        record.jellyfinUserId,
        `${label}.jellyfinUserId`,
        HOUSEHOLD_MANIFEST_LIMITS.maxJellyfinIdLength
      ),
      preferences: [],
      favorites: [],
      watchlists: [],
      homeRows: [],
      watchState: [],
      playbackHistory: []
    };

    const existing = profilesBySlug.get(slug);
    if (!existing) {
      profilesBySlug.set(slug, profile);
    } else if (
      existing.name !== profile.name ||
      existing.initials !== profile.initials ||
      existing.isDefault !== profile.isDefault ||
      existing.jellyfinUserId !== profile.jellyfinUserId
    ) {
      // Same identity, different scalar description: first occurrence wins,
      // the difference is recorded (children still merge below).
      conflict();
    }

    const children = childrenOf(slug);

    const rawPreferences = optionalObject(record.preferences, `${label}.preferences`);
    const prefKeys = Object.keys(rawPreferences);
    if (prefKeys.length > HOUSEHOLD_MANIFEST_LIMITS.maxPreferencesPerProfile) {
      throw new ManifestError(
        `${label}.preferences exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxPreferencesPerProfile} keys`
      );
    }
    for (const key of prefKeys) {
      children.preferences.add(
        { key, value: validatePreference(key, rawPreferences[key], label) },
        () => conflict()
      );
    }

    const rawFavorites = requireArray(record.favorites, `${label}.favorites`);
    if (rawFavorites.length > HOUSEHOLD_MANIFEST_LIMITS.maxFavoritesPerProfile) {
      throw new ManifestError(
        `${label}.favorites exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxFavoritesPerProfile} entries`
      );
    }
    for (const entry of rawFavorites) {
      children.favorites.add(validateListEntry(entry, `${label}.favorites[]`), () => conflict());
    }

    const rawWatchlists = requireArray(record.watchlists, `${label}.watchlists`);
    if (rawWatchlists.length > HOUSEHOLD_MANIFEST_LIMITS.maxWatchlistsPerProfile) {
      throw new ManifestError(
        `${label}.watchlists exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxWatchlistsPerProfile} lists`
      );
    }
    rawWatchlists.forEach((rawList, listIndex) => {
      const listLabel = `${label}.watchlists[${listIndex}]`;
      const listRecord = requireObject(rawList, listLabel);
      rejectUnknownKeys(listRecord, ["slug", "name", "entries"], listLabel);
      const listName = requireString(listRecord.name, `${listLabel}.name`, HOUSEHOLD_MANIFEST_LIMITS.maxNameLength);
      const listSlug = listRecord.slug !== undefined && listRecord.slug !== null
        ? validateSlug(listRecord.slug, `${listLabel}.slug`)
        : slugifyName(listName);
      const rawEntries = requireArray(listRecord.entries, `${listLabel}.entries`);
      if (rawEntries.length > HOUSEHOLD_MANIFEST_LIMITS.maxEntriesPerList) {
        throw new ManifestError(
          `${listLabel}.entries exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxEntriesPerList} entries`
        );
      }

      const existingList = children.watchlists.get(listSlug);
      if (!existingList) {
        const entries = new KeyedEntries<ManifestListEntry>(
          (entry) => entry.jellyfinId,
          listEntriesEqual
        );
        for (const entry of rawEntries) {
          entries.add(validateListEntry(entry, `${listLabel}.entries[]`), () => conflict());
        }
        children.watchlists.set(listSlug, { name: listName, entries });
        children.watchlistOrder.push(listSlug);
        return;
      }
      if (existingList.name !== listName) {
        throw new ManifestError(
          `ambiguous watchlist identity: names ${JSON.stringify(existingList.name)} and ${JSON.stringify(listName)} both map to slug "${listSlug}" in profile "${slug}"`
        );
      }
      for (const entry of rawEntries) {
        existingList.entries.add(validateListEntry(entry, `${listLabel}.entries[]`), () => conflict());
      }
    });

    const rawHomeRows = requireArray(record.homeRows, `${label}.homeRows`);
    if (rawHomeRows.length > HOUSEHOLD_MANIFEST_LIMITS.maxHomeRowsPerProfile) {
      throw new ManifestError(
        `${label}.homeRows exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxHomeRowsPerProfile} rows`
      );
    }
    for (const row of rawHomeRows) {
      children.homeRows.add(validateHomeRow(row, `${label}.homeRows[]`), () => conflict());
    }

    const rawWatchState = requireArray(record.watchState, `${label}.watchState`);
    if (rawWatchState.length > HOUSEHOLD_MANIFEST_LIMITS.maxWatchStatePerProfile) {
      throw new ManifestError(
        `${label}.watchState exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxWatchStatePerProfile} entries`
      );
    }
    for (const rawEntry of rawWatchState) {
      const entryLabel = `${label}.watchState[]`;
      const entryRecord = requireObject(rawEntry, entryLabel);
      rejectUnknownKeys(
        entryRecord,
        ["jellyfinId", "positionTicks", "durationTicks", "completed", "hiddenFromContinue", "firstPlayedAt", "lastPlayedAt"],
        entryLabel
      );
      children.watchState.add(
        {
          jellyfinId: requireJellyfinId(entryRecord.jellyfinId, `${entryLabel}.jellyfinId`),
          positionTicks: optionalTicks(entryRecord.positionTicks, `${entryLabel}.positionTicks`),
          durationTicks: optionalTicks(entryRecord.durationTicks, `${entryLabel}.durationTicks`),
          completed: optionalBoolean(entryRecord.completed, `${entryLabel}.completed`, false),
          hiddenFromContinue: optionalBoolean(entryRecord.hiddenFromContinue, `${entryLabel}.hiddenFromContinue`, false),
          firstPlayedAt: canonicalTimestamp(entryRecord.firstPlayedAt, `${entryLabel}.firstPlayedAt`),
          lastPlayedAt: canonicalTimestamp(entryRecord.lastPlayedAt, `${entryLabel}.lastPlayedAt`)
        },
        () => conflict()
      );
    }

    const rawHistory = requireArray(record.playbackHistory, `${label}.playbackHistory`);
    if (rawHistory.length > HOUSEHOLD_MANIFEST_LIMITS.maxHistoryPerProfile) {
      throw new ManifestError(
        `${label}.playbackHistory exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxHistoryPerProfile} events`
      );
    }
    for (const rawEntry of rawHistory) {
      const entryLabel = `${label}.playbackHistory[]`;
      const entryRecord = requireObject(rawEntry, entryLabel);
      rejectUnknownKeys(
        entryRecord,
        ["jellyfinId", "playedAt", "positionTicks", "durationTicks", "completed"],
        entryLabel
      );
      children.history.add(
        {
          jellyfinId: requireJellyfinId(entryRecord.jellyfinId, `${entryLabel}.jellyfinId`),
          playedAt: requireTimestamp(entryRecord.playedAt, `${entryLabel}.playedAt`),
          positionTicks: optionalTicks(entryRecord.positionTicks, `${entryLabel}.positionTicks`),
          durationTicks: optionalTicks(entryRecord.durationTicks, `${entryLabel}.durationTicks`),
          completed: optionalBoolean(entryRecord.completed, `${entryLabel}.completed`, false)
        },
        () => conflict()
      );
    }
  });

  // Watchlist entry dedup happens across profile occurrences, so the
  // per-list accumulation is finished here (first occurrence of each entry
  // in payload order wins).
  const profiles: ManifestProfile[] = [];
  for (const profile of profilesBySlug.values()) {
    const children = childState.get(profile.slug);
    if (!children) throw new Error(`internal: no child state for profile "${profile.slug}"`);
    profiles.push({
      ...profile,
      preferences: children.preferences.items,
      favorites: children.favorites.items,
      watchlists: children.watchlistOrder.map((slug) => {
        const list = children.watchlists.get(slug);
        if (!list) throw new Error(`internal: no watchlist "${slug}"`);
        return { slug, name: list.name, entries: list.entries.items };
      }),
      homeRows: children.homeRows.items,
      watchState: children.watchState.items,
      playbackHistory: children.history.items
    });
  }

  const rawCollections = requireArray(root.collections, "manifest.collections");
  if (rawCollections.length > HOUSEHOLD_MANIFEST_LIMITS.maxCollections) {
    throw new ManifestError(
      `manifest.collections exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxCollections} collections`
    );
  }
  const collections: ManifestCollection[] = [];
  const collectionsBySlug = new Map<string, ManifestCollection>();
  rawCollections.forEach((rawCollection, index) => {
    const label = `manifest.collections[${index}]`;
    const record = requireObject(rawCollection, label);
    rejectUnknownKeys(record, ["slug", "name", "description", "entries"], label);
    const name = requireString(record.name, `${label}.name`, HOUSEHOLD_MANIFEST_LIMITS.maxNameLength);
    const slug = record.slug !== undefined && record.slug !== null
      ? validateSlug(record.slug, `${label}.slug`)
      : slugifyName(name);
    const rawEntries = requireArray(record.entries, `${label}.entries`);
    if (rawEntries.length > HOUSEHOLD_MANIFEST_LIMITS.maxEntriesPerList) {
      throw new ManifestError(
        `${label}.entries exceeds ${HOUSEHOLD_MANIFEST_LIMITS.maxEntriesPerList} entries`
      );
    }

    const existing = collectionsBySlug.get(slug);
    if (!existing) {
      const collection: ManifestCollection = {
        slug,
        name,
        description: optionalString(record.description, `${label}.description`, HOUSEHOLD_MANIFEST_LIMITS.maxDescriptionLength),
        entries: rawEntries.map((entry) => validateListEntry(entry, `${label}.entries[]`))
      };
      collectionsBySlug.set(slug, collection);
      collections.push(collection);
      return;
    }
    if (existing.name !== name) {
      throw new ManifestError(
        `ambiguous collection identity: names ${JSON.stringify(existing.name)} and ${JSON.stringify(name)} both map to collection slug "${slug}"`
      );
    }
    for (const entry of rawEntries) {
      const candidate = validateListEntry(entry, `${label}.entries[]`);
      const incumbent = existing.entries.find((e) => e.jellyfinId === candidate.jellyfinId);
      if (!incumbent) {
        existing.entries.push(candidate);
      } else if (!listEntriesEqual(incumbent, candidate)) {
        conflict();
      }
    }
  });

  // A snapshot whose profiles declare no default is legal (the household
  // simply has not chosen one); the single-default invariant is enforced by
  // the schema's partial unique index for active rows, and the parse pass
  // above guarantees at most one profile carries the flag.
  return { profiles, collections, conflictsSkipped };
}

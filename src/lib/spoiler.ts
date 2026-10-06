import type { MediaItem } from "./types";

export type SpoilerShieldPreference = "shield" | "show";

/**
 * Conservative default: unwatched titles stay protected until a profile
 * deliberately opts out. Storage failures also fall back to this value.
 */
export const DEFAULT_SPOILER_SHIELD_PREFERENCE: SpoilerShieldPreference = "shield";

export const SPOILER_SHIELD_STORAGE_KEY = "reelhouse.spoiler-shield.v1";

export type ProfileSpoilerShieldPreferences = Record<string, SpoilerShieldPreference>;

export function normalizeSpoilerShieldPreference(value: unknown): SpoilerShieldPreference {
  return value === "show" ? "show" : "shield";
}

export function parseProfileSpoilerShieldPreferences(raw: string | null | undefined): ProfileSpoilerShieldPreferences {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const preferences: ProfileSpoilerShieldPreferences = {};
  for (const [profile, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (profile) preferences[profile] = normalizeSpoilerShieldPreference(value);
  }
  return preferences;
}

export type SpoilerShieldStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function readProfileSpoilerShieldPreference(
  store: SpoilerShieldStore | null | undefined,
  profile: string
): SpoilerShieldPreference {
  if (!store || !profile) return DEFAULT_SPOILER_SHIELD_PREFERENCE;
  try {
    const stored = parseProfileSpoilerShieldPreferences(store.getItem(SPOILER_SHIELD_STORAGE_KEY));
    return stored[profile] ?? DEFAULT_SPOILER_SHIELD_PREFERENCE;
  } catch {
    return DEFAULT_SPOILER_SHIELD_PREFERENCE;
  }
}

export function writeProfileSpoilerShieldPreference(
  store: SpoilerShieldStore | null | undefined,
  profile: string,
  preference: SpoilerShieldPreference
): void {
  if (!store || !profile) return;
  try {
    const stored = parseProfileSpoilerShieldPreferences(store.getItem(SPOILER_SHIELD_STORAGE_KEY));
    stored[profile] = preference;
    store.setItem(SPOILER_SHIELD_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory preference still applies.
  }
}

/**
 * Shielding requires the explicit watch-state contract: only Jellyfin's
 * UserData.Played marks an item watched, playback progress alone never does,
 * and an unknown watch state stays protected.
 */
export function isSpoilerShielded(
  item: Pick<MediaItem, "watched">,
  preference: SpoilerShieldPreference,
  revealed: boolean
): boolean {
  if (preference !== "shield") return false;
  if (revealed) return false;
  return item.watched !== true;
}

export const SPOILER_SHIELD_COPY = {
  maskedSynopsis: "Synopsis hidden — the spoiler shield protects unwatched titles.",
  revealItem: "Reveal",
  hideItem: "Hide",
  revealSynopsis: "Reveal synopsis",
  hideSynopsis: "Hide synopsis",
  revealSpoilers: "Reveal spoilers",
  hideSpoilers: "Hide spoilers"
} as const;

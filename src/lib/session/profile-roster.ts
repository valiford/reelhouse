// Client-side contract for the profile switcher's roster (RH-0046).
//
// Pure and hermetically testable, like profile-session: how a roster payload
// is validated into renderable entries (a row without its server identity is
// never switchable), which entry IS this session (the effective identity —
// the feed's resolved slug once known, else the asserted URL slug), and what
// activating an entry means (navigate to its ?profile= URL — or nothing at
// all when the entry already IS the current session, so re-selecting never
// reboots). The navigation itself belongs to the caller: the RH-0043 URL
// identity contract owns the switch and its bounded cleanup; this module
// only decides the target and refuses no-op ones.

import { normalizeProfileSlug } from "./profile-session.ts";

export interface ProfileRosterEntry {
  slug: string;
  displayName: string;
  initials: string | null;
  isDefault: boolean;
}

// Mirror of the server's roster cap (readmodels/params MAX_PROFILE_ROSTER):
// the client renders at most this many entries even if a payload claims more.
export const MAX_ROSTER_ENTRIES = 50;

// Demo mode has no household (the database is unconfigured) — the delivered
// fixture identity is the "demo" session itself (the spoiler-store key rule).
// The switcher lists it so the surface exists everywhere, and activating it
// is a re-selection of the current session, never a navigation.
export const DEMO_ROSTER_ENTRY: ProfileRosterEntry = {
  slug: "demo",
  displayName: "Demo",
  initials: "D",
  isDefault: true
};

/**
 * Validates a /api/profiles payload into renderable entries. Anything that
 * is not a shaped roster row is dropped, not fabricated: an entry without a
 * non-empty slug has no server identity to navigate to and is never rendered
 * switchable, and the list is capped so a hostile payload cannot inflate the
 * dialog.
 */
export function parseProfileRoster(body: unknown): ProfileRosterEntry[] {
  const rows =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as { profiles?: unknown }).profiles
      : null;
  if (!Array.isArray(rows)) return [];
  const entries: ProfileRosterEntry[] = [];
  for (const row of rows) {
    if (entries.length >= MAX_ROSTER_ENTRIES) break;
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const slugRaw = (row as { slug?: unknown }).slug;
    const slug = typeof slugRaw === "string" ? normalizeProfileSlug(slugRaw) : null;
    const displayName = (row as { display_name?: unknown }).display_name;
    if (slug === null) continue;
    if (typeof displayName !== "string" || displayName.trim() === "") continue;
    const initials = (row as { initials?: unknown }).initials;
    entries.push({
      slug,
      displayName,
      initials: typeof initials === "string" && initials.trim() !== "" ? initials : null,
      isDefault: (row as { is_default?: unknown }).is_default === true
    });
  }
  return entries;
}

/**
 * The session's effective profile identity for marking the active roster
 * entry: the feed's resolved slug is the authority once known (it covers the
 * unscoped default view), falling back to the asserted URL slug while the
 * feed has not resolved (or refused to — an unknown slug marks nothing).
 */
export function activeRosterSlug(urlSlug: string | null, resolvedSlug: string | null): string | null {
  return resolvedSlug ?? urlSlug;
}

/**
 * The URL to navigate to when a roster entry is activated, or null when the
 * activation is a re-selection of the current session: navigating to the
 * identical identity would trip the RH-0043 switch contract and drop cached
 * state for no change, so the caller just closes the switcher instead.
 */
export function profileSwitchTarget(currentSlug: string | null, targetSlug: string): string | null {
  const target = normalizeProfileSlug(targetSlug);
  if (target === null || target === currentSlug) return null;
  return `/?profile=${encodeURIComponent(target)}`;
}

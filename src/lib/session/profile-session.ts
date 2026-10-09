// Profile session identity for the living-room UI (RH-0043).
//
// The household profile is a URL identity: ?profile=<slug> asserts whose
// session this is, and the server resolves that slug against the active
// household (unknown slug → 404, never a silent fallback). The slug is the
// contractual identity — display names can be renamed without rewriting
// rows (docs/HOUSEHOLD.md), so nothing session-scoped may key off them.
//
// These helpers define the client contract in pure, hermetically testable
// form: how the asserted identity is read out of the URL, and how in-flight
// work is generation-bound so a late response computed for one profile can
// never land in another profile's view. The React layer owns the actual
// state slices; this module owns the identity rules.

// The server's identifier bound (readmodels/params resolveIdentifier): a
// slug longer than this is a 400 there, so the client passes it through
// unchanged rather than silently dropping the identity — an unparsable
// profile must fail closed into the profile-error panel, never fall back
// to the unscoped default household view.
export const MAX_PROFILE_SLUG_LENGTH = 200;

/**
 * Reads the asserted profile identity out of a URLSearchParams. Trims
 * whitespace and treats blank as "no identity asserted"; everything else
 * passes through verbatim so the server stays the identity authority
 * (an unknown or malformed slug is its 404/400, not a client-side guess).
 */
export function normalizeProfileSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Encodes the profile query parameter for an outbound request. Returns the
 * empty string when no identity is asserted so callers can append it (or
 * not) in one place — every profile-scoped request must carry the exact
 * session identity, formatted identically.
 */
export function profileQueryParam(slug: string | null | undefined): string {
  const slugValue = normalizeProfileSlug(slug);
  return slugValue ? `?profile=${encodeURIComponent(slugValue)}` : "";
}

/**
 * Generation guard for in-flight session work (RH-0043): every fetch
 * captures the token of the generation that started it, and an identity
 * switch invalidates the whole generation. A response whose token is stale
 * is dropped before it can touch state — the explicit contract that a late
 * reply computed for one profile never renders in another's view.
 */
export interface GenerationGuard {
  /** The token live requests must capture right now. */
  start(): number;
  /** Advance the generation: every previously issued token goes stale. */
  invalidate(): void;
  /** True iff the token still belongs to the live generation. */
  isLive(token: number): boolean;
}

export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return {
    start: () => generation,
    invalidate: () => {
      generation += 1;
    },
    isLive: (token: number) => token === generation
  };
}

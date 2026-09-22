// Pure input validation for the household persistence API.
//
// No I/O and no imports, mirroring src/lib/db/config.ts: every rule that a
// request must satisfy is checked here and reported as data, so route
// handlers can answer 400 without ever touching PostgreSQL. The database's
// CHECK/UNIQUE constraints remain the final authority (defense in depth);
// this layer just fails faster and with bounded, value-free messages.
//
// Error messages deliberately never echo the rejected input: request bodies
// are attacker-controlled, and diagnostics must stay bounded (RH-0027
// acceptance). Length limits exist so one write can never balloon the row
// or the log line.

export const HOUSEHOLD_LIMITS = {
  displayNameMax: 100,
  externalIdMax: 512,
  jellyfinUserIdMax: 128,
  preferencesMaxBytes: 16_384,
  preferencesMaxDepth: 32,
  profilesListDefault: 100,
  profilesListMax: 200,
  watchStateDefault: 50,
  watchStateMax: 200,
  continueWatchingDefault: 20,
  continueWatchingMax: 50
} as const;

// bigint columns hold up to 2^63-1, but JSON numbers are only safe to
// Number.MAX_SAFE_INTEGER; requests are capped there so a round-trip through
// JSON can never corrupt a tick value.
const MAX_SAFE_TICKS = Number.MAX_SAFE_INTEGER;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseUuid(raw: unknown, field: string): ParseResult<string> {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    return { ok: false, errors: [`${field} must be a UUID`] };
  }
  return { ok: true, value: raw.toLowerCase() };
}

export function parseDisplayName(raw: unknown): ParseResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, errors: ["display_name must be a string"] };
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > HOUSEHOLD_LIMITS.displayNameMax) {
    return {
      ok: false,
      errors: [`display_name must be between 1 and ${HOUSEHOLD_LIMITS.displayNameMax} characters after trimming`]
    };
  }
  return { ok: true, value: trimmed };
}

export function parseExternalId(raw: unknown): ParseResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, errors: ["external_id must be a string"] };
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > HOUSEHOLD_LIMITS.externalIdMax) {
    return {
      ok: false,
      errors: [`external_id must be between 1 and ${HOUSEHOLD_LIMITS.externalIdMax} characters after trimming`]
    };
  }
  return { ok: true, value: trimmed };
}

// Only Jellyfin exists as a source authority today; the database CHECK
// enforces the same domain. Extending it is a migration, not a request.
export function parseMediaSource(raw: unknown): ParseResult<"jellyfin"> {
  if (raw !== "jellyfin") {
    return { ok: false, errors: ["source must be \"jellyfin\""] };
  }
  return { ok: true, value: "jellyfin" };
}

export function parseJellyfinUserId(raw: unknown): ParseResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, errors: ["jellyfin_user_id must be a string"] };
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > HOUSEHOLD_LIMITS.jellyfinUserIdMax) {
    return {
      ok: false,
      errors: [`jellyfin_user_id must be between 1 and ${HOUSEHOLD_LIMITS.jellyfinUserIdMax} characters after trimming`]
    };
  }
  return { ok: true, value: trimmed };
}

export function parseTicks(raw: unknown, field: string, { allowZero = true } = {}): ParseResult<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { ok: false, errors: [`${field} must be an integer number of ticks`] };
  }
  if (allowZero ? raw < 0 : raw <= 0) {
    return { ok: false, errors: [`${field} must be ${allowZero ? ">= 0" : "> 0"}`] };
  }
  if (raw > MAX_SAFE_TICKS) {
    return { ok: false, errors: [`${field} exceeds the supported tick range`] };
  }
  return { ok: true, value: raw };
}

// Bounded size/depth walk: one recursive pass that refuses both a 10 MB
// preferences blob and a stack-overflow-deep nest, without building either.
function measureJson(value: unknown, depth: number, state: { bytes: number }): { ok: boolean } {
  if (depth > HOUSEHOLD_LIMITS.preferencesMaxDepth) return { ok: false };
  switch (typeof value) {
    case "string": {
      // JSON-escaped length is bounded by 6x the UTF-16 length ("\uXXXX");
      // good enough for a hard cap and never under-counts text.
      state.bytes += value.length * 6 + 2;
      return { ok: state.bytes <= HOUSEHOLD_LIMITS.preferencesMaxBytes };
    }
    case "number":
      state.bytes += String(value).length;
      break;
    case "boolean":
      state.bytes += 5;
      break;
    case "object":
      if (value === null) {
        state.bytes += 4;
        break;
      }
      for (const [key, item] of Object.entries(value)) {
        state.bytes += key.length * 6 + 4;
        if (!measureJson(item, depth + 1, state).ok) return { ok: false };
        if (state.bytes > HOUSEHOLD_LIMITS.preferencesMaxBytes) return { ok: false };
      }
      break;
    default:
      return { ok: false };
  }
  return { ok: state.bytes <= HOUSEHOLD_LIMITS.preferencesMaxBytes };
}

// Preferences are stored as a jsonb object; arrays, scalars, and null are
// refused here exactly like the database CHECK refuses them.
export function parsePreferences(raw: unknown): ParseResult<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["preferences must be a JSON object"] };
  }
  if (!measureJson(raw, 0, { bytes: 0 }).ok) {
    return {
      ok: false,
      errors: [
        `preferences exceed the supported size or nesting depth (${HOUSEHOLD_LIMITS.preferencesMaxBytes} bytes, depth ${HOUSEHOLD_LIMITS.preferencesMaxDepth})`
      ]
    };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

export interface WatchProgressInput {
  source: "jellyfin";
  externalId: string;
  positionTicks: number;
  durationTicks?: number;
  completed: boolean;
}

export function parseWatchProgress(raw: unknown): ParseResult<WatchProgressInput> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];

  const source = parseMediaSource(body.source);
  if (!source.ok) errors.push(...source.errors);

  const externalId = parseExternalId(body.externalId);
  if (!externalId.ok) errors.push(...externalId.errors);

  if (body.positionTicks === undefined) {
    errors.push("position_ticks is required");
  }
  const positionTicks = parseTicks(body.positionTicks, "position_ticks");
  if (!positionTicks.ok) errors.push(...positionTicks.errors);

  let durationTicks: number | undefined;
  if (body.durationTicks !== undefined && body.durationTicks !== null) {
    const parsed = parseTicks(body.durationTicks, "duration_ticks", { allowZero: false });
    if (!parsed.ok) errors.push(...parsed.errors);
    else durationTicks = parsed.value;
  }

  let completed = false;
  if (body.completed !== undefined) {
    if (typeof body.completed !== "boolean") errors.push("completed must be a boolean");
    else completed = body.completed;
  }

  if (
    positionTicks.ok &&
    durationTicks !== undefined &&
    positionTicks.value > durationTicks
  ) {
    errors.push("position_ticks must not exceed duration_ticks");
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      source: source.ok ? source.value : "jellyfin",
      externalId: externalId.ok ? externalId.value : "",
      positionTicks: positionTicks.ok ? positionTicks.value : 0,
      durationTicks,
      completed
    }
  };
}

export interface ProfilePatchInput {
  displayName?: string;
  isActive?: boolean;
}

export function parseProfilePatch(raw: unknown): ParseResult<ProfilePatchInput> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];
  const patch: ProfilePatchInput = {};

  if (body.displayName !== undefined) {
    const parsed = parseDisplayName(body.displayName);
    if (!parsed.ok) errors.push(...parsed.errors);
    else patch.displayName = parsed.value;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") errors.push("is_active must be a boolean");
    else patch.isActive = body.isActive;
  }
  if (patch.displayName === undefined && patch.isActive === undefined) {
    errors.push("at least one of display_name or is_active is required");
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: patch };
}

// Limits arrive as query strings; an out-of-range request is refused rather
// than silently clamped so clients see their contract violation.
export function parseLimit(
  raw: string | null,
  fallback: number,
  max: number
): ParseResult<number> {
  if (raw === null || raw.trim() === "") return { ok: true, value: fallback };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, errors: ["limit must be a positive integer"] };
  }
  const value = Number(trimmed);
  if (value < 1 || value > max) {
    return { ok: false, errors: [`limit must be between 1 and ${max}`] };
  }
  return { ok: true, value };
}

export function parseBooleanQuery(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

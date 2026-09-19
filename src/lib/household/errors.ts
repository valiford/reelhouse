// Typed errors and PostgreSQL error classification for the household
// persistence layer. Store functions either throw one of the semantic errors
// below or let a pg error bubble; the mapping to HTTP responses happens once,
// in src/lib/household/api.ts, from these classes plus classifyPgError().
//
// Constraint names from db/migrations are matched where the error code alone
// cannot distinguish the recovery path (e.g. a foreign key to a missing
// profile is a 404, not a 500).

export class HouseholdInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HouseholdInputError";
  }
}

export class HouseholdNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HouseholdNotFoundError";
  }
}

export class HouseholdConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HouseholdConflictError";
  }
}

export type PgErrorKind = "conflict" | "missing-reference" | "input" | "storage";

export interface PgErrorClassification {
  kind: PgErrorKind;
  /** SQLSTATE code when the error carries one. */
  code?: string;
  /** Constraint name when the violation carries one. */
  constraint?: string;
}

const PG_ERROR_CODES = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  NOT_NULL_VIOLATION: "23502",
  INVALID_TEXT_REPRESENTATION: "22P02",
  NUMERIC_VALUE_OUT_OF_RANGE: "22003"
} as const;

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
  message?: unknown;
}

interface VerifiedPgError {
  code: string;
  constraint: string | undefined;
}

function readPgError(error: unknown): VerifiedPgError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as PgLikeError;
  if (typeof candidate.code !== "string") return undefined;
  return {
    code: candidate.code,
    constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined
  };
}

// Maps the SQLSTATE classes the household schema can actually raise to a
// response category. Anything unlisted is storage — the caller reports 503/500
// with a redacted, truncated message instead of guessing.
export function classifyPgError(error: unknown): PgErrorClassification | undefined {
  const pg = readPgError(error);
  if (!pg) return undefined;
  const { code, constraint } = pg;

  switch (code) {
    case PG_ERROR_CODES.UNIQUE_VIOLATION:
      return { kind: "conflict", code, constraint };
    case PG_ERROR_CODES.FOREIGN_KEY_VIOLATION:
      // The referenced profile/media row vanished mid-request (cascade or
      // race); that is a not-found for the caller, not a server fault.
      return { kind: "missing-reference", code, constraint };
    case PG_ERROR_CODES.CHECK_VIOLATION:
    case PG_ERROR_CODES.NOT_NULL_VIOLATION:
    case PG_ERROR_CODES.INVALID_TEXT_REPRESENTATION:
    case PG_ERROR_CODES.NUMERIC_VALUE_OUT_OF_RANGE:
      return { kind: "input", code, constraint };
    default:
      return { kind: "storage", code, constraint };
  }
}

// pg CHECK/unique violation messages carry constraint names but not values;
// FK detail lines can carry key values, so detail is never included in the
// response text — only the bounded, generic message built from the kind.
export function describePgErrorKind(classification: PgErrorClassification): string {
  switch (classification.kind) {
    case "conflict":
      return "the request conflicts with existing state (duplicate key)";
    case "missing-reference":
      return "the request references state that does not exist";
    case "input":
      return "the request violates a data constraint";
    case "storage":
      return "the database rejected the operation";
  }
}

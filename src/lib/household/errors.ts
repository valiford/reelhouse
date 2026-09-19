// Error vocabulary for the household persistence layer (RH-0018).
//
// Pure logic only: no I/O and no Next.js imports, so unit tests can exercise
// the full code -> HTTP-status mapping under plain Node. Every client-visible
// failure is one of the codes below; anything unexpected is mapped to
// `database_unavailable` by toHouseholdErrorResponse() so raw driver errors
// (which may embed infrastructure detail) never reach a response body.

export type HouseholdErrorCode =
  | "validation_failed"
  | "profile_not_found"
  | "media_ref_not_found"
  | "watchlist_not_found"
  | "collection_not_found"
  | "home_row_not_found"
  | "duplicate_watchlist"
  | "duplicate_collection"
  | "duplicate_home_row"
  | "stale_order_set"
  | "idempotency_key_reuse"
  | "idempotency_state_invalid"
  | "database_unavailable";

const ERROR_STATUS: Record<HouseholdErrorCode, number> = {
  validation_failed: 400,
  profile_not_found: 404,
  media_ref_not_found: 404,
  watchlist_not_found: 404,
  collection_not_found: 404,
  home_row_not_found: 404,
  duplicate_watchlist: 409,
  duplicate_collection: 409,
  duplicate_home_row: 409,
  stale_order_set: 409,
  idempotency_key_reuse: 409,
  idempotency_state_invalid: 500,
  database_unavailable: 503
};

export class HouseholdError extends Error {
  readonly code: HouseholdErrorCode;
  readonly detail?: string;

  constructor(code: HouseholdErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "HouseholdError";
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function isHouseholdError(error: unknown): error is HouseholdError {
  return error instanceof HouseholdError;
}

export interface HouseholdErrorBody {
  error: { code: HouseholdErrorCode; message: string; detail?: string };
}

// Maps ANY thrown value to a bounded response. HouseholdErrors keep their
// code; everything else collapses to 503 database_unavailable with a generic
// message — the concrete error is the caller's to log (redacted), never the
// client's to read.
export function toHouseholdErrorResponse(error: unknown): { status: number; body: HouseholdErrorBody } {
  if (isHouseholdError(error)) {
    const body: HouseholdErrorBody = { error: { code: error.code, message: error.message } };
    if (error.detail !== undefined) body.error.detail = error.detail;
    return { status: error.status, body };
  }
  return {
    status: ERROR_STATUS.database_unavailable,
    body: { error: { code: "database_unavailable", message: "The database operation could not be completed" } }
  };
}

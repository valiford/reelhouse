// Pure input model for the household persistence layer (RH-0018).
//
// No I/O, no pg, no Next.js: every request field is parsed, normalized, and
// bounded HERE so both the API routes and the tests exercise one copy of the
// rules. The database CHECK constraints (RH-0003 migrations) back these rules
// up, but validation runs first so failures are 400s with actionable
// messages instead of constraint violations.
//
// Bounds are deliberate write-contract limits: names/titles 200 chars,
// descriptions 2000, external ids 200, idempotency keys 200 printable ASCII
// chars, positions 1..1,000,000, list reads capped at 500 rows, request
// bodies capped at 64 KiB.

import { createHash } from "node:crypto";
import { HouseholdError } from "./errors.ts";

export const MAX_BODY_CHARS = 65_536;
export const MAX_NAME_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 2_000;
export const MAX_EXTERNAL_ID_CHARS = 200;
export const MAX_SOURCE_KEY_CHARS = 200;
export const MAX_ROW_KEY_CHARS = 100;
export const MAX_IDEMPOTENCY_KEY_CHARS = 200;
export const MAX_POSITION = 1_000_000;
export const LIST_LIMIT_DEFAULT = 200;
export const LIST_LIMIT_MAX = 500;

// Mirrors media_item_ref.source CHECK exactly; widening is a migration plus
// a change here, never a silent extra.
export type MediaSource = "jellyfin";
export const MEDIA_SOURCES: readonly MediaSource[] = ["jellyfin"] as const;

export interface ValidatedMediaRef {
  source: MediaSource;
  externalId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Home-row keys are UI-stable slugs ("continue_watching"), not free text.
const ROW_KEY_PATTERN = /^[a-z0-9_]+$/;
// Printable ASCII without control characters; keys may contain spaces but
// not leading/trailing whitespace (trimmed first).
const IDEMPOTENCY_KEY_PATTERN = /^[!-~][ -~]*[!-~]$/;

function validationError(message: string): HouseholdError {
  return new HouseholdError("validation_failed", message);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw validationError(`${field} must be a UUID`);
  return value.toLowerCase();
}

// Accepts the field absent (undefined) vs present-but-invalid; callers decide
// whether absence is allowed.
export function parseOptionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return parseUuid(value, field);
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") throw validationError(`${field} must be a string`);
  return value;
}

export function parseName(value: unknown, field: string): string {
  const name = parseString(value, field).trim();
  if (name === "") throw validationError(`${field} must not be blank`);
  if (name.length > MAX_NAME_CHARS) {
    throw validationError(`${field} must be at most ${MAX_NAME_CHARS} characters`);
  }
  return name;
}

export function parseOptionalName(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseName(value, field);
}

export function parseDescription(value: unknown, field: string): string {
  const description = parseString(value, field).trim();
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw validationError(`${field} must be at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  return description;
}

export function parseOptionalDescription(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseDescription(value, field);
}

export function parseMediaRef(value: unknown, field: string): ValidatedMediaRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`${field} must be an object with "source" and "id"`);
  }
  const record = value as Record<string, unknown>;
  const source = parseString(record.source, `${field}.source`).trim();
  if (!MEDIA_SOURCES.includes(source as MediaSource)) {
    throw validationError(`${field}.source must be one of: ${MEDIA_SOURCES.join(", ")}`);
  }
  const externalId = parseString(record.id, `${field}.id`).trim();
  if (externalId === "") throw validationError(`${field}.id must not be blank`);
  if (externalId.length > MAX_EXTERNAL_ID_CHARS) {
    throw validationError(`${field}.id must be at most ${MAX_EXTERNAL_ID_CHARS} characters`);
  }
  return { source: source as MediaSource, externalId };
}

export function parseOptionalPosition(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw validationError(`${field} must be an integer`);
  }
  if (value < 1 || value > MAX_POSITION) {
    throw validationError(`${field} must be between 1 and ${MAX_POSITION}`);
  }
  return value;
}

export function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return LIST_LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw.trim())) throw validationError("limit must be a positive integer");
  const limit = Number(raw.trim());
  if (limit < 1) throw validationError("limit must be at least 1");
  return Math.min(limit, LIST_LIMIT_MAX);
}

export function parseIdempotencyKey(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const key = value.trim();
  if (key === "") return undefined;
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw validationError(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters`);
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw validationError("Idempotency-Key must contain only printable ASCII characters");
  }
  return key;
}

export function parseRowKey(value: unknown, field: string): string {
  const rowKey = parseString(value, field).trim();
  if (rowKey === "") throw validationError(`${field} must not be blank`);
  if (rowKey.length > MAX_ROW_KEY_CHARS) {
    throw validationError(`${field} must be at most ${MAX_ROW_KEY_CHARS} characters`);
  }
  if (!ROW_KEY_PATTERN.test(rowKey)) {
    throw validationError(`${field} must be lowercase letters, digits, and underscores`);
  }
  return rowKey;
}

export function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw validationError(`${field} must be a boolean`);
  return value;
}

export function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  return parseBoolean(value, field);
}

// A home row pulls from exactly one source, matching the home_row CHECK:
// jellyfin_section carries source_key and no collection; collection carries
// collection_id and no source_key.
export type ValidatedHomeRowSource =
  | { kind: "jellyfin_section"; sourceKey: string }
  | { kind: "collection"; collectionId: string };

export function parseHomeRowSource(value: unknown, field: string): ValidatedHomeRowSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`${field} must be an object with "kind"`);
  }
  const record = value as Record<string, unknown>;
  const kind = parseString(record.kind, `${field}.kind`);
  if (kind === "jellyfin_section") {
    if (record.collectionId !== undefined) {
      throw validationError(`${field}.collectionId must be omitted for a jellyfin_section source`);
    }
    const sourceKey = parseString(record.sourceKey, `${field}.sourceKey`).trim();
    if (sourceKey === "") throw validationError(`${field}.sourceKey must not be blank`);
    if (sourceKey.length > MAX_SOURCE_KEY_CHARS) {
      throw validationError(`${field}.sourceKey must be at most ${MAX_SOURCE_KEY_CHARS} characters`);
    }
    return { kind: "jellyfin_section", sourceKey };
  }
  if (kind === "collection") {
    if (record.sourceKey !== undefined) {
      throw validationError(`${field}.sourceKey must be omitted for a collection source`);
    }
    return { kind: "collection", collectionId: parseUuid(record.collectionId, `${field}.collectionId`) };
  }
  throw validationError(`${field}.kind must be "jellyfin_section" or "collection"`);
}

// ---- Request body framing -------------------------------------------------

export function parseJsonObject(raw: string): Record<string, unknown> {
  if (raw.length > MAX_BODY_CHARS) {
    throw validationError(`Request body must be at most ${MAX_BODY_CHARS} characters`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw validationError("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function requireFields(record: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (record[field] === undefined) throw validationError(`Missing required field: ${field}`);
  }
}

export function parseMediaRefList(value: unknown, field: string): ValidatedMediaRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(`${field} must be a non-empty array`);
  }
  if (value.length > LIST_LIMIT_MAX) {
    throw validationError(`${field} must contain at most ${LIST_LIMIT_MAX} entries`);
  }
  const refs = value.map((entry) => parseMediaRef(entry, field));
  const seen = new Set<string>();
  for (const ref of refs) {
    const identity = `${ref.source}:${ref.externalId}`;
    if (seen.has(identity)) throw validationError(`${field} must not contain duplicate items`);
    seen.add(identity);
  }
  return refs;
}

export function parseUuidList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(`${field} must be a non-empty array`);
  }
  if (value.length > LIST_LIMIT_MAX) {
    throw validationError(`${field} must contain at most ${LIST_LIMIT_MAX} entries`);
  }
  const ids = value.map((entry) => parseUuid(entry, field));
  if (new Set(ids).size !== ids.length) throw validationError(`${field} must not contain duplicate ids`);
  return ids;
}

// ---- Fingerprints ---------------------------------------------------------

// Keys sorted at every level so payload ordering can never fork an
// idempotency key; arrays keep their order (they are semantically ordered).
export function canonicalJsonString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonString).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonString((value as Record<string, unknown>)[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Fingerprint input is the NORMALIZED request (post-validation), so
// whitespace/formatting differences cannot fork a key but semantic
// differences always collide instead of silently replaying.
export function fingerprintRequest(scope: string, parts: Record<string, unknown>): string {
  return sha256Hex(canonicalJsonString({ scope, ...parts }));
}

export function iso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

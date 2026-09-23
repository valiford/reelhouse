// Pure household-backup artifact format (no I/O, no clock, no database).
//
// The DR backup story has exactly one durable artifact: a JSON envelope
// carrying the complete household manifest (the same contract the household
// import consumes) plus the integrity fields a restore needs to trust it.
// This module is the fail-closed boundary between "bytes someone handed us"
// and the restore: the envelope shape is exact, unknown fields are rejected,
// and the manifest's SHA-256 is recomputed and compared before anything else
// happens.
//
// Determinism rules (verified by unit tests):
// - The manifest checksum is taken over the manifest's compact JSON
//   serialization (JSON.stringify, insertion order = capture order). Any
//   edit to the snapshot — including a re-serialization that reorders keys —
//   changes the checksum and fails the restore. That is the point.
// - Timestamps and identities inside the manifest follow the household
//   manifest contract (manifest.ts); this module never interprets them.
//
// Two checksums exist by design and answer different questions:
//   manifest_sha256 — "is this the snapshot that was captured?" (embedded,
//                     always verified)
//   artifact sha256 — "are these the bytes that were written?" (computed by
//                     the CLI over the whole file; a restore binds the
//                     artifact to it via --sha256 or a dr_backup_runs row)
// The manifest checksum survives an operator re-saving the file with
// different formatting; the file checksum does not, and is not supposed to.

import { createHash } from "node:crypto";
import {
  ManifestError,
  normalizeManifest,
  type NormalizedManifest
} from "../household/manifest.ts";

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export const HOUSEHOLD_ARTIFACT_VERSION = 1;
export const HOUSEHOLD_ARTIFACT_KIND = "reelhouse_household_backup";
export const HOUSEHOLD_ARTIFACT_SCOPE = "household";

export interface HouseholdArtifact {
  artifact_version: number;
  kind: string;
  scope: string;
  created_at: string;
  manifest_sha256: string;
  manifest: unknown;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

// Canonical file name for an artifact: fixed prefix + the capture instant.
// The clock is injected (already an ISO string at the call site) so tests
// and re-runs stay deterministic.
export function formatArtifactFilename(createdAtIso: string): string {
  const stamp = createdAtIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `reelhouse-household-${stamp}.json`;
}

export function buildHouseholdArtifact(
  manifest: unknown,
  createdAtIso: string
): HouseholdArtifact {
  return {
    artifact_version: HOUSEHOLD_ARTIFACT_VERSION,
    kind: HOUSEHOLD_ARTIFACT_KIND,
    scope: HOUSEHOLD_ARTIFACT_SCOPE,
    created_at: createdAtIso,
    manifest_sha256: sha256Hex(serializeManifest(manifest)),
    manifest
  };
}

export function serializeManifest(manifest: unknown): string {
  return JSON.stringify(manifest);
}

export function serializeArtifact(artifact: HouseholdArtifact): string {
  return JSON.stringify(artifact);
}

// Validates the envelope and its embedded checksum, and returns the parsed
// artifact. Manifest *content* validation (the full household manifest
// contract) is the restore's job via normalizeManifest — this pass answers
// only "is this a well-formed, self-consistent artifact?".
export function parseHouseholdArtifact(raw: string): HouseholdArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ArtifactError(
      `artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArtifactError("artifact must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  rejectUnknownFields(record);
  requireExactField(record, "artifact_version", "number");
  requireExactField(record, "kind", "string");
  requireExactField(record, "scope", "string");
  requireExactField(record, "created_at", "string");
  requireExactField(record, "manifest_sha256", "string");

  const artifact = parsed as unknown as HouseholdArtifact;
  if (artifact.artifact_version !== HOUSEHOLD_ARTIFACT_VERSION) {
    throw new ArtifactError(
      `unsupported artifact_version ${String(artifact.artifact_version)} (expected ${HOUSEHOLD_ARTIFACT_VERSION})`
    );
  }
  if (artifact.kind !== HOUSEHOLD_ARTIFACT_KIND) {
    throw new ArtifactError(`unsupported artifact kind "${artifact.kind}"`);
  }
  if (artifact.scope !== HOUSEHOLD_ARTIFACT_SCOPE) {
    throw new ArtifactError(`unsupported artifact scope "${artifact.scope}"`);
  }
  const created = new Date(artifact.created_at);
  if (Number.isNaN(created.getTime())) {
    throw new ArtifactError(`created_at is not a parseable timestamp (got ${JSON.stringify(artifact.created_at)})`);
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.manifest_sha256)) {
    throw new ArtifactError("manifest_sha256 must be a 64-character lowercase hex digest");
  }

  const actual = sha256Hex(serializeManifest(artifact.manifest));
  if (actual !== artifact.manifest_sha256) {
    throw new ArtifactError(
      `manifest checksum mismatch: artifact declares ${artifact.manifest_sha256.slice(0, 12)}, content hashes to ${actual.slice(0, 12)} — the snapshot was modified or corrupted`
    );
  }
  return artifact;
}

// The manifest inside a validated artifact is handed to the import through
// the single source of truth: normalizeManifest validates the contract AND
// produces the loader's normalized form (the artifact stores the input
// shape; the loader consumes the normalized one). ManifestError is wrapped
// with the artifact context so the operator sees which side of the boundary
// rejected the payload.
export function normalizeArtifactManifest(artifact: HouseholdArtifact): NormalizedManifest {
  try {
    return normalizeManifest(artifact.manifest);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new ArtifactError(`artifact manifest rejected: ${error.message}`);
    }
    throw error;
  }
}

function rejectUnknownFields(record: Record<string, unknown>): void {
  const allowed = ["artifact_version", "kind", "scope", "created_at", "manifest_sha256", "manifest"];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ArtifactError(`artifact has unknown field "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function requireExactField(record: Record<string, unknown>, key: string, type: "number" | "string"): void {
  const value = record[key];
  if (value === undefined || value === null || typeof value !== type) {
    throw new ArtifactError(`artifact.${key} must be a ${type}`);
  }
}

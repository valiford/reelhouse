// Hermetic unit evidence for the DR artifact format (RH-0037).
//
// No database, no network, no clock: the artifact layer is pure, so the
// whole fail-closed surface — envelope shape, checksum verification, and
// the delegation to the household manifest contract — is pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactError,
  HOUSEHOLD_ARTIFACT_KIND,
  HOUSEHOLD_ARTIFACT_SCOPE,
  HOUSEHOLD_ARTIFACT_VERSION,
  buildHouseholdArtifact,
  formatArtifactFilename,
  normalizeArtifactManifest,
  parseHouseholdArtifact,
  serializeArtifact,
  sha256Hex
} from "./artifact.ts";

const CREATED = "2026-06-01T12:00:00.000Z";

// A minimal VALID household manifest in its INPUT shape (the shape
// normalizeManifest consumes — note preferences is an object keyed by
// preference key).
const VALID_MANIFEST = {
  profiles: [
    {
      slug: "kai",
      name: "Kai",
      initials: "K",
      isDefault: true,
      jellyfinUserId: "jf-user-1",
      preferences: { theme: "dark" },
      favorites: [{ jellyfinId: "mov-arrival", addedAt: "2026-05-01T00:00:00.000Z" }],
      watchlists: [
        {
          slug: "movie_night",
          name: "Movie Night",
          entries: [{ jellyfinId: "mov-citizen", addedAt: null }]
        }
      ],
      homeRows: [
        { slug: "continue_watching", kind: "continue_watching", title: "Continue", enabled: true, config: {} }
      ],
      watchState: [
        {
          jellyfinId: "mov-arrival",
          positionTicks: 1000,
          durationTicks: 2000,
          completed: false,
          hiddenFromContinue: false,
          firstPlayedAt: "2026-05-02T00:00:00.000Z",
          lastPlayedAt: "2026-05-03T00:00:00.000Z"
        }
      ],
      playbackHistory: [
        {
          jellyfinId: "mov-arrival",
          playedAt: "2026-05-02T00:00:00.000Z",
          positionTicks: null,
          durationTicks: null,
          completed: false
        }
      ]
    }
  ],
  collections: [
    {
      slug: "family_picks",
      name: "Family Picks",
      description: null,
      entries: [{ jellyfinId: "mov-arrival", addedAt: null }]
    }
  ]
};

function validArtifactJson(manifest: unknown = VALID_MANIFEST): string {
  return serializeArtifact(buildHouseholdArtifact(manifest, CREATED));
}

test("sha256Hex produces the standard digest", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("formatArtifactFilename is deterministic and filesystem-safe", () => {
  assert.equal(formatArtifactFilename(CREATED), "reelhouse-household-20260601T120000Z.json");
  assert.equal(formatArtifactFilename("2026-06-01T12:00:00.000Z"), formatArtifactFilename("2026-06-01T12:00:00.000Z"));
});

test("build → serialize → parse round-trips with a verified manifest checksum", () => {
  const json = validArtifactJson();
  const artifact = parseHouseholdArtifact(json);
  assert.equal(artifact.artifact_version, HOUSEHOLD_ARTIFACT_VERSION);
  assert.equal(artifact.kind, HOUSEHOLD_ARTIFACT_KIND);
  assert.equal(artifact.scope, HOUSEHOLD_ARTIFACT_SCOPE);
  assert.equal(artifact.created_at, CREATED);
  assert.equal(artifact.manifest_sha256, sha256Hex(JSON.stringify(VALID_MANIFEST)));
  assert.deepEqual(artifact.manifest, VALID_MANIFEST);
});

test("any manifest edit breaks the embedded checksum", () => {
  const tampered = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  const manifest = tampered.manifest as { profiles: Array<{ name: string }> };
  manifest.profiles[0].name = "Tampered";
  // The embedded checksum still describes the ORIGINAL content: the edit is
  // caught with no external knowledge at all.
  assert.throws(
    () => parseHouseholdArtifact(JSON.stringify(tampered)),
    /manifest checksum mismatch/
  );
});

test("a re-stamped edit is self-consistent — the external binding exists for it", () => {
  // A tamperer who recomputes the embedded checksum produces an envelope
  // that IS internally honest: it really is a snapshot of different
  // content. The artifact layer cannot and must not pretend to catch that —
  // which is exactly why a real restore refuses unbound artifacts and
  // verifies the file checksum against --sha256 or the backup ledger row
  // (pinned by the restore integration suite).
  const restamped = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  const manifest = restamped.manifest as { profiles: Array<{ name: string }> };
  manifest.profiles[0].name = "Tampered";
  restamped.manifest_sha256 = sha256Hex(JSON.stringify(restamped.manifest));
  const artifact = parseHouseholdArtifact(JSON.stringify(restamped));
  assert.equal(artifact.manifest_sha256, sha256Hex(JSON.stringify(artifact.manifest)));
});

test("key-order changes count as tampering unless the checksum is re-stamped", () => {
  // A re-serialization that reorders members produces different bytes, so a
  // naive re-save (checksum left alone) fails the embedded check even
  // though the data is "the same".
  const resaved = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  const manifest = resaved.manifest as Record<string, unknown>;
  resaved.manifest = { collections: manifest.collections, profiles: manifest.profiles };
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(resaved)), /manifest checksum mismatch/);

  // Re-stamped, it is an honest (different-looking) snapshot again — same
  // external-binding story as any other edit.
  resaved.manifest_sha256 = sha256Hex(JSON.stringify(resaved.manifest));
  const artifact = parseHouseholdArtifact(JSON.stringify(resaved));
  assert.deepEqual(artifact.manifest, resaved.manifest);
});

test("envelope shape is exact: unknown fields are rejected", () => {
  const parsed = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  parsed.note = "hello";
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(parsed)), /unknown field "note"/);
});

test("wrong version, kind, or scope fails closed", () => {
  const wrongVersion = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  wrongVersion.artifact_version = 2;
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(wrongVersion)), /unsupported artifact_version 2/);

  const wrongKind = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  wrongKind.kind = "something_else";
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(wrongKind)), /unsupported artifact kind/);

  const wrongScope = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  wrongScope.scope = "catalog";
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(wrongScope)), /unsupported artifact scope/);
});

test("malformed envelope fields fail closed", () => {
  const badDate = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  badDate.created_at = "not-a-date";
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(badDate)), /created_at is not a parseable timestamp/);

  const badSha = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  badSha.manifest_sha256 = "deadbeef";
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(badSha)), /64-character lowercase hex/);

  const missingType = JSON.parse(validArtifactJson()) as Record<string, unknown>;
  missingType.artifact_version = "1";
  assert.throws(() => parseHouseholdArtifact(JSON.stringify(missingType)), /artifact_version must be a number/);
});

test("non-JSON and non-object artifacts are rejected", () => {
  assert.throws(() => parseHouseholdArtifact("not json"), /artifact is not valid JSON/);
  assert.throws(() => parseHouseholdArtifact("[1,2,3]"), /artifact must be a JSON object/);
});

test("normalizeArtifactManifest delegates to the household manifest contract", () => {
  // The valid manifest passes untouched and produces the loader's
  // normalized form (preferences become keyed pairs).
  const artifact = parseHouseholdArtifact(validArtifactJson());
  const normalized = normalizeArtifactManifest(artifact);
  assert.deepEqual(normalized.profiles[0].preferences, [{ key: "theme", value: "dark" }]);

  // A checksum-consistent envelope around an invalid manifest is rejected
  // with the artifact context (not a bare ManifestError).
  const badManifest = { profiles: [{ total_nonsense: true }], collections: [] };
  const badArtifact = parseHouseholdArtifact(validArtifactJson(badManifest));
  assert.throws(() => normalizeArtifactManifest(badArtifact), ArtifactError);
  assert.throws(() => normalizeArtifactManifest(badArtifact), /artifact manifest rejected/);
});

// CLI entry point for the media_catalog quarantine review workflow (RH-0023).
//
//   node scripts/catalog-review.ts list [--status=open|resolved|all] [--reason=<reason>] [--limit=N]
//   node scripts/catalog-review.ts show <quarantine-id>
//   node scripts/catalog-review.ts detect
//   node scripts/catalog-review.ts weak-identity [--limit=N]
//   node scripts/catalog-review.ts resolve <quarantine-id> --action=<dismissed|source_fixed|discarded> [--note=...] [--by=...]
//   node scripts/catalog-review.ts remap-provider <provider> <value> --to=<canonical-item-id> [--note=...] [--by=...]
//   node scripts/catalog-review.ts pin-library <item-id> --to=<canonical-library-id> [--note=...] [--by=...]
//   node scripts/catalog-review.ts overrides [--limit=N]
//   node scripts/catalog-review.ts remove-override <override-id>
//
// Configuration is environment-only, like every catalog tool:
//   MEDIA_CATALOG_DATABASE_URL            catalog database target
//   MEDIA_CATALOG_RETIREMENT_DAYS         only for pool/timeout policy reuse
// No Jellyfin credentials: this workflow reads only the catalog database.
// The database URL is never printed; errors pass through the shared
// redaction helper. Exit code 0 only when the requested operation succeeded.
// This tool never writes to Jellyfin and never touches the reelhouse
// database.

import {
  LIST_LIMIT_DEFAULT,
  closeCatalogReviewSession,
  getQuarantine,
  listOverrides,
  listQuarantine,
  listWeakIdentity,
  openCatalogReviewSession,
  pinLibrary,
  redactReviewError,
  removeOverride,
  remapProviderClaim,
  resolveQuarantine,
  runDetectors,
  verifyReviewSchema,
  normalizeLibraryPin,
  normalizeOverrideId,
  normalizeProviderClaim,
  normalizeQuarantineId,
  normalizeResolution,
  isValidQuarantineReason,
  type QuarantineReason,
  type QuarantineStatusFilter
} from "../src/lib/catalog/review.ts";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.length === 0) return null;
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq <= 2) return null; // "--" or "--key" without a value
      const key = arg.slice(2, eq);
      const value = arg.slice(eq + 1);
      if (key in flags) return null; // duplicated flag
      flags[key] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function invalid(command: string, errors: string[]): never {
  fail(`catalog-review ${command}: invalid arguments — ${errors.join("; ")}`);
}

function operatorOf(flags: Record<string, string>): string {
  return flags.by?.trim() || "operator";
}

function limitOf(command: string, flags: Record<string, string>): number {
  if (flags.limit === undefined) return LIST_LIMIT_DEFAULT;
  if (!/^\d+$/.test(flags.limit)) invalid(command, ["--limit must be a positive integer"]);
  return Number(flags.limit);
}

const USAGE = `Usage: node scripts/catalog-review.ts <command> [args]

Commands:
  list [--status=open|resolved|all] [--reason=<reason>] [--limit=N]
  show <quarantine-id>
  detect
  weak-identity [--limit=N]
  resolve <quarantine-id> --action=<dismissed|source_fixed|discarded> [--note=...] [--by=...]
  remap-provider <provider> <value> --to=<canonical-item-id> [--note=...] [--by=...]
  pin-library <item-id> --to=<canonical-library-id> [--note=...] [--by=...]
  overrides [--limit=N]
  remove-override <override-id>`;

const parsed = parseArgs(process.argv.slice(2));
if (parsed === null) fail(USAGE);
const { command, positionals, flags } = parsed;

const env = process.env;

// Every flag this CLI understands, per command, enforced exactly — an
// unrecognized flag must fail loudly rather than be silently ignored.
const ALLOWED_FLAGS: Record<string, string[]> = {
  list: ["status", "reason", "limit"],
  show: [],
  detect: [],
  "weak-identity": ["limit"],
  resolve: ["action", "note", "by"],
  "remap-provider": ["to", "note", "by"],
  "pin-library": ["to", "note", "by"],
  overrides: ["limit"],
  "remove-override": []
};

const allowed = ALLOWED_FLAGS[command];
if (allowed === undefined) fail(USAGE);
for (const key of Object.keys(flags)) {
  if (!allowed.includes(key)) fail(`catalog-review ${command}: unknown option --${key}\n\n${USAGE}`);
}

try {
  const session = await openCatalogReviewSession(env);
  try {
    await verifyReviewSchema(session.pool);

    if (command === "list") {
      const status = (flags.status?.trim() || "open") as QuarantineStatusFilter;
      if (!["open", "resolved", "all"].includes(status)) {
        invalid(command, [`--status must be open, resolved, or all (got "${status}")`]);
      }
      let reason: QuarantineReason | null = null;
      if (flags.reason !== undefined) {
        const raw = flags.reason.trim();
        if (!isValidQuarantineReason(raw)) invalid(command, [`--reason must be one of: see docs/CATALOG_REVIEW.md (got "${raw}")`]);
        reason = raw;
      }
      const entries = await listQuarantine(session.pool, { status, reason, limit: limitOf(command, flags) });
      console.log(`catalog_quarantine (${status}${reason !== null ? `, reason=${reason}` : ""}): ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
      for (const entry of entries) {
        const detail = JSON.stringify(entry.detail);
        console.log(
          `[${entry.state}] ${entry.reason} ${entry.externalId} id=${entry.id} last=${entry.lastDetectedAt} detail=${detail}`
        );
      }
    } else if (command === "show") {
      const id = normalizeQuarantineId(positionals[0]);
      if (id.kind === "invalid") invalid(command, id.errors);
      const entry = await getQuarantine(session.pool, id.value);
      console.log(JSON.stringify(entry, null, 2));
    } else if (command === "detect") {
      const result = await runDetectors(session.pool, new Date(), (line) => console.log(line));
      console.log(
        `Detectors: ${result.duplicatePathFindings} duplicate-path and ${result.renamedIdentityFindings} renamed-identity findings recorded, ` +
          `${result.recorded} new/changed, ${result.closed} stale closed${result.truncated ? " (TRUNCATED: bounds hit, open rows left untouched)" : ""}`
      );
    } else if (command === "weak-identity") {
      const items = await listWeakIdentity(session.pool, limitOf(command, flags));
      console.log(`Items with no provider id (movies/series, live): ${items.length}`);
      for (const item of items) {
        console.log(`${item.kind} ${item.externalId} "${item.name}" path=${item.path ?? "(none)"} last=${item.lastSeenAt}`);
      }
    } else if (command === "resolve") {
      const id = normalizeQuarantineId(positionals[0]);
      if (id.kind === "invalid") invalid(command, id.errors);
      const resolution = normalizeResolution({ action: flags.action, note: flags.note, by: operatorOf(flags) });
      if (resolution.kind === "invalid") invalid(command, resolution.errors);
      const entry = await resolveQuarantine(session.pool, id.value, resolution.value, new Date());
      console.log(`Resolved ${entry.externalId} (${entry.reason}) as ${entry.resolutionAction} by ${entry.resolvedBy}`);
    } else if (command === "remap-provider") {
      const claim = normalizeProviderClaim({
        provider: positionals[0],
        value: positionals[1],
        to: flags.to,
        note: flags.note,
        by: operatorOf(flags)
      });
      if (claim.kind === "invalid") invalid(command, claim.errors);
      const result = await remapProviderClaim(session.pool, claim.value, new Date());
      console.log(
        `Override ${result.override.id}: ${result.override.provider}:${result.override.externalValue} belongs to ${result.override.canonicalExternalId}; ` +
          `${result.resolvedEntries} matching quarantine entr${result.resolvedEntries === 1 ? "y" : "ies"} closed as remapped`
      );
    } else if (command === "pin-library") {
      const pin = normalizeLibraryPin({ externalId: positionals[0], to: flags.to, note: flags.note, by: operatorOf(flags) });
      if (pin.kind === "invalid") invalid(command, pin.errors);
      const result = await pinLibrary(session.pool, pin.value, new Date());
      console.log(
        `Override ${result.override.id}: ${result.override.externalId} belongs to library ${result.override.canonicalExternalId}; ` +
          `${result.resolvedEntries} matching quarantine entr${result.resolvedEntries === 1 ? "y" : "ies"} closed as remapped`
      );
    } else if (command === "overrides") {
      const records = await listOverrides(session.pool, limitOf(command, flags));
      console.log(`Identity overrides: ${records.length}`);
      for (const record of records) {
        const subject = record.kind === "provider_claim" ? `${record.provider}:${record.externalValue}` : (record.externalId as string);
        console.log(`[${record.kind}] ${subject} -> ${record.canonicalExternalId} by ${record.createdBy} at ${record.createdAt} id=${record.id}`);
      }
    } else if (command === "remove-override") {
      const id = normalizeOverrideId(positionals[0]);
      if (id.kind === "invalid") invalid(command, id.errors);
      const record = await removeOverride(session.pool, id.value);
      console.log(`Removed override ${record.id} (${record.kind})`);
    }

    console.log(`Target: ${session.describe}`);
  } finally {
    await closeCatalogReviewSession(session);
  }
} catch (error) {
  fail(redactReviewError(error instanceof Error ? error.message : String(error), env));
}

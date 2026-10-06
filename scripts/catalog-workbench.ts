// Media identity repair workbench CLI (RH-0036): operator tooling over the
// catalog conflict quarantine.
//
//   npm run catalog:workbench -- scan
//   npm run catalog:workbench -- list [--status=quarantined|released|discarded|all]
//                                      [--reason=duplicate_identity|duplicate_file|moved_media|missing_external_id|all]
//                                      [--limit=1-200]
//   npm run catalog:workbench -- show <quarantine-id>
//   npm run catalog:workbench -- release <quarantine-id> [--note "..."]
//   npm run catalog:workbench -- discard <quarantine-id> [--note "..."]
//   npm run catalog:workbench -- remap <quarantine-id> --library <jellyfin-library-id> [--note "..."]
//
// Environment:
//   DATABASE_URL        Application role URL (least privilege, DML only).
//   REELHOUSE_OPERATOR  Operator identity recorded in the audit trail —
//                       required for release/discard/remap, ignored by
//                       read-only commands. Repairs without an actor fail
//                       closed.
//
// The scan is pure PostgreSQL detection: no Jellyfin connection is made and
// Jellyfin's internal database is never touched. Migrations must already be
// applied (`npm run db:migrate`). All echoed errors are scrubbed of the
// database URL.

import { Pool } from "pg";
import { loadDatabaseConfig, redactError } from "../src/lib/db/config.ts";
import { createPgSyncExecutor } from "../src/lib/catalog/pg-executor.ts";
import {
  WorkbenchError,
  WorkbenchParamError,
  describeQuarantine,
  discardQuarantine,
  listQuarantines,
  parseQuarantineId,
  releaseQuarantine,
  remapQuarantineItem,
  runIdentityScan
} from "../src/lib/catalog/workbench.ts";

function fail(message: string): never {
  console.error(`catalog:workbench ${message}`);
  process.exit(1);
}

const dbResult = loadDatabaseConfig(process.env);
if (dbResult.kind === "unconfigured") {
  fail("is not configured: DATABASE_URL (application role) is unset — see docs/WORKBENCH.md");
}
if (dbResult.kind === "invalid") {
  fail(`database configuration was rejected: ${dbResult.errors.join("; ")}`);
}
const db = dbResult.config;

interface Flags {
  note?: string;
  library?: string;
  status?: string;
  reason?: string;
  limit?: number;
}

const args = process.argv.slice(2);
const command = args[0];

const FLAG_SLOTS: Record<string, keyof Flags> = {
  "--note": "note",
  "--library": "library",
  "--status": "status",
  "--reason": "reason",
  "--limit": "limit"
};

// Bounded, strict flag parsing: unknown or duplicate flags fail closed so a
// typo can never silently change what an operator action does. Both
// `--flag=value` and `--flag value` forms are accepted.
function parseArgs(values: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const set = (name: string, rawValue: string | undefined): void => {
    if (rawValue === undefined) fail(`flag ${name} needs a value`);
    const slot = FLAG_SLOTS[name];
    if (flags[slot] !== undefined) fail(`flag ${name} given twice`);
    if (slot === "limit") {
      const parsed = Number(rawValue);
      if (!Number.isSafeInteger(parsed)) fail(`--limit must be an integer (got "${rawValue}")`);
      flags.limit = parsed;
    } else {
      (flags as Record<string, unknown>)[slot] = rawValue;
    }
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const eq = value.indexOf("=");
    if (eq !== -1) {
      set(value.slice(0, eq), value.slice(eq + 1));
      continue;
    }
    switch (value) {
      case "--note":
      case "--library":
      case "--status":
      case "--reason":
      case "--limit": {
        const next = values[index + 1];
        set(value, next !== undefined && !next.startsWith("--") ? next : undefined);
        if (next !== undefined && !next.startsWith("--")) index += 1;
        break;
      }
      default:
        fail(`accepts only --note, --library, --status, --reason, --limit (got ${value})`);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(args.slice(1));

if (command !== "scan" && command !== "list" && command !== "show" && command !== "release" && command !== "discard" && command !== "remap") {
  fail("requires one of: scan | list | show | release | discard | remap");
}
if (command === "scan" && (positional.length > 0 || Object.keys(flags).length > 0)) {
  fail("scan accepts no flags or arguments");
}
if (command === "list" && positional.length > 0) {
  fail("list accepts no positional arguments");
}
if ((command === "show" || command === "release" || command === "discard" || command === "remap") && positional.length !== 1) {
  fail(`${command} requires exactly one quarantine id`);
}
if (command === "remap" && flags.library === undefined) {
  fail("remap requires --library <jellyfin-library-id>");
}
if ((command === "release" || command === "discard") && flags.library !== undefined) {
  fail(`${command} does not accept --library (placement changes are remap-only)`);
}

const dbUrl = process.env.DATABASE_URL?.trim() ?? "";
const pool = new Pool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  database: db.database,
  ssl: db.ssl,
  // Workbench commands are sequential; a spare connection is enough.
  max: 2,
  connectionTimeoutMillis: db.connectionTimeoutMs,
  statement_timeout: db.statementTimeoutMs,
  application_name: "reelhouse-catalog-workbench"
});

const iso = (value: Date | null): string => (value === null ? "—" : new Date(value).toISOString());

try {
  const executor = createPgSyncExecutor(pool);

  if (command === "scan") {
    const result = await runIdentityScan(executor);
    console.log(
      `catalog:workbench scan #${result.scanId} finished in ${result.durationMs}ms — ` +
        `findings: duplicate_file=${result.duplicateFile} moved_media=${result.movedMedia} ` +
        `missing_external_id=${result.missingExternalId}; ` +
        `quarantines opened=${result.quarantinesOpened} bumped=${result.quarantinesBumped}` +
        `${result.truncated ? " (TRUNCATED: a detector hit its per-scan cap — re-run after resolving)" : ""}`
    );
  } else if (command === "list") {
    const rows = await listQuarantines(executor, {
      status: flags.status,
      reason: flags.reason,
      limit: flags.limit
    });
    if (rows.length === 0) {
      console.log("catalog:workbench list — no quarantine rows match");
    } else {
      for (const row of rows) {
        console.log(
          `#${row.id} [${row.status}] ${row.reason} identity="${row.identity}" ` +
            `occurrences=${row.occurrences} first=${iso(row.first_seen_at)} last=${iso(row.last_seen_at)}` +
            `${row.resolved_at !== null ? ` resolved=${iso(row.resolved_at)}` : ""}`
        );
        console.log(`    ${row.detail}`);
      }
      console.log(`catalog:workbench list — ${rows.length} row(s)`);
    }
  } else if (command === "show") {
    const id = parseQuarantineId(positional[0]);
    const inspection = await describeQuarantine(executor, id);
    const q = inspection.quarantine;
    console.log(
      `#${q.id} [${q.status}] ${q.reason} identity="${q.identity}" occurrences=${q.occurrences}`
    );
    console.log(`    first=${iso(q.first_seen_at)} last=${iso(q.last_seen_at)} resolved=${iso(q.resolved_at)}`);
    console.log(`    origin: ${q.run_id !== null ? `sync run #${q.run_id}` : `identity scan #${q.scan_id}`}`);
    console.log(`    ${q.detail}`);
    console.log(`    evidence: ${JSON.stringify(q.payload)}`);
    for (const item of inspection.items) {
      console.log(
        `    item ${item.jellyfin_id} "${item.name}" (${item.item_type}, library ${item.library_jellyfin_id})` +
          `${item.removed_at !== null ? ` TOMBSTONED ${iso(item.removed_at)}` : ""} path=${item.file_path ?? "—"}`
      );
    }
    for (const change of inspection.history) {
      console.log(
        `    history ${change.change_kind} ${change.jellyfin_id} rev=${change.source_revision ?? "—"} ` +
          `at=${iso(change.observed_at)} fields=${JSON.stringify(change.changed_fields)}`
      );
    }
    if (inspection.repairs.length === 0) {
      console.log("    repairs: none recorded");
    } else {
      for (const repair of inspection.repairs) {
        console.log(
          `    repair ${repair.action} by ${repair.operator} at=${iso(repair.recorded_at)}` +
            `${repair.note !== null ? ` note="${repair.note}"` : ""}`
        );
        console.log(`      evidence: ${JSON.stringify(repair.evidence)}`);
      }
    }
  } else {
    const id = parseQuarantineId(positional[0]);
    if (command === "release") {
      const result = await releaseQuarantine(executor, {
        quarantineId: id,
        operator: process.env.REELHOUSE_OPERATOR,
        note: flags.note
      });
      console.log(
        `catalog:workbench release — quarantine #${result.quarantineId} (${result.reason} "${result.identity}") ` +
          `resolved as ${result.status}; audit row #${result.auditId}`
      );
    } else if (command === "discard") {
      const result = await discardQuarantine(executor, {
        quarantineId: id,
        operator: process.env.REELHOUSE_OPERATOR,
        note: flags.note
      });
      console.log(
        `catalog:workbench discard — quarantine #${result.quarantineId} (${result.reason} "${result.identity}") ` +
          `resolved as ${result.status}; audit row #${result.auditId}`
      );
    } else {
      const result = await remapQuarantineItem(executor, {
        quarantineId: id,
        targetLibraryJellyfinId: flags.library!,
        operator: process.env.REELHOUSE_OPERATOR,
        note: flags.note
      });
      console.log(
        `catalog:workbench remap — item "${result.itemJellyfinId}" moved from library ` +
          `"${result.fromLibraryJellyfinId}" to "${result.toLibraryJellyfinId}"; ` +
          `quarantine #${result.quarantineId} resolved as ${result.status}; audit row #${result.auditId}. ` +
          `The next catalog sync reconciles against Jellyfin and re-quarantines if the source disagrees.`
      );
    }
  }
} catch (error) {
  if (error instanceof WorkbenchParamError) {
    fail(`rejected: ${error.message}`);
  }
  if (error instanceof WorkbenchError) {
    console.error(`catalog:workbench failed: ${redactError(error.message, dbUrl)}`);
    process.exitCode = 1;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`catalog:workbench failed: ${redactError(message, dbUrl)}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}

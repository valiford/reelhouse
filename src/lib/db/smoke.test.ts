// Unit tests for the pure smoke-check helpers (report model, formatting,
// aggregation, watchdog). No PostgreSQL, no I/O — these run in `npm test`.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatSmokeReport, summarizeStages, withTimeout, type SmokeReport } from "./smoke.ts";

function report(stages: SmokeReport["stages"], target = "postgresql://smoke:***@127.0.0.1:55433/db"): SmokeReport {
  return { target, stages, ok: summarizeStages(stages).ok };
}

describe("summarizeStages", () => {
  it("is ok only when every stage passed", () => {
    assert.equal(
      summarizeStages([
        { stage: "config", state: "pass" },
        { stage: "connect", state: "pass", durationMs: 3 }
      ]).ok,
      true
    );
  });

  it("fails when any stage failed", () => {
    assert.equal(
      summarizeStages([
        { stage: "config", state: "pass" },
        { stage: "connect", state: "fail", detail: "connect ECONNREFUSED" }
      ]).ok,
      false
    );
  });

  it("treats skipped stages as not ok — a partial smoke is a failed smoke", () => {
    assert.equal(
      summarizeStages([
        { stage: "config", state: "pass" },
        { stage: "connect", state: "skip", detail: "configuration failed" }
      ]).ok,
      false
    );
  });

  it("fails with no stages at all", () => {
    assert.equal(summarizeStages([]).ok, false);
  });
});

describe("formatSmokeReport", () => {
  it("renders target, stage lines, durations, details, and the final verdict", () => {
    const text = formatSmokeReport(
      report([
        { stage: "config", state: "pass", detail: "postgresql://smoke:***@127.0.0.1:55433/db ssl=disable poolMax=10" },
        { stage: "connect", state: "pass", detail: "latencyMs:2, server:PostgreSQL 18.6", durationMs: 9 },
        { stage: "migrations", state: "pass", detail: "9 applied, 0 already applied, repeat run clean", durationMs: 140 }
      ])
    );
    assert.match(text, /^Target: postgresql:\/\/smoke:\*\*\*@127\.0\.0\.1:55433\/db$/m);
    assert.match(text, /^\[PASS\] config — postgresql:\/\/smoke:\*\*\*@127\.0\.0\.1:55433\/db ssl=disable poolMax=10$/m);
    assert.match(text, /^\[PASS\] connect \(9 ms\) — latencyMs:2, server:PostgreSQL 18\.6$/m);
    assert.match(text, /^\[PASS\] migrations \(140 ms\) — 9 applied/m);
    assert.match(text, /SMOKE OK$/m);
    assert.doesNotMatch(text, /SMOKE FAILED/);
  });

  it("renders failures and skips distinctly and fails the verdict", () => {
    const text = formatSmokeReport(
      report([
        { stage: "config", state: "pass" },
        { stage: "connect", state: "fail", detail: "connect ECONNREFUSED 127.0.0.1:59999", durationMs: 4 },
        { stage: "migrations", state: "skip", detail: "connect failed" },
        { stage: "pool", state: "skip", detail: "connect failed" },
        { stage: "transactions", state: "skip", detail: "connect failed" }
      ])
    );
    assert.match(text, /^\[FAIL\] connect \(4 ms\) — connect ECONNREFUSED 127\.0\.0\.1:59999$/m);
    assert.match(text, /^\[SKIP\] migrations — connect failed$/m);
    assert.match(text, /^\[SKIP\] transactions — connect failed$/m);
    assert.match(text, /SMOKE FAILED$/m);
    assert.doesNotMatch(text, /SMOKE OK/);
  });

  it("omits the target line when no target was resolved", () => {
    const text = formatSmokeReport({
      stages: [{ stage: "config", state: "fail", detail: "No database configured" }],
      ok: false
    });
    assert.doesNotMatch(text, /^Target:/m);
    assert.match(text, /SMOKE FAILED$/m);
  });
});

describe("withTimeout watchdog", () => {
  it("rejects with the stage label once the budget elapses", async () => {
    await assert.rejects(
      withTimeout(new Promise<never>(() => {}), 20, "probe stage"),
      /probe stage exceeded the 20 ms smoke watchdog/
    );
  });

  it("passes the wrapped value through when work finishes in time", async () => {
    assert.equal(await withTimeout(Promise.resolve("done"), 1_000, "fast stage"), "done");
  });
});

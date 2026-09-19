# RH-0012 Worker Report — Jellyfin degraded-mode and reconnection UX

- **Date:** 2026-09-19 (claimed 18:40 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0012-jellyfin-degraded-mode-and-reconnection-ux`
- **Base:** `origin/main` @ `9028194`

## Claim

Dispatch bootstrap ran `git fetch origin --prune` and read the queue from
`origin/main` per protocol. Priority 1–4 rows (RH-0008/0009/0015/0016,
RH-0002/0003, RH-0004-duplicate) are stale-listed READY on `origin/main`
but are leased: each has an existing branch + local worktree + remote
branch (lease authority); RH-0004 was skipped as a duplicate of leased
RH-0016, per the rh-0019 worker precedent. At priority 5, RH-0012 was
the highest-priority unclaimed, automation-eligible READY job (RH-0019,
its priority-5 peer, is leased). Worktree `reelhouse-rh-0012` created
off `origin/main`; no other worktree entered.

## Commits on the branch

Implementation (base `origin/main` @ `9028194`):

1. `0e945d8` — Integrate frontend chain (rh-0009 + rh-0010/0011 +
   rh-0019). Per the rh-0015/rh-0016/rh-0019 worker precedent — a
   REVIEW branch carries the chain it builds on. Merged
   `origin/rh-0019` clean (it already carries rh-0009 and
   rh-0010/0011), providing the focus-navigation shell, bounded search
   contract, responsive presentation, PosterImage fallback, and TV
   overhaul as the base for this job's UX surface.
2. `ea1ff81` — Engine connection lifecycle: client state machine
   replaces the binary error flag with `connecting → ok`, or
   `unavailable` (demo titles stand in) / `stale` (last-good engine
   data stays on screen) when the engine is slow, unreachable, or
   malformed. Failures start an automatic bounded-backoff reconnect
   cycle (2 s → 4 s → 8 s → 16 s → 30 s cap) with the attempt count on
   the source chip; recovery ends the cycle, refreshes data, and
   flashes a transient "Reconnected" chip. Every engine request
   carries a 12 s client deadline (slow → explicit state, not an
   endless spinner); a quiet 60 s health refresh while healthy detects
   later outages without user interaction. Malformed API bodies are
   rejected explicitly ("Library returned malformed data." /
   "Search returned malformed data.") instead of rendered. Degraded
   fallback payloads now carry a bounded, redacted `degradedReason`
   (server side, via `boundedMessage`), and upstream malformed-JSON /
   malformed-`Items` responses become explicit upstream errors.
   Amber/rose/green chip + banner styling for stale/unavailable/
   recovered.
3. `e203c23` — Engine lifecycle failure-path tests (7 new): unavailable
   chip with bounded reason, auto-reconnect ladder walk, transient
   recovery acknowledgment, stale retention on failed health refresh,
   degraded payload reason surfacing, library + search 12 s timeouts,
   malformed payload rejections. The deferred fetch stub now rejects
   on signal abort like real fetch so timeout paths run end to end;
   the tvnav library-failure stub uses a real `Response` and asserts
   the new unavailable-chip contract (intentional contract change from
   the old plain demo chip).

Final commit (docs + review artifacts):

4. Documentation: README "Media engine connection states" section +
   Phase-1 bullet; `docs/SEARCH_LIBRARY_CONTRACT.md` extended with
   `degradedReason` and the client lifecycle. Job spec → REVIEW,
   queue updated, this report.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Explicit unavailable, stale, reconnecting, recovery states | ✅ unavailable (demo stand-in + reason banner), stale (engine data retained, amber banner/chip), reconnecting (attempt counter on chip), recovery (transient "Reconnected" chip → settled "Connected") — each pinned by unit tests and confirmed in a real browser |
| Slow Jellyfin surfaces explicitly | ✅ 12 s client deadline on library and search requests → explicit timeout state + reconnect cycle (unit-tested with fake timers) |
| Unreachable Jellyfin surfaces explicitly | ✅ fetch failure / 5xx / degraded fallback → unavailable or stale + bounded reason + auto-reconnect |
| Malformed data surfaces explicitly | ✅ client shape-guards both payloads; server maps upstream malformed JSON/Items to explicit errors and degraded fallback with bounded reason |
| Build and targeted interaction/failure-path checks remain green | ✅ `eslint .` clean, `tsc --noEmit` clean, `next build` succeeds (`○ /`, `ƒ /api/library`, `ƒ /api/search`), vitest **93 passed (9 files)** — 86 carried + 7 new |
| No internal Jellyfin database coupling | ✅ Jellyfin accessed via its HTTP API only; no DB coupling introduced; no secrets in source |
| Data boundaries preserved | ✅ demo fallback intact; diagnostics bounded/redacted (`boundedMessage`); household queries never enter logs (pinned by existing assertions) |
| No merge/deploy/release | ✅ local build + localhost browser smoke only; never touched main |

## Verification evidence (2026-09-19, Node 22.19.0 / npm 10.9.3)

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm run test` — **93 passed (9 files)**: full carried matrix
  (spatial engine, tvnav DOM layer, TV component matrix, bounded
  search contract, route contracts, diag/uniqueById) + 7 new
  lifecycle tests.
- `npm run build` — succeeds; routes unchanged (`○ /`,
  `ƒ /api/library`, `ƒ /api/search`).
- **Live browser verification** (production `next start`, engine
  pointed at a dead `127.0.0.1:8123` upstream, then a mock Jellyfin
  API brought up mid-cycle):
  1. *Unavailable/reconnecting:* alert banner "Couldn't reach the
     ReelHouse API — showing demo titles. (fetch failed)" + Retry;
     chip "● ReelHouse Engine unreachable — demo titles shown ·
     reconnecting (attempt 6)…" — backoff ladder visibly escalating;
     demo titles stand in. (screenshot retained in session artifacts)
  2. *Recovery:* with a mock Jellyfin API answering, the next
     automatic retry flipped the page to engine data ("Engine Restored
     Feature" hero) and settled at "● Connected to ReelHouse Engine";
     banner gone (transient "Reconnected" flash pinned by unit test).
  3. *Stale:* engine killed again; the 60 s health refresh failed and
     the page kept the engine data on screen with amber banner "Lost
     connection to the ReelHouse API — showing the last synced
     library. (fetch failed)" and amber chip "● Connection lost —
     showing last synced titles · reconnecting (attempt 5)…" — no demo
     swap.
- `GET /api/library` with dead upstream returns 200 demo payload with
  `degraded: true` and bounded `degradedReason: "fetch failed"`.

## Notes for review

- `reconnectAttempt` counts failed loads since the last good one; the
  chip appends "· reconnecting (attempt N)…" while N > 0. The backoff
  ladder is capped at 30 s and continues indefinitely (living-room
  device profile) until the engine answers or the app unmounts.
- A degraded payload arriving while engine data is on screen keeps the
  engine data (stale) instead of swapping to demo titles; demo titles
  only appear when there is nothing better to show.
- The 60 s health refresh doubles as data freshness: a successful
  poll replaces the library payload quietly (no flash).
- Chain note for integration order: this branch carries rh-0009 +
  rh-0010/0011 + rh-0019 (integration merge `0e945d8`), so the
  frontend merge chain continues 0009 → 0010/0011 → 0019 → 0012.

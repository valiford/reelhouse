# RH-0010 Worker Report — Search Filtering Pagination and Bounded-Result Contract

- **Date:** 2026-09-18 (claimed 20:25 America/New_York, inside the 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0010-search-filtering-pagination-and-bounded-result-contract`
- **Base:** `origin/main` @ `f2cde50`

## Claim

Queue read from `origin/main` per dispatch bootstrap (`git fetch origin
--prune`, then `git show origin/main:.zcode-worker/JOB_QUEUE.md`).
RH-0008 (priority 1) and RH-0009 (priority 2) are listed READY on
`origin/main` but are leased: worktrees `reelhouse-rh-0008` and
`reelhouse-rh-0009` and matching remote branches exist, so per the
lease rule they were skipped, not duplicated. RH-0010 was the
highest-priority READY job with `AUTOMATION_ELIGIBLE: true`, no
unsatisfied dependency, and no branch/worktree anywhere — claim
uncontested. New worktree `reelhouse-rh-0010` created from
`origin/main`.

## What was built

Bounded, filtered, and explicit search/library listing for both API
routes and the UI, with cancellation, stale-response ordering, and
deterministic result identity. No Jellyfin internal-DB coupling; all
upstream access stays on the supported Jellyfin API.

| Path | Role |
|---|---|
| `src/lib/list-query.ts` | Shared parse/validate for the bounded listing contract: `q` ≤200 chars, `kind` ⊆ Movie/Series/Episode/Video (case-insensitive, deduped), `year` 1878–2100, `limit` 1–50, `offset` 0–10000. Pure, no I/O |
| `src/lib/types.ts` | `SearchPayload` (`items`/`total`/`limit`/`offset`), `LibraryPayload.degraded` flag, `ReelHouseApiError` shape |
| `src/lib/jellyfin.ts` | Upstream queries take `AbortSignal` + `EnableTotalRecordCount`; search adds `SortBy=SortName` (deterministic order), `StartIndex`/`Limit` paging, kind/year filters, id-dedup; demo mode honors the same filters/paging; library falls back to demo with explicit `degraded: true` only when an upstream actually failed (missing credentials = demo mode, not degraded) |
| `src/app/api/search/route.ts` | Validates params (400 `invalid_query` naming the field), forwards `request.signal`, maps upstream failure to explicit 502 `upstream_unavailable` and cancellation to 408 — never a fake empty list |
| `src/app/api/library/route.ts` | Same validation, plus `sections` filter (known-titles only, 400 on unknown) and bounded per-section `limit`; demo and live modes honor the identical contract |
| `src/components/ReelHouseApp.tsx` | Sequence guard so only the newest request commits (stale ordering); abort on new input, filter change, clear, and unmount; explicit Searching/empty/error states with Retry; kind filter chips; Load-more appends pages and dedupes by id; library fetch failure surfaces a banner with Retry instead of a silent demo swap |
| `src/app/globals.css` | Chips, state notes, banner, load-more styles matching the existing compact convention |
| `docs/SEARCH_LIBRARY_CONTRACT.md` | Full request/response contract, bounds, error codes, and client behavior for downstream jobs (RH-0005/RH-0006) |
| `README.md` | Feature list and verification steps (`npm test`, contract doc link) |
| `vitest.config.ts`, `package.json` | Vitest + Testing Library toolchain, `npm test` script |

## Verification

All green in `reelhouse-rh-0010` on Node 22, no credentials (demo mode):

- `npm test` — **40/40 pass** across 4 files:
  - `list-query.test.ts` (9): bounds, canonicalization, and explicit field-named rejections
  - `search/route.test.ts` (13): demo determinism (identical requests → identical payloads, disjoint windows, filters), Jellyfin-mode upstream contract (SearchTerm/SortBy/StartIndex/Limit/Headers, TotalRecordCount flow-through, id-dedup), 400 matrix, 502 on upstream failure, 408 on cancellation
  - `library/route.test.ts` (8): section filtering incl. case-insensitivity, bounded section limits, unknown-section 400, degraded-flag fallback, 408
  - `ReelHouseApp.test.tsx` (10): results + counts, empty state, error+retry, superseded-request abort + stale-response ignore, unmount abort, load-more dedupe, kind-filter re-query, library failure banner + retry, degraded chip
- `npm run lint` — clean (fixed a `react-hooks/set-state-in-effect` violation by moving the empty-term reset into the change handler)
- `npm run typecheck` — clean
- `npm run build` — succeeds; `/api/library` and `/api/search` both emit as dynamic (ƒ)
- Browser verification (production `next start` on localhost): home renders in demo mode; search "saturday" → "4 matches" grid with posters; filter chips activate and re-query; empty state renders "No matches for “…”" with hint; clearing returns home with no regression. One environment note: the in-app browser pane did not deliver trusted input events to the tab, so interactions were driven through React's own handlers (programmatic `onChange`); the input-event path itself is covered by the jsdom interaction tests.

## Constraints honored

- Jellyfin reached only via its supported HTTP API; no internal SQLite coupling.
- No database credentials in any client-reachable surface (no DB involvement at all in this job).
- Demo-safe behavior preserved: missing credentials still serve demo search/library; degradation is explicit (`degraded: true`, chip copy, banner) while silent degradation is gone.
- Deterministic identity: same query + filters + page → identical item sequence (tested).
- No merge to `main`, no deploy, no release, no production restarts, no credential changes.
- Six-plus genuinely unclaimed READY jobs remain on `origin/main` (RH-0011…RH-0014, RH-0004) without bypassing dependency gates.

## Review notes

- `git show origin/main:.zcode-worker/JOB_QUEUE.md` still lists RH-0008/RH-0009 as READY while their branches/worktrees hold leases — same anomaly RH-0002/RH-0003 showed after re-listing. Flagging for the reviewer; per protocol those jobs were treated as leased and skipped.
- RH-0002's and RH-0003's spec/queue edits live on their review branches; this branch follows the same convention (RH-0010 marked REVIEW here, to be integrated by review, not by this worker).

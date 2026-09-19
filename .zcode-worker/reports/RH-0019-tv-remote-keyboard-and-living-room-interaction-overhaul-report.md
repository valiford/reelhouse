# RH-0019 Worker Report — TV Remote Keyboard and Living-Room Interaction Overhaul

- **Date:** 2026-09-19 (claimed 16:25 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0019-tv-remote-keyboard-and-living-room-interaction-overhaul`
- **Base:** `origin/main` @ `9028194`

## Claim

Dispatch bootstrap ran `git fetch origin --prune` and read the queue from
`origin/main` per protocol. Priority-1/2 rows (RH-0008/0009/0015/0016,
RH-0002/0003) are stale-listed READY on `origin/main` but are leased:
each has an existing branch + local worktree + remote branch (lease
authority). RH-0004 was skipped as a duplicate of leased RH-0016. At
priority 5, RH-0019 and RH-0012 were both READY, unclaimed, and
automation-eligible; the tie resolves to RH-0019 via supervisor commit
`9028194` ("Reload tomorrow ZCode priority queue", 2026-09-19 01:56),
which set `WAVE: Tomorrow priority` on RH-0019 — today. Worktree
`reelhouse-rh-0019` created off `origin/main`; no other worktree entered.

## Commits on the branch

Implementation (base `origin/main` @ `9028194`):

1. `f4135f7` — Deterministic TV spatial navigation engine + test harness:
   pure geometric candidate picker (`src/lib/spatial.ts`), DOM adapter
   with vendor back-key detection (Escape/GoBack/BrowserBack, webOS 461,
   Tizen GoBack 10009, Backspace outside text) and focus scopes
   (`src/lib/tvnav.ts`), React key-routing hook
   (`src/hooks/useTvNavigation.ts`), defensive result dedupe
   (`src/lib/uniqueById.ts`), bounded redacted diagnostics
   (`src/lib/diag.ts`), vitest+jsdom harness with deterministic
   `data-rect` layout stubbing, and unit suites.
2. `e2db79e` — UI wiring: arrow/enter/back across top bar, hero, rails,
   search, profile menu, and detail modal; focus-scope modal with
   `aria-labelledby`, invoker restore on close; search Enter commit
   stepping focus into results; stale-response guard; live match count
   (`aria-live`) + `aria-busy`; keyboard-only focus rings; modal/panel
   entrance transitions with reduced-motion kills; 1600/2200px 10-foot
   density tiers; full component regression matrix.
3. `aa197cc` — README TV-strategy and verification updates, job
   spec → REVIEW, queue updated, report.

Integration merges (per the rh-0015/rh-0016 worker precedent — a REVIEW
branch carries the chain it builds on):

4. `69fdc9b` — Integrate `origin/rh-0009` (focus-navigation shell).
   Byte-identical files (`spatial.ts`, `tvnav.ts`, `vitest.config.ts`,
   `vitest.setup.ts`, `spatial.test.ts`, `package.json` scripts/deps)
   merged clean; hook + component + CSS resolved to the overhaul
   supersets; carries RH-0009's route tests, `docs/TV_NAVIGATION.md`,
   spec REVIEW marker, and report.
5. `99c6200` — Integrate `origin/rh-0011` (which carries `rh-0010`).
   Union component: their bounded search contract (request-seq
   stale-guard, kind filter chips, load-more pagination, PosterImage
   fallback, degraded/connecting chips, error/retry states) + the
   overhaul's TV layer. `uniqueById` guards the first results page;
   bounded redacted warnings added to both fetch paths; their
   `ReelHouseApp.test.tsx` joins the suite with ONE locator adapted
   (`"Toggle search"` → `"Search"`, the shell's a11y name); their route
   tests supersede RH-0009's (new bounded contract); vitest config kept
   jsdom+setup (their jsdom-per-file pragma is compatible).

## Acceptance criteria

| Criterion | Result |
|---|---|
| Deterministic tests cover success + stale/duplicate/failure/recovery paths | ✅ 86 tests across 9 files: stale out-of-order responses ignored (request-seq guard), duplicate results deduped, search/library failure paths bounded with explicit retry UI, recovery on next query, spatial edge/tie/phantom determinism, bounded search contract (RH-0010's suites carried) |
| Build/lint/typecheck suites remain green | ✅ `eslint .` clean, `tsc --noEmit` clean, `next build` succeeds (`○ /`, `ƒ /api/library`, `ƒ /api/search`) — re-run after each integration merge |
| Diagnostics bounded and redacted | ✅ `boundedMessage`: 200-char cap, status-only messages generated client-side; household query strings/URLs never enter logs (pinned by exact-call test assertions) |
| Data boundaries preserved | ✅ Jellyfin untouched; no DB coupling; demo fallback intact; no secrets in source |
| No merge/deploy/release | ✅ Local build + localhost smoke only |

## Verification evidence (2026-09-19, Node 22.19.0 / npm 10.9.3)

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm run test` — **86 passed (9 files)** on the fully integrated
  branch: spatial engine (8), tvnav DOM layer (13), component TV
  matrix (14), uniqueById (2), boundedMessage (5), RH-0009 route
  tests superseded by RH-0010's bounded-contract route tests, RH-0010/
  0011 component suites (search states, filters, load-more, degraded
  chip, poster fallback, hero crossfade).
- `npm run build` — succeeds; production server smoke on :3219 re-run
  on the integrated branch.
- Browser verification (ZCode IAB pane, 1920×1080 and 2560×1440),
  repeated on the final integrated build: arrow keys walk top bar →
  hero → rails with correct aligned-column targeting; `data-kbd-nav`
  set on first key and cleared on pointer; card focus reveals
  off-screen rails; details modal opens with focus on the primary
  action (Watchlist fallback for demo items), traps Tab, animates in
  (`rh-modal-in` computed), closes on Escape/Back with focus restored
  to the invoker; search autofocuses, renders the kind-filter toolbar,
  announces "N matches" live, Enter commits focus into the first
  result, Back closes and restores the toggle; density tiers engage
  quantitatively (primary buttons 46→58→68px, cards 230→300→380px
  caps, topbar 74→92→108px); focus-ring selectors confirmed in the
  built stylesheet, rendering verified via computed `box-shadow`
  (gold 2–3px ring).

## Environment limitation found during browser verification

The ZCode in-app browser pane is never OS-focused, so Chromium does not
match `:focus` on `document.activeElement` there (broken focus chain),
and untrusted synthetic Enter cannot trigger native button activation.
Neither applies to a real TV/desktop browser with a focused document:
`:focus` semantics are standard browser behavior and Enter/Space
activation of focused controls is native trusted-event behavior. Both
paths are covered by the jsdom suite (initial focus, ring selectors,
activation via the same click handler native Enter dispatches). Recorded
here for the reviewer's context; no code change made.

## Integration status (rh-0009 / rh-0010 / rh-0011)

This branch now **contains** the full leased frontend chain:
`rh-0009` (shell, merged at `69fdc9b`) and `rh-0011` carrying `rh-0010`
(merged at `99c6200`) — the same pattern rh-0015/rh-0016 established
for the backend wave. Recommended acceptance order collapses to:

- **Merge this branch; it supersedes rh-0009 + rh-0010 + rh-0011
  content-wise** (their commits are ancestors of this branch, so the
  controller can merge rh-0009 → rh-0010 → rh-0011 → rh-0019 in queue
  order and the last merge is a fast-forward of already-integrated
  history), or merge them in any order — all conflicts were resolved
  here.
- Post-merge dedupe check: rh-0010's independent vitest toolchain and
  RH-0009's were unified to one config (jsdom + setup, per-file pragma
  compatible); `package.json` devDeps are the union (adds
  @testing-library/user-event).

## Findings the controller should see

1. `npm install` for the dev-only test toolchain (vitest 5, jsdom 29,
   @testing-library, @vitejs/plugin-react — version ranges identical to
   RH-0009's, plus @testing-library/user-event from rh-0010) prints
   existing `npm audit` notices; all are in dev dependencies,
   non-blocking, and RH-0008 owns the security pass.
2. Stale-response handling: RH-0010's request-seq guard (carried) and
   this job's cancelled-flag covered the same race two ways; the union
   keeps the seq guard as the single mechanism, with client-side
   `uniqueById` on the first page as a defensive duplicate guard on top
   of the route-level id-dedup.
3. Client fetch diagnostics intentionally carry HTTP status only — never
   URLs or query text (household search terms are treated as private).
4. RH-0012 (degraded-mode UX) remains the right home for explicit
   Jellyfin unavailable/reconnecting states; the carried degraded chip
   and this job's bounded demo-fallback logging are stopgaps, not the
   full UX.

## Handoff

Upon acceptance: merge rh-0009 → rh-0010 → rh-0011 → rh-0019 in queue
order (or merge this branch last as the integration carrier — see
Integration status). Six genuinely unclaimed READY jobs remain
(RH-0012/0013/0014/0020/0021 plus RH-0004 unless retired as an RH-0016
duplicate).

# RH-0035 — TV remote and living-room interaction enhancement — Worker Report

**Date:** 2026-09-23 (claimed ~12:25 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0035-tv-remote-and-living-room-interaction-enhancement` (worktree `reelhouse-rh-0035`, stacked on `origin/rh-0034-…` at `57dee98`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The living-room UI now runs **on the RH-0034 PostgreSQL read models** with a
complete, deterministic remote/keyboard interaction layer. This is the
switchover RH-0034's report explicitly deferred to RH-0035.

- `src/lib/tv/navigation.ts` — **pure spatial-navigation engine**: focus
  targets registered as `(band, slot)` coordinates mirroring the visual
  rows; left/right move within a band and **stop at band edges** (no wrap);
  up/down walk to the nearest non-empty band bounded by the map's
  `extent` and snap to the nearest slot with ties breaking to the smaller
  slot; first-claim-wins on duplicate ids and duplicate coordinates (an
  unreachable twin would strand focus). No DOM access — the entire focus
  order is hermetically testable.
- `src/lib/tv/viewmodel.ts` — **pure payload→view-model mappers** for every
  endpoint the UI consumes (`/api/home`, `/api/catalog/search`,
  `/api/catalog/items/:id`, `/api/catalog/status`, `/api/health`): card/rail
  render sets (enabled + resolved + non-empty rails in household order,
  position ties broken by slug), watch-progress percentages from household
  ticks (clamped 0–100), episode/season subtitles, image/play URLs built
  **only from `NEXT_PUBLIC_JELLYFIN_URL`** (null → letter tiles, mirroring
  the server-side `jellyfin.ts` builder), detail facets/people/file
  summary, and the banner matrix composing catalog freshness with Jellyfin
  health in priority order (Jellyfin-down > stale > never-synced-with-items).
- `src/components/ReelHouseApp.tsx` — rewritten over the read models:
  - **Boot routing**: `/api/health` sends an unconfigured database to the
    documented demo mode (demo library + `/api/search`); anything else
    loads `/api/home` (+ `/api/catalog/status`). Initial roving focus lands
    on the hero Play control after load.
  - **Keyboard contract**: one window keydown handler — arrows move focus
    through the engine, Enter activates natively, Backspace/Escape unwind
    modal → search → home, `Tab` is trapped inside the modal, and while the
    search input owns typing only ArrowDown (into results) and
    Escape/Backspace (leave search) are intercepted. Roving `tabindex`
    keeps exactly one tab stop; focused rails scroll `nearest`.
  - **Modal**: opens via card/hero activation, loads
    `/api/catalog/items/:id` (skeleton while loading), renders facets,
    people (name — role), file summary, and the Jellyfin play deep link;
    **404 renders a real "no longer in your catalog" state** (catalog churn
    between feed render and detail fetch); errors render retry; Escape/
    Backspace/backdrop-click close with focus restored to the opener.
  - **Search**: debounced 220 ms over `/api/catalog/search` (bounded
    limit 24 + explicit Load-more with `hasMore`), Movies/Shows nav presets
    (`types=movie|series`), rail "See all" opens the rail's library filter
    (`libraries=`), filter chip clears, empty/error/retry states, result
    grid registered as engine bands at 3/4/5/6 columns per density tier
    (CSS breakpoints use the same numbers, so band math always equals
    visual rows).
  - **States**: skeleton rails/hero/details while loading (`aria-busy`),
    feed 503 → recovery panel with Retry, profile 404 → profile-specific
    panel, empty household / empty rails states, unresolved-home-row and
    stale-catalog chips, degraded-Jellyfin banner (`role="status"`),
    `aria-live` status region for load/search/feed state.
  - Honest-UI cleanup: the hardcoded profile menu (hover-only, unusable on
    TV) is replaced by a display-only pill showing the feed's resolved
    profile (profile scoping is `?profile=<slug>`); the dead "+ Watchlist"
    button and the unexpressible "Home Videos" nav item are gone (the
    catalog normalizes Jellyfin `Video` → `movie`, so the type axis cannot
    slice home videos; they surface through library rails/`libraries=`).
- `src/app/globals.css` — **visible focus at every viewport** (`:focus`
  outline via `--focus-ring`, widening 3→4→5px with the tiers; cards
  additionally scale), **card-density tiers** at ≥1600px/≥2400px (larger
  cards, gaps, headings, buttons), fixed-column result grid matching the
  engine, skeleton shimmer, banner/state-panel styling, `.sr-only`, and
  `prefers-reduced-motion: reduce` disabling shimmer and card motion
  (outlines remain — indication is layout, not motion).
- Tests: `src/lib/tv/navigation.test.ts` (11 tests) +
  `src/lib/tv/viewmodel.test.ts` (12 tests), wired into `npm test`.
- Docs: `docs/TV_REMOTE.md` (data sources per mode, key map, focus order,
  states, accessibility, notes), README read-models section extended,
  `docs/READMODELS.md` gained a Consumer section.

## Design decisions worth review

- **Engine + mappers as pure libraries; React only wires.** There is no
  React testing infra in this repo, so the two halves that must be
  deterministic (focus order, display data) live outside React and are
  fully hermetically tested; the component reduces to state + wiring.
- **The hermetic suite caught a real remote-breaking bug before any live
  run**: the vertical scan's downward loop had no upper bound, so pressing
  ArrowDown on the last band spun forever (the "hang" first appeared as an
  inexplicable `node --test` child timeout). `FocusMap.extent` now bounds
  the scan; a regression test pins the last-band stop.
- **Demo mode is routed by `/api/health`, not by try/catch fallback.** The
  UI never silently swaps demo data for a database error: unconfigured →
  demo (a legitimate no-database operating state per `/api/health`'s own
  contract), unreachable → an explicit recovery panel.
- **Dispatched-event caveat, probed and explained**: the in-app browser's
  input bridge delivers no keydown events to the guest page (verified with
  an event logger — `cua.keypress` and `locator.press` both produce zero
  keydowns), so live browser verification dispatched `KeyboardEvent`s at
  the focused element. The app-side chain (handler → engine → roving
  focus → DOM focus) is thereby verified end-to-end in the real build
  against the real PG read models; the untestable residue is the OS input
  layer, and Enter's native activation is likewise trusted-event-only.
  Likewise `:focus` styling cannot match while the pane has no OS focus
  (`document.hasFocus() === false`); the loaded stylesheet rule was
  asserted instead of a screenshot.
- **Shared dev-DB checksum conflict, failed closed.** `npm run db:migrate`
  against the shared `reelhouse` dev database refused to run (migration 8
  checksum differs from another worker's recorded state — the migrator's
  fail-closed migration-uncertainty contract doing its job). I created a
  separate `reelhouse_rh0035_verify` database in the same disposable
  container and verified there; the shared database and the other worker's
  state were left untouched.

## Verification evidence

All commands run in `reelhouse-rh-0035`. Live stack: disposable loopback
PG18 (`127.0.0.1:5433`, database `reelhouse_rh0035_verify`, least-privilege
`reelhouse_app` role) + the deterministic Jellyfin stub
(`scripts/dev/jellyfin-stub.mjs`, DATASET=baseline) + `npm start` (port
3100) — never Synology.

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm test` — **136/136 pass** (113 pre-existing + 23 new: engine
  registration/dup-drop/edge-stop/nearest-band/tie-break/extent matrix,
  empty-map inertness; view-model cards/rails/hero/progress/image-URL/
  detail/banner matrices).
- `npm run build` — production build succeeds; all routes registered
  (`/` static, the seven API routes dynamic).
- `db:migrate` — 8/8 applied on the fresh verify database, then **re-run:
  "up to date — 8 migration(s) already applied"** (idempotent).
- `catalog:sync` (full) — run #2: libraries=2 items=9 upserted=8
  changes=8 watermark=2024-01-01T00:00:00.000Z (run #1 had recorded FAILED
  when the stub port raced; both runs visible in `/api/catalog/status`
  `recentRuns` with the FAILED run never changing the fresh verdict).
- `household:import` — run #1 full import; **run #2 idempotent re-import
  wrote only deltas** (profiles 2w→0w, favs 4w→3w, collEntries 6w→5w).
- Live curl matrix (server on 3100):
  ```text
  GET /api/health          → ok, database reachable (8 migrations, creds
                             summarized as reelhouse_app:***@…), jellyfin
                             "unreachable" (stub has no /System/Info/Public)
                             → drives the UI's degraded banner
  GET /api/home            → default profile v_ali; continue_watching =
                             [Pilot, 40% watched]; rails ordered; household
                             positions honored
  GET /api/home?profile=nicole → her rails only (profile isolation)
  GET /api/home?profile=ghost  → 404 not_found
  GET /api/home?limit=1    → perRailLimit=1, no rail exceeds 1 item
  GET /api/catalog/search?q=a&types=movie&sort=rating&limit=3
                           → filters echoed, rating desc
  GET /api/catalog/search?sort=vibes → 400 invalid_request
  GET /api/catalog/search?limit=4&offset=4 → items 4, total 8, hasMore false
  GET /api/catalog/items/mov-arrival → detail with facets
  GET /api/catalog/items/mov-nope    → 404 not_found
  GET /api/catalog/status  → fresh, 8 items byType, watermark, household
                             fresh, recentRuns [(full,succeeded),(full,failed)]
  Dead-port DATABASE_URL (127.0.0.1:5999), server on 3102:
    /api/home, /api/catalog/search, /api/catalog/status, /api/catalog/items/…
                           → all 503 {"error":"database_unavailable",
                             "detail":"connect ECONNREFUSED 127.0.0.1:5999"}
                             — no credentials or URL echoed
  ```
- Live browser matrix (in-app browser at 1920×1080 against the built app):
  ```text
  Boot            → status "Home feed loaded for V'Ali"; profile pill V'Ali;
                    banner "ReelHouse Engine is unreachable…"; hero Pilot
                    (Demo Show · S1:E1); rails Continue Watching (40% watched
                    chip on card), Recently Added, Movies, TV Shows, Family
                    Picks, Movie Night; initial roving focus on hero Play
  ArrowDown ×2    → hero-play → continue_watching:seeall → :card:0
  ArrowRight      → edge stop (single-card rail, focus unchanged)
  ArrowUp ×2      → :card:0 → :seeall → hero-play
  Down/Down/Down  → seeall → card:0 → recently_added:seeall (skips the
                    single-card band correctly)
  Card click      → role=dialog aria-modal=true, focus → modal-close,
                    title "Pilot" fetched from /api/catalog/items/ep-demo-1
  Escape          → modal gone, focus restored to opener card
  Search click    → input autofocused (search-input); "a" → 4 bounded
                    matches with count; ArrowDown → result:0;
                    Escape → search closed, focus restored to nav-search
  Roving tabindex → active element tabIndex 0, all others -1
  ```
  Keyboard events were dispatched as documented above (the automation
  bridge delivers no native keydowns); the stylesheet's `:focus` rule was
  asserted loaded rather than screenshot-verified (the pane has no OS
  focus during automation, so `:focus` cannot match there).

## Boundaries respected

- Jellyfin touched only through its HTTP API (the stub); its internal
  SQLite never read or written. Playback remains a Jellyfin web deep link.
- No PostgreSQL credentials reached the client; dead-port/503 details are
  redacted; `/api/health` summarizes the URL with `***`.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; unresolved rails (missing targets) are dropped
  client-side as data-level degradation; catalog churn renders as the
  detail-404 state rather than a stale card.
- The read-model/UI layer never writes; no schema changes in this job.
- The shared dev database's checksum conflict was failed-closed and
  routed around (separate verify database), never "fixed" in place.
- No merge to `main`, no deploy, no release, no credential changes;
  other workers' branches, worktrees, and processes untouched (the
  pre-existing port-3000 listener was left alone; my own orphans were
  killed by PID).
- Claim window: claimed ~12:25 PM EDT 2026-09-23, inside 11:00–21:00
  America/New_York.

## REVIEW notes

- Stack: this branch sits on `origin/rh-0034-…` (`57dee98`) like every
  predecessor in the wave; if any squash-merges, rebase onto the successor
  (no force-push).
- Stale queue rows persist on `origin/main` (RH-0030–0034 still READY
  while their branches carry REVIEW reports); per the dispatch bootstrap,
  branch/worktree existence is the lease authority and this branch is the
  claim record for RH-0035. Remaining genuinely unclaimed READY in the
  current wave: RH-0036–0037 (plus older-wave rows) — the six-unclaimed
  guideline is still not met by the current wave alone; flagged again.
- The in-app browser's screenshot surface timed out twice and its input
  bridge delivers no keydowns; both are environment limits, worked around
  with computed-style/stylesheet assertions and dispatched events. A
  reviewer with a focused window should see the gold focus ring directly.
- Natural next claim: RH-0036 or RH-0037 (no dependencies on this branch).

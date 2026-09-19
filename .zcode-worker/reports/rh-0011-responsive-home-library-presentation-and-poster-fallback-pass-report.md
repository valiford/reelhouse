# RH-0011 Worker Report — Responsive Home Library Presentation and Poster Fallback Pass

- **Date:** 2026-09-19 (claimed 15:26 America/New_York, inside the 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0011-responsive-home-library-presentation-and-poster-fallback-pass`
- **Base:** `rh-0010-search-filtering-pagination-and-bounded-result-contract` @ `cb80a01` (stacked; see Claim)

## Claim

Queue read from `origin/main` per dispatch bootstrap (`git fetch origin
--prune`, then `git show origin/main:.zcode-worker/JOB_QUEUE.md`). The
`origin/main` queue still lists RH-0002/0003/0008/0009/0010/0015/0016/
0017/0018 as READY, but every one of those has a remote branch and a
local worktree whose tip commit marks the job REVIEW — per the lease
rule they were treated as claimed and skipped, not duplicated.
RH-0004 (Jellyfin→`media_catalog` sync) duplicates leased RH-0016 and
was also skipped. RH-0011 was the highest-priority genuinely
unclaimed READY job with `AUTOMATION_ELIGIBLE: true` and no
unsatisfied dependency. No branch or worktree named `rh-0011*`
existed anywhere; claim uncontested.

**Base choice:** this branch starts from the rh-0010 review tip, not
`origin/main`, because RH-0010 (in REVIEW, unmerged) already rewrote
the same component (`ReelHouseApp.tsx`) and stylesheet regions this
job targets — its library-error banner and search status states are
the scaffolding RH-0011 builds on. This follows the accepted
RH-0017-on-rh-0016 stacking precedent; merge order for the reviewer is
RH-0010 then RH-0011 (RH-0011 contains rh-0010's commits, so it must
not merge first).

## What was built

Home-row, poster, density, loading-state, missing-art, and
layout-stability improvements in the presentation layer only. No API,
data-layer, or Jellyfin-authority changes.

| Change | Detail |
|---|---|
| Real poster `<img>` with failure fallback | `Card` no longer paints posters via CSS `background-image`. New `PosterImage` renders `<img loading="lazy" decoding="async">` with a fade-in on load; a load *error* swaps the card to the title-initial fallback (`PosterFallback`). Previously only items *without* an image URL got the fallback — broken or unreachable image URLs rendered as empty boxes forever. Lazy loading also stops offscreen rows from fetching 28+ posters eagerly |
| SSR image race fix | Images that finish loading (or fail) *before* hydration attaches `onLoad`/`onError` previously never reached the visible/fallback state — observed live: 14 of 28 loaded posters stuck invisible. Fixed with a callback ref that reconciles `img.complete`/`naturalWidth` at attach; re-verified 28/28 ready. `PosterImage` is keyed by image URL so payload swaps remount and re-arm the cycle (no effects, no lint exceptions) |
| Library connecting state | `source-chip` now shows a pulsing "Connecting to ReelHouse Engine…" state (with `aria-busy` on the content rail) while the `/api/library` fetch is in flight, instead of implying the demo library is final during load. Retry re-enters the connecting state |
| Empty connected library | When the engine is authoritative (`source: "jellyfin"`) but returns zero sections, an explicit "nothing is indexed yet" note replaces the formerly blank rail |
| Hero crossfade | Hero backdrop moved from an inline `background-image` on the section to a keyed `.hero-bg` layer with a fade-in, so the demo→engine backdrop swap no longer pops; the gradient fallback stays underneath |
| Row scroll/affordance | `.media-row` gains `scroll-snap-type: x proximity` + `scroll-padding-left` aligned to the shared page gutter and per-card `scroll-snap-align` (touch and TV-wheel friendly); a `padding-top/negative-margin` pair gives the hover-lift and focus ring headroom so `overflow-x: auto` no longer clips the top 5px of raised cards |
| Poster sizing/density | Search `poster-grid` switches to `minmax(clamp(132px, 38vw, 170px), 1fr)`: phones get 2 poster columns instead of 1 (verified; tuned after a classic-scrollbar viewport shrink collapsed the first attempt to 1 column), tablets/desktop get proportionally larger posters. Card copy is line-clamped (2-line title, 1-line meta) so long titles can't reflow the overlay; fallback initial scales with `clamp()` |
| Consistency + motion safety | Introduced `--page-gutter` custom property replacing four copies of the gutter clamp; `prefers-reduced-motion` guard disables the new fades, hover transform, and pulse; details-modal close button gets an accessible name |

## Verification

All green in `reelhouse-rh-0011`, no credentials (demo mode):

- `npm test` — **44/44 pass** across 4 files. RH-0010's 40 tests all
  still pass unmodified; 4 new `ReelHouseApp` tests cover the new
  behavior: connecting chip until the library fetch settles, poster
  `<img>` renders lazy and falls back to the title initial on image
  error, empty connected library note, hero crossfade layer present.
- `npm run lint` — clean. One deliberate
  `eslint-disable-next-line @next/next/no-img-element` with in-code
  justification: posters load directly from the household's Jellyfin
  host; routing them through the Next image optimizer is RH-0013
  scope ("Poster image loading and performance guard").
- `npm run typecheck` — clean.
- `npm run build` — succeeds; same route shapes as base (`/` static,
  both API routes dynamic).
- Browser verification (production `next start`, localhost:3311):
  - Desktop 1440×900: hero, chip (resolved demo state), all four home
    rows, gutter alignment, next-card peek, progress bars render.
  - Poster images: 28/28 reach the `is-ready` fade-in state after the
    hydration-race fix (was 14/28 — the bug was found live in this
    pass).
  - Forced a real image failure on a rendered card: `<img>` removed,
    title-initial fallback card rendered ("T" for The Long Weekend)
    with copy and progress bar intact.
  - Mobile 390×844: rows at 152px columns with peek; search grid
    measures 2 columns side-by-side (re-tested after the density fix).
  - Screenshot note: full-viewport captures in the in-app browser
    sometimes composite `<img>` layers dark; clipped captures and DOM
    probes (naturalWidth, computed opacity, class states) were used
    as ground truth.

## Constraints honored

- Jellyfin reached only via its supported HTTP API (`src/lib/jellyfin.ts`,
  untouched); no internal Jellyfin database coupling introduced. Diff
  touches only `ReelHouseApp.tsx`, `globals.css`, and the component
  test file; a repo-wide grep for DB/sqlite/postgres coupling over
  `src/` matches nothing real (only `pg` inside "jpg").
- Demo fallback behavior preserved; the degraded banner and chip copy
  from RH-0010 are untouched and still tested.
- No deployment, no credential or environment changes, no production
  restarts (the localhost server used for verification was stopped).
- No merge to `main`, no release, no force-push; another worker's
  branches/worktrees untouched.
- Six-plus genuinely unclaimed READY jobs remain (RH-0012, RH-0013,
  RH-0014, RH-0019, RH-0020, RH-0021) without bypassing dependency
  gates.

## Review notes

- Merge order: RH-0010 must land before/with RH-0011 (this branch
  contains rh-0010's commits).
- `origin/main`'s queue copy remains stale for all leased jobs (shows
  them READY while their branches hold REVIEW-tip leases) — same
  anomaly flagged in the RH-0010 report; treated as leased per
  protocol.
- Deep focus-navigation/keyboard work deliberately left to RH-0009
  (leased, REVIEW); image pipeline/performance guard left to RH-0013
  (unclaimed READY); full accessibility/reduced-motion suite left to
  RH-0014 (unclaimed READY). This pass only adds the basic
  reduced-motion guard for the animations it introduces.

# RH-0013 Worker Report — Poster Image Loading and Performance Guard

- **Date:** 2026-09-19 (claimed 19:26 America/New_York, inside the 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0013-poster-image-loading-and-performance-guard`
- **Base:** `0e945d8` — the chain-integration merge (origin/main `9028194` + rh-0019 chain tip `413fd83`; its tree is identical to `413fd83`)

## Claim

Queue read from `origin/main` per dispatch bootstrap (`git fetch origin
--prune`, then `git show origin/main:.zcode-worker/JOB_QUEUE.md`). The
`origin/main` queue lists twelve jobs READY, but branch/worktree
inspection (the lease authority) shows twelve leases already exist:
rh-0002, rh-0003, rh-0008, rh-0009, rh-0010, rh-0011, rh-0012,
rh-0015, rh-0016, rh-0017, rh-0018, rh-0019. The rh-0012 worktree
additionally holds **uncommitted in-flight work** — an active lease,
skipped without entering or modifying it. RH-0004 (priority 4) was
skipped as a duplicate: its scope (Jellyfin→`media_catalog`
synchronization with stable identity, provenance, idempotent
reconciliation) is leased RH-0016 verbatim. RH-0020 (same priority 6 as
this job) is marked `WAVE: Tomorrow priority` in its spec, deferring it
past RH-0013. RH-0013 is therefore the highest-priority genuinely
unclaimed READY job with `AUTOMATION_ELIGIBLE: true` and no
dependencies; no `rh-0013*` branch or worktree existed anywhere at
claim time. Claim uncontested.

**Base choice:** `0e945d8` rather than `origin/main`, because the
frontend chain in REVIEW (rh-0009/0010/0011/0019) owns the exact
component and stylesheet regions this job targets (`PosterImage`, the
`.poster`/`.hero` CSS contracts). Verified before choosing: the merge
commit's tree is byte-identical to rh-0019's tip, so nothing from
rh-0012's in-flight work is embedded. Merge order for the reviewer:
any chain order already accepted works; this branch carries the whole
integrated chain plus origin/main, with **no changes to
`jellyfin.ts` or `types.ts`** (rh-0012's in-flight files) and only
co-located presentation edits in `ReelHouseApp.tsx`/`globals.css`.

## What was built

The image pipeline RH-0011 explicitly deferred to this job: responsive
sizing, an explicit loading policy, formalized layout-shift protection,
and performance-guard tests. Presentation layer only — no API, data
layer, or authority changes.

| Change | Detail |
|---|---|
| Responsive poster sizing | New `src/lib/poster-image.ts` builds `srcSet` candidates by rewriting only the `maxWidth` query parameter of the existing Jellyfin image URL — byte-preserving for every other parameter (`URLSearchParams.toString()` re-encodes `%20` as `+`, pointlessly fragmenting upstream caches). Poster ladder 240/360/480/720/960 covers the largest layout slot (380 CSS px at ≥2200px) at DPR 2; `sizes` mirrors the widest slot per breakpoint. Fixed-size art (demo picsum URLs) renders src-only, exactly as before |
| Hero LCP policy | The hero backdrop moved from a CSS `background-image` div to a real `<img>` with `fetchPriority="high"`, eager loading, `decoding="async"`, backdrop ladder 640–1920 at `sizes="100vw"`. The hero was the only eagerly-fetched large art surface but had no priority hint and always pulled the one-size 1600w file. Visual contract unchanged (`object-fit: cover; object-position: center 35%`, keyed fade-in crossfade, shade gradients) |
| Optimizer decision recorded | RH-0011 left "routing through the Next image optimizer" open for this job. Evaluated and **rejected with rationale**: it would proxy every art byte through the NAS-hosted Node server (CPU + a hop per image) while Jellyfin already resizes and caches per `maxWidth`, and it moves media traffic off Jellyfin's media authority. Documented in `docs/IMAGE_LOADING.md`; the `no-img-element` disable now carries the final decision instead of a deferral |
| Layout-shift protection formalized | CLS safety was already structural (`.poster` reserves 2/3 via `aspect-ratio` + absolute `object-fit: cover` img; `.hero` reserves `min-height: 68vh`); it is now a **tested contract** — every rendered poster must sit inside the aspect-ratio slot, and the hero img is asserted absolute-in-hero via the CSS/DOM probes below |
| Graceful degradation | Non-Jellyfin URLs (demo art) and malformed inputs return no candidates rather than broken attributes; unit tests pin the rejection rules (wrong path shape, missing/non-numeric `maxWidth`, non-integer/non-positive widths, unsorted/duplicate ladder entries) |

## Verification

All green in `reelhouse-rh-0013`, no credentials (demo mode):

- `npm test` — **103/103 pass** across 11 files. The 86 inherited from
  the chain (rh-0019 tip count) all pass unmodified; **17 new**: 10
  unit (`poster-image.test.ts`)
  and 7 component guards (`ReelHouseApp.posters.test.tsx` — new file,
  deliberately separate from `ReelHouseApp.test.tsx` to avoid colliding
  with rh-0012's in-flight edits): srcSet/sizes present for Jellyfin art
  and absent for fixed-size art, every poster lazy + inside the
  aspect-ratio slot, hero eager + `fetchpriority=high` + `100vw` +
  ascending backdrop ladder, title-initial fallback still reached on the
  srcSet path, hero layer omitted when the payload has no backdrop.
- `npm run lint` — clean; `npm run typecheck` — clean; `npm run build` —
  succeeds with unchanged route shapes (`/` static, both API routes
  dynamic).
- Browser verification (production `next start`, localhost:3313, stopped
  after):
  - Desktop 1440×900 (DOM probe): hero `<img>` eager with
    `fetchpriority=high`, fully loaded (naturalWidth 1600), computed
    `object-fit: cover` / `object-position: 50% 35%`, filling the hero
    box; **28/28 posters** `loading=lazy`, all reaching `is-ready`, zero
    fallbacks; poster slots computed `aspect-ratio: 2 / 3`.
  - Mobile 390×844 (DOM probe): posters measure 152×228 (exact 2:3), no
    horizontal overflow, hero fully loaded, 28/28 ready.
  - Failure path, live: repointing a rendered poster's `src` at an
    unreachable URL fired the real error path — `<img>` removed,
    title-initial fallback rendered in its place (27 imgs + 1 fallback).
  - Visual capture: hero photo composites correctly (cover crop keeps
    `center 35%`, shade gradient and copy layered above); the in-app
    browser's full-viewport screenshot compositing tiles/duplicates
    layers (same artifact the RH-0011 report documented), so DOM probes
    were used as ground truth.
  - Honest limitation: the demo deployment serves fixed-size picsum art,
    so the live page renders the src-only path; the srcSet attribute
    contract is verified by the deterministic tests. A candidate-selection
    probe against a synthetic `<img>` was inconclusive (`currentSrc`
    stays empty for offscreen synthetic images) and is standard browser
    behavior, not app code.

## Constraints honored

- Jellyfin reached only via its supported HTTP image API (`maxWidth`
  variants of the same URLs the app already used); **no changes to
  `src/lib/jellyfin.ts`** — no internal Jellyfin database coupling
  introduced. Repo-wide check: new files touch no DB/SQLite/PG surface.
- Demo fallback behavior preserved end to end (degraded banner, chip,
  and RH-0011's fallback paths all still pass unmodified).
- No deployment, no credential or environment changes, no production
  restarts; the localhost verification server was stopped after use.
- No merge to `main`, no release, no force-push; no other job's branch
  or worktree entered or modified.
- Unclaimed READY after this claim: RH-0014, RH-0020 (tomorrow wave),
  RH-0021. The "at least six unclaimed READY" reserve is currently
  infeasible — eleven READY rows are held by active REVIEW leases and
  RH-0004 duplicates leased RH-0016; refill is the dispatcher's queue
  action, not new invented work.

## Review notes

- Merge order: this branch already contains origin/main and the whole
  rh-0009→0010→0011→0019 chain, so it merges after the chain without
  further ordering constraints. It does **not** contain rh-0012's
  in-flight work; both edit `ReelHouseApp.tsx` and `globals.css`, so
  whoever lands second rebases onto the first. This branch deliberately
  does not touch `jellyfin.ts`/`types.ts`, which rh-0012 also edits.
- `origin/main`'s queue remains stale for all leased jobs (READY rows
  whose branches hold REVIEW tips) — same anomaly flagged in the
  RH-0010/0011 reports; treated as leased per the lease-authority rule.
  This branch's queue copy moves only RH-0013 to REVIEW.
- The wildcard `images.remotePatterns` in `next.config.ts` is now inert
  for art (no `next/image` usage); tightening or removing it belongs to
  the security-hardening review (RH-0008) and was deliberately left
  untouched here.
- Accessibility/reduced-motion regression depth belongs to RH-0014
  (unclaimed READY); this job only preserved the existing
  `prefers-reduced-motion` guard for the hero fade.

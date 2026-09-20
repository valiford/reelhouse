# RH-0014 Worker Report — Accessibility and Reduced-Motion Regression Suite

- **Date:** 2026-09-20 (claimed 16:25 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0014-accessibility-and-reduced-motion-regression-suite`
- **Base:** `origin/main` @ `df9b1d4`

## Trigger

At dispatch the authoritative `origin/main` queue listed nineteen READY
jobs. Before claiming, remote branches and local worktrees were checked
(lease authority): all candidates above priority 7 were already leased —
RH-0022/0023/0015–0020 and RH-0008–0013 all have branches/worktrees.
RH-0004 (p4) is unleased but duplicates leased RH-0016 (same
Jellyfin→`media_catalog` sync scope), so claiming it would duplicate an
existing claim. Remaining genuinely unclaimed READY jobs: RH-0014 (p7)
and RH-0021 (p7); RH-0021's spec is marked `WAVE: Tomorrow priority`
(later wave), so **RH-0014** was claimed. The lease was pushed to origin
before implementation started.

## Commits on the branch

1. `3881b56` *(implementation)* — Accessibility/reduced-motion fixes in
   `ReelHouseApp.tsx` + `globals.css` (details-dialog focus management,
   keyboard-operable profile menu, search surface semantics, skip link,
   visible focus ring, `prefers-reduced-motion` guard) plus the 62-check
   regression suite (`tests/a11y/`, vitest + Testing Library + jsdom +
   jest-axe), `vitest.config.ts`, and `docs/ACCESSIBILITY.md`.
2. *(this commit)* — Job spec → REVIEW, queue updated (RH-0014 moved to
   Review Queue), README testing section, this report.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Keyboard / focus / semantic / contrast / reduced-motion / responsive coverage | ✅ All six areas have dedicated suites (see coverage map in `docs/ACCESSIBILITY.md`): semantics (11), keyboard (8), failure paths (6), axe audits (4), contrast (19), motion (4), responsive (11) |
| Build stays green | ✅ `npm run build` succeeds; routes unchanged (`/`, `/api/library`, `/api/search`) |
| Targeted interaction checks green | ✅ 62/62 vitest checks pass (tab order, search Escape chain, dialog focus trap + focus restore, profile menu, demo fallback) |
| Failure-path checks green | ✅ Network failure / non-JSON body / null items / section-less Jellyfin payload / demo-item identity all covered and green |
| No internal Jellyfin database coupling | ✅ Only `src/lib/jellyfin.ts` HTTP API usage; tests stub `fetch` — no SQLite/Jellyfin-internal access anywhere in the suite |
| Existing suites remain green | ✅ `npm run lint` clean, `npm run typecheck` clean (74 pre-fix type errors resolved) |

## Accessibility gaps found and fixed (the suite guards them)

1. **Details dialog had no keyboard story** — no Escape, no focus trap,
   focus never entered or returned. Now: `aria-labelledby`/`aria-describedby`,
   focus moves to the dialog shell on open, Tab/Shift+Tab cycle inside,
   Escape closes, focus restores to the opener (even on backdrop click),
   close button named.
2. **Profile menu was hover-only** (`:hover` CSS) — unreachable by
   keyboard. Now state-driven (`data-open`), `aria-haspopup`/`aria-expanded`
   /`aria-controls`, `menu`/`menuitemradio` + `aria-checked`, Escape closes
   with focus return, selection returns focus to the pill.
3. **Invisible keyboard focus on media cards** — `.media-card:focus-visible`
   had `outline: none`, and the only ring was ≥1200px. Now a global
   `:focus-visible` ring (gold) plus the poster ring at ≥1200px; search
   input `outline: 0` removed.
4. **No reduced-motion handling** — card lift transition always ran. Now a
   `prefers-reduced-motion: reduce` block neutralizes transitions,
   animations, scroll behavior, the card lift, and the skip-link slide.
5. **Unnamed controls** — search toggle, close button, "See all" buttons,
   search input, progress indicators (now `progressbar` with value
   semantics), decorative glyphs `aria-hidden`; added skip link, named nav,
   `aria-current="page"`, polite live region for result counts.

## Verification evidence (2026-09-20, Node 22.19.0 / npm 10.9.3)

- `npx vitest run` — **62/62 pass** across 7 files.
- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm run build` — succeeds; static `/` + dynamic API routes unchanged.
- **Real-browser verification (Chromium via in-app browser, dev server on
  :3714):**
  - Tab order: skip link → Home → Movies → Shows → Home Videos → search
    toggle → profile pill; hidden profile-menu items correctly skipped.
  - Visible gold focus ring confirmed on the focused search input
    (screenshot evidence).
  - Search: open → autofocus in input → type "the" → "16 matches" live
    region + 16 rendered cards; Escape clears (focus stays), Escape closes
    and returns focus to the toggle.
  - Dialog: opens with focus on the shell, `aria-modal`/labelledby/
    describedby wired; Tab → Close, Shift+Tab → Watchlist (wrap), Tab →
    Close (wrap) — trap never escapes; Escape closes and restores focus to
    the exact opener card; "Demo item" play control disabled (fail-closed).
  - Profile menu: opens with `aria-expanded="true"` and visible menu,
    click switches to Nicole (pill text updates, menu closes, focus back
    on pill); Escape closes with focus on the pill.
  - Served stylesheet contains `:focus-visible`, `.skip-link`, and media
    rules `(max-width: 850px)`, `(min-width: 1200px)`,
    `(prefers-reduced-motion: reduce)`.

## Known limits (documented in docs/ACCESSIBILITY.md)

1. jsdom has no layout engine: rendered contrast/geometry can't be
   measured there — covered by the stylesheet-derived WCAG audit
   (`contrast.test.ts`, includes alpha compositing) and explicit
   responsive stylesheet contracts. axe `color-contrast` remains
   "incomplete" under jsdom by nature.
2. The IAB automation surface does not synthesize Enter-to-click default
   actions, so button activation via Enter was verified in the vitest
   keyboard suite (jsdom synthesizes it), not in the live walkthrough.
3. OS-level reduced-motion rendering and screen-reader announcements need
   the manual checklist in `docs/ACCESSIBILITY.md` (the stylesheet
   contract and rule-presence in the served CSS are verified).

## Notes for the controller

1. **New dev dependencies** (devDependencies only): vitest, jsdom,
   @testing-library/{react,dom,user-event,jest-dom}, jest-axe,
   @types/jest-axe. Adds `"test"`/`"test:watch"` scripts; merge order with
   RH-0002/RH-0003 (which add `pg`/`node --test` patterns) will need a
   small package.json/package-lock/tsconfig conflict resolution.
2. **Vitest matcher typing:** `vitest` re-exports `Assertion` from
   `@vitest/expect`, so matcher module augmentation must target
   `@vitest/expect` (augmenting `"vitest"` is a silent no-op) — see
   `tests/axe-matchers.d.ts`. This also affects jest-dom's own `/vitest`
   entry under vitest 3.2.7; the shim covers both.
3. **next@16.0.1 deprecation warning** during install flags the known CVE
   (RH-0008's scope) — untouched here.
4. Demo data cycles 10 titles across 22 items, so card titles repeat
   across sections; tests disambiguate deliberately (worth knowing for
   future UI tests).
5. Frontend jobs in REVIEW (RH-0009–0013, RH-0019) will conflict with
   these `ReelHouseApp.tsx`/`globals.css` a11y changes by design — the
   regression suite is the contract they should integrate against.

## Handoff

Upon acceptance: merge this branch to `main` (controller action). After
integration, remaining genuinely unclaimed READY jobs: **RH-0021 only**
(RH-0020's branch appeared during this run) — the queue reserve is below
the six-job target; new jobs or accepts from the fifteen-job REVIEW queue
will restore it. Review queue after integration: RH-0014.

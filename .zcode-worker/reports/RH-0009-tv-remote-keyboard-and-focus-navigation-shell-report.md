# RH-0009 Worker Report — TV Remote Keyboard and Focus-Navigation Shell

- **Date:** 2026-09-18 (claimed 18:31 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0009-tv-remote-keyboard-and-focus-navigation-shell`
- **Base:** `origin/main` @ `f2cde50`

## Claim

Queue read from `origin/main` per dispatch bootstrap (the main worktree's
local queue copy is stale and was not used). Priority 1 RH-0008 was
leased — remote branch `origin/rh-0008-…` plus local worktree
`reelhouse-rh-0008`; RH-0002 likewise leased by the main worktree's
checked-out branch. Highest-priority READY job with `AUTOMATION_ELIGIBLE:
true` and **no** existing lease was RH-0009. Claim uncontested; fresh
worktree `reelhouse-rh-0009` created from `origin/main`.

## What was built

A dependency-free TV remote shell across every existing surface: topbar
nav, search, hero, media rails, cards, and the details modal.

| Path | Role |
|---|---|
| `src/lib/spatial.ts` | Pure geometry engine: candidates must lie strictly ahead on the movement axis (8 px edge tolerance); winner = smallest primary-axis gap + 2× cross-axis misalignment penalty; ties break to earliest DOM order. Edges hold focus. No DOM access — fully unit-testable. |
| `src/lib/tvnav.ts` | DOM layer: focusable discovery (enabled buttons/links/inputs, visible, non-`tabindex="-1"`), `data-focus-scope` resolution, Tab trapping with wrap, Back-key classification, reduced-motion-aware scroll-into-view, zero-area phantom filtering, deterministic re-entry at first focusable when focus is lost. |
| `src/hooks/useTvNavigation.ts` | One document-level `keydown` listener: arrows → spatial move (never page scroll; caret keys preserved inside text fields), Tab → trap/wrap, Back-family → app state machine. Sets `data-kbd-nav` on `<html>` while keyboard/remote navigation is active; cleared on pointer use. |
| `src/components/ReelHouseApp.tsx` | Back state machine (modal → search → profile menu; no-op on home so a stray remote key never exits the app); deterministic mount focus on Home; modal `data-focus-scope` + `aria-label` + focus restore to the exact invoking element; `data-autofocus` on the enabled primary modal action; search/profile close restore their toggle buttons; `aria-expanded`/`aria-controls`/`aria-haspopup`; cards scroll into view on focus. |
| `src/app/globals.css` | Visible focus: 3 px gold ring on focused controls in `data-kbd-nav` mode; cards ring the poster so the ring tracks the lift/scale transform; `:focus-visible` poster ring now at all widths (was ≥1200 px only); profile menu `.open` state for keyboard access; `prefers-reduced-motion` disables the card transform and smooth scroll. |
| `docs/TV_NAVIGATION.md` | Key map (incl. webOS 461 / Tizen GoBack / Fire TV 10009), deterministic rules, focus-restore matrix, degraded paths, testing guide. |
| `README.md` | TV strategy section updated: focus shell now included. |
| `vitest.config.ts`, `vitest.setup.ts`, `package.json` | Vitest 5 + jsdom + Testing Library toolchain, `@` alias, `npm test` script, layout stub via `data-rect` attributes. |

Key properties:

- **Deterministic everywhere:** entry focus (Home), spatial scoring with
  explicit tie-breaks, edge holds, re-entry after lost focus, first
  focusable on unlaid-out content.
- **No dead ends:** Back pops exactly one layer; focus returns to the
  exact element that opened the layer (invoking card, search toggle,
  profile pill).
- **Modal is a proper focus trap:** arrows and Tab stay inside the
  scope, Tab wraps, Escape/Back restores the invoker.
- **No internal Jellyfin DB coupling:** all surfaces are UI-level; the
  only data paths remain `/api/library` and `/api/search` (Jellyfin API
  or demo fallback).
- **Demo-safe behavior preserved:** disabled "Demo item" play button is
  skipped by focus discovery; Watchlist becomes the modal's primary
  focus target for demo items — an explicit degraded path.

## Verification

- `npm run lint` — clean (0 errors, 0 warnings).
- `npm run typecheck` — clean.
- `npm test` — **30/30 green**: spatial scoring (8), DOM helpers (9),
  end-to-end interaction (8), route tests incl. unreachable-engine demo
  fallback (5).
- `npm run build` — clean production build (routes: `/`, `/api/library`,
  `/api/search`).
- **Browser verification** (dev server, 1280×720, demo library):
  - Arrow walk verified in the real DOM: Home ↓ hero action → nav →
    aligned rail card; ↔ along rails; ↑ back to hero — all
    deterministic and spatially sensible at real layout sizes.
  - Card activation opens the details modal; focus lands on the enabled
    primary action; Tab wraps inside the modal; Escape closes and
    restores focus to the exact invoker.
  - Search opens with the field focused; Back closes it and restores the
    search toggle; results grid receives focus from the field.
  - Focus ring visually confirmed (gold 3 px poster ring screenshot);
    `data-kbd-nav` flag toggles with keyboard/pointer use.
  - Environment note: the embedded verification browser does not give
    the guest page OS-level focus (`document.hasFocus() === false`), so
    CSS `:focus` cannot match there and trusted key injection (CUA/
    Playwright) never reaches the page. Interaction was therefore driven
    through page-dispatched `KeyboardEvent`s hitting the production
    listener, and the ring was verified via the shipped stylesheet rule
    plus an equivalent-declaration render. `:focus` matching on real
    browsers/TVs is standard behavior; the interaction suites cover the
    full paths in jsdom.
  - Initial-mount focus is asserted by the interaction suite; the
    embedded pane's tab activation resets `activeElement`, so it was not
    asserted in-browser.

## Commits on the branch

1. `Add TV remote spatial focus navigation shell` — spatial engine, DOM
   helpers, hook, app wiring, focus CSS, docs/TV_NAVIGATION.md, README.
2. `Add route and TV navigation interaction tests` — vitest toolchain,
   spatial/DOM/component/route suites, `npm test`.
3. *(this commit)* — Job spec → REVIEW, queue updated, this report.

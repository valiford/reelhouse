# ReelHouse TV navigation shell

How the household UI is driven from a TV remote, a keyboard, or any
directional input device. The shell lives in three modules:

| Path | Role |
|---|---|
| `src/lib/spatial.ts` | Pure geometry: picks the best candidate in a direction from bounding boxes. No DOM. |
| `src/lib/tvnav.ts` | DOM layer: focusable discovery, focus scopes, Tab trapping, Back-key classification, scroll-into-view. |
| `src/hooks/useTvNavigation.ts` | React wiring: one document `keydown` listener, keyboard-mode flag, Back state machine callback. |

## Key map

| Key | Behavior |
|---|---|
| Arrow Up / Down / Left / Right | Spatial focus move. Inside a text field, Left/Right stay caret keys; Up/Down exit into the content below/above. Arrows never scroll the page. |
| Enter / OK | Native activation of the focused button/link. |
| Escape, `GoBack`, `BrowserBack`, keyCode 461 (webOS), 10009 (Fire TV/Tizen) | Back: closes the topmost layer — details modal, then search panel, then profile menu. On home it is a no-op, so a stray remote key never leaves the app. |
| Backspace | Treated as Back only outside text fields. |
| Tab / Shift+Tab | DOM focus order; wrapped within the details modal scope. |

## Deterministic rules

- **Entry:** on mount, focus lands on the Home nav button when nothing
  else holds focus.
- **Spatial scoring:** candidates must lie strictly ahead on the movement
  axis (8 px edge tolerance); the winner is the nearest by primary-axis
  gap with a 2× penalty per pixel of cross-axis misalignment when the
  windows don't overlap. Ties resolve to earliest DOM order.
- **Edges hold:** with no candidate in a direction, focus stays put.
- **Lost focus re-enters:** if focus falls to `<body>` (a card unmounted
  under the cursor of navigation), the next arrow focuses the first
  focusable in scope.
- **Zero-area elements are never targets** — they are phantom or
  collapsed and would break determinism.
- **Modal scope:** the details modal carries `data-focus-scope`; arrows
  and Tab only travel among its focusables, Tab wraps, and closing the
  modal restores focus to the element that opened it.
- **Search panel:** opening moves focus to the field; Back closes it,
  clears the query, and restores focus to the search toggle.
- **Profile menu:** the pill toggles it (`aria-expanded`); Back closes it
  and restores the pill; outside pointer presses close it.

## Visible focus

Keyboard/remote use sets `data-kbd-nav` on `<html>`; pointer use clears
it. Focus rings (3 px gold outline; cards ring the poster instead so the
ring tracks the lift/scale transform) render only in this mode, keeping
mouse clicks visually quiet. `:focus-visible` remains the fallback for
non-shell contexts. `prefers-reduced-motion` disables the card transform
and smooth scroll-into-view.

## Failure and degraded paths

- **Focus lost / unlaid-out content:** deterministic re-entry at the
  first focusable in scope; zero-area boxes are skipped.
- **Demo items in the modal:** the disabled "Demo item" play button is
  skipped by focus discovery; the primary action is the Watchlist button.
- **Remote Back on home:** no-op by design — the app is the leaf of the
  remote's back stack.

## Testing

`npm test` runs the targeted suites:

- `src/lib/spatial.test.ts` — scoring, alignment preference, edge holds,
  tolerance, tie-breaking.
- `src/lib/tvnav.test.ts` — Back-key classification, text-input
  detection, focusable filtering, scope resolution, Tab wrap, spatial
  moves over stamped rects.
- `src/components/ReelHouseApp.tvnav.test.tsx` — end-to-end interaction:
  mount entry focus, arrow walks, modal trap/restore, remote Back keys,
  search-field-to-results navigation, profile menu Back.
- `src/app/api/**/route.test.ts` — library/search routes incl. the
  unreachable-engine demo fallback.

jsdom has no layout; interaction tests stamp deterministic rects via a
`data-rect="left,top,width,height"` attribute that the vitest setup
feeds to `getBoundingClientRect`.

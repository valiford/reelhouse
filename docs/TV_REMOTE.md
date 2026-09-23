# ReelHouse TV remote & living-room interaction (RH-0035)

How the ReelHouse UI behaves under a TV remote or keyboard. The contract has
two halves: a **pure spatial-navigation engine** (`src/lib/tv/navigation.ts`)
that answers every arrow key deterministically from a registered focus map,
and **payload→view-model mappers** (`src/lib/tv/viewmodel.ts`) that turn the
RH-0034 read models into display-ready data. The React layer
(`src/components/ReelHouseApp.tsx`) only wires them together.

## Data sources (per mode)

| Mode | Home feed | Search | Item detail | Banners |
|---|---|---|---|---|
| **Database configured** | `/api/home` (profile-scoped rails) | `/api/catalog/search` (bounded, paginated) | `/api/catalog/items/:id` (facets) | `/api/catalog/status` + `/api/health` |
| **Demo mode** (database unconfigured per `/api/health`) | bundled demo library | `/api/search` (demo route) + client-side type filter | card data, rendered locally | none |

The UI never receives PostgreSQL credentials and never writes household
state. Playback is always a Jellyfin web deep link (`NEXT_PUBLIC_JELLYFIN_URL`);
ReelHouse never streams.

## Key map

| Key | Effect |
|---|---|
| `ArrowLeft` / `ArrowRight` | Move within the current visual row. **Stops at row edges — no wrap.** Horizontal rails scroll the focused card into view. |
| `ArrowUp` / `ArrowDown` | Move to the nearest row with targets, snapping to the slot closest to the current column (ties break to the left). |
| `Enter` | Native button/link activation (open details, activate filters, load more). |
| `Backspace` / `Escape` | Back: close the detail modal, else leave search (restoring focus to the search button), else nothing (browser navigation is suppressed). |
| `Tab` | Inside the modal only: trapped to cycle the modal's controls. Elsewhere, native tabbing (roving tabindex keeps one tab stop). |
| Typing while the search input is focused | Text editing wins; `ArrowDown` drops into the results, `Escape`/`Backspace` leave search. |

## Focus order

Focus targets are registered as `(band, slot)` coordinates that mirror the
visual rows exactly:

1. Band 0 — top bar: Home, Movies, Shows, then the search button.
2. Band 1 — hero actions (Play, More info) or the search input (+ filter chip) in search mode, or the retry button on the error state.
3. Home rails — per rail: a heading band ("See all") then a cards band, top to bottom in household order.
4. Search results — a band per visual grid row (3/4/5/6 columns per density tier; the CSS breakpoints and the engine use the same numbers), then "Load more".
5. Modal — Close, then Play/Retry; `Tab` cycles here.

Initial focus after load is the hero Play button (first rail card when no
hero, else Home). Opening the modal focuses Close; closing restores focus to
the card that opened it. Opening search focuses the input; leaving search
restores focus to the search button. Rails scroll their focused card into
view with `block/inline: nearest`.

## States

- **Skeletons** while the feed or detail loads (`aria-busy` on `<main>`).
- **Feed error / 503**: a recovery panel with a Retry button; a 404 profile
  renders a profile-specific state (profile comes from `?profile=<slug>`).
- **Empty household / empty rails**: explicit empty states, not blank screens.
- **Degradation chips**: unresolved home rows and stale-catalog status render
  as chips; an unreachable Jellyfin renders a banner (`role="status"`).
  Home rails whose library/collection/watchlist target is gone are dropped
  from the render set (the read model flags them `resolved: false`).
- **Search**: debounced 220 ms, page size 24 with an explicit Load-more,
  empty and error states, `aria-live` result counts.
- **Detail 404** ("no longer in your catalog") is rendered as a real state —
  catalog churn removes items between feed render and detail fetch.

## Accessibility

- Every focusable element shows the gold focus ring whenever focused, at
  every viewport (`--focus-ring` widens with the density tiers).
- Roving `tabindex`: exactly one tab stop; the status region
  (`role="status"`, `aria-live="polite"`) announces load/search/feed state.
- Cards expose `aria-label`s including watch progress; the modal is
  `role="dialog"` + `aria-modal` with a label and a focus trap.
- `prefers-reduced-motion: reduce` disables the shimmer and card motion;
  focus outlines (not motion) remain the position cue.
- Density tiers at ≥1600px and ≥2400px enlarge cards, gaps, headings,
  buttons, and the focus ring for 10-foot viewing.

## Notes

- The old hardcoded profile menu and the dead "+ Watchlist" / "Home Videos"
  nav controls were removed. Profile resolution is a URL concern
  (`/api/home?profile=<slug>`); the catalog normalizes Jellyfin `Video` to
  `movie`, so a type-axis "Home Videos" slice is not expressible —
  home-video content is reached through its library rails and the
  `libraries=` search filter (a rail's "See all" opens exactly that).
- Household **writes** (watchlist toggles, watch progress) are deliberately
  out of scope here; the read models consumed by this UI are read-only.

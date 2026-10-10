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
| **Database configured** | `/api/home` (profile-scoped rails), `/api/profiles` (household roster behind the switcher) | `/api/catalog/search` (bounded, paginated) | `/api/catalog/items/:id` (facets) | `/api/catalog/status` + `/api/health` |
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

## Profile session isolation (RH-0043)

The household profile is a **URL identity** (`?profile=<slug>`) that the UI
tracks live — Next's router syncs `useSearchParams` with history navigation
and native `history.pushState`/`replaceState`, so an in-session switch —
history navigation or the in-app profile switcher (RH-0046, below) — is
honored instead of silently serving the previous profile under the new URL. The slug is the contractual identity
(`docs/HOUSEHOLD.md`); display names are copy, never cache keys.

- **Identity-bound requests:** every profile-scoped call (home feed, catalog
  search pages, item detail) carries the exact session slug. Constructed at
  one choke point (`buildCatalogSearchUrl` / `profileQueryParam`), so no code
  path can issue an unscoped request while a profile is asserted.
- **Switch = bounded session cleanup:** an identity change invalidates the
  session generation, aborts the requests that outlive a render pass (detail
  modal, Load more), and drops every profile-scoped cached view — feed,
  search results and filters, detail modal, reveal set, focus. The UI
  restarts from the boot path for the new identity.
- **Generation-bound responses:** async work captures the generation token
  at start and is dropped when stale (`src/lib/session/profile-session.ts`).
  A late response computed for one profile can never overwrite or re-open
  another title's modal, and a stale profile's feed can never land after a
  switch. The boot and search effects additionally abort their own fetches
  per run.
- **Persisted preferences are slug-keyed:** the spoiler-shield preference
  lives under the resolved profile slug ("demo" in demo mode, the feed's
  slug for the unscoped default view). Entries written by earlier
  deliveries under a display name migrate onto the slug once the feed
  resolves the identity, and the legacy key is removed
  (`migrateProfileSpoilerShieldPreference`). An unparsable slug passes
  through untouched so the server's 404/400 stays the fail-closed authority
  — the client never falls back to another profile.

## Profile switcher (RH-0046)

The profile pill in the top bar is the switcher invoker: a real button
reachable by remote/keyboard focus and pointer (`aria-haspopup="dialog"`).
Activating it opens a `role="dialog"` roster of the household's ACTIVE
profiles (display name, avatar initials, the current session's entry marked
Active with `aria-current`).

- **Roster source:** `GET /api/profiles` — a dedicated, read-only census of
  active `household_profiles` rows (slug, display name, initials, default
  flag), bounded (`MAX_PROFILE_ROSTER`) and deterministically ordered
  (default first, then by slug), served through the delivered read-model
  discipline (shared pool executor, redacted 503 envelopes). Deliberately
  separate from `/api/home`: the switcher must open even when the current
  session's identity is unresolved (unknown/ghost slug), and the roster is
  household-scoped, not profile-scoped.
- **Switch mechanics:** activating a different entry navigates to its
  `/?profile=<slug>` URL via native `history.pushState` — the exact
  mechanism the RH-0043 contract verifies — and the delivered identity
  contract performs the session re-boot (generation invalidation, request
  aborts, cached-view drops). The switcher never hand-clears caches,
  generations, or reveal state.
- **No-op re-selection:** cancelling (Escape, Backspace, backdrop click) or
  activating the CURRENT session's entry only closes the dialog and
  restores focus to the invoker — no navigation, so no reboot and no cached
  state dropped.
- **Failure and edge behavior:** a roster fetch failure renders an honest
  retry state while the session underneath stays fully usable; an empty
  household renders an honest empty state (never fabricated profiles);
  entries without a server identity are never rendered switchable; opening
  the switcher on an unknown/ghost slug works and marks nothing active.
  Demo mode (database unconfigured) lists the delivered demo fixture
  identity, and activating it is a re-selection, never a navigation.
- **Focus:** the dialog is the whole world while open (the same trap
  discipline as the detail modal): the close control holds the initial
  focus, roster entries are one focus-engine band each so arrows walk the
  list, Enter activates the focused entry natively, Escape cancels back to
  the pill. Nothing in the dialog animates, so the reduced-motion contract
  holds by construction; at narrow widths the dialog caps to the viewport.

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

- The imported baseline's hardcoded profile menu was removed (RH-0035); the
  deliberate replacement is the RH-0046 switcher above, which drives the
  same URL identity — profile resolution remains a URL concern
  (`/?profile=<slug>`). The dead "+ Watchlist" / "Home Videos" nav controls
  are gone. The catalog normalizes Jellyfin `Video` to
  `movie`, so a type-axis "Home Videos" slice is not expressible —
  home-video content is reached through its library rails and the
  `libraries=` search filter (a rail's "See all" opens exactly that).
- Household **writes** (watchlist toggles, watch progress) are deliberately
  out of scope here; the read models consumed by this UI are read-only.

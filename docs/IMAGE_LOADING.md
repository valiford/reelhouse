# Image Loading Contract

How ReelHouse loads poster and backdrop art from the household Jellyfin
host: responsive sizing, loading policy, layout-shift protection, and
failure fallbacks. Introduced by RH-0013; art rendering itself (fade-in,
hydration race fix) came from RH-0011.

## Pipeline decision: Jellyfin resize API, not the Next image optimizer

Posters and backdrops load **directly from Jellyfin** using its supported
HTTP image API, which resizes and caches per request:

```
{JELLYFIN}/Items/{id}/Images/Primary?maxWidth={w}&quality=90&tag={tag}
```

The Next.js image optimizer was evaluated and rejected on purpose:

- It would proxy every art byte through the app server. On the target
  deployment (NAS-hosted Node standalone) that spends NAS CPU on a second
  resizer per unique request and adds a hop per image.
- Jellyfin already produces and caches the exact variants we need; asking
  it again at a different `maxWidth` is the same cache the playback
  clients use.
- Media authority stays where the rest of the app puts it: browsers fetch
  media from Jellyfin; the ReelHouse server serves contracts and state.
  (The wildcard `images.remotePatterns` in `next.config.ts` is therefore
  inert for art; touching it belongs to the security-hardening job, not
  this one.)

## Responsive sizing (srcSet/sizes)

`src/lib/poster-image.ts` rewrites only the `maxWidth` query parameter of
an existing Jellyfin image URL — byte-preserving for every other
parameter (a full URL round-trip would re-encode `%20` as `+` and
needlessly fragment upstream caches).

- Posters: candidates 240/360/480/720/960, covering the largest layout
  slot (380 CSS px in the ≥2200px breakpoints) at DPR 2. `sizes` mirrors
  the widest slot per breakpoint: `(min-width: 1800px) 400px,
  (min-width: 1400px) 320px, (min-width: 900px) 260px, 48vw`.
- Backdrops (hero): candidates 640/960/1280/1600/1920 with
  `sizes="100vw"`.
- Fixed-size art (the demo library's picsum URLs, or any URL outside
  Jellyfin's `/Items/{id}/Images/` shape) renders src-only with no
  `srcSet`/`sizes` — the browser scales it, exactly as before RH-0013.

## Loading policy

| Surface | loading | decoding | fetchPriority | Notes |
|---|---|---|---|---|
| Hero backdrop | eager (default) | async | high | The page's LCP element |
| Posters (rows + search grid) | lazy | async | default | Offscreen rows never fetch eagerly |
| Details-modal backdrop | — | — | — | Inline `background-image`, interaction-gated; loads only when the modal opens |

## Layout-shift protection

Structural, and independent of image arrival timing:

- `.poster` reserves its slot with `aspect-ratio: 2/3` + `overflow:
  hidden`; `.poster-img` is absolutely positioned with `object-fit:
  cover`, so load/swap/failure never reflows the grid.
- `.hero` reserves its area with `min-height: 68vh`; the hero backdrop
  `<img>` is absolutely positioned inside it. Converting the hero from a
  CSS `background-image` div to a real `<img>` (RH-0013) is what makes
  the priority hint and responsive candidates possible; the visual
  contract (`object-fit: cover; object-position: center 35%`, fade-in,
  shade gradients) is unchanged.

## Failure fallbacks

- A poster `<img>` whose load fails swaps to the title-initial
  `.poster-fallback` (RH-0011); the srcSet path follows the identical
  cycle because `responsiveImage()` only decorates the same `<img>`.
- `PosterImage` is keyed by image URL, so a payload swap that repoints an
  item's art remounts the component and re-arms load/error handling.
- Broader Jellyfin outage/reconnection UX is RH-0012's scope; per-image
  failure stays a local fallback by design.

## Test coverage

- `src/lib/poster-image.test.ts` — URL rewriting (byte-preserving,
  rejection rules), srcSet construction (ascending ladder, noise
  handling, src-only fallback).
- `src/components/ReelHouseApp.posters.test.tsx` — the performance
  guards as rendered contracts: every poster lazy and inside the
  aspect-ratio slot, srcSet/sizes present for Jellyfin art and absent
  for fixed-size art, hero eager + `fetchpriority=high` + `100vw`,
  title-initial fallback still reached on the srcSet path.

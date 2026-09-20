# ReelHouse Accessibility & Reduced-Motion Suite

What RH-0014 added, how to run it, and the guarantees it guards.

## Running

```bash
npm test          # vitest run — the full accessibility/regression suite
npm run test:watch
```

The suite lives in `tests/a11y/` (vitest + Testing Library + jsdom +
jest-axe) and runs with no credentials; components fetch against stubbed
`fetch`, never the real Jellyfin or PostgreSQL.

## Coverage map

| Area | File | What it guards |
|---|---|---|
| Semantics | `semantics.test.tsx` | landmarks, heading levels, `aria-current`, skip-link position, card accessible names (label-in-name), `progressbar` resume semantics, dialog `aria-modal`/labelledby/describedby, search landmark + toggle state, profile `menu`/`menuitemradio` state, polite live region for result counts |
| Keyboard | `keyboard.test.tsx` | tab order from page top, search open/type/Escape (clear → close) with focus return, dialog focus trap (Tab/Shift+Tab cycle), focus restoration to the opener, profile menu open/switch/Escape entirely from the keyboard |
| Failure paths | `failure-paths.test.tsx` | `/api/library` network failure and non-JSON body keep the demo library up, Jellyfin payload without sections renders without crashing, `/api/search` failure/null items report zero matches, demo items fail closed to a disabled play control |
| axe audits | `axe.test.tsx` | zero violations in library view, search-results view, and details dialog (demo and Jellyfin-linked item) |
| Contrast | `contrast.test.ts` | WCAG 2.x ratios computed from the real `globals.css`, including alpha compositing of translucent surfaces (topbar, chips, card scrim, buttons); 4.5:1 body text, 3:1 non-text UI. Audited color literals must still exist in the stylesheet, so palette changes fail here instead of shipping silently |
| Reduced motion | `motion.test.tsx` | `prefers-reduced-motion: reduce` block neutralizes transitions/animations and the card lift; no component may set inline transition/animation styles that would bypass the media query |
| Responsive | `responsive.test.ts` | 850px/1200px breakpoint contracts (nav collapse, rail card sizing, poster focus ring), fluid `clamp()` gutters/type, wrapping poster grid, bounded rail scrolling, global focus-visible ring, state-driven (not hover-only) profile menu |

## jsdom limits, and how they are covered

- jsdom has no layout engine, so rendered geometry/contrast cannot be
  measured there. Contrast is audited from the stylesheet itself
  (`contrast.test.ts`); responsive behavior is guarded as explicit
  stylesheet contracts (`responsive.test.ts`).
- `color-contrast` axe findings are incomplete under jsdom by nature;
  the stylesheet audit is the authoritative contrast gate.

## Manual checklist (real browser / TV)

The automated suite cannot fully replace:

1. **Keyboard walk** — Tab from the address bar: skip link → nav → search
   → profile; Enter activates; the details dialog traps Tab and Escape
   restores focus to the opener. (Verified in Chromium 2026-09-20.)
2. **Reduced motion** — enable OS "reduce motion" and reload: the card
   lift/hover transform and skip-link slide must be gone.
3. **Screen reader** — dialog name/description announcement, live-region
   result counts, profile menu checked state.
4. **Zoom/reflow** — 200% browser zoom and ~320px width: no horizontal
   page scroll, nav collapses, rails scroll internally.

## Component rules going forward

- Never remove `outline`/`outline: 0` without a replacement visible-focus
  treatment; the global `:focus-visible` ring is the contract.
- Any new motion (CSS or JS) must be neutralized under
  `prefers-reduced-motion: reduce`, and JS-driven motion must not use
  inline `transition`/`animation` styles (scanned by `motion.test.tsx`).
- New interactive surfaces need: accessible name, keyboard operability,
  dialog/menu semantics where applicable, and a failure path test if they
  fetch.
- Palette changes must update `contrast.test.ts` deliberately.

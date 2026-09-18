# Next.js security upgrade (RH-0008)

Completed 2026-09-18. This document records why and how the ReelHouse
Next.js baseline was upgraded, which advisories it closes, and how
regression is verified going forward.

## Baseline and exposure

| | Before | After |
|---|---|---|
| `next` | 16.0.1 (exact pin) | **16.3.5** (exact pin) |
| `eslint-config-next` | 16.0.1 | **16.3.5** |
| `react` / `react-dom` | 19.2.0 (unchanged) | 19.2.0 |
| `npm audit` | 1 critical + 2 high | **0 vulnerabilities** |

`next@16.0.1` was affected by:

- **CVE-2025-66478 / GHSA-9qr9-h5gf-34mp** ("React2Shell", CVSS 10.0) —
  unauthenticated RCE via the React Server Components protocol
  (upstream React CVE-2025-55182). Fixed for the 16.0.x line starting
  at 16.0.7; `16.3.5` includes the hardened RSC implementation.
- **GHSA-p293-qw3h-jr36** — unauthenticated RCE on Windows-hosted
  servers.
- **GHSA-2xp9-vwfh-vxw4** — unauthenticated RCE in the Image
  Optimization API when AVIF files are used.
- Transitive `postcss` (sourceMappingURL path-traversal/XSS family,
  GHSA-qx2v-qp2m-jg93 / GHSA-6g55-p6wh-862q / GHSA-fxqj-rqcc-2cmp /
  GHSA-r28c-9q8g-f849) and `sharp` (inherited libvips/libheif CVEs,
  GHSA-f88m-g3jw-g9cj / GHSA-rgj7-g3m4-5g8c) advisories, all resolved
  by the `next@16.3.5` dependency refresh.

`16.3.5` is the current `latest` stable release line (published
2026-09-11) and the version `npm audit fix` resolves to; canary
(`16.4.0-canary.*`) and preview tags are deliberately not used.

## Upgrade notes

- The 16.0.1 → 16.3.5 jump spans Next.js minors 16.1–16.3. No codemods
  or config changes were required: `next.config.ts`, the App Router
  tree, `output: "standalone"`, and the route handler contracts behave
  identically, and the build produces the same route manifest
  (`○ /`, `ƒ /api/library`, `ƒ /api/search`).
- Exact version pins are kept (repo convention) so production builds
  are reproducible and audit findings map to one reviewed version.

## Regression evidence (2026-09-18, Node 22.19.0)

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm run build` — succeeds; route manifest identical to baseline.
- `npm test` — 9/9 green (`tests/regression.test.mjs`, node:test):
  - **Demo mode** (no credentials): `/` renders the app shell with the
    server-rendered demo hero; `/api/library` returns
    `source: "demo"` with all four sections; `/api/search` finds demo
    items; blank/unmatched queries return `{"items":[]}`.
  - **Degraded mode** (configured Jellyfin unreachable):
    `/api/library` still serves the demo library (explicit fallback),
    `/api/search` degrades to empty results.
  - **Healthy upstream** (fake Jellyfin API): `/api/library` returns
    `source: "jellyfin"` with mapped fields, Continue Watching
    progression, and image URLs built from the configured public URL;
    `/api/search` proxies `SearchTerm` upstream and maps results; the
    API key is sent only server-side and never appears in responses.
- Live browser pass (production build, demo mode): home page
  hydrates, the search toggle opens the search panel with autofocus,
  and a typed query renders the debounced results view.

## Operator actions outside this repository

1. The running Synology deployment must be **rebuilt and restarted**
   (`docker compose up -d --build`) to pick up the patched image —
   worker protocol forbids touching production, so this is the
   controller's action after acceptance.
2. Per the CVE-2025-66478 advisory: if the deployed instance was
   unpatched and reachable as of 2025-12-04 13:00 PT, **rotate the
   `JELLYFIN_API_KEY`** (and any other secrets it held) after the
   patched rebuild. Credential rotation is explicitly out of worker
   scope.

## Going forward

Any future `next` bump must: pin an exact patched version from the
`latest` line, run `npm audit` (must stay at 0), and keep
`npm run lint && npm run typecheck && npm run build && npm test`
green — the regression suite is the behavioral contract for the two
API routes and the demo fallback.

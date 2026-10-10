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

---

## Integrated onto current main (RH-0045, 2026-10-09)

The RH-0008 delivery sat frozen on its own branch from 2026-09-18 until the
owner ordered its integration (October 9 wave, RH-0045). This section records
the integrated state; everything above is the original RH-0008 record,
preserved.

### Pin progression at integration

| | main before (base `4655455`) | frozen RH-0008 pins | integrated (final) |
|---|---|---|---|
| `next` | 16.0.1 | 16.3.5 | **16.4.0** |
| `eslint-config-next` | 16.0.1 | 16.3.5 | **16.4.0** |
| `npm audit` | 9 (8 high, 1 critical) | 6 (5 high, 1 critical) | recorded in `.zcode-worker/reports/RH-0045.md` |

**Why the final pin departs from the frozen 16.3.5:** the advisory database
moved after RH-0008 was delivered. At 16.3.5 the audit still reports
6 vulnerabilities (5 high, 1 critical) — Next-core advisories published after
2026-09-18 (development-server MCP information disclosure, App Router metadata
image-route `dynamicParams` bypass, SSG/ISR cache poisoning, Image Optimization
SSRF, and the transitive sharp/source-map-js set). npm's own resolution for
every remaining finding is `next@16.4.0` — the same major line — so the
integration takes 16.4.0 as the minimal pin that fulfills this job's
objective ("audit findings resolved or explicitly dispositioned"). The frozen
16.3.5 state was installed, audited and recorded before departing.

### Regression suite disposition

`tests/regression.test.mjs` is carried from frozen `4440f99` and runs via the
new `npm run test:regression` script (it needs a production build first, so it
deliberately stays OUT of the hermetic `npm test` union — the hermetic suite
must not require a build). One assertion was adapted, documented in the suite
header: since RH-0043, `/` statically prerenders only the Suspense fallback
skeleton, so the static-HTML shell check asserts the `skeleton-hero` marker
instead of the September server-rendered hero/topbar markup. The demo payload
contract that assertion covered remains asserted via `GET /api/library`. Every
other assertion is verbatim from RH-0008.

### Residual advisory disposition (final head)

`npm audit` at the final head reports **5 high / 0 critical**, and all five
findings share one root cause: `braces` GHSA-vfj7-8cjw-p6xm
(stack-exhaustion DoS via deeply nested glob patterns), via the dev-only
chain `eslint-config-next → @next/eslint-plugin-next → fast-glob →
micromatch → braces`. The installed `braces@3.0.3` is the newest release
that exists; the advisory's vulnerable range is `*` (no patched version is
published), so no pin or override can clear it — npm's only suggested
"fix" is downgrading `eslint-config-next` to 14, which would undo the
upgrade this job exists to deliver. Disposition: **accepted residual
risk** — the affected code is lint-toolchain-only (glob expansion during
`npm run lint`), is never exercised by the served application, and has no
attacker-reachable input in this product. Runtime dependencies (`next`,
`pg`, `react`, `react-dom`, `server-only`) audit clean.

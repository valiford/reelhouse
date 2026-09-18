# RH-0008 Worker Report — Next.js Security Upgrade and Regression Verification

- **Date:** 2026-09-18 (claimed 17:25 America/New_York, inside the 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0008-next-js-security-upgrade-and-regression-verification`
- **Base:** `origin/main` @ `f2cde50` ("Refill ReelHouse READY reserve with fresh jobs")

## Trigger

Authoritative `origin/main` queue listed RH-0008 as the highest-priority
READY job with `AUTOMATION_ELIGIBLE: true` and no dependencies. No
`rh-0008-*` branch or worktree existed (lease uncontested). Claimed via
linked worktree `E:/Users/valif-c/OneDrive/Documents/GitHub/reelhouse-rh-0008`.

## What was done

1. **Vulnerability baseline.** `npm audit` on the imported baseline
   (`next@16.0.1`): **1 critical + 2 high** — RSC-protocol RCE
   (CVE-2025-66478 / "React2Shell", CVSS 10.0, fixed from 16.0.7),
   Windows-host RCE (GHSA-p293-qw3h-jr36), Image-Optimization AVIF RCE
   (GHSA-2xp9-vwfh-vxw4), plus transitive `postcss` and `sharp`
   advisories. This is the dedicated upgrade job recommended by the
   RH-0001 report.
2. **Upgrade.** `next` and `eslint-config-next` bumped to exact pins of
   **16.3.5** — the current `latest` stable (2026-09-11) and the version
   `npm audit` itself resolves to; react/react-dom 19.2.0 unchanged
   (peer-compatible). `npm audit` is now **0 vulnerabilities**. No
   config or codemod changes were needed across minors 16.1–16.3.
3. **Regression suite** (`tests/regression.test.mjs`, Node built-in
   `node:test`, zero new dependencies; `npm test`). Starts real
   production servers (`next start`) on free ports in three scenarios:
   - *Demo mode*: app shell SSR (title, topbar, demo hero), demo
     library payload shape, demo search hit, blank/unmatched search →
     `{"items":[]}`.
   - *Degraded mode* (configured Jellyfin on a closed loopback port):
     library falls back to demo (explicit failure path), search
     degrades to empty.
   - *Healthy upstream* (in-test fake Jellyfin API): mapped payload
     (`source:"jellyfin"`, hero fields, Continue Watching progress,
     image URLs from the public URL), `SearchTerm` proxying, and the
     API key present on the upstream request header but absent from
     every client response.
4. **Browser pass** (production build, demo mode): home hydrates the
   full interactive tree; search toggle opens the panel with autofocus;
   typed query renders the debounced results ("Search results · 2
   matches" with both demo Santorini cards).
5. **Docs & queue.** `docs/SECURITY_UPGRADE.md` (advisories, evidence,
   patched-release policy), README verification section (adds
   `npm test`), job spec → REVIEW, queue moved RH-0008 Ready → Review,
   this report.

## Verification evidence (2026-09-18, Node 22.19.0 / npm 10.9.3)

| Check | Result |
|---|---|
| `npm audit` | **0 vulnerabilities** (was 1 critical + 2 high) |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | succeeds; route manifest identical to baseline (`○ /`, `ƒ /api/library`, `ƒ /api/search`) |
| `npm test` | **9/9 green** across 3 scenario suites |
| Browser (live DOM) | hydration, search toggle, debounced results all working on 16.3.5 |

Browser-tooling caveat, for honesty: the in-app browser's
pixel/screenshot and trusted-input surfaces were degraded in this
session (attach timeouts; locator clicks and screenshots timed out).
Visual evidence above was therefore gathered from the live DOM tree of
the real page, and the typed-search interaction was driven by an
in-page scripted click/input dispatch rather than an OS-level trusted
input event. No screenshots could be captured. App behavior itself was
healthy in every observable channel.

## Constraints honored

- Jellyfin remains the playback/library authority; no Jellyfin-internal
  DB coupling (the suite talks to the HTTP API surface only).
- No PostgreSQL exposure or credentials anywhere; nothing DB-related
  was added on top of `origin/main` (RH-0002's unmerged branch was not
  used as a base).
- Demo-safe behavior preserved and now regression-locked.
- No deploy/restart/credential change; nothing executed against the
  Synology.

## Findings the controller should see

1. **Operator action required on acceptance:** rebuild/restart the
   Synology container to run the patched image. Per the CVE-2025-66478
   advisory, if the deployment was unpatched and reachable since
   2025-12-04 13:00 PT, **rotate `JELLYFIN_API_KEY`** after the
   patched rebuild (credential rotation is out of worker scope).
2. **Queue observation:** `origin/main` currently lists **RH-0002 as
   READY** while its branch `origin/rh-0002-postgres18-reelhouse-connectivity`
   still exists (reviewed output from the prior dispatch, left in
   REVIEW state on that branch). Branch-exists = lease, so no one
   re-claimed it; flagging in case the READY row is unintentional.
3. eslint 9.39.1 remains EOL upstream (pre-existing, non-blocking).
4. `next@16.0.1`'s deprecation warning disappears with 16.3.5; the
   `npm audit fix --force` recommendation is now unnecessary — the
   pinned upgrade is the fix.

## Handoff

Upon acceptance: merge this branch to `main` (controller action;
fast-forward expected against `f2cde50`), rebuild the Synology
container, and consider the RH-0002 READY/lease question above. The
regression suite is the behavioral contract for `/`, `/api/library`,
and `/api/search` that RH-0009–RH-0014 should extend rather than
bypass.

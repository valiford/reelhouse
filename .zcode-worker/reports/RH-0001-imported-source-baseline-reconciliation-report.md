# RH-0001 Worker Report — Imported Source Baseline Reconciliation

- **Date:** 2026-09-18 (claimed 14:40 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0001-imported-source-baseline-reconciliation`
- **Base:** `origin/main` @ `b7e7352`

## Trigger

At dispatch time the working tree contained the previously missing
Synology application source (file copy, dates 2025-09-12 preserved) —
RH-0001's stop condition ("source not present") had cleared. No other
branch or worktree existed, so the claim was uncontested.

## Commits on the branch

1. `1da13e4` — Exclude Jellyfin engine runtime state from Git
   (`.gitignore`: `jellyfin-config/` 612 MB — Jellyfin internal SQLite
   DB/metadata/logs; `jellyfin-cache/` 5 MB — transcode/image caches).
2. `0a06f03` — Import existing Synology ReelHouse application source
   (20 files: Next.js 16 App Router UI, `src/lib/jellyfin.ts`
   server-side integration with demo fallback, `GET /api/library` +
   `GET /api/search`, Synology docker-compose, Dockerfile, `.env.example`,
   product README + `docs/PRODUCT_PLAN.md`, `public/.gitkeep` so the
   Dockerfile's `COPY /app/public` works from a fresh clone).
3. *(this commit)* — Baseline verification + reconciliation docs:
   `npm run typecheck` script, generated-file ignores
   (`next-env.d.ts`, `tsconfig.tsbuildinfo`), `package-lock.json`
   (generated at verification, pins the baseline), `docs/BASELINE.md`
   (inventory, deployment mapping, data authorities, PG-18 migration
   surface), README "Development & verification" section, job spec →
   REVIEW, queue updated, this report.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Source present; build/test/runtime verification documented | ✅ `docs/BASELINE.md` + README; all commands pass |
| No secrets, media, databases, caches, or generated runtime state committed | ✅ No `.env` exists; 617 MB Jellyfin runtime state and build outputs ignored; staged tree audited |
| Data authorities and Jellyfin boundaries explicit | ✅ Authority table in `docs/BASELINE.md`; Jellyfin SQLite off-limits, watch state read-only |
| RH-0002–RH-0007 can be safely activated after acceptance | ✅ Exact PG-18 migration surface recorded in `docs/BASELINE.md` |
| No deploy/restart/release | ✅ Nothing executed against the Synology; local build/smoke only |

## Verification evidence (2026-09-18, Node 22.19.0 / npm 10.9.3)

- `npm run lint` — clean.
- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds; routes: `○ /`, `ƒ /api/library`, `ƒ /api/search`.
- Production server smoke: `GET /` → 200 with app shell;
  `GET /api/library` → `{"source":"demo",...}`; `GET /api/search?q=santorini`
  → demo match. Demo mode is the deterministic no-credential path.

## Findings the controller should see

1. **next@16.0.1 is flagged vulnerable (CVE-2025-66478).** Upgrade is a
   behavior-affecting change and was deliberately NOT done here;
   recommend a dedicated job before RH-0002 broadens the server surface.
2. eslint 9.39.1 is EOL upstream (non-blocking).
3. No test framework exists; verification is lint/typecheck/build/smoke.
4. API routes are unauthenticated and search swallows errors — bounded
   by RH-0006.
5. The import arrived as a plain file copy into the Windows checkout,
   not via `docs/IMPORT_EXISTING_SOURCE.md`'s push-to-main procedure;
   this branch is therefore the import vehicle and needs an explicit
   merge decision (fast-forward expected; no conflicts with control-plane
   files).

## Handoff

Upon acceptance: merge this branch to `main` (controller action), then
the source-import gate on RH-0002–RH-0007 clears and six READY jobs
exist. `docs/BASELINE.md` §"PostgreSQL 18 migration surface" is the
input contract for RH-0002/RH-0003/RH-0004.

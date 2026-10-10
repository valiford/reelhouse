# Owner acceptance, cleanup, image, and October 10-B wave — evidence

Executed in-session 2026-10-10 ~02:45–04:15 EDT (America/New_York) per owner orders: accept RH-0046 (squash + merge), complete the local cleanup, upgrade the deployment image, order the next wave.

## 1. RH-0046 acceptance — squash-merged at `fc3818f`

| Item | Value |
|---|---|
| Review head accepted | `ae93304` — branch `rh-0046-in-app-household-profile-switcher` (base `4655455`; delivery evidence per `RH-0046.md`: 228 hermetic / 76 integration / build 10 routes / 16 real-browser checks / 5-visual-judge screens) |
| Prior main | `b37527e` (unchanged — remote re-verified immediately before merging) |
| Acceptance commit on main | `fc3818f` — `git merge --squash ae93304` + commit (owner-specified method) |
| Union with the RH-0045 squash | `package.json` was the only overlapping file; git auto-merged (the branches changed different lines) and the result was verified in both directions: staged delta vs prior main = exactly RH-0046's 20 files; delta vs the RH-0045 acceptance tree = exactly the union (23 files: RH-0046's 20 + the 0045-only pins/lockfile/regression-suite/security-doc files). Merged `package.json` carries 16.4.0 exact pins + `test:regression` + the 18-file hermetic union incl. `profile-roster.test.ts`. |
| Post-squash verification on merged main (primary worktree, deps converged to 16.4.0) | typecheck clean; **hermetic 228/228** (18-file union); production build green with **10 routes** incl. `/api/profiles` (npm install took ~1h under I/O contention with the parallel worktree sweep — result unaffected) |
| Ancestry note | Squash method (owner's choice, as with RH-0045): the branch's commits are intentionally not main ancestors; `origin/rh-0046` (tip `ae93304`) retained as squash evidence |

## 2. Local cleanup — executed per owner order

| Step | Result |
|---|---|
| Archive bundle (safety) | `reelhouse-branch-archive-2026-10-10.bundle` (1.09 MB) containing all 32 reconciled branch tips — `git bundle verify`: **okay** |
| Remote branch pruning | All 32 reconciled tips deleted (21 CLOSED-superseded + 11 COMPLETE-by-incorporation). Remote-verified post-deletion: exactly 8 refs remain — `main`, `rh-0001` (PR evidence), `rh-0041`/`rh-0042`/`rh-0043`/`rh-0044` (carrier lineage, ancestors of main), `rh-0045`/`rh-0046` (squash-evidence heads) |
| Worktree retirement | All job worktrees ordered removed (`git worktree remove --force` — the flag is required because each holds untracked `node_modules`; rh-0025's moot uncommitted WIP is included in this authorization). **The sweep was still running at control-commit time** — OneDrive makes the bulk deletions I/O-bound (minutes per worktree); it completes on its own with no further authorization. Progress at commit time: 3 of 38 removed; running count observable via `git worktree list`. |
| Local branches | All local branches except `main` deleted by the same script after the worktree removals |
| Containers | Stray disposable dev-db container from the Oct-9 dispatch (`reelhouse-postgres-dev`, loopback 5433) removed; the pre-existing Jellyfin stub on 8097 and any production-shaped containers are untouched |
| Not deleted | Nothing else. The bundle plus GitHub's retained unreachable objects preserve the pruned history; `rh-0045`/`rh-0046` remote heads preserve the squash-merged deliveries' original commits |

## 3. Deployment image — `reelhouse:latest` built and validated from merged main

| Item | Value |
|---|---|
| Build | `docker build -t reelhouse:latest .` from the primary worktree at merged main (post-RH-0046 squash) — **exit 0**; image `reelhouse:latest`, **301 MB**, `node:22-alpine` 3-stage standalone build |
| Contents | Next.js **16.4.0** toolchain (RH-0045), all accepted product surfaces incl. the profile switcher (RH-0046), 10 routes |
| Boundary | **Production activation remains an operator action.** No Synology/production credentials exist in the worker environment (fail-closed; precedent RH-0015/0024). The operator steps are: get `reelhouse:latest` onto the NAS (`docker save`/`load` or a registry push), then on the Synology `docker compose up -d --build reelhouse` (compose service `reelhouse-ui`, host port 3210 → container 3000), followed by the `docs/SECURITY_UPGRADE.md` operator actions — rotate `JELLYFIN_API_KEY` if the pre-upgrade deployment was exposed unpatched. Migrations stay out-of-band (`npm run db:migrate` under the owner role) per `docs/DATABASE.md`. |

## 4. October 10-B wave — ordered

| Priority | Job | Grounding |
|---|---|---|
| 1 | **RH-0047** — Household write API: profiles, preferences, idempotency kernel (READY) | The residual explicitly reserved by the RH-0005/0006 resolutions: migration 0006's household model is accepted on main but has no write path beyond the offline import; the write API + persisted `Idempotency-Key` stored-response replay kernel is the missing foundation. |
| 2 | **RH-0048** — Favorites/watchlists/collections/home-rows write API + first TV UI slice (READY, gated on RH-0047 acceptance) | The schema's list layer (0006) likewise has no API/surface; builds directly on RH-0047's kernel and the RH-0046 dialog/focus patterns. |

Both specs carry the standard contract (isolated worktree, REVIEW-not-COMPLETE, verification ladder, safety exclusions). Worker prompt: `prompts/worker-2026-10-10-b.md`. Claims honor 11:00–21:00 America/New_York.

## Not done (remains open)

- Production deployment/activation of `reelhouse:latest` — operator action (above).
- Worktree sweep completion — running; final count lands in the worker log with no further action.
- OneDrive relocation of the repository — still recommended (root-cause fix; the cleanup reduces exposure but the primary repo remains on the synced path).
- No CI exists; the acceptance standard remains tree/union verification plus the recorded worker evidence.

# Owner acceptance and lease reconciliation — 2026-10-10 — evidence

Decisions executed in-session, 2026-10-10 ~02:20–02:45 EDT (America/New_York), per owner orders:

1. **Accept RH-0045 — squash-merged to main** (owner specified the squash-merge method).
2. **Reconcile the 32 remaining CLAIMED branch leases** (owner order).
3. RH-0046 was found **already delivered REVIEW** (October 9 dispatch, branch `ae93304`) — verified, not accepted by this action.

## 1. RH-0045 acceptance (squash merge)

| Item | Value |
|---|---|
| Review head accepted | `b3ccab5` — branch `rh-0045-nextjs-security-upgrade-integration-carrier` |
| Prior main | `4655455` (October 9 reload; unchanged — remote re-verified by `git ls-remote` immediately before merging) |
| Acceptance commit on main | `077e1b6` — `git merge --squash b3ccab5` + commit (owner-specified method: "squashed with a merge") |
| Product tree vs tested head | **byte-identical** (`git diff b3ccab5^{tree} 077e1b6^{tree}` empty) |
| Contents | 10 files, +913/−202: `next` + `eslint-config-next` 16.4.0 exact pins + lockfile, `tests/regression.test.mjs` (RH-0008 suite, 9/9), `docs/SECURITY_UPGRADE.md`, delivery report + 4 screens, spec flip |
| Ancestry note | By the owner's chosen squash method the branch's commits are intentionally **not** main ancestors; the branch stays on the remote as frozen evidence (`4440f99` rh-0008 source likewise untouched) |
| Verification basis | Worker-executed at `17750fb`, recorded in `.zcode-worker/reports/RH-0045.md`: typecheck/lint clean; 220/220 hermetic; 75/75 integration (disposable PG18, app role, removed after); build green (9 routes); regression 9/9; **21/21 real-browser checks** re-proving the RH-0043 contract on 16.4.0; 4/4 visual-judge screens; audit 9 (8 high, 1 critical) → 5 high / 0 critical with the unpatchable dev-only `braces` chain (GHSA range `*`) dispositioned accepted risk. Suites were not re-run at acceptance — tree byte-identity + report per the established standard. |

## 2. Reconciliation of the 32 CLAIMED branch leases

Method: fresh `git merge-base --is-ancestor <branch-tip> refs/remotes/origin/main` for each of the 32 branch tips against the post-acceptance main (`077e1b6`); executed 2026-10-10 in this session. Result: exactly **11 ancestors** and **21 non-ancestors**, matching the 2026-10-09 reconciliation review's findings.

### COMPLETE by incorporation — 11 branches (rh-0030 … rh-0040)

Each branch tip is an **ancestor of origin/main**: their content entered through the RH-0041 convergence merges (`c72c30c` ← rh-0035, `4c0e364` ← rh-0037, and siblings) → RH-0044 carrier merges (`a42ad26`, `bb1b2f3`) → owner acceptance `59127ce`. Each branch's delivery report is on main under `.zcode-worker/reports/`. Reconciled: CLAIMED → **COMPLETE (incorporated)**.

rh-0030, rh-0031, rh-0032, rh-0033, rh-0034, rh-0035, rh-0036, rh-0037, rh-0038, rh-0039, rh-0040.

### CLOSED as superseded — 21 branches (rh-0002, rh-0003, rh-0008–rh-0024, rh-0026, rh-0027)

Each branch tip is **not an ancestor of origin/main** — never merged. Their scopes were re-delivered onto main by later accepted generations (the B-generation September wave incorporated via the carrier, plus RH-0043/0044/0045), as documented in the supersession ledgers of 2026-10-05/08/09 and each scope's delivered equivalent (DB layer, migrations 0001–0010, catalog sync family, household state, read models, DR tooling, TV UI). Reconciled: CLAIMED → **CLOSED (superseded)**. Two noted specifics: rh-0008's regression suite + security doc + pins were finally integrated via RH-0045 (source `4440f99`), the rest of that branch being stale old-baseline control-plane edits; rh-0017/0018/0022/0027's household write-API scope carries the residual disposition recorded in RH-0005's 2026-10-09 resolution (schema on main via migration 0006; write API = future owner-ordered job).

rh-0002, rh-0003, rh-0008, rh-0009, rh-0010, rh-0011, rh-0012, rh-0013, rh-0014, rh-0015, rh-0016, rh-0017, rh-0018, rh-0019, rh-0020, rh-0021, rh-0022, rh-0023, rh-0024, rh-0026, rh-0027.

### Not done (remains available to the owner)

- **No branch or worktree deletions were performed.** All 32 remote branch tips remain as frozen evidence. With this reconciliation, remote pruning of the 21 CLOSED branches (and the 11 incorporated tips) is now safe and awaits an explicit owner order; local worktree cleanup likewise.
- Deployment/hosted activation: none performed.
- **RH-0046 acceptance** — see below.

## 3. RH-0046 — delivered REVIEW, awaiting owner acceptance

The October 9 dispatch (~22:00 EDT) delivered the in-app household profile switcher on branch `rh-0046-in-app-household-profile-switcher` tip `ae93304`, base `4655455` (verified: `git merge-base ae93304 4655455` = `4655455`). Delivery artifacts verified present at tip: report `.zcode-worker/reports/RH-0046.md`, spec flipped REVIEW, 5 screens. Recorded evidence: typecheck/lint clean; **228/228 hermetic** (220 baseline + 8 roster tests); **76/76 integration** (75 + 1 roster contract test); build green with `/api/profiles` in the route manifest; **16/16 real-browser checks** (keyboard path, roster semantics, cancel/focus-restore, switch-through-switcher re-proving RH-0043 incl. deterministic parked-response race, re-select-no-op, injected-503 fail-closed retry, ghost-slug recovery); **5/5 visual-judge** screens.

Integration note for whoever accepts it: the only file this branch overlaps with the accepted RH-0045 squash is `package.json` (0046 adds `profile-roster.test.ts` to the hermetic union; main now carries the 16.4.0 pins + `test:regression` line) — a mechanical union resolution; no other overlap (20 changed files otherwise under `src/`, docs, report).

This control action does **not** accept or merge RH-0046; that remains the owner's gate.

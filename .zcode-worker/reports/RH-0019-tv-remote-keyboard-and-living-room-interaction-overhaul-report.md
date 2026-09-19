# RH-0019 Worker Report — TV Remote Keyboard and Living-Room Interaction Overhaul

- **Date:** 2026-09-19 (claimed 16:25 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0019-tv-remote-keyboard-and-living-room-interaction-overhaul`
- **Base:** `origin/main` @ `9028194`

## Claim

Dispatch bootstrap ran `git fetch origin --prune` and read the queue from
`origin/main` per protocol. Priority-1/2 rows (RH-0008/0009/0015/0016,
RH-0002/0003) are stale-listed READY on `origin/main` but are leased:
each has an existing branch + local worktree + remote branch (lease
authority). RH-0004 was skipped as a duplicate of leased RH-0016. At
priority 5, RH-0019 and RH-0012 were both READY, unclaimed, and
automation-eligible; the tie resolves to RH-0019 via supervisor commit
`9028194` ("Reload tomorrow ZCode priority queue", 2026-09-19 01:56),
which set `WAVE: Tomorrow priority` on RH-0019 — today. Worktree
`reelhouse-rh-0019` created off `origin/main`; no other worktree entered.

## Commits on the branch

1. `f4135f7` — Deterministic TV spatial navigation engine + test harness:
   pure geometric candidate picker (`src/lib/spatial.ts`), DOM adapter
   with vendor back-key detection (Escape/GoBack/BrowserBack, webOS 461,
   Tizen GoBack 10009, Backspace outside text) and focus scopes
   (`src/lib/tvnav.ts`), React key-routing hook
   (`src/hooks/useTvNavigation.ts`), defensive result dedupe
   (`src/lib/uniqueById.ts`), bounded redacted diagnostics
   (`src/lib/diag.ts`), vitest+jsdom harness with deterministic
   `data-rect` layout stubbing, and unit suites.
2. `e2db79e` — UI wiring: arrow/enter/back across top bar, hero, rails,
   search, profile menu, and detail modal; focus-scope modal with
   `aria-labelledby`, invoker restore on close; search Enter commit
   stepping focus into results; stale-response guard; live match count
   (`aria-live`) + `aria-busy`; keyboard-only focus rings; modal/panel
   entrance transitions with reduced-motion kills; 1600/2200px 10-foot
   density tiers; full component regression matrix.
3. *(this commit)* — README TV-strategy and verification updates, job
   spec → REVIEW, queue updated, this report.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Deterministic tests cover success + stale/duplicate/failure/recovery paths | ✅ 42 tests: stale out-of-order responses ignored (cancelled-flag guard), duplicate results deduped, search/library failure paths bounded, recovery on next query, spatial edge/tie/phantom determinism |
| Build/lint/typecheck suites remain green | ✅ `eslint .` clean, `tsc --noEmit` clean, `next build` succeeds (`○ /`, `ƒ /api/library`, `ƒ /api/search`) |
| Diagnostics bounded and redacted | ✅ `boundedMessage`: 200-char cap, status-only messages generated client-side; household query strings/URLs never enter logs (pinned by exact-call test assertions) |
| Data boundaries preserved | ✅ Jellyfin untouched; no DB coupling; demo fallback intact; no secrets in source |
| No merge/deploy/release | ✅ Local build + localhost smoke only |

## Verification evidence (2026-09-19, Node 22.19.0 / npm 10.9.3)

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm run test` — **42 passed (5 files)**: spatial engine (8), tvnav
  DOM layer (13), component interaction matrix (14), uniqueById (2),
  boundedMessage (5).
- `npm run build` — succeeds; production server smoke on :3219.
- Browser verification (ZCode IAB pane, 1920×1080 and 2560×1440):
  arrow keys walk top bar → hero → rails with correct aligned-column
  targeting; `data-kbd-nav` set on first key and cleared on pointer;
  card focus reveals off-screen rails; details modal opens with focus
  on the primary action (Watchlist fallback for demo items), traps Tab,
  animates in (`rh-modal-in` computed), closes on Escape/Back with focus
  restored to the invoking card; search autofocuses, announces "N
  matches" live, Enter commits focus into the first result, Back closes
  and restores the toggle; density tiers engage quantitatively (primary
  buttons 46→58→68px, cards 230→300→380px caps, topbar 74→92→108px);
  focus-ring selectors confirmed present in the built stylesheet and
  rendering verified via computed `box-shadow` (gold 2–3px ring).

## Environment limitation found during browser verification

The ZCode in-app browser pane is never OS-focused, so Chromium does not
match `:focus` on `document.activeElement` there (broken focus chain),
and untrusted synthetic Enter cannot trigger native button activation.
Neither applies to a real TV/desktop browser with a focused document:
`:focus` semantics are standard browser behavior and Enter/Space
activation of focused controls is native trusted-event behavior. Both
paths are covered by the jsdom suite (initial focus, ring selectors,
activation via the same click handler native Enter dispatches). Recorded
here for the reviewer's context; no code change made.

## Overlap disclosure for the controller (RH-0009)

RH-0009 ("TV remote keyboard and focus-navigation shell", in REVIEW,
unmerged) targets the same surface. This branch was therefore built as a
**deliberate superset** to make integration mechanical:

- `src/lib/spatial.ts`, `src/lib/tvnav.ts`, `vitest.config.ts`,
  `vitest.setup.ts`, `src/lib/spatial.test.ts` are **byte-identical** to
  RH-0009's versions — identical blobs merge cleanly regardless of order.
- `useTvNavigation.ts` adds an optional `onEnterInText` (shell behavior
  unchanged when omitted); `ReelHouseApp.tsx` and `globals.css` contain
  all shell behaviors plus the overhaul delta; component/unit tests
  subsume the shell's cases.
- Suggested integration: apply RH-0009 first, then resolve any
  add/add/content conflict toward this branch (superset). Applying this
  branch first also works; RH-0009's diff then reduces to near-no-op.

## Findings the controller should see

1. `npm install` for the dev-only test toolchain (vitest 5, jsdom 29,
   @testing-library, @vitejs/plugin-react — version ranges identical to
   RH-0009's) prints existing `npm audit` notices; all are in dev
   dependencies, non-blocking, and RH-0008 owns the security pass.
2. The stale-response guard (cancelled-flag around the debounced search
   setState chain) fixes a real race the abort signal alone does not
   cover (a response already in flight when the query changes).
3. Client fetch diagnostics intentionally carry HTTP status only — never
   URLs or query text (household search terms are treated as private).
4. RH-0012 (degraded-mode UX) remains the right home for explicit
   Jellyfin unavailable/reconnecting states; this job only hardened the
   silent demo-fallback path.

## Handoff

Upon acceptance: merge per the controller's frontend order (RH-0009
shell before this overhaul recommended; see overlap disclosure). Six
genuinely unclaimed READY jobs remain (RH-0012/0013/0014/0020/0021 plus
RH-0004 unless retired as an RH-0016 duplicate).

# LinkedIn Wiring — Tech Debt to Fix

Identified via parallel codebase audit (2026-03-06).
These are real issues, not speculative. None are blockers right now, but each has a concrete failure mode.

---

## Issue 1 — `linkedin-tools.ts` cached DB missing `busy_timeout`

**Files:** `src/tools/linkedin-tools.ts` (line 155), `src/tools/linkedin-autoposter.ts` (line 70)

**What it is:**
`linkedin-tools.ts` opens a persistent cached connection (`_db`) and sets only `journal_mode = WAL`.
`linkedin-autoposter.ts` opens a fresh connection per call and sets both `journal_mode = WAL` **and** `busy_timeout = 5000`.

**Fix:**
Add `_db.pragma('busy_timeout = 5000')` immediately after `_db.pragma('journal_mode = WAL')` in `linkedin-tools.ts` `getDb()`.

```ts
// linkedin-tools.ts ~line 155
_db.pragma('journal_mode = WAL');
_db.pragma('busy_timeout = 5000'); // ADD THIS
```

**What it causes without the fix:**
When the autoposter is mid-write and the agent simultaneously hits a LinkedIn tool (e.g. `linkedin_feed`), SQLite returns `SQLITE_BUSY` immediately with no retry. The tool call throws, the agent sees a failed tool call, and may surface a confusing error — even though the autoposter's write actually succeeded.

---

## Issue 2 — Duplicate `ensurePostedGuardIndexes` with independent flags across two modules

**Files:** `src/tools/linkedin-tools.ts` (lines 83–142), `src/tools/linkedin-autoposter.ts` (lines 22–135)

**What it is:**
Both files define the exact same `ensurePostedGuardIndexes()` function with their own module-level boolean guard (`_postedGuardEnsured` / `postedGuardEnsured`). The two guards cannot signal each other.

**Fix:**
Extract to a shared module, e.g. `src/tools/linkedin-db.ts`, that exports both `getDb()` and `ensurePostedGuardIndexes()`. Both files import from there. Single flag, single migration, single connection strategy.

**What it causes without the fix:**
On startup, both modules run their migration pass independently. If they run concurrently (autoposter 60s ticker fires while `linkedin_feed` first opens the DB), both try to UPDATE the same legacy rows and CREATE the same index simultaneously. The index creation is safe (`IF NOT EXISTS`) but the UPDATE fires twice generating spurious log noise. More importantly, the two independent flags mean the migration can re-run if either module is re-evaluated, and the growing divergence between the two implementations is a future bug waiting to happen.

---

## Issue 3 — `scheduleEngagementCheck` exported but never imported externally

**Files:** `src/tools/linkedin-autoposter.ts` (line 1157)

**What it is:**
`scheduleEngagementCheck` is `export function` but is only called from within the same file (line 1108, inside `checkAndPostNext()`). Nothing else imports it.

**Fix:**
Remove the `export` keyword. Make it a plain private function.

```ts
// change:
export function scheduleEngagementCheck(
// to:
function scheduleEngagementCheck(
```

**What it causes without the fix:**
Nothing breaks today. The risk is that a future developer sees it exported and assumes it's wired somewhere else, or that it needs to be called externally after posting — and skips wiring it properly when refactoring `checkAndPostNext()`.

---

## Issue 4 — `linkedin-tools.ts` cached `_db` is never closed, blocks WAL checkpointing

**Files:** `src/tools/linkedin-tools.ts` (lines 82, 144–161)

**What it is:**
`_db` is a module-level singleton opened once and held open forever. `linkedin-autoposter.ts` opens and explicitly closes (`db.close()`) its own connection in every `finally` block, which triggers WAL checkpointing. The unclosed `_db` in `linkedin-tools.ts` holds a reader open and can block those checkpoints from completing.

**Fix:**
Either:
- (Preferred) Merge into the shared `linkedin-db.ts` module from Issue 2 fix, with a single managed connection and a `closeLinkedInDb()` export called from `app.on('before-quit')` in `main/index.ts`.
- (Minimal) Add `app.on('before-quit', () => { if (_db) { _db.close(); _db = null; } })` inside `linkedin-tools.ts`.

**What it causes without the fix:**
During heavy activity (auto-scrape + drafting session), the WAL file can grow several MB larger than necessary because the autoposter's `db.close()` checkpoints are being partially blocked by the open reader. Not a correctness issue, but a disk usage / performance issue that compounds over time.

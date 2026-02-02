# Design: Unanswered Command Center

**Status:** EVA REVIEW
**Author:** Opus 4.5
**Date:** 2026-02-02

---

## 1. Executive Summary

Users miss emails that need replies. The inbox has hundreds of threads; some are unanswered but buried under new messages. There is no way to surface "I received something and never replied" without manually scanning.

The Unanswered Command Center adds a scheduled scan that finds threads where the last message is inbound (not from the user), tracks them in a dedicated SQLite table, and exposes them through three surfaces: a new Settings UI tab, Telegram commands, and rules engine integration for automated digests.

**Key constraint:** No AI/GLM involved. Unanswered detection is purely deterministic, using the existing `computeThreadState()` function. The only Gmail API calls are thread fetches via the existing `getThread()` wrapper.

**Scope:** New engine file, new DB table, new IPC handlers, new UI tab, new Telegram command, three new condition types, four new action types.

---

## 2. What Exists vs. What's New

### Already implemented (no changes needed)

| Component | File | Lines | Status |
|-----------|------|-------|--------|
| `computeThreadState()` | `src/scheduler/rules-engine.ts` | 119-146 | Working. Returns `'unread' \| 'unreplied' \| 'awaiting_reply' \| 'replied_with_answer' \| 'user_only'` |
| `ThreadState` type | `src/scheduler/rules-engine.ts` | 112 | Exported |
| `thread_state_cache` table | `src/scheduler/rules-engine.ts` | 220-227 | 30-min TTL, keyed on `(thread_id, account)` |
| `getOrFetchThreadState()` | `src/scheduler/rules-engine.ts` | 399-443 | Fetches thread, computes state, caches result |
| `getThread()` | `src/tools/gog-wrapper.ts` | 254-269 | Wraps `gog gmail thread get --json` |
| `readEmails()` | `src/tools/gog-wrapper.ts` | 88-107 | Wraps `gog gmail messages search --json` |
| `createDraft()` | `src/tools/gog-wrapper.ts` | 172-211 | Draft creation via `gog gmail drafts create` |
| `RulesEngine` class | `src/scheduler/rules-engine.ts` | 161-800 | Full rule evaluation, conditions, actions |
| `TriggerType` | `src/scheduler/rules-engine.ts` | 21 | `'on_label_applied' \| 'on_label_corrected' \| 'on_schedule' \| 'on_daily_summary'` |
| `ConditionType` | `src/scheduler/rules-engine.ts` | 23-29 | 10 existing condition types |
| `ActionType` | `src/scheduler/rules-engine.ts` | 30-35 | 10 existing action types |
| `email_processing_state` table | `src/scheduler/email-processor.ts` | 494-509 | Per-email classification data with `thread_id` |
| `EmailProcessor` class | `src/scheduler/email-processor.ts` | 428-1269 | Full processing pipeline |
| `ensureEmailProcessor()` | `src/main/index.ts` | 1528-1557 | Lazy init of EmailProcessor + RulesEngine |
| Telegram `sendMessage()` | `src/channels/telegram.ts` | 1266-1305 | Proactive message sending to specific chat |
| Telegram `broadcast()` | `src/channels/telegram.ts` | 1335-1342 | Send to all active chats |
| Rules Engine IPC handlers | `src/main/index.ts` | 1689-1753 | `rules:getAll`, `rules:create`, `rules:update`, etc. |
| Email Processing Settings UI | `ui/settings.html` | 1855-2061 | Tabs: Basics, Labels, Advanced, Status, History, Rules |
| `epSwitchTab()` | `ui/settings.html` | 3041-3047 | Tab switching logic |
| `SettingsManager` | `src/settings/` | -- | Key-value settings persistence |

### New additions

| Component | File | What |
|-----------|------|------|
| `unanswered_state` table | Created by `UnansweredEngine` | Tracks unanswered threads with state lifecycle |
| `UnansweredEngine` class | `src/scheduler/unanswered-engine.ts` | Scan, upsert, resolve, dismiss, digest |
| Extended `TriggerType` | `src/scheduler/rules-engine.ts` | Add `'on_unanswered_scan'` |
| Extended `ConditionType` | `src/scheduler/rules-engine.ts` | Add `'label_in'`, `'unanswered_age_minutes_gt'`, `'state_is_not'` |
| Extended `ActionType` | `src/scheduler/rules-engine.ts` | Add `'send_unanswered_digest'`, `'mark_resolved'`, `'dismiss'` |
| Unanswered IPC handlers | `src/main/index.ts` | `unanswered:scan`, `unanswered:list`, `unanswered:resolve`, `unanswered:dismiss`, `unanswered:getSettings` |
| "Unanswered" UI tab | `ui/settings.html` | New tab panel with filters, list, actions |
| `/unanswered` Telegram command | `src/channels/telegram.ts` | List and act on unanswered threads |

---

## 3. Schema Changes + Migration

### New table: `unanswered_state`

```sql
CREATE TABLE IF NOT EXISTS unanswered_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,          -- ID of the last inbound message
  subject TEXT,
  sender TEXT,              -- sender of the last inbound message
  label TEXT,               -- classification label from email_processing_state
  state TEXT NOT NULL DEFAULT 'unanswered',  -- unanswered | resolved | dismissed
  first_seen_at TEXT DEFAULT (datetime('now')),
  last_scanned_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  dismissed_at TEXT,
  UNIQUE(account, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_us_state ON unanswered_state(state);
CREATE INDEX IF NOT EXISTS idx_us_account_state ON unanswered_state(account, state);
CREATE INDEX IF NOT EXISTS idx_us_first_seen ON unanswered_state(first_seen_at);
```

### Migration strategy

The table is created by `UnansweredEngine.createTables()` in its constructor, identical to how `RulesEngine.createTables()` works (line 186 of `rules-engine.ts`). All statements use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, so they are idempotent. No ALTER TABLE needed -- this is a net-new table.

### State transitions

```
                    +---> resolved (user replied)
                    |       |
  [new thread] --> unanswered ---+--> dismissed (user dismisses)
                    ^       |
                    |       +---> resolved (auto-detected: user replied since last scan)
                    |
                    +--- re-opened (dismissed thread gets new inbound message)
```

State transition rules:
- `unanswered -> resolved`: User sends a reply (detected by `computeThreadState()` returning `'awaiting_reply'` or `'user_only'`), or explicit `mark_resolved` action.
- `unanswered -> dismissed`: User explicitly dismisses via UI, Telegram, or `dismiss` rule action.
- `dismissed -> unanswered`: Only if thread gets a new inbound message after dismissal (the `message_id` column changes). This prevents dismissed threads from reappearing on the next scan unless new mail arrives.
- `resolved -> unanswered`: Only if a new inbound message arrives after resolution (same logic).

---

## 4. Backend Spec

### 4.1 `UnansweredEngine` (`src/scheduler/unanswered-engine.ts`)

```typescript
import Database from 'better-sqlite3';
import { SettingsManager } from '../settings';
import { readEmails, getThread } from '../tools/gog-wrapper';

// Re-export from rules-engine to avoid circular deps
type ThreadState = 'unread' | 'unreplied' | 'awaiting_reply' | 'replied_with_answer' | 'user_only';

interface UnansweredThread {
  id: number;
  account: string;
  thread_id: string;
  message_id: string | null;
  subject: string | null;
  sender: string | null;
  label: string | null;
  state: 'unanswered' | 'resolved' | 'dismissed';
  first_seen_at: string;
  last_scanned_at: string;
  resolved_at: string | null;
  dismissed_at: string | null;
}

interface ScanResult {
  account: string;
  threadsScanned: number;
  newUnanswered: number;
  autoResolved: number;
  errors: number;
  durationMs: number;
}

interface UnansweredFilter {
  labels?: string[];          // filter by classification label
  ageMinutesGt?: number;      // only threads unanswered > N minutes
  state?: string;             // filter by state column
  limit?: number;
  offset?: number;
}

export class UnansweredEngine {
  private db: Database.Database;
  private scanIntervalId: ReturnType<typeof setInterval> | null = null;
  private digestThrottleMap: Map<string, number> = new Map(); // account -> last digest timestamp

  constructor(db: Database.Database);

  // --- Schema ---
  private createTables(): void;

  // --- Scan ---
  async scan(account: string): Promise<ScanResult>;
  async scanAll(): Promise<ScanResult[]>;

  // --- Query ---
  list(filter?: UnansweredFilter): UnansweredThread[];
  count(filter?: UnansweredFilter): number;
  getByThreadId(account: string, threadId: string): UnansweredThread | null;

  // --- Actions ---
  resolve(account: string, threadId: string): void;
  resolveAll(filter?: UnansweredFilter): number;
  dismiss(account: string, threadId: string): void;
  dismissAll(filter?: UnansweredFilter): number;

  // --- Digest ---
  async sendDigest(
    account: string,
    filter?: UnansweredFilter,
  ): Promise<{ sent: boolean; threadCount: number; throttled: boolean }>;

  // --- Scheduler ---
  startSchedule(intervalMinutes: number): void;
  stopSchedule(): void;

  // --- DI ---
  setTelegramSender(fn: (text: string) => void): void;
  setNotificationHandler(fn: (title: string, body: string) => void): void;
}
```

### 4.2 `scan(account)` algorithm

```
1. Read settings:
   - lookbackDays = SettingsManager.get('gmail.unanswered.lookbackDays') || '30'
   - labels = SettingsManager.get('gmail.unanswered.labels') || '[]'  (JSON array)
   - userEmail = SettingsManager.get('gmail.userEmail') || ''

2. Build Gmail query:
   - Base: "newer_than:{lookbackDays}d"
   - If labels configured: add "label:{label}" filter for each
   - Exclude sent-only: "NOT from:{userEmail}" (reduces noise)

3. Fetch thread list via readEmails({ query, max: 200, account })

4. For each thread in results (concurrency = 3):
   a. Check thread_state_cache first (30-min TTL)
   b. If cache miss, call getThread({ threadId, account })
   c. Compute thread state via computeThreadState()
   d. Update thread_state_cache (upsert)
   e. Determine unanswered status:
      - 'unreplied' -> unanswered
      - 'replied_with_answer' where last msg is inbound -> unanswered
      - 'unread' -> unanswered (subset of unreplied)
      - 'awaiting_reply' -> NOT unanswered (user already replied)
      - 'user_only' -> NOT unanswered

5. Upsert into unanswered_state:
   - New unanswered thread: INSERT with state='unanswered'
   - Existing unanswered, still unanswered: UPDATE last_scanned_at
   - Existing unanswered, now replied: UPDATE state='resolved', resolved_at=now
   - Existing dismissed, same message_id: SKIP (respect dismissal)
   - Existing dismissed, NEW message_id: UPDATE state='unanswered' (re-opened)
   - Existing resolved, NEW message_id: UPDATE state='unanswered' (re-opened)

6. Return ScanResult stats
```

### 4.3 Rules engine extensions

**File:** `src/scheduler/rules-engine.ts`

Add to `TriggerType` (line 21):
```typescript
export type TriggerType =
  | 'on_label_applied' | 'on_label_corrected'
  | 'on_schedule' | 'on_daily_summary'
  | 'on_unanswered_scan';   // NEW
```

Add to `ConditionType` (lines 23-29):
```typescript
export type ConditionType =
  | 'label_is' | 'label_is_not'
  | 'confidence_gte' | 'confidence_lt'
  | 'sender_domain' | 'has_attachment'
  | 'age_minutes_lt' | 'age_minutes_gt'
  | 'corrected_by_user' | 'rule_not_executed'
  | 'thread_state'
  | 'label_in'                    // NEW: comma-separated, matches if label is any of them
  | 'unanswered_age_minutes_gt'   // NEW: thread has been unanswered > N minutes
  | 'state_is_not';              // NEW: skip if unanswered_state matches value
```

Add to `ActionType` (lines 30-35):
```typescript
export type ActionType =
  | 'apply_label' | 'remove_label'
  | 'draft_reply' | 'send_reply'
  | 'mark_read' | 'archive'
  | 'send_telegram' | 'send_email'
  | 'add_to_summary' | 'do_nothing'
  | 'send_unanswered_digest'   // NEW: batch unanswered into Telegram message
  | 'mark_resolved'            // NEW: set state='resolved' in unanswered_state
  | 'dismiss';                 // NEW: set state='dismissed' in unanswered_state
```

Add to `matchSingleCondition()` (line 764):
```typescript
case 'label_in': {
  const labels = cond.value.split(',').map(l => l.trim());
  return labels.includes(email.label);
}
case 'unanswered_age_minutes_gt': {
  if (!email.threadId) return false;
  const row = this.db.prepare(
    "SELECT first_seen_at FROM unanswered_state WHERE thread_id = ? AND account = ? AND state = 'unanswered'"
  ).get(email.threadId, email.account) as { first_seen_at: string } | undefined;
  if (!row) return false;
  const ageMs = Date.now() - new Date(row.first_seen_at + 'Z').getTime();
  return ageMs / 60000 > Number(cond.value);
}
case 'state_is_not': {
  if (!email.threadId) return true;
  const row = this.db.prepare(
    "SELECT state FROM unanswered_state WHERE thread_id = ? AND account = ?"
  ).get(email.threadId, email.account) as { state: string } | undefined;
  return !row || row.state !== cond.value;
}
```

Add to `executeAction()` (line 447):
```typescript
case 'send_unanswered_digest':
  // Delegated to UnansweredEngine.sendDigest() via injected reference
  break;
case 'mark_resolved':
  if (email.threadId) {
    this.db.prepare(
      "UPDATE unanswered_state SET state = 'resolved', resolved_at = datetime('now') WHERE thread_id = ? AND account = ?"
    ).run(email.threadId, email.account);
  }
  break;
case 'dismiss':
  if (email.threadId) {
    this.db.prepare(
      "UPDATE unanswered_state SET state = 'dismissed', dismissed_at = datetime('now') WHERE thread_id = ? AND account = ?"
    ).run(email.threadId, email.account);
  }
  break;
```

### 4.4 IPC handlers

**File:** `src/main/index.ts` (add after existing rules IPC handlers, ~line 1753)

```typescript
// --- Unanswered Command Center ---

let unansweredEngine: UnansweredEngine | null = null;

async function ensureUnansweredEngine(): Promise<void> {
  await ensureEmailProcessor();
  if (!unansweredEngine) {
    const { UnansweredEngine } = await import('../scheduler/unanswered-engine');
    unansweredEngine = new UnansweredEngine(emailProcessor!.getDb());
    unansweredEngine.setTelegramSender((text: string) => {
      const chatId = SettingsManager.get('telegram.defaultChatId');
      if (chatId && telegramBot) {
        telegramBot.sendMessage(Number(chatId), text).catch(console.warn);
      }
    });
    unansweredEngine.setNotificationHandler((title: string, body: string) => {
      showNotification(title, body);
    });
  }
}

ipcMain.handle('unanswered:scan', async (_evt, account?: string) => {
  await ensureUnansweredEngine();
  if (account) return unansweredEngine!.scan(account);
  return unansweredEngine!.scanAll();
});

ipcMain.handle('unanswered:list', async (_evt, filter?: UnansweredFilter) => {
  await ensureUnansweredEngine();
  return {
    threads: unansweredEngine!.list(filter),
    total: unansweredEngine!.count(filter),
  };
});

ipcMain.handle('unanswered:resolve', async (_evt, account: string, threadId: string) => {
  await ensureUnansweredEngine();
  unansweredEngine!.resolve(account, threadId);
  return { ok: true };
});

ipcMain.handle('unanswered:resolveAll', async (_evt, filter?: UnansweredFilter) => {
  await ensureUnansweredEngine();
  const count = unansweredEngine!.resolveAll(filter);
  return { ok: true, count };
});

ipcMain.handle('unanswered:dismiss', async (_evt, account: string, threadId: string) => {
  await ensureUnansweredEngine();
  unansweredEngine!.dismiss(account, threadId);
  return { ok: true };
});

ipcMain.handle('unanswered:dismissAll', async (_evt, filter?: UnansweredFilter) => {
  await ensureUnansweredEngine();
  const count = unansweredEngine!.dismissAll(filter);
  return { ok: true, count };
});

ipcMain.handle('unanswered:digest', async (_evt, account: string) => {
  await ensureUnansweredEngine();
  return unansweredEngine!.sendDigest(account);
});

ipcMain.handle('unanswered:getSettings', async () => {
  return {
    enabled: SettingsManager.get('gmail.unanswered.enabled') === 'true',
    intervalMin: SettingsManager.get('gmail.unanswered.intervalMin') || '60',
    lookbackDays: SettingsManager.get('gmail.unanswered.lookbackDays') || '30',
    labels: JSON.parse(SettingsManager.get('gmail.unanswered.labels') || '[]'),
    digestThrottleHours: SettingsManager.get('gmail.unanswered.digestThrottleHours') || '4',
  };
});

ipcMain.handle('unanswered:saveSettings', async (_evt, settings: Record<string, string>) => {
  for (const [key, value] of Object.entries(settings)) {
    SettingsManager.set(`gmail.unanswered.${key}`, value);
  }
  return { ok: true };
});
```

### 4.5 Telegram `/unanswered` command

**File:** `src/channels/telegram.ts` (add in `setupHandlers()`, after existing command handlers, ~line 680)

```typescript
this.bot.command('unanswered', async (ctx) => {
  const arg = ctx.message?.text?.replace('/unanswered', '').trim();

  // Lazy import to avoid circular deps
  const { getUnansweredEngine } = await import('../scheduler/unanswered-engine');
  const engine = getUnansweredEngine();
  if (!engine) {
    await ctx.reply('Unanswered engine not initialized.');
    return;
  }

  // Parse filters: label:Clients age:2h
  const filter: UnansweredFilter = { state: 'unanswered', limit: 20 };
  if (arg) {
    const labelMatch = arg.match(/label:(\S+)/);
    if (labelMatch) filter.labels = [labelMatch[1]];
    const ageMatch = arg.match(/age:(\d+)([hm])/);
    if (ageMatch) {
      const val = parseInt(ageMatch[1], 10);
      filter.ageMinutesGt = ageMatch[2] === 'h' ? val * 60 : val;
    }
  }

  const threads = engine.list(filter);
  if (threads.length === 0) {
    await ctx.reply('No unanswered threads found.');
    return;
  }

  const lines = threads.map((t, i) =>
    `${i + 1}. ${t.subject || '(no subject)'}\n   From: ${t.sender || 'unknown'} | ${t.label || 'unlabeled'}\n   Since: ${t.first_seen_at}`
  );

  await ctx.reply(
    `Unanswered threads (${threads.length}):\n\n${lines.join('\n\n')}\n\n` +
    `Reply: "<number> draft", "<number> resolve", or "<number> dismiss"`
  );

  // Store thread list in memory for follow-up commands
  // (Use session-scoped state, keyed by chatId)
});
```

Follow-up message handler pattern (reply parsing):
- `1 draft` -> calls `createDraft()` for thread at index 1
- `2 resolve` -> calls `unansweredEngine.resolve(account, threadId)` for thread at index 2
- `3 dismiss` -> calls `unansweredEngine.dismiss(account, threadId)` for thread at index 3

---

## 5. UI Wireframes

### 5.1 New "Unanswered" tab in Email Processing settings

Add after the Rules tab in `ui/settings.html` (line 1861):

```
+--------+--------+----------+--------+---------+-------+------------+
| Basics | Labels | Advanced | Status | History | Rules | Unanswered |
+--------+--------+----------+--------+---------+-------+------------+
```

Count badge on the tab header shows number of currently unanswered threads.

### 5.2 Tab content: Empty state

```
+-------------------------------------------------------------------+
| Unanswered (0)                                                    |
+-------------------------------------------------------------------+
|                                                                   |
|  [x] Enable unanswered scan                                      |
|  Scan interval: [60 min v]    Lookback: [30 days v]              |
|                                                                   |
|  Labels to monitor:                                               |
|  +-------------------------------------------------------+       |
|  | Search labels...                                       |       |
|  +-------------------------------------------------------+       |
|  | [x] Clients    [x] Partners    [ ] Newsletters        |       |
|  | [x] Vendors    [ ] Promotions  [ ] Social             |       |
|  +-------------------------------------------------------+       |
|                                                                   |
|  [Scan Now]   [Send Digest]                                       |
|                                                                   |
|  +---------------------------------------------------------+     |
|  |              No unanswered threads found.                |     |
|  |              Run a scan to check your inbox.             |     |
|  +---------------------------------------------------------+     |
|                                                                   |
+-------------------------------------------------------------------+
```

### 5.3 Tab content: With results

```
+-------------------------------------------------------------------+
| Unanswered (7)                                                    |
+-------------------------------------------------------------------+
|                                                                   |
|  [x] Enable unanswered scan    Interval: [60 min v]              |
|                                                                   |
|  Filter: [All labels v]  Age: [Any v]   [Scan Now] [Send Digest] |
|                                                                   |
|  Batch: [Resolve All]  [Dismiss All]                              |
|                                                                   |
|  +---------------------------------------------------------------+|
|  | Subject              | From           | Label    | Since | Act ||
|  |--------------------------------------------------------------+||
|  | Re: Q1 Invoice       | john@acme.com  | Clients  | 2d    |D R X|
|  | Partnership proposal | lisa@co.io     | Partners | 4h    |D R X|
|  | Meeting follow-up    | mark@team.com  | Clients  | 1d    |D R X|
|  | Support ticket #442  | help@svc.com   | Vendors  | 6h    |D R X|
|  +---------------------------------------------------------------+|
|                                                                   |
|  D = Draft Reply    R = Resolve    X = Dismiss                    |
|  Showing 7 of 7 unanswered threads                                |
+-------------------------------------------------------------------+
```

### 5.4 Tab content: After scan (progress)

```
+-------------------------------------------------------------------+
|  Scanning account user@gmail.com...                               |
|  [=========>                    ] 34/102 threads checked          |
|                                                                   |
|  Found: 5 new unanswered, 2 auto-resolved                        |
+-------------------------------------------------------------------+
```

### 5.5 State transitions in the UI

| UI element | Current state | Action | New state |
|---|---|---|---|
| Draft Reply button (D) | unanswered | Creates Gmail draft, thread stays unanswered | unanswered (no state change) |
| Resolve button (R) | unanswered | Row fades out, moves to resolved | resolved |
| Dismiss button (X) | unanswered | Row fades out, moves to dismissed | dismissed |
| Resolve All | unanswered (filtered set) | All visible rows resolved | resolved |
| Dismiss All | unanswered (filtered set) | All visible rows dismissed | dismissed |
| Automatic (next scan) | unanswered | User replied since last scan | resolved (auto) |
| Automatic (next scan) | dismissed | New inbound message on thread | unanswered (re-opened) |

---

## 6. Failure Scenarios + Recovery

### 6.1 Gmail rate limits during scan

**Scenario:** `getThread()` returns 429 or timeout partway through scan.

**Recovery:**
- Scan processes threads sequentially with concurrency cap (3).
- On 429/timeout for a single thread: log warning, skip that thread, continue scanning remaining threads.
- Partial results are still upserted. Already-cached threads (from `thread_state_cache`) are not re-fetched.
- Next scan will pick up skipped threads (cache miss = retry).
- `ScanResult.errors` counter tracks how many threads failed.
- If >50% of threads fail, emit a notification: "Unanswered scan partially failed. Will retry next interval."

### 6.2 False positives (replied from another account or device)

**Scenario:** User replied from a different email account or via mobile. `computeThreadState()` still sees the thread as unreplied because the reply `from` address does not match `gmail.userEmail`.

**Recovery:**
- User clicks Dismiss in UI or sends `N dismiss` in Telegram.
- Dismissed state is sticky: the thread will NOT reappear on next scan unless a new inbound message arrives with a different `message_id` than what was recorded.
- The `message_id` column in `unanswered_state` tracks the last known inbound message. Only a genuinely NEW inbound message can re-open a dismissed thread.

### 6.3 Digest spam

**Scenario:** Rules trigger `send_unanswered_digest` action on every scan cycle, flooding Telegram.

**Recovery:**
- `UnansweredEngine.sendDigest()` enforces a per-account throttle.
- Default: max 1 digest per 4 hours per account (configurable via `gmail.unanswered.digestThrottleHours`).
- Throttle tracked in-memory via `digestThrottleMap: Map<string, number>`.
- If throttled, `sendDigest()` returns `{ sent: false, throttled: true }`.
- The digest message itself includes a count and summary, not individual thread details for large lists.

### 6.4 Large inbox (thousands of threads)

**Scenario:** User has 5000+ threads in the lookback window. Scanning all would exhaust API quota.

**Recovery:**
- `readEmails()` is called with `max: 200` cap (configurable via `gmail.unanswered.maxThreadsPerScan`).
- Default lookback is 30 days. Configurable down to 7 days for large inboxes.
- Label filter reduces scope: if user selects only 3 labels, only threads with those labels are fetched.
- `thread_state_cache` with 30-min TTL means repeated scans within the window do not re-fetch threads.
- Gmail query uses `NOT from:{userEmail}` to exclude sent-only threads at the API level.

### 6.5 DB corruption or missing table

**Scenario:** SQLite file is corrupted or table was accidentally dropped.

**Recovery:**
- `createTables()` uses `CREATE TABLE IF NOT EXISTS`. If the table is missing, it is recreated on next `UnansweredEngine` construction.
- If the DB itself is corrupted, this is handled at the `EmailProcessor` level (existing `better-sqlite3` error propagation). The scan will fail with an error, and the UI will show the error message.

### 6.6 Concurrent scan attempts

**Scenario:** User clicks "Scan Now" while a scheduled scan is already running.

**Recovery:**
- `UnansweredEngine.scan()` uses a `scanning: boolean` guard (same pattern as `EmailProcessor.running` at line 749 of `email-processor.ts`).
- If already scanning, returns early with `{ threadsScanned: 0, ... }` and a log message.

---

## 7. Phased Execution with Checkpoints

### Phase 1: Core engine + table (Backend only)

**Files changed:**
- NEW: `src/scheduler/unanswered-engine.ts`
- EDIT: `src/scheduler/rules-engine.ts` (export `computeThreadState`, add `ThreadMessage` export)

**Deliverables:**
1. `UnansweredEngine` class with `createTables()`, `scan()`, `list()`, `count()`, `resolve()`, `dismiss()`
2. `unanswered_state` table creation
3. Unit tests for scan logic, state transitions, dismissal stickiness

**Checkpoint:** Run `npm run typecheck && npm run lint`. Write unit tests that:
- Verify `scan()` correctly identifies unreplied threads
- Verify `resolve()` and `dismiss()` update state
- Verify dismissed threads are not re-opened unless `message_id` changes
- Verify `ScanResult` stats are accurate

---

### Phase 2: Rules engine extensions

**Files changed:**
- EDIT: `src/scheduler/rules-engine.ts` (types + `matchSingleCondition` + `executeAction`)

**Deliverables:**
1. `TriggerType` extended with `'on_unanswered_scan'`
2. Three new `ConditionType` values: `label_in`, `unanswered_age_minutes_gt`, `state_is_not`
3. Three new `ActionType` values: `send_unanswered_digest`, `mark_resolved`, `dismiss`
4. `matchSingleCondition()` switch cases for new conditions
5. `executeAction()` switch cases for new actions

**Checkpoint:** Run `npm run typecheck && npm run lint`. Write unit tests that:
- Verify `label_in` matches comma-separated label lists
- Verify `unanswered_age_minutes_gt` computes age correctly from `first_seen_at`
- Verify `state_is_not` reads from `unanswered_state` table
- Verify `mark_resolved` and `dismiss` actions update the correct rows

---

### Phase 3: IPC + Telegram

**Files changed:**
- EDIT: `src/main/index.ts` (add IPC handlers after line ~1753)
- EDIT: `src/channels/telegram.ts` (add `/unanswered` command in `setupHandlers()`)
- NEW: `src/scheduler/unanswered-engine.ts` export singleton getter `getUnansweredEngine()`

**Deliverables:**
1. All `unanswered:*` IPC handlers registered
2. `/unanswered` Telegram command with filter parsing
3. Follow-up reply parsing (`N draft`, `N resolve`, `N dismiss`)
4. `sendDigest()` with throttle enforcement
5. Lazy init via `ensureUnansweredEngine()` pattern (matches existing `ensureEmailProcessor()`)

**Checkpoint:** Manual test:
- Open Settings, verify no errors in console
- Send `/unanswered` in Telegram, verify response
- Call `unanswered:scan` via DevTools, verify `unanswered_state` table populated

---

### Phase 4: UI tab

**Files changed:**
- EDIT: `ui/settings.html` (add tab header after Rules tab, add tab panel, add JS functions)

**Deliverables:**
1. "Unanswered" tab with count badge
2. Settings section: enable toggle, interval, lookback, label multi-select
3. Thread list table with Draft Reply / Resolve / Dismiss per-row buttons
4. Batch actions: Resolve All, Dismiss All
5. Scan Now button with progress display
6. Send Digest button
7. Responsive layout matching existing tabs

**Checkpoint:** Manual test:
- Tab renders correctly with zero results
- Scan Now populates the list
- Per-item actions work (Draft Reply creates draft, Resolve/Dismiss remove from list)
- Batch actions work
- Count badge updates after scan

---

### Phase 5: Scheduled scan + startup wiring

**Files changed:**
- EDIT: `src/main/index.ts` (wire `UnansweredEngine.startSchedule()` at app startup, ~line 2500)

**Deliverables:**
1. If `gmail.unanswered.enabled === 'true'`, start scheduled scan at app startup
2. Schedule respects `gmail.unanswered.intervalMin` setting
3. After each scan, evaluate rules with `on_unanswered_scan` trigger
4. `stopSchedule()` called on app quit

**Checkpoint:** Manual test:
- Enable unanswered scanning in UI
- Restart app
- Verify scan runs automatically after configured interval
- Verify rules with `on_unanswered_scan` trigger fire after scan

---

## 8. Verification Checklist

### Correctness

- [ ] `computeThreadState()` correctly identifies unreplied threads (states: `unreplied`, `replied_with_answer` with inbound last message, `unread`)
- [ ] `unanswered_state` table created with correct schema and indexes
- [ ] `scan()` upserts correctly: new inserts, auto-resolves, respects dismissals
- [ ] Dismissed threads stay dismissed unless `message_id` changes (new inbound)
- [ ] Resolved threads stay resolved unless `message_id` changes (new inbound)
- [ ] `thread_state_cache` is respected (no redundant `getThread()` calls within 30-min window)
- [ ] `label_in` condition matches any label in comma-separated list
- [ ] `unanswered_age_minutes_gt` correctly computes minutes from `first_seen_at`
- [ ] `state_is_not` reads from `unanswered_state` and returns true when no row exists
- [ ] `mark_resolved` and `dismiss` actions update the correct `unanswered_state` rows
- [ ] `send_unanswered_digest` throttle enforced (max 1 per 4 hours per account)

### Safety

- [ ] No Gmail write operations in scan (read-only: `readEmails` + `getThread` only)
- [ ] Scan has concurrency cap (max 3 concurrent `getThread()` calls)
- [ ] Scan has thread count cap (max 200 per scan, configurable)
- [ ] Digest throttle prevents Telegram spam
- [ ] `scanning` guard prevents concurrent scan runs
- [ ] All SQL uses parameterized queries (no string interpolation)
- [ ] `createTables()` is idempotent (`IF NOT EXISTS`)

### Performance

- [ ] Scans complete within 60 seconds for 200 threads (with cache hits)
- [ ] `thread_state_cache` eliminates redundant API calls across scan + rules evaluation
- [ ] `unanswered_state` queries use indexes (`idx_us_state`, `idx_us_account_state`)
- [ ] UI list query has `LIMIT`/`OFFSET` for pagination
- [ ] Gmail query uses `NOT from:{userEmail}` to reduce API response size

### UI

- [ ] Tab renders correctly in both light and dark themes
- [ ] Count badge updates after scan
- [ ] Empty state shows helpful message with Scan Now button
- [ ] Per-row actions (Draft Reply, Resolve, Dismiss) work and update list
- [ ] Batch actions (Resolve All, Dismiss All) work on filtered set
- [ ] Scan Now shows progress indicator
- [ ] Label multi-select filter works and persists to settings
- [ ] Age filter works

### Telegram

- [ ] `/unanswered` lists threads with numbered entries
- [ ] `/unanswered label:Clients age:2h` filters correctly
- [ ] Reply `1 draft` creates Gmail draft for the correct thread
- [ ] Reply `2 resolve` marks correct thread as resolved
- [ ] Reply `3 dismiss` marks correct thread as dismissed
- [ ] Unauthorized users cannot access the command (existing middleware, `telegram.ts` line 303-337)

### Integration

- [ ] `on_unanswered_scan` trigger fires after each scheduled scan
- [ ] Rules with unanswered conditions evaluate correctly
- [ ] `send_unanswered_digest` action generates and sends correct Telegram message
- [ ] `UnansweredEngine` uses same DB instance as `EmailProcessor` and `RulesEngine`
- [ ] `ensureUnansweredEngine()` follows same lazy-init pattern as `ensureEmailProcessor()`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] All unit tests pass: `npm run test`

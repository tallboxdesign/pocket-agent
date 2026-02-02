# Design: Email Label Routing (Folder-Style Filing)

**Status:** EVA REVIEW INCORPORATED — ready for final approval
**Author:** Opus 4.5
**Date:** 2026-02-02
**EVA Review:** 2026-02-02

---

## 1. Executive Summary

After an email is classified/corrected/rule-actioned, Pocket Agent should optionally "file it away" by removing the INBOX label so it no longer clutters Primary.

**Current state:** 80% implemented. The backend `applyRouting()`, `LabelConfig` fields, UI checkboxes, `filed_at` column, and all three label-application paths already work.

**This design covers the delta:** observability, manual filing, destination label routing, bulk controls, and the failure/recovery paths EVA requires.

---

## 2. Definitions (EVA Review Point #1)

### What "filing" means precisely

In Gmail, there are no folders. There are labels. "Filing" is a sequence of label operations:

| Step | Operation | Gmail API | When |
|------|-----------|-----------|------|
| 1 | Apply classification label | `modifyLabels --add <label>` | Always (already done before routing) |
| 2 | Apply AI/Processed marker | `modifyLabels --add AI/Processed` | Always (already done before routing) |
| 3 | Apply destination label (if different) | `modifyLabels --add <routeToLabel>` | Only if `routeToLabel` is set and differs from classification label |
| 4 | Remove INBOX | `modifyLabels --remove INBOX` | Only if `removeFromInbox = true` |
| 5 | Remove UNREAD | `modifyLabels --remove UNREAD` | Only if `markReadOnFile = true` |

### Three questions answered

**Q: Is "file" always "remove from inbox" only?**
A: No. Filing is the combination of steps 3-5. Removing INBOX is the core action, but destination label and mark-read are part of the same atomic operation.

**Q: If destination label is set, do we also apply the classification label, or replace it?**
A: **Both labels are applied.** The classification label is always applied (step 1, before routing runs). The destination label is applied additionally (step 3). This means the email has both labels. Rationale: the classification label is the "truth" (what the email IS), the destination label is the "filing location" (where it goes). Removing the classification label would lose audit trail.

**Q: Can filing happen without a destination label?**
A: Yes. If `routeToLabel` is undefined (the default), steps 1-2 already applied the classification label. Steps 4-5 just remove INBOX/UNREAD. This is the common case.

---

## 3. Architecture: What Exists vs. What's New

### Already implemented (no changes needed)

| Component | Location | Status |
|-----------|----------|--------|
| `applyRouting()` function | `email-processor.ts:368-397` | Working |
| `removeFromInbox` / `markReadOnFile` / `keepInInboxOnUncertain` | `LabelConfig` type | Working |
| UI routing checkboxes | `settings.html:3138-3151` | Working |
| `filed_at` column | `email_processing_state` | Working |
| `Filed` badge in History | `settings.html:3468` | Working |
| All 3 paths call `applyRouting()` | classification / correction / rule action | Working |

### New additions

| Component | Description | Phase |
|-----------|-------------|-------|
| `routing_result` column | 3-state: `filed` / `in_inbox` / `unknown` | 1 |
| `routing_error` column | Short error string for forensics | 1 |
| History routing indicator | Badge per row: Filed / In Inbox / Unknown | 1 |
| Global kill switch | Disable all routing instantly | 1 |
| `gmailFileEmail` IPC | Manual filing from History | 2 |
| "File now" button | Per-row in History | 2 |
| "Retry routing" button | Per-row when routing failed | 2 |
| `routeToLabel` field | Destination label override | 3 |
| Searchable destination dropdown | Typeahead label picker | 3 |
| Default routing for new labels | Global defaults | 4 |
| Bulk apply routing | Multi-label routing config | 4 |
| "Restore to inbox" action | Undo filing per row | 4 |

---

## 4. Data Model Changes

### 4a. LabelConfig extension

Add one field to the existing type:
```typescript
routeToLabel?: string;   // Destination label. Default: undefined (same as label).
```

### 4b. email_processing_state — replace `in_inbox_after` with richer columns

**Replace the original proposal of a single `in_inbox_after INTEGER` with two columns (EVA Review Point #3):**

```sql
ALTER TABLE email_processing_state ADD COLUMN routing_result TEXT;
ALTER TABLE email_processing_state ADD COLUMN routing_error TEXT;
```

**`routing_result`** — 3 states:
- `'filed'` — INBOX removed successfully
- `'in_inbox'` — routing was attempted or skipped, email still in inbox
- `NULL` — routing not attempted (no config, or legacy row)

**`routing_error`** — short string for forensics:
- `NULL` — no error
- `'gmail_rate_limit'` — 429 during routing
- `'gmail_api_error: <msg>'` — other Gmail error
- `'destination_label_failed'` — couldn't create/apply destination label
- `'confidence_skip'` — skipped due to low/invalid confidence + `keepInInboxOnUncertain`
- `'no_routing_config'` — label has no routing settings

This replaces the original `in_inbox_after INTEGER` proposal. Three states + error string gives complete forensics without vibes.

### 4c. Global settings

```
gmail.emailProcessing.defaultRouting = JSON string
gmail.emailProcessing.routingEnabled = "true" | "false"   ← KILL SWITCH
```

**`routingEnabled`** (EVA Review Point #7): Global toggle. When `false`, `applyRouting()` returns immediately without doing anything. Default: `true`. UI: prominent toggle at top of Labels tab. This is the panic button.

**`defaultRouting`** shape:
```json
{
  "removeFromInbox": false,
  "markReadOnFile": false,
  "keepInInboxOnUncertain": true
}
```

---

## 5. Backend Changes

### 5a. `applyRouting()` — full rewrite spec

**File:** `src/scheduler/email-processor.ts`

**New signature:**
```typescript
export async function applyRouting(
  threadId: string | undefined,
  account: string,
  labelName: string,
  confidence: string,
  labelConfig: LabelConfig,
): Promise<{ result: 'filed' | 'in_inbox'; error?: string }>
```

**New flow (safe ordering per spec):**

```
1. Check global kill switch (routingEnabled). If false → return { result: 'in_inbox', error: 'routing_disabled' }

2. Read label config for labelName
   If no removeFromInbox AND no markReadOnFile → return { result: 'in_inbox', error: 'no_routing_config' }

3. Check confidence
   If (low OR invalid) AND keepInInboxOnUncertain ≠ false → return { result: 'in_inbox', error: 'confidence_skip' }
   NOTE: This also applies to GLM 429 errors and parse failures (which set confidence = 'invalid')

4. If routeToLabel is set and differs from labelName:
   a. Check destination label exists (from cached label list)
   b. If not exists: attempt gog gmail labels create
   c. If create fails → return { result: 'in_inbox', error: 'destination_label_failed' }
   d. Apply destination label: modifyLabels({ add: routeToLabel })
   e. If apply fails → return { result: 'in_inbox', error: 'destination_label_failed' }

5. Build removal list
   toRemove = []
   if removeFromInbox → toRemove.push('INBOX')
   if markReadOnFile → toRemove.push('UNREAD')

6. Remove labels: modifyLabels({ remove: toRemove.join(',') })
   If fails → return { result: 'in_inbox', error: 'gmail_api_error: <msg>' }

7. Return { result: 'filed' }
```

**Critical safety invariant (EVA Review Point #2):**
- Steps execute in order. If ANY step fails, subsequent steps are SKIPPED.
- INBOX is only removed (step 6) if all prior steps succeeded.
- If step 6 fails, the email keeps its labels and stays in inbox.

**Partial success scenario (EVA Review Point #2):**
The dangerous case is: "remove INBOX succeeded but destination label failed." This CANNOT happen because destination label (step 4) runs BEFORE inbox removal (step 6). If step 4 fails, step 6 never executes.

The reverse (label applied but INBOX not removed) is safe — email is visible in both inbox and label.

### 5b. Update callers to use new return type

**Classification path (`processEmails`):**
```typescript
const routingResult = await applyRouting(threadId, account, label, confidence, labelConfig);
// UPDATE email_processing_state SET routing_result = ?, routing_error = ?, filed_at = ?
//   WHERE message_id = ? AND account = ?
// filed_at = routingResult.result === 'filed' ? datetime('now') : null
```

**Correction path (`correctLabel`):**
```typescript
const routingResult = await applyRouting(threadId, account, newLabel, 'high', labelConfig);
// Same UPDATE pattern
```

**Rule action path (`actionApplyLabel`):**
```typescript
const routingResult = await applyRouting(threadId, account, label, confidence, labelConfig);
// No DB update here (rule actions don't write to email_processing_state directly)
```

### 5c. New IPC: `gmailFileEmail` (EVA Review Point #4)

**Behavior:** Executes the same `applyRouting()` function. Not a separate code path.

```typescript
ipcMain.handle('gmail:fileEmail', async (_, messageId: string, account: string) => {
  // 1. Look up email_processing_state row
  // 2. Get effective label (corrected_label ?? label_applied)
  // 3. Read fresh labelConfig from settings
  // 4. Call applyRouting(threadId, account, label, 'high', labelConfig)
  //    'high' because user-initiated = always route (ignore confidence)
  // 5. Update routing_result, routing_error, filed_at
  // 6. Return { ok: boolean, result: 'filed' | 'in_inbox', error?: string }
});
```

Works identically for all three paths because it reads the current state and re-runs routing.

### 5d. New IPC: `gmailUnfileEmail` (EVA Review Point — "Restore to inbox")

```typescript
ipcMain.handle('gmail:unfileEmail', async (_, messageId: string, account: string) => {
  // 1. Look up thread_id from email_processing_state
  // 2. modifyLabels({ threadIds: [threadId], add: 'INBOX', account })
  // 3. Update routing_result = 'in_inbox', filed_at = null
  // 4. Return { ok: boolean }
});
```

---

## 6. Uncertain Handling (EVA Review Point #6)

**Non-negotiable rules:**

1. `keepInInboxOnUncertain` is `true` by default. Always.
2. It applies to ALL of these cases:
   - confidence = `'low'`
   - confidence = `'invalid'`
   - GLM 429 errors (which set confidence = `'invalid'`, fail_reason = `'batch_429'`)
   - JSON parse failures (confidence = `'invalid'`, fail_reason = `'json_parse_fail'`)
   - Label mismatch (confidence = `'invalid'`, fail_reason = `'label_mismatch'`)
   - Empty content (confidence = `'invalid'`, fail_reason = `'empty_content'`)
3. The UI states clearly next to the checkbox: **"Uncertain emails (low confidence, GLM errors) stay in inbox"**
4. This is checked in step 3 of the routing flow, before any Gmail calls are made.

---

## 7. UI/UX Changes

### 7a. Labels Tab — Global controls (top of tab)

```
┌──────────────────────────────────────────────────────────────┐
│ Email Routing                                         [ON ●] │  ← kill switch
│                                                              │
│ Default for new labels:                                      │
│   ☐ Archive from Inbox  ☐ Mark read  ☑ Keep uncertain       │
│   [Apply to all unconfigured]                                │
│                                                              │
│ Bulk routing:                                                │
│   [Select labels...▼]  ☐ Archive  ☐ Mark read  [Apply]      │
└──────────────────────────────────────────────────────────────┘
```

**Kill switch** (EVA Review Point #7): Toggle for `routingEnabled`. Red/green. When OFF, no routing runs anywhere. Toast confirms: "All routing disabled."

### 7b. Labels Tab — Per-label routing section

```
Routing
  Destination: [🔍 Same as label          ▼]   ← searchable dropdown
  ☐ Archive from Inbox
  ☐ Mark as read when filed
  ☑ Keep in Inbox when uncertain (low confidence, GLM errors)
  [Reset to defaults]
```

**Destination dropdown (EVA Review Point #5):**
- Searchable typeahead (`<input>` with filtered `<datalist>` or custom dropdown)
- First option: "Same as label" (default)
- Lists ALL user labels from `epAllLabels`, sorted alphabetically
- Includes a "Reset to default" link that clears `routeToLabel`

### 7c. History Tab — Routing result column

**Replace the current implicit badge with an explicit 3-state indicator (EVA Review Point #3):**

| `routing_result` | `routing_error` | Badge | Action |
|---|---|---|---|
| `'filed'` | null | `Filed` (purple) | `[Restore ↑]` button |
| `'in_inbox'` | null | `In Inbox` (gray) | `[File ↓]` button (if routing configured) |
| `'in_inbox'` | non-null | `Routing failed` (red) | `[Retry ↓]` button |
| `NULL` | null | (no badge) | — |

**"Routing failed" badge** shows error on hover tooltip (e.g., "gmail_rate_limit", "destination_label_failed").

**Button behavior:**
- `[File ↓]` — calls `gmailFileEmail`. On success: badge → "Filed", toast "Filed to [label]". On failure: toast with error.
- `[Retry ↓]` — same call as "File now". Same behavior.
- `[Restore ↑]` — calls `gmailUnfileEmail`. On success: badge → "In Inbox", toast "Restored to inbox".

---

## 8. Telegram Interaction Flows

No Telegram changes. Routing is Gmail-side. Notifications (`notify: true`) fire BEFORE routing, so users always see important emails in Telegram even if they get filed.

---

## 9. GLM Prompt Design

No GLM changes. GLM classifies. Routing is deterministic. Separation is intentional.

---

## 10. Failure Scenarios and Recovery (EVA Review Points #2, #8)

### Scenario 1: Gmail rate limit mid-routing (429)
- **Result:** Email remains in inbox
- **DB state:** `routing_result = 'in_inbox'`, `routing_error = 'gmail_rate_limit'`
- **UI:** Badge "Routing failed", tooltip "gmail_rate_limit"
- **Recovery:** `[Retry ↓]` button. Next scheduled run will NOT retry (email already has AI/Processed). User must click Retry or wait for next correction.

### Scenario 2: Partial success — destination label applied, INBOX removal failed
- **Result:** Email visible in BOTH inbox and destination label (safe — not hidden)
- **DB state:** `routing_result = 'in_inbox'`, `routing_error = 'gmail_api_error: ...'`
- **Recovery:** `[Retry ↓]` button. `applyRouting()` is idempotent — re-adding destination label is harmless, re-removing INBOX will complete the operation.

### Scenario 3: Partial success — INBOX removed, destination label NOT applied
- **CANNOT HAPPEN.** Destination label (step 4) runs before INBOX removal (step 6). If step 4 fails, step 6 is skipped. This is the critical safety invariant.

### Scenario 4: Confidence is low/invalid/GLM error
- **Result:** Routing skipped by design
- **DB state:** `routing_result = 'in_inbox'`, `routing_error = 'confidence_skip'`
- **UI:** "In Inbox" badge. No action button (routing didn't fail, it was correctly skipped).
- **Recovery:** User corrects label → correction runs with `'high'` confidence → email gets filed.

### Scenario 5: Rule chain + routing loop
- **Prevention:** Chain depth cap = 3 (already implemented). Routing runs once per label application. No re-trigger.
- **Idempotency:** Removing INBOX twice is harmless. Adding same label twice is harmless.

### Scenario 6: App crash mid-routing
- **State:** Label may be applied, INBOX may or may not be removed
- **DB state:** `routing_result` and `filed_at` not yet written (crash before DB update)
- **Recovery:** Row shows no routing badge (NULL). User can click `[File ↓]` to complete. Idempotent — safe to re-run.

### Scenario 7: Misrouting configuration (too aggressive filing)
- **Detection:** User notices emails disappearing from inbox
- **Recovery:**
  1. **Kill switch** — disable all routing instantly (top of Labels tab)
  2. **"Show last 50 filed"** — History tab already shows Filed badge, sort/filter by filed_at
  3. **"Restore to inbox"** — per-row button to re-add INBOX
  4. **Per-label reset** — "Reset to defaults" link clears routing config for that label

---

## 11. Assumptions, Trade-offs, and Risks

### Assumptions
1. `gog gmail labels modify --remove INBOX` works for archiving (confirmed)
2. Users want label-level routing config, not per-email
3. Both classification label AND destination label remain on the email (audit trail)
4. `routeToLabel` is a power-user feature — most will use "same as label"

### Trade-offs

| Decision | Alternative | Why |
|----------|-------------|-----|
| Both labels kept | Replace classification label with destination | Audit trail. User can see what GLM classified AND where it was filed |
| 3-state `routing_result` TEXT | Boolean `in_inbox_after` | EVA required 3 states + error. TEXT is more expressive |
| Kill switch as global setting | No kill switch | EVA required panic toggle. Non-negotiable |
| `[Restore ↑]` per row | Bulk restore | Per-row is safer. Bulk restore added in Phase 4 if needed |

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| User enables Archive on all labels, misses email | Medium | High | `keepInInboxOnUncertain` default ON. Notifications fire before routing. Kill switch. |
| Gmail rate limit on batch routing | Low | Medium | `withRetry()` + concurrency limits. Max 1 extra call per email |
| Circular routeToLabel (A→B, B→A) | Very low | Low | Routing runs once per classification. No re-trigger |

---

## 12. Phased Execution Plan

### Phase 1: Observability + Kill Switch
**Checkpoint: can see 3-state routing result in History, can disable routing globally**

| File | Change |
|------|--------|
| `src/scheduler/email-processor.ts` | Add `routing_result` + `routing_error` columns. Update `applyRouting()` return type. Set columns after all routing calls. Add global kill switch check. |
| `ui/settings.html` | History: 3-state badge (Filed / In Inbox / Routing failed). Labels tab: kill switch toggle at top. |

### Phase 2: Manual Filing + Retry + Restore
**Checkpoint: can File, Retry, and Restore from History rows**

| File | Change |
|------|--------|
| `src/scheduler/email-processor.ts` | Export `fileEmail()` and `unfileEmail()` functions |
| `src/main/index.ts` | Add `gmail:fileEmail` and `gmail:unfileEmail` IPC handlers |
| `src/main/preload.ts` | Expose bridges |
| `ui/settings.html` | `[File ↓]` / `[Retry ↓]` / `[Restore ↑]` buttons per History row |

### Phase 3: Destination Label
**Checkpoint: can route classification label A into folder B**

| File | Change |
|------|--------|
| `src/scheduler/email-processor.ts` | `routeToLabel` in LabelConfig. Update `applyRouting()` step 4 (apply destination, create if missing). |
| `ui/settings.html` | Searchable destination dropdown in per-label routing section |

### Phase 4: Bulk Controls + Defaults
**Checkpoint: can configure routing for many labels at once**

| File | Change |
|------|--------|
| `ui/settings.html` | Default routing row, bulk apply UI, "Apply to all unconfigured", per-label "Reset to defaults" |

**Between each phase: manual test + EVA review.**

---

## 13. Scope Boundary

**In scope:** Everything above.

**Out of scope — needs separate design docs:**

| Topic | Why separate |
|-------|-------------|
| Label classification quality (positive/negative definitions, examples) | Already partially implemented. Affects GLM prompt, not routing. |
| Searchable label picker everywhere | UX improvement across all label dropdowns, not routing-specific |
| Unanswered email command center | Different feature: "needs reply" triage, draft actions, remind later |
| Telegram inbox triage mode | Conversational filing flow, different interaction model |
| GLM prompt template changes for negative guidance | Classification quality, not routing |

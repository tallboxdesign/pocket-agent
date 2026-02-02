# Design: Label Definition Fields & Searchable Label Pickers

**Status:** Draft for EVA Review
**Author:** (auto-generated)
**Date:** 2026-02-02
**Branch:** `my-voice-features`

---

## 1. Executive Summary

Two improvements to email processing label management:

**Part A -- Label Definition Fields.** Add `positiveTextExamples` and `negativeTextExamples` arrays to `LabelConfig`. These are short concrete phrases (e.g., "guest post request", "link placement offer") that complement the existing free-text `definition` and `negative` paragraph fields. The GLM prompt includes all six fields per label. The UI adds two pill-list inputs per label card between the existing Definition textarea and the Advanced section.

**Part B -- Searchable Label Pickers.** Replace every `<select>` label dropdown in the app with a single reusable picker component. The picker has a search input, three sections (Recent / Frequent / All), keyboard navigation (arrows, Enter, Escape), and click-outside-to-close. It applies to: the History correction popover, rule editor condition values (label_is, label_is_not), and rule editor action configs (apply_label, remove_label).

Both changes are additive. No existing data is deleted. Existing label configs with only `definition`/`negative` continue to work unchanged.

---

## 2. What Exists vs. What Is New

### Existing (with file paths and line numbers)

| Component | File | Lines | Description |
|---|---|---|---|
| `LabelConfig` type | `src/scheduler/email-processor.ts` | 31--40 | `Record<string, { notify?, description?, definition?, negative?, examples?, removeFromInbox?, markReadOnFile?, keepInInboxOnUncertain? }>` |
| `buildLabelList()` | `src/scheduler/email-processor.ts` | 217--236 | Builds `{ name, definition, negative }[]` from label config; fed to `buildGlmPrompt()` |
| `buildGlmPrompt()` | `src/scheduler/email-processor.ts` | 238--289 | Assembles GLM classification prompt. Per label: `Definition:` line, `NOT this label:` line, then few-shot email examples |
| Label card renderer | `ui/settings.html` | 3219--3313 | `epRenderLabels()` -- builds one card per label with: Classify checkbox, name, AI Defined badge, Notify checkbox, Definition textarea, Advanced toggle (examples pills, negative guidance textarea, routing checkboxes) |
| `epSetLabelDefinition()` | `ui/settings.html` | 3325--3330 | Saves definition text to config |
| `epSetLabelNegative()` | `ui/settings.html` | 3332--3336 | Saves negative guidance text to config |
| Correction popover | `ui/settings.html` | 3532--3651 | `epOpenCorrectPopover()` -- already has search input, grouped sections (Recent / Frequent / All), click-outside close. No keyboard nav. |
| `epBuildLabelOptions()` | `ui/settings.html` | 4261--4265 | Returns `<option>` HTML for label `<select>` dropdowns |
| Condition value builder | `ui/settings.html` | 4284--4314 | `epBuildConditionValueInput()` -- for `label` inputType returns `<select>` with `epBuildLabelOptions()` |
| Action config builder | `ui/settings.html` | 4343--4366 | `epBuildActionConfigInputs()` -- for `apply_label`/`remove_label` returns `<select>` with `epBuildLabelOptions()` |
| `getLabelStats()` | `src/scheduler/email-processor.ts` | 1161--1168 | SQL query: `COALESCE(corrected_label, label_applied)`, count, MAX(processed_at) as lastUsed |
| `gmailGetLabelStats` preload | `src/main/preload.ts` | 107, 311 | IPC bridge exposing `getLabelStats` to renderer |
| `email_processing_state` table | `src/scheduler/email-processor.ts` | 494--509 | Columns: account, message_id, thread_id, internal_date_ms, subject, sender, label_applied, confidence, processed_at, glm_raw, fail_reason, corrected_label, corrected_at, snippet, filed_at, routing_result, routing_error |

### New

| Change | Location | Description |
|---|---|---|
| Two new fields on `LabelConfig` | `src/scheduler/email-processor.ts` L31--40 | `positiveTextExamples: string[]`, `negativeTextExamples: string[]` |
| Extend `buildLabelList()` return type | `src/scheduler/email-processor.ts` L217--236 | Add `positiveTextExamples` and `negativeTextExamples` to the returned objects |
| Extend `buildGlmPrompt()` | `src/scheduler/email-processor.ts` L238--289 | Emit `Positive examples:` and `Negative examples:` lines per label |
| Pill-list inputs in label card | `ui/settings.html` L3276--3283 | Two new `<input> + pill list` blocks between Definition textarea and Advanced toggle |
| `epAddTextExample()` / `epRemoveTextExample()` | `ui/settings.html` (new functions) | Add/remove items from positiveTextExamples or negativeTextExamples |
| Cross-label conflict warning | `ui/settings.html` (new function) | `epCheckTextExampleConflicts()` -- warn if same phrase in positive of one label and negative of another |
| Reusable label picker component | `ui/settings.html` (new function) | `epOpenLabelPicker(anchorEl, options)` -- replaces all `<select>` label dropdowns |
| Replace popover label list | `ui/settings.html` L3532--3651 | Refactor `epOpenCorrectPopover()` to use `epOpenLabelPicker()` |
| Replace rule editor dropdowns | `ui/settings.html` L4284--4314, 4343--4366 | `epBuildConditionValueInput()` and `epBuildActionConfigInputs()` use picker instead of `<select>` |
| `ep_recent_labels` localStorage key | `ui/settings.html` (new) | Array of last 5 selected labels, updated on every picker selection |

---

## 3. Schema Changes & Migration

### 3a. LabelConfig Type Change (in-memory, persisted as JSON string in settings)

```typescript
// src/scheduler/email-processor.ts lines 31-40
// BEFORE:
type LabelConfig = Record<string, {
  notify?: boolean;
  description?: string;
  definition?: string;
  negative?: string;
  examples?: Array<string | { messageId: string; subject?: string; from?: string }>;
  removeFromInbox?: boolean;
  markReadOnFile?: boolean;
  keepInInboxOnUncertain?: boolean;
}>;

// AFTER:
type LabelConfig = Record<string, {
  notify?: boolean;
  description?: string;
  definition?: string;
  negative?: string;
  positiveTextExamples?: string[];    // NEW
  negativeTextExamples?: string[];    // NEW
  examples?: Array<string | { messageId: string; subject?: string; from?: string }>;
  removeFromInbox?: boolean;
  markReadOnFile?: boolean;
  keepInInboxOnUncertain?: boolean;
}>;
```

### 3b. Migration

**No SQLite migration required.** `LabelConfig` is stored as a JSON string in the settings store under key `gmail.emailProcessing.labelConfig`. The new fields are optional arrays that default to `[]` when absent. Existing configs load unchanged -- `cfg.positiveTextExamples || []` returns `[]` for old data.

**No data loss risk.** Fields are additive. The old `definition` and `negative` paragraph fields remain. `description` (legacy) remains for backward compat.

---

## 4. Backend Spec

### 4a. Extended `buildLabelList()` Return Type

```
File: src/scheduler/email-processor.ts
Current line: 217
```

```typescript
// BEFORE return type:
{ name: string; definition: string; negative: string }[]

// AFTER return type:
{
  name: string;
  definition: string;
  negative: string;
  positiveTextExamples: string[];
  negativeTextExamples: string[];
}[]
```

**Updated function body:**
```typescript
function buildLabelList(
  allLabels: unknown[],
  labelConfig: LabelConfig,
): { name: string; definition: string; negative: string; positiveTextExamples: string[]; negativeTextExamples: string[] }[] {
  const items: { name: string; definition: string; negative: string; positiveTextExamples: string[]; negativeTextExamples: string[] }[] = [];
  for (const l of allLabels) {
    const lObj = l as Record<string, unknown>;
    const name = String(lObj.name || lObj.label || l || '').trim();
    if (!name) continue;
    if (lObj.type === 'system') continue;
    const cfg = labelConfig[name];
    items.push({
      name,
      definition: cfg?.definition || cfg?.description || '',
      negative: cfg?.negative || '',
      positiveTextExamples: cfg?.positiveTextExamples || [],
      negativeTextExamples: cfg?.negativeTextExamples || [],
    });
  }
  return items;
}
```

### 4b. Extended `buildGlmPrompt()` Signature & Prompt Output

```
File: src/scheduler/email-processor.ts
Current line: 238
```

```typescript
function buildGlmPrompt(
  allowed: { name: string; definition: string; negative: string; positiveTextExamples: string[]; negativeTextExamples: string[] }[],
  examplesByLabel: Record<string, FullEmail[]>,
  batch: FullEmail[],
  reviewLabel: string,
): string {
  // ... existing preamble unchanged ...

  for (const l of allowed) {
    lines.push(`## ${l.name}`);
    if (l.definition) lines.push(`Definition: ${l.definition}`);
    if (l.positiveTextExamples.length > 0) {
      lines.push(`Positive examples: ${l.positiveTextExamples.map(e => `"${e}"`).join(', ')}`);
    }
    if (l.negativeTextExamples.length > 0) {
      lines.push(`Negative examples: ${l.negativeTextExamples.map(e => `"${e}"`).join(', ')}`);
    }
    if (l.negative) lines.push(`NOT this label: ${l.negative}`);
    lines.push('');
  }

  // ... rest unchanged ...
}
```

**Prompt output per label (example):**
```
## Guest Posts
Definition: Emails requesting guest posts or link placements on our blog
Positive examples: "guest post request", "link placement offer", "write for us"
Negative examples: "SEO audit report", "press release announcement"
NOT this label: SEO service offers, press release announcements
```

**Priority rule (already in preamble at L253):** "Negative guidance takes priority. If an email matches a label's negative guidance, do NOT assign that label." This existing rule covers both `negativeTextExamples` and `negative` paragraph. No preamble change needed -- the negative examples line appears before the `NOT this label:` line, reinforcing the negative signal.

### 4c. No New IPC Handlers

All data flows through the existing `gmail.emailProcessing.labelConfig` settings key. No new IPC channels required. The `getLabelStats()` query at L1161--1168 already returns the data the picker needs for the Frequent section.

---

## 5. UI Wireframes (ASCII)

### 5a. Label Card -- Extended Fields

```
+-----------------------------------------------------------------------+
| [ ] Classify    Guest Posts    [AI Defined]              [ ] Notify    |
|-----------------------------------------------------------------------|
| Definition                                          [AI Define]       |
| +-------------------------------------------------------------------+ |
| | Emails requesting guest posts or link placements on our blog      | |
| +-------------------------------------------------------------------+ |
|                                                                       |
| Positive text examples              (phrases that ARE this label)     |
| +-------------------------------------------------------------------+ |
| | [guest post request x] [link placement offer x] [write for us x] | |
| | [________________________________] <-- type + Enter to add         | |
| +-------------------------------------------------------------------+ |
|                                                                       |
| Negative text examples              (phrases that are NOT this label) |
| +-------------------------------------------------------------------+ |
| | [SEO audit report x] [press release x]                           | |
| | [________________________________] <-- type + Enter to add         | |
| +-------------------------------------------------------------------+ |
|                                                                       |
| > Advanced (examples, negative guidance & routing)                    |
|   [collapsed by default -- same as current]                           |
+-----------------------------------------------------------------------+
```

**States:**

1. **Empty state** -- No pills, placeholder text in input: "Type a phrase and press Enter"
2. **With pills** -- Pills wrap; input stays at end
3. **Conflict warning** -- If "SEO audit report" is in positiveTextExamples of label A and negativeTextExamples of label B, show yellow banner:

```
+-------------------------------------------------------------------+
| Warning: "SEO audit report" is also a positive example in         |
| [Label A]. This may cause classification conflicts.               |
+-------------------------------------------------------------------+
```

### 5b. Searchable Label Picker Component

Replaces all `<select>` label dropdowns. Rendered as a positioned popover anchored to a trigger element.

```
Trigger (button or styled input):
+----------------------------+
| Guest Posts            v   |
+----------------------------+

Picker popover (appears on click):
+----------------------------+
| [Search labels...      ]   |
|----------------------------|
| RECENT                     |
|   Clients                  |
|   Guest Posts        <--   |  <-- highlighted (keyboard)
|   Newsletters              |
|----------------------------|
| FREQUENT                   |
|   AI/Review                |
|   Clients                  |
|   Spam Reports             |
|----------------------------|
| ALL LABELS                 |
|   Accounting               |
|   Ads                      |
|   ...                      |
|   [Show all (47 more)]     |
|----------------------------|
| + Create new label...      |
+----------------------------+
```

**States:**

1. **Default** -- All three sections visible. If All Labels > 20, show first 10 + "Show all (N more)" toggle.
2. **Searching** -- Sections collapse; matching labels across all sections shown flat, deduplicated. No matches: "No matching labels" message.
3. **Keyboard focus** -- Arrow up/down moves highlight across all visible items (skips section headers). Enter confirms selection. Escape closes picker without change.
4. **Selection** -- Highlighted item has `background: var(--bg-hover)`. Current value (if any) shown with a checkmark prefix.
5. **Create new** -- Last item always "Create new label...". Clicking opens inline text input (same as current popover behavior at L3655--3658).

### 5c. Picker in Rule Editor (Condition)

```
BEFORE:
+---------+--+--------------------------+--+---+
| Label is v || [<select> dropdown]      v ||[x]|
+---------+--+--------------------------+--+---+

AFTER:
+---------+--+--------------------------+--+---+
| Label is v || Guest Posts            v ||[x]|
+---------+--+--------------------------+--+---+
                |                          |
                | [Search labels...      ] |
                | RECENT                   |
                |   ...                    |
                | FREQUENT                 |
                |   ...                    |
                | ALL LABELS               |
                |   ...                    |
                +--------------------------+
```

The styled trigger replaces `<select class="ep-cond-value">`. On click, the picker popover opens below the trigger. On selection, the trigger text updates and the hidden value is stored.

### 5d. Picker in Rule Editor (Action)

Same pattern. For `apply_label` and `remove_label` actions, the `<select class="ep-action-config" data-key="label">` becomes a picker trigger + hidden input.

---

## 6. Failure Scenarios & Recovery

| Scenario | Impact | Recovery |
|---|---|---|
| **Existing config missing new fields** | `positiveTextExamples`/`negativeTextExamples` are `undefined` | All code uses `cfg.positiveTextExamples \|\| []`. No crash. Prompt simply omits those lines. |
| **User adds same phrase to positive AND negative on same label** | Contradictory signal to GLM | UI prevents this: `epAddTextExample()` checks if the phrase already exists in the opposite array on the same label and shows an error toast. |
| **Cross-label conflict (phrase in positive of A, negative of B)** | GLM receives valid but conflicting signal | Yellow warning banner shown in UI (non-blocking). GLM handles via existing priority rule -- negative guidance wins. |
| **Extremely long text example phrase** | Could bloat GLM prompt | Enforce max 100 characters per phrase in UI. Silently truncate in `buildGlmPrompt()`. |
| **Too many text examples per label** | GLM prompt token overflow | Cap at 20 per array in UI. In `buildGlmPrompt()`, take first 20 only. |
| **Label picker fails to load label stats (IPC error)** | Frequent/Recent sections empty | Fall through to All Labels section (uses `epGmailLabels` already loaded). Show all alphabetically. |
| **Label picker: `epGmailLabels` empty AND stats empty** | Picker has nothing to show | Show message: "No labels available. Fetch labels from Gmail first." Same behavior as current `epBuildLabelOptions()` L4263. |
| **localStorage `ep_recent_labels` corrupted** | Recent section fails | Wrap JSON.parse in try/catch, fall back to `[]`. |
| **User presses Enter in search with no highlighted item** | Could submit empty selection | If no item is highlighted, Enter does nothing. Selection only fires on explicit highlight + Enter or click. |
| **Picker opened near bottom edge of viewport** | Popover clipped | Same positioning logic as `epOpenCorrectPopover()` L3622--3638: prefer below, flip above if insufficient space, clamp to viewport. |

---

## 7. Phased Execution with Checkpoints

### Phase 1: Data Model & Backend (no UI changes)

**Steps:**
1. Add `positiveTextExamples?: string[]` and `negativeTextExamples?: string[]` to `LabelConfig` type (L31--40)
2. Extend `buildLabelList()` return type and body (L217--236)
3. Extend `buildGlmPrompt()` to emit new lines (L238--289)
4. Run `npm run typecheck && npm run lint`

**Checkpoint:** All existing tests pass. Manual verification: run email processing with existing config (no text examples) -- prompt output unchanged (empty arrays produce no lines).

### Phase 2: Label Card UI -- Text Example Fields

**Steps:**
1. Add `epAddTextExample(labelName, field, value)` function -- pushes to `positiveTextExamples` or `negativeTextExamples`, saves config, re-renders
2. Add `epRemoveTextExample(labelName, field, index)` function -- splices array, saves, re-renders
3. Add `epCheckTextExampleConflicts(labelName, field, phrase)` -- scans all labels for cross-conflicts, returns array of conflicts
4. Modify `epRenderLabels()` (L3241--3313) -- insert two pill-list blocks after the Definition textarea and before the Advanced toggle
5. Run `npm run typecheck && npm run lint`

**Checkpoint:** Label cards show new fields. Adding/removing pills works. Cross-label conflicts show warning. Existing email processing picks up text examples in the next run.

### Phase 3: Reusable Label Picker Component

**Steps:**
1. Implement `epOpenLabelPicker(anchorEl, { onSelect, current, account })` function:
   - Creates popover DOM (search input + grouped list)
   - Fetches label stats via `window.pocketAgent.gmailGetLabelStats(account)`
   - Reads `ep_recent_labels` from localStorage
   - Wires search, keyboard nav, click-outside close
   - Calls `onSelect(labelName)` on selection, updates `ep_recent_labels`
2. Add CSS styles for `.ep-label-picker`, `.ep-label-picker-trigger`, `.ep-label-picker-group`, `.ep-label-picker-item`
3. Run `npm run typecheck && npm run lint`

**Checkpoint:** `epOpenLabelPicker()` can be called standalone from console with a test anchor element. All three sections render. Keyboard nav works. Search filters correctly.

### Phase 4: Replace Existing Dropdowns with Picker

**Steps:**
1. Refactor `epOpenCorrectPopover()` (L3532--3651) to use `epOpenLabelPicker()` internally for the label list portion. Keep the "Use as training example" checkbox and Save/Cancel buttons.
2. Replace `epBuildConditionValueInput()` label case (L4288--4289) -- instead of `<select>`, render a picker trigger `<div>` + hidden `<input class="ep-cond-value">`. Wire onclick to `epOpenLabelPicker()`.
3. Replace `epBuildActionConfigInputs()` apply_label/remove_label case (L4348--4350) -- same pattern: picker trigger + hidden `<input class="ep-action-config" data-key="label">`.
4. Update `epCollectConditions()` and `epCollectActions()` (rule save logic) to read from hidden inputs instead of `<select>` elements.
5. Remove `epBuildLabelOptions()` function (L4261--4265) once no callers remain. Also remove the label `<select>` in `epPopulateFilterLabels()` (L3712--3728) for the history filter if desired (optional -- could remain as a simple dropdown since it is a different use case).
6. Run `npm run typecheck && npm run lint`

**Checkpoint:** All four picker locations work. Rule editor saves/loads correctly. Correction popover saves corrections. No regressions in email processing.

---

## 8. Verification Checklist

### Data Model

- [ ] `LabelConfig` type includes `positiveTextExamples?: string[]` and `negativeTextExamples?: string[]`
- [ ] Existing configs without new fields load without error (defaults to `[]`)
- [ ] `buildLabelList()` returns objects with new fields populated from config
- [ ] `buildGlmPrompt()` emits `Positive examples:` and `Negative examples:` lines only when arrays are non-empty
- [ ] `buildGlmPrompt()` output with empty arrays is identical to current output (no blank lines)
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes

### Label Card UI

- [ ] Positive text examples pill list renders between Definition and Advanced toggle
- [ ] Negative text examples pill list renders below positive, above Advanced toggle
- [ ] Typing a phrase + Enter adds a pill
- [ ] Clicking X on a pill removes it
- [ ] Empty input + Enter does nothing
- [ ] Duplicate phrase in same array shows error toast, does not add
- [ ] Same phrase in positive AND negative on same label is rejected with error toast
- [ ] Cross-label conflict (positive in A, negative in B) shows yellow warning banner
- [ ] Phrase truncated at 100 characters
- [ ] Max 20 phrases per array enforced in UI
- [ ] Pill list wraps correctly at card width
- [ ] Labels with no text examples render identically to current (no empty sections)
- [ ] Helper text visible below each input field

### GLM Classification

- [ ] Email processing run with text examples produces correct prompt format
- [ ] Email processing run without text examples produces identical prompt to current
- [ ] Classification accuracy with text examples is equal or better (manual spot check)

### Label Picker Component

- [ ] Picker opens on trigger click, positioned below (or above if near bottom)
- [ ] Search input is auto-focused on open
- [ ] Typing filters labels across all sections in real time (debounced)
- [ ] Recent section shows last 5 from localStorage `ep_recent_labels`
- [ ] Frequent section shows top 5 by count from `getLabelStats()`
- [ ] All Labels section shows remaining labels alphabetically
- [ ] Labels appearing in Recent or Frequent are deduplicated from All Labels
- [ ] "Show all" toggle appears when All Labels > 20
- [ ] Arrow down moves highlight to next item (skips section headers)
- [ ] Arrow up moves highlight to previous item
- [ ] Enter on highlighted item selects it and closes picker
- [ ] Escape closes picker without selection
- [ ] Click outside closes picker without selection
- [ ] Selected label updates trigger display text
- [ ] Selection updates `ep_recent_labels` in localStorage (most recent first, max 5)
- [ ] "Create new label..." option appears at bottom
- [ ] Current value (if any) shown with checkmark prefix
- [ ] Empty label list shows "No labels available" message

### Picker Integration -- Correction Popover

- [ ] Correction popover uses picker for label selection
- [ ] "Use as training example" checkbox still works
- [ ] Save button applies correction via `gmailCorrectLabel`
- [ ] Cancel button closes without changes
- [ ] History table updates after correction

### Picker Integration -- Rule Editor Conditions

- [ ] `label_is` condition uses picker instead of `<select>`
- [ ] `label_is_not` condition uses picker instead of `<select>`
- [ ] Switching condition type away from label clears picker, shows correct input
- [ ] Switching condition type to label shows picker trigger with current value
- [ ] Saved rule loads with correct label displayed in picker trigger
- [ ] Rule test results display correctly with picker-selected labels

### Picker Integration -- Rule Editor Actions

- [ ] `apply_label` action uses picker instead of `<select>`
- [ ] `remove_label` action uses picker instead of `<select>`
- [ ] Switching action type preserves/clears config correctly
- [ ] Saved rule loads with correct label in action config
- [ ] Rule execution applies correct label (end-to-end)

### Regression

- [ ] Email processing runs complete without error
- [ ] Label card Classify/Notify checkboxes still work
- [ ] AI Define button still works for definition and negative fields
- [ ] Email example pills (few-shot) still add/remove correctly
- [ ] Routing checkboxes still save correctly
- [ ] History filtering by label still works
- [ ] `npm run test` passes
- [ ] `npm run typecheck && npm run lint` passes

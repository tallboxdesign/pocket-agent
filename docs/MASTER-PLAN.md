# Pocket Agent: Master Plan — Multi-Agent Orchestration System

**Created:** 2026-01-30
**Last Updated:** 2026-01-30
**Status:** PLANNING — Not yet implemented
**Architecture:** CEO (User) → Manager (Pocket Agent/Claude) → Workers (Claude CLI instances) + GLM-4.7 (utility model)

---

## Table of Contents

1. [GLM 4.7 Integration](#1-glm-47-integration)
2. [Universal Heartbeat System](#2-universal-heartbeat-system)
3. [Claude CLI Worker Spawning](#3-claude-cli-worker-spawning)
4. [Task Scheduling (Overnight Builds)](#4-task-scheduling-overnight-builds)
5. [Daily Summary Generation](#5-daily-summary-generation)
6. [Enhanced Activity Tracking & Token Counting](#6-enhanced-activity-tracking--token-counting)
7. [Session Continuity & Context Recovery](#7-session-continuity--context-recovery)
8. [Gmail Integration](#8-gmail-integration)
9. [Auto-Task Recording (General Inbox)](#9-auto-task-recording-general-inbox)
10. [Project Folder Manager](#10-project-folder-manager)
11. [Task Detail Panel Improvements](#11-task-detail-panel-improvements)
12. [Actor Tracking & Audit Trail](#12-actor-tracking--audit-trail)
13. [Tag & Assignee System](#13-tag--assignee-system)
14. [Project Selector in New Task Modal](#14-project-selector-in-new-task-modal)

---

## Current State (What Already Exists)

| Component | Status | Details |
|-----------|--------|---------|
| Zhipu API key setting | Config only | `settings/index.ts` line 99 — field exists, never used |
| Kanban activity log | Full tracking | `kanban_activity_log` table — logs all task mutations with actor, old/new values |
| Daily logs | Exists | `daily_logs` table — appends `[HH:MM] entry` per day |
| Message history | Full | `messages` table — all conversations persisted per session |
| Facts & embeddings | Full | `facts` + `chunks` tables with vector search |
| Scheduler | Full infrastructure | `cron_jobs` table — cron/at/every types, tracks last_status/error/duration |
| Sessions | Multi-session | `sessions` table — named sessions with message isolation |
| Rolling summaries | Exists | Context compression for long conversations |
| Approval workflow | Full | pending/approved/rejected with feedback, logged to activity |

---

## 1. GLM 4.7 Integration

### What
Use Zhipu AI **GLM-4.7** (z.ai) as a lightweight utility model for:
- Summarization (daily summaries, log processing)
- Email classification and labeling
- Periodic log review and compression
- Routine processing that doesn't need Claude's intelligence

Claude remains the primary agent/manager. GLM handles cheap background tasks.

### Current State
- API key field exists in settings UI (`ui/settings.html` line 1105)
- Setting defined in `src/settings/index.ts` line 99
- **Never actually called** — no API client exists

### Implementation

#### 1.1 Create GLM Client — `src/agent/glm-client.ts`
```typescript
// Zhipu AI GLM-4.7 API client
// Endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions
// Model: glm-4-0520 (verify exact ID for GLM-4.7)
// Auth: API key from settings (zhipu.apiKey)

export interface GLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GLMOptions {
  model?: string;        // default: GLM-4.7 model ID
  temperature?: number;  // default: 0.3 for summaries
  max_tokens?: number;   // default: 2048
}

export interface GLMResult {
  content: string;
  tokensUsed: { prompt: number; completion: number; total: number };
}

export async function callGLM(messages: GLMMessage[], options?: GLMOptions): Promise<GLMResult>
export async function summarizeWithGLM(text: string, prompt?: string): Promise<GLMResult>
export async function classifyWithGLM(text: string, categories: string[]): Promise<GLMResult>
```

#### 1.2 GLM is a Utility, Not a Provider
- GLM is NOT a primary agent provider — it's called by the manager and scheduled jobs
- The main agent (Claude) delegates lightweight tasks to GLM
- Every GLM call is logged to `event_log` with token counts

#### 1.3 Agent Tools — `src/tools/glm-tools.ts`
```typescript
// Tool: glm_summarize — Summarize text using GLM (saves Claude tokens)
// Tool: glm_classify — Classify text into categories
// Tool: glm_process — Generic GLM processing with custom prompt
```

### Files to Create/Modify
- CREATE: `src/agent/glm-client.ts`
- CREATE: `src/tools/glm-tools.ts`
- MODIFY: `src/agent/index.ts` — register GLM tools
- MODIFY: `src/settings/index.ts` — update setting description to "GLM-4.7"

---

## 2. Universal Heartbeat System

### What
The heartbeat is NOT just for Kanban. It's a **universal progress monitor** that activates whenever ANY work is running:
- Worker building something → heartbeat pings progress to Telegram
- Agent processing a complex task → heartbeat reports status
- Scheduled job running → heartbeat monitors completion
- Any active task → heartbeat pings at crucial moments

When nothing is running, the heartbeat is silent.

### How It Works

```
Continuous loop (configurable interval):
  1. Check: are there any active workers running?
  2. Check: are there any scheduled jobs executing?
  3. Check: is the agent currently processing something?
  4. If ANY work is active:
     a. Collect progress from all active work
     b. Update the relevant Kanban cards with progress
     c. At crucial moments (start, milestone, completion, error) → ping Telegram
     d. Log heartbeat to event_log and daily_logs
  5. If no work active → silent
```

### Crucial Moments That Trigger Pings
- Worker started (task X is now being built)
- Worker hit a milestone (50% through, first test passed, etc.)
- Worker completed successfully
- Worker failed with error
- Task has been in progress for too long (stale)
- Scheduled task is about to execute
- Something needs user approval

### Implementation

#### 2.1 Heartbeat Service — `src/scheduler/heartbeat.ts`
```typescript
export class Heartbeat {
  private lastCheckAt: string;
  private interval: NodeJS.Timeout;

  start(intervalMs: number = 60000)  // Check every 60 seconds
  stop()

  private async check(): Promise<void>
  private async checkActiveWorkers(): Promise<HeartbeatUpdate[]>
  private async checkRunningJobs(): Promise<HeartbeatUpdate[]>
  private async checkStaleTasks(): Promise<HeartbeatUpdate[]>
  private async checkPendingReviews(): Promise<HeartbeatUpdate[]>
  private async notify(updates: HeartbeatUpdate[]): Promise<void>
  private async updateKanbanCards(updates: HeartbeatUpdate[]): Promise<void>
}
```

#### 2.2 Heartbeat Settings
- `heartbeat.enabled` — on/off (default: on)
- `heartbeat.intervalSeconds` — how often to check (default: 60)
- `heartbeat.quietHours` — e.g., "23:00-07:00" (no pings while sleeping)
- `heartbeat.channels` — telegram, desktop, both

### Files to Create/Modify
- CREATE: `src/scheduler/heartbeat.ts`
- MODIFY: `src/main/index.ts` — start heartbeat on app launch
- MODIFY: `src/settings/index.ts` — heartbeat settings
- MODIFY: `ui/settings.html` — heartbeat config UI

---

## 3. Claude CLI Worker Spawning

### What
The manager (Pocket Agent) spawns Claude Code CLI instances as workers to build websites, apps, fix bugs, etc. Each worker:
- Runs in a specific project directory
- Has a specific task from the Kanban
- Streams progress back to the manager
- Updates the Kanban card with results (via heartbeat)
- Everything is tracked: success, failure, rejection, duration, tokens used

### Architecture

```
User creates/schedules task → Manager picks it up
  → Spawns: claude --dangerously-skip-permissions -p "task prompt" --output-format json
  → Worker runs autonomously
  → Heartbeat monitors output, pings Telegram at crucial moments
  → Heartbeat updates Kanban card with progress
  → On completion: card updated, moved to review, user notified
  → On failure: error logged, card marked failed, user notified
```

### Implementation

#### 3.1 Worker Manager — `src/workers/index.ts`
```typescript
export interface WorkerConfig {
  taskId: number;              // Kanban task ID
  projectDir: string;          // Working directory (from project workspace_path)
  prompt: string;              // Task description for Claude CLI
  timeout?: number;            // Max execution time (default: 30 min)
  model?: string;              // Claude model to use
}

export interface WorkerStatus {
  id: string;                  // Unique worker ID
  taskId: number;
  projectId: number;
  pid: number;                 // Process ID
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  output: string;              // Accumulated output
  error?: string;
  exitCode?: number;
  tokensUsed?: number;         // Total tokens consumed
}

export class WorkerManager {
  private workers: Map<string, WorkerStatus>;

  async spawnWorker(config: WorkerConfig): Promise<string>
  async cancelWorker(workerId: string): Promise<void>
  getWorkerStatus(workerId: string): WorkerStatus | null
  getActiveWorkers(): WorkerStatus[]
  getWorkerHistory(): WorkerStatus[]

  private async onWorkerComplete(workerId: string, exitCode: number): Promise<void>
  private async updateKanbanTask(taskId: number, status: WorkerStatus): Promise<void>
  private async notifyUser(taskId: number, status: WorkerStatus): Promise<void>
}
```

#### 3.2 Worker Execution Database — `src/workers/history.ts`
```sql
CREATE TABLE IF NOT EXISTS worker_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT UNIQUE NOT NULL,
  task_id INTEGER REFERENCES kanban_tasks(id),
  project_id INTEGER REFERENCES kanban_projects(id),
  project_dir TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT DEFAULT 'claude-sonnet-4-20250514',
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','timeout','cancelled')),
  pid INTEGER,
  output TEXT,
  error TEXT,
  exit_code INTEGER,
  tokens_used INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
);

CREATE INDEX IF NOT EXISTS idx_worker_task ON worker_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_worker_status ON worker_executions(status);
CREATE INDEX IF NOT EXISTS idx_worker_project ON worker_executions(project_id);
```

#### 3.3 Kanban Integration
- New task field: `scheduled_at` — when to run this task
- New task field: `worker_id` — which worker is handling this
- New activity actions: `worker_started`, `worker_completed`, `worker_failed`
- New task status: `scheduled` (between todo and in_progress)

#### 3.4 Agent Tools — `src/tools/worker-tools.ts`
```typescript
// Tool: spawn_worker — Start a Claude CLI worker for a Kanban task
// Tool: check_worker — Get status of a running worker
// Tool: cancel_worker — Stop a running worker
// Tool: list_workers — List all active and recent workers
```

#### 3.5 UI — Kanban card worker indicator
- Show worker status badge on cards (spinner while running, check when done, X when failed)
- Click to see worker output/logs
- "Schedule" button on task detail panel

### Files to Create/Modify
- CREATE: `src/workers/index.ts` — WorkerManager
- CREATE: `src/workers/history.ts` — worker execution DB
- CREATE: `src/tools/worker-tools.ts` — agent tools
- MODIFY: `src/kanban/index.ts` — add scheduled_at, worker_id fields
- MODIFY: `src/main/index.ts` — initialize WorkerManager
- MODIFY: `src/agent/index.ts` — register worker tools
- MODIFY: `ui/kanban.html` — schedule button, worker status badges

---

## 4. Task Scheduling (Overnight Builds)

### What
User can schedule specific Kanban tasks to run at specific times (e.g., overnight at 2 AM). The manager picks up scheduled tasks, spawns workers, and has results ready by morning.

### How It Works

```
User opens task → Clicks "Schedule" → Picks time (tonight, tomorrow, custom)
  → Task gets scheduled_at timestamp
  → Task status changes to "scheduled"
  → Scheduler checks every minute for due tasks
  → When due: spawns Claude CLI worker
  → Worker executes task
  → Heartbeat monitors progress, pings Telegram at milestones
  → Results logged to Kanban card
  → Task moves to "review" when done
  → User reviews in the morning
```

### Implementation

#### 4.1 Schedule Picker UI — `ui/kanban.html`
In task detail panel, add "Schedule" button with dropdown:
- "Tonight (2 AM)"
- "Tomorrow morning (8 AM)"
- "Custom time..." (datetime picker)
- "Now" (execute immediately)

#### 4.2 Scheduled Task Runner — `src/scheduler/task-runner.ts`
```typescript
export class TaskRunner {
  private checkInterval: NodeJS.Timeout;

  start()  // Check every 60 seconds for due tasks
  stop()

  private async checkScheduledTasks(): Promise<void>
  private async executeTask(task: KanbanTask): Promise<void>
  private async buildPromptFromTask(task: KanbanTaskDetail): Promise<string>
}
```

#### 4.3 Kanban Schema Changes
```sql
ALTER TABLE kanban_tasks ADD COLUMN scheduled_at TEXT;
ALTER TABLE kanban_tasks ADD COLUMN worker_id TEXT;
```
New status value: `'scheduled'` added to KanbanStatus type.

### Files to Create/Modify
- CREATE: `src/scheduler/task-runner.ts`
- MODIFY: `src/kanban/index.ts` — schema migration, scheduled_at field
- MODIFY: `ui/kanban.html` — schedule button and picker UI

---

## 5. Daily Summary Generation

### What
Every morning at 9 AM (configurable), GLM-4.7 generates a comprehensive summary of the previous day:
- What was done (completed tasks, approved reviews)
- What failed (worker failures, rejected tasks)
- What's pending (in progress, scheduled, stale)
- What needs attention (overdue, blocked)
- Token usage across all tasks/projects
- Who did what (actor trail: Claude, GLM, User)

Sent to Telegram and stored in `daily_logs`.

### Implementation

#### 5.1 Daily Summary Job — `src/scheduler/daily-summary.ts`
```typescript
export async function generateDailySummary(): Promise<string> {
  // 1. All activity from previous day (kanban_activity_log)
  // 2. Task status counts across all projects
  // 3. Worker execution history (successes, failures, durations, tokens)
  // 4. Scheduler job results
  // 5. Daily log entries
  // 6. Token usage per project/task
  // 7. Untracked work (events without a task_id)
  // 8. Send to GLM-4.7 for structured summary
  // 9. Store in daily_logs
  // 10. Send to Telegram
}
```

#### 5.2 Register as Scheduled Job
Auto-created on first launch:
```typescript
{
  name: 'daily_summary',
  schedule_type: 'cron',
  schedule: '0 9 * * *',  // 9 AM daily
  prompt: 'INTERNAL:daily_summary',
  channel: 'telegram',
  enabled: true
}
```

### Files to Create/Modify
- CREATE: `src/scheduler/daily-summary.ts`
- MODIFY: `src/scheduler/index.ts` — handle INTERNAL: prefix for system jobs
- MODIFY: `src/main/index.ts` — auto-create daily_summary job on first launch

---

## 6. Enhanced Activity Tracking & Token Counting

### What
Track EVERYTHING at the system level — tool executions, worker runs, agent decisions, failures, GLM calls, token usage. The agent cannot skip this. It's middleware.

### Token Counting Per Task
Every API call (Claude or GLM) records tokens used, linked to the active task. The task detail panel shows cumulative token spend. Daily summaries include cost breakdowns.

### Implementation

#### 6.1 Universal Event Log — `src/memory/event-log.ts`
```sql
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,        -- 'claude', 'glm', 'user', 'system', 'worker'
  actor TEXT,                  -- who triggered: 'user', 'claude', 'glm', 'scheduler'
  session_id TEXT,
  project_id INTEGER,
  task_id INTEGER,
  data TEXT,                   -- JSON payload
  tokens_prompt INTEGER,       -- prompt tokens used
  tokens_completion INTEGER,   -- completion tokens used
  tokens_total INTEGER,        -- total tokens used
  success INTEGER DEFAULT 1,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
);

CREATE INDEX IF NOT EXISTS idx_event_type ON event_log(event_type);
CREATE INDEX IF NOT EXISTS idx_event_created ON event_log(created_at);
CREATE INDEX IF NOT EXISTS idx_event_source ON event_log(source);
CREATE INDEX IF NOT EXISTS idx_event_project ON event_log(project_id);
CREATE INDEX IF NOT EXISTS idx_event_task ON event_log(task_id);
CREATE INDEX IF NOT EXISTS idx_event_actor ON event_log(actor);
```

**Event types:**
- `tool_call` — any tool execution (name, input summary, output summary, duration)
- `llm_call` — any LLM API call (model, tokens, cost)
- `worker_spawn` / `worker_complete` / `worker_fail`
- `heartbeat` — heartbeat check result
- `daily_summary` — daily summary generated
- `notification_sent` — Telegram/desktop notification
- `session_start` / `session_end`
- `task_auto_created` — auto-created inbox task
- `error` — any unhandled error

#### 6.2 Token Aggregation Queries
```typescript
// Get total tokens spent on a specific task
getTokensByTask(taskId: number): { claude: number, glm: number, total: number }

// Get total tokens spent on a project
getTokensByProject(projectId: number): { claude: number, glm: number, total: number }

// Get tokens spent in a date range
getTokensByDateRange(start: string, end: string): TokenBreakdown

// Get tokens spent per day (for charts)
getDailyTokenUsage(days: number): DailyTokenEntry[]
```

#### 6.3 Middleware Integration
In `src/tools/diagnostics.ts`, wrap every tool call to automatically log to `event_log`.
In `src/agent/index.ts`, after every LLM response, log token usage to `event_log` linked to the active task.

### Files to Create/Modify
- CREATE: `src/memory/event-log.ts`
- MODIFY: `src/tools/diagnostics.ts` — auto-log tool calls to event_log
- MODIFY: `src/agent/index.ts` — auto-log LLM calls with token counts

---

## 7. Session Continuity & Context Recovery

### What
When the agent starts a new session (or context window resets), it automatically knows where things left off. No user input needed — the data is in the database.

### How It Works

```
New session starts:
  1. Read daily_logs (last 3 days) → knows what happened each day
  2. Read kanban_activity_log (last 48 hours) → knows what tasks changed
  3. Read event_log (last 48 hours) → knows every tool call, worker run, error
  4. Read active tasks across ALL projects → knows what's in progress
  5. Read pending reviews → knows what needs approval
  6. Read scheduled tasks → knows what's coming up
  7. Read recent worker executions → knows what was built overnight
  8. Read untracked events → knows if anything slipped through without a task

  → Agent presents: "Here's where we left off..."
  → Agent asks: "Should we continue with X? Review Y? Schedule Z?"
```

### Implementation

#### 7.1 Context Briefing — `src/agent/briefing.ts`
```typescript
export async function generateSessionBriefing(): Promise<string> {
  // All the above data sources, formatted into a concise briefing
  // Injected into the agent's system prompt automatically
}
```

#### 7.2 Auto-inject into Agent System Prompt
On each new session or context reset, prepend the briefing to the system prompt so the agent knows the full state without needing the conversation history.

### Files to Create/Modify
- CREATE: `src/agent/briefing.ts`
- MODIFY: `src/agent/index.ts` — inject briefing into system prompt

---

## 8. Gmail Integration

### What
Use GLM-4.7 to process incoming Gmail:
- Read new emails
- Classify and label them (urgent, important, newsletter, spam)
- Ping user on Telegram for urgent/important emails
- Summarize email threads

### Implementation

#### 8.1 Gmail Client — `src/channels/gmail.ts`
```typescript
// Uses Gmail API via OAuth2 (googleapis npm package)
export class GmailClient {
  async authenticate(): Promise<void>
  async getUnreadEmails(maxResults?: number): Promise<GmailMessage[]>
  async labelEmail(messageId: string, labels: string[]): Promise<void>
  async getThread(threadId: string): Promise<GmailThread>
  async markAsRead(messageId: string): Promise<void>
}
```

#### 8.2 Scheduled Job — every 5 minutes
Classified by GLM-4.7. Urgent/important → Telegram ping. Everything logged to event_log.

### Files to Create/Modify
- CREATE: `src/channels/gmail.ts`
- CREATE: `src/channels/email-processor.ts`
- MODIFY: `package.json` — add googleapis dependency

---

## 9. Auto-Task Recording (General Inbox)

### What
The agent always works within a task context. If no task exists for the current work, the agent **auto-creates one in a "General Inbox" project**. This ensures nothing happens without being tracked.

### How It Works

```
User asks agent to do something:
  1. Is there an active Kanban task linked to this conversation? → Use it
  2. Is there a project that matches this topic? → Create task there
  3. Neither? → Create task in "General Inbox" project with descriptive title
  4. Agent works under that task — all events tagged with task_id
  5. Periodically, heartbeat checks inbox tasks and asks user:
     "Task X has been in Inbox for 2 days. Want to move it to a project?"
```

### What's NOT a task
Simple questions ("what time is it?", "how do I X?") don't create tasks. The agent uses judgment. But the event_log still records the interaction regardless.

### Inbox Cleanup
The heartbeat (or a daily GLM job) scans the General Inbox:
- Tasks older than 2 days without a project → ping user to organize
- Tasks that are clearly done → suggest archiving
- Tasks that belong to an existing project → suggest moving

### Implementation

#### 9.1 General Inbox Project
Auto-created on first launch if it doesn't exist:
```typescript
{
  name: 'General Inbox',
  description: 'Auto-created tasks from conversations. Organize into projects.',
  workspace_path: null
}
```

#### 9.2 Active Task Context — `src/agent/task-context.ts`
```typescript
export class TaskContext {
  private activeTaskId: number | null;
  private activeProjectId: number | null;

  setActiveTask(taskId: number): void
  getActiveTask(): number | null
  autoCreateTask(title: string, description: string): Promise<number>
  shouldCreateTask(userMessage: string): boolean  // Agent judgment
}
```

### Files to Create/Modify
- CREATE: `src/agent/task-context.ts`
- MODIFY: `src/agent/index.ts` — integrate task context
- MODIFY: `src/main/index.ts` — auto-create General Inbox project

---

## 10. Project Folder Manager

### What
Every project/plan gets its own subfolder. Plans are not dumped into one folder. Each plan subfolder contains:
- `PLAN.md` — the plan itself
- `TODO.md` — auto-tracked checklist (done/not done)
- `PROGRESS.md` — auto-updated progress log

### Folder Structure
```
docs/
  plans/
    glm-integration/
      PLAN.md
      TODO.md
      PROGRESS.md
    worker-spawning/
      PLAN.md
      TODO.md
      PROGRESS.md
    gmail-integration/
      PLAN.md
      TODO.md
      PROGRESS.md
    ...
  MASTER-PLAN.md          ← This file (overview)
```

### Auto-Tracking
When work starts on a plan item, the TODO.md is updated:
```markdown
- [x] Create GLM client (completed 2026-02-01 by Claude)
- [x] Register GLM tools (completed 2026-02-01 by Claude)
- [ ] Add GLM settings UI
- [ ] Test GLM summarization
```

PROGRESS.md gets appended with entries:
```markdown
### 2026-02-01
- Created `src/agent/glm-client.ts` — GLM API client with token tracking
- Registered 3 GLM tools in agent
- Tokens used: 12,450 (Claude), 0 (GLM)
```

### Implementation

#### 10.1 Plan Manager — `src/tools/plan-tools.ts`
```typescript
// Tool: create_plan — Create a new plan subfolder with PLAN.md, TODO.md, PROGRESS.md
// Tool: update_plan_todo — Check/uncheck items in a plan's TODO.md
// Tool: log_plan_progress — Append an entry to a plan's PROGRESS.md
// Tool: list_plans — List all plans with their completion percentage
```

### Files to Create/Modify
- CREATE: `src/tools/plan-tools.ts`
- CREATE: `docs/plans/` directory structure
- MODIFY: `src/agent/index.ts` — register plan tools

---

## 11. Task Detail Panel Improvements

### What
The current task detail panel is too small and only shows on the right side. Needs:
- **Expandable full-screen modal** — click to expand for detailed work
- **Left/right toggle** — button to flip panel to left or right side of screen
- **Richer content display** — full description visible, not truncated
- **Token usage display** — show tokens spent on this task
- **Worker output viewer** — see full build logs
- **Activity timeline with actors** — "Claude created", "User approved", "GLM processed"

### Implementation

#### 11.1 Panel Modes
1. **Side panel** (current) — quick glance, slides in from right
2. **Side panel left** — same but from left side
3. **Expanded modal** — full-screen overlay for detailed work

#### 11.2 UI Changes — `ui/kanban.html`
- Add expand button (⤢) to panel header → opens full modal
- Add left/right toggle button (⇆) to panel header → flips side
- Store preference in localStorage
- In expanded mode: full description editor, full activity timeline, worker logs, attachments grid, token counter

#### 11.3 Token Display
In task detail, show:
```
Tokens: 45,230 (Claude: 42,100 | GLM: 3,130)
```
Pulled from `event_log` aggregated by task_id.

### Files to Modify
- MODIFY: `ui/kanban.html` — panel toggle, expand modal, token display

---

## 12. Actor Tracking & Audit Trail

### What
Every action shows WHO did it. Not just "created 1 hour ago" but "Claude created 1 hour ago" or "User approved 30 min ago" or "GLM processed 2 hours ago".

### Current State
The `kanban_activity_log` has an `actor` field (default: 'user'). But:
- It's not consistently set (often defaults to 'user' even for agent actions)
- The UI doesn't display the actor

### Implementation

#### 12.1 Fix Actor Assignment
Ensure every mutation correctly sets the actor:
- `'user'` — user action in UI
- `'claude'` — Claude agent tool call
- `'glm'` — GLM processing
- `'scheduler'` — scheduled job
- `'worker:<id>'` — specific worker instance
- `'system'` — auto-migration, auto-cleanup

#### 12.2 Display in UI
Activity timeline entries show:
```
Claude created · 1 hour ago
User approved · 30 min ago
Worker w-abc123 completed · 15 min ago
GLM summarized · 5 min ago
```

In review cards and board cards, show the actor badge next to timestamps.

### Files to Modify
- MODIFY: `src/kanban/index.ts` — ensure actor is passed correctly
- MODIFY: `src/tools/kanban-tools.ts` — set actor='claude' on all agent calls
- MODIFY: `ui/kanban.html` — display actor in activity timeline and cards

---

## 13. Tag & Assignee System

### What
Tags and assignees are currently free-text — you can type anything. This needs structure.

### Tags
- **Autocomplete from existing tags** — when typing, suggest tags used across all projects
- **Predefined system tags** — `bug`, `feature`, `research`, `urgent`, `documentation`
- **Tag management** — view all tags, merge duplicates, delete unused
- **Tag colors** — each tag gets a consistent color (hash-based)

### Assignee Model
Currently a text field. Should be a dropdown with known models:
- `claude` — Claude (primary agent)
- `glm` — GLM-4.7 (utility model)
- `worker` — Claude CLI worker
- `user` — User (manual task)

Changing the assignee actually affects routing:
- Assign to `worker` → shows "Schedule" button
- Assign to `glm` → GLM handles it
- Assign to `claude` → main agent handles it
- Assign to `user` → just a reminder, no automation

### Implementation

#### 13.1 Backend — `src/kanban/index.ts`
```typescript
getAllTags(): string[]                    // Unique tags across all projects
getTagUsageCounts(): { tag: string, count: number }[]
```

#### 13.2 UI — `ui/kanban.html`
- Tag input with autocomplete dropdown
- Assignee as dropdown select (claude/glm/worker/user)
- Tags displayed with consistent colors

### Files to Modify
- MODIFY: `src/kanban/index.ts` — tag queries
- MODIFY: `ui/kanban.html` — tag autocomplete, assignee dropdown

---

## 14. Project Selector in New Task Modal

### What
When creating a new task, allow selecting which project it belongs to (dropdown pre-filled with current project, but changeable). Combined with tag autocomplete.

### Implementation
- Add project dropdown to New Task modal (populated from `kanbanListProjects()`)
- Default to current project but can switch
- Tag input with autocomplete from existing tags

### Files to Modify
- MODIFY: `ui/kanban.html` — project dropdown + tag autocomplete in modal
- MODIFY: `src/kanban/index.ts` — getAllTags query

---

## Implementation Order (Priority)

### Phase 1 — Foundation (Data Layer)
1. Universal event log with token tracking (`src/memory/event-log.ts`)
2. GLM 4.7 client (`src/agent/glm-client.ts`)
3. Actor tracking fixes across all Kanban operations
4. Project selector in New Task modal (quick win)

### Phase 2 — Workers & Scheduling
5. Worker manager + execution DB (`src/workers/`)
6. Claude CLI spawning + Kanban integration
7. Task scheduling UI (schedule button, overnight picker)
8. Scheduled task runner

### Phase 3 — Intelligence & Monitoring
9. Universal heartbeat system
10. Auto-task recording (General Inbox)
11. Daily summary generation (GLM-4.7)
12. Session continuity briefing

### Phase 4 — UI & Organization
13. Task detail panel improvements (expand, left/right, tokens)
14. Tag & assignee system (autocomplete, dropdown, colors)
15. Project folder manager (plan subfolders, TODO tracking)

### Phase 5 — Communication
16. Gmail integration + email classification
17. Telegram notifications for urgent emails

---

## Key Decisions Still Needed

1. **Claude CLI path**: Is `claude` available globally? Run `which claude` to check.
2. **Worker concurrency**: How many parallel workers? (Suggest: 2-3 max)
3. **Gmail OAuth**: Need Google Cloud Console project for credentials.
4. **GLM-4.7 model ID**: Verify exact model string for z.ai API.
5. **Worker timeout**: Default 30 min? Configurable per task?
6. **Quiet hours**: What hours to suppress heartbeat notifications?
7. **Token cost rates**: What are the per-token costs for Claude and GLM for cost display?

---

## Database Migrations Needed

```sql
-- 1. Universal event log table (new)
-- 2. Worker executions table (new)
-- 3. kanban_tasks: ADD scheduled_at TEXT
-- 4. kanban_tasks: ADD worker_id TEXT
-- 5. kanban_tasks: UPDATE status CHECK to include 'scheduled'
```

All migrations use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` for backwards compatibility.

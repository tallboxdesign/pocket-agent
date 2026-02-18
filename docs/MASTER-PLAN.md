# Pocket Agent: Master Plan — Multi-Agent Orchestration System

**Created:** 2026-01-30
**Last Updated:** 2026-02-12
**Status:** IN PROGRESS — v4.1 Email Intelligence
**Architecture:** CEO (User) → Manager (Pocket Agent/Claude) → Workers (Claude CLI instances) + GLM-5 (utility model, GLM-4.7 flash variants for bulk)

---

## ⛔ MEGA RULE — DATA INTEGRITY (READ THIS FIRST)

**NEVER, under any circumstances, lose, corrupt, overwrite, or reset user data.**

This is the single most important rule in the entire project. Violating it is unacceptable.

- **Database files (`pocket-agent.db`)** contain irreplaceable user data: chat history, routines/cron jobs, facts, settings, email state, kanban projects/tasks. Treat them as sacred.
- **Never** overwrite, truncate, or delete database files during builds, installs, or updates.
- **Never** reset or re-initialize tables that already contain user data.
- **Build/install cycles must be non-destructive.** Copying a new build to `/Applications` must never touch `~/Library/Application Support/pocket-agent/`.
- **Electron `safeStorage` encryption** depends on the app's code signature. Ad-hoc re-signing during `electron-builder` builds can invalidate encrypted values (API keys, tokens). Always verify encrypted settings survive after a re-sign.
- **Before any migration or schema change**, back up the database first. Use `ALTER TABLE ADD COLUMN` — never drop and recreate tables.
- **Test data persistence** after every build/install cycle: launch the app and confirm chat history, routines, and settings are intact.

If in doubt, **do nothing** rather than risk data loss.

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
15. [Multi-Agent Research System](#15-multi-agent-research-system)
16. [GLM Project Prioritization](#16-glm-project-prioritization)
17. [Upstream Ports](#17-upstream-ports-from-kenkaiiipocket-agent)
18. [Task Consolidation & Kanban Automation](#18-task-consolidation--kanban-automation)
19. [Voice / TTS Agent Tools](#19-voice--tts-agent-tools)
20. [Label Precision — Definition & Negative Guidance](#20-label-precision--definition--negative-guidance)
21. [Telegram Emoji Reactions Tool](#21-telegram-emoji-reactions-tool--done)
25. [Windows Build & Distribution](#25-windows-build--distribution)
26. [Workflow-Routine Integration](#26-workflow-routine-integration)
27. [Telegram Bot Command Registration](#27-telegram-bot-command-registration)
28. [GLM-5 Model Upgrade](#28-glm-5-model-upgrade)
29. [Reminder Archival & Re-ping System](#29-reminder-archival--re-ping-system)
30. [Calendar Integration](#30-calendar-integration)
31. [Workflow UI Overflow Fix](#31-workflow-ui-overflow-fix)
32. [Upstream Port Phase 5 — v2.3.2 Cherry-Picks](#32-upstream-port-phase-5--v232-cherry-picks)

---

## Current State (What Already Exists)

| Component | Status | Details |
|-----------|--------|---------|
| Zhipu GLM integration | Full | GLM-5 (worker/research), GLM-4.7-flash (classification), GLM-4.7-flashx (bulk) — `src/tools/glm-client.ts` |
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
- Summarization (daily summaries, log processing, research compilation)
- Email classification and labeling
- Periodic log review and compression
- Routine processing that doesn't need Claude's intelligence
- News summarization (user can ask "summarize today's AI news")
- Project prioritization analysis (rank projects by value/urgency)
- Session briefing compression (summarize 3 days of logs for context injection)
- Research post-processing (compile and deduplicate multi-agent research findings)

Claude remains the primary agent/manager. GLM handles cheap background tasks.
GLM **cannot** use the Agent SDK — it's a simple chat completion API. All agentic work (tools, decisions, research orchestration) stays with Claude.

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

#### 7.2 GLM Pre-Summarization
Raw logs from 3 days can be large. Before injection:
1. Collect raw data from all sources (daily_logs, activity_log, event_log, etc.)
2. Send to GLM for compression: "Summarize these 3 days of activity into a concise briefing"
3. GLM returns a compact summary (~500-1000 tokens) covering key events, pending work, blockers
4. This compact summary gets injected into the system prompt — not the raw logs

#### 7.3 Auto-inject into Agent System Prompt
On each new session or context reset, prepend the GLM-compressed briefing to the system prompt so the agent knows the full state without needing the conversation history.

### Files to Create/Modify
- CREATE: `src/agent/briefing.ts`
- MODIFY: `src/agent/index.ts` — inject briefing into system prompt

---

## 8. Gmail Integration

### What
The manager has its own Gmail account. Two directions:

**Inbound:** Use GLM-4.7 to process incoming Gmail:
- Read new emails
- Classify and label them (urgent, important, newsletter, spam)
- Ping user on Telegram for urgent/important emails
- Summarize email threads

**Outbound:** Routines and agent actions can send emails:
- Scheduled routines can output to email (e.g., daily report emailed to user)
- Agent can compose and send emails on behalf of the manager
- Email drafts require user approval before sending (unless auto-approved in settings)

### Routine Output Channels
Currently routines only output to chat. With Gmail, routines get a `channel` field:
- `chat` — response goes to the chat window (current behavior)
- `telegram` — response sent to Telegram
- `email` — response composed as email and sent to configured recipient(s)
- Multiple channels allowed (e.g., `chat+email` — show in chat AND email)

The Routines UI gets a "Send to" picker when creating/editing a routine: Chat, Telegram, Email, or any combination.

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
  async sendEmail(to: string, subject: string, body: string): Promise<void>
  async createDraft(to: string, subject: string, body: string): Promise<string>
}
```

#### 8.2 Inbound — Scheduled Job (every 5 minutes)
Classified by GLM-4.7. Urgent/important → Telegram ping. Everything logged to event_log.

#### 8.3 Outbound — Routine Email Delivery
When a routine has `channel: 'email'`:
1. Routine runs as normal (agent executes the prompt)
2. Agent output is formatted as email body
3. Email sent to configured recipient(s) via Gmail API
4. Logged to event_log with `event_type: 'email_sent'`

#### 8.4 Scheduler Schema Extension
```sql
ALTER TABLE cron_jobs ADD COLUMN channel TEXT DEFAULT 'chat';
-- Values: 'chat', 'telegram', 'email', 'chat+email', 'chat+telegram', etc.
ALTER TABLE cron_jobs ADD COLUMN email_recipients TEXT;
-- JSON array of email addresses for email channel
```

### Files to Create/Modify
- CREATE: `src/channels/gmail.ts`
- CREATE: `src/channels/email-processor.ts`
- MODIFY: `package.json` — add googleapis dependency
- MODIFY: `src/scheduler/index.ts` — route routine output to configured channel(s)
- MODIFY: `ui/cron.html` — "Send to" channel picker in routine creation form

---

## 9. Auto-Task Recording (Personal Project)

### What
The agent always works within a task context. If no task exists for the current work, the agent **auto-creates one in the "Personal" project** (see Section 18). This ensures nothing happens without being tracked.

The "Personal" project serves dual purpose:
1. **Inbox** for auto-created tasks from conversations
2. **Home** for simple todos redirected from `task_add` (Section 18.1)

### How It Works

```
User asks agent to do something:
  1. Is there an active Kanban task linked to this conversation? → Use it
  2. Is there a project that matches this topic? → Create task there
  3. Neither? → Create task in "Personal" project with descriptive title
  4. Agent works under that task — all events tagged with task_id
  5. Periodically, heartbeat checks Personal project tasks and asks user:
     "Task X has been in Personal for 2 days. Want to move it to a project?"
```

### What's NOT a task
Simple questions ("what time is it?", "how do I X?") don't create tasks. The agent uses judgment. But the event_log still records the interaction regardless.

### Inbox Cleanup
The heartbeat (or a daily GLM job) scans the Personal project:
- Tasks older than 2 days without being moved to a real project → ping user to organize
- Tasks that are clearly done → suggest archiving
- Tasks that belong to an existing project → suggest moving

### Implementation

#### 9.1 Personal Project
Auto-created on first launch if it doesn't exist (shared with Section 18):
```typescript
{
  name: 'Personal',
  description: 'Your tasks, todos, and auto-created items. Move to projects as needed.',
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
- MODIFY: `src/main/index.ts` — auto-create Personal project (shared with Section 18)

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
- **Voice summary button** — on tasks tagged `research`, a "Read aloud" button that sends the description to TTS for a spoken summary

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
- Voice summary button for `research`-tagged tasks — calls existing TTS pipeline with task description

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

## 15. Multi-Agent Research System

### What
When the user requests research (via Telegram, chat, or Kanban task), the manager orchestrates multiple Claude SDK agents in parallel to cover different angles of the topic. Results are compiled, stored in Kanban, and available for reading or voice summary.

### How It Works

```
User: "Research house prices and population in Sofia"
  → Manager breaks into sub-queries:
    1. "Population statistics for Sofia, trends, demographics"
    2. "House prices in Sofia, districts, trends, predictions"
    3. "Cost of living comparison with other European capitals"
  → Spawns 2-4 Claude SDK agents in parallel (NOT CLI workers — these use the agent SDK with web tools)
  → Each agent runs up to 20 web queries on its sub-topic
  → Agents stream findings back
  → Manager compiles results (or delegates compilation to GLM for token savings)
  → Creates/updates Kanban task tagged 'research' with compiled findings
  → Sends Telegram notification: "Research on Sofia is ready. 3 agents, 42 sources."
  → User reads in detail panel or requests TTS voice summary
```

### Research is a Tag, Not a Column
- Tasks tagged `research` follow normal flow: todo → in_progress → review → done
- Research belongs to the project it serves (e.g., real estate research → real estate project)
- General research with no project → General Inbox
- Quick-filter button in Kanban header shows all `research` tasks across projects

### Research Agent vs CLI Worker
| Aspect | Research Agent | CLI Worker |
|--------|---------------|------------|
| Purpose | Web research, information gathering | Code building, file operations |
| SDK | Claude Agent SDK (in-process) | Claude CLI (child process) |
| Tools | Web search, web fetch, summarize | Full filesystem, shell, git |
| Duration | 1-5 minutes | 5-60 minutes |
| Parallelism | 2-4 agents per research task | 1-2 workers at a time |
| Output | Compiled text/markdown report | Code changes, build artifacts |

### Research Results Storage
Each research task stores:
- **Compiled report** — markdown in task description
- **Sources list** — URLs with titles
- **Agent breakdown** — which agent found what
- **Token usage** — per agent and total
- **Timestamp** — when research was completed

### Implementation

#### 15.1 Research Orchestrator — `src/agent/research.ts`
```typescript
export interface ResearchRequest {
  query: string;              // User's research request
  projectId?: number;         // Target project (or General Inbox)
  maxAgents?: number;         // Max parallel agents (default: 3)
  maxQueriesPerAgent?: number;// Max web queries per agent (default: 20)
}

export interface ResearchResult {
  taskId: number;             // Kanban task ID
  sections: ResearchSection[];// Compiled findings by sub-topic
  sources: { url: string, title: string }[];
  tokenUsage: { prompt: number, completion: number, total: number };
  duration: number;           // Total time in ms
}

export async function executeResearch(request: ResearchRequest): Promise<ResearchResult>
```

#### 15.2 Agent Tools — `src/tools/research-tools.ts`
```typescript
// Tool: research — Spawn multi-agent research on a topic
// Tool: research_status — Check status of running research
// Tool: summarize_research — Get TTS-friendly summary of a research task
```

#### 15.3 Kanban Integration
- Research tasks auto-created with tag `research` and assignee `claude`
- On completion → moved to `review` with full report in description
- Voice summary button on research task detail panel

#### 15.4 GLM Post-Processing
After agents return raw findings, GLM can:
- Compile and deduplicate findings across agents
- Generate an executive summary
- Extract key statistics and facts
- Format for TTS readability

### Files to Create/Modify
- CREATE: `src/agent/research.ts`
- CREATE: `src/tools/research-tools.ts`
- MODIFY: `src/agent/index.ts` — register research tools
- MODIFY: `ui/kanban.html` — research filter button, voice summary button on research tasks

---

## 16. GLM Project Prioritization

### What
GLM periodically analyzes all projects and suggests prioritization based on:
- Completion percentage (how close to done)
- Last activity date (stale projects)
- Token investment (sunk cost / ROI)
- Task count and velocity (momentum)
- User-assigned priority/tags

### Implementation
Part of the daily summary (Section 5). GLM receives project data and returns a ranked list with reasoning. Can be triggered manually via Telegram: "What should I work on today?"

### Files to Modify
- MODIFY: `src/scheduler/daily-summary.ts` — add project prioritization to morning summary

---

## 17. Upstream Ports (from KenKaiii/pocket-agent)

### What
Port ALL valuable improvements from upstream v1.0.14 → v2.0.4 (21 commits) without breaking our custom features (email processing, rules engine, unanswered scan, kanban, voice/TTS, GLM multi-provider routing, label management).

### Safety Protocol
- **Backup branch** before any changes: `backup/my-voice-features-before-upstream-port`
- `npm run typecheck && npm run lint` after every phase
- Build + install + full smoke test at the end
- Rollback: `git reset --hard backup/my-voice-features-before-upstream-port`

### DO NOT Port (protect our features)
- `extractFactsBeforeCompaction` — we actively use it (`agent/index.ts:1568`)
- `pty_exec` tool — we actively use it (`agent/index.ts:944,1168-1173`)
- Tool description shortening — our descriptions have NL scheduling docs, channel detection
- Splash screen / cat theme / click sounds / Pixelify Sans font / About modal
- Upstream's basic GLM 4.7 support — we have superior multi-provider routing

### Skip Entirely (11 commits)
`64e5a06` cat UI, `c770b6d` splash+sounds, `50508cc` MIT+README, `acfa217` splash fix,
`af55b0f` badge styling (we have better), `147d56e` basic GLM (we have better),
version bumps: `6c58df2` `8dac6d6` `1e03577` `594ee4e` `9e0ea9a` `7eab8f4` `4386fd6` `6f1db44`

---

### 17.1 Phase 1 — Clean Cherry-Picks (3 commits)
Dry-run tested, no conflicts.

| Commit | What | File |
|--------|------|------|
| `9ef7724` | Telegram markdown — fix italic regex corrupting `@@PROTECTED_N@@` markers | `src/channels/telegram.ts` |
| `8f9c569` | Menu z-index — fix dropdown overlapping scroll buttons | `ui/chat.html` |
| `e992662` | NVM path detection — dynamic node path resolution for packaged app | `src/main/index.ts` |

### 17.2 Phase 2 — Performance + Memory Leaks (d338555, selective)

| Change | File | What |
|--------|------|------|
| Parallelize embeddings | `src/memory/index.ts` | Batch-of-5 `Promise.all` in `embedAllFacts()` and `embedRecentMessages()` |
| Catch promise rejection | `src/scheduler/index.ts` | `.catch()` on `checkReminders()` calls |
| Try/catch scheduler send | `src/main/index.ts` | Wrap `chatWindow.webContents.send('scheduler:message')` in try/catch |
| Queue memory leak fix | `src/agent/index.ts` | `delete` queue map key instead of `.length = 0` |

**SKIP**: splash webPreferences, removal of extractFactsBeforeCompaction, removal of getTokenLimits, config.example.json deletion.

### 17.3 Phase 3 — Browser Automation Fixes (70cc269)

| Change | File | What |
|--------|------|------|
| Element validation | `src/browser/cdp-tier.ts` | Check visibility/enabled before click, IIFE-wrap evaluate scripts |
| Follow-up summary | `src/agent/index.ts` | When no text response after tool use, make follow-up query for summary |

### 17.4 Phase 4 — Browser Launcher UI (b9d2a36, selective)

| Change | File | What |
|--------|------|------|
| NEW: Browser launcher | `src/browser/launcher.ts` | detectInstalledBrowsers(), launchBrowser(), testCdpConnection() |
| useMyBrowser setting | `src/browser/index.ts` | SettingsManager import, CDP preference check in selectTier() |
| Setting definition | `src/settings/index.ts` | `browser.useMyBrowser` boolean setting |
| IPC handlers | `src/main/index.ts` | browser:detectInstalled, browser:launch, browser:testConnection |
| Preload API | `src/main/preload.ts` | 3 new browser control methods + TS declarations |
| UI controls | `ui/settings.html` | Browser selector, Launch/Test buttons, Use My Browser toggle |

**SKIP**: full settings.html section rewrite (keep our structure, add controls inline), screenshot path change.

### 17.5 Phase 5 — Session Persistence + Safety + Project Tools (342e689, selective)

| Change | File | What |
|--------|------|------|
| NEW: Safety module | `src/agent/safety.ts` | Input validation and safety hooks (617 lines) |
| NEW: Project tools | `src/tools/project-tools.ts` | Project file operation tools (313 lines) |
| NEW: Project MCP | `src/mcp/project-server.ts` | MCP server for project operations (281 lines) |
| NEW: Safety tests | `tests/unit/safety.test.ts` | Safety module test suite (354 lines) |
| Workspace methods | `src/agent/index.ts` | getWorkspace(), getProjectRoot(), setWorkspace(), resetWorkspace() |
| Register project tools | `src/tools/index.ts` | Import + register in buildSdkMcpServers() and getCustomTools() |
| Session persistence | `ui/chat.html` | localStorage save/restore of currentSessionId (3 spots) |
| Table wrapper | `ui/chat.html` | CSS for scrollable tables + JS to wrap `<table>` in div |

**SKIP**: tool description shortening, pty_exec removal.

### 17.6 Phase 6 — Chat UI Enhancements (e8cc313 + 0ad2276 + 2f4b279, selective)

| Change | Source | What |
|--------|--------|------|
| Link click interceptor | `e8cc313` | Intercept `<a>` clicks → openExternal() for http/https links |
| Scroll-to-top/bottom buttons | `0ad2276` | CSS + HTML + JS for scroll buttons with visibility threshold |
| Copy button on messages | `2f4b279` | Footer with copy button, copyMessageText() clipboard function |

**SKIP**: About modal (upstream branding), click sounds, chat search (defer — ~490 lines, separate follow-up).

### 17.7 Phase 7 — Preload TypeScript fix

| Change | File | What |
|--------|------|------|
| Fix TS declaration | `src/main/preload.ts` | `openSettings: (tab?: string) => Promise<void>` (line 353) |
| Browser declarations | `src/main/preload.ts` | Add TS types for browser control APIs |

### Files Modified (total)

| File | Phases |
|------|--------|
| `src/agent/index.ts` | 2, 3, 5 |
| `src/browser/cdp-tier.ts` | 3 |
| `src/browser/index.ts` | 4 |
| `src/browser/launcher.ts` | 4 (NEW) |
| `src/agent/safety.ts` | 5 (NEW) |
| `src/tools/project-tools.ts` | 5 (NEW) |
| `src/mcp/project-server.ts` | 5 (NEW) |
| `tests/unit/safety.test.ts` | 5 (NEW) |
| `src/tools/index.ts` | 5 |
| `src/memory/index.ts` | 2 |
| `src/scheduler/index.ts` | 2 |
| `src/main/index.ts` | 1, 2, 4 |
| `src/main/preload.ts` | 4, 7 |
| `src/settings/index.ts` | 4 |
| `src/channels/telegram.ts` | 1 |
| `ui/chat.html` | 1, 5, 6 |
| `ui/settings.html` | 4 |

### 17.10 UI Improvements (2026-02-05)

**Rule Editor Modal — Resizable**
The rule editor modal was cutting off content (textarea going under the window). Made it responsive and resizable:
- Added `.ep-modal.resizable` CSS class with `resize: both`
- Default width 600px, min 400px, max 90vw
- Min height 400px, max 90vh
- Removed inline `max-height:460px` constraint on modal body
- User can drag bottom-right corner to resize

**File:** `ui/settings.html`

---

### 17.11 Upstream Port Phase 2 (2026-02-05) — SUPERSEDED by 17.12

~~Port 7 new commits from upstream v2.0.5 → v2.0.8, coexisting with our features.~~
All items below are included in the full v2.1.5 merge (17.12).

**Commits to Port:**
| Commit | Feature | Value |
|--------|---------|-------|
| `ce5a566` | Telegram /new, /model, /help commands + model sync | ⭐⭐⭐ HIGH |
| `7d9d698` | Telegram icon instant update on link/unlink | ⭐⭐ MEDIUM |
| `0be37c9` | Routine vs reminder tool naming (clearer descriptions) | ⭐⭐⭐ HIGH |
| `699d324` | CDP auto-reconnect + power management (App Nap prevention) | ⭐⭐⭐ HIGH |
| `9beafb1` | Compaction notification fix (wasCompacted flag) | ⭐⭐ MEDIUM |
| `1d6b2fa` | Compaction model fallback (try Haiku, then user's model) | ⭐⭐⭐ HIGH |
| `e843859` | Mind map organic connectors + drag performance | ⭐⭐ MEDIUM |

**Skip (branding/cosmetic):**
- Pixel cat animation, pixel heart, Pixelify Sans font, "Who made me" text changes

**Coexistence Rules:**
- **KEEP** our `/clear`, `/mychatid`, `/voice` commands alongside new `/new`, `/model`, `/help`
- **KEEP** old tool names as aliases if renaming (non-breaking)
- **KEEP** our legend div in mind map (upstream removed it)
- **DO NOT** add Pixelify Sans font or playNormalClick() sounds

**Phases:**
1. Telegram commands (/new, /model, /help) + model sync to desktop
2. Telegram icon instant update on link/unlink
3. Routine vs reminder tool descriptions (aliased, non-breaking)
4. CDP auto-reconnect + power management (powerSaveBlocker)
5. Compaction notification fix (newSummaryCreated stat)
6. Compaction model fallback loop
7. Mind map organic connectors (manual port, skip font/sounds)

**Files Modified:**
- `src/channels/telegram.ts` — new commands, session link broadcast
- `src/agent/index.ts` — setModel(), compaction fixes
- `src/browser/cdp-tier.ts` — health check, auto-reconnect
- `src/main/index.ts` — power management, session IPC
- `src/main/preload.ts` — model/session listeners
- `src/memory/index.ts` — newSummaryCreated stat
- `src/tools/scheduler-tools.ts` — routine/reminder descriptions
- `ui/chat.html` — model sync, compaction toast
- `ui/facts-graph.html` — organic connectors

**Full plan:** `.claude/plans/upstream-port-phase2.md`

### 17.12 Upstream Port Phase 3 — v2.1.5 Full Merge + Pocket CLI (2026-02-06) ✅ DONE

Full merge of upstream/main (57 commits ahead) into my-voice-features via `integration/upstream-v2.1.5` branch. Supersedes 17.11 — all planned ports are included.

**What was integrated:**
- **Modular Telegram** — 21-file directory structure replacing monolithic `telegram.ts`
- **Claude Opus 4.6** — Default model upgraded from Sonnet 4.5
- **Agent SDK 0.2.32** — `canUseTool` safety hooks, `PreToolUse` event
- **Config auto-repopulation** — Automatic backup/update of identity.md/CLAUDE.md on version change
- **Pocket CLI** — Go binary with 42 internet service integrations, installed via Settings tab, agent instructions updated with full command reference and priority rules (Section 22.1)
- **Splash screen** — New startup splash with progress indicators
- **PDF reading** — `pdf-parse` support for document handler
- **Project tools** — New project management tools
- **Browser improvements** — Better tier selection, consolidated screenshot saving

**Our features preserved (zero loss):**
- Voice/TTS pipeline (Brian voice, Edge TTS, Daniel fallback, summarizeForVoice)
- `/voice`, `/unanswered`, `/approve`, `/reject` Telegram commands
- `sendVoiceReply()` as modular `features/voice.ts`
- `sendPhoto()`, raw-emoji `reactToMessage()`, `restartTelegramBot()`
- Reconnection with exponential backoff + health check
- `setTelegramMessageContext` in message/media handlers
- Email intelligence (Gmail, GLM classification, rules engine, unanswered scanner)
- Kanban project management
- AI rule builder for email automation
- All custom tools (voice, photo, react, restart, gmail, glm-worker, kanban)

**Version:** `2.1.5-voice.1`

### 17.13 Upstream Port Phase 4 — v2.2.6 Merge (2026-02-10) ✅ DONE

Merged upstream v2.2.6 into my-voice-features. Includes persistent sessions, workflows (replacing skills), teams, media support, Windows support, and power management.

**Post-merge fix required:** The merge introduced **duplicate IPC handler registrations** for `browser:detectInstalled`, `browser:launch`, and `browser:testConnection` in `src/main/index.ts`. Electron crashes fatally when the same `ipcMain.handle()` channel is registered twice, which prevented the entire app from initializing — all UI buttons appeared dead because the backend never started. Fixed by removing the duplicate block (upstream's copy at ~line 2366, keeping the original at ~line 1717).

**Lesson learned:** After any upstream merge, always run the app in dev mode (`npx electron .`) and check stdout for `FATAL ERROR` before declaring success. `npm run typecheck` passing does NOT guarantee runtime correctness — duplicate IPC handlers are a runtime error, not a type error.

**What was integrated:**
- **Persistent sessions** — Multi-session support with SDK session IDs
- **Workflows** — Commands system replacing old skills setup
- **Teams** — Agent teams support
- **Media handling** — Cross-channel media with `readMedia`, `extractText`, `openImage`
- **Windows support** — Platform-aware PATH, shell selection, icon
- **Power management** — `powerSaveBlocker` to prevent app suspension
- **Tool blocked UI state** — Visual indicator when agent tool is blocked

**Version:** `2.2.6-voice.1`

---

## 18. Task Consolidation & Kanban Automation

### Problem
Four overlapping systems confuse the user:
- `tasks` table — simple todos via chat, **no UI window**
- `calendar_events` table — appointments via chat, **no UI window**
- `cron_jobs` table — routines + reminders, has Routines UI
- `kanban_tasks` table — project management, has Projects UI

User asks "where are my tasks?" and the answer is "scattered across 4 tables."

### Solution

#### 18.1 Consolidate Tasks into Kanban
**Redirect `task_add` → Kanban.** All user tasks go to a "Personal" Kanban project.

- Auto-create a **"Personal"** Kanban project on first launch (if not exists)
- Rewire `task_add` tool → creates a `kanban_tasks` entry in the Personal project
- Rewire `task_list` → queries `kanban_tasks` from Personal project
- Rewire `task_complete` → moves card to Done column
- Rewire `task_delete` → deletes the Kanban card
- `task_due` → queries Kanban tasks with due_date in range
- Old `tasks` table stays intact (no data loss), stops receiving new data
- One-time migration on startup: move existing `tasks` rows → Personal project cards

#### 18.2 Keep Calendar Events Separate
Calendar events are fundamentally different (start/end time, location, all-day flag). They stay in `calendar_events` and will later connect to Google Calendar / Apple Calendar. They need a UI eventually (dedicated Calendar window or section in Routines).

#### 18.3 Keep Cron Jobs As-Is
Standalone routines and simple reminders ("remind me to drink water in 1 hour") stay in `cron_jobs`. These are lightweight, don't need a Kanban card.

#### 18.4 Kanban Task Automation — The Unified Pipeline
Every Kanban card can optionally become an automated job. A card gains scheduling powers:

**New fields on `kanban_tasks`:**
```sql
ALTER TABLE kanban_tasks ADD COLUMN due_date TEXT;           -- ISO timestamp
ALTER TABLE kanban_tasks ADD COLUMN reminder_minutes INTEGER; -- notify N minutes before due
ALTER TABLE kanban_tasks ADD COLUMN action_type TEXT DEFAULT 'none'; -- none/reminder/execute
ALTER TABLE kanban_tasks ADD COLUMN notify_channels TEXT;     -- 'telegram,email,desktop' (comma-sep)
ALTER TABLE kanban_tasks ADD COLUMN recurrence TEXT;           -- null, 'daily', 'weekly', cron expr
ALTER TABLE kanban_tasks ADD COLUMN last_run_at TEXT;          -- for recurring tasks
```

**Three action types:**

| Action Type | Trigger | What Happens |
|-------------|---------|-------------|
| `none` | No automation | Card is passive, user manages manually |
| `reminder` | At due_date (minus reminder_minutes) | Ping user via notify_channels: "Reminder: Buy coffee" |
| `execute` | At due_date | Agent picks up card description as prompt, executes it, reports results |

**Execution flow for `execute` tasks:**
```
1. Scheduler scans kanban_tasks with due_date every 60 seconds
2. Task is due and action_type = 'execute':
   a. Send notification: "Starting work on: [task title]"
   b. Card moves to In Progress
   c. Agent executes the task description as a prompt
   d. For code tasks → spawn CLI worker (Section 3)
   e. For research tasks → spawn research agents (Section 15)
   f. For simple tasks → main agent handles directly
   g. On success:
      - Results added as comment on the card
      - Card moves to Review (or Done if auto-approved)
      - Notification: "Done: [task title]. Results ready for review."
   h. On failure:
      - Error logged as comment
      - Card stays In Progress with error tag
      - Notification: "Failed: [task title]. Error: ..."
   i. Heartbeat monitors progress, sends milestone updates
```

**Recurring `execute` tasks:**
```
Task: "Check my emails every morning" + recurrence: 'daily'
  → First run at due_date
  → Each run: agent executes, adds comment with results
  → Card tracks cumulative history (each run = new comment)
  → last_run_at updated after each execution
  → Never moves to Done (recurring)
  → Next run calculated from recurrence pattern
```

#### 18.5 Task Detail Panel — Schedule Section
The task detail panel (Section 11) gains a "Schedule" section:
- Date/time picker for due date
- Dropdown for action type: None / Reminder / Execute
- Channel checkboxes: Telegram, Email, Desktop
- Reminder offset: At the time / 15 min before / 30 min / 1 hour / 1 day
- Recurrence: One-time / Daily / Weekly / Weekdays / Custom cron
- For `execute` tasks: the card description IS the prompt the agent will run

#### 18.6 Task Scheduler Service — `src/scheduler/task-scheduler.ts`
```typescript
export class TaskScheduler {
  private checkInterval: NodeJS.Timeout;

  start(intervalMs: number = 60000)  // Check every 60 seconds
  stop()

  private async checkDueTasks(): Promise<void>
  private async checkReminders(): Promise<void>  // Tasks with reminder_minutes approaching
  private async executeTask(task: KanbanTask): Promise<void>
  private async handleRecurrence(task: KanbanTask): Promise<void>
  private async notify(task: KanbanTask, message: string): Promise<void>
}
```

Runs alongside the existing `CronScheduler` (which handles `cron_jobs`). They are independent:
- `CronScheduler` → fires standalone routines and simple reminders
- `TaskScheduler` → fires Kanban card automations

#### 18.7 Tool Rewiring — `src/tools/task-tools.ts`
```typescript
// Before: creates row in `tasks` table
// After: creates Kanban card in Personal project

task_add(title, priority?, due_date?) → kanbanCreateTask({
  projectId: personalProjectId,
  title,
  priority,
  due_date,
  action_type: due_date ? 'reminder' : 'none',
  status: 'todo'
})

task_list(status?) → kanbanGetBoard(personalProjectId, { status filter })
task_complete(id) → kanbanMoveTask(id, 'done')
task_delete(id) → kanbanDeleteTask(id)
task_due(hours) → kanbanGetTasksDueSoon(hours)
```

#### 18.8 Startup Migration
On app launch, one-time migration:
```typescript
async function migrateTasksToKanban() {
  // 1. Ensure "Personal" project exists
  // 2. Read all rows from `tasks` table
  // 3. For each: create kanban_tasks entry in Personal project
  //    - Map priority, due_date, status
  //    - Mark as migrated (add column `migrated_at` to tasks table)
  // 4. Log migration to event_log
}
```

### Files to Create/Modify
- CREATE: `src/scheduler/task-scheduler.ts` — Kanban task automation runner
- MODIFY: `src/tools/task-tools.ts` — redirect to Kanban operations
- MODIFY: `src/kanban/index.ts` — add due_date, action_type, notify_channels, recurrence fields + migration
- MODIFY: `src/main/index.ts` — auto-create Personal project, run migration, start TaskScheduler
- MODIFY: `ui/kanban.html` — schedule section in task detail panel
- MODIFY: `src/scheduler/index.ts` — TaskScheduler alongside CronScheduler

---

## 19. Voice / TTS Agent Tools

### What
The app already has a TTS pipeline (Edge TTS, `en-US-BrianMultilingualNeural` voice, MP3 caching) and the chat UI can play audio — but the agent doesn't know it has voice. Give the agent 4 MCP tools to speak on demand, check/toggle auto-TTS, and configure voice settings (e.g., Telegram voice replies).

### Current State
- Edge TTS works: `src/voice/tts.ts` — `synthesizeSpeech(text, outputDir)` → cached MP3
- Chat UI has auto-TTS toggle and playback controls
- Agent has NO voice tools and NO voice section in capabilities prompt
- Agent tells users "I can't speak" even though the app can

### Tools
| Tool | Input | Effect |
|------|-------|--------|
| `speak` | `{ text: string }` | Synthesize text → push `voice:play` to all BrowserWindows → audio plays in chat UI |
| `voice_status` | `{}` | Return current `autoTTS` and `telegramVoiceReplies` settings |
| `voice_toggle` | `{ enabled: boolean }` | Set `voice.ttsEnabled`, push `voice:ttsToggled` to sync UI toggle |
| `voice_config` | `{ telegramVoiceReplies?: boolean }` | Set voice-related settings, return current state |

### Agent Awareness
- Add Voice/TTS section to `buildCapabilitiesPrompt()` documenting all 4 tools
- Agent should speak when: user sent a voice message, delivering reminders, user says "say" or "read aloud"
- Remove "Cannot make calls" from Limitations since voice now works

### Implementation
- CREATE: `src/tools/voice-tools.ts` — 4 tool definitions + handlers + `getVoiceTools()` collection
- MODIFY: `src/tools/index.ts` — import + register in `buildSdkMcpServers()` and `getCustomTools()`
- MODIFY: `src/agent/index.ts` — allowedTools, capabilities prompt, formatToolName, limitations
- MODIFY: `src/main/preload.ts` — `onVoicePlay` and `onVoiceTtsToggled` event bridges
- MODIFY: `ui/chat.html` — listeners for agent-initiated `voice:play` and `voice:ttsToggled`

### Channel-Aware Voice Behavior

Voice behavior differs by channel:

**Telegram (default: ON)**
- Every text reply automatically includes a short voice summary (first paragraph / 2-3 sentences, not the full text)
- `/voice` command toggles voice replies on/off
- Controlled by `telegram.voiceReplies` setting

**Desktop App (default: auto-play OFF)**
- Voice is always pre-generated in background for every response (Edge TTS, free, ~200ms)
- Speaker toggle OFF: voice cached but not played. Click per-message speaker icon for instant playback.
- Speaker toggle ON: voice auto-plays with each response.
- Controlled by `voice.ttsEnabled` setting (header speaker icon)

**Agent Channel Awareness**
- Channel ('telegram' / 'desktop' / 'cron:*') injected into agent system prompt
- Agent knows which channel it's on and adapts voice behavior
- On Telegram: agent does NOT call speak() — voice is automatic
- On Desktop: agent uses speak() only when user explicitly asks

### Additional Implementation (extends tools from above)
- MODIFY: `src/voice/tts.ts` — add `summarizeForVoice()` for Telegram short summaries
- MODIFY: `src/channels/telegram.ts` — use summarized text + add `/voice` command
- MODIFY: `src/agent/index.ts` — inject channel into system prompt + `buildChannelContext()`
- MODIFY: `ui/chat.html` — always pre-cache voice, auto-play gated by toggle

### Edge TTS Fallback (2026-02-04)
Microsoft changed the Edge TTS WebSocket synthesis protocol, breaking all Node.js libraries (`node-edge-tts`, `@andresaya/edge-tts`, `edge-tts-universal`). The auth token update (Chromium version 143.0.3650.75) allows connection, but synthesis messages get rejected (close code 1011).

**Solution:** Dual-backend TTS with automatic fallback:
1. Try Edge TTS first (will auto-work when protocol is fixed)
2. Fall back to macOS `say` command with `Daniel (Enhanced)` voice + ffmpeg MP3 conversion

**Files Modified:**
- `src/voice/tts.ts` — Added `synthesizeWithMacosSay()`, try/catch wrapper, DRM patch at import time

### Channel-Aware Speak Tool (2026-02-04)
The `speak` tool was broadcasting audio to desktop windows even during Telegram conversations, causing unwanted audio playback.

**Solution:**
- Track active channel via `setActiveChannel()`/`getActiveChannel()` in voice-tools
- `handleSpeakTool` skips desktop broadcast when `activeChannel === 'telegram'`
- Updated tool description to explicitly say "DO NOT use for Telegram"
- `src/agent/index.ts` calls `setActiveChannel(channel)` before each query

### Meta-Commentary Stripping (2026-02-04)
Agent responses often start with meta-commentary like "Voice sent with the cleaner summary..." which `summarizeForVoice()` was reading aloud instead of the actual content.

**Solution:**
- Added `stripMarkdownAndMeta()` function to `src/voice/tts.ts`
- Filters out lines starting with voice-related meta phrases before extracting summary

### TTS Toggle Icon Fix (2026-02-09)
The speaker toggle button in the chat header only changed its CSS class (purple highlight) when toggled, but the SVG icon itself never changed — making it hard to tell if auto-read was on or off at a glance.

**Solution:**
- `updateTTSToggleUI()` in `ui/chat.html` now swaps the entire SVG icon:
  - **ON (auto-read active):** Speaker with sound waves
  - **OFF (silent mode):** Speaker with X (muted)
- Default icon is muted (speaker with X) since `autoTTSEnabled` starts false
- Follows the same pattern as the Kanban mute button implementation

### Edge TTS Reliability (2026-02-09)
Brian voice was intermittently replaced by Daniel (macOS fallback) due to Edge TTS timeouts or transient network failures. The fallback was silent — user heard a different voice with no indication of why.

**Solution:**
- Increased timeout from 15s → 30s (longer responses need more synthesis time)
- Added 1 retry with 1s delay before falling back to macOS Daniel
- Proper child process cleanup on timeout (was leaking zombie `edge-tts` processes)
- Clear logging when fallback triggers

**File Modified:** `src/voice/tts.ts`

---

## 21. Telegram Emoji Reactions Tool ✅ DONE

### What
Agent can place emoji reactions (👍, ❤️, 🔥, etc.) on user Telegram messages instead of generating full text replies, saving output tokens. When a reaction alone is sufficient (e.g., acknowledging a request), the agent reacts and returns an empty response.

### Implementation
- **`src/tools/session-context.ts`** — Added `telegramMessageContext` (chatId + messageId) set/cleared per handler
- **`src/tools/telegram-react-tool.ts`** (NEW) — `getTelegramReactToolDefinition()` + `handleTelegramReactTool(input)`, reads context from session-context
- **`src/channels/telegram.ts`** — `reactToMessage()` method via grammY `setMessageReaction` API; all 4 message handlers (text, photo, voice, audio) set/clear context and skip empty responses
- **`src/tools/index.ts`** — Registered in both `buildSdkMcpServers()` and `getCustomTools()`
- **`src/agent/index.ts`** — Added to `allowedTools`, `buildChannelContext('telegram')` mentions react tool, skip forced summary follow-up when `telegram_react` was used

### Files Created/Modified
| File | Change |
|------|--------|
| `src/tools/session-context.ts` | Added telegramMessageContext get/set |
| `src/tools/telegram-react-tool.ts` | NEW — tool definition + handler |
| `src/channels/telegram.ts` | reactToMessage(), context tracking, empty response skip |
| `src/tools/index.ts` | Import + register in SDK + custom tools |
| `src/agent/index.ts` | allowedTools, channel context, summary skip, friendly name |

---

## Implementation Order (Priority)

### Phase 0 — Upstream Ports (Bug Fixes & UX) ✅ DONE
1. ✅ Skills setup: 5 new wizards + inline API key modal (`ui/skills-setup.html`)
2. ✅ Session state persistence (`ui/chat.html`)
3. ✅ Stopped query bug fix (`ui/chat.html`)

### Phase 0.5 — Task Consolidation — Partially ✅
4. ✅ Auto-create "Personal" Kanban project on startup
5. Rewire `task_add/list/complete/delete` tools → Kanban operations in Personal project
6. ✅ Migrate existing `tasks` table rows → Personal project cards (one-time)
7. ✅ Schema columns: `due_date`, `action_type`, `notify_channels`, `recurrence`, `last_run_at`

### Phase 1 — Foundation (Data Layer) — Partially ✅
8. ✅ Universal event log with token tracking (`src/memory/event-log.ts`)
9. ✅ GLM 4.7 client + worker tools (`src/tools/glm-client.ts`, `src/tools/glm-worker.ts`)
10. Actor tracking fixes across all Kanban operations
11. Project selector in New Task modal (quick win)

### Phase 1.5 — Kanban Polish & Telegram ✅ DONE
12. ✅ Move Task to Project (backend + UI dropdown + agent tool)
13. ✅ Description markdown pills + Copy button
14. ✅ Tag & Assignee pills in detail panel
15. ✅ Cross-project overview modal (chart icon button)
16. ✅ Kanban Activity Log — show actor (user/agent/model) on each action
17. ✅ Cross-project All Tasks view — see ALL tasks from ALL projects in one view
18. ✅ Telegram "tasks" command — formatted overview of active tasks, project-grouped
19. ✅ Tray status — show "Telegram: Connected/Disconnected" in system tray menu
20. ✅ SVG icons — replaced emoji icons with clean inline SVGs in Kanban + Chat headers
21. ✅ All Tasks button in Chat header — opens Kanban window from chat

### Phase 2 — Unified Task System & Data Completeness ← CURRENT
_Foundation: everything routes through Kanban, data is clean, nothing lost_
22. ✅ Rewire `task_add/list/complete/delete` tools → Kanban Personal project (unifies all tasks into one system)
23. Actor tracking fixes — ensure every Kanban mutation correctly sets actor (user/claude/glm/system)
24. Store tool output in event_log — save first 2000 chars of every tool result (closes the last data gap)
25. Project selector in New Task modal (quick win, depends on unified task system)
26. Auto-task recording — agent auto-creates Kanban task when no task context exists
27. `/continue` command — shows list of all active projects with status/issues, user picks one to resume
28. ✅ Voice/TTS agent tools + channel-aware voice — 4 MCP tools, channel injection, Telegram /voice command, desktop pre-cache (Section 19)
28b. ✅ Telegram emoji reactions — `telegram_react` tool for token-saving acknowledgments (Section 21)
29. Label precision — definition + negative guidance fields per label (Section 20)
30. Label routing — per-label archive-from-inbox + mark-read after classification/correction/rules (Section 20)
31. Bulk label correction — multi-select emails in history, apply one label to all, train-as-example toggle (Section 20)
32. Searchable label correction popover — replaces native select, auto-fetches labels, overflow-safe positioning (Section 20)
33. Email processing quick-access — dedicated floating window from chat header envelope button, standalone mode (Section 20)
34. History filters — server-side filter by label, time range, clickable sender filter with active filter chips (Section 20)
35. Label card tooltips — hover explanations for all controls: classify, notify, definition, examples, negative guidance, routing (Section 20)
36. Rules editor fixes — label dropdowns use all Gmail labels with auto-fetch, action types have descriptions/tooltips, improved placeholders with variable docs (Section 20)
37. Agent instruction clarity — explicit decision rules for create_reminder vs schedule_task vs calendar_add in workspace CLAUDE.md and default instructions
38. AI Define button — per-label "AI Define" button that calls GLM Flash to generate precise definition + negative guidance from user text and example emails (Section 20)
39. Thread state conditions — rules engine `thread_state` condition (unread/unreplied/awaiting_reply/replied_with_answer/user_only), gog thread fetch with 30-min SQLite cache, lazy evaluation (Section 20)
40. Routing UI improvements — no-action warning, inline exception controls with Archive/Mark-read checkboxes, quick presets (Archive all / Archive+Read / Keep in Inbox), 7-day routing stats counter, dry-run preview table (Section 20)
41. ✅ Agent memory naming — enforce unique fact subjects to prevent overwriting (Section 23.1)
42. ✅ Task project routing — add `project` param to `task_add`, agent must search memory for routing rules before creating tasks (Section 23.1)
43. ✅ Reminder decision tree — clear instructions for `create_reminder` vs Apple Reminders vs Things vs `schedule_task` (Section 23.1)
44. Dynamic rules pattern — routing rules live in facts, agent searches on-demand instead of system prompt bloat (Section 23.1) — instructions added, full pattern is ongoing
45b. ✅ Kanban project_name resolution — `kanban_create_task`, `kanban_log_research`, `kanban_move_task_to_project` resolve by name instead of numeric ID (Section 23.2)
45c. ✅ TTS toggle icon — speaker icon swaps between waves (ON) and X (OFF) for clear visual state (Section 19)
45d. ✅ Edge TTS reliability — retry + longer timeout + process cleanup to keep Brian voice consistent (Section 19)

### Phase 2B — Multi-Agent Research System ← IMMEDIATE PRIORITY
_Enables parallel research with multiple SDK agents, compiled by GLM_

45. **Research Orchestrator** — `src/agent/research.ts`
    - `breakIntoSubTopics(query)` — GLM splits user query into 2-4 focused sub-topics
    - `spawnResearchAgent(subTopic)` — wrapper around SDK `query()` with research-focused prompt
    - `executeResearch(request)` — spawns parallel agents via `Promise.all()`
    - `compileResults(results[])` — GLM deduplicates and compiles findings
    - Progress streaming via EventEmitter

46. **Research Tools** — `src/tools/research-tools.ts`
    - `research(query, project?)` — triggers multi-agent research, returns job_id
    - `research_status(job_id)` — check progress (agents running, sources found)
    - `get_research(job_id)` — retrieve completed research report

47. **Research Database** — `research_jobs` table
    - Schema: `id, query, sub_topics JSON, status, agent_results JSON, compiled_report, sources JSON, token_usage JSON, created_at, completed_at`
    - Tracks each research job lifecycle

48. **Kanban Integration**
    - Auto-create task tagged `research` when research starts
    - Update task description as agents complete
    - Final compiled report stored in task
    - Voice summary button for TTS readout

49. **Notifications & Progress**
    - Telegram: "🔍 Research started: 3 agents on 'Sofia house prices'"
    - Telegram: "✅ Research complete: 42 sources, report ready"
    - Desktop notifications for completion
    - Real-time progress in chat UI

50. **SDK Agent Optimizations for Research** (from Section 23 review)
    - Retry logic with exponential backoff (prevent mid-research failures)
    - Streaming progress (show agent activity in real-time)
    - Per-agent token tracking

### Phase 3 — GLM Background Loop & Scheduling
_Depends on: unified tasks (Phase 2), complete event data (Phase 2)_
_Central service: `src/scheduler/glm-loop.ts` — orchestrates all parallel GLM jobs_
_Control panel: Settings → GLM Background Jobs — toggle/configure each job_

#### 3A. GLM Email Processor (every 20-30 min, configurable) — v2 with Codex reliability fixes
29. **Email Processing Service** — `src/scheduler/email-processor.ts`
    - **Checkpoint-based tracking**: per-account `last_internal_date_ms` in SQLite, NOT `newer_than:Xm`. Survives app offline/restart.
    - **Idempotent via `AI/Processed` label**: auto-created, applied to every classified email. Fetch query excludes `-label:AI/Processed`. Safe across crashes, reinstalls, multi-machine.
    - **Base query: `in:inbox`** (not categories). Categories are optional filter. Works even with categories disabled.
    - **Full email bodies** via `gog gmail get [messageId]` (not snippets)
    - **Concurrency-limited**: Gmail getMessage max 4 concurrent, GLM classify max 3 concurrent
    - **Retry with exponential backoff**: 2s → 4s → 8s, max 3 retries for transient errors
    - **GLM returns messageId** (not index). Must match exact label names. Low confidence → `AI/Review` label.
    - **Batch of 5**: group emails, fire batches to GLM Flash in parallel
    - **Few-shot examples**: 2-3 example emails per label (user picks from recent emails in settings)
    - **Label application**: predicted label + `AI/Processed` marker via `gog gmail labels modify`
    - **Notification rules**: notify for labels with `notify: true` AND high/medium confidence. Always notify for `AI/Review`.
    - **3 SQLite tables**: `email_processing_checkpoints`, `email_processing_state`, `email_processing_runs`
    - **11 settings keys**: enabled, intervalMin, accounts, categories, labelConfig, processedLabel, reviewLabel, maxEmailsPerRun, gmailConcurrency, glmConcurrency, lookbackDays
    - Scaling: 55 emails = 11 batches, 4 GLM rounds (conc:3), ~5s, ~$0.03. Monthly: ~$1-2.
30. **Email Settings UI** — `ui/settings.html` Email Processing section
    - Enable/disable toggle for the whole email processing job
    - Accounts to monitor (checkboxes, fetched from gog auth)
    - Categories to scan (optional: primary/updates/social/promotions/forums)
    - Scan frequency dropdown (20/30/60 min)
    - "Fetch Labels" button to refresh label list from Gmail API
    - Per-label configuration: description, notify toggle, 2-3 example emails
    - "Pick from Recent Emails" modal for adding examples
    - Advanced section: processed/review label names, concurrency, lookback days
    - Processing status: last run time, emails processed, next run, "Run Now" button

#### 3B. GLM Session Notes (every 30 min)
31. **Session Notes Service** — `src/scheduler/session-notes.ts`
    - For each active session: read messages + event_log + activity_log
    - For each active worker: read output + events
    - Fire all session/worker note jobs to GLM in parallel
    - GLM produces structured notes: what worked, what failed, user complaints, decisions
    - Save to `session_notes` table (session_id, task_id, worker_id, notes JSON, timestamp)
    - One global merge pass: cross-session summary
32. **GLM Event Triggers** — instant notes (don't wait for 30-min sweep)
    - Worker failure → GLM summarizes immediately
    - User complaint (negative sentiment) → GLM flags as unresolved
    - Task moved to blocked → note saved

#### 3C. Scheduling & Notifications
33. Kanban TaskScheduler — execute/remind on `due_date` (`src/scheduler/task-scheduler.ts`)
34. Task detail panel — schedule section (due date, action type, channels, recurrence)
35. Telegram notifications for urgent emails (uses email processor notify pipeline)

#### GLM Parallel Architecture
All GLM jobs use `Promise.all` for maximum parallelism. In a single 30-min sweep:
```
Email labeling:      11 calls (55 emails × full body, batches of 5)
Session notes:        3 calls (3 active sessions)
Worker monitoring:    2 calls (2 CLI workers)
─────────────────────
Total:               16 parallel GLM calls
Time:                2-3 seconds
Cost:                ~$0.03 per sweep, ~$1.50/day
```

### Phase 4 — Intelligence & Continuity
_Depends on: session_notes (Phase 3), GLM loop running_
36. **Session briefing on startup** — read session_notes + kanban state + event_log errors → GLM compresses into ~800 token briefing → injected into system prompt. Manager knows everything from previous sessions.
37. Daily summary generation — GLM compiles all session_notes from previous day into morning digest, sent to Telegram
38. GLM project prioritization — morning recommendations ("what should I work on today?") based on unresolved issues, stale tasks, momentum

### Phase 5 — Monitoring & Organization
_Depends on: scheduler (Phase 3), intelligence (Phase 4)_
39. Universal heartbeat system — monitors active workers/jobs, pings Telegram at milestones
40. Tag & assignee system — autocomplete, dropdown, colors, routing (assign to worker/glm/claude)
41. Project folder manager — plan subfolders with PLAN.md, TODO.md, PROGRESS.md

### Phase 6 — Workers & Research
_Depends on: heartbeat (Phase 5), tag routing (Phase 5), scheduler (Phase 3)_
42. Worker manager + execution DB (`src/workers/`)
43. Claude CLI spawning + Kanban integration (workers build code, heartbeat monitors)
44. Multi-agent research orchestrator (`src/agent/research.ts`)
45. Research tools + Kanban research filter

### Phase 7 — Cloud Backup & Sync
_Depends on: stable system — all data in Kanban/SQLite, nothing scattered_
46. Upload all Pocket Agent data (DB, attachments, photos) to cloud storage
47. Enable migration to another computer with full state restore
48. Choose backend (S3, Google Drive, or iCloud)

### Completed Phases
- ✅ Phase 5 (old) — Gmail integration (gog CLI — 8 tools, multi-account)

---

## 20. Label Precision — Definition & Negative Guidance

### What
Improve GLM email classification precision by replacing the single-line `description` field with a richer `definition` textarea, and adding a new `negative` guidance field per label. This teaches the GLM what a label IS and what it IS NOT, reducing collisions and false positives.

No new labels, no new label types, no conditional logic. Labels remain semantic state. This is human-in-the-loop semantic tuning via text.

### Data Model
Extend existing `LabelConfig` type in `src/scheduler/email-processor.ts`:

```typescript
type LabelConfig = Record<string, {
  notify?: boolean;
  description?: string;   // kept for backward compat (lazy migration)
  definition?: string;     // NEW — replaces description, richer text
  negative?: string;       // NEW — negative guidance (free-form text)
  examples?: Array<string | { messageId: string; subject?: string; from?: string }>;
}>;
```

- `definition`: plain text paragraph — what this label represents, when it should apply
- `negative`: plain text lines — what this label is NOT (exclusions, counter-examples)
- `description` kept in type for backward reads. Code reads `definition ?? description` everywhere. On edit, writes `definition` and deletes `description`.
- No new tables. No settings schema changes. Same JSON blob in `gmail.emailProcessing.labelConfig`.

### GLM Prompt Changes
`buildGlmPrompt()` AVAILABLE LABELS section changes from flat list to structured blocks:

```
AVAILABLE LABELS:

## Guest Posts
Definition: Emails requesting guest posts or link placements on our blog
NOT this label: SEO service offers
Press release announcements

## Clients
Definition: Emails from active clients about ongoing projects
```

New rule added: "Negative guidance takes priority. If an email matches a label's negative guidance, do NOT assign that label."

Labels without definition or negative guidance omit those lines cleanly.

### UI Changes — Label Card
Each label card in Settings → Labels tab becomes:

```
+----------------------------------------------+
| [x] Classify    Label Name       [x] Notify  |
|----------------------------------------------|
| Definition                                    |
| [textarea: "What this label represents..."]  |
|                                              |
| > Advanced (examples & negative guidance)     |
|   [collapsed by default, toggle open/close]  |
|   Examples: [pill] [pill] [+ Add]            |
|   Negative Guidance                          |
|   [textarea: "What this label is NOT..."]    |
+----------------------------------------------+
```

- Description `<input>` → Definition `<textarea rows="2">`
- Examples + negative guidance collapsed behind "Advanced" toggle
- Toggle state: in-memory only, default collapsed, no persistence needed

### Simplifications from Original Spec
| Proposed | Decision | Reason |
|---|---|---|
| `negative` as `string[]` with "NOT:" prefix parsing | Single `string` (textarea content) | No parsing needed. GLM gets text verbatim. |
| "Insert template" button | Skip — use placeholder text | Placeholder achieves same guidance, zero JS. |
| Persist toggle collapse state | In-memory only | Not worth a setting or data model field. |
| Eager `description` → `definition` migration | Lazy fallback reads | Zero risk. Old data works immediately. |

### Files to Modify
- MODIFY: `src/scheduler/email-processor.ts` — `LabelConfig` type, `buildLabelList()` return type, `buildGlmPrompt()` template
- MODIFY: `ui/settings.html` — CSS (textarea + toggle styles), `epRenderLabels()` card template, 3 new JS functions (`epSetLabelDefinition`, `epSetLabelNegative`, `epToggleAdvanced`), remove `epSetLabelDesc`

### Failure Scenarios
| Scenario | Expected behavior |
|---|---|
| Label collision (email matches definition but also negative guidance) | Negative guidance wins. Label not applied. Falls to next best or AI/Review. |
| Over-broad definition ("emails about content") | High invalid/low confidence. Visible in History. User refines text. |
| User over-fits (too many negatives) | Drop in classification rate visible in History. User removes negatives. |
| Conflicting positive example vs negative guidance | Negative guidance wins. Email goes to AI/Review if no other label fits. |

### What NOT to Build
- No regex editors, condition builders, or nested logic
- No rule duplication inside labels
- No auto-generated text or suggestions
- No new label types or categories

---

## v4.1 — Email Intelligence Roadmap

**Focus:** Mature the email processing pipeline from classification → full inbox management.

### Phase A: Routing Observability + Kill Switch ✅ DONE
_Routing Phase 1 from `docs/designs/email-label-routing.md`_
- ✅ `routing_result` + `routing_error` columns on `email_processing_state`
- ✅ Rewrite `applyRouting()` → return `{ result: 'filed' | 'in_inbox', error?: string }`
- ✅ Global `routingEnabled` kill switch setting + toggle at top of Labels tab
- ✅ 3-state badge in History (Filed / In Inbox / Routing failed)
- ✅ Global routing defaults (Archive from Inbox, Mark as read, Keep in Inbox when uncertain)
- ✅ Per-label routing exceptions with override pattern (`routingOverride` on LabelConfig)
- ✅ Exception management UI in routing section (add/remove directly)
- ✅ Removed activeLabels filter — ALL labels always sent to GLM for classification
- ✅ Renamed "Classify" → "Pin" (cosmetic sort only, no longer gates GLM)
- ✅ GLM concurrency set to 1 (Zhipu API doesn't support concurrent calls reliably)
- **Design:** `docs/designs/email-label-routing.md`

### Phase B: Rules v2 — OR Logic (Condition Groups) ← CURRENT
- `ConditionGroup = { mode: 'AND' | 'OR'; items: Condition[] }`
- `conditions_json` migrated from `Condition[]` → `ConditionGroup[]`
- Outer AND across groups; inner AND/OR per group
- UI: "+ Add Group" with per-group mode dropdown
- Test output: per-group pass/fail detail
- **Design:** `docs/designs/rules-v2-or-logic-and-draft-reply.md`

### Phase C: Draft Reply Addressing
- `replyTarget` (reply_to / from / custom), `customTo`, `cc`, `bcc`
- `subjectPrefix`, `skipNoReply`, `skipAutoGenerated`, `includeQuotedOriginal`
- Extract Reply-To, Auto-Submitted, Precedence, List-Id headers
- Recipient logic with fallbacks, skip logic for no-reply/auto-generated
- Compact "Addressing" expandable in draft_reply action row
- **Design:** `docs/designs/rules-v2-or-logic-and-draft-reply.md`

### Phase D: Label Definitions + GLM Prompt Improvements
- Add `positiveTextExamples: string[]` and `negativeTextExamples: string[]` to LabelConfig
- GLM prompt includes all 6 fields per label (definition, negative, examples, positive text, negative text, email examples)
- 4-field layout per label card + email examples
- Conflict warning if same phrase appears in multiple labels
- **Design:** `docs/designs/label-definition-and-pickers.md`

### Phase E: Searchable Label Pickers ✅ DONE (v4.3)
- ✅ Reusable `epCreateSearchableLabel()` component with type-to-filter + keyboard nav
- ✅ Applied to: rule editor conditions, rule editor actions, history filter
- Remaining: History correction picker, Recent/Frequent/All sections, routing destination picker
- **Design:** `docs/designs/label-definition-and-pickers.md`

### Phase F: Unanswered Command Center + Telegram
- Thread unanswered = inbound exists, last inbound > last outbound, not dismissed/resolved
- `on_unanswered_scan` trigger (scheduled, scan-based)
- `unanswered_state` table with state machine (unanswered → resolved / dismissed)
- `src/scheduler/unanswered-engine.ts` using existing getThread + computeThreadState
- Rules: `unanswered_age_minutes_gt`, `state_is_not` conditions; `send_unanswered_digest`, `draft_reply` actions
- UI tab: "Unanswered" with filters, Scan Now, per-item + batch actions
- Telegram: `/unanswered` command with reply actions
- **Design:** `docs/designs/unanswered-command-center.md`

### Phase G: Routing Phases 2-4
- Phase 2: Manual File/Retry/Restore buttons in History
- Phase 3: Destination label (`routeToLabel`) with searchable picker
- Phase 4: Bulk routing controls + default routing for new labels
- **Design:** `docs/designs/email-label-routing.md` (Phases 2-4)

### v4.2: Email Ops Clarity & Safety

Implemented changes for operational clarity, reversibility, and auditability:

1. **Badge legend** — "?" button in History header showing all badge types, colors, and meanings
2. **Split "In Inbox" badge** — 3 sub-states: "Kept (uncertain)" orange, "No routing" grey, "Routing failed" red
3. **Confidence filter** — dropdown in History tab (high/medium/low/invalid)
4. **Routing status filter** — dropdown in History tab (Filed/Kept/Failed)
5. **Restore/File buttons** — per-row actions in History to move emails in/out of inbox
6. **Draft reply noreply detection** — skip noreply/mailer-daemon/blocked domains before creating drafts
7. **Draft reply domain blocklist** — user-configurable setting `gmail.emailProcessing.draftReply.blockedDomains`
8. **Throttle logging** — log throttled Telegram messages to execution record instead of silent drop
9. **Rule execution log** — read-only panel in Rules tab showing recent rule firings
10. **Daily digest auto-schedule** — wire existing `dailySummaryTime` setting to a minutely check timer

**Deferred:** OR logic in conditions, auto-send, Telegram inline keyboards, Reply-To header support.

### v4.3: Rules UX & Prompt Clarity

UI-only changes in `ui/settings.html` — no backend or rule engine changes.

1. **Searchable label dropdown** — reusable `epCreateSearchableLabel()` component with type-to-filter, keyboard nav (Arrow/Enter/Escape), and click-outside close. Applied to rule editor conditions (`label_is`/`label_is_not`), actions (`apply_label`/`remove_label`), and history filter. Hidden `<input>` preserves save/load contract.
2. **Rule test "Show only matching" toggle** — checkbox in test results header to hide non-matching rows, reducing noise when tuning rules.
3. **Draft reply prompt textarea** — replaced single-line `<input>` with multi-line `<textarea>` (6 rows, resizable) plus helper text explaining the prompt's role. Default prompt pre-filled for new rules via `EP_DEFAULT_DRAFT_PROMPT`.
4. **Default example prompt** — `EP_DEFAULT_DRAFT_PROMPT` constant providing a complete guest-post-decline template as starter prompt for new `draft_reply` actions.
5. **Template variable `{draft}`** — `interpolateTemplate()` extended with `extras` map; `{draft}` resolves to "Draft reply queued" when rule includes a `draft_reply` action, empty otherwise. Available in Telegram and email templates.
6. **Variable reference tooltips** — `EP_TEMPLATE_VARS` array lists all 6 template variables (`{subject}`, `{sender}`, `{label}`, `{preview}`, `{confidence}`, `{draft}`) with descriptions. Telegram and email template inputs show full variable list on hover.

### v4.4: Phase F — Unanswered Command Center + Reply Control + GLM Tiered Models

Surfaces threads needing response and provides dismiss/resolve workflows. Design spec: `docs/designs/unanswered-command-center.md`.

1. **GLM tiered model system** — `glmBulk()` using FlashX (`glm-4.7-flashx`, 3 concurrent) for email classification throughput; `glmFlash()` kept for quality-sensitive tasks (draft replies, digests, label refinement). Default `glmConcurrency` raised to 3. Health check pings both models (skips duplicate if same).
2. **`UnansweredEngine`** — new `src/scheduler/unanswered-engine.ts`. Scans Gmail for unreplied threads using existing `computeThreadState()`, upserts into `unanswered_state` table with state lifecycle (`unanswered -> resolved/dismissed`). Supports scheduled scans, digest generation, and per-account throttling.
2. **`unanswered_state` table** — schema: `(account, thread_id, message_id, subject, sender, label, state, first_seen_at, last_scanned_at, resolved_at, dismissed_at)`. Dismissed threads are sticky unless a new inbound message arrives.
3. **Rules engine extensions** — `on_unanswered_scan` trigger type; three new conditions (`label_in`, `unanswered_age_minutes_gt`, `state_is_not`); three new actions (`send_unanswered_digest`, `mark_resolved`, `dismiss`).
4. **IPC handlers** — `unanswered:scan`, `unanswered:list`, `unanswered:resolve`, `unanswered:dismiss`, `unanswered:resolveAll`, `unanswered:dismissAll`, `unanswered:digest`, `unanswered:getSettings`, `unanswered:saveSettings`.
5. **Telegram `/unanswered` command** — lists unanswered threads with filters (`label:X`, `age:Nh`). Follow-up replies: `N draft`, `N resolve`, `N dismiss`.
6. **"Unanswered" UI tab** — new tab in Email Processing section with enable toggle, scan interval, lookback days, label multi-select, thread list with per-row actions (Draft Reply / Resolve / Dismiss), batch actions, Scan Now button, Send Digest button.
7. **Scheduled scan** — auto-scan at app startup when enabled, respects `gmail.unanswered.intervalMin` setting. After scan, evaluates rules with `on_unanswered_scan` trigger.

### v4.5: Reclassify + Rules Usability + Unanswered Fix

1. **AI/Draft label on draft replies** — `actionDraftReply()` applies "AI/Draft" label after `createDraft()` succeeds. Best-effort, uses existing `modifyLabels()`.
2. **Next-run timing in Rules tab** — info line showing scan interval, last scan time, next estimated scan.
3. **Replay rules on past emails** — `replayRules(limit)` method + UI button. Re-evaluates active rules against already-classified emails, skipping already-executed combinations.
4. **Reclassify emails** — `reclassifyEmails(messageIds, account)` method. Fetches fresh email content, re-runs GLM classification, updates DB + Gmail labels + routing. Per-row "Retry" button on failed/invalid emails + bulk "Reclassify" action.
5. **Fix unanswered scan** — unwrap `gog` response `{ messages: [...] }` format (was silently getting 0 results); auto-detect `gmail.userEmail` from account name; show scan errors in UI.

### v4.6: Multi-Provider Worker Models + Performance

1. **Unified Worker Models section** — renamed "GLM Worker (Zhipu)" → "Worker Models" in LLM settings. Worker, Flash, and Bulk model dropdowns now include both Zhipu (GLM-4.7/Flash/FlashX) and OpenAI (gpt-4.1-nano/gpt-4o-mini/gpt-4.1-mini) options.
2. **Auto provider routing** — `resolveModelProvider()` in glm-client auto-detects `gpt-*` → OpenAI API + OpenAI key, `glm-*` → Zhipu API + Zhipu key. No manual base URL or API key overrides needed.
3. **Remove duplicate bulk config** — removed Bulk Classification Model section from Email Processing → Advanced (was redundant with LLM page). Provider auto-resolved from model name; API keys centralized in Keys section.
4. **Skip rate-limit delays for OpenAI** — 2s inter-batch sleep only applies to Zhipu models. OpenAI bulk classification runs without artificial delays.
5. **Auto-boost GLM concurrency for OpenAI** — when bulk model is non-Zhipu, effective concurrency auto-raised to min 5 regardless of user setting (Zhipu needs throttling, OpenAI doesn't).
6. **Concurrency guard on reclassify** — `reclassifyEmails()` checks `this.running` flag to prevent racing with scheduled auto-runs. try/finally ensures flag is always released.
7. **"Retry Failed (N)" button** — one-click reclassify all invalid emails across all pages in History tab, with live progress counter.

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
-- 1. Universal event log table (new) — ✅ DONE
-- 2. Worker executions table (new)
-- 3. kanban_tasks: ADD scheduled_at TEXT
-- 4. kanban_tasks: ADD worker_id TEXT
-- 5. kanban_tasks: UPDATE status CHECK to include 'scheduled'
-- 6. cron_jobs: ADD channel TEXT DEFAULT 'chat'
-- 7. cron_jobs: ADD email_recipients TEXT
-- 8. kanban_tasks: ADD due_date TEXT
-- 9. kanban_tasks: ADD reminder_minutes INTEGER
-- 10. kanban_tasks: ADD action_type TEXT DEFAULT 'none'
-- 11. kanban_tasks: ADD notify_channels TEXT
-- 12. kanban_tasks: ADD recurrence TEXT
-- 13. kanban_tasks: ADD last_run_at TEXT
-- 14. tasks: ADD migrated_at TEXT (mark migrated rows)
```

All migrations use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` for backwards compatibility.

---

## 22. Pocket CLI — External Tool Integration

### Overview
Go CLI binary (`pocket`) providing 42 internet service integrations. Installed via Settings > Pocket CLI tab. The agent shells out to `pocket <category> <service> <action>` for ad-hoc queries.

### Categories & Services
| Category | Services |
|----------|----------|
| Social | Twitter, Reddit, Mastodon, Bluesky, Hacker News |
| Comms | Email (IMAP/SMTP), Slack, Discord, Telegram API |
| News | HN, RSS, Google News, TechCrunch |
| Knowledge | Wikipedia, Wolfram Alpha, Stack Overflow |
| Dev Tools | GitHub, GitLab, Jira, Linear, Sentry |
| Productivity | Todoist, Notion, Trello, Google Calendar |
| Utility | Weather, Crypto, Stocks, Currency, URL shortener |
| AI | OpenAI, Anthropic, Gemini, Perplexity |

### How It Works
1. User clicks "Install" in Settings > Pocket CLI tab
2. IPC handler `pocket-cli:install` downloads and installs the Go binary
3. Binary placed in user PATH (e.g., `~/.local/bin/pocket`)
4. Agent uses `execSync('pocket ...')` or shell tool to query services

### No Overlap with Existing Features
- **CLI email** (IMAP/SMTP) is for ad-hoc queries; our Gmail integration (Section 8) uses API + GLM classification for scheduled intelligence
- **CLI Todoist/Notion/Trello** hits external services; our Kanban (Section 18) is local SQLite
- Voice/TTS pipeline is entirely separate

### 22.1 Agent CLI Awareness Fix (2026-02-06) ✅ DONE

### 22.2 CLI Instructions Optimization (2026-02-06) ✅ DONE

**Problem:** Full CLI command reference in CLAUDE.md was ~60 lines (~800 tokens). Adding more tools = prompt bloat.

**Fix:** Trimmed to core no-auth commands (8 rows) + dynamic discovery instructions:
- `pocket commands` — discover ALL commands
- `pocket setup list` — check auth status
- `pocket setup show <service>` — setup help

**Result:** ~400 tokens saved. Agent can discover new tools dynamically without prompt updates.

**Problem discovered:** The deployed `~/Documents/Pocket-agent/CLAUDE.md` (the agent's live instructions) had zero mention of the Pocket CLI. The default template in `src/config/instructions.ts` had a sparse 4-example section, but the file on disk was created before the v2.1.5 merge and was never updated. The agent would use WebSearch for queries that the CLI handles better.

**Fix applied:**
- Updated `~/Documents/Pocket-agent/CLAUDE.md` with full CLI command reference (20+ no-auth commands, 11 auth services)
- Added explicit priority rule: "ALWAYS prefer pocket CLI over WebSearch/WebFetch"
- Added decision guide: when to use `pocket` vs WebSearch
- Updated `src/config/instructions.ts` default template with same comprehensive reference

**Key instruction added:** "Only use WebSearch when pocket has NO matching command" — ensures the agent reaches for `pocket news hn top` instead of googling "hacker news."

### Status: ✅ DONE (installed via upstream v2.1.5 merge, agent instructions updated 2026-02-06)

---

## 23. Agent Memory & Behavior Issues — Research Findings

### Overview
Investigation into why the agent misplaces project assignments, forgets reminders, and why facts count appears stuck.

### Issue 1: Facts UPSERT (Overwrite) Behavior

**Location:** `src/memory/index.ts:1467-1486`

The `saveFact()` function uses **upsert logic**:
```typescript
IF exists(category + subject) → UPDATE existing fact
ELSE → INSERT new fact
```

**Problem:** If the agent saves multiple facts with the same `category + subject` (e.g., all project rules use subject `"project_rule"`), they overwrite each other. This explains why fact count stays low (e.g., 14) even when user adds more rules.

**Fix:** Agent should use **unique subject names** like `project_rule_ken`, `project_rule_semantics`, `reminder_rule_default`.

### Issue 2: What the Agent Actually Reads

Every message, the agent receives facts via `getFactsForContext()`:
```markdown
## Known Facts

### preferences
- **semantics_content_rule**: When user shares anything semantics...

### projects
- **project_routing**: Ken → Ken project...
```

The agent sees ALL facts, but:
- Facts are not in the system prompt (good for token efficiency)
- Agent must proactively search/apply them (model behavior issue)

### Issue 3: Project Routing Not Working

**Root cause:** No enforced project lookup before task creation.

The agent has facts about project routing but doesn't consistently apply them because:
1. No system prompt instruction saying "ALWAYS search project rules before creating tasks"
2. `task_add` tool hardcodes "Personal" project — no project_id parameter
3. Agent claims it will follow rules but fails to invoke the right tools

**Fix needed:**
- Add to system prompt: "Before creating ANY task, call `memory_search('project routing')` to get assignment rules"
- Or: Add `project_id` parameter to `task_add` with guidance on selection

### Issue 4: Reminders vs Tasks Confusion

**Current tools:**
| Tool | What It Does |
|------|--------------|
| `create_reminder` | Internal scheduler — agent fires notification to itself |
| `schedule_task` | Scheduled agent action (check weather, etc.) |
| Apple Reminders | External `remindctl` skill — adds to macOS Reminders app |
| Things 3 | External `things` skill — adds to Things app |

**Problem:** When user says "remind me", agent doesn't know which system to use.

**Fix:** Add decision rule to system prompt:
```
"remind me" / "don't forget" with date → Apple Reminders (remindctl)
Agent needs to DO something → schedule_task
Information to remember → remember tool (facts)
```

### Issue 5: Mind Map Shows Connections But Count Stuck

The mind map shows **facts as nodes** and **connections as links**:
- 14 facts with 38 connections is valid — connections come from semantic similarity + category grouping
- The count IS accurate; issue is overwriting (Issue 1)

### Issue 6: Prompt Bloat Concern

**User concern:** Adding more rules to system prompt = mega tokens every message.

**Proposed pattern: Skills-based dynamic lookup**
```
INSTEAD OF:
  System prompt: 1000 lines of rules → tokens every message

DO:
  System prompt: "Before actions, search facts for relevant rules"
  Agent: Calls memory_search("project routing") → applies dynamically
```

This keeps prompt small while making rules "ever-growing" in facts.

### Recommended Fixes

| Issue | Fix | Priority |
|-------|-----|----------|
| Overwriting facts | Use unique subjects per rule | High |
| Project misplacement | Add mandatory `memory_search` before task creation | High |
| Reminder confusion | Clear decision tree in system prompt | Medium |
| Prompt bloat | Dynamic skill/fact lookup pattern | Medium |
| Agent claims but doesn't act | Model behavior — improve prompt clarity | Low (can't fully fix) |

### Status: 🔬 RESEARCH COMPLETE — Awaiting implementation

---

### 23.1 Implementation Plan — Agent Memory & Behavior Fixes

#### A. Instructions Update (`src/config/instructions.ts` + `~/Documents/Pocket-agent/CLAUDE.md`)

Add new section after "Proactive Behavior":

```markdown
## Memory — Fact Subject Naming

When saving facts with \`remember\`, use UNIQUE subjects to prevent overwriting:

**Good:** `project_rule_ken`, `project_rule_semantics`, `reminder_default_time`
**Bad:** `project_rule` (gets overwritten by next rule)

Format: `{category}_{specific_identifier}` — e.g., `project_routing_ken`, `preference_voice_speed`

## Task Creation — Project Lookup Required

Before creating ANY task with \`task_add\`:
1. Call \`memory_search("project routing")\` to check for routing rules
2. If a rule matches the task context, use the specified project
3. Default to "Personal" only when no rule applies

Example flow:
- User: "Add task for Ken's architecture document"
- Agent: \`memory_search("project routing ken")\` → finds "Ken → Ken project"
- Agent: \`task_add("Architecture document", project="Ken")\`

## Reminders — Decision Tree

| User says | Tool to use | Result |
|-----------|-------------|--------|
| "remind me to X" / "don't forget X" | \`create_reminder\` | Desktop/Telegram notification |
| "add X to my reminders" (Apple) | Bash: \`remindctl add "X"\` | Apple Reminders app |
| "add X to Things" / "todo X" | Bash: \`things add "X"\` | Things 3 app |
| "check weather at 9am" (agent action) | \`schedule_task\` | Agent runs prompt at time |

**Default behavior:** If user says "remind me" without specifying a system, use \`create_reminder\` (internal notification).
```

#### B. Task Tool Enhancement (`src/tools/task-tools.ts`)

Add `project` parameter to `task_add`:

```typescript
// In getTaskAddToolDefinition():
properties: {
  title: { type: 'string', description: 'Task title' },
  project: { type: 'string', description: 'Project name (default: Personal). Check memory for routing rules first.' },
  // ... existing properties
}

// In handleTaskAddTool():
const projectName = params.project || 'Personal';
const project = KanbanService.getProjectByName(projectName)
  || KanbanService.getOrCreatePersonalProject();
```

#### C. Remember Tool Enhancement (`src/tools/memory-tools.ts`)

Update tool description to enforce unique subjects:

```typescript
description: `Save important information to long-term memory.

IMPORTANT: Use UNIQUE subject names to prevent overwriting:
- Good: project_rule_ken, preference_voice, reminder_default
- Bad: project_rule (overwrites previous rules)

Format: {type}_{identifier} — e.g., project_routing_semantics
```

#### D. Dynamic Rules Pattern (Future)

Instead of system prompt bloat, agent searches facts on-demand:

1. **Routing rules** live in facts: `category: "rules", subject: "project_routing_ken", content: "Ken tasks → Ken project"`
2. **System prompt** contains: "Before task/reminder actions, search rules in memory"
3. **Agent flow:** User request → `memory_search("routing rules")` → apply matching rule → execute

This allows unlimited rules without growing the system prompt.

#### Files to Modify

| File | Change |
|------|--------|
| `src/config/instructions.ts` | Add Memory naming, Task lookup, Reminder decision sections |
| `~/Documents/Pocket-agent/CLAUDE.md` | Same content (live instructions file) |
| `src/tools/task-tools.ts` | Add `project` param to task_add |
| `src/tools/memory-tools.ts` | Update remember description for unique subjects |
| `src/kanban/index.ts` | Add `getProjectByName(name)` method |

### Status: ✅ IMPLEMENTED (2026-02-06)

### 23.2 Kanban Project Name Resolution (2026-02-09)

Despite adding `project` routing to `task_add` (23.1), the kanban-specific tools (`kanban_create_task`, `kanban_log_research`, `kanban_move_task_to_project`) still required numeric `project_id` — which the LLM often guessed wrong, saving tasks to the wrong project.

**Root Cause:**
1. `kanban_create_task` required `project_id` (number) — LLM guesses IDs incorrectly
2. `kanban_log_research` hardcoded "Research" project with no override
3. Agent instructions only covered `task_add` for project routing, so kanban tools bypassed routing

**Solution:** Added `project_name` (string, case-insensitive) parameter to all three kanban tools, using existing `KanbanService.getProjectByName()` for resolution:

| Tool | Change |
|------|--------|
| `kanban_create_task` | Added `project_name` (preferred over `project_id`), removed `project_id` from required |
| `kanban_log_research` | Added `project_name` to override default "Research" project |
| `kanban_move_task_to_project` | Added `project_name` (preferred over `project_id`), removed `project_id` from required |

**Files Modified:**
| File | Change |
|------|--------|
| `src/tools/kanban-tools.ts` | Added `project_name` param + resolution logic to 3 tools |
| `src/config/instructions.ts` | Updated routing instructions to cover all kanban tools |
| `~/Documents/Pocket-agent/CLAUDE.md` | Same routing guidance in live instructions |

### Status: ✅ IMPLEMENTED (2026-02-09)

---

## 24. Multi-Agent Research System — Implementation Plan

### Overview

Enable the manager agent to spawn multiple parallel Claude SDK agents for deep research. Each sub-agent focuses on one aspect of the query, results are compiled by GLM, and stored in Kanban.

### Architecture

```
User: "Research house prices in Sofia"
              ↓
┌─────────────────────────────────────────────────────────────┐
│  MANAGER AGENT (main Claude instance)                       │
│  1. Receives research request                               │
│  2. Calls GLM to break into sub-topics                      │
│  3. Creates research_job in DB (status: 'running')          │
│  4. Creates Kanban task tagged 'research'                   │
└─────────────────────────────────────────────────────────────┘
              ↓
        Promise.all([...])  ← PARALLEL EXECUTION
              ↓
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ SDK Agent 1 │  │ SDK Agent 2 │  │ SDK Agent 3 │
│ Topic A     │  │ Topic B     │  │ Topic C     │
│ 20 turns    │  │ 20 turns    │  │ 20 turns    │
│ WebSearch   │  │ WebSearch   │  │ WebSearch   │
│ WebFetch    │  │ WebFetch    │  │ WebFetch    │
└─────────────┘  └─────────────┘  └─────────────┘
              ↓
┌─────────────────────────────────────────────────────────────┐
│  GLM POST-PROCESSOR                                         │
│  - Deduplicate findings                                     │
│  - Compile into report                                      │
│  - Generate executive summary                               │
└─────────────────────────────────────────────────────────────┘
              ↓
    Kanban task + Telegram notification
```

### Core Mechanism: Parallel SDK Queries

The key insight: multiple `query()` calls run in parallel via `Promise.all()`:

```typescript
const subTopics = await glmSplitQuery(query);  // GLM breaks into 3 topics

const agentPromises = subTopics.map(topic =>
  runResearchAgent(topic)  // Each is an independent SDK query()
);

const results = await Promise.all(agentPromises);  // Run all in parallel

const report = await glmCompile(results);  // GLM merges findings
```

### Files to Create

| File | Purpose |
|------|---------|
| `src/agent/research.ts` | ResearchOrchestrator class with execute(), progress events |
| `src/tools/research-tools.ts` | `research`, `research_status`, `get_research` tools |

### Files to Modify

| File | Change |
|------|--------|
| `src/tools/index.ts` | Register research tools |
| `src/agent/index.ts` | Add research tools to allowedTools |
| `src/memory/db.ts` | Add `research_jobs` table schema |
| `ui/kanban.html` | Research filter button, voice summary on research tasks |

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS research_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  sub_topics TEXT,           -- JSON array
  status TEXT DEFAULT 'pending',
  agent_results TEXT,        -- JSON array
  compiled_report TEXT,
  summary TEXT,              -- For TTS
  sources TEXT,              -- JSON array
  kanban_task_id INTEGER,
  token_usage TEXT,          -- JSON
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  completed_at TEXT
);
```

### Key Interfaces

```typescript
interface ResearchRequest {
  query: string;
  projectId?: number;
  maxAgents?: number;        // default 3, max 5
  maxTurnsPerAgent?: number; // default 20
}

interface ResearchResult {
  jobId: number;
  report: string;            // Full markdown
  summary: string;           // TTS-friendly
  sources: Array<{ url: string; title: string; topic: string }>;
  tokenUsage: { prompt: number; completion: number; total: number };
  kanbanTaskId: number;
}
```

### Cost Optimization

| Component | Model | Cost |
|-----------|-------|------|
| Split query into topics | GLM Flash | ~$0.001 |
| Research agents (x3) | Sonnet 4.5 | ~$0.15-0.30 each |
| Compile results | GLM | ~$0.01 |
| **Total per research** | | ~$0.50-1.00 |

Using Sonnet instead of Opus for research agents saves ~70% while maintaining quality.

### Progress Streaming → Telegram Messages

**Decision:** Stream progress via Telegram messages so user knows it's working.

When research starts and progresses, send Telegram updates:
```
🔬 Starting research: "house prices in Sofia"
   Breaking into 3 sub-topics...

📚 Agent 1/3 started: "Population and demographics"
📚 Agent 2/3 started: "Real estate prices by district"
📚 Agent 3/3 started: "Cost of living comparison"

✅ Agent 1 done: 8 sources found
✅ Agent 2 done: 12 sources found
✅ Agent 3 done: 6 sources found

📝 Compiling results...

✅ Research complete! 26 sources, ~$0.47
   View full report in Kanban
```

**Implementation:**

```typescript
class ResearchOrchestrator extends EventEmitter {
  constructor(private telegramBot: TelegramBot, private chatId: number) {
    super();

    this.on('start', async ({ query, subTopics }) => {
      await telegramBot.sendMessage(chatId,
        `🔬 Starting research: "${query}"\n   Breaking into ${subTopics.length} sub-topics...`
      );
    });

    this.on('agent-start', async ({ agentIndex, topic, total }) => {
      await telegramBot.sendMessage(chatId,
        `📚 Agent ${agentIndex}/${total} started: "${topic}"`
      );
    });

    this.on('agent-complete', async ({ agentIndex, sourcesFound }) => {
      await telegramBot.sendMessage(chatId,
        `✅ Agent ${agentIndex} done: ${sourcesFound} sources found`
      );
    });

    this.on('complete', async ({ sources, cost }) => {
      await telegramBot.sendMessage(chatId,
        `✅ Research complete! ${sources.length} sources, ~$${cost.toFixed(2)}\n   View full report in Kanban`
      );
    });
  }
}
```

### Integration Points

1. **Telegram**: `/research <query>` command
2. **Chat UI**: "Research this" button on messages
3. **Kanban**: Research tasks auto-created, tagged `research`
4. **Voice**: "Read research summary" triggers TTS on executive summary

### Status: ✅ IMPLEMENTED — Core research orchestrator complete

**Files Created:**
- `src/agent/research.ts` — ResearchOrchestrator with parallel SDK agents
- `src/tools/research-tools.ts` — `research` and `research_status` tools

**Files Modified:**
- `src/tools/index.ts` — Registered research tools
- `src/agent/index.ts` — Added to allowedTools
- `src/main/index.ts` — Connected Telegram bot for progress streaming

**Next Steps:**
- Add `research_jobs` table to database for persistence
- Create Kanban tasks for research results
- Add research filter button to Kanban UI

---

## Implementation Summary (2026-02-06)

### ✅ Completed Today
| Section | Feature | Status |
|---------|---------|--------|
| 21 | Telegram Emoji Reactions | ✅ Done |
| 22 | Pocket CLI Integration | ✅ Done |
| 23.1 | Agent Memory Fixes (unique subjects, task routing) | ✅ Done |
| 23.2 | Kanban Project Name Resolution | ✅ Done |
| 19 | TTS Toggle Icon + Edge TTS Reliability | ✅ Done |
| 24 | Multi-Agent Research System | ✅ Core Complete |

### 🚧 In Progress
| Section | Feature | Next Action |
|---------|---------|-------------|
| 24 | Research Persistence | Add `research_jobs` table |
| 15 | Research Kanban UI | Add filter button for research tasks |

### 🐛 Bug Fixes (2026-02-06 — 2026-02-09)

| Issue | Root Cause | Fix |
|-------|------------|-----|
| Telegram stops responding after 1 message | Health check detected stale connection but only logged instead of reconnecting. `lastSuccessfulPoll` wasn't updated on message receipt. | Made health check actually trigger reconnection. Update `lastSuccessfulPoll` on every message handler. |
| TTS timing out (30s) / Voice robotic | Node.js Edge TTS packages (`edge-tts-universal`) broken/hanging. Fallback to macOS `say` was robotic. | Switched to Python `edge-tts` CLI which works reliably. Now uses **Brian** voice (en-US-BrianMultilingualNeural) - young American male neural voice. Fallback is Daniel (Enhanced) if CLI fails. |
| Research notifications incomplete | Only showed agent count, not topics | Enhanced Telegram notifications to show full agent list with what each agent will research |
| Kanban tasks saved to wrong project | `kanban_create_task` required numeric `project_id` — LLM guessed wrong IDs | Added `project_name` (string, case-insensitive) to all kanban tools, resolves via `getProjectByName()` |
| TTS toggle icon not reflecting state | `updateTTSToggleUI()` only toggled CSS class, SVG icon never changed | Swap entire SVG: speaker+waves (ON) vs speaker+X (OFF) |
| Brian voice intermittently replaced by Daniel | Edge TTS timeout (15s) or transient network fail → silent fallback to macOS say | Increased timeout to 30s, added 1 retry, proper child process kill on timeout |

### ✅ Completed (2026-02-15)
| Section | Feature | Status |
|---------|---------|--------|
| 34 | Upstream Port Phase 6 — v2.4.1 Full Merge | ✅ Done |
| 35 | Cron Jobs Survive Mac Sleep/Wake | ✅ Done |

### 📋 Upcoming Priorities
1. **Research Persistence** — Save research jobs to SQLite
2. **Kanban Integration** — Auto-create tasks tagged `research`
3. **Voice Summary** — TTS for research executive summaries
4. **CLI Worker System** — Spawn Claude CLI for code tasks (Section 3)

---

## 25. Windows Build & Distribution

**Status:** NOT STARTED
**Priority:** Medium
**Prerequisites:** v2.2.6 merge ✅ (Windows platform support already in codebase)

### Goal

Produce a Windows `.exe` installer so Pocket Agent can run on Windows machines.

### What's Already Done (from v2.2.6 merge)

- Platform-aware PATH setup (`IS_WINDOWS` constant, PowerShell shell selection)
- Windows-compatible shell command execution in `shell:runCommand`
- `icon.ico` added for Windows builds
- `process.platform` checks in main process
- `getPlatform()` exposed to renderer

### What's Needed

1. **Build environment** — Set up a Windows machine or VM (or GitHub Actions CI) to run `npm run dist:local` and produce `.exe`/`.msi` installer
2. **Native module compilation** — `better-sqlite3` must be compiled for Windows/x64 (electron-rebuild on Windows)
3. **Code signing** — Optional but recommended for Windows SmartScreen (unsigned apps show warnings)
4. **Testing** — Full smoke test on Windows:
   - App launches, tray icon works
   - Telegram bot connects
   - Shell commands execute via PowerShell
   - Voice/TTS (Edge TTS should work cross-platform, macOS `say` fallback won't — need Windows alternative)
   - Browser automation (Chrome CDP)
   - File paths (backslash handling)
5. **macOS-specific features** — Audit and skip gracefully on Windows:
   - `osascript` calls (Apple Notes, Reminders, etc.)
   - Keychain access (`safeStorage` should work cross-platform via Electron)
   - `open` command → `start` on Windows (already handled in some places)
6. **TTS fallback** — Replace macOS `say` with Windows `powershell -c "Add-Type -AssemblyName System.Speech; ..."` or similar
7. **Auto-updater** — Verify `electron-updater` works with Windows `.exe` builds
8. **GitHub Actions** — Add Windows to CI matrix for automated builds

### Stretch Goals

- Linux `.AppImage` / `.deb` build
- Cross-compilation from macOS using electron-builder (may work for simple cases)

---

## 26. Workflow-Routine Integration

**Status:** NOT STARTED
**Priority:** High
**Upstream coexistence:** This feature is additive — uses our existing `commands-loader.ts` and the scheduler's `prompt` field. Upstream routines continue to work as before (plain text prompts). No upstream files are modified; this only touches our scheduler code.

### The Problem

Routines and workflows are conceptually the same thing — a set of instructions for the agent. The difference is only the trigger:
- **Workflows** = manual (UI click or `/command` in Telegram), template lives in `.md` file
- **Routines** = automatic (cron schedule), prompt is inline text in the database

This means if you improve a workflow's instructions, you have to manually update every routine that does the same thing. They should share the same source of truth.

### The Solution

Allow routines to reference a workflow by name. When the scheduler fires, it loads the workflow's `.md` content and sends it as the prompt.

**Syntax:** In the routine's prompt field, use `@workflow:name` to reference a workflow:
- `@workflow:standup` → loads `standup.md` from commands directory
- `@workflow:standup Check the kanban board too` → loads workflow + appends user context
- `Run my morning email check` → plain text, works as before (backwards compatible)

### Implementation

1. **Scheduler change** (`src/scheduler/index.ts`):
   - Before sending a prompt, check if it starts with `@workflow:`
   - If yes, load the workflow via `findWorkflowCommand()` from `commands-loader.ts`
   - Wrap in `[Workflow: name]\n...\n[/Workflow]` format (same as UI and Telegram)
   - Append any extra text after the workflow name as user context
   - If workflow not found, send error message instead of silently failing

2. **Cron UI** (`ui/cron.html`):
   - Add a workflow dropdown/picker to the "create routine" form
   - When a workflow is selected, populate the prompt field with `@workflow:name`
   - Show a badge similar to the chat UI's workflow badge

3. **Telegram** — Already works. `/standup` in a routine prompt doesn't need changes since the scheduler sends to the agent which already has access to tools.

### Upstream Coexistence Notes

- **No upstream files modified** — `commands-loader.ts` is our file, scheduler changes are additive
- **Backwards compatible** — Routines without `@workflow:` prefix continue working as plain prompts
- **Merge-safe** — If upstream changes the scheduler, the only conflict point is the prompt expansion logic, which is a small isolated block
- **Shared vocabulary** — Upstream's "commands" = our "workflows". Both read from `.claude/commands/`. We just add the ability to trigger them on a schedule

---

## 27. Telegram Bot Command Registration

**Status:** DONE ✅
**Added:** 2026-02-10
**Completed:** 2026-02-11

### Problem
Telegram caches the slash command menu (`/help`, `/start`, etc.) from whatever bot previously used the same token. If the bot was previously used by another project (e.g. ClawdBot/OpenClaw), stale commands persist in the Telegram UI until `setMyCommands` is called with the correct scopes.

### Implementation

#### 27.1 `registerBotCommands()` — `src/channels/telegram/handlers/commands.ts`
- Exported function that manages Telegram's command menu via Bot API
- **Step 1: Delete all stale commands** across every scope:
  - Default, `all_private_chats`, `all_group_chats`
  - Per-chat scope for each allowed user ID (removes ClawdBot per-chat overrides)
  - Per-chat-member scope for each allowed user ID
- **Step 2: Set new commands** across every scope:
  - Default, `all_private_chats`, and per-chat for each allowed user
- Merges built-in commands (help, status, new, model, workflow, facts, voice, unanswered, link, unlink, restart) with workflow commands from `.claude/commands/`
- Sanitizes workflow names to Telegram's `[a-z0-9_]` format, max 32 chars
- Limits total commands to Telegram's 100-command cap

#### 27.2 Called from `main/index.ts` via setTimeout + dynamic import
- 3-second delay after `telegramBot.start()` to ensure bot is connected
- Creates a **fresh `Bot` instance** with the token to bypass Electron's V8 code cache
- Uses `await import()` for both Grammy and the commands handler

#### 27.3 `registerCommands()` public method + `registerTelegramCommands()` export
- Available for manual re-registration (e.g., after adding new workflows)
- `bot` property remains **private** — no external access to the Grammy Bot instance

### Critical Lessons Learned

#### Electron V8 Code Cache
- **Electron caches compiled bytecode** in `~/Library/Application Support/pocket-agent/Code Cache/`
- Editing `.js` files in the installed app has **NO EFFECT** — the cached bytecode takes precedence
- `Function.prototype.toString()` confirmed: the loaded function body differed from the file on disk
- Clearing Code Cache doesn't reliably help — Electron may regenerate from stale sources
- **Workaround:** Dynamic imports (`await import()`) and fresh object construction in `main/index.ts` bypass the cache
- **Never put critical one-time initialization logic inside module-level class methods** in Electron packaged apps — put it in `main/index.ts` instead

#### Telegram Command Scope Precedence
- Telegram resolves commands in order: `chat` > `chat_member` > `all_private_chats` > `all_group_chats` > `default`
- ClawdBot set commands with `chat` scope per-user, which **overrode** our default-scope commands
- Must delete AND set commands across ALL scopes to ensure they appear correctly
- `deleteMyCommands` without scope only clears the default — stale per-chat commands persist

#### Grammy `bot.start()` Behavior
- `bot.start()` returns a promise that resolves when the bot **STOPS**, not starts
- Code after `await bot.start()` inside the TelegramBot class **never executes** during normal operation
- Use the `onStart` callback for post-connection logic, or call from main with a setTimeout

### Security
- `bot` property remains **private** — no external access to the Grammy Bot instance
- Auth middleware checks allowlist on every message (not cached, real-time)
- Constructor throws if allowlist is empty
- Fresh Bot instance used for command registration is discarded after use

#### 27.4 Dynamic Workflow Command Handlers — `registerWorkflowCommandHandlers()`
- **Problem:** `registerBotCommands()` registers workflows with Telegram's `setMyCommands` API (so they appear in the menu), but grammY's `bot.command()` middleware intercepts `/commands` before the `message:text` handler fires. Unmatched commands were silently dropped — the AI agent would see raw `/guest_post_replies` text and respond "Unknown skill"
- **Solution:** `registerWorkflowCommandHandlers()` creates a `bot.command()` handler for each workflow file at startup
- Each handler: loads workflow content, wraps it in `[Workflow: name]...[/Workflow]` tags, sends to `AgentManager.processMessage()` via `withTyping()`
- Telegram command names are normalized: `guest-post-replies` → `guest_post_replies` (matching `registerBotCommands()` logic)
- Callback notifies desktop UI for cross-channel sync

#### Critical Lesson: grammY Command Routing
- In grammY, `bot.command('x')` handles `/x` — but messages with `/` prefix that don't match any registered `bot.command()` do NOT reliably fall through to `bot.on('message:text')`
- The `message:text` handler was registered last as a fallback but **never received unmatched slash commands**
- **Rule:** If a command appears in Telegram's menu (`setMyCommands`), it MUST also have a corresponding `bot.command()` handler

## 28. GLM-5 Model Upgrade

**Status:** ✅ DONE (2026-02-12)

### What
Zhipu released GLM-5 (745B MoE, 44B active params) on 2026-02-11. Added as selectable model and new default for quality tasks.

### Model Tier Strategy
| Tier | Model | Use Case |
|------|-------|----------|
| Worker/Quality | `glm-5` | Research compilation, summaries, extraction |
| Flash | `glm-4.7-flash` | Classification, fast tasks (GLM-5 flash not yet available) |
| Bulk | `glm-4.7-flashx` | Batch email classification (GLM-5 flashx not yet available) |

### Changes
- `src/tools/glm-client.ts` — DEFAULT_MODEL → `glm-5`
- `src/settings/index.ts` — default for `zhipu.model` → `glm-5`
- `src/agent/index.ts` — added `glm-5` to MODEL_PROVIDERS map
- `src/agent/research.ts` — research agent uses `glm-5`
- `src/channels/telegram/handlers/commands.ts` — GLM 5 added to `/model` selector (GLM 4.7 kept as option)

### Migration Note
Flash/bulk model defaults remain GLM-4.7 variants until Zhipu releases GLM-5-flash/flashx. Users who previously set `zhipu.model` explicitly in settings will keep their setting; only new installs get `glm-5` default.

## 29. Reminder Archival & Re-ping System

**Status:** ✅ DONE (2026-02-12)

### Problem
1. One-time reminders were deleted after firing — no audit trail
2. If user missed a reminder, it was gone forever
3. `list_scheduled_tasks` returned `schedule: null` for one-time reminders, confusing the agent

### Solution — Three Changes

#### 29.1 Re-ping Behavior
One-time reminders now re-ping every 3 days after firing, instead of being deleted. After execution, `next_run_at` is set to `now + 3 days`. The reminder keeps re-pinging until the user explicitly acknowledges it.

- `src/scheduler/index.ts` — changed post-fire logic for `delete_after_run` jobs: UPDATE instead of DELETE, sets `next_run_at` to +3 days

#### 29.2 Archive Instead of Delete
All "delete" operations now archive (set `enabled=0, next_run_at=NULL`) instead of actual DELETE.

- `src/memory/index.ts` — `deleteCronJob()` now runs UPDATE instead of DELETE
- `ui/cron.html` — delete button → archive button with archive icon, function renamed to `archiveJob()`
- `src/tools/scheduler-tools.ts` — `delete_scheduled_task` description updated to say "archive"

#### 29.3 Acknowledge Reminder Tool
New tool `acknowledge_reminder` lets the agent stop re-pinging when user confirms they've seen/handled a reminder. Archives the job.

- `src/tools/scheduler-tools.ts` — new tool definition + handler

#### 29.4 Human-Readable Schedule Descriptions
`list_scheduled_tasks` now returns descriptive schedule strings instead of raw DB columns:
- One-time: `"one-time reminder, fires at Feb 15, 2026 9:00 AM"`
- Recurring interval: `"recurring every 3 hours"`
- Cron: `"cron: 0 9 * * *"`

## 30. Calendar Integration

**Status:** 🚧 IN PROGRESS (2026-02-11)

### What
Google Calendar integration via `gog` CLI + calendar view UI page.

### Implementation
- `ui/calendar.html` — new calendar view page
- `src/main/index.ts` — IPC handlers for calendar data
- `src/main/preload.ts` — calendar API exposed to renderer

### Pending
- Full event CRUD via gog CLI
- Recurring event support
- Calendar sync with scheduler/reminders

## 31. Workflow UI Overflow Fix

**Status:** ✅ DONE (2026-02-12)

### Problem
When many workflow buttons existed, they extended beyond the visible viewport with no way to scroll or see them all.

### Root Cause
`#workflows-grid` had `flex-wrap: wrap` but the parent `#toolbar-row` was a single-line flex container that didn't allow vertical growth. `#workflows-area` had `align-items: center` which constrained height.

### Fix
- `#toolbar-row` — added `flex-wrap: wrap` so workflows area can take full width
- `#workflows-area` — changed to `flex: 1 1 100%` and `align-items: flex-start`
- `#workflows-grid` — added `max-height: 150px` and `overflow-y: auto` for scrollable grid

## 32. Upstream Port Phase 5 — v2.3.2 Cherry-Picks ✅ SUPERSEDED by 34

**Status:** ✅ DONE (2026-02-12)
**Upstream:** KenKaiii/pocket-agent commits from 2026-02-10 to 2026-02-12

### Strategy
Selective cherry-pick of 8 upstream commits. Manual port (read upstream diff, adapt to our codebase) — NOT git cherry-pick, since our branch has diverged significantly.

### Merge Order & Assignments

#### Wave 1 — Security & Trivial (no dependencies)

**32.1 SQL Injection Fix + Dead Code Cleanup** (`9af3d6a`) — CRITICAL
- **What:** Parameterized SQL in `memory/index.ts` semantic search; remove dead Telegram keyboard/util exports; delete unused CLI files
- **Port strategy:** Apply SQL fix to our `memory/index.ts`. Skip CLI file deletions (we don't have those files). Skip Telegram dead code removal (our modular structure differs). Only take the SQL injection fix.
- **Files:** `src/memory/index.ts`
- **Risk:** LOW — isolated SQL change
- **Custom conflicts:** None — our memory code has same vulnerable pattern

**32.2 Auto-Increment Session Names** (`dca12a9`) — TRIVIAL
- **What:** `getNextSessionName()` generates "New", "New2", etc. in UI
- **Port strategy:** Add the function to our `ui/chat.html`
- **Files:** `ui/chat.html`
- **Risk:** NONE
- **Custom conflicts:** None

#### Wave 2 — Agent Stability (sequential dependencies)

**32.3 Fix Stale SDK Sessions & Non-Anthropic Auth** (`e6de318`)
- **What:** Set ANTHROPIC_API_KEY for subprocess when using non-Anthropic providers; stale session detection + auto-retry
- **Port strategy:** Adapt to our `agent/index.ts` which has custom MODEL_PROVIDERS map and fallback system. Keep our fallback logic, add their stale session detection alongside it.
- **Files:** `src/agent/index.ts`, `src/agent/persistent-session.ts`
- **Risk:** MEDIUM — must coexist with our model fallback system
- **Custom conflicts:** Our `getProviderForModel()` and fallback error detection. Must preserve both.

**32.4 Human-Readable Error Messages** (`bcc06dc`)
- **What:** `formatAgentError()` maps SDK errors to user-friendly messages; route errors through IPC error path; error states in UI
- **Port strategy:** Add `formatAgentError()` to our agent. Integrate with our existing fallback — fallback triggers first, if fallback exhausted THEN show human-readable error. Add UI error persistence.
- **Files:** `src/agent/index.ts`, `src/agent/persistent-session.ts`, `src/scheduler/index.ts`, `ui/chat.html`
- **Risk:** HIGH — touches agent core, scheduler, and UI
- **Custom conflicts:** Our model fallback system catches same errors. Must ensure fallback runs first, error display only on final failure.
- **Depends on:** 32.3

**32.5 Session Crash Auto-Retry** (`2e6e171`)
- **What:** Extract actual crash reason from session errors; trigger auto-retry on crashes
- **Port strategy:** Small addition to error handling from 32.4
- **Files:** `src/agent/index.ts`
- **Risk:** LOW
- **Depends on:** 32.4

#### Wave 3 — Features (independent)

**32.6 Model Picker Dropdown in Chat Header** (`733d071`)
- **What:** Replace model badge with `<select>` dropdown for quick model switching
- **Port strategy:** Add to our UI. Must include our custom models (GLM-5, GLM-4.7, Kimi). Needs `getAvailableModels()` IPC — check if we have it, add if not.
- **Files:** `ui/chat.html`, possibly `src/main/preload.ts`, `src/main/index.ts`
- **Risk:** MEDIUM — UI header has our custom actions (email, routines, calendar)
- **Custom conflicts:** Header layout. Must preserve our action buttons.

**32.7 Office Document Text Extraction** (`faf72fa`)
- **What:** Extract text from .docx/.pptx/.xlsx via `officeparser` package; inline in Telegram and drag-and-drop
- **Port strategy:** Add `officeparser` dependency. Port Telegram document handler changes. Port drag-and-drop extraction. Port UI attachment rendering.
- **Files:** `package.json`, `src/channels/telegram/handlers/documents.ts`, `src/main/index.ts`, `src/main/preload.ts`, `ui/chat.html`
- **Risk:** MEDIUM — Telegram handler and UI changes
- **Custom conflicts:** Our Telegram handlers have custom context wrapping

**32.8 Cross-Channel Image Display** (`3f7b412`)
- **What:** Extract images from SDK responses; save to media dir; send via Telegram; render thumbnails in desktop UI
- **Port strategy:** Add MediaAttachment type. Port image extraction from agent responses. Port Telegram photo sending (we already have custom `sendPhoto` — merge). Port UI thumbnail rendering.
- **Files:** `src/agent/index.ts`, `src/channels/telegram/handlers/*.ts`, `src/channels/telegram/index.ts`, `src/channels/telegram/types.ts`, `src/main/index.ts`, `src/main/preload.ts`, `ui/chat.html`
- **Risk:** HIGH — touches many files, our custom Telegram has sendPhoto already
- **Custom conflicts:** Our `sendPhoto` in features, our custom handler signatures, our UI customizations

### Testing Checklist
After each wave:
- [ ] `npm run typecheck && npm run lint` — zero errors
- [ ] Build and install fresh DMG
- [ ] **CRITICAL: Verify chat history intact** — stale builds cause UI to show empty chats/routines even though DB is fine. If missing, rebuild+reinstall fixes it. Always check this first after every install.
- [ ] Verify: routines working, workflows visible
- [ ] Verify: Telegram bot connects, custom commands work (/voice, /unanswered)
- [ ] Verify: model switching works (Claude, GLM-5, GLM-4.7)
- [ ] Verify: email processing runs without errors

## 33. Routines/Reminders Separation (v2.2.7)

**Status:** ✅ DONE

- Added `status` field to cron_jobs (pending/fired/acknowledged/stale) with `fired_at` timestamp
- Stale reminder nagger: auto-detects unacknowledged reminders after 2 days
- UI split into 4 sections: Active Routines, Upcoming Reminders, Fired/Needs Attention, Archived
- Clear agent instructions distinguishing calendar vs reminders vs routines

## 34. Upstream Port Phase 6 — v2.4.1 Full Merge (2026-02-15) ✅ DONE

**Status:** ✅ DONE
**Branch:** `integration/upstream-v2.4.1` merged into `my-voice-features`
**Safety tag:** `pre-upstream-v2.4.1-backup`
**Upstream range:** v2.2.6 → v2.4.1 (21 commits, 56 files changed)

### What Was Merged

#### Agent Stability & SDK Fixes
- **Opus 4.6 thinking control** (`146a6ef`) — `THINKING_CONFIGS` with `thinking`/`effort` params replacing `THINKING_BUDGETS`/`maxThinkingTokens`. Thinking level setting now actually works on Opus 4.6.
- **Auto-retry corrupted sessions** (`a8eba30`) — `isInvalidThinking` and `isUnknownResumeError` retry conditions added alongside existing `isStaleSession`/`isSessionCrash`.
- **OAuth Bearer auth fix** (`743b10a`) — Uses `CLAUDE_CODE_OAUTH_TOKEN` env var (Bearer auth) instead of `ANTHROPIC_API_KEY` (x-api-key). Adds `validateOAuth` IPC handler.
- **OAuth token refresh + non-Anthropic thinking** (`cad6d0e`) — Auto-refresh on `authentication_failed`, `client_id` in refresh request. Only applies `thinking`/`effort` for Anthropic models (prevents invisible GLM/Kimi output).
- **Fix cumulative token display** (`b8424e1`) — Reads per-API-call usage from assistant messages instead of cumulative result messages.

#### Browser & Performance
- **Resource leak fixes** (`0febab2`) — CDP: `once('disconnected')` prevents listener accumulation, connect timeout cleared, download listeners cleaned up, `stopHealthCheck()` on disconnect. Electron: download handler cleanup on window close. Dead code removed: `embedBatch`, `EMBEDDING_DIMENSIONS`, `pdf-parse` dep, `node-pty` dep.

#### Infrastructure
- **Node.js PATH detection** (`8a0efc9`) — Detects fnm, volta, asdf, nodenv, n, mise (Unix) and nvm-windows, fnm, volta, scoop, chocolatey, nodist (Windows). Fixes ENOENT errors for non-nvm users.
- **Updater error messages** (`acbb051`) — Classifies update errors: "still building", "move to Applications", "network error", "server error".
- **22 test files** (`d49fc29`) — Coverage for tools, config, browser, Telegram handlers, permissions. Exports 5 private functions for testability.

#### UI
- **Daily Logs window** (`2ff372a`) — Calendar-based daily log viewer (`ui/daily-logs.html`), hamburger menu entry, `getAllDailyLogs()`/`getDailyLogsSince()` methods, IPC handlers.
- **OAuth warning badge** (`84694e9`) — "Use at own risk" badge on OAuth login in settings and onboarding.

### Already Had (No-Op)
- Model picker dropdown (`733d071`) — already in our chat.html
- Session name auto-increment (`dca12a9`) — already in our chat.html
- SDK pin to 0.2.38 (`a70612f`) — already pinned
- GLM-5 model (`84bfaa7`) — already in our MODEL_PROVIDERS
- Human-readable errors (`bcc06dc`) — already have formatAgentError + error routing
- Session crash reason + retry (`2e6e171`) — already have isStaleSession + isSessionCrash

### Skipped
- 4 version bump commits (we use our own `2.2.6-voice.1`)
- Dep updates (`f418cff`) — superseded by SDK pin

### Conflict Resolution
- 8 files had merge conflicts, resolved by 4 parallel agents
- `src/agent/index.ts` (11 conflicts) — heaviest, all custom code preserved
- `ui/chat.html` (7 conflicts) — all custom UI preserved
- `src/main/index.ts` (3 conflicts) — all custom IPC/power handlers preserved
- `package-lock.json` (35 conflicts) — regenerated via `npm install`
- Typecheck + lint: 0 errors, 2 pre-existing warnings

---

### CRITICAL: Post-Merge Checklist for Future Upstream Merges

**Root cause of recurring merge bugs:** Duplicate `ipcMain.handle()` registrations. Electron throws if the same channel is registered twice, which silently kills `setupIPC()` mid-execution — all handlers registered after the duplicate never get registered. The app appears to work (chat loads fine) but buttons for features registered later (kanban, calendar, email) break.

**After every upstream merge, run this:**

```bash
# 1. Check for duplicate IPC handler registrations (MUST return empty)
grep -o "ipcMain.handle('[^']*'" src/main/index.ts | sort | uniq -d

# 2. Check for duplicate ipcMain.on registrations
grep -o "ipcMain.on('[^']*'" src/main/index.ts | sort | uniq -d

# 3. Typecheck + lint (already in CLAUDE.md but repeating for emphasis)
npm run typecheck && npm run lint
```

If step 1 or 2 returns ANY output, you have duplicate handlers that will crash at runtime. Remove the duplicate (keep whichever version is more complete).

**Why this keeps happening:** Our custom features (browser launcher, email, kanban, voice) register IPC handlers in the same `setupIPC()` function as upstream code. When upstream adds or moves handlers, merge conflicts can leave both the old and new registration in place. Git merge won't catch this because the duplicates are far apart in the file (1000+ lines).

---

### CRITICAL: SDK Upgrade Guide

**Current version:** `@anthropic-ai/claude-agent-sdk` 0.2.42 (bundles Claude Code CLI 2.1.42)

**The `CLAUDECODE` env var trap (discovered 2026-02-16):**

SDK 0.2.42+ bundles Claude Code CLI 2.1.42 which added a **nested session detection** check. The CLI checks for a `CLAUDECODE` environment variable on startup — if it exists, it refuses to start with "cannot be launched inside another Claude Code session" and exits with code 1.

Our app passes `...process.env` to the SDK's `env` option. If the user (or a dev) launches the app from within a Claude Code terminal session, `CLAUDECODE=1` is in the environment and propagates to the subprocess, causing an instant crash. Even when launched normally, the first SDK call may set this var in `process.env`, causing subsequent calls to fail.

**Fix (already applied in `src/agent/index.ts`):**
```typescript
const env = { ...process.env };
delete env.CLAUDECODE;        // Prevent nested session detection
delete env.CLAUDE_CONFIG_DIR; // Prevent config dir conflicts
```

**When upgrading the SDK in the future:**
1. Check the bundled Claude Code CLI version in `package.json` → `claudeCodeVersion`
2. Read the Claude Code changelog for new env var checks or startup validations
3. Test with ALL providers (Anthropic, Kimi/Moonshot, GLM, MiniMax) — non-Anthropic providers hit different code paths
4. Test in BOTH dev mode (`npm start`) AND packaged app (DMG install) — they have different env contexts
5. If the CLI exits with code 1 immediately, run it manually to see the real error:
   ```bash
   ANTHROPIC_BASE_URL="..." ANTHROPIC_API_KEY="..." node node_modules/@anthropic-ai/claude-agent-sdk/cli.js --version
   ```

---

## 35. Cron Jobs Survive Mac Sleep/Wake (2026-02-15) ✅ DONE

**Status:** ✅ DONE

### Problem
Cron-type routines used node-cron in-memory timers which miss ticks during macOS sleep. The polling timer (`checkDueJobs`) skipped cron-type jobs (`schedule_type != 'cron'`). Node-cron's `executeJob` didn't update DB timestamps, creating split-brain state.

### Fix
- `checkDueJobs` SQL now includes ALL job types (removed `schedule_type != 'cron'` filter)
- Double-execution guard: skips cron catch-up if `last_run_at` within 5 minutes
- `executeJob` (node-cron path) syncs `last_run_at`, `last_status`, `next_run_at` to DB
- `catchUpMissedJobs()` public method on CronScheduler
- `powerMonitor.on('resume')` calls `scheduler?.catchUpMissedJobs()` for immediate catch-up
- Scheduler mutex deadlock fix: `catchUpMissedJobs` resets `isCheckingReminders` before re-checking

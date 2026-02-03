# Pocket Agent: Master Plan — Multi-Agent Orchestration System

**Created:** 2026-01-30
**Last Updated:** 2026-02-02
**Status:** IN PROGRESS — v4.1 Email Intelligence
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
15. [Multi-Agent Research System](#15-multi-agent-research-system)
16. [GLM Project Prioritization](#16-glm-project-prioritization)
17. [Upstream Ports](#17-upstream-ports-from-kenkaiiipocket-agent)
18. [Task Consolidation & Kanban Automation](#18-task-consolidation--kanban-automation)
19. [Voice / TTS Agent Tools](#19-voice--tts-agent-tools)
20. [Label Precision — Definition & Negative Guidance](#20-label-precision--definition--negative-guidance)

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
Cherry-pick valuable improvements from the original repo without adopting the cat theme, click sounds, or splash screen. Manual port to avoid merge conflicts with our Kanban, voice, and TTS work.

### 17.1 Skills Setup — Inline API Key Entry
**Source:** `c770b6d` (upstream)
- 5 new skill setup wizards: 1Password, Gemini, Himalaya (email), Notion, Trello
- Inline API key modal on the Superpowers page — no need to navigate to Settings
- Per-env-var input fields with "Get key" links to provider pages
- **Method:** Take upstream `ui/skills-setup.html` directly (we never modified this file)

### 17.2 Session State Persistence
**Source:** `c770b6d` (upstream)
- Per-session input text — draft text saved when switching tabs, restored when switching back
- Per-session attachments — dragged-in files preserved per tab
- Per-session suggestions — ghost text suggestions preserved per tab
- Per-session queued messages — pending message tracking per tab
- Per-session pending user messages — unsaved messages re-rendered on tab switch
- **Method:** Manually port the Map-based state refactoring into our `ui/chat.html`, skipping cat theme and click sounds

### 17.3 Stopped Query Bug Fix
**Source:** `c770b6d` (upstream)
- Suppress "Aborted" error messages when user intentionally stops a query
- Add `showTimestamp` parameter to `addMessage()` — stopped messages shown without timestamp
- **Method:** Small targeted edit in our `ui/chat.html`

### What We Skip
- Splash screen with shimmer animation (`ui/splash.html`)
- Click sounds on every button (`assets/click.mp3`, `assets/normal-click.mp3`)
- "Franky the Cat" identity (pixel cat spinner, paw print send button, Pixelify Sans font)
- Cat-themed status messages in `src/agent/index.ts`
- These can be revisited later if desired

### Files to Modify
- REPLACE: `ui/skills-setup.html` — take upstream version
- MODIFY: `ui/chat.html` — session state Maps + stopped query fix (manual port)

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
22. Rewire `task_add/list/complete/delete` tools → Kanban Personal project (unifies all tasks into one system)
23. Actor tracking fixes — ensure every Kanban mutation correctly sets actor (user/claude/glm/system)
24. Store tool output in event_log — save first 2000 chars of every tool result (closes the last data gap)
25. Project selector in New Task modal (quick win, depends on unified task system)
26. Auto-task recording — agent auto-creates Kanban task when no task context exists
27. `/continue` command — shows list of all active projects with status/issues, user picks one to resume
28. Voice/TTS agent tools + channel-aware voice — 4 MCP tools, channel injection, Telegram /voice command, desktop pre-cache
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

1. **GLM tiered model system** — `glmBulk()` using Flash X (`glm-4.7-flashx`, 3 concurrent) for email classification throughput; `glmFlash()` kept for quality-sensitive tasks (draft replies, digests, label refinement). Default `glmConcurrency` raised to 3.
2. **`UnansweredEngine`** — new `src/scheduler/unanswered-engine.ts`. Scans Gmail for unreplied threads using existing `computeThreadState()`, upserts into `unanswered_state` table with state lifecycle (`unanswered -> resolved/dismissed`). Supports scheduled scans, digest generation, and per-account throttling.
2. **`unanswered_state` table** — schema: `(account, thread_id, message_id, subject, sender, label, state, first_seen_at, last_scanned_at, resolved_at, dismissed_at)`. Dismissed threads are sticky unless a new inbound message arrives.
3. **Rules engine extensions** — `on_unanswered_scan` trigger type; three new conditions (`label_in`, `unanswered_age_minutes_gt`, `state_is_not`); three new actions (`send_unanswered_digest`, `mark_resolved`, `dismiss`).
4. **IPC handlers** — `unanswered:scan`, `unanswered:list`, `unanswered:resolve`, `unanswered:dismiss`, `unanswered:resolveAll`, `unanswered:dismissAll`, `unanswered:digest`, `unanswered:getSettings`, `unanswered:saveSettings`.
5. **Telegram `/unanswered` command** — lists unanswered threads with filters (`label:X`, `age:Nh`). Follow-up replies: `N draft`, `N resolve`, `N dismiss`.
6. **"Unanswered" UI tab** — new tab in Email Processing section with enable toggle, scan interval, lookback days, label multi-select, thread list with per-row actions (Draft Reply / Resolve / Dismiss), batch actions, Scan Now button, Send Digest button.
7. **Scheduled scan** — auto-scan at app startup when enabled, respects `gmail.unanswered.intervalMin` setting. After scan, evaluates rules with `on_unanswered_scan` trigger.

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

# Pocket Agent: Master Plan — Multi-Agent Orchestration System

**Created:** 2026-01-30
**Status:** PLANNING — Not yet implemented
**Architecture:** CEO (User) → Manager (Pocket Agent) → Workers (Claude CLI instances)

---

## Table of Contents

1. [GLM 4.7 Integration](#1-glm-47-integration)
2. [Kanban Heartbeat System](#2-kanban-heartbeat-system)
3. [Claude CLI Worker Spawning](#3-claude-cli-worker-spawning)
4. [Task Scheduling (Overnight Builds)](#4-task-scheduling-overnight-builds)
5. [Daily Summary Generation](#5-daily-summary-generation)
6. [Enhanced Activity Tracking](#6-enhanced-activity-tracking)
7. [Session Continuity & Context Recovery](#7-session-continuity--context-recovery)
8. [Gmail Integration](#8-gmail-integration)
9. [Project Selector in New Task Modal](#9-project-selector-in-new-task-modal)

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
Use Zhipu AI GLM-4.7 (z.ai) as a lightweight model for summarization, email processing, and routine tasks — saving Claude tokens for complex work.

### Current State
- API key field exists in settings UI (`ui/settings.html` line 1105)
- Setting defined in `src/settings/index.ts` line 99
- **Never actually called** — no API client exists

### Implementation

#### 1.1 Create GLM Client — `src/agent/glm-client.ts`
```typescript
// Zhipu AI GLM-4.7 API client
// Endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions
// Model: glm-4-0520 (or glm-4.7 when available)
// Auth: API key from settings (zhipu.apiKey)

export interface GLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GLMOptions {
  model?: string;        // default: 'glm-4-0520'
  temperature?: number;  // default: 0.3 for summaries
  max_tokens?: number;   // default: 2048
}

export async function callGLM(messages: GLMMessage[], options?: GLMOptions): Promise<string>
export async function summarizeWithGLM(text: string, prompt?: string): Promise<string>
export async function classifyWithGLM(text: string, categories: string[]): Promise<string>
```

#### 1.2 Register as Provider — `src/agent/index.ts`
- Add `'zhipu'` to provider list alongside `'anthropic'` and `'moonshot'`
- GLM is NOT a primary agent provider — it's a utility model called by tools and scheduled jobs
- The main agent (Claude) delegates lightweight tasks to GLM

#### 1.3 Agent Tool — `src/tools/glm-tools.ts`
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

## 2. Kanban Heartbeat System

### What
Every 15 minutes, the heartbeat checks what changed in the Kanban (by user or agent). The manager reflects on changes and pings the user on Telegram with suggestions — "Should we proceed with X?", "Task Y has been sitting in review for 2 hours", "Want to schedule Z for tonight?"

### How It Works

```
Every 15 min:
  1. Query kanban_activity_log for changes since last heartbeat
  2. If no changes → skip (silent)
  3. If changes found:
     a. Summarize changes (GLM-4.7 for efficiency)
     b. Check for stale tasks (in review > 2h, in_progress > 1 day)
     c. Check for tasks that could be scheduled overnight
     d. Format a brief update
     e. Send to Telegram (and/or desktop notification)
     f. Log heartbeat to daily_logs
```

### Implementation

#### 2.1 Heartbeat Service — `src/scheduler/heartbeat.ts`
```typescript
export class KanbanHeartbeat {
  private lastCheckAt: string;  // ISO timestamp of last check
  private interval: NodeJS.Timeout;

  start(intervalMs: number = 900000)  // 15 min default
  stop()

  private async checkChanges(): Promise<HeartbeatResult>
  private async getRecentActivity(since: string): Promise<ActivityEntry[]>
  private async findStaleTasks(): Promise<KanbanTask[]>
  private async generateSummary(activities: ActivityEntry[]): Promise<string>
  private async notify(summary: string): Promise<void>
}
```

#### 2.2 New Query — `src/kanban/index.ts`
```typescript
// Get all activity since a timestamp, across ALL projects
getActivitySince(since: string): ActivityEntry[]

// Get tasks that haven't moved in N hours
getStaleTasks(hoursInStatus: number): KanbanTask[]

// Get tasks in review that are pending approval
getPendingReviewTasks(): KanbanTask[]
```

#### 2.3 Heartbeat Settings
- `heartbeat.enabled` — on/off (default: on)
- `heartbeat.intervalMinutes` — how often (default: 15)
- `heartbeat.quietHours` — e.g., "23:00-07:00" (no pings while sleeping)
- `heartbeat.channels` — where to send: telegram, desktop, both

### Files to Create/Modify
- CREATE: `src/scheduler/heartbeat.ts`
- MODIFY: `src/kanban/index.ts` — add cross-project activity queries
- MODIFY: `src/main/index.ts` — start heartbeat on app launch
- MODIFY: `src/settings/index.ts` — add heartbeat settings
- MODIFY: `ui/settings.html` — add heartbeat config UI

---

## 3. Claude CLI Worker Spawning

### What
The manager (Pocket Agent) can spawn Claude Code CLI instances as workers to build websites, apps, fix bugs, etc. Each worker:
- Runs in a specific project directory
- Has a specific task from the Kanban
- Streams progress back to the manager
- Updates the Kanban card with results
- Everything is tracked: success, failure, rejection, duration

### Architecture

```
User creates task → Schedules it → Manager picks it up
  → Spawns: claude --dangerously-skip-permissions -p "task prompt" --output-format json
  → Worker runs autonomously
  → Manager monitors output
  → On completion: updates Kanban card, notifies user
  → On failure: logs error, marks task failed, notifies user
```

### Implementation

#### 3.1 Worker Manager — `src/workers/index.ts`
```typescript
export interface WorkerConfig {
  taskId: number;              // Kanban task ID
  projectDir: string;          // Working directory
  prompt: string;              // Task description for Claude CLI
  timeout?: number;            // Max execution time (default: 30 min)
  model?: string;              // Claude model to use
}

export interface WorkerStatus {
  id: string;                  // Unique worker ID
  taskId: number;
  pid: number;                 // Process ID
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  output: string;              // Accumulated output
  error?: string;
  exitCode?: number;
}

export class WorkerManager {
  private workers: Map<string, WorkerStatus>;

  async spawnWorker(config: WorkerConfig): Promise<string>  // Returns worker ID
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

#### 3.4 Agent Tool — `src/tools/worker-tools.ts`
```typescript
// Tool: spawn_worker — Start a Claude CLI worker for a Kanban task
// Tool: check_worker — Get status of a running worker
// Tool: cancel_worker — Stop a running worker
// Tool: list_workers — List all active and recent workers
```

#### 3.5 UI — Kanban card worker indicator
- Show worker status badge on cards (spinner while running, checkmark when done, X when failed)
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

Sent to Telegram and stored in `daily_logs`.

### Implementation

#### 5.1 Daily Summary Job — `src/scheduler/daily-summary.ts`
```typescript
export async function generateDailySummary(): Promise<string> {
  // 1. Get all activity from previous day
  const yesterday = getYesterdayRange();
  const activities = KanbanService.getActivitySince(yesterday.start);

  // 2. Get task status counts across all projects
  const projects = KanbanService.listProjects();

  // 3. Get worker execution history
  const workerResults = WorkerHistory.getExecutionsSince(yesterday.start);

  // 4. Get scheduler job results
  const jobResults = getScheduler().getHistory();

  // 5. Get daily log entries
  const dailyLog = getDailyLog(yesterday.date);

  // 6. Send to GLM-4.7 for summary
  const summary = await summarizeWithGLM(allData, DAILY_SUMMARY_PROMPT);

  // 7. Store in daily_logs
  appendToDailyLog(`[DAILY SUMMARY]\n${summary}`);

  // 8. Send to Telegram
  await sendToTelegram(summary);

  return summary;
}
```

#### 5.2 Register as Scheduled Job
Auto-created on first launch:
```typescript
{
  name: 'daily_summary',
  schedule_type: 'cron',
  schedule: '0 9 * * *',  // 9 AM daily
  prompt: 'INTERNAL:daily_summary',  // Special handler, not LLM prompt
  channel: 'telegram',
  enabled: true
}
```

#### 5.3 Settings
- `dailySummary.enabled` — on/off
- `dailySummary.time` — cron expression (default: "0 9 * * *")
- `dailySummary.channel` — telegram, desktop, both

### Files to Create/Modify
- CREATE: `src/scheduler/daily-summary.ts`
- MODIFY: `src/scheduler/index.ts` — handle INTERNAL: prefix for system jobs
- MODIFY: `src/main/index.ts` — auto-create daily_summary job on first launch
- MODIFY: `src/settings/index.ts` — daily summary settings

---

## 6. Enhanced Activity Tracking

### What
Track EVERYTHING — not just Kanban mutations, but tool executions, worker runs, agent decisions, failures, session events. The goal: the agent can look back at any point in time and see exactly what happened.

### Current Gaps
- Tool execution results: logged to console only, not persisted
- Worker execution: doesn't exist yet
- Agent reasoning: not stored
- Failed operations: partially tracked (scheduler yes, tools no)

### Implementation

#### 6.1 Universal Event Log — `src/memory/event-log.ts`
```sql
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT,
  project_id INTEGER,
  task_id INTEGER,
  data TEXT,  -- JSON payload
  success INTEGER DEFAULT 1,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
);

CREATE INDEX IF NOT EXISTS idx_event_type ON event_log(event_type);
CREATE INDEX IF NOT EXISTS idx_event_created ON event_log(created_at);
CREATE INDEX IF NOT EXISTS idx_event_source ON event_log(source);
CREATE INDEX IF NOT EXISTS idx_event_project ON event_log(project_id);
```

**Event types:**
- `tool_call` — any tool execution (name, input, output, duration)
- `worker_spawn` — worker started
- `worker_complete` — worker finished (success/fail)
- `heartbeat` — heartbeat check result
- `daily_summary` — daily summary generated
- `glm_call` — GLM API call
- `gmail_check` — email check
- `notification_sent` — Telegram/desktop notification
- `session_start` / `session_end`
- `error` — any unhandled error

#### 6.2 Event Logger
```typescript
export function logEvent(type: string, source: string, data?: object, options?: {
  sessionId?: string;
  projectId?: number;
  taskId?: number;
  success?: boolean;
  error?: string;
  durationMs?: number;
}): void

export function getEventsSince(since: string, type?: string): EventEntry[]
export function getEventsByTask(taskId: number): EventEntry[]
export function getEventsByProject(projectId: number): EventEntry[]
```

### Files to Create/Modify
- CREATE: `src/memory/event-log.ts`
- MODIFY: `src/tools/diagnostics.ts` — log tool calls to event_log
- MODIFY: `src/agent/index.ts` — log session events

---

## 7. Session Continuity & Context Recovery

### What
When the agent starts a new session (or context window resets), it automatically:
1. Checks recent daily logs (last 3 days)
2. Checks active Kanban tasks across all projects
3. Checks recent event log for unfinished work
4. Checks pending reviews and scheduled tasks
5. Presents a briefing: "Here's where we left off..."

### Current State
- `getConversationContext()` already loads recent messages
- `getDailyLogsContext()` returns last 3 days of daily logs
- `getRecentMessages()` loads recent conversation
- Session system supports multiple named sessions

### Implementation

#### 7.1 Context Briefing — `src/agent/briefing.ts`
```typescript
export async function generateSessionBriefing(): Promise<string> {
  // 1. Recent daily logs
  const logs = getRecentDailyLogs(3);

  // 2. Active tasks across all projects
  const projects = KanbanService.listProjects();
  const activeTasks = [];
  for (const project of projects) {
    const board = KanbanService.getBoard(project.id);
    // Collect in_progress, review, scheduled tasks
  }

  // 3. Recent worker executions
  const recentWorkers = WorkerHistory.getRecent(10);

  // 4. Pending reviews
  const pendingReviews = KanbanService.getPendingReviewTasks();

  // 5. Scheduled tasks coming up
  const scheduledTasks = KanbanService.getScheduledTasks();

  // 6. Recent event log highlights
  const recentEvents = getEventsSince(threeDaysAgo);

  // Format briefing
  return formatBriefing({ logs, activeTasks, recentWorkers, pendingReviews, scheduledTasks, recentEvents });
}
```

#### 7.2 Auto-inject into Agent System Prompt
On each new session or context reset, prepend the briefing to the system prompt so the agent knows the full state.

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
// Uses Gmail API via OAuth2
// Requires: googleapis npm package
// Auth: OAuth2 flow stored in settings

export class GmailClient {
  async authenticate(): Promise<void>
  async getUnreadEmails(maxResults?: number): Promise<GmailMessage[]>
  async labelEmail(messageId: string, labels: string[]): Promise<void>
  async getThread(threadId: string): Promise<GmailThread>
  async markAsRead(messageId: string): Promise<void>
}
```

#### 8.2 Email Processor — `src/channels/email-processor.ts`
```typescript
export class EmailProcessor {
  async processNewEmails(): Promise<ProcessedEmail[]>
  private async classifyEmail(email: GmailMessage): Promise<EmailClassification>
  private async shouldNotify(classification: EmailClassification): Promise<boolean>
  private async summarizeThread(thread: GmailThread): Promise<string>
}
```

#### 8.3 Scheduled Job
```typescript
{
  name: 'gmail_check',
  schedule_type: 'every',
  interval_ms: 300000,  // Every 5 minutes
  prompt: 'INTERNAL:gmail_check',
  channel: 'telegram'
}
```

### Dependencies
- `googleapis` npm package
- OAuth2 credentials (Google Cloud Console)
- Settings: `gmail.enabled`, `gmail.clientId`, `gmail.clientSecret`, `gmail.refreshToken`

### Files to Create/Modify
- CREATE: `src/channels/gmail.ts`
- CREATE: `src/channels/email-processor.ts`
- MODIFY: `src/main/index.ts` — auto-create gmail_check job
- MODIFY: `src/settings/index.ts` — Gmail settings
- MODIFY: `ui/settings.html` — Gmail config UI + OAuth flow
- MODIFY: `package.json` — add googleapis dependency

---

## 9. Project Selector in New Task Modal

### What
When creating a new task, allow selecting which project it belongs to (dropdown pre-filled with current project). Also add tag autocomplete from existing tags across all projects.

### Implementation

#### 9.1 UI Changes — `ui/kanban.html`
- Add project dropdown to New Task modal (populated from `kanbanListProjects()`)
- Default to current project
- Add tag input with autocomplete (suggestions from all existing tags)

#### 9.2 Backend — `src/kanban/index.ts`
```typescript
// Get all unique tags across all projects
getAllTags(): string[]
```

### Files to Modify
- MODIFY: `ui/kanban.html` — project dropdown + tag autocomplete in modal
- MODIFY: `src/kanban/index.ts` — getAllTags query

---

## Implementation Order (Priority)

### Phase 1 — Foundation
1. GLM 4.7 client (`src/agent/glm-client.ts`)
2. Enhanced event log (`src/memory/event-log.ts`)
3. Project selector in New Task modal (quick win)

### Phase 2 — Workers
4. Worker manager + execution DB (`src/workers/`)
5. Claude CLI spawning + Kanban integration
6. Task scheduling UI (schedule button, overnight picker)
7. Scheduled task runner

### Phase 3 — Intelligence
8. Kanban heartbeat system
9. Daily summary generation (GLM-4.7)
10. Session continuity briefing

### Phase 4 — Communication
11. Gmail integration
12. Email classification + Telegram notifications

---

## Key Decisions Still Needed

1. **Claude CLI path**: Is `claude` available globally or need full path?
2. **Worker concurrency**: How many parallel workers? (Suggest: 2-3 max)
3. **Gmail OAuth**: Who sets up the Google Cloud project? Need client credentials.
4. **GLM-4.7 model ID**: Need to verify exact model string for z.ai API
5. **Worker timeout**: Default 30 min? Configurable per task?
6. **Quiet hours**: What hours to suppress heartbeat notifications?

---

## Database Migrations Needed

```sql
-- 1. Worker executions table (new)
-- 2. Universal event log table (new)
-- 3. kanban_tasks: ADD scheduled_at TEXT
-- 4. kanban_tasks: ADD worker_id TEXT
-- 5. kanban_tasks: UPDATE status CHECK to include 'scheduled'
```

All migrations use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` for backwards compatibility.

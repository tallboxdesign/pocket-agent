/**
 * Universal Event Log
 *
 * Tracks all system events: tool calls, LLM calls, worker runs, notifications,
 * errors, etc. Every event records token usage, actor, duration, and optional
 * links to projects/tasks for aggregation.
 *
 * Uses shared SQLite database with WAL mode for concurrent access.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ============================================================================
// Types
// ============================================================================

export type EventType =
  | 'tool_call'
  | 'llm_call'
  | 'worker_spawn'
  | 'worker_complete'
  | 'worker_fail'
  | 'heartbeat'
  | 'daily_summary'
  | 'notification_sent'
  | 'session_start'
  | 'session_end'
  | 'task_auto_created'
  | 'research_start'
  | 'research_complete'
  | 'email_processing'
  | 'error';

export type EventSource = 'claude' | 'glm' | 'user' | 'system' | 'worker';
export type EventActor = 'user' | 'claude' | 'glm' | 'scheduler' | 'system' | string;

export interface EventLogEntry {
  id: number;
  event_type: EventType;
  source: EventSource;
  actor: EventActor | null;
  session_id: string | null;
  project_id: number | null;
  task_id: number | null;
  data: string | null;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  tokens_total: number | null;
  success: number;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface LogEventInput {
  event_type: EventType;
  source: EventSource;
  actor?: EventActor;
  session_id?: string;
  project_id?: number;
  task_id?: number;
  data?: Record<string, unknown> | string;
  tokens_prompt?: number;
  tokens_completion?: number;
  tokens_total?: number;
  success?: boolean;
  error?: string;
  duration_ms?: number;
}

export interface TokenSummary {
  claude_prompt: number;
  claude_completion: number;
  glm_prompt: number;
  glm_completion: number;
  total: number;
}

export interface DailyTokenEntry {
  date: string;
  claude_tokens: number;
  glm_tokens: number;
  total_tokens: number;
  event_count: number;
}

export interface EventCountByType {
  event_type: string;
  count: number;
}

// ============================================================================
// Database Connection (Singleton)
// ============================================================================

let sharedDb: Database.Database | null = null;
let dbInitialized = false;

function getDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

function getDb(): Database.Database {
  if (sharedDb && !dbInitialized) {
    ensureTable(sharedDb);
    dbInitialized = true;
    return sharedDb;
  }

  if (sharedDb) {
    return sharedDb;
  }

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('Database not found. Start Pocket Agent first.');
  }

  sharedDb = new Database(dbPath);
  sharedDb.pragma('journal_mode = WAL');
  sharedDb.pragma('busy_timeout = 5000');

  ensureTable(sharedDb);
  dbInitialized = true;

  return sharedDb;
}

export function closeEventLogDb(): void {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
    dbInitialized = false;
  }
}

// ============================================================================
// Schema
// ============================================================================

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      actor TEXT,
      session_id TEXT,
      project_id INTEGER,
      task_id INTEGER,
      data TEXT,
      tokens_prompt INTEGER,
      tokens_completion INTEGER,
      tokens_total INTEGER,
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
    CREATE INDEX IF NOT EXISTS idx_event_session ON event_log(session_id);
  `);
}

// ============================================================================
// Write Operations
// ============================================================================

export function logEvent(input: LogEventInput): number {
  const db = getDb();
  const dataStr =
    input.data != null
      ? typeof input.data === 'string'
        ? input.data
        : JSON.stringify(input.data)
      : null;

  const result = db
    .prepare(
      `INSERT INTO event_log
       (event_type, source, actor, session_id, project_id, task_id,
        data, tokens_prompt, tokens_completion, tokens_total,
        success, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.event_type,
      input.source,
      input.actor ?? null,
      input.session_id ?? null,
      input.project_id ?? null,
      input.task_id ?? null,
      dataStr,
      input.tokens_prompt ?? null,
      input.tokens_completion ?? null,
      input.tokens_total ?? null,
      input.success === false ? 0 : 1,
      input.error ?? null,
      input.duration_ms ?? null
    );

  return Number(result.lastInsertRowid);
}

// ============================================================================
// Read Operations
// ============================================================================

export function getRecentEvents(limit: number = 50): EventLogEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM event_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as EventLogEntry[];
}

export function getEventsByType(eventType: EventType, limit: number = 50): EventLogEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM event_log WHERE event_type = ? ORDER BY created_at DESC LIMIT ?')
    .all(eventType, limit) as EventLogEntry[];
}

export function getEventsByTask(taskId: number, limit: number = 100): EventLogEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM event_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(taskId, limit) as EventLogEntry[];
}

export function getEventsByProject(projectId: number, limit: number = 100): EventLogEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM event_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(projectId, limit) as EventLogEntry[];
}

export function getEventsBySession(sessionId: string, limit: number = 200): EventLogEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM event_log WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
    .all(sessionId, limit) as EventLogEntry[];
}

export function getEventsSince(since: string, limit: number = 500): EventLogEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM event_log WHERE created_at >= ? ORDER BY created_at ASC LIMIT ?')
    .all(since, limit) as EventLogEntry[];
}

// ============================================================================
// Token Aggregation
// ============================================================================

export function getTokensByTask(taskId: number): TokenSummary {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_prompt ELSE 0 END), 0) AS claude_prompt,
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_completion ELSE 0 END), 0) AS claude_completion,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_prompt ELSE 0 END), 0) AS glm_prompt,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_completion ELSE 0 END), 0) AS glm_completion,
         COALESCE(SUM(tokens_total), 0) AS total
       FROM event_log
       WHERE task_id = ? AND tokens_total IS NOT NULL`
    )
    .get(taskId) as TokenSummary;
  return row;
}

export function getTokensByProject(projectId: number): TokenSummary {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_prompt ELSE 0 END), 0) AS claude_prompt,
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_completion ELSE 0 END), 0) AS claude_completion,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_prompt ELSE 0 END), 0) AS glm_prompt,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_completion ELSE 0 END), 0) AS glm_completion,
         COALESCE(SUM(tokens_total), 0) AS total
       FROM event_log
       WHERE project_id = ? AND tokens_total IS NOT NULL`
    )
    .get(projectId) as TokenSummary;
  return row;
}

export function getTokensByDateRange(start: string, end: string): TokenSummary {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_prompt ELSE 0 END), 0) AS claude_prompt,
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_completion ELSE 0 END), 0) AS claude_completion,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_prompt ELSE 0 END), 0) AS glm_prompt,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_completion ELSE 0 END), 0) AS glm_completion,
         COALESCE(SUM(tokens_total), 0) AS total
       FROM event_log
       WHERE created_at >= ? AND created_at < ? AND tokens_total IS NOT NULL`
    )
    .get(start, end) as TokenSummary;
  return row;
}

export function getDailyTokenUsage(days: number = 14): DailyTokenEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         substr(created_at, 1, 10) AS date,
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_total ELSE 0 END), 0) AS claude_tokens,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_total ELSE 0 END), 0) AS glm_tokens,
         COALESCE(SUM(tokens_total), 0) AS total_tokens,
         COUNT(*) AS event_count
       FROM event_log
       WHERE tokens_total IS NOT NULL
       GROUP BY substr(created_at, 1, 10)
       ORDER BY date DESC
       LIMIT ?`
    )
    .all(days) as DailyTokenEntry[];
}

// ============================================================================
// Analytics
// ============================================================================

export function getEventCountsByType(since?: string): EventCountByType[] {
  const db = getDb();
  if (since) {
    return db
      .prepare(
        `SELECT event_type, COUNT(*) AS count
         FROM event_log
         WHERE created_at >= ?
         GROUP BY event_type
         ORDER BY count DESC`
      )
      .all(since) as EventCountByType[];
  }
  return db
    .prepare(
      `SELECT event_type, COUNT(*) AS count
       FROM event_log
       GROUP BY event_type
       ORDER BY count DESC`
    )
    .all() as EventCountByType[];
}

export function getErrorEvents(limit: number = 50): EventLogEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM event_log WHERE success = 0 ORDER BY created_at DESC LIMIT ?')
    .all(limit) as EventLogEntry[];
}

export function getTotalEventCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS count FROM event_log').get() as { count: number };
  return row.count;
}

/**
 * Get a summary of the last N hours of activity for session briefings.
 * Returns event counts by type, total tokens, and error count.
 */
export function getActivitySummary(hours: number = 72): {
  eventCounts: EventCountByType[];
  tokenSummary: TokenSummary;
  errorCount: number;
  totalEvents: number;
} {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const db = getDb();

  const eventCounts = db
    .prepare(
      `SELECT event_type, COUNT(*) AS count
       FROM event_log WHERE created_at >= ?
       GROUP BY event_type ORDER BY count DESC`
    )
    .all(since) as EventCountByType[];

  const tokenSummary = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_prompt ELSE 0 END), 0) AS claude_prompt,
         COALESCE(SUM(CASE WHEN source = 'claude' THEN tokens_completion ELSE 0 END), 0) AS claude_completion,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_prompt ELSE 0 END), 0) AS glm_prompt,
         COALESCE(SUM(CASE WHEN source = 'glm' THEN tokens_completion ELSE 0 END), 0) AS glm_completion,
         COALESCE(SUM(tokens_total), 0) AS total
       FROM event_log WHERE created_at >= ? AND tokens_total IS NOT NULL`
    )
    .get(since) as TokenSummary;

  const errorRow = db
    .prepare('SELECT COUNT(*) AS count FROM event_log WHERE created_at >= ? AND success = 0')
    .get(since) as { count: number };

  const totalRow = db
    .prepare('SELECT COUNT(*) AS count FROM event_log WHERE created_at >= ?')
    .get(since) as { count: number };

  return {
    eventCounts,
    tokenSummary,
    errorCount: errorRow.count,
    totalEvents: totalRow.count,
  };
}

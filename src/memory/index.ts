import Database from 'better-sqlite3';
import {
  initEmbeddings,
  hasEmbeddings,
  embed,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from './embeddings';

// Types
export interface Session {
  id: string;
  name: string;
  mode?: 'coder' | 'manager';
  hidden?: boolean;
  created_at: string;
  updated_at: string;
  telegram_linked?: boolean;
  telegram_group_name?: string | null;
}

export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  token_count?: number;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export interface Fact {
  id: number;
  category: string;
  subject: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface CronJob {
  id: number;
  name: string;
  schedule_type?: string;
  schedule: string | null;
  run_at?: string | null;
  interval_ms?: number | null;
  prompt: string;
  channel: string;
  enabled: boolean;
  delete_after_run?: boolean;
  context_messages?: number;
  next_run_at?: string | null;
  session_id?: string | null;
  job_type?: 'routine' | 'reminder';
  status?: 'pending' | 'fired' | 'acknowledged' | 'stale';
  fired_at?: string | null;
}

export interface ConversationContext {
  messages: Array<{ role: string; content: string; timestamp?: string }>;
  totalTokens: number;
  summarizedCount: number;
  summary?: string;
}

export interface SmartContextOptions {
  recentMessageLimit: number;      // Number of recent messages to include
  rollingSummaryInterval: number;  // Create summaries every N messages
  semanticRetrievalCount: number;  // Number of semantically relevant messages to retrieve
  currentQuery?: string;           // Current user query for semantic search
}

export interface SmartContext {
  recentMessages: Array<{ role: string; content: string; timestamp?: string }>;
  rollingSummary: string | null;
  relevantMessages: Array<{ role: string; content: string; timestamp?: string; similarity?: number }>;
  totalTokens: number;
  stats: {
    totalMessages: number;
    summarizedMessages: number;
    recentCount: number;
    relevantCount: number;
    newSummaryCreated: boolean;  // True if a new rolling summary was created this turn
  };
}

export interface SearchResult {
  fact: Fact;
  score: number;
  vectorScore: number;
  keywordScore: number;
}

export interface GraphNode {
  id: number;
  subject: string;
  category: string;
  content: string;
  group: number;
}

export interface GraphLink {
  source: number;
  target: number;
  type: 'category' | 'semantic' | 'keyword';
  strength: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface DailyLog {
  id: number;
  date: string;
  content: string;
  updated_at: string;
}

export interface TelegramChatSession {
  chat_id: number;
  session_id: string;
  group_name: string | null;
  created_at: string;
}

export interface SoulAspect {
  id: number;
  aspect: string;
  content: string;
  created_at: string;
  updated_at: string;
}

// Summarizer function type - injected to avoid circular dependency with agent
export type SummarizerFn = (messages: Message[]) => Promise<string>;

// Token estimation: ~4 characters per token
const CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_LIMIT = 150000;

// Search weights
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const MIN_SCORE_THRESHOLD = 0.35;
const MAX_SEARCH_RESULTS = 6;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class MemoryManager {
  private db: Database.Database;
  private summarizer?: SummarizerFn;
  private normalizeSessionMode(mode: string | null | undefined): 'coder' | 'manager' {
    const normalized = String(mode || '').trim().toLowerCase();
    if (normalized === 'general' || normalized === 'manager') return 'manager';
    return 'coder';
  }

  /** Expose raw db for direct queries (e.g. calendar IPC handlers) */
  getDatabase(): Database.Database {
    return this.db;
  }
  private embeddingsReady: boolean = false;

  // Cache for facts context (invalidated on fact changes)
  private factsContextCache: string | null = null;
  private factsContextCacheValid: boolean = false;

  // Cache for soul context (invalidated on soul changes)
  private soulContextCache: string | null = null;
  private soulContextCacheValid: boolean = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      -- Sessions for isolated conversation threads
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT DEFAULT 'coder',
        hidden INTEGER DEFAULT 0,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Main conversation messages (per-session)
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        token_count INTEGER,
        session_id TEXT REFERENCES sessions(id)
      );

      -- Facts extracted from conversations (long-term memory)
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Embedding chunks linked to facts
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );

      -- Scheduled cron jobs (supports cron/at/every schedule types)
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK(schedule_type IN ('cron', 'at', 'every')),
        schedule TEXT,
        run_at TEXT,
        interval_ms INTEGER,
        prompt TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'desktop',
        enabled INTEGER DEFAULT 1,
        delete_after_run INTEGER DEFAULT 0,
        context_messages INTEGER DEFAULT 0,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT CHECK(last_status IN ('ok', 'error', 'skipped')),
        last_error TEXT,
        last_duration_ms INTEGER,
        status TEXT DEFAULT 'pending',
        fired_at TEXT,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Summaries of older conversation chunks (per-session)
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER,
        session_id TEXT REFERENCES sessions(id),
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Calendar events
      CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        all_day INTEGER DEFAULT 0,
        location TEXT,
        reminder_minutes INTEGER DEFAULT 15,
        reminded INTEGER DEFAULT 0,
        channel TEXT DEFAULT 'desktop',
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Tasks / Todos
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        due_date TEXT,
        priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
        reminder_minutes INTEGER,
        reminded INTEGER DEFAULT 0,
        channel TEXT DEFAULT 'desktop',
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Daily logs for memory journaling (global across all sessions)
      CREATE TABLE IF NOT EXISTS daily_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Soul aspects (agent's evolving identity/personality)
      CREATE TABLE IF NOT EXISTS soul (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aspect TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Telegram chat to session mapping
      CREATE TABLE IF NOT EXISTS telegram_chat_sessions (
        chat_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        group_name TEXT,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Message embeddings for semantic search of past conversations
      CREATE TABLE IF NOT EXISTS message_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL UNIQUE,
        embedding BLOB NOT NULL,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      -- Rolling summaries for smart context (different from compaction summaries)
      CREATE TABLE IF NOT EXISTS rolling_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_message_embeddings_message ON message_embeddings(message_id);
      CREATE INDEX IF NOT EXISTS idx_rolling_summaries_session ON rolling_summaries(session_id, end_message_id);
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
      CREATE INDEX IF NOT EXISTS idx_chunks_fact_id ON chunks(fact_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_range ON summaries(start_message_id, end_message_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_time);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(date);
      CREATE INDEX IF NOT EXISTS idx_soul_aspect ON soul(aspect);

      -- Unique constraint on session names (for Telegram group linking)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name_unique ON sessions(name);

      -- Kanban projects (session-independent)
      CREATE TABLE IF NOT EXISTS kanban_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        workspace_path TEXT,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        color TEXT DEFAULT '#a855f7',
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Kanban tasks
      CREATE TABLE IF NOT EXISTS kanban_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES kanban_projects(id) ON DELETE CASCADE,
        parent_task_id INTEGER REFERENCES kanban_tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'backlog' CHECK(status IN ('backlog','todo','in_progress','review','done')),
        priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
        assignee_model TEXT DEFAULT 'claude',
        position INTEGER DEFAULT 0,
        estimated_minutes INTEGER,
        approval_status TEXT CHECK(approval_status IN ('pending','approved','rejected')),
        approval_feedback TEXT,
        tags TEXT,
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
        updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      -- Kanban activity log
      CREATE TABLE IF NOT EXISTS kanban_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES kanban_projects(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        details TEXT,
        actor TEXT DEFAULT 'user',
        created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_tasks_project ON kanban_tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_kanban_tasks_parent ON kanban_tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_activity_task ON kanban_activity_log(task_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_activity_project ON kanban_activity_log(project_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_projects_status ON kanban_projects(status);

      -- LinkedIn posts persistence (survives session restarts)
      CREATE TABLE IF NOT EXISTS linkedin_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_url TEXT UNIQUE NOT NULL,
        author TEXT NOT NULL,
        text_preview TEXT NOT NULL,
        reactions INTEGER DEFAULT 0,
        comments INTEGER DEFAULT 0,
        post_type TEXT,
        hook_score INTEGER,
        emotion_tag TEXT,
        niche_target TEXT,
        authenticity_flag TEXT,
        post_bank_ids TEXT,
        post_bank_group TEXT,
        source_tag TEXT DEFAULT 'feed:home',
        scraped_date TEXT NOT NULL,
        first_seen_at TEXT DEFAULT (datetime('now')),
        first_seen_reactions INTEGER,
        first_seen_comments INTEGER,
        last_seen_at TEXT DEFAULT (datetime('now')),
        times_seen INTEGER DEFAULT 1,
        scrape_status TEXT DEFAULT 'new',
        scrape_status_at TEXT DEFAULT (datetime('now')),
        commented INTEGER DEFAULT 0,
        comment_draft TEXT,
        kanban_task_id INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_lp_date ON linkedin_posts(scraped_date);
      CREATE INDEX IF NOT EXISTS idx_lp_author ON linkedin_posts(author);

      -- LinkedIn draft evidence (why a specific draft was generated)
      CREATE TABLE IF NOT EXISTS linkedin_draft_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL REFERENCES linkedin_posts(id) ON DELETE CASCADE,
        post_url TEXT NOT NULL,
        model TEXT,
        research_model TEXT,
        writer_model TEXT,
        comment_intent TEXT,
        post_summary TEXT,
        key_point TEXT,
        statistic TEXT,
        implication TEXT,
        follow_up_question TEXT,
        stance_basis TEXT,
        actionable_add_on TEXT,
        post_intent TEXT,
        confidence TEXT,
        full_post_word_count INTEGER,
        source_1_name TEXT,
        source_1_url TEXT,
        source_2_name TEXT,
        source_2_url TEXT,
        research_trace TEXT,
        draft_trace TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_linkedin_draft_evidence_post ON linkedin_draft_evidence(post_id);
      CREATE INDEX IF NOT EXISTS idx_linkedin_draft_evidence_created ON linkedin_draft_evidence(created_at);
    `);

    // Create FTS5 virtual table for keyword search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          category,
          subject,
          content,
          content='facts',
          content_rowid='id'
        );
      `);

      // Create triggers to keep FTS index in sync
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, category, subject, content)
          VALUES (new.id, new.category, new.subject, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, category, subject, content)
          VALUES ('delete', old.id, old.category, old.subject, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, category, subject, content)
          VALUES ('delete', old.id, old.category, old.subject, old.content);
          INSERT INTO facts_fts(rowid, category, subject, content)
          VALUES (new.id, new.category, new.subject, new.content);
        END;
      `);
    } catch {
      // FTS5 triggers may already exist
    }

    // FTS5 for messages (search all conversation history)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='id'
        );
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content)
          VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
          INSERT INTO messages_fts(rowid, content)
          VALUES (new.id, new.content);
        END;
      `);
    } catch {
      // messages FTS5 triggers may already exist
    }

    // FTS5 for cron_jobs (search reminders, routines, scheduled tasks)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS cron_jobs_fts USING fts5(
          name,
          prompt,
          content='cron_jobs',
          content_rowid='id'
        );
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS cron_jobs_ai AFTER INSERT ON cron_jobs BEGIN
          INSERT INTO cron_jobs_fts(rowid, name, prompt)
          VALUES (new.id, new.name, new.prompt);
        END;

        CREATE TRIGGER IF NOT EXISTS cron_jobs_ad AFTER DELETE ON cron_jobs BEGIN
          INSERT INTO cron_jobs_fts(cron_jobs_fts, rowid, name, prompt)
          VALUES ('delete', old.id, old.name, old.prompt);
        END;

        CREATE TRIGGER IF NOT EXISTS cron_jobs_au AFTER UPDATE ON cron_jobs BEGIN
          INSERT INTO cron_jobs_fts(cron_jobs_fts, rowid, name, prompt)
          VALUES ('delete', old.id, old.name, old.prompt);
          INSERT INTO cron_jobs_fts(rowid, name, prompt)
          VALUES (new.id, new.name, new.prompt);
        END;
      `);
    } catch {
      // cron_jobs FTS5 triggers may already exist
    }

    // FTS5 for kanban_tasks (search project tasks)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kanban_tasks_fts USING fts5(
          title,
          description,
          content='kanban_tasks',
          content_rowid='id'
        );
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS kanban_tasks_ai AFTER INSERT ON kanban_tasks BEGIN
          INSERT INTO kanban_tasks_fts(rowid, title, description)
          VALUES (new.id, new.title, new.description);
        END;

        CREATE TRIGGER IF NOT EXISTS kanban_tasks_ad AFTER DELETE ON kanban_tasks BEGIN
          INSERT INTO kanban_tasks_fts(kanban_tasks_fts, rowid, title, description)
          VALUES ('delete', old.id, old.title, old.description);
        END;

        CREATE TRIGGER IF NOT EXISTS kanban_tasks_au AFTER UPDATE ON kanban_tasks BEGIN
          INSERT INTO kanban_tasks_fts(kanban_tasks_fts, rowid, title, description)
          VALUES ('delete', old.id, old.title, old.description);
          INSERT INTO kanban_tasks_fts(rowid, title, description)
          VALUES (new.id, new.title, new.description);
        END;
      `);
    } catch {
      // kanban_tasks FTS5 triggers may already exist
    }

    // Migration: add subject column if missing (must run BEFORE FTS rebuild)
    const columns = this.db.pragma('table_info(facts)') as Array<{ name: string }>;
    const hasSubject = columns.some(c => c.name === 'subject');
    if (!hasSubject) {
      this.db.exec(`ALTER TABLE facts ADD COLUMN subject TEXT NOT NULL DEFAULT ''`);
      console.log('[Memory] Migrated facts table: added subject column');
    }

    // Rebuild FTS index from existing facts (after all schema migrations)
    this.rebuildFtsIndex();

    // Migration: add session_id to messages if missing
    const msgColumns = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    const hasSessionId = msgColumns.some(c => c.name === 'session_id');
    if (!hasSessionId) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN session_id TEXT REFERENCES sessions(id)`);
      console.log('[Memory] Migrated messages table: added session_id column');
    }

    // Migration: add session_id to summaries if missing
    const sumColumns = this.db.pragma('table_info(summaries)') as Array<{ name: string }>;
    const sumHasSessionId = sumColumns.some(c => c.name === 'session_id');
    if (!sumHasSessionId) {
      this.db.exec(`ALTER TABLE summaries ADD COLUMN session_id TEXT REFERENCES sessions(id)`);
      console.log('[Memory] Migrated summaries table: added session_id column');
    }

    // Migration: add metadata column to messages if missing
    const msgColsForMeta = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    const hasMetadata = msgColsForMeta.some(c => c.name === 'metadata');
    if (!hasMetadata) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN metadata TEXT`);
      console.log('[Memory] Migrated messages table: added metadata column');
    }

    // Migration: create default session and migrate orphan messages
    this.migrateToDefaultSession();

    // Migration: add session_id to calendar_events, tasks, and cron_jobs
    this.migrateSessionScopedTables();

    // Migration: add sdk_session_id to sessions for SDK session persistence
    const sessColumns = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    if (!sessColumns.some(c => c.name === 'sdk_session_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT');
      console.log('[Memory] Migrated sessions table: added sdk_session_id column');
    }
    if (!sessColumns.some(c => c.name === 'mode')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'coder'`);
      this.db.exec(`UPDATE sessions SET mode = 'coder' WHERE mode IS NULL OR trim(mode) = ''`);
      console.log('[Memory] Migrated sessions table: added mode column');
    }
    if (!sessColumns.some(c => c.name === 'hidden')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN hidden INTEGER DEFAULT 0`);
      this.db.exec(`UPDATE sessions SET hidden = 1 WHERE id != 'default' AND instr(id, ':') > 0`);
      console.log('[Memory] Migrated sessions table: added hidden column');
    }
    // Always self-heal colon-scoped runtime sessions so planner/agent lanes never reappear as normal chats.
    this.db.exec(`UPDATE sessions SET hidden = 1 WHERE id != 'default' AND instr(id, ':') > 0`);
    // Mode cleanup: "general" has been merged into "manager"
    this.db.exec(`UPDATE sessions SET mode = 'manager' WHERE lower(trim(mode)) = 'general'`);
    this.db.exec(`UPDATE sessions SET mode = 'coder' WHERE mode IS NULL OR lower(trim(mode)) NOT IN ('coder', 'manager')`);

    // Migration: shift daily_logs date keys to local time (pre-UTC bug)
    this.migrateDailyLogsToLocalDates();
  }

  /**
   * Add session_id column to calendar_events, tasks, and cron_jobs tables
   * and migrate existing records to the default session
   */
  private migrateSessionScopedTables(): void {
    const DEFAULT_SESSION_ID = 'default';

    // Helper to check if column exists
    const hasColumn = (table: string, column: string): boolean => {
      const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      return columns.some(c => c.name === column);
    };

    // Migrate calendar_events
    if (!hasColumn('calendar_events', 'session_id')) {
      this.db.exec(`ALTER TABLE calendar_events ADD COLUMN session_id TEXT REFERENCES sessions(id)`);
      const count = (this.db.prepare('SELECT COUNT(*) as c FROM calendar_events WHERE session_id IS NULL').get() as { c: number }).c;
      if (count > 0) {
        this.db.prepare('UPDATE calendar_events SET session_id = ? WHERE session_id IS NULL').run(DEFAULT_SESSION_ID);
        console.log(`[Memory] Migrated ${count} calendar events to default session`);
      }
      console.log('[Memory] Migrated calendar_events table: added session_id column');
    }

    // Migrate tasks
    if (!hasColumn('tasks', 'session_id')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT REFERENCES sessions(id)`);
      const count = (this.db.prepare('SELECT COUNT(*) as c FROM tasks WHERE session_id IS NULL').get() as { c: number }).c;
      if (count > 0) {
        this.db.prepare('UPDATE tasks SET session_id = ? WHERE session_id IS NULL').run(DEFAULT_SESSION_ID);
        console.log(`[Memory] Migrated ${count} tasks to default session`);
      }
      console.log('[Memory] Migrated tasks table: added session_id column');
    }

    // Migrate cron_jobs
    if (!hasColumn('cron_jobs', 'session_id')) {
      this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN session_id TEXT REFERENCES sessions(id)`);
      const count = (this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs WHERE session_id IS NULL').get() as { c: number }).c;
      if (count > 0) {
        this.db.prepare('UPDATE cron_jobs SET session_id = ? WHERE session_id IS NULL').run(DEFAULT_SESSION_ID);
        console.log(`[Memory] Migrated ${count} cron jobs to default session`);
      }
      console.log('[Memory] Migrated cron_jobs table: added session_id column');
    }

    // Migrate cron_jobs: add status and fired_at columns
    if (!hasColumn('cron_jobs', 'status')) {
      this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN status TEXT DEFAULT 'pending'`);
      // Existing one-time jobs that already ran get status='fired'
      this.db.prepare(`
        UPDATE cron_jobs SET status = 'fired'
        WHERE delete_after_run = 1 AND enabled = 0 AND last_run_at IS NOT NULL AND status = 'pending'
      `).run();
      console.log('[Memory] Migrated cron_jobs table: added status column');
    }
    if (!hasColumn('cron_jobs', 'fired_at')) {
      this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN fired_at TEXT`);
      // Backfill fired_at from last_run_at for already-fired reminders
      this.db.prepare(`
        UPDATE cron_jobs SET fired_at = last_run_at
        WHERE status = 'fired' AND fired_at IS NULL AND last_run_at IS NOT NULL
      `).run();
      console.log('[Memory] Migrated cron_jobs table: added fired_at column');
    }

    // Create indexes for session filtering
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_session ON calendar_events(session_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_session ON cron_jobs(session_id)`);
    } catch {
      // Indexes may already exist
    }

    // LinkedIn posts: add management columns
    if (!hasColumn('linkedin_posts', 'priority')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN priority TEXT DEFAULT 'normal'`);
      console.log('[Memory] Migrated linkedin_posts: added priority column');
    }
    if (!hasColumn('linkedin_posts', 'scheduled_at')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN scheduled_at TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added scheduled_at column');
    }
    if (!hasColumn('linkedin_posts', 'snoozed_until')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN snoozed_until TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added snoozed_until column');
    }
    if (!hasColumn('linkedin_posts', 'hidden')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN hidden INTEGER DEFAULT 0`);
      console.log('[Memory] Migrated linkedin_posts: added hidden column');
    }
    if (!hasColumn('linkedin_posts', 'reactions_at_snooze')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN reactions_at_snooze INTEGER`);
      console.log('[Memory] Migrated linkedin_posts: added reactions_at_snooze column');
    }
    if (!hasColumn('linkedin_posts', 'comments_at_snooze')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN comments_at_snooze INTEGER`);
      console.log('[Memory] Migrated linkedin_posts: added comments_at_snooze column');
    }
    if (!hasColumn('linkedin_posts', 'approved')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN approved INTEGER DEFAULT 0`);
      console.log('[Memory] Migrated linkedin_posts: added approved column');
    }
    if (!hasColumn('linkedin_posts', 'voice_preset')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN voice_preset TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added voice_preset column');
    }
    if (!hasColumn('linkedin_posts', 'engagement_check_due')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN engagement_check_due TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added engagement_check_due column');
    }
    if (!hasColumn('linkedin_posts', 'baseline_reactions')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN baseline_reactions INTEGER`);
      console.log('[Memory] Migrated linkedin_posts: added baseline_reactions column');
    }
    if (!hasColumn('linkedin_posts', 'baseline_comments')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN baseline_comments INTEGER`);
      console.log('[Memory] Migrated linkedin_posts: added baseline_comments column');
    }
    if (!hasColumn('linkedin_posts', 'engagement_checked')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN engagement_checked INTEGER DEFAULT 0`);
      console.log('[Memory] Migrated linkedin_posts: added engagement_checked column');
    }
    if (!hasColumn('linkedin_posts', 'first_seen_at')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN first_seen_at TEXT`);
      this.db.prepare(`UPDATE linkedin_posts SET first_seen_at = COALESCE(created_at, datetime('now')) WHERE first_seen_at IS NULL`).run();
      console.log('[Memory] Migrated linkedin_posts: added first_seen_at column');
    }
    if (!hasColumn('linkedin_posts', 'first_seen_reactions')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN first_seen_reactions INTEGER`);
      this.db.prepare(`UPDATE linkedin_posts SET first_seen_reactions = COALESCE(reactions, 0) WHERE first_seen_reactions IS NULL`).run();
      console.log('[Memory] Migrated linkedin_posts: added first_seen_reactions column');
    }
    if (!hasColumn('linkedin_posts', 'first_seen_comments')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN first_seen_comments INTEGER`);
      this.db.prepare(`UPDATE linkedin_posts SET first_seen_comments = COALESCE(comments, 0) WHERE first_seen_comments IS NULL`).run();
      console.log('[Memory] Migrated linkedin_posts: added first_seen_comments column');
    }
    if (!hasColumn('linkedin_posts', 'last_seen_at')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN last_seen_at TEXT`);
      this.db.prepare(`UPDATE linkedin_posts SET last_seen_at = datetime('now') WHERE last_seen_at IS NULL`).run();
      console.log('[Memory] Migrated linkedin_posts: added last_seen_at column');
    }
    if (!hasColumn('linkedin_posts', 'times_seen')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN times_seen INTEGER DEFAULT 1`);
      this.db.prepare(`UPDATE linkedin_posts SET times_seen = 1 WHERE times_seen IS NULL OR times_seen < 1`).run();
      console.log('[Memory] Migrated linkedin_posts: added times_seen column');
    }
    if (!hasColumn('linkedin_posts', 'scrape_status')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN scrape_status TEXT DEFAULT 'new'`);
      this.db.prepare(`UPDATE linkedin_posts SET scrape_status = CASE WHEN COALESCE(times_seen, 1) > 1 THEN 'seen_again' ELSE 'new' END WHERE scrape_status IS NULL OR TRIM(scrape_status) = ''`).run();
      console.log('[Memory] Migrated linkedin_posts: added scrape_status column');
    }
    if (!hasColumn('linkedin_posts', 'scrape_status_at')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN scrape_status_at TEXT`);
      this.db.prepare(`UPDATE linkedin_posts SET scrape_status_at = COALESCE(last_seen_at, first_seen_at, created_at, datetime('now')) WHERE scrape_status_at IS NULL`).run();
      console.log('[Memory] Migrated linkedin_posts: added scrape_status_at column');
    }
    if (!hasColumn('linkedin_posts', 'source_tag')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN source_tag TEXT DEFAULT 'feed:home'`);
      this.db.prepare(`UPDATE linkedin_posts SET source_tag = 'feed:home' WHERE source_tag IS NULL OR TRIM(source_tag) = ''`).run();
      console.log('[Memory] Migrated linkedin_posts: added source_tag column');
    }
    if (!hasColumn('linkedin_posts', 'draft_state')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN draft_state TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added draft_state column');
    }
    if (!hasColumn('linkedin_posts', 'draft_error')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN draft_error TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added draft_error column');
    }
    if (!hasColumn('linkedin_posts', 'draft_started_at')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN draft_started_at TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added draft_started_at column');
    }
    if (!hasColumn('linkedin_posts', 'draft_finished_at')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN draft_finished_at TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added draft_finished_at column');
    }
    if (!hasColumn('linkedin_posts', 'image_count')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN image_count INTEGER DEFAULT 0`);
      console.log('[Memory] Migrated linkedin_posts: added image_count column');
    }
    if (!hasColumn('linkedin_posts', 'image_analysis_status')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN image_analysis_status TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added image_analysis_status column');
    }
    if (!hasColumn('linkedin_posts', 'image_analysis_note')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN image_analysis_note TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added image_analysis_note column');
    }
    if (!hasColumn('linkedin_posts', 'image_analyzed_at')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN image_analyzed_at TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added image_analyzed_at column');
    }
    if (!hasColumn('linkedin_posts', 'hook_score')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN hook_score INTEGER`);
      console.log('[Memory] Migrated linkedin_posts: added hook_score column');
    }
    if (!hasColumn('linkedin_posts', 'emotion_tag')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN emotion_tag TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added emotion_tag column');
    }
    if (!hasColumn('linkedin_posts', 'niche_target')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN niche_target TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added niche_target column');
    }
    if (!hasColumn('linkedin_posts', 'authenticity_flag')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN authenticity_flag TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added authenticity_flag column');
    }
    if (!hasColumn('linkedin_posts', 'post_bank_ids')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN post_bank_ids TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added post_bank_ids column');
    }
    if (!hasColumn('linkedin_posts', 'post_bank_group')) {
      this.db.exec(`ALTER TABLE linkedin_posts ADD COLUMN post_bank_group TEXT`);
      console.log('[Memory] Migrated linkedin_posts: added post_bank_group column');
    }

    // LinkedIn activity log (auto-poster audit trail)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        post_url TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        comment_text TEXT,
        daily_limit INTEGER,
        daily_count INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // LinkedIn authors (relationship tracking)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        profile_url TEXT,
        first_seen TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now')),
        total_posts_seen INTEGER DEFAULT 0,
        total_comments_by_me INTEGER DEFAULT 0,
        last_commented_date TEXT,
        notes TEXT
      )
    `);

    // LinkedIn engagement checks (delta tracking)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_engagement_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        post_url TEXT NOT NULL,
        checked_at TEXT DEFAULT (datetime('now')),
        reactions INTEGER NOT NULL,
        comments_count INTEGER NOT NULL,
        reactions_delta INTEGER DEFAULT 0,
        comments_delta INTEGER DEFAULT 0,
        baseline INTEGER DEFAULT 0
      )
    `);

    // Content Planner: publishing targets (profile, company, group, article)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL DEFAULT 'profile',
        url TEXT,
        label TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        audience_summary TEXT,
        tone_rules TEXT,
        topic_fit_rules TEXT,
        cta_style TEXT,
        posts_per_day INTEGER DEFAULT 1,
        approval_mode TEXT DEFAULT 'review_required',
        can_auto_publish INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Content Planner: plans (one research prompt -> multiple target-specific assets)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_content_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        topic TEXT,
        source_urls TEXT,
        research_mode TEXT DEFAULT 'balanced',
        status TEXT DEFAULT 'draft',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Content Planner: assets (one per plan x target, lifecycle: pending -> drafted -> approved -> scheduled -> published)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_plan_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES linkedin_content_plans(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES linkedin_targets(id),
        draft_text TEXT,
        final_text TEXT,
        quality_score INTEGER,
        fingerprint TEXT,
        evidence_id INTEGER REFERENCES linkedin_draft_evidence(id),
        kanban_task_id INTEGER,
        status TEXT DEFAULT 'pending',
        scheduled_at TEXT,
        published_at TEXT,
        publish_error TEXT,
        image_path TEXT,
        image_model TEXT DEFAULT 'nano-banana-pro',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // Migration: add image_path if missing (existing installs)
    try {
      this.db.exec(`ALTER TABLE linkedin_plan_assets ADD COLUMN image_path TEXT`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lpa_plan ON linkedin_plan_assets(plan_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lpa_target ON linkedin_plan_assets(target_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lpa_status ON linkedin_plan_assets(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lpa_scheduled ON linkedin_plan_assets(scheduled_at) WHERE status = 'scheduled'`);

    // Idea Lab: migrate plan_assets with new columns
    const assetMigrations = [
      'ALTER TABLE linkedin_plan_assets ADD COLUMN session_id INTEGER REFERENCES linkedin_idea_sessions(id)',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN idea_card_id INTEGER REFERENCES linkedin_idea_cards(id)',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN batch_rules TEXT',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN per_idea_rules TEXT',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN discussion_context TEXT',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN last_error TEXT',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN error_step TEXT',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN retry_count INTEGER DEFAULT 0',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN image_model TEXT DEFAULT \'nano-banana-pro\'',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN image_preset TEXT DEFAULT \'none\'',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN image_caption TEXT',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN source_urls_json TEXT',
      'ALTER TABLE linkedin_plan_assets ADD COLUMN trace_json TEXT',
    ];
    for (const sql of assetMigrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ } // eslint-disable-line no-empty
    }

    // Idea Lab: sessions (freeform dump + discussion thread)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_idea_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT DEFAULT 'active',
        initial_dump TEXT,
        discussion_history TEXT,
        batch_rules TEXT,
        research_sources TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Idea Lab: idea cards (generated from discussion)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_idea_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES linkedin_idea_sessions(id) ON DELETE CASCADE,
        target_id INTEGER REFERENCES linkedin_targets(id),
        angle TEXT NOT NULL,
        hook TEXT,
        key_points TEXT,
        source_urls TEXT,
        image_model TEXT DEFAULT 'nano-banana-pro',
        image_preset TEXT DEFAULT 'none',
        image_concept TEXT,
        image_caption TEXT,
        per_idea_rules TEXT,
        selected INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        asset_id INTEGER REFERENCES linkedin_plan_assets(id),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lic_session ON linkedin_idea_cards(session_id)`);
    try { this.db.exec(`ALTER TABLE linkedin_idea_cards ADD COLUMN image_model TEXT DEFAULT 'nano-banana-pro'`); } catch { /* column already exists */ }

    // URL Registry: central source database for all URLs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_url_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        url_hash TEXT NOT NULL,
        domain TEXT,
        url_type TEXT NOT NULL DEFAULT 'reference',
        title TEXT,
        snippet TEXT,
        topic_tags TEXT,
        times_used INTEGER DEFAULT 1,
        first_seen_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_url_hash ON linkedin_url_registry(url_hash)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_url_type ON linkedin_url_registry(url_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_url_domain ON linkedin_url_registry(domain)`);

    // URL Registry: junction tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_session_urls (
        session_id INTEGER NOT NULL REFERENCES linkedin_idea_sessions(id) ON DELETE CASCADE,
        url_id INTEGER NOT NULL REFERENCES linkedin_url_registry(id),
        role TEXT DEFAULT 'research',
        PRIMARY KEY (session_id, url_id)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_idea_urls (
        idea_card_id INTEGER NOT NULL REFERENCES linkedin_idea_cards(id) ON DELETE CASCADE,
        url_id INTEGER NOT NULL REFERENCES linkedin_url_registry(id),
        PRIMARY KEY (idea_card_id, url_id)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linkedin_asset_urls (
        asset_id INTEGER NOT NULL REFERENCES linkedin_plan_assets(id) ON DELETE CASCADE,
        url_id INTEGER NOT NULL REFERENCES linkedin_url_registry(id),
        role TEXT DEFAULT 'source',
        PRIMARY KEY (asset_id, url_id, role)
      )
    `);
  }

  private migrateDailyLogsToLocalDates(): void {
    const rows = this.db.prepare(`
      SELECT id, date, content, updated_at
      FROM daily_logs
      ORDER BY date ASC, id ASC
    `).all() as Array<{ id: number; date: string; content: string; updated_at: string }>;

    if (rows.length === 0) return;

    const merged = new Map<string, { content: string; updated_at: string }>();
    let needsMigration = false;

    for (const row of rows) {
      const localDate = this.coerceLocalDateFromUpdatedAt(row.updated_at, row.date);
      if (localDate !== row.date) needsMigration = true;

      const existing = merged.get(localDate);
      if (existing) {
        existing.content = existing.content + '\n' + row.content;
        if (row.updated_at > existing.updated_at) {
          existing.updated_at = row.updated_at;
        }
      } else {
        merged.set(localDate, { content: row.content, updated_at: row.updated_at });
      }
    }

    if (!needsMigration) return;

    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM daily_logs');
      const insert = this.db.prepare(`
        INSERT INTO daily_logs (date, content, updated_at)
        VALUES (?, ?, ?)
      `);
      for (const [date, data] of merged.entries()) {
        insert.run(date, data.content, data.updated_at);
      }
    });

    tx();
    console.log(`[Memory] Migrated daily_logs to local dates (${rows.length} rows -> ${merged.size} days)`);
  }

  /**
   * Create default session and migrate existing messages without session_id
   */
  private migrateToDefaultSession(): void {
    const DEFAULT_SESSION_ID = 'default';
    const DEFAULT_SESSION_NAME = 'Chat';

    // Check if default session exists
    const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(DEFAULT_SESSION_ID);
    if (!existing) {
      // Create default session
      this.db.prepare(`
        INSERT INTO sessions (id, name, created_at, updated_at)
        VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ')), (strftime('%Y-%m-%dT%H:%M:%fZ')))
      `).run(DEFAULT_SESSION_ID, DEFAULT_SESSION_NAME);
      console.log('[Memory] Created default session');
    }

    // Migrate orphan messages (no session_id) to default session
    const orphanCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id IS NULL').get() as { c: number }).c;
    if (orphanCount > 0) {
      this.db.prepare('UPDATE messages SET session_id = ? WHERE session_id IS NULL').run(DEFAULT_SESSION_ID);
      console.log(`[Memory] Migrated ${orphanCount} messages to default session`);
    }

    // Migrate orphan summaries to default session
    const orphanSumCount = (this.db.prepare('SELECT COUNT(*) as c FROM summaries WHERE session_id IS NULL').get() as { c: number }).c;
    if (orphanSumCount > 0) {
      this.db.prepare('UPDATE summaries SET session_id = ? WHERE session_id IS NULL').run(DEFAULT_SESSION_ID);
      console.log(`[Memory] Migrated ${orphanSumCount} summaries to default session`);
    }
  }

  /**
   * Rebuild all FTS indexes from existing data
   */
  private rebuildFtsIndex(): void {
    // Facts FTS
    try {
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM facts_fts').get() as { c: number }).c;
      const factsCount = (this.db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c;

      if (ftsCount === 0 && factsCount > 0) {
        console.log('[Memory] Rebuilding facts FTS index...');
        const facts = this.db.prepare('SELECT id, category, subject, content FROM facts').all() as Fact[];
        const insert = this.db.prepare('INSERT INTO facts_fts(rowid, category, subject, content) VALUES (?, ?, ?, ?)');
        for (const fact of facts) {
          insert.run(fact.id, fact.category, fact.subject, fact.content);
        }
        console.log(`[Memory] Rebuilt facts FTS with ${facts.length} entries`);
      }
    } catch (e) {
      console.warn('[Memory] Facts FTS rebuild failed:', e);
    }

    // Messages FTS
    try {
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages_fts').get() as { c: number }).c;
      const msgCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;

      if (ftsCount === 0 && msgCount > 0) {
        console.log('[Memory] Rebuilding messages FTS index...');
        const msgs = this.db.prepare('SELECT id, content FROM messages').all() as Array<{ id: number; content: string }>;
        const insert = this.db.prepare('INSERT INTO messages_fts(rowid, content) VALUES (?, ?)');
        for (const msg of msgs) {
          insert.run(msg.id, msg.content);
        }
        console.log(`[Memory] Rebuilt messages FTS with ${msgs.length} entries`);
      }
    } catch (e) {
      console.warn('[Memory] Messages FTS rebuild failed:', e);
    }

    // Cron jobs FTS
    try {
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs_fts').get() as { c: number }).c;
      const cronCount = (this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs').get() as { c: number }).c;

      if (ftsCount === 0 && cronCount > 0) {
        console.log('[Memory] Rebuilding cron_jobs FTS index...');
        const crons = this.db.prepare('SELECT id, name, prompt FROM cron_jobs').all() as Array<{ id: number; name: string; prompt: string }>;
        const insert = this.db.prepare('INSERT INTO cron_jobs_fts(rowid, name, prompt) VALUES (?, ?, ?)');
        for (const cron of crons) {
          insert.run(cron.id, cron.name, cron.prompt);
        }
        console.log(`[Memory] Rebuilt cron_jobs FTS with ${crons.length} entries`);
      }
    } catch (e) {
      console.warn('[Memory] Cron jobs FTS rebuild failed:', e);
    }

    // Kanban tasks FTS
    try {
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM kanban_tasks_fts').get() as { c: number }).c;
      const taskCount = (this.db.prepare('SELECT COUNT(*) as c FROM kanban_tasks').get() as { c: number }).c;

      if (ftsCount === 0 && taskCount > 0) {
        console.log('[Memory] Rebuilding kanban_tasks FTS index...');
        const tasks = this.db.prepare('SELECT id, title, description FROM kanban_tasks').all() as Array<{ id: number; title: string; description: string | null }>;
        const insert = this.db.prepare('INSERT INTO kanban_tasks_fts(rowid, title, description) VALUES (?, ?, ?)');
        for (const task of tasks) {
          insert.run(task.id, task.title, task.description || '');
        }
        console.log(`[Memory] Rebuilt kanban_tasks FTS with ${tasks.length} entries`);
      }
    } catch (e) {
      console.warn('[Memory] Kanban tasks FTS rebuild failed:', e);
    }
  }

  /**
   * Initialize embeddings with OpenAI API key
   */
  initializeEmbeddings(openaiApiKey: string): void {
    initEmbeddings(openaiApiKey);
    this.embeddingsReady = true;
    console.log('[Memory] Embeddings initialized');

    // Embed any facts that don't have embeddings
    this.embedMissingFacts().catch(err => {
      console.error('[Memory] Failed to embed missing facts:', err);
    });
  }

  /**
   * Embed facts that don't have embeddings yet
   */
  private async embedMissingFacts(): Promise<void> {
    if (!hasEmbeddings()) return;

    const factsWithoutEmbeddings = this.db.prepare(`
      SELECT f.id, f.category, f.subject, f.content
      FROM facts f
      LEFT JOIN chunks c ON f.id = c.fact_id
      WHERE c.id IS NULL
    `).all() as Fact[];

    if (factsWithoutEmbeddings.length === 0) return;

    console.log(`[Memory] Embedding ${factsWithoutEmbeddings.length} facts...`);

    const batchSize = 5;
    for (let i = 0; i < factsWithoutEmbeddings.length; i += batchSize) {
      const batch = factsWithoutEmbeddings.slice(i, i + batchSize);
      await Promise.all(batch.map(fact => this.embedFact(fact)));
    }

    console.log('[Memory] Finished embedding facts');
  }

  /**
   * Generate and store embedding for a fact
   */
  private async embedFact(fact: Fact): Promise<void> {
    if (!hasEmbeddings()) return;

    try {
      // Combine fact fields for embedding
      const textToEmbed = `${fact.category}: ${fact.subject} - ${fact.content}`;
      const embedding = await embed(textToEmbed);
      const embeddingBuffer = serializeEmbedding(embedding);

      // Delete existing chunk for this fact
      this.db.prepare('DELETE FROM chunks WHERE fact_id = ?').run(fact.id);

      // Insert new chunk with embedding
      this.db.prepare(`
        INSERT INTO chunks (fact_id, content, embedding)
        VALUES (?, ?, ?)
      `).run(fact.id, textToEmbed, embeddingBuffer);
    } catch (err) {
      console.error(`[Memory] Failed to embed fact ${fact.id}:`, err);
    }
  }

  /**
   * Set the summarizer function
   */
  setSummarizer(fn: SummarizerFn): void {
    this.summarizer = fn;
  }

  // ============ SESSION METHODS ============

  /**
   * Create a new session
   * @throws Error if session name already exists
   */
  createSession(name: string, mode: 'coder' | 'manager' = 'coder'): Session {
    // Check for duplicate name
    const existing = this.getSessionByName(name);
    if (existing) {
      throw new Error(`Session name "${name}" already exists`);
    }

    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(`
      INSERT INTO sessions (id, name, mode, hidden, created_at, updated_at)
      VALUES (?, ?, ?, 0, (strftime('%Y-%m-%dT%H:%M:%fZ')), (strftime('%Y-%m-%dT%H:%M:%fZ')))
    `).run(id, name, mode);

    return this.getSession(id)!;
  }

  private shouldHideSession(id: string): boolean {
    return id !== 'default' && id.includes(':');
  }

  /**
   * Get a session by name (exact match)
   */
  getSessionByName(name: string): Session | null {
    const row = this.db.prepare(`
      SELECT id, name, mode, COALESCE(hidden, 0) AS hidden, created_at, updated_at
      FROM sessions
      WHERE name = ?
    `).get(name) as Session | undefined;

    if (!row) return null;
    row.mode = this.normalizeSessionMode(row.mode || null);
    return row;
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): Session | null {
    const row = this.db.prepare(`
      SELECT id, name, mode, COALESCE(hidden, 0) AS hidden, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `).get(id) as Session | undefined;

    if (!row) return null;
    row.mode = this.normalizeSessionMode(row.mode || null);
    return row;
  }

  ensureSession(id: string, name?: string, mode: 'coder' | 'manager' = 'coder'): Session {
    const existing = this.getSession(id);
    if (existing) {
      if (this.shouldHideSession(id) && !existing.hidden) {
        this.db.prepare(`
          UPDATE sessions
          SET hidden = 1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
          WHERE id = ?
        `).run(id);
        return this.getSession(id)!;
      }
      return existing;
    }

    const sessionName = String(name || id || 'Session').trim() || id;
    const hidden = this.shouldHideSession(id) ? 1 : 0;
    this.db.prepare(`
      INSERT INTO sessions (id, name, mode, hidden, created_at, updated_at)
      VALUES (?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ')), (strftime('%Y-%m-%dT%H:%M:%fZ')))
    `).run(id, sessionName, mode, hidden);
    return this.getSession(id)!;
  }

  /**
   * Get all sessions, ordered by most recent activity
   * Includes telegram link status
   */
  getSessions(): Session[] {
    interface SessionRow {
      id: string;
      name: string;
      mode: string | null;
      created_at: string;
      updated_at: string;
      telegram_linked: number;
      telegram_group_name: string | null;
    }
    const rows = this.db.prepare(`
      SELECT
        s.id,
        s.name,
        s.mode,
        s.created_at,
        s.updated_at,
        CASE WHEN t.chat_id IS NOT NULL THEN 1 ELSE 0 END as telegram_linked,
        t.group_name as telegram_group_name
      FROM sessions s
      LEFT JOIN telegram_chat_sessions t ON s.id = t.session_id
      WHERE COALESCE(s.hidden, 0) = 0
        AND (s.id = 'default' OR instr(s.id, ':') = 0)
      ORDER BY s.updated_at DESC
    `).all() as SessionRow[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      mode: this.normalizeSessionMode(row.mode),
      created_at: row.created_at,
      updated_at: row.updated_at,
      telegram_linked: !!row.telegram_linked,
      telegram_group_name: row.telegram_group_name,
    }));
  }

  /**
   * Get the mode for a session (defaults to coder for legacy sessions)
   */
  getSessionMode(sessionId: string): 'coder' | 'manager' {
    const row = this.db.prepare('SELECT mode FROM sessions WHERE id = ?').get(sessionId) as { mode: string | null } | undefined;
    return this.normalizeSessionMode(row?.mode);
  }

  /**
   * Set the mode for a session.
   */
  setSessionMode(sessionId: string, mode: 'coder' | 'manager'): boolean {
    const normalized = this.normalizeSessionMode(mode);
    const result = this.db.prepare(`
      UPDATE sessions SET mode = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
      WHERE id = ?
    `).run(normalized, sessionId);
    return result.changes > 0;
  }

  /**
   * Rename a session
   * @throws Error if new name already exists
   */
  renameSession(id: string, name: string): boolean {
    // Check for duplicate name (excluding self)
    const existing = this.getSessionByName(name);
    if (existing && existing.id !== id) {
      throw new Error(`Session name "${name}" already exists`);
    }

    const result = this.db.prepare(`
      UPDATE sessions SET name = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
      WHERE id = ?
    `).run(name, id);

    return result.changes > 0;
  }

  /**
   * Delete a session and all its messages/summaries
   */
  deleteSession(id: string): boolean {
    // Don't allow deleting the default session
    if (id === 'default') {
      console.warn('[Memory] Cannot delete the default session');
      return false;
    }

    // Delete related data first (due to foreign key constraints)
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM summaries WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM telegram_chat_sessions WHERE session_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

    return result.changes > 0;
  }

  /**
   * Touch session (update updated_at timestamp)
   */
  touchSession(id: string): void {
    this.db.prepare(`UPDATE sessions SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id = ?`).run(id);
  }

  /**
   * Get session message count
   */
  getSessionMessageCount(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as { c: number };
    return row.c;
  }

  // ============ TELEGRAM CHAT SESSION METHODS ============

  /**
   * Link a Telegram chat to a session
   */
  linkTelegramChat(chatId: number, sessionId: string, groupName?: string): boolean {
    try {
      this.db.prepare(`
        INSERT INTO telegram_chat_sessions (chat_id, session_id, group_name)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          session_id = excluded.session_id,
          group_name = excluded.group_name
      `).run(chatId, sessionId, groupName || null);
      return true;
    } catch (err) {
      console.error('[Memory] Failed to link Telegram chat:', err);
      return false;
    }
  }

  /**
   * Unlink a Telegram chat from its session
   */
  unlinkTelegramChat(chatId: number): boolean {
    const result = this.db.prepare('DELETE FROM telegram_chat_sessions WHERE chat_id = ?').run(chatId);
    return result.changes > 0;
  }

  /**
   * Get the session ID for a Telegram chat
   */
  getSessionForChat(chatId: number): string | null {
    const row = this.db.prepare(`
      SELECT session_id FROM telegram_chat_sessions WHERE chat_id = ?
    `).get(chatId) as { session_id: string } | undefined;
    return row?.session_id || null;
  }

  /**
   * Get the Telegram chat ID for a session
   */
  getChatForSession(sessionId: string): number | null {
    const row = this.db.prepare(`
      SELECT chat_id FROM telegram_chat_sessions WHERE session_id = ?
    `).get(sessionId) as { chat_id: number } | undefined;
    return row?.chat_id || null;
  }

  /**
   * Get all Telegram chat to session mappings
   */
  getAllTelegramChatSessions(): TelegramChatSession[] {
    return this.db.prepare(`
      SELECT chat_id, session_id, group_name, created_at
      FROM telegram_chat_sessions
      ORDER BY created_at DESC
    `).all() as TelegramChatSession[];
  }

  // ============ DAILY LOG METHODS ============

  /**
   * Get today's local date in YYYY-MM-DD format
   */
  private getTodayDate(): string {
    return this.formatLocalDate(new Date());
  }

  private formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getLocalDateNDaysAgo(daysAgo: number): string {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - daysAgo);
    return this.formatLocalDate(date);
  }

  private coerceLocalDateFromUpdatedAt(updatedAt: string | null | undefined, fallbackDate: string): string {
    if (updatedAt) {
      const parsed = new Date(updatedAt);
      if (!Number.isNaN(parsed.getTime())) {
        return this.formatLocalDate(parsed);
      }
    }
    return fallbackDate;
  }

  /**
   * Get a daily log by date (defaults to today)
   */
  getDailyLog(date?: string): DailyLog | null {
    const targetDate = date || this.getTodayDate();
    const row = this.db.prepare(`
      SELECT id, date, content, updated_at
      FROM daily_logs
      WHERE date = ?
    `).get(targetDate) as DailyLog | undefined;

    return row || null;
  }

  /**
   * Append an entry to today's daily log
   * Creates the log if it doesn't exist
   */
  appendToDailyLog(entry: string): DailyLog {
    const today = this.getTodayDate();
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const formattedEntry = `[${timestamp}] ${entry}`;

    const existing = this.getDailyLog(today);

    if (existing) {
      // Append to existing log
      const newContent = existing.content + '\n' + formattedEntry;
      this.db.prepare(`
        UPDATE daily_logs
        SET content = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
        WHERE date = ?
      `).run(newContent, today);
    } else {
      // Create new log for today
      this.db.prepare(`
        INSERT INTO daily_logs (date, content, updated_at)
        VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ')))
      `).run(today, formattedEntry);
    }

    return this.getDailyLog(today)!;
  }

  /**
   * Get recent daily logs (for context)
   */
  getRecentDailyLogs(days: number = 3): DailyLog[] {
    return this.db.prepare(`
      SELECT id, date, content, updated_at
      FROM daily_logs
      ORDER BY date DESC
      LIMIT ?
    `).all(days) as DailyLog[];
  }

  /**
   * Get all daily logs (for display in UI)
   */
  getAllDailyLogs(): DailyLog[] {
    return this.db.prepare(`
      SELECT id, date, content, updated_at
      FROM daily_logs
      ORDER BY date DESC
    `).all() as DailyLog[];
  }

  /**
   * Get daily logs from the last N calendar days
   */
  getDailyLogsSince(days: number = 3): DailyLog[] {
    const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 3;
    const startDate = this.getLocalDateNDaysAgo(Math.max(0, safeDays - 1));
    return this.db.prepare(`
      SELECT id, date, content, updated_at
      FROM daily_logs
      WHERE date >= ?
      ORDER BY date DESC
    `).all(startDate) as DailyLog[];
  }

  /**
   * Get daily logs as formatted context string for the agent
   */
  getDailyLogsContext(days: number = 3): string {
    const logs = this.getDailyLogsSince(days);
    if (logs.length === 0) {
      return '';
    }

    const lines: string[] = ['## Recent Daily Logs'];
    for (const log of logs.reverse()) {  // Show oldest first
      const dateLabel = log.date === this.getTodayDate() ? 'Today' : log.date;
      lines.push(`\n### ${dateLabel}`);
      lines.push(log.content);
    }

    return lines.join('\n');
  }

  // ============ MESSAGE METHODS ============

  saveMessage(role: 'user' | 'assistant' | 'system', content: string, sessionId: string = 'default', metadata?: Record<string, unknown>): number {
    const tokenCount = estimateTokens(content);
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    const stmt = this.db.prepare(`
      INSERT INTO messages (role, content, token_count, session_id, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(role, content, tokenCount, sessionId, metadataJson);

    // Touch session to update activity timestamp
    this.touchSession(sessionId);

    return result.lastInsertRowid as number;
  }

  getRecentMessages(limit: number = 50, sessionId: string = 'default'): Message[] {
    const stmt = this.db.prepare(`
      SELECT id, role, content, timestamp, token_count, session_id, metadata
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    const rows = stmt.all(sessionId, limit) as Array<Message & { metadata: string | null }>;
    return rows.reverse().map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  getMessageCount(sessionId?: string): number {
    if (sessionId) {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
      const row = stmt.get(sessionId) as { count: number };
      return row.count;
    }
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  async getConversationContext(
    tokenLimit: number = DEFAULT_TOKEN_LIMIT,
    sessionId: string = 'default'
  ): Promise<ConversationContext> {
    const reservedTokens = 10000;
    const availableTokens = tokenLimit - reservedTokens;

    // Limit query to reasonable number of messages (avoids loading entire history into memory)
    // 1000 messages at ~300 tokens each = ~300k tokens, well above our typical limit
    const MAX_MESSAGES_TO_FETCH = 1000;

    const recentMessagesQuery = this.db.prepare(`
      SELECT id, role, content, timestamp, token_count, session_id
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(sessionId, MAX_MESSAGES_TO_FETCH) as Message[];

    if (recentMessagesQuery.length === 0) {
      return { messages: [], totalTokens: 0, summarizedCount: 0 };
    }

    // Get total count to know if there are older messages beyond our limit
    const totalCount = this.getMessageCount(sessionId);

    const recentMessages: Message[] = [];
    let tokenCount = 0;

    for (let i = 0; i < recentMessagesQuery.length; i++) {
      const msg = recentMessagesQuery[i];
      const msgTokens = msg.token_count || estimateTokens(msg.content);

      if (tokenCount + msgTokens > availableTokens) {
        break;
      }

      recentMessages.unshift(msg);
      tokenCount += msgTokens;
    }

    // Calculate how many messages are older than what we're including
    const olderMessageCount = totalCount - recentMessages.length;

    if (olderMessageCount <= 0) {
      return {
        messages: recentMessages.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
        totalTokens: tokenCount,
        summarizedCount: 0,
      };
    }

    const oldestRecentId = recentMessages[0]?.id || 0;
    const summary = await this.getOrCreateSummary(oldestRecentId, sessionId);

    const contextMessages: Array<{ role: string; content: string }> = [];

    if (summary) {
      console.log(`[Memory] Including summary for ${olderMessageCount} older messages`);
      contextMessages.push({
        role: 'system',
        content: `[Previous conversation summary]\n${summary}`,
      });
      tokenCount += estimateTokens(summary);
    }

    contextMessages.push(
      ...recentMessages.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp }))
    );

    return {
      messages: contextMessages,
      totalTokens: tokenCount,
      summarizedCount: olderMessageCount,
      summary,
    };
  }

  /**
   * Get smart context using rolling summaries, recent messages, and semantic retrieval.
   * This is more efficient than loading all messages into context.
   */
  async getSmartContext(
    sessionId: string = 'default',
    options: SmartContextOptions
  ): Promise<SmartContext> {
    const { recentMessageLimit, rollingSummaryInterval, semanticRetrievalCount, currentQuery } = options;

    // 1. Get total message count
    const totalMessages = this.getMessageCount(sessionId);

    // 2. Get recent messages (last N messages)
    const recentMessagesQuery = this.db.prepare(`
      SELECT id, role, content, timestamp, token_count
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(sessionId, recentMessageLimit) as Message[];

    const recentMessages = recentMessagesQuery.reverse(); // Oldest first
    const oldestRecentId = recentMessages[0]?.id || 0;

    // 3. Get or create rolling summary for older messages
    let rollingSummary: string | null = null;
    const summarizedMessages = totalMessages - recentMessages.length;

    if (summarizedMessages > 0 && oldestRecentId > 1) {
      rollingSummary = await this.getOrCreateRollingSummary(
        oldestRecentId,
        sessionId,
        rollingSummaryInterval
      );
    }

    // 4. Get semantically relevant messages (if embeddings available and query provided)
    let relevantMessages: Array<{ role: string; content: string; timestamp?: string; similarity?: number }> = [];
    if (semanticRetrievalCount > 0 && currentQuery && this.embeddingsReady) {
      relevantMessages = await this.searchRelevantMessages(
        currentQuery,
        sessionId,
        semanticRetrievalCount,
        recentMessages.map(m => m.id) // Exclude recent messages
      );
    }

    // 5. Calculate total tokens
    let totalTokens = 0;
    for (const msg of recentMessages) {
      totalTokens += msg.token_count || estimateTokens(msg.content);
    }
    if (rollingSummary) {
      totalTokens += estimateTokens(rollingSummary);
    }
    for (const msg of relevantMessages) {
      totalTokens += estimateTokens(msg.content);
    }

    console.log(`[Memory] Smart context: ${recentMessages.length} recent, ${summarizedMessages} summarized, ${relevantMessages.length} relevant (${totalTokens} tokens)`);

    return {
      recentMessages: recentMessages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
      rollingSummary,
      relevantMessages,
      totalTokens,
      stats: {
        totalMessages,
        summarizedMessages,
        recentCount: recentMessages.length,
        relevantCount: relevantMessages.length,
        newSummaryCreated: false,  // Not creating new summary in this function
      },
    };
  }

  /**
   * Get or create a rolling summary for messages before the given ID.
   * Creates incremental summaries every N messages.
   */
  private async getOrCreateRollingSummary(
    beforeMessageId: number,
    sessionId: string,
    interval: number
  ): Promise<string | null> {
    // Check for existing rolling summary that covers up to beforeMessageId-1
    const existingRow = this.db.prepare(`
      SELECT content, end_message_id FROM rolling_summaries
      WHERE session_id = ? AND end_message_id <= ?
      ORDER BY end_message_id DESC
      LIMIT 1
    `).get(sessionId, beforeMessageId - 1) as { content: string; end_message_id: number } | undefined;

    const existingSummary = existingRow ? { content: existingRow.content } : undefined;
    const lastSummarizedId = existingRow?.end_message_id || 0;

    // Get messages that need summarizing (between last summary and beforeMessageId)
    const unsummarizedMessages = this.db.prepare(`
      SELECT id, role, content, timestamp
      FROM messages
      WHERE session_id = ? AND id > ? AND id < ?
      ORDER BY id ASC
    `).all(sessionId, lastSummarizedId, beforeMessageId) as Message[];

    // If we have enough unsummarized messages, create a new rolling summary
    if (unsummarizedMessages.length >= interval && this.summarizer) {
      const newSummary = await this.createRollingSummary(
        unsummarizedMessages,
        sessionId,
        existingSummary?.content
      );

      // Store the new rolling summary
      const startId = unsummarizedMessages[0].id;
      const endId = unsummarizedMessages[unsummarizedMessages.length - 1].id;

      this.db.prepare(`
        INSERT INTO rolling_summaries (session_id, start_message_id, end_message_id, content, token_count)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, startId, endId, newSummary, estimateTokens(newSummary));

      console.log(`[Memory] Created rolling summary for messages ${startId}-${endId}`);

      // Combine with existing summary
      if (existingSummary?.content) {
        return `${existingSummary.content}\n\n${newSummary}`;
      }
      return newSummary;
    }

    // Return existing summary combined with basic summary of recent unsummarized
    if (existingSummary?.content) {
      if (unsummarizedMessages.length > 0) {
        const basicSummary = this.createBasicSummary(unsummarizedMessages);
        return `${existingSummary.content}\n\n${basicSummary}`;
      }
      return existingSummary.content;
    }

    // No existing summary - create basic summary if we have messages
    if (unsummarizedMessages.length > 0) {
      return this.createBasicSummary(unsummarizedMessages);
    }

    return null;
  }

  /**
   * Create a rolling summary from messages, optionally incorporating a previous summary.
   */
  private async createRollingSummary(
    messages: Message[],
    sessionId: string,
    previousSummary?: string
  ): Promise<string> {
    if (!this.summarizer) {
      return this.createBasicSummary(messages);
    }

    try {
      // If there's a previous summary, include it as context
      const messagesWithContext = previousSummary
        ? [{ id: 0, role: 'system' as const, content: `[Previous summary]\n${previousSummary}`, timestamp: '' }, ...messages]
        : messages;

      const summary = await this.summarizer(messagesWithContext);
      console.log(`[Memory] Created rolling summary for session ${sessionId} (${messages.length} messages, ${estimateTokens(summary)} tokens)`);
      return summary;
    } catch (error) {
      console.error('[Memory] Rolling summary failed, using basic summary:', error);
      return this.createBasicSummary(messages);
    }
  }

  /**
   * Search for semantically relevant past messages using embeddings.
   */
  private async searchRelevantMessages(
    query: string,
    sessionId: string,
    limit: number,
    excludeIds: number[]
  ): Promise<Array<{ role: string; content: string; timestamp?: string; similarity: number }>> {
    if (!hasEmbeddings()) {
      return [];
    }

    try {
      const queryEmbedding = await embed(query);

      // Get message embeddings (excluding recent messages)
      const placeholders = excludeIds.length > 0 ? excludeIds.map(() => '?').join(',') : '0';
      const params = excludeIds.length > 0 ? [sessionId, ...excludeIds] : [sessionId];
      const embeddings = this.db.prepare(`
        SELECT me.message_id, me.embedding, m.role, m.content, m.timestamp
        FROM message_embeddings me
        JOIN messages m ON me.message_id = m.id
        WHERE m.session_id = ? AND m.id NOT IN (${placeholders})
        ORDER BY m.id DESC
        LIMIT 200
      `).all(...params) as Array<{
        message_id: number;
        embedding: Buffer;
        role: string;
        content: string;
        timestamp: string;
      }>;

      if (embeddings.length === 0) {
        return [];
      }

      // Calculate similarities
      const scored = embeddings.map(e => ({
        role: e.role,
        content: e.content,
        timestamp: e.timestamp,
        similarity: cosineSimilarity(queryEmbedding, deserializeEmbedding(e.embedding)),
      }));

      // Sort by similarity and take top N
      scored.sort((a, b) => b.similarity - a.similarity);
      const relevant = scored.slice(0, limit).filter(m => m.similarity > 0.3);

      if (relevant.length > 0) {
        console.log(`[Memory] Found ${relevant.length} relevant messages (top similarity: ${relevant[0].similarity.toFixed(3)})`);
      }

      return relevant;
    } catch (error) {
      console.error('[Memory] Semantic search failed:', error);
      return [];
    }
  }

  /**
   * Embed a message and store in message_embeddings table.
   * Called after saving a message to enable future semantic search.
   */
  async embedMessage(messageId: number): Promise<void> {
    if (!hasEmbeddings()) {
      return;
    }

    try {
      const message = this.db.prepare(`
        SELECT content FROM messages WHERE id = ?
      `).get(messageId) as { content: string } | undefined;

      if (!message) return;

      const embedding = await embed(message.content);
      const embeddingBuffer = serializeEmbedding(embedding);

      this.db.prepare(`
        INSERT OR REPLACE INTO message_embeddings (message_id, embedding)
        VALUES (?, ?)
      `).run(messageId, embeddingBuffer);
    } catch (error) {
      console.error(`[Memory] Failed to embed message ${messageId}:`, error);
    }
  }

  /**
   * Embed recent messages that don't have embeddings yet.
   * Called periodically to backfill embeddings.
   */
  async embedRecentMessages(sessionId: string = 'default', limit: number = 50): Promise<number> {
    if (!hasEmbeddings()) {
      return 0;
    }

    const unembeddedMessages = this.db.prepare(`
      SELECT m.id, m.content
      FROM messages m
      LEFT JOIN message_embeddings me ON m.id = me.message_id
      WHERE m.session_id = ? AND me.id IS NULL
      ORDER BY m.id DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<{ id: number; content: string }>;

    let embedded = 0;
    const batchSize = 5;
    for (let i = 0; i < unembeddedMessages.length; i += batchSize) {
      const batch = unembeddedMessages.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (msg) => {
        try {
          const embedding = await embed(msg.content);
          const embeddingBuffer = serializeEmbedding(embedding);

          this.db.prepare(`
            INSERT OR REPLACE INTO message_embeddings (message_id, embedding)
            VALUES (?, ?)
          `).run(msg.id, embeddingBuffer);

          return true;
        } catch (error) {
          console.error(`[Memory] Failed to embed message ${msg.id}:`, error);
          return false;
        }
      }));
      embedded += results.filter(Boolean).length;
    }

    if (embedded > 0) {
      console.log(`[Memory] Embedded ${embedded} messages for session ${sessionId}`);
    }

    return embedded;
  }

  private async getOrCreateSummary(beforeMessageId: number, sessionId: string = 'default'): Promise<string | undefined> {
    if (beforeMessageId <= 1) {
      return undefined;
    }

    const existingSummary = this.db.prepare(`
      SELECT content FROM summaries
      WHERE end_message_id = ? AND session_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(beforeMessageId - 1, sessionId) as { content: string } | undefined;

    if (existingSummary) {
      console.log(`[Memory] Retrieved existing summary for session ${sessionId}, messages up to ID ${beforeMessageId - 1}`);
      return existingSummary.content;
    }

    const messagesToSummarize = this.db.prepare(`
      SELECT id, role, content, timestamp
      FROM messages
      WHERE id < ? AND session_id = ?
      ORDER BY id ASC
    `).all(beforeMessageId, sessionId) as Message[];

    if (messagesToSummarize.length === 0) {
      return undefined;
    }

    const partialSummary = this.db.prepare(`
      SELECT id, end_message_id, content FROM summaries
      WHERE end_message_id < ? AND session_id = ?
      ORDER BY end_message_id DESC
      LIMIT 1
    `).get(beforeMessageId, sessionId) as { id: number; end_message_id: number; content: string } | undefined;

    let summary: string;
    let startId: number;

    if (partialSummary && this.summarizer) {
      const newMessages = messagesToSummarize.filter(m => m.id > partialSummary.end_message_id);
      if (newMessages.length === 0) {
        return partialSummary.content;
      }

      const combinedContent = [
        { role: 'system' as const, content: `Previous summary: ${partialSummary.content}` },
        ...newMessages,
      ];
      summary = await this.summarizer(combinedContent as Message[]);
      startId = 1;
    } else if (this.summarizer) {
      summary = await this.summarizer(messagesToSummarize);
      startId = messagesToSummarize[0].id;
    } else {
      summary = this.createBasicSummary(messagesToSummarize);
      startId = messagesToSummarize[0].id;
    }

    const endId = messagesToSummarize[messagesToSummarize.length - 1].id;
    console.log(`[Memory] Created new summary for session ${sessionId}, messages ${startId}-${endId} (${messagesToSummarize.length} messages, ${estimateTokens(summary)} tokens)`);
    this.db.prepare(`
      INSERT INTO summaries (start_message_id, end_message_id, content, token_count, session_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(startId, endId, summary, estimateTokens(summary), sessionId);

    // Clean up old summaries that are now superseded (keep only the 3 most recent per session)
    this.db.prepare(`
      DELETE FROM summaries WHERE session_id = ? AND id NOT IN (
        SELECT id FROM summaries WHERE session_id = ? ORDER BY end_message_id DESC LIMIT 3
      )
    `).run(sessionId, sessionId);

    return summary;
  }

  private createBasicSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user');
    const topics = new Set<string>();

    for (const msg of userMessages.slice(-20)) {
      const topic = msg.content.slice(0, 100).replace(/\n/g, ' ');
      topics.add(topic);
    }

    const topicList = Array.from(topics).slice(0, 10);
    return `Previous conversation (${messages.length} messages) covered:\n${topicList.map(t => `- ${t}...`).join('\n')}`;
  }

  // ============ FACT METHODS ============

  /**
   * Save a fact to long-term memory (with embedding)
   */
  saveFact(category: string, subject: string, content: string): number {
    const existing = this.db.prepare(`
      SELECT id FROM facts WHERE category = ? AND subject = ?
    `).get(category, subject) as { id: number } | undefined;

    let factId: number;

    if (existing) {
      this.db.prepare(`
        UPDATE facts SET content = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id = ?
      `).run(content, existing.id);
      factId = existing.id;
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO facts (category, subject, content)
        VALUES (?, ?, ?)
      `);
      const result = stmt.run(category, subject, content);
      factId = result.lastInsertRowid as number;
    }

    // Invalidate facts context cache
    this.factsContextCacheValid = false;

    // Embed the fact asynchronously
    if (hasEmbeddings()) {
      const fact: Fact = { id: factId, category, subject, content, created_at: '', updated_at: '' };
      this.embedFact(fact).catch(err => {
        console.error(`[Memory] Failed to embed fact ${factId}:`, err);
      });
    }

    return factId;
  }

  getAllFacts(): Fact[] {
    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      ORDER BY category, subject
    `);
    return stmt.all() as Fact[];
  }

  getFactsForContext(): string {
    // Return cached result if valid (avoids repeated DB queries on every message)
    if (this.factsContextCacheValid && this.factsContextCache !== null) {
      return this.factsContextCache;
    }

    const facts = this.getAllFacts();
    if (facts.length === 0) {
      this.factsContextCache = '';
      this.factsContextCacheValid = true;
      return '';
    }

    const byCategory = new Map<string, Fact[]>();
    for (const fact of facts) {
      const list = byCategory.get(fact.category) || [];
      list.push(fact);
      byCategory.set(fact.category, list);
    }

    const lines: string[] = ['## Known Facts'];
    for (const [category, categoryFacts] of byCategory) {
      lines.push(`\n### ${category}`);
      for (const fact of categoryFacts) {
        if (fact.subject) {
          lines.push(`- **${fact.subject}**: ${fact.content}`);
        } else {
          lines.push(`- ${fact.content}`);
        }
      }
    }

    const result = lines.join('\n');
    this.factsContextCache = result;
    this.factsContextCacheValid = true;
    return result;
  }

  deleteFact(id: number): boolean {
    // Chunks will be deleted by CASCADE
    const stmt = this.db.prepare('DELETE FROM facts WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.factsContextCacheValid = false; // Invalidate cache
    }
    return result.changes > 0;
  }

  deleteFactBySubject(category: string, subject: string): boolean {
    const stmt = this.db.prepare('DELETE FROM facts WHERE category = ? AND subject = ?');
    const result = stmt.run(category, subject);
    if (result.changes > 0) {
      this.factsContextCacheValid = false; // Invalidate cache
    }
    return result.changes > 0;
  }

  /**
   * Hybrid semantic + keyword search for facts
   */
  async searchFactsHybrid(query: string): Promise<SearchResult[]> {
    const results: Map<number, SearchResult> = new Map();

    // Determine weights based on whether embeddings are available
    const embeddingsAvailable = hasEmbeddings();
    const vectorWeight = embeddingsAvailable ? VECTOR_WEIGHT : 0;
    const keywordWeight = embeddingsAvailable ? KEYWORD_WEIGHT : 1.0; // 100% weight when no embeddings
    const scoreThreshold = embeddingsAvailable ? MIN_SCORE_THRESHOLD : 0.15; // Lower threshold for keyword-only

    // 1. Vector search (if embeddings available)
    if (embeddingsAvailable) {
      try {
        const queryEmbedding = await embed(query);

        // Limit chunks to prevent loading entire table into memory
        const chunks = this.db.prepare(`
          SELECT c.fact_id, c.embedding, f.id, f.category, f.subject, f.content, f.created_at, f.updated_at
          FROM chunks c
          JOIN facts f ON c.fact_id = f.id
          WHERE c.embedding IS NOT NULL
          ORDER BY c.created_at DESC
          LIMIT 500
        `).all() as Array<{
          fact_id: number;
          embedding: Buffer;
          id: number;
          category: string;
          subject: string;
          content: string;
          created_at: string;
          updated_at: string;
        }>;

        for (const chunk of chunks) {
          const chunkEmbedding = deserializeEmbedding(chunk.embedding);
          // Validate embedding before computing similarity
          if (!chunkEmbedding || chunkEmbedding.length === 0 || chunkEmbedding.length !== queryEmbedding.length) {
            continue; // Skip invalid embeddings
          }
          const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

          const fact: Fact = {
            id: chunk.id,
            category: chunk.category,
            subject: chunk.subject,
            content: chunk.content,
            created_at: chunk.created_at,
            updated_at: chunk.updated_at,
          };

          results.set(chunk.id, {
            fact,
            score: similarity * vectorWeight,
            vectorScore: similarity,
            keywordScore: 0,
          });
        }
      } catch (err) {
        console.error('[Memory] Vector search failed:', err);
      }
    }

    // 2. Keyword search using FTS5
    try {
      // Escape special FTS5 characters and create search query
      const escapedQuery = query.replace(/['"]/g, '').trim();
      if (escapedQuery) {
        const ftsResults = this.db.prepare(`
          SELECT f.id, f.category, f.subject, f.content, f.created_at, f.updated_at,
                 bm25(facts_fts) as rank
          FROM facts_fts
          JOIN facts f ON facts_fts.rowid = f.id
          WHERE facts_fts MATCH ?
          ORDER BY rank
          LIMIT 20
        `).all(`"${escapedQuery}" OR ${escapedQuery.split(/\s+/).join(' OR ')}`) as Array<Fact & { rank: number }>;

        // Normalize keyword scores (BM25 returns negative values, lower is better)
        const maxRank = Math.max(...ftsResults.map(r => Math.abs(r.rank)), 1);

        for (const ftsResult of ftsResults) {
          const normalizedScore = 1 - (Math.abs(ftsResult.rank) / maxRank);
          const existing = results.get(ftsResult.id);

          if (existing) {
            existing.keywordScore = normalizedScore;
            existing.score += normalizedScore * keywordWeight;
          } else {
            const fact: Fact = {
              id: ftsResult.id,
              category: ftsResult.category,
              subject: ftsResult.subject,
              content: ftsResult.content,
              created_at: ftsResult.created_at,
              updated_at: ftsResult.updated_at,
            };

            results.set(ftsResult.id, {
              fact,
              score: normalizedScore * keywordWeight,
              vectorScore: 0,
              keywordScore: normalizedScore,
            });
          }
        }
      }
    } catch (err) {
      console.error('[Memory] Keyword search failed:', err);
    }

    // 3. Sort by score and filter
    const sortedResults = Array.from(results.values())
      .filter(r => r.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEARCH_RESULTS);

    return sortedResults;
  }

  /**
   * Build FTS5 MATCH query from keywords (OR-based for broad recall).
   */
  private buildFtsQuery(query: string): string {
    return query.replace(/['"]/g, '').trim().split(/\s+/)
      .filter(k => k.length > 1)
      .join(' OR ');
  }

  /**
   * Search EVERYTHING in the database: messages, cron jobs, kanban tasks/projects,
   * tasks, daily logs, cron history. Uses FTS5 for speed with LIKE fallback.
   */
  searchEverything(query: string, limit = 8): {
    messages: Array<{ id: number; role: string; content: string; timestamp: string }>;
    cronJobs: Array<{ id: number; name: string; prompt: string; schedule: string | null; enabled: boolean; job_type: string | null }>;
    kanbanTasks: Array<{ id: number; title: string; description: string | null; status: string; project_name: string }>;
    kanbanProjects: Array<{ id: number; name: string; description: string | null; status: string }>;
    tasks: Array<{ id: number; title: string; description: string | null; status: string; due_date: string | null }>;
    dailyLogs: Array<{ id: number; date: string; content: string }>;
    cronHistory: Array<{ jobName: string; response: string; timestamp: string }>;
  } {
    const keywords = query.replace(/['"]/g, '').trim().split(/\s+/).filter(k => k.length > 1);
    if (keywords.length === 0) return { messages: [], cronJobs: [], kanbanTasks: [], kanbanProjects: [], tasks: [], dailyLogs: [], cronHistory: [] };

    const ftsQuery = this.buildFtsQuery(query);

    // LIKE fallback helpers (for tables without FTS or when FTS fails)
    const likeConditions = (cols: string[]) => {
      const parts = keywords.map(() => cols.map(c => `${c} LIKE ?`).join(' OR '));
      return `(${parts.join(' OR ')})`;
    };
    const likeParams = (colCount: number) => keywords.flatMap(kw => Array(colCount).fill(`%${kw}%`));

    // 1. Messages - FTS5 with BM25 ranking, LIKE fallback
    let messages: Array<{ id: number; role: string; content: string; timestamp: string }> = [];
    try {
      messages = this.db.prepare(`
        SELECT m.id, m.role, m.content, m.timestamp, bm25(messages_fts) as rank
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.id
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{ id: number; role: string; content: string; timestamp: string }>;
    } catch {
      // FTS failed, fall back to LIKE
      messages = this.db.prepare(`
        SELECT id, role, content, timestamp
        FROM messages
        WHERE ${likeConditions(['content'])}
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(...likeParams(1), limit) as Array<{ id: number; role: string; content: string; timestamp: string }>;
    }

    // 2. Cron jobs - FTS5 with LIKE fallback
    let cronJobs: Array<{ id: number; name: string; prompt: string; schedule: string | null; enabled: boolean; job_type: string | null }> = [];
    try {
      const raw = this.db.prepare(`
        SELECT c.id, c.name, c.prompt, c.schedule, c.enabled, c.job_type, bm25(cron_jobs_fts) as rank
        FROM cron_jobs_fts
        JOIN cron_jobs c ON cron_jobs_fts.rowid = c.id
        WHERE cron_jobs_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{ id: number; name: string; prompt: string; schedule: string | null; enabled: number; job_type: string | null }>;
      cronJobs = raw.map(c => ({ ...c, enabled: c.enabled === 1 }));
    } catch {
      const raw = this.db.prepare(`
        SELECT id, name, prompt, schedule, enabled, job_type
        FROM cron_jobs
        WHERE ${likeConditions(['name', 'prompt'])}
        ORDER BY id DESC
        LIMIT ?
      `).all(...likeParams(2), limit) as Array<{ id: number; name: string; prompt: string; schedule: string | null; enabled: number; job_type: string | null }>;
      cronJobs = raw.map(c => ({ ...c, enabled: c.enabled === 1 }));
    }

    // 3. Kanban tasks - FTS5 with LIKE fallback
    let kanbanTasks: Array<{ id: number; title: string; description: string | null; status: string; project_name: string }> = [];
    try {
      kanbanTasks = this.db.prepare(`
        SELECT kt.id, kt.title, kt.description, kt.status, kp.name as project_name, bm25(kanban_tasks_fts) as rank
        FROM kanban_tasks_fts
        JOIN kanban_tasks kt ON kanban_tasks_fts.rowid = kt.id
        JOIN kanban_projects kp ON kt.project_id = kp.id
        WHERE kanban_tasks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{ id: number; title: string; description: string | null; status: string; project_name: string }>;
    } catch {
      kanbanTasks = this.db.prepare(`
        SELECT kt.id, kt.title, kt.description, kt.status, kp.name as project_name
        FROM kanban_tasks kt
        JOIN kanban_projects kp ON kt.project_id = kp.id
        WHERE ${likeConditions(['kt.title', 'kt.description'])}
        ORDER BY kt.updated_at DESC
        LIMIT ?
      `).all(...likeParams(2), limit) as Array<{ id: number; title: string; description: string | null; status: string; project_name: string }>;
    }

    // 4. Kanban projects (LIKE only - small table, no FTS needed)
    const kanbanProjects = this.db.prepare(`
      SELECT id, name, description, status
      FROM kanban_projects
      WHERE ${likeConditions(['name', 'description'])}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...likeParams(2), limit) as Array<{ id: number; name: string; description: string | null; status: string }>;

    // 5. Tasks (LIKE only - small table)
    const tasks = this.db.prepare(`
      SELECT id, title, description, status, due_date
      FROM tasks
      WHERE ${likeConditions(['title', 'description'])}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...likeParams(2), limit) as Array<{ id: number; title: string; description: string | null; status: string; due_date: string | null }>;

    // 6. Daily logs (LIKE only)
    const dailyLogs = this.db.prepare(`
      SELECT id, date, content
      FROM daily_logs
      WHERE ${likeConditions(['content'])}
      ORDER BY date DESC
      LIMIT ?
    `).all(...likeParams(1), limit) as Array<{ id: number; date: string; content: string }>;

    // 7. Cron history
    let cronHistory: Array<{ jobName: string; response: string; timestamp: string }> = [];
    try {
      cronHistory = this.db.prepare(`
        SELECT job_name as jobName, response, timestamp
        FROM cron_history
        WHERE ${likeConditions(['job_name', 'response'])}
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(...likeParams(2), limit) as Array<{ jobName: string; response: string; timestamp: string }>;
    } catch {
      // cron_history table may not exist in all versions
    }

    return { messages, cronJobs, kanbanTasks, kanbanProjects, tasks, dailyLogs, cronHistory };
  }

  /**
   * Simple search (fallback, no embeddings)
   */
  searchFacts(query: string, category?: string): Fact[] {
    const searchPattern = `%${query}%`;

    if (category) {
      const stmt = this.db.prepare(`
        SELECT id, category, subject, content, created_at, updated_at
        FROM facts
        WHERE category = ? AND (content LIKE ? OR subject LIKE ?)
        ORDER BY updated_at DESC
      `);
      return stmt.all(category, searchPattern, searchPattern) as Fact[];
    }

    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      WHERE content LIKE ? OR subject LIKE ? OR category LIKE ?
      ORDER BY updated_at DESC
    `);
    return stmt.all(searchPattern, searchPattern, searchPattern) as Fact[];
  }

  getFactsByCategory(category: string): Fact[] {
    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      WHERE category = ?
      ORDER BY subject, updated_at DESC
    `);
    return stmt.all(category) as Fact[];
  }

  getFactCategories(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT category FROM facts ORDER BY category
    `);
    const rows = stmt.all() as { category: string }[];
    return rows.map(r => r.category);
  }

  // ============ CRON JOB METHODS ============

  saveCronJob(
    name: string,
    schedule: string,
    prompt: string,
    channel: string = 'default',
    sessionId: string = 'default'
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO cron_jobs (name, schedule, prompt, channel, session_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        schedule = excluded.schedule,
        prompt = excluded.prompt,
        channel = excluded.channel,
        session_id = excluded.session_id
    `);
    const result = stmt.run(name, schedule, prompt, channel, sessionId);
    return result.lastInsertRowid as number;
  }

  updateCronJobPrompt(name: string, prompt: string, sessionId?: string): boolean {
    const stmt = this.db.prepare(
      sessionId
        ? `UPDATE cron_jobs SET prompt = ?, session_id = ? WHERE name = ?`
        : `UPDATE cron_jobs SET prompt = ? WHERE name = ?`
    );
    const result = sessionId
      ? stmt.run(prompt, sessionId, name)
      : stmt.run(prompt, name);
    return result.changes > 0;
  }

  getCronJobs(enabledOnly: boolean = true): CronJob[] {
    const query = enabledOnly
      ? 'SELECT * FROM cron_jobs WHERE enabled = 1'
      : 'SELECT * FROM cron_jobs';
    const stmt = this.db.prepare(query);
    const rows = stmt.all() as Array<{
      id: number;
      name: string;
      schedule_type: string;
      schedule: string | null;
      run_at: string | null;
      interval_ms: number | null;
      prompt: string;
      channel: string;
      enabled: number;
      delete_after_run: number;
      context_messages: number;
      next_run_at: string | null;
      session_id: string | null;
      job_type: string | null;
    }>;
    return rows.map(r => ({
      ...r,
      enabled: r.enabled === 1,
      delete_after_run: r.delete_after_run === 1,
      job_type: (r.job_type || 'routine') as 'routine' | 'reminder',
    }));
  }

  setCronJobEnabled(name: string, enabled: boolean): boolean {
    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET enabled = ? WHERE name = ?
    `);
    const result = stmt.run(enabled ? 1 : 0, name);
    return result.changes > 0;
  }

  deleteCronJob(name: string): boolean {
    // Archive instead of delete - disable and mark with archived timestamp
    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET enabled = 0, next_run_at = NULL, updated_at = datetime('now')
      WHERE name = ?
    `);
    const result = stmt.run(name);
    return result.changes > 0;
  }

  // ============ UTILITY METHODS ============

  getStats(sessionId?: string): {
    messageCount: number;
    factCount: number;
    cronJobCount: number;
    summaryCount: number;
    estimatedTokens: number;
    embeddedFactCount: number;
    sessionCount?: number;
  } {
    let messages: { c: number; t: number };
    let summaries: { c: number };

    if (sessionId) {
      // Session-specific stats
      messages = this.db.prepare('SELECT COUNT(*) as c, SUM(token_count) as t FROM messages WHERE session_id = ?').get(sessionId) as { c: number; t: number };
      summaries = this.db.prepare('SELECT COUNT(*) as c FROM summaries WHERE session_id = ?').get(sessionId) as { c: number };
    } else {
      // Global stats
      messages = this.db.prepare('SELECT COUNT(*) as c, SUM(token_count) as t FROM messages').get() as { c: number; t: number };
      summaries = this.db.prepare('SELECT COUNT(*) as c FROM summaries').get() as { c: number };
    }

    const facts = this.db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number };
    const cronJobs = this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs').get() as { c: number };
    const embeddedFacts = this.db.prepare('SELECT COUNT(DISTINCT fact_id) as c FROM chunks WHERE embedding IS NOT NULL').get() as { c: number };
    const sessionCount = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number };

    return {
      messageCount: messages.c,
      factCount: facts.c,
      cronJobCount: cronJobs.c,
      summaryCount: summaries.c,
      estimatedTokens: messages.t || 0,
      embeddedFactCount: embeddedFacts.c,
      sessionCount: sessionCount.c,
    };
  }

  clearConversation(sessionId?: string): void {
    if (sessionId) {
      // Clear only the specified session
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM summaries WHERE session_id = ?').run(sessionId);
      // Clear SDK session so next message starts fresh
      this.clearSdkSessionId(sessionId);
    } else {
      // Clear all (legacy behavior)
      this.db.exec('DELETE FROM messages');
      this.db.exec('DELETE FROM summaries');
      this.db.exec('UPDATE sessions SET sdk_session_id = NULL');
    }
  }

  // ============ SDK SESSION PERSISTENCE ============

  /**
   * Get the SDK session ID for a given app session
   */
  getSdkSessionId(sessionId: string): string | null {
    const row = this.db.prepare('SELECT sdk_session_id FROM sessions WHERE id = ?').get(sessionId) as { sdk_session_id: string | null } | undefined;
    return row?.sdk_session_id ?? null;
  }

  /**
   * Store the SDK session ID for a given app session
   */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, sessionId);
  }

  /**
   * Clear the SDK session ID for a given app session (forces fresh start)
   */
  clearSdkSessionId(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET sdk_session_id = NULL WHERE id = ?').run(sessionId);
  }

  /**
   * Get facts as graph data for visualization
   * Returns nodes (facts) and links (connections between facts)
   */
  async getFactsGraphData(): Promise<GraphData> {
    const facts = this.getAllFacts();
    if (facts.length === 0) {
      return { nodes: [], links: [] };
    }

    // Category to group index mapping
    const categoryGroups: Record<string, number> = {
      user_info: 0,
      preferences: 1,
      projects: 2,
      people: 3,
      work: 4,
      notes: 5,
      decisions: 6,
    };

    // Create nodes
    const nodes: GraphNode[] = facts.map(fact => ({
      id: fact.id,
      subject: fact.subject || fact.content.slice(0, 30),
      category: fact.category,
      content: fact.content,
      group: categoryGroups[fact.category] ?? 7, // 7 = other
    }));

    const links: GraphLink[] = [];
    const linkSet = new Set<string>(); // Track unique links

    const addLink = (source: number, target: number, type: GraphLink['type'], strength: number) => {
      const key = `${Math.min(source, target)}-${Math.max(source, target)}-${type}`;
      if (!linkSet.has(key) && source !== target) {
        linkSet.add(key);
        links.push({ source, target, type, strength });
      }
    };

    // 1. Category connections - facts in same category
    const factsByCategory = new Map<string, Fact[]>();
    for (const fact of facts) {
      const list = factsByCategory.get(fact.category) || [];
      list.push(fact);
      factsByCategory.set(fact.category, list);
    }

    for (const categoryFacts of factsByCategory.values()) {
      // Connect each fact to up to 3 others in the same category
      for (let i = 0; i < categoryFacts.length; i++) {
        for (let j = i + 1; j < Math.min(i + 4, categoryFacts.length); j++) {
          addLink(categoryFacts[i].id, categoryFacts[j].id, 'category', 0.3);
        }
      }
    }

    // 2. Semantic connections (if embeddings available)
    // Limit to prevent O(N²) explosion with many facts
    const MAX_SEMANTIC_COMPARISONS = 200; // Max facts to compare for semantic links
    if (hasEmbeddings()) {
      try {
        // Get chunks with embeddings (limited for performance)
        const chunks = this.db.prepare(`
          SELECT c.fact_id, c.embedding
          FROM chunks c
          WHERE c.embedding IS NOT NULL
          ORDER BY c.created_at DESC
          LIMIT ?
        `).all(MAX_SEMANTIC_COMPARISONS) as Array<{ fact_id: number; embedding: Buffer }>;

        // Build fact ID to embedding map
        const factEmbeddings = new Map<number, number[]>();
        for (const chunk of chunks) {
          const emb = deserializeEmbedding(chunk.embedding);
          // Validate embedding
          if (emb && emb.length > 0) {
            factEmbeddings.set(chunk.fact_id, emb);
          }
        }

        // Compare each pair of facts with embeddings
        const factIds = Array.from(factEmbeddings.keys());
        let comparisons = 0;
        const MAX_COMPARISONS = 10000; // Cap total comparisons to prevent freeze

        outer: for (let i = 0; i < factIds.length; i++) {
          const embA = factEmbeddings.get(factIds[i])!;
          for (let j = i + 1; j < factIds.length; j++) {
            if (++comparisons > MAX_COMPARISONS) break outer;

            const embB = factEmbeddings.get(factIds[j])!;
            // Validate lengths match
            if (embA.length !== embB.length) continue;

            const similarity = cosineSimilarity(embA, embB);

            // Only link if similarity is strong enough (above 0.5)
            if (similarity >= 0.5) {
              addLink(factIds[i], factIds[j], 'semantic', similarity);
            }
          }
        }
      } catch (err) {
        console.error('[Memory] Failed to compute semantic links:', err);
      }
    }

    // 3. Keyword connections
    // Extract significant words from each fact
    // Limit facts processed for keyword matching to prevent O(N²M) explosion
    const MAX_KEYWORD_FACTS = 300;
    const COMMON_WORDS = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
      'our', 'out', 'has', 'have', 'been', 'this', 'that', 'they', 'from', 'with', 'will',
      'what', 'when', 'where', 'which', 'their', 'about', 'would', 'there', 'could', 'other',
      'into', 'than', 'then', 'them', 'these', 'some', 'like', 'just', 'only', 'over', 'such',
      'make', 'made', 'also', 'most', 'very', 'does', 'being', 'those', 'after', 'before',
    ]);

    const extractKeywords = (text: string): Set<string> => {
      const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      return new Set(words.filter(w => !COMMON_WORDS.has(w)));
    };

    // Only process limited facts for keyword matching
    const factsToProcess = facts.slice(0, MAX_KEYWORD_FACTS);
    const factKeywords = new Map<number, Set<string>>();
    for (const fact of factsToProcess) {
      const keywords = extractKeywords(`${fact.subject} ${fact.content}`);
      factKeywords.set(fact.id, keywords);
    }

    // Find keyword overlaps between facts
    const factIds = Array.from(factKeywords.keys());
    let keywordComparisons = 0;
    const MAX_KEYWORD_COMPARISONS = 15000; // Cap total comparisons

    outer: for (let i = 0; i < factIds.length; i++) {
      const kwA = factKeywords.get(factIds[i])!;
      if (kwA.size === 0) continue;

      for (let j = i + 1; j < factIds.length; j++) {
        if (++keywordComparisons > MAX_KEYWORD_COMPARISONS) break outer;

        const kwB = factKeywords.get(factIds[j])!;
        if (kwB.size === 0) continue;

        // Count shared keywords
        let shared = 0;
        for (const kw of kwA) {
          if (kwB.has(kw)) shared++;
        }

        // Link if at least 2 shared keywords
        if (shared >= 2) {
          const strength = Math.min(1, shared / 5); // Max strength at 5 shared words
          addLink(factIds[i], factIds[j], 'keyword', strength);
        }
      }
    }

    return { nodes, links };
  }

  // ============ SOUL METHODS ============

  /**
   * Set or update a soul aspect
   */
  setSoulAspect(aspect: string, content: string): number {
    const existing = this.db.prepare(`
      SELECT id FROM soul WHERE aspect = ?
    `).get(aspect) as { id: number } | undefined;

    let aspectId: number;

    if (existing) {
      this.db.prepare(`
        UPDATE soul SET content = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id = ?
      `).run(content, existing.id);
      aspectId = existing.id;
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO soul (aspect, content)
        VALUES (?, ?)
      `);
      const result = stmt.run(aspect, content);
      aspectId = result.lastInsertRowid as number;
    }

    // Invalidate soul context cache
    this.soulContextCacheValid = false;

    return aspectId;
  }

  /**
   * Get a specific soul aspect
   */
  getSoulAspect(aspect: string): SoulAspect | null {
    const row = this.db.prepare(`
      SELECT id, aspect, content, created_at, updated_at
      FROM soul
      WHERE aspect = ?
    `).get(aspect) as SoulAspect | undefined;

    return row || null;
  }

  /**
   * Get all soul aspects
   */
  getAllSoulAspects(): SoulAspect[] {
    const stmt = this.db.prepare(`
      SELECT id, aspect, content, created_at, updated_at
      FROM soul
      ORDER BY aspect
    `);
    return stmt.all() as SoulAspect[];
  }

  /**
   * Delete a soul aspect
   */
  deleteSoulAspect(aspect: string): boolean {
    const stmt = this.db.prepare('DELETE FROM soul WHERE aspect = ?');
    const result = stmt.run(aspect);
    if (result.changes > 0) {
      this.soulContextCacheValid = false; // Invalidate cache
    }
    return result.changes > 0;
  }

  /**
   * Delete a soul aspect by ID
   */
  deleteSoulAspectById(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM soul WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.soulContextCacheValid = false; // Invalidate cache
    }
    return result.changes > 0;
  }

  /**
   * Get soul aspects formatted for context injection
   */
  getSoulContext(): string {
    // Return cached result if valid
    if (this.soulContextCacheValid && this.soulContextCache !== null) {
      return this.soulContextCache;
    }

    const aspects = this.getAllSoulAspects();
    if (aspects.length === 0) {
      this.soulContextCache = '';
      this.soulContextCacheValid = true;
      return '';
    }

    const lines: string[] = ['## Working Preferences'];
    for (const aspect of aspects) {
      lines.push(`\n### ${aspect.aspect}`);
      lines.push(aspect.content);
    }

    const result = lines.join('\n');
    this.soulContextCache = result;
    this.soulContextCacheValid = true;
    return result;
  }

  close(): void {
    this.db.close();
  }
}

export { MemoryManager as MemoryStore };

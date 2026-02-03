/**
 * Unanswered Command Center Engine
 *
 * Scans Gmail for threads needing a response, tracks them in SQLite,
 * and supports resolve/dismiss workflows via UI, Telegram, and rules.
 *
 * Detection is purely deterministic — uses computeThreadState() from
 * rules-engine.ts. No AI/GLM involved in unanswered detection.
 */

import Database from 'better-sqlite3';
import { SettingsManager } from '../settings';
import { readEmails, getThread } from '../tools/gog-wrapper';
import { computeThreadState, type ThreadMessage, type ThreadState } from './rules-engine';

// ============================================================================
// Types
// ============================================================================

export interface UnansweredThread {
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

export interface ScanResult {
  account: string;
  threadsScanned: number;
  newUnanswered: number;
  autoResolved: number;
  errors: number;
  durationMs: number;
}

export interface UnansweredFilter {
  labels?: string[];
  ageMinutesGt?: number;
  state?: string;
  limit?: number;
  offset?: number;
}

interface ThreadData {
  messages?: Array<{ id?: string; from?: string; labelIds?: string[] }>;
}

interface EmailSearchResult {
  threadId?: string;
  id?: string;
  subject?: string;
  from?: string;
  snippet?: string;
  labelIds?: string[];
}

// ============================================================================
// Singleton access for Telegram command
// ============================================================================

let singletonInstance: UnansweredEngine | null = null;

function setSingletonInstance(instance: UnansweredEngine): void {
  singletonInstance = instance;
}

export function getUnansweredEngine(): UnansweredEngine | null {
  return singletonInstance;
}

// ============================================================================
// UnansweredEngine Class
// ============================================================================

export class UnansweredEngine {
  private db: Database.Database;
  private telegramSender: ((text: string) => void) | null = null;
  private notifyHandler: ((title: string, body: string) => void) | null = null;
  private scanIntervalId: ReturnType<typeof setInterval> | null = null;
  private digestThrottleMap: Map<string, number> = new Map();
  private scanning = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.createTables();
    setSingletonInstance(this);
  }

  // ---------- DI ----------

  setTelegramSender(fn: (text: string) => void): void {
    this.telegramSender = fn;
  }

  setNotificationHandler(fn: (title: string, body: string) => void): void {
    this.notifyHandler = fn;
  }

  // ---------- Schema ----------

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS unanswered_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        subject TEXT,
        sender TEXT,
        label TEXT,
        state TEXT NOT NULL DEFAULT 'unanswered',
        first_seen_at TEXT DEFAULT (datetime('now')),
        last_scanned_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT,
        dismissed_at TEXT,
        UNIQUE(account, thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_us_state ON unanswered_state(state);
      CREATE INDEX IF NOT EXISTS idx_us_account_state ON unanswered_state(account, state);
      CREATE INDEX IF NOT EXISTS idx_us_first_seen ON unanswered_state(first_seen_at);
    `);
  }

  // ---------- Scan ----------

  async scan(account: string): Promise<ScanResult> {
    if (this.scanning) {
      console.log('[UnansweredEngine] Scan already in progress, skipping');
      return { account, threadsScanned: 0, newUnanswered: 0, autoResolved: 0, errors: 0, durationMs: 0 };
    }

    this.scanning = true;
    const startMs = Date.now();
    let threadsScanned = 0;
    let newUnanswered = 0;
    let autoResolved = 0;
    let errors = 0;

    try {
      const lookbackDays = SettingsManager.get('gmail.unanswered.lookbackDays') || '30';
      const labelsRaw = SettingsManager.get('gmail.unanswered.labels') || '[]';
      const userEmail = SettingsManager.get('gmail.userEmail') || account || '';
      const maxThreads = Number(SettingsManager.get('gmail.unanswered.maxThreadsPerScan') || '200');

      if (!userEmail) {
        console.warn('[UnansweredEngine] gmail.userEmail not configured and no account provided');
        return { account, threadsScanned: 0, newUnanswered: 0, autoResolved: 0, errors: 1, durationMs: Date.now() - startMs };
      }

      let labels: string[] = [];
      try { labels = JSON.parse(labelsRaw) as string[]; } catch { /* empty */ }

      // Build Gmail query
      let query = `newer_than:${lookbackDays}d NOT from:${userEmail}`;
      if (labels.length > 0) {
        const labelFilter = labels.map(l => `label:${l}`).join(' OR ');
        query += ` (${labelFilter})`;
      }

      const searchRes = await readEmails({ query, max: maxThreads, account });
      if (!searchRes.success || !searchRes.emails) {
        console.warn('[UnansweredEngine] readEmails failed:', searchRes.error);
        return { account, threadsScanned: 0, newUnanswered: 0, autoResolved: 0, errors: 1, durationMs: Date.now() - startMs };
      }

      let emails: EmailSearchResult[] = [];
      try {
        const parsed = JSON.parse(searchRes.emails);
        emails = Array.isArray(parsed) ? parsed : (parsed?.messages || []);
      } catch { /* empty */ }

      // Deduplicate by threadId
      const threadMap = new Map<string, EmailSearchResult>();
      for (const e of emails) {
        if (e.threadId && !threadMap.has(e.threadId)) {
          threadMap.set(e.threadId, e);
        }
      }

      // Process threads with concurrency cap
      const threadEntries = [...threadMap.entries()];
      const CONCURRENCY = 3;

      for (let i = 0; i < threadEntries.length; i += CONCURRENCY) {
        const batch = threadEntries.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(([threadId, emailData]) =>
            this.processThread(threadId, account, userEmail, emailData),
          ),
        );

        for (const result of results) {
          threadsScanned++;
          if (result.status === 'rejected') {
            errors++;
            continue;
          }
          const outcome = result.value;
          if (outcome === 'new_unanswered') newUnanswered++;
          else if (outcome === 'auto_resolved') autoResolved++;
        }
      }

      // Warn if many errors
      if (errors > 0 && errors > threadEntries.length / 2 && this.notifyHandler) {
        this.notifyHandler('Unanswered Scan', `Scan partially failed (${errors}/${threadEntries.length} threads). Will retry next interval.`);
      }
    } finally {
      this.scanning = false;
    }

    const durationMs = Date.now() - startMs;
    console.log(`[UnansweredEngine] Scan complete: ${threadsScanned} scanned, ${newUnanswered} new unanswered, ${autoResolved} auto-resolved, ${errors} errors (${durationMs}ms)`);
    return { account, threadsScanned, newUnanswered, autoResolved, errors, durationMs };
  }

  async scanAll(): Promise<ScanResult[]> {
    const accountsRaw = SettingsManager.get('gmail.emailProcessing.accounts') || '[]';
    let accounts: string[] = [];
    try { accounts = JSON.parse(accountsRaw) as string[]; } catch { /* empty */ }
    if (accounts.length === 0) return [];

    const results: ScanResult[] = [];
    for (const account of accounts) {
      results.push(await this.scan(account));
    }
    return results;
  }

  private async processThread(
    threadId: string,
    account: string,
    userEmail: string,
    emailData: EmailSearchResult,
  ): Promise<'new_unanswered' | 'auto_resolved' | 'still_unanswered' | 'not_unanswered' | 'dismissed_sticky'> {
    // Check thread_state_cache first (30-min TTL)
    const cached = this.db.prepare(
      "SELECT thread_state FROM thread_state_cache WHERE thread_id = ? AND account = ? AND fetched_at > datetime('now', '-30 minutes')",
    ).get(threadId, account) as { thread_state: string } | undefined;

    let threadState: ThreadState | null = null;
    let lastInboundMessageId: string | null = null;

    if (cached) {
      threadState = cached.thread_state as ThreadState;
    } else {
      // Fetch from Gmail
      const res = await getThread({ threadId, account });
      if (!res.success || !res.thread) {
        throw new Error(`Failed to fetch thread ${threadId}: ${res.error}`);
      }

      let threadRaw: Record<string, unknown> = {};
      try { threadRaw = JSON.parse(res.thread) as Record<string, unknown>; } catch { /* empty */ }
      // gog wraps response: { thread: { messages: [...] } }
      const threadData = (threadRaw.thread || threadRaw) as ThreadData;
      const rawMsgs = threadData.messages || [];
      // Extract 'from' from payload.headers (gog doesn't put it directly on message)
      const extractFrom = (m: Record<string, unknown>): string => {
        const payload = m.payload as Record<string, unknown> | undefined;
        const headers = (payload?.headers || []) as Array<{ name: string; value: string }>;
        const fromHeader = headers.find(h => h.name === 'From');
        return fromHeader?.value || (m.from as string) || '';
      };
      const msgs: ThreadMessage[] = rawMsgs.map(m => ({
        from: extractFrom(m as Record<string, unknown>),
        labelIds: m.labelIds,
      }));

      if (msgs.length === 0) return 'not_unanswered';

      threadState = computeThreadState(msgs, userEmail);

      // Find last inbound message ID
      const inboundMsgs = rawMsgs.filter(
        m => !extractFrom(m as Record<string, unknown>).toLowerCase().includes(userEmail.toLowerCase()),
      );
      if (inboundMsgs.length > 0) {
        lastInboundMessageId = inboundMsgs[inboundMsgs.length - 1].id || null;
      }

      // Update thread_state_cache
      this.db.prepare(`
        INSERT INTO thread_state_cache (thread_id, account, thread_state, message_count, fetched_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(thread_id, account) DO UPDATE SET
          thread_state = excluded.thread_state,
          message_count = excluded.message_count,
          fetched_at = excluded.fetched_at
      `).run(threadId, account, threadState, (threadData.messages || []).length);
    }

    // Determine if unanswered
    const isUnanswered = threadState === 'unreplied' || threadState === 'unread' || threadState === 'replied_with_answer';

    // Look up label from email_processing_state
    const epRow = this.db.prepare(
      'SELECT corrected_label, label_applied FROM email_processing_state WHERE thread_id = ? AND account = ? ORDER BY processed_at DESC LIMIT 1',
    ).get(threadId, account) as { corrected_label: string | null; label_applied: string | null } | undefined;
    const label = epRow?.corrected_label || epRow?.label_applied || emailData.labelIds?.[0] || null;

    // Check existing row
    const existing = this.db.prepare(
      'SELECT * FROM unanswered_state WHERE thread_id = ? AND account = ?',
    ).get(threadId, account) as UnansweredThread | undefined;

    const messageId = lastInboundMessageId || emailData.id || null;

    if (!existing) {
      // New thread
      if (isUnanswered) {
        this.db.prepare(`
          INSERT INTO unanswered_state (account, thread_id, message_id, subject, sender, label, state)
          VALUES (?, ?, ?, ?, ?, ?, 'unanswered')
        `).run(account, threadId, messageId, emailData.subject || null, emailData.from || null, label);
        return 'new_unanswered';
      }
      return 'not_unanswered';
    }

    // Existing row
    if (existing.state === 'unanswered') {
      if (!isUnanswered) {
        // Auto-resolve: user replied
        this.db.prepare(
          "UPDATE unanswered_state SET state = 'resolved', resolved_at = datetime('now'), last_scanned_at = datetime('now') WHERE id = ?",
        ).run(existing.id);
        return 'auto_resolved';
      }
      // Still unanswered — update scan time
      this.db.prepare(
        "UPDATE unanswered_state SET last_scanned_at = datetime('now'), message_id = ?, subject = COALESCE(?, subject), sender = COALESCE(?, sender), label = COALESCE(?, label) WHERE id = ?",
      ).run(messageId, emailData.subject, emailData.from, label, existing.id);
      return 'still_unanswered';
    }

    if (existing.state === 'dismissed' || existing.state === 'resolved') {
      // Re-open only if new inbound message
      if (isUnanswered && messageId && messageId !== existing.message_id) {
        this.db.prepare(
          "UPDATE unanswered_state SET state = 'unanswered', message_id = ?, dismissed_at = NULL, resolved_at = NULL, last_scanned_at = datetime('now'), subject = COALESCE(?, subject), sender = COALESCE(?, sender), label = COALESCE(?, label) WHERE id = ?",
        ).run(messageId, emailData.subject, emailData.from, label, existing.id);
        return 'new_unanswered';
      }
      return 'dismissed_sticky';
    }

    return 'not_unanswered';
  }

  // ---------- Query ----------

  list(filter?: UnansweredFilter): UnansweredThread[] {
    const { where, params } = this.buildWhereClause(filter);
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    return this.db.prepare(
      `SELECT * FROM unanswered_state ${where} ORDER BY first_seen_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as UnansweredThread[];
  }

  count(filter?: UnansweredFilter): number {
    const { where, params } = this.buildWhereClause(filter);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM unanswered_state ${where}`,
    ).get(...params) as { cnt: number };
    return row.cnt;
  }

  getByThreadId(account: string, threadId: string): UnansweredThread | null {
    return (this.db.prepare(
      'SELECT * FROM unanswered_state WHERE account = ? AND thread_id = ?',
    ).get(account, threadId) as UnansweredThread) ?? null;
  }

  private buildWhereClause(filter?: UnansweredFilter): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const state = filter?.state ?? 'unanswered';
    if (state) {
      clauses.push('state = ?');
      params.push(state);
    }

    if (filter?.labels && filter.labels.length > 0) {
      const placeholders = filter.labels.map(() => '?').join(', ');
      clauses.push(`label IN (${placeholders})`);
      params.push(...filter.labels);
    }

    if (filter?.ageMinutesGt !== undefined) {
      clauses.push("first_seen_at < datetime('now', '-' || ? || ' minutes')");
      params.push(filter.ageMinutesGt);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return { where, params };
  }

  // ---------- Actions ----------

  resolve(account: string, threadId: string): void {
    this.db.prepare(
      "UPDATE unanswered_state SET state = 'resolved', resolved_at = datetime('now') WHERE account = ? AND thread_id = ? AND state = 'unanswered'",
    ).run(account, threadId);
  }

  resolveAll(filter?: UnansweredFilter): number {
    const safeFilter = { ...filter, state: 'unanswered' };
    const { where, params } = this.buildWhereClause(safeFilter);
    const result = this.db.prepare(
      `UPDATE unanswered_state SET state = 'resolved', resolved_at = datetime('now') ${where.replace('WHERE', 'WHERE state = state AND')}`,
    ).run(...params);
    // Simpler approach: use the filter to count, then update
    return result.changes;
  }

  dismiss(account: string, threadId: string): void {
    this.db.prepare(
      "UPDATE unanswered_state SET state = 'dismissed', dismissed_at = datetime('now') WHERE account = ? AND thread_id = ? AND state = 'unanswered'",
    ).run(account, threadId);
  }

  dismissAll(filter?: UnansweredFilter): number {
    const safeFilter = { ...filter, state: 'unanswered' };
    const { where, params } = this.buildWhereClause(safeFilter);
    const result = this.db.prepare(
      `UPDATE unanswered_state SET state = 'dismissed', dismissed_at = datetime('now') ${where.replace('WHERE', 'WHERE state = state AND')}`,
    ).run(...params);
    return result.changes;
  }

  // ---------- Digest ----------

  async sendDigest(
    account: string,
    filter?: UnansweredFilter,
  ): Promise<{ sent: boolean; threadCount: number; throttled: boolean }> {
    // Throttle check
    const throttleHours = Number(SettingsManager.get('gmail.unanswered.digestThrottleHours') || '4');
    const lastDigest = this.digestThrottleMap.get(account) || 0;
    if (Date.now() - lastDigest < throttleHours * 3600000) {
      return { sent: false, threadCount: 0, throttled: true };
    }

    const threads = this.list({ ...filter, state: 'unanswered' });
    if (threads.length === 0) {
      return { sent: false, threadCount: 0, throttled: false };
    }

    const lines = threads.slice(0, 20).map((t, i) =>
      `${i + 1}. ${t.subject || '(no subject)'}\n   From: ${t.sender || 'unknown'} | ${t.label || '-'} | Since: ${t.first_seen_at}`,
    );
    const suffix = threads.length > 20 ? `\n\n... and ${threads.length - 20} more` : '';
    const text = `Unanswered Threads (${threads.length}):\n\n${lines.join('\n\n')}${suffix}`;

    if (this.telegramSender) {
      this.telegramSender(text);
    }
    if (this.notifyHandler) {
      this.notifyHandler('Unanswered Threads', `${threads.length} thread(s) need attention`);
    }

    this.digestThrottleMap.set(account, Date.now());
    return { sent: true, threadCount: threads.length, throttled: false };
  }

  // ---------- Scheduler ----------

  startSchedule(intervalMinutes: number): void {
    this.stopSchedule();
    console.log(`[UnansweredEngine] Starting scheduled scan every ${intervalMinutes} min`);
    this.scanIntervalId = setInterval(async () => {
      try {
        await this.scanAll();
      } catch (err) {
        console.warn('[UnansweredEngine] Scheduled scan failed:', err);
      }
    }, intervalMinutes * 60000);
  }

  stopSchedule(): void {
    if (this.scanIntervalId) {
      clearInterval(this.scanIntervalId);
      this.scanIntervalId = null;
    }
  }
}

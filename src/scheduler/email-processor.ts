/**
 * Email Processing Service
 *
 * GLM-4.7 Flash reads full email bodies, classifies them into user's Gmail labels
 * using few-shot examples, applies labels, and notifies on important emails.
 *
 * Reliability features (Codex v2):
 * - Checkpoint-based tracking (survives offline/restart)
 * - AI/Processed marker label (idempotent across crashes)
 * - Concurrency-limited Gmail + GLM calls
 * - Exponential backoff retry on transient errors
 * - Strict GLM output validation with AI/Review fallback
 */

import Database from 'better-sqlite3';
import { SettingsManager } from '../settings';
import {
  readEmails, getMessage, listLabels, modifyLabels, createLabel,
} from '../tools/gog-wrapper';
import { glmFlash } from '../tools/glm-client';
import { logEvent } from '../memory/event-log';

// ============================================================================
// Types
// ============================================================================

type Confidence = 'high' | 'medium' | 'low' | 'invalid';

type FailReason = 'empty_content' | 'json_parse_fail' | 'label_mismatch' | 'missing_msgid' | 'batch_429' | 'batch_error' | null;

type LabelConfig = Record<string, {
  notify?: boolean;
  description?: string;   // legacy, kept for backward compat
  definition?: string;     // replaces description
  negative?: string;       // negative guidance text
  examples?: Array<string | { messageId: string; subject?: string; from?: string }>;
  removeFromInbox?: boolean;        // archive thread from inbox after filing
  markReadOnFile?: boolean;         // mark thread as read after filing
  keepInInboxOnUncertain?: boolean; // keep in inbox when confidence is low/invalid (default true)
}>;

interface EmailListItem {
  id: string;
  threadId?: string;
  internalDate?: string | number;
  date?: string;
  subject?: string;
  from?: string;
}

interface FullEmail {
  id: string;
  threadId?: string;
  internalDateMs: number;
  from: string;
  subject: string;
  body: string;
}

interface ClassificationResult {
  messageId: string;
  threadId?: string;
  label: string;
  confidence: Confidence;
  subject?: string;
  from?: string;
  failReason?: FailReason;
  glmRaw?: string;
}

interface ProcessingRunStats {
  emailsFetched: number;
  emailsClassified: number;
  emailsSkipped: number;
  labelsApplied: Record<string, number>;
  glmCalls: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Unwrap gog JSON responses: gog wraps arrays in objects like { "labels": [...] } or { "messages": [...] } */
function unwrapGogArray(raw: string, key: string): unknown[] {
  const parsed = safeJsonParse<unknown>(raw, []);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && key in (parsed as Record<string, unknown>)) {
    return (parsed as Record<string, unknown>)[key] as unknown[];
  }
  return [];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('rate') ||
    msg.includes('429') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('temporar')
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > maxRetries || !isTransientError(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[EmailProcessor] Retry ${attempt}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const current = idx;
      idx += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current]);
    }
  });

  await Promise.all(workers);
  return results;
}

function toInternalDateMs(item: EmailListItem): number {
  const raw = item.internalDate ?? item.date;
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  const n = Number(raw);
  if (!Number.isNaN(n) && n > 0) return n;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

// ============================================================================
// Email Parsing
// ============================================================================

function adaptFullEmail(msgRes: { success: boolean; message?: string }): FullEmail | null {
  if (!msgRes.success || !msgRes.message) return null;

  const raw = safeJsonParse<Record<string, unknown>>(msgRes.message, {});

  // gog getMessage returns: { headers: { from, subject, date }, message: { id, threadId, internalDate, snippet }, body: "..." }
  const headers = (raw.headers || {}) as Record<string, unknown>;
  const msg = (raw.message || {}) as Record<string, unknown>;

  const id = String(msg.id || raw.id || raw.messageId || '');
  const threadId = String(msg.threadId || raw.threadId || '') || undefined;

  let internalDateMs = 0;
  const iDate = msg.internalDate ?? raw.internalDate ?? headers.date ?? raw.date;
  if (iDate) {
    const n = Number(iDate);
    if (!Number.isNaN(n) && n > 0) {
      internalDateMs = n;
    } else {
      const t = new Date(String(iDate)).getTime();
      if (Number.isFinite(t)) internalDateMs = t;
    }
  }

  const from = String(headers.from || raw.from || '');
  const subject = String(headers.subject || raw.subject || '');
  // Prefer snippet for classification (clean text), fall back to full body
  const snippet = String(msg.snippet || '');
  const body = snippet || String(raw.body || '').slice(0, 2000);

  return { id, threadId, internalDateMs, from, subject, body };
}

// ============================================================================
// GLM Prompt Building
// ============================================================================

function buildLabelList(
  allLabels: unknown[],
  labelConfig: LabelConfig,
): { name: string; definition: string; negative: string }[] {
  const items: { name: string; definition: string; negative: string }[] = [];
  for (const l of allLabels) {
    const lObj = l as Record<string, unknown>;
    const name = String(lObj.name || lObj.label || l || '').trim();
    if (!name) continue;
    // Skip system labels (gog returns type: "system" for Gmail built-ins)
    if (lObj.type === 'system') continue;
    const cfg = labelConfig[name];
    items.push({
      name,
      definition: cfg?.definition || cfg?.description || '',
      negative: cfg?.negative || '',
    });
  }
  return items;
}

function buildGlmPrompt(
  allowed: { name: string; definition: string; negative: string }[],
  examplesByLabel: Record<string, FullEmail[]>,
  batch: FullEmail[],
  reviewLabel: string,
): string {
  const lines: string[] = [];

  lines.push('You are an email classifier. Classify each email into exactly ONE label from the list below.');
  lines.push('');
  lines.push('RULES:');
  lines.push('- Output JSON only, no extra text.');
  lines.push('- The "label" must exactly match one of the AVAILABLE LABELS.');
  lines.push('- Use the messageId provided for each email.');
  lines.push(`- If unsure, set confidence to "low" and label to "${reviewLabel}".`);
  lines.push('- Negative guidance takes priority. If an email matches a label\'s negative guidance, do NOT assign that label.');
  lines.push('');
  lines.push('AVAILABLE LABELS:');
  lines.push('');
  for (const l of allowed) {
    lines.push(`## ${l.name}`);
    if (l.definition) lines.push(`Definition: ${l.definition}`);
    if (l.negative) lines.push(`NOT this label: ${l.negative}`);
    lines.push('');
  }

  const exampleLabels = Object.keys(examplesByLabel);
  if (exampleLabels.length > 0) {
    lines.push('EXAMPLES:');
    for (const label of exampleLabels) {
      for (const ex of examplesByLabel[label] || []) {
        lines.push(`--- Label: ${label} ---`);
        lines.push(`From: ${ex.from} | Subject: ${ex.subject}`);
        lines.push(`Body: ${ex.body.slice(0, 500)}`);
        lines.push('');
      }
    }
  }

  lines.push('CLASSIFY THESE EMAILS:');
  lines.push('');
  for (const e of batch) {
    lines.push(`[messageId: ${e.id}] From: ${e.from} | Subject: ${e.subject}`);
    lines.push(`Body: ${e.body}`);
    lines.push('');
  }

  lines.push('Respond with JSON array only:');
  lines.push('[{"messageId":"...","label":"...","confidence":"high|medium|low"}]');

  return lines.join('\n');
}

function validateGlmResponse(
  raw: string,
  batch: FullEmail[],
  allowedLabels: Set<string>,
  reviewLabel: string,
): ClassificationResult[] {
  const glmRaw = (raw || '').slice(0, 2000);

  // Empty content
  if (!raw || !raw.trim()) {
    return batch.map((e) => ({
      messageId: e.id,
      threadId: e.threadId,
      label: reviewLabel,
      confidence: 'invalid' as Confidence,
      subject: e.subject,
      from: e.from,
      failReason: 'empty_content' as FailReason,
      glmRaw,
    }));
  }

  // Try to extract JSON from response (GLM may wrap in ```json blocks)
  let jsonStr = raw.trim();
  const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  const parsed = safeJsonParse<unknown[]>(jsonStr, []);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    // Complete parse failure — everything goes to review
    return batch.map((e) => ({
      messageId: e.id,
      threadId: e.threadId,
      label: reviewLabel,
      confidence: 'invalid' as Confidence,
      subject: e.subject,
      from: e.from,
      failReason: 'json_parse_fail' as FailReason,
      glmRaw,
    }));
  }

  const batchIds = new Set(batch.map((b) => b.id));
  const out: ClassificationResult[] = [];

  for (const item of parsed) {
    const obj = item as Record<string, unknown>;
    const messageId = String(obj?.messageId || '');
    const label = String(obj?.label || '');
    const conf = String(obj?.confidence || 'low');
    const confidence = (['high', 'medium', 'low'].includes(conf) ? conf : 'invalid') as Confidence;

    if (!batchIds.has(messageId)) continue;

    const email = batch.find((b) => b.id === messageId);
    if (!allowedLabels.has(label)) {
      out.push({ messageId, threadId: email?.threadId, label: reviewLabel, confidence: 'invalid', subject: email?.subject, from: email?.from, failReason: 'label_mismatch', glmRaw });
    } else {
      out.push({ messageId, threadId: email?.threadId, label, confidence, subject: email?.subject, from: email?.from, failReason: null, glmRaw });
    }
  }

  // Ensure every email in batch is covered
  const covered = new Set(out.map((o) => o.messageId));
  for (const e of batch) {
    if (!covered.has(e.id)) {
      out.push({ messageId: e.id, threadId: e.threadId, label: reviewLabel, confidence: 'invalid', subject: e.subject, from: e.from, failReason: 'missing_msgid', glmRaw });
    }
  }

  return out;
}

// ============================================================================
// Routing (archive / mark-read) per label config
// ============================================================================

export async function applyRouting(
  threadId: string | undefined,
  account: string,
  labelName: string,
  confidence: string,
  labelConfig: LabelConfig,
): Promise<boolean> {
  if (!threadId) return false;
  const cfg = labelConfig[labelName];
  if (!cfg?.removeFromInbox && !cfg?.markReadOnFile) return false;

  const isUncertain = confidence === 'low' || confidence === 'invalid';
  if (isUncertain && cfg.keepInInboxOnUncertain !== false) return false;

  const toRemove: string[] = [];
  if (cfg.removeFromInbox) toRemove.push('INBOX');
  if (cfg.markReadOnFile) toRemove.push('UNREAD');

  try {
    await withRetry(() => modifyLabels({
      threadIds: [threadId],
      remove: toRemove.join(','),
      account,
    }));
    return true;
  } catch (err) {
    console.warn(`[EmailProcessor] Routing failed for ${labelName}:`, err);
    return false;
  }
}

// ============================================================================
// Email Processor Class
// ============================================================================

export class EmailProcessor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private db: Database.Database;
  private notifyHandler: ((title: string, body: string) => void) | null = null;
  private progressHandler: ((status: string, detail?: Record<string, unknown>) => void) | null = null;
  private rulesEngine: import('./rules-engine').RulesEngine | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.createTables();
    this.migrateSchema();
  }

  // ---------- Lifecycle ----------

  start(): void {
    const intervalMin = parseInt(SettingsManager.get('gmail.emailProcessing.intervalMin') || '30', 10) || 30;
    const intervalMs = intervalMin * 60_000;

    console.log(`[EmailProcessor] Starting with ${intervalMin}min interval`);
    void this.processEmails();
    this.intervalId = setInterval(() => void this.processEmails(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[EmailProcessor] Stopped');
  }

  setNotificationHandler(handler: (title: string, body: string) => void): void {
    this.notifyHandler = handler;
  }

  setProgressHandler(handler: (status: string, detail?: Record<string, unknown>) => void): void {
    this.progressHandler = handler;
  }

  setRulesEngine(engine: import('./rules-engine').RulesEngine): void {
    this.rulesEngine = engine;
  }

  private emitProgress(status: string, detail?: Record<string, unknown>): void {
    if (this.progressHandler) this.progressHandler(status, detail);
  }

  restart(): void {
    this.stop();
    this.start();
  }

  // ---------- Schema ----------

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_processing_checkpoints (
        account TEXT PRIMARY KEY,
        last_internal_date_ms INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS email_processing_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        internal_date_ms INTEGER,
        subject TEXT,
        sender TEXT,
        label_applied TEXT,
        confidence TEXT,
        processed_at TEXT DEFAULT (datetime('now')),
        glm_raw TEXT,
        fail_reason TEXT,
        corrected_label TEXT,
        corrected_at TEXT,
        UNIQUE(account, message_id)
      );

      CREATE TABLE IF NOT EXISTS email_processing_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        emails_fetched INTEGER DEFAULT 0,
        emails_classified INTEGER DEFAULT 0,
        emails_skipped INTEGER DEFAULT 0,
        labels_applied TEXT,
        glm_calls INTEGER DEFAULT 0,
        duration_ms INTEGER,
        error TEXT,
        success INTEGER DEFAULT 1
      );
    `);

    // Create indexes if they don't exist
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_eps_account ON email_processing_state(account);
      CREATE INDEX IF NOT EXISTS idx_eps_processed ON email_processing_state(processed_at);
    `);
  }

  // ---------- Schema Migration ----------

  private migrateSchema(): void {
    const cols = this.db.pragma('table_info(email_processing_state)') as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));

    // Add new columns if missing (existing installs)
    if (!colNames.has('glm_raw')) {
      this.db.exec('ALTER TABLE email_processing_state ADD COLUMN glm_raw TEXT');
    }
    if (!colNames.has('fail_reason')) {
      this.db.exec('ALTER TABLE email_processing_state ADD COLUMN fail_reason TEXT');
    }
    if (!colNames.has('corrected_label')) {
      this.db.exec('ALTER TABLE email_processing_state ADD COLUMN corrected_label TEXT');
    }
    if (!colNames.has('corrected_at')) {
      this.db.exec('ALTER TABLE email_processing_state ADD COLUMN corrected_at TEXT');
    }
    if (!colNames.has('snippet')) {
      this.db.exec('ALTER TABLE email_processing_state ADD COLUMN snippet TEXT');
    }
    if (!colNames.has('filed_at')) {
      this.db.exec('ALTER TABLE email_processing_state ADD COLUMN filed_at TEXT');
    }

    // If existing DB has CHECK constraint on confidence that blocks 'invalid',
    // recreate the table without the CHECK constraint
    try {
      this.db.prepare(
        "INSERT INTO email_processing_state(account,message_id,confidence) VALUES('__test__','__test__','invalid')",
      ).run();
      this.db.prepare(
        "DELETE FROM email_processing_state WHERE account='__test__'",
      ).run();
    } catch {
      // CHECK constraint blocks 'invalid' — recreate table without it.
      // At this point, new columns were already added via ALTER above,
      // so we can reference them safely in the SELECT.
      console.log('[EmailProcessor] Migrating email_processing_state to remove CHECK constraint');
      this.db.exec(`
        CREATE TABLE email_processing_state_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account TEXT NOT NULL,
          message_id TEXT NOT NULL,
          thread_id TEXT,
          internal_date_ms INTEGER,
          subject TEXT,
          sender TEXT,
          label_applied TEXT,
          confidence TEXT,
          processed_at TEXT DEFAULT (datetime('now')),
          glm_raw TEXT,
          fail_reason TEXT,
          corrected_label TEXT,
          corrected_at TEXT,
          snippet TEXT,
          filed_at TEXT,
          UNIQUE(account, message_id)
        );
        INSERT INTO email_processing_state_new(id, account, message_id, thread_id, internal_date_ms, subject, sender, label_applied, confidence, processed_at, glm_raw, fail_reason, corrected_label, corrected_at, snippet, filed_at)
          SELECT id, account, message_id, thread_id, internal_date_ms, subject, sender,
                 label_applied, confidence, processed_at,
                 glm_raw, fail_reason, corrected_label, corrected_at, snippet, NULL
          FROM email_processing_state;
        DROP TABLE email_processing_state;
        ALTER TABLE email_processing_state_new RENAME TO email_processing_state;
        CREATE INDEX IF NOT EXISTS idx_eps_account ON email_processing_state(account);
        CREATE INDEX IF NOT EXISTS idx_eps_processed ON email_processing_state(processed_at);
      `);
      console.log('[EmailProcessor] Migration complete');
    }
  }

  // ---------- Checkpoint ----------

  private getCheckpoint(account: string): number {
    const row = this.db
      .prepare('SELECT last_internal_date_ms FROM email_processing_checkpoints WHERE account = ?')
      .get(account) as { last_internal_date_ms: number } | undefined;
    return row?.last_internal_date_ms ?? 0;
  }

  private setCheckpoint(account: string, ms: number): void {
    this.db.prepare(`
      INSERT INTO email_processing_checkpoints(account, last_internal_date_ms, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(account) DO UPDATE SET
        last_internal_date_ms = excluded.last_internal_date_ms,
        updated_at = datetime('now')
    `).run(account, ms);
  }

  // ---------- State ----------

  private isAlreadyProcessed(account: string, messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM email_processing_state WHERE account = ? AND message_id = ? LIMIT 1')
      .get(account, messageId);
    return Boolean(row);
  }

  private saveProcessed(
    account: string,
    email: FullEmail,
    appliedLabel: string,
    confidence: Confidence,
    glmRaw?: string,
    failReason?: FailReason,
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO email_processing_state
      (account, message_id, thread_id, internal_date_ms, subject, sender, label_applied, confidence, glm_raw, fail_reason, snippet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(account, email.id, email.threadId ?? null, email.internalDateMs,
      email.subject ?? null, email.from ?? null, appliedLabel, confidence,
      glmRaw ?? null, failReason ?? null, (email.body || '').slice(0, 300));
  }

  // ---------- Run History ----------

  private startRun(account: string): number {
    const info = this.db.prepare(
      'INSERT INTO email_processing_runs(account, started_at) VALUES (?, ?)',
    ).run(account, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  private finishRun(runId: number, stats: ProcessingRunStats, durationMs: number, error?: string): void {
    this.db.prepare(`
      UPDATE email_processing_runs SET
        completed_at = datetime('now'),
        emails_fetched = ?,
        emails_classified = ?,
        emails_skipped = ?,
        labels_applied = ?,
        glm_calls = ?,
        duration_ms = ?,
        error = ?,
        success = ?
      WHERE id = ?
    `).run(
      stats.emailsFetched, stats.emailsClassified, stats.emailsSkipped,
      JSON.stringify(stats.labelsApplied), stats.glmCalls,
      durationMs, error ?? null, error ? 0 : 1, runId,
    );
  }

  // ---------- Label Helpers ----------

  private async ensureLabel(labelName: string, account: string): Promise<void> {
    try {
      const res = await listLabels({ account });
      if (!res.success) return;
      const labels = unwrapGogArray(res.labels || '[]', 'labels');
      const exists = labels.some((l) => {
        const obj = l as Record<string, unknown>;
        return (obj.name || obj.label || l) === labelName;
      });
      if (!exists) {
        await createLabel({ name: labelName, account });
        console.log(`[EmailProcessor] Created label: ${labelName}`);
      }
    } catch (err) {
      console.warn(`[EmailProcessor] Could not ensure label ${labelName}:`, err);
    }
  }

  // ---------- Few-Shot Examples ----------

  private async fetchFewShotExamples(
    account: string,
    labelConfig: LabelConfig,
  ): Promise<Record<string, FullEmail[]>> {
    const result: Record<string, FullEmail[]> = {};

    for (const [label, cfg] of Object.entries(labelConfig)) {
      const rawExamples = (cfg.examples || []).slice(0, 5);
      if (rawExamples.length === 0) continue;

      const emails: FullEmail[] = [];
      for (const ex of rawExamples) {
        // Examples can be plain messageId strings or { messageId, subject, from } objects
        const messageId = typeof ex === 'string' ? ex : ex.messageId;
        if (!messageId) continue;
        try {
          const msgRes = await withRetry(() => getMessage({ messageId, account }));
          const email = adaptFullEmail(msgRes);
          if (email) emails.push(email);
        } catch {
          // Skip failed example fetches
        }
      }
      if (emails.length > 0) result[label] = emails;
    }

    return result;
  }

  // ---------- Main Processing Loop ----------

  async processEmails(onDemand = false): Promise<void> {
    if (this.running) {
      console.log('[EmailProcessor] Already running, skipping');
      return;
    }
    this.running = true;

    // Skip enabled check for on-demand runs triggered by "Run Now"
    if (!onDemand) {
      const enabled = SettingsManager.get('gmail.emailProcessing.enabled') === 'true';
      if (!enabled) {
        this.running = false;
        return;
      }
    }

    const accounts = safeJsonParse<string[]>(SettingsManager.get('gmail.emailProcessing.accounts') || '[]', []);
    const categories = safeJsonParse<string[]>(SettingsManager.get('gmail.emailProcessing.categories') || '[]', []);
    const labelConfig = safeJsonParse<LabelConfig>(SettingsManager.get('gmail.emailProcessing.labelConfig') || '{}', {});
    const processedLabel = SettingsManager.get('gmail.emailProcessing.processedLabel') || 'AI/Processed';
    const reviewLabel = SettingsManager.get('gmail.emailProcessing.reviewLabel') || 'AI/Review';
    const lookbackDays = SettingsManager.get('gmail.emailProcessing.lookbackDays') || '7';
    const maxEmails = parseInt(SettingsManager.get('gmail.emailProcessing.maxEmailsPerRun') || '100', 10) || 100;
    const gmailConc = parseInt(SettingsManager.get('gmail.emailProcessing.gmailConcurrency') || '4', 10) || 4;
    const glmConc = parseInt(SettingsManager.get('gmail.emailProcessing.glmConcurrency') || '1', 10) || 1;

    const glmModel = SettingsManager.get('zhipu.flashModel') || 'glm-4.7-flash';
    const glmBase = SettingsManager.get('zhipu.baseUrl') || 'https://open.bigmodel.cn/api/paas/v4';
    console.log(`[EmailProcessor] GLM model: ${glmModel}, base: ${glmBase}, concurrency: ${glmConc}`);
    console.log(`[EmailProcessor] Accounts: ${JSON.stringify(accounts)}, categories: ${JSON.stringify(categories)}`);

    if (accounts.length === 0) {
      console.log('[EmailProcessor] No accounts configured');
      this.running = false;
      return;
    }

    for (const account of accounts) {
      const runId = this.startRun(account);
      const started = Date.now();
      const stats: ProcessingRunStats = {
        emailsFetched: 0, emailsClassified: 0, emailsSkipped: 0,
        labelsApplied: {}, glmCalls: 0,
      };

      try {
        // 1. Load checkpoint
        const checkpoint = this.getCheckpoint(account);
        console.log(`[EmailProcessor] ${account}: checkpoint=${checkpoint} (${checkpoint ? new Date(checkpoint).toISOString() : 'none'})`);

        // 2. Ensure marker labels exist
        await this.ensureLabel(processedLabel, account);
        await this.ensureLabel(reviewLabel, account);

        // 3. Build query
        let query: string;
        if (categories.length > 0) {
          const catFilter = categories.map((c: string) => `category:${c}`).join(' OR ');
          query = `(${catFilter}) newer_than:${lookbackDays}d -label:${processedLabel}`;
        } else {
          query = `in:inbox newer_than:${lookbackDays}d -label:${processedLabel}`;
        }
        console.log(`[EmailProcessor] ${account}: query="${query}"`);

        // 4. Fetch email list
        this.emitProgress('Fetching email list...', { account });
        const listRes = await withRetry(() => readEmails({ query, max: maxEmails, account }));
        if (!listRes.success) {
          throw new Error(`readEmails failed: ${listRes.error}`);
        }
        console.log(`[EmailProcessor] ${account}: raw response length=${(listRes.emails || '').length}`);
        const emailList = unwrapGogArray(listRes.emails || '[]', 'messages') as EmailListItem[];
        stats.emailsFetched = emailList.length;
        console.log(`[EmailProcessor] ${account}: fetched ${emailList.length} emails`);

        // 5. Local filter by checkpoint
        const candidates = emailList.filter((e) => {
          const ms = toInternalDateMs(e);
          return ms > checkpoint;
        });

        // 6. Dedup via state table
        const notProcessed = candidates.filter((e) => {
          if (this.isAlreadyProcessed(account, e.id)) {
            stats.emailsSkipped += 1;
            return false;
          }
          return true;
        });

        if (notProcessed.length === 0) {
          console.log(`[EmailProcessor] ${account}: No new emails (${stats.emailsFetched} fetched, ${stats.emailsSkipped} skipped)`);
          this.finishRun(runId, stats, Date.now() - started);
          continue;
        }

        console.log(`[EmailProcessor] ${account}: Processing ${notProcessed.length} new emails`);
        this.emitProgress(`Fetching ${notProcessed.length} email bodies...`, { account, total: notProcessed.length });

        // 7. Fetch full bodies (concurrency limited)
        const fullEmails = (await withConcurrency(
          notProcessed,
          gmailConc,
          async (item) => {
            const msgRes = await withRetry(() => getMessage({ messageId: item.id, account }));
            return adaptFullEmail(msgRes);
          },
        )).filter((e): e is FullEmail => e !== null);

        if (fullEmails.length === 0) {
          this.finishRun(runId, stats, Date.now() - started);
          continue;
        }

        // 8. Fetch labels for classification
        const labelsRes = await withRetry(() => listLabels({ account }));
        const allLabels = unwrapGogArray(labelsRes.labels || '[]', 'labels');
        const allPromptLabels = buildLabelList(allLabels, labelConfig);

        // Filter to active labels only (if configured)
        const activeLabels = safeJsonParse<string[]>(
          SettingsManager.get('gmail.emailProcessing.activeLabels') || '[]', [],
        );
        const promptLabels = activeLabels.length > 0
          ? allPromptLabels.filter(l => activeLabels.includes(l.name))
          : allPromptLabels;

        const allowedLabelSet = new Set(promptLabels.map((x) => x.name));
        allowedLabelSet.add(reviewLabel);

        // Log allowed labels for diagnostics
        console.log(`[EmailProcessor] Allowed labels (${promptLabels.length}/${allPromptLabels.length}): ${JSON.stringify(promptLabels.map(l => l.name))}`);

        // 9. Fetch few-shot examples
        const examplesByLabel = await this.fetchFewShotExamples(account, labelConfig);

        // 10. Classify in batches (concurrency limited)
        const batches = chunk(fullEmails, 5);
        let batchIdx = 0;
        const batchResults = await withConcurrency(
          batches,
          glmConc,
          async (batch) => {
            batchIdx += 1;
            const currentBatch = batchIdx;
            const prompt = buildGlmPrompt(promptLabels, examplesByLabel, batch, reviewLabel);
            stats.glmCalls += 1;

            console.log(`[EmailProcessor] Batch ${currentBatch}/${batches.length} (prompt: ${prompt.length} chars): classifying ${batch.map(e => e.subject || '(no subject)').join(' | ')}`);
            this.emitProgress(`Classifying batch ${currentBatch}/${batches.length}...`, { account, batch: currentBatch, total: batches.length, subjects: batch.map(e => e.subject || '(no subject)') });

            // Rate limit safety: delay before each GLM call
            await sleep(2000);

            let glmRes: { success: boolean; content?: string };
            try {
              // glmFlash returns { success: false } on API errors (429 etc.) instead
              // of throwing. We throw here so withRetry can apply exponential backoff.
              glmRes = await withRetry(async () => {
                const res = await glmFlash({
                  messages: [{ role: 'user', content: prompt }],
                  maxTokens: 8000,
                  temperature: 0.1,
                  disableThinking: true,
                });
                if (!res.success) {
                  throw new Error(res.error || 'GLM call failed');
                }
                return res;
              }, 3, 3000); // 3 retries, base 3s → backoff: 3s, 6s, 12s
            } catch (glmErr) {
              // All retries exhausted — fall back to review
              const errMsg = String(glmErr);
              const is429 = errMsg.includes('429') || errMsg.toLowerCase().includes('rate');
              console.warn(`[EmailProcessor] Batch ${currentBatch}: GLM failed after retries: ${glmErr}`);
              return batch.map((e) => ({
                messageId: e.id,
                threadId: e.threadId,
                label: reviewLabel,
                confidence: 'invalid' as Confidence,
                subject: e.subject,
                from: e.from,
                failReason: (is429 ? 'batch_429' : 'batch_error') as FailReason,
                glmRaw: errMsg.slice(0, 2000),
              }));
            }

            // Log raw GLM response for diagnostics
            console.log(`[EmailProcessor] Batch ${currentBatch} raw GLM response: ${glmRes.content}`);

            const validated = validateGlmResponse(glmRes.content!, batch, allowedLabelSet, reviewLabel);
            console.log(`[EmailProcessor] Batch ${currentBatch} validated: ${JSON.stringify(validated.map(v => ({ msg: v.messageId.slice(0,8), label: v.label, conf: v.confidence })))}`);
            return validated;
          },
        );

        const flat = batchResults.flat();
        stats.emailsClassified = flat.length;

        // 11. Apply labels
        for (const r of flat) {
          const email = fullEmails.find((e) => e.id === r.messageId);
          if (!email) continue;

          const labelToApply = (r.confidence === 'low' || r.confidence === 'invalid') ? reviewLabel : r.label;
          const addLabels = `${labelToApply},${processedLabel}`;

          try {
            await withRetry(() => modifyLabels({
              threadIds: email.threadId ? [email.threadId] : [],
              add: addLabels,
              account,
            }));
          } catch (err) {
            console.warn(`[EmailProcessor] Failed to apply label to ${r.messageId}:`, err);
          }

          stats.labelsApplied[labelToApply] = (stats.labelsApplied[labelToApply] || 0) + 1;
          this.saveProcessed(account, email, labelToApply, r.confidence, r.glmRaw, r.failReason);

          // Route (archive/mark-read) based on label config
          const routed = await applyRouting(email.threadId, account, labelToApply, r.confidence, labelConfig);
          if (routed) {
            this.db.prepare('UPDATE email_processing_state SET filed_at = datetime(\'now\') WHERE message_id = ? AND account = ?')
              .run(email.id, account);
          }

          // Evaluate rules engine
          if (this.rulesEngine) {
            try {
              await this.rulesEngine.evaluate({
                messageId: email.id,
                threadId: email.threadId,
                account,
                subject: email.subject ?? '',
                sender: email.from ?? '',
                snippet: (email.body || '').slice(0, 300),
                label: labelToApply,
                confidence: r.confidence,
                internalDateMs: email.internalDateMs,
                correctedByUser: false,
              }, 'on_label_applied', 0);
            } catch (err) {
              console.warn('[EmailProcessor] Rule evaluation failed:', err);
            }
          }
        }

        // 12. Advance checkpoint
        const maxMs = Math.max(...fullEmails.map((e) => e.internalDateMs));
        if (Number.isFinite(maxMs) && maxMs > checkpoint) {
          this.setCheckpoint(account, maxMs);
        }

        // 13. Log to event_log
        logEvent({
          event_type: 'email_processing',
          source: 'glm',
          actor: 'glm',
          session_id: 'system',
          data: {
            account,
            emailsFetched: stats.emailsFetched,
            emailsClassified: stats.emailsClassified,
            emailsSkipped: stats.emailsSkipped,
            labelsApplied: stats.labelsApplied,
            glmCalls: stats.glmCalls,
            checkpointAdvanced: maxMs > checkpoint,
          },
          success: true,
          duration_ms: Date.now() - started,
        });

        this.finishRun(runId, stats, Date.now() - started);

        console.log(`[EmailProcessor] ${account}: Done — ${stats.emailsClassified} classified, ${stats.glmCalls} GLM calls, ${Date.now() - started}ms`);
        this.emitProgress(`Done! ${stats.emailsClassified} classified, ${Object.keys(stats.labelsApplied).length} labels used`, { account, ...stats });

        // 14. Send notifications
        await this.sendNotifications(flat, labelConfig, reviewLabel, account);

      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        console.error(`[EmailProcessor] Failed for ${account}:`, errorText);

        logEvent({
          event_type: 'email_processing',
          source: 'glm',
          actor: 'glm',
          session_id: 'system',
          data: { account, error: errorText },
          success: false,
          error: errorText,
          duration_ms: Date.now() - started,
        });

        this.finishRun(runId, stats, Date.now() - started, errorText);
      }
    }

    this.running = false;
  }

  // ---------- Notifications ----------

  private async sendNotifications(
    results: ClassificationResult[],
    labelConfig: LabelConfig,
    reviewLabel: string,
    account: string,
  ): Promise<void> {
    const toNotify: Record<string, ClassificationResult[]> = {};

    for (const r of results) {
      const isReview = r.label === reviewLabel;
      const isNotifyEnabled = labelConfig[r.label]?.notify === true;
      const isHighConfidence = r.confidence !== 'low' && r.confidence !== 'invalid';

      if (isReview || (isNotifyEnabled && isHighConfidence)) {
        if (!toNotify[r.label]) toNotify[r.label] = [];
        toNotify[r.label].push(r);
      }
    }

    if (Object.keys(toNotify).length === 0) return;

    // Build notification message
    const lines: string[] = [`New emails classified (${account}):`];
    for (const [label, emails] of Object.entries(toNotify)) {
      const prefix = label === reviewLabel ? 'Needs Review' : label;
      lines.push(`  ${prefix} (${emails.length}):`);
      for (const e of emails.slice(0, 5)) {
        lines.push(`    ${e.subject || '(no subject)'} — ${e.from || 'unknown'}`);
      }
      if (emails.length > 5) {
        lines.push(`    ... and ${emails.length - 5} more`);
      }
    }

    const message = lines.join('\n');
    console.log(`[EmailProcessor] Notification:\n${message}`);

    // Send via notification handler (desktop notification + Telegram if configured)
    if (this.notifyHandler) {
      this.notifyHandler('Email Processing', message);
    }

    logEvent({
      event_type: 'notification_sent',
      source: 'system',
      actor: 'glm',
      session_id: 'system',
      data: { channel: 'email_processor', message, account },
      success: true,
    });
  }

  // ---------- Status Query (for IPC) ----------

  getProcessingStatus(): {
    runs: unknown[];
    checkpoints: unknown[];
  } {
    const runs = this.db
      .prepare('SELECT * FROM email_processing_runs ORDER BY id DESC LIMIT 20')
      .all();
    const checkpoints = this.db
      .prepare('SELECT * FROM email_processing_checkpoints')
      .all();
    return { runs, checkpoints };
  }

  getProcessedEmails(limit = 200, offset = 0): {
    emails: unknown[];
    total: number;
  } {
    const total = (this.db
      .prepare('SELECT COUNT(*) AS count FROM email_processing_state')
      .get() as { count: number }).count;
    const emails = this.db
      .prepare(
        'SELECT * FROM email_processing_state ORDER BY processed_at DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset);
    return { emails, total };
  }

  // ---------- DB Access ----------

  getDb(): Database.Database { return this.db; }

  // ---------- Label Stats ----------

  getLabelStats(account?: string): { label: string; count: number; lastUsed: string }[] {
    const query = account
      ? `SELECT COALESCE(corrected_label, label_applied) AS label, COUNT(*) AS count, MAX(processed_at) AS lastUsed
         FROM email_processing_state WHERE account = ? GROUP BY label ORDER BY count DESC`
      : `SELECT COALESCE(corrected_label, label_applied) AS label, COUNT(*) AS count, MAX(processed_at) AS lastUsed
         FROM email_processing_state GROUP BY label ORDER BY count DESC`;
    return (account ? this.db.prepare(query).all(account) : this.db.prepare(query).all()) as { label: string; count: number; lastUsed: string }[];
  }

  // ---------- Label Corrections ----------

  async correctLabel(
    messageId: string,
    account: string,
    newLabel: string,
    useAsExample: boolean,
  ): Promise<void> {
    const row = this.db.prepare(
      'SELECT * FROM email_processing_state WHERE message_id = ? AND account = ?',
    ).get(messageId, account) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Email not found');

    const oldLabel = String(row.corrected_label || row.label_applied || '');

    // Update DB
    this.db.prepare(
      'UPDATE email_processing_state SET corrected_label = ?, corrected_at = datetime(\'now\') WHERE message_id = ? AND account = ?',
    ).run(newLabel, messageId, account);

    // Gmail: remove old label, add new label (keep AI/Processed)
    const threadId = String(row.thread_id || '');
    if (threadId && oldLabel !== newLabel) {
      try {
        await modifyLabels({
          threadIds: [threadId],
          remove: oldLabel,
          add: newLabel,
          account,
        });
      } catch (err) {
        console.warn(`[EmailProcessor] Failed to update Gmail labels for ${messageId}:`, err);
      }
    }

    // Route with 'high' confidence — user corrections are explicit
    const labelConfigFresh = safeJsonParse<LabelConfig>(
      SettingsManager.get('gmail.emailProcessing.labelConfig') || '{}', {},
    );
    const routed = await applyRouting(threadId || undefined, account, newLabel, 'high', labelConfigFresh);
    if (routed) {
      this.db.prepare('UPDATE email_processing_state SET filed_at = datetime(\'now\') WHERE message_id = ? AND account = ?')
        .run(messageId, account);
    }

    // Evaluate rules engine for label correction
    if (this.rulesEngine) {
      try {
        await this.rulesEngine.evaluate({
          messageId,
          threadId: threadId || undefined,
          account,
          subject: String(row.subject || ''),
          sender: String(row.sender || ''),
          snippet: String(row.snippet || ''),
          label: newLabel,
          confidence: String(row.confidence || 'low'),
          internalDateMs: Number(row.internal_date_ms) || 0,
          correctedByUser: true,
        }, 'on_label_corrected', 0);
      } catch (err) {
        console.warn('[EmailProcessor] Rule evaluation on correction failed:', err);
      }
    }

    // If useAsExample: add to labelConfig few-shot examples
    if (useAsExample) {
      const labelConfigRaw = SettingsManager.get('gmail.emailProcessing.labelConfig') || '{}';
      const labelConfig = safeJsonParse<LabelConfig>(labelConfigRaw, {});
      if (!labelConfig[newLabel]) labelConfig[newLabel] = {};
      if (!labelConfig[newLabel].examples) labelConfig[newLabel].examples = [];

      const examples = labelConfig[newLabel].examples!;
      // Dedupe by messageId
      const hasIt = examples.some(e => {
        if (typeof e === 'string') return e === messageId;
        return e.messageId === messageId;
      });
      if (!hasIt) {
        examples.push({
          messageId,
          subject: String(row.subject || ''),
          from: String(row.sender || ''),
        });
        // Cap at 5
        if (examples.length > 5) examples.shift();
      }

      SettingsManager.set('gmail.emailProcessing.labelConfig', JSON.stringify(labelConfig));
    }

    console.log(`[EmailProcessor] Corrected ${messageId}: ${oldLabel} → ${newLabel} (example: ${useAsExample})`);
  }
}

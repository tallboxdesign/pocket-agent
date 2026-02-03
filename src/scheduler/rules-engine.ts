/**
 * Rules Engine for Email Processing
 *
 * Evaluates deterministic rules on classified emails.
 * Supports triggers (on_label_applied, on_label_corrected, on_schedule, on_daily_summary),
 * AND-logic conditions, and configurable actions (send_telegram, apply_label, draft_reply, etc.).
 *
 * Safety: chain depth cap, loop detection, approval countdown, draft mode by default.
 */

import Database from 'better-sqlite3';
import { SettingsManager } from '../settings';
import { modifyLabels, createDraft, sendEmail, getThread } from '../tools/gog-wrapper';
import { glmFlash } from '../tools/glm-client';
import { applyRouting } from './email-processor';

// ============================================================================
// Types
// ============================================================================

export type TriggerType = 'on_label_applied' | 'on_label_corrected' | 'on_schedule' | 'on_daily_summary' | 'on_unanswered_scan';
export type RuleMode = 'disabled' | 'draft' | 'active';
export type ConditionType =
  | 'label_is' | 'label_is_not'
  | 'confidence_gte' | 'confidence_lt'
  | 'sender_domain' | 'has_attachment'
  | 'age_minutes_lt' | 'age_minutes_gt'
  | 'corrected_by_user' | 'rule_not_executed'
  | 'thread_state'
  | 'label_in' | 'unanswered_age_minutes_gt' | 'state_is_not';
export type ActionType =
  | 'apply_label' | 'remove_label'
  | 'draft_reply' | 'send_reply'
  | 'mark_read' | 'archive'
  | 'send_telegram' | 'send_email'
  | 'add_to_summary' | 'do_nothing'
  | 'send_unanswered_digest' | 'mark_resolved' | 'dismiss';

export interface Condition { type: ConditionType; value: string; }
export interface Action { type: ActionType; config: Record<string, string>; }

export interface EmailRule {
  id: number;
  name: string;
  account: string;
  trigger_type: TriggerType;
  conditions_json: string;
  actions_json: string;
  mode: RuleMode;
  priority: number;
  max_chain_depth: number;
  approval_remaining: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

export interface EmailContext {
  messageId: string;
  threadId?: string;
  account: string;
  subject: string;
  sender: string;
  snippet: string;
  label: string;
  confidence: string;
  internalDateMs: number;
  correctedByUser: boolean;
}

export interface RuleExecution {
  id: number;
  rule_id: number;
  rule_name: string;
  message_id: string;
  account: string;
  trigger_type: string;
  executed_at: string;
  actions_taken: string;
  result: 'ok' | 'blocked' | 'error' | 'dry_run';
  error: string | null;
  chain_depth: number;
}

interface DailySummaryItem {
  message_id: string;
  account: string;
  label: string;
  subject: string;
  sender: string;
  snippet: string;
}

// ============================================================================
// Helpers
// ============================================================================

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, invalid: 0 };

function confidenceRank(conf: string): number {
  return CONFIDENCE_RANK[conf] ?? 0;
}

// Thread state types
export type ThreadState = 'unread' | 'unreplied' | 'awaiting_reply' | 'replied_with_answer' | 'user_only';

export interface ThreadMessage {
  from: string;
  labelIds?: string[];
}

export function computeThreadState(messages: ThreadMessage[], userEmail: string): ThreadState {
  const userLower = userEmail.toLowerCase();

  // Check UNREAD on any message
  if (messages.some(m => m.labelIds?.includes('UNREAD'))) {
    return 'unread';
  }

  const userSent = messages.filter(m => m.from.toLowerCase().includes(userLower));

  // All messages from user
  if (userSent.length === messages.length) {
    return 'user_only';
  }

  // No messages from user at all
  if (userSent.length === 0) {
    return 'unreplied';
  }

  // Mixed: check who sent the last message
  const last = messages[messages.length - 1];
  if (last.from.toLowerCase().includes(userLower)) {
    return 'awaiting_reply';
  }

  return 'replied_with_answer';
}

function interpolateTemplate(template: string, email: EmailContext, extras: Record<string, string> = {}): string {
  let result = template
    .replace(/\{sender\}/g, email.sender)
    .replace(/\{subject\}/g, email.subject)
    .replace(/\{preview\}/g, email.snippet)
    .replace(/\{label\}/g, email.label)
    .replace(/\{confidence\}/g, email.confidence);
  for (const [key, val] of Object.entries(extras)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
  }
  return result;
}

// ============================================================================
// RulesEngine Class
// ============================================================================

export class RulesEngine {
  private db: Database.Database;
  private telegramSender: ((text: string) => void) | null = null;
  private notifyHandler: ((title: string, body: string) => void) | null = null;
  private telegramThrottleCount = 0;
  private telegramThrottleResetAt = 0;

  constructor(db: Database.Database) {
    this.db = db;
    this.createTables();
    this.cleanupOldExecutions();
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
      CREATE TABLE IF NOT EXISTS email_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT '*',
        trigger_type TEXT NOT NULL DEFAULT 'on_label_applied',
        conditions_json TEXT NOT NULL DEFAULT '[]',
        actions_json TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL DEFAULT 'draft',
        priority INTEGER NOT NULL DEFAULT 100,
        max_chain_depth INTEGER NOT NULL DEFAULT 3,
        approval_remaining INTEGER NOT NULL DEFAULT 3,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS email_rule_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL,
        rule_name TEXT,
        message_id TEXT NOT NULL,
        account TEXT NOT NULL,
        trigger_type TEXT,
        executed_at TEXT DEFAULT (datetime('now')),
        actions_taken TEXT,
        result TEXT DEFAULT 'ok',
        error TEXT,
        chain_depth INTEGER DEFAULT 0,
        FOREIGN KEY (rule_id) REFERENCES email_rules(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS thread_state_cache (
        thread_id TEXT NOT NULL,
        account TEXT NOT NULL,
        thread_state TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        fetched_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (thread_id, account)
      );

      CREATE TABLE IF NOT EXISTS daily_summary_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        account TEXT NOT NULL,
        label TEXT,
        subject TEXT,
        sender TEXT,
        snippet TEXT,
        added_at TEXT DEFAULT (datetime('now')),
        summary_run_id TEXT
      );
    `);
  }

  // ---------- CRUD ----------

  getRules(account?: string): EmailRule[] {
    if (account) {
      return this.db.prepare(
        "SELECT * FROM email_rules WHERE account IN ('*', ?) ORDER BY priority ASC",
      ).all(account) as EmailRule[];
    }
    return this.db.prepare('SELECT * FROM email_rules ORDER BY priority ASC').all() as EmailRule[];
  }

  getRule(id: number): EmailRule | null {
    return (this.db.prepare('SELECT * FROM email_rules WHERE id = ?').get(id) as EmailRule) ?? null;
  }

  createRule(data: Partial<EmailRule>): EmailRule {
    const info = this.db.prepare(`
      INSERT INTO email_rules (name, account, trigger_type, conditions_json, actions_json, mode, priority, max_chain_depth, approval_remaining, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name || 'Untitled Rule',
      data.account || '*',
      data.trigger_type || 'on_label_applied',
      data.conditions_json || '[]',
      data.actions_json || '[]',
      data.mode || 'draft',
      data.priority ?? 100,
      data.max_chain_depth ?? 3,
      data.approval_remaining ?? 3,
      data.enabled ?? 1,
    );
    return this.getRule(Number(info.lastInsertRowid))!;
  }

  updateRule(id: number, updates: Partial<EmailRule>): EmailRule | null {
    const fields: string[] = [];
    const values: unknown[] = [];
    const allowed: (keyof EmailRule)[] = [
      'name', 'account', 'trigger_type', 'conditions_json', 'actions_json',
      'mode', 'priority', 'max_chain_depth', 'approval_remaining', 'enabled',
    ];
    for (const key of allowed) {
      if (key in updates) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    }
    if (fields.length === 0) return this.getRule(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE email_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getRule(id);
  }

  deleteRule(id: number): void {
    this.db.prepare('DELETE FROM email_rules WHERE id = ?').run(id);
  }

  toggleRule(id: number, enabled: boolean): void {
    this.db.prepare("UPDATE email_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  // ---------- Core Evaluation ----------

  async evaluate(email: EmailContext, trigger: TriggerType, chainDepth = 0): Promise<void> {
    if (SettingsManager.get('gmail.emailProcessing.rulesEnabled') !== 'true') return;

    // Loop detection: if >10 executions for same message in last 5 minutes
    const recentCount = (this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM email_rule_executions WHERE message_id = ? AND executed_at > datetime('now', '-5 minutes')",
    ).get(email.messageId) as { cnt: number }).cnt;

    if (recentCount > 10) {
      console.warn(`[RulesEngine] Loop detected for ${email.messageId} (${recentCount} executions). Disabling rules.`);
      SettingsManager.set('gmail.emailProcessing.rulesEnabled', 'false');
      if (this.notifyHandler) {
        this.notifyHandler('Rules Engine', 'Loop detected — rules auto-disabled. Check rule configuration.');
      }
      return;
    }

    // Load matching rules
    const rules = this.db.prepare(
      "SELECT * FROM email_rules WHERE enabled = 1 AND trigger_type = ? AND account IN ('*', ?) ORDER BY priority ASC",
    ).all(trigger, email.account) as EmailRule[];

    let newLabelApplied: string | null = null;

    for (const rule of rules) {
      if (!(await this.matchConditions(rule, email))) continue;

      // Mode handling
      if (rule.mode === 'disabled') continue;

      if (rule.mode === 'draft') {
        this.logExecution(rule.id, rule.name, email.messageId, email.account, trigger, '(dry run)', 'dry_run', null, chainDepth);
        continue;
      }

      // Active mode with approval countdown
      if (rule.approval_remaining > 0) {
        this.db.prepare("UPDATE email_rules SET approval_remaining = approval_remaining - 1, updated_at = datetime('now') WHERE id = ?").run(rule.id);
        this.logExecution(rule.id, rule.name, email.messageId, email.account, trigger, '(approval pending)', 'blocked', null, chainDepth);
        continue;
      }

      // Execute actions
      const actions = safeJsonParse<Action[]>(rule.actions_json, []);
      const templateExtras: Record<string, string> = {};
      if (actions.some(a => a.type === 'draft_reply')) {
        templateExtras.draft = 'Draft reply queued';
      }
      const actionResults: string[] = [];

      for (const action of actions) {
        try {
          await this.executeAction(action, email, templateExtras);
          actionResults.push(action.type);
          if (action.type === 'apply_label' && action.config.label) {
            newLabelApplied = action.config.label;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[RulesEngine] Action ${action.type} failed:`, errMsg);
          this.logExecution(rule.id, rule.name, email.messageId, email.account, trigger, action.type, 'error', errMsg, chainDepth);
        }
      }

      if (actionResults.length > 0) {
        this.logExecution(rule.id, rule.name, email.messageId, email.account, trigger, actionResults.join(','), 'ok', null, chainDepth);
        this.db.prepare("UPDATE email_rules SET last_run_at = datetime('now') WHERE id = ?").run(rule.id);
      }
    }

    // Chain: if an apply_label action fired, re-evaluate with new label
    if (newLabelApplied && chainDepth < 3) {
      const chainedEmail = { ...email, label: newLabelApplied };
      await this.evaluate(chainedEmail, 'on_label_applied', chainDepth + 1);
    }
  }

  // ---------- Condition Evaluation ----------

  private async matchConditions(rule: EmailRule, email: EmailContext): Promise<boolean> {
    const conditions = safeJsonParse<Condition[]>(rule.conditions_json, []);
    if (conditions.length === 0) return true;

    for (const cond of conditions) {
      if (cond.type === 'thread_state') {
        const state = await this.getOrFetchThreadState(email);
        if (state !== cond.value) return false;
      } else {
        if (!this.matchSingleCondition(cond, email)) return false;
      }
    }
    return true;
  }

  // ---------- Thread State ----------

  private async getOrFetchThreadState(email: EmailContext): Promise<ThreadState | null> {
    if (!email.threadId) return null;

    // Check cache (30-min TTL)
    const cached = this.db.prepare(
      "SELECT thread_state FROM thread_state_cache WHERE thread_id = ? AND account = ? AND fetched_at > datetime('now', '-30 minutes')",
    ).get(email.threadId, email.account) as { thread_state: string } | undefined;

    if (cached) return cached.thread_state as ThreadState;

    // Fetch from Gmail
    const res = await getThread({ threadId: email.threadId, account: email.account });
    if (!res.success || !res.thread) {
      console.warn('[RulesEngine] Failed to fetch thread', email.threadId, res.error);
      return null;
    }

    const threadData = safeJsonParse<{ messages?: Array<{ from?: string; labelIds?: string[] }> }>(res.thread, {});
    const msgs: ThreadMessage[] = (threadData.messages || []).map(m => ({
      from: m.from || '',
      labelIds: m.labelIds,
    }));

    if (msgs.length === 0) return null;

    const userEmail = SettingsManager.get('gmail.userEmail') || '';
    if (!userEmail) {
      console.warn('[RulesEngine] gmail.userEmail not configured, cannot compute thread state');
      return null;
    }

    const state = computeThreadState(msgs, userEmail);

    // Upsert cache
    this.db.prepare(`
      INSERT INTO thread_state_cache (thread_id, account, thread_state, message_count, fetched_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(thread_id, account) DO UPDATE SET
        thread_state = excluded.thread_state,
        message_count = excluded.message_count,
        fetched_at = excluded.fetched_at
    `).run(email.threadId, email.account, state, msgs.length);

    return state;
  }

  // ---------- Action Execution ----------

  private async executeAction(action: Action, email: EmailContext, extras: Record<string, string> = {}): Promise<void> {
    switch (action.type) {
      case 'send_telegram':
        await this.actionSendTelegram(email, action.config, extras);
        break;
      case 'apply_label':
        await this.actionApplyLabel(email, action.config);
        break;
      case 'remove_label':
        await this.actionRemoveLabel(email, action.config);
        break;
      case 'mark_read':
        await this.actionMarkRead(email);
        break;
      case 'archive':
        await this.actionArchive(email);
        break;
      case 'add_to_summary':
        this.actionAddToSummary(email);
        break;
      case 'draft_reply':
        await this.actionDraftReply(email, action.config);
        break;
      case 'send_email':
        await this.actionSendEmail(email, action.config, extras);
        break;
      case 'do_nothing':
        break;
      case 'send_unanswered_digest':
        // Delegated to UnansweredEngine via its own scheduling; no-op in rules for now
        break;
      case 'mark_resolved':
        if (email.threadId) {
          this.db.prepare(
            "UPDATE unanswered_state SET state = 'resolved', resolved_at = datetime('now') WHERE thread_id = ? AND account = ? AND state = 'unanswered'",
          ).run(email.threadId, email.account);
        }
        break;
      case 'dismiss':
        if (email.threadId) {
          this.db.prepare(
            "UPDATE unanswered_state SET state = 'dismissed', dismissed_at = datetime('now') WHERE thread_id = ? AND account = ? AND state = 'unanswered'",
          ).run(email.threadId, email.account);
        }
        break;
      default:
        console.warn(`[RulesEngine] Unknown action type: ${action.type}`);
    }
  }

  private async actionSendTelegram(email: EmailContext, config: Record<string, string>, extras: Record<string, string> = {}): Promise<void> {
    if (!this.telegramSender) {
      console.warn('[RulesEngine] No telegram sender configured');
      return;
    }

    // Throttle check
    const maxPerHour = Number(config.maxPerHour) || 20;
    const now = Date.now();
    if (now > this.telegramThrottleResetAt) {
      this.telegramThrottleCount = 0;
      this.telegramThrottleResetAt = now + 3600000;
    }
    if (this.telegramThrottleCount >= maxPerHour) {
      throw new Error('throttled');
    }
    this.telegramThrottleCount++;

    const template = config.template || '📧 {label}: {subject}\nFrom: {sender}\n{preview}';
    const text = interpolateTemplate(template, email, extras);
    this.telegramSender(text);
  }

  private async actionApplyLabel(email: EmailContext, config: Record<string, string>): Promise<void> {
    if (!email.threadId || !config.label) return;
    await modifyLabels({ threadIds: [email.threadId], add: config.label, account: email.account });
    // Apply routing based on label config
    const lcRaw = SettingsManager.get('gmail.emailProcessing.labelConfig') || '{}';
    const lc = safeJsonParse<Record<string, Record<string, unknown>>>(lcRaw, {});
    await applyRouting(email.threadId, email.account, config.label, email.confidence, lc as Parameters<typeof applyRouting>[4]);
  }

  private async actionRemoveLabel(email: EmailContext, config: Record<string, string>): Promise<void> {
    if (!email.threadId || !config.label) return;
    await modifyLabels({ threadIds: [email.threadId], remove: config.label, account: email.account });
  }

  private async actionMarkRead(email: EmailContext): Promise<void> {
    if (!email.threadId) return;
    await modifyLabels({ threadIds: [email.threadId], remove: 'UNREAD', account: email.account });
  }

  private async actionArchive(email: EmailContext): Promise<void> {
    if (!email.threadId) return;
    await modifyLabels({ threadIds: [email.threadId], remove: 'INBOX', account: email.account });
  }

  private actionAddToSummary(email: EmailContext): void {
    this.db.prepare(`
      INSERT INTO daily_summary_queue (message_id, account, label, subject, sender, snippet)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(email.messageId, email.account, email.label, email.subject, email.sender, email.snippet);
  }

  private async actionDraftReply(email: EmailContext, config: Record<string, string>): Promise<void> {
    // noreply detection
    const senderLower = (email.sender || '').toLowerCase();
    const noreplyPatterns = [
      'noreply@', 'no-reply@', 'donotreply@', 'do-not-reply@',
      'mailer-daemon@', 'postmaster@',
    ];
    if (noreplyPatterns.some(p => senderLower.includes(p))) {
      throw new Error('skipped_noreply');
    }

    // Domain blocklist check
    const blockedDomainsRaw = SettingsManager.get('gmail.emailProcessing.draftReply.blockedDomains') || '';
    if (blockedDomainsRaw) {
      const blockedDomains = blockedDomainsRaw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
      const senderDomain = senderLower.split('@')[1] || '';
      if (blockedDomains.some(d => senderDomain === d || senderDomain.endsWith('.' + d))) {
        throw new Error('skipped_blocked_domain');
      }
    }

    const prompt = this.buildDraftReplyPrompt(email, config);
    const glmRes = await glmFlash({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1000,
      temperature: 0.4,
      disableThinking: true,
    });

    if (!glmRes.success || !glmRes.content?.trim()) {
      throw new Error('GLM returned empty draft content');
    }

    await createDraft({
      to: email.sender,
      subject: 'Re: ' + email.subject,
      body: glmRes.content,
      replyToMessageId: email.messageId,
      account: email.account,
    });
  }

  private async actionSendEmail(email: EmailContext, config: Record<string, string>, extras: Record<string, string> = {}): Promise<void> {
    const to = config.to || '';
    if (!to) return;
    const subject = interpolateTemplate(config.subjectTemplate || 'Re: {subject}', email, extras);
    const body = interpolateTemplate(config.bodyTemplate || '{preview}', email, extras);
    await sendEmail({ to, subject, body, account: email.account });
  }

  // ---------- GLM Prompt Templates ----------

  private buildDraftReplyPrompt(email: EmailContext, config: Record<string, string>): string {
    const userName = SettingsManager.get('profile.name') || 'User';
    const userSignature = config.signature || '';
    const tone = config.tone || 'professional';
    const instructions = config.instructions || '';
    const replyIntent = config.replyIntent || '';

    return [
      'You write high-quality email replies for the user. You must be accurate. Do not invent facts, dates, names, prices, attachments, or promises. If information is missing, ask concise clarifying questions instead of guessing. Keep it human, not robotic. No marketing fluff. No legal advice. No medical advice.',
      '',
      'The reply must match the instructions exactly.',
      '- Output plain text only',
      '- No markdown',
      '- No JSON',
      '- No headers',
      '- No bullet points unless asked',
      '- Do not mention any internal systems, rules, labels, models, or AI',
      '',
      'Write a reply email draft.',
      '',
      `User profile:`,
      `Name: ${userName}`,
      userSignature ? `Signature:\n${userSignature}` : '',
      '',
      `Reply settings:`,
      `Tone: ${tone}`,
      instructions ? `Instructions: ${instructions}` : '',
      replyIntent ? `Reply intent: ${replyIntent}` : '',
      '',
      'Hard constraints:',
      '- Use only the facts in Email context below',
      '- If the email asks for something impossible or unclear, say so politely',
      '',
      'Email context:',
      `From: ${email.sender}`,
      `Subject: ${email.subject}`,
      `Preview: ${email.snippet}`,
      '',
      'Write the reply now. Plain text only.',
      '',
      'If you asked any clarifying questions, put them under a final line:',
      'Questions:',
      '1. ...',
    ].filter(Boolean).join('\n');
  }

  private buildDailySummaryPrompt(items: DailySummaryItem[], preferences: { verbosity: string; followups: string }): string {
    const itemsBlock = items.map(item =>
      `Label: ${item.label} | From: ${item.sender} | Subject: ${item.subject}\nSnippet: ${item.snippet || 'N/A'}`,
    ).join('\n\n');

    const now = new Date();
    const digestDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    return [
      'You write a daily email digest for the user. You must not invent facts. Use only the provided items. Be concise and structured. Do not mention AI, models, or internal details.',
      '',
      'Output plain text only. No markdown. No JSON. Use clear section headings. Do not exceed 3000 characters.',
      '',
      'Create a daily email digest.',
      '',
      `Digest date: ${digestDate}`,
      `Verbosity: ${preferences.verbosity || 'compact'}`,
      `Include follow-ups: ${preferences.followups || 'yes'}`,
      '',
      'Items:',
      itemsBlock,
      '',
      'Required format:',
      '',
      'DAILY DIGEST',
      `Date: ${digestDate}`,
      '',
      'SECTION: [label_name]',
      '- [time] [sender]: [subject] | [one_line_summary_from_snippet]',
      '',
      'FOLLOW-UPS',
      '1. ...',
      '',
      'Rules:',
      '- Do not guess outcomes',
      '- If a snippet is too vague, summarise it as "Needs review"',
      '- If multiple items are near duplicates, group them and note count',
      '',
      'Create the digest now.',
    ].join('\n');
  }

  // ---------- Daily Summary ----------

  async runDailySummary(): Promise<{ success: boolean; summary?: string; error?: string }> {
    const items = this.db.prepare(
      'SELECT * FROM daily_summary_queue WHERE summary_run_id IS NULL ORDER BY added_at ASC',
    ).all() as DailySummaryItem[];

    if (items.length === 0) {
      return { success: true, summary: 'No items in queue.' };
    }

    const prompt = this.buildDailySummaryPrompt(items, { verbosity: 'compact', followups: 'yes' });
    const glmRes = await glmFlash({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2000,
      temperature: 0.3,
      disableThinking: true,
    });

    if (!glmRes.success || !glmRes.content?.trim()) {
      return { success: false, error: 'GLM returned empty summary' };
    }

    const runId = new Date().toISOString();
    this.db.prepare(
      'UPDATE daily_summary_queue SET summary_run_id = ? WHERE summary_run_id IS NULL',
    ).run(runId);

    // Send via telegram and/or notification
    if (this.telegramSender) {
      this.telegramSender(glmRes.content);
    }
    if (this.notifyHandler) {
      this.notifyHandler('Daily Email Digest', glmRes.content.slice(0, 200));
    }

    return { success: true, summary: glmRes.content };
  }

  // ---------- Logging ----------

  private logExecution(
    ruleId: number,
    ruleName: string,
    messageId: string,
    account: string,
    trigger: TriggerType | string,
    actionsTaken: string,
    result: 'ok' | 'blocked' | 'error' | 'dry_run',
    error: string | null,
    chainDepth: number,
  ): void {
    this.db.prepare(`
      INSERT INTO email_rule_executions (rule_id, rule_name, message_id, account, trigger_type, actions_taken, result, error, chain_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ruleId, ruleName, messageId, account, trigger, actionsTaken, result, error, chainDepth);
  }

  getExecutionLog(ruleId?: number, limit = 50): RuleExecution[] {
    if (ruleId) {
      return this.db.prepare(
        'SELECT * FROM email_rule_executions WHERE rule_id = ? ORDER BY executed_at DESC LIMIT ?',
      ).all(ruleId, limit) as RuleExecution[];
    }
    return this.db.prepare(
      'SELECT * FROM email_rule_executions ORDER BY executed_at DESC LIMIT ?',
    ).all(limit) as RuleExecution[];
  }

  // ---------- Test Mode ----------

  testRule(ruleId: number, limit = 10): { email: { subject: string; sender: string; label: string }; matched: boolean; conditions: { type: string; value: string; passed: boolean }[] }[] {
    const rule = this.getRule(ruleId);
    if (!rule) return [];

    const conditions = safeJsonParse<Condition[]>(rule.conditions_json, []);

    // Smart sampling: include some emails that match the label_is condition
    // so the test is actually useful (not just random recent emails).
    const labelCond = conditions.find(c => c.type === 'label_is');
    let emails: Record<string, unknown>[];
    if (labelCond) {
      // Fetch half from the target label, half from recent — deduplicated
      const half = Math.ceil(limit / 2);
      const targeted = this.db.prepare(
        `SELECT * FROM email_processing_state
         WHERE COALESCE(corrected_label, label_applied) = ?
         ORDER BY processed_at DESC LIMIT ?`,
      ).all(labelCond.value, half) as Record<string, unknown>[];
      const targetIds = new Set(targeted.map(e => e.message_id));
      const recent = (this.db.prepare(
        'SELECT * FROM email_processing_state ORDER BY processed_at DESC LIMIT ?',
      ).all(limit) as Record<string, unknown>[])
        .filter(e => !targetIds.has(e.message_id));
      emails = [...targeted, ...recent].slice(0, limit);
    } else {
      emails = this.db.prepare(
        'SELECT * FROM email_processing_state ORDER BY processed_at DESC LIMIT ?',
      ).all(limit) as Record<string, unknown>[];
    }

    return emails.map((e) => {
      const ctx: EmailContext = {
        messageId: String(e.message_id),
        threadId: e.thread_id ? String(e.thread_id) : undefined,
        account: String(e.account),
        subject: String(e.subject || ''),
        sender: String(e.sender || ''),
        snippet: String(e.snippet || ''),
        label: String(e.corrected_label || e.label_applied || ''),
        confidence: String(e.confidence || 'low'),
        internalDateMs: Number(e.internal_date_ms) || 0,
        correctedByUser: !!e.corrected_label,
      };

      const condResults = conditions.map((cond) => {
        const passed = this.matchSingleCondition(cond, ctx);
        return { type: cond.type, value: cond.value, passed };
      });

      const matched = condResults.length === 0 || condResults.every(c => c.passed);

      return {
        email: { subject: ctx.subject, sender: ctx.sender, label: ctx.label },
        matched,
        conditions: condResults,
      };
    });
  }

  private matchSingleCondition(cond: Condition, email: EmailContext): boolean {
    switch (cond.type) {
      case 'label_is': return email.label === cond.value;
      case 'label_is_not': return email.label !== cond.value;
      case 'confidence_gte': return confidenceRank(email.confidence) >= confidenceRank(cond.value);
      case 'confidence_lt': return confidenceRank(email.confidence) < confidenceRank(cond.value);
      case 'sender_domain': return email.sender.includes('@' + cond.value);
      case 'has_attachment': return true;
      case 'age_minutes_lt': return (Date.now() - email.internalDateMs) / 60000 < Number(cond.value);
      case 'age_minutes_gt': return (Date.now() - email.internalDateMs) / 60000 > Number(cond.value);
      case 'corrected_by_user': return email.correctedByUser === (cond.value === 'true');
      case 'rule_not_executed': {
        const rid = Number(cond.value);
        const existing = this.db.prepare(
          'SELECT 1 FROM email_rule_executions WHERE rule_id = ? AND message_id = ? AND result = ? LIMIT 1',
        ).get(rid, email.messageId, 'ok');
        return !existing;
      }
      case 'thread_state': {
        // Sync: cache-only lookup for testRule (no API fetch)
        if (!email.threadId) return false;
        const cached = this.db.prepare(
          "SELECT thread_state FROM thread_state_cache WHERE thread_id = ? AND account = ?",
        ).get(email.threadId, email.account) as { thread_state: string } | undefined;
        return cached ? cached.thread_state === cond.value : false;
      }
      case 'label_in': {
        const labels = cond.value.split(',').map(l => l.trim());
        return labels.includes(email.label);
      }
      case 'unanswered_age_minutes_gt': {
        if (!email.threadId) return false;
        const usRow = this.db.prepare(
          "SELECT first_seen_at FROM unanswered_state WHERE thread_id = ? AND account = ? AND state = 'unanswered'",
        ).get(email.threadId, email.account) as { first_seen_at: string } | undefined;
        if (!usRow) return false;
        const ageMs = Date.now() - new Date(usRow.first_seen_at + 'Z').getTime();
        return ageMs / 60000 > Number(cond.value);
      }
      case 'state_is_not': {
        if (!email.threadId) return true;
        const usRow2 = this.db.prepare(
          'SELECT state FROM unanswered_state WHERE thread_id = ? AND account = ?',
        ).get(email.threadId, email.account) as { state: string } | undefined;
        return !usRow2 || usRow2.state !== cond.value;
      }
      default: return true;
    }
  }

  // ---------- Cleanup ----------

  private cleanupOldExecutions(): void {
    this.db.prepare("DELETE FROM email_rule_executions WHERE executed_at < datetime('now', '-30 days')").run();
    this.db.prepare("DELETE FROM thread_state_cache WHERE fetched_at < datetime('now', '-7 days')").run();
  }
}

/**
 * Telegram LinkedIn control handlers.
 * Provides deterministic list + action commands so users can drive LinkedIn
 * workflows from Telegram without relying on free-form tool prompting.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Bot, Context } from 'grammy';
import { SettingsManager } from '../../../settings';
import { withTyping } from '../utils/typing';
import { markLinkedInControlSource, rebalancePendingSchedules } from '../../../tools/linkedin-autoposter';

type LinkedInPanel = 'queue' | 'drafted' | 'scheduled' | 'all';

type LinkedInListRow = {
  id: number;
  author: string;
  text_preview: string;
  reactions: number;
  comments: number;
  post_type: string | null;
  comment_draft: string | null;
  approved: number;
  scheduled_at: string | null;
  commented: number;
  image_count?: number | null;
  full_post_summary?: string | null;
};

type LinkedInListContext = {
  panel: LinkedInPanel;
  ids: number[];
  createdAt: number;
};

type LinkedInListContextMap = Record<string, LinkedInListContext>;

const LIST_CONTEXT_KEY = 'telegram.linkedin.listContext';
const LIST_COMMANDS = ['li', 'linkedin'];
const DRAFT_COMMANDS = ['lidraft', 'linkedin_draft'];
const APPROVE_COMMANDS = ['liapprove', 'linkedin_approve'];
const REJECT_COMMANDS = ['lireject', 'linkedin_reject'];
const SCHEDULE_COMMANDS = ['lischedule', 'linkedin_schedule'];
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

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
  return '';
}

function getDb(): Database.Database | null {
  const dbPath = getDbPath();
  if (!dbPath) return null;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function normalizeText(raw: string): string {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTwoSentenceSummary(raw: string): string {
  const text = normalizeText(raw);
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentences = flat
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(Boolean);

  const selected: string[] = [];
  for (const sentence of sentences) {
    if (sentence.split(/\s+/).length < 5) continue;
    selected.push(sentence);
    if (selected.length >= 2) break;
  }
  if (selected.length >= 2) return selected.join(' ');
  if (selected.length === 1) return selected[0];
  const words = flat.split(/\s+/).slice(0, 24);
  return `${words.join(' ')}${flat.split(/\s+/).length > 24 ? '...' : ''}`;
}

function short(text: string, max = 170): string {
  const clean = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}...`;
}

function normalizeType(raw: string | null | undefined): string {
  const v = String(raw || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!v) return 'unclassified';
  if (v === 'promotion' || v === 'promo') return 'promotional';
  if (v === 'jobposting') return 'job-posting';
  if (v === 'thoughtleadership') return 'thought-leadership';
  if (v === 'personalstory') return 'personal-story';
  if (v === 'summit' || v === 'conference' || v === 'webinar') return 'event';
  return v;
}

function labelType(raw: string | null | undefined): string {
  const key = normalizeType(raw);
  if (key === 'thought-leadership') return 'Thought Leadership';
  if (key === 'personal-story') return 'Personal Story';
  if (key === 'job-posting') return 'Job Posting';
  if (key === 'unclassified') return 'Unclassified';
  return key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function parsePanel(input: string): LinkedInPanel {
  const raw = String(input || '').trim().toLowerCase();
  if (raw === 'queue' || raw === 'drafted' || raw === 'scheduled' || raw === 'all') return raw;
  return 'queue';
}

function fetchPosts(panel: LinkedInPanel, limit = 12): LinkedInListRow[] {
  const db = getDb();
  if (!db) return [];
  try {
    const maxLimit = Math.max(1, Math.min(30, Number.isFinite(limit) ? limit : 12));
    const priorityOrder = `CASE lp.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END`;
    let where = 'lp.hidden = 0 AND lp.commented = 0';
    if (panel === 'queue') {
      where += ` AND (lp.comment_draft IS NULL OR TRIM(lp.comment_draft) = '')
                 AND (lp.approved IS NULL OR lp.approved = 0)
                 AND (lp.scheduled_at IS NULL OR TRIM(lp.scheduled_at) = '')`;
    } else if (panel === 'drafted') {
      where += ` AND lp.comment_draft IS NOT NULL AND TRIM(lp.comment_draft) != ''
                 AND (lp.approved IS NULL OR lp.approved = 0)
                 AND (lp.scheduled_at IS NULL OR TRIM(lp.scheduled_at) = '')`;
    } else if (panel === 'scheduled') {
      where += ` AND lp.approved = 1
                 AND lp.scheduled_at IS NOT NULL AND TRIM(lp.scheduled_at) != ''`;
    }

    return db.prepare(
      `SELECT
         lp.id,
         lp.author,
         lp.text_preview,
         lp.reactions,
         lp.comments,
         lp.post_type,
         lp.comment_draft,
         lp.approved,
         lp.scheduled_at,
         lp.commented,
         lp.image_count,
         pc.summary_text AS full_post_summary
       FROM linkedin_posts lp
       LEFT JOIN linkedin_post_content pc ON pc.post_id = lp.id
       WHERE ${where}
       ORDER BY ${priorityOrder}, (COALESCE(lp.reactions,0) + COALESCE(lp.comments,0)) DESC
       LIMIT ?`
    ).all(maxLimit) as LinkedInListRow[];
  } catch (err) {
    console.warn('[Telegram:LinkedIn] fetchPosts failed:', err);
    return [];
  } finally {
    db.close();
  }
}

function loadListContextMap(): LinkedInListContextMap {
  try {
    const raw = SettingsManager.get(LIST_CONTEXT_KEY) || '{}';
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as LinkedInListContextMap;
  } catch {
    return {};
  }
}

function saveListContextMap(map: LinkedInListContextMap): void {
  SettingsManager.set(LIST_CONTEXT_KEY, JSON.stringify(map));
}

function setListContext(chatId: number, panel: LinkedInPanel, ids: number[]): void {
  const map = loadListContextMap();
  map[String(chatId)] = {
    panel,
    ids: ids.filter(id => Number.isFinite(id) && id > 0),
    createdAt: Date.now(),
  };
  saveListContextMap(map);
}

function getListContext(chatId: number): LinkedInListContext | null {
  const map = loadListContextMap();
  const row = map[String(chatId)];
  if (!row || !Array.isArray(row.ids) || row.ids.length === 0) return null;
  return row;
}

function parseSelectionIndices(raw: string): number[] {
  const text = String(raw || '').toLowerCase();
  if (!text) return [];

  let normalized = text;
  for (const [word, num] of Object.entries(NUMBER_WORDS)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'g'), String(num));
  }

  const out = new Set<number>();
  const rangeMatches = normalized.matchAll(/(\d+)\s*-\s*(\d+)/g);
  for (const m of rangeMatches) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const start = Math.max(1, Math.min(a, b));
    const end = Math.max(1, Math.max(a, b));
    for (let i = start; i <= end; i++) out.add(i);
  }

  const singleMatches = normalized.matchAll(/\b(\d+)\b/g);
  for (const m of singleMatches) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }

  return Array.from(out).sort((a, b) => a - b);
}

function resolveSelection(chatId: number, selector: string): { postIds: number[]; labels: number[]; invalid: number[]; error?: string } {
  const context = getListContext(chatId);
  if (!context) {
    return { postIds: [], labels: [], invalid: [], error: 'No active LinkedIn list context. Run /linkedin first.' };
  }
  const labels = parseSelectionIndices(selector);
  if (labels.length === 0) {
    return { postIds: [], labels: [], invalid: [], error: 'No post numbers found. Example: 1,2,5' };
  }

  const postIds: number[] = [];
  const invalid: number[] = [];
  for (const label of labels) {
    const id = context.ids[label - 1];
    if (!id) invalid.push(label);
    else postIds.push(id);
  }
  if (postIds.length === 0) {
    return { postIds: [], labels, invalid, error: 'Selected numbers are outside the current list.' };
  }
  return { postIds, labels, invalid };
}

function parseScheduleOffsetMinutes(raw: string): number {
  const text = String(raw || '');
  const inMatch = text.match(/\bin\s+(\d{1,4})\b/i);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1440, n));
  }
  const tailMatch = text.match(/(\d{1,4})\s*$/);
  if (tailMatch) {
    const n = parseInt(tailMatch[1], 10);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1440, n));
  }
  return 30;
}

function toDbDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function runDraftAction(chatId: number, selector: string): Promise<string> {
  const sel = resolveSelection(chatId, selector);
  if (sel.error) return sel.error;
  markLinkedInControlSource('telegram');

  const { draftBatch } = await import('../../../tools/linkedin-drafter');
  const result = await draftBatch(sel.postIds, 1);
  if (result.results.length === 0 && result.errors.length === 0) {
    const note = sel.invalid.length ? ` Invalid: ${sel.invalid.join(', ')}.` : '';
    return `Queued ${sel.postIds.length} post(s) behind an active draft job.${note}`;
  }

  const db = getDb();
  if (!db) return 'Draft job completed but database is unavailable for preview.';
  try {
    const rows = db.prepare(
      `SELECT id, author, comment_draft, draft_state
       FROM linkedin_posts
       WHERE id IN (${sel.postIds.map(() => '?').join(',')})`
    ).all(...sel.postIds) as Array<{ id: number; author: string; comment_draft: string | null; draft_state: string | null }>;

    const byId = new Map(rows.map(r => [r.id, r]));
    const lines: string[] = [];
    for (const id of sel.postIds) {
      const row = byId.get(id);
      if (!row) continue;
      if (row.comment_draft) {
        lines.push(`#${id} ${row.author}: ${short(row.comment_draft, 220)}`);
      } else {
        lines.push(`#${id} ${row.author}: ${row.draft_state || 'no draft yet'}`);
      }
    }

    const errLine = result.errors.length > 0 ? `\nIssues: ${result.errors.length}` : '';
    return `Drafted ${result.results.length}/${sel.postIds.length} selected post(s).${errLine}\n\n${lines.join('\n\n')}`;
  } finally {
    db.close();
  }
}

function runApproveAction(chatId: number, selector: string): string {
  const sel = resolveSelection(chatId, selector);
  if (sel.error) return sel.error;
  markLinkedInControlSource('telegram');

  const db = getDb();
  if (!db) return 'Database not available.';
  try {
    const update = db.prepare(
      `UPDATE linkedin_posts
       SET approved = 1
       WHERE id = ? AND comment_draft IS NOT NULL AND TRIM(comment_draft) != ''`
    );
    let approved = 0;
    for (const id of sel.postIds) {
      const res = update.run(id);
      if (res.changes > 0) approved++;
    }
    const invalidNote = sel.invalid.length ? ` Invalid: ${sel.invalid.join(', ')}.` : '';
    return `Approved ${approved}/${sel.postIds.length} selected post(s).${invalidNote}`;
  } finally {
    db.close();
  }
}

function runRejectAction(chatId: number, selector: string): string {
  const sel = resolveSelection(chatId, selector);
  if (sel.error) return sel.error;
  markLinkedInControlSource('telegram');

  const db = getDb();
  if (!db) return 'Database not available.';
  try {
    const update = db.prepare(
      `UPDATE linkedin_posts
       SET comment_draft = NULL,
           kanban_task_id = NULL,
           approved = 0,
           scheduled_at = NULL
       WHERE id = ?`
    );
    let rejected = 0;
    for (const id of sel.postIds) {
      const res = update.run(id);
      if (res.changes > 0) rejected++;
    }
    const invalidNote = sel.invalid.length ? ` Invalid: ${sel.invalid.join(', ')}.` : '';
    return `Rejected/cleared ${rejected}/${sel.postIds.length} selected post(s).${invalidNote}`;
  } finally {
    db.close();
  }
}

function runScheduleAction(chatId: number, selector: string, offsetMinutes: number): string {
  const sel = resolveSelection(chatId, selector);
  if (sel.error) return sel.error;
  markLinkedInControlSource('telegram');

  const db = getDb();
  if (!db) return 'Database not available.';
  try {
    const rowById = db.prepare(
      `SELECT id, author, comment_draft FROM linkedin_posts WHERE id = ?`
    );
    const update = db.prepare(
      `UPDATE linkedin_posts
       SET approved = 1,
           scheduled_at = ?
       WHERE id = ?`
    );

    const nowMs = Date.now();
    let cursor = nowMs + (Math.max(0, offsetMinutes) * 60 * 1000);
    const scheduled: Array<{ id: number; author: string; at: string }> = [];
    for (const id of sel.postIds) {
      const row = rowById.get(id) as { id: number; author: string; comment_draft: string | null } | undefined;
      if (!row || !row.comment_draft || !row.comment_draft.trim()) continue;
      const spacingMin = 6 + Math.floor(Math.random() * 6);
      if (scheduled.length > 0) cursor += spacingMin * 60 * 1000;
      const at = toDbDate(cursor);
      update.run(at, id);
      scheduled.push({ id, author: row.author, at });
    }

    const rebalance = rebalancePendingSchedules();
    const lines = scheduled.map(s => `#${s.id} ${s.author} -> ${s.at}`).join('\n');
    const invalidNote = sel.invalid.length ? ` Invalid: ${sel.invalid.join(', ')}.` : '';
    const rebalanceNote = rebalance.adjusted > 0
      ? ` Rebalanced ${rebalance.adjusted}/${rebalance.total}.`
      : '';
    if (scheduled.length === 0) {
      return `No selected posts had drafts to schedule.${invalidNote}`;
    }
    return `Scheduled ${scheduled.length}/${sel.postIds.length} selected post(s).${invalidNote}${rebalanceNote}\n\n${lines}`;
  } finally {
    db.close();
  }
}

function parseLiCommandArgs(text: string): { panel: LinkedInPanel; limit: number } {
  const args = String(text || '').trim().split(/\s+/).filter(Boolean);
  const panel = parsePanel(args[0] || 'queue');
  const rawLimit = parseInt(args[1] || '12', 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(30, rawLimit)) : 12;
  return { panel, limit };
}

function stripSlashCommand(text: string): string {
  return String(text || '').replace(/^\/\S+\s*/i, '').trim();
}

function formatListReply(rows: LinkedInListRow[], panel: LinkedInPanel): string {
  const uniqueAuthors = new Set(rows.map(r => String(r.author || '').trim()).filter(Boolean));
  const totalReacts = rows.reduce((acc, r) => acc + Number(r.reactions || 0), 0);
  const totalComments = rows.reduce((acc, r) => acc + Number(r.comments || 0), 0);

  const header = `LinkedIn ${panel.toUpperCase()} (${rows.length})\nAuthors: ${uniqueAuthors.size} | Reacts: ${totalReacts} | Comments: ${totalComments}`;
  const lines = rows.map((row, i) => {
    const summary = short(row.full_post_summary || buildTwoSentenceSummary(row.text_preview || ''), 150);
    const imageFlag = Number(row.image_count || 0) > 0 ? ' | image' : '';
    return `${i + 1}. [${row.reactions || 0}r/${row.comments || 0}c] ${row.author}\n   ${summary}\n   ${labelType(row.post_type)}${imageFlag}`;
  });

  const hint =
    `\nUse numbers from this list:\n` +
    `- draft one, two and five (or /linkedin_draft 1,2,5)\n` +
    `- /linkedin_approve 1,2,5\n` +
    `- /linkedin_schedule 1,2,5 in 45\n` +
    `- /linkedin_reject 3`;

  return `${header}\n\n${lines.join('\n\n')}${hint}`;
}

export function registerLinkedInTelegramHandlers(
  bot: Bot,
  sendResponse: (ctx: Context, text: string) => Promise<void>,
): void {
  const onList = async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const rawArgs = stripSlashCommand(ctx.message?.text || '');
    const { panel, limit } = parseLiCommandArgs(rawArgs);
    markLinkedInControlSource('telegram');

    const rows = await withTyping(ctx, async () => fetchPosts(panel, limit));
    if (rows.length === 0) {
      await ctx.reply(`No LinkedIn posts found for panel "${panel}". Try /linkedin all`);
      return;
    }

    setListContext(chatId, panel, rows.map(r => Number(r.id)).filter(id => Number.isFinite(id) && id > 0));
    await sendResponse(ctx, formatListReply(rows, panel));
  };

  const onDraft = async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const selector = stripSlashCommand(ctx.message?.text || '');
    const reply = await withTyping(ctx, async () => runDraftAction(chatId, selector));
    await sendResponse(ctx, reply);
  };

  const onApprove = async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const selector = stripSlashCommand(ctx.message?.text || '');
    const reply = runApproveAction(chatId, selector);
    await ctx.reply(reply);
  };

  const onReject = async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const selector = stripSlashCommand(ctx.message?.text || '');
    const reply = runRejectAction(chatId, selector);
    await ctx.reply(reply);
  };

  const onSchedule = async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const raw = stripSlashCommand(ctx.message?.text || '');
    const offset = parseScheduleOffsetMinutes(raw);
    const reply = runScheduleAction(chatId, raw, offset);
    await sendResponse(ctx, reply);
  };

  for (const command of LIST_COMMANDS) bot.command(command, onList);
  for (const command of DRAFT_COMMANDS) bot.command(command, onDraft);
  for (const command of APPROVE_COMMANDS) bot.command(command, onApprove);
  for (const command of REJECT_COMMANDS) bot.command(command, onReject);
  for (const command of SCHEDULE_COMMANDS) bot.command(command, onSchedule);
}

export async function tryHandleLinkedInNaturalAction(
  ctx: Context,
  message: string,
  sendResponse: (ctx: Context, text: string) => Promise<void>,
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const text = String(message || '').trim();
  if (!text || text.startsWith('/')) return false;

  const normalized = text.toLowerCase();
  if (!/^(draft|approve|reject|schedule)\b/.test(normalized)) return false;

  const action = normalized.split(/\s+/)[0];
  const payload = text.slice(action.length).trim();
  if (!payload) return false;

  // Only treat natural action text as LinkedIn control when a recent list context exists.
  // Otherwise let normal agent chat handle messages like "draft strategy for ...".
  if (!getListContext(chatId)) return false;

  let reply = '';
  if (action === 'draft') {
    reply = await withTyping(ctx, async () => runDraftAction(chatId, payload));
  } else if (action === 'approve') {
    reply = runApproveAction(chatId, payload);
  } else if (action === 'reject') {
    reply = runRejectAction(chatId, payload);
  } else if (action === 'schedule') {
    const offset = parseScheduleOffsetMinutes(payload);
    reply = runScheduleAction(chatId, payload, offset);
  }

  if (!reply) return false;
  await sendResponse(ctx, reply);
  return true;
}

/**
 * LinkedIn Auto-Post Daemon
 *
 * Posts approved+scheduled drafts automatically, enforces daily limits,
 * author frequency caps, and rate limiting. Runs on a 60s interval
 * managed by the scheduler.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SettingsManager } from '../settings';
import { linkedinExec } from './linkedin-wrapper';
import { KanbanService } from '../kanban';
import type { TelegramBot } from '../channels/telegram';

// Module state
let telegramBot: TelegramBot | null = null;
let cachedDailyLimit: number | null = null;
let cachedLimitDay: string | null = null;
let autoPosterRunInFlight = false;

export function setLinkedInTelegramBot(bot: TelegramBot | null): void {
  telegramBot = bot;
}

function getDb(): Database.Database | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const db = new Database(p);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      return db;
    }
  }
  return null;
}

function today(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseHm(hm: string, fallback: number): number {
  const match = String(hm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const h = Math.min(23, Math.max(0, parseInt(match[1], 10)));
  const m = Math.min(59, Math.max(0, parseInt(match[2], 10)));
  return h * 60 + m;
}

function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function isInWindow(currentMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true; // full day
  if (startMin < endMin) return currentMin >= startMin && currentMin < endMin;
  return currentMin >= startMin || currentMin < endMin; // overnight wrap
}

function activePostingWindow(): { name: 'day' | 'night'; intervalMs: number } | null {
  const minuteNow = nowMinutes();
  const dayEnabled = SettingsManager.get('linkedin.dayWindowEnabled') !== 'false';
  const nightEnabled = SettingsManager.get('linkedin.nightWindowEnabled') === 'true';

  const dayStart = parseHm(SettingsManager.get('linkedin.dayWindowStart') || '09:00', 9 * 60);
  const dayEnd = parseHm(SettingsManager.get('linkedin.dayWindowEnd') || '18:00', 18 * 60);
  const nightStart = parseHm(SettingsManager.get('linkedin.nightWindowStart') || '22:00', 22 * 60);
  const nightEnd = parseHm(SettingsManager.get('linkedin.nightWindowEnd') || '06:00', 6 * 60);

  const dayIntervalMin = Math.max(1, parseInt(SettingsManager.get('linkedin.dayWindowIntervalMin') || '45', 10) || 45);
  const nightIntervalMin = Math.max(1, parseInt(SettingsManager.get('linkedin.nightWindowIntervalMin') || '120', 10) || 120);

  if (dayEnabled && isInWindow(minuteNow, dayStart, dayEnd)) {
    return { name: 'day', intervalMs: dayIntervalMin * 60 * 1000 };
  }
  if (nightEnabled && isInWindow(minuteNow, nightStart, nightEnd)) {
    return { name: 'night', intervalMs: nightIntervalMin * 60 * 1000 };
  }
  return null;
}

function getDailyLimit(): number {
  const d = today();
  if (cachedLimitDay === d && cachedDailyLimit !== null) return cachedDailyLimit;
  const min = Math.max(1, parseInt(SettingsManager.get('linkedin.dailyLimitMin') || '8', 10) || 8);
  const max = Math.max(min, parseInt(SettingsManager.get('linkedin.dailyLimitMax') || '18', 10) || 18);
  cachedDailyLimit = min + Math.floor(Math.random() * (max - min + 1));
  cachedLimitDay = d;
  return cachedDailyLimit;
}

function getCommentDelayMs(): number {
  const baseMin = parseFloat(SettingsManager.get('linkedin.commentDelay') || '3') || 3;
  const jitter = 1.0 + Math.random() * 0.4; // 1.0-1.4
  return baseMin * 60 * 1000 * jitter;
}

function getBaseCommentDelayMs(): number {
  const baseMin = parseFloat(SettingsManager.get('linkedin.commentDelay') || '3') || 3;
  return Math.max(60_000, Math.round(baseMin * 60_000));
}

function toDbDateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function parseDbDateTime(value: string | null | undefined): number {
  if (!value) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  const normalized = raw.includes('Z') ? raw : `${raw}Z`;
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : NaN;
}

type PostingWindows = {
  dayEnabled: boolean;
  nightEnabled: boolean;
  dayStart: number;
  dayEnd: number;
  nightStart: number;
  nightEnd: number;
};

function getPostingWindows(): PostingWindows {
  return {
    dayEnabled: SettingsManager.get('linkedin.dayWindowEnabled') !== 'false',
    nightEnabled: SettingsManager.get('linkedin.nightWindowEnabled') === 'true',
    dayStart: parseHm(SettingsManager.get('linkedin.dayWindowStart') || '09:00', 9 * 60),
    dayEnd: parseHm(SettingsManager.get('linkedin.dayWindowEnd') || '18:00', 18 * 60),
    nightStart: parseHm(SettingsManager.get('linkedin.nightWindowStart') || '22:00', 22 * 60),
    nightEnd: parseHm(SettingsManager.get('linkedin.nightWindowEnd') || '06:00', 6 * 60),
  };
}

function hasAnyPostingWindow(windows: PostingWindows): boolean {
  return windows.dayEnabled || windows.nightEnabled;
}

function isWithinPostingWindowMs(tsMs: number, windows: PostingWindows): boolean {
  const d = new Date(tsMs);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (windows.dayEnabled && isInWindow(minutes, windows.dayStart, windows.dayEnd)) return true;
  if (windows.nightEnabled && isInWindow(minutes, windows.nightStart, windows.nightEnd)) return true;
  return false;
}

function alignToPostingWindowMs(tsMs: number, windows: PostingWindows): number | null {
  if (!hasAnyPostingWindow(windows)) return tsMs;
  const roundedStart = Math.max(0, Math.ceil(tsMs / 60000) * 60000);
  const maxMinutesToScan = 14 * 24 * 60; // two weeks safety cap
  for (let i = 0; i <= maxMinutesToScan; i++) {
    const candidate = roundedStart + i * 60000;
    if (isWithinPostingWindowMs(candidate, windows)) return candidate;
  }
  return null;
}

export interface RebalanceScheduleResult {
  adjusted: number;
  total: number;
  adjustedOthers: number;
  priorityScheduledAt: string | null;
  warning?: string;
}

export function rebalancePendingSchedules(options: { priorityPostId?: number; preferredAt?: string } = {}): RebalanceScheduleResult {
  const db = getDb();
  if (!db) {
    return {
      adjusted: 0,
      total: 0,
      adjustedOthers: 0,
      priorityScheduledAt: null,
      warning: 'Database not available for schedule rebalance',
    };
  }

  try {
    const windows = getPostingWindows();
    if (!hasAnyPostingWindow(windows)) {
      return {
        adjusted: 0,
        total: 0,
        adjustedOthers: 0,
        priorityScheduledAt: null,
        warning: 'Both posting windows are disabled. Enable day and/or night window.',
      };
    }

    const rows = db.prepare(
      `SELECT id, scheduled_at
       FROM linkedin_posts
       WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
         AND scheduled_at IS NOT NULL AND hidden = 0
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, datetime(scheduled_at) ASC`
    ).all(options.priorityPostId || 0) as Array<{ id: number; scheduled_at: string | null }>;

    if (rows.length === 0) {
      return {
        adjusted: 0,
        total: 0,
        adjustedOthers: 0,
        priorityScheduledAt: null,
      };
    }

    const nowFloorMs = Math.max(0, Date.now() + 60_000);
    const minSpacingMs = getBaseCommentDelayMs();
    const preferredMsRaw = parseDbDateTime(options.preferredAt);
    const preferredMs = Number.isFinite(preferredMsRaw) ? preferredMsRaw : NaN;

    const updates: Array<{ id: number; at: string; changed: boolean }> = [];
    let cursorMs = nowFloorMs;
    let warning: string | undefined;

    for (const row of rows) {
      const currentMsRaw = parseDbDateTime(row.scheduled_at);
      const hasCurrent = Number.isFinite(currentMsRaw);
      let candidateMs = hasCurrent ? currentMsRaw : cursorMs;

      if (options.priorityPostId && row.id === options.priorityPostId && Number.isFinite(preferredMs)) {
        candidateMs = Math.max(preferredMs, nowFloorMs);
      }

      if (candidateMs < cursorMs) candidateMs = cursorMs;

      let alignedMs = alignToPostingWindowMs(candidateMs, windows);
      if (alignedMs === null) {
        warning = 'Could not find an allowed posting window for pending posts.';
        break;
      }

      if (alignedMs < cursorMs) {
        const alignedCursor = alignToPostingWindowMs(cursorMs, windows);
        if (alignedCursor === null) {
          warning = 'Could not align pending posts into enabled posting windows.';
          break;
        }
        alignedMs = alignedCursor;
      }

      const nextCursor = alignToPostingWindowMs(alignedMs + minSpacingMs, windows);
      if (nextCursor === null) {
        warning = 'Could not compute safe spacing in posting windows.';
        break;
      }

      const changed = !hasCurrent || Math.abs(alignedMs - currentMsRaw) >= 30_000;
      updates.push({ id: row.id, at: toDbDateTime(alignedMs), changed });
      cursorMs = nextCursor;
    }

    const updateStmt = db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const u of updates) {
        if (u.changed) updateStmt.run(u.at, u.id);
      }
    });
    tx();

    let priorityScheduledAt: string | null = null;
    if (options.priorityPostId) {
      const row = db.prepare('SELECT scheduled_at FROM linkedin_posts WHERE id = ?')
        .get(options.priorityPostId) as { scheduled_at: string | null } | undefined;
      priorityScheduledAt = row?.scheduled_at || null;
    }

    const adjusted = updates.filter(u => u.changed).length;
    const adjustedOthers = options.priorityPostId
      ? updates.filter(u => u.changed && u.id !== options.priorityPostId).length
      : adjusted;

    return {
      adjusted,
      total: rows.length,
      adjustedOthers,
      priorityScheduledAt,
      warning,
    };
  } finally {
    db.close();
  }
}

function getLastPostedAtMs(db: Database.Database): number {
  const row = db.prepare(
    `SELECT created_at FROM linkedin_activity_log
     WHERE action = 'posted'
     ORDER BY id DESC LIMIT 1`
  ).get() as { created_at: string } | undefined;

  if (!row?.created_at) return 0;
  const ts = Date.parse(`${row.created_at}Z`);
  return Number.isFinite(ts) ? ts : 0;
}

export async function notifyTelegram(message: string): Promise<void> {
  if (!telegramBot) return;
  try {
    const chatId = SettingsManager.get('telegram.defaultChatId');
    if (chatId) {
      await telegramBot.sendMessage(parseInt(chatId, 10), message);
    }
  } catch (err) {
    console.error('[AutoPoster] Telegram notification failed:', err);
  }
}

export async function checkAndPostNext(): Promise<void> {
  if (SettingsManager.get('linkedin.autoPosterEnabled') !== 'true') return;
  const window = activePostingWindow();
  if (!window) return;
  if (autoPosterRunInFlight) {
    console.log('[AutoPoster] Skip tick: previous run still in progress');
    return;
  }

  const db = getDb();
  if (!db) return;
  autoPosterRunInFlight = true;

  try {
    const dailyLimit = getDailyLimit();
    const todayStr = today();

    // Count today's posts
    const countRow = db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_activity_log
       WHERE action = 'posted' AND date(created_at, 'localtime') = ?`
    ).get(todayStr) as { c: number };
    const todayCount = countRow.c;

    if (todayCount >= dailyLimit) {
      // Reschedule remaining posts to tomorrow or night window
      const remaining = db.prepare(
        `SELECT id, author FROM linkedin_posts
         WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
           AND scheduled_at IS NOT NULL AND hidden = 0
         ORDER BY scheduled_at ASC`
      ).all() as Array<{ id: number; author: string }>;

      if (remaining.length > 0) {
        const nightEnabled = SettingsManager.get('linkedin.nightWindowEnabled') === 'true';
        const nightStart = SettingsManager.get('linkedin.nightWindowStart') || '22:00';
        const [nh, nm] = nightStart.split(':').map(Number);

        const update = db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?');
        const tx = db.transaction(() => {
          let cumulativeMs = 0;
          for (const post of remaining) {
            const spacingMin = 3 + Math.random() * 5;
            const jitterSec = 10 + Math.floor(Math.random() * 61);
            cumulativeMs += spacingMin * 60000 + jitterSec * 1000;

            let baseTime: Date;
            if (nightEnabled) {
              // Move to tonight's night window
              baseTime = new Date();
              baseTime.setHours(nh, nm, 0, 0);
              if (baseTime.getTime() < Date.now()) baseTime.setDate(baseTime.getDate() + 1);
            } else {
              // Move to tomorrow 09:00
              baseTime = new Date();
              baseTime.setDate(baseTime.getDate() + 1);
              baseTime.setHours(9, 0, 0, 0);
            }
            const newTime = new Date(baseTime.getTime() + cumulativeMs).toISOString().replace('T', ' ').slice(0, 19);
            update.run(newTime, post.id);
          }
        });
        tx();

        const target = nightEnabled ? `tonight's night window (${nightStart})` : 'tomorrow 09:00';
        notifyTelegram(`LinkedIn: Daily limit reached (${todayCount}/${dailyLimit}). ${remaining.length} posts moved to ${target}.`).catch(() => {});
        console.log(`[AutoPoster] Daily limit ${dailyLimit} reached. Rescheduled ${remaining.length} posts to ${target}`);
      }
      return;
    }

    // Rate limit check
    const lastPostedAt = getLastPostedAtMs(db);
    if (lastPostedAt > 0) {
      const elapsed = Date.now() - lastPostedAt;
      const requiredDelay = Math.max(getCommentDelayMs(), window.intervalMs);
      if (elapsed < requiredDelay) return;
    }

    // Find next eligible post
    const priorityOrder = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END`;
    const candidates = db.prepare(
      `SELECT id, post_url, author, comment_draft, reactions, comments, kanban_task_id FROM linkedin_posts
       WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
         AND scheduled_at IS NOT NULL AND datetime(scheduled_at) <= datetime('now')
         AND hidden = 0
       ORDER BY ${priorityOrder}, scheduled_at ASC
       LIMIT 10`
    ).all() as Array<{ id: number; post_url: string; author: string; comment_draft: string; reactions: number; comments: number; kanban_task_id: number | null }>;

    if (candidates.length === 0) return;

    const maxPerWeek = parseInt(SettingsManager.get('linkedin.authorMaxCommentsPerWeek') || '2', 10) || 2;

    for (const post of candidates) {
      // URL-level duplicate guard across legacy duplicate rows / failed previous updates.
      // If we ever posted this URL before, mark all matching rows as commented and skip.
      const alreadyPosted = db.prepare(
        `SELECT 1 as ok FROM linkedin_activity_log
         WHERE action = 'posted' AND post_url = ?
         LIMIT 1`
      ).get(post.post_url) as { ok: number } | undefined;
      if (alreadyPosted?.ok) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, scheduled_at = NULL WHERE post_url = ?').run(post.post_url);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'skipped', 'duplicate_post_guard', ?, ?)`
        ).run(post.id, post.post_url, dailyLimit, todayCount);
        console.log(`[AutoPoster] Duplicate guard skipped already-posted URL: ${post.post_url}`);
        continue;
      }

      // Author limit check
      const authorCount = db.prepare(
        `SELECT COUNT(*) as c FROM linkedin_activity_log
         WHERE action = 'posted' AND post_url IN (SELECT post_url FROM linkedin_posts WHERE author = ?)
         AND created_at >= datetime('now', '-7 days')`
      ).get(post.author) as { c: number };

      if (authorCount.c >= maxPerWeek) {
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'skipped', 'author_limit', ?, ?)`
        ).run(post.id, post.post_url, dailyLimit, todayCount);
        continue;
      }

      // Claim atomically: only one runner should be able to claim this scheduled row.
      const claim = db.prepare(
        `UPDATE linkedin_posts
         SET scheduled_at = NULL
         WHERE id = ?
           AND approved = 1
           AND commented = 0
           AND comment_draft IS NOT NULL
           AND scheduled_at IS NOT NULL
           AND hidden = 0`
      ).run(post.id);
      if (claim.changes === 0) {
        continue;
      }

      // Post the comment — single attempt, no blind retry (prevents double-posting)
      let posted = false;
      try {
        await linkedinExec('reply', ['--url', post.post_url, '--comment', post.comment_draft, '--no-confirm'], 120000);
        posted = true;
      } catch (err) {
        console.error(`[AutoPoster] Posting failed for ${post.author}:`, err);
        // Check if "Comment posted successfully" appears in stdout (timeout after submit)
        const errMsg = String((err as Error & { stdout?: string }).stdout || '');
        if (errMsg.includes('Comment posted successfully')) {
          console.log(`[AutoPoster] Comment was actually posted despite timeout for ${post.author}`);
          posted = true;
        }
      }

      if (posted) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, scheduled_at = NULL WHERE post_url = ?').run(post.post_url);

        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, comment_text, daily_limit, daily_count)
           VALUES (?, ?, 'posted', ?, ?, ?, ?)`
        ).run(post.id, post.post_url, `window:${window.name}`, post.comment_draft, dailyLimit, todayCount + 1);

        scheduleEngagementCheck(db, post.id, post.post_url, post.reactions, post.comments);

        if (post.kanban_task_id) {
          try {
            KanbanService.moveTask(post.kanban_task_id, 'done', 'linkedin-autoposter');
          } catch { /* task may be missing/archived */ }
        }

        await notifyTelegram(`LinkedIn: Posted on ${post.author}'s post (${todayCount + 1}/${dailyLimit} today)`);
        console.log(`[AutoPoster] Posted comment on ${post.author}'s post (${todayCount + 1}/${dailyLimit})`);
      } else {
        // Reschedule 5-10 min later instead of giving up
        const retryMin = 5 + Math.floor(Math.random() * 6); // 5-10 min
        const retryAt = new Date(Date.now() + retryMin * 60000).toISOString().replace('T', ' ').slice(0, 19);
        db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?').run(retryAt, post.id);

        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'retry_scheduled', ?, ?, ?)`
        ).run(post.id, post.post_url, `timeout_retry_at_${retryAt}`, dailyLimit, todayCount);

        await notifyTelegram(`LinkedIn: Posting on ${post.author}'s post timed out. Auto-retrying at ${retryAt.slice(11, 16)}.`);
        console.log(`[AutoPoster] Timed out on ${post.author}, rescheduled to ${retryAt}`);
      }
      return; // One post per tick
    }
  } finally {
    db.close();
    autoPosterRunInFlight = false;
  }
}

export function scheduleEngagementCheck(
  db: Database.Database,
  postId: number,
  postUrl: string,
  reactions: number,
  comments: number,
): void {
  // Record baseline
  db.prepare(
    `INSERT INTO linkedin_engagement_checks (post_id, post_url, reactions, comments_count, baseline)
     VALUES (?, ?, ?, ?, 1)`
  ).run(postId, postUrl, reactions, comments);

  // Set check due 24-48h from now
  const hoursOffset = 24 + Math.random() * 24;
  const dueDate = new Date(Date.now() + hoursOffset * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `UPDATE linkedin_posts SET baseline_reactions = ?, baseline_comments = ?, engagement_check_due = ? WHERE id = ?`
  ).run(reactions, comments, dueDate, postId);
}

export async function checkDueEngagement(): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    const due = db.prepare(
      `SELECT id, post_url, author, baseline_reactions, baseline_comments FROM linkedin_posts
       WHERE commented = 1 AND engagement_check_due IS NOT NULL
         AND datetime(engagement_check_due) <= datetime('now')
         AND engagement_checked = 0
       LIMIT 5`
    ).all() as Array<{ id: number; post_url: string; author: string; baseline_reactions: number | null; baseline_comments: number | null }>;

    for (const post of due) {
      try {
        const result = await linkedinExec('engagement', ['--url', post.post_url], 60000);
        const data = JSON.parse(result) as { reactions: number; comments: number };

        const reactionsDelta = data.reactions - (post.baseline_reactions || 0);
        const commentsDelta = data.comments - (post.baseline_comments || 0);

        db.prepare(
          `INSERT INTO linkedin_engagement_checks (post_id, post_url, reactions, comments_count, reactions_delta, comments_delta)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(post.id, post.post_url, data.reactions, data.comments, reactionsDelta, commentsDelta);

        db.prepare('UPDATE linkedin_posts SET engagement_checked = 1 WHERE id = ?').run(post.id);

        if (reactionsDelta >= 5 || commentsDelta >= 2) {
          await notifyTelegram(`LinkedIn: +${reactionsDelta} reactions, +${commentsDelta} comments on ${post.author}'s post since your comment`);
        }

        console.log(`[AutoPoster] Engagement check for ${post.author}: +${reactionsDelta}r +${commentsDelta}c`);
      } catch (err) {
        console.error(`[AutoPoster] Engagement check failed for post ${post.id}:`, err);
        // Mark as checked to avoid infinite retries
        db.prepare('UPDATE linkedin_posts SET engagement_checked = 1 WHERE id = ?').run(post.id);
      }

      // Random delay between checks (5-15s)
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));
    }
  } finally {
    db.close();
  }
}

export function syncAuthorsFromPosts(): void {
  const db = getDb();
  if (!db) return;

  try {
    const authors = db.prepare(
      `SELECT author, COUNT(*) as total_seen,
         SUM(CASE WHEN commented = 1 THEN 1 ELSE 0 END) as total_commented,
         MAX(CASE WHEN commented = 1 THEN scraped_date ELSE NULL END) as last_commented
       FROM linkedin_posts WHERE author != 'Unknown' GROUP BY author`
    ).all() as Array<{ author: string; total_seen: number; total_commented: number; last_commented: string | null }>;

    const upsert = db.prepare(
      `INSERT INTO linkedin_authors (name, total_posts_seen, total_comments_by_me, last_commented_date, last_seen)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         total_posts_seen = excluded.total_posts_seen,
         total_comments_by_me = excluded.total_comments_by_me,
         last_commented_date = COALESCE(excluded.last_commented_date, linkedin_authors.last_commented_date),
         last_seen = datetime('now')`
    );

    const tx = db.transaction(() => {
      for (const a of authors) {
        upsert.run(a.author, a.total_seen, a.total_commented, a.last_commented);
      }
    });
    tx();

    console.log(`[AutoPoster] Synced ${authors.length} authors`);
  } finally {
    db.close();
  }
}

export function rescheduleStalePosts(): number {
  const db = getDb();
  if (!db) return 0;

  try {
    const stale = db.prepare(
      `SELECT id, author FROM linkedin_posts
       WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
         AND scheduled_at IS NOT NULL AND datetime(scheduled_at) < datetime('now')
         AND hidden = 0
       ORDER BY scheduled_at ASC`
    ).all() as Array<{ id: number; author: string }>;

    if (stale.length === 0) return 0;

    const update = db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?');
    const tx = db.transaction(() => {
      let cumulativeMs = 0;
      for (const post of stale) {
        // Random 3-8 min spacing between each post
        const spacingMin = 3 + Math.random() * 5;
        // Plus 10-70s jitter
        const jitterSec = 10 + Math.floor(Math.random() * 61);
        cumulativeMs += spacingMin * 60000 + jitterSec * 1000;
        const newTime = new Date(Date.now() + cumulativeMs).toISOString().replace('T', ' ').slice(0, 19);
        update.run(newTime, post.id);
      }
    });
    tx();

    console.log(`[AutoPoster] Rescheduled ${stale.length} stale posts with random intervals`);
    return stale.length;
  } finally {
    db.close();
  }
}

export function getDailyStats(): { postedToday: number; dailyLimit: number; pendingApproved: number } {
  const db = getDb();
  if (!db) return { postedToday: 0, dailyLimit: getDailyLimit(), pendingApproved: 0 };

  try {
    const todayStr = today();
    const posted = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_activity_log
       WHERE action = 'posted' AND date(created_at, 'localtime') = ?`
    ).get(todayStr) as { c: number }).c;

    const pending = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_posts WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL AND hidden = 0`
    ).get() as { c: number }).c;

    return { postedToday: posted, dailyLimit: getDailyLimit(), pendingApproved: pending };
  } finally {
    db.close();
  }
}

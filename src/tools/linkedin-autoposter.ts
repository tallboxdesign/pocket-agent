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
import type { TelegramBot } from '../channels/telegram';

// Module state
let telegramBot: TelegramBot | null = null;
let cachedDailyLimit: number | null = null;
let cachedLimitDay: string | null = null;

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
  return new Date().toISOString().slice(0, 10);
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
  const jitter = 0.6 + Math.random() * 0.8; // 0.6-1.4
  return baseMin * 60 * 1000 * jitter;
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

  const db = getDb();
  if (!db) return;

  try {
    const dailyLimit = getDailyLimit();
    const todayStr = today();

    // Count today's posts
    const countRow = db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_activity_log WHERE action = 'posted' AND date(created_at) = ?`
    ).get(todayStr) as { c: number };
    const todayCount = countRow.c;

    if (todayCount >= dailyLimit) return;

    // Rate limit check
    const lastPosted = db.prepare(
      `SELECT created_at FROM linkedin_activity_log WHERE action = 'posted' ORDER BY id DESC LIMIT 1`
    ).get() as { created_at: string } | undefined;

    if (lastPosted) {
      const elapsed = Date.now() - new Date(lastPosted.created_at + 'Z').getTime();
      if (elapsed < getCommentDelayMs()) return;
    }

    // Find next eligible post
    const priorityOrder = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END`;
    const candidates = db.prepare(
      `SELECT id, post_url, author, comment_draft, reactions, comments FROM linkedin_posts
       WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
         AND scheduled_at IS NOT NULL AND datetime(scheduled_at) <= datetime('now')
         AND hidden = 0
       ORDER BY ${priorityOrder}, scheduled_at ASC
       LIMIT 10`
    ).all() as Array<{ id: number; post_url: string; author: string; comment_draft: string; reactions: number; comments: number }>;

    if (candidates.length === 0) return;

    const maxPerWeek = parseInt(SettingsManager.get('linkedin.authorMaxCommentsPerWeek') || '2', 10) || 2;

    for (const post of candidates) {
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

      // Post the comment
      try {
        await linkedinExec('reply', ['--url', post.post_url, '--comment', post.comment_draft, '--no-confirm'], 90000);

        db.prepare('UPDATE linkedin_posts SET commented = 1, scheduled_at = NULL WHERE id = ?').run(post.id);

        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, comment_text, daily_limit, daily_count)
           VALUES (?, ?, 'posted', ?, ?, ?)`
        ).run(post.id, post.post_url, post.comment_draft, dailyLimit, todayCount + 1);

        // Schedule engagement check
        scheduleEngagementCheck(db, post.id, post.post_url, post.reactions, post.comments);

        // Telegram notification
        await notifyTelegram(`LinkedIn: Posted on ${post.author}'s post (${todayCount + 1}/${dailyLimit} today)`);

        console.log(`[AutoPoster] Posted comment on ${post.author}'s post (${todayCount + 1}/${dailyLimit})`);
        return; // One post per tick
      } catch (err) {
        console.error(`[AutoPoster] Failed to post on ${post.author}:`, err);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'error', ?, ?, ?)`
        ).run(post.id, post.post_url, String(err), dailyLimit, todayCount);
        return; // Don't try more on error
      }
    }
  } finally {
    db.close();
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

export function getDailyStats(): { postedToday: number; dailyLimit: number; pendingApproved: number } {
  const db = getDb();
  if (!db) return { postedToday: 0, dailyLimit: getDailyLimit(), pendingApproved: 0 };

  try {
    const todayStr = today();
    const posted = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_activity_log WHERE action = 'posted' AND date(created_at) = ?`
    ).get(todayStr) as { c: number }).c;

    const pending = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_posts WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL AND hidden = 0`
    ).get() as { c: number }).c;

    return { postedToday: posted, dailyLimit: getDailyLimit(), pendingApproved: pending };
  } finally {
    db.close();
  }
}

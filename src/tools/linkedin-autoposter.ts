/**
 * LinkedIn Auto-Post Daemon
 *
 * Posts approved+scheduled drafts automatically, enforces daily limits,
 * author frequency caps, and rate limiting. Runs on a 60s interval
 * managed by the scheduler.
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
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
let postedGuardEnsured = false;
const ATTEMPT_GUARD_HOURS = 6;
const DEFAULT_POST_NOW_FIRST_DELAY_SEC = 10;
const DEFAULT_POST_NOW_HOT_COUNT = 5;
const DEFAULT_POST_NOW_HOT_WINDOW_MINUTES = 15;
const DEFAULT_POST_NOW_PRIORITY_COUNT = 10;
const DEFAULT_POST_NOW_PRIORITY_WINDOW_MINUTES = 120;
const LINKEDIN_CONTROL_SOURCE_KEY = 'linkedin.controlSource';
const LINKEDIN_CONTROL_EXPIRES_AT_KEY = 'linkedin.controlExpiresAt';
const LINKEDIN_TELEGRAM_NOTIFY_MODE_KEY = 'linkedin.telegramNotifyMode';

export function setLinkedInTelegramBot(bot: TelegramBot | null): void {
  telegramBot = bot;
}

export function markLinkedInControlSource(source: 'telegram' | 'desktop'): void {
  const normalized = source === 'telegram' ? 'telegram' : 'desktop';
  SettingsManager.set(LINKEDIN_CONTROL_SOURCE_KEY, normalized);
  if (normalized === 'telegram') {
    const ttlRaw = parseInt(SettingsManager.get('linkedin.telegramControlTtlMin') || '240', 10);
    const ttlMin = Number.isFinite(ttlRaw) ? Math.max(5, Math.min(1440, ttlRaw)) : 240;
    const expiresAt = Date.now() + (ttlMin * 60 * 1000);
    SettingsManager.set(LINKEDIN_CONTROL_EXPIRES_AT_KEY, String(expiresAt));
  } else {
    SettingsManager.set(LINKEDIN_CONTROL_EXPIRES_AT_KEY, '0');
  }
}

export function shouldNotifyTelegramForLinkedIn(): boolean {
  const mode = String(SettingsManager.get(LINKEDIN_TELEGRAM_NOTIFY_MODE_KEY) || 'telegram_only')
    .trim()
    .toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'always') return true;

  const source = String(SettingsManager.get(LINKEDIN_CONTROL_SOURCE_KEY) || '').trim().toLowerCase();
  const expiresAt = parseInt(SettingsManager.get(LINKEDIN_CONTROL_EXPIRES_AT_KEY) || '0', 10);
  if (source !== 'telegram') return false;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return Date.now() <= expiresAt;
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
      ensurePostedGuardIndexes(db);
      return db;
    }
  }
  return null;
}

function ensurePostedGuardIndexes(db: Database.Database): void {
  if (postedGuardEnsured) return;
  db.exec(`
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_li_activity_action_post_url ON linkedin_activity_log(action, post_url)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_li_activity_post_id_action ON linkedin_activity_log(post_id, action)`);
  try {
    const duplicatePostedRows = (db.prepare(`
      SELECT COUNT(*) as c
      FROM linkedin_activity_log
      WHERE action = 'posted'
        AND id NOT IN (
          SELECT MIN(id)
          FROM linkedin_activity_log
          WHERE action = 'posted'
          GROUP BY post_url
        )
    `).get() as { c: number } | undefined)?.c || 0;
    if (duplicatePostedRows > 0) {
      db.prepare(`
        UPDATE linkedin_activity_log
        SET action = 'posted_duplicate_legacy',
            reason = CASE
              WHEN reason IS NULL OR trim(reason) = ''
              THEN 'legacy duplicate converted during migration'
              ELSE reason || '; legacy duplicate converted during migration'
            END
        WHERE action = 'posted'
          AND id NOT IN (
            SELECT MIN(id)
            FROM linkedin_activity_log
            WHERE action = 'posted'
            GROUP BY post_url
          )
      `).run();
      console.log(`[AutoPoster] Converted ${duplicatePostedRows} legacy duplicate posted row(s)`);
    }
  } catch (err) {
    console.warn('[AutoPoster] Could not normalize legacy posted duplicates:', err);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_li_posted_once_per_url
    ON linkedin_activity_log(post_url)
    WHERE action = 'posted'
  `);
  postedGuardEnsured = true;
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
  cachedDailyLimit = getDailyLimitForDay(d);
  cachedLimitDay = d;
  return cachedDailyLimit;
}

function getBaseDailyLimitRange(): { min: number; max: number } {
  const hardCap = 50;
  const explicit = parseInt(SettingsManager.get('linkedin.dailyLimit') || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) {
    const value = Math.min(hardCap, Math.max(1, explicit));
    return { min: value, max: value };
  }
  const minRaw = Math.max(1, parseInt(SettingsManager.get('linkedin.dailyLimitMin') || '8', 10) || 8);
  const maxRaw = Math.max(minRaw, parseInt(SettingsManager.get('linkedin.dailyLimitMax') || '15', 10) || 15);
  const min = Math.min(hardCap, minRaw);
  const max = Math.min(hardCap, Math.max(min, maxRaw));
  return { min, max };
}

function getLightDayConfig(): { daysPerWeek: number; min: number; max: number } {
  const hardCap = 50;
  const daysPerWeek = Math.max(0, Math.min(7, parseInt(SettingsManager.get('linkedin.lightDaysPerWeek') || '0', 10) || 0));
  const minRaw = Math.max(1, parseInt(SettingsManager.get('linkedin.lightDayMinPosts') || '10', 10) || 10);
  const maxRaw = Math.max(minRaw, parseInt(SettingsManager.get('linkedin.lightDayMaxPosts') || String(minRaw), 10) || minRaw);
  return {
    daysPerWeek,
    min: Math.min(hardCap, minRaw),
    max: Math.min(hardCap, Math.max(minRaw, maxRaw)),
  };
}

type ManualLightDayConfig = {
  weekday: string;
  min: number;
  max: number;
};

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function normalizeWeekdayKey(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase().slice(0, 3);
  return WEEKDAY_KEYS.includes(normalized as typeof WEEKDAY_KEYS[number]) ? normalized : '';
}

function getManualLightDayConfigs(): ManualLightDayConfig[] {
  const hardCap = 50;
  const readSlot = (index: 1 | 2): ManualLightDayConfig | null => {
    const weekday = normalizeWeekdayKey(SettingsManager.get(`linkedin.lightDay${index}Weekday`) || '');
    if (!weekday) return null;
    const minRaw = Math.max(1, parseInt(SettingsManager.get(`linkedin.lightDay${index}MinPosts`) || '10', 10) || 10);
    const maxRaw = Math.max(minRaw, parseInt(SettingsManager.get(`linkedin.lightDay${index}MaxPosts`) || String(minRaw), 10) || minRaw);
    return {
      weekday,
      min: Math.min(hardCap, minRaw),
      max: Math.min(hardCap, Math.max(minRaw, maxRaw)),
    };
  };

  return [readSlot(1), readSlot(2)].filter((slot): slot is ManualLightDayConfig => Boolean(slot));
}

function hashString32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseLocalDayKey(dayKey: string): Date | null {
  const match = String(dayKey || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function getWeekdayKeyForDay(dayKey: string): string {
  const date = parseLocalDayKey(dayKey);
  if (!date) return '';
  return WEEKDAY_KEYS[date.getDay()] || '';
}

function getIsoWeekSeed(dayKey: string): string {
  const date = parseLocalDayKey(dayKey);
  if (!date) return dayKey;
  const copy = new Date(date);
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day + 3);
  const year = copy.getFullYear();
  const jan4 = new Date(year, 0, 4, 12, 0, 0, 0);
  const jan4Day = (jan4.getDay() + 6) % 7;
  jan4.setDate(jan4.getDate() - jan4Day + 3);
  const week = 1 + Math.round((copy.getTime() - jan4.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function getDeterministicLimitForDay(dayKey: string, min: number, max: number, salt: string): number {
  const normalizedMin = Math.max(1, Math.floor(min));
  const normalizedMax = Math.max(normalizedMin, Math.floor(max));
  if (normalizedMax <= normalizedMin) return normalizedMin;
  const hash = hashString32(`${salt}:${dayKey}`);
  return normalizedMin + (hash % (normalizedMax - normalizedMin + 1));
}

function isLightDay(dayKey: string): boolean {
  const manual = getManualLightDayConfigs();
  if (manual.length > 0) {
    const weekday = getWeekdayKeyForDay(dayKey);
    return manual.some((slot) => slot.weekday === weekday);
  }
  const config = getLightDayConfig();
  if (config.daysPerWeek <= 0) return false;
  const targetDate = parseLocalDayKey(dayKey);
  if (!targetDate) return false;
  const weekSeed = getIsoWeekSeed(dayKey);
  const weekStart = new Date(targetDate);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  weekStart.setHours(12, 0, 0, 0);
  const ranked: Array<{ key: string; score: number }> = [];
  for (let i = 0; i < 7; i++) {
    const candidate = new Date(weekStart);
    candidate.setDate(weekStart.getDate() + i);
    const candidateKey = localDayKeyFromMs(candidate.getTime());
    ranked.push({
      key: candidateKey,
      score: hashString32(`linkedin-light:${weekSeed}:${candidateKey}`),
    });
  }
  ranked.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
  return ranked.slice(0, config.daysPerWeek).some((entry) => entry.key === dayKey);
}

function getDailyLimitForDay(dayKey: string): number {
  const manual = getManualLightDayConfigs();
  if (manual.length > 0) {
    const weekday = getWeekdayKeyForDay(dayKey);
    const manualSlot = manual.find((slot) => slot.weekday === weekday);
    if (manualSlot) {
      return getDeterministicLimitForDay(dayKey, manualSlot.min, manualSlot.max, `linkedin-manual-light:${weekday}`);
    }
    const base = getBaseDailyLimitRange();
    return getDeterministicLimitForDay(dayKey, base.min, base.max, 'linkedin-base-limit');
  }

  const base = getBaseDailyLimitRange();
  if (!isLightDay(dayKey)) {
    return getDeterministicLimitForDay(dayKey, base.min, base.max, 'linkedin-base-limit');
  }
  const light = getLightDayConfig();
  return Math.min(
    getDeterministicLimitForDay(dayKey, base.min, base.max, 'linkedin-base-limit'),
    getDeterministicLimitForDay(dayKey, light.min, light.max, 'linkedin-light-limit'),
  );
}

function getActivePostingMinutesPerLocalDay(windows: PostingWindows): number {
  if (!hasAnyPostingWindow(windows)) return 24 * 60;
  let activeMinutes = 0;
  for (let minute = 0; minute < 24 * 60; minute++) {
    if (windows.dayEnabled && isInWindow(minute, windows.dayStart, windows.dayEnd)) {
      activeMinutes += 1;
      continue;
    }
    if (windows.nightEnabled && isInWindow(minute, windows.nightStart, windows.nightEnd)) {
      activeMinutes += 1;
    }
  }
  return Math.max(1, activeMinutes);
}

function getScheduleDayCap(dayKey: string): number {
  return getDailyLimitForDay(dayKey);
}

function getTargetSpacingForDay(dayKey: string, alignedMs: number, windows: PostingWindows, fallbackMs: number): number {
  if (!isLightDay(dayKey)) {
    return getPostingWindowIntervalMs(alignedMs, windows, fallbackMs);
  }
  const dayCap = getScheduleDayCap(dayKey);
  const activeMinutes = getActivePostingMinutesPerLocalDay(windows);
  const broadSpacingMs = Math.floor((activeMinutes * 60 * 1000) / Math.max(1, dayCap));
  return Math.max(getPostingWindowIntervalMs(alignedMs, windows, fallbackMs), broadSpacingMs);
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

type AuthorPostingPolicy = {
  cooldownHours: number;
  max24h: number;
  max7d: number;
};

type AuthorPostingStats = {
  dailyCount: number;
  weeklyCount: number;
  lastPostedAtMs: number;
  lastPostedAt: string | null;
};

function getAuthorPostingPolicy(): AuthorPostingPolicy {
  return {
    cooldownHours: Math.max(0, parseInt(SettingsManager.get('linkedin.authorCooldownHours') || '6', 10) || 0),
    max24h: Math.max(0, parseInt(SettingsManager.get('linkedin.authorMaxComments24h') || '2', 10) || 0),
    max7d: Math.max(0, parseInt(SettingsManager.get('linkedin.authorMaxComments7d') || '4', 10) || 0),
  };
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

function getAuthorPostingStats(db: Database.Database, author: string): AuthorPostingStats {
  const rows = db.prepare(
    `SELECT al.created_at
     FROM linkedin_activity_log al
     WHERE al.action = 'posted'
       AND al.post_url IN (SELECT lp.post_url FROM linkedin_posts lp WHERE lp.author = ?)
       AND al.created_at >= datetime('now', '-7 days')
     ORDER BY datetime(al.created_at) DESC`
  ).all(author) as Array<{ created_at: string }>;

  const nowMs = Date.now();
  const dayThreshold = nowMs - (24 * 60 * 60 * 1000);
  let dailyCount = 0;
  let lastPostedAtMs = 0;
  let lastPostedAt: string | null = null;

  for (const row of rows) {
    const ts = parseDbDateTime(row.created_at);
    if (!Number.isFinite(ts)) continue;
    if (!lastPostedAtMs) {
      lastPostedAtMs = ts;
      lastPostedAt = row.created_at;
    }
    if (ts >= dayThreshold) dailyCount += 1;
  }

  return {
    dailyCount,
    weeklyCount: rows.length,
    lastPostedAtMs,
    lastPostedAt,
  };
}

function computeAuthorNextEligibleMs(
  db: Database.Database,
  author: string,
  policy: AuthorPostingPolicy,
): { blocked: boolean; code: 'author_cooldown' | 'author_limit_24h' | 'author_limit_7d' | null; nextEligibleMs: number; stats: AuthorPostingStats } {
  const stats = getAuthorPostingStats(db, author);
  const nowMs = Date.now();
  let blocked = false;
  let code: 'author_cooldown' | 'author_limit_24h' | 'author_limit_7d' | null = null;
  let nextEligibleMs = nowMs;

  if (policy.cooldownHours > 0 && stats.lastPostedAtMs > 0) {
    const cooldownUntil = stats.lastPostedAtMs + (policy.cooldownHours * 60 * 60 * 1000);
    if (cooldownUntil > nextEligibleMs) {
      blocked = true;
      code = 'author_cooldown';
      nextEligibleMs = cooldownUntil;
    }
  }

  if (policy.max24h > 0 && stats.dailyCount >= policy.max24h) {
    const row = db.prepare(
      `SELECT MIN(datetime(al.created_at)) AS oldest_created_at
       FROM linkedin_activity_log al
       WHERE al.action = 'posted'
         AND al.post_url IN (SELECT lp.post_url FROM linkedin_posts lp WHERE lp.author = ?)
         AND al.created_at >= datetime('now', '-24 hours')`
    ).get(author) as { oldest_created_at: string | null } | undefined;
    const oldestMs = parseDbDateTime(row?.oldest_created_at);
    const candidateMs = Number.isFinite(oldestMs) ? oldestMs + (24 * 60 * 60 * 1000) + 60_000 : nowMs + 60_000;
    if (candidateMs > nextEligibleMs) {
      blocked = true;
      code = 'author_limit_24h';
      nextEligibleMs = candidateMs;
    }
  }

  if (policy.max7d > 0 && stats.weeklyCount >= policy.max7d) {
    const row = db.prepare(
      `SELECT MIN(datetime(al.created_at)) AS oldest_created_at
       FROM linkedin_activity_log al
       WHERE al.action = 'posted'
         AND al.post_url IN (SELECT lp.post_url FROM linkedin_posts lp WHERE lp.author = ?)
         AND al.created_at >= datetime('now', '-7 days')`
    ).get(author) as { oldest_created_at: string | null } | undefined;
    const oldestMs = parseDbDateTime(row?.oldest_created_at);
    const candidateMs = Number.isFinite(oldestMs) ? oldestMs + (7 * 24 * 60 * 60 * 1000) + 60_000 : nowMs + 60_000;
    if (candidateMs > nextEligibleMs) {
      blocked = true;
      code = 'author_limit_7d';
      nextEligibleMs = candidateMs;
    }
  }

  return { blocked, code, nextEligibleMs, stats };
}

function encodeAuthorDelayReason(
  code: 'author_cooldown' | 'author_limit_24h' | 'author_limit_7d',
  policy: AuthorPostingPolicy,
  stats: AuthorPostingStats,
  nextEligibleMs: number,
): string {
  return [
    `author_rule:${code}`,
    `cooldown_h=${policy.cooldownHours}`,
    `daily=${stats.dailyCount}`,
    `daily_max=${policy.max24h}`,
    `weekly=${stats.weeklyCount}`,
    `weekly_max=${policy.max7d}`,
    `last_posted=${stats.lastPostedAt || ''}`,
    `next=${toDbDateTime(nextEligibleMs)}`,
  ].join(';');
}

function localDayKeyFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextLocalDayStartMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 1, 0, 0).getTime();
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function randomIntBetween(min: number, max: number): number {
  const lo = Math.floor(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

type PostNowPriorityConfig = {
  firstDelayMs: number;
  hotCount: number;
  hotWindowMs: number;
  priorityCount: number;
  priorityWindowMs: number;
};

function getPostNowPriorityConfig(): PostNowPriorityConfig {
  const firstDelaySec = clampInt(
    parseInt(SettingsManager.get('linkedin.postNowFirstDelaySec') || String(DEFAULT_POST_NOW_FIRST_DELAY_SEC), 10) || DEFAULT_POST_NOW_FIRST_DELAY_SEC,
    1,
    300,
  );
  const hotCount = clampInt(
    parseInt(SettingsManager.get('linkedin.postNowHotCount') || String(DEFAULT_POST_NOW_HOT_COUNT), 10) || DEFAULT_POST_NOW_HOT_COUNT,
    1,
    20,
  );
  const hotWindowMin = clampInt(
    parseInt(SettingsManager.get('linkedin.postNowHotWindowMin') || String(DEFAULT_POST_NOW_HOT_WINDOW_MINUTES), 10) || DEFAULT_POST_NOW_HOT_WINDOW_MINUTES,
    1,
    240,
  );
  const priorityCountRaw = clampInt(
    parseInt(SettingsManager.get('linkedin.postNowPriorityCount') || String(DEFAULT_POST_NOW_PRIORITY_COUNT), 10) || DEFAULT_POST_NOW_PRIORITY_COUNT,
    1,
    50,
  );
  const priorityCount = Math.max(hotCount, priorityCountRaw);
  const priorityWindowMinRaw = clampInt(
    parseInt(SettingsManager.get('linkedin.postNowPriorityWindowMin') || String(DEFAULT_POST_NOW_PRIORITY_WINDOW_MINUTES), 10) || DEFAULT_POST_NOW_PRIORITY_WINDOW_MINUTES,
    1,
    24 * 60,
  );
  const hotWindowMs = hotWindowMin * 60 * 1000;
  const priorityWindowMs = Math.max(hotWindowMs, priorityWindowMinRaw * 60 * 1000);
  return {
    firstDelayMs: firstDelaySec * 1000,
    hotCount,
    hotWindowMs,
    priorityCount,
    priorityWindowMs,
  };
}

function interpolateRangeInt(start: number, end: number, fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return Math.floor(start);
  if (fraction >= 1) return Math.floor(end);
  return Math.floor(start + ((end - start) * fraction));
}

function computeAdaptiveSpacingMs(
  position: number,
  total: number,
  minSpacingMs: number,
  targetSpacingMs: number,
  lastAtMs: number,
  bulkHorizonEndMs: number,
): number {
  const configuredSpacingMs = Math.max(minSpacingMs, targetSpacingMs);

  // Small batches can stay near-term (manual burst behavior).
  if (total <= 3) {
    const min = Math.max(minSpacingMs, Math.floor(configuredSpacingMs * 0.8));
    const max = Math.max(min + 60_000, Math.floor(configuredSpacingMs * 1.1));
    return randomIntBetween(min, max);
  }
  if (total === 4) {
    const min = Math.max(minSpacingMs, Math.floor(configuredSpacingMs * 0.82));
    const max = Math.max(min + 90_000, Math.floor(configuredSpacingMs * 1.15));
    return randomIntBetween(min, max);
  }

  // Larger batches: stay anchored to the configured window interval instead of
  // stretching aggressively across a broad horizon.
  const queuePressure = Math.max(0, total - 4);
  const pressureFactor = Math.min(0.18, queuePressure * 0.0125);
  const pressuredCenterMs = Math.max(minSpacingMs, Math.floor(configuredSpacingMs * (1 - pressureFactor)));
  const pressuredMinMs = Math.max(minSpacingMs, Math.floor(pressuredCenterMs * 0.88));
  const pressuredMaxMs = Math.max(
    pressuredMinMs + 60_000,
    Math.floor(configuredSpacingMs * 1.18),
  );

  if (lastAtMs >= bulkHorizonEndMs) {
    return randomIntBetween(pressuredMinMs, pressuredMaxMs);
  }

  const remaining = Math.max(1, total - position - 1);
  const remainingHorizonMs = Math.max(configuredSpacingMs, bulkHorizonEndMs - lastAtMs);
  const horizonBaselineMs = Math.floor(remainingHorizonMs / remaining);
  const baselineMs = Math.min(Math.floor(configuredSpacingMs * 1.15), Math.max(pressuredCenterMs, horizonBaselineMs));
  const jitteredMs = Math.floor(baselineMs * (0.92 + Math.random() * 0.18));
  return clampInt(jitteredMs, pressuredMinMs, pressuredMaxMs);
}

function computePriorityTargetOffsetMs(
  priorityIndex: number,
  priorityCount: number,
  minSpacingMs: number,
): number | null {
  if (priorityIndex < 0 || priorityCount <= 0) return null;
  const config = getPostNowPriorityConfig();
  const cappedPriorityCount = Math.max(1, Math.min(priorityCount, config.priorityCount));
  if (priorityIndex >= cappedPriorityCount) return null;

  const hotCount = Math.max(1, Math.min(config.hotCount, cappedPriorityCount));
  const hotWindowMs = Math.max(config.firstDelayMs, config.hotWindowMs);
  const safeHotWindowMs = Math.max(
    hotWindowMs,
    config.firstDelayMs + Math.max(0, hotCount - 1) * minSpacingMs,
  );

  if (priorityIndex === 0) return config.firstDelayMs;

  if (priorityIndex < hotCount) {
    if (hotCount === 1) return config.firstDelayMs;
    return interpolateRangeInt(
      config.firstDelayMs,
      safeHotWindowMs,
      priorityIndex / (hotCount - 1),
    );
  }

  const extendedCount = cappedPriorityCount - hotCount;
  if (extendedCount <= 0) return null;

  const extendedStartMs = safeHotWindowMs + minSpacingMs;
  const safePriorityWindowMs = Math.max(
    config.priorityWindowMs,
    extendedStartMs + Math.max(0, extendedCount - 1) * minSpacingMs,
  );
  const extendedIndex = priorityIndex - hotCount;
  if (extendedCount === 1) return extendedStartMs;
  return interpolateRangeInt(
    extendedStartMs,
    safePriorityWindowMs,
    extendedIndex / (extendedCount - 1),
  );
}

function normalizeLinkedInPostUrl(raw: string): string {
  const input = String(raw || '').trim();
  if (!input) return '';
  const activityMatch = input.match(/urn:li:activity:\d+/i);
  if (activityMatch) {
    return `https://www.linkedin.com/feed/update/${activityMatch[0].toLowerCase()}/`;
  }
  try {
    const u = new URL(input);
    u.hash = '';
    u.search = '';
    u.hostname = 'www.linkedin.com';
    let pathname = u.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    u.pathname = `${pathname}/`;
    return u.toString();
  } catch {
    return input;
  }
}

function extractActivityId(url: string): string | null {
  const m = String(url || '').match(/activity:(\d+)/i);
  return m ? m[1] : null;
}

function normalizeCommentFingerprint(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPostedSameCommentOnUrl(db: Database.Database, postUrl: string, commentText: string): boolean {
  const target = normalizeCommentFingerprint(commentText);
  if (!target) return false;
  const activityId = extractActivityId(postUrl);
  const rows = activityId
    ? db.prepare(
      `SELECT comment_text
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND comment_text IS NOT NULL
         AND (post_url = ? OR post_url LIKE ?)
       ORDER BY id DESC
       LIMIT 30`
    ).all(postUrl, `%activity:${activityId}%`) as Array<{ comment_text: string }>
    : db.prepare(
      `SELECT comment_text
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND comment_text IS NOT NULL
         AND post_url = ?
       ORDER BY id DESC
       LIMIT 30`
    ).all(postUrl) as Array<{ comment_text: string }>;

  for (const row of rows) {
    if (normalizeCommentFingerprint(String(row.comment_text || '')) === target) {
      return true;
    }
  }
  return false;
}

function hasAnyPostedOnUrl(
  db: Database.Database,
  postUrl: string,
): { matched: boolean; createdAt?: string; postUrl?: string } {
  const activityId = extractActivityId(postUrl);
  const row = activityId
    ? db.prepare(
      `SELECT post_url, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND (post_url = ? OR post_url LIKE ?)
       ORDER BY id DESC
       LIMIT 1`
    ).get(postUrl, `%activity:${activityId}%`) as { post_url?: string; created_at?: string } | undefined
    : db.prepare(
      `SELECT post_url, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted' AND post_url = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(postUrl) as { post_url?: string; created_at?: string } | undefined;
  if (!row?.post_url) return { matched: false };
  return { matched: true, createdAt: row.created_at, postUrl: row.post_url };
}

function hasRecentAttemptGuard(db: Database.Database, postUrl: string): boolean {
  const activityId = extractActivityId(postUrl);
  let row: { action: string; created_at: string } | undefined;
  if (activityId) {
    row = db.prepare(
      `SELECT action, created_at
       FROM linkedin_activity_log
       WHERE action IN ('posting_attempt', 'verify_needed', 'session_expired', 'retry_allowed')
         AND (post_url = ? OR post_url LIKE ?)
       ORDER BY id DESC
       LIMIT 1`
    ).get(postUrl, `%activity:${activityId}%`) as { action: string; created_at: string } | undefined;
  } else {
    row = db.prepare(
      `SELECT action, created_at
       FROM linkedin_activity_log
       WHERE action IN ('posting_attempt', 'verify_needed', 'session_expired', 'retry_allowed')
         AND post_url = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(postUrl) as { action: string; created_at: string } | undefined;
  }
  if (!row?.created_at) return false;
  const action = String(row.action || '').trim().toLowerCase();
  if (action === 'session_expired' || action === 'retry_allowed') {
    return false;
  }
  const ts = parseDbDateTime(row.created_at);
  if (!Number.isFinite(ts)) return true;
  return (Date.now() - ts) < ATTEMPT_GUARD_HOURS * 60 * 60 * 1000;
}

function getRetryScheduledCount(db: Database.Database, postUrl: string): number {
  const activityId = extractActivityId(postUrl);
  if (activityId) {
    const row = db.prepare(
      `SELECT COUNT(*) as c
       FROM linkedin_activity_log
       WHERE action = 'retry_scheduled'
         AND (post_url = ? OR post_url LIKE ?)`
    ).get(postUrl, `%activity:${activityId}%`) as { c: number } | undefined;
    return Number(row?.c || 0);
  }

  const row = db.prepare(
    `SELECT COUNT(*) as c
     FROM linkedin_activity_log
     WHERE action = 'retry_scheduled'
       AND post_url = ?`
  ).get(postUrl) as { c: number } | undefined;
  return Number(row?.c || 0);
}

type PostingWindows = {
  dayEnabled: boolean;
  nightEnabled: boolean;
  dayStart: number;
  dayEnd: number;
  dayIntervalMs: number;
  nightStart: number;
  nightEnd: number;
  nightIntervalMs: number;
};

function getPostingWindows(): PostingWindows {
  return {
    dayEnabled: SettingsManager.get('linkedin.dayWindowEnabled') !== 'false',
    nightEnabled: SettingsManager.get('linkedin.nightWindowEnabled') === 'true',
    dayStart: parseHm(SettingsManager.get('linkedin.dayWindowStart') || '09:00', 9 * 60),
    dayEnd: parseHm(SettingsManager.get('linkedin.dayWindowEnd') || '18:00', 18 * 60),
    dayIntervalMs: Math.max(1, parseInt(SettingsManager.get('linkedin.dayWindowIntervalMin') || '45', 10) || 45) * 60 * 1000,
    nightStart: parseHm(SettingsManager.get('linkedin.nightWindowStart') || '22:00', 22 * 60),
    nightEnd: parseHm(SettingsManager.get('linkedin.nightWindowEnd') || '06:00', 6 * 60),
    nightIntervalMs: Math.max(1, parseInt(SettingsManager.get('linkedin.nightWindowIntervalMin') || '120', 10) || 120) * 60 * 1000,
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

function getPostingWindowIntervalMs(tsMs: number, windows: PostingWindows, fallbackMs: number): number {
  const d = new Date(tsMs);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (windows.dayEnabled && isInWindow(minutes, windows.dayStart, windows.dayEnd)) {
    return Math.max(fallbackMs, windows.dayIntervalMs);
  }
  if (windows.nightEnabled && isInWindow(minutes, windows.nightStart, windows.nightEnd)) {
    return Math.max(fallbackMs, windows.nightIntervalMs);
  }
  return fallbackMs;
}

function alignToPostingWindowMs(tsMs: number, windows: PostingWindows): number | null {
  if (!hasAnyPostingWindow(windows)) return tsMs;
  if (isWithinPostingWindowMs(tsMs, windows)) return tsMs;
  const roundedStart = Math.max(0, Math.ceil(tsMs / 60000) * 60000);
  const maxMinutesToScan = 14 * 24 * 60; // two weeks safety cap
  for (let i = 0; i <= maxMinutesToScan; i++) {
    const candidate = roundedStart + i * 60000;
    if (isWithinPostingWindowMs(candidate, windows)) return candidate;
  }
  return null;
}

function delayDuePostsForCooldown(
  db: Database.Database,
  windows: PostingWindows,
  cooldownUntilMs: number,
  dailyLimit: number,
  todayCount: number,
): number {
  const priorityOrder = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END`;
  const due = db.prepare(
    `SELECT id, post_url
     FROM linkedin_posts
     WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
       AND scheduled_at IS NOT NULL AND datetime(scheduled_at) <= datetime('now')
       AND hidden = 0
     ORDER BY ${priorityOrder}, scheduled_at ASC`
  ).all() as Array<{ id: number; post_url: string }>;

  if (due.length === 0) return 0;

  const update = db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?');
  const log = db.prepare(
    `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
     VALUES (?, ?, 'delayed', ?, ?, ?)`
  );

  const spacingMs = getBaseCommentDelayMs();
  let cursorMs = Math.max(cooldownUntilMs, Date.now() + 30_000);
  let shifted = 0;
  const cooldownLabel = toDbDateTime(cooldownUntilMs);

  const tx = db.transaction(() => {
    for (const row of due) {
      const normalizedUrl = normalizeLinkedInPostUrl(row.post_url);
      const aligned = alignToPostingWindowMs(cursorMs, windows);
      if (aligned === null) break;

      update.run(toDbDateTime(aligned), row.id);
      log.run(row.id, normalizedUrl, `cooldown_until_${cooldownLabel}`, dailyLimit, todayCount);
      shifted++;

      const nextCursor = alignToPostingWindowMs(aligned + spacingMs, windows);
      cursorMs = nextCursor ?? (aligned + spacingMs);
    }
  });
  tx();

  return shifted;
}

export interface RebalanceScheduleResult {
  adjusted: number;
  total: number;
  adjustedOthers: number;
  priorityScheduledAt: string | null;
  warning?: string;
}

export function rebalancePendingSchedules(options: { priorityPostId?: number; preferredAt?: string; fromNow?: boolean } = {}): RebalanceScheduleResult {
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

    const priorityConfig = getPostNowPriorityConfig();
    const rows = db.prepare(
      `SELECT id, scheduled_at,
              (
                SELECT MAX(created_at)
                FROM linkedin_activity_log la
                WHERE la.post_id = linkedin_posts.id
                  AND la.action = 'priority_scheduled'
              ) AS last_priority_scheduled_at,
              CASE
                WHEN (
                  SELECT MAX(created_at)
                  FROM linkedin_activity_log la
                  WHERE la.post_id = linkedin_posts.id
                    AND la.action = 'priority_scheduled'
                ) IS NOT NULL
                 AND datetime((
                  SELECT MAX(created_at)
                  FROM linkedin_activity_log la
                  WHERE la.post_id = linkedin_posts.id
                    AND la.action = 'priority_scheduled'
                 )) >= datetime('now', '-${priorityConfig.priorityWindowMs / 60000} minutes')
                THEN 1
                ELSE 0
              END AS has_priority_now
       FROM linkedin_posts
       WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
         AND scheduled_at IS NOT NULL AND hidden = 0
       ORDER BY
         CASE
           WHEN id = ? THEN 0
           WHEN has_priority_now = 1
             AND datetime(scheduled_at) <= datetime('now', '+${priorityConfig.priorityWindowMs / 60000} minutes') THEN 1
           WHEN datetime(scheduled_at) <= datetime('now', '+${priorityConfig.priorityWindowMs / 60000} minutes') THEN 2
           WHEN has_priority_now = 1 THEN 3
           ELSE 4
         END,
         datetime(last_priority_scheduled_at) DESC,
         datetime(scheduled_at) ASC`
    ).all(options.priorityPostId || 0) as Array<{ id: number; scheduled_at: string | null; has_priority_now?: number; last_priority_scheduled_at?: string | null }>;

    if (rows.length === 0) {
      return {
        adjusted: 0,
        total: 0,
        adjustedOthers: 0,
        priorityScheduledAt: null,
      };
    }

    const hasPriorityRows = rows.some((row) => row.id === (options.priorityPostId || 0) || Number(row.has_priority_now || 0) === 1);
    const nowFloorMs = Math.max(0, Date.now() + (hasPriorityRows ? 1_000 : 60_000));
    const minSpacingMs = getBaseCommentDelayMs();
    const bulkSpreadHours = 6;
    const bulkHorizonEndMs = nowFloorMs + (bulkSpreadHours * 60 * 60 * 1000);
    const preferredMsRaw = parseDbDateTime(options.preferredAt);
    const preferredMs = Number.isFinite(preferredMsRaw) ? preferredMsRaw : NaN;
    const postedPerDayRows = db.prepare(
      `SELECT date(created_at, 'localtime') AS day, COUNT(*) AS c
       FROM linkedin_activity_log
       WHERE action = 'posted'
       GROUP BY day`
    ).all() as Array<{ day: string; c: number }>;
    const dayUsage = new Map<string, number>();
    for (const row of postedPerDayRows) {
      const key = String(row.day || '').trim();
      if (!key) continue;
      dayUsage.set(key, Math.max(0, Number(row.c || 0)));
    }
    const priorityRowIds = rows
      .filter((row) => row.id === (options.priorityPostId || 0) || Number(row.has_priority_now || 0) === 1)
      .map((row) => row.id);
    const priorityRowIndex = new Map<number, number>();
    priorityRowIds.forEach((id, index) => {
      priorityRowIndex.set(id, index);
    });

    const updates: Array<{ id: number; at: string; changed: boolean }> = [];
    let cursorMs = nowFloorMs;
    let warning: string | undefined;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const currentMsRaw = parseDbDateTime(row.scheduled_at);
      const hasCurrent = Number.isFinite(currentMsRaw);
      let candidateMs = options.fromNow ? cursorMs : (hasCurrent ? currentMsRaw : cursorMs);

      const priorityIndex = priorityRowIndex.get(row.id) ?? -1;
      const priorityTargetOffsetMs = computePriorityTargetOffsetMs(
        priorityIndex,
        priorityRowIds.length,
        minSpacingMs,
      );

      if (priorityTargetOffsetMs !== null) {
        candidateMs = Math.max(nowFloorMs + priorityTargetOffsetMs, nowFloorMs);
      } else if (options.priorityPostId && row.id === options.priorityPostId && Number.isFinite(preferredMs)) {
        candidateMs = Math.max(preferredMs, nowFloorMs);
      }

      if (candidateMs < cursorMs) candidateMs = cursorMs;

      let alignedMs: number | null = alignToPostingWindowMs(candidateMs, windows);
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

      // Enforce per-day cap (posted + scheduled). Spill to next local day if needed.
      let aligned: number | null = alignedMs;
      let capacityShifted = 0;
      while (aligned !== null) {
        const key = localDayKeyFromMs(aligned);
        const dayCap = getScheduleDayCap(key);
        const used = dayUsage.get(key) || 0;
        if (used < dayCap) break;
        capacityShifted += 1;
        if (capacityShifted > 60) {
          warning = `Could not find a day with available capacity under daily limit (${dayCap}).`;
          aligned = null;
          break;
        }
        const nextStart = nextLocalDayStartMs(aligned);
        aligned = alignToPostingWindowMs(nextStart, windows);
      }
      if (aligned === null) break;
      alignedMs = aligned;

      const dayKey = localDayKeyFromMs(alignedMs);
      const targetSpacingMs = getTargetSpacingForDay(dayKey, alignedMs, windows, minSpacingMs);
      const adaptiveSpacingMs = computeAdaptiveSpacingMs(
        i,
        rows.length,
        minSpacingMs,
        targetSpacingMs,
        alignedMs,
        bulkHorizonEndMs,
      );
      const nextCursor = alignToPostingWindowMs(alignedMs + adaptiveSpacingMs, windows);
      if (nextCursor === null) {
        warning = 'Could not compute safe spacing in posting windows.';
        break;
      }

      const changed = !hasCurrent || Math.abs(alignedMs - currentMsRaw) >= 30_000;
      updates.push({ id: row.id, at: toDbDateTime(alignedMs), changed });
      const scheduledDayKey = localDayKeyFromMs(alignedMs);
      dayUsage.set(scheduledDayKey, (dayUsage.get(scheduledDayKey) || 0) + 1);
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
  if (!shouldNotifyTelegramForLinkedIn()) return;
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
  // Halt if session is expired - wait for re-authentication
  if (SettingsManager.get('linkedin.sessionExpired') === 'true') {
    return;
  }
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
        `SELECT id, author, post_url FROM linkedin_posts
         WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
           AND scheduled_at IS NOT NULL AND hidden = 0
         ORDER BY scheduled_at ASC`
      ).all() as Array<{ id: number; author: string; post_url: string }>;

      if (remaining.length > 0) {
        const nightEnabled = SettingsManager.get('linkedin.nightWindowEnabled') === 'true';
        const nightStart = SettingsManager.get('linkedin.nightWindowStart') || '22:00';
        const [nh, nm] = nightStart.split(':').map(Number);

        const update = db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?');
        const logDelayed = db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'delayed', ?, ?, ?)`
        );
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
            const targetTime = new Date(baseTime.getTime() + cumulativeMs);
            const newTime = targetTime.toISOString().replace('T', ' ').slice(0, 19);
            const targetDay = localDayKeyFromMs(targetTime.getTime());
            const normalizedUrl = normalizeLinkedInPostUrl(post.post_url);
            update.run(newTime, post.id);
            logDelayed.run(
              post.id,
              normalizedUrl,
              `daily_limit_rollover:${todayStr}->${targetDay}`,
              dailyLimit,
              todayCount
            );
          }
        });
        tx();
        try {
          const rebalance = rebalancePendingSchedules();
          if (rebalance.warning) {
            console.warn('[AutoPoster] Daily-limit rebalance warning:', rebalance.warning);
          }
        } catch (rebalanceErr) {
          console.warn('[AutoPoster] Daily-limit rebalance failed:', rebalanceErr);
        }

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
      if (elapsed < requiredDelay) {
        const cooldownUntilMs = lastPostedAt + requiredDelay;
        const windows = getPostingWindows();
        const shifted = delayDuePostsForCooldown(db, windows, cooldownUntilMs, dailyLimit, todayCount);
        if (shifted > 0) {
          console.log(`[AutoPoster] Cooldown active, delayed ${shifted} due post(s) until ${toDbDateTime(cooldownUntilMs)}`);
        }
        return;
      }
    }

    // Find next eligible post
    const priorityOrder = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END`;
    const candidates = db.prepare(
      `SELECT id, post_url, author, comment_draft, reactions, comments, kanban_task_id,
              hook_score, emotion_tag, niche_target, authenticity_flag
       FROM linkedin_posts
       WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL
         AND scheduled_at IS NOT NULL AND datetime(scheduled_at) <= datetime('now')
         AND hidden = 0
       ORDER BY ${priorityOrder}, scheduled_at ASC
       LIMIT 10`
    ).all() as Array<{ id: number; post_url: string; author: string; comment_draft: string; reactions: number; comments: number; kanban_task_id: number | null; hook_score: number | null; emotion_tag: string | null; niche_target: string | null; authenticity_flag: string | null }>;

    if (candidates.length === 0) return;

    // Quality gate enforcement - block posts missing required metadata
    const qgEnabled = SettingsManager.get('linkedin.qualityGateEnabled') === 'true';
    const qgMinHook = parseInt(SettingsManager.get('linkedin.qualityGateMinHook') || '7', 10);
    const qgRequireEmotion = SettingsManager.get('linkedin.qualityGateRequireEmotion') === 'true';
    const qgRequireNiche = SettingsManager.get('linkedin.qualityGateRequireNiche') === 'true';
    const qgRequireAuth = SettingsManager.get('linkedin.qualityGateRequireAuthenticity') === 'true';

    const authorPolicy = getAuthorPostingPolicy();
    let rebalanceNeeded = false;

    for (const post of candidates) {
      const postUrl = normalizeLinkedInPostUrl(post.post_url);
      if (!postUrl) continue;

      // Hard duplicate guard: never comment twice on the same URL.
      const alreadyPosted = hasAnyPostedOnUrl(db, postUrl);
      if (alreadyPosted.matched) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, approved = 0, scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'skipped', 'duplicate_url_already_posted', ?, ?)`
        ).run(post.id, postUrl, dailyLimit, todayCount);
        await notifyTelegram(`LinkedIn: Duplicate blocked on ${post.author}'s post (URL already commented at ${alreadyPosted.createdAt || 'earlier'}).`);
        continue;
      }

      // Legacy safety guard: old retry-storm history means uncertain outcome.
      // Do not auto-post this URL again without manual verification.
      const retryHistoryCount = getRetryScheduledCount(db, postUrl);
      if (retryHistoryCount >= 3) {
        db.prepare('UPDATE linkedin_posts SET scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'verify_needed', ?, ?, ?)`
        ).run(post.id, postUrl, `retry_storm_history_${retryHistoryCount}`, dailyLimit, todayCount);
        await notifyTelegram(`LinkedIn: Blocked auto-post on ${post.author}'s post due to retry-storm history (${retryHistoryCount}). Verify manually before retrying.`);
        continue;
      }

      // Duplicate guard: allow multiple comments on the same URL, but never repost
      // the exact same comment text on that URL.
      if (hasPostedSameCommentOnUrl(db, postUrl, post.comment_draft)) {
        db.prepare('UPDATE linkedin_posts SET scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'verify_needed', 'duplicate_same_comment_url', ?, ?)`
        ).run(post.id, postUrl, dailyLimit, todayCount);
        await notifyTelegram(`LinkedIn: Skipped duplicate comment on ${post.author}'s post (same URL + same text). Draft a follow-up narrative, then approve/schedule again.`);
        console.log(`[AutoPoster] Blocked duplicate same-comment repost on URL: ${postUrl}`);
        continue;
      }

      if (hasRecentAttemptGuard(db, postUrl)) {
        db.prepare('UPDATE linkedin_posts SET scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'skipped', 'recent_attempt_guard', ?, ?)`
        ).run(post.id, postUrl, dailyLimit, todayCount);
        await notifyTelegram(`LinkedIn: Guarded ${post.author}'s post after uncertain attempt. Verify manually before retrying.`);
        continue;
      }

      const authorGate = computeAuthorNextEligibleMs(db, post.author, authorPolicy);
      if (authorGate.blocked && authorGate.code) {
        const windows = getPostingWindows();
        const alignedMs = alignToPostingWindowMs(Math.max(authorGate.nextEligibleMs, Date.now() + 60_000), windows);
        const nextMs = alignedMs ?? Math.max(authorGate.nextEligibleMs, Date.now() + 60_000);
        db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?').run(toDbDateTime(nextMs), post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'delayed', ?, ?, ?)`
        ).run(
          post.id,
          postUrl,
          encodeAuthorDelayReason(authorGate.code, authorPolicy, authorGate.stats, nextMs),
          dailyLimit,
          todayCount
        );
        rebalanceNeeded = true;
        continue;
      }

      // Quality gate: block posts missing required metadata
      if (qgEnabled) {
        const missing: string[] = [];
        const hookScore = Number(post.hook_score || 0);
        if (qgMinHook > 0 && (!Number.isFinite(hookScore) || hookScore < qgMinHook)) {
          missing.push(`hook_score<${qgMinHook}`);
        }
        if (qgRequireEmotion && !String(post.emotion_tag || '').trim()) missing.push('emotion_tag');
        if (qgRequireNiche && !String(post.niche_target || '').trim()) missing.push('niche_target');
        if (qgRequireAuth && !String(post.authenticity_flag || '').trim()) missing.push('authenticity_flag');

        if (missing.length > 0) {
          db.prepare('UPDATE linkedin_posts SET scheduled_at = NULL, approved = 0 WHERE id = ?').run(post.id);
          db.prepare(
            `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
             VALUES (?, ?, 'quality_blocked', ?, ?, ?)`
          ).run(post.id, postUrl, `missing:${missing.join(',')}`, dailyLimit, todayCount);
          await notifyTelegram(`LinkedIn: Quality gate blocked ${post.author}'s post. Missing: ${missing.join(', ')}. Fill metadata and re-approve.`);
          console.log(`[AutoPoster] Quality gate blocked post ${post.id}: missing ${missing.join(', ')}`);
          continue;
        }
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

      // Re-check after claim to avoid race windows.
      const alreadyPostedAfterClaim = hasAnyPostedOnUrl(db, postUrl);
      if (alreadyPostedAfterClaim.matched) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, approved = 0, scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'skipped', 'duplicate_url_post_claim', ?, ?)`
        ).run(post.id, postUrl, dailyLimit, todayCount);
        continue;
      }

      // Post the comment — single attempt, no blind retry (prevents double-posting)
      let posted = false;
      let failureReason = '';
      db.prepare(
        `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
         VALUES (?, ?, 'posting_attempt', ?, ?, ?)`
      ).run(post.id, postUrl, `window:${window.name}`, dailyLimit, todayCount);
      try {
        await linkedinExec('reply', ['--url', postUrl, '--comment', post.comment_draft, '--no-confirm'], 120000);
        posted = true;
      } catch (err) {
        console.error(`[AutoPoster] Posting failed for ${post.author}:`, err);
        // Check if "Comment posted successfully" appears in stdout (timeout after submit)
        const stdout = String((err as Error & { stdout?: string }).stdout || '');
        const stderr = String((err as Error & { stderr?: string }).stderr || '');
        const msg = String((err as Error).message || '');
        const errMsg = `${stdout}\n${stderr}\n${msg}`;
        if (errMsg.includes('Comment posted successfully')) {
          console.log(`[AutoPoster] Comment was actually posted despite timeout for ${post.author}`);
          posted = true;
        } else if (errMsg.includes('Not authenticated')) {
          // Explicit auth failure: restore the post's schedule and halt all further attempts
          db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?')
            .run(toDbDateTime(Date.now() + 30 * 60_000), post.id);
          db.prepare(
            `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
             VALUES (?, ?, 'session_expired', 'linkedin_login_required', ?, ?)`
          ).run(post.id, postUrl, dailyLimit, todayCount);
          await notifyTelegram(
            `LinkedIn: Session expired (login redirect detected). ` +
            `Auto-poster PAUSED. Re-authenticate in the app, then posting will resume automatically.`
          );
          console.error(`[AutoPoster] SESSION EXPIRED - halting autoposter until re-auth`);
          // Set a flag so the autoposter skips all further ticks until session is restored
          SettingsManager.set('linkedin.sessionExpired', 'true');
          return;
        } else if (errMsg.includes('Could not find comment box')) {
          db.prepare('UPDATE linkedin_posts SET scheduled_at = NULL WHERE id = ?').run(post.id);
          db.prepare(
            `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
             VALUES (?, ?, 'verify_needed', 'comment_box_not_found', ?, ?)`
          ).run(post.id, postUrl, dailyLimit, todayCount);
          await notifyTelegram(
            `LinkedIn: Could not find comment box for ${post.author}'s post. Marked for manual review instead of pausing the whole auto-poster.`
          );
          console.warn(`[AutoPoster] Comment box not found for ${post.author}; marked verify_needed without expiring session`);
          continue;
        } else {
          failureReason = errMsg.replace(/\s+/g, ' ').trim().slice(0, 500);
        }
      }

      if (posted) {
        // Clear session expired flag on successful post
        if (SettingsManager.get('linkedin.sessionExpired') === 'true') {
          SettingsManager.set('linkedin.sessionExpired', 'false');
        }
        db.prepare('UPDATE linkedin_posts SET commented = 1, scheduled_at = NULL WHERE id = ?').run(post.id);

        db.prepare(
          `INSERT OR IGNORE INTO linkedin_activity_log (post_id, post_url, action, reason, comment_text, daily_limit, daily_count)
           VALUES (?, ?, 'posted', ?, ?, ?, ?)`
        ).run(post.id, postUrl, `window:${window.name}`, post.comment_draft, dailyLimit, todayCount + 1);

        scheduleEngagementCheck(db, post.id, postUrl, post.reactions, post.comments);

        if (post.kanban_task_id) {
          try {
            KanbanService.moveTask(post.kanban_task_id, 'done', 'linkedin-autoposter');
          } catch { /* task may be missing/archived */ }
        }

        await notifyTelegram(`LinkedIn: Posted on ${post.author}'s post (${todayCount + 1}/${dailyLimit} today)`);
        console.log(`[AutoPoster] Posted comment on ${post.author}'s post (${todayCount + 1}/${dailyLimit})`);
      } else {
        // Safety first: do not auto-retry uncertain outcomes to avoid duplicate posts.
        db.prepare('UPDATE linkedin_posts SET scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, daily_limit, daily_count)
           VALUES (?, ?, 'verify_needed', ?, ?, ?)`
        ).run(post.id, postUrl, failureReason || 'unknown_post_result', dailyLimit, todayCount);

        await notifyTelegram(`LinkedIn: Posting on ${post.author}'s post is uncertain. Auto-retry disabled to prevent duplicates. Please verify manually.`);
        console.log(`[AutoPoster] Uncertain result on ${post.author}; moved to manual verification`);
      }
      if (rebalanceNeeded) {
        try {
          const rebalance = rebalancePendingSchedules();
          if (rebalance.warning) {
            console.warn('[AutoPoster] Author-frequency rebalance warning:', rebalance.warning);
          }
        } catch (rebalanceErr) {
          console.warn('[AutoPoster] Author-frequency rebalance failed:', rebalanceErr);
        }
      }
      return; // One post per tick
    }
    if (rebalanceNeeded) {
      try {
        const rebalance = rebalancePendingSchedules();
        if (rebalance.warning) {
          console.warn('[AutoPoster] Author-frequency rebalance warning:', rebalance.warning);
        }
      } catch (rebalanceErr) {
        console.warn('[AutoPoster] Author-frequency rebalance failed:', rebalanceErr);
      }
    }

    // --- Content Planner: pick up scheduled plan assets ---
    if (SettingsManager.get('linkedin.plannerEnabled') === 'true') {
      try {
        const planAsset = db.prepare(
          `SELECT a.id, a.draft_text, a.final_text, a.kanban_task_id,
                  a.image_path, t.can_auto_publish, t.label as target_label
           FROM linkedin_plan_assets a
           JOIN linkedin_targets t ON a.target_id = t.id
           WHERE a.status = 'scheduled'
             AND a.scheduled_at IS NOT NULL
             AND datetime(a.scheduled_at) <= datetime('now')
             AND t.can_auto_publish = 1
           ORDER BY a.scheduled_at ASC
           LIMIT 1`
        ).get() as { id: number; draft_text: string | null; final_text: string | null; kanban_task_id: number | null; image_path: string | null; can_auto_publish: number; target_label: string } | undefined;

        if (planAsset) {
          const text = planAsset.final_text || planAsset.draft_text;
          if (text) {
            console.log(`[AutoPoster] Publishing plan asset #${planAsset.id} for target "${planAsset.target_label}"`);
            try {
              // Write text to temp file to avoid CLI arg length limits
              const tmpFile = path.join(os.tmpdir(), `planner_post_${planAsset.id}_${Date.now()}.txt`);
              fs.writeFileSync(tmpFile, text, 'utf-8');
              const postArgs = ['--text-file', tmpFile, '--no-confirm'];
              if (planAsset.image_path) postArgs.push('--image', planAsset.image_path);
              await linkedinExec('post', postArgs, 120000);
              try { fs.unlinkSync(tmpFile); } catch { /* ok */ }

              db.prepare(
                `UPDATE linkedin_plan_assets SET status = 'published', published_at = datetime('now'), publish_error = NULL WHERE id = ?`
              ).run(planAsset.id);

              if (planAsset.kanban_task_id) {
                try { KanbanService.moveTask(planAsset.kanban_task_id, 'done', 'linkedin-autoposter'); } catch { /* ok */ }
              }

              db.prepare(
                `INSERT INTO linkedin_activity_log (action, reason, comment_text, daily_limit, daily_count)
                 VALUES ('plan_published', ?, ?, ?, ?)`
              ).run(`auto:target:${planAsset.target_label}`, text.slice(0, 500), dailyLimit, todayCount + 1);

              await notifyTelegram(`LinkedIn: Published plan asset #${planAsset.id} for "${planAsset.target_label}" (${todayCount + 1}/${dailyLimit} today)`);
            } catch (err) {
              const errMsg = String((err as Error).message || '').slice(0, 500);
              db.prepare(
                `UPDATE linkedin_plan_assets SET publish_error = ? WHERE id = ?`
              ).run(errMsg, planAsset.id);

              await notifyTelegram(`LinkedIn: Failed to publish plan asset #${planAsset.id}: ${errMsg}`);
              console.error(`[AutoPoster] Plan asset #${planAsset.id} publish failed:`, err);
            }
          }
        }
      } catch (planErr) {
        console.warn('[AutoPoster] Plan asset check failed:', planErr);
      }
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
    const windows = getPostingWindows();
    if (!hasAnyPostingWindow(windows)) return 0;

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
      let cursorMs = Math.max(Date.now() + 30_000, Date.now());
      for (const post of stale) {
        const aligned = alignToPostingWindowMs(cursorMs, windows);
        if (aligned === null) break;
        update.run(toDbDateTime(aligned), post.id);
        const dayKey = localDayKeyFromMs(aligned);
        const targetSpacingMs = getTargetSpacingForDay(dayKey, aligned, windows, getBaseCommentDelayMs());
        const spacingMinMs = Math.max(getBaseCommentDelayMs(), Math.floor(targetSpacingMs * 0.55));
        const spacingMaxMs = Math.max(spacingMinMs + 60_000, Math.floor(targetSpacingMs * 0.9));
        const nextSpacingMs = randomIntBetween(spacingMinMs, spacingMaxMs);
        const nextCursor = alignToPostingWindowMs(aligned + nextSpacingMs, windows);
        cursorMs = nextCursor ?? (aligned + nextSpacingMs);
      }
    });
    tx();

    console.log(`[AutoPoster] Rescheduled ${stale.length} stale posts using configured posting window intervals`);
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

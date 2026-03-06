/**
 * LinkedIn agent tools -browse feed, read posts, comment, create posts, manage auth.
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { linkedinExec } from './linkedin-wrapper';
import { SettingsManager } from '../settings';
import { glmFlash, glmChat, isGlmConfigured } from './glm-client';
import { KanbanService } from '../kanban';

// ============================================================================
// Voice preset selection
// ============================================================================

interface VoicePreset {
  name: string;
  prompt: string;
  postTypes: string[];
}

function selectVoiceForPost(postType: string | null | undefined): string {
  const presetsJson = SettingsManager.get('linkedin.voicePresets') || '';
  let presets: VoicePreset[] = [];
  try {
    const parsed = JSON.parse(presetsJson);
    if (Array.isArray(parsed)) presets = parsed;
  } catch { /* invalid JSON, fall through */ }

  if (presets.length === 0) {
    return SettingsManager.get('linkedin.voiceStyle') || '';
  }

  if (Math.random() < 0.7 && postType) {
    const matching = presets.filter(p => p.postTypes.includes(postType));
    if (matching.length > 0) {
      return matching[Math.floor(Math.random() * matching.length)].prompt;
    }
  }

  return presets[Math.floor(Math.random() * presets.length)].prompt;
}

function getAuthorFirstName(author: string | null | undefined): string {
  const raw = String(author || '').trim();
  if (!raw) return '';
  const first = raw.split(/\s+/)[0] || '';
  return first.replace(/[^\p{L}\p{N}'’.-]/gu, '').replace(/[.,:;!?]+$/g, '');
}

function ensureReadableCommentLayout(draft: string): string {
  const raw = draft.trim();
  if (!raw) return raw;

  if (raw.includes('\n')) {
    return raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n');
  }

  const sentences = (raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map(s => s.trim())
    .filter(Boolean);
  if (sentences.length <= 1) return raw;

  const lines: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    lines.push(sentences[i]);
    if (i < sentences.length - 1 && i % 2 === 1) lines.push('');
  }
  return lines.join('\n').trim();
}

// ============================================================================
// Database helper (shared connection to pocket-agent.db)
// ============================================================================

let _db: Database.Database | null = null;
let _postedGuardEnsured = false;

function ensurePostedGuardIndexes(db: Database.Database): void {
  if (_postedGuardEnsured) return;
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
      console.log(`[LinkedIn] Converted ${duplicatePostedRows} legacy duplicate posted row(s)`);
    }
  } catch (err) {
    console.warn('[LinkedIn] Could not normalize legacy posted duplicates:', err);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_li_posted_once_per_url
    ON linkedin_activity_log(post_url)
    WHERE action = 'posted'
  `);
  _postedGuardEnsured = true;
}

function getDb(): Database.Database | null {
  if (_db) return _db;
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      _db = new Database(p);
      _db.pragma('journal_mode = WAL');
      ensurePostedGuardIndexes(_db);
      return _db;
    }
  }
  return null;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateAwarenessContext(): { isoDate: string; humanDate: string; year: number } {
  const now = new Date();
  return {
    isoDate: now.toISOString().slice(0, 10),
    humanDate: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    year: now.getFullYear(),
  };
}

function normalizeLinkedInPostType(raw: unknown): string | null {
  const v = String(raw || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!v) return null;
  if (v === 'promotion' || v === 'promo') return 'promotional';
  if (v === 'jobposting') return 'job-posting';
  if (v === 'thoughtleadership') return 'thought-leadership';
  if (v === 'personalstory') return 'personal-story';
  if (v === 'summit' || v === 'conference' || v === 'webinar') return 'event';
  return v;
}

function normalizeLinkedInText(raw: string): string {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildQuickOverviewSummary(raw: string): string {
  const text = normalizeLinkedInText(raw);
  if (!text) return '';

  const flat = text.replace(/\s+/g, ' ').trim();
  const words = flat.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const clampWords = (input: string, maxWords: number): string => {
    const w = String(input || '').trim().split(/\s+/).filter(Boolean);
    if (w.length <= maxWords) return w.join(' ');
    return `${w.slice(0, maxWords).join(' ')}...`;
  };

  const sentences = flat
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(Boolean);
  const meaningful = sentences.filter(s => (s.split(/\s+/).length || 0) >= 5);

  if (meaningful.length >= 2) {
    return `${clampWords(meaningful[0], 14)}\n${clampWords(meaningful[1], 14)}`.trim();
  }
  if (meaningful.length === 1) {
    const first = clampWords(meaningful[0], 14);
    const used = meaningful[0].split(/\s+/).filter(Boolean).length;
    const tail = words.slice(Math.min(used, words.length), Math.min(used + 14, words.length)).join(' ');
    if (tail) return `${first}\n${clampWords(tail, 14)}`.trim();
    return first;
  }

  const first = words.slice(0, 14).join(' ');
  const second = words.slice(14, 28).join(' ');
  return second ? `${clampWords(first, 14)}\n${clampWords(second, 14)}`.trim() : clampWords(first, 14);
}

type DiscoveryQueryLeaderboardEntry = {
  query: string;
  normalized_query: string;
  run_count: number;
  success_count: number;
  failure_count: number;
  scraped_total: number;
  new_total: number;
  refreshed_total: number;
  last_used_at: string;
  last_success_at: string;
  last_error: string;
  last_source: string;
  last_scroll: number;
  last_limit: number;
  score: number;
};

function normalizeDiscoveryQuery(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function computeDiscoveryScore(entry: DiscoveryQueryLeaderboardEntry): number {
  const scraped = Math.max(1, Number(entry.scraped_total || 0));
  const successRuns = Math.max(0, Number(entry.success_count || 0));
  const failureRuns = Math.max(0, Number(entry.failure_count || 0));
  const runs = Math.max(1, Number(entry.run_count || 0));
  const hitRate = (Math.max(0, Number(entry.new_total || 0)) + (0.35 * Math.max(0, Number(entry.refreshed_total || 0)))) / scraped;
  const reliability = successRuns / Math.max(1, successRuns + failureRuns);
  const confidenceBoost = 1 + Math.log1p(runs);
  const score = hitRate * reliability * confidenceBoost;
  return Number(score.toFixed(6));
}

function loadDiscoveryQueryLeaderboard(): DiscoveryQueryLeaderboardEntry[] {
  const raw = String(SettingsManager.get('linkedin.discoveryQueryLeaderboard') || '[]').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const query = String(item?.query || '').trim();
        const normalized = normalizeDiscoveryQuery(String(item?.normalized_query || query));
        if (!query || !normalized) return null;
        const row: DiscoveryQueryLeaderboardEntry = {
          query: query.slice(0, 120),
          normalized_query: normalized,
          run_count: Math.max(0, Number(item?.run_count || 0)),
          success_count: Math.max(0, Number(item?.success_count || 0)),
          failure_count: Math.max(0, Number(item?.failure_count || 0)),
          scraped_total: Math.max(0, Number(item?.scraped_total || 0)),
          new_total: Math.max(0, Number(item?.new_total || 0)),
          refreshed_total: Math.max(0, Number(item?.refreshed_total || 0)),
          last_used_at: String(item?.last_used_at || ''),
          last_success_at: String(item?.last_success_at || ''),
          last_error: String(item?.last_error || ''),
          last_source: String(item?.last_source || ''),
          last_scroll: Math.max(0, Number(item?.last_scroll || 0)),
          last_limit: Math.max(0, Number(item?.last_limit || 0)),
          score: Number(item?.score || 0),
        };
        row.score = computeDiscoveryScore(row);
        return row;
      })
      .filter((item): item is DiscoveryQueryLeaderboardEntry => !!item)
      .sort((a, b) => b.score - a.score || b.run_count - a.run_count)
      .slice(0, 80);
  } catch {
    return [];
  }
}

function saveDiscoveryQueryLeaderboard(rows: DiscoveryQueryLeaderboardEntry[]): void {
  const compact = rows
    .map((row) => ({
      query: String(row.query || '').slice(0, 120),
      normalized_query: normalizeDiscoveryQuery(row.normalized_query || row.query),
      run_count: Math.max(0, Number(row.run_count || 0)),
      success_count: Math.max(0, Number(row.success_count || 0)),
      failure_count: Math.max(0, Number(row.failure_count || 0)),
      scraped_total: Math.max(0, Number(row.scraped_total || 0)),
      new_total: Math.max(0, Number(row.new_total || 0)),
      refreshed_total: Math.max(0, Number(row.refreshed_total || 0)),
      last_used_at: String(row.last_used_at || ''),
      last_success_at: String(row.last_success_at || ''),
      last_error: String(row.last_error || ''),
      last_source: String(row.last_source || ''),
      last_scroll: Math.max(0, Number(row.last_scroll || 0)),
      last_limit: Math.max(0, Number(row.last_limit || 0)),
      score: Number(computeDiscoveryScore(row).toFixed(6)),
    }))
    .filter((row) => row.query && row.normalized_query)
    .sort((a, b) => b.score - a.score || b.run_count - a.run_count)
    .slice(0, 80);
  SettingsManager.set('linkedin.discoveryQueryLeaderboard', JSON.stringify(compact));
}

function recordDiscoveryQueryRun(input: {
  query: string;
  scraped: number;
  newPosts: number;
  refreshedPosts: number;
  success: boolean;
  source?: string;
  scroll?: number;
  limit?: number;
  error?: string;
}): void {
  const normalized = normalizeDiscoveryQuery(input.query);
  const query = String(input.query || '').trim().slice(0, 120);
  if (!normalized || !query) return;

  const rows = loadDiscoveryQueryLeaderboard();
  const map = new Map<string, DiscoveryQueryLeaderboardEntry>();
  for (const row of rows) {
    if (!row.normalized_query) continue;
    map.set(row.normalized_query, row);
  }
  const existing = map.get(normalized);
  const now = new Date().toISOString();
  const next: DiscoveryQueryLeaderboardEntry = existing || {
    query,
    normalized_query: normalized,
    run_count: 0,
    success_count: 0,
    failure_count: 0,
    scraped_total: 0,
    new_total: 0,
    refreshed_total: 0,
    last_used_at: '',
    last_success_at: '',
    last_error: '',
    last_source: '',
    last_scroll: 0,
    last_limit: 0,
    score: 0,
  };

  next.query = query;
  next.normalized_query = normalized;
  next.run_count += 1;
  if (input.success) {
    next.success_count += 1;
    next.scraped_total += Math.max(0, Math.floor(input.scraped || 0));
    next.new_total += Math.max(0, Math.floor(input.newPosts || 0));
    next.refreshed_total += Math.max(0, Math.floor(input.refreshedPosts || 0));
    next.last_success_at = now;
    next.last_error = '';
  } else {
    next.failure_count += 1;
    next.last_error = String(input.error || '').slice(0, 240);
  }
  next.last_used_at = now;
  next.last_source = String(input.source || '').slice(0, 60);
  next.last_scroll = Math.max(0, Math.floor(input.scroll || 0));
  next.last_limit = Math.max(0, Math.floor(input.limit || 0));
  next.score = computeDiscoveryScore(next);

  map.set(normalized, next);
  saveDiscoveryQueryLeaderboard(Array.from(map.values()));
}

async function buildAiOverviewSummary(raw: string): Promise<string> {
  const fallback = buildQuickOverviewSummary(raw);
  const text = normalizeLinkedInText(raw);
  if (!text) return fallback;
  if (!isGlmConfigured()) return fallback;

  try {
    const result = await glmFlash({
      maxTokens: 120,
      temperature: 0.2,
      disableThinking: true,
      messages: [
        {
          role: 'system',
          content: 'Summarize LinkedIn post text into exactly 1-2 short sentences. Keep the core claim and practical meaning. No hashtags, no emojis, no fluff, no quotes.',
        },
        {
          role: 'user',
          content: text.slice(0, 2400),
        },
      ],
    });
    if (!result.success || !result.content) return fallback;
    const normalized = normalizeLinkedInText(result.content);
    return buildQuickOverviewSummary(normalized || fallback);
  } catch {
    return fallback;
  }
}

function checkEnabled(): string | null {
  if (!SettingsManager.getBoolean('linkedin.enabled')) {
    // Auto-enable if auth profile exists (settings may have been reset)
    const profileDir = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'data', 'browser_state', 'browser_profile');
    if (fs.existsSync(profileDir)) {
      SettingsManager.set('linkedin.enabled', 'true');
      console.log('[LinkedIn] Auto-enabled: browser profile found at', profileDir);
    } else {
      return JSON.stringify({ error: 'LinkedIn integration is not enabled. Enable it in Settings → LinkedIn.' });
    }
  }
  return null;
}

// ============================================================================
// Browse Feed Tool
// ============================================================================

function getBrowseFeedToolDefinition() {
  return {
    name: 'linkedin_feed',
    description: `Browse your LinkedIn feed and extract posts with engagement data.

Returns posts sorted by engagement (reactions + comments) as JSON.
Useful for finding trending content, monitoring topics, or discovering posts to engage with.

The first call may be slow (~60s) if the Python environment needs setup.

Examples:
- linkedin_feed() -browse feed with default settings
- linkedin_feed(scroll=5, keyword="AI") -scroll more, filter by keyword
- linkedin_feed(person="Sam Altman") -find posts by a specific person
- linkedin_feed(min_engagement=50, limit=10) -high-engagement posts only
- linkedin_feed(search_query="#seo", scroll=8, limit=30) -discovery scrape from LinkedIn content search`,
    input_schema: {
      type: 'object' as const,
      properties: {
        scroll: { type: 'number', description: 'Number of scroll iterations (default: 3, more = more posts but slower)' },
        person: { type: 'string', description: 'Filter posts by author name (case-insensitive)' },
        keyword: { type: 'string', description: 'Filter posts containing this keyword (case-insensitive)' },
        search_query: { type: 'string', description: 'Discovery mode query for LinkedIn content search (keyword or hashtag)' },
        min_engagement: { type: 'number', description: 'Minimum reactions+comments (default: 0)' },
        limit: { type: 'number', description: 'Max posts to return (default: 20)' },
        skip_ai_summary: { type: 'boolean', description: 'Skip AI summary promotion pass (useful for background scraping)' },
        scrape_source: { type: 'string', description: 'Internal label for telemetry (manual, auto, profile name)' },
      },
      required: [],
    },
  };
}

async function handleBrowseFeedTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as {
    scroll?: number; person?: string; keyword?: string;
    min_engagement?: number; limit?: number;
    search_query?: string; skip_ai_summary?: boolean; scrape_source?: string;
  };

  const args: string[] = [];
  const defaultScroll = parseInt(SettingsManager.get('linkedin.feedScroll') || '12', 10);
  const defaultLimit = parseInt(SettingsManager.get('linkedin.feedLimit') || '20', 10);
  const effectiveScroll = Math.max(1, Math.min(24, Number.isFinite(Number(p.scroll)) ? Number(p.scroll) : defaultScroll));
  const effectiveLimit = Math.max(5, Math.min(120, Number.isFinite(Number(p.limit)) ? Number(p.limit) : defaultLimit));
  const searchQuery = String(p.search_query || '').trim();
  const scrapeSource = String(p.scrape_source || '').trim() || (searchQuery ? 'manual:discovery' : 'manual:feed');
  args.push('--scroll', String(effectiveScroll));
  args.push('--limit', String(effectiveLimit));
  if (p.min_engagement) args.push('--min-engagement', String(p.min_engagement));

  // Apply explicit filters or fall back to settings defaults
  const keyword = (searchQuery && !p.keyword) ? '' : (p.keyword || SettingsManager.get('linkedin.feedKeywords'));
  if (p.person) args.push('--person', p.person);
  if (keyword) args.push('--keyword', keyword);
  if (searchQuery) args.push('--search-query', searchQuery);

  // Always dump HTML for diagnostics when feed is empty
  const dumpPath = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'data', 'debug_feed.html');
  args.push('--dump-html', dumpPath);

  try {
    const stdout = await linkedinExec('feed', args, 180000);
    const posts = JSON.parse(stdout);

    if (posts.length === 0) {
      if (searchQuery) {
        recordDiscoveryQueryRun({
          query: searchQuery,
          scraped: 0,
          newPosts: 0,
          refreshedPosts: 0,
          success: true,
          source: scrapeSource,
          scroll: effectiveScroll,
          limit: effectiveLimit,
        });
      }
      // Check what page we actually loaded
      let hint = '';
      try {
        const html = fs.readFileSync(dumpPath, 'utf-8').slice(0, 2000);
        if (html.includes('login') || html.includes('session_redirect')) {
          hint = ' Session expired -re-authentication needed.';
        } else if (html.length < 5000) {
          hint = ` Page was mostly empty (${html.length} bytes) -possible block or empty feed.`;
        } else {
          hint = ` Page loaded (${html.length} bytes) but CSS selectors matched nothing -LinkedIn may have changed their markup.`;
        }
      } catch { /* no dump */ }
      console.warn(`[LinkedIn] Feed returned 0 posts.${hint}`);
      return JSON.stringify({
        success: true, count: 0, posts: [],
        warning: `Feed returned 0 posts.${hint} Debug HTML saved to ${dumpPath}`,
      });
    }

    // Persist scraped posts to DB and refresh existing rows on re-scrape
    const db = getDb();
    let newPosts = posts;
    if (db) {
      try {
        db.exec(`ALTER TABLE linkedin_posts ADD COLUMN source_tag TEXT DEFAULT 'feed:home'`);
      } catch {
        // Column already exists.
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS linkedin_post_content (
          post_id INTEGER PRIMARY KEY REFERENCES linkedin_posts(id) ON DELETE CASCADE,
          post_url TEXT NOT NULL,
          full_text TEXT NOT NULL,
          summary_text TEXT,
          source TEXT DEFAULT 'linkedin_read_post',
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_linkedin_post_content_url ON linkedin_post_content(post_url);
      `);

      const upsert = db.prepare(
        `INSERT INTO linkedin_posts (
           post_url, author, text_preview, reactions, comments, post_type, scraped_date,
           first_seen_reactions, first_seen_comments, last_seen_at, source_tag, times_seen, scrape_status, scrape_status_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 1, 'new', datetime('now'))
         ON CONFLICT(post_url) DO UPDATE SET
           author = excluded.author,
           text_preview = excluded.text_preview,
           reactions = excluded.reactions,
           comments = excluded.comments,
           post_type = excluded.post_type,
           scraped_date = excluded.scraped_date,
           source_tag = CASE
             WHEN excluded.source_tag IS NOT NULL AND TRIM(excluded.source_tag) != ''
             THEN excluded.source_tag
             ELSE COALESCE(linkedin_posts.source_tag, 'feed:home')
           END,
           last_seen_at = datetime('now'),
           times_seen = COALESCE(linkedin_posts.times_seen, 1) + 1,
           scrape_status = CASE
             WHEN linkedin_posts.author != excluded.author
               OR linkedin_posts.text_preview != excluded.text_preview
               OR COALESCE(linkedin_posts.reactions, 0) != COALESCE(excluded.reactions, 0)
               OR COALESCE(linkedin_posts.comments, 0) != COALESCE(excluded.comments, 0)
               OR COALESCE(linkedin_posts.post_type, '') != COALESCE(excluded.post_type, '')
               OR linkedin_posts.scraped_date != excluded.scraped_date
             THEN 'refreshed'
             ELSE 'seen_again'
           END,
           scrape_status_at = datetime('now'),
           first_seen_at = COALESCE(linkedin_posts.first_seen_at, datetime('now')),
           first_seen_reactions = COALESCE(linkedin_posts.first_seen_reactions, excluded.first_seen_reactions),
           first_seen_comments = COALESCE(linkedin_posts.first_seen_comments, excluded.first_seen_comments)`
      );
      const check = db.prepare(
        `SELECT id, author, text_preview, reactions, comments, post_type, scraped_date
         FROM linkedin_posts WHERE post_url = ?`
      );
      const checkByActivity = db.prepare(
        `SELECT post_url
         FROM linkedin_posts
         WHERE post_url LIKE ?
         ORDER BY id DESC
         LIMIT 1`
      );
      const upsertQuickSummary = db.prepare(
        `INSERT INTO linkedin_post_content (post_id, post_url, full_text, summary_text, source, updated_at)
         VALUES (?, ?, '', ?, 'feed_quick_summary', datetime('now'))
         ON CONFLICT(post_id) DO UPDATE SET
           post_url = excluded.post_url,
           full_text = CASE
             WHEN linkedin_post_content.source = 'linkedin_read_post' AND COALESCE(linkedin_post_content.full_text, '') != ''
             THEN linkedin_post_content.full_text
             ELSE linkedin_post_content.full_text
           END,
           summary_text = CASE
             WHEN linkedin_post_content.source = 'linkedin_read_post' AND COALESCE(linkedin_post_content.summary_text, '') != ''
             THEN linkedin_post_content.summary_text
             ELSE excluded.summary_text
           END,
           source = CASE
             WHEN linkedin_post_content.source = 'linkedin_read_post'
             THEN linkedin_post_content.source
             ELSE 'feed_quick_summary'
           END,
           updated_at = datetime('now')`
      );
      type ExistingLinkedInPostRow = {
        id: number;
        author: string;
        text_preview: string;
        reactions: number;
        comments: number;
        post_type: string | null;
        scraped_date: string;
      };
      const today = todayDate();
      const existingUrls = new Set<string>();
      const refreshedUrls = new Set<string>();
      const refreshedPostsByUrl = new Map<string, unknown>();
      type SummaryCandidate = { postId: number; postUrl: string; preview: string };
      const summaryCandidates: SummaryCandidate[] = [];
      const tx = db.transaction(() => {
        for (const post of posts) {
          let normalizedPostUrl = post.post_url ? normalizeLinkedInPostUrl(post.post_url) : '';
          if (normalizedPostUrl) {
            const activityId = extractActivityId(normalizedPostUrl);
            if (activityId) {
              const existingByActivity = checkByActivity.get(`%activity:${activityId}%`) as { post_url?: string } | undefined;
              const canonicalExisting = normalizeLinkedInPostUrl(String(existingByActivity?.post_url || ''));
              if (canonicalExisting) normalizedPostUrl = canonicalExisting;
            }
            post.post_url = normalizedPostUrl;
            const existing = check.get(normalizedPostUrl) as ExistingLinkedInPostRow | undefined;
            const nextAuthor = post.author || 'Unknown';
            const nextPreview = (post.text_preview || '').slice(0, 500);
            const nextReactions = post.reactions || 0;
            const nextComments = post.comments || 0;
            const nextType = normalizeLinkedInPostType(post.type);
            const nextSourceTag = String((post as { source?: string }).source || (p.search_query ? `search:${p.search_query}` : 'feed:home'))
              .trim()
              .slice(0, 120) || 'feed:home';

            if (existing) {
              existingUrls.add(normalizedPostUrl);
              const changed =
                existing.author !== nextAuthor ||
                existing.text_preview !== nextPreview ||
                Number(existing.reactions || 0) !== nextReactions ||
                Number(existing.comments || 0) !== nextComments ||
                (existing.post_type || null) !== nextType ||
                existing.scraped_date !== today;
              if (changed) {
                refreshedUrls.add(normalizedPostUrl);
                refreshedPostsByUrl.set(normalizedPostUrl, post);
              }
            }

            upsert.run(
              normalizedPostUrl,
              nextAuthor,
              nextPreview,
              nextReactions,
              nextComments,
              nextType,
              today,
              nextReactions,
              nextComments,
              nextSourceTag,
            );

            const persisted = check.get(normalizedPostUrl) as ExistingLinkedInPostRow | undefined;
            if (persisted?.id) {
              const quickSummary = buildQuickOverviewSummary(nextPreview);
              if (quickSummary) {
                upsertQuickSummary.run(persisted.id, normalizedPostUrl, quickSummary);
                summaryCandidates.push({
                  postId: persisted.id,
                  postUrl: normalizedPostUrl,
                  preview: nextPreview,
                });
              }
            }
          }
        }
      });
      tx();
      if (!p.skip_ai_summary && isGlmConfigured() && summaryCandidates.length > 0) {
        const promoteAiSummary = db.prepare(
          `UPDATE linkedin_post_content
           SET summary_text = ?, source = 'feed_ai_summary', updated_at = datetime('now')
           WHERE post_id = ?
             AND (source IS NULL OR source != 'linkedin_read_post')`
        );
        const candidateByUrl = new Map<string, SummaryCandidate>();
        for (const c of summaryCandidates) {
          if (!candidateByUrl.has(c.postUrl)) candidateByUrl.set(c.postUrl, c);
        }
        const configuredLimit = Math.max(1, Math.min(200, parseInt(SettingsManager.get('linkedin.feedAiOverviewLimit') || '50', 10) || 50));
        const prioritized = Array.from(candidateByUrl.values())
          .sort((a, b) => {
            const pa = posts.find((p: { post_url?: string }) => p.post_url === a.postUrl) as { reactions?: number; comments?: number } | undefined;
            const pb = posts.find((p: { post_url?: string }) => p.post_url === b.postUrl) as { reactions?: number; comments?: number } | undefined;
            const ea = Number(pa?.reactions || 0) + Number(pa?.comments || 0);
            const eb = Number(pb?.reactions || 0) + Number(pb?.comments || 0);
            return eb - ea;
          })
          .slice(0, configuredLimit);

        for (const candidate of prioritized) {
          const aiSummary = await buildAiOverviewSummary(candidate.preview);
          if (aiSummary) {
            promoteAiSummary.run(aiSummary, candidate.postId);
          }
        }
      }
      // Only return posts that were actually new
      newPosts = posts.filter((p: { post_url?: string }) => p.post_url && !existingUrls.has(p.post_url));
      const refreshedCount = refreshedUrls.size;
      const seenAgainCount = Math.max(0, existingUrls.size - refreshedCount);
      const refreshedPosts = posts.filter((p: { post_url?: string }) => p.post_url && refreshedPostsByUrl.has(p.post_url));
      if (searchQuery) {
        recordDiscoveryQueryRun({
          query: searchQuery,
          scraped: posts.length,
          newPosts: newPosts.length,
          refreshedPosts: refreshedCount,
          success: true,
          source: scrapeSource,
          scroll: effectiveScroll,
          limit: effectiveLimit,
        });
      }
      return JSON.stringify({
        success: true,
        count: newPosts.length,
        total_scraped: posts.length,
        skipped_existing: posts.length - newPosts.length,
        seen_again_existing: seenAgainCount,
        updated_existing: refreshedCount,
        updated_posts: refreshedPosts,
        all_posts: posts,
        posts: newPosts,
      });
    }
    if (searchQuery) {
      recordDiscoveryQueryRun({
        query: searchQuery,
        scraped: posts.length,
        newPosts: newPosts.length,
        refreshedPosts: 0,
        success: true,
        source: scrapeSource,
        scroll: effectiveScroll,
        limit: effectiveLimit,
      });
    }
    return JSON.stringify({
      success: true,
      count: newPosts.length,
      total_scraped: posts.length,
      skipped_existing: posts.length - newPosts.length,
      updated_existing: 0,
      updated_posts: [],
      all_posts: posts,
      posts: newPosts,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] feed failed:', msg);
    if (searchQuery) {
      recordDiscoveryQueryRun({
        query: searchQuery,
        scraped: 0,
        newPosts: 0,
        refreshedPosts: 0,
        success: false,
        source: scrapeSource,
        scroll: effectiveScroll,
        limit: effectiveLimit,
        error: msg,
      });
    }
    return JSON.stringify({ success: false, error: msg });
  }
}

type AutoScrapeFlaggedPost = {
  id: number;
  author: string;
  post_url: string;
  reactions: number;
  comments: number;
  engagement: number;
};

export async function runLinkedInAutoScrapeCycle(input: {
  scroll?: number;
  limit?: number;
  minReactions?: number;
  minComments?: number;
  maxFlagged?: number;
  discoveryEnabled?: boolean;
  discoveryQueries?: string[];
  discoveryScroll?: number;
  discoveryLimit?: number;
} = {}): Promise<{
  success: boolean;
  scraped: number;
  new_posts: number;
  flagged: number;
  flagged_posts: AutoScrapeFlaggedPost[];
  warning?: string;
  error?: string;
}> {
  const minReactions = Math.max(0, Math.floor(input.minReactions ?? 5));
  const minComments = Math.max(0, Math.floor(input.minComments ?? 1));
  const maxFlagged = Math.max(1, Math.min(20, Math.floor(input.maxFlagged ?? 8)));
  const discoveryEnabled = !!input.discoveryEnabled;
  const discoveryQueries = Array.from(new Set((input.discoveryQueries || [])
    .map(q => String(q || '').trim())
    .filter(Boolean)));
  const discoveryScroll = Math.max(1, Math.min(24, Math.floor(input.discoveryScroll ?? Math.max(8, input.scroll ?? 12))));
  const discoveryLimit = Math.max(5, Math.min(120, Math.floor(input.discoveryLimit ?? Math.max(20, input.limit ?? 50))));

  try {
    const parseScrape = (raw: string) => JSON.parse(raw) as {
      success?: boolean;
      error?: string;
      warning?: string;
      total_scraped?: number;
      count?: number;
    };
    let totalScraped = 0;
    let totalNew = 0;
    const warnings: string[] = [];

    const baseScrape = parseScrape(await handleBrowseFeedTool({
      scroll: input.scroll,
      limit: input.limit,
      skip_ai_summary: true,
      scrape_source: 'auto:feed',
    }));
    if (!baseScrape?.success) {
      return {
        success: false,
        scraped: 0,
        new_posts: 0,
        flagged: 0,
        flagged_posts: [],
        error: baseScrape?.error || 'Auto scrape failed',
      };
    }
    totalScraped += Number(baseScrape?.total_scraped || 0);
    totalNew += Number(baseScrape?.count || 0);
    if (baseScrape?.warning) warnings.push(baseScrape.warning);

    if (discoveryEnabled && discoveryQueries.length > 0) {
      for (const query of discoveryQueries) {
        const discovered = parseScrape(await handleBrowseFeedTool({
          search_query: query,
          scroll: discoveryScroll,
          limit: discoveryLimit,
          skip_ai_summary: true,
          scrape_source: 'auto:discovery',
        }));
        if (!discovered?.success) {
          warnings.push(`Discovery '${query}' failed: ${discovered?.error || 'unknown error'}`);
          continue;
        }
        totalScraped += Number(discovered?.total_scraped || 0);
        totalNew += Number(discovered?.count || 0);
        if (discovered?.warning) warnings.push(`Discovery '${query}': ${discovered.warning}`);
      }
    }

    const db = getDb();
    if (!db) {
      return {
        success: false,
        scraped: totalScraped,
        new_posts: totalNew,
        flagged: 0,
        flagged_posts: [],
        error: 'Database not available',
      };
    }

    const today = todayDate();
    const candidates = db.prepare(
      `SELECT id, author, post_url, reactions, comments, priority
       FROM linkedin_posts
       WHERE scraped_date = ?
         AND hidden = 0
         AND commented = 0
         AND (comment_draft IS NULL OR trim(comment_draft) = '')
         AND COALESCE(reactions, 0) >= ?
         AND COALESCE(comments, 0) >= ?
       ORDER BY (COALESCE(reactions, 0) + COALESCE(comments, 0)) DESC, id ASC
       LIMIT ?`
    ).all(today, minReactions, minComments, maxFlagged) as Array<{
      id: number;
      author: string;
      post_url: string;
      reactions: number;
      comments: number;
      priority: string | null;
    }>;

    const alreadyFlagged = db.prepare(
      `SELECT 1
       FROM linkedin_activity_log
       WHERE post_id = ?
         AND action = 'auto_scrape_flagged'
         AND date(created_at, 'localtime') = date('now', 'localtime')
       LIMIT 1`
    );
    const markPriority = db.prepare(
      `UPDATE linkedin_posts
       SET priority = CASE WHEN priority = 'urgent' THEN 'urgent' ELSE 'high' END
       WHERE id = ?`
    );
    const logFlag = db.prepare(
      `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason)
       VALUES (?, ?, 'auto_scrape_flagged', ?)`
    );

    const flaggedPosts: AutoScrapeFlaggedPost[] = [];
    const tx = db.transaction(() => {
      for (const row of candidates) {
        const seen = alreadyFlagged.get(row.id) as { 1: number } | undefined;
        if (seen) continue;
        markPriority.run(row.id);
        logFlag.run(row.id, normalizeLinkedInPostUrl(row.post_url), `engagement:r${row.reactions}:c${row.comments}`);
        flaggedPosts.push({
          id: row.id,
          author: row.author || 'Unknown',
          post_url: normalizeLinkedInPostUrl(row.post_url),
          reactions: Number(row.reactions || 0),
          comments: Number(row.comments || 0),
          engagement: Number(row.reactions || 0) + Number(row.comments || 0),
        });
      }
    });
    tx();

    return {
      success: true,
      scraped: totalScraped,
      new_posts: totalNew,
      flagged: flaggedPosts.length,
      flagged_posts: flaggedPosts,
      warning: warnings.length > 0 ? warnings.slice(0, 4).join(' | ') : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      scraped: 0,
      new_posts: 0,
      flagged: 0,
      flagged_posts: [],
      error: msg,
    };
  }
}

// ============================================================================
// Read Post Tool
// ============================================================================

function getReadPostToolDefinition() {
  return {
    name: 'linkedin_read_post',
    description: `Read the full content of a specific LinkedIn post by URL.

Returns the post author, full text content, and URL as JSON.

Examples:
- linkedin_read_post(url="https://www.linkedin.com/feed/update/urn:li:activity:123/")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'LinkedIn post URL' },
      },
      required: ['url'],
    },
  };
}

async function handleReadPostTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { url: string };
  if (!p.url) return JSON.stringify({ error: 'url is required' });

  try {
    const stdout = await linkedinExec('reply', ['--url', p.url, '--read-only'], 60000);
    const post = JSON.parse(stdout);
    return JSON.stringify({ success: true, ...post });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] read_post failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Comment Tool
// ============================================================================

function getCommentToolDefinition() {
  return {
    name: 'linkedin_comment',
    description: `Comment on a LinkedIn post.

Always pass --no-confirm to avoid hanging on stdin prompt.
The agent should use its own judgment about whether to ask the user for confirmation before commenting.
Check linkedin.autoConfirm setting -if false, ask the user first.

Examples:
- linkedin_comment(url="https://...", comment="Great insights!")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'LinkedIn post URL' },
        comment: { type: 'string', description: 'Comment text to post' },
      },
      required: ['url', 'comment'],
    },
  };
}

// Rate limiter: track last comment time to space them out with randomized delays
let _lastCommentTime = 0;
const ATTEMPT_GUARD_HOURS = 6;
function getCommentDelayMs(): number {
  const baseMins = parseFloat(SettingsManager.get('linkedin.commentDelay') || '3');
  // Keep at or above configured baseline, but still humanized.
  const jitter = 1.0 + Math.random() * 0.4;
  return Math.max(60000, baseMins * jitter * 60 * 1000);
}

function parseDbTsMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ts = Date.parse(`${value}Z`);
  return Number.isFinite(ts) ? ts : 0;
}

function normalizeCommentFingerprint(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPostedSameCommentOnUrl(
  db: Database.Database,
  normalizedUrl: string,
  commentText: string,
): { matched: boolean; postUrl?: string; createdAt?: string } {
  const activityId = extractActivityId(normalizedUrl);
  const rows = activityId
    ? db.prepare(
      `SELECT post_url, comment_text, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND comment_text IS NOT NULL
         AND (post_url = ? OR post_url LIKE ?)
       ORDER BY id DESC
       LIMIT 30`
    ).all(normalizedUrl, `%activity:${activityId}%`) as Array<{ post_url: string; comment_text: string; created_at: string }>
    : db.prepare(
      `SELECT post_url, comment_text, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND comment_text IS NOT NULL
         AND post_url = ?
       ORDER BY id DESC
       LIMIT 30`
    ).all(normalizedUrl) as Array<{ post_url: string; comment_text: string; created_at: string }>;

  const target = normalizeCommentFingerprint(commentText);
  if (!target) return { matched: false };
  for (const row of rows) {
    if (normalizeCommentFingerprint(String(row.comment_text || '')) === target) {
      return { matched: true, postUrl: row.post_url, createdAt: row.created_at };
    }
  }
  return { matched: false };
}

function hasAnyPostedOnUrl(
  db: Database.Database,
  normalizedUrl: string,
): { matched: boolean; postUrl?: string; createdAt?: string } {
  const activityId = extractActivityId(normalizedUrl);
  const row = activityId
    ? db.prepare(
      `SELECT post_url, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND (post_url = ? OR post_url LIKE ?)
       ORDER BY id DESC
       LIMIT 1`
    ).get(normalizedUrl, `%activity:${activityId}%`) as { post_url?: string; created_at?: string } | undefined
    : db.prepare(
      `SELECT post_url, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND post_url = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(normalizedUrl) as { post_url?: string; created_at?: string } | undefined;
  if (!row?.post_url) return { matched: false };
  return { matched: true, postUrl: row.post_url, createdAt: row.created_at };
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

async function handleCommentTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { url: string; comment: string };
  if (!p.url || !p.comment) return JSON.stringify({ error: 'url and comment are required' });
  const normalizedUrl = normalizeLinkedInPostUrl(p.url);
  if (!normalizedUrl) return JSON.stringify({ error: 'url and comment are required' });
  const activityId = extractActivityId(normalizedUrl);

  const db = getDb();
  const dbLastPostedMs = db
    ? parseDbTsMs((db.prepare(
      `SELECT created_at FROM linkedin_activity_log WHERE action = 'posted' ORDER BY id DESC LIMIT 1`
    ).get() as { created_at: string } | undefined)?.created_at)
    : 0;
  const lastPostedMs = Math.max(_lastCommentTime, dbLastPostedMs);

  // Enforce rate limiting between comments
  const now = Date.now();
  const elapsed = now - lastPostedMs;
  const requiredDelayMs = getCommentDelayMs();
  if (lastPostedMs > 0 && elapsed < requiredDelayMs) {
    const remainingMs = requiredDelayMs - elapsed;
    const waitSec = Math.ceil(remainingMs / 1000);
    console.log(`[LinkedIn] Rate limit active: need ${waitSec}s before next comment`);

    let scheduledAt: string | null = null;
    if (db) {
      const post = activityId
        ? db.prepare(
          `SELECT id, approved, commented
           FROM linkedin_posts
           WHERE post_url = ? OR post_url LIKE ?
           ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl, `%activity:${activityId}%`) as { id: number; approved: number; commented: number } | undefined
        : db.prepare(
          `SELECT id, approved, commented FROM linkedin_posts WHERE post_url = ? ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl) as { id: number; approved: number; commented: number } | undefined;
      if (post && post.approved === 1 && post.commented === 0) {
        const alreadyPosted = hasAnyPostedOnUrl(db, normalizedUrl);
        if (alreadyPosted.matched) {
          db.prepare('UPDATE linkedin_posts SET commented = 1, approved = 0, scheduled_at = NULL WHERE id = ?').run(post.id);
        } else {
          scheduledAt = new Date(lastPostedMs + requiredDelayMs).toISOString().replace('T', ' ').slice(0, 19);
          db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?').run(scheduledAt, post.id);
          try {
            const { rebalancePendingSchedules } = await import('./linkedin-autoposter');
            const rebalance = rebalancePendingSchedules({ priorityPostId: post.id, preferredAt: scheduledAt });
            if (rebalance.priorityScheduledAt) scheduledAt = rebalance.priorityScheduledAt;
          } catch (rebalanceErr) {
            console.warn('[LinkedIn] Rate-limit retry schedule rebalance failed:', rebalanceErr);
          }
        }
      }
    }

    return JSON.stringify({
      success: false,
      rate_limited: true,
      retry_after_sec: waitSec,
      scheduled_retry: !!scheduledAt,
      scheduled_at: scheduledAt,
      error: `Cooldown active. Retry in about ${waitSec}s to avoid LinkedIn rate limits.`,
    });
  }

  try {
    // Duplicate guard (URL + same comment text): block repost and ask for follow-up narrative.
    if (db) {
      const alreadyPosted = hasAnyPostedOnUrl(db, normalizedUrl);
      if (alreadyPosted.matched) {
        const existing = activityId
          ? db.prepare(
            `SELECT id
             FROM linkedin_posts
             WHERE post_url = ? OR post_url LIKE ?
             ORDER BY id DESC LIMIT 1`
          ).get(normalizedUrl, `%activity:${activityId}%`) as { id: number } | undefined
          : db.prepare(
            `SELECT id
             FROM linkedin_posts
             WHERE post_url = ?
             ORDER BY id DESC LIMIT 1`
          ).get(normalizedUrl) as { id: number } | undefined;
        if (existing?.id) {
          db.prepare(
            `UPDATE linkedin_posts
             SET commented = 1, approved = 0, scheduled_at = NULL
             WHERE id = ?`
          ).run(existing.id);
        }
        return JSON.stringify({
          success: false,
          duplicate_post_url: true,
          needs_follow_up: true,
          error: 'This URL already has a posted comment. Duplicate posting is blocked. Draft a follow-up narrative instead.',
          post_url: alreadyPosted.postUrl || normalizedUrl,
          first_posted_at: alreadyPosted.createdAt || null,
        });
      }

      const sameComment = hasPostedSameCommentOnUrl(db, normalizedUrl, p.comment);
      if (sameComment.matched) {
        return JSON.stringify({
          success: false,
          duplicate_comment: true,
          needs_follow_up: true,
          error: 'Same comment already posted on this URL. Draft a follow-up narrative instead of reposting.',
          post_url: sameComment.postUrl || normalizedUrl,
          first_posted_at: sameComment.createdAt || null,
        });
      }

      const recentAttempt = activityId
        ? db.prepare(
          `SELECT created_at FROM linkedin_activity_log
           WHERE action IN ('posting_attempt', 'verify_needed')
             AND (post_url = ? OR post_url LIKE ?)
           ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl, `%activity:${activityId}%`) as { created_at: string } | undefined
        : db.prepare(
          `SELECT created_at FROM linkedin_activity_log
           WHERE action IN ('posting_attempt', 'verify_needed')
             AND post_url = ?
           ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl) as { created_at: string } | undefined;
      if (recentAttempt?.created_at) {
        const guardTs = parseDbTsMs(recentAttempt.created_at);
        if (!guardTs || (Date.now() - guardTs) < ATTEMPT_GUARD_HOURS * 60 * 60 * 1000) {
          return JSON.stringify({
            success: false,
            needs_verification: true,
            error: 'Recent uncertain posting attempt detected. Verify on LinkedIn before retrying.',
          });
        }
      }

      const retryStormCount = activityId
        ? (db.prepare(
          `SELECT COUNT(*) as c
           FROM linkedin_activity_log
           WHERE action = 'retry_scheduled'
             AND (post_url = ? OR post_url LIKE ?)`
        ).get(normalizedUrl, `%activity:${activityId}%`) as { c: number } | undefined)?.c || 0
        : (db.prepare(
          `SELECT COUNT(*) as c
           FROM linkedin_activity_log
           WHERE action = 'retry_scheduled'
             AND post_url = ?`
        ).get(normalizedUrl) as { c: number } | undefined)?.c || 0;
      if (retryStormCount >= 3) {
        return JSON.stringify({
          success: false,
          needs_verification: true,
          error: `Legacy retry-storm history detected (${retryStormCount}). Verify on LinkedIn before posting again.`,
        });
      }

      const postForAttempt = activityId
        ? db.prepare(
          `SELECT id FROM linkedin_posts
           WHERE post_url = ? OR post_url LIKE ?
           ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl, `%activity:${activityId}%`) as { id: number } | undefined
        : db.prepare(
          `SELECT id FROM linkedin_posts
           WHERE post_url = ?
           ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl) as { id: number } | undefined;
      if (postForAttempt) {
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason)
           VALUES (?, ?, 'posting_attempt', ?)`
        ).run(postForAttempt.id, normalizedUrl, 'manual');
      }
    }

    // Single attempt only; retry can create duplicate comments if LinkedIn accepts
    // the first submit but response times out.
    let posted = false;
    try {
      await linkedinExec('reply', ['--url', normalizedUrl, '--comment', p.comment, '--no-confirm'], 120000);
      posted = true;
    } catch (err) {
      const maybeStdout = String((err as Error & { stdout?: string }).stdout || '');
      if (maybeStdout.includes('Comment posted successfully')) {
        console.log('[LinkedIn] Comment appears posted despite timeout/error');
        posted = true;
      } else {
        throw err;
      }
    }
    if (!posted) throw new Error('Comment posting failed');
    _lastCommentTime = Date.now();

    if (db) {
      const post = activityId
        ? db.prepare(
          `SELECT id, author, kanban_task_id
           FROM linkedin_posts
           WHERE post_url = ? OR post_url LIKE ?
           ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl, `%activity:${activityId}%`) as { id: number; author: string; kanban_task_id: number | null } | undefined
        : db.prepare(
          `SELECT id, author, kanban_task_id FROM linkedin_posts WHERE post_url = ? ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl) as { id: number; author: string; kanban_task_id: number | null } | undefined;

      if (post) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT OR IGNORE INTO linkedin_activity_log (post_id, post_url, action, comment_text)
           VALUES (?, ?, 'posted', ?)`
        ).run(post.id, normalizedUrl, p.comment);

        if (post.kanban_task_id) {
          try {
            KanbanService.moveTask(post.kanban_task_id, 'done', 'linkedin-comment');
          } catch {
            // Task may be missing/archived
          }
        }
      }
    }

    return JSON.stringify({ success: true, message: 'Comment posted', post_url: normalizedUrl });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] comment failed:', msg);
    if (db) {
      const post = activityId
        ? db.prepare(
          `SELECT id FROM linkedin_posts
           WHERE post_url = ? OR post_url LIKE ?
           ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl, `%activity:${activityId}%`) as { id: number } | undefined
        : db.prepare(
          `SELECT id FROM linkedin_posts WHERE post_url = ? ORDER BY id DESC LIMIT 1`
        ).get(normalizedUrl) as { id: number } | undefined;
      if (post) {
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason)
           VALUES (?, ?, 'verify_needed', ?)`
        ).run(post.id, normalizedUrl, msg.slice(0, 500));
      }
    }
    return JSON.stringify({
      success: false,
      needs_verification: true,
      error: `Comment outcome is uncertain. Verify on LinkedIn before retrying. ${msg}`,
    });
  }
}

// ============================================================================
// Create Post Tool
// ============================================================================

function getCreatePostToolDefinition() {
  return {
    name: 'linkedin_post',
    description: `Create a new LinkedIn post.

Always uses --no-confirm to avoid hanging on stdin prompt.
The agent should use its own judgment about whether to ask the user for confirmation before posting.
Check linkedin.autoConfirm setting -if false, ask the user first.

Examples:
- linkedin_post(text="Excited to share...")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Post text content' },
      },
      required: ['text'],
    },
  };
}

async function handleCreatePostTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { text: string };
  if (!p.text) return JSON.stringify({ error: 'text is required' });

  try {
    await linkedinExec('post', ['--text', p.text, '--no-confirm'], 120000);
    return JSON.stringify({ success: true, message: 'Post published' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] post failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Auth Status Tool
// ============================================================================

function getAuthStatusToolDefinition() {
  return {
    name: 'linkedin_auth_status',
    description: `Check or manage LinkedIn authentication status.

Actions:
- status: Check if authenticated and session age
- validate: Actually test the session by loading LinkedIn
- setup: Start interactive auth (opens browser for manual login)
- clear: Remove all authentication data

The first call may be slow (~60s) if the Python environment needs setup.

Examples:
- linkedin_auth_status(action="status")
- linkedin_auth_status(action="validate")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: status, validate, setup, or clear (default: status)',
        },
      },
      required: [],
    },
  };
}

async function handleAuthStatusTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { action?: string };
  const action = p.action || 'status';

  if (!['status', 'validate', 'setup', 'clear'].includes(action)) {
    return JSON.stringify({ error: 'action must be one of: status, validate, setup, clear' });
  }

  try {
    // setup needs longer timeout since user logs in manually
    const timeout = action === 'setup' ? 600000 : 30000;
    const stdout = await linkedinExec('auth_manager', [action], timeout);
    return JSON.stringify({ success: true, action, output: stdout });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] auth_status failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Classify LinkedIn Posts Tool
// ============================================================================

const LINKEDIN_POST_CATEGORIES = [
  'thought-leadership', 'technical', 'news', 'personal-story',
  'promotional', 'job-posting', 'event', 'question', 'other',
] as const;

function getClassifyPostsToolDefinition() {
  return {
    name: 'classify_linkedin_posts',
    description: `Classify LinkedIn feed posts by type using AI.

Takes an array of posts (from linkedin_feed) and classifies each into one of:
thought-leadership, technical, news, personal-story, promotion, job-posting, event, question, other.

Returns posts with added "type" field, grouped by category.
Requires GLM (worker model) to be configured. Falls back gracefully if not available.

Examples:
- classify_linkedin_posts(posts=<output from linkedin_feed>)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        posts: {
          type: 'array',
          description: 'Array of post objects from linkedin_feed (must have text_preview field)',
          items: {
            type: 'object',
            properties: {
              author: { type: 'string' },
              text_preview: { type: 'string' },
              post_url: { type: 'string' },
              engagement: { type: 'number' },
            },
          },
        },
      },
      required: ['posts'],
    },
  };
}

async function handleClassifyPostsTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { posts: Array<{ author?: string; text_preview?: string; post_url?: string; engagement?: number }> };
  if (!p.posts || !Array.isArray(p.posts)) {
    return JSON.stringify({ error: 'posts array is required' });
  }

  if (!isGlmConfigured()) {
    // Graceful degradation -return posts without classification
    return JSON.stringify({
      success: true,
      classified: false,
      note: 'GLM not configured. Posts returned without classification. Set up a worker model in Settings > Keys.',
      posts: p.posts,
    });
  }

  const CONCURRENCY = 3;
  const classified: Array<Record<string, unknown>> = [];

  // Process in batches of CONCURRENCY
  for (let i = 0; i < p.posts.length; i += CONCURRENCY) {
    const batch = p.posts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (post) => {
        const preview = (post.text_preview || '').slice(0, 500);
        const result = await glmFlash({
          messages: [
            {
              role: 'system',
              content: `Classify this LinkedIn post into exactly ONE of: ${LINKEDIN_POST_CATEGORIES.join(', ')}. Return ONLY the category name, nothing else.`,
            },
            { role: 'user', content: `Author: ${post.author || 'Unknown'}\n\n${preview}` },
          ],
          maxTokens: 20,
          temperature: 0.1,
        });
        const type = result.success && result.content
          ? (normalizeLinkedInPostType(result.content.trim().toLowerCase().replace(/[^a-z-]/g, '')) || 'other')
          : 'other';
        return { ...post, type: LINKEDIN_POST_CATEGORIES.includes(type as typeof LINKEDIN_POST_CATEGORIES[number]) ? type : 'other' };
      })
    );
    for (const r of results) {
      classified.push(r.status === 'fulfilled' ? r.value : { ...batch[results.indexOf(r)], type: 'other' });
    }
  }

  // Group by type
  const byType: Record<string, Array<Record<string, unknown>>> = {};
  for (const post of classified) {
    const t = post.type as string;
    if (!byType[t]) byType[t] = [];
    byType[t].push(post);
  }

  // Persist classification back to DB so LinkedIn Activity matches chat classification.
  const db = getDb();
  if (db) {
    const updateByUrl = db.prepare('UPDATE linkedin_posts SET post_type = ? WHERE post_url = ?');
    const tx = db.transaction(() => {
      for (const post of classified) {
        const postUrl = String(post.post_url || '').trim();
        const nextType = normalizeLinkedInPostType(post.type);
        if (!postUrl || !nextType) continue;
        const normalizedUrl = normalizeLinkedInPostUrl(postUrl);
        updateByUrl.run(nextType, normalizedUrl);
      }
    });
    tx();
  }

  return JSON.stringify({ success: true, classified: true, count: classified.length, posts: classified, by_type: byType });
}

// ============================================================================
// Draft LinkedIn Post Tool
// ============================================================================

const LINKEDIN_STYLES = ['insight', 'story', 'contrarian', 'how-to', 'listicle'] as const;

const STYLE_INSTRUCTIONS: Record<string, string> = {
  insight: 'Share a key insight or lesson learned. Start with a bold hook statement.',
  story: 'Tell a short personal or professional story. Use "I" voice and build to a takeaway.',
  contrarian: 'Challenge a common belief or popular opinion. Start with "Most people think X. They\'re wrong."',
  'how-to': 'Provide actionable steps. Use numbered steps or bullet points.',
  listicle: 'List format with numbered items. Each item should be concise and valuable.',
};

function getDraftPostToolDefinition() {
  return {
    name: 'draft_linkedin_post',
    description: `Generate a LinkedIn post draft from a topic and optional research, storing it in Kanban for review.

Creates a draft using AI with LinkedIn best practices (hook line, short paragraphs, CTA, hashtags).
Stores the draft as a Kanban task in the "LinkedIn" project with status "review" for user approval.

Styles: insight (default), story, contrarian, how-to, listicle

Examples:
- draft_linkedin_post(topic="AI in healthcare", style="insight")
- draft_linkedin_post(topic="Remote work tips", research_report="...", style="how-to")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Topic or theme for the post' },
        research_report: { type: 'string', description: 'Optional research report to base the post on' },
        style: { type: 'string', description: 'Post style: insight, story, contrarian, how-to, listicle (default: insight)' },
        reference_post_url: { type: 'string', description: 'Optional URL of a reference post for style inspiration' },
      },
      required: ['topic'],
    },
  };
}

async function handleDraftPostTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { topic: string; research_report?: string; style?: string; reference_post_url?: string };
  if (!p.topic) return JSON.stringify({ error: 'topic is required' });

  if (!isGlmConfigured()) {
    return JSON.stringify({ error: 'GLM not configured. Set up a worker model in Settings > Keys to generate drafts.' });
  }

  const style = (p.style && LINKEDIN_STYLES.includes(p.style as typeof LINKEDIN_STYLES[number]))
    ? p.style : 'insight';
  const dateContext = dateAwarenessContext();

  // Load user's voice/rules/direction from settings
  const voiceStyle = selectVoiceForPost(style);
  const writingRules = SettingsManager.get('linkedin.writingRules') || '';
  const contentDirection = SettingsManager.get('linkedin.contentDirection') || '';

  let systemPrompt = `You are writing a LinkedIn post as a seasoned practitioner. You sound like someone who has done the work, not someone who researched it. Write from experience and conviction.

Rules:
- Today's date is ${dateContext.humanDate} (${dateContext.isoDate}). Current year is ${dateContext.year}.
- Be strictly date-aware: do not invent month/day/year references.
- If no source context provides a year, avoid using a year in the post.
- Strong hook in the first 1-2 lines
- Short paragraphs (1-3 sentences each), line breaks between them
- NO emojis, NO em-dashes, NO en-dashes. Use commas, periods, or "..." instead
- Vary sentence length: mix short punchy with longer analytical
- No corporate buzzwords, no filler, no "leveraging" or "paradigm shift"
- Sound like a person talking, not an article. Confident but not preachy
- End with a question or call-to-action
- 3-5 relevant hashtags at the end
- Under 1300 characters
- Style: ${STYLE_INSTRUCTIONS[style] || STYLE_INSTRUCTIONS.insight}
- Write the post text ONLY. No meta-commentary.`;

  if (voiceStyle) systemPrompt += `\n\nUSER'S WRITING VOICE:\n${voiceStyle}`;
  if (writingRules) systemPrompt += `\n\nWRITING RULES:\n${writingRules}`;
  if (contentDirection) systemPrompt += `\n\nCONTENT DIRECTION:\n${contentDirection}`;

  let userMessage = `Topic: ${p.topic}`;
  if (p.research_report) {
    userMessage += `\n\nResearch to draw from:\n${p.research_report.slice(0, 3000)}`;
  }
  if (p.reference_post_url) {
    userMessage += `\n\nReference post URL for style inspiration: ${p.reference_post_url}`;
  }

  try {
    const result = await glmChat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      maxTokens: 1024,
      temperature: 0.7,
    });

    if (!result.success || !result.content) {
      return JSON.stringify({ success: false, error: result.error || 'Failed to generate draft' });
    }

    const draft = result.content.trim();

    // Get or create LinkedIn project
    let project = KanbanService.getProjectByName('LinkedIn');
    if (!project) {
      project = KanbanService.createProject('LinkedIn', 'LinkedIn content drafts and posts', '#0a66c2');
    }

    // Create Kanban task with draft as description
    const task = KanbanService.createTask({
      project_id: project.id,
      title: `Draft: ${p.topic.slice(0, 80)}`,
      description: draft,
      status: 'review',
      priority: 'medium',
      tags: 'linkedin,draft',
    });

    const source = p.research_report ? 'Researched online' : 'From LLM knowledge';

    return JSON.stringify({
      success: true,
      draft,
      source,
      kanban_task_id: task.id,
      kanban_project_id: project.id,
      style,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] draft_post failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Draft LinkedIn Comment Tool
// ============================================================================

function getDraftCommentToolDefinition() {
  return {
    name: 'draft_linkedin_comment',
    description: `Generate a comment draft for a LinkedIn post, stored in Kanban for review before posting.

Reads the post content (via text_preview or full text) and generates a relevant, engaging comment.
Stores the draft as a Kanban task in the "LinkedIn" project with status "review".
After user approval, use linkedin_comment to post it.

Examples:
- draft_linkedin_comment(post_url="https://...", post_text="...", tone="supportive")
- draft_linkedin_comment(post_url="https://...", post_text="...", tone="insightful", instruction="mention our experience with RAG")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        post_url: { type: 'string', description: 'LinkedIn post URL to comment on' },
        post_text: { type: 'string', description: 'Post content (text_preview or full text)' },
        post_author: { type: 'string', description: 'Post author name (for context)' },
        tone: { type: 'string', description: 'Comment tone: supportive, insightful, contrarian, curious, congratulatory (default: insightful)' },
        instruction: { type: 'string', description: 'Optional specific instruction for the comment (e.g. "mention our product", "share a personal anecdote")' },
      },
      required: ['post_url', 'post_text'],
    },
  };
}

const COMMENT_TONES: Record<string, string> = {
  supportive: 'Agree with the author and add value by sharing a complementary perspective or example.',
  insightful: 'Add a unique insight, data point, or perspective that extends the conversation.',
  contrarian: 'Respectfully challenge or offer an alternative viewpoint. Be constructive, not combative.',
  curious: 'Ask a thoughtful follow-up question that shows genuine interest and sparks discussion.',
  congratulatory: 'Celebrate the author\'s achievement or milestone with genuine enthusiasm.',
};

async function handleDraftCommentTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { post_url: string; post_text: string; post_author?: string; tone?: string; instruction?: string };
  if (!p.post_url || !p.post_text) {
    return JSON.stringify({ error: 'post_url and post_text are required' });
  }

  if (!isGlmConfigured()) {
    return JSON.stringify({ error: 'GLM not configured. Set up a worker model in Settings > Keys to generate comment drafts.' });
  }

  const tone = (p.tone && p.tone in COMMENT_TONES) ? p.tone : 'insightful';
  const authorFirstName = getAuthorFirstName(p.post_author);
  const dateContext = dateAwarenessContext();
  const authorOpeningRule = authorFirstName
    ? `Start sentence 1 with "${authorFirstName}," and then acknowledge a concrete point from their post.`
    : 'Start sentence 1 by acknowledging a concrete point from the post.';

  // Load user's voice/rules from settings
  const voiceStyle = selectVoiceForPost(null);
  const writingRules = SettingsManager.get('linkedin.writingRules') || '';

  let systemPrompt = `You are a real person leaving a LinkedIn comment. You have hands-on experience in this field.

ABSOLUTE RULES (violating any = failure):
1. PUNCTUATION: NEVER use em dashes (—) or en dashes (–). Use commas, periods, semicolons, or parentheses. If you write a single em dash the comment fails.
2. BANNED WORDS (never use any of these): crucial, mastery, landscape, leverage, comprehensive, cutting-edge, game-changer, robust, harness, elevate, delve, foster, transformative, revolutionize, unleash, paradigm, synergy, holistic, pivotal, invaluable, navigate, realm, streamline, optimize, facilitate, enhance, innovative, empower, insightful, groundbreaking, remarkable, impressive, prevalent, crucial, utilize, ecosystem, unprecedented
3. NO emojis, NO hashtags
4. Never start with "Great post", "Thanks for sharing", "This is so important", "Absolutely", "100%"
5. Today's date is ${dateContext.humanDate} (${dateContext.isoDate}); current year is ${dateContext.year}. Never invent year/month/day references. If year is not in the post context, do not add one.

STYLE:
- 2-4 sentences. Be specific to what the author actually said.
- ${authorOpeningRule}
- Sound like a comment from someone who does this work daily, not someone summarizing it.
- Reference a concrete detail from the post. Add your own angle or experience.
- Short punchy sentences mixed with longer ones. Casual but smart.
- Use 2-4 short paragraphs with line breaks, avoid one dense wall of text.
- ${COMMENT_TONES[tone]}
- Write the comment text ONLY. No explanation or meta-commentary.

Check your output: scan for em dashes and banned words. Fix before returning.`;

  if (voiceStyle) systemPrompt += `\n\nUSER'S WRITING VOICE:\n${voiceStyle}`;
  if (writingRules) systemPrompt += `\n\nWRITING RULES:\n${writingRules}`;

  let userMessage = `Post by ${p.post_author || 'someone'}:\n${p.post_text.slice(0, 2000)}`;
  if (p.instruction) {
    userMessage += `\n\nSpecific instruction: ${p.instruction}`;
  }

  try {
    const result = await glmChat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      maxTokens: 512,
      temperature: 0.3,
    });

    if (!result.success || !result.content) {
      return JSON.stringify({ success: false, error: result.error || 'Failed to generate comment draft' });
    }

    // Post-process: strip em dashes and en dashes that the model sneaks in
    const draft = ensureReadableCommentLayout(result.content.trim()
      .replace(/\s*—\s*/g, ', ')
      .replace(/\s*–\s*/g, ', ')
      .replace(/,,/g, ','));

    // Get or create LinkedIn project
    let project = KanbanService.getProjectByName('LinkedIn');
    if (!project) {
      project = KanbanService.createProject('LinkedIn', 'LinkedIn content drafts and posts', '#0a66c2');
    }

    const title = `Comment on ${p.post_author ? p.post_author + "'s post" : 'post'}: ${p.post_text.slice(0, 60)}...`;

    // Check if there's an existing kanban task for this post (redo scenario)
    const db = getDb();
    let existingTaskId: number | null = null;
    if (db) {
      const existing = db.prepare('SELECT kanban_task_id FROM linkedin_posts WHERE post_url = ?').get(p.post_url) as { kanban_task_id?: number } | undefined;
      if (existing?.kanban_task_id) existingTaskId = existing.kanban_task_id;
    }

    let taskId: number;
    if (existingTaskId) {
      // Update existing kanban task with new draft
      KanbanService.updateTask(existingTaskId, {
        description: `${draft}\n\n---\nPost URL: ${p.post_url}`,
        status: 'review',
      });
      KanbanService.addComment(existingTaskId, `Draft redone:\n${draft}`);
      taskId = existingTaskId;
    } else {
      // Create new kanban task
      const task = KanbanService.createTask({
        project_id: project.id,
        title: title.slice(0, 120),
        description: `${draft}\n\n---\nPost URL: ${p.post_url}`,
        status: 'review',
        priority: 'medium',
        tags: 'linkedin,comment',
      });
      taskId = task.id;
    }

    // Store draft and kanban link in DB
    if (db) {
      db.prepare('UPDATE linkedin_posts SET comment_draft = ?, kanban_task_id = ? WHERE post_url = ?')
        .run(draft, taskId, p.post_url);
    }

    return JSON.stringify({
      success: true,
      draft,
      source: 'From LLM knowledge',
      post_url: p.post_url,
      kanban_task_id: taskId,
      kanban_project_id: project.id,
      tone,
      redone: !!existingTaskId,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] draft_comment failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Revise LinkedIn Draft Tool
// ============================================================================

function getReviseDraftToolDefinition() {
  return {
    name: 'revise_linkedin_draft',
    description: `Revise an existing LinkedIn draft (post or comment) based on user feedback.

Reads the current draft from a Kanban task, applies the feedback using AI, and updates the task.
The task stays in "review" status for further iteration or approval.
Works with both post drafts (from draft_linkedin_post) and comment drafts (from draft_linkedin_comment).

Examples:
- revise_linkedin_draft(kanban_task_id=42, feedback="Make it shorter and more punchy")
- revise_linkedin_draft(kanban_task_id=42, feedback="Add more data points")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        kanban_task_id: { type: 'number', description: 'Kanban task ID containing the draft' },
        feedback: { type: 'string', description: 'User feedback for revision' },
      },
      required: ['kanban_task_id', 'feedback'],
    },
  };
}

async function handleReviseDraftTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { kanban_task_id: number; feedback: string };
  if (!p.kanban_task_id || !p.feedback) {
    return JSON.stringify({ error: 'kanban_task_id and feedback are required' });
  }

  if (!isGlmConfigured()) {
    return JSON.stringify({ error: 'GLM not configured. Set up a worker model in Settings > Keys.' });
  }

  const task = KanbanService.getTask(p.kanban_task_id);
  if (!task) {
    return JSON.stringify({ error: `Kanban task #${p.kanban_task_id} not found` });
  }

  const currentDraft = task.description || '';
  if (!currentDraft) {
    return JSON.stringify({ error: `Task #${p.kanban_task_id} has no draft content in description` });
  }

  try {
    const result = await glmChat({
      messages: [
        {
          role: 'system',
          content: 'You are revising a LinkedIn post draft. Apply the user\'s feedback while maintaining LinkedIn best practices (hook line, short paragraphs, CTA, hashtags). Return ONLY the revised post text.',
        },
        {
          role: 'user',
          content: `Original draft:\n${currentDraft}\n\nFeedback:\n${p.feedback}\n\nRevise the post accordingly.`,
        },
      ],
      maxTokens: 1024,
      temperature: 0.7,
    });

    if (!result.success || !result.content) {
      return JSON.stringify({ success: false, error: result.error || 'Failed to revise draft' });
    }

    const revisedDraft = result.content.trim();

    // Update Kanban task with revised draft, keep in review
    KanbanService.updateTask(p.kanban_task_id, {
      description: revisedDraft,
      status: 'review',
    });

    return JSON.stringify({
      success: true,
      draft: revisedDraft,
      kanban_task_id: p.kanban_task_id,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] revise_draft failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Today's Saved Posts Tool
// ============================================================================

function getTodayPostsToolDefinition() {
  return {
    name: 'linkedin_today_posts',
    description: `Recall today's scraped LinkedIn posts from the database.

Returns posts that were scraped today, sorted by engagement (reactions + comments) descending.
Use this when the user references posts by number after a session restart -the posts persist in the database.

Optionally filter by date (defaults to today) or author.

Examples:
- linkedin_today_posts() -get all posts scraped today
- linkedin_today_posts(date="2026-02-26") -get yesterday's posts
- linkedin_today_posts(author="Sam Altman") -filter by author`,
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date to query (YYYY-MM-DD, default: today)' },
        author: { type: 'string', description: 'Filter by author name (case-insensitive)' },
      },
      required: [],
    },
  };
}

async function handleTodayPostsTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not available' });
  }

  const p = input as { date?: string; author?: string };
  const date = p.date || todayDate();

  let query = 'SELECT * FROM linkedin_posts WHERE scraped_date = ?';
  const params: (string | number)[] = [date];

  if (p.author) {
    query += ' AND author LIKE ?';
    params.push(`%${p.author}%`);
  }

  query += ' ORDER BY (reactions + comments) DESC';

  try {
    const posts = db.prepare(query).all(...params);
    return JSON.stringify({ success: true, date, count: posts.length, posts });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// LinkedIn Activity Dashboard Tool
// ============================================================================

function getLinkedInActivityDashboardToolDefinition() {
  return {
    name: 'linkedin_activity_dashboard',
    description: `Show a compact LinkedIn activity dashboard from the local database.

Returns summary counts for a date (default: today): scraped, drafted, undrafted, approved, scheduled, published.
Also returns small lists of next scheduled posts and approved posts ready for posting.

Use this when the user asks for LinkedIn status/activity from Telegram or desktop.

Examples:
- linkedin_activity_dashboard()
- linkedin_activity_dashboard(date="2026-02-27", limit=8)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date to inspect (YYYY-MM-DD). Default: today' },
        limit: { type: 'number', description: 'Max posts to include in list sections (default: 10, max: 30)' },
      },
      required: [],
    },
  };
}

async function handleLinkedInActivityDashboardTool(input: unknown): Promise<string> {
  const db = getDb();
  if (!db) {
    return JSON.stringify({ success: false, error: 'Database not available' });
  }

  const p = input as { date?: string; limit?: number };
  const date = p.date || todayDate();
  const limit = Math.max(3, Math.min(30, Math.floor(p.limit || 10)));

  try {
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS scraped,
        SUM(CASE WHEN comment_draft IS NOT NULL AND commented = 0 THEN 1 ELSE 0 END) AS drafted,
        SUM(CASE WHEN (comment_draft IS NULL OR comment_draft = '') AND commented = 0 THEN 1 ELSE 0 END) AS undrafted,
        SUM(CASE WHEN approved = 1 AND commented = 0 THEN 1 ELSE 0 END) AS approved_pending,
        SUM(CASE WHEN scheduled_at IS NOT NULL AND commented = 0 THEN 1 ELSE 0 END) AS scheduled_pending,
        SUM(CASE WHEN commented = 1 THEN 1 ELSE 0 END) AS published,
        SUM(CASE WHEN hidden = 1 THEN 1 ELSE 0 END) AS hidden
      FROM linkedin_posts
      WHERE scraped_date = ?
    `).get(date) as {
      scraped: number; drafted: number; undrafted: number; approved_pending: number;
      scheduled_pending: number; published: number; hidden: number;
    };

    const nextScheduled = db.prepare(`
      SELECT id, author, post_url, priority, scheduled_at
      FROM linkedin_posts
      WHERE commented = 0 AND scheduled_at IS NOT NULL AND hidden = 0
      ORDER BY datetime(scheduled_at) ASC
      LIMIT ?
    `).all(limit);

    const readyToPost = db.prepare(`
      SELECT id, author, post_url, priority, reactions, comments, scheduled_at
      FROM linkedin_posts
      WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL AND hidden = 0
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END,
        CASE WHEN scheduled_at IS NULL THEN 1 ELSE 0 END,
        datetime(scheduled_at) ASC,
        (reactions + comments) DESC
      LIMIT ?
    `).all(limit);

    const recentPosted = db.prepare(`
      SELECT post_id, post_url, created_at
      FROM linkedin_activity_log
      WHERE action = 'posted' AND date(created_at) = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(date, limit);

    const postedToday = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_activity_log
       WHERE action = 'posted' AND date(created_at, 'localtime') = ?`
    ).get(date) as { c: number }).c;

    const failedToday = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_activity_log
       WHERE action IN ('failed', 'error') AND date(created_at, 'localtime') = ?`
    ).get(date) as { c: number }).c;

    const approvedUnscheduled = (db.prepare(
      `SELECT COUNT(*) as c
       FROM linkedin_posts
       WHERE approved = 1 AND commented = 0 AND hidden = 0
         AND (scheduled_at IS NULL OR scheduled_at = '')`
    ).get() as { c: number }).c;

    const autoPosterEnabled = SettingsManager.get('linkedin.autoPosterEnabled') === 'true';

    return JSON.stringify({
      success: true,
      date,
      autoPosterEnabled,
      summary: {
        scraped: summary?.scraped || 0,
        drafted: summary?.drafted || 0,
        undrafted: summary?.undrafted || 0,
        approved_pending: summary?.approved_pending || 0,
        scheduled_pending: summary?.scheduled_pending || 0,
        published: summary?.published || 0,
        hidden: summary?.hidden || 0,
        posted_today: postedToday,
        failed_today: failedToday,
        approved_unscheduled: approvedUnscheduled,
      },
      next_scheduled: nextScheduled,
      ready_to_post: readyToPost,
      posted_today_items: recentPosted,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Schedule Approved LinkedIn Drafts Tool
// ============================================================================

function getScheduleApprovedLinkedInToolDefinition() {
  return {
    name: 'linkedin_schedule_approved',
    description: `Schedule approved LinkedIn comment drafts across a time window.

This picks approved drafts (not yet commented), ordered by priority, and assigns scheduled_at timestamps.
Useful for requests like "schedule 3 posts in the next 15 minutes".

Examples:
- linkedin_schedule_approved(count=3, window_minutes=15)
- linkedin_schedule_approved(count=5, window_minutes=45, start_in_minutes=5)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'How many approved drafts to schedule (default: 3)' },
        window_minutes: { type: 'number', description: 'Total scheduling window in minutes (default: 15)' },
        start_in_minutes: { type: 'number', description: 'Delay before first scheduled post (default: 0)' },
        include_already_scheduled: { type: 'boolean', description: 'If true, allow rescheduling already scheduled drafts (default: false)' },
      },
      required: [],
    },
  };
}

async function handleScheduleApprovedLinkedInTool(input: unknown): Promise<string> {
  const db = getDb();
  if (!db) {
    return JSON.stringify({ success: false, error: 'Database not available' });
  }

  const p = input as {
    count?: number;
    window_minutes?: number;
    start_in_minutes?: number;
    include_already_scheduled?: boolean;
  };
  const count = Math.max(1, Math.min(20, Math.floor(p.count || 3)));
  const windowMinutes = Math.max(1, Math.min(180, Math.floor(p.window_minutes || 15)));
  const startInMinutes = Math.max(0, Math.min(180, Math.floor(p.start_in_minutes || 0)));
  const includeScheduled = !!p.include_already_scheduled;

  try {
    const scheduledClause = includeScheduled ? '' : 'AND scheduled_at IS NULL';
    const candidates = db.prepare(`
      SELECT id, author, post_url, priority
      FROM linkedin_posts
      WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL AND hidden = 0
        ${scheduledClause}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END,
        (reactions + comments) DESC,
        id ASC
      LIMIT ?
    `).all(count) as Array<{ id: number; author: string; post_url: string; priority: string }>;

    if (candidates.length === 0) {
      return JSON.stringify({
        success: false,
        scheduled: 0,
        error: 'No approved drafts available to schedule',
      });
    }

    const markPosted = db.prepare(
      `UPDATE linkedin_posts
       SET commented = 1, approved = 0, scheduled_at = NULL
       WHERE id = ?`
    );
    const eligible: Array<{ id: number; author: string; post_url: string; priority: string }> = [];
    let blockedDuplicates = 0;
    for (const c of candidates) {
      const normalized = normalizeLinkedInPostUrl(c.post_url);
      if (normalized && hasAnyPostedOnUrl(db, normalized).matched) {
        markPosted.run(c.id);
        blockedDuplicates += 1;
        continue;
      }
      eligible.push(c);
    }
    if (eligible.length === 0) {
      return JSON.stringify({
        success: false,
        scheduled: 0,
        blocked_duplicates: blockedDuplicates,
        error: 'No approved drafts available to schedule (duplicate URL guard blocked all candidates).',
      });
    }

    const baseMs = Date.now() + startInMinutes * 60 * 1000;
    const windowMs = windowMinutes * 60 * 1000;
    const stepMs = eligible.length <= 1 ? 0 : Math.max(60 * 1000, Math.floor(windowMs / (eligible.length - 1)));

    const setSchedule = db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (let i = 0; i < eligible.length; i++) {
        const runAt = new Date(baseMs + i * stepMs).toISOString().replace('T', ' ').slice(0, 19);
        setSchedule.run(runAt, eligible[i].id);
      }
    });
    tx();

    let rebalanceAdjusted = 0;
    let rebalanceWarning: string | undefined;
    try {
      const { rebalancePendingSchedules } = await import('./linkedin-autoposter');
      const rebalance = rebalancePendingSchedules();
      rebalanceAdjusted = rebalance.adjusted;
      if (rebalance.warning) rebalanceWarning = rebalance.warning;
    } catch (rebalanceErr) {
      console.warn('[LinkedIn] schedule_approved rebalance failed:', rebalanceErr);
      rebalanceWarning = 'Scheduled, but could not rebalance pending posts.';
    }

    const getScheduledAt = db.prepare('SELECT scheduled_at FROM linkedin_posts WHERE id = ?');
    const scheduledItems = eligible.map((c, i) => ({
      id: c.id,
      author: c.author,
      priority: c.priority,
      scheduled_at: ((getScheduledAt.get(c.id) as { scheduled_at?: string } | undefined)?.scheduled_at)
        || new Date(baseMs + i * stepMs).toISOString().replace('T', ' ').slice(0, 19),
      post_url: c.post_url,
    }));

    const remaining = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_posts WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL AND hidden = 0`
    ).get() as { c: number }).c;

    return JSON.stringify({
      success: true,
      scheduled: scheduledItems.length,
      requested: count,
      blocked_duplicates: blockedDuplicates,
      window_minutes: windowMinutes,
      start_in_minutes: startInMinutes,
      rebalance_adjusted: rebalanceAdjusted,
      warning: rebalanceWarning,
      items: scheduledItems,
      remaining_approved: Math.max(0, remaining - scheduledItems.length),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Save Draft Tool (for agent-written comments, bypassing GLM)
// ============================================================================

function getSaveDraftToolDefinition() {
  return {
    name: 'linkedin_save_draft',
    description: `Save a comment draft that YOU (the agent) wrote directly. Use this instead of draft_linkedin_comment when you want to write the comment yourself for better quality.

This saves the draft to the LinkedIn posts database and creates/updates a Kanban task.

Parameters:
- post_id: The numeric ID of the LinkedIn post in the database
- draft: The comment text to save
- post_url: (optional) The LinkedIn post URL, used for Kanban description`,
    input_schema: {
      type: 'object' as const,
      properties: {
        post_id: { type: 'number', description: 'LinkedIn post database ID' },
        draft: { type: 'string', description: 'The comment text to save as draft' },
        post_url: { type: 'string', description: 'LinkedIn post URL (optional)' },
      },
      required: ['post_id', 'draft'],
    },
  };
}

async function handleSaveDraftTool(input: unknown): Promise<string> {
  const p = input as { post_id: number; draft: string; post_url?: string };
  if (!p.post_id || !p.draft) {
    return JSON.stringify({ error: 'post_id and draft are required' });
  }

  try {
    const db = getDb();
    if (!db) return JSON.stringify({ error: 'Database not available' });

    // Get existing post data
    const post = db.prepare('SELECT post_url, kanban_task_id, author, text_preview FROM linkedin_posts WHERE id = ?')
      .get(p.post_id) as { post_url: string; kanban_task_id?: number; author: string; text_preview: string } | undefined;
    if (!post) return JSON.stringify({ error: `Post ID ${p.post_id} not found` });

    const postUrl = p.post_url || post.post_url;

    // Post-process: strip em/en dashes
    const cleanDraft = p.draft.trim()
      .replace(/\s*—\s*/g, ', ')
      .replace(/\s*–\s*/g, ', ')
      .replace(/,,/g, ',');

    // Quality gate: reject short/weak drafts back to the agent
    const sentenceCount = cleanDraft.split(/[.!?]+/).filter((s: string) => s.trim().length > 8).length;
    if (cleanDraft.length < 320) {
      return JSON.stringify({ success: false, error: `Draft too short (${cleanDraft.length} chars, need 320+). Match length to topic depth: simple topics 4-5 sentences (~400 chars), complex topics 6-10 sentences (~800-1500 chars).` });
    }
    if (sentenceCount < 3) {
      return JSON.stringify({ success: false, error: `Draft has only ${sentenceCount} sentence(s), need at least 3. Write a substantive comment with a concrete fact, your own angle, and a sharp question.` });
    }
    const authorFirst = (post.author || '').split(/\s+/)[0] || '';
    if (authorFirst && !new RegExp(`^["'""''(\\[\\s]*${authorFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(cleanDraft)) {
      return JSON.stringify({ success: false, error: `Draft must start with "${authorFirst}," addressing the author by name. Rewrite the opening sentence.` });
    }
    const fluffPattern = /\b(great post|thanks for sharing|spot on|love this|well said|couldn't agree more)\b/i;
    if (fluffPattern.test(cleanDraft)) {
      return JSON.stringify({ success: false, error: 'Draft contains generic praise ("great post", "thanks for sharing", etc.). Remove fluff and add substance.' });
    }

    // Get or create LinkedIn project
    let project = KanbanService.getProjectByName('LinkedIn');
    if (!project) {
      project = KanbanService.createProject('LinkedIn', 'LinkedIn content drafts and posts', '#0a66c2');
    }

    let taskId: number;
    if (post.kanban_task_id) {
      // Update existing kanban task
      KanbanService.updateTask(post.kanban_task_id, {
        description: `${cleanDraft}\n\n---\nPost URL: ${postUrl}`,
        status: 'review',
      });
      KanbanService.addComment(post.kanban_task_id, `Draft rewritten by agent:\n${cleanDraft}`);
      taskId = post.kanban_task_id;
    } else {
      // Create new kanban task
      const title = `Comment on ${post.author ? post.author + "'s post" : 'post'}: ${post.text_preview.slice(0, 60)}...`;
      const task = KanbanService.createTask({
        project_id: project.id,
        title: title.slice(0, 120),
        description: `${cleanDraft}\n\n---\nPost URL: ${postUrl}`,
        status: 'review',
        priority: 'medium',
        tags: 'linkedin,comment',
      });
      taskId = task.id;
    }

    // Save to linkedin_posts
    db.prepare('UPDATE linkedin_posts SET comment_draft = ?, kanban_task_id = ? WHERE id = ?')
      .run(cleanDraft, taskId, p.post_id);

    return JSON.stringify({
      success: true,
      draft: cleanDraft,
      post_id: p.post_id,
      kanban_task_id: taskId,
      redone: !!post.kanban_task_id,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] save_draft failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Export
// ============================================================================

export function getLinkedInTools() {
  return [
    { ...getBrowseFeedToolDefinition(), handler: handleBrowseFeedTool },
    { ...getReadPostToolDefinition(), handler: handleReadPostTool },
    { ...getCommentToolDefinition(), handler: handleCommentTool },
    { ...getCreatePostToolDefinition(), handler: handleCreatePostTool },
    { ...getAuthStatusToolDefinition(), handler: handleAuthStatusTool },
    { ...getClassifyPostsToolDefinition(), handler: handleClassifyPostsTool },
    { ...getDraftPostToolDefinition(), handler: handleDraftPostTool },
    { ...getDraftCommentToolDefinition(), handler: handleDraftCommentTool },
    { ...getReviseDraftToolDefinition(), handler: handleReviseDraftTool },
    { ...getTodayPostsToolDefinition(), handler: handleTodayPostsTool },
    { ...getLinkedInActivityDashboardToolDefinition(), handler: handleLinkedInActivityDashboardTool },
    { ...getScheduleApprovedLinkedInToolDefinition(), handler: handleScheduleApprovedLinkedInTool },
    { ...getSaveDraftToolDefinition(), handler: handleSaveDraftTool },
  ];
}

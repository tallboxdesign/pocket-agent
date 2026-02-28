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
      return _db;
    }
  }
  return null;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
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
- linkedin_feed(min_engagement=50, limit=10) -high-engagement posts only`,
    input_schema: {
      type: 'object' as const,
      properties: {
        scroll: { type: 'number', description: 'Number of scroll iterations (default: 3, more = more posts but slower)' },
        person: { type: 'string', description: 'Filter posts by author name (case-insensitive)' },
        keyword: { type: 'string', description: 'Filter posts containing this keyword (case-insensitive)' },
        min_engagement: { type: 'number', description: 'Minimum reactions+comments (default: 0)' },
        limit: { type: 'number', description: 'Max posts to return (default: 20)' },
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
  };

  const args: string[] = [];
  const defaultScroll = parseInt(SettingsManager.get('linkedin.feedScroll') || '3', 10);
  const defaultLimit = parseInt(SettingsManager.get('linkedin.feedLimit') || '20', 10);
  args.push('--scroll', String(p.scroll || defaultScroll));
  args.push('--limit', String(p.limit || defaultLimit));
  if (p.min_engagement) args.push('--min-engagement', String(p.min_engagement));

  // Apply explicit filters or fall back to settings defaults
  const keyword = p.keyword || SettingsManager.get('linkedin.feedKeywords');
  if (p.person) args.push('--person', p.person);
  if (keyword) args.push('--keyword', keyword);

  // Always dump HTML for diagnostics when feed is empty
  const dumpPath = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'data', 'debug_feed.html');
  args.push('--dump-html', dumpPath);

  try {
    const stdout = await linkedinExec('feed', args, 180000);
    const posts = JSON.parse(stdout);

    if (posts.length === 0) {
      // Check what page we actually loaded
      let hint = '';
      try {
        const html = fs.readFileSync(dumpPath, 'utf-8').slice(0, 2000);
        if (html.includes('login') || html.includes('session_redirect')) {
          hint = ' Session expired -re-authentication needed.';
        } else if (html.length < 5000) {
          hint = ` Page was mostly empty (${html.length} bytes) -possible rate limit or blocked.`;
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

    // Persist scraped posts to DB, track which are new
    const db = getDb();
    let newPosts = posts;
    if (db) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO linkedin_posts (post_url, author, text_preview, reactions, comments, post_type, scraped_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const check = db.prepare('SELECT id FROM linkedin_posts WHERE post_url = ?');
      const today = todayDate();
      const existingUrls = new Set<string>();
      const tx = db.transaction(() => {
        for (const post of posts) {
          if (post.post_url) {
            const existing = check.get(post.post_url);
            if (existing) existingUrls.add(post.post_url);
            insert.run(
              post.post_url,
              post.author || 'Unknown',
              (post.text_preview || '').slice(0, 500),
              post.reactions || 0,
              post.comments || 0,
              post.type || null,
              today,
            );
          }
        }
      });
      tx();
      // Only return posts that were actually new
      newPosts = posts.filter((p: { post_url?: string }) => p.post_url && !existingUrls.has(p.post_url));
    }

    return JSON.stringify({ success: true, count: newPosts.length, total_scraped: posts.length, skipped_existing: posts.length - newPosts.length, posts: newPosts });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] feed failed:', msg);
    return JSON.stringify({ success: false, error: msg });
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

async function handleCommentTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { url: string; comment: string };
  if (!p.url || !p.comment) return JSON.stringify({ error: 'url and comment are required' });

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
      const post = db.prepare(
        `SELECT id, approved, commented FROM linkedin_posts WHERE post_url = ? ORDER BY id DESC LIMIT 1`
      ).get(p.url) as { id: number; approved: number; commented: number } | undefined;
      if (post && post.approved === 1 && post.commented === 0) {
        scheduledAt = new Date(lastPostedMs + requiredDelayMs).toISOString().replace('T', ' ').slice(0, 19);
        db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?').run(scheduledAt, post.id);
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
    // Double-post guard: check if already commented
    if (db) {
      const check = db.prepare('SELECT commented FROM linkedin_posts WHERE post_url = ? ORDER BY id DESC LIMIT 1').get(p.url) as { commented: number } | undefined;
      if (check && check.commented === 1) {
        return JSON.stringify({ success: false, error: 'Already posted on this post' });
      }
    }

    // Retry once with longer timeout if first attempt fails
    let posted = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const timeout = attempt === 1 ? 120000 : 150000;
        await linkedinExec('reply', ['--url', p.url, '--comment', p.comment, '--no-confirm'], timeout);
        posted = true;
        break;
      } catch (retryErr) {
        console.error(`[LinkedIn] comment attempt ${attempt}/2 failed:`, retryErr);
        if (attempt < 2) await new Promise(r => setTimeout(r, 10000));
      }
    }
    if (!posted) throw new Error('Comment posting failed after 2 attempts');
    _lastCommentTime = Date.now();

    if (db) {
      const post = db.prepare(
        `SELECT id, author, kanban_task_id FROM linkedin_posts WHERE post_url = ? ORDER BY id DESC LIMIT 1`
      ).get(p.url) as { id: number; author: string; kanban_task_id: number | null } | undefined;

      if (post) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, scheduled_at = NULL WHERE id = ?').run(post.id);
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, comment_text)
           VALUES (?, ?, 'posted', ?)`
        ).run(post.id, p.url, p.comment);

        if (post.kanban_task_id) {
          try {
            KanbanService.moveTask(post.kanban_task_id, 'done', 'linkedin-comment');
          } catch {
            // Task may be missing/archived
          }
        }
      }
    }

    return JSON.stringify({ success: true, message: 'Comment posted', post_url: p.url });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] comment failed:', msg);
    if (db) {
      const post = db.prepare(
        `SELECT id FROM linkedin_posts WHERE post_url = ? ORDER BY id DESC LIMIT 1`
      ).get(p.url) as { id: number } | undefined;
      if (post) {
        db.prepare(
          `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason)
           VALUES (?, ?, 'failed', ?)`
        ).run(post.id, p.url, msg);
      }
    }
    return JSON.stringify({ success: false, error: msg });
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
  'promotion', 'job-posting', 'event', 'question', 'other',
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
          ? result.content.trim().toLowerCase().replace(/[^a-z-]/g, '')
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

  // Load user's voice/rules/direction from settings
  const voiceStyle = selectVoiceForPost(style);
  const writingRules = SettingsManager.get('linkedin.writingRules') || '';
  const contentDirection = SettingsManager.get('linkedin.contentDirection') || '';

  let systemPrompt = `You are writing a LinkedIn post as a seasoned practitioner. You sound like someone who has done the work, not someone who researched it. Write from experience and conviction.

Rules:
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

    const baseMs = Date.now() + startInMinutes * 60 * 1000;
    const windowMs = windowMinutes * 60 * 1000;
    const stepMs = candidates.length <= 1 ? 0 : Math.max(60 * 1000, Math.floor(windowMs / (candidates.length - 1)));

    const setSchedule = db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (let i = 0; i < candidates.length; i++) {
        const runAt = new Date(baseMs + i * stepMs).toISOString().replace('T', ' ').slice(0, 19);
        setSchedule.run(runAt, candidates[i].id);
      }
    });
    tx();

    const scheduledItems = candidates.map((c, i) => ({
      id: c.id,
      author: c.author,
      priority: c.priority,
      scheduled_at: new Date(baseMs + i * stepMs).toISOString().replace('T', ' ').slice(0, 19),
      post_url: c.post_url,
    }));

    const remaining = (db.prepare(
      `SELECT COUNT(*) as c FROM linkedin_posts WHERE approved = 1 AND commented = 0 AND comment_draft IS NOT NULL AND hidden = 0`
    ).get() as { c: number }).c;

    return JSON.stringify({
      success: true,
      scheduled: scheduledItems.length,
      requested: count,
      window_minutes: windowMinutes,
      start_in_minutes: startInMinutes,
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

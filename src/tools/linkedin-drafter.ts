/**
 * LinkedIn Parallel Draft Orchestrator
 *
 * Spawns multiple Claude SDK agents in parallel (batches of 5) to research
 * and draft LinkedIn comments. Each agent:
 * 1. Reads the full post content
 * 2. Does web research on the topic
 * 3. Writes a genuine, research-backed comment
 * 4. Returns the draft for saving
 *
 * This runs in the background without blocking the main chat.
 */

import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SettingsManager } from '../settings';
import { KanbanService } from '../kanban';

// SDK types
type SDKQuery = AsyncGenerator<unknown, void>;
type SDKOptions = {
  model?: string;
  maxTurns?: number;
  abortController?: AbortController;
  tools?: { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  systemPrompt?: string;
};

let sdkQuery: ((params: { prompt: string; options?: SDKOptions }) => SDKQuery) | null = null;
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk') as { query: typeof sdkQuery };
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

function configureSonnetEnvironment(): void {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// DB helper
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
      return db;
    }
  }
  return null;
}

// Types
export interface DraftPost {
  id: number;
  post_url: string;
  author: string;
  text_preview: string;
  reactions: number;
  comments: number;
  kanban_task_id?: number;
}

export interface DraftResult {
  postId: number;
  author: string;
  draft: string;
  kanbanTaskId: number;
  researched: boolean;
}

export interface DraftJobProgress {
  total: number;
  completed: number;
  current: string;
  results: DraftResult[];
  errors: string[];
}

// Event emitter for progress updates
export const draftEvents = new EventEmitter();

// Active job tracking
let activeJob: AbortController | null = null;

export function cancelDraftJob(): void {
  if (activeJob) {
    activeJob.abort();
    activeJob = null;
  }
}

/**
 * Run a single SDK agent to research and draft a comment for one post
 */
async function draftOnePost(
  post: DraftPost,
  voiceStyle: string,
  abortController: AbortController,
): Promise<DraftResult> {
  configureSonnetEnvironment();

  const queryFn = await loadSDK();
  if (!queryFn) throw new Error('Failed to load SDK');

  const systemPrompt = `You are writing a LinkedIn comment. Your job:
1. Research the topic to find something real and specific to reference
2. Write a short, genuine comment (2-3 sentences MAX)

ABSOLUTE RULES:
- NEVER use em dashes or en dashes. Use commas, periods, or parentheses.
- BANNED WORDS: crucial, landscape, leverage, comprehensive, robust, cutting-edge, game-changer, harness, elevate, delve, foster, transformative, revolutionize, unleash, paradigm, synergy, holistic, pivotal, invaluable, navigate, realm, streamline, optimize, facilitate, enhance, innovative, empower, insightful, groundbreaking, remarkable, impressive, prevalent, utilize, ecosystem, unprecedented
- NO emojis, NO hashtags
- Never start with "Great post", "Thanks for sharing", "This is so important", "Absolutely"
- 2-3 sentences only. Short and punchy.
- Reference something SPECIFIC from the post or from your research.
- Sound like a real person who does this work daily.

${voiceStyle ? `USER'S VOICE STYLE:\n${voiceStyle}` : ''}

OUTPUT FORMAT: Return ONLY the comment text. Nothing else. No explanation, no quotes, no prefix.`;

  const prompt = `LinkedIn post by ${post.author}:
"${post.text_preview}"

Post URL: ${post.post_url}

Step 1: Use WebSearch to find a recent real stat, example, case study, or tool related to this post's topic.
Step 2: Write a 2-3 sentence comment that references something concrete from your research. Be specific and genuine.

Return ONLY the comment text.`;

  const result = queryFn({
    prompt,
    options: {
      model: 'claude-sonnet-4-6',
      maxTurns: 10,
      abortController,
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: ['WebSearch', 'WebFetch'],
      systemPrompt,
    },
  });

  let draft = '';
  for await (const event of result) {
    if (typeof event === 'object' && event !== null) {
      const evt = event as {
        type?: string;
        message?: { content?: Array<{ type: string; text?: string }> };
      };
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) {
            draft += block.text;
          }
        }
      }
    }
  }

  // Clean up the draft
  draft = draft.trim()
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, ', ')
    .replace(/,,/g, ',')
    .replace(/^["']|["']$/g, ''); // Strip wrapping quotes

  // Take the last paragraph if the agent added explanatory text before
  const lines = draft.split('\n').filter(l => l.trim());
  if (lines.length > 1) {
    // If last block looks like the actual comment (short, no "Here's" etc), use it
    const lastBlock = lines[lines.length - 1];
    if (lastBlock.length < 500 && !lastBlock.startsWith('I ') && !lastBlock.includes('Step')) {
      draft = lastBlock;
    }
  }

  if (!draft) throw new Error(`No draft generated for post by ${post.author}`);

  // Save to DB and kanban
  const db = getDb();
  if (!db) throw new Error('Database not available');

  let project = KanbanService.getProjectByName('LinkedIn');
  if (!project) {
    project = KanbanService.createProject('LinkedIn', 'LinkedIn content drafts and posts', '#0a66c2');
  }

  let taskId: number;
  if (post.kanban_task_id) {
    KanbanService.updateTask(post.kanban_task_id, {
      description: `${draft}\n\n---\nPost URL: ${post.post_url}`,
      status: 'review',
    });
    KanbanService.addComment(post.kanban_task_id, `Draft (researched):\n${draft}`);
    taskId = post.kanban_task_id;
  } else {
    const title = `Comment on ${post.author}'s post: ${post.text_preview.slice(0, 60)}...`;
    const task = KanbanService.createTask({
      project_id: project.id,
      title: title.slice(0, 120),
      description: `${draft}\n\n---\nPost URL: ${post.post_url}`,
      status: 'review',
      priority: 'medium',
      tags: 'linkedin,comment',
    });
    taskId = task.id;
  }

  db.prepare('UPDATE linkedin_posts SET comment_draft = ?, kanban_task_id = ? WHERE id = ?')
    .run(draft, taskId, post.id);
  db.close();

  return {
    postId: post.id,
    author: post.author,
    draft,
    kanbanTaskId: taskId,
    researched: true,
  };
}

/**
 * Draft comments for multiple posts in parallel batches
 */
export async function draftBatch(
  postIds: number[],
  batchSize: number = 5,
): Promise<{ results: DraftResult[]; errors: string[] }> {
  if (activeJob) {
    activeJob.abort();
  }
  const jobAbort = new AbortController();
  activeJob = jobAbort;

  const results: DraftResult[] = [];
  const errors: string[] = [];

  // Load voice style
  let voiceStyle = '';
  try {
    voiceStyle = SettingsManager.get('linkedin.voiceStyle') || '';
  } catch { /* ok */ }

  // Load posts from DB
  const db = getDb();
  if (!db) {
    return { results, errors: ['Database not available'] };
  }

  const posts: DraftPost[] = [];
  for (const id of postIds) {
    const row = db.prepare(
      'SELECT id, post_url, author, text_preview, reactions, comments, kanban_task_id FROM linkedin_posts WHERE id = ?'
    ).get(id) as DraftPost | undefined;
    if (row) posts.push(row);
  }
  db.close();

  if (posts.length === 0) {
    return { results, errors: ['No posts found'] };
  }

  const progress: DraftJobProgress = {
    total: posts.length,
    completed: 0,
    current: '',
    results: [],
    errors: [],
  };

  draftEvents.emit('start', { total: posts.length });

  // Process in batches
  for (let i = 0; i < posts.length; i += batchSize) {
    if (jobAbort.signal.aborted) break;

    const batch = posts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(posts.length / batchSize);

    draftEvents.emit('batch', { batch: batchNum, total: totalBatches, posts: batch.map(p => p.author) });

    const batchPromises = batch.map(async (post) => {
      if (jobAbort.signal.aborted) return;

      progress.current = post.author;
      draftEvents.emit('progress', { ...progress });

      try {
        const result = await draftOnePost(post, voiceStyle, jobAbort);
        results.push(result);
        progress.completed++;
        progress.results.push(result);
        draftEvents.emit('drafted', { postId: post.id, author: post.author, draft: result.draft });
      } catch (err) {
        const msg = `Failed for ${post.author}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        progress.errors.push(msg);
        progress.completed++;
        draftEvents.emit('error', { postId: post.id, author: post.author, error: msg });
      }

      draftEvents.emit('progress', { ...progress });
    });

    await Promise.all(batchPromises);
  }

  activeJob = null;
  draftEvents.emit('complete', { total: posts.length, drafted: results.length, errors: errors.length });

  return { results, errors };
}

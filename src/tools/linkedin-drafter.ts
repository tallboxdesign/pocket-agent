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
import { AgentManager } from '../agent';

// SDK types
type SDKQuery = AsyncGenerator<unknown, void>;
type SDKOptions = {
  model?: string;
  maxTurns?: number;
  abortController?: AbortController;
  tools?: { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  systemPrompt?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
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

type ProviderType = 'anthropic' | 'moonshot' | 'glm' | 'minimax';

const MODEL_PROVIDERS: Record<string, ProviderType> = {
  'claude-opus-4-6': 'anthropic',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  'kimi-k2.5': 'moonshot',
  'glm-5': 'glm',
  'MiniMax-M2.5': 'minimax',
  'MiniMax-M2.5-Lightning': 'minimax',
};

const PROVIDER_BASE_URLS: Record<Exclude<ProviderType, 'anthropic'>, string> = {
  moonshot: 'https://api.moonshot.ai/anthropic/',
  glm: 'https://api.z.ai/api/anthropic/',
  minimax: 'https://api.minimax.io/anthropic/',
};

function getDraftModel(): string {
  const runtimeModel = AgentManager.getModel();
  if (typeof runtimeModel === 'string' && runtimeModel.trim()) return runtimeModel.trim();

  const configured = SettingsManager.get('agent.model');
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }
  return 'claude-sonnet-4-6';
}

function getProviderForModel(model: string): ProviderType {
  return MODEL_PROVIDERS[model] || 'anthropic';
}

async function configureProviderEnvironment(model: string): Promise<void> {
  const provider = getProviderForModel(model);

  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

  if (provider === 'moonshot') {
    const moonshotKey = SettingsManager.get('moonshot.apiKey');
    if (!moonshotKey) {
      throw new Error('Moonshot API key not configured. Add it in Settings > Keys.');
    }
    process.env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.moonshot;
    process.env.ANTHROPIC_AUTH_TOKEN = moonshotKey;
    process.env.ANTHROPIC_API_KEY = moonshotKey;
    return;
  }

  if (provider === 'glm') {
    const glmKey = SettingsManager.get('glm.apiKey');
    if (!glmKey) {
      throw new Error('Z.AI GLM API key not configured. Add it in Settings > LLM.');
    }
    process.env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.glm;
    process.env.ANTHROPIC_AUTH_TOKEN = glmKey;
    process.env.ANTHROPIC_API_KEY = glmKey;
    return;
  }

  if (provider === 'minimax') {
    const minimaxKey = SettingsManager.get('minimax.apiKey');
    if (!minimaxKey) {
      throw new Error('MiniMax API key not configured. Add it in Settings > LLM.');
    }
    process.env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.minimax;
    process.env.ANTHROPIC_AUTH_TOKEN = minimaxKey;
    process.env.ANTHROPIC_API_KEY = minimaxKey;
    return;
  }

  const anthropicKey = SettingsManager.get('anthropic.apiKey');
  if (anthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
    return;
  }

  const authMethod = SettingsManager.get('auth.method');
  if (authMethod === 'oauth') {
    const { ClaudeOAuth } = await import('../auth/oauth');
    const freshToken = await ClaudeOAuth.getAccessToken();
    if (!freshToken) {
      throw new Error('Anthropic OAuth expired. Re-authenticate in Settings.');
    }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = freshToken;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    return;
  }

  throw new Error('No Anthropic API key configured. Add it in Settings.');
}

function getSdkCwd(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const appSupportDir = path.join(homeDir, 'Library/Application Support/pocket-agent');
  if (fs.existsSync(appSupportDir)) return appSupportDir;
  return homeDir || process.cwd();
}

function getSdkEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };
  // Prevent nested-session and global config leakage that can crash child SDK runs.
  delete env.CLAUDECODE;
  return env;
}

function isWeakDraft(draft: string): boolean {
  const text = draft.trim();
  if (text.length < 320) return true;
  const sentenceCount = text.split(/[.!?]+/).filter(s => s.trim().length > 8).length;
  if (sentenceCount < 3) return true;
  const hasNumericDetail = /\d/.test(text);
  const hasSourceCue = /\b(according to|report|study|survey|data|from|research|analysis)\b/i.test(text);
  const hasFluff = /\b(great post|thanks for sharing|spot on|love this)\b/i.test(text);
  if (hasFluff) return true;
  return !(hasNumericDetail && hasSourceCue);
}

async function generateDraftFromSdk(
  queryFn: (params: { prompt: string; options?: SDKOptions }) => SDKQuery,
  prompt: string,
  options: SDKOptions,
): Promise<string> {
  const result = queryFn({ prompt, options });
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
  return draft;
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
let jobRunning = false;

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
  model: string,
): Promise<DraftResult> {
  await configureProviderEnvironment(model);

  const queryFn = await loadSDK();
  if (!queryFn) throw new Error('Failed to load SDK');

  const systemPrompt = `You are writing a high-quality LinkedIn reply comment.

GOAL:
- Write a substantive, credible comment with real research.

RESPONSE REQUIREMENTS:
- 4-6 sentences, roughly 320-900 characters.
- Sentence 1 must reference a specific point from the post.
- Include one concrete researched fact (number, date, or named source).
- Add an actionable implication, tradeoff, or sharp follow-up question.

STYLE:
- Natural and human, not corporate fluff.
- Sentence case only, no title-case shouting.
- Mix sentence length so it reads like a person, not a template.
- No emojis and no hashtags.
- No em dashes.
- Avoid generic praise like "Great post" or "Thanks for sharing."

${voiceStyle ? `USER'S VOICE STYLE:\n${voiceStyle}` : ''}

OUTPUT FORMAT:
Return ONLY the final comment text, no preface and no explanation.`;

  const basePrompt = `LinkedIn post by ${post.author}:
"${post.text_preview}"

Post URL: ${post.post_url}

Step 1: Use WebSearch to find a recent real stat, example, case study, or tool related to this post's topic.
Step 2: Write a substantive comment with one specific researched detail, source cue, and one non-obvious insight.

Return ONLY the comment text.`;

  const options: SDKOptions = {
    model,
    maxTurns: 12,
    abortController,
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['WebSearch', 'WebFetch'],
    systemPrompt,
    cwd: getSdkCwd(),
    env: getSdkEnv(),
  };

  let draft = '';
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      draft = await generateDraftFromSdk(queryFn, basePrompt, options);
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 2 && /code process aborted/i.test(msg)) {
        await new Promise(resolve => setTimeout(resolve, 350));
        continue;
      }
      throw err;
    }
  }
  if (!draft && lastErr) throw (lastErr instanceof Error ? lastErr : new Error(String(lastErr)));

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

  if (isWeakDraft(draft)) {
    const stricterPrompt = `${basePrompt}

Your previous attempt was too generic.
Rewrite the comment to include:
- one specific numeric or dated fact
- an explicit source cue (e.g., "according to [source]" or "in [source] data")
- a concrete practical implication for the author.`;
    const refined = await generateDraftFromSdk(queryFn, stricterPrompt, options);
    if (refined && refined.trim()) {
      draft = refined.trim()
        .replace(/\s*—\s*/g, ', ')
        .replace(/\s*–\s*/g, ', ')
        .replace(/,,/g, ',')
        .replace(/^["']|["']$/g, '');
    }
  }

  if (!draft) throw new Error(`No draft generated for post by ${post.author}`);

  // Save to DB and kanban
  const db = getDb();
  if (!db) throw new Error('Database not available');

  try {
    let project = KanbanService.getProjectByName('LinkedIn');
    if (!project) {
      try {
        project = KanbanService.createProject('LinkedIn', 'LinkedIn content drafts and posts', '#0a66c2');
      } catch {
        // Another agent may have created it concurrently
        project = KanbanService.getProjectByName('LinkedIn');
        if (!project) throw new Error('Failed to get or create LinkedIn project');
      }
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

    return {
      postId: post.id,
      author: post.author,
      draft,
      kanbanTaskId: taskId,
      researched: true,
    };
  } finally {
    db.close();
  }
}

/**
 * Draft comments for multiple posts in parallel batches
 */
export async function draftBatch(
  postIds: number[],
  batchSize: number = 5,
): Promise<{ results: DraftResult[]; errors: string[] }> {
  if (jobRunning) {
    if (activeJob) activeJob.abort();
    // Wait briefly for previous job to wind down
    await new Promise(r => setTimeout(r, 500));
  }
  const jobAbort = new AbortController();
  activeJob = jobAbort;
  jobRunning = true;

  const results: DraftResult[] = [];
  const errors: string[] = [];

  // Load voice style
  let voiceStyle = '';
  try {
    voiceStyle = SettingsManager.get('linkedin.voiceStyle') || '';
  } catch { /* ok */ }
  const draftModel = getDraftModel();

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
  const effectiveBatchSize = Math.max(1, Math.min(batchSize || 1, 2));

  for (let i = 0; i < posts.length; i += effectiveBatchSize) {
    if (jobAbort.signal.aborted) break;

    const batch = posts.slice(i, i + effectiveBatchSize);
    const batchNum = Math.floor(i / effectiveBatchSize) + 1;
    const totalBatches = Math.ceil(posts.length / effectiveBatchSize);

    draftEvents.emit('batch', { batch: batchNum, total: totalBatches, posts: batch.map(p => p.author) });

    const batchPromises = batch.map(async (post) => {
      if (jobAbort.signal.aborted) return;

      progress.current = post.author;
      draftEvents.emit('researching', { type: 'researching', postId: post.id, author: post.author });
      draftEvents.emit('progress', { ...progress });

      try {
        const result = await draftOnePost(post, voiceStyle, jobAbort, draftModel);
        results.push(result);
        progress.completed++;
        progress.results.push(result);
        draftEvents.emit('drafted', { type: 'drafted', postId: post.id, author: post.author, draft: result.draft });
      } catch (err) {
        const msg = `Failed for ${post.author}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        progress.errors.push(msg);
        progress.completed++;
        draftEvents.emit('error', { type: 'error', postId: post.id, author: post.author, error: msg });
      }

      draftEvents.emit('progress', { ...progress });
    });

    await Promise.all(batchPromises);
  }

  activeJob = null;
  jobRunning = false;
  draftEvents.emit('complete', { type: 'complete', total: posts.length, drafted: results.length, errors: errors.length });

  return { results, errors };
}

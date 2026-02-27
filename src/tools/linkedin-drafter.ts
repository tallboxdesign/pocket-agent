/**
 * LinkedIn Parallel Draft Orchestrator
 *
 * Spawns multiple SDK agents in parallel (capped at 2) to research
 * and draft LinkedIn comments. Each agent:
 * 1. Reads the full post content
 * 2. Runs a short web-research pass
 * 3. Runs a separate writing pass from the research notes
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
type DraftMode = 'fast' | 'balanced' | 'deep';
type LinkedInDraftConfig = {
  mode: DraftMode;
  perPostTimeoutSec: number;
  researchMaxTurns: number;
  writeMaxTurns: number;
  maxSearchQueries: number;
  fallbackModel: string;
  requireTwoSources: boolean;
};

type ResearchEvidence = {
  postSummary: string;
  keyPoint: string;
  statistic: string;
  sources: Array<{ name: string; url: string }>;
  implication: string;
  followUpQuestion: string;
  postIntent: 'educational' | 'promotional' | 'mixed';
  confidence: 'high' | 'medium' | 'low';
};

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

function parseIntSetting(key: string, fallback: number, min: number, max: number): number {
  const raw = SettingsManager.get(key);
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function getDraftMode(): DraftMode {
  const raw = (SettingsManager.get('linkedin.draftMode') || 'balanced').trim().toLowerCase();
  if (raw === 'fast' || raw === 'deep' || raw === 'balanced') return raw;
  return 'balanced';
}

function getLinkedInDraftConfig(): LinkedInDraftConfig {
  const mode = getDraftMode();
  const modeDefaults: Record<DraftMode, { timeout: number; researchTurns: number; writeTurns: number; queries: number; requireTwoSources: boolean }> = {
    fast: { timeout: 60, researchTurns: 3, writeTurns: 3, queries: 1, requireTwoSources: false },
    balanced: { timeout: 95, researchTurns: 5, writeTurns: 4, queries: 2, requireTwoSources: false },
    deep: { timeout: 140, researchTurns: 7, writeTurns: 6, queries: 3, requireTwoSources: true },
  };
  const defaults = modeDefaults[mode];

  return {
    mode,
    perPostTimeoutSec: parseIntSetting('linkedin.draftTimeoutSec', defaults.timeout, 30, 240),
    researchMaxTurns: parseIntSetting('linkedin.researchMaxTurns', defaults.researchTurns, 2, 10),
    writeMaxTurns: parseIntSetting('linkedin.writeMaxTurns', defaults.writeTurns, 2, 10),
    maxSearchQueries: parseIntSetting('linkedin.researchMaxQueries', defaults.queries, 1, 4),
    fallbackModel: (SettingsManager.get('linkedin.researchFallbackModel') || '').trim(),
    requireTwoSources: defaults.requireTwoSources,
  };
}

function hasModelCredentials(model: string): boolean {
  const provider = getProviderForModel(model);
  if (provider === 'moonshot') return !!SettingsManager.get('moonshot.apiKey');
  if (provider === 'glm') return !!SettingsManager.get('glm.apiKey');
  if (provider === 'minimax') return !!SettingsManager.get('minimax.apiKey');
  return !!SettingsManager.get('anthropic.apiKey') || SettingsManager.get('auth.method') === 'oauth';
}

function getAttemptModels(primaryModel: string, fallbackModel: string): string[] {
  const globalFallback = (SettingsManager.get('agent.fallbackModel') || '').trim();
  const candidates = [primaryModel, fallbackModel, globalFallback, 'kimi-k2.5']
    .map(m => (m || '').trim())
    .filter(Boolean);
  const unique = Array.from(new Set(candidates));
  return unique.filter((model, idx) => idx === 0 || hasModelCredentials(model));
}

async function buildProviderEnv(model: string): Promise<Record<string, string | undefined>> {
  const provider = getProviderForModel(model);
  const env = getSdkEnv();

  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  if (provider === 'moonshot') {
    const moonshotKey = SettingsManager.get('moonshot.apiKey');
    if (!moonshotKey) {
      throw new Error('Moonshot API key not configured. Add it in Settings > Keys.');
    }
    env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.moonshot;
    env.ANTHROPIC_AUTH_TOKEN = moonshotKey;
    env.ANTHROPIC_API_KEY = moonshotKey;
    return env;
  }

  if (provider === 'glm') {
    const glmKey = SettingsManager.get('glm.apiKey');
    if (!glmKey) {
      throw new Error('Z.AI GLM API key not configured. Add it in Settings > LLM.');
    }
    env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.glm;
    env.ANTHROPIC_AUTH_TOKEN = glmKey;
    env.ANTHROPIC_API_KEY = glmKey;
    return env;
  }

  if (provider === 'minimax') {
    const minimaxKey = SettingsManager.get('minimax.apiKey');
    if (!minimaxKey) {
      throw new Error('MiniMax API key not configured. Add it in Settings > LLM.');
    }
    env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.minimax;
    env.ANTHROPIC_AUTH_TOKEN = minimaxKey;
    env.ANTHROPIC_API_KEY = minimaxKey;
    return env;
  }

  const anthropicKey = SettingsManager.get('anthropic.apiKey');
  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
    return env;
  }

  const authMethod = SettingsManager.get('auth.method');
  if (authMethod === 'oauth') {
    const { ClaudeOAuth } = await import('../auth/oauth');
    const freshToken = await ClaudeOAuth.getAccessToken();
    if (!freshToken) {
      throw new Error('Anthropic OAuth expired. Re-authenticate in Settings.');
    }
    env.CLAUDE_CODE_OAUTH_TOKEN = freshToken;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
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

function cleanDraftText(draft: string): string {
  let text = draft.trim()
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, ', ')
    .replace(/,,/g, ',')
    .replace(/^["']|["']$/g, '');

  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length > 1) {
    const lastBlock = lines[lines.length - 1];
    if (lastBlock.length < 900 && !lastBlock.startsWith('I ') && !lastBlock.includes('Step')) {
      text = lastBlock;
    }
  }
  return text.trim();
}

function detectPostIntent(text: string): 'educational' | 'promotional' | 'mixed' {
  const low = text.toLowerCase();
  const promoHits = [
    /book (a )?call/,
    /\bdm me\b/,
    /\bjoin (my|our)\b/,
    /\bapply now\b/,
    /\benroll\b/,
    /\bcohort\b/,
    /\bcourse\b/,
    /\bclient(s)?\b/,
    /\bagency\b/,
    /\bsign up\b/,
  ].filter(re => re.test(low)).length;
  const educationalHits = [
    /\baccording to\b/,
    /\bstudy\b/,
    /\bdata\b/,
    /\bframework\b/,
    /\bcase study\b/,
    /\bexperiment\b/,
    /\bmethod\b/,
  ].filter(re => re.test(low)).length;

  if (promoHits >= 2 && promoHits > educationalHits) return 'promotional';
  if (promoHits >= 1 && educationalHits >= 1) return 'mixed';
  return 'educational';
}

function chooseCommentIntent(postId: number): 'tradeoff' | 'new_data_point' | 'execution_caveat' | 'sharp_question' {
  const intents: Array<'tradeoff' | 'new_data_point' | 'execution_caveat' | 'sharp_question'> = [
    'tradeoff',
    'new_data_point',
    'execution_caveat',
    'sharp_question',
  ];
  const idx = Math.abs((postId * 31 + new Date().getUTCDate()) % intents.length);
  return intents[idx];
}

function hasSourceCue(text: string): boolean {
  return /\b(according to|in .* data|in .* report|research from|study from|survey by)\b/i.test(text);
}

function getMeaningfulTokens(input: string): string[] {
  const stop = new Set([
    'the', 'and', 'that', 'with', 'from', 'this', 'have', 'will', 'your', 'about', 'their', 'they', 'into',
    'what', 'when', 'where', 'which', 'while', 'could', 'would', 'should', 'there', 'here', 'been', 'being',
    'than', 'then', 'because', 'very', 'also', 'only', 'just', 'some', 'more', 'less', 'over', 'under',
  ]);
  return (input.toLowerCase().match(/[a-z0-9]{4,}/g) || [])
    .filter(t => !stop.has(t))
    .slice(0, 12);
}

function hasRelevanceAnchor(draft: string, keyPoint: string, preview: string): boolean {
  const draftLow = draft.toLowerCase();
  const anchorTokens = getMeaningfulTokens(keyPoint || preview);
  if (anchorTokens.length === 0) return true;
  return anchorTokens.some(token => draftLow.includes(token));
}

function hasAISlopWords(text: string): boolean {
  return /\b(landscape|leverage|robust|comprehensive|holistic|streamline|optimize|paradigm|game[- ]changing|cutting-edge|transformative|unprecedented|synergy|foster|harness|delve|elevate)\b/i.test(text);
}

function getNumbers(text: string): string[] {
  return Array.from(new Set((text.match(/\b\d+(?:\.\d+)?%?\b/g) || []).map(n => n.trim())));
}

function evaluateDraftQuality(draft: string, evidence: ResearchEvidence, preview: string): string[] {
  const issues: string[] = [];
  if (isWeakDraft(draft)) issues.push('too generic or too short');
  if (!hasRelevanceAnchor(draft, evidence.keyPoint, preview)) issues.push('missing concrete anchor from original post');
  if (hasAISlopWords(draft)) issues.push('contains AI-sounding jargon');
  const allCapsWords = draft.match(/\b[A-Z]{4,}\b/g) || [];
  if (allCapsWords.length > 2) issues.push('contains unnatural all-caps wording');

  const draftNums = getNumbers(draft);
  if (draftNums.length > 0) {
    if (!hasSourceCue(draft)) issues.push('numeric claim lacks source cue');
    const evidenceNums = getNumbers(evidence.statistic);
    if (evidenceNums.length > 0 && !draftNums.some(n => evidenceNums.includes(n))) {
      issues.push('numeric claim not grounded in research evidence');
    }
  }
  return issues;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseResearchEvidence(rawResearch: string, fallbackIntent: ResearchEvidence['postIntent']): ResearchEvidence {
  const parsed = extractJsonObject(rawResearch);
  const fallback: ResearchEvidence = {
    postSummary: '',
    keyPoint: '',
    statistic: '',
    sources: [],
    implication: '',
    followUpQuestion: '',
    postIntent: fallbackIntent,
    confidence: 'low',
  };

  if (!parsed) {
    fallback.postSummary = rawResearch.trim().slice(0, 200);
    return fallback;
  }

  const confidenceRaw = String(parsed.confidence || '').toLowerCase();
  const confidence: ResearchEvidence['confidence'] =
    confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
      ? confidenceRaw
      : 'medium';

  const postIntentRaw = String(parsed.post_intent || '').toLowerCase();
  const postIntent: ResearchEvidence['postIntent'] =
    postIntentRaw === 'promotional' || postIntentRaw === 'mixed' || postIntentRaw === 'educational'
      ? postIntentRaw
      : fallbackIntent;

  const sources: Array<{ name: string; url: string }> = [];
  const source1 = String(parsed.source_1 || parsed.source || '').trim();
  const sourceUrl1 = String(parsed.source_url_1 || parsed.source_url || '').trim();
  const source2 = String(parsed.source_2 || '').trim();
  const sourceUrl2 = String(parsed.source_url_2 || '').trim();
  if (source1) sources.push({ name: source1, url: sourceUrl1 });
  if (source2) sources.push({ name: source2, url: sourceUrl2 });

  return {
    postSummary: String(parsed.post_summary || '').trim(),
    keyPoint: String(parsed.key_point || '').trim(),
    statistic: String(parsed.statistic || '').trim(),
    sources,
    implication: String(parsed.implication || '').trim(),
    followUpQuestion: String(parsed.follow_up_question || '').trim(),
    postIntent,
    confidence,
  };
}

function evidenceToBrief(evidence: ResearchEvidence): string {
  const sourceLines = evidence.sources
    .map((s, idx) => `Source ${idx + 1}: ${s.name}${s.url ? ` (${s.url})` : ''}`)
    .join('\n');

  const lines = [
    evidence.postSummary ? `Post summary: ${evidence.postSummary}` : '',
    evidence.keyPoint ? `Key point: ${evidence.keyPoint}` : '',
    evidence.statistic ? `Fact/stat: ${evidence.statistic}` : '',
    sourceLines,
    evidence.implication ? `Implication: ${evidence.implication}` : '',
    evidence.followUpQuestion ? `Follow-up angle: ${evidence.followUpQuestion}` : '',
    `Post intent: ${evidence.postIntent}`,
    `Evidence confidence: ${evidence.confidence}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function hasMinimumEvidence(evidence: ResearchEvidence, requireTwoSources: boolean): boolean {
  if (!evidence.keyPoint || !evidence.statistic) return false;
  if (requireTwoSources) return evidence.sources.length >= 2;
  return evidence.sources.length >= 1;
}

function createAttemptAbortController(parent: AbortController, timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const onParentAbort = () => controller.abort();
  parent.signal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, Math.max(1000, timeoutMs));

  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      parent.signal.removeEventListener('abort', onParentAbort);
    },
    timedOut: () => didTimeout,
  };
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

async function runResearchPass(
  queryFn: (params: { prompt: string; options?: SDKOptions }) => SDKQuery,
  post: DraftPost,
  model: string,
  config: LinkedInDraftConfig,
  abortController: AbortController,
  env: Record<string, string | undefined>,
): Promise<ResearchEvidence> {
  const fallbackIntent = detectPostIntent(post.text_preview);
  const researchSystemPrompt = `You are a focused research analyst for LinkedIn comments.

Rules:
- Use at most ${config.maxSearchQueries} WebSearch calls and at most 1 WebFetch call.
- Gather one recent concrete fact and one practical implication.
- Use grounded sources only. No made-up stats.
- Do not write the final comment.
- Return ONLY strict JSON.`;

  const researchPrompt = `LinkedIn post by ${post.author}:
"${post.text_preview}"
Post URL: ${post.post_url}

Research the exact topic and return STRICT JSON:
{
  "post_summary": "one-line summary of what the author is saying",
  "key_point": "most specific point from the post to reference",
  "statistic": "one concrete recent fact with number/date",
  "source_1": "publication/org name for primary source",
  "source_url_1": "url if found, else empty string",
  "source_2": "secondary source name (optional unless required)",
  "source_url_2": "secondary source url (optional)",
  "implication": "why this matters in practice",
  "follow_up_question": "one sharp question to deepen the discussion",
  "post_intent": "educational|promotional|mixed",
  "confidence": "high|medium|low"
}`;

  const researchOptions: SDKOptions = {
    model,
    maxTurns: config.researchMaxTurns,
    abortController,
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['WebSearch', 'WebFetch'],
    systemPrompt: researchSystemPrompt,
    cwd: getSdkCwd(),
    env,
  };

  const rawResearch = await generateDraftFromSdk(queryFn, researchPrompt, researchOptions);
  const evidence = parseResearchEvidence(rawResearch, fallbackIntent);
  if (!hasMinimumEvidence(evidence, config.requireTwoSources)) {
    const required = config.requireTwoSources ? '2 sources' : '1 source';
    throw new Error(`Research evidence insufficient (needs key point, statistic, and ${required})`);
  }
  return evidence;
}

async function runWritePass(
  queryFn: (params: { prompt: string; options?: SDKOptions }) => SDKQuery,
  post: DraftPost,
  styleGuide: string,
  evidence: ResearchEvidence,
  commentIntent: 'tradeoff' | 'new_data_point' | 'execution_caveat' | 'sharp_question',
  model: string,
  config: LinkedInDraftConfig,
  abortController: AbortController,
  env: Record<string, string | undefined>,
): Promise<string> {
  const researchBrief = evidenceToBrief(evidence);
  const challengeInstruction = evidence.postIntent === 'promotional' || evidence.postIntent === 'mixed'
    ? 'The post has promotional intent. Do not default to agreement. Constructively challenge assumptions and add a practical tradeoff.'
    : 'Be constructive and add practical value beyond agreement.';

  const intentInstructionMap: Record<typeof commentIntent, string> = {
    tradeoff: 'Prioritize a concrete tradeoff the author should consider.',
    new_data_point: 'Prioritize a concrete data point and what it changes in decisions.',
    execution_caveat: 'Prioritize execution risk/caveat and how to mitigate it.',
    sharp_question: 'Prioritize one specific question that deepens the discussion.',
  };

  const writingSystemPrompt = `You are writing a high-quality LinkedIn reply comment.

GOAL:
- Sound genuinely human and practitioner-level.

RESPONSE REQUIREMENTS:
- 4-6 sentences, roughly 320-900 characters.
- Sentence 1 must reference a specific point from the post.
- Include one concrete researched fact from the notes.
- Add an actionable implication or thoughtful question.

STYLE:
- Sentence case, natural rhythm, and varied sentence length.
- No emojis, no hashtags, no em dashes.
- Avoid generic praise ("great post", "thanks for sharing").
- Avoid AI-sounding words like "landscape", "leverage", "robust", "holistic", "transformative".${styleGuide ? `\n\nSTYLE GUIDE:\n${styleGuide}` : ''}

OUTPUT FORMAT:
Return ONLY the final comment text.`;

  const writePrompt = `LinkedIn post by ${post.author}:
"${post.text_preview}"
Post URL: ${post.post_url}

Research notes:
${researchBrief}

Narrative guidance:
- ${challengeInstruction}
- Comment intent: ${commentIntent} (${intentInstructionMap[commentIntent]})
- The first sentence must reference the key point from the original post.

Write the final comment now.`;

  const writeOptions: SDKOptions = {
    model,
    maxTurns: config.writeMaxTurns,
    abortController,
    systemPrompt: writingSystemPrompt,
    cwd: getSdkCwd(),
    env,
  };

  let draft = cleanDraftText(await generateDraftFromSdk(queryFn, writePrompt, writeOptions));
  for (let repairAttempt = 0; repairAttempt < 2; repairAttempt++) {
    const issues = evaluateDraftQuality(draft, evidence, post.text_preview);
    if (issues.length === 0) break;
    const repairPrompt = `${writePrompt}

The previous draft failed quality checks for:
- ${issues.join('\n- ')}

Rewrite with strict compliance:
- reference the post's key point explicitly
- include one numeric/date detail from research notes
- include source cue wording
- avoid hype/jargon and generic agreement`;
    draft = cleanDraftText(await generateDraftFromSdk(queryFn, repairPrompt, writeOptions));
  }

  if (!draft) {
    throw new Error('Write pass returned empty output');
  }

  const finalIssues = evaluateDraftQuality(draft, evidence, post.text_preview);
  if (finalIssues.length > 0) {
    throw new Error(`Draft quality checks failed: ${finalIssues.join('; ')}`);
  }

  return draft;
}

async function generateDraftForModel(
  queryFn: (params: { prompt: string; options?: SDKOptions }) => SDKQuery,
  post: DraftPost,
  styleGuide: string,
  model: string,
  config: LinkedInDraftConfig,
  parentAbortController: AbortController,
  remainingMs: number,
): Promise<string> {
  const env = await buildProviderEnv(model);
  const attempt = createAttemptAbortController(parentAbortController, remainingMs);
  try {
    const evidence = await runResearchPass(queryFn, post, model, config, attempt.controller, env);
    const commentIntent = chooseCommentIntent(post.id);
    return await runWritePass(queryFn, post, styleGuide, evidence, commentIntent, model, config, attempt.controller, env);
  } catch (err) {
    if (parentAbortController.signal.aborted) {
      throw new Error('Draft job cancelled');
    }
    if (attempt.timedOut()) {
      throw new Error(`Timed out while drafting with ${model}`);
    }
    throw err;
  } finally {
    attempt.cleanup();
  }
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
  styleGuide: string,
  abortController: AbortController,
  model: string,
): Promise<DraftResult> {
  const queryFn = await loadSDK();
  if (!queryFn) throw new Error('Failed to load SDK');

  const config = getLinkedInDraftConfig();
  const attemptModels = getAttemptModels(model, config.fallbackModel);
  const deadline = Date.now() + (config.perPostTimeoutSec * 1000);

  let draft = '';
  const attemptErrors: string[] = [];

  for (const attemptModel of attemptModels) {
    if (abortController.signal.aborted) throw new Error('Draft job cancelled');
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1500) {
      attemptErrors.push(`Timed out after ${config.perPostTimeoutSec}s total`);
      break;
    }
    try {
      draft = await generateDraftForModel(
        queryFn,
        post,
        styleGuide,
        attemptModel,
        config,
        abortController,
        remainingMs,
      );
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attemptErrors.push(`${attemptModel}: ${msg}`);
      if (abortController.signal.aborted) throw new Error('Draft job cancelled');
      continue;
    }
  }

  if (!draft) {
    const detail = attemptErrors.length ? ` (${attemptErrors.join(' | ')})` : '';
    throw new Error(`No draft generated for post by ${post.author}${detail}`);
  }

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
  batchSize: number = 2,
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

  // Load writing guidance
  let voiceStyle = '';
  let writingRules = '';
  let contentDirection = '';
  try {
    voiceStyle = SettingsManager.get('linkedin.voiceStyle') || '';
    writingRules = SettingsManager.get('linkedin.writingRules') || '';
    contentDirection = SettingsManager.get('linkedin.contentDirection') || '';
  } catch { /* ok */ }
  const styleGuide = [voiceStyle, writingRules, contentDirection].filter(Boolean).join('\n\n');
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
        const result = await draftOnePost(post, styleGuide, jobAbort, draftModel);
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

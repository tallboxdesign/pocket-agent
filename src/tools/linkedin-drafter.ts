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

function computeEffectiveTimeoutSec(baseTimeoutSec: number, primaryModel: string, preview: string): number {
  let effective = baseTimeoutSec;
  const provider = getProviderForModel(primaryModel);

  // Non-Anthropic backends typically need more wall time for web-enabled passes.
  if (provider !== 'anthropic') {
    effective = Math.round(effective * 1.35);
  }

  // Long previews tend to require more research/rewrites.
  if ((preview || '').length >= 320) {
    effective += 15;
  }

  return Math.min(360, Math.max(30, effective));
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
  const defaults = ['claude-sonnet-4-6', 'glm-5', 'MiniMax-M2.5-Lightning', 'kimi-k2.5'];
  const candidates = [primaryModel, fallbackModel, globalFallback, ...defaults]
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
  const hasFluff = /\b(great post|thanks for sharing|spot on|love this)\b/i.test(text);
  if (hasFluff) return true;
  const hasConcreteSignal = /\b(\d|case study|example|in practice|because|when|if|trade[- ]off|execution|signal|framework)\b/i.test(text);
  return !hasConcreteSignal;
}

function cleanDraftText(draft: string): string {
  let text = draft.trim()
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, ', ')
    .replace(/,,/g, ',')
    .replace(/^["']|["']$/g, '');

  // Strip preamble lines like "Here's the comment:" or "Sure, here's a draft:"
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length > 1) {
    const preamblePattern = /^(here['']?s|sure|okay|draft|comment|below|the final|my reply|my comment)/i;
    while (lines.length > 1 && lines[0].length < 80 && preamblePattern.test(lines[0].trim())) {
      lines.shift();
    }
    text = lines.join('\n');
  }
  return text.trim();
}

function ensureReadableCommentLayout(draft: string): string {
  const raw = draft.trim();
  if (!raw) return raw;

  // Keep intentional multiline drafts, just normalize spacing.
  if (raw.includes('\n')) {
    return raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n');
  }

  // Split dense single-paragraph output into readable short blocks.
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

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAuthorFirstName(author: string): string {
  const raw = String(author || '').trim();
  if (!raw) return '';
  const first = raw.split(/\s+/)[0] || '';
  return first.replace(/[^\p{L}\p{N}'’.-]/gu, '').replace(/[.,:;!?]+$/g, '');
}

function startsWithAuthorName(draft: string, authorFirstName: string): boolean {
  if (!authorFirstName) return true;
  const start = draft.trim();
  const escaped = escapeRegex(authorFirstName);
  const re = new RegExp(`^["'“”‘’(\\[]?\\s*${escaped}\\b`, 'i');
  return re.test(start);
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
  return /\b(landscape|leverage|robust|comprehensive|holistic|streamline|optimize|paradigm|game[- ]changing|cutting-edge|transformative|unprecedented|synergy|foster|harness|delve|elevate|dramatically|significantly|meaningful|signaling|proposes|pressure-testing|measurable|acquisition channel|survey questions)\b/i.test(text);
}

function getNumbers(text: string): string[] {
  return Array.from(new Set((text.match(/\b\d+(?:\.\d+)?%?\b/g) || []).map(n => n.trim())));
}

function evaluateDraftQuality(
  draft: string,
  evidence: ResearchEvidence,
  preview: string,
  authorFirstName: string,
): string[] {
  const issues: string[] = [];
  if (isWeakDraft(draft)) issues.push('too generic or too short');
  if (!startsWithAuthorName(draft, authorFirstName)) issues.push('opening does not start with the author name');
  if (!hasRelevanceAnchor(draft, evidence.keyPoint, preview)) issues.push('missing concrete anchor from original post');
  if (!draft.includes('\n') && draft.length > 350) issues.push('single dense paragraph, needs line breaks');
  if (hasAISlopWords(draft)) issues.push('contains AI-sounding jargon');
  if (/\?\s*$/.test(draft.trim())) issues.push('ends with a question');
  if (/\b(according to|study by|data from|research by|report by)\b/i.test(draft)) issues.push('cites source by name');
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Study|Report|Research|Survey|Data|Index)\b/.test(draft)) issues.push('references named study or report');
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

function hasCriticalQualityIssue(issues: string[]): boolean {
  const criticalSnippets = [
    'opening does not start',
    'missing concrete anchor',
    'numeric claim lacks source cue',
    'numeric claim not grounded',
    'too generic or too short',
    'ends with a question',
    'cites source by name',
    'references named study or report',
  ];
  return issues.some(issue => criticalSnippets.some(snippet => issue.includes(snippet)));
}

function buildDeterministicFallbackDraft(
  post: DraftPost,
  evidence: ResearchEvidence,
  authorFirstName: string,
  commentIntent: 'tradeoff' | 'new_data_point' | 'execution_caveat' | 'sharp_question',
): string {
  const anchor = (evidence.keyPoint || post.text_preview || 'the point you shared')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '')
    .slice(0, 160);

  const sourceName = (evidence.sources[0]?.name || 'recent industry').trim();
  const rawStat = (evidence.statistic || '').replace(/\s+/g, ' ').trim();
  const statSentence = rawStat
    ? (hasSourceCue(rawStat) ? rawStat : `According to ${sourceName} data, ${rawStat}`)
    : `According to ${sourceName} data, search behavior is fragmenting faster than most teams plan for.`;

  const angleLineMap: Record<typeof commentIntent, string> = {
    tradeoff: 'The trade-off is speed versus trust, and teams that optimize for volume alone usually pay for it later.',
    new_data_point: 'The missing piece is translating that trend into one measurable execution choice this week.',
    execution_caveat: 'The execution caveat is consistency, because most teams change tactics before signals stabilize.',
    sharp_question: 'The useful next step is pressure-testing this with one concrete metric instead of broad assumptions.',
  };

  const question = (evidence.followUpQuestion || 'How are you validating this in your current workflow?')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '') + '?';

  const text = [
    `${authorFirstName}, your point about ${anchor} is the part most teams underestimate.`,
    statSentence.endsWith('.') ? statSentence : `${statSentence}.`,
    angleLineMap[commentIntent],
    question,
  ].join('\n\n');

  return ensureReadableCommentLayout(cleanDraftText(text));
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
    evidence.statistic ? `Background insight (paraphrase loosely, do NOT cite source names or exact numbers): ${evidence.statistic}` : '',
    sourceLines,
    evidence.implication ? `Implication: ${evidence.implication}` : '',
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
- FIRST: Use WebFetch on the post URL to read the FULL post content. The preview below is truncated.
- Then use at most ${config.maxSearchQueries} WebSearch calls to find one recent concrete fact.
- Gather one practical implication grounded in real data.
- Use grounded sources only. No made-up stats.
- Do not write the final comment.
- Return ONLY strict JSON.`;

  const researchPrompt = `LinkedIn post by ${post.author} (preview, may be truncated):
"${post.text_preview}"
Post URL: ${post.post_url}

STEP 1: WebFetch the post URL above to read the FULL post text (the preview is often truncated).
STEP 2: Research the exact topic with WebSearch.
STEP 3: Return STRICT JSON:
{
  "post_summary": "one-line summary of what the author is saying",
  "key_point": "most specific point from the post to reference",
  "statistic": "one loose fact or trend you found (paraphrase casually, no exact numbers or source names needed)",
  "source_1": "publication/org name for your reference only",
  "source_url_1": "url if found, else empty string",
  "source_2": "secondary source name (optional)",
  "source_url_2": "secondary source url (optional)",
  "implication": "why this matters in practice, in plain language",
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
  const authorFirstName = getAuthorFirstName(post.author);
  const challengeInstruction = evidence.postIntent === 'promotional' || evidence.postIntent === 'mixed'
    ? 'The post has promotional intent. Do not default to agreement. Constructively challenge assumptions and add a practical tradeoff.'
    : 'Be constructive and add practical value beyond agreement.';

  const intentInstructionMap: Record<typeof commentIntent, string> = {
    tradeoff: 'Prioritize a concrete tradeoff the author should consider.',
    new_data_point: 'Prioritize a concrete data point and what it changes in decisions.',
    execution_caveat: 'Prioritize execution risk/caveat and how to mitigate it.',
    sharp_question: 'Prioritize one specific question that deepens the discussion.',
  };

  const writingSystemPrompt = `You are writing a high-quality LinkedIn reply comment. Sound like someone who genuinely knows their stuff typing a quick reply, not a conference talk or blog post.

RESPONSE REQUIREMENTS:
- YOU decide the length based on the topic. Quick take: 3-5 sentences (~300-500 chars). Real discussion: 5-8 sentences (~500-900 chars). Deep argument: 8-10 sentences (~800-1400 chars). Never pad for length. Let the content decide.
- Sentence 1 must start with "${authorFirstName}," and reference a specific point from the post.
- Weave in ONE insight from the research naturally. Do NOT cite source names, publication names, or exact statistics. Paraphrase loosely like you already knew it. Say "the market is roughly doubling" not "according to Mordor Intelligence the market will grow from $75B to $149B by 2031".
- Do NOT end with a question. End with a statement, a take, or an incomplete thought. Questions at the end feel like interview prompts, not real comments.

VOICE (critical - this is what makes it sound human):
- Vary paragraph length: mix short punchy lines with longer thoughts. Never uniform blocks.
- Lowercase generic acronyms casually: "seo", "ctr", "aio", "llm" (not SEO, CTR). Brand names stay capitalized: Google, Ahrefs, ChatGPT.
- Mix sentence-start casing: ~50% capitalized, ~50% not.
- Use one casual connector per comment max: "honestly", "the thing is", "tbh".
- Incomplete thoughts OK: "but yeah." or trailing "..." or starting with "and".
- Round numbers casually sometimes: "around 60%" not "61%", "3-4x" not "3.7x".
- Let some thoughts run naturally into each other. Don't perfectly structure every paragraph.

HARD RULES:
- No emojis, no hashtags, no em dashes, no en dashes.
- No generic praise ("great post", "thanks for sharing", "love this", "spot on").
- No AI jargon ("landscape", "leverage", "robust", "holistic", "transformative", "game-changing", "trajectory", "institutionalizing", "decoupling", "paradigm", "ecosystem", "scalable", "actionable", "double down").
- Challenge marketing stunts. If the post pushes a tool too hard, point out limitations or what it omits.
- Never be a yes-man. Call out self-promotion with data and real perspective.
- Use only straight quotes and apostrophes, no curly/smart quotes.${styleGuide ? `\n\nADDITIONAL STYLE GUIDE:\n${styleGuide}` : ''}

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
- Start the first sentence with "${authorFirstName}," and reference the key point from the original post.

Write the final comment now.`;

  const writeOptions: SDKOptions = {
    model,
    maxTurns: config.writeMaxTurns,
    abortController,
    systemPrompt: writingSystemPrompt,
    cwd: getSdkCwd(),
    env,
  };

  let draft = ensureReadableCommentLayout(cleanDraftText(await generateDraftFromSdk(queryFn, writePrompt, writeOptions)));
  for (let repairAttempt = 0; repairAttempt < 2; repairAttempt++) {
    const issues = evaluateDraftQuality(draft, evidence, post.text_preview, authorFirstName);
    if (issues.length === 0) break;
    const repairPrompt = `${writePrompt}

The previous draft failed quality checks for:
- ${issues.join('\n- ')}

Rewrite with strict compliance:
- start sentence 1 with "${authorFirstName},"
- reference the post's key point explicitly
- include one numeric/date detail from research notes
- include source cue wording
- format as short paragraphs with line breaks, not one dense block
- avoid hype/jargon and generic agreement`;
    draft = ensureReadableCommentLayout(cleanDraftText(await generateDraftFromSdk(queryFn, repairPrompt, writeOptions)));
  }

  if (!draft) {
    throw new Error('Write pass returned empty output');
  }

  const finalIssues = evaluateDraftQuality(draft, evidence, post.text_preview, authorFirstName);
  if (finalIssues.length > 0) {
    const salvagePrompt = `${writePrompt}

The latest draft still failed checks for:
- ${finalIssues.join('\n- ')}

Final rewrite requirements:
- Exactly 4 or 5 sentences
- Sentence 1 must start with "${authorFirstName},"
- Include one specific number/date from research notes
- Include one source cue phrase like "According to" or "In [source] data"
- Keep natural human tone and short paragraph formatting with line breaks
- No generic praise and no jargon

Return only the final comment text.`;

    const salvaged = ensureReadableCommentLayout(
      cleanDraftText(await generateDraftFromSdk(queryFn, salvagePrompt, writeOptions))
    );
    if (salvaged) draft = salvaged;

    const salvageIssues = evaluateDraftQuality(draft, evidence, post.text_preview, authorFirstName);
    if (salvageIssues.length > 0) {
      if (hasCriticalQualityIssue(salvageIssues)) {
        const fallbackDraft = buildDeterministicFallbackDraft(post, evidence, authorFirstName, commentIntent);
        const fallbackIssues = evaluateDraftQuality(fallbackDraft, evidence, post.text_preview, authorFirstName);
        if (fallbackIssues.length > 0) {
          console.warn(`[LinkedInDrafter] Fallback draft has remaining warnings: ${fallbackIssues.join('; ')}`);
        }
        return fallbackDraft;
      }
      console.warn(`[LinkedInDrafter] Accepting draft with non-critical quality warnings: ${salvageIssues.join('; ')}`);
    }
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
    const abortReason = parentAbortController.signal.reason;
    if (parentAbortController.signal.aborted && abortReason === 'timeout') {
      throw new Error(`Timed out while drafting with ${model}`);
    }
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
  post_type?: string;
  voice_preset?: string;
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
  jobRunning = false;
}

export function isDraftJobRunning(): boolean {
  return jobRunning;
}

type DraftState = 'queued' | 'researching' | 'writing' | 'success' | 'failed_quality' | 'failed_timeout' | 'failed_provider' | 'cancelled_user' | 'cancelled_system';

function setDraftState(postId: number, state: DraftState, error?: string): void {
  const db = getDb();
  if (!db) return;
  try {
    const now = new Date().toISOString();
    const isTerminal = state === 'success' || state.startsWith('failed_') || state.startsWith('cancelled_');
    if (state === 'queued' || state === 'researching') {
      db.prepare(
        `UPDATE linkedin_posts SET draft_state = ?, draft_error = NULL, draft_started_at = ?, draft_finished_at = NULL WHERE id = ?`
      ).run(state, now, postId);
    } else if (isTerminal) {
      db.prepare(
        `UPDATE linkedin_posts SET draft_state = ?, draft_error = ?, draft_finished_at = ? WHERE id = ?`
      ).run(state, error || null, now, postId);
    } else {
      db.prepare(
        `UPDATE linkedin_posts SET draft_state = ?, draft_error = NULL WHERE id = ?`
      ).run(state, postId);
    }
  } catch (err) {
    console.warn('[LinkedInDrafter] Failed to set draft state:', err);
  } finally {
    db.close();
  }
}

function classifyDraftError(err: unknown, abortController: AbortController): DraftState {
  const msg = err instanceof Error ? err.message : String(err);
  if (/cancelled|cancel/i.test(msg)) {
    const reason = abortController.signal.reason;
    if (reason === 'job_cancelled') return 'cancelled_system';
    return 'cancelled_user';
  }
  if (/timed? ?out|timeout/i.test(msg)) return 'failed_timeout';
  if (/quality|generic|too short|weak/i.test(msg)) return 'failed_quality';
  if (/api|auth|key|rate.?limit|network|credential|expired|oauth|500|502|503/i.test(msg)) return 'failed_provider';
  return 'failed_provider';
}

function logDraftActivity(
  postId: number,
  postUrl: string,
  action: 'drafted' | 'failed' | 'failed_quality' | 'failed_timeout' | 'failed_provider' | 'cancelled' | 'cancelled_user' | 'cancelled_system',
  reason?: string,
  commentText?: string,
): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, comment_text)
       VALUES (?, ?, ?, ?, ?)`
    ).run(postId, postUrl, action, reason || null, commentText || null);
  } catch (err) {
    console.warn('[LinkedInDrafter] Failed to log draft activity:', err);
  } finally {
    db.close();
  }
}

interface VoicePreset {
  name: string;
  prompt: string;
  postTypes: string[];
}

function selectVoiceForPost(postType: string | null | undefined, overridePreset?: string | null): string {
  const presetsJson = SettingsManager.get('linkedin.voicePresets') || '';
  let presets: VoicePreset[] = [];
  try {
    const parsed = JSON.parse(presetsJson);
    if (Array.isArray(parsed)) presets = parsed;
  } catch { /* invalid JSON, fall through */ }

  if (presets.length === 0) {
    return SettingsManager.get('linkedin.voiceStyle') || '';
  }

  // Per-post override
  if (overridePreset) {
    const match = presets.find(p => p.name === overridePreset);
    if (match) return match.prompt;
  }

  // 70% match post type, 30% random variety
  if (Math.random() < 0.7 && postType) {
    const matching = presets.filter(p => p.postTypes.includes(postType));
    if (matching.length > 0) {
      return matching[Math.floor(Math.random() * matching.length)].prompt;
    }
  }

  // Random preset (covers 30% case and fallback)
  return presets[Math.floor(Math.random() * presets.length)].prompt;
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

  setDraftState(post.id, 'researching');

  // Clear old draft so stale content doesn't persist if this attempt fails
  const clearDb = getDb();
  if (clearDb) {
    try { clearDb.prepare('UPDATE linkedin_posts SET comment_draft = NULL WHERE id = ?').run(post.id); }
    catch { /* ok */ }
    finally { clearDb.close(); }
  }

  const config = getLinkedInDraftConfig();
  const attemptModels = getAttemptModels(model, config.fallbackModel);
  const effectiveTimeoutSec = computeEffectiveTimeoutSec(config.perPostTimeoutSec, model, post.text_preview);
  const deadline = Date.now() + (effectiveTimeoutSec * 1000);

  let draft = '';
  const attemptErrors: string[] = [];

  for (const attemptModel of attemptModels) {
    if (abortController.signal.aborted) throw new Error('Draft job cancelled');
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1500) {
      attemptErrors.push(`Timed out after ${effectiveTimeoutSec}s total`);
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

  setDraftState(post.id, 'writing');

  // Save to DB and kanban
  const db = getDb();
  if (!db) throw new Error('Database not available');

  try {
    if (abortController.signal.aborted) {
      throw new Error('Draft timed out before save');
    }

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
    db.prepare(
      `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, comment_text)
       VALUES (?, ?, 'drafted', 'draft:ok', ?)`
    ).run(post.id, post.post_url, draft);

    if (abortController.signal.aborted) {
      throw new Error('Draft timed out before finalize');
    }

    setDraftState(post.id, 'success');

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
 * Draft comments for posts sequentially (one at a time to avoid API overload).
 * Supports up to 50 posts. Each post goes through the state machine:
 * queued, researching, writing, success, failed_x, cancelled_x
 */
export async function draftBatch(
  postIds: number[],
  _batchSize: number = 1,
): Promise<{ results: DraftResult[]; errors: string[] }> {
  if (jobRunning) {
    // If activeJob is null, this is a leaked state from a crashed previous run -reset it
    if (!activeJob) {
      jobRunning = false;
    } else {
      return {
        results: [],
        errors: ['A draft job is already running. Wait for it to finish or cancel it first.'],
      };
    }
  }
  const jobAbort = new AbortController();
  activeJob = jobAbort;
  jobRunning = true;

  const results: DraftResult[] = [];
  const errors: string[] = [];

  let totalPostsForCompletion = 0;
  try {
    let writingRules = '';
    let contentDirection = '';
    try {
      writingRules = SettingsManager.get('linkedin.writingRules') || '';
      contentDirection = SettingsManager.get('linkedin.contentDirection') || '';
    } catch { /* ok */ }
    const draftModel = getDraftModel();

    const db = getDb();
    if (!db) {
      errors.push('Database not available');
      return { results, errors };
    }

    const posts: DraftPost[] = [];
    for (const id of postIds) {
      const row = db.prepare(
        'SELECT id, post_url, author, text_preview, reactions, comments, kanban_task_id, post_type, voice_preset FROM linkedin_posts WHERE id = ?'
      ).get(id) as DraftPost | undefined;
      if (row) posts.push(row);
    }

    // Mark all posts as queued upfront
    for (const post of posts) {
      db.prepare(`UPDATE linkedin_posts SET draft_state = 'queued', draft_error = NULL, draft_started_at = datetime('now'), draft_finished_at = NULL WHERE id = ?`).run(post.id);
    }
    db.close();

    if (posts.length === 0) {
      errors.push('No posts found');
      return { results, errors };
    }

    totalPostsForCompletion = posts.length;
    const progress: DraftJobProgress = {
      total: posts.length,
      completed: 0,
      current: '',
      results: [],
      errors: [],
    };

    draftEvents.emit('start', { total: posts.length });

    // Process sequentially -one post at a time
    for (const post of posts) {
      if (jobAbort.signal.aborted) {
        // Mark remaining queued posts as cancelled_system
        setDraftState(post.id, 'cancelled_system', 'Batch was cancelled');
        logDraftActivity(post.id, post.post_url, 'cancelled_system', 'draft:batch cancelled');
        draftEvents.emit('error', { type: 'error', postId: post.id, author: post.author, error: `Cancelled for ${post.author}` });
        progress.completed++;
        draftEvents.emit('progress', { ...progress });
        continue;
      }

      progress.current = post.author;
      draftEvents.emit('researching', { type: 'researching', postId: post.id, author: post.author });
      draftEvents.emit('progress', { ...progress });

      try {
        const voicePrompt = selectVoiceForPost(post.post_type, post.voice_preset);
        const postStyleGuide = [voicePrompt, writingRules, contentDirection].filter(Boolean).join('\n\n');
        const config = getLinkedInDraftConfig();
        const perPostTimeoutSec = computeEffectiveTimeoutSec(config.perPostTimeoutSec, draftModel, post.text_preview) + 20;
        const timeoutMs = Math.max(30000, perPostTimeoutSec * 1000);
        const postAbort = new AbortController();
        const onJobAbort = () => postAbort.abort('job_cancelled');
        jobAbort.signal.addEventListener('abort', onJobAbort, { once: true });

        const timeoutError = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            postAbort.abort('timeout');
            reject(new Error(`Timed out after ${perPostTimeoutSec}s for ${post.author}`));
          }, timeoutMs);
          postAbort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        });

        const runDraft = (async () => {
          try {
            return await draftOnePost(post, postStyleGuide, postAbort, draftModel);
          } finally {
            jobAbort.signal.removeEventListener('abort', onJobAbort);
          }
        })();

        const result = await Promise.race([runDraft, timeoutError]);
        results.push(result);
        progress.completed++;
        progress.results.push(result);
        draftEvents.emit('drafted', { type: 'drafted', postId: post.id, author: post.author, draft: result.draft });
      } catch (err) {
        const failState = classifyDraftError(err, jobAbort);
        const msg = `Failed for ${post.author}: ${err instanceof Error ? err.message : String(err)}`;
        setDraftState(post.id, failState, err instanceof Error ? err.message : String(err));

        const isCancelled = failState.startsWith('cancelled_');
        if (!isCancelled) {
          errors.push(msg);
          progress.errors.push(msg);
        }
        progress.completed++;

        const logAction = isCancelled ? failState as 'cancelled_user' | 'cancelled_system' : failState as 'failed_quality' | 'failed_timeout' | 'failed_provider';
        logDraftActivity(post.id, post.post_url, logAction, `draft:${msg}`);
        draftEvents.emit('error', { type: 'error', postId: post.id, author: post.author, error: isCancelled ? `Cancelled for ${post.author}` : msg });
      }

      draftEvents.emit('progress', { ...progress });
    }

    return { results, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    console.error('[LinkedInDrafter] Batch failure:', msg);
    return { results, errors };
  } finally {
    activeJob = null;
    jobRunning = false;
    draftEvents.emit('complete', {
      type: 'complete',
      total: totalPostsForCompletion || postIds.length || 0,
      drafted: results.length,
      errors: errors.length,
    });
  }
}

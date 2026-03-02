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

type StanceBasis = 'contradiction' | 'missing_piece' | 'lived_experience' | 'logical_gap';
type CommentIntent = 'tradeoff' | 'new_data_point' | 'execution_caveat' | 'sharp_question';

type ResearchEvidence = {
  postSummary: string;
  keyPoint: string;
  statistic: string;
  sources: Array<{ name: string; url: string }>;
  implication: string;
  followUpQuestion: string;
  stanceBasis: StanceBasis;
  actionableAddOn: string;
  fullPostWordCount: number;
  postIntent: 'educational' | 'promotional' | 'mixed';
  confidence: 'high' | 'medium' | 'low';
};

type DraftDiversityContext = {
  usedOpeningSignatures: Set<string>;
  usedLeadInSignatures: Set<string>;
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
  const explicit = (SettingsManager.get('linkedin.postModel') || '').trim();
  if (explicit && hasModelCredentials(explicit)) return explicit;

  const runtimeModel = AgentManager.getModel();
  if (typeof runtimeModel === 'string' && runtimeModel.trim() && hasModelCredentials(runtimeModel.trim())) {
    return runtimeModel.trim();
  }

  const configured = (SettingsManager.get('agent.model') || '').trim();
  if (configured && hasModelCredentials(configured)) {
    return configured.trim();
  }

  const fallbacks = ['claude-sonnet-4-6', 'glm-5', 'MiniMax-M2.5-Lightning', 'kimi-k2.5'];
  const firstAvailable = fallbacks.find(model => hasModelCredentials(model));
  if (firstAvailable) return firstAvailable;

  // Last resort: keep a deterministic default even if credentials are currently missing.
  return explicit || configured || 'claude-sonnet-4-6';
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

function chooseCommentIntent(postId: number): CommentIntent {
  const intents: Array<CommentIntent> = [
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

function countWords(text: string): number {
  return (String(text || '').match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length;
}

function clampNumber(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

type LengthPlan = {
  targetWords: number;
  minWords: number;
  maxWords: number;
  label: 'short' | 'medium' | 'long';
};

type DraftQualityAssessment = {
  hardIssues: string[];
  softWarnings: string[];
};

type DraftGenerationResult = {
  draft: string;
  evidence: ResearchEvidence;
  commentIntent: CommentIntent;
  model: string;
};

function getLengthPlan(
  preview: string,
  evidence: ResearchEvidence,
  commentIntent: CommentIntent,
): LengthPlan {
  const sourceWords = Number.isFinite(evidence.fullPostWordCount) && evidence.fullPostWordCount > 0
    ? evidence.fullPostWordCount
    : countWords(preview);
  let target = Math.round(sourceWords * 0.95);

  if (evidence.postIntent === 'promotional' || evidence.postIntent === 'mixed') target += 18;
  if (commentIntent === 'execution_caveat' || commentIntent === 'tradeoff') target += 14;
  if (commentIntent === 'sharp_question') target -= 10;
  if (evidence.confidence === 'low') target -= 8;

  target = clampNumber(target, 70, 230);
  const minWords = clampNumber(target - 22, 55, 210);
  const maxWords = clampNumber(target + 38, 90, 270);
  const label: LengthPlan['label'] = target < 105 ? 'short' : target < 165 ? 'medium' : 'long';

  return { targetWords: target, minWords, maxWords, label };
}

function normalizeSignatureWords(text: string, maxWords: number): string {
  return (String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [])
    .slice(0, maxWords)
    .join(' ');
}

function getOpeningSignature(draft: string): string {
  const firstSentence = (String(draft || '').match(/[^.!?]+[.!?]?/) || [''])[0];
  return normalizeSignatureWords(firstSentence, 7);
}

function getLeadInSignatures(draft: string): string[] {
  const lines = String(draft || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 4);
  return lines
    .map(line => normalizeSignatureWords(line, 4))
    .filter(Boolean);
}

function hasTwoCentsMoment(text: string): boolean {
  const low = text.toLowerCase();
  const stancePatterns = [
    /\bmy two cents\b/,
    /\bi (?:disagree|don't buy|would push back|would challenge|think)\b/,
    /\bthe miss is\b/,
    /\bthe gap is\b/,
    /\bthe problem is\b/,
    /\bhard truth\b/,
    /\bthis part is bs\b/,
    /\bbullshit\b/,
    /\bwrong level\b/,
    /\btrade[- ]off\b/,
    /\bi'd do it differently\b/,
  ];
  if (stancePatterns.some(re => re.test(low))) return true;
  return /\bbut\b/.test(low) && /\b(not|isn't|doesn't|won't|can't|miss|wrong)\b/.test(low);
}

function getSentenceWordLengths(text: string): number[] {
  return (String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map(s => countWords(s))
    .filter(n => n > 0);
}

function hasHumanSentenceRhythm(text: string, lengthPlan: LengthPlan): boolean {
  const lengths = getSentenceWordLengths(text);
  if (lengths.length < 2) return false;

  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);
  const spread = maxLen - minLen;

  // For medium/long comments, enforce visible cadence shifts.
  if (lengthPlan.label !== 'short') {
    const hasShort = lengths.some(n => n <= 6);
    const hasLong = lengths.some(n => n >= 16);
    return (hasShort && hasLong) || spread >= 12;
  }

  // Short comments still need some variance, just less extreme.
  return spread >= 7 || (minLen <= 6 && maxLen >= 12);
}

function hasPunctuationTexture(text: string, lengthPlan: LengthPlan): boolean {
  if (lengthPlan.label === 'short') return true;
  const trimmed = text.trim();
  const withoutFinalQuestion = trimmed.replace(/\?\s*$/, '');
  return withoutFinalQuestion.includes('...') || withoutFinalQuestion.includes(';') || withoutFinalQuestion.includes('?');
}

function hasActionableFollowThrough(text: string): boolean {
  const low = text.toLowerCase();
  const actionPatterns = [
    /\bstart with\b/,
    /\bnext step\b/,
    /\btry\b/,
    /\bdo this\b/,
    /\bdo x then y\b/,
    /\bmeasure\b/,
    /\btrack\b/,
    /\bmap\b/,
    /\baudit\b/,
    /\btest\b/,
    /\bship\b/,
    /\bprioritize\b/,
    /\bworkflow\b/,
    /\bchecklist\b/,
    /\bpractically\b/,
    /\bif you want this to work\b/,
  ];
  return actionPatterns.some(re => re.test(low));
}

function evaluateDraftQuality(
  draft: string,
  evidence: ResearchEvidence,
  preview: string,
  authorFirstName: string,
  lengthPlan: LengthPlan,
  diversity?: DraftDiversityContext,
): DraftQualityAssessment {
  const hardIssues: string[] = [];
  const softWarnings: string[] = [];

  if (isWeakDraft(draft)) hardIssues.push('too generic or too short');
  if (!startsWithAuthorName(draft, authorFirstName)) hardIssues.push('opening does not start with the author name');
  if (!hasRelevanceAnchor(draft, evidence.keyPoint, preview)) hardIssues.push('missing concrete anchor from original post');
  if (!draft.includes('\n') && draft.length > 350) hardIssues.push('single dense paragraph, needs line breaks');
  if (hasAISlopWords(draft)) hardIssues.push('contains AI-sounding jargon');
  if (/\?\s*$/.test(draft.trim())) hardIssues.push('ends with a question');
  if (/\b(according to|study by|data from|research by|report by)\b/i.test(draft)) hardIssues.push('cites source by name');
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Study|Report|Research|Survey|Data|Index)\b/.test(draft)) hardIssues.push('references named study or report');
  const allCapsWords = draft.match(/\b[A-Z]{4,}\b/g) || [];
  if (allCapsWords.length > 2) hardIssues.push('contains unnatural all-caps wording');
  if (!hasTwoCentsMoment(draft)) hardIssues.push('missing clear two-cents stance');
  if (!hasActionableFollowThrough(draft)) hardIssues.push('missing actionable follow-through');

  const words = countWords(draft);
  if (words < lengthPlan.minWords) hardIssues.push(`too short for auto-length target (${words} words, need ${lengthPlan.minWords}-${lengthPlan.maxWords})`);
  if (words > lengthPlan.maxWords) hardIssues.push(`too long for auto-length target (${words} words, need ${lengthPlan.minWords}-${lengthPlan.maxWords})`);

  const draftNums = getNumbers(draft);
  if (draftNums.length > 0) {
    if (!hasSourceCue(draft)) hardIssues.push('numeric claim lacks source cue');
    const evidenceNums = getNumbers(evidence.statistic);
    if (evidenceNums.length > 0 && !draftNums.some(n => evidenceNums.includes(n))) {
      hardIssues.push('numeric claim not grounded in research evidence');
    }
  }

  // Metaphors and analogies — instant AI tell
  if (/\b(it'?s like|the way .{5,30} is the same|think of it as|imagine a|picture a|it'?s the equivalent)\b/i.test(draft)) {
    hardIssues.push('contains metaphor or analogy');
  }

  // Audience-lecturing: talking to "anyone" or "people" instead of the author
  if (/\b(anyone considering|people need to|everyone should|people who|those who are)\b/i.test(draft)) {
    hardIssues.push('lectures the audience instead of talking to the author');
  }

  // Too many paragraphs = essay structure
  const paragraphs = draft.split(/\n\s*\n|\n/).filter(p => p.trim().length > 20);
  if (paragraphs.length > 5) hardIssues.push('too many paragraphs, sounds like an essay');

  // Too long overall
  if (draft.length > 1400) hardIssues.push('comment too long, trim to under 1400 chars');

  if (diversity) {
    const opening = getOpeningSignature(draft);
    if (opening && diversity.usedOpeningSignatures.has(opening)) {
      hardIssues.push('opening pattern repeated from earlier draft in this batch');
    }
    const repeatedLeadIns = getLeadInSignatures(draft).filter(sig => diversity.usedLeadInSignatures.has(sig));
    if (repeatedLeadIns.length >= 2) {
      hardIssues.push('too many repeated lead-ins from earlier drafts in this batch');
    }
  }

  if (!hasHumanSentenceRhythm(draft, lengthPlan)) {
    softWarnings.push('sentence rhythm too uniform (needs short + long sentence mix)');
  }
  if (!hasPunctuationTexture(draft, lengthPlan)) {
    softWarnings.push('missing punctuation texture (use ... or ; or inline ? naturally)');
  }

  return { hardIssues, softWarnings };
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
    'lectures the audience',
    'too many paragraphs',
    'comment too long',
    'contains metaphor',
    'missing clear two-cents stance',
    'missing actionable follow-through',
    'too short for auto-length target',
    'too long for auto-length target',
    'opening pattern repeated',
    'repeated lead-ins',
  ];
  return issues.some(issue => criticalSnippets.some(snippet => issue.includes(snippet)));
}

function buildDeterministicFallbackDraft(
  post: DraftPost,
  evidence: ResearchEvidence,
  authorFirstName: string,
  commentIntent: CommentIntent,
): string {
  const anchor = (evidence.keyPoint || post.text_preview || 'the point you shared')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '')
    .slice(0, 160);

  const sourceName = (evidence.sources[0]?.name || 'recent industry').trim();
  const rawStat = (evidence.statistic || '').replace(/\s+/g, ' ').trim();
  const statSentence = rawStat
    ? (hasSourceCue(rawStat) ? rawStat : `in recent ${sourceName.toLowerCase()} data, ${rawStat}`)
    : 'in recent market data, search behavior is fragmenting faster than most teams plan for.';

  const angleLineMap: Record<typeof commentIntent, string> = {
    tradeoff: 'my two cents, the tradeoff is speed versus trust; teams chasing volume usually pay for it later.',
    new_data_point: 'my two cents, the trend only matters if it changes one concrete execution choice this week...',
    execution_caveat: 'my two cents, execution consistency is the real bottleneck because most teams pivot before signals settle.',
    sharp_question: 'my two cents, this is worth stress-testing with one hard metric instead of broad assumptions.',
  };

  const actionLine = (evidence.actionableAddOn || 'practical move: map one workflow, choose one metric, and review it after two weeks.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '');

  const text = [
    `${authorFirstName}, your point about ${anchor} is the part most teams underestimate.`,
    statSentence.endsWith('.') ? statSentence : `${statSentence}.`,
    angleLineMap[commentIntent],
    actionLine.endsWith('.') ? actionLine : `${actionLine}.`,
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
    stanceBasis: 'logical_gap',
    actionableAddOn: '',
    fullPostWordCount: 0,
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

  const stanceBasisRaw = String(parsed.stance_basis || '').toLowerCase().replace(/\s+/g, '_');
  const stanceBasis: StanceBasis =
    stanceBasisRaw === 'contradiction'
    || stanceBasisRaw === 'missing_piece'
    || stanceBasisRaw === 'lived_experience'
    || stanceBasisRaw === 'logical_gap'
      ? stanceBasisRaw
      : 'logical_gap';

  const sources: Array<{ name: string; url: string }> = [];
  const source1 = String(parsed.source_1 || parsed.source || '').trim();
  const sourceUrl1 = String(parsed.source_url_1 || parsed.source_url || '').trim();
  const source2 = String(parsed.source_2 || '').trim();
  const sourceUrl2 = String(parsed.source_url_2 || '').trim();
  if (source1) sources.push({ name: source1, url: sourceUrl1 });
  if (source2) sources.push({ name: source2, url: sourceUrl2 });

  const fullPostWordCountRaw = Number.parseInt(String(parsed.full_post_word_count || '0'), 10);
  const fullPostWordCount = Number.isFinite(fullPostWordCountRaw) && fullPostWordCountRaw > 0
    ? fullPostWordCountRaw
    : 0;

  return {
    postSummary: String(parsed.post_summary || '').trim(),
    keyPoint: String(parsed.key_point || '').trim(),
    statistic: String(parsed.statistic || '').trim(),
    sources,
    implication: String(parsed.implication || '').trim(),
    followUpQuestion: String(parsed.follow_up_question || '').trim(),
    stanceBasis,
    actionableAddOn: String(parsed.actionable_add_on || '').trim(),
    fullPostWordCount,
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
    evidence.fullPostWordCount > 0 ? `Full post word count from WebFetch: ${evidence.fullPostWordCount}` : '',
    evidence.implication ? `Implication: ${evidence.implication}` : '',
    `Two-cents basis selected from research: ${evidence.stanceBasis}`,
    evidence.actionableAddOn ? `Actionable follow-through to include: ${evidence.actionableAddOn}` : '',
    `Post intent: ${evidence.postIntent}`,
    `Evidence confidence: ${evidence.confidence}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function hasMinimumEvidence(evidence: ResearchEvidence, requireTwoSources: boolean): boolean {
  if (!evidence.keyPoint || !evidence.statistic || !evidence.actionableAddOn) return false;
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
- Derive the two-cents basis in this priority order: contradiction > missing_piece > lived_experience > logical_gap.
- Provide one actionable add-on (mini tutorial step, practical suggestion, or researched discovery) so the comment adds value, not just criticism.
- Use ONLY evidence from this run's WebFetch/WebSearch. Do not rely on model memory.
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
  "full_post_word_count": "integer word count from the WebFetch full post text",
  "key_point": "most specific point from the post to reference",
  "statistic": "one loose fact or trend you found (paraphrase casually, no exact numbers or source names needed)",
  "stance_basis": "contradiction|missing_piece|lived_experience|logical_gap",
  "actionable_add_on": "one concrete next step or mini-tutorial tip that helps the reader act",
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
    throw new Error(`Research evidence insufficient (needs key point, statistic, actionable add-on, and ${required})`);
  }
  return evidence;
}

async function runWritePass(
  queryFn: (params: { prompt: string; options?: SDKOptions }) => SDKQuery,
  post: DraftPost,
  styleGuide: string,
  evidence: ResearchEvidence,
  commentIntent: CommentIntent,
  model: string,
  config: LinkedInDraftConfig,
  abortController: AbortController,
  env: Record<string, string | undefined>,
  diversity?: DraftDiversityContext,
): Promise<string> {
  const researchBrief = evidenceToBrief(evidence);
  const authorFirstName = getAuthorFirstName(post.author);
  const lengthPlan = getLengthPlan(post.text_preview, evidence, commentIntent);
  const avoidOpenings = diversity ? Array.from(diversity.usedOpeningSignatures).filter(Boolean).slice(-6) : [];
  const avoidLeadIns = diversity ? Array.from(diversity.usedLeadInSignatures).filter(Boolean).slice(-8) : [];
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
- Automatic length target for this post: around ${lengthPlan.targetWords} words (${lengthPlan.minWords}-${lengthPlan.maxWords} acceptable). Content decides where it lands, never pad.
- Sentence 1 must start with "${authorFirstName}," and reference a specific point from the post.
- Weave in ONE insight from the research naturally. Do NOT cite source names, publication names, or exact statistics. Paraphrase loosely like you already knew it. Say "the market is roughly doubling" not "according to Mordor Intelligence the market will grow from $75B to $149B by 2031".
- Do NOT end with a question. End with a statement, a take, or an incomplete thought. Questions at the end feel like interview prompts, not real comments.
- Include one clear "two-cents moment": a direct stance, pushback, or "this part is bs" claim tied to what the author said. No fence-sitting.
- The two-cents moment must come from the selected research basis (${evidence.stanceBasis}) and stay close to the author's topic.
- After pushback, add actionable continuation. Leave a practical next step, mini tutorial step, or specific discovery so readers learn something.

VOICE (critical - this is what makes it sound human):
- Vary paragraph length: mix short punchy lines with longer thoughts. Never uniform blocks.
- Lowercase generic acronyms casually: "seo", "ctr", "aio", "llm" (not SEO, CTR). Brand capitalization does not need to be perfect every time, but never use ALL CAPS brand names.
- Mix sentence-start casing: ~50% capitalized, ~50% not.
- Use one casual connector per comment max: "honestly", "the thing is", "tbh".
- Leave 1-2 rough edges on purpose: lowercase starts, sentence fragment, or abrupt connector. Keep it readable, not polished.
- Round numbers casually sometimes: "around 60%" not "61%", "3-4x" not "3.7x".
- Let some thoughts run naturally into each other. Don't perfectly structure every paragraph.
- Rhythm guidance is soft, not rigid: prefer mixed sentence lengths and occasional punctuation texture ("...", ";", inline "?"), but do not force weird punctuation if it hurts flow.
- NO metaphors or analogies. Never "it's like X", "the way Y works", "think of it as Z". Just say the thing directly. Metaphors are the #1 AI tell.
- NO intro-body-conclusion structure. The comment should read like one continuous thought that could have kept going but you stopped typing. Real comments don't wrap up neatly.
- Don't overuse personal experience framing ("I've seen", "we had a client", "happened to us"). Use it once max and only when it genuinely adds weight. Most of the time just state your take directly without qualifying where it comes from.
- Kill filler and hedge words: never use "and yeah", "I mean", "to be fair", "maybe but", "nobody's arguing that", "sure but". Every sentence must carry a point. If removing a sentence changes nothing, delete it.
- Format as 2-4 short chunks separated by single line breaks. Break after a thought shift, not after every sentence. Never one giant wall of text, never 5+ separate paragraphs. Think text message energy — short blocks, not essay paragraphs.
- Batch diversity: avoid repeating opening patterns or lead-ins used in recent drafts from this same run.${avoidOpenings.length ? `\n  Avoid these opening signatures: ${avoidOpenings.join(' | ')}` : ''}${avoidLeadIns.length ? `\n  Avoid these lead-ins: ${avoidLeadIns.join(' | ')}` : ''}

HARD RULES:
- No emojis, no hashtags, no em dashes, no en dashes.
- No generic praise ("great post", "thanks for sharing", "love this", "spot on").
- No AI jargon ("landscape", "leverage", "robust", "holistic", "transformative", "game-changing", "trajectory", "institutionalizing", "decoupling", "paradigm", "ecosystem", "scalable", "actionable", "double down").
- Use only straight quotes and apostrophes, no curly/smart quotes.
- NEVER invent statistics or data. No "3x higher", "roughly doubling", "60% of companies" unless the research notes contain that exact figure. If you don't have a number, don't make one up. Use your own experience framing instead: "from what I've seen", "in my experience", "the teams I've worked with".
- NEVER lecture the audience. Don't say "anyone considering X should..." or "people need to understand...". You're talking to the author, not giving a TED talk.
- Promotional posts: you can push back, but be specific to what the author actually said. Don't default to generic contrarian takes. Challenge the specific claim, not the category. And acknowledge what's actually good before you push back.
- Keep the tone of someone who respects the author but disagrees on specifics. Not hostile, not preachy. Think bar conversation, not debate podium.
- Max 3-4 short paragraphs for a pushback comment. If you need more than that, you're over-explaining.${styleGuide ? `\n\nADDITIONAL STYLE GUIDE:\n${styleGuide}` : ''}

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
- Two-cents basis from research: ${evidence.stanceBasis}
- Actionable continuation to include after your stance: ${evidence.actionableAddOn || 'provide one practical next step tied to the claim'}
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
    const quality = evaluateDraftQuality(draft, evidence, post.text_preview, authorFirstName, lengthPlan, diversity);
    const issues = quality.hardIssues;
    if (issues.length === 0) break;
    const repairPrompt = `${writePrompt}

The previous draft failed quality checks for:
- ${issues.join('\n- ')}

Rewrite with strict compliance:
- start sentence 1 with "${authorFirstName},"
- reference the post's key point explicitly
- include one numeric/date detail from research notes
- include source cue wording
- include one direct two-cents stance tied to the specific claim in the post
- include actionable follow-through right after the stance (specific next step or mini tutorial)
- keep length around ${lengthPlan.targetWords} words (${lengthPlan.minWords}-${lengthPlan.maxWords})
- format as short paragraphs with line breaks, not one dense block
- avoid hype/jargon and generic agreement
- keep text human-imperfect: allow lowercase sentence starts, but avoid ALL CAPS`;
    draft = ensureReadableCommentLayout(cleanDraftText(await generateDraftFromSdk(queryFn, repairPrompt, writeOptions)));
  }

  if (!draft) {
    throw new Error('Write pass returned empty output');
  }

  const finalQuality = evaluateDraftQuality(draft, evidence, post.text_preview, authorFirstName, lengthPlan, diversity);
  if (finalQuality.hardIssues.length > 0) {
    const salvagePrompt = `${writePrompt}

The latest draft still failed checks for:
- ${finalQuality.hardIssues.join('\n- ')}

Final rewrite requirements:
- Keep length around ${lengthPlan.targetWords} words (${lengthPlan.minWords}-${lengthPlan.maxWords})
- Sentence 1 must start with "${authorFirstName},"
- Include one specific number/date from research notes
- Include one source cue phrase like "According to" or "In [source] data"
- Include one clear two-cents stance, direct and specific
- Include actionable follow-through after the stance, concrete and useful
- Keep natural human tone and short paragraph formatting with line breaks
- Keep slight human messiness (lowercase starts/fragments allowed), no ALL CAPS brand words
- No generic praise and no jargon

Return only the final comment text.`;

    const salvaged = ensureReadableCommentLayout(
      cleanDraftText(await generateDraftFromSdk(queryFn, salvagePrompt, writeOptions))
    );
    if (salvaged) draft = salvaged;

    const salvageQuality = evaluateDraftQuality(draft, evidence, post.text_preview, authorFirstName, lengthPlan, diversity);
    if (salvageQuality.hardIssues.length > 0) {
      if (hasCriticalQualityIssue(salvageQuality.hardIssues)) {
        const fallbackDraft = buildDeterministicFallbackDraft(post, evidence, authorFirstName, commentIntent);
        const fallbackQuality = evaluateDraftQuality(fallbackDraft, evidence, post.text_preview, authorFirstName, lengthPlan, diversity);
        if (fallbackQuality.hardIssues.length > 0 || fallbackQuality.softWarnings.length > 0) {
          console.warn(`[LinkedInDrafter] Fallback draft warnings: ${[...fallbackQuality.hardIssues, ...fallbackQuality.softWarnings].join('; ')}`);
        }
        return fallbackDraft;
      }
      console.warn(`[LinkedInDrafter] Accepting draft with non-critical quality warnings: ${salvageQuality.hardIssues.join('; ')}`);
    } else if (salvageQuality.softWarnings.length > 0) {
      console.warn(`[LinkedInDrafter] Style warnings (soft): ${salvageQuality.softWarnings.join('; ')}`);
    }
  } else if (finalQuality.softWarnings.length > 0) {
    console.warn(`[LinkedInDrafter] Style warnings (soft): ${finalQuality.softWarnings.join('; ')}`);
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
  diversity?: DraftDiversityContext,
): Promise<DraftGenerationResult> {
  const env = await buildProviderEnv(model);
  const attempt = createAttemptAbortController(parentAbortController, remainingMs);
  try {
    const evidence = await runResearchPass(queryFn, post, model, config, attempt.controller, env);
    const commentIntent = chooseCommentIntent(post.id);
    const draft = await runWritePass(queryFn, post, styleGuide, evidence, commentIntent, model, config, attempt.controller, env, diversity);
    return { draft, evidence, commentIntent, model };
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

function saveDraftEvidence(
  db: Database.Database,
  postId: number,
  postUrl: string,
  generation: DraftGenerationResult,
): void {
  const ev = generation.evidence;
  const s1 = ev.sources[0] || { name: '', url: '' };
  const s2 = ev.sources[1] || { name: '', url: '' };

  db.prepare(`
    INSERT INTO linkedin_draft_evidence (
      post_id, post_url, model, comment_intent,
      post_summary, key_point, statistic, implication, follow_up_question,
      stance_basis, actionable_add_on, post_intent, confidence, full_post_word_count,
      source_1_name, source_1_url, source_2_name, source_2_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    postId,
    postUrl,
    generation.model || null,
    generation.commentIntent || null,
    ev.postSummary || null,
    ev.keyPoint || null,
    ev.statistic || null,
    ev.implication || null,
    ev.followUpQuestion || null,
    ev.stanceBasis || null,
    ev.actionableAddOn || null,
    ev.postIntent || null,
    ev.confidence || null,
    Number.isFinite(ev.fullPostWordCount) ? ev.fullPostWordCount : null,
    s1.name || null,
    s1.url || null,
    s2.name || null,
    s2.url || null,
  );
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
  diversity?: DraftDiversityContext,
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
  let generation: DraftGenerationResult | null = null;
  const attemptErrors: string[] = [];

  for (const attemptModel of attemptModels) {
    if (abortController.signal.aborted) throw new Error('Draft job cancelled');
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1500) {
      attemptErrors.push(`Timed out after ${effectiveTimeoutSec}s total`);
      break;
    }
    try {
      generation = await generateDraftForModel(
        queryFn,
        post,
        styleGuide,
        attemptModel,
        config,
        abortController,
        remainingMs,
        diversity,
      );
      draft = generation.draft;
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
    if (generation) {
      saveDraftEvidence(db, post.id, post.post_url, generation);
    }

    if (abortController.signal.aborted) {
      throw new Error('Draft timed out before finalize');
    }

    if (diversity) {
      const opening = getOpeningSignature(draft);
      if (opening) diversity.usedOpeningSignatures.add(opening);
      for (const lead of getLeadInSignatures(draft)) diversity.usedLeadInSignatures.add(lead);
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
    const diversity: DraftDiversityContext = {
      usedOpeningSignatures: new Set<string>(),
      usedLeadInSignatures: new Set<string>(),
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
            return await draftOnePost(post, postStyleGuide, postAbort, draftModel, diversity);
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

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
import os from 'os';
import fs from 'fs';
import { SettingsManager } from '../settings';
import { KanbanService } from '../kanban';
import { AgentManager } from '../agent';
import { glmChat } from './glm-client';
import { linkedinExec } from './linkedin-wrapper';

// SDK types
type SDKQuery = AsyncGenerator<unknown, void>;
type SDKOptions = {
  model?: string;
  maxTurns?: number;
  abortController?: AbortController;
  tools?: { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  systemPrompt?: string;
  settingSources?: ('project' | 'user')[];
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

type ProviderType = 'anthropic' | 'moonshot' | 'glm' | 'minimax' | 'qwen' | 'openrouter' | 'openai' | 'gemini';
type DraftMode = 'fast' | 'balanced' | 'deep';
type LinkedInDraftConfig = {
  mode: DraftMode;
  perPostTimeoutSec: number;
  researchMaxTurns: number;
  writeMaxTurns: number;
  maxSearchQueries: number;
  fallbackModel: string;
  fallbackModel2: string;
  fallbackModel3: string;
  requireTwoSources: boolean;
};

type StanceBasis = 'contradiction' | 'missing_piece' | 'lived_experience' | 'logical_gap';
type CommentIntent = 'tradeoff' | 'new_data_point' | 'execution_caveat' | 'sharp_question';

type ResearchEvidence = {
  postSummary: string;
  keyPoint: string;
  statistic: string;
  sources: Array<{ name: string; url: string }>;
  namedMechanism: string;
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
  'gpt-4.1': 'openai',
  'gpt-4.1-mini': 'openai',
  'gpt-4.1-nano': 'openai',
  'gemini-2.5-pro': 'gemini',
  'gemini-2.5-flash': 'gemini',
  'gemini-2.5-flash-lite': 'gemini',
  'kimi-k2.5': 'moonshot',
  'glm-5': 'glm',
  'MiniMax-M2.5': 'minimax',
  'MiniMax-M2.5-Lightning': 'minimax',
  'qwen3.5-plus-2026-02-15': 'qwen',
  'qwen/qwen3.5-plus-02-15': 'openrouter',
  'qwen/qwen3.5-flash': 'openrouter',
};

const PROVIDER_BASE_URLS: Record<Exclude<ProviderType, 'anthropic'>, string> = {
  moonshot: 'https://api.moonshot.ai/anthropic',
  glm: 'https://api.z.ai/api/anthropic',
  minimax: 'https://api.minimax.io/anthropic',
  qwen: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
  openrouter: 'https://openrouter.ai/api',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

function isAllowedLinkedInModel(model: string): boolean {
  return getProviderForModel(model) !== 'openrouter';
}

function getDraftModel(): string {
  const explicit = (SettingsManager.get('linkedin.postModel') || '').trim();
  if (explicit && isAllowedLinkedInModel(explicit) && hasModelCredentials(explicit)) return explicit;

  const runtimeModel = AgentManager.getModel();
  if (
    typeof runtimeModel === 'string'
    && runtimeModel.trim()
    && isAllowedLinkedInModel(runtimeModel.trim())
    && hasModelCredentials(runtimeModel.trim())
  ) {
    return runtimeModel.trim();
  }

  const configured = (SettingsManager.get('agent.model') || '').trim();
  if (configured && isAllowedLinkedInModel(configured) && hasModelCredentials(configured)) {
    return configured.trim();
  }

  const fallbacks = ['claude-sonnet-4-6', 'gemini-2.5-flash', 'gpt-4.1', 'glm-5', 'MiniMax-M2.5-Lightning', 'kimi-k2.5', 'qwen3.5-plus-2026-02-15'];
  const firstAvailable = fallbacks.find(model => hasModelCredentials(model));
  if (firstAvailable) return firstAvailable;

  // Last resort: keep a deterministic default even if credentials are currently missing.
  return (isAllowedLinkedInModel(explicit) && explicit)
    || (isAllowedLinkedInModel(configured) && configured)
    || 'claude-sonnet-4-6';
}

function getProviderForModel(model: string): ProviderType {
  const mapped = MODEL_PROVIDERS[model];
  if (mapped) return mapped;
  const normalized = String(model || '').trim().toLowerCase();
  if (normalized.startsWith('gpt-')) return 'openai';
  if (normalized.startsWith('gemini-')) return 'gemini';
  if (normalized.includes('/')) return 'openrouter';
  if (normalized.startsWith('qwen')) return 'qwen';
  return 'anthropic';
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
    fallbackModel2: (SettingsManager.get('linkedin.researchFallbackModel2') || '').trim(),
    fallbackModel3: (SettingsManager.get('linkedin.researchFallbackModel3') || '').trim(),
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
  if (provider === 'qwen') return !!SettingsManager.get('qwen.apiKey');
  if (provider === 'openai') return !!SettingsManager.get('openai.apiKey');
  if (provider === 'gemini') return !!SettingsManager.get('gemini.apiKey');
  if (provider === 'openrouter') return !!SettingsManager.get('openrouter.apiKey');
  return !!SettingsManager.get('anthropic.apiKey') || SettingsManager.get('auth.method') === 'oauth';
}

function getAttemptModels(primaryModel: string, fallbackModel: string, fallbackModel2: string, fallbackModel3: string): string[] {
  const globalFallback = (SettingsManager.get('agent.fallbackModel') || '').trim();
  const defaults = ['claude-sonnet-4-6', 'gemini-2.5-flash', 'gpt-4.1', 'glm-5', 'MiniMax-M2.5-Lightning', 'kimi-k2.5', 'qwen3.5-plus-2026-02-15'];
  const candidates = [primaryModel, fallbackModel, fallbackModel2, fallbackModel3, globalFallback, ...defaults]
    .map(m => (m || '').trim())
    .filter(Boolean);
  const unique = Array.from(new Set(candidates));
  return unique.filter((model, idx) => {
    const provider = getProviderForModel(model);
    if (provider === 'openrouter') return false;
    return idx === 0 || hasModelCredentials(model);
  });
}

function pickResearchModel(primaryModel: string, config: LinkedInDraftConfig): string {
  const candidates = getAttemptModels(primaryModel, config.fallbackModel, config.fallbackModel2, config.fallbackModel3);
  const match = candidates.find((model) => {
    const provider = getProviderForModel(model);
    if (provider === 'openrouter' || provider === 'openai' || provider === 'gemini') return false;
    return hasModelCredentials(model);
  });
  return match || '';
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
    env.CLAUDE_CODE_OAUTH_TOKEN = minimaxKey;
    delete env.ANTHROPIC_API_KEY;
    return env;
  }

  if (provider === 'qwen') {
    const qwenKey = SettingsManager.get('qwen.apiKey');
    if (!qwenKey) {
      throw new Error('Qwen API key not configured. Add it in Settings > LLM.');
    }
    env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.qwen;
    env.CLAUDE_CODE_OAUTH_TOKEN = qwenKey;
    delete env.ANTHROPIC_API_KEY;
    return env;
  }

  if (provider === 'openrouter') {
    const openRouterKey = SettingsManager.get('openrouter.apiKey');
    if (!openRouterKey) {
      throw new Error('OpenRouter API key not configured. Add it in Settings > LLM.');
    }
    env.ANTHROPIC_BASE_URL = PROVIDER_BASE_URLS.openrouter;
    env.CLAUDE_CODE_OAUTH_TOKEN = openRouterKey;
    delete env.ANTHROPIC_API_KEY;
    env.HTTP_REFERER = 'https://github.com/google-gemini/pocket-agent';
    env.X_TITLE = 'Pocket Agent';
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

  const anthropicKey = SettingsManager.get('anthropic.apiKey');
  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
    return env;
  }

  throw new Error('No Anthropic API key configured. Add it in Settings.');
}

function getAgentWorkspace(): string {
  return path.join(os.homedir(), 'Documents', 'Pocket-agent');
}

function getAppDataDir(): string {
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, 'Library/Application Support/pocket-agent'),
    path.join(homeDir, '.config/pocket-agent'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return homeDir || process.cwd();
}

function getSdkCwd(): string {
  const workspace = getAgentWorkspace();
  if (fs.existsSync(path.join(workspace, 'CLAUDE.md'))) return workspace;
  const appSupportDir = getAppDataDir();
  if (fs.existsSync(appSupportDir)) return appSupportDir;
  return workspace || process.cwd();
}

function getSdkEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };
  // Prevent nested-session and global config leakage that can crash child SDK runs.
  delete env.CLAUDECODE;
  if (!env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = path.join(getAppDataDir(), '.claude');
  }
  return env;
}

function getPromptDateContext(): { isoDate: string; humanDate: string; year: number } {
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const humanDate = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return {
    isoDate,
    humanDate,
    year: now.getFullYear(),
  };
}

function extractYearTokens(text: string): string[] {
  return Array.from(new Set((String(text || '').match(/\b20\d{2}\b/g) || []).map(String)));
}

function normalizeLinkedInPostText(raw: string): string {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clipForPrompt(text: string, maxChars: number): string {
  const clean = normalizeLinkedInPostText(text);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).trimEnd()}\n...[truncated for prompt]`;
}

type LinkedInPostImage = {
  url: string;
  alt: string;
  dataUri: string;
};

type ImageAnalysisStatus = 'pending' | 'none' | 'analyzed' | 'skipped_no_model' | 'failed';

type ImageAnalysisResult = {
  context: string;
  status: ImageAnalysisStatus;
  note: string;
};

type LinkedInPostContent = {
  text: string;
  images: LinkedInPostImage[];
  imageContext: string;
  imageAnalysisStatus: ImageAnalysisStatus;
  imageAnalysisNote: string;
};

function normalizeImageDataUri(raw: string): string {
  const value = String(raw || '').trim();
  if (!value.startsWith('data:image/')) return '';
  return value.length <= 750000 ? value : '';
}

function normalizeLinkedInPostImages(raw: unknown): LinkedInPostImage[] {
  if (!Array.isArray(raw)) return [];
  const out: LinkedInPostImage[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const url = String(row.url || '').trim();
    const alt = normalizeLinkedInPostText(String(row.alt || ''));
    const dataUri = normalizeImageDataUri(String(row.data_uri || row.dataUri || ''));
    const key = (url || dataUri || alt).toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!url && !dataUri) continue;
    out.push({ url, alt, dataUri });
    if (out.length >= 2) break;
  }

  return out;
}

function getVisionModelConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const geminiKey = String(SettingsManager.get('gemini.apiKey') || '').trim();
  if (geminiKey) {
    return { baseUrl: PROVIDER_BASE_URLS.gemini, apiKey: geminiKey, model: 'gemini-2.5-flash' };
  }
  const openAiKey = String(SettingsManager.get('openai.apiKey') || '').trim();
  if (openAiKey) {
    return { baseUrl: PROVIDER_BASE_URLS.openai, apiKey: openAiKey, model: 'gpt-4.1-mini' };
  }
  return null;
}

async function summarizeLinkedInPostImages(
  images: LinkedInPostImage[],
  postPreview: string,
  postUrl: string,
  parentAbortController?: AbortController,
): Promise<ImageAnalysisResult> {
  const usable = images.filter(img => !!img.dataUri || /^https?:\/\//i.test(img.url || '')).slice(0, 2);
  if (usable.length === 0) {
    return { context: '', status: 'none', note: 'No images detected on post' };
  }

  const modelCfg = getVisionModelConfig();
  if (!modelCfg) {
    return {
      context: '',
      status: 'skipped_no_model',
      note: 'Images found but no vision model key configured',
    };
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentAbortController) {
    parentAbortController.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: `You are analyzing image(s) attached to a LinkedIn post.

Return STRICT JSON only:
{
  "image_narrative": "1-2 short sentences explaining what the images are communicating",
  "image_text": "key OCR/copy visible in the images, or empty string if none",
  "confidence": "high|medium|low"
}

Rules:
- Stay grounded in image content only.
- No speculation.
- Keep image_narrative under 80 words.

Post preview:
${clipForPrompt(postPreview || '', 500)}
Post URL: ${postUrl}`,
      },
    ];

    for (const image of usable) {
      const src = image.dataUri || image.url;
      if (!src) continue;
      content.push({
        type: 'image_url',
        image_url: { url: src, detail: 'low' },
      });
    }

    const response = await fetch(`${modelCfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${modelCfg.apiKey}`,
      },
      body: JSON.stringify({
        model: modelCfg.model,
        temperature: 0.1,
        max_tokens: 300,
        messages: [
          { role: 'system', content: 'Analyze post images for comment drafting context.' },
          { role: 'user', content },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Vision API failed (${response.status})`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!raw) {
      return {
        context: '',
        status: 'failed',
        note: `Vision model returned empty output (${modelCfg.model})`,
      };
    }

    const parsed = extractJsonObject(raw);
    if (!parsed) {
      return {
        context: clipForPrompt(raw, 260),
        status: 'analyzed',
        note: `Image analysis completed with ${modelCfg.model}`,
      };
    }

    const narrative = normalizeLinkedInPostText(String(parsed.image_narrative || ''));
    const imageText = normalizeLinkedInPostText(String(parsed.image_text || ''));
    const confidence = String(parsed.confidence || '').trim().toLowerCase();
    const confidenceLabel = confidence ? ` (${confidence})` : '';

    const parts = [
      narrative ? `Image narrative${confidenceLabel}: ${narrative}` : '',
      imageText ? `Image text signals: ${imageText}` : '',
    ].filter(Boolean);
    const context = parts.join('\n');
    if (!context) {
      return {
        context: '',
        status: 'failed',
        note: `Image analysis produced no usable context (${modelCfg.model})`,
      };
    }
    return {
      context,
      status: 'analyzed',
      note: `Analyzed ${usable.length} image${usable.length === 1 ? '' : 's'} with ${modelCfg.model}`,
    };
  } catch (err) {
    console.warn('[LinkedInDrafter] Image vision analysis skipped:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      context: '',
      status: 'failed',
      note: `Image analysis failed: ${clipForPrompt(msg, 120)}`,
    };
  } finally {
    clearTimeout(timeout);
    if (parentAbortController) {
      parentAbortController.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

async function readFullLinkedInPostContent(postUrl: string, abortController?: AbortController): Promise<LinkedInPostContent> {
  const url = String(postUrl || '').trim();
  if (!url) {
    return {
      text: '',
      images: [],
      imageContext: '',
      imageAnalysisStatus: 'none',
      imageAnalysisNote: 'No post URL',
    };
  }
  const out = await linkedinExec('reply', ['--url', url, '--read-only'], 90000);
  const parsed = JSON.parse(out) as { text?: string; images?: unknown };
  const text = normalizeLinkedInPostText(String(parsed?.text || ''));
  const images = normalizeLinkedInPostImages(parsed?.images);
  const imageAnalysis = await summarizeLinkedInPostImages(images, text, url, abortController);
  return {
    text,
    images,
    imageContext: imageAnalysis.context,
    imageAnalysisStatus: imageAnalysis.status,
    imageAnalysisNote: imageAnalysis.note,
  };
}

function setImageAnalysisState(
  postId: number,
  status: ImageAnalysisStatus,
  imageCount: number,
  note?: string,
): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(
      `UPDATE linkedin_posts
       SET image_analysis_status = ?,
           image_count = ?,
           image_analysis_note = ?,
           image_analyzed_at = datetime('now')
       WHERE id = ?`
    ).run(status, Math.max(0, Number(imageCount || 0)), note || null, postId);
  } catch (err) {
    console.warn('[LinkedInDrafter] Failed to save image analysis state:', err);
  } finally {
    db.close();
  }
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

function normalizeHumanTechnicalCasing(input: string): string {
  let text = String(input || '');
  text = text.replace(/\b(ChatGPT|Perplexity|Claude|Gemini)\b/gi, (m) => m.toLowerCase());
  text = text.replace(/\b(LLMs?|AIs?|SEOs?|CTR|CPC|AIOs?|SERPs?|GEO)\b/g, (m) => m.toLowerCase());
  return text;
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
  return normalizeHumanTechnicalCasing(text.trim());
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

function getNormalizedWordStream(input: string): string[] {
  return (String(input || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function hasHeavyPhraseOverlap(source: string, candidate: string): boolean {
  const sourceWords = getNormalizedWordStream(source);
  const candidateWords = getNormalizedWordStream(candidate);
  if (sourceWords.length < 14 || candidateWords.length < 14) return false;

  for (const n of [10, 9, 8]) {
    const candidateNgrams = new Set<string>();
    for (let i = 0; i <= candidateWords.length - n; i++) {
      candidateNgrams.add(candidateWords.slice(i, i + n).join(' '));
    }
    for (let i = 0; i <= sourceWords.length - n; i++) {
      const ngram = sourceWords.slice(i, i + n).join(' ');
      if (candidateNgrams.has(ngram)) return true;
    }
  }
  return false;
}

function hasRelevanceAnchor(draft: string, keyPoint: string, preview: string): boolean {
  const draftLow = draft.toLowerCase();
  const anchorTokens = getMeaningfulTokens(keyPoint || preview);
  if (anchorTokens.length === 0) return true;
  return anchorTokens.some(token => draftLow.includes(token));
}

function hasAISlopWords(text: string): boolean {
  return /\b(landscape|leverage|robust|comprehensive|holistic|streamline|optimize|paradigm|game[- ]changing|cutting-edge|transformative|unprecedented|synergy|foster|harness|delve|elevate|dramatically|significantly|meaningful|signaling|proposes|pressure-testing|measurable|acquisition channel|survey questions|importantly|more importantly|most importantly)\b/i.test(text);
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
    /\bi (?:disagree|don't buy|would push back|would challenge|think)\b/,
    /\bwhere i'd push back\b/,
    /\bthe part i don't buy\b/,
    /\bwhat gets missed here\b/,
    /\bthis is true up to the point where\b/,
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

function hasBannedTemplatePhrases(text: string): boolean {
  return /\b(my two cents|practical move)\b/i.test(text);
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
  if (hasHeavyPhraseOverlap(preview, draft)) hardIssues.push('too close to the post wording');
  if (!draft.includes('\n') && draft.length > 350) hardIssues.push('single dense paragraph, needs line breaks');
  if (hasAISlopWords(draft)) hardIssues.push('contains AI-sounding jargon');
  if (/\b(?:the\s+)?pattern in 20\d{2} is (?:pretty|very|quite)?\s*clear\b/i.test(draft)) {
    hardIssues.push('uses year-pattern boilerplate phrasing');
  }
  const draftYears = extractYearTokens(draft);
  if (draftYears.length > 0) {
    const currentYear = getPromptDateContext().year;
    const postYears = new Set([
      ...extractYearTokens(preview),
      ...extractYearTokens(evidence.postSummary),
      ...extractYearTokens(evidence.keyPoint),
    ]);
    const sourceYears = new Set([
      ...extractYearTokens(preview),
      ...extractYearTokens(evidence.postSummary),
      ...extractYearTokens(evidence.keyPoint),
      ...extractYearTokens(evidence.statistic),
      ...extractYearTokens(evidence.implication),
      ...extractYearTokens(evidence.actionableAddOn),
    ]);
    const ungroundedYears = draftYears.filter((year) => !sourceYears.has(year));
    if (ungroundedYears.length > 0) {
      hardIssues.push(`introduces ungrounded year reference (${ungroundedYears.join(', ')})`);
    }
    if (postYears.size === 0) {
      const nonCurrentYears = draftYears.filter((year) => Number.parseInt(year, 10) !== currentYear);
      if (nonCurrentYears.length > 0) {
        hardIssues.push(`uses non-current year without post evidence (${nonCurrentYears.join(', ')})`);
      }
    }
  }
  if (/\b(?:more importantly|most importantly|importantly)\b/i.test(draft)) {
    hardIssues.push('uses emphasis filler wording');
  }
  if (/\bgoogle'?s?\s+spam detection\b/i.test(draft)) {
    hardIssues.push('uses vague algorithm phrasing ("spam detection")');
  }
  if (
    evidence.namedMechanism
    && !new RegExp(`\\b${escapeRegex(evidence.namedMechanism)}\\b`, 'i').test(draft)
    && /\b(spam detection|anti[- ]spam|link schemes?|link spam)\b/i.test(draft)
  ) {
    softWarnings.push(`mechanism name available ("${evidence.namedMechanism}") but not used`);
  }
  if (/\bthe author (claims|says|argues|thinks|believes)\b/i.test(draft)) {
    softWarnings.push('meta framing sounds robotic; talk directly to the person');
  }
  if (/\bQ[1-4]\s+20\d{2}\s+analysis\b/i.test(draft)) {
    softWarnings.push('report citation tone reads formal; keep it lighter');
  }
  if (/\?\s*$/.test(draft.trim())) hardIssues.push('ends with a question');
  if (/\bhttps?:\/\/|www\./i.test(draft)) hardIssues.push('contains source url in comment');
  const allCapsWords = draft.match(/\b[A-Z]{4,}\b/g) || [];
  if (allCapsWords.length > 2) hardIssues.push('contains unnatural all-caps wording');
  if (!hasTwoCentsMoment(draft)) hardIssues.push('missing clear two-cents stance');
  if (!hasActionableFollowThrough(draft)) hardIssues.push('missing actionable follow-through');
  if (hasBannedTemplatePhrases(draft)) hardIssues.push('contains canned template phrase');

  const words = countWords(draft);
  if (words < lengthPlan.minWords) hardIssues.push(`too short for auto-length target (${words} words, need ${lengthPlan.minWords}-${lengthPlan.maxWords})`);
  if (words > lengthPlan.maxWords) hardIssues.push(`too long for auto-length target (${words} words, need ${lengthPlan.minWords}-${lengthPlan.maxWords})`);

  const draftNums = getNumbers(draft);
  if (draftNums.length >= 3) hardIssues.push('too many numeric claims, sounds report-like');
  const percentCount = (draft.match(/%/g) || []).length;
  if (percentCount >= 2) hardIssues.push('too many percentages, sounds robotic');
  if (/\b\d+\.\d+\b/.test(draft)) softWarnings.push('decimal precision reads robotic; round numbers casually');
  if (/\b(according to|study by|data from|research by|report by)\b/i.test(draft)) {
    softWarnings.push('source citation phrasing is formal; keep it casual ("recently saw in...")');
  }
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Study|Report|Research|Survey|Data|Index)\b/.test(draft)) {
    softWarnings.push('named report title reads formal; keep source mention lighter');
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
    'too close to the post wording',
    'too many numeric claims',
    'too many percentages',
    'too generic or too short',
    'ends with a question',
    'contains source url',
    'lectures the audience',
    'too many paragraphs',
    'comment too long',
    'contains metaphor',
    'year-pattern boilerplate',
    'emphasis filler wording',
    'vague algorithm phrasing',
    'missing clear two-cents stance',
    'missing actionable follow-through',
    'contains canned template phrase',
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
  const normalizeAnchorSnippet = (value: string): string => {
    const cleaned = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(the author|this post|author)\s+(claims|says|argues|thinks|believes)\s+(that\s+)?/i, '')
      .replace(/^that\s+/i, '')
      .replace(/\bALL\b/g, 'all')
      .replace(/[.?!]+$/, '');
    const clipped = (cleaned || 'the point you shared').slice(0, 160).trim();
    if (/^[A-Z][a-z]/.test(clipped)) {
      return `${clipped.charAt(0).toLowerCase()}${clipped.slice(1)}`;
    }
    return clipped;
  };

  const toCasualEvidenceSentence = (ev: ResearchEvidence): string => {
    const fallback = 'lately i keep seeing execution quality matter more than checklist seo.';
    let text = String(ev.implication || ev.statistic || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\baccording to\b[^,]*,\s*/ig, '')
      .replace(/\b(?:more importantly|most importantly|importantly)\b[:,]?\s*/ig, '')
      .replace(/\b(?:the\s+)?pattern in 20\d{2} is (?:pretty|very|quite)?\s*clear\b[:,]?\s*/ig, '')
      .replace(/\bhttps?:\/\/\S+/ig, '')
      .replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4}'s\s+(?:Q[1-4]\s+20\d{2}\s+)?(analysis|report|study|data)\b/g, 'recent data')
      .replace(/\([^)]*(analysis|report|study|survey|data)[^)]*\)/ig, '')
      .replace(/\b\d+\.\d+\b/g, (m) => `${Math.round(Number(m))}`);

    // Keep at most one rough percentage to avoid report-like comments.
    let pctSeen = 0;
    text = text.replace(/\b\d+(?:\.\d+)?%/g, (m) => {
      pctSeen += 1;
      if (pctSeen === 1) return `around ${Math.round(Number(m.replace('%', '')))}%`;
      return '';
    });

    // If numeric density is still high, strip numbers entirely.
    const numberTokens = text.match(/\b\d+(?:\.\d+)?\b/g) || [];
    if (numberTokens.length > 2) {
      text = text.replace(/\b\d+(?:\.\d+)?\b/g, '');
    }

    text = text
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.;:])/g, '$1')
      .replace(/,\s*,/g, ', ')
      .replace(/^[,.;:\s]+|[,.;:\s]+$/g, '')
      .trim();

    const mechanism = String(ev.namedMechanism || '').trim();
    if (mechanism && !new RegExp(`\\b${escapeRegex(mechanism)}\\b`, 'i').test(text)) {
      text = `${mechanism} is a good example here, ${text}`.replace(/\s{2,}/g, ' ').trim();
    }

    if (!text) return fallback;
    return /[.?!]$/.test(text) ? text : `${text}.`;
  };

  const anchor = normalizeAnchorSnippet(evidence.keyPoint || post.text_preview || 'the point you shared');
  const statSentence = toCasualEvidenceSentence(evidence);

  const angleLineMap: Record<typeof commentIntent, string[]> = {
    tradeoff: [
      "where i'd push back is the tradeoff between speed and trust, volume-first usually backfires later.",
      "the part people skip is the trust cost of moving too fast, that's where results fall apart.",
    ],
    new_data_point: [
      "what gets missed here is the trend only matters if it changes one concrete decision this week.",
      "this is useful only when it changes execution, otherwise it's just interesting commentary.",
    ],
    execution_caveat: [
      "the real bottleneck is execution consistency, most teams pivot before signals settle.",
      "this works until teams break rhythm after week two, then the signal disappears.",
    ],
    sharp_question: [
      "i'd pressure-test this with one hard metric before scaling it.",
      "where i'd push back is broad claims before the metric is clear.",
    ],
  };
  const angleVariants = angleLineMap[commentIntent];
  const angleLine = angleVariants[Math.abs(post.id) % angleVariants.length];

  const actionLine = (evidence.actionableAddOn || 'start with one workflow, choose one metric, and review it after two weeks.')
    .replace(/\s+/g, ' ')
    .replace(/^(practical move|actionable add[- ]on|next step)\s*:\s*/i, '')
    .trim()
    .replace(/[.?!]+$/, '');

  const text = [
    `${authorFirstName}, the part that stood out to me is this: ${anchor}.`,
    statSentence.endsWith('.') ? statSentence : `${statSentence}.`,
    angleLine,
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
    namedMechanism: '',
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
    namedMechanism: String(parsed.named_mechanism || parsed.mechanism_name || '').trim(),
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
    evidence.statistic ? `Background insight (paraphrase loosely; optional light source mention, but no URLs and no exact numbers): ${evidence.statistic}` : '',
    evidence.namedMechanism ? `Concrete mechanism/system name (if relevant, mention naturally): ${evidence.namedMechanism}` : '',
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
  if (!Number.isFinite(evidence.fullPostWordCount) || evidence.fullPostWordCount <= 0) return false;
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
  fullPostText: string,
  imageContext: string,
  model: string,
  config: LinkedInDraftConfig,
  abortController: AbortController,
  env: Record<string, string | undefined>,
): Promise<ResearchEvidence> {
  const fullTextForPrompt = clipForPrompt(fullPostText || post.text_preview || '', 10000);
  const fallbackIntent = detectPostIntent(fullTextForPrompt || post.text_preview);
  const dateContext = getPromptDateContext();
  const researchSystemPrompt = `You are a focused research analyst for LinkedIn comments.

Rules:
- Today's date is ${dateContext.humanDate} (${dateContext.isoDate}). Current year is ${dateContext.year}.
- Be strictly date-aware. If the post/research does not explicitly mention a year, do not invent one.
- Never introduce outdated years unless they are explicitly present in the post or verified source.
- Full post content is already provided below from a direct LinkedIn read-only fetch. Use that as the primary source of truth for what the author said.
- If IMAGE CONTEXT is provided, treat it as additional source-of-truth for what the author is communicating.
- Never invent visual details beyond IMAGE CONTEXT.
- You may use WebFetch on the post URL only if you must verify missing context.
- Then use at most ${config.maxSearchQueries} WebSearch calls to find one recent concrete fact.
- Gather one practical implication grounded in real data.
- Derive the two-cents basis in this priority order: contradiction > missing_piece > lived_experience > logical_gap.
- Provide one actionable add-on (mini tutorial step, practical suggestion, or researched discovery) so the comment adds value, not just criticism.
- If your fact references a named system/algorithm/policy (for example SpamBrain), capture that exact name. Avoid vague labels like "spam detection" when a concrete name exists.
- Use ONLY evidence from provided full post text + this run's WebSearch/WebFetch. Do not rely on model memory.
- Use grounded sources only. No made-up stats.
- Do not write the final comment.
- Return ONLY strict JSON.`;

  const researchPrompt = `LinkedIn post by ${post.author} (preview, may be truncated):
"${post.text_preview}"
Post URL: ${post.post_url}

FULL POST TEXT (authoritative; use this for key point extraction):
"""
${fullTextForPrompt}
"""

IMAGE CONTEXT (from direct post media analysis; may be empty):
"""
${clipForPrompt(imageContext || '', 1200) || '[none]'}
"""

STEP 1: Extract the true key point from FULL POST TEXT above.
STEP 1b: If IMAGE CONTEXT is non-empty, fold one concrete image detail into your understanding of the post.
STEP 2: Research the exact topic with WebSearch (and WebFetch if needed).
STEP 3: Return STRICT JSON:
{
  "post_summary": "one-line summary of what the author is saying",
  "full_post_word_count": "integer word count from FULL POST TEXT above",
  "key_point": "most specific point from the post to reference",
  "statistic": "one loose fact or trend you found (paraphrase casually; optional light source mention, no exact numbers)",
  "named_mechanism": "if relevant, exact algorithm/system/policy name from research (example: SpamBrain), else empty string",
  "stance_basis": "contradiction|missing_piece|lived_experience|logical_gap",
  "actionable_add_on": "one concrete next step or mini-tutorial tip that helps the reader act",
  "source_1": "publication/org name for your reference only",
  "source_url_1": "url if found, else empty string",
  "source_2": "secondary source name (optional)",
  "source_url_2": "secondary source url (optional)",
  "implication": "why this matters in practice, in plain language",
  "post_intent": "educational|promotional|mixed",
  "confidence": "high|medium|low"
}

Date discipline:
- If any year appears in your JSON fields, it must come from FULL POST TEXT or verified sources from this run.
- If uncertain, omit year references.`;

  const researchOptions: SDKOptions = {
    model,
    maxTurns: config.researchMaxTurns,
    abortController,
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['WebSearch', 'WebFetch'],
    systemPrompt: researchSystemPrompt,
    settingSources: ['project'],
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
  fullPostText: string,
  imageContext: string,
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
  const fullTextForPrompt = clipForPrompt(fullPostText || post.text_preview || '', 10000);
  const dateContext = getPromptDateContext();
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
- Today's date is ${dateContext.humanDate} (${dateContext.isoDate}); current year is ${dateContext.year}.
- Be date/year aware: never add a year unless it exists in the post or the research notes provided below.
- If a year is needed and source context is missing, omit the year instead of guessing.
- Weave in ONE insight from the research naturally. Optional: one light source mention ("recently saw in [source]..."). No URLs or exact statistics.
- If image context is available, incorporate one concrete visual/text detail naturally when relevant.
- Use your own wording. Do not mirror long phrases from the author's original post.
- Do not say "the author claims/says". Talk directly to the person ("you") or by name.
- Avoid formula phrasing like "the pattern this year is pretty clear" or any canned year statement.
- Do not use filler emphasis words: "importantly", "more importantly", "most importantly".
- Numbers are optional. If you use one, keep it rough and single (no stacked percentages).
- Do NOT end with a question. End with a statement, a take, or an incomplete thought. Questions at the end feel like interview prompts, not real comments.
- Include one clear "two-cents moment": a direct stance, pushback, or "this part is bs" claim tied to what the author said. No fence-sitting.
- The two-cents moment must come from the selected research basis (${evidence.stanceBasis}) and stay close to the author's topic.
- After pushback, add actionable continuation. Leave a practical next step, mini tutorial step, or specific discovery so readers learn something.
- Do not label sections with canned phrases. Never write "my two cents" or "practical move".

VOICE (critical - this is what makes it sound human):
- Vary paragraph length: mix short punchy lines with longer thoughts. Never uniform blocks.
- Lowercase generic acronyms casually: "seo", "ctr", "aio", "llm" (not SEO, CTR). Brand capitalization does not need to be perfect every time, but never use ALL CAPS brand names.
- Use normal sentence casing. Occasional lowercase starts are acceptable only when they feel natural, not forced.
- Use one casual connector per comment max: "honestly", "the thing is", "tbh".
- Leave 1-2 rough edges on purpose: lowercase starts, sentence fragment, or abrupt connector. Keep it readable, not polished.
- If you use numbers, round casually: "around 60%" not "61%", "3-4x" not "3.7x".
- Let some thoughts run naturally into each other. Don't perfectly structure every paragraph.
- Rhythm guidance is soft, not rigid: prefer mixed sentence lengths and occasional punctuation texture ("...", ";", inline "?"), but do not force weird punctuation if it hurts flow.
- If research surfaced a concrete system/algorithm name, prefer that specific name once instead of vague wording (example: use "SpamBrain", not "google spam detection").
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
- NEVER invent statistics or data. Numbers are optional; if unsure, skip numbers and keep it practical.
- NEVER lecture the audience. Don't say "anyone considering X should..." or "people need to understand...". You're talking to the author, not giving a TED talk.
- Promotional posts: you can push back, but be specific to what the author actually said. Don't default to generic contrarian takes. Challenge the specific claim, not the category. And acknowledge what's actually good before you push back.
- Keep the tone of someone who respects the author but disagrees on specifics. Not hostile, not preachy. Think bar conversation, not debate podium.
- Max 3-4 short paragraphs for a pushback comment. If you need more than that, you're over-explaining.${styleGuide ? `\n\nADDITIONAL STYLE GUIDE:\n${styleGuide}` : ''}

OUTPUT FORMAT:
Return ONLY the final comment text.`;

  const writePrompt = `LinkedIn post by ${post.author}:
FULL POST TEXT:
"""
${fullTextForPrompt}
"""

IMAGE CONTEXT (may be empty):
"""
${clipForPrompt(imageContext || '', 1200) || '[none]'}
"""

Preview snippet:
"${post.text_preview}"
Post URL: ${post.post_url}

Research notes:
${researchBrief}

Narrative guidance:
- ${challengeInstruction}
- Comment intent: ${commentIntent} (${intentInstructionMap[commentIntent]})
- Two-cents basis from research: ${evidence.stanceBasis}
- Actionable continuation to include after your stance: ${evidence.actionableAddOn || 'provide one concrete next step tied to the claim'}
- Start the first sentence with "${authorFirstName}," and reference the key point from the original post.

Write the final comment now.`;

  const writeOptions: SDKOptions = {
    model,
    maxTurns: config.writeMaxTurns,
    abortController,
    systemPrompt: writingSystemPrompt,
    settingSources: ['project'],
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
- do not copy long phrases from the post; rephrase in your own words
- do not use meta phrasing like "the author claims"
- avoid canned year phrases and never guess a year
- avoid emphasis filler words like "importantly" or "more importantly"
- include one direct two-cents stance tied to the specific claim in the post
- include actionable follow-through right after the stance (specific next step or mini tutorial)
- keep length around ${lengthPlan.targetWords} words (${lengthPlan.minWords}-${lengthPlan.maxWords})
- format as short paragraphs with line breaks, not one dense block
- avoid stacked numbers/percentages (0-1 rough number max)
- avoid hype/jargon and generic agreement
- keep text natural and direct; avoid forced quirks or random capitalization
- never use canned labels like "my two cents" or "practical move"`;
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
- Use different phrasing from the original post (no close paraphrase)
- Do not use wording like "the author claims/says"
- Avoid canned year phrasing and do not invent any year reference
- Do not use filler emphasis words like "importantly", "more importantly", or "most importantly"
- Include one clear two-cents stance, direct and specific
- Include actionable follow-through after the stance, concrete and useful
- Keep natural human tone and short paragraph formatting with line breaks
- Source mention is optional and light; avoid URLs and stacked percentages
- Keep the tone natural and readable; no random capitalization or ALL CAPS brand words
- Never use the literal phrases "my two cents" or "practical move"
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
          // If fallback degraded too much, keep the salvage draft even with issues.
          if (salvageQuality.hardIssues.length < fallbackQuality.hardIssues.length) {
            return draft;
          }
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

function buildFallbackEvidenceFromPost(post: DraftPost, fullPostText: string, imageContext = ''): ResearchEvidence {
  const fullText = normalizeLinkedInPostText(fullPostText || post.text_preview || '');
  const imageSignal = normalizeLinkedInPostText(imageContext || '');
  const combined = [fullText, imageSignal].filter(Boolean).join('\n\n');
  const firstSentence = (fullText.match(/[^.!?]+[.!?]?/) || [''])[0].trim();
  const fallbackIntent = detectPostIntent(combined || fullText);
  const keyPoint = firstSentence || fullText.slice(0, 160);
  const postSummary = firstSentence || fullText.slice(0, 180);
  return {
    postSummary: imageSignal ? `${postSummary} ${clipForPrompt(imageSignal, 140)}` : postSummary,
    keyPoint,
    statistic: 'Recent operator reports suggest distribution shifts quickly when publishing cadence outruns quality controls.',
    sources: [],
    namedMechanism: '',
    implication: imageSignal
      ? 'Execution quality and visual message alignment matter more than raw posting volume.'
      : 'Execution quality and pacing matter more than volume.',
    followUpQuestion: '',
    stanceBasis: 'logical_gap',
    actionableAddOn: 'Add one concrete test and one measurable checkpoint before scaling the tactic.',
    fullPostWordCount: countWords(fullText),
    postIntent: fallbackIntent,
    confidence: 'low',
  };
}

async function generateDraftViaOpenAIModel(
  post: DraftPost,
  fullPostText: string,
  imageContext: string,
  styleGuide: string,
  model: string,
  parentAbortController: AbortController,
  remainingMs: number,
  diversity?: DraftDiversityContext,
  evidenceOverride?: ResearchEvidence | null,
  commentIntentOverride?: CommentIntent | null,
): Promise<DraftGenerationResult> {
  const attempt = createAttemptAbortController(parentAbortController, remainingMs);
  const fullTextForPrompt = clipForPrompt(fullPostText || post.text_preview || '', 10000);
  const imageContextForPrompt = clipForPrompt(imageContext || '', 1200);
  const dateContext = getPromptDateContext();
  const evidence = evidenceOverride || buildFallbackEvidenceFromPost(post, fullTextForPrompt, imageContextForPrompt);
  const commentIntent = commentIntentOverride || chooseCommentIntent(post.id);
  const authorFirstName = getAuthorFirstName(post.author);
  const lengthPlan = getLengthPlan(post.text_preview, evidence, commentIntent);
  const avoidOpenings = diversity ? Array.from(diversity.usedOpeningSignatures).filter(Boolean).slice(-5) : [];
  const avoidLeadIns = diversity ? Array.from(diversity.usedLeadInSignatures).filter(Boolean).slice(-6) : [];
  const researchBrief = evidenceOverride ? evidenceToBrief(evidence) : '';

  const systemPrompt = `You write a LinkedIn reply comment.

Rules:
- Start sentence 1 with "${authorFirstName},"
- Keep length around ${lengthPlan.targetWords} words (${lengthPlan.minWords}-${lengthPlan.maxWords})
- Today's date is ${dateContext.humanDate} (${dateContext.isoDate}); current year is ${dateContext.year}.
- Do not invent year references. If year is not present in the post text, avoid adding one.
- Keep the comment specific to the post and add one practical two-cents stance.
- Add one actionable follow-through after your stance.
- Use short readable paragraph chunks (2-4), no hashtags, no emojis, no links.
- Do not end with a question.
- No generic praise, no AI jargon, no em dash.
- Return ONLY the final comment text.${researchBrief ? `\n\nResearch brief (must be grounded in your response):\n${researchBrief}` : ''}${styleGuide ? `\n\nStyle guide:\n${styleGuide}` : ''}`;

  const userPrompt = `Author: ${post.author}
Full post text:
"""
${fullTextForPrompt}
"""

Image context (may be empty):
"""
${imageContextForPrompt || '[none]'}
"""

Preview snippet:
${post.text_preview}

Draft a direct reply comment now.
Avoid repeating these opening signatures: ${avoidOpenings.join(' | ') || 'none'}
Avoid repeating these lead-ins: ${avoidLeadIns.join(' | ') || 'none'}${researchBrief ? `\n\nResearch brief:\n${researchBrief}` : ''}`;

  const abortPromise = new Promise<never>((_, reject) => {
    attempt.controller.signal.addEventListener('abort', () => {
      if (attempt.timedOut()) reject(new Error(`Timed out while drafting with ${model}`));
      else reject(new Error('Draft job cancelled'));
    }, { once: true });
  });

  try {
    const response = await Promise.race([
      glmChat({
        model,
        disableThinking: true,
        temperature: 0.35,
        maxTokens: 1200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      abortPromise,
    ]);

    if (!response.success || !response.content?.trim()) {
      throw new Error(response.error || `No draft output for ${model}`);
    }

    let draft = ensureReadableCommentLayout(cleanDraftText(response.content));
    const quality = evaluateDraftQuality(draft, evidence, post.text_preview, authorFirstName, lengthPlan, diversity);
    if (quality.hardIssues.length > 0) {
      if (hasCriticalQualityIssue(quality.hardIssues)) {
        draft = buildDeterministicFallbackDraft(post, evidence, authorFirstName, commentIntent);
      } else {
        console.warn(`[LinkedInDrafter] OpenAI fallback draft quality warnings: ${quality.hardIssues.join('; ')}`);
      }
    }
    return { draft, evidence, commentIntent, model };
  } finally {
    attempt.cleanup();
  }
}

async function generateDraftForModel(
  queryFn: (params: { prompt: string; options?: SDKOptions }) => SDKQuery,
  post: DraftPost,
  fullPostText: string,
  imageContext: string,
  styleGuide: string,
  model: string,
  config: LinkedInDraftConfig,
  parentAbortController: AbortController,
  remainingMs: number,
  diversity?: DraftDiversityContext,
): Promise<DraftGenerationResult> {
  const provider = getProviderForModel(model);
  if (provider === 'openai' || provider === 'gemini') {
    let evidence: ResearchEvidence | null = null;
    const commentIntent = chooseCommentIntent(post.id);
    const researchModel = pickResearchModel(model, config);
    if (researchModel) {
      const researchBudgetMs = Math.max(5000, Math.floor(remainingMs * 0.6));
      const researchAttempt = createAttemptAbortController(parentAbortController, researchBudgetMs);
      try {
        const env = await buildProviderEnv(researchModel);
        evidence = await runResearchPass(
          queryFn,
          post,
          fullPostText,
          imageContext,
          researchModel,
          config,
          researchAttempt.controller,
          env,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[LinkedInDrafter] Research pass skipped for ${post.author} (${researchModel}): ${msg}`);
      } finally {
        researchAttempt.cleanup();
      }
    }
    return generateDraftViaOpenAIModel(
      post,
      fullPostText,
      imageContext,
      styleGuide,
      model,
      parentAbortController,
      remainingMs,
      diversity,
      evidence,
      commentIntent,
    );
  }

  const env = await buildProviderEnv(model);
  const attempt = createAttemptAbortController(parentAbortController, remainingMs);
  let evidence: ResearchEvidence | null = null;
  let commentIntent: CommentIntent | null = null;
  try {
    evidence = await runResearchPass(queryFn, post, fullPostText, imageContext, model, config, attempt.controller, env);
    commentIntent = chooseCommentIntent(post.id);
    const draft = await runWritePass(queryFn, post, fullPostText, imageContext, styleGuide, evidence, commentIntent, model, config, attempt.controller, env, diversity);
    return { draft, evidence, commentIntent, model };
  } catch (err) {
    const abortReason = parentAbortController.signal.reason;
    // If research already succeeded but writing timed out, salvage with deterministic fallback.
    if (attempt.timedOut() && evidence && commentIntent) {
      const authorFirstName = getAuthorFirstName(post.author);
      const fallbackDraft = buildDeterministicFallbackDraft(post, evidence, authorFirstName, commentIntent);
      console.warn(`[LinkedInDrafter] Write pass timed out for ${post.author} on ${model}; using deterministic fallback draft`);
      return { draft: fallbackDraft, evidence, commentIntent, model };
    }
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
  comment_draft?: string | null;
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
const activeDraftPostIds = new Set<number>();
const pendingDraftPostIds = new Set<number>();
const pendingDraftOrder: number[] = [];

function markPostsQueued(postIds: number[], note?: string): void {
  if (postIds.length === 0) return;
  const db = getDb();
  if (!db) return;
  try {
    const update = db.prepare(
      `UPDATE linkedin_posts
       SET draft_state = 'queued',
           draft_error = ?,
           draft_started_at = datetime('now'),
           draft_finished_at = NULL
       WHERE id = ?`
    );
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) update.run(note || null, id);
    });
    tx(postIds);
  } catch (err) {
    console.warn('[LinkedInDrafter] Failed to mark queued posts:', err);
  } finally {
    db.close();
  }
}

function enqueuePendingDraftPostIds(postIds: number[]): number[] {
  const accepted: number[] = [];
  for (const rawId of postIds) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (activeDraftPostIds.has(id)) continue;
    if (pendingDraftPostIds.has(id)) continue;
    pendingDraftPostIds.add(id);
    pendingDraftOrder.push(id);
    accepted.push(id);
  }
  return accepted;
}

function drainPendingDraftPostIds(): number[] {
  if (pendingDraftOrder.length === 0) return [];
  const out = [...pendingDraftOrder];
  pendingDraftOrder.length = 0;
  pendingDraftPostIds.clear();
  return out;
}

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

export interface DraftRecoveryResult {
  recoveredCount: number;
  recoveredPostIds: number[];
}

export function recoverInterruptedDrafts(trigger: 'restart' | 'wake' = 'restart'): DraftRecoveryResult {
  const db = getDb();
  if (!db) return { recoveredCount: 0, recoveredPostIds: [] };

  try {
    // If a draft text already exists, treat interrupted states as completed.
    db.prepare(
      `UPDATE linkedin_posts
       SET draft_state = 'success',
           draft_error = NULL,
           draft_finished_at = COALESCE(draft_finished_at, datetime('now'))
       WHERE hidden = 0
         AND commented = 0
         AND draft_state IN ('queued', 'researching', 'writing')
         AND comment_draft IS NOT NULL
         AND trim(comment_draft) <> ''`
    ).run();

    const rows = db.prepare(
      `SELECT id, post_url, draft_state
       FROM linkedin_posts
       WHERE hidden = 0
         AND commented = 0
         AND (comment_draft IS NULL OR trim(comment_draft) = '')
         AND draft_state IN ('queued', 'researching', 'writing')
       ORDER BY id ASC`
    ).all() as Array<{ id: number; post_url: string; draft_state: string }>;

    if (rows.length === 0) return { recoveredCount: 0, recoveredPostIds: [] };

    const now = new Date().toISOString();
    const update = db.prepare(
      `UPDATE linkedin_posts
       SET draft_state = 'queued',
           draft_error = ?,
           draft_started_at = ?,
           draft_finished_at = NULL
       WHERE id = ?`
    );
    const log = db.prepare(
      `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason)
       VALUES (?, ?, 'recovered', ?)`
    );

    const reasonBase = trigger === 'wake'
      ? 'draft_recovered_after_wake'
      : 'draft_recovered_after_restart';

    const tx = db.transaction(() => {
      for (const row of rows) {
        const reason = `${reasonBase}:was_${String(row.draft_state || 'unknown')}`;
        update.run('Recovered after interruption. Auto-retry started.', now, row.id);
        log.run(row.id, row.post_url, reason);
      }
    });
    tx();

    return {
      recoveredCount: rows.length,
      recoveredPostIds: rows.map(r => Number(r.id)).filter(id => Number.isFinite(id) && id > 0),
    };
  } catch (err) {
    console.warn('[LinkedInDrafter] Failed to recover interrupted drafts:', err);
    return { recoveredCount: 0, recoveredPostIds: [] };
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
  setImageAnalysisState(post.id, 'pending', 0, 'Reading full post and attached images');

  // Clear old draft so stale content doesn't persist if this attempt fails
  const clearDb = getDb();
  if (clearDb) {
    try { clearDb.prepare('UPDATE linkedin_posts SET comment_draft = NULL WHERE id = ?').run(post.id); }
    catch { /* ok */ }
    finally { clearDb.close(); }
  }

  const config = getLinkedInDraftConfig();
  const attemptModels = getAttemptModels(model, config.fallbackModel, config.fallbackModel2, config.fallbackModel3);
  // Keep internal deadline aligned with outer batch timeout window (+20s grace).
  const effectiveTimeoutSec = computeEffectiveTimeoutSec(config.perPostTimeoutSec, model, post.text_preview) + 20;
  const deadline = Date.now() + (effectiveTimeoutSec * 1000);
  let fullPost: LinkedInPostContent;
  try {
    fullPost = await readFullLinkedInPostContent(post.post_url, abortController);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setImageAnalysisState(post.id, 'failed', 0, `Post read failed: ${clipForPrompt(msg, 120)}`);
    throw err;
  }
  setImageAnalysisState(post.id, fullPost.imageAnalysisStatus, fullPost.images.length, fullPost.imageAnalysisNote);
  const fullPostText = fullPost.text;
  const imageContext = fullPost.imageContext;
  if (!fullPostText) {
    setImageAnalysisState(post.id, fullPost.imageAnalysisStatus, fullPost.images.length, `${fullPost.imageAnalysisNote}. Full text missing`);
    throw new Error(`Full post fetch failed for ${post.author}; drafting aborted to avoid summary-only output`);
  }

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
        fullPostText,
        imageContext,
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
    const imageReason = (() => {
      const count = Number(fullPost.images?.length || 0);
      if (fullPost.imageAnalysisStatus === 'analyzed') return `draft:ok:image_analyzed:${count}`;
      if (fullPost.imageAnalysisStatus === 'none') return 'draft:ok:no_images';
      if (fullPost.imageAnalysisStatus === 'pending') return 'draft:ok:image_pending';
      if (fullPost.imageAnalysisStatus === 'skipped_no_model') return 'draft:ok:image_skipped_no_model';
      return 'draft:ok:image_failed';
    })();
    db.prepare(
      `INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, comment_text)
       VALUES (?, ?, 'drafted', ?, ?)`
    ).run(post.id, post.post_url, imageReason, draft);
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
  forceRedo: boolean = false,
): Promise<{ results: DraftResult[]; errors: string[] }> {
  if (jobRunning) {
    // If activeJob is null, this is a leaked state from a crashed previous run -reset it
    if (!activeJob) {
      jobRunning = false;
    } else {
      const queued = enqueuePendingDraftPostIds(postIds);
      if (queued.length > 0) {
        markPostsQueued(queued, forceRedo ? 'Queued for redraft behind active draft job' : 'Queued behind active draft job');
        draftEvents.emit('progress', {
          type: 'progress',
          total: queued.length,
          completed: 0,
          current: 'Queued behind active batch',
          queued: queued.length,
        });
      }
      return {
        results: [],
        errors: [],
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
    let reusedExistingCount = 0;
    const markExistingSuccess = db.prepare(
      `UPDATE linkedin_posts
       SET draft_state = 'success',
           draft_error = NULL,
           draft_finished_at = COALESCE(draft_finished_at, datetime('now'))
       WHERE id = ?`
    );
    for (const id of postIds) {
      const row = db.prepare(
        'SELECT id, post_url, author, text_preview, reactions, comments, kanban_task_id, comment_draft, post_type, voice_preset FROM linkedin_posts WHERE id = ?'
      ).get(id) as DraftPost | undefined;
      if (!row) continue;
      const existingDraft = String(row.comment_draft || '').trim();
      if (existingDraft && !forceRedo) {
        markExistingSuccess.run(row.id);
        reusedExistingCount++;
        results.push({
          postId: row.id,
          author: row.author,
          draft: existingDraft,
          kanbanTaskId: Number(row.kanban_task_id || 0),
          researched: true,
        });
        continue;
      }
      if (existingDraft && forceRedo) {
        db.prepare('UPDATE linkedin_posts SET comment_draft = NULL WHERE id = ?').run(row.id);
      }
      posts.push(row);
    }

    // Mark all posts as queued upfront
    for (const post of posts) {
      db.prepare(`UPDATE linkedin_posts SET draft_state = 'queued', draft_error = NULL, draft_started_at = datetime('now'), draft_finished_at = NULL WHERE id = ?`).run(post.id);
    }
    db.close();

    if (posts.length === 0 && results.length === 0) {
      errors.push('No posts found');
      return { results, errors };
    }
    if (posts.length === 0) {
      totalPostsForCompletion = reusedExistingCount;
      return { results, errors };
    }

    for (const post of posts) activeDraftPostIds.add(post.id);

    totalPostsForCompletion = posts.length + reusedExistingCount;
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
    for (const id of postIds) activeDraftPostIds.delete(Number(id));
    activeJob = null;
    jobRunning = false;
    draftEvents.emit('complete', {
      type: 'complete',
      total: totalPostsForCompletion || postIds.length || 0,
      drafted: results.length,
      errors: errors.length,
    });
    const queuedFollowUp = drainPendingDraftPostIds();
    if (queuedFollowUp.length > 0) {
      setTimeout(() => {
        void draftBatch(queuedFollowUp, _batchSize, forceRedo).catch((err) => {
          console.error('[LinkedInDrafter] Failed to run queued follow-up batch:', err);
        });
      });
    }
  }
}

export async function rewriteLinkedInDraftWithInstructions(options: {
  draftText: string;
  instructions: string;
  author?: string;
  postPreview?: string;
  postUrl?: string;
}): Promise<{ rewritten: string; model: string }> {
  const original = String(options.draftText || '').trim();
  const instructions = String(options.instructions || '').trim();
  if (!original) throw new Error('Original draft is empty');
  if (!instructions) throw new Error('Instructions are required');

  const author = String(options.author || '').trim();
  const preview = String(options.postPreview || '').trim();
  const postUrl = String(options.postUrl || '').trim();
  const primaryModel = getDraftModel();
  const config = getLinkedInDraftConfig();
  const attemptModels = getAttemptModels(primaryModel, config.fallbackModel, config.fallbackModel2, config.fallbackModel3);
  if (attemptModels.length === 0) {
    throw new Error('No available models for AI edit helper');
  }

  const attemptErrors: string[] = [];
  let queryFn: ((params: { prompt: string; options?: SDKOptions }) => SDKQuery) | null = null;
  for (const model of attemptModels) {
    const provider = getProviderForModel(model);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort('timeout'), 70_000);
    const dateContext = getPromptDateContext();
    try {
      const systemPrompt = `You are editing a LinkedIn comment draft.

Rules:
- Apply only the requested changes.
- Keep the original narrative, structure, and intent intact.
- Today's date is ${dateContext.humanDate} (${dateContext.isoDate}); current year is ${dateContext.year}.
- Do not invent year references. If year is not in provided text/instructions, avoid adding one.
- Preserve any strong phrasing that is already good.
- Do not add hashtags, emojis, URLs, or markdown.
- Keep line breaks readable.
- Return ONLY the revised draft text.`;

      const userPrompt = `Author: ${author || 'unknown'}
Post preview: ${preview || 'n/a'}
Post URL: ${postUrl || 'n/a'}

Original draft:
${original}

Requested additions/changes:
${instructions}

Rewrite now while preserving everything else as much as possible.`;

      let rewritten = '';
      if (provider === 'openai') {
        const response = await glmChat({
          model,
          disableThinking: true,
          temperature: 0.2,
          maxTokens: Math.max(700, Math.min(1800, Math.round(original.length * 1.8))),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        });
        if (!response.success || !response.content?.trim()) {
          throw new Error(response.error || `Empty rewrite output from ${model}`);
        }
        rewritten = response.content;
      } else {
        if (!queryFn) queryFn = await loadSDK();
        if (!queryFn) throw new Error('Failed to load SDK');
        const env = await buildProviderEnv(model);
        rewritten = await generateDraftFromSdk(queryFn, userPrompt, {
          model,
          maxTurns: 3,
          abortController,
          systemPrompt,
          settingSources: ['project'],
          cwd: getSdkCwd(),
          env,
        });
      }

      const cleaned = ensureReadableCommentLayout(cleanDraftText(rewritten));
      if (!cleaned) {
        throw new Error(`Rewriter returned empty output (${model})`);
      }
      return { rewritten: cleaned, model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attemptErrors.push(`${model}: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`AI edit helper failed (${attemptErrors.join(' | ')})`);
}

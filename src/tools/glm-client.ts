/**
 * Standalone GLM (Zhipu AI) API client.
 *
 * OpenAI-compatible HTTP client using raw fetch — does NOT use the Claude Agent SDK.
 * Used as a worker model for cheap bulk tasks (summarization, classification, extraction).
 *
 * Bulk classification supports provider override: set zhipu.bulkBaseUrl + zhipu.bulkApiKey
 * to route bulk calls to OpenAI (gpt-4.1-nano), Qwen (qwen-turbo), or any OpenAI-compatible API.
 */

import { SettingsManager } from '../settings';
import { logEvent } from '../memory/event-log';

// ============================================================================
// Types
// ============================================================================

export interface GlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GlmRequestParams {
  messages: GlmMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Disable reasoning/thinking mode (Zhipu-only, skipped for other providers) */
  disableThinking?: boolean;
}

export interface GlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface GlmResponse {
  success: boolean;
  content?: string;
  usage?: GlmUsage;
  error?: string;
}

// ============================================================================
// Default config
// ============================================================================

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.7';
const DEFAULT_FLASH_MODEL = 'glm-4.7-flash';
const DEFAULT_BULK_MODEL = 'glm-4.7-flashx';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT = 60000;

// ============================================================================
// Provider resolution — auto-detect from model name
// ============================================================================

function resolveModelProvider(model: string): { baseUrl: string; apiKey: string } {
  if (model.startsWith('gpt-')) {
    return {
      baseUrl: OPENAI_BASE_URL,
      apiKey: SettingsManager.get('openai.apiKey') || '',
    };
  }
  // Default: Zhipu
  return {
    baseUrl: SettingsManager.get('zhipu.baseUrl') || DEFAULT_BASE_URL,
    apiKey: SettingsManager.get('zhipu.apiKey') || '',
  };
}

// ============================================================================
// Core API call
// ============================================================================

interface CallApiOverrides {
  forceModel?: string;
  forceBaseUrl?: string;
  forceApiKey?: string;
}

async function callGlmApi(params: GlmRequestParams & CallApiOverrides): Promise<GlmResponse> {
  const apiKey = params.forceApiKey || SettingsManager.get('zhipu.apiKey');
  if (!apiKey) {
    return { success: false, error: 'API key not configured. Add it in Settings > Keys.' };
  }

  const baseUrl = params.forceBaseUrl || SettingsManager.get('zhipu.baseUrl') || DEFAULT_BASE_URL;
  const model = params.forceModel || params.model || SettingsManager.get('zhipu.model') || DEFAULT_MODEL;
  const temperature = params.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
  const isZhipu = baseUrl.includes('bigmodel.cn');

  const url = `${baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  // Thinking parameter is Zhipu-only — other providers reject unknown fields
  if (params.disableThinking && isZhipu) {
    body.thinking = { type: 'disabled' };
  }

  const startTime = Date.now();
  const provider = isZhipu ? 'zhipu' : 'external';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const error = `API error ${response.status}: ${errText}`;
      console.error(`[GLM:${provider}]`, error);
      return { success: false, error };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: GlmUsage;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage;
    const durationMs = Date.now() - startTime;

    // Debug: log when content is empty despite 200 OK
    if (!content) {
      console.warn(`[GLM:${provider}] Empty content from ${model}. Response keys: ${JSON.stringify(Object.keys(data))}. Choices: ${JSON.stringify(data.choices?.length ?? 'none')}. Usage: ${JSON.stringify(usage)}. Full first choice: ${JSON.stringify(data.choices?.[0])}`);
    }

    // Log tokens to event log
    if (usage) {
      logEvent({
        event_type: 'llm_call',
        source: provider === 'zhipu' ? 'glm' : provider,
        actor: 'glm',
        data: { model, temperature, provider },
        tokens_prompt: usage.prompt_tokens,
        tokens_completion: usage.completion_tokens,
        tokens_total: usage.total_tokens,
        duration_ms: durationMs,
      });
    }

    return { success: true, content, usage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GLM:${provider}] API call failed:`, msg);
    return { success: false, error: msg };
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Call GLM with the primary worker model (glm-4.7 by default).
 * Use for quality tasks: summaries, structured extraction.
 */
export async function glmChat(params: GlmRequestParams): Promise<GlmResponse> {
  const model = params.model || SettingsManager.get('zhipu.model') || DEFAULT_MODEL;
  const provider = resolveModelProvider(model);
  return callGlmApi({ ...params, forceModel: model, forceBaseUrl: provider.baseUrl, forceApiKey: provider.apiKey });
}

/**
 * Call GLM with the flash model (glm-4.7-flash by default).
 * Use for fast/cheap tasks: classification, yes/no, bulk processing.
 */
export async function glmFlash(params: GlmRequestParams): Promise<GlmResponse> {
  const flashModel = SettingsManager.get('zhipu.flashModel') || DEFAULT_FLASH_MODEL;
  const provider = resolveModelProvider(flashModel);
  return callGlmApi({ ...params, forceModel: flashModel, forceBaseUrl: provider.baseUrl, forceApiKey: provider.apiKey });
}

/**
 * Call with the bulk model for high-throughput batch classification.
 * Supports provider override: set zhipu.bulkBaseUrl + zhipu.bulkApiKey to route
 * to OpenAI (gpt-4.1-nano), Qwen (qwen-turbo), or any OpenAI-compatible API.
 */
export async function glmBulk(params: GlmRequestParams): Promise<GlmResponse> {
  const bulkModel = SettingsManager.get('zhipu.bulkModel') || DEFAULT_BULK_MODEL;
  const provider = resolveModelProvider(bulkModel);
  return callGlmApi({ ...params, forceModel: bulkModel, forceBaseUrl: provider.baseUrl, forceApiKey: provider.apiKey });
}

/**
 * Check if any worker model is configured (Zhipu or OpenAI key set).
 */
export function isGlmConfigured(): boolean {
  return !!SettingsManager.get('zhipu.apiKey') || !!SettingsManager.get('openai.apiKey');
}

/**
 * Quick health check — pings flash and bulk models (skips duplicate if same provider+model).
 */
export async function glmHealthCheck(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const flashModel = SettingsManager.get('zhipu.flashModel') || DEFAULT_FLASH_MODEL;
  const bulkModel = SettingsManager.get('zhipu.bulkModel') || DEFAULT_BULK_MODEL;
  const flashProvider = resolveModelProvider(flashModel);
  const bulkProvider = resolveModelProvider(bulkModel);

  const pingParams: GlmRequestParams = {
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 5,
  };

  const okModels: string[] = [];
  const errors: string[] = [];

  const flashResult = await glmFlash(pingParams);
  if (flashResult.success) okModels.push(flashModel);
  else errors.push(`${flashModel}: ${flashResult.error}`);

  // Ping bulk separately if it uses a different provider or model
  const bulkIsDifferent = bulkModel !== flashModel || bulkProvider.baseUrl !== flashProvider.baseUrl;
  if (bulkIsDifferent) {
    const bulkResult = await glmBulk(pingParams);
    if (bulkResult.success) okModels.push(bulkModel);
    else errors.push(`${bulkModel}: ${bulkResult.error}`);
  }

  if (okModels.length > 0) {
    return { ok: true, models: okModels };
  }
  return { ok: false, error: errors.join('; ') };
}

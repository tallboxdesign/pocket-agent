/**
 * Standalone GLM (Zhipu AI) API client.
 *
 * OpenAI-compatible HTTP client using raw fetch — does NOT use the Claude Agent SDK.
 * Used as a worker model for cheap bulk tasks (summarization, classification, extraction).
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
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT = 60000;

// ============================================================================
// Core API call
// ============================================================================

async function callGlmApi(params: GlmRequestParams & { forceModel?: string }): Promise<GlmResponse> {
  const apiKey = SettingsManager.get('zhipu.apiKey');
  if (!apiKey) {
    return { success: false, error: 'Zhipu API key not configured. Add it in Settings > Keys.' };
  }

  const baseUrl = SettingsManager.get('zhipu.baseUrl') || DEFAULT_BASE_URL;
  const model = params.forceModel || params.model || SettingsManager.get('zhipu.model') || DEFAULT_MODEL;
  const temperature = params.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: params.messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  const startTime = Date.now();

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
      const error = `GLM API error ${response.status}: ${errText}`;
      console.error('[GLM]', error);
      return { success: false, error };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: GlmUsage;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage;
    const durationMs = Date.now() - startTime;

    // Log tokens to event log
    if (usage) {
      logEvent({
        event_type: 'llm_call',
        source: 'glm',
        actor: 'glm',
        data: { model, temperature },
        tokens_prompt: usage.prompt_tokens,
        tokens_completion: usage.completion_tokens,
        tokens_total: usage.total_tokens,
        duration_ms: durationMs,
      });
    }

    return { success: true, content, usage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[GLM] API call failed:', msg);
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
  return callGlmApi(params);
}

/**
 * Call GLM with the flash model (glm-4.7-flash by default).
 * Use for fast/cheap tasks: classification, yes/no, bulk processing.
 */
export async function glmFlash(params: GlmRequestParams): Promise<GlmResponse> {
  const flashModel = SettingsManager.get('zhipu.flashModel') || DEFAULT_FLASH_MODEL;
  return callGlmApi({ ...params, forceModel: flashModel });
}

/**
 * Check if GLM is configured (API key set).
 */
export function isGlmConfigured(): boolean {
  return !!SettingsManager.get('zhipu.apiKey');
}

/**
 * Quick health check — sends a tiny request to verify connectivity.
 */
export async function glmHealthCheck(): Promise<{ ok: boolean; model?: string; error?: string }> {
  const result = await glmFlash({
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 5,
  });

  if (result.success) {
    const flashModel = SettingsManager.get('zhipu.flashModel') || DEFAULT_FLASH_MODEL;
    return { ok: true, model: flashModel };
  }
  return { ok: false, error: result.error };
}

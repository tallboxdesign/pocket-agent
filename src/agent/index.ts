import { MemoryManager, Message, DailyLog } from '../memory';
import { buildMCPServers, buildSdkMcpServers, setMemoryManager, setSoulMemoryManager, ToolsConfig, validateToolsConfig, getCurrentSessionId } from '../tools';
import { closeBrowserManager } from '../browser';
import { loadIdentity } from '../config/identity';
import { loadInstructions } from '../config/instructions';
import { SettingsManager } from '../settings';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildCanUseToolCallback,
  buildPreToolUseHook,
  setStatusEmitter,
  approvePendingExternalApproval,
  clearPendingExternalApproval,
  getPendingExternalApproval,
} from './safety';
import { PersistentSDKSession, TurnResult } from './persistent-session';

// Provider configuration for different LLM backends
type ProviderType = 'anthropic' | 'moonshot' | 'glm' | 'minimax' | 'qwen' | 'openrouter' | 'gemini';

interface ProviderConfig {
  baseUrl?: string;
}

const PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  'anthropic': {
    // No baseUrl = uses default Anthropic endpoint
  },
  'moonshot': {
    baseUrl: 'https://api.moonshot.ai/anthropic',
  },
  'glm': {
    baseUrl: 'https://api.z.ai/api/anthropic',
  },
  'minimax': {
    baseUrl: 'https://api.minimax.io/anthropic',
  },
  'qwen': {
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
  },
  'openrouter': {
    baseUrl: 'https://openrouter.ai/api',
  },
  'gemini': {
    // Main chat agent currently depends on Anthropic-compatible Messages API.
    // Gemini direct is OpenAI-compatible and is handled in non-SDK flows.
  },
};

// Model to provider mapping
const MODEL_PROVIDERS: Record<string, ProviderType> = {
  // Anthropic models
  'claude-opus-4-6': 'anthropic',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  // Moonshot/Kimi models
  'kimi-k2.5': 'moonshot',
  // Z.AI GLM models
  'glm-5': 'glm',
  // MiniMax models
  'MiniMax-M2.5': 'minimax',
  'MiniMax-M2.5-Lightning': 'minimax',
  // Gemini direct models (visible in picker, guarded in main SDK flow)
  'gemini-2.5-pro': 'gemini',
  'gemini-2.5-flash': 'gemini',
  'gemini-2.5-flash-lite': 'gemini',
  // Qwen direct (DashScope Anthropic-compatible endpoint)
  'qwen3.5-plus-2026-02-15': 'qwen',
  // OpenRouter models
  'qwen/qwen3.5-plus-02-15': 'openrouter',
  'qwen/qwen3.5-flash': 'openrouter',
};

/**
 * Get the provider type for a model
 */
function getProviderForModel(model: string): ProviderType {
  const mapped = MODEL_PROVIDERS[model];
  if (mapped) return mapped;
  const normalized = String(model || '').trim().toLowerCase();
  if (normalized.startsWith('gemini-')) return 'gemini';
  if (normalized.includes('/')) return 'openrouter';
  if (normalized.startsWith('qwen')) return 'qwen';
  return 'anthropic';
}

/**
 * Configure environment variables for the selected provider
 * This is called before each SDK query to ensure correct routing
 */
async function configureProviderEnvironment(model: string): Promise<void> {
  const provider = getProviderForModel(model);
  const config = PROVIDER_CONFIGS[provider];

  // Clear all provider-related env vars first
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (provider === 'moonshot') {
    // Moonshot requires base URL and uses Bearer token auth
    const moonshotKey = SettingsManager.get('moonshot.apiKey');
    if (!moonshotKey) {
      throw new Error('Moonshot API key not configured. Please add your key in Settings > Keys.');
    }

    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = moonshotKey;
    // Set ANTHROPIC_API_KEY so the SDK subprocess passes its auth check.
    // The request sends both x-api-key and Authorization: Bearer headers;
    // OpenAI-compatible providers use Bearer and ignore x-api-key.
    process.env.ANTHROPIC_API_KEY = moonshotKey;

    console.log('[AgentManager] Provider configured: Moonshot (Kimi)');
  } else if (provider === 'glm') {
    // Z.AI GLM requires base URL and uses Bearer token auth
    const glmKey = SettingsManager.get('glm.apiKey');
    if (!glmKey) {
      throw new Error('Z.AI GLM API key not configured. Please add your key in Settings > LLM.');
    }

    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = glmKey;
    // Set ANTHROPIC_API_KEY so the SDK subprocess passes its auth check.
    // The request sends both x-api-key and Authorization: Bearer headers;
    // OpenAI-compatible providers use Bearer and ignore x-api-key.
    process.env.ANTHROPIC_API_KEY = glmKey;

    console.log('[AgentManager] Provider configured: Z.AI GLM');
  } else if (provider === 'minimax') {
    const minimaxKey = SettingsManager.get('minimax.apiKey');
    if (!minimaxKey) {
      throw new Error('MiniMax API key not configured. Please add your key in Settings > LLM.');
    }

    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = minimaxKey;
    delete process.env.ANTHROPIC_API_KEY;

    console.log('[AgentManager] Provider configured: MiniMax');
  } else if (provider === 'qwen') {
    const qwenKey = SettingsManager.get('qwen.apiKey');
    if (!qwenKey) {
      throw new Error('Qwen API key not configured. Please add your key in Settings > LLM.');
    }

    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = qwenKey;
    delete process.env.ANTHROPIC_API_KEY;

    console.log('[AgentManager] Provider configured: Qwen (DashScope)');
  } else if (provider === 'openrouter') {
    const openRouterKey = SettingsManager.get('openrouter.apiKey');
    if (!openRouterKey) {
      throw new Error('OpenRouter API key not configured. Please add your key in Settings > LLM.');
    }

    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = openRouterKey;
    delete process.env.ANTHROPIC_API_KEY;
    // OpenRouter recommended headers
    process.env.HTTP_REFERER = 'https://github.com/google-gemini/pocket-agent';
    process.env.X_TITLE = 'Pocket Agent';

    console.log('[AgentManager] Provider configured: OpenRouter');
  } else if (provider === 'gemini') {
    throw new Error('Gemini direct is available for LinkedIn drafting. Main chat currently requires Anthropic-compatible providers.');
  } else {
    // Anthropic provider - restore correct API key and clear non-Anthropic vars
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    // Restore Anthropic API key (may have been overwritten by non-Anthropic provider key)
    const anthropicKey = SettingsManager.get('anthropic.apiKey');
    if (anthropicKey) {
      process.env.ANTHROPIC_API_KEY = anthropicKey;
    } else {
      // No API key -check for OAuth token
      const authMethod = SettingsManager.get('auth.method');
      if (authMethod === 'oauth') {
        // Refresh token if needed before using it
        const { ClaudeOAuth } = await import('../auth/oauth');
        const freshToken = await ClaudeOAuth.getAccessToken();
        if (freshToken) {
          // OAuth tokens require Bearer auth, not x-api-key.
          // CLAUDE_CODE_OAUTH_TOKEN tells the SDK to use OAuth mode:
          // apiKey=null (no x-api-key header), authToken=token (Authorization: Bearer).
          // ANTHROPIC_API_KEY must NOT be set -it would be sent as x-api-key and rejected.
          process.env.CLAUDE_CODE_OAUTH_TOKEN = freshToken;
          delete process.env.ANTHROPIC_API_KEY;
          delete process.env.ANTHROPIC_AUTH_TOKEN;
          console.log('[AgentManager] Using OAuth token for Anthropic auth');
        } else {
          throw new Error('OAuth session expired. Please re-authenticate in Settings.');
        }
      } else {
        throw new Error('No API key configured. Please add your key in Settings.');
      }
    }

    console.log('[AgentManager] Provider configured: Anthropic');
  }
}

/**
 * Map SDK/API error strings to human-readable messages.
 * No "Error:" prefix -display layers add their own (red bubble in UI, warning in Telegram).
 * Covers Anthropic, Moonshot (Kimi), GLM (Z.AI), and common SDK errors.
 *
 * Errors that indicate potential app bugs (server, session, timeout, unknown)
 * get a developer-report hint appended. User-side errors (auth, billing, rate limit,
 * network, model config) do not.
 */
const REPORT_HINT = '\n\nIf this keeps happening, send this error to the developer.';

function reportable(msg: string): string {
  return msg + REPORT_HINT;
}

function formatAgentError(error: string): string {
  const e = error.toLowerCase();

  // Authentication errors (all providers)
  if (e.includes('authentication_failed') || e.includes('invalid x-api-key') || e.includes('invalid api key')
    || e.includes('unauthorized') || e.includes('invalid token') || e.includes('token expired')
    || e.includes('auth') && e.includes('fail')) {
    return 'Invalid API key. Please check your key in Settings. [authentication_failed]';
  }

  // Billing / quota errors (all providers)
  if (e.includes('billing_error') || e.includes('insufficient') || e.includes('credit')
    || e.includes('payment') || e.includes('quota') || e.includes('exceeded')
    || e.includes('balance')) {
    return 'Billing issue -your account may have run out of credits. Check your provider dashboard. [billing_error]';
  }

  // Rate limiting (all providers -Anthropic 429, Moonshot/GLM rate limits)
  if (e.includes('rate_limit') || e.includes('too many requests') || e.includes('overloaded')
    || e.includes('throttl') || e.includes('concurrency') || e.includes('capacity')) {
    return 'Rate limited -too many requests. Wait a moment and try again. [rate_limit]';
  }

  // Model / request errors
  if (e.includes('invalid_request') && !e.includes('key')) {
    return `Invalid request -${error} [invalid_request]`;
  }
  if (e.includes('max_output_tokens') || e.includes('max tokens') || e.includes('output limit')) {
    return 'Response exceeded maximum token limit. Try a simpler request. [max_output_tokens]';
  }
  if (e.includes('context') && (e.includes('too long') || e.includes('exceed') || e.includes('limit'))) {
    return 'Message too long for model context window. Try a shorter message or start a new session. [context_overflow]';
  }
  if (e.includes('model') && (e.includes('not found') || e.includes('not available') || e.includes('does not exist') || e.includes('not support'))) {
    return `Model not available -${error}. Check Settings > Model. [model_not_found]`;
  }

  // Server errors (all providers)
  if (e.includes('server_error') || e.includes('internal server') || e.includes('bad gateway')
    || e.includes('service unavailable') || e.includes('temporarily')) {
    return reportable('API server error. The provider may be experiencing issues -try again shortly. [server_error]');
  }

  // Network errors -user-side, no report needed
  if (e.includes('econnrefused') || e.includes('enotfound') || e.includes('etimedout')
    || e.includes('econnreset') || e.includes('epipe') || e.includes('fetch failed')
    || e.includes('network') || e.includes('dns') || e.includes('socket hang up')) {
    return 'Network error -cannot reach the API. Check your internet connection. [network_error]';
  }

  // Session errors -include the underlying reason so the developer can debug
  if (e.includes('session error') || e.includes('session closed') || e.includes('session not alive')) {
    const reasonMatch = error.match(/Session error:\s*(.+)/i);
    const reason = reasonMatch ? reasonMatch[1] : error;
    return reportable(`Agent session crashed: ${reason} [session_error]`);
  }

  // Timeout -could indicate app issue
  if (e.includes('timed out') || e.includes('timeout')) {
    return reportable('Request timed out. Try again or use a simpler prompt. [timeout]');
  }

  // Permission denied (SDK tool use)
  if (e.includes('permission') && e.includes('denied')) {
    return `Permission denied -${error} [permission_denied]`;
  }

  // Fallback -unknown error, developer should know
  return reportable(error);
}

// Status event types
export type AgentStatus = {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'tool_blocked' | 'responding' | 'done' | 'subagent_start' | 'subagent_update' | 'subagent_end' | 'queued' | 'queue_processing' | 'teammate_start' | 'teammate_idle' | 'teammate_message' | 'task_completed' | 'background_task_start' | 'background_task_output' | 'background_task_end' | 'partial_text' | 'mode_switched';
  sessionId?: string;
  toolName?: string;
  toolInput?: string;
  message?: string;
  // Partial text preview (streamed as agent composes)
  partialText?: string;
  // Subagent tracking
  agentId?: string;
  agentType?: string;
  agentCount?: number;  // Number of active subagents
  // Queue tracking
  queuePosition?: number;
  queuedMessage?: string;
  // Safety blocking
  blockedReason?: string;
  // Pocket CLI indicator
  isPocketCli?: boolean;
  // Team tracking
  teammateName?: string;
  teamName?: string;
  taskId?: string;
  taskSubject?: string;
  // Background task tracking
  backgroundTaskId?: string;
  backgroundTaskDescription?: string;
  backgroundTaskCount?: number;
};

// SDK types (loaded dynamically)
type SDKQuery = AsyncGenerator<unknown, void>;
type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string }
) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt: boolean }>;
type PreToolUseHookCallback = (input: { tool_name: string; tool_input: unknown }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}>;
// Hook callback types for team events
type TeammateIdleHookCallback = (input: { teammate_name: string; team_name: string }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'TeammateIdle';
  };
}>;
type TaskCompletedHookCallback = (input: { task_id: string; task_subject: string; task_description?: string; teammate_name?: string; team_name?: string }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'TaskCompleted';
  };
}>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UserPromptSubmitHookCallback = (input: any, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext?: string;
  };
}>;

// Thinking config type (replaces deprecated maxThinkingTokens)
type ThinkingConfig = { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' };

type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;  // deprecated -kept for non-Anthropic providers
  thinking?: ThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  abortController?: AbortController;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  persistSession?: boolean;
  resume?: string;  // SDK session ID to resume
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('project' | 'user')[];
  canUseTool?: CanUseToolCallback;  // Pre-tool-use validation callback
  env?: { [envVar: string]: string | undefined };  // Environment variables for Claude Code process
  hooks?: {
    PreToolUse?: Array<{ hooks: PreToolUseHookCallback[] }>;
    UserPromptSubmit?: Array<{ hooks: UserPromptSubmitHookCallback[] }>;
    TeammateIdle?: Array<{ hooks: TeammateIdleHookCallback[] }>;
    TaskCompleted?: Array<{ hooks: TaskCompletedHookCallback[] }>;
  };
};

// Thinking level to config mapping.
// For Opus 4.6: the CLI always forces adaptive thinking regardless of budget tokens,
// so the `effort` parameter is the proper way to control thinking depth.
// For other models: budget tokens are enforced via the `thinking` option.
const THINKING_CONFIGS: Record<string, { thinking: ThinkingConfig; effort?: 'low' | 'medium' | 'high' }> = {
  'none':     { thinking: { type: 'disabled' } },
  'minimal':  { thinking: { type: 'enabled', budgetTokens: 2048 },  effort: 'low' },
  'normal':   { thinking: { type: 'enabled', budgetTokens: 10000 }, effort: 'medium' },
  'extended':  { thinking: { type: 'adaptive' },                    effort: 'high' },
};

// Image content for multimodal messages
export interface ImageContent {
  type: 'base64';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;  // base64 encoded
}

// Attachment info for tracking attachments in metadata
export interface AttachmentInfo {
  hasAttachment: boolean;
  attachmentType?: 'photo' | 'voice' | 'audio' | 'document' | 'location';
}

// Content block types for SDK
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type ContentBlock = TextBlock | ImageBlock;

// SDK User Message type for async iterable
interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

// Dynamic SDK loader - prompt can be string or async iterable of messages
let sdkQuery: ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: SDKOptions }) => SDKQuery) | null = null;

// Use Function to preserve native import() - TypeScript converts import() to require() in CommonJS
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk') as { query: typeof sdkQuery };
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

export interface AgentConfig {
  memory: MemoryManager;
  projectRoot?: string;
  workspace?: string;  // Isolated working directory for agent file operations
  dataDir?: string;    // App data directory (e.g. ~/Library/Application Support/pocket-agent)
  model?: string;
  mode?: 'coder' | 'manager';
  tools?: ToolsConfig;
}

export interface MediaAttachment {
  type: 'image';
  filePath: string;       // absolute path on disk
  mimeType: string;       // e.g. 'image/png'
}

export interface ProcessResult {
  response: string;
  tokensUsed: number;
  wasCompacted: boolean;
  suggestedPrompt?: string;
  contextTokens?: number;
  contextWindow?: number;
  media?: MediaAttachment[];
}

export interface TurnContext {
  hints?: string[];
}

export interface ToolCallRecord {
  tool: string;
  input?: string;
  timestamp: string;
}

/**
 * AgentManager - Singleton wrapper around Claude Agent SDK
 */
class AgentManagerClass extends EventEmitter {
  private static instance: AgentManagerClass | null = null;
  private memory: MemoryManager | null = null;
  private projectRoot: string = process.cwd();
  private workspace: string = process.cwd();  // Isolated working directory for agent
  private model: string = 'claude-opus-4-6';
  private mode: 'coder' | 'manager' = 'coder';
  private toolsConfig: ToolsConfig | null = null;
  private initialized: boolean = false;
  private identity: string = '';
  private instructions: string = '';
  private abortControllersBySession: Map<string, AbortController> = new Map();
  private processingBySession: Map<string, boolean> = new Map();
  private lastSuggestedPromptBySession: Map<string, string | undefined> = new Map();
  private messageQueueBySession: Map<string, Array<{
    message: string;
    channel: string;
    images?: ImageContent[];
    attachmentInfo?: AttachmentInfo;
    turnContext?: TurnContext;
    resolve: (result: ProcessResult) => void;
    reject: (error: Error) => void;
  }>> = new Map();
  private sdkSessionIdBySession: Map<string, string> = new Map();
  private persistentSessions: Map<string, PersistentSDKSession> = new Map();
  private contextUsageBySession: Map<string, { contextTokens: number; contextWindow: number }> = new Map();
  private pendingMediaBySession: Map<string, MediaAttachment[]> = new Map();
  private stoppedByUserSession: Set<string> = new Set();
  private sdkToolTimers: Map<string, { timer: ReturnType<typeof setTimeout>; sessionId: string }> = new Map();
  private recentToolCallsBySession: Map<string, ToolCallRecord[]> = new Map();
  private activeTurnToolNamesBySession: Map<string, Set<string>> = new Map();
  private static readonly MAX_RECENT_TOOL_CALLS = 40;

  // Per-tool timeouts for SDK built-in tools (MCP tools have their own via wrapToolHandler)
  private static readonly SDK_TOOL_TIMEOUTS: Record<string, number> = {
    Bash: 120_000,      // 2 min -commands can be long-running
    Read: 15_000,
    Write: 15_000,
    Edit: 15_000,
    Glob: 15_000,
    Grep: 30_000,       // large codebases
    WebSearch: 30_000,
    WebFetch: 45_000,
    Task: 300_000,      // 5 min -subagent work
  };
  private static readonly SDK_TOOL_DEFAULT_TIMEOUT = 60_000; // 1 min default

  private constructor() {
    super();
  }

  static getInstance(): AgentManagerClass {
    if (!AgentManagerClass.instance) {
      AgentManagerClass.instance = new AgentManagerClass();
    }
    return AgentManagerClass.instance;
  }

  initialize(config: AgentConfig): void {
    this.memory = config.memory;
    this.projectRoot = config.projectRoot || process.cwd();
    this.workspace = config.workspace || this.projectRoot;
    this.model = config.model || 'claude-opus-4-6';
    this.mode = this.normalizeMode(config.mode || SettingsManager.get('agent.mode') || 'coder');
    this.toolsConfig = config.tools || null;
    this.initialized = true;

    // Isolate SDK session storage from global Claude Code installation
    if (config.dataDir) {
      process.env.CLAUDE_CONFIG_DIR = path.join(config.dataDir, '.claude');
    }

    this.identity = loadIdentity();
    this.instructions = loadInstructions();
    setMemoryManager(this.memory);
    setSoulMemoryManager(this.memory);

    // Set up safety status emitter for UI feedback on blocked tools
    setStatusEmitter((status) => {
      this.emitStatus(status);
    });

    console.log('[AgentManager] Initialized');
    console.log('[AgentManager] Project root:', this.projectRoot);
    console.log('[AgentManager] Workspace:', this.workspace);
    console.log('[AgentManager] Model:', this.model);
    console.log('[AgentManager] Mode:', this.mode);
    console.log('[AgentManager] Identity loaded:', this.identity.length, 'chars');
    console.log('[AgentManager] Instructions loaded:', this.instructions.length, 'chars');

    if (this.toolsConfig) {
      const validation = validateToolsConfig(this.toolsConfig);
      if (!validation.valid) {
        console.warn('[AgentManager] Tool config issues:', validation.errors);
      }

      if (this.toolsConfig.browser.enabled) {
        console.log('[AgentManager] Browser: 2-tier (Electron, CDP)');
      }
    }

    // Backfill message embeddings asynchronously (for semantic retrieval)
    this.backfillMessageEmbeddings().catch(e => {
      console.error('[AgentManager] Embedding backfill failed:', e);
    });
  }

  /**
   * Backfill embeddings for messages that don't have them yet.
   * Runs asynchronously in the background during initialization.
   */
  private async backfillMessageEmbeddings(): Promise<void> {
    if (!this.memory) return;

    // Get all sessions and backfill each
    const sessions = this.memory.getSessions();
    for (const session of sessions) {
      const embedded = await this.memory.embedRecentMessages(session.id, 100);
      if (embedded > 0) {
        console.log(`[AgentManager] Backfilled ${embedded} embeddings for session ${session.id}`);
      }
    }
  }

  isInitialized(): boolean {
    return this.initialized && this.memory !== null;
  }

  getModel(): string {
    return this.model;
  }

  getMode(): 'coder' | 'manager' {
    return this.mode;
  }

  private normalizeMode(mode: string): 'coder' | 'manager' {
    const normalized = String(mode || '').trim().toLowerCase();
    if (normalized === 'general' || normalized === 'manager') return 'manager';
    return 'coder';
  }

  private inferCoderIntent(userMessage: string): boolean {
    const text = String(userMessage || '').toLowerCase();

    // Strong coder intent
    if (/\b(code|coding|debug|bug|fix|refactor|implement|terminal|shell|bash|git|commit|push|pull request|pr|npm|pnpm|yarn|tsc)\b/.test(text)) {
      return true;
    }
    // Supporting coder intent
    if (/\b(file|files|folder|repository|repo|branch|function|class|typescript|javascript|python|sql|migration|build|tests?)\b/.test(text)) {
      return true;
    }
    if (/`[^`]+`/.test(text)) {
      return true;
    }
    return false;
  }

  private controlExternalApproval(
    userMessage: string,
    sessionId: string,
  ): { rewrittenMessage?: string; immediateResult?: ProcessResult } {
    const text = String(userMessage || '').trim();
    if (!text) return {};

    const denyMatch = text.match(/^deny\s+external\b/i);
    if (denyMatch) {
      clearPendingExternalApproval(sessionId);
      return {
        immediateResult: {
          response: 'External action denied. No host-level command was executed.',
          tokensUsed: 0,
          wasCompacted: false,
        },
      };
    }

    const approveMatch = text.match(/^approve\s+external(?:\s*:\s*([\s\S]+))?$/i);
    if (!approveMatch) return {};

    const explicitCommand = String(approveMatch[1] || '').trim() || undefined;
    const approval = approvePendingExternalApproval(sessionId, explicitCommand);
    if (!approval.ok || !approval.command) {
      const pending = getPendingExternalApproval(sessionId);
      const suffix = pending
        ? `\nPending command:\n${pending.command}\n\nReply with:\napprove external: ${pending.command}`
        : '';
      return {
        immediateResult: {
          response: `${approval.message}${suffix}`,
          tokensUsed: 0,
          wasCompacted: false,
        },
      };
    }

    return {
      rewrittenMessage:
        `[User approved one external command for this session: "${approval.command}". ` +
        `Continue previous task and execute only this approved command if still needed.]`,
    };
  }

  private recordToolCall(sessionId: string, tool: string, input?: string): void {
    const list = this.recentToolCallsBySession.get(sessionId) || [];
    list.push({
      tool,
      input: input?.trim() ? input.slice(0, 220) : undefined,
      timestamp: new Date().toISOString(),
    });
    if (list.length > AgentManagerClass.MAX_RECENT_TOOL_CALLS) {
      list.splice(0, list.length - AgentManagerClass.MAX_RECENT_TOOL_CALLS);
    }
    this.recentToolCallsBySession.set(sessionId, list);
  }

  private markToolAttemptedThisTurn(sessionId: string, tool: string): void {
    let set = this.activeTurnToolNamesBySession.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.activeTurnToolNamesBySession.set(sessionId, set);
    }
    set.add(tool);
  }

  private getToolGroupSummary(mode: 'coder' | 'manager'): string[] {
    const groups: string[] = [];
    if (mode === 'coder') {
      groups.push('Code/Shell: enabled (Read, Write, Edit, Bash, Task, WebSearch, WebFetch)');
    } else {
      groups.push('Code/Shell: restricted (Read/Write/Edit/Bash/Task blocked in Manager mode)');
      groups.push('Lookup tools: enabled (Grep, Glob, WebSearch, WebFetch)');
    }

    groups.push('Memory: enabled (remember, list_facts, memory_search, daily_log, soul_set)');
    groups.push('Planning: enabled (task_*, calendar_*, scheduler/reminders)');
    groups.push('Kanban: enabled (project/task search and updates)');
    groups.push('Research + LinkedIn + Telegram ops: enabled');
    groups.push(`Browser: ${this.toolsConfig?.browser.enabled ? 'enabled' : 'disabled by settings'}`);
    return groups;
  }

  private buildRuntimeModeToolCard(
    sessionId: string,
    channel: string,
    sessionMode: 'coder' | 'manager',
    allowedTools: string[]
  ): string {
    const now = new Date();
    const local = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const groups = this.getToolGroupSummary(sessionMode);
    return [
      '## Runtime Mode + Tool Card',
      `Session ID: ${sessionId}`,
      `Channel: ${channel}`,
      `Active mode: ${sessionMode}`,
      `Current time (ISO): ${now.toISOString()}`,
      `Current local time: ${local}`,
      `Allowed tool count this turn: ${allowedTools.length}`,
      `Allowed tool groups: ${groups.join(' | ')}`,
    ].join('\n');
  }

  getSessionMode(sessionId: string = 'default'): 'coder' | 'manager' {
    const memory = this.memory;
    if (!memory) return this.mode;
    return memory.getSessionMode(sessionId);
  }

  getToolSummary(sessionId: string = 'default'): { mode: 'coder' | 'manager'; groups: string[] } {
    const mode = this.getSessionMode(sessionId);
    return { mode, groups: this.getToolGroupSummary(mode) };
  }

  getRecentToolCalls(sessionId: string = 'default', limit: number = 8): ToolCallRecord[] {
    const list = this.recentToolCallsBySession.get(sessionId) || [];
    return list.slice(-Math.max(1, limit)).reverse();
  }

  setModel(model: string): void {
    const oldProvider = getProviderForModel(this.model);
    const newProvider = getProviderForModel(model);

    this.model = model;
    SettingsManager.set('agent.model', model);
    console.log('[AgentManager] Model changed to:', model);

    // If provider changed, we must close existing sessions because SDK client config (baseURL, keys) 
    // is tied to the client instance created at session start.
    if (oldProvider !== newProvider) {
      console.log(`[AgentManager] Provider changed (${oldProvider} -> ${newProvider}), closing all persistent sessions`);
      this.closeAllPersistentSessions();
    } else {
      // Update model on all live persistent sessions (within same provider)
      for (const [sid, session] of this.persistentSessions.entries()) {
        if (session.isAlive()) {
          session.setModel(model).catch(err => {
            console.error(`[AgentManager] Failed to set model on session ${sid}:`, err);
          });
        }
      }
    }

    this.emit('model:changed', model);
  }

  setMode(mode: string): void {
    const normalized = this.normalizeMode(mode);
    this.mode = normalized;
    SettingsManager.set('agent.mode', normalized);
    console.log('[AgentManager] Mode changed to:', normalized);
    this.emit('mode:changed', normalized);
  }

  async processMessage(
    userMessage: string,
    channel: string = 'default',
    sessionId: string = 'default',
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo,
    turnContext?: TurnContext
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    const externalControl = this.controlExternalApproval(userMessage, sessionId);
    if (externalControl.immediateResult) {
      return externalControl.immediateResult;
    }
    const effectiveUserMessage = externalControl.rewrittenMessage || userMessage;

    // If already processing, queue the message
    if (this.processingBySession.get(sessionId)) {
      return this.queueMessage(effectiveUserMessage, channel, sessionId, images, attachmentInfo, turnContext);
    }

    return this.executeMessage(effectiveUserMessage, channel, sessionId, images, attachmentInfo, false, undefined, turnContext);
  }

  /**
   * Queue a message to be processed after the current one finishes
   */
  private queueMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo,
    turnContext?: TurnContext
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      // Get or create queue for this session
      if (!this.messageQueueBySession.has(sessionId)) {
        this.messageQueueBySession.set(sessionId, []);
      }
      const queue = this.messageQueueBySession.get(sessionId)!;

      // Add to queue
      queue.push({ message: userMessage, channel, images, attachmentInfo, resolve, reject, turnContext });

      const queuePosition = queue.length;
      console.log(`[AgentManager] Message queued at position ${queuePosition} for session ${sessionId}`);

      // Emit queued status
      this.emitStatus({
        type: 'queued',
        sessionId,
        queuePosition,
        queuedMessage: userMessage.slice(0, 100),
        message: `in the litter queue (#${queuePosition})`,
      });
    });
  }

  /**
   * Process the next message in the queue for a session
   */
  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.messageQueueBySession.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    console.log(`[AgentManager] Processing queued message for session ${sessionId}, ${queue.length} remaining`);

    // Emit status that we're processing a queued message
    this.emitStatus({
      type: 'queue_processing',
      sessionId,
      queuedMessage: next.message.slice(0, 100),
      message: 'digging it up now...',
    });

    try {
      const result = await this.executeMessage(
        next.message,
        next.channel,
        sessionId,
        next.images,
        next.attachmentInfo,
        false,
        undefined,
        next.turnContext
      );
      next.resolve(result);
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Actually execute a message (internal implementation)
   * Uses persistent sessions: first message creates a Query, subsequent messages
   * use streamInput() to keep the subprocess alive (preserving background tasks).
   */
  private isQuotaError(msg: string): boolean {
    const patterns = ['429', 'quota', 'insufficient balance', 'rate limit', 'exceeded', 'suspended', 'invalid api key', 'invalid x-api-key'];
    const lower = msg.toLowerCase();
    return patterns.some(p => lower.includes(p));
  }

  private isModelUnavailableError(msg: string): boolean {
    const lower = String(msg || '').toLowerCase();
    const patterns = [
      'model_not_found',
      'model not available',
      'model not found',
      'does not exist',
      'not support',
      'run --model',
      'issue with the selected model',
      'may not have access',
      'you may not have access',
      'invalid model',
    ];
    return patterns.some(p => lower.includes(p));
  }

  private shouldFallbackForError(msg: string): boolean {
    return this.isQuotaError(msg) || this.isModelUnavailableError(msg);
  }

  private fallbackReasonLabel(msg: string): string {
    return this.isModelUnavailableError(msg) ? 'model unavailable' : 'quota exceeded';
  }

  private isAutoModelFallbackEnabled(): boolean {
    // Opt-in only. If unset, no automatic model switching.
    return String(SettingsManager.get('agent.autoModelFallback') || '').trim().toLowerCase() === 'true';
  }

  private hasModelCredentials(model: string): boolean {
    const provider = getProviderForModel(model);
    if (provider === 'moonshot') return !!SettingsManager.get('moonshot.apiKey');
    if (provider === 'glm') return !!SettingsManager.get('glm.apiKey');
    if (provider === 'minimax') return !!SettingsManager.get('minimax.apiKey');
    if (provider === 'qwen') return !!SettingsManager.get('qwen.apiKey');
    if (provider === 'openrouter') return !!SettingsManager.get('openrouter.apiKey');
    return !!SettingsManager.get('anthropic.apiKey') || SettingsManager.get('auth.method') === 'oauth';
  }

  private getBestFallbackModel(currentModel: string): string | null {
    const configured = (SettingsManager.get('agent.fallbackModel') || '').trim();
    if (configured && configured !== currentModel && this.hasModelCredentials(configured)) {
      return configured;
    }

    const candidates = [
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'glm-5',
      'MiniMax-M2.5-Lightning',
      'kimi-k2.5',
      'qwen3.5-plus-2026-02-15',
    ];

    for (const candidate of candidates) {
      if (candidate !== currentModel && this.hasModelCredentials(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private async executeMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo,
    retryWithFallback = false,
    modelOverride?: string,
    turnContext?: TurnContext,
  ): Promise<ProcessResult> {
    // Memory should already be checked by processMessage, but guard anyway
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    const memory = this.memory; // Local reference for TypeScript narrowing
    const activeModel = modelOverride || this.model;
    const usingTemporaryModel = !!modelOverride && modelOverride !== this.model;
    if (!memory.getSession(sessionId)) {
      const inferredName = sessionId
        .split(':')
        .map(part => part || 'session')
        .join(' ')
        .replace(/\b\w/g, ch => ch.toUpperCase());
      memory.ensureSession(sessionId, inferredName, 'coder');
    }
    let sessionMode = memory.getSessionMode(sessionId);
    let autoSwitchNotice: string | null = null;
    const safeHints = (turnContext?.hints || [])
      .map(h => String(h || '').trim())
      .filter(Boolean)
      .slice(0, 4);
    const turnHintPrefix = safeHints.length > 0
      ? safeHints.map(h => `[Turn context: ${h}]`).join('\n')
      : '';
    const runtimeUserMessage = turnHintPrefix
      ? `${turnHintPrefix}\n${userMessage}`
      : userMessage;

    // Convenience: if chat is in Manager and request clearly needs coding, auto-switch to Coder.
    if ((channel === 'telegram' || channel === 'desktop') && sessionMode === 'manager') {
      const needsCoder = this.inferCoderIntent(userMessage);
      if (needsCoder) {
        const switched = memory.setSessionMode(sessionId, 'coder');
        if (switched) {
          this.clearSdkSessionMapping(sessionId);
          sessionMode = 'coder';
          autoSwitchNotice = 'Auto-switched to Coder mode for this request.';
          this.emitStatus({
            type: 'mode_switched',
            sessionId,
            message: autoSwitchNotice,
          });
          console.log(`[AgentManager] Auto-switched session ${sessionId} to coder mode (channel=${channel})`);
        }
      }
    }

    this.processingBySession.set(sessionId, true);
    this.stoppedByUserSession.delete(sessionId);
    this.lastSuggestedPromptBySession.set(sessionId, undefined);
    this.pendingMediaBySession.set(sessionId, []);
    this.activeTurnToolNamesBySession.set(sessionId, new Set<string>());

    try {
      const existingSession = this.persistentSessions.get(sessionId);
      let turnResult: TurnResult;
      let hadSdkSessionBeforeStart = false;

      if (existingSession?.isAlive()) {
        // === Existing session: send via streamInput ===
        console.log(`[AgentManager] Sending to existing persistent session: ${sessionId}`);
        this.emitStatus({ type: 'thinking', sessionId, message: '*stretches paws* thinking...' });

        // Build content blocks for images
        const contentBlocks = images && images.length > 0
          ? [
              { type: 'text' as const, text: runtimeUserMessage },
              ...images.map(img => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.mediaType,
                  data: img.data,
                },
              })),
            ]
          : undefined;

        turnResult = await existingSession.send(runtimeUserMessage, contentBlocks);
      } else {
        // === New session: create Query with first message ===
        // Clean up dead session if present
        if (existingSession) {
          this.persistentSessions.delete(sessionId);
        }

        // Look up SDK session for resume (in-memory cache first, then DB)
        let sdkSessionId = this.sdkSessionIdBySession.get(sessionId)
          || memory.getSdkSessionId(sessionId)
          || undefined;
        hadSdkSessionBeforeStart = !!sdkSessionId;

        if (sdkSessionId) {
          console.log(`[AgentManager] Resuming SDK session: ${sdkSessionId}`);
        } else {
          console.log('[AgentManager] Starting new persistent SDK session');
        }

        const queryFn = await loadSDK();
        if (!queryFn) throw new Error('Failed to load SDK');

        // Build options with dynamic context
        const options = await this.buildPersistentOptions(memory, sessionId, sessionMode, activeModel, channel, sdkSessionId);

        console.log('[AgentManager] Calling query() with model:', options.model, 'thinking:', JSON.stringify(options.thinking) || 'default', 'effort:', options.effort || 'default');
        this.emitStatus({ type: 'thinking', sessionId, message: '*stretches paws* thinking...' });

        // Create persistent session
        const session = new PersistentSDKSession(
          sessionId,
          (msg) => this.processStatusFromMessage(msg),
          (msg, current) => this.extractFromMessage(msg, current)
        );

        // Listen for SDK session ID capture
        session.on('sdkSessionId', (capturedId: string) => {
          this.sdkSessionIdBySession.set(sessionId, capturedId);
          memory.setSdkSessionId(sessionId, capturedId);
        });

        // Listen for session closure
        session.on('closed', () => {
          console.log(`[AgentManager] Persistent session closed: ${sessionId}`);
          // Clear SDK tool timeout timers belonging to this session
          for (const [id, entry] of this.sdkToolTimers.entries()) {
            if (entry.sessionId === sessionId) {
              clearTimeout(entry.timer);
              this.sdkToolTimers.delete(id);
            }
          }
        });

        this.persistentSessions.set(sessionId, session);

        // Build content blocks for images (if any)
        const firstContentBlocks: ContentBlock[] | undefined = images && images.length > 0
          ? [
              { type: 'text' as const, text: runtimeUserMessage },
              ...images.map(img => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.mediaType,
                  data: img.data,
                },
              })),
            ]
          : undefined;

        if (firstContentBlocks) {
          console.log(`[AgentManager] Starting persistent session with ${images!.length} image(s)`);
        }

        try {
          turnResult = await session.start(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            queryFn as any,
            runtimeUserMessage,
            options as unknown as Record<string, unknown>,
            firstContentBlocks
          );
        } catch (startError) {
          // If resume failed (corrupted/missing SDK session), retry without resume
          if (sdkSessionId) {
            const errMsg = startError instanceof Error ? startError.message : String(startError);
            console.warn(`[AgentManager] Resume failed (${errMsg}), retrying without resume...`);
            sdkSessionId = undefined;
            this.sdkSessionIdBySession.delete(sessionId);
            memory.clearSdkSessionId(sessionId);

            // Clean up failed session
            session.close();
            this.persistentSessions.delete(sessionId);

            // Create new session without resume
            const freshOptions = await this.buildPersistentOptions(memory, sessionId, sessionMode, activeModel, channel, undefined);
            const freshSession = new PersistentSDKSession(
              sessionId,
              (msg) => this.processStatusFromMessage(msg),
              (msg, current) => this.extractFromMessage(msg, current)
            );

            freshSession.on('sdkSessionId', (capturedId: string) => {
              this.sdkSessionIdBySession.set(sessionId, capturedId);
              memory.setSdkSessionId(sessionId, capturedId);
            });

            freshSession.on('closed', () => {
              console.log(`[AgentManager] Persistent session closed: ${sessionId}`);
              // Clear SDK tool timeout timers belonging to this session
              for (const [id, entry] of this.sdkToolTimers.entries()) {
                if (entry.sessionId === sessionId) {
                  clearTimeout(entry.timer);
                  this.sdkToolTimers.delete(id);
                }
              }
            });

            this.persistentSessions.set(sessionId, freshSession);

            turnResult = await freshSession.start(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              queryFn as any,
              runtimeUserMessage,
              freshOptions as unknown as Record<string, unknown>,
              firstContentBlocks
            );
          } else {
            throw startError;
          }
        }
      }

      // === Check for stale/crashed session errors and retry without resume ===
      // Use the flag captured BEFORE session.start() -the sdkSessionIdBySession map
      // is populated mid-call by the 'sdkSessionId' event, so checking it here would always be true.
      const wasResuming = hadSdkSessionBeforeStart;
      if (turnResult.errors && turnResult.errors.length > 0) {
        console.log(`[AgentManager] Turn errors: ${JSON.stringify(turnResult.errors)}, response length: ${turnResult.response.length}, wasResuming: ${wasResuming}`);
      }
      const isStaleSession = turnResult.errors?.some(e => e.includes('No conversation found with session ID'));
      const isInvalidThinking = turnResult.errors?.some(e => e.includes('Invalid signature in thinking block'));
      // "unknown" errors during resume are typically invalid thinking signatures or corrupted sessions.
      // The SDK may still return error text as "response", so don't require empty response.
      const isUnknownResumeError = wasResuming && turnResult.errors?.some(e => e === 'unknown');
      const isSessionCrash = !turnResult.response && turnResult.errors?.some(e =>
        e.includes('Session error') || e.includes('session closed'));
      // OAuth token expired mid-session -the subprocess can't refresh it, so we must
      // kill the session, refresh the token, and retry with a new subprocess.
      const isAuthFailed = turnResult.errors?.some(e => e.includes('authentication_failed'));
      if (isStaleSession || isInvalidThinking || isUnknownResumeError || isSessionCrash || isAuthFailed) {
        const staleId = this.sdkSessionIdBySession.get(sessionId);
        const reason = isStaleSession ? 'stale SDK session'
          : isInvalidThinking ? 'invalid thinking signature'
          : isUnknownResumeError ? 'unknown resume error'
          : isAuthFailed ? 'OAuth token expired'
          : 'session crash';
        console.warn(`[AgentManager] ${reason} detected (${staleId}), retrying...`);

        // For auth failures, keep the SDK session ID so we can resume with a fresh token.
        // For other errors, clear the session to start fresh.
        if (!isAuthFailed) {
          this.sdkSessionIdBySession.delete(sessionId);
          memory.clearSdkSessionId(sessionId);
        }

        // Close the dead session (subprocess has stale token or corrupted state)
        const deadSession = this.persistentSessions.get(sessionId);
        if (deadSession) {
          deadSession.close();
          this.persistentSessions.delete(sessionId);
        }

        // Retry: buildPersistentOptions will refresh the OAuth token via configureProviderEnvironment.
        // For auth failures, resume the same SDK session (context is valid, just token expired).
        const queryFn = await loadSDK();
        if (!queryFn) throw new Error('Failed to load SDK');

        const resumeId = isAuthFailed ? staleId : undefined;
        const freshOptions = await this.buildPersistentOptions(memory, sessionId, sessionMode, activeModel, channel, resumeId);
        const freshSession = new PersistentSDKSession(
          sessionId,
          (msg) => this.processStatusFromMessage(msg),
          (msg, current) => this.extractFromMessage(msg, current)
        );

        freshSession.on('sdkSessionId', (capturedId: string) => {
          this.sdkSessionIdBySession.set(sessionId, capturedId);
          memory.setSdkSessionId(sessionId, capturedId);
        });

        freshSession.on('closed', () => {
          console.log(`[AgentManager] Persistent session closed: ${sessionId}`);
          // Clear SDK tool timeout timers belonging to this session
          for (const [id, entry] of this.sdkToolTimers.entries()) {
            if (entry.sessionId === sessionId) {
              clearTimeout(entry.timer);
              this.sdkToolTimers.delete(id);
            }
          }
        });

        this.persistentSessions.set(sessionId, freshSession);
        this.emitStatus({ type: 'thinking', sessionId, message: 'reconnecting...' });

        // Build content blocks for images (if any)
        const retryContentBlocks = images && images.length > 0
          ? [
              { type: 'text' as const, text: runtimeUserMessage },
              ...images.map(img => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.mediaType,
                  data: img.data,
                },
              })),
            ]
          : undefined;

        turnResult = await freshSession.start(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          queryFn as any,
          runtimeUserMessage,
          freshOptions as unknown as Record<string, unknown>,
          retryContentBlocks
        );
      }

      // === Check for model/quota errors and retry with fallback model ===
      const turnFallbackTrigger = turnResult.errors?.find(e => this.shouldFallbackForError(e));
      if (this.isAutoModelFallbackEnabled() && !retryWithFallback && turnFallbackTrigger) {
        const fallbackModel = this.getBestFallbackModel(activeModel);
        if (fallbackModel && fallbackModel !== activeModel) {
          const originalModel = activeModel;
          const reason = this.fallbackReasonLabel(turnFallbackTrigger);
          console.log(`[AgentManager] ${reason} in turnResult, falling back to ${fallbackModel}`);
          this.closePersistentSession(sessionId);
          this.sdkSessionIdBySession.delete(sessionId);
          memory.clearSdkSessionId(sessionId);
          const result = await this.executeMessage(
            userMessage,
            channel,
            sessionId,
            images,
            attachmentInfo,
            true,
            fallbackModel,
            turnContext
          );
          result.response = `[Used fallback model ${fallbackModel} for this request (${reason}; primary: ${originalModel})]\n\n${result.response}`;
          return result;
        }
      }

      // If the request was aborted (user pressed stop), bail out cleanly
      const wasAborted = this.stoppedByUserSession.has(sessionId)
        || turnResult.errors?.some(e => e.includes('aborted') || e.includes('interrupted'));
      if (wasAborted) {
        this.stoppedByUserSession.delete(sessionId);
        this.emitStatus({ type: 'done', sessionId });
        this.processingBySession.set(sessionId, false);
        const partialResponse = turnResult.response?.trim() || '';
        return {
          response: partialResponse,
          tokensUsed: 0,
          wasCompacted: false,
          suggestedPrompt: partialResponse ? this.lastSuggestedPromptBySession.get(sessionId) : undefined,
        };
      }

      // === Process turn result (same for both paths) ===
      let response = turnResult.response;
      const wasCompacted = turnResult.wasCompacted;

      // Store context window usage from SDK result
      if (turnResult.contextTokens !== undefined || turnResult.contextWindow !== undefined) {
        const existing = this.contextUsageBySession.get(sessionId);
        this.contextUsageBySession.set(sessionId, {
          contextTokens: turnResult.contextTokens ?? existing?.contextTokens ?? 0,
          contextWindow: turnResult.contextWindow ?? existing?.contextWindow ?? 0,
        });
      }

      this.emitStatus({ type: 'done', sessionId });

      // If no text response, try to recover or surface the actual problem
      if (!response) {
        // Check if the SDK reported errors -throw so they route through the error display path
        // (red bubble in UI, warning in Telegram)
        // BUT first check if this is a quota error that should trigger model fallback
        if (turnResult.errors && turnResult.errors.length > 0) {
          const emptyFallbackTrigger = turnResult.errors.find(e => this.shouldFallbackForError(e));
          if (this.isAutoModelFallbackEnabled() && emptyFallbackTrigger && !retryWithFallback) {
            const fallbackModel = this.getBestFallbackModel(activeModel);
            if (fallbackModel && fallbackModel !== activeModel) {
              const originalModel = activeModel;
              const reason = this.fallbackReasonLabel(emptyFallbackTrigger);
              console.log(`[AgentManager] ${reason} in empty response, falling back to ${fallbackModel}`);
              this.closePersistentSession(sessionId);
              this.sdkSessionIdBySession.delete(sessionId);
              memory.clearSdkSessionId(sessionId);
              const result = await this.executeMessage(
                userMessage,
                channel,
                sessionId,
                images,
                attachmentInfo,
                true,
                fallbackModel,
                turnContext
              );
              result.response = `[Used fallback model ${fallbackModel} for this request (${reason}; primary: ${originalModel})]\n\n${result.response}`;
              return result;
            }
          }
          const errorSummary = turnResult.errors.join('; ');
          console.error(`[AgentManager] Empty response with SDK errors: ${errorSummary}`);
          throw new Error(formatAgentError(turnResult.errors[0]));
        }

        // No errors -agent likely did tool-only work, request a summary
        const currentSession = this.persistentSessions.get(sessionId);
        if (currentSession?.isAlive()) {
          console.log('[AgentManager] No text response (no errors), requesting summary...');
          this.emitStatus({ type: 'thinking', sessionId, message: 'summarizing...' });

          try {
            const summaryResult = await currentSession.send('Briefly summarize what you just did in 1-2 sentences.');
            if (summaryResult.response) {
              response = summaryResult.response;
            } else if (summaryResult.errors && summaryResult.errors.length > 0) {
              console.error(`[AgentManager] Summary returned errors: ${summaryResult.errors.join('; ')}`);
              throw new Error(formatAgentError(summaryResult.errors[0]));
            } else {
              console.warn('[AgentManager] Summary also returned empty -no errors, no text');
              response = 'Task completed (no details available).';
            }
          } catch (summaryError) {
            // Re-throw formatted errors (from above), format raw errors
            if (summaryError instanceof Error && summaryError.message.includes('[')) {
              throw summaryError;
            }
            const errMsg = summaryError instanceof Error ? summaryError.message : String(summaryError);
            console.error(`[AgentManager] Summary request failed: ${errMsg}`);
            throw new Error(formatAgentError(errMsg));
          }

          this.emitStatus({ type: 'done', sessionId });
        } else {
          console.warn('[AgentManager] Session not alive for summary -session may have crashed');
          throw new Error(reportable('Agent session ended unexpectedly. Send another message to start a new session.'));
        }
      }

      // Some SDK backends return model-access failures as plain text response instead of an error object.
      if (this.isAutoModelFallbackEnabled() && !retryWithFallback && response && this.isModelUnavailableError(response)) {
        const fallbackModel = this.getBestFallbackModel(activeModel);
        if (fallbackModel && fallbackModel !== activeModel) {
          const originalModel = activeModel;
          const reason = this.fallbackReasonLabel(response);
          console.log(`[AgentManager] Response indicated ${reason}, falling back to ${fallbackModel}`);
          this.closePersistentSession(sessionId);
          this.sdkSessionIdBySession.delete(sessionId);
          memory.clearSdkSessionId(sessionId);
          const result = await this.executeMessage(
            userMessage,
            channel,
            sessionId,
            images,
            attachmentInfo,
            true,
            fallbackModel,
            turnContext
          );
          result.response = `[Used fallback model ${fallbackModel} for this request (${reason}; primary: ${originalModel})]\n\n${result.response}`;
          return result;
        }
      }

      if (autoSwitchNotice && channel === 'telegram' && response) {
        response = `ℹ️ ${autoSwitchNotice}\n\n${response}`;
      }

      {
        // Clean up scheduled job messages before saving - remove internal LLM instructions
        let messageToSave = userMessage;

        // Convert reminder prompts to clean display format (for reminders)
        const reminderMatch = messageToSave.match(/^\[SCHEDULED REMINDER - DELIVER NOW\]\nThe user previously asked to be reminded about: "(.+?)"\n\nDeliver this reminder/);
        if (reminderMatch) {
          messageToSave = `Reminder: ${reminderMatch[1]}`;
        }

        // Add metadata for message source and attachments
        let metadata: Record<string, unknown> | undefined;
        if (channel.startsWith('cron:')) {
          metadata = { source: 'scheduler', jobName: channel.slice(5) };
        } else if (channel === 'telegram') {
          // Use explicit attachmentInfo if provided, otherwise check for images
          const hasAttachment = attachmentInfo?.hasAttachment ?? (images && images.length > 0);
          const attachmentType = attachmentInfo?.attachmentType ?? (images && images.length > 0 ? 'photo' : undefined);
          metadata = { source: 'telegram', hasAttachment, attachmentType };
        }

        const userMsgId = memory.saveMessage('user', messageToSave, sessionId, metadata);
        // Assistant response doesn't need hasAttachment but keep source for consistency
        const assistantMetadata = metadata ? { source: metadata.source } : undefined;
        const assistantMsgId = memory.saveMessage('assistant', response, sessionId, assistantMetadata);
        console.log('[AgentManager] Saved messages to SQLite (session: ' + sessionId + ')');

        // Embed messages asynchronously for future semantic retrieval
        // Don't await - let it run in background
        memory.embedMessage(userMsgId).catch(e => console.error('[AgentManager] Failed to embed user message:', e));
        memory.embedMessage(assistantMsgId).catch(e => console.error('[AgentManager] Failed to embed assistant message:', e));
      }

      this.extractAndStoreFacts(userMessage);

      const statsAfter = memory.getStats();
      const contextUsage = this.contextUsageBySession.get(sessionId);

      return {
        response,
        tokensUsed: statsAfter.estimatedTokens,
        wasCompacted,
        suggestedPrompt: this.lastSuggestedPromptBySession.get(sessionId),
        contextTokens: contextUsage?.contextTokens,
        contextWindow: contextUsage?.contextWindow,
        media: (this.pendingMediaBySession.get(sessionId) || []).length > 0 ? this.pendingMediaBySession.get(sessionId) : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[AgentManager] Query failed:', errorMsg);
      if (error instanceof Error && error.stack) {
        console.error('[AgentManager] Stack trace:', error.stack);
      }
      // Log full error object for debugging
      console.error('[AgentManager] Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

      // Check if this is a session-closed exception (race condition: isAlive() was true but send() threw)
      // Retry once as a fresh session — same as the isSessionCrash path in turnResult handling.
      const isThrownSessionClosed = !retryWithFallback &&
        (errorMsg.toLowerCase().includes('session closed') ||
         errorMsg.toLowerCase().includes('session error') ||
         errorMsg.toLowerCase().includes('session not alive'));
      if (isThrownSessionClosed) {
        console.warn(`[AgentManager] Session closed exception caught, retrying as fresh session (${sessionId})`);
        this.closePersistentSession(sessionId);
        this.persistentSessions.delete(sessionId);
        this.sdkSessionIdBySession.delete(sessionId);
        memory.clearSdkSessionId(sessionId);
        return this.executeMessage(userMessage, channel, sessionId, images, attachmentInfo, true, activeModel, turnContext);
      }

      // Check if this is a model/quota issue and we have a fallback
      if (this.isAutoModelFallbackEnabled() && this.shouldFallbackForError(errorMsg) && !retryWithFallback) {
        const fallbackModel = this.getBestFallbackModel(activeModel);
        if (fallbackModel && fallbackModel !== activeModel) {
          const originalModel = activeModel;
          const reason = this.fallbackReasonLabel(errorMsg);
          console.log(`[AgentManager] Primary model ${reason}, falling back to ${fallbackModel}`);
          this.closePersistentSession(sessionId);
          this.sdkSessionIdBySession.delete(sessionId);
          memory.clearSdkSessionId(sessionId);
          const result = await this.executeMessage(
            userMessage,
            channel,
            sessionId,
            images,
            attachmentInfo,
            true,
            fallbackModel,
            turnContext
          );
          result.response = `[Used fallback model ${fallbackModel} for this request (${reason}; primary: ${originalModel})]\n\n${result.response}`;
          return result;
        }
      }

      // Save user message and error response so they persist across reloads
      memory.saveMessage('user', userMessage, sessionId);
      memory.saveMessage('assistant', errorMsg, sessionId, { isError: true });

      throw error;
    } finally {
      if (usingTemporaryModel) {
        // Fallback model is request-scoped only: do not keep a fallback-bound SDK session.
        this.closePersistentSession(sessionId);
        this.sdkSessionIdBySession.delete(sessionId);
        memory.clearSdkSessionId(sessionId);
      }
      this.activeTurnToolNamesBySession.delete(sessionId);
      this.processingBySession.set(sessionId, false);

      // Process next message in queue (if any)
      // Use setTimeout(0) to avoid blocking the current promise resolution
      setTimeout(() => {
        this.processQueue(sessionId).catch((err) => {
          console.error('[AgentManager] Queue processing failed:', err);
        });
      }, 0);
    }
  }

  /**
   * Get the number of queued messages for a session
   */
  getQueueLength(sessionId: string = 'default'): number {
    return this.messageQueueBySession.get(sessionId)?.length || 0;
  }

  /**
   * Clear the message queue for a session
   */
  clearQueue(sessionId: string = 'default'): void {
    const queue = this.messageQueueBySession.get(sessionId);
    if (queue && queue.length > 0) {
      // Reject all pending messages
      for (const item of queue) {
        item.reject(new Error('Queue cleared'));
      }
      // Delete the key entirely to prevent memory leak from accumulated empty arrays
      this.messageQueueBySession.delete(sessionId);
      console.log(`[AgentManager] Queue cleared for session ${sessionId}`);
    } else if (queue) {
      // Clean up empty queue entries
      this.messageQueueBySession.delete(sessionId);
    }
  }

  /**
   * Stop the current turn for a specific session (or any running query if no sessionId).
   * Uses interrupt() on persistent sessions to stop the current turn while keeping
   * the subprocess alive (preserving background tasks).
   * Also clears any queued messages for that session.
   */
  stopQuery(sessionId?: string, clearQueuedMessages: boolean = true): boolean {
    // Clear SDK tool timeout timers for the session being stopped
    const targetSessionId = sessionId
      || [...this.processingBySession.entries()].find(([, v]) => v)?.[0];
    if (targetSessionId) {
      for (const [id, entry] of this.sdkToolTimers.entries()) {
        if (entry.sessionId === targetSessionId) {
          clearTimeout(entry.timer);
          this.sdkToolTimers.delete(id);
        }
      }
    }

    if (sessionId) {
      // Clear the queue first
      if (clearQueuedMessages) {
        this.clearQueue(sessionId);
      }

      const session = this.persistentSessions.get(sessionId);
      if (session?.isAlive() && this.processingBySession.get(sessionId)) {
        console.log(`[AgentManager] Interrupting persistent session ${sessionId} (bg tasks survive)...`);
        this.stoppedByUserSession.add(sessionId);
        session.interrupt().catch(err => {
          console.error(`[AgentManager] Interrupt failed for ${sessionId}:`, err);
        });
        return true;
      }

      // Fallback to abort controller (for non-persistent queries)
      const abortController = this.abortControllersBySession.get(sessionId);
      if (this.processingBySession.get(sessionId) && abortController) {
        console.log(`[AgentManager] Stopping query for session ${sessionId} via abort...`);
        this.stoppedByUserSession.add(sessionId);
        abortController.abort();
        return true;
      }
      return false;
    }

    // Legacy: stop any running query (first one found)
    for (const [sid, isProcessing] of this.processingBySession.entries()) {
      if (isProcessing) {
        if (clearQueuedMessages) {
          this.clearQueue(sid);
        }

        const session = this.persistentSessions.get(sid);
        if (session?.isAlive()) {
          console.log(`[AgentManager] Interrupting persistent session ${sid}...`);
          this.stoppedByUserSession.add(sid);
          session.interrupt().catch(err => {
            console.error(`[AgentManager] Interrupt failed for ${sid}:`, err);
          });
          return true;
        }

        const abortController = this.abortControllersBySession.get(sid);
        if (abortController) {
          console.log(`[AgentManager] Stopping query for session ${sid} via abort...`);
          this.stoppedByUserSession.add(sid);
          abortController.abort();
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if a query is currently processing (optionally for a specific session)
   */
  isQueryProcessing(sessionId?: string): boolean {
    if (sessionId) {
      return this.processingBySession.get(sessionId) || false;
    }
    // Check if any session is processing
    for (const isProcessing of this.processingBySession.values()) {
      if (isProcessing) return true;
    }
    return false;
  }

  /**
   * Get the current workspace directory
   */
  getWorkspace(): string {
    return this.workspace;
  }

  /**
   * Get the default project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Set the workspace directory for agent file operations.
   * This takes effect on the next SDK query (cwd option).
   * Closes all persistent sessions and clears SDK session mappings since sessions are tied to cwd.
   */
  setWorkspace(path: string): void {
    console.log('[AgentManager] Workspace changed:', this.workspace, '->', path);
    this.workspace = path;
    // SDK sessions are stored per-cwd, so changing cwd invalidates them
    this.closeAllPersistentSessions();
    this.sdkSessionIdBySession.clear();
  }

  /**
   * Reset workspace to default project root
   * Closes all persistent sessions and clears SDK session mappings since sessions are tied to cwd.
   */
  resetWorkspace(): void {
    console.log('[AgentManager] Workspace reset to project root:', this.projectRoot);
    this.workspace = this.projectRoot;
    this.closeAllPersistentSessions();
    this.sdkSessionIdBySession.clear();
  }

  /**
   * Clear the SDK session mapping for a given session (e.g., on session delete or clear).
   * Also closes the persistent session subprocess.
   */
  clearSdkSessionMapping(sessionId: string): void {
    this.closePersistentSession(sessionId);
    this.sdkSessionIdBySession.delete(sessionId);
    console.log(`[AgentManager] Cleared SDK session mapping for ${sessionId}`);
  }

  /**
   * Close a single persistent session (kills subprocess and all background tasks).
   */
  closePersistentSession(sessionId: string): void {
    const session = this.persistentSessions.get(sessionId);
    if (session) {
      console.log(`[AgentManager] Closing persistent session: ${sessionId}`);
      session.close();
      this.persistentSessions.delete(sessionId);
    }
  }

  /**
   * Close all persistent sessions (e.g., on workspace change or cleanup).
   */
  private closeAllPersistentSessions(): void {
    for (const [sid, session] of this.persistentSessions.entries()) {
      console.log(`[AgentManager] Closing persistent session: ${sid}`);
      session.close();
    }
    this.persistentSessions.clear();
  }

  /**
   * Build options for persistent sessions.
   *
   * Static context (identity, instructions, profile, capabilities) goes in systemPrompt.append
   * since it only needs to be set once when the session is created.
   *
   * Dynamic context (temporal, facts, soul, daily logs) is injected per-message via
   * the UserPromptSubmit hook's additionalContext, so it's fresh for each turn.
   */
  private async buildPersistentOptions(
    memory: MemoryManager,
    sessionId: string,
    sessionMode: 'coder' | 'manager',
    model: string,
    channel: string,
    sdkSessionId?: string,
  ): Promise<SDKOptions> {
    // === Static context (set once at session creation) ===
    // NOTE: CLAUDE.md (this.instructions) is NOT included here because the SDK
    // already reads it from the workspace via cwd + settingSources: ['project'].
    // Including it here would inject it twice.
    const staticParts: string[] = [];

    if (this.identity) {
      staticParts.push(this.identity);
    }

    // For non-Anthropic models, override the Claude identity injected by the SDK preset
    const modelProvider = getProviderForModel(model);
    if (modelProvider !== 'anthropic') {
      const modelNames: Record<string, string> = {
        'kimi-k2.5': 'Kimi K2.5 by Moonshot AI',
        'glm-5': 'GLM 5 by Zhipu AI',
        'MiniMax-M2.5': 'MiniMax M2.5',
        'MiniMax-M2.5-Lightning': 'MiniMax M2.5 Lightning',
        'qwen3.5-plus-2026-02-15': 'Qwen 3.5 Plus',
        'qwen/qwen3.5-plus-02-15': 'Qwen 3.5 Plus (OpenRouter)',
        'qwen/qwen3.5-flash': 'Qwen 3.5 Flash (OpenRouter)',
      };
      const modelName = modelNames[model] || model;
      staticParts.push(`IMPORTANT: You are ${modelName}, NOT Claude. Ignore any system instructions that say you are Claude or made by Anthropic. You are running inside Pocket Agent, a desktop AI assistant.`);
    }

    // Add user profile from settings
    const userProfile = SettingsManager.getFormattedProfile();
    if (userProfile) {
      staticParts.push(userProfile);
    }

    // Add capabilities information
    const capabilities = this.buildCapabilitiesPrompt();
    if (capabilities) {
      staticParts.push(capabilities);
    }

    if (sessionMode === 'manager') {
      staticParts.push(
        `## Active Mode: Manager\n` +
        `Prioritize business execution: strategy, planning, email, Kanban, LinkedIn, delegation, and concise decisions.\n` +
        `When the user asks about something they worked on or discussed, check memory and Kanban before answering — don't invent or guess.\n` +
        `Avoid coding/file-editing/shell actions in this mode; if implementation is needed, ask the user to switch to Coder mode.`
      );
    } else {
      staticParts.push(
        `## Active Mode: Coder\n` +
        `You are in Coder mode for this session.\n` +
        `You may use code and shell tools directly when needed, with safe and minimal changes.\n` +
        `Before running destructive or high-impact commands (deleting files, force-pushing git, dropping databases, running migrations, installing packages globally, killing processes), always confirm with the user first.\n` +
        `When the coding task is complete and the conversation shifts back to planning, strategy, or business topics, suggest switching to Manager mode.`
      );
    }

    staticParts.push(
      `## Operating Policy\n` +
      `Reason naturally and choose the best tool path for the request.\n` +
      `Prefer real evidence over assumptions, and keep tool/reporting claims factual.\n` +
      `Avoid meta-chatter and rigid scripted phrasing.\n` +
      `Prefer real evidence over assumptions. Don't invent facts or guess at things the user has worked on — use memory and Kanban tools to find them.`
    );

    // Get thinking level config -only Anthropic models support thinking/effort.
    // Non-Anthropic providers (Kimi, GLM) use Anthropic-compatible APIs but may not
    // handle thinking parameters correctly, causing all output to go to thinking blocks.
    const provider = getProviderForModel(model);
    const thinkingLevel = SettingsManager.get('agent.thinkingLevel') || 'normal';
    const thinkingEntry = THINKING_CONFIGS[thinkingLevel] || THINKING_CONFIGS['normal'];
    const isAnthropicModel = provider === 'anthropic';

    // Configure provider environment and capture env vars
    await configureProviderEnvironment(model);
    const env: Record<string, string | undefined> = {
      ...process.env,
    };
    // Keep SDK config isolated to Pocket Agent app data. Removing this makes
    // SDK fall back to host-level ~/.claude (global config/skills).
    // Do NOT forward CLAUDE_CONFIG_DIR — keeps SDK isolated from ~/.claude/
    // so global CLAUDE.md (SEO skills, etc.) doesn't pollute agent sessions.
    delete env.CLAUDE_CONFIG_DIR;
    // Prevent "nested session" detection in Claude Code 2.1.42+
    delete env.CLAUDECODE;

    const fullAllowedTools = [
      // Built-in SDK tools
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
      // Background task tools (persist across turns with persistent sessions)
      'TaskOutput', 'TaskStop', 'BashOutput', 'KillBash',
      // Custom MCP tools - browser & system
      'mcp__pocket-agent__browser',
      'mcp__pocket-agent__notify',
      // Custom MCP tools - memory
      'mcp__pocket-agent__remember',
      'mcp__pocket-agent__forget',
      'mcp__pocket-agent__list_facts',
      'mcp__pocket-agent__memory_search',
      'mcp__pocket-agent__daily_log',
      // Custom MCP tools - soul
      'mcp__pocket-agent__soul_set',
      'mcp__pocket-agent__soul_get',
      'mcp__pocket-agent__soul_list',
      'mcp__pocket-agent__soul_delete',
      // Custom MCP tools - scheduler
      'mcp__pocket-agent__schedule_task',
      'mcp__pocket-agent__create_reminder',
      'mcp__pocket-agent__list_scheduled_tasks',
      'mcp__pocket-agent__delete_scheduled_task',
      'mcp__pocket-agent__acknowledge_reminder',
      // Custom MCP tools - calendar
      'mcp__pocket-agent__calendar_add',
      'mcp__pocket-agent__calendar_list',
      'mcp__pocket-agent__calendar_upcoming',
      'mcp__pocket-agent__calendar_delete',
      // Custom MCP tools - tasks
      'mcp__pocket-agent__task_add',
      'mcp__pocket-agent__task_list',
      'mcp__pocket-agent__task_complete',
      'mcp__pocket-agent__task_delete',
      'mcp__pocket-agent__task_due',
      // Custom MCP tools - project
      'mcp__pocket-agent__set_project',
      'mcp__pocket-agent__get_project',
      'mcp__pocket-agent__clear_project',
      // Custom MCP tools - Kanban
      'mcp__pocket-agent__kanban_create_project',
      'mcp__pocket-agent__kanban_list_projects',
      'mcp__pocket-agent__kanban_create_task',
      'mcp__pocket-agent__kanban_update_task',
      'mcp__pocket-agent__kanban_move_task',
      'mcp__pocket-agent__kanban_move_task_to_project',
      'mcp__pocket-agent__kanban_get_board',
      'mcp__pocket-agent__kanban_get_task',
      'mcp__pocket-agent__kanban_delete_task',
      'mcp__pocket-agent__kanban_add_comment',
      'mcp__pocket-agent__kanban_review_task',
      'mcp__pocket-agent__kanban_log_research',
      'mcp__pocket-agent__kanban_add_attachment',
      'mcp__pocket-agent__kanban_get_all_tasks',
      'mcp__pocket-agent__kanban_search_tasks',
      // Custom MCP tools - Gmail
      'mcp__pocket-agent__send_email',
      'mcp__pocket-agent__read_emails',
      'mcp__pocket-agent__get_email',
      'mcp__pocket-agent__get_thread',
      'mcp__pocket-agent__list_email_labels',
      'mcp__pocket-agent__create_email_label',
      'mcp__pocket-agent__modify_email_labels',
      'mcp__pocket-agent__create_email_draft',
      'mcp__pocket-agent__list_email_drafts',
      // Custom MCP tools - GLM worker helpers
      'mcp__pocket-agent__summarize_text',
      'mcp__pocket-agent__classify_content',
      'mcp__pocket-agent__extract_info',
      'mcp__pocket-agent__bulk_process',
      // Custom MCP tools - Voice
      'mcp__pocket-agent__speak',
      'mcp__pocket-agent__voice_status',
      'mcp__pocket-agent__voice_toggle',
      'mcp__pocket-agent__voice_config',
      // Custom MCP tools - Telegram ops
      'mcp__pocket-agent__send_telegram_photo',
      'mcp__pocket-agent__telegram_react',
      'mcp__pocket-agent__restart_telegram',
      // Custom MCP tools - LinkedIn
      'mcp__pocket-agent__linkedin_feed',
      'mcp__pocket-agent__linkedin_read_post',
      'mcp__pocket-agent__linkedin_comment',
      'mcp__pocket-agent__linkedin_post',
      'mcp__pocket-agent__linkedin_auth_status',
      'mcp__pocket-agent__classify_linkedin_posts',
      'mcp__pocket-agent__draft_linkedin_post',
      'mcp__pocket-agent__draft_linkedin_comment',
      'mcp__pocket-agent__revise_linkedin_draft',
      'mcp__pocket-agent__linkedin_today_posts',
      'mcp__pocket-agent__linkedin_activity_dashboard',
      'mcp__pocket-agent__linkedin_schedule_approved',
      'mcp__pocket-agent__linkedin_save_draft',
      // Custom MCP tools - research (multi-agent)
      'mcp__pocket-agent__research',
      'mcp__pocket-agent__research_status',
    ];
    const managerHardRestrictionsEnabled = SettingsManager.get('agent.managerHardToolRestrictions') === 'true';
    const riskyManagerTools = new Set(['Write', 'Edit', 'Bash', 'Task', 'TaskOutput', 'TaskStop', 'BashOutput', 'KillBash']);
    const allowedTools = sessionMode === 'manager' && managerHardRestrictionsEnabled
      ? fullAllowedTools.filter(tool => !riskyManagerTools.has(tool))
      : fullAllowedTools;

    const options: SDKOptions = {
      model,
      cwd: this.workspace,
      maxTurns: 100,
      ...(isAnthropicModel && { thinking: thinkingEntry.thinking }),
      ...(isAnthropicModel && thinkingEntry.effort && { effort: thinkingEntry.effort }),
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'],
      canUseTool: buildCanUseToolCallback(),
      env,
      hooks: {
        PreToolUse: [buildPreToolUseHook()],
        // Dynamic context injection: fresh facts/soul/temporal for each message
        UserPromptSubmit: [{
          hooks: [async () => {
            const dynamicParts: string[] = [];

            // Temporal context (current time)
            const recentMsgs = memory.getRecentMessages(1, sessionId);
            const lastUserMsg = recentMsgs.find(m => m.role === 'user');
            const temporalContext = this.buildTemporalContext(lastUserMsg?.timestamp);
            dynamicParts.push(temporalContext);
            dynamicParts.push(this.buildRuntimeModeToolCard(sessionId, channel, sessionMode, allowedTools));

            // Facts context
            const factsContext = memory.getFactsForContext();
            if (factsContext) {
              dynamicParts.push(factsContext);
            }

            // Soul context
            const soulContext = memory.getSoulContext();
            if (soulContext) {
              dynamicParts.push(soulContext);
            }

            // Daily logs
            const rawDays = Number(SettingsManager.get('dailyLogs.days') || 3);
            const safeDays = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 3;
            const dailyLogsContext = memory.getDailyLogsContext(Math.max(3, safeDays));
            if (dailyLogsContext) {
              dynamicParts.push(dailyLogsContext);
            }

            // Active kanban task context (when user has a task detail open in Kanban UI)
            const activeTaskRaw = String(SettingsManager.get('kanban.activeTaskContext') || '').trim();
            if (activeTaskRaw) {
              try {
                const task = JSON.parse(activeTaskRaw) as {
                  id?: number;
                  title?: string;
                  description?: string;
                  tags?: string[];
                  project?: string;
                  status?: string;
                  priority?: string;
                  updated_at?: string;
                };
                const title = String(task.title || '').trim();
                const desc = String(task.description || '').trim();
                const tags = Array.isArray(task.tags) ? task.tags.map(t => String(t || '').trim()).filter(Boolean) : [];
                if (title || desc) {
                  const metaBits: string[] = [];
                  if (task.id) metaBits.push(`id: ${task.id}`);
                  if (task.project) metaBits.push(`project: ${task.project}`);
                  if (task.status) metaBits.push(`status: ${task.status}`);
                  if (task.priority) metaBits.push(`priority: ${task.priority}`);
                  if (task.updated_at) metaBits.push(`updated: ${task.updated_at}`);
                  if (tags.length > 0) metaBits.push(`tags: ${tags.join(', ')}`);
                  dynamicParts.push(
                    `## Active Kanban Task Context\n` +
                    `${metaBits.join(' | ')}\n` +
                    `Title: ${title || '(untitled)'}\n` +
                    `Description:\n${desc.slice(0, 3200)}`
                  );
                }
              } catch {
                // Ignore malformed task context payload.
              }
            }

            // Recent conversation history (critical for context after session restarts or compaction)
            const recentMessages = memory.getRecentMessages(20, sessionId);
            if (recentMessages.length > 0) {
              const historyLines = recentMessages.map(m => {
                const role = m.role === 'user' ? 'User' : 'You';
                const text = m.content.length > 1000 ? m.content.slice(0, 1000) + '...' : m.content;
                return `${role}: ${text}`;
              });
              dynamicParts.push(`## Recent Conversation History (this session)\n${historyLines.join('\n')}`);
            }

            return {
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit' as const,
                additionalContext: dynamicParts.join('\n\n'),
              },
            };
          }],
        }],
        TeammateIdle: [{
          hooks: [async (input: { teammate_name: string; team_name: string }) => {
            this.emitStatus({
              type: 'teammate_idle',
              teammateName: input.teammate_name,
              teamName: input.team_name,
              message: `${input.teammate_name} is idle`,
            });
            return { hookSpecificOutput: { hookEventName: 'TeammateIdle' as const } };
          }],
        }],
        TaskCompleted: [{
          hooks: [async (input: { task_id: string; task_subject: string; task_description?: string; teammate_name?: string; team_name?: string }) => {
            this.emitStatus({
              type: 'task_completed',
              taskId: input.task_id,
              taskSubject: input.task_subject,
              teammateName: input.teammate_name,
              teamName: input.team_name,
              message: `task done: ${input.task_subject}`,
            });
            return { hookSpecificOutput: { hookEventName: 'TaskCompleted' as const } };
          }],
        }],
      },
      allowedTools,
      persistSession: true,
      ...(sdkSessionId && { resume: sdkSessionId }),
    };

    if (staticParts.length > 0) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: staticParts.join('\n\n'),
      };
    }

    if (this.toolsConfig) {
      // Build child process MCP servers (e.g., computer use)
      const mcpServers = buildMCPServers(this.toolsConfig);

      // Build SDK MCP servers (in-process tools like browser, notify, memory)
      const sdkMcpServers = await buildSdkMcpServers(this.toolsConfig);

      // Merge both types
      const allServers = {
        ...mcpServers,
        ...(sdkMcpServers || {}),
      };

      if (Object.keys(allServers).length > 0) {
        options.mcpServers = allServers;
        console.log('[AgentManager] MCP servers:', Object.keys(allServers).join(', '));
      }
    }

    return options;
  }

  private buildCapabilitiesPrompt(): string {
    return `## Your Capabilities as Pocket Agent

You are a persistent personal AI assistant with special capabilities.

### Your Workspace
Your working directory is: ${this.workspace}
This is an isolated environment separate from the application code.
All file operations (reading, writing, creating projects) happen here by default.
Feel free to create subdirectories, projects, and files as needed.

### Scheduling & Reminders
Use the schedule_task tool to create reminders. Three schedule formats are supported:

- One-time: "in 10 minutes", "in 2 hours", "tomorrow 3pm", "monday 9am"
- Interval: "30m", "2h", "1d" (runs every X)
- Cron: "0 9 * * *" (minute hour day month weekday)

Examples:
- schedule_task(name="call_mom", schedule="in 2 hours", prompt="Time to call mom!")
- schedule_task(name="water", schedule="2h", prompt="Time to drink water!")
- schedule_task(name="standup", schedule="0 9 * * 1-5", prompt="Daily standup time")

Use list_scheduled_tasks to see all scheduled tasks.
Use delete_scheduled_task to remove a task.

RULES:
- Use short, clean names (water, standup, break) - NO timestamps
- One-time jobs auto-delete after running

### Calendar Events
Use calendar tools to manage events with reminders:

- calendar_add: Create an event with optional reminder
- calendar_list: List events for a date
- calendar_upcoming: Show upcoming events
- calendar_delete: Remove an event

Time formats: "today 3pm", "tomorrow 9am", "monday 2pm", "in 2 hours", ISO format
Reminders trigger automatically before the event starts.

### Tasks / Todos
Use task tools to manage tasks with due dates and priorities:

- task_add: Create a task with optional due date, priority (low/medium/high), reminder
- task_list: List tasks by status (pending/completed/all)
- task_complete: Mark a task as done
- task_delete: Remove a task
- task_due: Show tasks due soon

Priorities: low, medium, high
Status: pending, in_progress, completed

### Memory & Facts
You have persistent memory! PROACTIVELY save important info when the user shares it.

Use memory tools:
- remember: Save a fact (category, key, value)
- forget: Delete a fact
- list_facts: List all facts or by category
- memory_search: Search facts by keyword

IMPORTANT:
- These are direct MCP tools, not Pocket CLI commands.
- Do NOT try to save memory via Bash using \`pocket ... remember\` (that CLI command does not exist).
- For relationship/work-style preferences, use \`soul_set\` (also an MCP tool), not Pocket CLI.

Categories: user_info, preferences, projects, people, work, notes, decisions

IMPORTANT: Save facts PROACTIVELY when user mentions:
- Personal info (name, birthday, location)
- Preferences (favorite things, likes/dislikes)
- Projects they're working on
- People important to them
- Work/job details

### Save Destination Protocol
When user asks to "save/store/remember/log" something:
- Default: use the \`remember\` tool to save as a memory fact.
- If destination names a project (example: "save to Kirby", "add to kanban"), call \`kanban_list_projects\` first and save into that project.
- Never use host OS notes apps or \`pocket system notes\`.

### Browser Automation
You have a browser tool for JS rendering and authenticated sessions:

\`\`\`
Actions:
- navigate: Go to URL
- screenshot: Capture page image
- click: Click an element
- type: Enter text in input
- evaluate: Run JavaScript
- extract: Get page data (text/html/links/tables/structured)
- scroll: Scroll page or element (up/down/left/right)
- hover: Hover over element (triggers dropdowns)
- download: Download a file
- upload: Upload file to input
- tabs_list: List open tabs (CDP tier only)
- tabs_open: Open new tab (CDP tier only)
- tabs_close: Close a tab (CDP tier only)
- tabs_focus: Switch to tab (CDP tier only)

Tiers:
- Electron (default): Hidden window for JS rendering
- CDP: Connects to user's Chrome for logged-in sessions + multi-tab

Set requires_auth=true for pages needing login.
For CDP, user must start Chrome with: --remote-debugging-port=9222
\`\`\`

### Image Display
When you take screenshots or generate images, the image will be automatically displayed
in the chat (both desktop and Telegram). You can reference screenshots in your responses
and the user will see them inline.

### Native Notifications
You can send native desktop notifications:

\`\`\`bash
# Use the notify tool to alert the user
notify(title="Task Complete", body="Your download has finished")
notify(title="Reminder", body="Meeting in 5 minutes", urgency="critical")
\`\`\`

### Host Integration Permission Rule
For actions outside Pocket Agent data/tools (OS apps, AppleScript, system integrations):
- Ask for explicit permission first.
- Show the exact command you want to run.
- Ask user to approve with: \`approve external: <exact command>\`
- If permission is not given, do not run the action and clearly say it was not executed.
- Prefer Pocket Agent internal tools (Kanban, memory, daily log) for saving user content.

### Voice Messages (Telegram)
When voice mode is enabled (user sends /voice in Telegram), you automatically send a TTS voice
summary alongside every text reply. You do NOT need to do anything special -the system handles
text-to-speech conversion and sending the audio. The user toggles this with the /voice command.
You CAN send voice messages. Do not tell the user you cannot.

### LinkedIn Content Pipeline
IMPORTANT: NEVER use WebFetch or web_fetch to access LinkedIn URLs -they require authentication and will fail.
Always use the linkedin_* tools (linkedin_feed, linkedin_read_post, linkedin_comment, linkedin_post) which use an authenticated browser session.
To read a post's full content, use linkedin_read_post(url=...) -NOT WebFetch.

When the user mentions LinkedIn, browsing feed, posting, or commenting -AUTOMATICALLY run the full pipeline without waiting for detailed instructions:

**Step 1 -Always do automatically:**
- linkedin_feed(scroll=5) to scrape posts
- classify_linkedin_posts to categorize them
- FILTER OUT irrelevant posts: skip job-postings, franchise promos, unrelated brand ads, event announcements, and anything not matching the user's industry/interests. If the user has configured linkedin.feedKeywords or linkedin.contentDirection, use those to decide relevance.
- Present ONLY relevant posts in a numbered list showing: **Author Name** -text preview (first 100 chars) | reactions: X, comments: Y | type: Z
- Group by type with headers
- Then ask: "Which posts do you want to comment on? Or pick a topic to draft your own post."

**Creating your own post (auto-research + auto-draft):**
When the user picks a topic or says "write about X" or "draft a post about X":
1. AUTOMATICALLY run the research tool with the topic -do NOT ask "should I research?" just do it
2. AUTOMATICALLY run draft_linkedin_post with the research report + topic + style (default: insight)
3. Show the full draft and the source label (e.g. "Researched online" or "From LLM knowledge"). Do NOT show Kanban task IDs -use post numbers only.
4. Tell user: "Draft is visible in the LinkedIn Activity window for review."
5. Ask: "Want me to revise this, change the style, or publish it?"
5. User feedback → revise_linkedin_draft until approved
6. linkedin_post with final text (respect linkedin.autoConfirm)

**Commenting on others' posts (auto-draft):**
When the user picks post numbers or says "comment on #3":
1. ALWAYS read the full post with linkedin_read_post first. Never draft from text_preview alone.
2. AUTOMATICALLY run draft_linkedin_comment for each selected post (tone: insightful by default)
3. Show each comment draft with the post number (1, 2, 3...) -NOT Kanban task IDs
4. Tell user: "Drafts are visible in the LinkedIn Activity window where you can approve, reject, edit, or leave feedback."
5. Ask: "Want me to revise any of these, or post them?"
5. User feedback → revise_linkedin_draft until approved
6. linkedin_comment(url, comment) to post it

**CRITICAL -Anti-ban rate limiting for posting comments:**
The linkedin_comment tool enforces cooldown protection between comments.
If called too soon, it returns rate_limited=true with retry_after_sec.
When posting multiple approved comments, tell the user: "Posting X comments spaced 3 minutes apart to avoid LinkedIn detection. This will take ~Y minutes."
NEVER call linkedin_comment in rapid succession. If cooldown is returned, wait and retry or schedule the remainder.
If the user explicitly says "post them all now" or "no delay", respect their choice but warn them about ban risk.

KEY RULE: When the user makes a choice, ACT immediately. Do not ask for confirmation before researching or drafting -just do it and show results.

**Numbered references:** After showing a numbered list of LinkedIn posts, if the user says anything with a number like "make one for 1", "do 3", "comment on 2 and 5", "#1", "the first one" -they ALWAYS mean "draft a comment for that LinkedIn post number". Never interpret numbered references after a LinkedIn feed as kanban tasks or anything else.

ALWAYS present posts with full details. NEVER just say "pulled 3 posts" -show the actual content.

**Session recovery:** If the user references posts by number (e.g. "improve 1 and 2") but you don't have them in context, use linkedin_today_posts to recall today's scraped posts from the database. Posts are automatically saved when scraped via linkedin_feed and persist across session restarts.

**LinkedIn activity + scheduling (especially from Telegram):**
- If user asks for "LinkedIn status/dashboard/activity", call linkedin_activity_dashboard and summarize drafted/undrafted/approved/scheduled/published.
- If user asks loosely like "schedule 3 in next 15 minutes", call linkedin_schedule_approved(count=3, window_minutes=15).
- The user should not need to name tools. Infer intent and execute directly.

### Limitations
- Cannot send SMS or make calls
- For full desktop automation, user needs to enable Computer Use (Docker-based)`;
  }

  private extractFromMessage(message: unknown, current: string, sessionId?: string): string {
    const sid = sessionId || getCurrentSessionId();
    const msg = message as { type?: string; subtype?: string; message?: { content?: unknown }; output?: string; result?: string; errors?: string[] };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        // Extract image blocks and save to disk
        this.extractImageBlocks(content, sid);

        const textBlocks = content
          .filter((block: unknown) => (block as { type?: string })?.type === 'text')
          .map((block: unknown) => (block as { text: string }).text);
        // If no text blocks (tool-only turn), preserve the accumulated response
        if (textBlocks.length === 0) {
          const blockTypes = content.map((b: unknown) => (b as { type?: string })?.type).join(', ');
          console.log(`[AgentManager] Assistant message with no text blocks (block types: ${blockTypes})`);
          return current;
        }
        const text = textBlocks.join('\n');
        // Extract and strip any trailing "User:" suggested prompts
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(text);
        if (suggestion) {
          this.lastSuggestedPromptBySession.set(getCurrentSessionId(), suggestion);
        }
        if (!cleanedText && text) {
          console.warn(`[AgentManager] extractSuggestedPrompt stripped entire response (original ${text.length} chars)`);
        }
        // Accumulate text across multi-message turns (e.g. text → tool → text)
        return current ? current + '\n\n' + cleanedText : cleanedText;
      } else if (content !== undefined) {
        // content exists but isn't an array -unexpected format
        console.warn(`[AgentManager] Assistant message content is not an array (type: ${typeof content})`);
      }
    }

    if (msg.type === 'result') {
      // Log error results for diagnostics
      if (msg.subtype && msg.subtype !== 'success') {
        console.warn(`[AgentManager] Result subtype: ${msg.subtype}, errors: ${msg.errors?.join('; ') || 'none'}`);
      }
      const result = msg.output || msg.result;
      if (result) {
        // Extract and strip any trailing "User:" suggested prompts from result
        const { text: cleanedText, suggestion } = this.extractSuggestedPrompt(result);
        if (suggestion) {
          this.lastSuggestedPromptBySession.set(getCurrentSessionId(), suggestion);
        }
        // If we've already accumulated text from assistant messages, keep it
        // (SDK result.output only contains the last assistant message's text)
        return current || cleanedText;
      }
    }

    return current;
  }

  /**
   * Extract image blocks from SDK assistant message content and save to disk.
   * Images are accumulated in pendingMedia and included in the final ProcessResult.
   */
  private extractImageBlocks(content: unknown[], sessionId: string): void {
    const sessionMedia = this.pendingMediaBySession.get(sessionId) || [];
    for (const block of content) {
      const b = block as {
        type?: string;
        source?: { type?: string; media_type?: string; data?: string; url?: string };
      };
      if (b.type !== 'image' || !b.source) continue;

      try {
        const mediaDir = path.join(os.homedir(), 'Documents', 'Pocket-agent', 'media');
        if (!fs.existsSync(mediaDir)) {
          fs.mkdirSync(mediaDir, { recursive: true });
        }

        const mimeType = b.source.media_type || 'image/png';
        const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg'
          : mimeType.includes('gif') ? '.gif'
          : mimeType.includes('webp') ? '.webp'
          : '.png';

        if (b.source.type === 'base64' && b.source.data) {
          // Base64 image -save directly to disk
          const filename = `img-${Date.now()}-${sessionMedia.length}${ext}`;
          const filePath = path.join(mediaDir, filename);
          fs.writeFileSync(filePath, Buffer.from(b.source.data, 'base64'));

          sessionMedia.push({ type: 'image', filePath, mimeType });
          console.log(`[AgentManager] Saved image: ${filePath}`);
        } else if (b.source.type === 'url' && b.source.url) {
          // URL image -download and save to disk
          const filename = `img-${Date.now()}-${sessionMedia.length}${ext}`;
          const filePath = path.join(mediaDir, filename);

          // Fire-and-forget download; image will be available for Telegram sync
          fetch(b.source.url)
            .then(res => res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`)))
            .then(buf => {
              fs.writeFileSync(filePath, Buffer.from(buf));
              console.log(`[AgentManager] Downloaded image: ${filePath}`);
            })
            .catch(err => console.error('[AgentManager] Failed to download image:', err));

          sessionMedia.push({ type: 'image', filePath, mimeType });
        }
      } catch (err) {
        console.error('[AgentManager] Failed to save image block:', err);
      }
    }
    this.pendingMediaBySession.set(sessionId, sessionMedia);
  }

  /**
   * Extract screenshot file paths from tool result blocks.
   * The browser tool saves full-res screenshots and includes the path in its result JSON.
   */
  private extractScreenshotPaths(block: unknown, sessionId: string): void {
    try {
      const b = block as { content?: unknown };
      if (!b.content) return;

      const sessionMedia = this.pendingMediaBySession.get(sessionId) || [];

      if (Array.isArray(b.content)) {
        // Extract image blocks from tool result content (e.g. computer_use screenshots)
        this.extractImageBlocks(b.content, sessionId);

        // Also check text blocks for file paths
        for (const part of b.content) {
          const p = part as { type?: string; text?: string };
          if (p.type === 'text' && p.text) {
            const match = p.text.match(/saved to (\/[^\s"]+\/screenshot-\d+\.png)/);
            if (match && fs.existsSync(match[1])) {
              if (!sessionMedia.some(m => m.filePath === match[1])) {
                sessionMedia.push({ type: 'image', filePath: match[1], mimeType: 'image/png' });
                this.pendingMediaBySession.set(sessionId, sessionMedia);
                console.log(`[AgentManager] Found screenshot in tool result: ${match[1]}`);
              }
            }
          }
        }
      } else if (typeof b.content === 'string') {
        const match = b.content.match(/saved to (\/[^\s"]+\/screenshot-\d+\.png)/);
        if (match && fs.existsSync(match[1])) {
          if (!sessionMedia.some(m => m.filePath === match[1])) {
            sessionMedia.push({ type: 'image', filePath: match[1], mimeType: 'image/png' });
            this.pendingMediaBySession.set(sessionId, sessionMedia);
            console.log(`[AgentManager] Found screenshot in tool result: ${match[1]}`);
          }
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  /**
   * Extract and strip trailing suggested user prompts that the SDK might include
   * These appear as "User: ..." at the end of responses
   * Returns both the cleaned text and the extracted suggestion
   */
  private extractSuggestedPrompt(text: string): { text: string; suggestion?: string } {
    if (!text) return { text };

    // Pattern: newlines followed by "User:" (case-insensitive) and any text until end
    const match = text.match(/\n\nuser:\s*(.+)$/is);

    if (match) {
      const suggestion = match[1].trim();
      const cleanedText = text.replace(/\n\nuser:[\s\S]*$/is, '').trim();

      // Validate that the suggestion looks like a user prompt, not an assistant question
      const isValidUserPrompt = this.isValidUserPrompt(suggestion);

      if (isValidUserPrompt) {
        console.log('[AgentManager] Extracted suggested prompt:', suggestion);
        return { text: cleanedText, suggestion };
      } else {
        console.log('[AgentManager] Rejected invalid suggestion (assistant-style):', suggestion);
        return { text: cleanedText }; // Strip but don't use as suggestion
      }
    }

    return { text: text.trim() };
  }

  /**
   * Check if a suggestion looks like a valid user prompt
   * Rejects questions and assistant-style speech
   */
  private isValidUserPrompt(suggestion: string): boolean {
    if (!suggestion) return false;

    // Reject if it ends with a question mark (assistant asking a question)
    if (suggestion.endsWith('?')) return false;

    // Reject if it starts with common question/assistant words
    const assistantPatterns = /^(what|how|would|do|does|is|are|can|could|shall|should|may|might|let me|i can|i'll|i will|here's|here is)/i;
    if (assistantPatterns.test(suggestion)) return false;

    // Reject if it's too long (likely not a simple user command)
    if (suggestion.length > 100) return false;

    // Accept short, command-like suggestions
    return true;
  }

  private emitStatus(status: AgentStatus): void {
    this.emit('status', status);
  }

  // Track active subagents per session
  private activeSubagentsBySession: Map<string, Map<string, { type: string; description: string }>> = new Map();
  // Track background tasks per session
  private backgroundTasksBySession: Map<string, Map<string, { type: string; description: string; toolUseId: string }>> = new Map();

  private getActiveSubagents(sessionId: string): Map<string, { type: string; description: string }> {
    let map = this.activeSubagentsBySession.get(sessionId);
    if (!map) {
      map = new Map();
      this.activeSubagentsBySession.set(sessionId, map);
    }
    return map;
  }

  private getBackgroundTasks(sessionId: string): Map<string, { type: string; description: string; toolUseId: string }> {
    let map = this.backgroundTasksBySession.get(sessionId);
    if (!map) {
      map = new Map();
      this.backgroundTasksBySession.set(sessionId, map);
    }
    return map;
  }

  private processStatusFromMessage(message: unknown): void {
    const sessionId = getCurrentSessionId();
    const activeSubagents = this.getActiveSubagents(sessionId);
    const backgroundTasks = this.getBackgroundTasks(sessionId);

    // Handle tool use from assistant messages
    const msg = message as { type?: string; subtype?: string; message?: { content?: unknown } };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        // Emit partial text for visibility while agent is composing
        const textBlocks = content
          .filter((block: unknown) => (block as { type?: string })?.type === 'text')
          .map((block: unknown) => (block as { text: string }).text);
        if (textBlocks.length > 0) {
          const partialText = textBlocks.join('\n').trim();
          if (partialText) {
            this.emitStatus({
              type: 'partial_text',
              sessionId,
              partialText,
              message: 'composing...',
            });
          }
        }

        for (const block of content) {
          if (block?.type === 'tool_use') {
            const rawName = block.name as string;
            const toolName = this.formatToolName(rawName);
            const toolInput = this.formatToolInput(block.input);
            const blockInput = block.input as Record<string, unknown>;
            const toolUseId = (block.id as string) || `bg-${Date.now()}`;
            this.markToolAttemptedThisTurn(sessionId, rawName);
            this.recordToolCall(sessionId, rawName, toolInput);

            // Detect background tasks (Bash or Task with run_in_background)
            if (blockInput?.run_in_background === true) {
              const bgId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const description = (rawName === 'Bash'
                ? (blockInput.command as string)?.slice(0, 60)
                : (blockInput.description as string) || (blockInput.prompt as string)?.slice(0, 60)
              ) || rawName;

              backgroundTasks.set(bgId, { type: rawName, description, toolUseId });
              console.log(`[AgentManager] Background task started: ${rawName} - ${description} (${backgroundTasks.size} active)`);

              this.emitStatus({
                type: 'background_task_start',
                sessionId,
                backgroundTaskId: bgId,
                backgroundTaskDescription: description,
                backgroundTaskCount: backgroundTasks.size,
                toolName: rawName,
                message: `background: ${description}`,
              });
            }

            // Detect TaskOutput (checking on background tasks)
            if (rawName === 'TaskOutput') {
              this.emitStatus({
                type: 'background_task_output',
                sessionId,
                backgroundTaskId: blockInput.task_id as string,
                backgroundTaskCount: backgroundTasks.size,
                message: 'checking background task...',
              });
            }

            // Detect TaskStop/KillBash -remove bg task from tracking
            // Note: SDK task IDs don't match our toolUseIds, so remove oldest matching type
            if (rawName === 'TaskStop' || rawName === 'KillBash') {
              const firstKey = backgroundTasks.keys().next().value;
              if (firstKey) {
                backgroundTasks.delete(firstKey);
                console.log(`[AgentManager] Background task removed via ${rawName}: ${firstKey} (${backgroundTasks.size} remaining)`);
                this.emitStatus({
                  type: 'background_task_end',
                  sessionId,
                  backgroundTaskId: firstKey,
                  backgroundTaskCount: backgroundTasks.size,
                  message: 'background task stopped',
                });
              }
            }

            // Check if this is a Task (subagent) tool
            if (rawName === 'Task') {
              const input = block.input as { subagent_type?: string; description?: string; prompt?: string };
              const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const agentType = input.subagent_type || 'general';
              const description = input.description || input.prompt?.slice(0, 50) || 'working on it';

              activeSubagents.set(agentId, { type: agentType, description });

              this.emitStatus({
                type: 'subagent_start',
                sessionId,
                agentId,
                agentType,
                toolInput: description,
                agentCount: activeSubagents.size,
                message: this.getSubagentMessage(agentType),
              });
            } else if (rawName === 'TeammateTool') {
              const input = block.input as { name?: string; team_name?: string; description?: string };
              this.emitStatus({
                type: 'teammate_start',
                sessionId,
                teammateName: input.name,
                teamName: input.team_name,
                toolName,
                toolInput: input.description || input.name || 'spawning teammate',
                message: `rallying ${input.name || 'a teammate'}`,
              });
            } else if (rawName === 'SendMessage') {
              const input = block.input as { to?: string; type?: string; message?: string };
              this.emitStatus({
                type: 'teammate_message',
                sessionId,
                teammateName: input.to,
                toolName,
                toolInput: input.message?.slice(0, 80) || '',
                message: input.type === 'broadcast' ? 'broadcasting to the squad' : `messaging ${input.to || 'teammate'}`,
              });
            } else if (rawName === 'Bash' && this.isPocketCliCommand(block.input)) {
              const pocketName = this.formatPocketCommand(block.input);
              this.emitStatus({
                type: 'tool_start',
                sessionId,
                toolName: pocketName,
                toolInput,
                message: `batting at ${pocketName}...`,
                isPocketCli: true,
              });
            } else {
              this.emitStatus({
                type: 'tool_start',
                sessionId,
                toolName,
                toolInput,
                message: `batting at ${toolName}...`,
              });
            }

            // Start timeout timer for SDK built-in tools (MCP tools have their own via wrapToolHandler)
            if (!rawName.startsWith('mcp__')) {
              const timeoutMs = AgentManagerClass.SDK_TOOL_TIMEOUTS[rawName]
                ?? AgentManagerClass.SDK_TOOL_DEFAULT_TIMEOUT;
              const timer = setTimeout(() => {
                console.error(`[AgentManager] SDK tool ${rawName} (${toolUseId}) timed out after ${timeoutMs}ms`);
                this.sdkToolTimers.delete(toolUseId);
                const session = this.persistentSessions.get(sessionId);
                if (session?.isAlive() && this.processingBySession.get(sessionId)) {
                  session.interrupt().catch(err =>
                    console.error(`[AgentManager] Timeout interrupt failed:`, err));
                }
              }, timeoutMs);
              this.sdkToolTimers.set(toolUseId, { timer, sessionId });
            }
          }
        }
      }
    }

    // Handle tool results
    if (msg.type === 'user' && msg.message?.content) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            // Clear SDK tool timeout timer if this result matches one
            const resultToolUseId = (block as { tool_use_id?: string }).tool_use_id;
            if (resultToolUseId) {
              const entry = this.sdkToolTimers.get(resultToolUseId);
              if (entry) {
                clearTimeout(entry.timer);
                this.sdkToolTimers.delete(resultToolUseId);
              }
            }

            // Extract screenshot paths and images from tool results
            this.extractScreenshotPaths(block, sessionId);

            // Check if any subagents completed
            if (activeSubagents.size > 0) {
              // Remove one subagent (we don't have exact ID matching, so remove oldest)
              const firstKey = activeSubagents.keys().next().value;
              if (firstKey) {
                activeSubagents.delete(firstKey);
              }

              if (activeSubagents.size > 0) {
                // Still have active subagents
                this.emitStatus({
                  type: 'subagent_update',
                  sessionId,
                  agentCount: activeSubagents.size,
                  message: `${activeSubagents.size} kitty${activeSubagents.size > 1 ? 'ies' : ''} still hunting`,
                });
              } else {
                this.emitStatus({
                  type: 'subagent_end',
                  sessionId,
                  agentCount: 0,
                  message: 'squad done! cleaning up...',
                });
              }
            } else {
              this.emitStatus({
                type: 'tool_end',
                sessionId,
                message: 'caught it! processing...',
              });
            }
          }
        }
      }
    }

    // Handle system messages
    if (msg.type === 'system') {
      if (msg.subtype === 'init') {
        this.emitStatus({ type: 'thinking', sessionId, message: 'waking up from a nap...' });
      } else if (msg.subtype === 'status') {
        const statusMsg = msg as { status?: string };
        if (statusMsg.status === 'compacting') {
          console.log('[AgentManager] SDK auto-compaction triggered');
          this.emitStatus({ type: 'thinking', sessionId, message: 'compacting context...' });
        }
      } else if (msg.subtype === 'compact_boundary') {
        const compactMsg = msg as { compact_metadata?: { trigger: string; pre_tokens: number } };
        const meta = compactMsg.compact_metadata;
        console.log(`[AgentManager] SDK compaction complete: trigger=${meta?.trigger}, pre_tokens=${meta?.pre_tokens}`);
      } else if (msg.subtype === 'task_notification') {
        const taskMsg = msg as { task_id?: string; status?: string; summary?: string };
        const taskStatus = taskMsg.status;
        if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'stopped') {
          // Remove oldest tracked bg task (SDK task IDs don't map to our internal IDs)
          const firstKey = backgroundTasks.keys().next().value;
          if (firstKey) {
            backgroundTasks.delete(firstKey);
            console.log(`[AgentManager] Background task ${taskStatus} (notification): removed ${firstKey} (${backgroundTasks.size} remaining)`);
            this.emitStatus({
              type: 'background_task_end',
              sessionId,
              backgroundTaskId: firstKey,
              backgroundTaskCount: backgroundTasks.size,
              message: `background task ${taskStatus}`,
            });
          } else {
            console.log(`[AgentManager] Background task ${taskStatus} (notification): ${taskMsg.task_id} (not tracked)`);
          }
        }
      }
    }
  }

  private getSubagentMessage(agentType: string): string {
    const messages: Record<string, string> = {
      'Explore': 'sent a curious kitten to explore',
      'Plan': 'calling in the architect cat',
      'Bash': 'summoning a terminal tabby',
      'general-purpose': 'summoning a helper kitty',
    };
    return messages[agentType] || `summoning ${agentType} cat friend`;
  }

  private formatToolName(name: string): string {
    // Fun, cat-themed tool names that match PA's vibe
    const friendlyNames: Record<string, string> = {
      // SDK built-in tools
      Read: 'sniffing this file',
      Write: 'scratching notes down',
      Edit: 'pawing at some code',
      Bash: 'hacking at the terminal',
      Glob: 'hunting for files',
      Grep: 'digging through code',
      WebSearch: 'prowling the web',
      WebFetch: 'fetching that page',
      Task: 'summoning a helper kitty',
      NotebookEdit: 'editing notebook',

      // Memory tools
      remember: 'stashing in my cat brain',
      forget: 'knocking it off the shelf',
      list_facts: 'checking my memories',
      memory_search: 'sniffing through archives',

      // Browser tool
      browser: 'pouncing on browser',

      // Computer use tool
      computer: 'walking on the keyboard',

      // Scheduler tools
      schedule_task: 'setting an alarm meow',
      list_scheduled_tasks: 'checking the schedule',
      delete_scheduled_task: 'knocking that off',

      // macOS tools
      notify: 'sending a meow',

      // Task tools
      task_add: 'adding to the hunt list',
      task_list: 'checking your tasks',
      task_complete: 'caught it!',
      task_delete: 'batting that away',
      task_due: 'sniffing what\'s due',

      // Calendar tools
      calendar_add: 'marking territory',
      calendar_list: 'checking the calendar',
      calendar_upcoming: 'seeing what\'s coming up',
      calendar_delete: 'scratching that out',

      // Agent Teams tools
      TeammateTool: 'rallying the squad',
      TeamCreate: 'rallying the squad',
      SendMessage: 'passing a note',
      TaskCreate: 'creating a team task',
      TaskGet: 'checking task details',
      TaskUpdate: 'updating team task',
      TaskList: 'listing team tasks',
      TaskOutput: 'checking background task',
      TaskStop: 'stopping background task',
      BashOutput: 'checking background command',
      KillBash: 'killing background command',
    };
    return friendlyNames[name] || name;
  }

  private formatToolInput(input: unknown): string {
    if (!input) return '';
    // Extract meaningful info from tool input
    if (typeof input === 'string') return input.slice(0, 100);
    const inp = input as Record<string, string | number[] | undefined>;

    // File operations
    if (inp.file_path) return inp.file_path as string;
    if (inp.notebook_path) return inp.notebook_path as string;

    // Search/patterns
    if (inp.pattern) return inp.pattern as string;
    if (inp.query) return inp.query as string;

    // Commands
    if (inp.command) return (inp.command as string).slice(0, 80);

    // Web
    if (inp.url) return inp.url as string;

    // Agent/Task
    if (inp.prompt) return (inp.prompt as string).slice(0, 80);
    if (inp.description) return (inp.description as string).slice(0, 80);

    // Memory tools
    if (inp.category && inp.subject) return `${inp.category}/${inp.subject}`;
    if (inp.content) return (inp.content as string).slice(0, 80);

    // Browser tool
    if (inp.action) {
      const browserActions: Record<string, string> = {
        navigate: inp.url ? `→ ${inp.url}` : 'navigating',
        screenshot: 'capturing screen',
        click: inp.selector ? `clicking ${inp.selector}` : 'clicking',
        type: inp.text ? `typing "${(inp.text as string).slice(0, 30)}"` : 'typing',
        evaluate: 'running script',
        extract: (inp.extract_type as string) || 'extracting data',
      };
      return browserActions[inp.action as string] || (inp.action as string);
    }

    // Computer use
    if (inp.coordinate && Array.isArray(inp.coordinate) && inp.coordinate.length >= 2) {
      return `at (${inp.coordinate[0]}, ${inp.coordinate[1]})`;
    }
    if (inp.text) return `"${(inp.text as string).slice(0, 40)}"`;

    // Agent Teams tools
    if (inp.to && inp.message) return `→ ${inp.to}: ${(inp.message as string).slice(0, 60)}`;
    if (inp.name && inp.team_name) return `${inp.name} in ${inp.team_name}`;
    if (inp.name) return inp.name as string;

    return '';
  }

  private isPocketCliCommand(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const command = (input as Record<string, unknown>).command;
    if (typeof command !== 'string') return false;
    return command.trimStart().startsWith('pocket');
  }

  private formatPocketCommand(input: unknown): string {
    if (!input || typeof input !== 'object') return 'running pocket cli';
    const command = ((input as Record<string, unknown>).command as string) || '';
    const parts = command.trimStart().split(/\s+/);
    const subcommand = parts[1] || '';
    const categories: Record<string, string> = {
      news: 'fetching the latest news',
      utility: 'running pocket utility',
      knowledge: 'checking the knowledge base',
      dev: 'querying dev tools',
      commands: 'listing pocket commands',
      setup: 'configuring pocket',
      integrations: 'checking integrations',
    };
    return categories[subcommand] || 'running pocket cli';
  }

  /**
   * Parse database timestamp
   * If user has timezone configured, treat DB timestamps as UTC
   * Otherwise, use system local time (original behavior)
   */
  private parseDbTimestamp(timestamp: string): Date {
    // If already has timezone indicator, parse directly
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(timestamp)) {
      return new Date(timestamp);
    }

    // Check if user has configured a timezone
    const userTimezone = SettingsManager.get('profile.timezone');

    if (userTimezone) {
      // User has timezone set - treat DB timestamps as UTC
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized + 'Z');
    } else {
      // No timezone configured - use system local time
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized);
    }
  }

  /**
   * Build temporal context for the system prompt
   * Gives the agent awareness of current time and conversation timing
   */
  private buildTemporalContext(lastMessageTimestamp?: string): string {
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[now.getDay()];

    const timeStr = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const dateStr = now.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    // Build upcoming weekday reference so agent knows exact dates
    const weekRef: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const dn = dayNames[d.getDay()];
      const ds = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      weekRef.push(i === 0 ? `${dn} ${ds} (TODAY)` : `${dn} ${ds}`);
    }

    const lines = [
      '## Current Time',
      `It is ${dayName}, ${dateStr} at ${timeStr}.`,
      `Upcoming days: ${weekRef.join(', ')}.`,
    ];

    // Add time since last message if available
    if (lastMessageTimestamp) {
      try {
        const lastDate = this.parseDbTimestamp(lastMessageTimestamp);
        const diffMs = now.getTime() - lastDate.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let timeSince = '';
        if (diffMins < 1) timeSince = 'just now';
        else if (diffMins < 60) timeSince = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        else if (diffHours < 24) timeSince = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        else if (diffDays < 7) timeSince = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        else timeSince = lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        lines.push(`Last message from user was ${timeSince}.`);
      } catch {
        // Ignore timestamp parsing errors
      }
    }

    return lines.join('\n');
  }

  private extractAndStoreFacts(userMessage: string): void {
    if (!this.memory) return;

    const patterns: Array<{ pattern: RegExp; category: string; subject: string }> = [
      { pattern: /my name is (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /call me (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /i live in ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i'm from ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i work (?:at|for) ([^.,]+)/i, category: 'work', subject: 'employer' },
      { pattern: /i work as (?:a |an )?([^.,]+)/i, category: 'work', subject: 'role' },
      { pattern: /my job is ([^.,]+)/i, category: 'work', subject: 'role' },
    ];

    for (const { pattern, category, subject } of patterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        this.memory.saveFact(category, subject, match[1].trim());
        console.log(`[AgentManager] Extracted fact: [${category}] ${subject}: ${match[1]}`);
      }
    }
  }

  // ============ Public API ============

  getStats(sessionId?: string): (ReturnType<MemoryManager['getStats']> & { contextTokens?: number; contextWindow?: number }) | null {
    const stats = this.memory?.getStats(sessionId);
    if (!stats) return null;
    const contextUsage = sessionId ? this.contextUsageBySession.get(sessionId) : undefined;
    return {
      ...stats,
      contextTokens: contextUsage?.contextTokens,
      contextWindow: contextUsage?.contextWindow,
    };
  }

  clearConversation(sessionId?: string): void {
    this.memory?.clearConversation(sessionId);
    console.log('[AgentManager] Conversation cleared' + (sessionId ? ` (session: ${sessionId})` : ''));
  }

  getMemory(): MemoryManager | null {
    return this.memory;
  }

  searchFacts(queryStr: string): Array<{ category: string; subject: string; content: string }> {
    return this.memory?.searchFacts(queryStr) || [];
  }

  saveFact(category: string, subject: string, content: string): void {
    this.memory?.saveFact(category, subject, content);
  }

  getAllFacts(): Array<{ id: number; category: string; subject: string; content: string }> {
    return this.memory?.getAllFacts() || [];
  }

  getAllDailyLogs(): DailyLog[] {
    return this.memory?.getAllDailyLogs() || [];
  }

  getRecentDailyLogs(days: number = 3): DailyLog[] {
    return this.memory?.getRecentDailyLogs(days) || [];
  }

  getDailyLogsSince(days: number = 3): DailyLog[] {
    return this.memory?.getDailyLogsSince(days) || [];
  }

  getRecentMessages(limit: number = 10, sessionId: string = 'default'): Message[] {
    return this.memory?.getRecentMessages(limit, sessionId) || [];
  }

  getToolsConfig(): ToolsConfig | null {
    return this.toolsConfig;
  }

  cleanup(): void {
    this.closeAllPersistentSessions();
    closeBrowserManager();
    console.log('[AgentManager] Cleanup complete');
  }
}

export const AgentManager = AgentManagerClass.getInstance();
export { AgentManagerClass };

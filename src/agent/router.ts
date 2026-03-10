/**
 * Smart Router — PocketFlow-inspired message classifier
 *
 * Classifies every incoming Telegram message with a single fast Haiku call
 * (~200ms, ~$0.001) and routes it to the cheapest model + smallest tool set
 * that can handle the job.
 *
 * Fallback: if the call fails or times out, returns the 'complex' route
 * (current default behaviour — opus + full tools). Zero degradation.
 */

import { SettingsManager } from '../settings';
import { ClaudeOAuth } from '../auth/oauth';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RouteType = 'quick' | 'lookup' | 'chat' | 'code' | 'research' | 'creative' | 'complex';
export type ToolSet = 'minimal' | 'standard' | 'full';

export interface RouteDecision {
  route: RouteType;
  model: string;
  mode: 'coder' | 'manager';
  maxTurns: number;
  toolSet: ToolSet;
  classificationMs: number;
}

// ─── Route table ──────────────────────────────────────────────────────────────

const ROUTE_CONFIGS: Record<RouteType, Omit<RouteDecision, 'route' | 'classificationMs'>> = {
  quick:    { model: 'claude-haiku-4-5-20251001', mode: 'manager', maxTurns: 5,   toolSet: 'minimal'  },
  lookup:   { model: 'claude-haiku-4-5-20251001', mode: 'manager', maxTurns: 10,  toolSet: 'standard' },
  chat:     { model: 'claude-sonnet-4-6',          mode: 'manager', maxTurns: 15,  toolSet: 'standard' },
  code:     { model: 'claude-sonnet-4-6',          mode: 'coder',   maxTurns: 50,  toolSet: 'full'     },
  research: { model: 'claude-sonnet-4-6',          mode: 'coder',   maxTurns: 30,  toolSet: 'full'     },
  creative: { model: 'claude-opus-4-6',            mode: 'manager', maxTurns: 20,  toolSet: 'minimal'  },
  complex:  { model: 'claude-opus-4-6',            mode: 'coder',   maxTurns: 100, toolSet: 'full'     },
};

const COMPLEX_FALLBACK: RouteDecision = {
  route: 'complex',
  ...ROUTE_CONFIGS.complex,
  classificationMs: 0,
};

// ─── Tool sets ────────────────────────────────────────────────────────────────

export const TOOL_SETS: Record<ToolSet, string[]> = {
  minimal: [
    'mcp__pocket-agent__remember',
    'mcp__pocket-agent__forget',
    'mcp__pocket-agent__list_facts',
    'mcp__pocket-agent__memory_search',
    'mcp__pocket-agent__daily_log',
    'mcp__pocket-agent__soul_set',
    'mcp__pocket-agent__soul_get',
    'mcp__pocket-agent__soul_list',
    'mcp__pocket-agent__soul_delete',
    'mcp__pocket-agent__speak',
    'mcp__pocket-agent__voice_status',
    'mcp__pocket-agent__voice_toggle',
    'mcp__pocket-agent__voice_config',
    'mcp__pocket-agent__notify',
    'mcp__pocket-agent__send_telegram_photo',
    'mcp__pocket-agent__telegram_react',
  ],
  standard: [
    // Everything in minimal
    'mcp__pocket-agent__remember',
    'mcp__pocket-agent__forget',
    'mcp__pocket-agent__list_facts',
    'mcp__pocket-agent__memory_search',
    'mcp__pocket-agent__daily_log',
    'mcp__pocket-agent__soul_set',
    'mcp__pocket-agent__soul_get',
    'mcp__pocket-agent__soul_list',
    'mcp__pocket-agent__soul_delete',
    'mcp__pocket-agent__speak',
    'mcp__pocket-agent__voice_status',
    'mcp__pocket-agent__voice_toggle',
    'mcp__pocket-agent__voice_config',
    'mcp__pocket-agent__notify',
    'mcp__pocket-agent__send_telegram_photo',
    'mcp__pocket-agent__telegram_react',
    // Web
    'WebSearch',
    'WebFetch',
    // Scheduler & calendar
    'mcp__pocket-agent__schedule_task',
    'mcp__pocket-agent__create_reminder',
    'mcp__pocket-agent__list_scheduled_tasks',
    'mcp__pocket-agent__delete_scheduled_task',
    'mcp__pocket-agent__acknowledge_reminder',
    'mcp__pocket-agent__calendar_add',
    'mcp__pocket-agent__calendar_list',
    'mcp__pocket-agent__calendar_upcoming',
    'mcp__pocket-agent__calendar_delete',
    // Tasks / Kanban
    'mcp__pocket-agent__task_add',
    'mcp__pocket-agent__task_list',
    'mcp__pocket-agent__task_complete',
    'mcp__pocket-agent__task_delete',
    'mcp__pocket-agent__task_due',
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
    // Email
    'mcp__pocket-agent__send_email',
    'mcp__pocket-agent__read_emails',
    'mcp__pocket-agent__get_email',
    'mcp__pocket-agent__get_thread',
    'mcp__pocket-agent__list_email_labels',
    'mcp__pocket-agent__create_email_label',
    'mcp__pocket-agent__modify_email_labels',
    'mcp__pocket-agent__create_email_draft',
    'mcp__pocket-agent__list_email_drafts',
    // LinkedIn
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
    // Project
    'mcp__pocket-agent__set_project',
    'mcp__pocket-agent__get_project',
    'mcp__pocket-agent__clear_project',
  ],
  // 'full' = all tools — enforced in buildPersistentOptions by passing undefined
  full: [],
};

// ─── Classification prompt ────────────────────────────────────────────────────

const CLASSIFICATION_PROMPT = `You are a message router for an AI personal assistant. Classify the user's message into exactly one route.

ROUTES (choose the CHEAPEST that can handle the job):
- quick    → haiku, 5 turns   — greetings, simple facts, acks, single-hop questions ("what time in Tokyo?", "thanks", "ok", "yo")
- lookup   → haiku, 10 turns  — memory/saved-data retrieval ("what did I say about X?", "find that link I saved", "what's my password for Y?")
- chat     → sonnet, 15 turns — planning, advice, email drafts, calendar, tasks, LinkedIn, scheduling ("help me plan my week", "draft reply to this email")
- code     → sonnet, 50 turns — coding, debugging, file editing, terminal commands ("fix the bug", "add endpoint", "run tests")
- research → sonnet, 30 turns — explicit web research requests ("research X", "find latest news on Y", "look up Z online")
- creative → opus, 20 turns   — creative writing, LinkedIn posts, long-form content ("write a LinkedIn post about AI", "draft an article about X")
- complex  → opus, 100 turns  — multi-step, ambiguous, or anything you're unsure about

RULES:
- When in doubt, return complex
- If the message is 1-3 words with no clear intent, return quick
- If it asks to search/research the web, return research
- If it asks to write original long-form content, return creative
- If it involves files, code, or shell commands, return code

Recent context (last 2 messages, for reference only):
{CONTEXT}

User message: {MESSAGE}

Respond with ONLY valid JSON, no markdown, no explanation:
{"route":"<route>"}`;

// ─── Auth helper ─────────────────────────────────────────────────────────────

/**
 * Returns Anthropic auth headers using API key if available, falling back to
 * OAuth Bearer token. Returns null if neither is configured.
 */
async function getAnthropicAuthHeaders(): Promise<Record<string, string> | null> {
  const apiKey = SettingsManager.get('anthropic.apiKey');
  if (apiKey) {
    return { 'x-api-key': apiKey };
  }

  const authMethod = SettingsManager.get('auth.method');
  if (authMethod === 'oauth') {
    const token = await ClaudeOAuth.getAccessToken();
    if (token) {
      return { 'Authorization': `Bearer ${token}` };
    }
  }

  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Classify a message and return a routing decision.
 * Always resolves — falls back to 'complex' on any error or timeout.
 */
export async function classifyMessage(
  text: string,
  recentContext?: string[],
): Promise<RouteDecision> {
  const t0 = Date.now();

  const authHeaders = await getAnthropicAuthHeaders();
  if (!authHeaders) return COMPLEX_FALLBACK;

  const contextStr = recentContext && recentContext.length > 0
    ? recentContext.slice(-2).join('\n')
    : '(none)';

  const prompt = CLASSIFICATION_PROMPT
    .replace('{CONTEXT}', contextStr)
    .replace('{MESSAGE}', text.slice(0, 500));

  try {
    const result = await Promise.race([
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...authHeaders,
        },
        body: JSON.stringify({
          model: SettingsManager.get('agent.smartRouterModel') || 'claude-haiku-4-5-20251001',
          max_tokens: 32,
          messages: [{ role: 'user', content: prompt }],
        }),
      }).then(r => r.json() as Promise<{ content: Array<{ type: string; text: string }> }>),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('router timeout')), 500)
      ),
    ]);

    const raw = result.content[0]?.type === 'text' ? result.content[0].text.trim() : '';
    const parsed = JSON.parse(raw) as { route?: string };
    const route = parsed.route as RouteType;

    if (!ROUTE_CONFIGS[route]) {
      console.warn(`[Router] Unknown route "${route}", falling back to complex`);
      return { ...COMPLEX_FALLBACK, classificationMs: Date.now() - t0 };
    }

    const decision: RouteDecision = {
      route,
      ...ROUTE_CONFIGS[route],
      classificationMs: Date.now() - t0,
    };

    console.log(`[Router] ${route} (${decision.classificationMs}ms) — model: ${decision.model}, turns: ${decision.maxTurns}, tools: ${decision.toolSet}`);
    return decision;

  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Router] Classification failed (${ms}ms): ${msg} — defaulting to complex`);
    return { ...COMPLEX_FALLBACK, classificationMs: ms };
  }
}

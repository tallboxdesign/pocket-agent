/**
 * Research Tools for the Agent
 *
 * Provides tools to spawn multi-agent research tasks and retrieve results.
 * Progress is streamed via Telegram when a chatId is available.
 */

import {
  getResearchOrchestrator,
  ResearchRequest,
} from '../agent/research';
import type { TelegramBot } from '../channels/telegram';
import { getTelegramMessageContext } from './session-context';

// Store for telegram bot reference (type-only import to avoid circular deps)
let telegramBotInstance: TelegramBot | null = null;

/**
 * Set the Telegram bot instance for progress messages
 */
export function setResearchTelegramBot(bot: TelegramBot | null): void {
  telegramBotInstance = bot;
}

/**
 * Active research jobs for status tracking
 */
const activeResearchJobs: Map<number, {
  query: string;
  status: string;
  startTime: number;
  chatId?: number;
}> = new Map();

// ============================================================================
// Research Tool Definition
// ============================================================================

export function getResearchToolDefinition() {
  return {
    name: 'research',
    description: `Spawn multiple AI research agents to deeply investigate a topic in parallel.

Use when:
- User asks for comprehensive research on a topic
- Deep analysis is needed with multiple angles
- Gathering current information from the web

The research system will:
1. Break the query into 3 sub-topics
2. Run parallel agents (each with up to 20 web queries)
3. Compile findings into a report
4. Send progress updates via Telegram

Returns a research job ID for tracking. Results are stored and can be retrieved later.

Examples:
- research("house prices in Sofia") → researches prices, districts, trends
- research("best practices for React testing", max_agents=2) → focused research
- research("AI trends 2024", project_id=5) → saves to specific kanban project`,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The research question or topic',
        },
        project_id: {
          type: 'number',
          description: 'Optional kanban project ID to save the research task',
        },
        max_agents: {
          type: 'number',
          description: 'Maximum parallel research agents (1-5, default: 3)',
        },
      },
      required: ['query'],
    },
  };
}

export async function handleResearchTool(input: unknown): Promise<string> {
  const params = input as {
    query: string;
    project_id?: number;
    max_agents?: number;
  };

  if (!params.query) {
    return JSON.stringify({ error: 'query is required' });
  }

  // Get chatId from telegram context if available
  const telegramContext = getTelegramMessageContext();
  const chatId = telegramContext?.chatId;

  const request: ResearchRequest = {
    query: params.query,
    projectId: params.project_id,
    maxAgents: params.max_agents,
    chatId,
  };

  const orchestrator = getResearchOrchestrator();

  // Set up Telegram progress messages if bot and chatId are available
  if (telegramBotInstance && chatId) {
    setupTelegramProgress(orchestrator, chatId);
  }

  try {
    // Start research (this is async but we return immediately with job info)
    const resultPromise = orchestrator.execute(request);

    // For now, we'll wait for completion (future: return job ID and let user check status)
    const result = await resultPromise;

    return JSON.stringify({
      success: true,
      jobId: result.jobId,
      query: params.query,
      report: result.report,
      summary: result.summary,
      sources_count: result.sources.length,
      sources: result.sources.slice(0, 10),  // First 10 sources
      token_usage: result.tokenUsage,
      duration_ms: result.duration,
      cost_estimate: `$${((result.tokenUsage.prompt * 3 + result.tokenUsage.completion * 15) / 1000000).toFixed(2)}`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ResearchTools] research failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Research Status Tool Definition
// ============================================================================

export function getResearchStatusToolDefinition() {
  return {
    name: 'research_status',
    description: `Check the status of active research jobs.

Returns information about currently running research tasks including:
- Number of active jobs
- Query being researched
- Progress (agents completed, sources found)`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

export async function handleResearchStatusTool(_input: unknown): Promise<string> {
  const orchestrator = getResearchOrchestrator();
  const activeCount = orchestrator.getActiveJobCount();

  const jobs = Array.from(activeResearchJobs.entries()).map(([jobId, info]) => ({
    jobId,
    query: info.query,
    status: info.status,
    duration_ms: Date.now() - info.startTime,
  }));

  return JSON.stringify({
    success: true,
    active_jobs: activeCount,
    jobs,
  });
}

// ============================================================================
// Telegram Progress Setup
// ============================================================================

let progressListenersSetUp = false;

function setupTelegramProgress(orchestrator: ReturnType<typeof getResearchOrchestrator>, chatId: number): void {
  // Only set up listeners once
  if (progressListenersSetUp) return;
  progressListenersSetUp = true;

  const bot = telegramBotInstance;
  if (!bot) return;

  orchestrator.on('start', async ({ query }: { query: string }) => {
    await bot.sendMessage(chatId, `🔬 Starting research: "${query}"\n   Breaking into sub-topics...`);
  });

  orchestrator.on('topics-ready', async ({ subTopics }: { subTopics: string[] }) => {
    await bot.sendMessage(chatId, `📋 Found ${subTopics.length} research angles`);
  });

  orchestrator.on('agent-start', async ({ agentIndex, topic, total }: { agentIndex: number; topic: string; total: number }) => {
    await bot.sendMessage(chatId, `📚 Agent ${agentIndex}/${total} started: "${topic}"`);
  });

  orchestrator.on('agent-complete', async ({ agentIndex, sourcesFound }: { agentIndex: number; sourcesFound: number }) => {
    await bot.sendMessage(chatId, `✅ Agent ${agentIndex} done: ${sourcesFound} sources found`);
  });

  orchestrator.on('compiling', async () => {
    await bot.sendMessage(chatId, `📝 Compiling results...`);
  });

  orchestrator.on('complete', async ({ sources, cost, duration }: { sources: unknown[]; cost: number; duration: number }) => {
    const durationSec = Math.round(duration / 1000);
    await bot.sendMessage(
      chatId,
      `✅ Research complete! ${sources.length} sources, ~$${cost.toFixed(2)}, ${durationSec}s\n   Results ready in chat`
    );
  });

  orchestrator.on('cancelled', async ({ jobId }: { jobId: number }) => {
    await bot.sendMessage(chatId, `⛔ Research job ${jobId} cancelled`);
  });
}

// ============================================================================
// Export all research tools
// ============================================================================

export function getResearchTools() {
  return [
    { ...getResearchToolDefinition(), handler: handleResearchTool },
    { ...getResearchStatusToolDefinition(), handler: handleResearchStatusTool },
  ];
}

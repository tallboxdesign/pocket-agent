/**
 * Multi-Agent Research Orchestrator
 *
 * Enables the manager agent to spawn multiple parallel Claude SDK agents
 * for deep research. Each sub-agent focuses on one aspect of the query,
 * results are compiled by GLM, and progress is streamed via Telegram.
 */

import { EventEmitter } from 'events';
import { SettingsManager } from '../settings';

// SDK types (loaded dynamically)
type SDKQuery = AsyncGenerator<unknown, void>;
type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  abortController?: AbortController;
  tools?: { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
};

// Dynamic SDK loader
let sdkQuery: ((params: { prompt: string; options?: SDKOptions }) => SDKQuery) | null = null;
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk') as { query: typeof sdkQuery };
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

// ============================================================================
// Types
// ============================================================================

export interface ResearchRequest {
  query: string;
  projectId?: number;
  maxAgents?: number;        // default 3, max 5
  maxTurnsPerAgent?: number; // default 20
  chatId?: number;           // Telegram chat for progress updates
}

export interface ResearchSource {
  url: string;
  title: string;
  topic: string;
}

export interface AgentResult {
  topic: string;
  findings: string;
  sources: ResearchSource[];
  tokenUsage: { prompt: number; completion: number };
}

export interface ResearchResult {
  jobId: number;
  report: string;            // Full markdown
  summary: string;           // TTS-friendly
  sources: ResearchSource[];
  tokenUsage: { prompt: number; completion: number; total: number };
  kanbanTaskId?: number;
  duration: number;          // ms
}

export interface ResearchJob {
  id: number;
  query: string;
  sub_topics: string | null;
  status: 'pending' | 'running' | 'compiling' | 'completed' | 'failed';
  agent_results: string | null;
  compiled_report: string | null;
  summary: string | null;
  sources: string | null;
  kanban_task_id: number | null;
  token_usage: string | null;
  created_at: string;
  completed_at: string | null;
}

// Progress event types
export interface ResearchProgress {
  jobId: number;
  status: string;
  agentProgress: Array<{
    index: number;
    topic: string;
    status: 'pending' | 'running' | 'completed';
    sourcesFound: number;
  }>;
}

// ============================================================================
// GLM Utilities (using Z.AI GLM for cheap operations)
// ============================================================================

/**
 * Configure environment for GLM API
 */
function configureGlmEnvironment(): void {
  const glmKey = SettingsManager.get('glm.apiKey');
  if (!glmKey) {
    throw new Error('Z.AI GLM API key not configured. Please add your key in Settings > LLM.');
  }

  process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic/';
  process.env.ANTHROPIC_AUTH_TOKEN = glmKey;
  delete process.env.ANTHROPIC_API_KEY;
}

/**
 * Configure environment for Sonnet (research agents)
 */
function configureSonnetEnvironment(): void {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // ANTHROPIC_API_KEY should be set globally or via OAuth
}

/**
 * Use GLM to split a research query into sub-topics
 */
async function glmSplitQuery(query: string, maxTopics: number = 3): Promise<string[]> {
  const prompt = `You are a research planner. Given a user's research request, break it into ${maxTopics} distinct sub-topics that can be researched in parallel.

User request: "${query}"

Output ONLY a JSON array of topic strings, nothing else. Each topic should be a focused research angle.
Example: ["Population demographics and trends", "Real estate market analysis", "Economic indicators"]

JSON array:`;

  configureGlmEnvironment();

  const queryFn = await loadSDK();
  if (!queryFn) throw new Error('Failed to load SDK');

  const result = queryFn({
    prompt,
    options: {
      model: 'glm-5',
      maxTurns: 1,
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: [],  // No tools needed for this
    },
  });

  let response = '';
  for await (const event of result) {
    if (typeof event === 'object' && event !== null) {
      const evt = event as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) {
            response += block.text;
          }
        }
      }
    }
  }

  // Parse JSON array from response
  const match = response.match(/\[[\s\S]*?\]/);
  if (!match) {
    console.error('[Research] GLM split failed, using default split. Response:', response);
    return [query];  // Fallback to single topic
  }

  try {
    const topics = JSON.parse(match[0]) as string[];
    return topics.slice(0, maxTopics);
  } catch (e) {
    console.error('[Research] Failed to parse GLM response:', e);
    return [query];
  }
}

/**
 * Use GLM to compile agent results into a final report
 */
async function glmCompileResults(
  query: string,
  agentResults: AgentResult[]
): Promise<{ report: string; summary: string }> {
  const resultsText = agentResults.map((r, i) =>
    `## Agent ${i + 1}: ${r.topic}\n\n${r.findings}\n\nSources: ${r.sources.map(s => s.url).join(', ')}`
  ).join('\n\n---\n\n');

  const prompt = `You are a research compiler. Combine these research findings into a single coherent report.

Original query: "${query}"

Research findings:
${resultsText}

Create two outputs:
1. A comprehensive markdown report that synthesizes all findings
2. A brief TTS-friendly summary (2-3 sentences, no URLs or special formatting)

Format your response as:
## Report
[comprehensive report here]

## Summary
[TTS-friendly summary here]`;

  configureGlmEnvironment();

  const queryFn = await loadSDK();
  if (!queryFn) throw new Error('Failed to load SDK');

  const result = queryFn({
    prompt,
    options: {
      model: 'glm-5',
      maxTurns: 1,
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: [],
    },
  });

  let response = '';
  for await (const event of result) {
    if (typeof event === 'object' && event !== null) {
      const evt = event as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) {
            response += block.text;
          }
        }
      }
    }
  }

  // Parse report and summary
  const reportMatch = response.match(/## Report\s*([\s\S]*?)(?=## Summary|$)/i);
  const summaryMatch = response.match(/## Summary\s*([\s\S]*?)$/i);

  return {
    report: reportMatch?.[1]?.trim() || response,
    summary: summaryMatch?.[1]?.trim() || 'Research completed.',
  };
}

// ============================================================================
// Research Agent Runner
// ============================================================================

/**
 * Run a single research agent on a specific topic
 */
async function runResearchAgent(
  topic: string,
  maxTurns: number,
  abortController: AbortController,
  onProgress?: (sourcesFound: number) => void
): Promise<AgentResult> {
  const systemPrompt = `You are a focused research agent. Your task is to thoroughly research this specific topic:

"${topic}"

Instructions:
1. Use WebSearch to find relevant, recent information
2. Use WebFetch to read important pages in detail
3. Gather facts, statistics, and expert opinions
4. Note your sources with URLs

Be thorough but efficient. Focus only on this topic, ignore tangential information.
When done, provide a clear summary of your findings.`;

  configureSonnetEnvironment();

  const queryFn = await loadSDK();
  if (!queryFn) throw new Error('Failed to load SDK');

  const result = queryFn({
    prompt: `Research this topic thoroughly: "${topic}"`,
    options: {
      model: 'claude-sonnet-4-5-20250929',
      maxTurns,
      abortController,
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: ['WebSearch', 'WebFetch'],
      systemPrompt,
    },
  });

  let findings = '';
  const sources: ResearchSource[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const event of result) {
    if (typeof event === 'object' && event !== null) {
      const evt = event as {
        type?: string;
        message?: { content?: Array<{ type: string; text?: string }> };
        tool_use?: { name: string; input: unknown };
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      // Track token usage
      if (evt.usage) {
        promptTokens += evt.usage.input_tokens || 0;
        completionTokens += evt.usage.output_tokens || 0;
      }

      // Capture assistant responses
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) {
            findings += block.text + '\n';
          }
        }
      }

      // Track web fetches as sources
      if (evt.tool_use?.name === 'WebFetch') {
        const input = evt.tool_use.input as { url?: string };
        if (input.url) {
          sources.push({
            url: input.url,
            title: input.url,  // We could extract title from response
            topic,
          });
          onProgress?.(sources.length);
        }
      }
    }
  }

  return {
    topic,
    findings: findings.trim(),
    sources,
    tokenUsage: { prompt: promptTokens, completion: completionTokens },
  };
}

// ============================================================================
// Research Orchestrator
// ============================================================================

export class ResearchOrchestrator extends EventEmitter {
  private activeJobs: Map<number, AbortController> = new Map();

  constructor() {
    super();
  }

  /**
   * Execute a research request
   */
  async execute(request: ResearchRequest): Promise<ResearchResult> {
    const startTime = Date.now();
    const maxAgents = Math.min(request.maxAgents || 3, 5);
    const maxTurnsPerAgent = request.maxTurnsPerAgent || 20;

    console.log(`[Research] Starting research: "${request.query}" with up to ${maxAgents} agents`);

    // Emit start event
    this.emit('start', { query: request.query, maxAgents });

    // Step 1: Use GLM to break query into sub-topics
    this.emit('splitting', { query: request.query });
    const subTopics = await glmSplitQuery(request.query, maxAgents);
    console.log(`[Research] Sub-topics:`, subTopics);

    this.emit('topics-ready', { query: request.query, subTopics });

    // Create abort controller for this job
    const jobAbort = new AbortController();
    const jobId = Date.now();  // Simple ID for now
    this.activeJobs.set(jobId, jobAbort);

    // Step 2: Run research agents in parallel
    const agentProgress: ResearchProgress['agentProgress'] = subTopics.map((topic, i) => ({
      index: i + 1,
      topic,
      status: 'pending' as const,
      sourcesFound: 0,
    }));

    this.emit('progress', { jobId, status: 'running', agentProgress });

    const agentPromises = subTopics.map(async (topic, index) => {
      agentProgress[index].status = 'running';
      this.emit('agent-start', { jobId, agentIndex: index + 1, topic, total: subTopics.length });
      this.emit('progress', { jobId, status: 'running', agentProgress });

      try {
        const result = await runResearchAgent(
          topic,
          maxTurnsPerAgent,
          jobAbort,
          (sourcesFound) => {
            agentProgress[index].sourcesFound = sourcesFound;
            this.emit('progress', { jobId, status: 'running', agentProgress });
          }
        );

        agentProgress[index].status = 'completed';
        agentProgress[index].sourcesFound = result.sources.length;
        this.emit('agent-complete', {
          jobId,
          agentIndex: index + 1,
          topic,
          sourcesFound: result.sources.length,
        });
        this.emit('progress', { jobId, status: 'running', agentProgress });

        return result;
      } catch (error) {
        console.error(`[Research] Agent ${index + 1} failed:`, error);
        agentProgress[index].status = 'completed';
        return {
          topic,
          findings: `Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          sources: [],
          tokenUsage: { prompt: 0, completion: 0 },
        };
      }
    });

    const agentResults = await Promise.all(agentPromises);

    // Step 3: Use GLM to compile results
    this.emit('compiling', { jobId });
    const { report, summary } = await glmCompileResults(request.query, agentResults);

    // Collect all sources
    const allSources = agentResults.flatMap(r => r.sources);

    // Calculate total token usage
    const totalUsage = agentResults.reduce(
      (acc, r) => ({
        prompt: acc.prompt + r.tokenUsage.prompt,
        completion: acc.completion + r.tokenUsage.completion,
        total: acc.total + r.tokenUsage.prompt + r.tokenUsage.completion,
      }),
      { prompt: 0, completion: 0, total: 0 }
    );

    // Estimate cost (rough: $3/1M input, $15/1M output for Sonnet)
    const cost = (totalUsage.prompt * 3 + totalUsage.completion * 15) / 1000000;

    const duration = Date.now() - startTime;

    // Cleanup
    this.activeJobs.delete(jobId);

    // Emit completion
    this.emit('complete', {
      jobId,
      sources: allSources,
      cost,
      duration,
    });

    console.log(`[Research] Completed in ${duration}ms, ${allSources.length} sources, ~$${cost.toFixed(2)}`);

    return {
      jobId,
      report,
      summary,
      sources: allSources,
      tokenUsage: totalUsage,
      duration,
    };
  }

  /**
   * Cancel a running research job
   */
  cancel(jobId: number): boolean {
    const controller = this.activeJobs.get(jobId);
    if (controller) {
      controller.abort();
      this.activeJobs.delete(jobId);
      this.emit('cancelled', { jobId });
      return true;
    }
    return false;
  }

  /**
   * Get number of active research jobs
   */
  getActiveJobCount(): number {
    return this.activeJobs.size;
  }
}

// Singleton instance
let orchestratorInstance: ResearchOrchestrator | null = null;

export function getResearchOrchestrator(): ResearchOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new ResearchOrchestrator();
  }
  return orchestratorInstance;
}

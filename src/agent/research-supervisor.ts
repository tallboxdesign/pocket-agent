/**
 * Research Supervisor — PocketFlow-inspired quality gate
 *
 * After all research sub-agents complete, a single Sonnet call reviews their
 * findings before compilation. Catches hallucinated sources, vague claims, and
 * off-topic results. Can trigger a one-shot retry of flagged agents.
 *
 * Fallback: if the call fails or times out, approves everything and passes
 * through unchanged (same result as today, zero degradation).
 */

import { SettingsManager } from '../settings';
import { ClaudeOAuth } from '../auth/oauth';
import type { AgentResult } from './research';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlaggedResult {
  result: AgentResult;
  issues: string[];
  severity: 'warning' | 'critical';
}

export interface RetryRequest {
  topic: string;
  feedback: string;
}

export interface SupervisorVerdict {
  approved: AgentResult[];
  flagged: FlaggedResult[];
  retry: RetryRequest[];
  summary: string;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildSupervisorPrompt(query: string, results: AgentResult[]): string {
  const resultsSummary = results.map((r, i) => `
=== Agent ${i + 1}: ${r.topic} ===
Findings (first 800 chars): ${r.findings.slice(0, 800)}
Sources (${r.sources.length}): ${r.sources.map(s => s.url).join(', ') || 'none'}
`).join('\n');

  return `You are a research quality reviewer. Examine these sub-agent findings for the query: "${query}"

For each agent's result, evaluate:
1. Are source URLs plausible? (real domains, not fabricated)
2. Are claims specific? (dates, numbers, names — not vague filler)
3. Does it actually answer the assigned sub-topic?
4. Any major contradictions between agents?

${resultsSummary}

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "approved": [0, 1],
  "flagged": [
    { "index": 2, "issues": ["vague claims, no specific dates", "source URLs look fabricated"], "severity": "critical" }
  ],
  "retry": [
    { "index": 2, "topic": "exact topic text", "feedback": "specific instructions for retry" }
  ],
  "summary": "one-line assessment"
}

Use agent indices (0-based). Only add to "retry" if severity is critical. When in doubt, approve.`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the supervisor check on all agent results.
 * Always resolves — falls back to approving everything on any error or timeout.
 */
export async function supervisorCheck(
  originalQuery: string,
  results: AgentResult[],
  abortSignal?: AbortSignal,
): Promise<SupervisorVerdict> {
  const approveAll: SupervisorVerdict = {
    approved: results,
    flagged: [],
    retry: [],
    summary: 'All results approved (supervisor skipped)',
  };

  if (results.length === 0) return approveAll;

  // Resolve auth — API key takes priority, then OAuth Bearer token.
  // If neither is available, skip supervision and approve all.
  let authHeaders: Record<string, string> | null = null;
  const apiKey = SettingsManager.get('anthropic.apiKey');
  if (apiKey) {
    authHeaders = { 'x-api-key': apiKey };
  } else if (SettingsManager.get('auth.method') === 'oauth') {
    const token = await ClaudeOAuth.getAccessToken();
    if (token) authHeaders = { 'Authorization': `Bearer ${token}` };
  }
  if (!authHeaders) return approveAll;

  const supervisorModel = SettingsManager.get('agent.researchSupervisorModel') || 'claude-sonnet-4-6';

  try {
    const prompt = buildSupervisorPrompt(originalQuery, results);

    const response = await Promise.race([
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...authHeaders,
        },
        body: JSON.stringify({
          model: supervisorModel,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: abortSignal,
      }).then(r => r.json() as Promise<{ content: Array<{ type: string; text: string }> }>),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('supervisor timeout')), 15_000);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('supervisor aborted'));
        });
      }),
    ]);

    const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';

    interface RawVerdict {
      approved?: number[];
      flagged?: Array<{ index: number; issues: string[]; severity: string }>;
      retry?: Array<{ index: number; topic: string; feedback: string }>;
      summary?: string;
    }

    const parsed = JSON.parse(raw) as RawVerdict;

    const approvedIndices = new Set<number>(parsed.approved || []);

    // Build approved list
    const approved: AgentResult[] = [];
    for (const idx of approvedIndices) {
      if (idx >= 0 && idx < results.length) approved.push(results[idx]);
    }

    // Build flagged list
    const flagged: FlaggedResult[] = (parsed.flagged || [])
      .filter(f => f.index >= 0 && f.index < results.length)
      .map(f => ({
        result: results[f.index],
        issues: f.issues || [],
        severity: (f.severity === 'critical' ? 'critical' : 'warning') as 'warning' | 'critical',
      }));

    // Build retry list (only flagged agents that aren't in approved)
    const retry: RetryRequest[] = (parsed.retry || [])
      .filter(r => r.index >= 0 && r.index < results.length && !approvedIndices.has(r.index))
      .map(r => ({
        topic: r.topic || results[r.index].topic,
        feedback: r.feedback || 'Please provide more specific claims with verifiable sources.',
      }));

    const verdict: SupervisorVerdict = {
      approved,
      flagged,
      retry,
      summary: parsed.summary || 'Review complete',
    };

    console.log(`[Supervisor] approved=${approved.length} flagged=${flagged.length} retry=${retry.length} — ${verdict.summary}`);
    return verdict;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Supervisor] Check failed: ${msg} — approving all results`);
    return approveAll;
  }
}

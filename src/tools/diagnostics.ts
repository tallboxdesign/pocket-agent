/**
 * Tool diagnostics - timing, logging, and timeout wrapper
 *
 * Wraps all tool handlers to:
 * - Log start/end with timing
 * - Enforce timeouts
 * - Catch and report errors
 */

import { logEvent } from '../memory/event-log';
import { getCurrentSessionId } from './session-context';

const TOOL_TIMEOUT_MS = 30000; // 30 second default timeout

interface ToolTiming {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'running' | 'success' | 'error' | 'timeout';
  error?: string;
}

// Track active tool calls
const activeTools = new Map<string, ToolTiming>();
let toolCallId = 0;

/**
 * Log tool diagnostic message
 */
function logTool(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '🔧';
  console.log(`${prefix} [Tool ${timestamp}] ${message}${dataStr}`);
}

/**
 * Wrap a tool handler with diagnostics and timeout
 */
export function wrapToolHandler<T>(
  toolName: string,
  handler: (input: T) => Promise<string>,
  timeoutMs: number = TOOL_TIMEOUT_MS
): (input: T) => Promise<string> {
  return async (input: T): Promise<string> => {
    const callId = `${toolName}-${++toolCallId}`;
    const timing: ToolTiming = {
      name: toolName,
      startTime: Date.now(),
      status: 'running',
    };
    activeTools.set(callId, timing);

    // Log input (truncated for large inputs)
    const inputStr = JSON.stringify(input);
    const truncatedInput = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;
    logTool('info', `START ${toolName}`, { callId, input: truncatedInput });

    // Create timeout promise
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutId = setTimeout(() => {
        timing.status = 'timeout';
        timing.endTime = Date.now();
        timing.duration = timing.endTime - timing.startTime;
        logTool('error', `TIMEOUT ${toolName} after ${timeoutMs}ms`, { callId, duration: timing.duration });
        reject(new Error(`Tool ${toolName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      // Race between handler and timeout
      const result = await Promise.race([
        handler(input),
        timeoutPromise,
      ]);

      clearTimeout(timeoutId!);
      timing.status = 'success';
      timing.endTime = Date.now();
      timing.duration = timing.endTime - timing.startTime;

      // Log result (truncated)
      const resultStr = result.length > 200 ? result.slice(0, 200) + '...' : result;
      logTool('info', `END ${toolName}`, { callId, duration: `${timing.duration}ms`, result: resultStr });

      try {
        logEvent({
          event_type: 'tool_call',
          source: 'claude',
          actor: 'claude',
          session_id: getCurrentSessionId(),
          data: { tool: toolName, input: truncatedInput },
          success: true,
          duration_ms: timing.duration,
        });
      } catch { /* don't let event logging break tool execution */ }

      return result;
    } catch (error) {
      clearTimeout(timeoutId!);
      timing.status = timing.status === 'timeout' ? 'timeout' : 'error';
      timing.endTime = Date.now();
      timing.duration = timing.endTime - timing.startTime;
      timing.error = error instanceof Error ? error.message : 'Unknown error';

      logTool('error', `FAIL ${toolName}`, {
        callId,
        duration: `${timing.duration}ms`,
        error: timing.error
      });

      try {
        logEvent({
          event_type: 'tool_call',
          source: 'claude',
          actor: 'claude',
          session_id: getCurrentSessionId(),
          data: { tool: toolName, input: truncatedInput },
          success: false,
          error: timing.error,
          duration_ms: timing.duration,
        });
      } catch { /* don't let event logging break tool execution */ }

      // Return error as JSON so agent can see it
      return JSON.stringify({
        error: timing.error,
        toolName,
        duration: timing.duration,
        timedOut: timing.status === 'timeout'
      });
    } finally {
      activeTools.delete(callId);
    }
  };
}

/**
 * Get currently active tools (for debugging)
 */
export function getActiveTools(): ToolTiming[] {
  const now = Date.now();
  return Array.from(activeTools.values()).map(t => ({
    ...t,
    duration: now - t.startTime,
  }));
}

/**
 * Log active tools status (call periodically to detect hangs)
 */
export function logActiveToolsStatus(): void {
  const active = getActiveTools();
  if (active.length > 0) {
    logTool('warn', `${active.length} tools still running`, {
      tools: active.map(t => ({ name: t.name, runningFor: `${t.duration}ms` })),
    });
  }
}

/**
 * Specific timeout values for different tool types
 */
export const TOOL_TIMEOUTS = {
  // Fast tools - should complete in <5s
  remember: 5000,
  forget: 5000,
  list_facts: 5000,
  notify: 5000,

  // Medium tools - up to 15s
  memory_search: 15000,
  task_add: 10000,
  task_list: 10000,
  task_complete: 5000,
  task_delete: 5000,
  task_due: 10000,
  schedule_task: 10000,
  list_scheduled_tasks: 5000,
  delete_scheduled_task: 5000,
  calendar_add: 10000,
  calendar_list: 10000,
  calendar_upcoming: 10000,
  calendar_delete: 5000,
  pty_exec: 60000, // Shell commands can take longer

  // Slow tools - browser operations
  browser: 45000, // Browser can be slow
} as const;

/**
 * Get timeout for a specific tool
 */
export function getToolTimeout(toolName: string): number {
  return TOOL_TIMEOUTS[toolName as keyof typeof TOOL_TIMEOUTS] || TOOL_TIMEOUT_MS;
}

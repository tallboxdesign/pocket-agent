/**
 * Unit tests for session-scoped calendar events, tasks, and cron jobs
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setCurrentSessionId, getCurrentSessionId, runWithSessionId } from '../../src/tools/session-context';
import fs from 'fs';
import path from 'path';

describe('Session Context', () => {
  beforeEach(() => {
    // Reset to default session before each test
    setCurrentSessionId('default');
  });

  it('should default to "default" session', () => {
    setCurrentSessionId('default'); // Reset first
    expect(getCurrentSessionId()).toBe('default');
  });

  it('should set and get session ID via fallback', () => {
    setCurrentSessionId('work');
    expect(getCurrentSessionId()).toBe('work');

    setCurrentSessionId('personal');
    expect(getCurrentSessionId()).toBe('personal');
  });

  it('should persist session ID across calls', () => {
    setCurrentSessionId('test-session-123');
    expect(getCurrentSessionId()).toBe('test-session-123');
    expect(getCurrentSessionId()).toBe('test-session-123');
  });
});

describe('AsyncLocalStorage Session Isolation', () => {
  beforeEach(() => {
    setCurrentSessionId('default');
  });

  it('should isolate session ID within runWithSessionId', () => {
    runWithSessionId('isolated-session', () => {
      expect(getCurrentSessionId()).toBe('isolated-session');
    });

    // Outside, falls back to the fallback value
    expect(getCurrentSessionId()).toBe('default');
  });

  it('should support nested runWithSessionId with different IDs', () => {
    runWithSessionId('outer', () => {
      expect(getCurrentSessionId()).toBe('outer');

      runWithSessionId('inner', () => {
        expect(getCurrentSessionId()).toBe('inner');
      });

      // Back to outer after inner completes
      expect(getCurrentSessionId()).toBe('outer');
    });
  });

  it('should isolate concurrent async contexts', async () => {
    const results: string[] = [];

    const task1 = runWithSessionId('session-A', async () => {
      results.push(`task1-start: ${getCurrentSessionId()}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      results.push(`task1-end: ${getCurrentSessionId()}`);
    });

    const task2 = runWithSessionId('session-B', async () => {
      results.push(`task2-start: ${getCurrentSessionId()}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      results.push(`task2-end: ${getCurrentSessionId()}`);
    });

    await Promise.all([task1, task2]);

    expect(results).toContain('task1-start: session-A');
    expect(results).toContain('task1-end: session-A');
    expect(results).toContain('task2-start: session-B');
    expect(results).toContain('task2-end: session-B');
  });

  it('should return the value from the wrapped function', () => {
    const result = runWithSessionId('test', () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('should return a promise from an async wrapped function', async () => {
    const result = await runWithSessionId('test', async () => {
      return 'async-result';
    });
    expect(result).toBe('async-result');
  });
});

describe('Session Context Integration', () => {
  it('should maintain session context across tool calls', () => {
    // Simulate agent setting session before processing
    setCurrentSessionId('session-abc');

    // First tool call should see the session
    expect(getCurrentSessionId()).toBe('session-abc');

    // Second tool call should still see the same session
    expect(getCurrentSessionId()).toBe('session-abc');

    // After processing a different session
    setCurrentSessionId('session-xyz');
    expect(getCurrentSessionId()).toBe('session-xyz');
  });

  it('should handle session changes between messages', () => {
    // Message 1 in work session
    setCurrentSessionId('work');
    expect(getCurrentSessionId()).toBe('work');

    // Message 2 in personal session
    setCurrentSessionId('personal');
    expect(getCurrentSessionId()).toBe('personal');

    // Message 3 back to default
    setCurrentSessionId('default');
    expect(getCurrentSessionId()).toBe('default');
  });
});

describe('Source Code Verification', () => {
  const srcDir = path.join(__dirname, '../../src');

  it('calendar-tools.ts should import getCurrentSessionId', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/calendar-tools.ts'), 'utf-8');
    expect(content).toContain("import { getCurrentSessionId } from './session-context'");
  });

  it('calendar-tools.ts should use getCurrentSessionId in handleCalendarAddTool', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/calendar-tools.ts'), 'utf-8');
    // Check the INSERT includes session_id
    expect(content).toContain('session_id');
    expect(content).toMatch(/INSERT INTO calendar_events.*session_id/s);
  });

  it('calendar-tools.ts should filter by session_id in handleCalendarListTool', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/calendar-tools.ts'), 'utf-8');
    // Check that SELECT queries include session_id filter
    expect(content).toMatch(/SELECT \* FROM calendar_events WHERE session_id/);
  });

  it('calendar-tools.ts should filter by session_id in handleCalendarUpcomingTool', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/calendar-tools.ts'), 'utf-8');
    // Check that the upcoming query includes session_id
    expect(content).toMatch(/WHERE session_id = \? AND start_time/);
  });

  it('task-tools.ts should import getCurrentSessionId', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/task-tools.ts'), 'utf-8');
    expect(content).toContain("import { getCurrentSessionId } from './session-context'");
  });

  it('task-tools.ts should use session_id in handleTaskAddTool', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/task-tools.ts'), 'utf-8');
    expect(content).toMatch(/INSERT INTO tasks.*session_id/s);
  });

  it('task-tools.ts should filter by session_id in handleTaskListTool', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/task-tools.ts'), 'utf-8');
    expect(content).toMatch(/SELECT \* FROM tasks WHERE session_id = \?/);
  });

  it('task-tools.ts should filter by session_id in handleTaskDueTool', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/task-tools.ts'), 'utf-8');
    expect(content).toMatch(/WHERE session_id = \? AND status/);
  });

  it('scheduler-tools.ts should import getCurrentSessionId', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/scheduler-tools.ts'), 'utf-8');
    expect(content).toContain("import { getCurrentSessionId } from './session-context'");
  });

  it('scheduler-tools.ts should use session_id in INSERT/UPDATE', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/scheduler-tools.ts'), 'utf-8');
    expect(content).toMatch(/INSERT INTO cron_jobs.*session_id/s);
    expect(content).toMatch(/UPDATE cron_jobs SET.*session_id/s);
  });

  it('agent/persistent-session.ts should import and use runWithSessionId', () => {
    const content = fs.readFileSync(path.join(srcDir, 'agent/persistent-session.ts'), 'utf-8');
    expect(content).toContain('runWithSessionId');
    expect(content).toContain('runWithSessionId(this.sessionId');
  });

  it('scheduler/index.ts should include session_id in calendar reminder queries', () => {
    const content = fs.readFileSync(path.join(srcDir, 'scheduler/index.ts'), 'utf-8');
    expect(content).toMatch(/SELECT.*session_id.*FROM calendar_events/s);
  });

  it('scheduler/index.ts should include session_id in task reminder queries', () => {
    const content = fs.readFileSync(path.join(srcDir, 'scheduler/index.ts'), 'utf-8');
    expect(content).toMatch(/SELECT.*session_id.*FROM tasks/s);
  });

  it('scheduler/index.ts should include session_id in cron job queries', () => {
    const content = fs.readFileSync(path.join(srcDir, 'scheduler/index.ts'), 'utf-8');
    expect(content).toMatch(/SELECT.*session_id.*FROM cron_jobs/s);
  });

  it('scheduler/index.ts sendReminder should accept sessionId parameter', () => {
    const content = fs.readFileSync(path.join(srcDir, 'scheduler/index.ts'), 'utf-8');
    expect(content).toMatch(/sendReminder\(.*sessionId.*\)/s);
  });

  it('scheduler/index.ts routeJobResponse should accept sessionId parameter', () => {
    const content = fs.readFileSync(path.join(srcDir, 'scheduler/index.ts'), 'utf-8');
    expect(content).toMatch(/routeJobResponse\(.*sessionId.*\)/s);
  });

  it('scheduler/index.ts setChatHandler should include sessionId in signature', () => {
    const content = fs.readFileSync(path.join(srcDir, 'scheduler/index.ts'), 'utf-8');
    expect(content).toMatch(/setChatHandler\(handler:.*sessionId: string/s);
  });

  it('memory/index.ts should have migrateSessionScopedTables method', () => {
    const content = fs.readFileSync(path.join(srcDir, 'memory/index.ts'), 'utf-8');
    expect(content).toContain('migrateSessionScopedTables');
    expect(content).toContain('ALTER TABLE calendar_events ADD COLUMN session_id');
    expect(content).toContain('ALTER TABLE tasks ADD COLUMN session_id');
    expect(content).toContain('ALTER TABLE cron_jobs ADD COLUMN session_id');
  });

  it('tools/index.ts should export session context functions', () => {
    const content = fs.readFileSync(path.join(srcDir, 'tools/index.ts'), 'utf-8');
    expect(content).toContain('runWithSessionId');
    expect(content).toContain("from './session-context'");
  });

  it('main/index.ts scheduler chat handler should include sessionId', () => {
    const content = fs.readFileSync(path.join(srcDir, 'main/index.ts'), 'utf-8');
    expect(content).toMatch(/setChatHandler\(.*sessionId.*\)/s);
    expect(content).toContain("{ jobName, prompt, response, sessionId }");
  });

  it('agent/index.ts AgentStatus type should include sessionId field', () => {
    const content = fs.readFileSync(path.join(srcDir, 'agent/index.ts'), 'utf-8');
    expect(content).toMatch(/export type AgentStatus = \{[\s\S]*?sessionId\?: string/);
  });

  it('agent/index.ts should use lastSuggestedPromptBySession instead of single variable', () => {
    const content = fs.readFileSync(path.join(srcDir, 'agent/index.ts'), 'utf-8');
    expect(content).toContain('lastSuggestedPromptBySession');
    expect(content).not.toMatch(/private lastSuggestedPrompt:/);
  });

  it('agent/index.ts should use activeSubagentsBySession instead of single map', () => {
    const content = fs.readFileSync(path.join(srcDir, 'agent/index.ts'), 'utf-8');
    expect(content).toContain('activeSubagentsBySession');
    expect(content).toContain('getActiveSubagents');
    expect(content).not.toMatch(/private activeSubagents:/);
  });

  it('agent/index.ts should configure provider environment in buildPersistentOptions', () => {
    const content = fs.readFileSync(path.join(srcDir, 'agent/index.ts'), 'utf-8');
    expect(content).toContain('configureProviderEnvironment');
    expect(content).toContain('buildPersistentOptions');
  });

  it('agent/index.ts should import getCurrentSessionId', () => {
    const content = fs.readFileSync(path.join(srcDir, 'agent/index.ts'), 'utf-8');
    expect(content).toContain('getCurrentSessionId');
    expect(content).toMatch(/import.*getCurrentSessionId.*from/);
  });

  it('main/index.ts status handler should filter by sessionId', () => {
    const content = fs.readFileSync(path.join(srcDir, 'main/index.ts'), 'utf-8');
    expect(content).toContain('status.sessionId');
    expect(content).toMatch(/if \(status\.sessionId && status\.sessionId !== effectiveSessionId\) return/);
  });
});

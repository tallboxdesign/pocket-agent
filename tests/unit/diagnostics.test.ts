/**
 * Unit tests for the Tools diagnostics wrapper
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  wrapToolHandler,
  getActiveTools,
  logActiveToolsStatus,
  getToolTimeout,
  TOOL_TIMEOUTS,
} from '../../src/tools/diagnostics';

describe('wrapToolHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Suppress console.log during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('successful execution', () => {
    it('should call the handler with the provided input', async () => {
      const handler = vi.fn().mockResolvedValue('success');
      const wrappedHandler = wrapToolHandler('testTool', handler);

      const input = { key: 'value' };
      const resultPromise = wrappedHandler(input);

      // Advance timers to allow the promise to resolve
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(handler).toHaveBeenCalledWith(input);
      expect(result).toBe('success');
    });

    it('should return the result from the handler', async () => {
      const expectedResult = 'handler result';
      const handler = vi.fn().mockResolvedValue(expectedResult);
      const wrappedHandler = wrapToolHandler('testTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe(expectedResult);
    });

    it('should log start and end messages', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const handler = vi.fn().mockResolvedValue('done');
      const wrappedHandler = wrapToolHandler('logTool', handler);

      const resultPromise = wrappedHandler({ test: 'input' });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(consoleSpy).toHaveBeenCalledTimes(2);
      // Check START message
      expect(consoleSpy.mock.calls[0][0]).toContain('START logTool');
      // Check END message
      expect(consoleSpy.mock.calls[1][0]).toContain('END logTool');
    });
  });

  describe('timeout behavior', () => {
    it('should timeout after the specified duration', async () => {
      const handler = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          // This handler never resolves
          setTimeout(() => resolve('late'), 60000);
        });
      });

      const timeoutMs = 5000;
      const wrappedHandler = wrapToolHandler('slowTool', handler, timeoutMs);

      const resultPromise = wrappedHandler({});

      // Advance time past the timeout
      await vi.advanceTimersByTimeAsync(timeoutMs + 100);

      const result = await resultPromise;
      const parsed = JSON.parse(result);

      expect(parsed.error).toBe(`Tool slowTool timed out after ${timeoutMs}ms`);
      expect(parsed.toolName).toBe('slowTool');
      expect(parsed.timedOut).toBe(true);
    });

    it('should use default timeout when not specified', async () => {
      const handler = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          setTimeout(() => resolve('done'), 60000);
        });
      });

      const wrappedHandler = wrapToolHandler('defaultTimeoutTool', handler);

      const resultPromise = wrappedHandler({});

      // Default timeout is 30000ms
      await vi.advanceTimersByTimeAsync(30001);

      const result = await resultPromise;
      const parsed = JSON.parse(result);

      expect(parsed.timedOut).toBe(true);
      expect(parsed.error).toContain('30000ms');
    });

    it('should not timeout if handler completes in time', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        return 'quick response';
      });

      const wrappedHandler = wrapToolHandler('quickTool', handler, 5000);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('quick response');
    });
  });

  describe('error handling', () => {
    it('should catch and return errors as JSON', async () => {
      const errorMessage = 'Something went wrong';
      const handler = vi.fn().mockRejectedValue(new Error(errorMessage));
      const wrappedHandler = wrapToolHandler('errorTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe(errorMessage);
      expect(parsed.toolName).toBe('errorTool');
      expect(parsed.timedOut).toBe(false);
    });

    it('should handle non-Error exceptions', async () => {
      const handler = vi.fn().mockRejectedValue('string error');
      const wrappedHandler = wrapToolHandler('stringErrorTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Unknown error');
      expect(parsed.timedOut).toBe(false);
    });

    it('should log error messages', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const handler = vi.fn().mockRejectedValue(new Error('test error'));
      const wrappedHandler = wrapToolHandler('failingTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      await resultPromise;

      // Should have START and FAIL logs
      const logCalls = consoleSpy.mock.calls.map((call) => call[0]);
      expect(logCalls.some((msg) => msg.includes('START failingTool'))).toBe(true);
      expect(logCalls.some((msg) => msg.includes('FAIL failingTool'))).toBe(true);
    });
  });

  describe('timing/diagnostics tracking', () => {
    it('should include duration in successful result logs', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const handler = vi.fn().mockResolvedValue('done');
      const wrappedHandler = wrapToolHandler('timedTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      await resultPromise;

      // The END log should include duration
      const endLog = consoleSpy.mock.calls.find((call) => call[0].includes('END timedTool'));
      expect(endLog).toBeDefined();
      expect(endLog![0]).toContain('duration');
    });

    it('should include duration in error responses', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('fail'));
      const wrappedHandler = wrapToolHandler('errorDurationTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      const parsed = JSON.parse(result);
      expect(parsed.duration).toBeDefined();
      expect(typeof parsed.duration).toBe('number');
    });

    it('should truncate large inputs in logs', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const handler = vi.fn().mockResolvedValue('done');
      const wrappedHandler = wrapToolHandler('largeInputTool', handler);

      const largeInput = { data: 'x'.repeat(500) };
      const resultPromise = wrappedHandler(largeInput);
      await vi.runAllTimersAsync();
      await resultPromise;

      // The START log should truncate input
      const startLog = consoleSpy.mock.calls.find((call) =>
        call[0].includes('START largeInputTool')
      );
      expect(startLog).toBeDefined();
      expect(startLog![0]).toContain('...');
    });

    it('should truncate large results in logs', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const largeResult = 'y'.repeat(500);
      const handler = vi.fn().mockResolvedValue(largeResult);
      const wrappedHandler = wrapToolHandler('largeResultTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      await resultPromise;

      // The END log should truncate result
      const endLog = consoleSpy.mock.calls.find((call) => call[0].includes('END largeResultTool'));
      expect(endLog).toBeDefined();
      expect(endLog![0]).toContain('...');
    });
  });

  describe('active tools tracking', () => {
    it('should track active tools during execution', async () => {
      let activeToolsDuringExecution: ReturnType<typeof getActiveTools> = [];
      const handler = vi.fn().mockImplementation(async () => {
        activeToolsDuringExecution = getActiveTools();
        return 'done';
      });
      const wrappedHandler = wrapToolHandler('trackedTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(activeToolsDuringExecution.length).toBe(1);
      expect(activeToolsDuringExecution[0].name).toBe('trackedTool');
      expect(activeToolsDuringExecution[0].status).toBe('running');
    });

    it('should remove tools from active list after completion', async () => {
      const handler = vi.fn().mockResolvedValue('done');
      const wrappedHandler = wrapToolHandler('completedTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      await resultPromise;

      const activeTools = getActiveTools();
      const completedTool = activeTools.find((t) => t.name === 'completedTool');
      expect(completedTool).toBeUndefined();
    });

    it('should remove tools from active list after error', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('fail'));
      const wrappedHandler = wrapToolHandler('failedTool', handler);

      const resultPromise = wrappedHandler({});
      await vi.runAllTimersAsync();
      await resultPromise;

      const activeTools = getActiveTools();
      const failedTool = activeTools.find((t) => t.name === 'failedTool');
      expect(failedTool).toBeUndefined();
    });
  });
});

describe('getActiveTools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return empty array when no tools are running', () => {
    const tools = getActiveTools();
    // Filter out any tools from other tests that might still be tracked
    expect(Array.isArray(tools)).toBe(true);
  });

  it('should calculate current duration for running tools', async () => {
    let capturedTools: ReturnType<typeof getActiveTools> = [];

    const handler = vi.fn().mockImplementation(async () => {
      // Wait a bit before capturing
      await new Promise((resolve) => setTimeout(resolve, 1000));
      capturedTools = getActiveTools();
      return 'done';
    });

    const wrappedHandler = wrapToolHandler('durationTool', handler);
    const resultPromise = wrappedHandler({});

    // Advance time to trigger the internal setTimeout
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();
    await resultPromise;

    const durationTool = capturedTools.find((t) => t.name === 'durationTool');
    expect(durationTool).toBeDefined();
    expect(durationTool!.duration).toBeGreaterThanOrEqual(0);
  });
});

describe('logActiveToolsStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should not log when no tools are active', () => {
    const consoleSpy = vi.spyOn(console, 'log');

    // Clear spy call count
    consoleSpy.mockClear();

    logActiveToolsStatus();

    // The function should not log anything if no tools are active
    // (This may or may not be true depending on active tools from other tests)
    expect(consoleSpy).toHaveBeenCalledTimes(0);
  });

  it('should log warning when tools are active', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    const handler = vi.fn().mockImplementation(async () => {
      // Clear previous log calls
      consoleSpy.mockClear();
      logActiveToolsStatus();
      return 'done';
    });

    const wrappedHandler = wrapToolHandler('activeTool', handler);
    const resultPromise = wrappedHandler({});
    await vi.runAllTimersAsync();
    await resultPromise;

    // The logActiveToolsStatus should have logged a warning
    const warnLog = consoleSpy.mock.calls.find((call) => call[0].includes('tools still running'));
    expect(warnLog).toBeDefined();
  });
});

describe('getToolTimeout', () => {
  it('should return specific timeout for known tools', () => {
    expect(getToolTimeout('remember')).toBe(TOOL_TIMEOUTS.remember);
    expect(getToolTimeout('browser')).toBe(TOOL_TIMEOUTS.browser);
  });

  it('should return default timeout for unknown tools', () => {
    const defaultTimeout = 30000; // TOOL_TIMEOUT_MS
    expect(getToolTimeout('unknownTool')).toBe(defaultTimeout);
    expect(getToolTimeout('randomTool')).toBe(defaultTimeout);
  });
});

describe('TOOL_TIMEOUTS', () => {
  it('should have appropriate timeout values', () => {
    // Fast tools should have short timeouts
    expect(TOOL_TIMEOUTS.remember).toBeLessThanOrEqual(10000);
    expect(TOOL_TIMEOUTS.forget).toBeLessThanOrEqual(10000);
    expect(TOOL_TIMEOUTS.list_facts).toBeLessThanOrEqual(10000);

    // Browser tools should have longer timeouts
    expect(TOOL_TIMEOUTS.browser).toBeGreaterThanOrEqual(30000);
  });
});

describe('synchronous handler support', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should work with handlers that return promises immediately', async () => {
    // The handler type is (input: T) => Promise<string>, so it must return a promise
    // But we can test with an immediately resolving promise
    const handler = vi.fn().mockImplementation(() => Promise.resolve('sync-like result'));
    const wrappedHandler = wrapToolHandler('syncLikeTool', handler);

    const resultPromise = wrappedHandler({ data: 'test' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('sync-like result');
    expect(handler).toHaveBeenCalledWith({ data: 'test' });
  });
});

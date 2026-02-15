import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock session-context
vi.mock('../../src/tools/session-context', () => ({
  getCurrentSessionId: vi.fn(() => 'test-session'),
  setCurrentSessionId: vi.fn(),
  runWithSessionId: vi.fn((id, fn) => fn()),
}));

// Mock better-sqlite3
const mockRun = vi.fn(() => ({ lastInsertRowid: 1, changes: 1 }));
const mockGet = vi.fn();
const mockAll = vi.fn(() => []);
const mockPrepare = vi.fn(() => ({ run: mockRun, get: mockGet, all: mockAll }));
const mockExec = vi.fn();
const mockPragma = vi.fn();
const mockClose = vi.fn();
const mockDb = { prepare: mockPrepare, exec: mockExec, pragma: mockPragma, close: mockClose };

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function () { return mockDb; }),
}));

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}));

vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return { ...actual, default: actual };
});

// Mock scheduler
const mockGetAllJobs = vi.fn(() => []);
const mockDeleteJob = vi.fn(() => true);

vi.mock('../../src/scheduler', () => ({
  getScheduler: vi.fn(() => ({
    getAllJobs: mockGetAllJobs,
    deleteJob: mockDeleteJob,
  })),
}));

import {
  handleCreateRoutineTool,
  handleCreateReminderTool,
  handleListRoutinesTool,
  handleDeleteRoutineTool,
  getCreateRoutineToolDefinition,
  getCreateReminderToolDefinition,
  getListRoutinesToolDefinition,
  getDeleteRoutineToolDefinition,
} from '../../src/tools/scheduler-tools';
import { getScheduler } from '../../src/scheduler';

describe('Scheduler Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined); // No existing job by default
    mockGetAllJobs.mockReturnValue([]);
    mockDeleteJob.mockReturnValue(true);
  });

  // ============================================================================
  // getCreateRoutineToolDefinition
  // ============================================================================

  describe('getCreateRoutineToolDefinition', () => {
    it('has correct name and required fields', () => {
      const def = getCreateRoutineToolDefinition();
      expect(def.name).toBe('create_routine');
      expect(def.input_schema.required).toContain('name');
      expect(def.input_schema.required).toContain('schedule');
      expect(def.input_schema.required).toContain('prompt');
    });
  });

  // ============================================================================
  // handleCreateRoutineTool
  // ============================================================================

  describe('handleCreateRoutineTool', () => {
    it('succeeds with cron schedule "0 9 * * *"', async () => {
      const result = await handleCreateRoutineTool({
        name: 'morning_check',
        schedule: '0 9 * * *',
        prompt: 'Check the weather',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.name).toBe('morning_check');
      expect(parsed.type).toBe('cron');
      expect(parsed.schedule).toContain('cron');
    });

    it('succeeds with "every 30m" interval', async () => {
      const result = await handleCreateRoutineTool({
        name: 'status_check',
        schedule: '30m',
        prompt: 'Check server status',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.type).toBe('every');
      expect(parsed.one_time).toBe(false);
    });

    it('succeeds with "tomorrow 3pm" as one-time job', async () => {
      const result = await handleCreateRoutineTool({
        name: 'one_time_task',
        schedule: 'tomorrow 3pm',
        prompt: 'Send summary email',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.type).toBe('at');
      expect(parsed.one_time).toBe(true);
    });

    it('returns error when required fields are missing', async () => {
      const result = await handleCreateRoutineTool({
        name: 'test',
        schedule: '0 9 * * *',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Missing required fields');
    });

    it('returns error with hint for unparseable schedule', async () => {
      const result = await handleCreateRoutineTool({
        name: 'bad_schedule',
        schedule: 'whenever-you-feel-like-it',
        prompt: 'Do something',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Could not parse schedule');
      expect(parsed.hint).toBeDefined();
    });

    it('updates existing job if name already exists', async () => {
      mockGet.mockReturnValue({ id: 42 }); // Simulate existing job

      const result = await handleCreateRoutineTool({
        name: 'existing_job',
        schedule: '0 9 * * *',
        prompt: 'Updated prompt',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      // Verify the UPDATE query was used (not INSERT)
      const prepareCalls = mockPrepare.mock.calls.map(c => c[0]);
      const hasUpdate = prepareCalls.some(q => typeof q === 'string' && q.includes('UPDATE cron_jobs'));
      expect(hasUpdate).toBe(true);
    });
  });

  // ============================================================================
  // getCreateReminderToolDefinition
  // ============================================================================

  describe('getCreateReminderToolDefinition', () => {
    it('has correct name and required fields', () => {
      const def = getCreateReminderToolDefinition();
      expect(def.name).toBe('create_reminder');
      expect(def.input_schema.required).toContain('name');
      expect(def.input_schema.required).toContain('schedule');
      expect(def.input_schema.required).toContain('reminder');
    });
  });

  // ============================================================================
  // handleCreateReminderTool
  // ============================================================================

  describe('handleCreateReminderTool', () => {
    it('creates a reminder with job_type = reminder', async () => {
      const result = await handleCreateReminderTool({
        name: 'shower_time',
        schedule: 'tomorrow 3pm',
        reminder: 'Time to take a shower!',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.type).toBe('reminder');
      expect(parsed.name).toBe('shower_time');

      // Verify the INSERT used 'reminder' as job_type
      const runCalls = mockRun.mock.calls;
      const hasReminderType = runCalls.some(call =>
        call.some(arg => arg === 'reminder')
      );
      expect(hasReminderType).toBe(true);
    });

    it('returns error when required fields are missing', async () => {
      const result = await handleCreateReminderTool({
        name: 'test',
        schedule: 'tomorrow 3pm',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Missing required fields');
    });

    it('returns error for missing name', async () => {
      const result = await handleCreateReminderTool({
        schedule: 'tomorrow 3pm',
        reminder: 'Hello',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Missing required fields');
    });
  });

  // ============================================================================
  // getListRoutinesToolDefinition
  // ============================================================================

  describe('getListRoutinesToolDefinition', () => {
    it('has correct name', () => {
      const def = getListRoutinesToolDefinition();
      expect(def.name).toBe('list_routines');
    });
  });

  // ============================================================================
  // handleListRoutinesTool
  // ============================================================================

  describe('handleListRoutinesTool', () => {
    it('returns empty when no jobs', async () => {
      mockGetAllJobs.mockReturnValue([]);

      const result = await handleListRoutinesTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('No scheduled tasks');
      expect(parsed.tasks).toEqual([]);
    });

    it('returns formatted jobs', async () => {
      mockGetAllJobs.mockReturnValue([
        {
          name: 'morning_weather',
          job_type: 'routine',
          schedule_type: 'cron',
          schedule: '0 9 * * *',
          run_at: null,
          interval_ms: null,
          next_run_at: '2025-12-25T09:00:00Z',
          prompt: 'Check weather',
          channel: 'desktop',
          enabled: 1,
        },
        {
          name: 'shower_reminder',
          job_type: 'reminder',
          schedule_type: 'at',
          schedule: null,
          run_at: '2025-12-25T15:00:00Z',
          interval_ms: null,
          next_run_at: '2025-12-25T15:00:00Z',
          prompt: 'Time to shower!',
          channel: 'desktop',
          enabled: 1,
        },
      ]);

      const result = await handleListRoutinesTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(2);
      expect(parsed.tasks).toHaveLength(2);
      expect(parsed.tasks[0].name).toBe('morning_weather');
      expect(parsed.tasks[0].type).toBe('routine');
      expect(parsed.tasks[1].type).toBe('reminder');
    });

    it('returns error when scheduler is not initialized', async () => {
      vi.mocked(getScheduler).mockReturnValueOnce(null as ReturnType<typeof getScheduler>);

      const result = await handleListRoutinesTool();
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Scheduler not initialized');
    });
  });

  // ============================================================================
  // getDeleteRoutineToolDefinition
  // ============================================================================

  describe('getDeleteRoutineToolDefinition', () => {
    it('has correct name and required fields', () => {
      const def = getDeleteRoutineToolDefinition();
      expect(def.name).toBe('delete_routine');
      expect(def.input_schema.required).toContain('name');
    });
  });

  // ============================================================================
  // handleDeleteRoutineTool
  // ============================================================================

  describe('handleDeleteRoutineTool', () => {
    it('returns success when job is deleted', async () => {
      mockDeleteJob.mockReturnValue(true);

      const result = await handleDeleteRoutineTool({ name: 'morning_weather' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('morning_weather');
    });

    it('returns not found when job does not exist', async () => {
      mockDeleteJob.mockReturnValue(false);

      const result = await handleDeleteRoutineTool({ name: 'nonexistent' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('nonexistent');
    });

    it('returns error when name is missing', async () => {
      const result = await handleDeleteRoutineTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('name is required');
    });

    it('returns error when scheduler is not initialized', async () => {
      vi.mocked(getScheduler).mockReturnValueOnce(null as ReturnType<typeof getScheduler>);

      const result = await handleDeleteRoutineTool({ name: 'test' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Scheduler not initialized');
    });
  });
});

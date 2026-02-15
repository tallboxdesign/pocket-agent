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

import {
  handleTaskAddTool,
  handleTaskListTool,
  handleTaskCompleteTool,
  handleTaskDeleteTool,
  handleTaskDueTool,
  getTaskAddToolDefinition,
  getTaskListToolDefinition,
  getTaskCompleteToolDefinition,
  getTaskDeleteToolDefinition,
  getTaskDueToolDefinition,
  closeTaskDb,
} from '../../src/tools/task-tools';

describe('Task Tools', () => {
  beforeEach(() => {
    // Reset singleton DB state between tests
    closeTaskDb();
    vi.clearAllMocks();
    mockRun.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
  });

  // ============================================================================
  // handleTaskAddTool
  // ============================================================================

  describe('handleTaskAddTool', () => {
    it('succeeds with title only', async () => {
      const result = await handleTaskAddTool({ title: 'Buy groceries' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe(1);
      expect(parsed.title).toBe('Buy groceries');
      expect(parsed.priority).toBe('medium');
    });

    it('succeeds with due date, priority, and description', async () => {
      const result = await handleTaskAddTool({
        title: 'Submit report',
        due: '2025-12-31T17:00:00Z',
        priority: 'high',
        description: 'Quarterly report',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.priority).toBe('high');
      expect(parsed.due).not.toBeNull();
    });

    it('returns error when title is missing', async () => {
      const result = await handleTaskAddTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('title is required');
    });

    it('returns error for invalid priority', async () => {
      const result = await handleTaskAddTool({
        title: 'Task',
        priority: 'urgent',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Priority must be');
    });

    it('returns error for unparseable due date', async () => {
      const result = await handleTaskAddTool({
        title: 'Task',
        due: 'not-a-date-xyz',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Could not parse due date');
    });

    it('includes session_id in the response', async () => {
      const result = await handleTaskAddTool({ title: 'Test task' });
      const parsed = JSON.parse(result);
      expect(parsed.session_id).toBe('test-session');
    });
  });

  // ============================================================================
  // getTaskAddToolDefinition
  // ============================================================================

  describe('getTaskAddToolDefinition', () => {
    it('has correct name and required fields', () => {
      const def = getTaskAddToolDefinition();
      expect(def.name).toBe('task_add');
      expect(def.input_schema.required).toContain('title');
    });
  });

  // ============================================================================
  // handleTaskListTool
  // ============================================================================

  describe('handleTaskListTool', () => {
    it('defaults filter to pending', async () => {
      mockAll.mockReturnValue([]);

      const result = await handleTaskListTool({});
      const parsed = JSON.parse(result);
      expect(parsed.filter).toBe('pending');

      // Verify query includes status filter
      const lastQuery = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1][0];
      expect(lastQuery).toContain('AND status = ?');
    });

    it('filter = all does not include status clause', async () => {
      mockAll.mockReturnValue([]);

      const result = await handleTaskListTool({ status: 'all' });
      const parsed = JSON.parse(result);
      expect(parsed.filter).toBe('all');

      // Verify query does NOT include status filter
      const lastQuery = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1][0];
      expect(lastQuery).not.toContain('AND status = ?');
    });

    it('returns formatted tasks', async () => {
      mockAll.mockReturnValue([
        { id: 1, title: 'Task A', due_date: '2025-12-25T10:00:00Z', priority: 'high', status: 'pending', reminder_minutes: null },
        { id: 2, title: 'Task B', due_date: null, priority: 'low', status: 'pending', reminder_minutes: 30 },
      ]);

      const result = await handleTaskListTool({});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(2);
      expect(parsed.tasks).toHaveLength(2);
      expect(parsed.tasks[0].title).toBe('Task A');
      expect(parsed.tasks[1].priority).toBe('low');
    });
  });

  // ============================================================================
  // getTaskListToolDefinition
  // ============================================================================

  describe('getTaskListToolDefinition', () => {
    it('has correct name', () => {
      const def = getTaskListToolDefinition();
      expect(def.name).toBe('task_list');
    });
  });

  // ============================================================================
  // handleTaskCompleteTool
  // ============================================================================

  describe('handleTaskCompleteTool', () => {
    it('returns success when changes > 0', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      const result = await handleTaskCompleteTool({ id: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('1');
    });

    it('returns not found when changes === 0', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 0 });

      const result = await handleTaskCompleteTool({ id: 999 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('999');
    });

    it('returns error when id is missing', async () => {
      const result = await handleTaskCompleteTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('id is required');
    });
  });

  // ============================================================================
  // getTaskCompleteToolDefinition
  // ============================================================================

  describe('getTaskCompleteToolDefinition', () => {
    it('has correct name', () => {
      const def = getTaskCompleteToolDefinition();
      expect(def.name).toBe('task_complete');
    });
  });

  // ============================================================================
  // handleTaskDeleteTool
  // ============================================================================

  describe('handleTaskDeleteTool', () => {
    it('returns success when changes > 0', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      const result = await handleTaskDeleteTool({ id: 5 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('5');
    });

    it('returns not found when changes === 0', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 0 });

      const result = await handleTaskDeleteTool({ id: 999 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('999');
    });

    it('returns error when id is missing', async () => {
      const result = await handleTaskDeleteTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('id is required');
    });
  });

  // ============================================================================
  // getTaskDeleteToolDefinition
  // ============================================================================

  describe('getTaskDeleteToolDefinition', () => {
    it('has correct name', () => {
      const def = getTaskDeleteToolDefinition();
      expect(def.name).toBe('task_delete');
    });
  });

  // ============================================================================
  // handleTaskDueTool
  // ============================================================================

  describe('handleTaskDueTool', () => {
    it('defaults to 24 hours', async () => {
      mockAll.mockReturnValue([]);

      const result = await handleTaskDueTool({});
      const parsed = JSON.parse(result);
      expect(parsed.hours).toBe(24);
    });

    it('uses custom hours parameter', async () => {
      mockAll.mockReturnValue([]);

      const result = await handleTaskDueTool({ hours: 48 });
      const parsed = JSON.parse(result);
      expect(parsed.hours).toBe(48);
    });

    it('returns overdue and upcoming arrays', async () => {
      const pastDate = new Date(Date.now() - 3600000).toISOString();
      const futureDate = new Date(Date.now() + 3600000).toISOString();

      mockAll.mockReturnValue([
        { id: 1, title: 'Overdue Task', due_date: pastDate, priority: 'high', status: 'pending' },
        { id: 2, title: 'Upcoming Task', due_date: futureDate, priority: 'medium', status: 'pending' },
      ]);

      const result = await handleTaskDueTool({ hours: 24 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.overdue).toHaveLength(1);
      expect(parsed.upcoming).toHaveLength(1);
      expect(parsed.overdue[0].title).toBe('Overdue Task');
      expect(parsed.upcoming[0].title).toBe('Upcoming Task');
    });
  });

  // ============================================================================
  // getTaskDueToolDefinition
  // ============================================================================

  describe('getTaskDueToolDefinition', () => {
    it('has correct name', () => {
      const def = getTaskDueToolDefinition();
      expect(def.name).toBe('task_due');
    });
  });

  // ============================================================================
  // closeTaskDb
  // ============================================================================

  describe('closeTaskDb', () => {
    it('does not throw', () => {
      expect(() => closeTaskDb()).not.toThrow();
    });
  });
});

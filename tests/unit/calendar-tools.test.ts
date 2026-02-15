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
  handleCalendarAddTool,
  handleCalendarListTool,
  handleCalendarUpcomingTool,
  handleCalendarDeleteTool,
  getCalendarAddToolDefinition,
  getCalendarListToolDefinition,
  getCalendarUpcomingToolDefinition,
  getCalendarDeleteToolDefinition,
  closeCalendarDb,
} from '../../src/tools/calendar-tools';

describe('Calendar Tools', () => {
  beforeEach(() => {
    // Reset singleton DB state between tests
    closeCalendarDb();
    vi.clearAllMocks();
    mockRun.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
  });

  // ============================================================================
  // getCalendarAddToolDefinition
  // ============================================================================

  describe('getCalendarAddToolDefinition', () => {
    it('has correct name', () => {
      const def = getCalendarAddToolDefinition();
      expect(def.name).toBe('calendar_add');
    });

    it('has required fields: title and start_time', () => {
      const def = getCalendarAddToolDefinition();
      expect(def.input_schema.required).toContain('title');
      expect(def.input_schema.required).toContain('start_time');
    });
  });

  // ============================================================================
  // handleCalendarAddTool
  // ============================================================================

  describe('handleCalendarAddTool', () => {
    it('returns success with id and title on valid input', async () => {
      const result = await handleCalendarAddTool({
        title: 'Team Meeting',
        start_time: '2025-12-25T10:00:00Z',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe(1);
      expect(parsed.title).toBe('Team Meeting');
    });

    it('returns error when title is missing', async () => {
      const result = await handleCalendarAddTool({ start_time: 'tomorrow 3pm' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('title');
    });

    it('returns error when start_time is missing', async () => {
      const result = await handleCalendarAddTool({ title: 'Meeting' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('title and start_time are required');
    });

    it('returns error for unparseable start_time', async () => {
      const result = await handleCalendarAddTool({
        title: 'Meeting',
        start_time: 'not-a-real-date-xyz',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Could not parse start time');
    });

    it('defaults reminder_minutes to 15', async () => {
      const result = await handleCalendarAddTool({
        title: 'Standup',
        start_time: '2025-12-25T09:00:00Z',
      });
      const parsed = JSON.parse(result);
      expect(parsed.reminder_minutes).toBe(15);
    });

    it('parses "tomorrow 3pm" and calls prepare/run', async () => {
      await handleCalendarAddTool({
        title: 'Dentist',
        start_time: 'tomorrow 3pm',
      });
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });

    it('includes session_id in the response', async () => {
      const result = await handleCalendarAddTool({
        title: 'Event',
        start_time: '2025-12-25T10:00:00Z',
      });
      const parsed = JSON.parse(result);
      expect(parsed.session_id).toBe('test-session');
    });
  });

  // ============================================================================
  // getCalendarListToolDefinition
  // ============================================================================

  describe('getCalendarListToolDefinition', () => {
    it('has correct name', () => {
      const def = getCalendarListToolDefinition();
      expect(def.name).toBe('calendar_list');
    });
  });

  // ============================================================================
  // handleCalendarListTool
  // ============================================================================

  describe('handleCalendarListTool', () => {
    it('lists all events when no date filter', async () => {
      mockAll.mockReturnValue([
        { id: 1, title: 'Event A', start_time: '2025-12-25T10:00:00Z', end_time: null, location: null, reminder_minutes: 15 },
        { id: 2, title: 'Event B', start_time: '2025-12-26T14:00:00Z', end_time: null, location: 'Office', reminder_minutes: 30 },
      ]);

      const result = await handleCalendarListTool({});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(2);
      expect(parsed.events).toHaveLength(2);
      expect(parsed.events[0].title).toBe('Event A');
    });

    it('filters by date when "today" is passed', async () => {
      mockAll.mockReturnValue([]);

      await handleCalendarListTool({ date: 'today' });

      // Verify that prepare was called with a query containing date filter
      const callArgs = mockPrepare.mock.calls;
      const lastQuery = callArgs[callArgs.length - 1][0];
      expect(lastQuery).toContain('date(start_time) = date(?)');
    });

    it('returns empty array when no events', async () => {
      mockAll.mockReturnValue([]);

      const result = await handleCalendarListTool({});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.events).toEqual([]);
    });
  });

  // ============================================================================
  // getCalendarUpcomingToolDefinition
  // ============================================================================

  describe('getCalendarUpcomingToolDefinition', () => {
    it('has correct name', () => {
      const def = getCalendarUpcomingToolDefinition();
      expect(def.name).toBe('calendar_upcoming');
    });
  });

  // ============================================================================
  // handleCalendarUpcomingTool
  // ============================================================================

  describe('handleCalendarUpcomingTool', () => {
    it('defaults to 24 hours when no hours parameter', async () => {
      mockAll.mockReturnValue([]);

      const result = await handleCalendarUpcomingTool({});
      const parsed = JSON.parse(result);
      expect(parsed.hours).toBe(24);
    });

    it('uses custom hours parameter', async () => {
      mockAll.mockReturnValue([]);

      const result = await handleCalendarUpcomingTool({ hours: 48 });
      const parsed = JSON.parse(result);
      expect(parsed.hours).toBe(48);
    });

    it('returns events within the time window', async () => {
      mockAll.mockReturnValue([
        { id: 1, title: 'Soon', start_time: new Date(Date.now() + 3600000).toISOString(), location: null },
      ]);

      const result = await handleCalendarUpcomingTool({ hours: 2 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
    });
  });

  // ============================================================================
  // getCalendarDeleteToolDefinition
  // ============================================================================

  describe('getCalendarDeleteToolDefinition', () => {
    it('has correct name and required id', () => {
      const def = getCalendarDeleteToolDefinition();
      expect(def.name).toBe('calendar_delete');
      expect(def.input_schema.required).toContain('id');
    });
  });

  // ============================================================================
  // handleCalendarDeleteTool
  // ============================================================================

  describe('handleCalendarDeleteTool', () => {
    it('returns success when event is found and deleted', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      const result = await handleCalendarDeleteTool({ id: 42 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('42');
    });

    it('returns not found when changes === 0', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 0 });

      const result = await handleCalendarDeleteTool({ id: 999 });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('999');
    });

    it('returns error when id is missing', async () => {
      const result = await handleCalendarDeleteTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('id is required');
    });
  });

  // ============================================================================
  // closeCalendarDb
  // ============================================================================

  describe('closeCalendarDb', () => {
    it('does not throw', () => {
      expect(() => closeCalendarDb()).not.toThrow();
    });
  });
});

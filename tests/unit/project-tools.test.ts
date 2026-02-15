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

// Mock fs with both default and named exports
const mockExistsSync = vi.fn(() => true);
const mockStatSync = vi.fn(() => ({ isDirectory: () => true }));

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return { ...actual, default: actual };
});

// Mock AgentManager
vi.mock('../../src/agent/index.js', () => ({
  AgentManager: {
    setWorkspace: vi.fn(),
    getWorkspace: vi.fn(() => '/mock/workspace'),
    getProjectRoot: vi.fn(() => '/mock/default'),
    resetWorkspace: vi.fn(),
  },
}));

import {
  handleSetProjectTool,
  handleGetProjectTool,
  handleClearProjectTool,
} from '../../src/tools/project-tools';
import { AgentManager } from '../../src/agent/index.js';

describe('Project Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  // ============================================================================
  // handleSetProjectTool
  // ============================================================================

  describe('handleSetProjectTool', () => {
    it('returns error when path is missing', async () => {
      const result = await handleSetProjectTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('path is required');
    });

    it('returns error for path traversal (..)', async () => {
      const result = await handleSetProjectTool({ path: '/usr/../etc/passwd' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('traversal');
    });

    it('returns error for relative path', async () => {
      const result = await handleSetProjectTool({ path: 'relative/path' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Path must be absolute');
    });

    it('returns error when path does not exist', async () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        // DB path exists, but the project path does not
        if (typeof p === 'string' && p.includes('pocket-agent.db')) return true;
        if (typeof p === 'string' && p === '/nonexistent/project') return false;
        return true;
      });

      const result = await handleSetProjectTool({ path: '/nonexistent/project' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('does not exist');
    });

    it('returns error when path is a file, not a directory', async () => {
      mockStatSync.mockReturnValue({ isDirectory: () => false });

      const result = await handleSetProjectTool({ path: '/some/file.txt' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('not a directory');
    });

    it('succeeds: saves to DB and calls AgentManager.setWorkspace', async () => {
      const result = await handleSetProjectTool({ path: '/Users/kenkai/my-project' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.path).toBeDefined();
      expect(AgentManager.setWorkspace).toHaveBeenCalled();

      // Verify the DB prepare was called for the INSERT
      const prepareCalls = mockPrepare.mock.calls.map(c => c[0]);
      const hasInsert = prepareCalls.some(q => typeof q === 'string' && q.includes('INSERT INTO settings'));
      expect(hasInsert).toBe(true);
    });

    it('returns error when DB is not found', async () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        // DB does not exist, but the project path does
        if (typeof p === 'string' && p.includes('pocket-agent.db')) return false;
        return true;
      });

      const result = await handleSetProjectTool({ path: '/Users/kenkai/my-project' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Database not found');
    });
  });

  // ============================================================================
  // handleGetProjectTool
  // ============================================================================

  describe('handleGetProjectTool', () => {
    it('returns hasProject: false when no active project in DB', async () => {
      mockGet.mockReturnValue(undefined);

      const result = await handleGetProjectTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.hasProject).toBe(false);
      expect(parsed.currentWorkspace).toBe('/mock/workspace');
    });

    it('returns hasProject: true with path when active project exists', async () => {
      mockGet.mockReturnValue({ value: '/Users/kenkai/my-project' });

      const result = await handleGetProjectTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.hasProject).toBe(true);
      expect(parsed.path).toBe('/Users/kenkai/my-project');
      expect(parsed.exists).toBe(true);
    });

    it('returns warning when active project path has been deleted', async () => {
      mockGet.mockReturnValue({ value: '/Users/kenkai/deleted-project' });
      mockExistsSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p === '/Users/kenkai/deleted-project') return false;
        return true;
      });

      const result = await handleGetProjectTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.hasProject).toBe(true);
      expect(parsed.warning).toContain('no longer exists');
      expect(parsed.exists).toBe(false);
    });

    it('returns runtime workspace when no DB is available', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await handleGetProjectTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.hasProject).toBe(false);
      expect(parsed.currentWorkspace).toBe('/mock/workspace');
      expect(parsed.defaultWorkspace).toBe('/mock/default');
    });
  });

  // ============================================================================
  // handleClearProjectTool
  // ============================================================================

  describe('handleClearProjectTool', () => {
    it('returns success and calls resetWorkspace when project was active', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 1 });

      const result = await handleClearProjectTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('cleared');
      expect(AgentManager.resetWorkspace).toHaveBeenCalled();
    });

    it('returns message saying none was set when no active project', async () => {
      mockRun.mockReturnValue({ lastInsertRowid: 0, changes: 0 });

      const result = await handleClearProjectTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('No active project was set');
    });

    it('returns error when DB is not found', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await handleClearProjectTool();
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Database not found');
    });
  });
});

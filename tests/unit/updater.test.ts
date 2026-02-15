/**
 * Unit tests for the auto-updater module
 *
 * Tests updater initialization, status reporting, IPC handler setup,
 * and dev-mode behavior with mocked electron-updater and Electron.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Use vi.hoisted to create variables that are available in vi.mock factories
const { mockAutoUpdater, mockIpcMainHandle } = vi.hoisted(() => ({
  mockAutoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
  mockIpcMainHandle: vi.fn(),
}));

let mockIsPackaged = false;

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: (...args: unknown[]) => mockIpcMainHandle(...args),
  },
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
  },
}));

vi.mock('../../src/settings', () => ({
  SettingsManager: {
    get: vi.fn(() => 'true'),
  },
}));

// Must import after mocks are set up
import { getUpdateStatus, initializeUpdater, checkForUpdates, setupUpdaterIPC } from '../../src/main/updater';

describe('updater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPackaged = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getUpdateStatus', () => {
    it('returns a status object', () => {
      const status = getUpdateStatus();

      expect(status).toBeDefined();
      expect(status).toHaveProperty('status');
    });
  });

  describe('initializeUpdater', () => {
    it('sets status to dev-mode when not packaged', () => {
      mockIsPackaged = false;

      initializeUpdater();

      const status = getUpdateStatus();
      expect(status.status).toBe('dev-mode');
      expect(status.error).toContain('packaged app');
    });

    it('sets up event handlers when packaged', () => {
      mockIsPackaged = true;

      initializeUpdater();

      // Should register event handlers on autoUpdater
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('checking-for-update', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-not-available', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('download-progress', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('configures autoUpdater settings when packaged', () => {
      mockIsPackaged = true;

      initializeUpdater();

      expect(mockAutoUpdater.autoDownload).toBe(false);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
    });
  });

  describe('checkForUpdates', () => {
    it('returns dev-mode status when not packaged', async () => {
      mockIsPackaged = false;

      const status = await checkForUpdates();

      expect(status.status).toBe('dev-mode');
    });
  });

  describe('setupUpdaterIPC', () => {
    it('registers 4 IPC handlers', () => {
      setupUpdaterIPC();

      expect(mockIpcMainHandle).toHaveBeenCalledTimes(4);
      expect(mockIpcMainHandle).toHaveBeenCalledWith('updater:checkForUpdates', expect.any(Function));
      expect(mockIpcMainHandle).toHaveBeenCalledWith('updater:downloadUpdate', expect.any(Function));
      expect(mockIpcMainHandle).toHaveBeenCalledWith('updater:installUpdate', expect.any(Function));
      expect(mockIpcMainHandle).toHaveBeenCalledWith('updater:getStatus', expect.any(Function));
    });
  });
});

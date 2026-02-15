/**
 * Unit tests for macOS permission detection and management
 *
 * Tests permission checking, missing permission detection,
 * and status reporting with mocked Electron and system APIs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetMediaAccessStatus = vi.fn(() => 'granted');
const mockIsTrustedAccessibilityClient = vi.fn(() => true);
const mockAskForMediaAccess = vi.fn(async () => true);
const mockOpenExternal = vi.fn();

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: (...args: unknown[]) => mockGetMediaAccessStatus(...args),
    isTrustedAccessibilityClient: (...args: unknown[]) => mockIsTrustedAccessibilityClient(...args),
    askForMediaAccess: (...args: unknown[]) => mockAskForMediaAccess(...args),
  },
  shell: {
    openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  },
}));

const mockExecSync = vi.fn(() => 'authorized');

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const mockAccessSync = vi.fn();

vi.mock('fs', () => ({
  accessSync: (...args: unknown[]) => mockAccessSync(...args),
  constants: { R_OK: 4 },
}));

const mockPlatform = vi.fn(() => 'darwin');
const mockHomedir = vi.fn(() => '/mock/home');

vi.mock('os', () => ({
  platform: () => mockPlatform(),
  homedir: () => mockHomedir(),
}));

import {
  isMacOS,
  checkPermission,
  getMissingPermissions,
  getPermissionStatus,
  getAllPermissionTypes,
  requestPermission,
  openPermissionSettings,
  PermissionType,
} from '../../src/permissions/macos';

describe('macos-permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue('darwin');
    mockGetMediaAccessStatus.mockReturnValue('granted');
    mockIsTrustedAccessibilityClient.mockReturnValue(true);
    mockAccessSync.mockImplementation(() => undefined); // no throw = access granted
    mockExecSync.mockReturnValue('authorized');
  });

  describe('isMacOS', () => {
    it('returns true on darwin', () => {
      mockPlatform.mockReturnValue('darwin');
      expect(isMacOS()).toBe(true);
    });

    it('returns false on other platforms', () => {
      mockPlatform.mockReturnValue('win32');
      expect(isMacOS()).toBe(false);
    });
  });

  describe('checkPermission', () => {
    it('returns true for camera when granted', () => {
      mockGetMediaAccessStatus.mockReturnValue('granted');
      expect(checkPermission('camera')).toBe(true);
    });

    it('returns false for camera when not granted', () => {
      mockGetMediaAccessStatus.mockReturnValue('denied');
      expect(checkPermission('camera')).toBe(false);
    });

    it('returns true for microphone when granted', () => {
      mockGetMediaAccessStatus.mockReturnValue('granted');
      expect(checkPermission('microphone')).toBe(true);
    });

    it('returns true for screen-recording when granted', () => {
      mockGetMediaAccessStatus.mockReturnValue('granted');
      expect(checkPermission('screen-recording')).toBe(true);
    });

    it('returns true for accessibility when trusted', () => {
      mockIsTrustedAccessibilityClient.mockReturnValue(true);
      expect(checkPermission('accessibility')).toBe(true);
    });

    it('returns false for accessibility when not trusted', () => {
      mockIsTrustedAccessibilityClient.mockReturnValue(false);
      expect(checkPermission('accessibility')).toBe(false);
    });

    it('returns true for bluetooth (always true)', () => {
      expect(checkPermission('bluetooth')).toBe(true);
    });

    it('returns true for automation (always true)', () => {
      expect(checkPermission('automation')).toBe(true);
    });

    it('returns true for full-disk-access when file is accessible', () => {
      mockAccessSync.mockImplementation(() => undefined);
      expect(checkPermission('full-disk-access')).toBe(true);
    });

    it('returns false for full-disk-access when no protected files are accessible', () => {
      mockAccessSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });
      expect(checkPermission('full-disk-access')).toBe(false);
    });

    it('returns true on non-macOS platform for all types', () => {
      mockPlatform.mockReturnValue('win32');
      expect(checkPermission('camera')).toBe(true);
      expect(checkPermission('microphone')).toBe(true);
      expect(checkPermission('accessibility')).toBe(true);
      expect(checkPermission('screen-recording')).toBe(true);
    });
  });

  describe('getMissingPermissions', () => {
    it('returns types that are not granted', () => {
      mockGetMediaAccessStatus.mockReturnValue('denied');
      mockIsTrustedAccessibilityClient.mockReturnValue(false);

      const missing = getMissingPermissions(['camera', 'microphone', 'bluetooth']);

      expect(missing).toContain('camera');
      expect(missing).toContain('microphone');
      // bluetooth is always true
      expect(missing).not.toContain('bluetooth');
    });

    it('returns empty array when all permissions granted', () => {
      mockGetMediaAccessStatus.mockReturnValue('granted');
      mockIsTrustedAccessibilityClient.mockReturnValue(true);

      const missing = getMissingPermissions(['camera', 'microphone', 'accessibility']);

      expect(missing).toEqual([]);
    });

    it('returns empty array on non-macOS platform', () => {
      mockPlatform.mockReturnValue('linux');

      const missing = getMissingPermissions(['camera', 'microphone', 'accessibility']);

      expect(missing).toEqual([]);
    });
  });

  describe('getPermissionStatus', () => {
    it('returns correct status shape for a permission', () => {
      const status = getPermissionStatus('camera');

      expect(status).toEqual(
        expect.objectContaining({
          type: 'camera',
          granted: true,
          canRequest: true,
          label: 'Camera',
          description: expect.any(String),
          settingsUrl: expect.any(String),
        }),
      );
    });

    it('returns canRequest true for camera, microphone, accessibility', () => {
      expect(getPermissionStatus('camera').canRequest).toBe(true);
      expect(getPermissionStatus('microphone').canRequest).toBe(true);
      expect(getPermissionStatus('accessibility').canRequest).toBe(true);
    });

    it('returns canRequest false for non-requestable permissions', () => {
      expect(getPermissionStatus('screen-recording').canRequest).toBe(false);
      expect(getPermissionStatus('full-disk-access').canRequest).toBe(false);
      expect(getPermissionStatus('calendar').canRequest).toBe(false);
    });
  });

  describe('getAllPermissionTypes', () => {
    it('returns all 10 permission types', () => {
      const types = getAllPermissionTypes();

      expect(types).toHaveLength(10);
      expect(types).toContain('accessibility');
      expect(types).toContain('screen-recording');
      expect(types).toContain('full-disk-access');
      expect(types).toContain('reminders');
      expect(types).toContain('contacts');
      expect(types).toContain('calendar');
      expect(types).toContain('camera');
      expect(types).toContain('microphone');
      expect(types).toContain('bluetooth');
      expect(types).toContain('automation');
    });
  });

  describe('requestPermission', () => {
    it('asks for camera access on macOS', async () => {
      mockAskForMediaAccess.mockResolvedValue(true);

      const result = await requestPermission('camera');

      expect(result).toBe(true);
      expect(mockAskForMediaAccess).toHaveBeenCalledWith('camera');
    });

    it('asks for microphone access on macOS', async () => {
      mockAskForMediaAccess.mockResolvedValue(true);

      const result = await requestPermission('microphone');

      expect(result).toBe(true);
      expect(mockAskForMediaAccess).toHaveBeenCalledWith('microphone');
    });

    it('returns true on non-macOS platforms', async () => {
      mockPlatform.mockReturnValue('win32');

      const result = await requestPermission('camera');

      expect(result).toBe(true);
    });

    it('opens settings for non-requestable permissions', async () => {
      const result = await requestPermission('full-disk-access');

      expect(result).toBe(false);
      expect(mockOpenExternal).toHaveBeenCalled();
    });
  });

  describe('openPermissionSettings', () => {
    it('opens macOS system preferences URL', async () => {
      await openPermissionSettings('camera');

      expect(mockOpenExternal).toHaveBeenCalledWith(
        expect.stringContaining('x-apple.systempreferences'),
      );
    });

    it('opens Windows settings URL on win32', async () => {
      mockPlatform.mockReturnValue('win32');

      await openPermissionSettings('camera');

      expect(mockOpenExternal).toHaveBeenCalledWith('ms-settings:privacy-webcam');
    });
  });
});

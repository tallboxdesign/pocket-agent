/**
 * Unit tests for Telegram authentication middleware
 *
 * Tests user allowlist checking and middleware authorization flow
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock settings module
vi.mock('../../src/settings', () => ({
  SettingsManager: {
    getArray: vi.fn(() => []),
  },
}));

import { SettingsManager } from '../../src/settings';
import {
  isUserAllowed,
  getAllowedUsers,
  createAuthMiddleware,
} from '../../src/channels/telegram/middleware/auth';

describe('Auth Middleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(SettingsManager.getArray).mockReturnValue([]);
  });

  // ============ isUserAllowed ============

  describe('isUserAllowed', () => {
    it('should return true when user ID is in the allowlist', () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123', '456', '789']);

      expect(isUserAllowed(456)).toBe(true);
    });

    it('should return false when user ID is not in the allowlist', () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123', '456']);

      expect(isUserAllowed(999)).toBe(false);
    });

    it('should return false when allowlist is empty', () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue([]);

      expect(isUserAllowed(123)).toBe(false);
    });

    it('should handle single-user allowlist', () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['42']);

      expect(isUserAllowed(42)).toBe(true);
      expect(isUserAllowed(99)).toBe(false);
    });
  });

  // ============ getAllowedUsers ============

  describe('getAllowedUsers', () => {
    it('should return parsed integer user IDs', () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123', '456', '789']);

      const result = getAllowedUsers();

      expect(result).toEqual([123, 456, 789]);
    });

    it('should filter out NaN values', () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123', 'invalid', '456', '', 'abc']);

      const result = getAllowedUsers();

      expect(result).toEqual([123, 456]);
    });

    it('should return empty array for empty settings', () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue([]);

      const result = getAllowedUsers();

      expect(result).toEqual([]);
    });

    it('should call SettingsManager.getArray with correct key', () => {
      getAllowedUsers();

      expect(SettingsManager.getArray).toHaveBeenCalledWith('telegram.allowedUserIds');
    });
  });

  // ============ createAuthMiddleware ============

  describe('createAuthMiddleware', () => {
    it('should call next() when user is authorized', async () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123', '456']);

      const middleware = createAuthMiddleware();
      const ctx = {
        from: { id: 123 },
        reply: vi.fn(),
      } as unknown as Parameters<ReturnType<typeof createAuthMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(next).toHaveBeenCalledOnce();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should reply with unauthorized message when user is not authorized', async () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123']);

      const middleware = createAuthMiddleware();
      const ctx = {
        from: { id: 999 },
        reply: vi.fn(),
      } as unknown as Parameters<ReturnType<typeof createAuthMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledOnce();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('not authorized')
      );
    });

    it('should block when allowlist is empty', async () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue([]);

      const middleware = createAuthMiddleware();
      const ctx = {
        from: { id: 123 },
        reply: vi.fn(),
      } as unknown as Parameters<ReturnType<typeof createAuthMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledOnce();
    });

    it('should block when ctx.from is undefined', async () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123']);

      const middleware = createAuthMiddleware();
      const ctx = {
        from: undefined,
        reply: vi.fn(),
      } as unknown as Parameters<ReturnType<typeof createAuthMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledOnce();
    });

    it('should block when ctx.from.id is undefined', async () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue(['123']);

      const middleware = createAuthMiddleware();
      const ctx = {
        from: { id: undefined },
        reply: vi.fn(),
      } as unknown as Parameters<ReturnType<typeof createAuthMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledOnce();
    });

    it('should include mention of Settings in unauthorized message', async () => {
      vi.mocked(SettingsManager.getArray).mockReturnValue([]);

      const middleware = createAuthMiddleware();
      const ctx = {
        from: { id: 1 },
        reply: vi.fn(),
      } as unknown as Parameters<ReturnType<typeof createAuthMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Settings')
      );
    });
  });
});

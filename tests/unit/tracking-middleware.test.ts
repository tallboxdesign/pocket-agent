/**
 * Unit tests for Telegram chat tracking middleware
 *
 * Tests ChatTracker class and the tracking middleware factory
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock settings module
vi.mock('../../src/settings', () => ({
  SettingsManager: {
    getArray: vi.fn(() => []),
    set: vi.fn(),
  },
}));

import { SettingsManager } from '../../src/settings';
import {
  ChatTracker,
  createTrackingMiddleware,
} from '../../src/channels/telegram/middleware/tracking';

describe('Tracking Middleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(SettingsManager.getArray).mockReturnValue([]);
  });

  // ============ ChatTracker ============

  describe('ChatTracker', () => {
    describe('track', () => {
      it('should return true for a new chat ID', () => {
        const tracker = new ChatTracker();
        expect(tracker.track(100)).toBe(true);
      });

      it('should return false for an already tracked chat ID', () => {
        const tracker = new ChatTracker();
        tracker.track(100);
        expect(tracker.track(100)).toBe(false);
      });

      it('should persist chat IDs after tracking', () => {
        const tracker = new ChatTracker();
        tracker.track(100);

        expect(SettingsManager.set).toHaveBeenCalled();
      });

      it('should not persist when tracking existing ID', () => {
        const tracker = new ChatTracker();
        tracker.track(100);
        vi.mocked(SettingsManager.set).mockClear();

        tracker.track(100); // track again
        expect(SettingsManager.set).not.toHaveBeenCalled();
      });
    });

    describe('isTracked', () => {
      it('should return true after tracking a chat ID', () => {
        const tracker = new ChatTracker();
        tracker.track(200);
        expect(tracker.isTracked(200)).toBe(true);
      });

      it('should return false for untracked chat ID', () => {
        const tracker = new ChatTracker();
        expect(tracker.isTracked(999)).toBe(false);
      });

      it('should return false after untracking', () => {
        const tracker = new ChatTracker();
        tracker.track(300);
        tracker.untrack(300);
        expect(tracker.isTracked(300)).toBe(false);
      });
    });

    describe('untrack', () => {
      it('should remove a tracked chat ID', () => {
        const tracker = new ChatTracker();
        tracker.track(400);
        tracker.untrack(400);
        expect(tracker.isTracked(400)).toBe(false);
      });

      it('should be a noop for non-tracked chat ID', () => {
        const tracker = new ChatTracker();
        vi.mocked(SettingsManager.set).mockClear();

        tracker.untrack(999);

        // Should not call persist since nothing changed
        expect(SettingsManager.set).not.toHaveBeenCalled();
      });

      it('should persist after removing a tracked ID', () => {
        const tracker = new ChatTracker();
        tracker.track(500);
        vi.mocked(SettingsManager.set).mockClear();

        tracker.untrack(500);

        expect(SettingsManager.set).toHaveBeenCalled();
      });
    });

    describe('getAll', () => {
      it('should return all tracked chat IDs', () => {
        const tracker = new ChatTracker();
        tracker.track(10);
        tracker.track(20);
        tracker.track(30);

        const all = tracker.getAll();
        expect(all).toHaveLength(3);
        expect(all).toContain(10);
        expect(all).toContain(20);
        expect(all).toContain(30);
      });

      it('should return empty array when nothing tracked', () => {
        const tracker = new ChatTracker();
        expect(tracker.getAll()).toEqual([]);
      });

      it('should not include untracked IDs', () => {
        const tracker = new ChatTracker();
        tracker.track(10);
        tracker.track(20);
        tracker.untrack(10);

        const all = tracker.getAll();
        expect(all).toHaveLength(1);
        expect(all).toContain(20);
        expect(all).not.toContain(10);
      });
    });

    describe('count', () => {
      it('should return 0 for fresh tracker', () => {
        const tracker = new ChatTracker();
        expect(tracker.count).toBe(0);
      });

      it('should reflect additions', () => {
        const tracker = new ChatTracker();
        tracker.track(1);
        expect(tracker.count).toBe(1);
        tracker.track(2);
        expect(tracker.count).toBe(2);
        tracker.track(3);
        expect(tracker.count).toBe(3);
      });

      it('should reflect removals', () => {
        const tracker = new ChatTracker();
        tracker.track(1);
        tracker.track(2);
        expect(tracker.count).toBe(2);

        tracker.untrack(1);
        expect(tracker.count).toBe(1);

        tracker.untrack(2);
        expect(tracker.count).toBe(0);
      });

      it('should not double-count duplicate tracks', () => {
        const tracker = new ChatTracker();
        tracker.track(42);
        tracker.track(42);
        tracker.track(42);
        expect(tracker.count).toBe(1);
      });
    });

    describe('constructor - loading persisted IDs', () => {
      it('should load persisted chat IDs from settings', () => {
        vi.mocked(SettingsManager.getArray).mockReturnValue(['100', '200', '300']);

        const tracker = new ChatTracker();

        expect(tracker.isTracked(100)).toBe(true);
        expect(tracker.isTracked(200)).toBe(true);
        expect(tracker.isTracked(300)).toBe(true);
        expect(tracker.count).toBe(3);
      });

      it('should filter out NaN values from persisted IDs', () => {
        vi.mocked(SettingsManager.getArray).mockReturnValue(['100', 'invalid', '200']);

        const tracker = new ChatTracker();

        expect(tracker.count).toBe(2);
        expect(tracker.isTracked(100)).toBe(true);
        expect(tracker.isTracked(200)).toBe(true);
      });

      it('should handle empty persisted settings', () => {
        vi.mocked(SettingsManager.getArray).mockReturnValue([]);

        const tracker = new ChatTracker();

        expect(tracker.count).toBe(0);
      });
    });
  });

  // ============ createTrackingMiddleware ============

  describe('createTrackingMiddleware', () => {
    it('should track chatId and call next()', async () => {
      const tracker = new ChatTracker();
      const middleware = createTrackingMiddleware(tracker);

      const ctx = {
        chat: { id: 12345 },
      } as unknown as Parameters<ReturnType<typeof createTrackingMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(tracker.isTracked(12345)).toBe(true);
      expect(next).toHaveBeenCalledOnce();
    });

    it('should call next() even with no chatId', async () => {
      const tracker = new ChatTracker();
      const middleware = createTrackingMiddleware(tracker);

      const ctx = {
        chat: undefined,
      } as unknown as Parameters<ReturnType<typeof createTrackingMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);

      expect(next).toHaveBeenCalledOnce();
      expect(tracker.count).toBe(0);
    });

    it('should not duplicate-track on multiple messages from same chat', async () => {
      const tracker = new ChatTracker();
      const middleware = createTrackingMiddleware(tracker);

      const ctx = {
        chat: { id: 777 },
      } as unknown as Parameters<ReturnType<typeof createTrackingMiddleware>>[0];
      const next = vi.fn();

      await middleware(ctx, next);
      await middleware(ctx, next);
      await middleware(ctx, next);

      expect(tracker.count).toBe(1);
      expect(next).toHaveBeenCalledTimes(3);
    });

    it('should track multiple different chat IDs', async () => {
      const tracker = new ChatTracker();
      const middleware = createTrackingMiddleware(tracker);
      const next = vi.fn();

      const ctx1 = { chat: { id: 1 } } as unknown as Parameters<ReturnType<typeof createTrackingMiddleware>>[0];
      const ctx2 = { chat: { id: 2 } } as unknown as Parameters<ReturnType<typeof createTrackingMiddleware>>[0];
      const ctx3 = { chat: { id: 3 } } as unknown as Parameters<ReturnType<typeof createTrackingMiddleware>>[0];

      await middleware(ctx1, next);
      await middleware(ctx2, next);
      await middleware(ctx3, next);

      expect(tracker.count).toBe(3);
      expect(tracker.isTracked(1)).toBe(true);
      expect(tracker.isTracked(2)).toBe(true);
      expect(tracker.isTracked(3)).toBe(true);
    });
  });
});

/**
 * Unit tests for the browser launcher module
 *
 * Tests browser detection, CDP connection testing, and browser launching
 * with mocked filesystem, child_process, and fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  exec: vi.fn((_cmd: string, cb: (err: Error | null, result: { stdout: string }) => void) =>
    cb(null, { stdout: '' }),
  ),
}));

vi.mock('util', () => ({
  promisify: vi.fn(
    (fn: (...args: unknown[]) => void) =>
      vi.fn(
        (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            fn(...args, (err: Error | null, result: unknown) => (err ? reject(err) : resolve(result)));
          }),
      ),
  ),
}));

import { existsSync } from 'fs';
import { detectInstalledBrowsers, testCdpConnection, launchBrowser } from '../../src/browser/launcher';

describe('browser-launcher', () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('detectInstalledBrowsers', () => {
    it('returns empty array when no browsers are installed', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const browsers = detectInstalledBrowsers();

      expect(browsers).toEqual([]);
    });

    it('returns browser info when Chrome path exists', () => {
      // Return true for Chrome's macOS path, false for everything else
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        return p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      });

      const browsers = detectInstalledBrowsers();

      expect(browsers.length).toBeGreaterThanOrEqual(1);
      const chrome = browsers.find((b) => b.id === 'chrome');
      expect(chrome).toBeDefined();
      expect(chrome!.name).toBe('Google Chrome');
      expect(chrome!.installed).toBe(true);
    });
  });

  describe('testCdpConnection', () => {
    it('returns connected when fetch succeeds', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ Browser: 'Chrome/120' }),
      });

      const result = await testCdpConnection('http://localhost:9222');

      expect(result.connected).toBe(true);
      expect(result.browserInfo).toEqual({ Browser: 'Chrome/120' });
    });

    it('returns not connected when fetch throws', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await testCdpConnection('http://localhost:9222');

      expect(result.connected).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('returns not connected when response is not ok', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
      });

      const result = await testCdpConnection('http://localhost:9222');

      expect(result.connected).toBe(false);
      expect(result.error).toBe('CDP endpoint not responding');
    });
  });

  describe('launchBrowser', () => {
    it('returns error for unknown browser id', async () => {
      const result = await launchBrowser('unknown-browser');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown browser');
    });

    it('returns error when browser is not installed', async () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await launchBrowser('chrome');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });
  });
});

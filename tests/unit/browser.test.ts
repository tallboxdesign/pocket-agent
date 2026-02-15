/**
 * Unit tests for Browser Tiers (CDP and Electron)
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';

// Mock puppeteer-core module
vi.mock('puppeteer-core', () => ({
  default: {
    connect: vi.fn(),
  },
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => Buffer.from('mock file content')),
  statSync: vi.fn(() => ({ size: 100 })),
}));

// Mock path module partially — use actual implementations for cross-platform compat
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return {
    ...actual,
    dirname: vi.fn(actual.dirname),
    basename: vi.fn(actual.basename),
    extname: vi.fn(actual.extname),
    join: vi.fn(actual.join),
  };
});

// Import after mocks
import puppeteer from 'puppeteer-core';

describe('CdpTier', () => {
  let CdpTier: typeof import('../../src/browser/cdp-tier').CdpTier;
  let mockBrowser: Partial<Browser>;
  let mockPage: Partial<Page>;
  let fetchSpy: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create mock page
    mockPage = {
      url: vi.fn(() => 'https://example.com'),
      title: vi.fn(async () => 'Example Page'),
      goto: vi.fn(async () => null),
      screenshot: vi.fn(async () => 'base64screenshot'),
      waitForSelector: vi.fn(async () => ({ click: vi.fn() })),
      click: vi.fn(async () => undefined),
      type: vi.fn(async () => undefined),
      keyboard: {
        press: vi.fn(async () => undefined),
      } as unknown as Page['keyboard'],
      evaluate: vi.fn(async () => {
        return { success: true };
      }),
      hover: vi.fn(async () => undefined),
      bringToFront: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      createCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => undefined),
        on: vi.fn(),
        once: vi.fn(),
        removeAllListeners: vi.fn(),
      })),
      $: vi.fn(async () => ({
        uploadFile: vi.fn(async () => undefined),
      })),
    };

    // Create mock browser
    mockBrowser = {
      connected: true,
      pages: vi.fn(async () => [mockPage as Page]),
      newPage: vi.fn(async () => mockPage as Page),
      disconnect: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };

    // Mock puppeteer.connect
    (puppeteer.connect as Mock).mockResolvedValue(mockBrowser as Browser);

    // Mock global fetch for CDP connection check
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ Browser: 'Chrome' }),
    });
    global.fetch = fetchSpy;

    // Dynamically import CdpTier after mocks are set up
    const module = await import('../../src/browser/cdp-tier');
    CdpTier = module.CdpTier;
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllTimers();
  });

  describe('constructor', () => {
    it('should use default CDP URL when none provided', () => {
      const tier = new CdpTier();
      expect(tier).toBeDefined();
    });

    it('should accept custom CDP URL', () => {
      const tier = new CdpTier('http://localhost:9333');
      expect(tier).toBeDefined();
    });
  });

  describe('connect', () => {
    it('should connect successfully when Chrome is running with CDP', async () => {
      const tier = new CdpTier();
      const result = await tier.connect();

      expect(result.success).toBe(true);
      expect(result.tier).toBe('cdp');
      expect(result.url).toBeDefined();
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:9222/json/version', expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(puppeteer.connect).toHaveBeenCalledWith({
        browserURL: 'http://localhost:9222',
        defaultViewport: null,
        protocolTimeout: 30000,
      });
    });

    it('should return error when CDP server is not running', async () => {
      fetchSpy.mockRejectedValue(new Error('Connection refused'));

      const tier = new CdpTier();
      const result = await tier.connect();

      expect(result.success).toBe(false);
      expect(result.tier).toBe('cdp');
      expect(result.error).toContain('CDP connection failed');
    });

    it('should return error when fetch returns non-OK response', async () => {
      fetchSpy.mockResolvedValue({ ok: false });

      const tier = new CdpTier();
      const result = await tier.connect();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Chrome not running with remote debugging');
    });

    it('should create new page if no pages exist', async () => {
      (mockBrowser.pages as Mock).mockResolvedValue([]);

      const tier = new CdpTier();
      const result = await tier.connect();

      expect(result.success).toBe(true);
      expect(mockBrowser.newPage).toHaveBeenCalled();
    });
  });

  describe('getConnectionHelp', () => {
    it('should return helpful error message with OS-specific instructions', async () => {
      fetchSpy.mockRejectedValue(new Error('Test error message'));

      const tier = new CdpTier();
      const result = await tier.connect();

      expect(result.error).toContain('CDP connection failed');
      expect(result.error).toContain('macOS');
      expect(result.error).toContain('Windows');
      expect(result.error).toContain('Linux');
      expect(result.error).toContain('--remote-debugging-port=9222');
    });

    it('should handle non-Error objects', async () => {
      fetchSpy.mockRejectedValue('String error');

      const tier = new CdpTier();
      const result = await tier.connect();

      expect(result.success).toBe(false);
      expect(result.error).toContain('CDP connection failed');
    });
  });

  describe('navigate', () => {
    it('should navigate to URL successfully', async () => {
      const tier = new CdpTier();
      await tier.connect();

      (mockPage.evaluate as Mock).mockResolvedValue('Page text content');

      const result = await tier.navigate('https://test.com');

      expect(result.success).toBe(true);
      expect(result.tier).toBe('cdp');
      expect(mockPage.goto).toHaveBeenCalledWith('https://test.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    });

    it('should wait for selector when specified', async () => {
      const tier = new CdpTier();
      await tier.connect();

      (mockPage.evaluate as Mock).mockResolvedValue('Page text content');

      await tier.navigate('https://test.com', '#main');

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#main', { timeout: 10000 });
    });

    it('should wait for timeout when number is specified', async () => {
      const tier = new CdpTier();
      await tier.connect();

      (mockPage.evaluate as Mock).mockResolvedValue('Page text content');

      const startTime = Date.now();
      await tier.navigate('https://test.com', 100);
      const elapsed = Date.now() - startTime;

      // Should have waited at least 100ms (with some margin)
      expect(elapsed).toBeGreaterThanOrEqual(90);
    });

    it('should return error on navigation failure', async () => {
      (mockPage.goto as Mock).mockRejectedValue(new Error('Navigation failed'));

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.navigate('https://invalid-url.com');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Navigation failed');
    });

    it('should auto-connect if not connected', async () => {
      const tier = new CdpTier();
      // Don't call connect explicitly

      (mockPage.evaluate as Mock).mockResolvedValue('Page text content');

      const result = await tier.navigate('https://test.com');

      expect(result.success).toBe(true);
      expect(puppeteer.connect).toHaveBeenCalled();
    });
  });

  describe('screenshot', () => {
    it('should take screenshot successfully', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.screenshot();

      expect(result.success).toBe(true);
      expect(result.screenshot).toBe('base64screenshot');
      expect(mockPage.screenshot).toHaveBeenCalledWith({
        encoding: 'base64',
        type: 'png',
      });
    });

    it('should return error on screenshot failure', async () => {
      (mockPage.screenshot as Mock).mockRejectedValue(new Error('Screenshot failed'));

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.screenshot();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Screenshot failed');
    });
  });

  describe('click', () => {
    it('should click element successfully', async () => {
      const tier = new CdpTier();
      await tier.connect();

      (mockPage.evaluate as Mock).mockResolvedValueOnce(true); // ensurePage responsiveness check
      (mockPage.evaluate as Mock).mockResolvedValueOnce({ clickable: true }); // click visibility check
      const result = await tier.click('#button');

      expect(result.success).toBe(true);
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#button', { timeout: 5000 });
      expect(mockPage.click).toHaveBeenCalledWith('#button');
    });

    it('should return error when selector not found', async () => {
      (mockPage.waitForSelector as Mock).mockRejectedValue(new Error('Timeout'));

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.click('#nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Timeout');
    });
  });

  describe('type', () => {
    it('should type text successfully', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.type('#input', 'hello world');

      expect(result.success).toBe(true);
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#input', { timeout: 5000 });
      expect(mockPage.click).toHaveBeenCalledWith('#input', { clickCount: 3 });
      expect(mockPage.type).toHaveBeenCalledWith('#input', 'hello world');
    });

    it('should return error on type failure', async () => {
      (mockPage.type as Mock).mockRejectedValue(new Error('Type failed'));

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.type('#input', 'text');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Type failed');
    });
  });

  describe('evaluate', () => {
    it('should evaluate script successfully', async () => {
      (mockPage.evaluate as Mock).mockResolvedValue({ data: 'result' });

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.evaluate('document.title');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ data: 'result' });
    });

    it('should return error on evaluation failure', async () => {
      (mockPage.evaluate as Mock).mockRejectedValue(new Error('Eval error'));

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.evaluate('invalid code');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Eval error');
    });
  });

  describe('scroll', () => {
    it('should scroll down by default', async () => {
      (mockPage.evaluate as Mock).mockResolvedValue({
        success: true,
        scrollY: 300,
        scrollX: 0,
        scrollHeight: 1000,
        scrollWidth: 800,
      });

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.scroll();

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('scrollY');
    });

    it('should return error when element not found', async () => {
      (mockPage.waitForSelector as Mock).mockRejectedValue(new Error('Element not found'));

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.scroll('down', 300, '#nonexistent');

      expect(result.success).toBe(false);
    });
  });

  describe('hover', () => {
    it('should hover over element successfully', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.hover('#menu');

      expect(result.success).toBe(true);
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#menu', { timeout: 5000 });
      expect(mockPage.hover).toHaveBeenCalledWith('#menu');
    });
  });

  describe('execute', () => {
    it('should handle navigate action', async () => {
      const tier = new CdpTier();
      await tier.connect();

      (mockPage.evaluate as Mock).mockResolvedValue('text');

      const result = await tier.execute({ action: 'navigate', url: 'https://test.com' });

      expect(result.success).toBe(true);
    });

    it('should return error when URL missing for navigate', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.execute({ action: 'navigate' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('URL required');
    });

    it('should handle screenshot action', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.execute({ action: 'screenshot' });

      expect(result.success).toBe(true);
    });

    it('should return error for unknown action', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.execute({ action: 'unknown' as 'navigate' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    it('should return error when selector missing for click', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.execute({ action: 'click' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Selector required');
    });

    it('should return error when script missing for evaluate', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.execute({ action: 'evaluate' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Script required');
    });
  });

  describe('isConnected', () => {
    it('should return true when connected', async () => {
      const tier = new CdpTier();
      await tier.connect();

      expect(tier.isConnected()).toBe(true);
    });

    it('should return false when not connected', () => {
      const tier = new CdpTier();

      expect(tier.isConnected()).toBe(false);
    });
  });

  describe('getState', () => {
    it('should return current state', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const state = tier.getState();

      expect(state).toHaveProperty('url');
      expect(state).toHaveProperty('connected');
      expect(state.connected).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should disconnect from browser', async () => {
      const tier = new CdpTier();
      await tier.connect();

      tier.disconnect();

      expect(mockBrowser.disconnect).toHaveBeenCalled();
      expect(tier.isConnected()).toBe(false);
    });
  });

  describe('tab management', () => {
    it('should list tabs', async () => {
      (mockBrowser.pages as Mock).mockResolvedValue([mockPage as Page, mockPage as Page]);

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.tabsList();

      expect(result.success).toBe(true);
      expect(result.tabs).toHaveLength(2);
    });

    it('should open new tab', async () => {
      const tier = new CdpTier();
      await tier.connect();

      (mockBrowser.pages as Mock).mockResolvedValue([mockPage as Page]);

      const result = await tier.tabsOpen('https://new-tab.com');

      expect(result.success).toBe(true);
      expect(mockBrowser.newPage).toHaveBeenCalled();
    });

    it('should close tab', async () => {
      const tier = new CdpTier();
      await tier.connect();

      // First list tabs to populate the pages map
      await tier.tabsList();

      const result = await tier.tabsClose('tab-0');

      expect(result.success).toBe(true);
    });

    it('should return error for non-existent tab', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.tabsClose('tab-999');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Tab not found');
    });

    it('should focus tab', async () => {
      const tier = new CdpTier();
      await tier.connect();

      // First list tabs to populate the pages map
      await tier.tabsList();

      const result = await tier.tabsFocus('tab-0');

      expect(result.success).toBe(true);
      expect(mockPage.bringToFront).toHaveBeenCalled();
    });
  });

  describe('upload', () => {
    it('should return error when file not found', async () => {
      const fs = await import('fs');
      (fs.existsSync as Mock).mockReturnValue(false);

      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.upload('#file-input', '/nonexistent/file.txt');

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });
  });

  describe('download', () => {
    it('should return error when neither selector nor url provided', async () => {
      const tier = new CdpTier();
      await tier.connect();

      const result = await tier.download();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Either selector or url required for download');
    });
  });
});

describe('Edge Cases', () => {
  describe('Invalid URLs', () => {
    it('CDP tier should handle invalid URL during navigation', async () => {
      vi.resetModules();

      const mockPage = {
        url: vi.fn(() => ''),
        goto: vi.fn(async () => {
          throw new Error('ERR_INVALID_URL');
        }),
        title: vi.fn(async () => ''),
        evaluate: vi.fn(async () => ''),
      };

      const mockBrowser = {
        connected: true,
        pages: vi.fn(async () => [mockPage]),
        on: vi.fn(),
        once: vi.fn(),
        disconnect: vi.fn(),
      };

      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      (puppeteer.connect as Mock).mockResolvedValue(mockBrowser);

      const module = await import('../../src/browser/cdp-tier');
      const tier = new module.CdpTier();
      await tier.connect();

      const result = await tier.navigate('not-a-valid-url');

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_INVALID_URL');
    });
  });

  describe('Connection recovery', () => {
    it('CDP tier should attempt reconnection when browser disconnected', async () => {
      vi.resetModules();

      const mockPage = {
        url: vi.fn(() => 'https://example.com'),
        title: vi.fn(async () => 'Title'),
        goto: vi.fn(async () => null),
        screenshot: vi.fn(async () => 'base64'),
        evaluate: vi.fn(async () => 'text'),
      };

      let connectCount = 0;
      const mockBrowser = {
        get connected() {
          connectCount++;
          return connectCount > 1;
        },
        pages: vi.fn(async () => [mockPage]),
        on: vi.fn(),
        once: vi.fn(),
        disconnect: vi.fn(),
      };

      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      (puppeteer.connect as Mock).mockResolvedValue(mockBrowser);

      const module = await import('../../src/browser/cdp-tier');
      const tier = new module.CdpTier();
      await tier.connect();

      // Reset connect count to simulate disconnection
      connectCount = 0;

      const result = await tier.screenshot();

      expect(result.success).toBe(true);
      // Connect is called at least once
      expect(puppeteer.connect).toHaveBeenCalled();
    });
  });
});

// Note: ElectronTier tests require the Electron runtime environment.
// These tests are skipped as the Electron mocking is complex and requires
// a proper Electron testing framework like spectron or playwright-electron.
// The CDP tier tests above validate the browser automation logic patterns
// which are similar across both tiers.
describe.skip('ElectronTier', () => {
  // ElectronTier requires an Electron runtime environment for proper testing.
  // Consider using playwright-electron or spectron for integration tests.
});

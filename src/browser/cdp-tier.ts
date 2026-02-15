/**
 * CDP (Chrome DevTools Protocol) browser tier
 *
 * Connects to user's Chrome via CDP for tasks requiring logged-in sessions.
 * User runs Chrome with: --remote-debugging-port=9222
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';
import { BrowserAction, BrowserResult } from './types';
import * as path from 'path';
import * as fs from 'fs';

const DEFAULT_CDP_URL = 'http://localhost:9222';

export class CdpTier {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private pages: Map<string, Page> = new Map(); // Track all pages by ID
  private currentUrl: string = '';
  private cdpUrl: string;
  private downloadPath: string = process.cwd();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private reconnecting: boolean = false;
  private lastConnectionError: string | null = null;

  constructor(cdpUrl: string = DEFAULT_CDP_URL) {
    this.cdpUrl = cdpUrl;
  }

  /**
   * Check if CDP endpoint is reachable
   */
  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${this.cdpUrl}/json/version`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start health check interval
   */
  private startHealthCheck(): void {
    // Stop any existing interval
    this.stopHealthCheck();

    // Check every 15 seconds (fast detection of stale connections after sleep/lock)
    this.healthCheckInterval = setInterval(async () => {
      if (this.browser && !this.reconnecting) {
        const isHealthy = await this.checkHealth();
        if (!isHealthy) {
          console.log('[CDP] Health check failed, connection may be stale');
          this.handleDisconnect();
        }
      }
    }, 15000);
  }

  /**
   * Stop health check interval
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Handle browser disconnection
   */
  private handleDisconnect(): void {
    console.log('[CDP] Browser disconnected');
    this.stopHealthCheck();
    // Properly close the old Puppeteer WebSocket before nulling
    if (this.browser) {
      try {
        this.browser.disconnect();
      } catch {
        // Already disconnected or dead — ignore
      }
    }
    this.browser = null;
    this.page = null;
    this.pages.clear();
    this.currentUrl = '';
  }

  /**
   * Connect to Chrome via CDP
   */
  async connect(): Promise<BrowserResult> {
    // Prevent multiple simultaneous reconnection attempts
    if (this.reconnecting) {
      return {
        success: false,
        tier: 'cdp',
        error: 'Reconnection already in progress',
      };
    }

    this.reconnecting = true;
    this.lastConnectionError = null;

    try {
      // Check if Chrome is running with CDP
      const isReachable = await this.checkHealth();
      if (!isReachable) {
        throw new Error('Chrome not running with remote debugging');
      }

      // Disconnect existing browser if any
      if (this.browser) {
        try {
          this.browser.disconnect();
        } catch {
          // Ignore disconnect errors
        }
        this.browser = null;
        this.page = null;
        this.pages.clear();
      }

      // Wrap connect in a timeout — puppeteer.connect() can hang indefinitely
      // if Chrome is in a bad state (e.g. partially frozen after sleep)
      const connectPromise = puppeteer.connect({
        browserURL: this.cdpUrl,
        defaultViewport: null,
        protocolTimeout: 30000, // Fail fast on stale protocol messages
      });
      let connectTimeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        connectTimeoutId = setTimeout(() => reject(new Error('puppeteer.connect() timed out after 10s')), 10000);
      });
      try {
        this.browser = await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        clearTimeout(connectTimeoutId!);
      }

      // Listen for disconnection (once to prevent accumulation on reconnect)
      this.browser.once('disconnected', () => {
        console.log('[CDP] Browser disconnected event received');
        this.handleDisconnect();
      });

      // Get existing pages
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
      this.currentUrl = this.page.url();

      // Start health monitoring
      this.startHealthCheck();

      console.log('[CDP] Connected to Chrome');

      return {
        success: true,
        tier: 'cdp',
        url: this.currentUrl,
      };
    } catch (error) {
      const errorMsg = this.getConnectionHelp(error);
      this.lastConnectionError = errorMsg;
      return {
        success: false,
        tier: 'cdp',
        error: errorMsg,
      };
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Get helpful connection error message
   */
  private getConnectionHelp(error: unknown): string {
    const msg = error instanceof Error ? error.message : 'Unknown error';

    return `CDP connection failed: ${msg}\n\n` +
      'To use CDP tier, start Chrome with remote debugging:\n\n' +
      'macOS:\n' +
      '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n\n' +
      'Windows:\n' +
      '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222\n\n' +
      'Linux:\n' +
      '  google-chrome --remote-debugging-port=9222';
  }

  /**
   * Wait for an in-progress reconnection to finish (if any)
   */
  private async waitForReconnect(timeoutMs: number = 12000): Promise<boolean> {
    const start = Date.now();
    while (this.reconnecting && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return !this.reconnecting;
  }

  /**
   * Ensure connected with auto-reconnect
   */
  private async ensurePage(): Promise<Page> {
    // If a reconnection is already in progress (e.g. from power event),
    // wait for it instead of failing immediately
    if (this.reconnecting) {
      console.log('[CDP] Waiting for in-progress reconnection...');
      await this.waitForReconnect();
    }

    // Check if we need to reconnect
    const needsReconnect = !this.page || !this.browser || !this.browser.connected;

    if (needsReconnect) {
      console.log('[CDP] Connection lost, attempting reconnect...');
      const result = await this.connect();
      if (!result.success) {
        throw new Error(result.error || 'Failed to connect to Chrome. Make sure Chrome is running with --remote-debugging-port=9222');
      }
    }

    // Verify page is still valid
    if (!this.page) {
      throw new Error('No page available after connection');
    }

    // Double-check the page is responsive (with timeout to prevent hang on dead WebSocket)
    try {
      const isResponsive = await Promise.race([
        this.page.evaluate(() => true).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!isResponsive) {
        throw new Error('Page evaluate timed out');
      }
    } catch {
      console.log('[CDP] Page unresponsive, reconnecting...');
      this.handleDisconnect();
      const result = await this.connect();
      if (!result.success) {
        throw new Error(result.error || 'Failed to reconnect');
      }
    }

    return this.page!;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, waitFor?: string | number): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      this.currentUrl = page.url();

      // Wait for condition if specified
      if (waitFor) {
        if (typeof waitFor === 'number') {
          await new Promise(resolve => setTimeout(resolve, waitFor));
        } else {
          await page.waitForSelector(waitFor, { timeout: 10000 });
        }
      }

      const title = await page.title();
      const text = await this.getVisibleText();

      return {
        success: true,
        tier: 'cdp',
        url: this.currentUrl,
        title,
        text,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Take screenshot
   */
  async screenshot(): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      const buffer = await page.screenshot({
        encoding: 'base64',
        type: 'png',
      });

      return {
        success: true,
        tier: 'cdp',
        screenshot: buffer as string,
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Click an element
   */
  async click(selector: string): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      // Wait for element with shorter timeout
      const element = await page.waitForSelector(selector, { timeout: 5000 });
      if (!element) {
        return {
          success: false,
          tier: 'cdp',
          error: `Element not found: ${selector}`,
        };
      }

      // Check if element is visible and enabled
      const isClickable = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) return { clickable: false, reason: 'not found' };
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return { clickable: false, reason: 'hidden (display:none)' };
        if (style.visibility === 'hidden') return { clickable: false, reason: 'hidden (visibility)' };
        if ((el as HTMLButtonElement).disabled) return { clickable: false, reason: 'disabled' };
        return { clickable: true };
      }, selector);

      if (!isClickable.clickable) {
        return {
          success: false,
          tier: 'cdp',
          error: `Element not clickable: ${isClickable.reason}`,
        };
      }

      await page.click(selector);

      // Brief wait for any immediate effects
      await new Promise(resolve => setTimeout(resolve, 300));

      return {
        success: true,
        tier: 'cdp',
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Type into an element
   */
  async type(selector: string, text: string): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      await page.waitForSelector(selector, { timeout: 5000 });

      // Clear existing value
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');

      // Type new value
      await page.type(selector, text);

      return {
        success: true,
        tier: 'cdp',
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Evaluate JavaScript
   */
  async evaluate(script: string): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      // Wrap script in IIFE to avoid variable redeclaration issues
      // when multiple evaluate calls use the same variable names
      const wrappedScript = `(() => { ${script} })()`;
      const result = await page.evaluate(wrappedScript);

      return {
        success: true,
        tier: 'cdp',
        data: result,
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Extract data from page
   */
  async extract(action: BrowserAction): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();
      const selector = action.extractSelector || 'body';
      const extractType = action.extractType || 'structured';

      const result = await page.evaluate((sel: string, type: string) => {
        const el = document.querySelector(sel) || document.body;

        switch (type) {
          case 'text':
            return { text: (el as HTMLElement).innerText };

          case 'html':
            return { html: el.innerHTML };

          case 'links':
            const links: Array<{ href: string; text: string }> = [];
            el.querySelectorAll('a[href]').forEach((a: Element) => {
              links.push({
                href: (a as HTMLAnchorElement).href,
                text: a.textContent?.trim() || '',
              });
            });
            return { links };

          case 'tables':
            const tables: string[][][] = [];
            el.querySelectorAll('table').forEach((table: Element) => {
              const tableData: string[][] = [];
              table.querySelectorAll('tr').forEach((row: Element) => {
                const rowData: string[] = [];
                row.querySelectorAll('td, th').forEach((cell: Element) => {
                  rowData.push(cell.textContent?.trim() || '');
                });
                if (rowData.length) tableData.push(rowData);
              });
              if (tableData.length) tables.push(tableData);
            });
            return { tables };

          case 'structured':
          default:
            const mainEl = document.querySelector('main, article, [role="main"], .content') || document.body;
            return {
              title: document.title,
              url: window.location.href,
              description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
              headings: Array.from(document.querySelectorAll('h1, h2, h3'))
                .slice(0, 20)
                .map(h => h.textContent?.trim()),
              mainContent: (mainEl as HTMLElement).innerText?.slice(0, 3000) || '',
            };
        }
      }, selector, extractType);

      return {
        success: true,
        tier: 'cdp',
        data: result,
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get visible text from page
   */
  private async getVisibleText(): Promise<string> {
    if (!this.page) return '';

    return this.page.evaluate(() => {
      return document.body.innerText.slice(0, 5000);
    });
  }

  /**
   * Scroll the page
   */
  async scroll(
    direction: 'up' | 'down' | 'left' | 'right' = 'down',
    amount: number = 300,
    selector?: string
  ): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      if (selector) {
        // Scroll element into view first
        await page.waitForSelector(selector, { timeout: 5000 });
      }

      const result = await page.evaluate(
        (dir: string, amt: number, sel: string | null) => {
          const target = sel ? document.querySelector(sel) : window;
          if (sel && !target) {
            return { success: false, error: 'Element not found' };
          }

          const scrollTarget = target === window ? window : (target as Element);

          switch (dir) {
            case 'up':
              scrollTarget.scrollBy(0, -amt);
              break;
            case 'down':
              scrollTarget.scrollBy(0, amt);
              break;
            case 'left':
              scrollTarget.scrollBy(-amt, 0);
              break;
            case 'right':
              scrollTarget.scrollBy(amt, 0);
              break;
          }

          return {
            success: true,
            scrollY: window.scrollY,
            scrollX: window.scrollX,
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
          };
        },
        direction,
        amount,
        selector || null
      );

      if (!result.success) {
        return {
          success: false,
          tier: 'cdp',
          error: result.error || 'Scroll failed',
        };
      }

      return {
        success: true,
        tier: 'cdp',
        url: page.url(),
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Hover over an element
   */
  async hover(selector: string): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      await page.waitForSelector(selector, { timeout: 5000 });
      await page.hover(selector);

      // Wait for hover effects
      await new Promise(resolve => setTimeout(resolve, 300));

      return {
        success: true,
        tier: 'cdp',
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Trigger and wait for a download
   */
  async download(
    selector?: string,
    url?: string,
    savePath?: string,
    timeout: number = 30000
  ): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      // Set download behavior via CDP
      const client = await page.createCDPSession();
      const downloadDir = savePath ? path.dirname(savePath) : this.downloadPath;

      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });

      // Set up download listener (use once to prevent listener accumulation)
      const downloadPromise = new Promise<{ path: string; size: number }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          client.removeAllListeners('Page.downloadWillBegin');
          client.removeAllListeners('Page.downloadProgress');
          reject(new Error('Download timed out'));
        }, timeout);

        client.once('Page.downloadWillBegin', (event) => {
          console.log('[CDP] Download starting:', event.suggestedFilename);
        });

        client.on('Page.downloadProgress', (event) => {
          if (event.state === 'completed') {
            clearTimeout(timeoutId);
            client.removeAllListeners('Page.downloadProgress');
            const filePath = path.join(downloadDir, event.guid || 'download');
            resolve({ path: filePath, size: event.totalBytes || 0 });
          } else if (event.state === 'canceled') {
            clearTimeout(timeoutId);
            client.removeAllListeners('Page.downloadProgress');
            reject(new Error('Download was canceled'));
          }
        });
      });

      // Trigger download
      if (selector) {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.click(selector);
      } else if (url) {
        await page.goto(url);
      } else {
        return {
          success: false,
          tier: 'cdp',
          error: 'Either selector or url required for download',
        };
      }

      try {
        const result = await downloadPromise;
        return {
          success: true,
          tier: 'cdp',
          url: page.url(),
          downloadedFile: result.path,
          downloadSize: result.size,
        };
      } catch (e) {
        return {
          success: false,
          tier: 'cdp',
          error: e instanceof Error ? e.message : 'Download failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Upload a file to an input element
   */
  async upload(selector: string, filePath: string): Promise<BrowserResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          tier: 'cdp',
          error: `File not found: ${filePath}`,
        };
      }

      const page = await this.ensurePage();

      await page.waitForSelector(selector, { timeout: 5000 });

      // Get the file input element
      const inputElement = await page.$(selector);
      if (!inputElement) {
        return {
          success: false,
          tier: 'cdp',
          error: 'Element not found',
        };
      }

      // Upload file using Puppeteer's uploadFile
      // Cast to input element handle for uploadFile
      const inputHandle = inputElement as unknown as import('puppeteer-core').ElementHandle<HTMLInputElement>;
      await inputHandle.uploadFile(filePath);

      const stats = fs.statSync(filePath);

      return {
        success: true,
        tier: 'cdp',
        url: page.url(),
        data: {
          fileName: path.basename(filePath),
          size: stats.size,
        },
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * List all open tabs
   */
  async tabsList(): Promise<BrowserResult> {
    try {
      if (!this.browser?.connected) {
        const result = await this.connect();
        if (!result.success) {
          return result;
        }
      }

      const pages = await this.browser!.pages();
      const tabs = await Promise.all(
        pages.map(async (page, index) => {
          const url = page.url();
          const title = await page.title().catch(() => '');
          const id = `tab-${index}`;

          // Track pages
          this.pages.set(id, page);

          return {
            id,
            url,
            title,
            active: page === this.page,
          };
        })
      );

      return {
        success: true,
        tier: 'cdp',
        tabs,
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Open a new tab
   */
  async tabsOpen(url?: string): Promise<BrowserResult> {
    try {
      if (!this.browser?.connected) {
        const result = await this.connect();
        if (!result.success) {
          return result;
        }
      }

      const newPage = await this.browser!.newPage();
      const pages = await this.browser!.pages();
      const tabId = `tab-${pages.length - 1}`;

      this.pages.set(tabId, newPage);
      this.page = newPage;

      if (url) {
        await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        this.currentUrl = newPage.url();
      }

      return {
        success: true,
        tier: 'cdp',
        tabId,
        url: newPage.url(),
        title: await newPage.title().catch(() => ''),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Close a tab
   */
  async tabsClose(tabId: string): Promise<BrowserResult> {
    try {
      const page = this.pages.get(tabId);
      if (!page) {
        return {
          success: false,
          tier: 'cdp',
          error: `Tab not found: ${tabId}`,
        };
      }

      await page.close();
      this.pages.delete(tabId);

      // If we closed the active tab, switch to another
      if (page === this.page) {
        const pages = await this.browser!.pages();
        this.page = pages[0] || null;
        this.currentUrl = this.page?.url() || '';
      }

      return {
        success: true,
        tier: 'cdp',
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Focus/switch to a tab
   */
  async tabsFocus(tabId: string): Promise<BrowserResult> {
    try {
      const page = this.pages.get(tabId);
      if (!page) {
        return {
          success: false,
          tier: 'cdp',
          error: `Tab not found: ${tabId}`,
        };
      }

      await page.bringToFront();
      this.page = page;
      this.currentUrl = page.url();

      return {
        success: true,
        tier: 'cdp',
        tabId,
        url: this.currentUrl,
        title: await page.title().catch(() => ''),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Execute action
   */
  async execute(action: BrowserAction): Promise<BrowserResult> {
    switch (action.action) {
      case 'navigate':
        if (!action.url) {
          return { success: false, tier: 'cdp', error: 'URL required' };
        }
        return this.navigate(action.url, action.waitFor);

      case 'screenshot':
        return this.screenshot();

      case 'click':
        if (!action.selector) {
          return { success: false, tier: 'cdp', error: 'Selector required' };
        }
        return this.click(action.selector);

      case 'type':
        if (!action.selector || action.text === undefined) {
          return { success: false, tier: 'cdp', error: 'Selector and text required' };
        }
        return this.type(action.selector, action.text);

      case 'evaluate':
        if (!action.script) {
          return { success: false, tier: 'cdp', error: 'Script required' };
        }
        return this.evaluate(action.script);

      case 'extract':
        return this.extract(action);

      case 'scroll':
        return this.scroll(
          action.scrollDirection || 'down',
          action.scrollAmount || 300,
          action.selector
        );

      case 'hover':
        if (!action.selector) {
          return { success: false, tier: 'cdp', error: 'Selector required' };
        }
        return this.hover(action.selector);

      case 'download':
        return this.download(
          action.selector,
          action.url,
          action.downloadPath,
          action.downloadTimeout
        );

      case 'upload':
        if (!action.selector || !action.filePath) {
          return { success: false, tier: 'cdp', error: 'Selector and filePath required' };
        }
        return this.upload(action.selector, action.filePath);

      case 'tabs_list':
        return this.tabsList();

      case 'tabs_open':
        return this.tabsOpen(action.url);

      case 'tabs_close':
        if (!action.tabId) {
          return { success: false, tier: 'cdp', error: 'tabId required' };
        }
        return this.tabsClose(action.tabId);

      case 'tabs_focus':
        if (!action.tabId) {
          return { success: false, tier: 'cdp', error: 'tabId required' };
        }
        return this.tabsFocus(action.tabId);

      default:
        return {
          success: false,
          tier: 'cdp',
          error: `Unknown action: ${action.action}`,
        };
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return !!(this.browser?.connected && this.page);
  }

  /**
   * Get current state
   */
  getState(): { url: string; connected: boolean; lastError?: string } {
    return {
      url: this.currentUrl,
      connected: this.isConnected(),
      lastError: this.lastConnectionError || undefined,
    };
  }

  /**
   * Force reconnection (called after system wake/unlock)
   * Proactively tears down stale connection and re-establishes.
   */
  async forceReconnect(): Promise<BrowserResult> {
    console.log('[CDP] Force reconnect triggered (system wake/unlock)');
    this.handleDisconnect();
    return this.connect();
  }

  /**
   * Disconnect from Chrome
   */
  disconnect(): void {
    this.stopHealthCheck();

    if (this.browser) {
      try {
        this.browser.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.browser = null;
    this.page = null;
    this.pages.clear();
    this.currentUrl = '';
    this.lastConnectionError = null;
    console.log('[CDP] Disconnected');
  }
}

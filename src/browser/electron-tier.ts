/**
 * Electron hidden window browser tier
 *
 * Uses a hidden BrowserWindow for JS-heavy pages.
 * Runs invisibly, doesn't interrupt user.
 */

import { BrowserWindow, WebContents, app } from 'electron';
import { BrowserAction, BrowserResult } from './types';
import * as path from 'path';
import * as fs from 'fs';

// Default timeout for browser operations (15 seconds)
const BROWSER_OP_TIMEOUT = 15000;

/**
 * Run a promise with timeout
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Browser operation "${operation}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Log browser operation with timing
 */
function logBrowser(operation: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`🌐 [Browser ${timestamp}] ${operation}${dataStr}`);
}

export class ElectronTier {
  private window: BrowserWindow | null = null;
  private currentUrl: string = '';
  private downloadPath: string = app.getPath('downloads');
  private lastDownload: { path: string; size: number } | null = null;
  private downloadHandler: ((_event: Electron.Event, item: Electron.DownloadItem) => void) | null = null;

  /**
   * Initialize hidden browser window
   */
  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    this.window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false, // Hidden
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // Disabled to allow user-agent override
        webSecurity: true,
      },
    });

    // Set realistic user agent to reduce bot detection
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
    this.window.webContents.setUserAgent(userAgent);

    // Remove webdriver flag that signals automation
    this.window.webContents.on('did-finish-load', () => {
      this.window?.webContents.executeJavaScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      `).catch(() => {});
    });

    // Prevent window from showing
    this.window.on('show', () => {
      this.window?.hide();
    });

    // Set up download handling (single handler, cleaned up on destroy)
    this.downloadHandler = (_event, item) => {
      const savePath = path.join(this.downloadPath, item.getFilename());
      item.setSavePath(savePath);

      item.on('done', (_e, state) => {
        if (state === 'completed') {
          this.lastDownload = {
            path: savePath,
            size: item.getReceivedBytes(),
          };
        }
      });
    };
    this.window.webContents.session.on('will-download', this.downloadHandler);

    // Clean up handler when window is destroyed to prevent accumulation
    this.window.on('closed', () => {
      this.downloadHandler = null;
    });

    return this.window;
  }

  /**
   * Get webContents
   */
  private async getWebContents(): Promise<WebContents> {
    const window = await this.ensureWindow();
    return window.webContents;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, waitFor?: string | number): Promise<BrowserResult> {
    const startTime = Date.now();
    logBrowser('navigate START', { url });

    try {
      const webContents = await this.getWebContents();

      await withTimeout(
        webContents.loadURL(url),
        BROWSER_OP_TIMEOUT,
        `loadURL(${url})`
      );
      this.currentUrl = url;

      // Wait for condition if specified
      if (waitFor) {
        await this.waitFor(waitFor);
      } else {
        // Default: wait for DOM content loaded (with timeout)
        await new Promise<void>(resolve => {
          webContents.once('dom-ready', () => resolve());
          // Shorter timeout fallback (3s instead of 5s)
          setTimeout(resolve, 3000);
        });
      }

      const title = await withTimeout(
        webContents.executeJavaScript('document.title'),
        5000,
        'get title'
      );
      const text = await withTimeout(
        this.getVisibleText(),
        5000,
        'get visible text'
      );

      const duration = Date.now() - startTime;
      logBrowser('navigate END', { url, duration: `${duration}ms` });

      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
        title,
        text,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logBrowser('navigate FAILED', { url, duration: `${duration}ms`, error: errorMsg });

      return {
        success: false,
        tier: 'electron',
        error: errorMsg,
      };
    }
  }

  /**
   * Take screenshot
   */
  async screenshot(): Promise<BrowserResult> {
    const startTime = Date.now();
    logBrowser('screenshot START', { url: this.currentUrl });

    try {
      const webContents = await this.getWebContents();

      if (!this.currentUrl) {
        logBrowser('screenshot FAILED', { error: 'No page loaded' });
        return {
          success: false,
          tier: 'electron',
          error: 'No page loaded. Call navigate first.',
        };
      }

      // Wait briefly for any pending renders/paints before capturing
      await new Promise(resolve => setTimeout(resolve, 1500));

      let image = await withTimeout(
        webContents.capturePage(),
        10000,
        'capturePage'
      );
      let base64 = image.toPNG().toString('base64');

      // Detect blank/white screenshots and retry with longer wait
      const isBlank = image.getSize().width > 0 && image.getSize().height > 0 &&
        base64.length < 5000; // Very small PNG = likely blank
      if (isBlank) {
        logBrowser('screenshot BLANK detected, retrying with longer wait');
        await new Promise(resolve => setTimeout(resolve, 3000));
        image = await withTimeout(
          webContents.capturePage(),
          10000,
          'capturePage retry'
        );
        base64 = image.toPNG().toString('base64');
      }

      const duration = Date.now() - startTime;
      logBrowser('screenshot END', { duration: `${duration}ms`, size: base64.length });

      return {
        success: true,
        tier: 'electron',
        screenshot: base64,
        url: this.currentUrl,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logBrowser('screenshot FAILED', { duration: `${duration}ms`, error: errorMsg });

      return {
        success: false,
        tier: 'electron',
        error: errorMsg,
      };
    }
  }

  /**
   * Click an element
   */
  async click(selector: string): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { success: false, error: 'Element not found' };
          el.click();
          return { success: true };
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error || 'Click failed',
        };
      }

      // Wait a bit for any navigation/updates
      await new Promise(resolve => setTimeout(resolve, 500));

      return {
        success: true,
        tier: 'electron',
        url: webContents.getURL(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Type into an element
   */
  async type(selector: string, text: string): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { success: false, error: 'Element not found' };
          if (!('value' in el)) return { success: false, error: 'Element is not an input' };

          el.focus();
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));

          return { success: true };
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error || 'Type failed',
        };
      }

      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Evaluate JavaScript
   */
  async evaluate(script: string): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          try {
            const result = ${script};
            return { success: true, data: result };
          } catch (e) {
            return { success: false, error: e.message };
          }
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error,
        };
      }

      return {
        success: true,
        tier: 'electron',
        data: result.data,
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Extract data from page
   */
  async extract(action: BrowserAction): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();
      const selector = action.extractSelector || 'body';
      const extractType = action.extractType || 'structured';

      const result = await webContents.executeJavaScript(`
        (function() {
          const selector = ${JSON.stringify(selector)};
          const el = document.querySelector(selector) || document.body;
          const extractType = ${JSON.stringify(extractType)};

          switch (extractType) {
            case 'text':
              return { text: el.innerText };

            case 'html':
              return { html: el.innerHTML };

            case 'links':
              const links = [];
              el.querySelectorAll('a[href]').forEach(a => {
                links.push({ href: a.href, text: a.innerText.trim() });
              });
              return { links };

            case 'tables':
              const tables = [];
              el.querySelectorAll('table').forEach(table => {
                const tableData = [];
                table.querySelectorAll('tr').forEach(row => {
                  const rowData = [];
                  row.querySelectorAll('td, th').forEach(cell => {
                    rowData.push(cell.innerText.trim());
                  });
                  if (rowData.length) tableData.push(rowData);
                });
                if (tableData.length) tables.push(tableData);
              });
              return { tables };

            case 'structured':
            default:
              return {
                title: document.title,
                description: document.querySelector('meta[name="description"]')?.content || '',
                headings: Array.from(document.querySelectorAll('h1, h2, h3'))
                  .slice(0, 20)
                  .map(h => h.innerText.trim()),
                mainContent: (document.querySelector('main, article, [role="main"], .content') || document.body)
                  .innerText.slice(0, 3000)
              };
          }
        })()
      `);

      return {
        success: true,
        tier: 'electron',
        data: result,
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Wait for condition
   */
  private async waitFor(condition: string | number): Promise<void> {
    const webContents = await this.getWebContents();

    if (typeof condition === 'number') {
      await new Promise(resolve => setTimeout(resolve, condition));
      return;
    }

    // Wait for selector
    const timeout = 10000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const found = await webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(condition)})`
      );
      if (found) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for selector: ${condition}`);
  }

  /**
   * Get visible text from page
   */
  private async getVisibleText(): Promise<string> {
    const webContents = await this.getWebContents();

    return webContents.executeJavaScript(`
      document.body.innerText.slice(0, 5000)
    `);
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
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'window'};
          if (${selector ? 'true' : 'false'} && !target) {
            return { success: false, error: 'Element not found' };
          }

          const scrollTarget = target === window ? window : target;
          const direction = ${JSON.stringify(direction)};
          const amount = ${amount};

          switch (direction) {
            case 'up':
              scrollTarget.scrollBy(0, -amount);
              break;
            case 'down':
              scrollTarget.scrollBy(0, amount);
              break;
            case 'left':
              scrollTarget.scrollBy(-amount, 0);
              break;
            case 'right':
              scrollTarget.scrollBy(amount, 0);
              break;
          }

          return {
            success: true,
            scrollY: window.scrollY,
            scrollX: window.scrollX,
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth
          };
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error || 'Scroll failed',
        };
      }

      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Hover over an element
   */
  async hover(selector: string): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { success: false, error: 'Element not found' };

          // Dispatch mouse events to trigger hover states
          const rect = el.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;

          const mouseEnter = new MouseEvent('mouseenter', {
            bubbles: true,
            clientX: centerX,
            clientY: centerY
          });
          const mouseOver = new MouseEvent('mouseover', {
            bubbles: true,
            clientX: centerX,
            clientY: centerY
          });

          el.dispatchEvent(mouseEnter);
          el.dispatchEvent(mouseOver);

          return { success: true };
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error || 'Hover failed',
        };
      }

      // Wait a bit for hover effects
      await new Promise(resolve => setTimeout(resolve, 300));

      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Trigger a download and wait for it
   */
  async download(
    selector?: string,
    url?: string,
    savePath?: string,
    timeout: number = 30000
  ): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      if (savePath) {
        this.downloadPath = path.dirname(savePath);
      }

      this.lastDownload = null;

      // Trigger download via click or direct navigation
      if (selector) {
        await webContents.executeJavaScript(`
          document.querySelector(${JSON.stringify(selector)})?.click()
        `);
      } else if (url) {
        await webContents.downloadURL(url);
      } else {
        return {
          success: false,
          tier: 'electron',
          error: 'Either selector or url required for download',
        };
      }

      // Wait for download to complete
      const startTime = Date.now();
      while (!this.lastDownload && Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (!this.lastDownload) {
        return {
          success: false,
          tier: 'electron',
          error: 'Download timed out',
        };
      }

      // Type assertion needed: TypeScript doesn't track that lastDownload
      // was set by the download event handler during the async wait
      const download = this.lastDownload as { path: string; size: number };
      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
        downloadedFile: download.path,
        downloadSize: download.size,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Upload a file to an input element
   */
  async upload(selector: string, filePath: string): Promise<BrowserResult> {
    try {
      // Verify file exists
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          tier: 'electron',
          error: `File not found: ${filePath}`,
        };
      }

      const webContents = await this.getWebContents();

      // Check if element is a file input
      const isFileInput = await webContents.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { error: 'Element not found' };
          if (el.tagName !== 'INPUT' || el.type !== 'file') {
            return { error: 'Element is not a file input' };
          }
          return { ok: true };
        })()
      `);

      if (isFileInput.error) {
        return {
          success: false,
          tier: 'electron',
          error: isFileInput.error,
        };
      }

      // Use Electron's file input mechanism
      // Note: In Electron, we need to use webContents.send and preload
      // For now, we'll use a workaround with executeJavaScript
      const fileName = path.basename(filePath);
      const fileContent = fs.readFileSync(filePath);
      const base64 = fileContent.toString('base64');
      const mimeType = this.getMimeType(filePath);

      await webContents.executeJavaScript(`
        (function() {
          const input = document.querySelector(${JSON.stringify(selector)});
          const dataUrl = 'data:${mimeType};base64,${base64}';

          // Convert base64 to File
          fetch(dataUrl)
            .then(res => res.blob())
            .then(blob => {
              const file = new File([blob], ${JSON.stringify(fileName)}, { type: '${mimeType}' });
              const dt = new DataTransfer();
              dt.items.add(file);
              input.files = dt.files;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
        })()
      `);

      // Wait for upload to process
      await new Promise(resolve => setTimeout(resolve, 500));

      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
        data: { fileName, size: fileContent.length },
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.zip': 'application/zip',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Execute action
   */
  async execute(action: BrowserAction): Promise<BrowserResult> {
    switch (action.action) {
      case 'navigate':
        if (!action.url) {
          return { success: false, tier: 'electron', error: 'URL required' };
        }
        return this.navigate(action.url, action.waitFor);

      case 'screenshot':
        return this.screenshot();

      case 'click':
        if (!action.selector) {
          return { success: false, tier: 'electron', error: 'Selector required' };
        }
        return this.click(action.selector);

      case 'type':
        if (!action.selector || action.text === undefined) {
          return { success: false, tier: 'electron', error: 'Selector and text required' };
        }
        return this.type(action.selector, action.text);

      case 'evaluate':
        if (!action.script) {
          return { success: false, tier: 'electron', error: 'Script required' };
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
          return { success: false, tier: 'electron', error: 'Selector required' };
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
          return { success: false, tier: 'electron', error: 'Selector and filePath required' };
        }
        return this.upload(action.selector, action.filePath);

      // Tab management not supported in single-window Electron tier
      case 'tabs_list':
      case 'tabs_open':
      case 'tabs_close':
      case 'tabs_focus':
        return {
          success: false,
          tier: 'electron',
          error: 'Tab management requires CDP tier. Set requires_auth=true or tier="cdp"',
        };

      default:
        return {
          success: false,
          tier: 'electron',
          error: `Unknown action: ${action.action}`,
        };
    }
  }

  /**
   * Get current state
   */
  getState(): { url: string; active: boolean } {
    return {
      url: this.currentUrl,
      active: this.window !== null && !this.window.isDestroyed(),
    };
  }

  /**
   * Close the hidden window
   */
  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this.currentUrl = '';
  }
}

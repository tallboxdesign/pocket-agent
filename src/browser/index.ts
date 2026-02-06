/**
 * Browser automation with two tiers
 *
 * The SDK's built-in WebFetch handles simple HTTP requests.
 * This module adds capabilities WebFetch doesn't have:
 *
 * 1. Electron hidden window: JS rendering without interrupting user
 * 2. CDP connection: Access to user's logged-in Chrome sessions
 */

import { ElectronTier } from './electron-tier';
import { CdpTier } from './cdp-tier';
import { BrowserAction, BrowserResult, BrowserTier, BrowserToolInput } from './types';
import { SettingsManager } from '../settings';

export * from './types';

/**
 * BrowserManager - Orchestrates Electron and CDP tiers
 */
export class BrowserManager {
  private electronTier: ElectronTier | null = null;
  private cdpTier: CdpTier | null = null;
  private lastTier: BrowserTier = 'electron';

  constructor() {}

  /**
   * Get or create Electron tier (lazy init)
   */
  private getElectronTier(): ElectronTier {
    if (!this.electronTier) {
      this.electronTier = new ElectronTier();
    }
    return this.electronTier;
  }

  /**
   * Get or create CDP tier (lazy init)
   */
  private getCdpTier(): CdpTier {
    if (!this.cdpTier) {
      this.cdpTier = new CdpTier();
    }
    return this.cdpTier;
  }

  /**
   * Determine the best tier for an action
   */
  private selectTier(action: BrowserAction): BrowserTier {
    // Explicit tier requested
    if (action.tier && (action.tier === 'electron' || action.tier === 'cdp')) {
      console.log(`[Browser] Tier explicitly set to: ${action.tier}`);
      return action.tier;
    }

    // Auth required → CDP
    if (action.requiresAuth) {
      console.log('[Browser] requires_auth=true, selecting CDP');
      return 'cdp';
    }

    // "Use My Browser" setting enabled → prefer CDP
    const useMyBrowserSetting = SettingsManager.get('browser.useMyBrowser');
    console.log(`[Browser] useMyBrowser setting = "${useMyBrowserSetting}"`);
    if (useMyBrowserSetting === 'true') {
      console.log('[Browser] Use My Browser enabled, selecting CDP');
      return 'cdp';
    }

    // If we were already using CDP (for auth), stay there
    if (this.lastTier === 'cdp' && this.cdpTier?.isConnected()) {
      console.log('[Browser] Already on CDP, staying there');
      return 'cdp';
    }

    // Default to Electron for JS rendering
    console.log('[Browser] Defaulting to Electron');
    return 'electron';
  }

  /**
   * Detect if a page result indicates a bot block (Cloudflare, etc.)
   */
  private isBlockedResponse(result: BrowserResult): boolean {
    const blockIndicators = [
      'just a moment',        // Cloudflare challenge page title
      'attention required',   // Cloudflare
      'checking your browser', // Cloudflare
      'ray id',               // Cloudflare error page
      'access denied',        // Generic WAF
      'please verify you are a human', // Various bot checks
    ];
    const text = `${result.title || ''} ${result.text || ''}`.toLowerCase();
    return blockIndicators.some(indicator => text.includes(indicator));
  }

  /**
   * Execute a browser action with auto-fallback to CDP on bot blocks
   */
  async execute(action: BrowserAction): Promise<BrowserResult> {
    const tier = this.selectTier(action);
    this.lastTier = tier;

    console.log(`[Browser] Executing "${action.action}" via ${tier} tier`);

    switch (tier) {
      case 'electron': {
        const result = await this.getElectronTier().execute(action);

        // Auto-fallback to CDP if Electron got blocked by bot detection
        if (result.success && this.isBlockedResponse(result)) {
          console.log('[Browser] Bot block detected on Electron tier, retrying with CDP...');
          const cdpResult = await this.getCdpTier().execute(action);
          if (cdpResult.success) {
            this.lastTier = 'cdp';
            return cdpResult;
          }
          // CDP failed too — return original with a hint
          result.text = `[Bot protection detected. CDP fallback failed — start Chrome with --remote-debugging-port=9222 for authenticated access]\n\n${result.text || ''}`;
        }

        return result;
      }

      case 'cdp':
        return this.getCdpTier().execute(action);

      default:
        return {
          success: false,
          tier: 'electron',
          error: `Unknown tier: ${tier}`,
        };
    }
  }

  /**
   * Process tool input from agent
   */
  async handleToolInput(input: BrowserToolInput): Promise<BrowserResult> {
    const action: BrowserAction = {
      action: input.action as BrowserAction['action'],
      url: input.url,
      selector: input.selector,
      text: input.text,
      script: input.script,
      extractType: input.extract_type as BrowserAction['extractType'],
      extractSelector: input.extract_selector,
      waitFor: input.wait_for,
      tier: input.tier as BrowserTier,
      requiresAuth: input.requires_auth,
      // New fields
      scrollDirection: input.scroll_direction as BrowserAction['scrollDirection'],
      scrollAmount: input.scroll_amount,
      downloadPath: input.download_path,
      downloadTimeout: input.download_timeout,
      filePath: input.file_path,
      tabId: input.tab_id,
    };

    return this.execute(action);
  }

  /**
   * Get status of all tiers
   */
  getStatus(): Record<string, unknown> {
    return {
      electron: this.electronTier?.getState() || { active: false },
      cdp: this.cdpTier?.getState() || { connected: false },
      lastTier: this.lastTier,
    };
  }

  /**
   * Close all tiers
   */
  close(): void {
    this.electronTier?.close();
    this.cdpTier?.disconnect();
    console.log('[Browser] All tiers closed');
  }
}

// Singleton instance
let browserManager: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!browserManager) {
    browserManager = new BrowserManager();
  }
  return browserManager;
}

export function closeBrowserManager(): void {
  browserManager?.close();
  browserManager = null;
}

/**
 * Browser tool definition for Claude Agent SDK
 *
 * Note: For simple page fetching, use the built-in WebFetch tool.
 * This tool is for:
 * - JS-heavy pages that need rendering (Electron)
 * - Pages requiring logged-in sessions (CDP)
 */
export function getBrowserToolDefinition() {
  return {
    name: 'browser',
    description: `Browser automation for JS rendering and authenticated sessions.

Use built-in tools first:
- WebSearch: Search the web
- WebFetch: Fetch page content

Use THIS tool when you need:
- JavaScript rendering (SPAs, dynamic content)
- Screenshots of rendered pages
- Clicking/typing on interactive elements
- Access to user's logged-in browser sessions
- File downloads/uploads
- Multi-tab workflows (CDP tier only)

Actions:
- navigate: Go to URL
- screenshot: Capture page image
- click: Click an element
- type: Enter text in input
- evaluate: Run JavaScript
- extract: Get page data (text/html/links/tables/structured)
- scroll: Scroll page or element
- hover: Hover over element (triggers dropdowns)
- download: Download a file
- upload: Upload file to input
- tabs_list: List open tabs (CDP only)
- tabs_open: Open new tab (CDP only)
- tabs_close: Close a tab (CDP only)
- tabs_focus: Switch to tab (CDP only)

Tiers:
- Electron (default): Hidden window for JS rendering
- CDP: Connects to user's Chrome for logged-in sessions + multi-tab

Set requires_auth=true for pages needing login (uses CDP tier).
For CDP, user must start Chrome with: --remote-debugging-port=9222`,
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: [
            'navigate',
            'screenshot',
            'click',
            'type',
            'evaluate',
            'extract',
            'scroll',
            'hover',
            'download',
            'upload',
            'tabs_list',
            'tabs_open',
            'tabs_close',
            'tabs_focus',
          ],
          description: 'The browser action to perform',
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for navigate, tabs_open, download actions)',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for element (for click, type, hover, scroll, download, upload)',
        },
        text: {
          type: 'string',
          description: 'Text to type (for type action)',
        },
        script: {
          type: 'string',
          description: 'JavaScript to evaluate (for evaluate action)',
        },
        extract_type: {
          type: 'string',
          enum: ['text', 'html', 'links', 'tables', 'structured'],
          description: 'Type of data to extract (default: structured)',
        },
        extract_selector: {
          type: 'string',
          description: 'CSS selector to extract from (default: body)',
        },
        wait_for: {
          oneOf: [
            { type: 'string', description: 'CSS selector to wait for' },
            { type: 'number', description: 'Milliseconds to wait' },
          ],
          description: 'Wait condition after action',
        },
        tier: {
          type: 'string',
          enum: ['electron', 'cdp'],
          description: 'Force a specific browser tier',
        },
        requires_auth: {
          type: 'boolean',
          description: 'Set true if page requires login (will use CDP tier)',
        },
        scroll_direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Direction to scroll (default: down)',
        },
        scroll_amount: {
          type: 'number',
          description: 'Pixels to scroll (default: 300)',
        },
        download_path: {
          type: 'string',
          description: 'Path to save downloaded file',
        },
        download_timeout: {
          type: 'number',
          description: 'Max ms to wait for download (default: 30000)',
        },
        file_path: {
          type: 'string',
          description: 'Path to file to upload (for upload action)',
        },
        tab_id: {
          type: 'string',
          description: 'Tab ID for tabs_close, tabs_focus actions',
        },
        save_to: {
          type: 'string',
          description: 'Custom directory to save screenshots (default: app screenshots folder)',
        },
      },
      required: ['action'],
    },
  };
}

/**
 * Browser tool handler for agent
 */
export async function handleBrowserTool(input: unknown): Promise<string> {
  const manager = getBrowserManager();
  const result = await manager.handleToolInput(input as BrowserToolInput);

  // Format result for agent
  if (!result.success) {
    return JSON.stringify({
      error: result.error,
      tier: result.tier,
    });
  }

  const response: Record<string, unknown> = {
    success: true,
    tier: result.tier,
    url: result.url,
  };

  if (result.title) response.title = result.title;
  if (result.text) response.text = result.text;
  if (result.data) response.data = result.data;
  if (result.html) response.html = result.html;
  if (result.screenshot) {
    // Save screenshot to workspace folder
    const fs = await import('fs');
    const path = await import('path');
    const { app } = await import('electron');
    const os = await import('os');
    const timestamp = Date.now();
    const toolInput = input as BrowserToolInput;

    // Determine save directory: custom save_to, or persistent screenshots dir in ~/Documents
    let screenshotsDir: string;
    if (toolInput.save_to) {
      screenshotsDir = toolInput.save_to;
    } else {
      screenshotsDir = path.join(os.homedir(), 'Documents', 'Pocket-agent', 'screenshots');
    }

    // Ensure screenshots directory exists
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const screenshotPath = path.join(screenshotsDir, `screenshot-${timestamp}.png`);
    fs.writeFileSync(screenshotPath, Buffer.from(result.screenshot, 'base64'));
    response.screenshot = screenshotPath;
    response.screenshotBase64 = result.screenshot;
    response.screenshotSize = `${Math.round(result.screenshot.length / 1024)}KB`;
  }
  // New result fields
  if (result.downloadedFile) {
    response.downloadedFile = result.downloadedFile;
    response.downloadSize = result.downloadSize;
  }
  if (result.tabs) response.tabs = result.tabs;
  if (result.tabId) response.tabId = result.tabId;

  return JSON.stringify(response);
}

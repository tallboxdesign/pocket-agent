/**
 * Browser launcher utility
 *
 * Detects installed Chromium browsers and launches them with CDP enabled.
 * Supports macOS and Windows.
 */

import { spawn, exec } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';

export interface BrowserInfo {
  id: string;
  name: string;
  path: string;
  processName: string;
  bundleId: string;
  installed: boolean;
}

interface BrowserDefinition {
  id: string;
  name: string;
  processName: string;
  bundleId: string;
  macPath: string;
  winPaths: string[];
}

const BROWSER_DEFINITIONS: BrowserDefinition[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    processName: IS_WINDOWS ? 'chrome.exe' : 'Google Chrome',
    bundleId: 'com.google.Chrome',
    macPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    winPaths: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    processName: IS_WINDOWS ? 'msedge.exe' : 'Microsoft Edge',
    bundleId: 'com.microsoft.edgemac',
    macPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    winPaths: [
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  },
  {
    id: 'brave',
    name: 'Brave',
    processName: IS_WINDOWS ? 'brave.exe' : 'Brave Browser',
    bundleId: 'com.brave.Browser',
    macPath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    winPaths: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
  },
  {
    id: 'arc',
    name: 'Arc',
    processName: IS_WINDOWS ? 'Arc.exe' : 'Arc',
    bundleId: 'company.thebrowser.Browser',
    macPath: '/Applications/Arc.app/Contents/MacOS/Arc',
    winPaths: [
      path.join(process.env['LOCALAPPDATA'] || '', 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache', 'Local', 'Arc', 'Application', 'Arc.exe'),
    ],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    processName: IS_WINDOWS ? 'chrome.exe' : 'Chromium',
    bundleId: 'org.chromium.Chromium',
    macPath: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    winPaths: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Chromium', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Chromium', 'Application', 'chrome.exe'),
    ],
  },
];

/**
 * Resolve the executable path for the current platform
 */
function resolveBrowserPath(def: BrowserDefinition): string | null {
  if (IS_MACOS) {
    return existsSync(def.macPath) ? def.macPath : null;
  }
  if (IS_WINDOWS) {
    for (const p of def.winPaths) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  // Linux: fallback — try macPath (unlikely) or return null
  return existsSync(def.macPath) ? def.macPath : null;
}

/**
 * Detect installed browsers
 */
export function detectInstalledBrowsers(): BrowserInfo[] {
  const results: BrowserInfo[] = [];
  for (const def of BROWSER_DEFINITIONS) {
    const resolved = resolveBrowserPath(def);
    if (resolved) {
      results.push({
        id: def.id,
        name: def.name,
        path: resolved,
        processName: def.processName,
        bundleId: def.bundleId,
        installed: true,
      });
    }
  }
  return results;
}

/**
 * Check if a browser is currently running (cross-platform)
 */
export async function isBrowserRunning(browser: BrowserInfo): Promise<boolean> {
  try {
    if (IS_WINDOWS) {
      const { stdout } = await execAsync(
        `tasklist /FI "IMAGENAME eq ${browser.processName}" /NH`,
      );
      return stdout.toLowerCase().includes(browser.processName.toLowerCase());
    } else {
      const { stdout } = await execAsync(`pgrep -x "${browser.processName}"`);
      return stdout.trim().length > 0;
    }
  } catch {
    return false;
  }
}

/**
 * Test CDP connection
 */
export async function testCdpConnection(
  cdpUrl: string = 'http://localhost:9222',
): Promise<{ connected: boolean; error?: string; browserInfo?: unknown }> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return { connected: false, error: 'CDP endpoint not responding' };
    }

    const info = await response.json();
    return { connected: true, browserInfo: info };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

/**
 * Launch browser with CDP enabled
 */
export async function launchBrowser(
  browserId: string,
  port: number = 9222,
): Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }> {
  const def = BROWSER_DEFINITIONS.find((b) => b.id === browserId);
  if (!def) {
    return { success: false, error: `Unknown browser: ${browserId}` };
  }

  const browserPath = resolveBrowserPath(def);
  if (!browserPath) {
    return { success: false, error: `${def.name} is not installed` };
  }

  const browserInfo: BrowserInfo = {
    id: def.id,
    name: def.name,
    path: browserPath,
    processName: def.processName,
    bundleId: def.bundleId,
    installed: true,
  };

  // Check if already running
  const running = await isBrowserRunning(browserInfo);
  if (running) {
    return {
      success: false,
      alreadyRunning: true,
      error: `${def.name} is already running. Please close it first to enable remote debugging.`,
    };
  }

  try {
    // Disable macOS App Nap before launch (macOS only)
    if (IS_MACOS) {
      try {
        await execAsync(
          `defaults write ${def.bundleId} NSAppSleepDisabled -bool YES`,
        );
        console.log(`[Browser] Disabled App Nap for ${def.name}`);
      } catch {
        console.warn(`[Browser] Could not disable App Nap for ${def.name}`);
      }
    }

    // Launch browser with remote debugging and anti-throttling flags
    const child = spawn(
      browserPath,
      [
        `--remote-debugging-port=${port}`,
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--disable-features=IntensiveWakeUpThrottling',
      ],
      {
        detached: !IS_WINDOWS, // detached is not needed on Windows
        stdio: 'ignore',
        windowsHide: true,
      },
    );

    child.unref();

    // Wait for CDP to become available with retries
    const maxAttempts = 10;
    const delayMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      const result = await testCdpConnection(`http://localhost:${port}`);
      if (result.connected) {
        return { success: true };
      }

      console.log(`[Browser] CDP connection attempt ${attempt}/${maxAttempts}...`);
    }

    return {
      success: false,
      error: 'Browser launched but CDP connection timed out. Try "Test Connection" in a moment.',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to launch browser',
    };
  }
}

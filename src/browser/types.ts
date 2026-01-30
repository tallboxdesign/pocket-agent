/**
 * Browser automation types
 */

export type BrowserTier = 'electron' | 'cdp';

export type BrowserActionType =
  | 'navigate'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'evaluate'
  | 'extract'
  | 'scroll'
  | 'hover'
  | 'download'
  | 'upload'
  | 'tabs_list'
  | 'tabs_open'
  | 'tabs_close'
  | 'tabs_focus';

export interface BrowserAction {
  action: BrowserActionType;
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  extractType?: 'text' | 'html' | 'links' | 'tables' | 'structured';
  extractSelector?: string;
  waitFor?: string | number; // selector or ms
  tier?: BrowserTier; // Force a specific tier
  requiresAuth?: boolean; // Hint that auth is needed (triggers CDP)
  // Scroll options
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number; // pixels
  // Download options
  downloadPath?: string; // where to save
  downloadTimeout?: number; // ms to wait for download
  // Upload options
  filePath?: string; // file to upload
  // Tab options
  tabId?: string; // for tabs_close, tabs_focus
}

export interface BrowserResult {
  success: boolean;
  tier: BrowserTier;
  data?: unknown;
  screenshot?: string; // base64
  html?: string;
  text?: string;
  error?: string;
  url?: string;
  title?: string;
  // Download result
  downloadedFile?: string;
  downloadSize?: number;
  // Tab results
  tabs?: Array<{ id: string; url: string; title: string; active: boolean }>;
  tabId?: string;
}

export interface ExtractedData {
  text?: string;
  html?: string;
  links?: Array<{ href: string; text: string }>;
  tables?: Array<Array<Array<string>>>;
  structured?: Record<string, unknown>;
}

export interface BrowserState {
  currentUrl?: string;
  currentTier?: BrowserTier;
  electronWindowId?: number;
  cdpConnected?: boolean;
}

export interface BrowserToolInput {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  extract_type?: string;
  extract_selector?: string;
  wait_for?: string | number;
  tier?: string;
  requires_auth?: boolean;
  // New fields
  scroll_direction?: string;
  scroll_amount?: number;
  download_path?: string;
  download_timeout?: number;
  file_path?: string;
  tab_id?: string;
  save_to?: string; // Custom directory to save screenshots
}

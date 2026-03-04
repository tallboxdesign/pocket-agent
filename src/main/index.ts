import { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, Notification, globalShortcut, shell, dialog, screen, powerMonitor, powerSaveBlocker } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { AgentManager } from '../agent';
import { MemoryManager } from '../memory';
import { createScheduler, CronScheduler } from '../scheduler';
import { createTelegramBot, TelegramBot } from '../channels/telegram';
import { SettingsManager, SETTINGS_SCHEMA } from '../settings';
import { loadIdentity, saveIdentity, getIdentityPath, DEFAULT_IDENTITY } from '../config/identity';
import { loadInstructions, saveInstructions, getInstructionsPath, DEFAULT_INSTRUCTIONS } from '../config/instructions';
import { DEFAULT_COMMANDS } from '../config/commands';
import { loadWorkflowCommands } from '../config/commands-loader';
import { closeTaskDb, closeKanbanDb, setResearchTelegramBot } from '../tools';
import { setLinkedInTelegramBot, notifyTelegram, rescheduleStalePosts, rebalancePendingSchedules, markLinkedInControlSource } from '../tools/linkedin-autoposter';
import { linkedinExec } from '../tools/linkedin-wrapper';
import {
  clearExternalActionAudit,
  getExternalActionAudit,
  getExternalSafetyState,
  runExternalActionRegression,
} from '../agent/safety';
import { KanbanService, type KanbanStatus, migrateTasksToKanban } from '../kanban';
import { getBrowserManager } from '../browser';
import { WAQManager } from '../queue/processor';
import { createTelegramDispatcher } from '../channels/telegram/waq-adapter';
import { initializeUpdater, setupUpdaterIPC, setSettingsWindow } from './updater';
import cityTimezones from 'city-timezones';

// Handle EPIPE errors gracefully (happens when stdout pipe is closed)
process.stdout?.on('error', (err: Error & { code?: string }) => {
  if (err.code === 'EPIPE') return;
});
process.stderr?.on('error', (err: Error & { code?: string }) => {
  if (err.code === 'EPIPE') return;
});
process.on('uncaughtException', (err) => {
  if (err.message?.includes('EPIPE')) return;
  console.error('[Main] Uncaught Exception:', err);

  // Check if this is a recoverable error (API/network/auth)
  const msg = err.message?.toLowerCase() || '';
  const isRecoverable =
    msg.includes('401') || msg.includes('403') || msg.includes('429') ||
    msg.includes('unauthorized') || msg.includes('rate limit') ||
    msg.includes('econnrefused') || msg.includes('etimedout') ||
    msg.includes('enotfound') || msg.includes('fetch failed') ||
    msg.includes('socket hang up') || msg.includes('econnreset') ||
    msg.includes('api key') || msg.includes('overloaded') ||
    msg.includes('network') || msg.includes('aborted') ||
    msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504');

  if (isRecoverable) {
    console.error('[Main] Recoverable error caught at process level — NOT exiting');
    return;
  }

  // Fatal error — exit
  console.error('[Main] FATAL uncaught exception — exiting');
  process.exit(1);
});

const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';

/**
 * Scan a directory for version subdirectories containing a bin/ folder.
 * Used by nvm, n, and nvm-windows to find installed Node versions.
 */
function scanVersionBins(versionsDir: string, binSubdir = 'bin'): string[] {
  const paths: string[] = [];
  try {
    if (fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir)) {
        const binPath = path.join(versionsDir, entry, binSubdir);
        if (fs.existsSync(binPath)) {
          paths.push(binPath);
        }
      }
    }
  } catch {
    // Ignore errors reading directory
  }
  return paths;
}

/**
 * Detect Node.js paths from all common Unix version managers.
 * Covers: nvm, fnm, volta, asdf, nodenv, n, mise
 */
function detectNodeManagerPaths(): string[] {
  const paths: string[] = [];

  // nvm: ~/.nvm/versions/node/*/bin
  paths.push(...scanVersionBins(path.join(HOME_DIR, '.nvm/versions/node')));

  // fnm: ~/.fnm/aliases/default/bin or ~/.local/share/fnm/aliases/default/bin
  const fnmPaths = [
    path.join(HOME_DIR, '.fnm/aliases/default/bin'),
    path.join(HOME_DIR, '.local/share/fnm/aliases/default/bin'),
  ];
  for (const p of fnmPaths) {
    if (fs.existsSync(p)) paths.push(p);
  }

  // volta: ~/.volta/bin
  const voltaBin = path.join(HOME_DIR, '.volta/bin');
  if (fs.existsSync(voltaBin)) paths.push(voltaBin);

  // asdf: ~/.asdf/shims
  const asdfShims = path.join(HOME_DIR, '.asdf/shims');
  if (fs.existsSync(asdfShims)) paths.push(asdfShims);

  // nodenv: ~/.nodenv/shims
  const nodenvShims = path.join(HOME_DIR, '.nodenv/shims');
  if (fs.existsSync(nodenvShims)) paths.push(nodenvShims);

  // n: /usr/local/n/versions/node/*/bin, also $N_PREFIX/bin
  paths.push(...scanVersionBins('/usr/local/n/versions/node'));
  const nPrefix = process.env.N_PREFIX;
  if (nPrefix) {
    const nPrefixBin = path.join(nPrefix, 'bin');
    if (fs.existsSync(nPrefixBin)) paths.push(nPrefixBin);
  }

  // mise: ~/.local/share/mise/shims
  const miseShims = path.join(HOME_DIR, '.local/share/mise/shims');
  if (fs.existsSync(miseShims)) paths.push(miseShims);

  return paths;
}

/**
 * Detect Node.js paths from common Windows version managers.
 * Covers: nvm-windows, fnm, volta, scoop, chocolatey, nodist
 */
function detectWindowsNodePaths(): string[] {
  const paths: string[] = [];
  const appData = process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(HOME_DIR, 'AppData', 'Local');

  // nvm-windows: %APPDATA%\nvm\* (version directories contain node.exe directly)
  paths.push(...scanVersionBins(path.join(appData, 'nvm'), '.'));

  // fnm: %APPDATA%\fnm\aliases\default
  const fnmDefault = path.join(appData, 'fnm', 'aliases', 'default');
  if (fs.existsSync(fnmDefault)) paths.push(fnmDefault);

  // volta: %APPDATA%\Volta\bin or %LOCALAPPDATA%\Volta\bin
  const voltaPaths = [
    path.join(appData, 'Volta', 'bin'),
    path.join(localAppData, 'Volta', 'bin'),
  ];
  for (const p of voltaPaths) {
    if (fs.existsSync(p)) paths.push(p);
  }

  // scoop: ~/scoop/shims
  const scoopShims = path.join(HOME_DIR, 'scoop', 'shims');
  if (fs.existsSync(scoopShims)) paths.push(scoopShims);

  // chocolatey: C:\ProgramData\chocolatey\bin
  const chocoBin = 'C:\\ProgramData\\chocolatey\\bin';
  if (fs.existsSync(chocoBin)) paths.push(chocoBin);

  // nodist: %APPDATA%\nodist\bin
  const nodistBin = path.join(appData, 'nodist', 'bin');
  if (fs.existsSync(nodistBin)) paths.push(nodistBin);

  return paths;
}

// Cache detected paths at module load
const cachedNodeManagerPaths = IS_WINDOWS ? detectWindowsNodePaths() : detectNodeManagerPaths();

// Fix PATH for packaged apps — platform-aware
if (app.isPackaged) {
  if (IS_WINDOWS) {
    // Windows: ensure common tool directories are on PATH
    const winPaths = [
      path.join(HOME_DIR, 'AppData', 'Roaming', 'npm'),
      path.join(HOME_DIR, '.local', 'bin'),
      'C:\\Program Files\\nodejs',
      'C:\\Program Files\\Git\\cmd',
      ...cachedNodeManagerPaths,
    ].join(';');
    process.env.PATH = winPaths + ';' + (process.env.PATH || '');
  } else {
    // macOS / Linux: node/npm binaries aren't in PATH when launched from Finder
    const fixedPath = [
      '/opt/homebrew/bin',        // Apple Silicon Homebrew
      '/usr/local/bin',           // Intel Homebrew / standard location
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      ...cachedNodeManagerPaths,  // All version managers (nvm, fnm, volta, asdf, etc.)
      HOME_DIR + '/.local/bin',
    ].join(':');
    process.env.PATH = fixedPath + ':' + (process.env.PATH || '');
  }
  if (cachedNodeManagerPaths.length > 0) {
    console.log('[Main] Detected Node paths:', cachedNodeManagerPaths.join(', '));
  }
  console.log('[Main] Fixed PATH for packaged app');
}

// Month name mapping for birthday parsing
const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/**
 * Parse a birthday string into month and day
 * Supports formats like: "March 15", "15 March", "3/15", "03-15", "March 15th"
 */
function parseBirthday(birthday: string): { month: number; day: number } | null {
  if (!birthday || !birthday.trim()) return null;

  const cleaned = birthday.trim().toLowerCase();

  // Try "Month Day" or "Month Dayth/st/nd/rd" format (e.g., "March 15" or "March 15th")
  const monthDayMatch = cleaned.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (monthDayMatch) {
    const month = MONTHS[monthDayMatch[1]];
    const day = parseInt(monthDayMatch[2], 10);
    if (month && day >= 1 && day <= 31) {
      return { month, day };
    }
  }

  // Try "Day Month" format (e.g., "15 March" or "15th March")
  const dayMonthMatch = cleaned.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const month = MONTHS[dayMonthMatch[2]];
    if (month && day >= 1 && day <= 31) {
      return { month, day };
    }
  }

  // Try numeric formats: "3/15", "03/15", "3-15", "03-15"
  const numericMatch = cleaned.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (numericMatch) {
    const first = parseInt(numericMatch[1], 10);
    const second = parseInt(numericMatch[2], 10);
    // Assume MM/DD format (US style)
    if (first >= 1 && first <= 12 && second >= 1 && second <= 31) {
      return { month: first, day: second };
    }
  }

  return null;
}

/**
 * Set up birthday cron jobs when birthday is configured
 */
async function setupBirthdayCronJobs(birthday: string): Promise<void> {
  if (!scheduler) return;

  const jobNameMidnight = 'birthday_midnight';
  const jobNameNoon = 'birthday_noon';

  // Always delete existing birthday jobs first (including legacy names with underscore prefix)
  scheduler.deleteJob(jobNameMidnight);
  scheduler.deleteJob(jobNameNoon);
  scheduler.deleteJob('_birthday_midnight');
  scheduler.deleteJob('_birthday_noon');

  const parsed = parseBirthday(birthday);
  if (!parsed) {
    console.log('[Birthday] No valid birthday to schedule');
    return;
  }

  const { month, day } = parsed;
  const userName = SettingsManager.get('profile.name') || 'the user';

  // Cron format: minute hour day month day-of-week
  // Midnight: 0 0 DAY MONTH *
  // Noon: 0 12 DAY MONTH *
  const cronMidnight = `0 0 ${day} ${month} *`;
  const cronNoon = `0 12 ${day} ${month} *`;

  const promptMidnight = `It's ${userName}'s birthday! The clock just struck midnight. Send them a warm, heartfelt birthday message to start their special day. Be genuine and celebratory - this is the first birthday wish of their day!`;

  const promptNoon = `It's ${userName}'s birthday and it's now midday! Send them another wonderful birthday message. Make this one even more special and celebratory than the morning one - wish them an amazing rest of their birthday, mention hoping their day has been great so far, and express how much you appreciate them.`;

  // Create the jobs (channel 'telegram' to send via Telegram if configured)
  const channel = SettingsManager.get('telegram.defaultChatId') ? 'telegram' : 'desktop';

  await scheduler.createJob(jobNameMidnight, cronMidnight, promptMidnight, channel);
  await scheduler.createJob(jobNameNoon, cronNoon, promptNoon, channel);

  console.log(`[Birthday] Scheduled birthday reminders for ${month}/${day} (${userName})`);
}

let tray: Tray | null = null;
let memory: MemoryManager | null = null;
let scheduler: CronScheduler | null = null;
let telegramBot: TelegramBot | null = null;
let waqManager: WAQManager | null = null;
let emailProcessor: import('../scheduler/email-processor').EmailProcessor | null = null;
let rulesEngine: import('../scheduler/rules-engine').RulesEngine | null = null;
let unansweredEngine: import('../scheduler/unanswered-engine').UnansweredEngine | null = null;
let chatWindow: BrowserWindow | null = null;
let cronWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let factsGraphWindow: BrowserWindow | null = null;
let customizeWindow: BrowserWindow | null = null;
let factsWindow: BrowserWindow | null = null;
let soulWindow: BrowserWindow | null = null;
let skillsSetupWindow: BrowserWindow | null = null;
let kanbanWindow: BrowserWindow | null = null;
let calendarWindow: BrowserWindow | null = null;
let emailWindow: BrowserWindow | null = null;
let dailyLogsWindow: BrowserWindow | null = null;
let linkedInActivityWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

/**
 * Get the agent's isolated workspace directory.
 * This is separate from the app's project root to prevent conflicts.
 * Located in ~/Documents/Pocket-agent/
 */
function getAgentWorkspace(): string {
  const documentsPath = app.getPath('documents');
  return path.join(documentsPath, 'Pocket-agent');
}

/**
 * Ensure the agent workspace directory exists.
 * Creates it if missing (on first run, after onboarding, or if deleted).
 * Sets up CLAUDE.md and .claude/commands for the SDK to load.
 */
function ensureAgentWorkspace(): string {
  const workspace = getAgentWorkspace();

  if (!fs.existsSync(workspace)) {
    console.log('[Main] Creating agent workspace:', workspace);
    fs.mkdirSync(workspace, { recursive: true });
  }

  const currentVersion = app.getVersion();
  const versionFile = path.join(workspace, '.pocket-version');

  // Check if app version changed (update occurred)
  let previousVersion: string | null = null;
  let isVersionUpdate = false;

  if (fs.existsSync(versionFile)) {
    previousVersion = fs.readFileSync(versionFile, 'utf-8').trim();
    if (previousVersion !== currentVersion) {
      isVersionUpdate = true;
      console.log(`[Main] App updated from v${previousVersion} to v${currentVersion}`);
    }
  } else {
    // First install or version file missing - treat as update to populate files
    isVersionUpdate = true;
    console.log(`[Main] First install or version file missing, will populate config files`);
  }

  // Repopulate config files on version update
  if (isVersionUpdate) {
    const identityPath = path.join(workspace, 'identity.md');
    const claudeMdPath = path.join(workspace, 'CLAUDE.md');
    const backupDir = path.join(workspace, '.backups');

    // Create backup directory
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Identity: only create if missing — never overwrite user customizations
    if (fs.existsSync(identityPath)) {
      const defaultsBackup = path.join(backupDir, `identity-defaults-${currentVersion}.md`);
      fs.writeFileSync(defaultsBackup, DEFAULT_IDENTITY);
      console.log(`[Main] Saved default identity.md for reference: ${defaultsBackup}`);
    } else {
      fs.writeFileSync(identityPath, DEFAULT_IDENTITY);
      console.log('[Main] Created identity.md with defaults (first install)');
    }

    // Instructions: only create if missing — never overwrite user customizations
    if (fs.existsSync(claudeMdPath)) {
      const defaultsBackup = path.join(backupDir, `CLAUDE-defaults-${currentVersion}.md`);
      fs.writeFileSync(defaultsBackup, DEFAULT_INSTRUCTIONS);
      console.log(`[Main] Saved default CLAUDE.md for reference: ${defaultsBackup}`);
    } else {
      fs.writeFileSync(claudeMdPath, DEFAULT_INSTRUCTIONS);
      console.log('[Main] Created CLAUDE.md with defaults (first install)');
    }

    // Populate default workflow commands
    // If .claude is a symlink from a previous install, replace it with a real directory
    const workspaceClaudeDirForCmds = path.join(workspace, '.claude');
    if (fs.existsSync(workspaceClaudeDirForCmds) && fs.lstatSync(workspaceClaudeDirForCmds).isSymbolicLink()) {
      // Preserve any user-created commands from the symlink target before replacing
      const symlinkCommandsDir = path.join(workspaceClaudeDirForCmds, 'commands');
      const preservedCommands: Array<{ name: string; content: string }> = [];
      if (fs.existsSync(symlinkCommandsDir)) {
        const defaultFilenames = new Set(DEFAULT_COMMANDS.map(c => c.filename));
        for (const file of fs.readdirSync(symlinkCommandsDir).filter(f => f.endsWith('.md'))) {
          if (!defaultFilenames.has(file)) {
            preservedCommands.push({ name: file, content: fs.readFileSync(path.join(symlinkCommandsDir, file), 'utf-8') });
          }
        }
      }
      fs.unlinkSync(workspaceClaudeDirForCmds);
      fs.mkdirSync(workspaceClaudeDirForCmds, { recursive: true });
      console.log('[Main] Replaced .claude symlink with real directory for commands');
      // Restore preserved user commands
      if (preservedCommands.length > 0) {
        const restoredDir = path.join(workspaceClaudeDirForCmds, 'commands');
        fs.mkdirSync(restoredDir, { recursive: true });
        for (const cmd of preservedCommands) {
          fs.writeFileSync(path.join(restoredDir, cmd.name), cmd.content);
        }
        console.log(`[Main] Preserved ${preservedCommands.length} user workflow command(s)`);
      }
    }
    const commandsDir = path.join(workspaceClaudeDirForCmds, 'commands');
    if (!fs.existsSync(commandsDir)) {
      fs.mkdirSync(commandsDir, { recursive: true });
    }
    // Only write defaults — never delete existing user commands
    for (const cmd of DEFAULT_COMMANDS) {
      fs.writeFileSync(path.join(commandsDir, cmd.filename), cmd.content);
    }
    console.log(`[Main] Populated ${DEFAULT_COMMANDS.length} default workflow command(s)`);

    // Update version file
    fs.writeFileSync(versionFile, currentVersion);
    console.log(`[Main] Updated version file to v${currentVersion}`);
  }

  // Ensure .claude folder is symlinked from source (for skills and commands)
  // Clean up legacy .claude/skills folder (no longer used)
  const workspaceClaudeDir = path.join(workspace, '.claude');
  if (fs.existsSync(workspaceClaudeDir)) {
    const workspaceSkillsDir = path.join(workspaceClaudeDir, 'skills');
    try {
      if (fs.existsSync(workspaceSkillsDir)) {
        const stats = fs.lstatSync(workspaceSkillsDir);
        if (stats.isSymbolicLink()) {
          fs.unlinkSync(workspaceSkillsDir);
        } else {
          fs.rmSync(workspaceSkillsDir, { recursive: true, force: true });
        }
        console.log('[Main] Removed legacy .claude/skills folder');
      }
    } catch (err) {
      console.warn('[Main] Failed to remove legacy .claude/skills:', err);
    }
  }

  // Ensure CLAUDE.md exists and is up to date
  const claudeMdPath = path.join(workspace, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    // File exists, no updates needed
  } else {
    console.log('[Main] Creating workspace CLAUDE.md');
    const claudeMdContent = `# Pocket Agent Workspace

This is your personal workspace directory. All file operations happen here by default.

## Workspace Guidelines
- Create subdirectories for different projects
- This workspace persists across sessions
- Use absolute paths to work outside this directory

## Core Behavior

**PROACTIVE MEMORY IS CRITICAL:**
- Save facts IMMEDIATELY when user shares info - don't ask, just remember
- Search memory before answering questions about the user
- Reference stored knowledge naturally: "As you mentioned before..."
- Update facts when information changes (forget + remember)

## Available Tools

All tools are pre-approved. Use them directly.

### Memory
- \`remember(category, subject, content)\` - Save facts
- \`forget(category, subject)\` - Remove facts
- \`list_facts(category?)\` - Show facts
- \`memory_search(query)\` - Search facts

**Categories:** user_info, preferences, projects, people, work, notes, decisions

### Calendar
- \`calendar_add(title, start_time, reminder_minutes?, location?)\`
- \`calendar_list(date?)\` - "today", "tomorrow", or date
- \`calendar_upcoming(hours?)\` - Next N hours
- \`calendar_delete(id)\`

### Tasks
- \`task_add(title, due?, priority?, reminder_minutes?)\`
- \`task_list(status?)\` - pending/completed/all
- \`task_complete(id)\`
- \`task_delete(id)\`
- \`task_due(hours?)\` - Overdue/upcoming

### Scheduler (Recurring)
- \`schedule_task(name, cron, prompt, channel?)\`
- \`list_scheduled_tasks()\`
- \`delete_scheduled_task(name)\`

### Browser
- \`browser(action, ...)\` - navigate, screenshot, click, type, scroll, hover, download, upload, tabs
- Use \`requires_auth: true\` for logged-in sessions

### System
- \`notify(title, body?, urgency?)\` - Desktop notification
- \`pty_exec(command)\` - Interactive terminal

## Time Formats
- Natural: "today 3pm", "tomorrow 9am", "monday 2pm"
- Relative: "in 2 hours", "in 30 minutes"

## Behavior
1. **Memory First** - Check/save relevant facts
2. **Offer Help** - Suggest tasks/events for mentioned plans
3. **Be Concise** - Verbose on desktop, brief on Telegram
4. **Stay Proactive** - Remind about overdue tasks
`;
    fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');
  }

  return workspace;
}

// ============ Tray Setup ============

async function createTray(): Promise<void> {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  const iconPath2x = path.join(__dirname, '../../assets/tray-icon@2x.png');
  let icon: Electron.NativeImage;

  try {
    // Load both 1x and 2x versions for retina support
    const icon1x = nativeImage.createFromPath(iconPath);
    const icon2x = nativeImage.createFromPath(iconPath2x);

    if (!icon1x.isEmpty() && !icon2x.isEmpty()) {
      // Create a multi-resolution image
      icon = nativeImage.createEmpty();
      const traySize = IS_WINDOWS ? 16 : 22;
      const traySize2x = IS_WINDOWS ? 32 : 44;
      icon.addRepresentation({ scaleFactor: 1, width: traySize, height: traySize, buffer: icon1x.resize({ width: traySize, height: traySize }).toPNG() });
      icon.addRepresentation({ scaleFactor: 2, width: traySize2x, height: traySize2x, buffer: icon2x.resize({ width: traySize2x, height: traySize2x }).toPNG() });
      if (IS_MACOS) icon.setTemplateImage(true); // macOS menu bar only
    } else if (!icon1x.isEmpty()) {
      icon = icon1x.resize({ width: IS_WINDOWS ? 16 : 22, height: IS_WINDOWS ? 16 : 22 });
      if (IS_MACOS) icon.setTemplateImage(true);
    } else {
      icon = createDefaultIcon();
    }
  } catch {
    icon = createDefaultIcon();
  }

  tray = new Tray(icon);
  tray.setToolTip('Pocket Agent');

  // Double-click opens chat
  tray.on('double-click', () => {
    openChatWindow();
  });

  updateTrayMenu();
}

function createDefaultIcon(): Electron.NativeImage {
  // Create a 16x16 robot face icon for macOS menu bar
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  // Helper to set a pixel white
  const setPixel = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      const i = (y * size + x) * 4;
      canvas[i] = 255;     // R
      canvas[i + 1] = 255; // G
      canvas[i + 2] = 255; // B
      canvas[i + 3] = 255; // A
    }
  };

  // Helper to draw a filled rectangle
  const fillRect = (x1: number, y1: number, x2: number, y2: number) => {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        setPixel(x, y);
      }
    }
  };

  // Draw robot face (centered in 16x16)
  // Head outline - rounded rectangle (rows 2-13, cols 3-12)
  // Top edge
  fillRect(4, 2, 11, 2);
  // Bottom edge
  fillRect(4, 13, 11, 13);
  // Left edge
  fillRect(3, 3, 3, 12);
  // Right edge
  fillRect(12, 3, 12, 12);
  // Corners
  setPixel(4, 3); setPixel(11, 3);
  setPixel(4, 12); setPixel(11, 12);

  // Antenna
  setPixel(7, 0); setPixel(8, 0);
  setPixel(7, 1); setPixel(8, 1);

  // Eyes (2x2 squares)
  fillRect(5, 5, 6, 7);   // Left eye
  fillRect(9, 5, 10, 7);  // Right eye

  // Mouth (horizontal line)
  fillRect(5, 10, 10, 11);

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  icon.setTemplateImage(true); // For macOS menu bar
  return icon;
}

function updateTrayMenu(): void {
  if (!tray) return;

  const stats = AgentManager.getStats();

  const statusText = AgentManager.isInitialized()
    ? `Messages: ${stats?.messageCount || 0} | Facts: ${stats?.factCount || 0}`
    : 'Not initialized';

  const telegramStatus = telegramBot
    ? (telegramBot.isRunning ? 'Telegram: Connected' : 'Telegram: Disconnected')
    : 'Telegram: Not configured';

  // Load menu icon
  const menuIconPath = path.join(__dirname, '../../assets/menu-icon.png');
  let menuIcon: Electron.NativeImage | undefined;
  try {
    menuIcon = nativeImage.createFromPath(menuIconPath);
    if (!menuIcon.isEmpty()) {
      menuIcon = menuIcon.resize({ width: 16, height: 16 });
      menuIcon.setTemplateImage(true);
    } else {
      menuIcon = undefined;
    }
  } catch {
    menuIcon = undefined;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Pocket Agent v${app.getVersion()}`,
      enabled: false,
      icon: menuIcon,
    },
    { type: 'separator' },
    {
      label: 'Chat',
      click: () => openChatWindow(),
      accelerator: 'Alt+Z',
    },
    {
      label: 'Projects',
      click: () => openKanbanWindow(),
    },
    {
      label: 'Calendar',
      click: () => openCalendarWindow(),
    },
    {
      label: 'LinkedIn',
      click: () => openLinkedInActivityWindow(),
    },
    { type: 'separator' },
    {
      label: statusText,
      enabled: false,
    },
    {
      label: telegramStatus,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Tweaks...',
      click: () => openSettingsWindow(),
      accelerator: 'CmdOrCtrl+,',
    },
    {
      label: 'Check for Updates...',
      click: () => openSettingsWindow('updates'),
    },
    { type: 'separator' },
    {
      label: 'Reboot',
      click: async () => {
        await restartAgent();
        showNotification('Pocket Agent', 'Back online! ✨');
      },
    },
    { type: 'separator' },
    {
      label: 'Bye!',
      click: () => app.quit(),
      accelerator: 'CmdOrCtrl+Q',
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ============ Splash Screen ============

function showSplashScreen(): void {
  console.log('[Main] Showing splash screen...');

  // Get primary display for proper centering
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const splashWidth = 650;
  const splashHeight = 200;

  splashWindow = new BrowserWindow({
    width: splashWidth,
    height: splashHeight,
    x: Math.round((screenWidth - splashWidth) / 2),
    y: Math.round((screenHeight - splashHeight) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'splash-preload.js'),
    },
  });

  splashWindow.loadFile(path.join(__dirname, '../../ui/splash.html'));

  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  // Safety timeout - force close splash after 5 seconds if IPC fails
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      console.log('[Main] Safety timeout: force-closing splash screen');
      closeSplashScreen();
    }
  }, 5000);
}

function closeSplashScreen(): void {
  console.log('[Main] closeSplashScreen called, splashWindow exists:', !!splashWindow);
  if (splashWindow && !splashWindow.isDestroyed()) {
    console.log('[Main] Closing splash window...');
    splashWindow.close();
    splashWindow = null;
    console.log('[Main] Splash window closed');
  }
}

// ============ Windows ============

function openChatWindow(): void {
  console.log('[Main] Opening chat window...');
  if (chatWindow && !chatWindow.isDestroyed()) {
    console.log('[Main] Chat window already exists, focusing');
    chatWindow.show();
    chatWindow.focus();
    return;
  }

  // Load saved window bounds
  const savedBoundsJson = SettingsManager.get('window.chatBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 600,
    height: 800,
    title: 'Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  // Apply saved bounds if available
  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
      console.log('[Main] Restored chat window bounds:', savedBounds);
    } catch {
      console.warn('[Main] Failed to parse saved window bounds');
    }
  }

  chatWindow = new BrowserWindow(windowOptions);

  chatWindow.loadFile(path.join(__dirname, '../../ui/chat.html'));

  chatWindow.once('ready-to-show', () => {
    chatWindow?.show();
    if (SettingsManager.getBoolean('debug.devTools')) {
      chatWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // Save window bounds when moved, resized, or closed
  const saveBounds = () => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      const bounds = chatWindow.getBounds();
      SettingsManager.set('window.chatBounds', JSON.stringify(bounds));
    }
  };

  chatWindow.on('moved', saveBounds);
  chatWindow.on('resized', saveBounds);
  chatWindow.on('close', saveBounds);

  chatWindow.on('closed', () => {
    chatWindow = null;
  });
}

function openCronWindow(): void {
  if (cronWindow && !cronWindow.isDestroyed()) {
    cronWindow.show();
    cronWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.cronBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 500,
    title: 'My Routines - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  cronWindow = new BrowserWindow(windowOptions);

  cronWindow.loadFile(path.join(__dirname, '../../ui/cron.html'));

  cronWindow.once('ready-to-show', () => {
    cronWindow?.show();
  });

  const saveBounds = () => {
    if (cronWindow && !cronWindow.isDestroyed()) {
      SettingsManager.set('window.cronBounds', JSON.stringify(cronWindow.getBounds()));
    }
  };
  cronWindow.on('moved', saveBounds);
  cronWindow.on('resized', saveBounds);
  cronWindow.on('close', saveBounds);

  cronWindow.on('closed', () => {
    cronWindow = null;
  });
}

function openSettingsWindow(tab?: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (tab) {
      settingsWindow.webContents.send('navigate-tab', tab);
    }
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.settingsBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 600,
    title: 'Tweaks - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  settingsWindow = new BrowserWindow(windowOptions);

  // Clear cache to ensure fresh HTML loads during development
  settingsWindow.webContents.session.clearCache().then(() => {
    const hash = tab ? `#${tab}` : '';
    settingsWindow?.loadFile(path.join(__dirname, '../../ui/settings.html'), { hash });
  });

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });

  const saveBounds = () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      SettingsManager.set('window.settingsBounds', JSON.stringify(settingsWindow.getBounds()));
    }
  };
  settingsWindow.on('moved', saveBounds);
  settingsWindow.on('resized', saveBounds);
  settingsWindow.on('close', saveBounds);

  settingsWindow.on('closed', () => {
    setSettingsWindow(null);
    settingsWindow = null;
  });

  // Connect updater to settings window for status updates
  setSettingsWindow(settingsWindow);
}

function openSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 520,
    height: 580,
    title: 'Welcome!',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    resizable: false,
    minimizable: false,
    closable: true,
  });

  setupWindow.loadFile(path.join(__dirname, '../../ui/setup.html'));

  setupWindow.once('ready-to-show', () => {
    setupWindow?.show();
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
    // After setup is closed, check if we can initialize
    if (SettingsManager.hasRequiredKeys() && !AgentManager.isInitialized()) {
      initializeAgent();
    }
  });
}

function openFactsGraphWindow(): void {
  if (factsGraphWindow && !factsGraphWindow.isDestroyed()) {
    factsGraphWindow.show();
    factsGraphWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.factsGraphBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 700,
    title: 'Mind Map - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  factsGraphWindow = new BrowserWindow(windowOptions);

  factsGraphWindow.loadFile(path.join(__dirname, '../../ui/facts-graph.html'));

  factsGraphWindow.once('ready-to-show', () => {
    factsGraphWindow?.show();
  });

  const saveBounds = () => {
    if (factsGraphWindow && !factsGraphWindow.isDestroyed()) {
      SettingsManager.set('window.factsGraphBounds', JSON.stringify(factsGraphWindow.getBounds()));
    }
  };
  factsGraphWindow.on('moved', saveBounds);
  factsGraphWindow.on('resized', saveBounds);
  factsGraphWindow.on('close', saveBounds);

  factsGraphWindow.on('closed', () => {
    factsGraphWindow = null;
  });
}

function openCustomizeWindow(): void {
  if (customizeWindow && !customizeWindow.isDestroyed()) {
    customizeWindow.show();
    customizeWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.customizeBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 800,
    height: 650,
    title: 'Make It Yours - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  customizeWindow = new BrowserWindow(windowOptions);

  customizeWindow.loadFile(path.join(__dirname, '../../ui/customize.html'));

  customizeWindow.once('ready-to-show', () => {
    customizeWindow?.show();
  });

  const saveBounds = () => {
    if (customizeWindow && !customizeWindow.isDestroyed()) {
      SettingsManager.set('window.customizeBounds', JSON.stringify(customizeWindow.getBounds()));
    }
  };
  customizeWindow.on('moved', saveBounds);
  customizeWindow.on('resized', saveBounds);
  customizeWindow.on('close', saveBounds);

  customizeWindow.on('closed', () => {
    customizeWindow = null;
  });
}

function openFactsWindow(): void {
  if (factsWindow && !factsWindow.isDestroyed()) {
    factsWindow.show();
    factsWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.factsBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 550,
    title: 'My Brain - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  factsWindow = new BrowserWindow(windowOptions);

  factsWindow.loadFile(path.join(__dirname, '../../ui/facts.html'));

  factsWindow.once('ready-to-show', () => {
    factsWindow?.show();
  });

  const saveBounds = () => {
    if (factsWindow && !factsWindow.isDestroyed()) {
      SettingsManager.set('window.factsBounds', JSON.stringify(factsWindow.getBounds()));
    }
  };
  factsWindow.on('moved', saveBounds);
  factsWindow.on('resized', saveBounds);
  factsWindow.on('close', saveBounds);

  factsWindow.on('closed', () => {
    factsWindow = null;
  });
}

function openLinkedInActivityWindow(): void {
  if (linkedInActivityWindow && !linkedInActivityWindow.isDestroyed()) {
    linkedInActivityWindow.show();
    linkedInActivityWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.linkedInActivityBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 600,
    title: 'LinkedIn Activity - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  linkedInActivityWindow = new BrowserWindow(windowOptions);
  linkedInActivityWindow.loadFile(path.join(__dirname, '../../ui/linkedin-activity.html'));

  linkedInActivityWindow.once('ready-to-show', () => {
    linkedInActivityWindow?.show();
  });

  const saveBounds = () => {
    if (linkedInActivityWindow && !linkedInActivityWindow.isDestroyed()) {
      SettingsManager.set('window.linkedInActivityBounds', JSON.stringify(linkedInActivityWindow.getBounds()));
    }
  };
  linkedInActivityWindow.on('moved', saveBounds);
  linkedInActivityWindow.on('resized', saveBounds);
  linkedInActivityWindow.on('close', saveBounds);

  linkedInActivityWindow.on('closed', () => {
    linkedInActivityWindow = null;
  });
}

function openDailyLogsWindow(): void {
  if (dailyLogsWindow && !dailyLogsWindow.isDestroyed()) {
    dailyLogsWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.dailyLogsBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 550,
    title: 'Daily Logs - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  dailyLogsWindow = new BrowserWindow(windowOptions);

  dailyLogsWindow.loadFile(path.join(__dirname, '../../ui/daily-logs.html'));

  dailyLogsWindow.once('ready-to-show', () => {
    dailyLogsWindow?.show();
  });

  const saveBounds = () => {
    if (dailyLogsWindow && !dailyLogsWindow.isDestroyed()) {
      SettingsManager.set('window.dailyLogsBounds', JSON.stringify(dailyLogsWindow.getBounds()));
    }
  };
  dailyLogsWindow.on('moved', saveBounds);
  dailyLogsWindow.on('resized', saveBounds);
  dailyLogsWindow.on('close', saveBounds);

  dailyLogsWindow.on('closed', () => {
    dailyLogsWindow = null;
  });
}

function openSoulWindow(): void {
  if (soulWindow && !soulWindow.isDestroyed()) {
    soulWindow.show();
    soulWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.soulBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 700,
    height: 550,
    title: 'Agent Soul - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  soulWindow = new BrowserWindow(windowOptions);

  soulWindow.loadFile(path.join(__dirname, '../../ui/soul.html'));

  soulWindow.once('ready-to-show', () => {
    soulWindow?.show();
  });

  const saveBounds = () => {
    if (soulWindow && !soulWindow.isDestroyed()) {
      SettingsManager.set('window.soulBounds', JSON.stringify(soulWindow.getBounds()));
    }
  };
  soulWindow.on('moved', saveBounds);
  soulWindow.on('resized', saveBounds);
  soulWindow.on('close', saveBounds);

  soulWindow.on('closed', () => {
    soulWindow = null;
  });
}

function createSkillsSetupWindow(): void {
  if (skillsSetupWindow && !skillsSetupWindow.isDestroyed()) {
    skillsSetupWindow.show();
    skillsSetupWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.skillsSetupBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 700,
    title: 'Superpowers - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  skillsSetupWindow = new BrowserWindow(windowOptions);

  skillsSetupWindow.loadFile(path.join(__dirname, '../../ui/skills-setup.html'));

  skillsSetupWindow.once('ready-to-show', () => {
    skillsSetupWindow?.show();
  });

  const saveBounds = () => {
    if (skillsSetupWindow && !skillsSetupWindow.isDestroyed()) {
      SettingsManager.set('window.skillsSetupBounds', JSON.stringify(skillsSetupWindow.getBounds()));
    }
  };
  skillsSetupWindow.on('moved', saveBounds);
  skillsSetupWindow.on('resized', saveBounds);
  skillsSetupWindow.on('close', saveBounds);

  skillsSetupWindow.on('closed', () => {
    skillsSetupWindow = null;
  });
}

function openKanbanWindow(): void {
  if (kanbanWindow && !kanbanWindow.isDestroyed()) {
    kanbanWindow.show();
    kanbanWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.kanbanBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1100,
    height: 700,
    title: 'Projects - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  kanbanWindow = new BrowserWindow(windowOptions);

  kanbanWindow.loadFile(path.join(__dirname, '../../ui/kanban.html'));

  kanbanWindow.once('ready-to-show', () => {
    kanbanWindow?.show();
  });

  const saveBounds = () => {
    if (kanbanWindow && !kanbanWindow.isDestroyed()) {
      SettingsManager.set('window.kanbanBounds', JSON.stringify(kanbanWindow.getBounds()));
    }
  };
  kanbanWindow.on('moved', saveBounds);
  kanbanWindow.on('resized', saveBounds);
  kanbanWindow.on('close', saveBounds);

  kanbanWindow.on('closed', () => {
    kanbanWindow = null;
  });
}

function openCalendarWindow(): void {
  if (calendarWindow && !calendarWindow.isDestroyed()) {
    calendarWindow.show();
    calendarWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.calendarBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 700,
    title: 'Calendar - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  calendarWindow = new BrowserWindow(windowOptions);

  calendarWindow.loadFile(path.join(__dirname, '../../ui/calendar.html'));

  calendarWindow.once('ready-to-show', () => {
    calendarWindow?.show();
  });

  const saveBounds = () => {
    if (calendarWindow && !calendarWindow.isDestroyed()) {
      SettingsManager.set('window.calendarBounds', JSON.stringify(calendarWindow.getBounds()));
    }
  };
  calendarWindow.on('moved', saveBounds);
  calendarWindow.on('resized', saveBounds);
  calendarWindow.on('close', saveBounds);

  calendarWindow.on('closed', () => {
    calendarWindow = null;
  });
}

function openEmailProcessingWindow(): void {
  if (emailWindow && !emailWindow.isDestroyed()) {
    emailWindow.show();
    emailWindow.focus();
    return;
  }

  const savedBoundsJson = SettingsManager.get('window.emailBounds');
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 650,
    title: 'Email Processing - Pocket Agent',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  if (savedBoundsJson) {
    try {
      const savedBounds = JSON.parse(savedBoundsJson);
      if (savedBounds.x !== undefined) windowOptions.x = savedBounds.x;
      if (savedBounds.y !== undefined) windowOptions.y = savedBounds.y;
      if (savedBounds.width) windowOptions.width = savedBounds.width;
      if (savedBounds.height) windowOptions.height = savedBounds.height;
    } catch { /* ignore */ }
  }

  emailWindow = new BrowserWindow(windowOptions);

  emailWindow.loadFile(path.join(__dirname, '../../ui/settings.html'), { hash: 'email-standalone' });

  emailWindow.once('ready-to-show', () => {
    emailWindow?.show();
  });

  const saveBounds = () => {
    if (emailWindow && !emailWindow.isDestroyed()) {
      SettingsManager.set('window.emailBounds', JSON.stringify(emailWindow.getBounds()));
    }
  };
  emailWindow.on('moved', saveBounds);
  emailWindow.on('resized', saveBounds);
  emailWindow.on('close', saveBounds);

  emailWindow.on('closed', () => {
    emailWindow = null;
  });
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function getLinkedInDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function normalizeLinkedInText(raw: string): string {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLinkedInPostUrl(raw: string): string {
  const input = String(raw || '').trim();
  if (!input) return '';
  const activityMatch = input.match(/urn:li:activity:\d+/i);
  if (activityMatch) {
    return `https://www.linkedin.com/feed/update/${activityMatch[0].toLowerCase()}/`;
  }
  try {
    const u = new URL(input);
    u.hash = '';
    u.search = '';
    u.hostname = 'www.linkedin.com';
    let pathname = u.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    u.pathname = `${pathname}/`;
    return u.toString();
  } catch {
    return input;
  }
}

function extractLinkedInActivityId(url: string): string | null {
  const m = String(url || '').match(/activity:(\d+)/i);
  return m ? m[1] : null;
}

function hasPostedLinkedInUrl(db: any, rawUrl: string): { matched: boolean; matchedUrl?: string; createdAt?: string } {
  const normalizedUrl = normalizeLinkedInPostUrl(rawUrl);
  if (!normalizedUrl) return { matched: false };
  const activityId = extractLinkedInActivityId(normalizedUrl);
  const row = activityId
    ? db.prepare(
      `SELECT post_url, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted'
         AND (post_url = ? OR post_url LIKE ?)
       ORDER BY id DESC
       LIMIT 1`
    ).get(normalizedUrl, `%activity:${activityId}%`) as { post_url?: string; created_at?: string } | undefined
    : db.prepare(
      `SELECT post_url, created_at
       FROM linkedin_activity_log
       WHERE action = 'posted' AND post_url = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(normalizedUrl) as { post_url?: string; created_at?: string } | undefined;
  if (!row?.post_url) return { matched: false };
  return { matched: true, matchedUrl: row.post_url, createdAt: row.created_at };
}

function reconcileLinkedInPostedState(db: any): number {
  const rows = db.prepare(
    `SELECT id, post_url
     FROM linkedin_posts
     WHERE commented = 0`
  ).all() as Array<{ id: number; post_url: string }>;
  if (!rows.length) return 0;
  const markPosted = db.prepare(
    `UPDATE linkedin_posts
     SET commented = 1, approved = 0, scheduled_at = NULL
     WHERE id = ?`
  );
  let fixed = 0;
  for (const row of rows) {
    if (hasPostedLinkedInUrl(db, row.post_url).matched) {
      markPosted.run(row.id);
      fixed += 1;
    }
  }
  return fixed;
}

function buildTwoSentenceSummary(raw: string): string {
  const text = normalizeLinkedInText(raw);
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentences = flat
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(Boolean);
  const selected: string[] = [];
  for (const sentence of sentences) {
    if (sentence.split(/\s+/).length < 5) continue;
    selected.push(sentence);
    if (selected.length >= 2) break;
  }
  if (selected.length >= 2) return selected.join(' ');
  if (selected.length === 1) {
    const words = flat.split(/\s+/);
    const firstCount = selected[0].split(/\s+/).length;
    const tail = words.slice(firstCount, firstCount + 18).join(' ');
    if (!tail) return selected[0];
    const clipped = words.length > firstCount + 18 ? `${tail}...` : tail;
    return `${selected[0]} ${clipped}`;
  }
  const words = flat.split(/\s+/);
  return words.slice(0, 32).join(' ') + (words.length > 32 ? '...' : '');
}

const CACHE_WARN_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1 GB

type CacheStats = {
  userDataPath: string;
  safeCacheBytes: number;
  appDataBytes: number;
  appBundleBytes: number;
  dbBytes: number;
  dbWalBytes: number;
  thresholdBytes: number;
  overThreshold: boolean;
};

function getDirectorySizeBytes(targetDir: string): number {
  let total = 0;
  try {
    if (!targetDir || !fs.existsSync(targetDir)) return 0;
    const stack: string[] = [targetDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) stack.push(fullPath);
          else if (entry.isFile() || entry.isSymbolicLink()) total += fs.lstatSync(fullPath).size;
        } catch {
          // Ignore inaccessible files.
        }
      }
    }
  } catch {
    return total;
  }
  return total;
}

function getAppBundlePath(): string {
  if (IS_MACOS) {
    const candidate = path.resolve(process.execPath, '../../..');
    if (candidate.endsWith('.app') && fs.existsSync(candidate)) return candidate;
  }
  return path.dirname(process.execPath);
}

function getSafeCacheDirs(userDataPath: string): string[] {
  const dirs = [
    path.join(userDataPath, 'Cache'),
    path.join(userDataPath, 'Code Cache'),
    path.join(userDataPath, 'GPUCache'),
    path.join(userDataPath, 'DawnGraphiteCache'),
    path.join(userDataPath, 'DawnWebGPUCache'),
    path.join(userDataPath, 'blob_storage'),
    path.join(userDataPath, 'shared_proto_db'),
    path.join(userDataPath, 'Service Worker', 'CacheStorage'),
  ];
  if (IS_MACOS) dirs.push(path.join(HOME_DIR, 'Library/Caches/pocket-agent'));
  else if (IS_WINDOWS) dirs.push(path.join(HOME_DIR, 'AppData/Local/pocket-agent/Cache'));
  else dirs.push(path.join(HOME_DIR, '.cache/pocket-agent'));
  return Array.from(new Set(dirs));
}

function collectCacheStats(): CacheStats {
  const userDataPath = app.getPath('userData');
  const safeCacheBytes = getSafeCacheDirs(userDataPath).reduce((sum, dir) => sum + getDirectorySizeBytes(dir), 0);
  const appDataBytes = getDirectorySizeBytes(userDataPath);
  const appBundleBytes = getDirectorySizeBytes(getAppBundlePath());
  const dbPath = path.join(userDataPath, 'pocket-agent.db');
  const walPath = `${dbPath}-wal`;
  const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const dbWalBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  return {
    userDataPath,
    safeCacheBytes,
    appDataBytes,
    appBundleBytes,
    dbBytes,
    dbWalBytes,
    thresholdBytes: CACHE_WARN_THRESHOLD_BYTES,
    overThreshold: safeCacheBytes >= CACHE_WARN_THRESHOLD_BYTES,
  };
}

function clearDirectoryContents(targetDir: string): void {
  if (!targetDir || !fs.existsSync(targetDir)) return;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(targetDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(targetDir, entry);
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

// ============ IPC Handlers ============

function setupIPC(): void {
  // Chat messages with status streaming
  ipcMain.handle('agent:send', async (event, message: string, sessionId?: string) => {
    console.log(`[IPC] agent:send received sessionId: ${sessionId}`);

    // Auto-initialize agent if not yet initialized (handles race conditions and late key setup)
    if (!AgentManager.isInitialized()) {
      if (SettingsManager.hasRequiredKeys()) {
        console.log('[IPC] Agent not initialized, initializing now...');
        await initializeAgent();
      }
      if (!AgentManager.isInitialized()) {
        return { success: false, error: 'No API keys configured. Please add your key in Settings > LLM.' };
      }
    }

    // Resolve session: if no explicit session given, prefer the linked Telegram session so
    // desktop and Telegram share the same conversation history.
    const resolvedSessionId = (() => {
      if (sessionId && sessionId !== 'default') return sessionId;
      const telegramSessions = memory?.getAllTelegramChatSessions();
      if (telegramSessions && telegramSessions.length > 0) {
        // Use the most recently created Telegram session (first row, ordered DESC)
        return telegramSessions[0].session_id;
      }
      return sessionId || 'default';
    })();

    // Set up status listener to forward to renderer
    const effectiveSessionId = resolvedSessionId;
    const statusHandler = (status: { type: string; sessionId?: string; toolName?: string; toolInput?: string; message?: string }) => {
      // Only forward status events for this session (or events without sessionId for backward compat)
      if (status.sessionId && status.sessionId !== effectiveSessionId) return;

      // Send status update to the chat window that initiated the request
      const webContents = event.sender;
      if (!webContents.isDestroyed()) {
        webContents.send('agent:status', status);
      }
    };

    AgentManager.on('status', statusHandler);

    try {
      const result = await AgentManager.processMessage(message, 'desktop', resolvedSessionId);
      updateTrayMenu();

      // Optional sync Desktop -> Telegram (disabled by default to avoid duplicate/noisy updates)
      const desktopToTelegramSync = SettingsManager.get('telegram.syncDesktopToTelegram') === 'true';
      if (desktopToTelegramSync) {
        const linkedChatId = memory?.getChatForSession(effectiveSessionId);
        console.log('[Main] Checking telegram sync - bot exists:', !!telegramBot, 'session:', effectiveSessionId, 'linked chat:', linkedChatId);
        if (telegramBot && linkedChatId) {
          console.log('[Main] Syncing desktop message to Telegram chat:', linkedChatId);
          telegramBot.syncToChat(message, result.response, linkedChatId, result.media).catch((err) => {
            console.error('[Main] Failed to sync desktop message to Telegram:', err);
          });
        }
      }

      return {
        success: true,
        response: result.response,
        tokensUsed: result.tokensUsed,
        suggestedPrompt: result.suggestedPrompt,
        wasCompacted: result.wasCompacted,
        media: result.media,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    } finally {
      AgentManager.off('status', statusHandler);
    }
  });

  ipcMain.handle('agent:history', async (_, limit: number = 50, sessionId?: string) => {
    return AgentManager.getRecentMessages(limit, sessionId || 'default');
  });

  ipcMain.handle('agent:stats', async (_, sessionId?: string) => {
    return AgentManager.getStats(sessionId);
  });

  ipcMain.handle('agent:clear', async (_, sessionId?: string) => {
    AgentManager.clearConversation(sessionId);
    if (sessionId) {
      AgentManager.clearSdkSessionMapping(sessionId);
    }
    updateTrayMenu();
    return { success: true };
  });

  // Sessions
  ipcMain.handle('sessions:list', async () => {
    return memory?.getSessions() || [];
  });

  ipcMain.handle('sessions:create', async (_, name: string) => {
    try {
      const mode = AgentManager.getMode();
      return { success: true, session: memory?.createSession(name, mode) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('sessions:rename', async (_, id: string, name: string) => {
    try {
      const success = memory?.renameSession(id, name) ?? false;
      return { success };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('sessions:delete', async (_, id: string) => {
    // Stop any running query for this session first to prevent orphaned processes
    AgentManager.stopQuery(id);
    // Close persistent session (kills subprocess + bg tasks) and clear queue
    AgentManager.clearQueue(id);
    AgentManager.clearSdkSessionMapping(id);  // Also closes persistent session
    const success = memory?.deleteSession(id) ?? false;
    return { success };
  });

  // Agent mode (global default for new sessions)
  ipcMain.handle('agent:setMode', async (_, mode: string) => {
    const requested = String(mode || '').trim().toLowerCase();
    const normalized = requested === 'general' ? 'manager' : requested;
    if (!['coder', 'manager'].includes(normalized)) {
      return { success: false, error: 'Invalid mode' };
    }
    AgentManager.setMode(normalized);
    SettingsManager.set('agent.mode', normalized);
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('agent:modeChanged', normalized);
    }
    return { success: true };
  });

  ipcMain.handle('agent:getMode', async () => {
    return AgentManager.getMode();
  });

  // Per-session mode (can be changed at any time; applies to future turns)
  ipcMain.handle('agent:getSessionMode', async (_, sessionId: string) => {
    return memory?.getSessionMode(sessionId) || 'coder';
  });

  ipcMain.handle('agent:setSessionMode', async (_, sessionId: string, mode: string) => {
    const requested = String(mode || '').trim().toLowerCase();
    const normalized = requested === 'general' ? 'manager' : requested;
    if (!['coder', 'manager'].includes(normalized)) {
      return { success: false, error: 'Invalid mode' };
    }
    if (!memory) return { success: false, error: 'Memory not initialized' };

    const success = memory.setSessionMode(sessionId, normalized as 'coder' | 'manager');
    if (success) {
      // Recreate the persistent SDK session so the next turn picks up the new mode prompt/tool set.
      AgentManager.clearSdkSessionMapping(sessionId);
    }
    return { success };
  });

  ipcMain.handle('agent:stop', async (_, sessionId?: string) => {
    const stopped = AgentManager.stopQuery(sessionId);
    return { success: stopped };
  });

  ipcMain.handle('agent:getExternalSafetyState', async () => {
    return getExternalSafetyState();
  });

  ipcMain.handle('agent:getExternalAudit', async (_evt, limit: number = 50) => {
    return getExternalActionAudit(limit);
  });

  ipcMain.handle('agent:clearExternalAudit', async () => {
    clearExternalActionAudit();
    return { success: true };
  });

  ipcMain.handle('agent:runExternalRegression', async () => {
    return runExternalActionRegression();
  });

  // Facts
  ipcMain.handle('facts:list', async () => {
    return AgentManager.getAllFacts();
  });

  ipcMain.handle('facts:search', async (_, query: string) => {
    return AgentManager.searchFacts(query);
  });

  ipcMain.handle('facts:categories', async () => {
    return memory?.getFactCategories() || [];
  });

  ipcMain.handle('facts:delete', async (_, id: number) => {
    if (!memory) return { success: false };
    const success = memory.deleteFact(id);
    return { success };
  });

  ipcMain.handle('facts:graph-data', async () => {
    if (!memory) return { nodes: [], links: [] };
    return memory.getFactsGraphData();
  });

  // Soul (Self-Knowledge)
  ipcMain.handle('soul:list', async () => {
    if (!memory) return [];
    return memory.getAllSoulAspects();
  });

  ipcMain.handle('soul:get', async (_, aspect: string) => {
    if (!memory) return null;
    return memory.getSoulAspect(aspect);
  });

  ipcMain.handle('soul:delete', async (_, id: number) => {
    if (!memory) return { success: false };
    const success = memory.deleteSoulAspectById(id);
    return { success };
  });

  ipcMain.handle('app:openFactsGraph', async () => {
    openFactsGraphWindow();
  });

  ipcMain.handle('app:openFacts', async () => {
    openFactsWindow();
  });

  ipcMain.handle('app:openLinkedInActivity', async () => {
    openLinkedInActivityWindow();
  });

  ipcMain.handle('linkedin:listPosts', async (_, date: string, authorFilter?: string) => {
    try {
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return [];
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      // eslint-disable-next-line no-empty
      try { db.exec(`ALTER TABLE linkedin_posts ADD COLUMN hook_score INTEGER`); } catch {}
      // eslint-disable-next-line no-empty
      try { db.exec(`ALTER TABLE linkedin_posts ADD COLUMN emotion_tag TEXT`); } catch {}
      // eslint-disable-next-line no-empty
      try { db.exec(`ALTER TABLE linkedin_posts ADD COLUMN niche_target TEXT`); } catch {}
      // eslint-disable-next-line no-empty
      try { db.exec(`ALTER TABLE linkedin_posts ADD COLUMN authenticity_flag TEXT`); } catch {}
      // eslint-disable-next-line no-empty
      try { db.exec(`ALTER TABLE linkedin_posts ADD COLUMN post_bank_ids TEXT`); } catch {}
      // eslint-disable-next-line no-empty
      try { db.exec(`ALTER TABLE linkedin_posts ADD COLUMN post_bank_group TEXT`); } catch {}
      try {
        const reconciled = reconcileLinkedInPostedState(db);
        if (reconciled > 0) {
          console.log(`[LinkedIn] Reconciled ${reconciled} post(s) to published state from activity log`);
        }
      } catch (reconcileErr) {
        console.warn('[LinkedIn] Reconcile posted state failed:', reconcileErr);
      }
      try {
        const cleaned = db.prepare(
          `UPDATE linkedin_posts
             SET draft_state = 'success',
                 draft_error = NULL,
                 draft_finished_at = COALESCE(draft_finished_at, datetime('now'))
           WHERE comment_draft IS NOT NULL
             AND TRIM(comment_draft) != ''
             AND draft_state IN ('queued', 'researching', 'writing')`
        ).run();
        if (cleaned.changes > 0) {
          console.log(`[LinkedIn] Cleaned ${cleaned.changes} stale draft_state rows`);
        }
      } catch (cleanupErr) {
        console.warn('[LinkedIn] Cleanup draft_state failed:', cleanupErr);
      }
      const hasEvidenceTable = !!db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'linkedin_draft_evidence' LIMIT 1`
      ).get();
      const hasPostContentTable = !!db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'linkedin_post_content' LIMIT 1`
      ).get();
      const priorityOrder = `CASE lp.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END`;
      const evidenceSelect = hasEvidenceTable
        ? `,
           de.model AS evidence_model,
           de.comment_intent AS evidence_comment_intent,
           de.post_summary AS evidence_post_summary,
           de.key_point AS evidence_key_point,
           de.statistic AS evidence_statistic,
           de.implication AS evidence_implication,
           de.follow_up_question AS evidence_follow_up_question,
           de.stance_basis AS evidence_stance_basis,
           de.actionable_add_on AS evidence_actionable_add_on,
           de.post_intent AS evidence_post_intent,
           de.confidence AS evidence_confidence,
           de.full_post_word_count AS evidence_full_post_word_count,
           de.source_1_name AS evidence_source_1_name,
           de.source_1_url AS evidence_source_1_url,
           de.source_2_name AS evidence_source_2_name,
           de.source_2_url AS evidence_source_2_url,
           de.created_at AS evidence_created_at,
           `
        : `,
           `;
      const contentSelect = hasPostContentTable
        ? `
           pc.full_text AS full_post_text,
           pc.summary_text AS full_post_summary,
           pc.source AS full_post_source,
           pc.updated_at AS full_post_updated_at
           `
        : `
           NULL AS full_post_text,
           NULL AS full_post_summary,
           NULL AS full_post_source,
           NULL AS full_post_updated_at
           `;
      const evidenceJoin = hasEvidenceTable
        ? `
         LEFT JOIN (
           SELECT ev.post_id,
                  ev.model,
                  ev.comment_intent,
                  ev.post_summary,
                  ev.key_point,
                  ev.statistic,
                  ev.implication,
                  ev.follow_up_question,
                  ev.stance_basis,
                  ev.actionable_add_on,
                  ev.post_intent,
                  ev.confidence,
                  ev.full_post_word_count,
                  ev.source_1_name,
                  ev.source_1_url,
                  ev.source_2_name,
                  ev.source_2_url,
                  ev.created_at
           FROM linkedin_draft_evidence ev
           INNER JOIN (
             SELECT post_id, MAX(id) AS max_id
             FROM linkedin_draft_evidence
             GROUP BY post_id
           ) latest_ev ON latest_ev.max_id = ev.id
         ) de ON de.post_id = lp.id`
        : '';
      const contentJoin = hasPostContentTable
        ? `
         LEFT JOIN linkedin_post_content pc ON pc.post_id = lp.id`
        : '';
      const authorSearch = String(authorFilter || '').trim();
      const useAuthorSearch = authorSearch.length > 0;
      const authorLike = `%${authorSearch}%`;

      const activeWhere = useAuthorSearch
        ? `lp.hidden = 0 AND (lp.snoozed_until IS NULL OR lp.snoozed_until <= datetime('now')) AND LOWER(lp.author) LIKE LOWER(?)`
        : `
          lp.hidden = 0
          AND (lp.snoozed_until IS NULL OR lp.snoozed_until <= datetime('now'))
          AND (
            -- Scheduled work is shown on the day it is scheduled to run (local time).
            (lp.commented = 0 AND lp.scheduled_at IS NOT NULL AND date(lp.scheduled_at, 'localtime') = ?)
            OR
            -- Everything else stays anchored to scrape date.
            (((lp.scheduled_at IS NULL OR lp.scheduled_at = '') OR lp.commented = 1) AND lp.scraped_date = ?)
            OR
            -- Carry-over backlog: unscheduled pending items from previous days appear in today's view.
            (? = date('now', 'localtime')
             AND lp.commented = 0
             AND (lp.scheduled_at IS NULL OR lp.scheduled_at = '')
             AND lp.scraped_date < ?)
          )
        `;
      const snoozedWhere = useAuthorSearch
        ? `hidden = 0 AND snoozed_until > datetime('now') AND LOWER(author) LIKE LOWER(?)`
        : `
          hidden = 0
          AND snoozed_until > datetime('now')
          AND (
            scraped_date = ?
            OR (scheduled_at IS NOT NULL AND date(scheduled_at, 'localtime') = ?)
          )
        `;
      const activeParams = useAuthorSearch ? [authorLike] : [date, date, date, date];
      const snoozedParams = useAuthorSearch ? [authorLike] : [date, date];

      const posts = db.prepare(
        `SELECT lp.*, lp.draft_state, lp.draft_error${evidenceSelect}
           ${contentSelect},
           CASE
             WHEN lp.commented = 1 THEN 1
             WHEN EXISTS (
               SELECT 1 FROM linkedin_activity_log pl
               WHERE pl.action = 'posted' AND pl.post_url = lp.post_url
               LIMIT 1
             ) THEN 1
             ELSE 0
           END AS posted_logged,
           (COALESCE(lp.reactions, 0) - COALESCE(lp.first_seen_reactions, COALESCE(lp.reactions, 0))) AS reactions_gain_since_first,
           (COALESCE(lp.comments, 0) - COALESCE(lp.first_seen_comments, COALESCE(lp.comments, 0))) AS comments_gain_since_first,
           CAST(COALESCE((julianday('now') - julianday(COALESCE(lp.first_seen_at, lp.created_at))), 0) AS INTEGER) AS days_since_first_seen,
           CASE
             WHEN lp.commented = 0
              AND datetime(COALESCE(lp.first_seen_at, lp.created_at)) <= datetime('now', '-2 days')
              AND (
                (COALESCE(lp.reactions, 0) - COALESCE(lp.first_seen_reactions, COALESCE(lp.reactions, 0)) >= 10)
                OR (COALESCE(lp.comments, 0) - COALESCE(lp.first_seen_comments, COALESCE(lp.comments, 0)) >= 3)
                OR (
                  COALESCE(lp.first_seen_reactions, 0) > 0
                  AND (1.0 * COALESCE(lp.reactions, 0) / COALESCE(lp.first_seen_reactions, 1)) >= 1.4
                  AND (COALESCE(lp.reactions, 0) - COALESCE(lp.first_seen_reactions, 0)) >= 5
                )
                OR (
                  COALESCE(lp.first_seen_comments, 0) > 0
                  AND (1.0 * COALESCE(lp.comments, 0) / COALESCE(lp.first_seen_comments, 1)) >= 1.4
                  AND (COALESCE(lp.comments, 0) - COALESCE(lp.first_seen_comments, 0)) >= 2
                )
              )
             THEN 1 ELSE 0
           END AS recheck_candidate,
           aa.total_comments_by_me AS author_total_comments,
           aa.last_commented_date AS author_last_commented,
           al.last_activity_action,
           al.last_activity_reason,
           al.last_activity_at,
           (SELECT COUNT(*) FROM linkedin_activity_log af
            WHERE af.post_id = lp.id AND af.action IN ('failed', 'failed_quality', 'failed_timeout', 'failed_provider', 'error', 'verify_needed')) AS failed_attempts,
           ec.reactions_delta, ec.comments_delta,
           (SELECT COUNT(*) FROM linkedin_activity_log alw
            WHERE alw.action = 'posted' AND alw.post_url IN (SELECT p2.post_url FROM linkedin_posts p2 WHERE p2.author = lp.author)
            AND alw.created_at >= datetime('now', '-7 days')) AS author_weekly_comments
         FROM linkedin_posts lp
         LEFT JOIN linkedin_authors aa ON aa.name = lp.author
         LEFT JOIN (
           SELECT act.post_id,
                  act.action AS last_activity_action,
                  act.reason AS last_activity_reason,
                  act.created_at AS last_activity_at
           FROM linkedin_activity_log act
           INNER JOIN (
             SELECT post_id, MAX(id) AS max_id
             FROM linkedin_activity_log
             GROUP BY post_id
           ) latest ON latest.max_id = act.id
         ) al ON al.post_id = lp.id
         LEFT JOIN (
           SELECT post_id, reactions_delta, comments_delta
           FROM linkedin_engagement_checks WHERE baseline = 0
           GROUP BY post_id HAVING id = MAX(id)
         ) ec ON ec.post_id = lp.id
         ${evidenceJoin}
         ${contentJoin}
         WHERE ${activeWhere}
         ORDER BY ${priorityOrder}, (lp.reactions + lp.comments) DESC`
      ).all(...activeParams);
      const snoozed = db.prepare(
        `SELECT * FROM linkedin_posts WHERE ${snoozedWhere} ORDER BY snoozed_until ASC`
      ).all(...snoozedParams);
      db.close();
      return { posts, snoozed };
    } catch (err) {
      console.error('[LinkedIn] Failed to list posts:', err);
      return { posts: [], snoozed: [], error: String(err) };
    }
  });

  ipcMain.handle('linkedin:getPostingDays', async (_, month?: string) => {
    try {
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return [];

      const monthKey = String(month || '').trim().match(/^\d{4}-\d{2}$/)
        ? String(month).trim()
        : new Date().toISOString().slice(0, 7);

      const db = new Database(dbPath, { readonly: true });
      db.pragma('journal_mode = WAL');
      const rows = db.prepare(
        `SELECT date(created_at, 'localtime') AS date, COUNT(*) AS count
         FROM linkedin_activity_log
         WHERE action = 'posted'
           AND strftime('%Y-%m', datetime(created_at, 'localtime')) = ?
         GROUP BY date
         ORDER BY date ASC`
      ).all(monthKey) as Array<{ date: string; count: number }>;
      db.close();
      return rows;
    } catch (err) {
      console.error('[LinkedIn] Failed to load posting days:', err);
      return [];
    }
  });

  ipcMain.handle('linkedin:getPostContent', async (_, postId: number, forceRefresh?: boolean) => {
    try {
      const normalizedPostId = Number(postId);
      if (!Number.isFinite(normalizedPostId) || normalizedPostId <= 0) {
        return { success: false, error: 'Invalid post id' };
      }
      const dbPath = getLinkedInDbPath();
      if (!dbPath) return { success: false, error: 'LinkedIn database not found' };

      const Database = (await import('better-sqlite3')).default;
      const ensureSql = `
        CREATE TABLE IF NOT EXISTS linkedin_post_content (
          post_id INTEGER PRIMARY KEY REFERENCES linkedin_posts(id) ON DELETE CASCADE,
          post_url TEXT NOT NULL,
          full_text TEXT NOT NULL,
          summary_text TEXT,
          source TEXT DEFAULT 'linkedin_read_post',
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_linkedin_post_content_url ON linkedin_post_content(post_url);
      `;

      let db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.exec(ensureSql);
      const post = db.prepare(
        'SELECT id, post_url, author, text_preview FROM linkedin_posts WHERE id = ?'
      ).get(normalizedPostId) as { id: number; post_url: string; author: string; text_preview: string } | undefined;
      const cached = db.prepare(
        'SELECT full_text, summary_text, updated_at FROM linkedin_post_content WHERE post_id = ?'
      ).get(normalizedPostId) as { full_text?: string; summary_text?: string; updated_at?: string } | undefined;
      db.close();

      if (!post) return { success: false, error: 'Post not found' };

      const cachedText = normalizeLinkedInText(String(cached?.full_text || ''));
      const hasCached = cachedText.length > 0;
      if (hasCached && !forceRefresh) {
        const summary = normalizeLinkedInText(String(cached?.summary_text || ''))
          || buildTwoSentenceSummary(cachedText);
        return {
          success: true,
          postId: normalizedPostId,
          postUrl: post.post_url,
          author: post.author,
          fullText: cachedText,
          summary,
          cached: true,
          fetchedAt: cached?.updated_at || null,
        };
      }

      let fullText = '';
      try {
        const stdout = await linkedinExec('reply', ['--url', post.post_url, '--read-only'], 90000);
        const parsed = JSON.parse(stdout) as { text?: string };
        fullText = normalizeLinkedInText(String(parsed?.text || ''));
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (hasCached) {
          return {
            success: true,
            postId: normalizedPostId,
            postUrl: post.post_url,
            author: post.author,
            fullText: cachedText,
            summary: normalizeLinkedInText(String(cached?.summary_text || '')) || buildTwoSentenceSummary(cachedText),
            cached: true,
            fetchedAt: cached?.updated_at || null,
            warning: `Live fetch failed, using cached copy: ${msg}`,
          };
        }
        return { success: false, error: `Failed to fetch full post: ${msg}` };
      }

      if (!fullText) {
        fullText = normalizeLinkedInText(post.text_preview || '');
      }
      let summary = buildTwoSentenceSummary(fullText);
      let summarySource = 'linkedin_read_post';
      try {
        const { glmFlash, isGlmConfigured } = await import('../tools/glm-client');
        if (isGlmConfigured()) {
          const aiSummaryRes = await glmFlash({
            maxTokens: 120,
            temperature: 0.2,
            disableThinking: true,
            messages: [
              {
                role: 'system',
                content: 'Summarize LinkedIn post text into exactly 1-2 short sentences. Keep the main claim and practical meaning. No hashtags, no emojis, no fluff.',
              },
              {
                role: 'user',
                content: fullText.slice(0, 2400),
              },
            ],
          });
          if (aiSummaryRes.success && aiSummaryRes.content) {
            const aiSummary = normalizeLinkedInText(String(aiSummaryRes.content || ''));
            if (aiSummary) {
              summary = buildTwoSentenceSummary(aiSummary);
              summarySource = 'linkedin_read_post_ai';
            }
          }
        }
      } catch (summaryErr) {
        console.warn('[LinkedIn] AI summary fallback to heuristic:', summaryErr);
      }

      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.exec(ensureSql);
      db.prepare(
        `INSERT INTO linkedin_post_content (post_id, post_url, full_text, summary_text, source, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(post_id) DO UPDATE SET
           post_url = excluded.post_url,
           full_text = excluded.full_text,
           summary_text = excluded.summary_text,
           source = excluded.source,
           updated_at = datetime('now')`
      ).run(normalizedPostId, post.post_url, fullText, summary, summarySource);
      const updated = db.prepare(
        'SELECT updated_at FROM linkedin_post_content WHERE post_id = ?'
      ).get(normalizedPostId) as { updated_at?: string } | undefined;
      db.close();

      return {
        success: true,
        postId: normalizedPostId,
        postUrl: post.post_url,
        author: post.author,
        fullText,
        summary,
        cached: false,
        fetchedAt: updated?.updated_at || null,
      };
    } catch (err) {
      console.error('[LinkedIn] Failed to fetch post content:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:rejectDraft', async (_, postId: number) => {
    try {
      markLinkedInControlSource('desktop');
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      // Get kanban_task_id before clearing
      const row = db.prepare('SELECT kanban_task_id FROM linkedin_posts WHERE id = ?').get(postId) as { kanban_task_id?: number } | undefined;
      db.prepare('UPDATE linkedin_posts SET comment_draft = NULL, kanban_task_id = NULL WHERE id = ?').run(postId);
      db.close();
      // Cancel kanban task if exists
      if (row?.kanban_task_id) {
        try {
          const { KanbanService } = await import('../kanban');
          KanbanService.updateTask(row.kanban_task_id, { status: 'done' });
        } catch { /* kanban task may not exist */ }
      }
      return { success: true };
    } catch (err) {
      console.error('[LinkedIn] Failed to reject draft:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:updateDraft', async (_, postId: number, newText: string) => {
    try {
      markLinkedInControlSource('desktop');
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      const row = db.prepare('SELECT kanban_task_id FROM linkedin_posts WHERE id = ?').get(postId) as { kanban_task_id?: number } | undefined;
      db.prepare('UPDATE linkedin_posts SET comment_draft = ? WHERE id = ?').run(newText, postId);
      db.close();
      // Update kanban task description if exists
      if (row?.kanban_task_id) {
        try {
          const { KanbanService } = await import('../kanban');
          const task = KanbanService.getTask(row.kanban_task_id);
          if (task) {
            // Preserve the post URL from description
            const urlMatch = (task.description || '').match(/---\nPost URL: .+/);
            const urlSuffix = urlMatch ? `\n\n${urlMatch[0]}` : '';
            KanbanService.updateTask(row.kanban_task_id, { description: newText + urlSuffix });
          }
        } catch { /* kanban task may not exist */ }
      }
      return { success: true };
    } catch (err) {
      console.error('[LinkedIn] Failed to update draft:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:updatePostMeta', async (_, postId: number, updates: Record<string, unknown>) => {
    try {
      markLinkedInControlSource('desktop');
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');

      const fields: string[] = [];
      const values: Array<string | number | null> = [];
      const hookRaw = updates?.hook_score;
      if (hookRaw !== undefined) {
        const hookNum = Number(hookRaw);
        const hookScore = Number.isFinite(hookNum) ? Math.max(0, Math.min(10, Math.round(hookNum))) : null;
        fields.push('hook_score = ?');
        values.push(hookScore);
      }
      if (updates?.emotion_tag !== undefined) {
        const emotion = String(updates.emotion_tag || '').trim();
        fields.push('emotion_tag = ?');
        values.push(emotion ? emotion : null);
      }
      if (updates?.niche_target !== undefined) {
        const niche = String(updates.niche_target || '').trim();
        fields.push('niche_target = ?');
        values.push(niche ? niche : null);
      }
      if (updates?.authenticity_flag !== undefined) {
        const raw = String(updates.authenticity_flag || '').trim().toLowerCase();
        const allowed = new Set(['human', 'assist', 'ai']);
        const auth = allowed.has(raw) ? raw : '';
        fields.push('authenticity_flag = ?');
        values.push(auth ? auth : null);
      }
      if (updates?.post_bank_ids !== undefined) {
        let bankValue: string | null = null;
        if (Array.isArray(updates.post_bank_ids)) {
          bankValue = JSON.stringify(updates.post_bank_ids.map(v => String(v)).filter(Boolean));
        } else {
          const raw = String(updates.post_bank_ids || '').trim();
          bankValue = raw ? raw : null;
        }
        fields.push('post_bank_ids = ?');
        values.push(bankValue);
      }
      if (updates?.post_bank_group !== undefined) {
        const group = String(updates.post_bank_group || '').trim();
        fields.push('post_bank_group = ?');
        values.push(group ? group : null);
      }
      if (!fields.length) {
        db.close();
        return { success: false, error: 'No fields to update' };
      }

      values.push(Number(postId));
      db.prepare(`UPDATE linkedin_posts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      db.close();
      return { success: true };
    } catch (err) {
      console.error('[LinkedIn] Failed to update post meta:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:rewriteDraft', async (_, postId: number, currentText: string, instructions: string) => {
    try {
      markLinkedInControlSource('desktop');
      const normalizedPostId = Number(postId);
      const normalizedInstructions = String(instructions || '').trim();
      const providedText = String(currentText || '').trim();
      if (!Number.isFinite(normalizedPostId) || normalizedPostId <= 0) {
        return { success: false, error: 'Invalid post id' };
      }
      if (!normalizedInstructions) {
        return { success: false, error: 'Instructions are required' };
      }

      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };

      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      const row = db.prepare(
        'SELECT author, text_preview, post_url, comment_draft, post_bank_ids, post_bank_group FROM linkedin_posts WHERE id = ?'
      ).get(normalizedPostId) as { author?: string; text_preview?: string; post_url?: string; comment_draft?: string | null; post_bank_ids?: string | null; post_bank_group?: string | null } | undefined;
      db.close();
      if (!row) return { success: false, error: 'Post not found' };

      const baseDraft = providedText || String(row.comment_draft || '').trim();
      if (!baseDraft) return { success: false, error: 'No draft text available to rewrite' };

      const { rewriteLinkedInDraftWithInstructions } = await import('../tools/linkedin-drafter');
      const rewritten = await rewriteLinkedInDraftWithInstructions({
        draftText: baseDraft,
        instructions: normalizedInstructions,
        author: String(row.author || ''),
        postPreview: String(row.text_preview || ''),
        postUrl: String(row.post_url || ''),
        postBankIds: String(row.post_bank_ids || ''),
        postBankGroup: String(row.post_bank_group || ''),
      });

      return {
        success: true,
        rewritten: rewritten.rewritten,
        model: rewritten.model,
      };
    } catch (err) {
      console.error('[LinkedIn] Failed to rewrite draft:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:approveDraft', async (_, postId: number) => {
    try {
      markLinkedInControlSource('desktop');
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      const row = db.prepare('SELECT post_url, comment_draft, kanban_task_id FROM linkedin_posts WHERE id = ?').get(postId) as { post_url: string; comment_draft: string | null; kanban_task_id?: number } | undefined;
      if (!row || !row.comment_draft) { db.close(); return { success: false, error: 'No draft to approve' }; }
      const alreadyPosted = hasPostedLinkedInUrl(db, row.post_url);
      if (alreadyPosted.matched) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, approved = 0, scheduled_at = NULL WHERE id = ?').run(postId);
        db.close();
        return {
          success: false,
          duplicate_post_url: true,
          error: `Duplicate blocked: this URL already has a posted comment (${alreadyPosted.createdAt || 'previously'}).`,
        };
      }
      // Mark as approved in DB (not yet commented - that happens when actually posted)
      db.prepare('UPDATE linkedin_posts SET approved = 1 WHERE id = ?').run(postId);
      db.close();
      // Approve kanban task if exists
      if (row.kanban_task_id) {
        try {
          const { KanbanService } = await import('../kanban');
          KanbanService.updateTask(row.kanban_task_id, { status: 'todo' });
          KanbanService.addComment(row.kanban_task_id, 'Approved for posting. Waiting for scheduled/auto publish.');
        } catch { /* kanban task may not exist */ }
      }
      return { success: true, postUrl: row.post_url, draft: row.comment_draft };
    } catch (err) {
      console.error('[LinkedIn] Failed to approve draft:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:hidePost', async (_, postId: number) => {
    try {
      markLinkedInControlSource('desktop');
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.prepare('UPDATE linkedin_posts SET hidden = 1 WHERE id = ?').run(postId);
      db.close();
      return { success: true };
    } catch (err) {
      console.error('[LinkedIn] Failed to hide post:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:snoozePost', async (_, postId: number, days: number) => {
    try {
      markLinkedInControlSource('desktop');
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      // Snapshot engagement and set snooze
      const post = db.prepare('SELECT reactions, comments, author, post_url FROM linkedin_posts WHERE id = ?').get(postId) as { reactions: number; comments: number; author: string; post_url: string } | undefined;
      if (!post) { db.close(); return { success: false, error: 'Post not found' }; }
      db.prepare(
        `UPDATE linkedin_posts SET snoozed_until = datetime('now', '+' || ? || ' days'), reactions_at_snooze = ?, comments_at_snooze = ? WHERE id = ?`
      ).run(days, post.reactions, post.comments, postId);
      // Create one-time cron job to re-check
      const snoozedUntil = db.prepare(`SELECT datetime('now', '+' || ? || ' days') as t`).get(days) as { t: string };
      const jobName = `linkedin-snooze-${postId}-${Date.now()}`;
      db.prepare(
        `INSERT INTO cron_jobs (name, schedule_type, run_at, next_run_at, prompt, channel, enabled, delete_after_run, session_id, status) VALUES (?, 'at', ?, ?, ?, 'desktop', 1, 1, 'default', 'pending')`
      ).run(
        jobName,
        snoozedUntil.t,
        snoozedUntil.t,
        `Check snoozed LinkedIn post #${postId} by ${post.author} (${post.post_url}). Original engagement: ${post.reactions} reactions, ${post.comments} comments. Use linkedin_read_post to get current engagement. If reactions or comments grew by 20%+, draft a comment. Otherwise dismiss it by clearing the snooze.`
      );
      db.close();
      return { success: true };
    } catch (err) {
      console.error('[LinkedIn] Failed to snooze post:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:setPriority', async (_, postId: number, priority: string) => {
    try {
      markLinkedInControlSource('desktop');
      const validPriorities = ['low', 'normal', 'high', 'urgent'];
      if (!validPriorities.includes(priority)) return { success: false, error: 'Invalid priority' };
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.prepare('UPDATE linkedin_posts SET priority = ? WHERE id = ?').run(priority, postId);
      db.close();
      return { success: true };
    } catch (err) {
      console.error('[LinkedIn] Failed to set priority:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:schedulePost', async (_, postId: number, datetime: string) => {
    try {
      markLinkedInControlSource('desktop');
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      const post = db.prepare('SELECT post_url, comment_draft FROM linkedin_posts WHERE id = ?').get(postId) as { post_url: string; comment_draft: string | null } | undefined;
      if (!post) { db.close(); return { success: false, error: 'Post not found' }; }
      if (!post.comment_draft) { db.close(); return { success: false, error: 'No draft to schedule' }; }
      const alreadyPosted = hasPostedLinkedInUrl(db, post.post_url);
      if (alreadyPosted.matched) {
        db.prepare('UPDATE linkedin_posts SET commented = 1, approved = 0, scheduled_at = NULL WHERE id = ?').run(postId);
        db.close();
        return {
          success: false,
          duplicate_post_url: true,
          error: `Duplicate blocked: this URL already has a posted comment (${alreadyPosted.createdAt || 'previously'}).`,
        };
      }
      db.prepare('UPDATE linkedin_posts SET scheduled_at = ? WHERE id = ?').run(datetime, postId);
      // No cron job needed — the autoposter daemon picks up posts where scheduled_at <= now
      db.close();
      let scheduledAt = datetime;
      let adjustedOthers = 0;
      let warning: string | undefined;
      try {
        const { rebalancePendingSchedules } = await import('../tools/linkedin-autoposter');
        const rebalance = rebalancePendingSchedules({ priorityPostId: postId, preferredAt: datetime });
        if (rebalance.priorityScheduledAt) scheduledAt = rebalance.priorityScheduledAt;
        adjustedOthers = rebalance.adjustedOthers || 0;
        warning = rebalance.warning;
      } catch (rebalanceErr) {
        console.warn('[LinkedIn] schedule rebalance failed:', rebalanceErr);
        warning = 'Scheduled, but could not rebalance nearby posts.';
      }
      return { success: true, scheduledAt, adjustedOthers, warning };
    } catch (err) {
      console.error('[LinkedIn] Failed to schedule post:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:draftBatch', async (_, postIds: number[], batchSize?: number, forceRedo?: boolean) => {
    const safeSendProgress = (payload: unknown): void => {
      try {
        if (!linkedInActivityWindow || linkedInActivityWindow.isDestroyed()) return;
        linkedInActivityWindow.webContents.send('linkedin:draftProgress', payload);
      } catch (sendErr) {
        console.warn('[LinkedIn] Failed to send draft progress event:', sendErr);
      }
    };

    try {
      markLinkedInControlSource('desktop');
      const cleanIds = Array.isArray(postIds)
        ? postIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0)
        : [];
      if (cleanIds.length === 0) {
        return { success: false, error: 'No valid post IDs selected', errors: ['No valid post IDs selected'] };
      }

      const { draftBatch, draftEvents } = await import('../tools/linkedin-drafter');
      const progressHandler = (data: unknown) => safeSendProgress(data);
      const typedProgressHandler = (data: unknown) =>
        safeSendProgress({ type: 'progress', ...(data as Record<string, unknown>) });

      draftEvents.on('drafted', progressHandler);
      draftEvents.on('error', progressHandler);
      draftEvents.on('researching', progressHandler);
      draftEvents.on('complete', progressHandler);
      draftEvents.on('progress', typedProgressHandler);

      try {
        const result = await draftBatch(cleanIds, batchSize || 2, !!forceRedo);
        const drafted = result.results.length;
        const errors = result.errors;
        const queued = drafted === 0 && errors.length === 0 ? cleanIds.length : 0;

        if (drafted === 0 && errors.length > 0) {
          return {
            success: false,
            error: errors[0],
            drafted,
            errors,
          };
        }

        return { success: true, drafted, queued, errors };
      } finally {
        draftEvents.removeListener('drafted', progressHandler);
        draftEvents.removeListener('error', progressHandler);
        draftEvents.removeListener('researching', progressHandler);
        draftEvents.removeListener('complete', progressHandler);
        draftEvents.removeListener('progress', typedProgressHandler);
      }
    } catch (err) {
      console.error('[LinkedIn] Batch draft failed:', err);
      return { success: false, error: String(err), errors: [String(err)] };
    }
  });

  ipcMain.handle('linkedin:redraftBatch', async (_, postIds: number[], batchSize?: number) => {
    const safeSendProgress = (payload: unknown): void => {
      try {
        if (!linkedInActivityWindow || linkedInActivityWindow.isDestroyed()) return;
        linkedInActivityWindow.webContents.send('linkedin:draftProgress', payload);
      } catch (sendErr) {
        console.warn('[LinkedIn] Failed to send redraft progress event:', sendErr);
      }
    };

    try {
      markLinkedInControlSource('desktop');
      const cleanIds = Array.isArray(postIds)
        ? postIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0)
        : [];
      if (cleanIds.length === 0) {
        return { success: false, error: 'No valid post IDs selected', errors: ['No valid post IDs selected'] };
      }

      const { redraftBatch, draftEvents } = await import('../tools/linkedin-drafter');
      const progressHandler = (data: unknown) => safeSendProgress(data);
      const typedProgressHandler = (data: unknown) =>
        safeSendProgress({ type: 'progress', ...(data as Record<string, unknown>) });

      draftEvents.on('drafted', progressHandler);
      draftEvents.on('error', progressHandler);
      draftEvents.on('researching', progressHandler);
      draftEvents.on('complete', progressHandler);
      draftEvents.on('progress', typedProgressHandler);

      try {
        const result = await redraftBatch(cleanIds, batchSize || 1);
        const drafted = result.results.length;
        const errors = result.errors;

        if (drafted === 0 && errors.length > 0) {
          return {
            success: false,
            error: errors[0],
            drafted,
            errors,
          };
        }

        return {
          success: true,
          drafted,
          errors,
        };
      } finally {
        draftEvents.off('drafted', progressHandler);
        draftEvents.off('error', progressHandler);
        draftEvents.off('researching', progressHandler);
        draftEvents.off('complete', progressHandler);
        draftEvents.off('progress', typedProgressHandler);
      }
    } catch (err) {
      console.error('[LinkedIn] Failed to redraft batch:', err);
      return { success: false, error: String(err) };
    }
  });

  // Telegram notification when batch drafting completes
  import('../tools/linkedin-drafter').then(({ draftEvents }) => {
    draftEvents.on('complete', (data: { total?: number; drafted?: number }) => {
      if (data && typeof data.drafted === 'number' && data.drafted > 0) {
        notifyTelegram(`LinkedIn: ${data.drafted} drafts ready for review`).catch(() => {});
      }
    });
  }).catch(() => {});

  ipcMain.handle('linkedin:cancelDraftJob', async () => {
    try {
      markLinkedInControlSource('desktop');
      const { cancelDraftJob } = await import('../tools/linkedin-drafter');
      cancelDraftJob();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('linkedin:getDailyStats', async () => {
    try {
      const { getDailyStats } = await import('../tools/linkedin-autoposter');
      return getDailyStats();
    } catch (err) {
      console.error('[LinkedIn] getDailyStats error:', err);
      return { postedToday: 0, dailyLimit: 0, pendingApproved: 0 };
    }
  });

  ipcMain.handle('linkedin:getWeeklyReview', async (_event, days?: number) => {
    try {
      const Database = (await import('better-sqlite3')).default;
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const possiblePaths = [
        path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
        path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
        path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
      ];
      let dbPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) return { success: false, error: 'Database not found' };

      const rawDays = Number(days || 0);
      const safeDays = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(30, Math.floor(rawDays)) : 7;
      const offsetDays = Math.max(0, safeDays - 1);

      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      const rows = db.prepare(
        `SELECT id, post_url, author, text_preview, reactions, comments, comment_draft,
                hook_score, emotion_tag, niche_target, authenticity_flag,
                scraped_date, approved, commented, scheduled_at
         FROM linkedin_posts
         WHERE hidden = 0
           AND scraped_date >= date('now', 'localtime', ?)
           AND scraped_date <= date('now', 'localtime')`
      ).all(`-${offsetDays} days`) as Array<Record<string, unknown>>;
      db.close();

      const posts = rows.map((row) => ({
        id: Number(row.id),
        post_url: String(row.post_url || ''),
        author: String(row.author || ''),
        text_preview: String(row.text_preview || ''),
        reactions: Number(row.reactions || 0),
        comments: Number(row.comments || 0),
        comment_draft: String(row.comment_draft || ''),
        hook_score: row.hook_score === null || row.hook_score === undefined ? null : Number(row.hook_score),
        emotion_tag: String(row.emotion_tag || ''),
        niche_target: String(row.niche_target || ''),
        authenticity_flag: String(row.authenticity_flag || ''),
        scraped_date: String(row.scraped_date || ''),
        approved: Number(row.approved || 0),
        commented: Number(row.commented || 0),
        scheduled_at: String(row.scheduled_at || ''),
      }));

      const engagementOf = (p: typeof posts[number]) => (p.reactions || 0) + (p.comments || 0);
      const total = posts.length;
      const drafted = posts.filter(p => p.comment_draft && p.comment_draft.trim()).length;
      const approved = posts.filter(p => p.approved).length;
      const scheduled = posts.filter(p => p.scheduled_at).length;
      const published = posts.filter(p => p.commented).length;
      const avgEngagement = total ? (posts.reduce((acc, p) => acc + engagementOf(p), 0) / total) : 0;

      const top = [...posts].sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, 5);
      const bottom = [...posts].sort((a, b) => engagementOf(a) - engagementOf(b)).slice(0, 5);

      const byEmotion = new Map<string, { count: number; total: number }>();
      const byAuth = new Map<string, { count: number; total: number }>();
      const byHook = new Map<string, { count: number; total: number }>();
      for (const p of posts) {
        const engagement = engagementOf(p);
        const emotion = p.emotion_tag.trim().toLowerCase();
        if (emotion) {
          const slot = byEmotion.get(emotion) || { count: 0, total: 0 };
          slot.count += 1;
          slot.total += engagement;
          byEmotion.set(emotion, slot);
        }
        const auth = p.authenticity_flag.trim().toLowerCase();
        if (auth) {
          const slot = byAuth.get(auth) || { count: 0, total: 0 };
          slot.count += 1;
          slot.total += engagement;
          byAuth.set(auth, slot);
        }
        const hook = Number(p.hook_score || 0);
        if (Number.isFinite(hook) && hook > 0) {
          const bucket = hook <= 4 ? '1-4' : hook <= 7 ? '5-7' : '8-10';
          const slot = byHook.get(bucket) || { count: 0, total: 0 };
          slot.count += 1;
          slot.total += engagement;
          byHook.set(bucket, slot);
        }
      }

      const toBreakdown = (map: Map<string, { count: number; total: number }>) =>
        Array.from(map.entries())
          .map(([key, val]) => ({ key, count: val.count, avg: val.count ? val.total / val.count : 0 }))
          .sort((a, b) => b.avg - a.avg);

      return {
        success: true,
        days: safeDays,
        stats: {
          total,
          drafted,
          approved,
          scheduled,
          published,
          avgEngagement,
        },
        top,
        bottom,
        byEmotion: toBreakdown(byEmotion),
        byHook: toBreakdown(byHook),
        byAuth: toBreakdown(byAuth),
      };
    } catch (err) {
      console.error('[LinkedIn] getWeeklyReview error:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('app:openDailyLogs', async () => {
    openDailyLogsWindow();
  });

  ipcMain.handle('dailyLogs:list', async (_event, days?: number) => {
    const raw = typeof days === 'number' ? days : Number(days || 0);
    const safeDays = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
    return AgentManager.getDailyLogsSince(Math.max(3, safeDays));
  });

  ipcMain.handle('app:openSoul', async () => {
    openSoulWindow();
  });

  ipcMain.handle('app:openCustomize', async () => {
    openCustomizeWindow();
  });

  ipcMain.handle('app:openRoutines', async () => {
    openCronWindow();
  });

  ipcMain.handle('app:openExternal', async (_, url: string) => {
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) {
      console.warn('[IPC] Blocked openExternal with disallowed scheme:', url);
      return;
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('app:openPath', async (_, filePath: string) => {
    // Security: only allow opening paths within the Pocket-agent documents directory
    const allowedDir = path.join(app.getPath('documents'), 'Pocket-agent');
    const resolvedPath = path.resolve(filePath);
    const rel = path.relative(path.resolve(allowedDir), resolvedPath);
    const isAllowed = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!isAllowed) {
      console.warn('[Main] Blocked openPath outside allowed directory:', filePath);
      return;
    }
    await shell.openPath(resolvedPath);
  });

  ipcMain.handle('app:showInFolder', async (_, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // Open an image in the default viewer — handles both local paths and URLs
  ipcMain.handle('app:openImage', async (_, src: string) => {
    try {
      const mediaDir = path.join(app.getPath('documents'), 'Pocket-agent', 'media');
      if (src.startsWith('http://') || src.startsWith('https://')) {
        // Remote URL — download to media dir first
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());

        const contentType = res.headers.get('content-type') || '';
        const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
          : contentType.includes('gif') ? '.gif'
          : contentType.includes('webp') ? '.webp'
          : '.png';

        const filePath = path.join(mediaDir, `img-${Date.now()}${ext}`);
        fs.writeFileSync(filePath, buf);
        await shell.openPath(filePath);
      } else {
        // Local file path — only allow opening files from known app directories
        if (src.startsWith('data:')) {
          console.warn('[Main] Blocked openImage for data URL');
          return;
        }
        const localPath = src.startsWith('file://') ? fileURLToPath(src) : src;
        const resolvedPath = path.resolve(localPath);
        const allowedDirs = [
          path.join(app.getPath('documents'), 'Pocket-agent'),
          path.join(app.getPath('userData'), 'attachments'),
        ].map(dir => path.resolve(dir));
        const isAllowed = allowedDirs.some(dir => {
          const rel = path.relative(dir, resolvedPath);
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
        if (!isAllowed) {
          console.warn('[Main] Blocked openImage outside allowed directories:', src);
          return;
        }
        await shell.openPath(resolvedPath);
      }
    } catch (err) {
      console.error('[Main] Failed to open image:', err);
    }
  });

  // Customize - Identity
  ipcMain.handle('customize:getIdentity', async () => {
    return loadIdentity();
  });

  ipcMain.handle('customize:saveIdentity', async (_, content: string) => {
    const success = saveIdentity(content);
    return { success };
  });

  ipcMain.handle('customize:getIdentityPath', async () => {
    return getIdentityPath();
  });

  // Customize - Instructions
  ipcMain.handle('customize:getInstructions', async () => {
    return loadInstructions();
  });

  ipcMain.handle('customize:saveInstructions', async (_, content: string) => {
    const success = saveInstructions(content);
    return { success };
  });

  ipcMain.handle('customize:getInstructionsPath', async () => {
    return getInstructionsPath();
  });

  // Location and timezone lookup
  ipcMain.handle('location:lookup', async (_, query: string) => {
    if (!query || query.length < 2) return [];

    const results = cityTimezones.lookupViaCity(query);
    // Return top 10 results with city, country, and timezone
    return results.slice(0, 10).map((r: { city: string; country: string; timezone: string; province?: string }) => ({
      city: r.city,
      country: r.country,
      province: r.province || '',
      timezone: r.timezone,
      display: r.province ? `${r.city}, ${r.province}, ${r.country}` : `${r.city}, ${r.country}`,
    }));
  });

  ipcMain.handle('timezone:list', async () => {
    // Get all IANA timezones
    try {
      const timezones = Intl.supportedValuesOf('timeZone');
      return timezones;
    } catch {
      // Fallback for older environments
      return [
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
        'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Madrid',
        'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Moscow',
        'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Seoul',
        'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Jerusalem',
        'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth',
        'Pacific/Auckland', 'Pacific/Honolulu', 'Pacific/Fiji',
        'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos',
      ];
    }
  });

  // Cron jobs
  ipcMain.handle('cron:list', async () => {
    return scheduler?.getAllJobs() || [];
  });

  ipcMain.handle('cron:create', async (_, name: string, schedule: string, prompt: string, channel: string, sessionId: string) => {
    const success = await scheduler?.createJob(name, schedule, prompt, channel, sessionId || 'default');
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:update', async (_, name: string, prompt: string, sessionId?: string) => {
    const success = scheduler?.updateJob(name, prompt, sessionId);
    return { success };
  });

  ipcMain.handle('cron:delete', async (_, name: string) => {
    const success = scheduler?.deleteJob(name);
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:toggle', async (_, name: string, enabled: boolean) => {
    const success = scheduler?.setJobEnabled(name, enabled);
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:run', async (_, name: string) => {
    const result = await scheduler?.runJobNow(name);
    return result;
  });

  ipcMain.handle('cron:history', async (_, limit: number = 20) => {
    return scheduler?.getHistory(limit) || [];
  });

  // App info
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getCacheStats', async () => {
    try {
      return { success: true, ...collectCacheStats() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('app:clearSafeCache', async () => {
    try {
      const before = collectCacheStats();
      const userDataPath = app.getPath('userData');
      const safeDirs = getSafeCacheDirs(userDataPath);
      for (const dir of safeDirs) clearDirectoryContents(dir);

      const sessions = new Set(
        BrowserWindow.getAllWindows()
          .map(win => win.webContents?.session)
          .filter(Boolean)
      );
      for (const ses of sessions) {
        try {
          await ses.clearCache();
        } catch {
          // best effort
        }
      }

      const after = collectCacheStats();
      const clearedBytes = Math.max(0, before.safeCacheBytes - after.safeCacheBytes);
      return { success: true, before, after, clearedBytes };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Settings
  ipcMain.handle('settings:getAll', async () => {
    return SettingsManager.getAllSafe();
  });

  ipcMain.handle('settings:get', async (_, key: string) => {
    const def = SETTINGS_SCHEMA.find(s => s.key === key);
    if (def?.encrypted) {
      const value = SettingsManager.get(key);
      return value ? '••••••••' : '';
    }
    return SettingsManager.get(key);
  });

  ipcMain.handle('settings:set', async (_, key: string, value: string) => {
    try {
      SettingsManager.set(key, value);

      if (key === 'agent.mode') {
        const raw = (value || '').trim().toLowerCase();
        const normalized = raw === 'general' ? 'manager' : raw;
        const mode = normalized === 'manager' ? 'manager' : 'coder';
        AgentManager.setMode(mode);
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send('agent:modeChanged', mode);
        }
      }

      if (key === 'agent.model') {
        AgentManager.setModel(value);
      }

      // Auto-setup birthday cron jobs when birthday is set
      if (key === 'profile.birthday') {
        await setupBirthdayCronJobs(value);
      }

      // Email processor lifecycle: start/stop/restart on settings change
      if (key === 'gmail.emailProcessing.enabled') {
        if (value === 'true') {
          await ensureEmailProcessor();
          emailProcessor!.start();
          console.log('[Main] Email processor started via settings');
        } else {
          if (emailProcessor) {
            emailProcessor.stop();
            console.log('[Main] Email processor stopped via settings');
          }
        }
      } else if (key === 'gmail.emailProcessing.intervalMin') {
        if (emailProcessor && SettingsManager.getBoolean('gmail.emailProcessing.enabled')) {
          emailProcessor.restart();
          console.log('[Main] Email processor restarted with new interval');
        }
      }

      // Instant Telegram toggle — no restart required
      if (key === 'telegram.enabled') {
        const enabled = value === 'true' || value === '1';
        if (enabled) {
          const token = SettingsManager.get('telegram.botToken');
          if (!telegramBot && token) {
            telegramBot = createTelegramBot();
            if (telegramBot) {
              telegramBot.setOnMessageCallback((data) => {
                if (chatWindow && !chatWindow.isDestroyed()) {
                  chatWindow.webContents.send('telegram:message', {
                    userMessage: data.userMessage,
                    response: data.response,
                    chatId: data.chatId,
                    sessionId: data.sessionId,
                    hasAttachment: data.hasAttachment,
                    attachmentType: data.attachmentType,
                    wasCompacted: data.wasCompacted,
                    media: data.media,
                  });
                }
              });
              telegramBot.setOnSessionLinkCallback(() => {
                if (chatWindow && !chatWindow.isDestroyed()) {
                  chatWindow.webContents.send('sessions:changed');
                }
              });
              await telegramBot.start();
              if (scheduler) scheduler.setTelegramBot(telegramBot);
              setResearchTelegramBot(telegramBot);
              setLinkedInTelegramBot(telegramBot);
              console.log('[Main] Telegram started (live toggle)');
            }
          }
        } else {
          if (telegramBot) {
            await telegramBot.stop();
            telegramBot = null;
            if (scheduler) scheduler.setTelegramBot(null);
            setResearchTelegramBot(null as unknown as TelegramBot);
            setLinkedInTelegramBot(null);
            console.log('[Main] Telegram stopped (live toggle)');
          }
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('settings:delete', async (_, key: string) => {
    const success = SettingsManager.delete(key);
    return { success };
  });

  ipcMain.handle('settings:schema', async (_, category?: string) => {
    return SettingsManager.getSchema(category);
  });

  ipcMain.handle('settings:isFirstRun', async () => {
    return SettingsManager.isFirstRun();
  });

  ipcMain.handle('settings:initializeKeychain', async () => {
    return SettingsManager.initializeKeychain();
  });

  ipcMain.handle('settings:validateAnthropic', async (_, key: string) => {
    return SettingsManager.validateAnthropicKey(key);
  });

  ipcMain.handle('settings:validateOpenAI', async (_, key: string) => {
    return SettingsManager.validateOpenAIKey(key);
  });

  ipcMain.handle('settings:validateTelegram', async (_, token: string) => {
    return SettingsManager.validateTelegramToken(token);
  });

  ipcMain.handle('settings:validateMoonshot', async (_, key: string) => {
    return SettingsManager.validateMoonshotKey(key);
  });

  ipcMain.handle('settings:validateMinimax', async (_, key: string) => {
    return SettingsManager.validateMinimaxKey(key);
  });

  ipcMain.handle('settings:validateQwen', async (_, key: string) => {
    return SettingsManager.validateQwenKey(key);
  });

  ipcMain.handle('settings:validateOpenRouter', async (_, key: string) => {
    return SettingsManager.validateOpenRouterKey(key);
  });

  // Get available models based on configured API keys
  ipcMain.handle('settings:getAvailableModels', async () => {
    const models: Array<{ id: string; name: string; provider: string }> = [];
    const parseFavoriteModelIds = (raw: string): Set<string> => {
      const text = String(raw || '').trim();
      if (!text) return new Set<string>();
      try {
        if (text.startsWith('[')) {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            return new Set(
              parsed
                .map((v: unknown) => String(v || '').trim().toLowerCase())
                .filter(Boolean)
            );
          }
        }
      } catch {
        // Fall back to plain-text parsing below.
      }
      return new Set(
        text
          .split(/[\n,]+/)
          .map(v => v.trim().toLowerCase())
          .filter(Boolean)
      );
    };

    const fetchOpenRouterModels = async (
      apiKey: string,
      favoriteIds: Set<string>
    ): Promise<Array<{ id: string; name: string; provider: string }>> => {
      const fallback = [
        { id: 'openrouter/auto', name: 'OpenRouter Auto', provider: favoriteIds.has('openrouter/auto') ? 'openrouter_fav' : 'openrouter' },
      ];
      const fetchRows = async (url: string): Promise<Array<Record<string, unknown>>> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: 'application/json',
            },
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`OpenRouter models API failed (${response.status})`);
          }
          const payload = await response.json() as { data?: Array<Record<string, unknown>> };
          return Array.isArray(payload?.data) ? payload.data : [];
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        // Only use user-scoped list to avoid showing models the current key cannot use.
        const rows = await fetchRows('https://openrouter.ai/api/v1/models/user');

        const mapped = rows
          .map((row) => {
            const id = String(row.id || '').trim();
            if (!id) return null;
            const nameRaw = String(row.name || '').trim();
            const isFav = favoriteIds.has(id.toLowerCase());
            
            // Check for tool support - agent depends on tools!
            const supportedParams = Array.isArray(row.supported_parameters) ? (row.supported_parameters as string[]) : [];
            const supportsTools = supportedParams.includes('tools');
            
            // Filter out models that don't support tools, unless they are already favorites.
            if (!supportsTools && !isFav) return null;

            const promptPrice = Number((row as { pricing?: { prompt?: string | number } }).pricing?.prompt);
            const completionPrice = Number((row as { pricing?: { completion?: string | number } }).pricing?.completion);
            const isFree = Number.isFinite(promptPrice)
              && Number.isFinite(completionPrice)
              && promptPrice === 0
              && completionPrice === 0;

            const contextLength = Number(row.context_length);
            const contextStr = contextLength >= 1024 ? ` (${Math.round(contextLength / 1024)}k)` : '';

            const name = nameRaw && nameRaw.toLowerCase() !== id.toLowerCase() ? nameRaw : id;
            return {
              id,
              name: `${name}${contextStr}${isFree ? ' [free]' : ''}`,
              provider: isFav ? 'openrouter_fav' : 'openrouter',
            };
          })
          .filter((item): item is { id: string; name: string; provider: string } => !!item);

        const dedupedById = new Map<string, { id: string; name: string; provider: string }>();
        for (const item of mapped) {
          dedupedById.set(item.id.toLowerCase(), item);
        }
        const deduped = Array.from(dedupedById.values());

        const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
        const favorites = deduped.filter(m => m.provider === 'openrouter_fav').sort(byName);
        const rest = deduped.filter(m => m.provider === 'openrouter').sort(byName);
        return [...favorites, ...rest];
      } catch (err) {
        console.warn('[Main] Failed to fetch OpenRouter user models, using safe fallback list:', err);
        return fallback;
      }
    };

    // Check for Anthropic keys (OAuth or API key)
    const authMethod = SettingsManager.get('auth.method');
    const hasOAuth = authMethod === 'oauth' && SettingsManager.get('auth.oauthToken');
    const hasAnthropicKey = SettingsManager.get('anthropic.apiKey');

    if (hasOAuth || hasAnthropicKey) {
      models.push(
        { id: 'claude-opus-4-6', name: 'Opus 4.6', provider: 'anthropic' },
        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', provider: 'anthropic' },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', provider: 'anthropic' }
      );
    }

    // Check for Moonshot/Kimi key
    const hasMoonshotKey = SettingsManager.get('moonshot.apiKey');
    if (hasMoonshotKey) {
      models.push(
        { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'moonshot' }
      );
    }

    // Check for GLM/Zhipu key
    const hasGlmKey = SettingsManager.get('glm.apiKey');
    if (hasGlmKey) {
      models.push(
        { id: 'glm-5', name: 'GLM 5', provider: 'glm' }
      );
    }

    // Check for MiniMax key
    const hasMinimaxKey = SettingsManager.get('minimax.apiKey');
    if (hasMinimaxKey) {
      models.push(
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'minimax' },
        { id: 'MiniMax-M2.5-Lightning', name: 'M2.5 Lightning', provider: 'minimax' }
      );
    }

    // Check for Gemini key (direct API, not OpenRouter)
    const hasGeminiKey = SettingsManager.get('gemini.apiKey');
    if (hasGeminiKey) {
      models.push(
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini' },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini' },
        { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', provider: 'gemini' }
      );
    }

    // Check for direct Qwen key (DashScope Anthropic-compatible endpoint)
    const hasQwenKey = SettingsManager.get('qwen.apiKey');
    if (hasQwenKey) {
      models.push(
        { id: 'qwen3.5-plus-2026-02-15', name: 'Qwen 3.5 Plus', provider: 'qwen' }
      );
    }

    // Check for OpenRouter key
    const hasOpenRouterKey = SettingsManager.get('openrouter.apiKey');
    if (hasOpenRouterKey) {
      const favoriteIds = parseFavoriteModelIds(SettingsManager.get('openrouter.favoriteModels') || '');
      const openRouterModels = await fetchOpenRouterModels(hasOpenRouterKey, favoriteIds);
      models.push(...openRouterModels);
    }

    return models;
  });

  // Browser launcher IPC handlers are registered later in setupIPC (upstream block)

  ipcMain.handle('glm:healthCheck', async () => {
    const { glmHealthCheck, isGlmConfigured } = await import('../tools/glm-client');
    if (!isGlmConfigured()) return { ok: false, error: 'No API key' };
    return glmHealthCheck();
  });

  ipcMain.handle('glm:expand', async (_event, systemPrompt: string, userText: string) => {
    const { glmChat, isGlmConfigured } = await import('../tools/glm-client');
    if (!isGlmConfigured()) return { ok: false, error: 'GLM not configured — add API key in settings' };
    try {
      const result = await glmChat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
      });
      if (result.success && result.content) return { ok: true, text: result.content };
      return { ok: false, error: result.error || 'No response' };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('gog:status', async () => {
    const { isGogAvailable } = await import('../tools/gog-wrapper');
    try {
      const available = await isGogAvailable();
      if (!available) return { ok: false, error: 'gog CLI not found' };
      const { gogExec } = await import('../tools/gog-wrapper');
      const authList = await gogExec(['auth', 'list']);
      return { ok: true, accounts: authList };
    } catch {
      return { ok: false, error: 'gog check failed' };
    }
  });

  // Gmail Email Processing IPC handlers
  ipcMain.handle('gmail:fetchLabels', async (_evt: unknown, account?: string) => {
    const { listLabels } = await import('../tools/gog-wrapper');
    try {
      return await listLabels({ account });
    } catch {
      return { success: false, error: 'Failed to fetch labels' };
    }
  });

  ipcMain.handle('gmail:fetchRecentEmails', async (_evt: unknown, account?: string) => {
    const { readEmails } = await import('../tools/gog-wrapper');
    try {
      return await readEmails({ query: 'in:inbox newer_than:7d', max: 50, account });
    } catch {
      return { success: false, error: 'Failed to fetch emails' };
    }
  });

  ipcMain.handle('gmail:getEmailPreview', async (_evt: unknown, messageId: string, account?: string) => {
    const { getMessage } = await import('../tools/gog-wrapper');
    try {
      return await getMessage({ messageId, account });
    } catch {
      return { success: false, error: 'Failed to fetch email' };
    }
  });

  // Helper: ensure email processor and rules engine exist (lazy init)
  async function ensureEmailProcessor(): Promise<void> {
    if (!emailProcessor) {
      const { EmailProcessor } = await import('../scheduler/email-processor');
      const epDbPath = path.join(app.getPath('userData'), 'pocket-agent.db');
      emailProcessor = new EmailProcessor(epDbPath);
      emailProcessor.setNotificationHandler((title: string, body: string) => {
        showNotification(title, body);
      });
      emailProcessor.setProgressHandler((status: string, detail?: Record<string, unknown>) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gmail:progress', { status, ...detail });
        }
      });
    }
    if (!rulesEngine) {
      const { RulesEngine } = await import('../scheduler/rules-engine');
      rulesEngine = new RulesEngine(emailProcessor.getDb());
      rulesEngine.setNotificationHandler((title: string, body: string) => {
        showNotification(title, body);
      });
      rulesEngine.setTelegramSender((text: string) => {
        const chatId = SettingsManager.get('telegram.defaultChatId');
        if (chatId && telegramBot) {
          telegramBot.sendMessage(Number(chatId), text).catch((err: unknown) => {
            console.warn('[RulesEngine] Telegram send failed:', err);
          });
        }
      });
      emailProcessor.setRulesEngine(rulesEngine);
    }
    scheduleDailyDigest();
  }

  // Daily digest scheduler - checks every minute if it's time to send
  let dailyDigestTimer: ReturnType<typeof setInterval> | null = null;
  let dailyDigestLastRun = '';

  function scheduleDailyDigest(): void {
    if (dailyDigestTimer) return; // already scheduled
    dailyDigestTimer = setInterval(async () => {
      const timeStr = SettingsManager.get('gmail.emailProcessing.dailySummaryTime') || '08:00';
      const now = new Date();
      const [h, m] = timeStr.split(':').map(Number);
      const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      if (now.getHours() === h && now.getMinutes() === m && dailyDigestLastRun !== todayKey) {
        dailyDigestLastRun = todayKey;
        try {
          if (rulesEngine) {
            console.log('[DailyDigest] Running daily summary');
            await rulesEngine.runDailySummary();
          }
        } catch (err) {
          console.warn('[DailyDigest] Failed:', err);
        }
      }
    }, 60000);
  }

  ipcMain.handle('gmail:runEmailProcessor', async () => {
    try {
      await ensureEmailProcessor();
      await emailProcessor!.processEmails(true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle('gmail:getProcessingStatus', async () => {
    try {
      await ensureEmailProcessor();
      return emailProcessor!.getProcessingStatus();
    } catch {
      return { runs: [], checkpoints: [] };
    }
  });

  ipcMain.handle('gmail:getProcessedEmails', async (_evt: unknown, limit?: number, offset?: number, filters?: { label?: string; since?: string; sender?: string; confidence?: string; routing?: string }) => {
    try {
      await ensureEmailProcessor();
      return emailProcessor!.getProcessedEmails(limit ?? 200, offset ?? 0, filters);
    } catch {
      return { emails: [], total: 0 };
    }
  });

  ipcMain.handle('gmail:correctLabel', async (_evt: unknown, messageId: string, account: string, newLabel: string, useAsExample: boolean) => {
    try {
      await ensureEmailProcessor();
      await emailProcessor!.correctLabel(messageId, account, newLabel, useAsExample);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle('gmail:reclassifyEmails', async (_evt: unknown, messageIds: string[], account: string) => {
    try {
      await ensureEmailProcessor();
      return await emailProcessor!.reclassifyEmails(messageIds, account);
    } catch (err) {
      return { total: messageIds.length, reclassified: 0, errors: messageIds.length, results: [], error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle('gmail:getLabelStats', async (_evt: unknown, account?: string) => {
    try {
      await ensureEmailProcessor();
      return emailProcessor!.getLabelStats(account);
    } catch { return []; }
  });

  ipcMain.handle('gmail:getRoutingStats', async (_evt: unknown, account?: string) => {
    try {
      await ensureEmailProcessor();
      return emailProcessor!.getRoutingStats(account);
    } catch { return { filed: 0, kept: 0, failed: 0 }; }
  });

  ipcMain.handle('gmail:restoreToInbox', async (_evt: unknown, messageId: string, account: string) => {
    try {
      await ensureEmailProcessor();
      const { modifyLabels } = await import('../tools/gog-wrapper');
      const row = emailProcessor!.getDb().prepare(
        'SELECT thread_id FROM email_processing_state WHERE message_id = ? AND account = ?'
      ).get(messageId, account) as { thread_id: string } | undefined;
      if (!row?.thread_id) return { ok: false, error: 'Thread not found' };
      await modifyLabels({ threadIds: [row.thread_id], add: 'INBOX', account });
      emailProcessor!.getDb().prepare(
        "UPDATE email_processing_state SET routing_result = 'in_inbox', routing_error = 'user_restored' WHERE message_id = ? AND account = ?"
      ).run(messageId, account);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle('gmail:fileFromInbox', async (_evt: unknown, messageId: string, account: string) => {
    try {
      await ensureEmailProcessor();
      const { modifyLabels } = await import('../tools/gog-wrapper');
      const row = emailProcessor!.getDb().prepare(
        'SELECT thread_id FROM email_processing_state WHERE message_id = ? AND account = ?'
      ).get(messageId, account) as { thread_id: string } | undefined;
      if (!row?.thread_id) return { ok: false, error: 'Thread not found' };
      await modifyLabels({ threadIds: [row.thread_id], remove: 'INBOX', account });
      emailProcessor!.getDb().prepare(
        "UPDATE email_processing_state SET routing_result = 'filed', routing_error = NULL WHERE message_id = ? AND account = ?"
      ).run(messageId, account);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle('gmail:aiDefineLabelConfig', async (
    _evt: unknown,
    labelName: string,
    definition: string,
    negative: string,
    examples: Array<{ messageId: string; subject?: string; from?: string }>,
    field: 'definition' | 'negative',
    account?: string,
  ) => {
    try {
      const { glmFlash } = await import('../tools/glm-client');
      const { getMessage } = await import('../tools/gog-wrapper');

      // Fetch example email content in parallel
      let exampleTexts: string[] = [];
      if (examples && examples.length > 0) {
        const toFetch = examples.slice(0, 5);
        const results = await Promise.allSettled(
          toFetch.map(ex => getMessage({ messageId: ex.messageId, account })),
        );
        exampleTexts = results
          .filter((r): r is PromiseFulfilledResult<{ success: boolean; message?: string }> =>
            r.status === 'fulfilled' && r.value.success && !!r.value.message)
          .map((r, i) => {
            try {
              const parsed = JSON.parse(r.value.message!);
              const from = parsed.from || parsed.sender || toFetch[i].from || 'Unknown';
              const subject = parsed.subject || toFetch[i].subject || '(no subject)';
              const body = (parsed.body || parsed.snippet || '').slice(0, 1000);
              return `--- Example ${i + 1} ---\nFrom: ${from} | Subject: ${subject}\nBody: ${body}`;
            } catch {
              return '';
            }
          })
          .filter(Boolean);
      }

      const examplesBlock = exampleTexts.length > 0
        ? `\n\nExample emails (${exampleTexts.length}):\n${exampleTexts.join('\n\n')}`
        : '';

      let prompt: string;
      if (field === 'definition') {
        prompt = `You are an expert email classification assistant. Write a precise definition for an email label.

Label name: "${labelName}"
User's rough definition: "${definition || '(none provided)'}"${examplesBlock}

Instructions:
1. Analyze the label name, user's rough text, and any example emails above.
2. Write a precise definition (2-3 sentences) — be specific about senders, topics, and patterns that belong in this label. Focus ONLY on what DOES belong.
3. Output ONLY the definition text, nothing else. No JSON, no quotes, no prefix.`;
      } else {
        prompt = `You are an expert email classification assistant. Write negative guidance for an email label — what does NOT belong.

Label name: "${labelName}"
Current definition: "${definition || '(none provided)'}"
User's rough negative guidance: "${negative || '(none provided)'}"${examplesBlock}

Instructions:
1. Analyze the label name, current definition, user's rough text, and any example emails above.
2. Write negative guidance (2-3 sentences) — describe what does NOT belong in this label, common confusions to avoid. Be specific.
3. Output ONLY the negative guidance text, nothing else. No JSON, no quotes, no prefix.`;
      }

      const result = await glmFlash({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
        temperature: 0.3,
        disableThinking: true,
      });

      if (!result.success || !result.content) {
        return { ok: false, error: result.error || 'GLM returned no content' };
      }

      const text = result.content.trim();
      return { ok: true, field, text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  // Rules Engine IPC handlers
  ipcMain.handle('rules:getAll', async (_evt: unknown, account?: string) => {
    try {
      await ensureEmailProcessor();
      return rulesEngine!.getRules(account);
    } catch { return []; }
  });

  ipcMain.handle('rules:get', async (_evt: unknown, id: number) => {
    try {
      await ensureEmailProcessor();
      return rulesEngine!.getRule(id);
    } catch { return null; }
  });

  ipcMain.handle('rules:create', async (_evt: unknown, rule: Record<string, unknown>) => {
    try {
      await ensureEmailProcessor();
      return rulesEngine!.createRule(rule as Partial<import('../scheduler/rules-engine').EmailRule>);
    } catch (err) { return { error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('rules:update', async (_evt: unknown, id: number, updates: Record<string, unknown>) => {
    try {
      await ensureEmailProcessor();
      return rulesEngine!.updateRule(id, updates as Partial<import('../scheduler/rules-engine').EmailRule>);
    } catch (err) { return { error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('rules:delete', async (_evt: unknown, id: number) => {
    try {
      await ensureEmailProcessor();
      rulesEngine!.deleteRule(id);
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('rules:toggle', async (_evt: unknown, id: number, enabled: boolean) => {
    try {
      await ensureEmailProcessor();
      rulesEngine!.toggleRule(id, enabled);
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('rules:test', async (_evt: unknown, id: number, limit?: number) => {
    try {
      await ensureEmailProcessor();
      return rulesEngine!.testRule(id, limit ?? 10);
    } catch { return []; }
  });

  ipcMain.handle('rules:getExecutions', async (_evt: unknown, ruleId?: number, limit?: number) => {
    try {
      await ensureEmailProcessor();
      return rulesEngine!.getExecutionLog(ruleId, limit ?? 50);
    } catch { return []; }
  });

  ipcMain.handle('rules:runDailySummary', async () => {
    try {
      await ensureEmailProcessor();
      return await rulesEngine!.runDailySummary();
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('rules:replay', async (_evt: unknown, limit?: number) => {
    try {
      await ensureEmailProcessor();
      return await rulesEngine!.replayRules(limit ?? 50);
    } catch (err) { return { total: 0, matched: 0, executed: 0, errors: 0, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  // AI Rule Builder - analyze emails and suggest rules
  ipcMain.handle('rules:aiBuildRule', async (
    _evt: unknown,
    emails: Array<{ messageId: string; account: string; subject?: string; sender?: string; label?: string }>,
    userPrompt: string,
  ) => {
    try {
      const { glmFlash } = await import('../tools/glm-client');
      const { getMessage } = await import('../tools/gog-wrapper');

      // Fetch full body for each email (up to 5 to avoid token limits)
      const emailsToAnalyze = emails.slice(0, 5);
      const emailDetails: Array<{ subject: string; sender: string; label: string; body: string }> = [];

      for (const e of emailsToAnalyze) {
        try {
          const msgRes = await getMessage({ messageId: e.messageId, account: e.account });
          if (msgRes.success && msgRes.message) {
            const parsed = JSON.parse(msgRes.message);
            const headers = parsed.headers || {};
            const msg = parsed.message || {};
            const body = parsed.body || msg.snippet || '';
            emailDetails.push({
              subject: headers.subject || e.subject || '',
              sender: headers.from || e.sender || '',
              label: e.label || '',
              body: body.slice(0, 1500),
            });
          }
        } catch { /* skip failed fetches */ }
      }

      if (emailDetails.length === 0) {
        return { ok: false, error: 'Could not fetch any email details' };
      }

      // Build prompt for GLM
      const emailsBlock = emailDetails.map((e, i) =>
        `--- Email ${i + 1} ---\nFrom: ${e.sender}\nSubject: ${e.subject}\nLabel: ${e.label}\nBody:\n${e.body}`
      ).join('\n\n');

      const prompt = `You are an email automation expert. Analyze the following emails and create a rule configuration.

USER'S INTENT:
${userPrompt}

EMAILS TO ANALYZE:
${emailsBlock}

Based on the user's intent and the email patterns, generate a JSON rule with:
1. "name": A short descriptive name for this rule
2. "conditions": Array of conditions to match these emails. Use types like:
   - {"type": "label_is", "value": "LabelName"} - match specific label
   - {"type": "body_contains", "value": "keyword"} - match body text (case-insensitive)
   - {"type": "subject_contains", "value": "keyword"} - match subject
   - {"type": "sender_domain", "value": "domain.com"} - match sender domain
3. "action": Either "draft_reply" or "do_nothing"
4. "draftInstructions": If action is draft_reply, detailed instructions for writing the reply. Be specific about tone, what to include/exclude, any URLs or pricing to mention.

Respond with ONLY valid JSON, no markdown, no explanation:
{"name": "...", "conditions": [...], "action": "...", "draftInstructions": "..."}`;

      const glmRes = await glmFlash({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1500,
        temperature: 0.3,
        disableThinking: true,
      });

      if (!glmRes.success || !glmRes.content) {
        return { ok: false, error: 'AI failed to generate rule' };
      }

      // Parse the JSON response
      let result;
      try {
        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = glmRes.content.trim();
        if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }
        result = JSON.parse(jsonStr);
      } catch {
        return { ok: false, error: 'AI returned invalid JSON', raw: glmRes.content };
      }

      return {
        ok: true,
        suggestion: {
          name: result.name || 'New Rule',
          conditions: result.conditions || [],
          action: result.action || 'draft_reply',
          draftInstructions: result.draftInstructions || '',
        },
        emailCount: emailDetails.length,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to build rule' };
    }
  });

  // --- Unanswered Command Center ---

  async function ensureUnansweredEngine(): Promise<void> {
    await ensureEmailProcessor();
    if (!unansweredEngine) {
      const { UnansweredEngine } = await import('../scheduler/unanswered-engine');
      unansweredEngine = new UnansweredEngine(emailProcessor!.getDb());
      unansweredEngine.setTelegramSender((text: string) => {
        const chatId = SettingsManager.get('telegram.defaultChatId');
        if (chatId && telegramBot) {
          telegramBot.sendMessage(Number(chatId), text).catch((err: unknown) => {
            console.warn('[UnansweredEngine] Telegram send failed:', err);
          });
        }
      });
      unansweredEngine.setNotificationHandler((title: string, body: string) => {
        showNotification(title, body);
      });
    }
  }

  ipcMain.handle('unanswered:scan', async (_evt: unknown, account?: string) => {
    try {
      await ensureUnansweredEngine();
      if (account) return await unansweredEngine!.scan(account);
      return await unansweredEngine!.scanAll();
    } catch (err) { return { error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('unanswered:list', async (_evt: unknown, filter?: Record<string, unknown>) => {
    try {
      await ensureUnansweredEngine();
      return {
        threads: unansweredEngine!.list(filter as import('../scheduler/unanswered-engine').UnansweredFilter),
        total: unansweredEngine!.count(filter as import('../scheduler/unanswered-engine').UnansweredFilter),
      };
    } catch { return { threads: [], total: 0 }; }
  });

  ipcMain.handle('unanswered:resolve', async (_evt: unknown, account: string, threadId: string) => {
    try {
      await ensureUnansweredEngine();
      unansweredEngine!.resolve(account, threadId);
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('unanswered:resolveAll', async (_evt: unknown, filter?: Record<string, unknown>) => {
    try {
      await ensureUnansweredEngine();
      const count = unansweredEngine!.resolveAll(filter as import('../scheduler/unanswered-engine').UnansweredFilter);
      return { ok: true, count };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('unanswered:dismiss', async (_evt: unknown, account: string, threadId: string) => {
    try {
      await ensureUnansweredEngine();
      unansweredEngine!.dismiss(account, threadId);
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('unanswered:dismissAll', async (_evt: unknown, filter?: Record<string, unknown>) => {
    try {
      await ensureUnansweredEngine();
      const count = unansweredEngine!.dismissAll(filter as import('../scheduler/unanswered-engine').UnansweredFilter);
      return { ok: true, count };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('unanswered:digest', async (_evt: unknown, account: string) => {
    try {
      await ensureUnansweredEngine();
      return await unansweredEngine!.sendDigest(account);
    } catch (err) { return { sent: false, threadCount: 0, throttled: false, error: err instanceof Error ? err.message : 'Failed' }; }
  });

  ipcMain.handle('unanswered:getSettings', async () => {
    return {
      enabled: SettingsManager.get('gmail.unanswered.enabled') === 'true',
      intervalMin: SettingsManager.get('gmail.unanswered.intervalMin') || '60',
      lookbackDays: SettingsManager.get('gmail.unanswered.lookbackDays') || '30',
      labels: JSON.parse(SettingsManager.get('gmail.unanswered.labels') || '[]'),
      digestThrottleHours: SettingsManager.get('gmail.unanswered.digestThrottleHours') || '4',
    };
  });

  ipcMain.handle('unanswered:saveSettings', async (_evt: unknown, settings: Record<string, string>) => {
    for (const [key, value] of Object.entries(settings)) {
      SettingsManager.set(`gmail.unanswered.${key}`, value);
    }
    return { ok: true };
  });

  ipcMain.handle('telegram:restart', async () => {
    try {
      if (telegramBot) {
        await telegramBot.stop();
        telegramBot = null;
      }
      const telegramEnabled = SettingsManager.getBoolean('telegram.enabled');
      const telegramToken = SettingsManager.get('telegram.botToken');
      if (!telegramEnabled || !telegramToken) {
        return { success: false, error: 'Telegram not enabled or no token configured' };
      }
      telegramBot = createTelegramBot();
      if (!telegramBot) {
        return { success: false, error: 'Failed to create Telegram bot' };
      }
      telegramBot.setOnMessageCallback((data) => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send('telegram:message', {
            userMessage: data.userMessage,
            response: data.response,
            chatId: data.chatId,
            sessionId: data.sessionId,
            hasAttachment: data.hasAttachment,
            attachmentType: data.attachmentType,
          });
        }
      });
      await telegramBot.start();
      if (scheduler) {
        scheduler.setTelegramBot(telegramBot);
      }
      setResearchTelegramBot(telegramBot);
      setLinkedInTelegramBot(telegramBot);
      console.log('[Main] Telegram restarted via IPC');
      return { success: true };
    } catch (error) {
      console.error('[Main] Telegram restart failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('agent:restart', async () => {
    try {
      await restartAgent();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('app:openSettings', async (_event, tab?: string) => {
    openSettingsWindow(tab);
  });

  ipcMain.handle('app:openChat', async () => {
    openChatWindow();
  });

  ipcMain.handle('chat:injectMessage', async (_, message: string) => {
    openChatWindow();
    // Wait for window page JS to finish loading so chat:inject listener is registered
    await new Promise<void>(resolve => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        const wc = chatWindow.webContents;
        if (!wc.isLoading()) {
          resolve();
        } else {
          wc.once('did-finish-load', () => resolve());
          setTimeout(() => resolve(), 3000);
        }
      } else {
        setTimeout(() => resolve(), 3000);
      }
    });
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chat:inject', message);
    }
  });

  // OAuth flow for Claude subscription
  ipcMain.handle('auth:startOAuth', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.startFlow();
  });

  ipcMain.handle('auth:completeOAuth', async (_, code: string) => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.completeWithCode(code);
  });

  ipcMain.handle('auth:cancelOAuth', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    ClaudeOAuth.cancelFlow();
    return { success: true };
  });

  ipcMain.handle('auth:isOAuthPending', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.isPending();
  });

  ipcMain.handle('auth:validateOAuth', async () => {
    try {
      const { ClaudeOAuth } = await import('../auth/oauth');
      // Timeout after 5 seconds to avoid hanging the UI
      const result = await Promise.race([
        ClaudeOAuth.getAccessToken().then(token => ({ valid: token !== null })),
        new Promise<{ valid: boolean }>(resolve =>
          setTimeout(() => resolve({ valid: false }), 5000)
        ),
      ]);
      console.log('[OAuth] Validation result:', result.valid ? 'valid' : 'expired/failed');
      return result;
    } catch (error) {
      console.error('[OAuth] Validation error:', error);
      return { valid: false };
    }
  });

  // Browser control
  ipcMain.handle('browser:detectInstalled', async () => {
    const { detectInstalledBrowsers } = await import('../browser/launcher');
    return detectInstalledBrowsers();
  });

  ipcMain.handle('browser:launch', async (_, browserId: string, port?: number) => {
    const { launchBrowser } = await import('../browser/launcher');
    return launchBrowser(browserId, port || 9222);
  });

  ipcMain.handle('browser:testConnection', async (_, cdpUrl?: string) => {
    const { testCdpConnection } = await import('../browser/launcher');
    return testCdpConnection(cdpUrl || 'http://localhost:9222');
  });

  // Shell commands — platform-aware shell selection (restricted to local UI origin)
  ipcMain.handle('shell:runCommand', async (event, command: string) => {
    const senderUrl = event.sender.getURL();
    if (!senderUrl.startsWith('file://')) {
      console.warn('[IPC] Blocked shell:runCommand from non-local origin:', senderUrl);
      throw new Error('Shell commands only allowed from local UI');
    }
    const allowedPrefixes = IS_WINDOWS
      ? [
          '(Get-Command pocket',
          'Invoke-RestMethod https://api.github.com/repos/KenKaiii/pocket-agent-cli/releases/latest',
          '$installDir = Join-Path',
        ]
      : [
          'which pocket',
          'strings ',
          'curl -fsSL https://api.github.com/repos/KenKaiii/pocket-agent-cli/releases/latest',
          'curl -fsSL https://raw.githubusercontent.com/KenKaiii/pocket-agent-cli/main/scripts/install.sh | sed ',
        ];
    if (!allowedPrefixes.some(prefix => command.startsWith(prefix))) {
      console.warn('[IPC] Blocked shell:runCommand outside allowlist:', command.slice(0, 120));
      throw new Error('Command not allowed');
    }
    const execAsync = promisify(exec);
    const shellOpts: Record<string, unknown> = IS_WINDOWS
      ? { shell: 'powershell.exe', env: process.env }
      : { shell: '/bin/bash', env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${HOME_DIR}/.local/bin` } };
    try {
      const { stdout } = await execAsync(command, shellOpts);
      return stdout;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Shell] Command failed:', errorMsg);
      throw error;
    }
  });

  // Commands (Workflows)
  ipcMain.handle('commands:list', async () => {
    return loadWorkflowCommands();
  });

  // Read media file as data URI (for displaying agent-generated images in chat)
  ipcMain.handle('agent:readMedia', async (_, filePath: string) => {
    try {
      // Security: only allow reading from the Pocket-agent media directory
      const mediaDir = path.join(app.getPath('documents'), 'Pocket-agent', 'media');
      const resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith(mediaDir)) {
        throw new Error('Access denied: path outside media directory');
      }

      const buffer = fs.readFileSync(resolvedPath);
      const ext = path.extname(resolvedPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const mimeType = mimeMap[ext] || 'image/png';
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Main] Failed to read media file:', errorMsg);
      return null;
    }
  });

  // File attachments
  ipcMain.handle('attachment:save', async (_, name: string, dataUrl: string) => {
    try {
      // Create attachments directory
      const attachmentsDir = path.join(app.getPath('userData'), 'attachments');
      if (!fs.existsSync(attachmentsDir)) {
        fs.mkdirSync(attachmentsDir, { recursive: true });
      }

      // Generate unique filename
      const timestamp = Date.now();
      const safeName = name.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filePath = path.join(attachmentsDir, `${timestamp}-${safeName}`);

      // Extract base64 data and save
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        throw new Error('Invalid data URL format');
      }

      const buffer = Buffer.from(matches[2], 'base64');
      fs.writeFileSync(filePath, buffer);

      console.log(`[Attachment] Saved: ${filePath}`);
      return filePath;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Attachment] Save failed:', errorMsg);
      throw error;
    }
  });

  // Voice - microphone permission
  ipcMain.handle('voice:micPermission', async () => {
    try {
      const { systemPreferences } = await import('electron');
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return { granted };
    } catch (error) {
      console.error('[Voice] Mic permission error:', error);
      return { granted: false };
    }
  });

  // Voice - transcribe audio via macOS SFSpeechRecognizer (free, on-device)
  // Splits long recordings into ~55s chunks for reliable recognition
  ipcMain.handle('voice:transcribe', async (_, audioData: ArrayBuffer) => {
    try {
      const fs = await import('fs');
      const { execFile } = await import('child_process');

      const tempDir = path.join(app.getPath('temp'), 'pocket-agent-voice');
      fs.mkdirSync(tempDir, { recursive: true });

      // Find the transcriber binary
      let binaryPath: string;
      if (app.isPackaged) {
        binaryPath = path.join(process.resourcesPath, 'app', 'assets', 'transcribe-speech');
      } else {
        binaryPath = path.join(__dirname, '..', '..', 'assets', 'transcribe-speech');
      }

      if (!fs.existsSync(binaryPath)) {
        return { success: false, error: 'Speech transcriber not found. Rebuild the app.' };
      }

      const buffer = Buffer.from(audioData);

      // Parse WAV header: sample rate at offset 24 (4 bytes LE), block align at offset 32 (2 bytes LE)
      const sampleRate = buffer.readUInt32LE(24);
      const blockAlign = buffer.readUInt16LE(32);
      const dataStart = 44; // Standard WAV header size
      const dataLength = buffer.length - dataStart;

      // Split into ~55-second chunks
      const chunkSeconds = 55;
      const bytesPerChunk = sampleRate * blockAlign * chunkSeconds;
      const chunkCount = Math.ceil(dataLength / bytesPerChunk);

      console.log(`[Voice] Transcribing ${Math.round(dataLength / (sampleRate * blockAlign))}s audio in ${chunkCount} chunk(s)`);

      // Helper to write a WAV chunk file
      const writeChunkWav = (chunkIndex: number): string => {
        const chunkStart = chunkIndex * bytesPerChunk;
        const chunkEnd = Math.min(chunkStart + bytesPerChunk, dataLength);
        const chunkDataLen = chunkEnd - chunkStart;
        const chunkFile = path.join(tempDir, `chunk-${Date.now()}-${chunkIndex}.wav`);

        // Build WAV with correct header for this chunk
        const chunkBuf = Buffer.alloc(44 + chunkDataLen);
        // Copy original header
        buffer.copy(chunkBuf, 0, 0, 44);
        // Fix sizes in header
        chunkBuf.writeUInt32LE(36 + chunkDataLen, 4); // RIFF chunk size
        chunkBuf.writeUInt32LE(chunkDataLen, 40);      // data chunk size
        // Copy audio data
        buffer.copy(chunkBuf, 44, dataStart + chunkStart, dataStart + chunkEnd);
        fs.writeFileSync(chunkFile, chunkBuf);
        return chunkFile;
      };

      // Transcribe a single chunk file
      const transcribeChunk = (filePath: string): Promise<string> => {
        return new Promise((resolve, reject) => {
          execFile(binaryPath, [filePath], { timeout: 90000 }, (error, stdout, stderr) => {
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
            if (error) {
              if (stderr?.includes('not authorized')) {
                reject(new Error('Speech recognition permission denied. Allow in System Settings > Privacy & Security > Speech Recognition.'));
              } else {
                reject(new Error(stderr?.trim() || error.message));
              }
            } else {
              resolve(stdout.trim());
            }
          });
        });
      };

      // Process chunks sequentially (Apple rate-limits concurrent requests)
      const results: string[] = [];
      for (let i = 0; i < chunkCount; i++) {
        const chunkFile = writeChunkWav(i);
        try {
          const text = await transcribeChunk(chunkFile);
          if (text) results.push(text);
        } catch (err) {
          // Clean up remaining chunks on auth error
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('not authorized') || errMsg.includes('permission')) {
            return { success: false, error: errMsg };
          }
          console.warn(`[Voice] Chunk ${i + 1}/${chunkCount} failed: ${errMsg}`);
          // Continue with other chunks
        }
      }

      const fullText = results.join(' ').trim();
      if (!fullText) {
        return { success: false, error: 'No speech detected. Try speaking louder or closer to the mic.' };
      }
      return { success: true, text: fullText };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Transcription failed';
      console.error('[Voice] Transcription error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  // Voice TTS
  ipcMain.handle('voice:tts', async (_, text: string) => {
    try {
      const { synthesizeSpeech } = await import('../voice/tts');
      const ttsDir = path.join(app.getPath('userData'), 'tts-cache');
      const audioPath = await synthesizeSpeech(text, ttsDir);
      return { success: true, audioPath };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'TTS failed';
      console.error('[Voice] TTS error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  // Skills
  // Skills status/install/uninstall handlers removed (skills module was deleted)

  ipcMain.handle('skills:openPermissionSettings', async (_, permissionType: string) => {
    const { openPermissionSettings } = await import('../permissions/macos');
    await openPermissionSettings(permissionType as Parameters<typeof openPermissionSettings>[0]);
  });

  ipcMain.handle('skills:checkPermission', async (_, permissionType: string) => {
    const { getPermissionStatus } = await import('../permissions/macos');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getPermissionStatus(permissionType as any);
  });

  ipcMain.handle('app:openSkillsSetup', async () => {
    createSkillsSetupWindow();
  });

  ipcMain.handle('app:openKanban', async () => {
    openKanbanWindow();
  });

  ipcMain.handle('app:openCron', async () => {
    openCronWindow();
  });

  ipcMain.handle('app:openEmailProcessing', async () => {
    openEmailProcessingWindow();
  });

  // Calendar
  ipcMain.handle('app:openCalendar', async () => {
    openCalendarWindow();
  });

  ipcMain.handle('calendar:list', async (_, startDate?: string, endDate?: string) => {
    try {
      if (!memory) return [];
      const db = memory.getDatabase();
      let sql = 'SELECT * FROM calendar_events';
      const params: string[] = [];
      if (startDate && endDate) {
        sql += ' WHERE start_time >= ? AND start_time <= ?';
        params.push(startDate, endDate);
      } else if (startDate) {
        sql += ' WHERE start_time >= ?';
        params.push(startDate);
      } else if (endDate) {
        sql += ' WHERE start_time <= ?';
        params.push(endDate);
      }
      sql += ' ORDER BY start_time ASC';
      return db.prepare(sql).all(...params);
    } catch { return []; }
  });

  ipcMain.handle('calendar:add', async (_, event: Record<string, unknown>) => {
    try {
      if (!memory) return { success: false, error: 'Memory not initialized' };
      const db = memory.getDatabase();
      const stmt = db.prepare(
        `INSERT INTO calendar_events (title, description, start_time, end_time, all_day, location, reminder_minutes, channel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const result = stmt.run(
        event.title, event.description || null, event.start_time, event.end_time || null,
        event.all_day ? 1 : 0, event.location || null, event.reminder_minutes ?? 15, event.channel || 'desktop'
      );
      return { success: true, id: result.lastInsertRowid };
    } catch (err) { return { success: false, error: String(err) }; }
  });

  ipcMain.handle('calendar:delete', async (_, id: number) => {
    try {
      if (!memory) return { success: false, error: 'Memory not initialized' };
      const db = memory.getDatabase();
      db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
      return { success: true };
    } catch (err) { return { success: false, error: String(err) }; }
  });

  ipcMain.handle('calendar:update', async (_, id: number, updates: Record<string, unknown>) => {
    try {
      if (!memory) return { success: false, error: 'Memory not initialized' };
      const db = memory.getDatabase();
      const fields: string[] = [];
      const values: unknown[] = [];
      for (const [key, val] of Object.entries(updates)) {
        if (['title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'reminder_minutes', 'channel'].includes(key)) {
          fields.push(`${key} = ?`);
          values.push(key === 'all_day' ? (val ? 1 : 0) : val);
        }
      }
      if (fields.length === 0) return { success: false, error: 'No valid fields to update' };
      fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')");
      values.push(id);
      db.prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      return { success: true };
    } catch (err) { return { success: false, error: String(err) }; }
  });

  // Kanban
  ipcMain.handle('kanban:listProjects', async () => {
    try { return KanbanService.listProjects(); } catch { return []; }
  });

  ipcMain.handle('kanban:getProject', async (_, id: number) => {
    try { return KanbanService.getProject(id); } catch { return null; }
  });

  ipcMain.handle('kanban:createProject', async (_, name: string, description?: string, color?: string) => {
    try { return { success: true, project: KanbanService.createProject(name, description, color) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:archiveProject', async (_, id: number) => {
    return { success: KanbanService.archiveProject(id) };
  });

  ipcMain.handle('kanban:deleteProject', async (_, id: number) => {
    try { return { success: KanbanService.deleteProject(id) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:updateProject', async (_, id: number, updates: Record<string, string>) => {
    try { return { success: true, project: KanbanService.updateProject(id, updates) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:getBoard', async (_, projectId: number) => {
    try { return KanbanService.getBoard(projectId); } catch { return null; }
  });

  ipcMain.handle('kanban:createTask', async (_, input: Record<string, unknown>) => {
    try {
      return { success: true, task: KanbanService.createTask(input as unknown as Parameters<typeof KanbanService.createTask>[0]) };
    } catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:getTask', async (_, id: number) => {
    try { return KanbanService.getTask(id); } catch { return null; }
  });

  ipcMain.handle('kanban:updateTask', async (_, id: number, updates: Record<string, unknown>) => {
    try { return { success: true, task: KanbanService.updateTask(id, updates) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:moveTask', async (_, id: number, status: string) => {
    try { return { success: true, task: KanbanService.moveTask(id, status as KanbanStatus) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:moveTaskToProject', async (_, id: number, projectId: number) => {
    try { return { success: true, task: KanbanService.moveTaskToProject(id, projectId) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:getAllTasks', async (_, statusFilter?: string[]) => {
    try { return KanbanService.getAllTasks(statusFilter as import('../kanban').KanbanStatus[]); }
    catch { return []; }
  });

  ipcMain.handle('kanban:deleteTask', async (_, id: number) => {
    return { success: KanbanService.deleteTask(id) };
  });

  ipcMain.handle('kanban:addComment', async (_, taskId: number, comment: string) => {
    try { KanbanService.addComment(taskId, comment); return { success: true }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:getActivity', async (_, taskId: number, limit?: number) => {
    try { return KanbanService.getActivityLog(taskId, limit); } catch { return []; }
  });

  ipcMain.handle('kanban:approveTask', async (_, id: number) => {
    try { return { success: true, task: KanbanService.approveTask(id) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:rejectTask', async (_, id: number, feedback: string) => {
    try { return { success: true, task: KanbanService.rejectTask(id, feedback) }; }
    catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:searchTasks', async (_, query: string, projectId?: number) => {
    try { return KanbanService.searchTasks(query, projectId); } catch { return []; }
  });

  ipcMain.handle('kanban:addAttachment', async (_, taskId: number, attachment: Record<string, unknown>) => {
    try {
      return { success: true, attachment: KanbanService.addAttachment(taskId, attachment as Parameters<typeof KanbanService.addAttachment>[1]) };
    } catch (e) { return { success: false, error: (e as Error).message }; }
  });

  ipcMain.handle('kanban:getAttachments', async (_, taskId: number) => {
    try { return KanbanService.getAttachments(taskId); } catch { return []; }
  });

  ipcMain.handle('kanban:deleteAttachment', async (_, id: number) => {
    return { success: KanbanService.deleteAttachment(id) };
  });

  ipcMain.handle('kanban:selectFileOrFolder', async (_, options: { title?: string; properties?: string[] }) => {
    const props: Array<'openFile' | 'openDirectory'> = [];
    if (options.properties?.includes('openDirectory')) {
      props.push('openDirectory');
    } else {
      props.push('openFile');
    }
    const result = await dialog.showOpenDialog({ title: options.title || 'Select', properties: props });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, filePath: result.filePaths[0] };
  });

  // Skill setup config handler (skills module removed)
  ipcMain.handle('skills:getSetupConfig', async () => {
    return { found: false };
  });

  // File dialog for skill setup (e.g., uploading credentials files)
  ipcMain.handle(
    'skills:selectFile',
    async (_, options: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
      const result = await dialog.showOpenDialog({
        title: options.title || 'Select File',
        properties: ['openFile'],
        filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      return { success: true, filePath: result.filePaths[0] };
    }
  );

  // Setup command execution (skills module removed)
  ipcMain.handle('skills:runSetupCommand', async () => {
    return { success: false, error: 'Skills module removed', output: '' };
  });

  // Extract text from Office documents (docx, pptx, xlsx, odt, odp, ods, rtf)
  ipcMain.handle('attachment:extract-text', async (_, filePath: string) => {
    const attachmentsDir = path.join(app.getPath('documents'), 'Pocket-agent', 'attachments');
    const resolvedPath = path.resolve(filePath);
    const rel = path.relative(path.resolve(attachmentsDir), resolvedPath);
    const isAllowed = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!isAllowed) {
      console.warn('[IPC] Blocked attachment:extract-text outside attachments dir:', resolvedPath);
      throw new Error('File path must be within attachments directory');
    }
    const { parseOffice } = await import('officeparser');
    const ast = await parseOffice(resolvedPath);
    return ast.toText();
  });
}

// ============ Agent Lifecycle ============

async function initializeAgent(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'pocket-agent.db');

  // Check if we have required API keys
  if (!SettingsManager.hasRequiredKeys()) {
    console.log('[Main] No API keys configured, skipping agent initialization');
    return;
  }

  // Project root (where CLAUDE.md and CLI tools live)
  const projectRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '../..');

  // Agent workspace (isolated working directory for file operations)
  const workspace = ensureAgentWorkspace();

  // Initialize memory (if not already done)
  if (!memory) {
    memory = new MemoryManager(dbPath);
  }

  // Initialize embeddings if OpenAI key is available
  const openaiKey = SettingsManager.get('openai.apiKey');
  if (openaiKey) {
    memory.initializeEmbeddings(openaiKey);
    console.log('[Main] Embeddings enabled with OpenAI');
  } else {
    console.log('[Main] Embeddings disabled (no OpenAI API key)');
  }

  // Build tools config from settings
  const toolsConfig = {
    mcpServers: {},
    computerUse: {
      enabled: false,
      dockerized: true,
      displaySize: { width: 1920, height: 1080 },
    },
    browser: {
      enabled: SettingsManager.getBoolean('browser.enabled'),
      cdpUrl: SettingsManager.get('browser.cdpUrl') || 'http://localhost:9222',
    },
  };

  // Validate model/key match — fall back if selected model has no API key
  let selectedModel = SettingsManager.get('agent.model');
  const providerKeyMap: Record<string, string> = {
    anthropic: 'anthropic.apiKey',
    moonshot: 'moonshot.apiKey',
    glm: 'glm.apiKey',
    minimax: 'minimax.apiKey',
    qwen: 'qwen.apiKey',
    openrouter: 'openrouter.apiKey',
  };
  const modelProviderMap: Record<string, string> = {
    'claude-opus-4-6': 'anthropic',
    'claude-sonnet-4-6': 'anthropic',
    'claude-haiku-4-5-20251001': 'anthropic',
    'kimi-k2.5': 'moonshot',
    'glm-5': 'glm',
    'MiniMax-M2.5': 'minimax',
    'MiniMax-M2.5-Lightning': 'minimax',
    'qwen3.5-plus-2026-02-15': 'qwen',
    'qwen/qwen3.5-plus-02-15': 'openrouter',
    'qwen/qwen3.5-flash': 'openrouter',
  };
  const selectedProvider = modelProviderMap[selectedModel]
    || (String(selectedModel || '').includes('/') ? 'openrouter' : '')
    || (/^qwen/i.test(String(selectedModel || '')) ? 'qwen' : '')
    || 'anthropic';
  const hasOAuth = !!SettingsManager.get('auth.oauthToken');
  const hasSelectedKey = selectedProvider === 'anthropic'
    ? !!(SettingsManager.get('anthropic.apiKey') || hasOAuth)
    : !!SettingsManager.get(providerKeyMap[selectedProvider] || '');

  if (!hasSelectedKey) {
    // Find a provider that has a key
    const fallbackOrder = ['anthropic', 'moonshot', 'glm', 'minimax', 'qwen', 'openrouter'];
    let fallbackModel = '';
    for (const provider of fallbackOrder) {
      const hasKey = provider === 'anthropic'
        ? !!(SettingsManager.get('anthropic.apiKey') || hasOAuth)
        : !!SettingsManager.get(providerKeyMap[provider] || '');
      if (hasKey) {
        const defaultModels: Record<string, string> = {
          anthropic: 'claude-sonnet-4-6',
          moonshot: 'kimi-k2.5',
          glm: 'glm-5',
          minimax: 'MiniMax-M2.5',
          qwen: 'qwen3.5-plus-2026-02-15',
          openrouter: 'openrouter/auto',
        };
        fallbackModel = defaultModels[provider] || '';
        console.warn(`[Main] Model "${selectedModel}" has no API key for provider "${selectedProvider}". Falling back to "${fallbackModel}" (${provider})`);
        break;
      }
    }
    if (fallbackModel) {
      selectedModel = fallbackModel;
    }
  }

  // Initialize agent with tools config
  const selectedMode = (SettingsManager.get('agent.mode') || 'coder').trim().toLowerCase();
  AgentManager.initialize({
    memory,
    projectRoot,
    workspace,  // Isolated working directory for agent file operations
    dataDir: app.getPath('userData'),
    model: selectedModel,
    mode: (selectedMode === 'general' || selectedMode === 'manager') ? 'manager' : 'coder',
    tools: toolsConfig,
  });

  // Initialize scheduler
  if (SettingsManager.getBoolean('scheduler.enabled')) {
    scheduler = createScheduler();
    await scheduler.initialize(memory, dbPath);

    // Set notification handler for scheduler
    scheduler.setNotificationHandler((title: string, body: string) => {
      showNotification(title, body);
    });

    // Set chat handler for scheduler (sends messages to chat window with session context)
    scheduler.setChatHandler((jobName: string, prompt: string, response: string, sessionId: string) => {
      console.log(`[Scheduler] Sending chat message for job: ${jobName} (session: ${sessionId})`);
      // Send to chat window if open, with session context
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send('scheduler:message', { jobName, prompt, response, sessionId });
      }
      // Also open chat window if not open
      if (!chatWindow || chatWindow.isDestroyed()) {
        openChatWindow();
        // Wait a bit for window to load, then send message
        setTimeout(() => {
          try {
            if (chatWindow && !chatWindow.isDestroyed()) {
              chatWindow.webContents.send('scheduler:message', { jobName, prompt, response, sessionId });
            }
          } catch (err) {
            console.error('[Scheduler] Failed to send message to chat window:', err);
          }
        }, 1000);
      }
    });

    // Set up birthday reminders if birthday is configured
    const birthday = SettingsManager.get('profile.birthday');
    if (birthday) {
      await setupBirthdayCronJobs(birthday);
    }
  }

  // Initialize email processor
  if (SettingsManager.getBoolean('gmail.emailProcessing.enabled')) {
    try {
      const { EmailProcessor } = await import('../scheduler/email-processor');
      emailProcessor = new EmailProcessor(dbPath);
      emailProcessor.setNotificationHandler((title: string, body: string) => {
        showNotification(title, body);
      });
      emailProcessor.setProgressHandler((status: string, detail?: Record<string, unknown>) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gmail:progress', { status, ...detail });
        }
      });
      emailProcessor.start();
      console.log('[Main] Email processor started');

      // Start unanswered scan if enabled
      if (SettingsManager.get('gmail.unanswered.enabled') === 'true') {
        try {
          const { UnansweredEngine } = await import('../scheduler/unanswered-engine');
          unansweredEngine = new UnansweredEngine(emailProcessor.getDb());
          unansweredEngine.setNotificationHandler((title: string, body: string) => {
            showNotification(title, body);
          });
          unansweredEngine.setTelegramSender((text: string) => {
            const chatId = SettingsManager.get('telegram.defaultChatId');
            if (chatId && telegramBot) {
              telegramBot.sendMessage(Number(chatId), text).catch((err: unknown) => {
                console.warn('[UnansweredEngine] Telegram send failed:', err);
              });
            }
          });
          const intervalMin = Number(SettingsManager.get('gmail.unanswered.intervalMin') || '60');
          unansweredEngine.startSchedule(intervalMin);
          console.log(`[Main] Unanswered scan started (every ${intervalMin} min)`);
        } catch (uaErr) {
          console.error('[Main] Failed to start unanswered scan:', uaErr);
        }
      }
    } catch (error) {
      console.error('[Main] Failed to start email processor:', error);
    }
  }

  // Initialize Telegram
  const telegramEnabled = SettingsManager.getBoolean('telegram.enabled');
  const telegramToken = SettingsManager.get('telegram.botToken');

  if (telegramEnabled && telegramToken) {
    try {
      telegramBot = createTelegramBot();

      if (!telegramBot) {
        console.error('[Main] Telegram bot creation failed');
      } else {
        // Set up cross-channel sync: Telegram -> Desktop
        // Only send to chat window if it's already open - don't force open or notify
        telegramBot.setOnMessageCallback((data) => {
          // Only sync to desktop UI if chat window is already open
          if (chatWindow && !chatWindow.isDestroyed()) {
            chatWindow.webContents.send('telegram:message', {
              userMessage: data.userMessage,
              response: data.response,
              chatId: data.chatId,
              sessionId: data.sessionId,
              hasAttachment: data.hasAttachment,
              attachmentType: data.attachmentType,
              wasCompacted: data.wasCompacted,
              media: data.media,
            });
          }
          // Messages are already saved to SQLite, so they'll appear when user opens chat
        });

        await telegramBot.start();

        // Register bot commands after a short delay to ensure bot is connected
        // Uses dynamic import + fresh Bot instance to bypass Electron V8 code cache
        setTimeout(async () => {
          try {
            const { Bot } = await import('grammy');
            const { registerBotCommands } = await import('../channels/telegram/handlers/commands');
            const token = SettingsManager.get('telegram.botToken');
            if (token) {
              const tempBot = new Bot(token);
              await registerBotCommands(tempBot);
              console.log('[Main] Telegram commands registered');
            }
          } catch (err) {
            console.error('[Main] Failed to register Telegram commands:', err);
          }
        }, 3000);

        if (scheduler) {
          scheduler.setTelegramBot(telegramBot);
        }
        setResearchTelegramBot(telegramBot);
        setLinkedInTelegramBot(telegramBot);

        // Initialize WAQ for reliable Telegram delivery
        // Access bot via bracket notation — class methods not on prototype at runtime (Electron/ES2022 issue)
        const botApi = (telegramBot as unknown as Record<string, unknown>)['bot'] as import('grammy').Bot | undefined;
        if (!botApi) {
          console.error('[Main] WAQ: Could not get Telegram Bot API instance');
        } else {
          const dispatcher = createTelegramDispatcher(botApi);
          waqManager = new WAQManager(dbPath, dispatcher);
          (telegramBot as unknown as Record<string, unknown>)['waq'] = waqManager.queue;
          waqManager.start();
          console.log('[Main] WAQ processor started');
        }

        console.log('[Main] Telegram started');
      }
    } catch (error) {
      console.error('[Main] Telegram failed:', error);
    }
  }

  console.log('[Main] Pocket Agent initialized');
  updateTrayMenu();
}

async function stopAgent(): Promise<void> {
  if (telegramBot) {
    await telegramBot.stop();
    telegramBot = null;
    setLinkedInTelegramBot(null);
  }
  if (scheduler) {
    scheduler.stopAll();
    scheduler = null;
  }
  if (emailProcessor) {
    emailProcessor.stop();
    emailProcessor = null;
  }
  // Cleanup browser resources
  AgentManager.cleanup();
  console.log('[Main] Agent stopped');
  updateTrayMenu();
}

async function restartAgent(): Promise<void> {
  await stopAgent();
  await initializeAgent();
}

async function recoverAndRetryInterruptedLinkedInDrafts(trigger: 'restart' | 'wake' = 'restart'): Promise<void> {
  try {
    const { recoverInterruptedDrafts, draftBatch, isDraftJobRunning } = await import('../tools/linkedin-drafter');
    if (isDraftJobRunning()) return;

    const recovered = recoverInterruptedDrafts(trigger);
    if (recovered.recoveredCount <= 0 || recovered.recoveredPostIds.length === 0) return;

    const sourceLabel = trigger === 'wake' ? 'after wake' : 'after restart';
    notifyTelegram(`LinkedIn: Recovered ${recovered.recoveredCount} interrupted drafts ${sourceLabel}. Auto-retrying now.`).catch(() => {});

    setTimeout(() => {
      void (async () => {
        try {
          const result = await draftBatch(recovered.recoveredPostIds, 1);
          if (result.errors.length > 0) {
            notifyTelegram(`LinkedIn: Auto-retry completed with ${result.errors.length} issue(s). Check LinkedIn Activity status badges.`).catch(() => {});
          }
        } catch (err) {
          console.warn('[LinkedIn] Auto-retry of recovered drafts failed:', err);
          notifyTelegram('LinkedIn: Auto-retry of recovered drafts failed. Please check LinkedIn Activity.').catch(() => {});
        }
      })();
    }, 2500);
  } catch (err) {
    console.warn('[LinkedIn] Draft recovery check failed:', err);
  }
}

// ============ App Lifecycle ============

app.whenReady().then(async () => {
  console.log('[Main] App ready, starting initialization...');

  try {
    // Show splash screen immediately
    showSplashScreen();

    // === Power Management ===
    // Prevent App Nap from throttling our timers (scheduler, reminders)
    // This keeps the app responsive even when display is off
    let powerBlockerId: number | null = null;

    const startPowerBlocker = () => {
      if (powerBlockerId === null) {
        // 'prevent-app-suspension' keeps timers running accurately
        powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        console.log('[Power] App suspension blocker started');
      }
    };

    const stopPowerBlocker = () => {
      if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
        powerSaveBlocker.stop(powerBlockerId);
        powerBlockerId = null;
        console.log('[Power] App suspension blocker stopped');
      }
    };

    // Start blocker immediately
    startPowerBlocker();

    // Handle system suspend/resume (actual sleep)
    powerMonitor.on('suspend', () => {
      console.log('[Power] System suspending (sleep)');
      // Timers will be paused, nothing we can do
    });

    powerMonitor.on('resume', () => {
      console.log('[Power] System resumed from sleep');
      // Restart power blocker in case it was affected
      startPowerBlocker();
      // Force CDP reconnection — WebSocket is dead after sleep
      getBrowserManager().forceReconnectCdp().catch((err) => {
        console.warn('[Power] CDP reconnect after resume failed:', err);
      });
      // Catch up any cron jobs missed during sleep
      scheduler?.catchUpMissedJobs().catch((err) => {
        console.error('[Power] Failed to catch up missed jobs:', err);
      });
      // Recalculate LinkedIn queue timing after sleep/offline drift
      const rebalance = rebalancePendingSchedules();
      if (rebalance.adjusted > 0) {
        notifyTelegram(`LinkedIn: Rebalanced ${rebalance.adjusted}/${rebalance.total} scheduled posts after wake`).catch(() => {});
      } else {
        const rescheduled = rescheduleStalePosts();
        if (rescheduled > 0) {
          notifyTelegram(`LinkedIn: Rescheduled ${rescheduled} stale posts after wake`).catch(() => {});
        }
      }
      if (rebalance.warning) {
        notifyTelegram(`LinkedIn warning: ${rebalance.warning}`).catch(() => {});
      }
    });

    // Handle lock screen (display off but CPU running)
    powerMonitor.on('lock-screen', () => {
      console.log('[Power] Screen locked');
      // Keep blocker running - this is when App Nap would kick in
    });

    powerMonitor.on('unlock-screen', () => {
      console.log('[Power] Screen unlocked');
      // Force CDP reconnection — connection may have gone stale during lock
      getBrowserManager().forceReconnectCdp().catch((err) => {
        console.warn('[Power] CDP reconnect after unlock failed:', err);
      });
    });

    // Clean up on app quit
    app.on('will-quit', () => {
      stopPowerBlocker();
    });

    // Set Dock icon on macOS
    if (process.platform === 'darwin') {
      const dockIconPath = path.join(__dirname, '../../assets/icon.png');
      if (fs.existsSync(dockIconPath)) {
        app.dock?.setIcon(dockIconPath);
      }
    }

    // Clean up voice/TTS audio files older than 24 hours
    try {
      const voiceDirs = [
        path.join(app.getPath('temp'), 'pocket-agent-voice'),
        path.join(app.getPath('userData'), 'tts-cache'),
      ];
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      const now = Date.now();
      for (const dir of voiceDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        let removed = 0;
        for (const file of files) {
          const filePath = path.join(dir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile() && now - stat.mtimeMs > maxAge) {
              fs.unlinkSync(filePath);
              removed++;
            }
          } catch { /* skip */ }
        }
        if (removed > 0) console.log(`[Voice] Cleaned ${removed} old files from ${path.basename(dir)}`);
      }
    } catch (e) {
      console.warn('[Voice] Cleanup error:', e);
    }

    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'pocket-agent.db');
    console.log('[Main] DB path:', dbPath);

    // Initialize settings first (uses same DB)
    console.log('[Main] Initializing settings...');
    SettingsManager.initialize(dbPath);

    // Migrate from old config.json if it exists
    const oldConfigPath = path.join(userDataPath, 'config.json');
    await SettingsManager.migrateFromConfig(oldConfigPath);
    console.log('[Main] Settings initialized');

    // Initialize memory (shared with settings)
    console.log('[Main] Initializing memory...');
    memory = new MemoryManager(dbPath);
    console.log('[Main] Memory initialized');

    // Auto-create Personal project and migrate legacy tasks
    try {
      KanbanService.getOrCreatePersonalProject();
      migrateTasksToKanban();
    } catch (e) {
      console.warn('[Main] Task consolidation failed (non-fatal):', e);
    }

    try {
      setupIPC();
    } catch (e) {
      console.error('[Main] FATAL: setupIPC failed:', e);
    }
    setupUpdaterIPC();
    console.log('[Main] Creating tray...');
    await createTray();
    console.log('[Main] Tray created');

    // Initialize auto-updater (only in packaged app)
    if (app.isPackaged) {
      initializeUpdater();
      console.log('[Main] Auto-updater initialized');
    }

    // Register global shortcut (Alt+Z on all platforms — maps to Option+Z on macOS)
    const shortcut = 'Alt+Z';
    const registered = globalShortcut.register(shortcut, () => {
      openChatWindow();
    });
    if (registered) {
      console.log(`[Main] Global shortcut ${shortcut} registered`);
    } else {
      console.warn(`[Main] Failed to register global shortcut ${shortcut}`);
    }

    // Check for first run
    if (SettingsManager.isFirstRun()) {
      console.log('[Main] First run detected, showing setup wizard');
      openSetupWindow();
    } else {
      console.log('[Main] Initializing agent...');
      await initializeAgent();
      // Recalculate LinkedIn queue when app starts after downtime
      const startupRebalance = rebalancePendingSchedules();
      if (startupRebalance.adjusted > 0) {
        notifyTelegram(`LinkedIn: Rebalanced ${startupRebalance.adjusted}/${startupRebalance.total} scheduled posts on launch`).catch(() => {});
      } else {
        const staleCount = rescheduleStalePosts();
        if (staleCount > 0) {
          notifyTelegram(`LinkedIn: Rescheduled ${staleCount} stale posts on launch`).catch(() => {});
        }
      }
      if (startupRebalance.warning) {
        notifyTelegram(`LinkedIn warning: ${startupRebalance.warning}`).catch(() => {});
      }
      void recoverAndRetryInterruptedLinkedInDrafts('restart');
      // Open chat window on launch so users see the app
      openChatWindow();
    }

    // Periodic tray update
    setInterval(updateTrayMenu, 30000);
  } catch (error) {
    console.error('[Main] FATAL ERROR during initialization:', error);
  }
});

app.on('window-all-closed', () => {
  // Keep running (tray app)
});

app.on('activate', () => {
  // macOS: clicking Dock icon opens chat window
  openChatWindow();
});

app.on('before-quit', async () => {
  if (app.isReady()) {
    globalShortcut.unregisterAll(); // Clean up global shortcuts
  }
  await stopAgent();
  if (waqManager) {
    await waqManager.stop();
    waqManager = null;
  }
  if (memory) {
    memory.close();
  }
  if (unansweredEngine) {
    unansweredEngine.stopSchedule();
  }
  closeTaskDb(); // Clean up task tools database connection
  closeKanbanDb(); // Clean up kanban database connection
  SettingsManager.close();
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openChatWindow();
  });
}

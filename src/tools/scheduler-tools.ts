/**
 * Scheduler tools for the agent
 *
 * Allows the agent to create, list, and manage scheduled tasks/reminders
 * Supports three schedule types:
 * - cron: Standard cron expressions (e.g., "0 9 * * *")
 * - at: One-time execution (e.g., "tomorrow 3pm", "in 10 minutes")
 * - every: Recurring intervals (e.g., "30m", "2h", "1d")
 */

import { getScheduler } from '../scheduler';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getCurrentSessionId } from './session-context';

function getDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

// Parse schedule string and determine type
function parseSchedule(input: string): {
  type: 'cron' | 'at' | 'every';
  schedule?: string;
  runAt?: string;
  intervalMs?: number;
} | null {
  const trimmed = input.trim();

  // Check for "every" pattern: 30m, 2h, 1d, etc.
  const everyMatch = trimmed.match(/^(?:every\s+)?(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (everyMatch) {
    const [, amount, unit] = everyMatch;
    const num = parseInt(amount, 10);
    let ms: number;
    if (unit.startsWith('m')) ms = num * 60 * 1000;
    else if (unit.startsWith('h')) ms = num * 60 * 60 * 1000;
    else ms = num * 24 * 60 * 60 * 1000;
    return { type: 'every', intervalMs: ms };
  }

  // Check for "at" pattern: specific datetime
  const atTime = parseDateTime(trimmed);
  if (atTime) {
    // If it's a relative/specific time, treat as "at"
    if (trimmed.match(/^(today|tomorrow|in\s+\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)) {
      return { type: 'at', runAt: atTime };
    }
  }

  // Check for cron expression (5 parts)
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5 && validateCron(trimmed)) {
    return { type: 'cron', schedule: trimmed };
  }

  // Try parsing as datetime for "at" type
  if (atTime) {
    return { type: 'at', runAt: atTime };
  }

  return null;
}

// Parse datetime string to ISO format
function parseDateTime(input: string): string | null {
  const now = new Date();

  // "today 3pm", "tomorrow 9am", "monday 2pm"
  const relativeMatch = input.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (relativeMatch) {
    const [, dayStr, hourStr, minStr, ampm] = relativeMatch;
    const targetDate = new Date(now);

    if (dayStr.toLowerCase() === 'tomorrow') {
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (dayStr.toLowerCase() !== 'today') {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.indexOf(dayStr.toLowerCase());
      const currentDay = targetDate.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7;
      targetDate.setDate(targetDate.getDate() + daysToAdd);
    }

    let hour = parseInt(hourStr, 10);
    const min = minStr ? parseInt(minStr, 10) : 0;
    if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;

    targetDate.setHours(hour, min, 0, 0);
    return targetDate.toISOString();
  }

  // "in 2 hours", "in 30 minutes", "in 3 days", "in 3 days at 9am", "in 2 days 3:30pm"
  const inMatch = input.match(/^in\s+(\d+)\s*(hour|hr|minute|min|day|d)s?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (inMatch) {
    const [, amount, unit, timeHour, timeMin, timeAmPm] = inMatch;
    const num = parseInt(amount, 10);
    const unitLower = unit.toLowerCase();

    if (unitLower.startsWith('hour') || unitLower === 'hr') {
      return new Date(now.getTime() + num * 3600000).toISOString();
    }
    if (unitLower.startsWith('min')) {
      return new Date(now.getTime() + num * 60000).toISOString();
    }

    // Days: support optional time-of-day
    const target = new Date(now.getTime() + num * 86400000);
    if (timeHour) {
      let hour = parseInt(timeHour, 10);
      const min = timeMin ? parseInt(timeMin, 10) : 0;
      if (timeAmPm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (timeAmPm?.toLowerCase() === 'am' && hour === 12) hour = 0;
      target.setHours(hour, min, 0, 0);
    }
    return target.toISOString();
  }

  // "feb 14 9am", "march 5 2:30pm", "jan 20"
  const monthDateMatch = input.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (monthDateMatch) {
    const [, monthStr, dayStr, hourStr, minStr, ampm] = monthDateMatch;
    const months: Record<string, number> = {
      jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
      may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
      sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
    };
    const month = months[monthStr.toLowerCase()];
    const day = parseInt(dayStr, 10);
    const target = new Date(now.getFullYear(), month, day);

    // If date is in the past, assume next year
    if (target < now && !hourStr) target.setFullYear(target.getFullYear() + 1);

    if (hourStr) {
      let hour = parseInt(hourStr, 10);
      const min = minStr ? parseInt(minStr, 10) : 0;
      if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;
      target.setHours(hour, min, 0, 0);
      if (target < now) target.setFullYear(target.getFullYear() + 1);
    } else {
      target.setHours(9, 0, 0, 0); // Default to 9am if no time given
    }

    return target.toISOString();
  }

  // Try direct parse (ISO format, etc.)
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime()) && parsed > now) {
    return parsed.toISOString();
  }

  return null;
}

// Validate cron expression
function validateCron(schedule: string): boolean {
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day
    [1, 12],  // month
    [0, 7],   // weekday
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    if (part === '*') continue;
    if (part.includes('/')) continue;
    if (part.includes('-')) continue;
    if (part.includes(',')) continue;

    const num = parseInt(part, 10);
    if (isNaN(num) || num < ranges[i][0] || num > ranges[i][1]) {
      return false;
    }
  }

  return true;
}

// Calculate next run time
function calculateNextRun(type: string, schedule: string | null, runAt: string | null, intervalMs: number | null): string | null {
  const now = new Date();

  if (type === 'at' && runAt) {
    const runDate = new Date(runAt);
    return runDate > now ? runAt : null;
  }

  if (type === 'every' && intervalMs) {
    return new Date(now.getTime() + intervalMs).toISOString();
  }

  if (type === 'cron' && schedule) {
    const parts = schedule.split(/\s+/);
    const [min, hour] = parts;
    const next = new Date(now);
    next.setSeconds(0, 0);

    if (min !== '*') next.setMinutes(parseInt(min, 10));
    if (hour !== '*') next.setHours(parseInt(hour, 10));

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.toISOString();
  }

  return null;
}

function formatDateTime(isoString: string | null): string | null {
  if (!isoString) return null;
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

/**
 * Schedule task tool definition
 */
export function getScheduleTaskToolDefinition() {
  return {
    name: 'schedule_task',
    description: `Create a scheduled routine where the agent performs an ACTION.

Use this for tasks where the agent should DO something (check weather, summarize news, etc).
For simple reminders, use create_reminder instead.

Schedule formats:
- Recurring intervals: "30m", "2h", "1d"
- Cron expressions: "0 9 * * *" (minute hour day month weekday)
- One-time: "in 10 minutes", "in 3 days at 9am", "tomorrow 3pm", "feb 14 9am"

IMPORTANT: The 'prompt' field is an INSTRUCTION that will be sent to a future LLM instance.
Write it as a command, not as formatted output.
- GOOD: "Check the weather and tell the user"
- BAD: "Good morning! Here's your weather: ☀️"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for this scheduled task (e.g., "morning_weather")',
        },
        schedule: {
          type: 'string',
          description: 'When to run: "30m", "2h", "0 9 * * *", "in 10 minutes", "in 3 days at 9am", "tomorrow 3pm", "feb 14 9am"',
        },
        prompt: {
          type: 'string',
          description: 'Instruction for the future LLM. Write as a command like "Check the weather" or "Summarize today\'s news". NOT formatted output.',
        },
        channel: {
          type: 'string',
          description: 'Where to send: "desktop", "telegram", "email", or combos like "desktop,email" (default: desktop)',
        },
      },
      required: ['name', 'schedule', 'prompt'],
    },
  };
}

/**
 * Schedule task tool handler
 * Now supports natural language scheduling in addition to cron
 */
export async function handleScheduleTaskTool(input: unknown): Promise<string> {
  const { name, schedule, prompt, channel } = input as {
    name: string;
    schedule: string;
    prompt: string;
    channel?: string;
  };

  if (!name || !schedule || !prompt) {
    return JSON.stringify({ error: 'Missing required fields: name, schedule, prompt' });
  }

  console.log(`[SchedulerTool] Creating task: ${name} (${schedule})`);

  // Parse the schedule string
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return JSON.stringify({
      error: `Could not parse schedule: "${schedule}"`,
      hint: 'Use: "in 10 minutes", "tomorrow 3pm", "30m", "2h", or cron "0 9 * * *"',
    });
  }

  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
      return JSON.stringify({ error: 'Database not found. Start Pocket Agent first.' });
    }

    const db = new Database(dbPath);

    // Ensure table has the new columns
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN schedule_type TEXT DEFAULT 'cron'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN interval_ms INTEGER`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER DEFAULT 0`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN next_run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN session_id TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN job_type TEXT DEFAULT 'routine'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN status TEXT DEFAULT 'pending'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN fired_at TEXT`);
    } catch { /* column exists */ }

    const sessionId = getCurrentSessionId();

    // Auto-enable delete-after for one-time "at" jobs
    const deleteAfterRun = parsed.type === 'at' ? 1 : 0;

    // Determine default channel: use telegram if configured, otherwise desktop
    let targetChannel = channel;
    if (!targetChannel) {
      // Check if Telegram is configured by looking for activeChatIds in settings
      const telegramSetting = db.prepare(
        "SELECT value FROM settings WHERE key = 'telegram.activeChatIds'"
      ).get() as { value: string } | undefined;

      if (telegramSetting?.value) {
        try {
          const chatIds = JSON.parse(telegramSetting.value);
          if (Array.isArray(chatIds) && chatIds.length > 0) {
            targetChannel = 'telegram';
          }
        } catch {
          // Invalid JSON, fall through to desktop
        }
      }

      if (!targetChannel) {
        targetChannel = 'desktop';
      }
    }

    const nextRunAt = calculateNextRun(
      parsed.type,
      parsed.schedule || null,
      parsed.runAt || null,
      parsed.intervalMs || null
    );

    // Check if exists - update or insert
    const existing = db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(name);

    if (existing) {
      db.prepare(`
        UPDATE cron_jobs SET
          schedule_type = ?, schedule = ?, run_at = ?, interval_ms = ?,
          prompt = ?, channel = ?, enabled = 1,
          delete_after_run = ?, next_run_at = ?, session_id = ?,
          status = 'pending', fired_at = NULL,
          updated_at = datetime('now')
        WHERE name = ?
      `).run(
        parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        prompt, targetChannel, deleteAfterRun, nextRunAt, sessionId, name
      );
    } else {
      db.prepare(`
        INSERT INTO cron_jobs (
          name, schedule_type, schedule, run_at, interval_ms,
          prompt, channel, enabled, delete_after_run, next_run_at, session_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'pending')
      `).run(
        name, parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        prompt, targetChannel, deleteAfterRun, nextRunAt, sessionId
      );
    }

    db.close();

    // Build user-friendly schedule description
    let scheduleDesc: string;
    if (parsed.type === 'at') {
      scheduleDesc = `one-time at ${formatDateTime(parsed.runAt!)}`;
    } else if (parsed.type === 'every') {
      scheduleDesc = `every ${formatDuration(parsed.intervalMs!)}`;
    } else {
      scheduleDesc = `cron: ${parsed.schedule}`;
    }

    console.log(`[SchedulerTool] Task created: ${name} (${parsed.type})`);
    const nextRunFormatted = formatDateTime(nextRunAt);
    return JSON.stringify({
      success: true,
      message: `Scheduled task "${name}" created`,
      VERIFY_DATE: parsed.type === 'at' ? `⚠️ This task will fire at: ${nextRunFormatted}. Double-check this is the correct date and time!` : undefined,
      name,
      type: parsed.type,
      schedule: scheduleDesc,
      next_run: nextRunFormatted,
      next_run_iso: nextRunAt,
      one_time: deleteAfterRun === 1,
      channel: targetChannel,
      session_id: sessionId,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SchedulerTool] Failed to create task: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
}

/**
 * Create reminder tool definition
 */
export function getCreateReminderToolDefinition() {
  return {
    name: 'create_reminder',
    description: `Create a simple reminder to notify the user about something.

Use this when the user says "remind me to..." or "don't let me forget to..."
For action-based tasks (check weather, etc), use schedule_task instead.

Schedule formats:
- One-time: "in 10 minutes", "tomorrow 3pm", "monday 9am", "feb 14 9am"
- One-time with time: "in 3 days at 9am", "in 5 days 2:30pm"
- Recurring: "30m", "2h", or cron "0 9 * * *"

When creating multiple reminders for future dates, ALWAYS specify the time (e.g. "in 3 days at 9am" or "feb 14 9am"), otherwise they fire at the current time of day.

IMPORTANT: The 'reminder' field is the FINAL MESSAGE shown to the user.
Compose a friendly, complete reminder message - it will be displayed directly with NO further LLM processing.
- GOOD: "Hey Ken! Time to take a shower 🚿"
- GOOD: "Don't forget to call mom! 📱"
- BAD: "take a shower" (too minimal)
- BAD: "Remind Ken to take a shower" (this is an instruction, not a message)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for the reminder (e.g., "shower_reminder")',
        },
        schedule: {
          type: 'string',
          description: 'When to remind: "in 10 minutes", "in 3 days at 9am", "tomorrow 3pm", "feb 14 9am", "30m", "2h", or cron "0 9 * * *"',
        },
        reminder: {
          type: 'string',
          description: 'The final message to display. Examples: "Hey Ken! Time to take a shower 🚿", "Don\'t forget to call mom! 📱". Compose a friendly, complete message.',
        },
        channel: {
          type: 'string',
          description: 'Where to send: "desktop", "telegram", "email", or combos like "desktop,email" (default: desktop)',
        },
      },
      required: ['name', 'schedule', 'reminder'],
    },
  };
}

/**
 * Create reminder tool handler
 */
export async function handleCreateReminderTool(input: unknown): Promise<string> {
  const { name, schedule, reminder, channel } = input as {
    name: string;
    schedule: string;
    reminder: string;
    channel?: string;
  };

  if (!name || !schedule || !reminder) {
    return JSON.stringify({ error: 'Missing required fields: name, schedule, reminder' });
  }

  console.log(`[SchedulerTool] Creating reminder: ${name} (${schedule})`);

  // Parse the schedule string
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return JSON.stringify({
      error: `Could not parse schedule: "${schedule}"`,
      hint: 'Use: "in 10 minutes", "tomorrow 3pm", "30m", "2h", or cron "0 9 * * *"',
    });
  }

  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
      return JSON.stringify({ error: 'Database not found. Start Pocket Agent first.' });
    }

    const db = new Database(dbPath);

    // Ensure table has the new columns (including job_type)
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN schedule_type TEXT DEFAULT 'cron'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN interval_ms INTEGER`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER DEFAULT 0`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN next_run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN session_id TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN job_type TEXT DEFAULT 'routine'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN status TEXT DEFAULT 'pending'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN fired_at TEXT`);
    } catch { /* column exists */ }

    const sessionId = getCurrentSessionId();

    // Auto-enable delete-after for one-time "at" jobs
    const deleteAfterRun = parsed.type === 'at' ? 1 : 0;

    // Determine default channel: use telegram if configured, otherwise desktop
    let targetChannel = channel;
    if (!targetChannel) {
      const telegramSetting = db.prepare(
        "SELECT value FROM settings WHERE key = 'telegram.activeChatIds'"
      ).get() as { value: string } | undefined;

      if (telegramSetting?.value) {
        try {
          const chatIds = JSON.parse(telegramSetting.value);
          if (Array.isArray(chatIds) && chatIds.length > 0) {
            targetChannel = 'telegram';
          }
        } catch {
          // Invalid JSON, fall through to desktop
        }
      }

      if (!targetChannel) {
        targetChannel = 'desktop';
      }
    }

    const nextRunAt = calculateNextRun(
      parsed.type,
      parsed.schedule || null,
      parsed.runAt || null,
      parsed.intervalMs || null
    );

    // Check if exists - update or insert
    const existing = db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(name);

    if (existing) {
      db.prepare(`
        UPDATE cron_jobs SET
          schedule_type = ?, schedule = ?, run_at = ?, interval_ms = ?,
          prompt = ?, channel = ?, enabled = 1,
          delete_after_run = ?, next_run_at = ?, session_id = ?, job_type = ?,
          status = 'pending', fired_at = NULL,
          updated_at = datetime('now')
        WHERE name = ?
      `).run(
        parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        reminder, targetChannel, deleteAfterRun, nextRunAt, sessionId, 'reminder', name
      );
    } else {
      db.prepare(`
        INSERT INTO cron_jobs (
          name, schedule_type, schedule, run_at, interval_ms,
          prompt, channel, enabled, delete_after_run, next_run_at, session_id, job_type, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'pending')
      `).run(
        name, parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        reminder, targetChannel, deleteAfterRun, nextRunAt, sessionId, 'reminder'
      );
    }

    db.close();

    // Build user-friendly schedule description
    let scheduleDesc: string;
    if (parsed.type === 'at') {
      scheduleDesc = `one-time at ${formatDateTime(parsed.runAt!)}`;
    } else if (parsed.type === 'every') {
      scheduleDesc = `every ${formatDuration(parsed.intervalMs!)}`;
    } else {
      scheduleDesc = `cron: ${parsed.schedule}`;
    }

    console.log(`[SchedulerTool] Reminder created: ${name} (${parsed.type})`);
    const nextRunFormatted = formatDateTime(nextRunAt);
    return JSON.stringify({
      success: true,
      message: `Reminder "${name}" created`,
      VERIFY_DATE: `⚠️ This reminder will fire at: ${nextRunFormatted}. Double-check this is the correct date and time! If the user asked for a specific day, confirm it matches.`,
      name,
      type: 'reminder',
      schedule: scheduleDesc,
      next_run: nextRunFormatted,
      next_run_iso: nextRunAt,
      one_time: deleteAfterRun === 1,
      channel: targetChannel,
      session_id: sessionId,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SchedulerTool] Failed to create reminder: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
}

/**
 * List scheduled tasks tool definition
 */
export function getListScheduledTasksToolDefinition() {
  return {
    name: 'list_scheduled_tasks',
    description: 'List all scheduled tasks and reminders. Shows name, schedule, and status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

/**
 * List scheduled tasks handler
 */
export async function handleListScheduledTasksTool(): Promise<string> {
  const scheduler = getScheduler();

  if (!scheduler) {
    return JSON.stringify({ error: 'Scheduler not initialized' });
  }

  const jobs = scheduler.getAllJobs();

  if (jobs.length === 0) {
    return JSON.stringify({
      success: true,
      message: 'No scheduled tasks',
      tasks: [],
    });
  }

  const formatJob = (job: typeof jobs[0]) => {
    let scheduleDescription: string;
    if (job.schedule_type === 'at' || (!job.schedule && job.next_run_at)) {
      scheduleDescription = `one-time reminder, fires at ${formatDateTime(job.next_run_at ?? null) || job.next_run_at}`;
    } else if (job.schedule_type === 'every' && job.interval_ms) {
      scheduleDescription = `recurring every ${formatDuration(job.interval_ms)}`;
    } else if (job.schedule) {
      scheduleDescription = `cron: ${job.schedule}`;
    } else {
      scheduleDescription = 'unknown schedule';
    }
    return {
      name: job.name,
      type: job.job_type || 'routine',
      schedule: scheduleDescription,
      next_run: formatDateTime(job.next_run_at ?? null) || job.next_run_at || null,
      prompt: job.prompt,
      channel: job.channel,
      enabled: job.enabled,
      status: job.status || 'pending',
    };
  };

  const activeRoutines = jobs.filter(j => (j.job_type || 'routine') === 'routine' && j.enabled).map(formatJob);
  const upcomingReminders = jobs.filter(j => j.job_type === 'reminder' && j.enabled && (!j.status || j.status === 'pending')).map(formatJob);
  const firedReminders = jobs.filter(j => j.job_type === 'reminder' && j.status === 'fired').map(formatJob);
  const staleReminders = jobs.filter(j => j.status === 'stale').map(formatJob);
  const acknowledged = jobs.filter(j => j.status === 'acknowledged').map(formatJob);
  const disabledRoutines = jobs.filter(j => (j.job_type || 'routine') === 'routine' && !j.enabled).map(formatJob);

  return JSON.stringify({
    success: true,
    count: jobs.length,
    active_routines: activeRoutines,
    upcoming_reminders: upcomingReminders,
    fired_reminders: firedReminders,
    stale_reminders: staleReminders,
    acknowledged,
    disabled_routines: disabledRoutines,
  });
}

/**
 * Delete scheduled task tool definition
 */
export function getDeleteScheduledTaskToolDefinition() {
  return {
    name: 'delete_scheduled_task',
    description: 'Archive a scheduled task or reminder by name. The task is disabled and preserved for future reference, never permanently deleted.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of the task to delete',
        },
      },
      required: ['name'],
    },
  };
}

/**
 * Delete scheduled task handler
 */
export async function handleDeleteScheduledTaskTool(input: unknown): Promise<string> {
  const scheduler = getScheduler();

  if (!scheduler) {
    return JSON.stringify({ error: 'Scheduler not initialized' });
  }

  const { name } = input as { name: string };

  if (!name) {
    return JSON.stringify({ error: 'Task name is required' });
  }

  const success = scheduler.deleteJob(name);

  if (success) {
    console.log(`[SchedulerTool] Archived task: ${name}`);
    return JSON.stringify({
      success: true,
      message: `Task "${name}" archived`,
    });
  } else {
    return JSON.stringify({
      success: false,
      error: `Task "${name}" not found`,
    });
  }
}

/**
 * Acknowledge reminder tool definition
 */
export function getAcknowledgeReminderToolDefinition() {
  return {
    name: 'acknowledge_reminder',
    description: `Mark a one-time reminder as acknowledged/done. This stops the follow-up pings.

Use this when the user confirms they've seen/handled a reminder (e.g., "got it", "done", "thanks for reminding me").
The reminder is archived (not deleted) so it can be reviewed later.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of the reminder to acknowledge',
        },
      },
      required: ['name'],
    },
  };
}

/**
 * Acknowledge reminder handler - archives the reminder
 */
export async function handleAcknowledgeReminderTool(input: unknown): Promise<string> {
  const { name } = input as { name: string };

  if (!name) {
    return JSON.stringify({ error: 'Reminder name is required' });
  }

  try {
    const dbPath = getDbPath();
    const db = new Database(dbPath);

    const job = db.prepare('SELECT id, name, job_type FROM cron_jobs WHERE name = ?').get(name) as { id: number; name: string; job_type: string } | undefined;

    if (!job) {
      db.close();
      return JSON.stringify({ success: false, error: `Reminder "${name}" not found` });
    }

    // Ensure status column exists
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN status TEXT DEFAULT 'pending'`);
    } catch { /* column exists */ }

    // Archive: disable, clear next_run_at, set status to acknowledged
    db.prepare(`
      UPDATE cron_jobs SET enabled = 0, next_run_at = NULL, status = 'acknowledged', updated_at = datetime('now')
      WHERE name = ?
    `).run(name);

    db.close();

    console.log(`[SchedulerTool] Acknowledged reminder: ${name}`);
    return JSON.stringify({
      success: true,
      message: `Reminder "${name}" acknowledged and archived. No more follow-up pings.`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: errorMsg });
  }
}

/**
 * Get all scheduler tools
 */
export function getSchedulerTools() {
  return [
    {
      ...getScheduleTaskToolDefinition(),
      handler: handleScheduleTaskTool,
    },
    {
      ...getCreateReminderToolDefinition(),
      handler: handleCreateReminderTool,
    },
    {
      ...getAcknowledgeReminderToolDefinition(),
      handler: handleAcknowledgeReminderTool,
    },
    {
      ...getListScheduledTasksToolDefinition(),
      handler: handleListScheduledTasksTool,
    },
    {
      ...getDeleteScheduledTaskToolDefinition(),
      handler: handleDeleteScheduledTaskTool,
    },
  ];
}

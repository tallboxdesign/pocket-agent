/**
 * Calendar tools for the agent
 *
 * MCP tools for managing calendar events with reminders
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getCurrentSessionId } from './session-context';

// Shared database connection (singleton pattern for connection pooling)
let sharedDb: Database.Database | null = null;
let dbInitialized = false;

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

/**
 * Get shared database connection (creates if needed)
 */
function getDb(): Database.Database | null {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  if (sharedDb && !dbInitialized) {
    ensureTable(sharedDb);
    dbInitialized = true;
    return sharedDb;
  }

  if (sharedDb) {
    return sharedDb;
  }

  sharedDb = new Database(dbPath);
  ensureTable(sharedDb);
  dbInitialized = true;
  return sharedDb;
}

/**
 * Close the shared database connection (call on app shutdown)
 */
export function closeCalendarDb(): void {
  if (sharedDb) {
    try {
      sharedDb.close();
    } catch {
      // Ignore close errors
    }
    sharedDb = null;
    dbInitialized = false;
  }
}

function parseDateTime(input: string): string | null {
  const now = new Date();

  // "today 3pm", "tomorrow 9am", "monday 2pm"
  const relativeMatch = input.match(
    /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i
  );
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

  // "in 2 hours", "in 30 minutes"
  const inMatch = input.match(/^in\s+(\d+)\s+(hour|minute|min|day)s?$/i);
  if (inMatch) {
    const [, amount, unit] = inMatch;
    const ms =
      parseInt(amount, 10) *
      (unit.toLowerCase().startsWith('hour')
        ? 3600000
        : unit.toLowerCase().startsWith('min')
          ? 60000
          : 86400000);
    return new Date(now.getTime() + ms).toISOString();
  }

  // Try direct parse (ISO format, etc.)
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

function formatDateTime(isoString: string): string {
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

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      all_day INTEGER DEFAULT 0,
      location TEXT,
      reminder_minutes INTEGER DEFAULT 15,
      reminded INTEGER DEFAULT 0,
      channel TEXT DEFAULT 'desktop',
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_time);
    CREATE INDEX IF NOT EXISTS idx_calendar_session ON calendar_events(session_id);
  `);
}

// ============================================================================
// Calendar Add Tool
// ============================================================================

export function getCalendarAddToolDefinition() {
  return {
    name: 'calendar_add',
    description: 'Add a calendar event with optional reminder. Time formats: "today 3pm", "tomorrow 9am", "in 2 hours", or ISO.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_time: { type: 'string', description: 'Start time (e.g., "tomorrow 2pm", "in 1 hour")' },
        end_time: { type: 'string', description: 'Optional end time' },
        location: { type: 'string', description: 'Optional location' },
        description: { type: 'string', description: 'Optional description' },
        reminder_minutes: { type: 'number', description: 'Minutes before to remind (default: 15)' },
      },
      required: ['title', 'start_time'],
    },
  };
}

export async function handleCalendarAddTool(input: unknown): Promise<string> {
  const params = input as {
    title: string;
    start_time: string;
    end_time?: string;
    location?: string;
    description?: string;
    reminder_minutes?: number;
  };

  if (!params.title || !params.start_time) {
    return JSON.stringify({ error: 'title and start_time are required' });
  }

  const startTime = parseDateTime(params.start_time);
  if (!startTime) {
    return JSON.stringify({ error: `Could not parse start time: "${params.start_time}"` });
  }

  const endTime = params.end_time ? parseDateTime(params.end_time) : null;
  const reminderMinutes = params.reminder_minutes ?? 15;
  // Channel is always 'desktop' - routing broadcasts to all configured channels
  const channel = 'desktop';

  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found. Start Pocket Agent first.' });
  }

  const sessionId = getCurrentSessionId();

  const result = db.prepare(`
    INSERT INTO calendar_events (title, description, start_time, end_time, location, reminder_minutes, channel, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.title, params.description || null, startTime, endTime, params.location || null, reminderMinutes, channel, sessionId);

  return JSON.stringify({
    success: true,
    id: result.lastInsertRowid,
    title: params.title,
    start_time: formatDateTime(startTime),
    reminder_minutes: reminderMinutes,
    channel,
    session_id: sessionId,
  });
}

// ============================================================================
// Calendar List Tool
// ============================================================================

export function getCalendarListToolDefinition() {
  return {
    name: 'calendar_list',
    description: 'List calendar events. Optionally filter by date ("today", "tomorrow", or YYYY-MM-DD).',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Filter by date: "today", "tomorrow", or YYYY-MM-DD' },
      },
      required: [],
    },
  };
}

export async function handleCalendarListTool(input: unknown): Promise<string> {
  const params = input as { date?: string };

  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found' });
  }

  const sessionId = getCurrentSessionId();

  let query = 'SELECT * FROM calendar_events WHERE session_id = ?';
  const queryParams: (string | null)[] = [sessionId];

  if (params.date) {
    const filterDate =
      params.date.toLowerCase() === 'today'
        ? new Date().toISOString().split('T')[0]
        : params.date.toLowerCase() === 'tomorrow'
          ? new Date(Date.now() + 86400000).toISOString().split('T')[0]
          : params.date;

    query += ' AND date(start_time) = date(?)';
    queryParams.push(filterDate);
  }

  query += ' ORDER BY start_time ASC';

  const events = db.prepare(query).all(...queryParams) as Array<{
    id: number;
    title: string;
    start_time: string;
    end_time: string | null;
    location: string | null;
    reminder_minutes: number;
  }>;

  return JSON.stringify({
    success: true,
    count: events.length,
    events: events.map(e => ({
      id: e.id,
      title: e.title,
      start: formatDateTime(e.start_time),
      end: e.end_time ? formatDateTime(e.end_time) : null,
      location: e.location,
      reminder: `${e.reminder_minutes} min before`,
    })),
  });
}

// ============================================================================
// Calendar Upcoming Tool
// ============================================================================

export function getCalendarUpcomingToolDefinition() {
  return {
    name: 'calendar_upcoming',
    description: 'Get upcoming calendar events within the next N hours (default: 24).',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: { type: 'number', description: 'Hours to look ahead (default: 24)' },
      },
      required: [],
    },
  };
}

export async function handleCalendarUpcomingTool(input: unknown): Promise<string> {
  const params = input as { hours?: number };
  const hours = params.hours ?? 24;

  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found' });
  }

  const sessionId = getCurrentSessionId();
  const now = new Date();
  const later = new Date(now.getTime() + hours * 3600000);

  const events = db.prepare(`
    SELECT * FROM calendar_events
    WHERE session_id = ? AND start_time >= ? AND start_time <= ?
    ORDER BY start_time ASC
  `).all(sessionId, now.toISOString(), later.toISOString()) as Array<{
    id: number;
    title: string;
    start_time: string;
    location: string | null;
  }>;

  return JSON.stringify({
    success: true,
    hours,
    count: events.length,
    events: events.map(e => ({
      id: e.id,
      title: e.title,
      start: formatDateTime(e.start_time),
      location: e.location,
    })),
  });
}

// ============================================================================
// Calendar Delete Tool
// ============================================================================

export function getCalendarDeleteToolDefinition() {
  return {
    name: 'calendar_delete',
    description: 'Delete a calendar event by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Event ID to delete' },
      },
      required: ['id'],
    },
  };
}

export async function handleCalendarDeleteTool(input: unknown): Promise<string> {
  const params = input as { id: number };

  if (!params.id) {
    return JSON.stringify({ error: 'id is required' });
  }

  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found' });
  }

  const result = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(params.id);
  if (result.changes > 0) {
    return JSON.stringify({ success: true, message: `Event ${params.id} deleted` });
  } else {
    return JSON.stringify({ success: false, error: `Event ${params.id} not found` });
  }
}

// ============================================================================
// Export all calendar tools
// ============================================================================

export function getCalendarTools() {
  return [
    { ...getCalendarAddToolDefinition(), handler: handleCalendarAddTool },
    { ...getCalendarListToolDefinition(), handler: handleCalendarListTool },
    { ...getCalendarUpcomingToolDefinition(), handler: handleCalendarUpcomingTool },
    { ...getCalendarDeleteToolDefinition(), handler: handleCalendarDeleteTool },
  ];
}

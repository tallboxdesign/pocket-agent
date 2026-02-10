#!/usr/bin/env node
/**
 * CLI for Calendar Management
 *
 * Usage:
 *   node dist/cli/calendar-cli.js add <title> <start_time> [options]
 *   node dist/cli/calendar-cli.js list [date]
 *   node dist/cli/calendar-cli.js upcoming [hours]
 *   node dist/cli/calendar-cli.js delete <id>
 *   node dist/cli/calendar-cli.js update <id> <field> <value>
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

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

// Parse datetime string to ISO format
function parseDateTime(input: string): string | null {
  // Handle relative times
  const now = new Date();

  // "today 3pm", "tomorrow 9am", "monday 2pm"
  const relativeMatch = input.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (relativeMatch) {
    const [, dayStr, hourStr, minStr, ampm] = relativeMatch;
    let targetDate = new Date(now);

    if (dayStr.toLowerCase() === 'tomorrow') {
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (dayStr.toLowerCase() !== 'today') {
      // Day of week
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
    const ms = parseInt(amount, 10) * (
      unit.toLowerCase().startsWith('hour') ? 3600000 :
      unit.toLowerCase().startsWith('min') ? 60000 :
      86400000
    );
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

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(JSON.stringify({
      error: 'Usage: calendar-cli <add|list|upcoming|delete|update> [args]',
      commands: {
        add: 'calendar-cli add "<title>" "<start_time>" [--end "<end_time>"] [--reminder <minutes>] [--location "<location>"]',
        list: 'calendar-cli list [date]',
        upcoming: 'calendar-cli upcoming [hours]',
        delete: 'calendar-cli delete <id>',
        update: 'calendar-cli update <id> <field> <value>',
      },
      examples: {
        'Add event': 'calendar-cli add "Team meeting" "tomorrow 2pm" --reminder 15',
        'Add with end': 'calendar-cli add "Lunch" "today 12pm" --end "today 1pm"',
        'List today': 'calendar-cli list today',
        'Next 24h': 'calendar-cli upcoming 24',
      },
    }));
    process.exit(1);
  }

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.log(JSON.stringify({ error: 'Database not found. Please start Pocket Agent first.' }));
    process.exit(1);
  }

  const db = new Database(dbPath);

  // Ensure table exists
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_time);
  `);

  try {
    switch (command) {
      case 'add': {
        const [, title, startTimeStr] = args;

        if (!title || !startTimeStr) {
          console.log(JSON.stringify({ error: 'Usage: add "<title>" "<start_time>" [options]' }));
          process.exit(1);
        }

        const startTime = parseDateTime(startTimeStr);
        if (!startTime) {
          console.log(JSON.stringify({ error: `Could not parse start time: "${startTimeStr}"` }));
          process.exit(1);
        }

        // Parse optional args
        let endTime: string | null = null;
        let reminderMinutes = 15;
        let location: string | null = null;
        let description: string | null = null;
        let channel = 'desktop';

        for (let i = 3; i < args.length; i++) {
          if (args[i] === '--end' && args[i + 1]) {
            endTime = parseDateTime(args[++i]);
          } else if (args[i] === '--reminder' && args[i + 1]) {
            reminderMinutes = parseInt(args[++i], 10);
          } else if (args[i] === '--location' && args[i + 1]) {
            location = args[++i];
          } else if (args[i] === '--description' && args[i + 1]) {
            description = args[++i];
          } else if (args[i] === '--channel' && args[i + 1]) {
            channel = args[++i];
          }
        }

        const result = db.prepare(`
          INSERT INTO calendar_events (title, description, start_time, end_time, location, reminder_minutes, channel)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(title, description, startTime, endTime, location, reminderMinutes, channel);

        console.log(JSON.stringify({
          success: true,
          id: result.lastInsertRowid,
          title,
          start_time: formatDateTime(startTime),
          reminder_minutes: reminderMinutes,
          channel,
        }));
        break;
      }

      case 'list': {
        const [, dateFilter] = args;
        let query = 'SELECT * FROM calendar_events WHERE 1=1';
        const params: string[] = [];

        if (dateFilter) {
          const filterDate = dateFilter.toLowerCase() === 'today'
            ? new Date().toISOString().split('T')[0]
            : dateFilter.toLowerCase() === 'tomorrow'
            ? new Date(Date.now() + 86400000).toISOString().split('T')[0]
            : dateFilter;

          query += ' AND date(start_time) = date(?)';
          params.push(filterDate);
        }

        query += ' ORDER BY start_time ASC';

        const events = db.prepare(query).all(...params) as Array<{
          id: number;
          title: string;
          description: string | null;
          start_time: string;
          end_time: string | null;
          location: string | null;
          reminder_minutes: number;
          channel: string;
        }>;

        console.log(JSON.stringify({
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
        }));
        break;
      }

      case 'upcoming': {
        const hours = parseInt(args[1] || '24', 10);
        const now = new Date();
        const later = new Date(now.getTime() + hours * 3600000);

        const events = db.prepare(`
          SELECT * FROM calendar_events
          WHERE start_time >= ? AND start_time <= ?
          ORDER BY start_time ASC
        `).all(now.toISOString(), later.toISOString()) as Array<{
          id: number;
          title: string;
          start_time: string;
          location: string | null;
        }>;

        console.log(JSON.stringify({
          success: true,
          hours,
          count: events.length,
          events: events.map(e => ({
            id: e.id,
            title: e.title,
            start: formatDateTime(e.start_time),
            location: e.location,
          })),
        }));
        break;
      }

      case 'delete': {
        const id = parseInt(args[1], 10);
        if (!id) {
          console.log(JSON.stringify({ error: 'Usage: delete <id>' }));
          process.exit(1);
        }

        const result = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
        if (result.changes > 0) {
          console.log(JSON.stringify({ success: true, message: `Event ${id} deleted` }));
        } else {
          console.log(JSON.stringify({ success: false, error: `Event ${id} not found` }));
        }
        break;
      }

      case 'update': {
        const [, idStr, field, ...valueParts] = args;
        const id = parseInt(idStr, 10);
        const value = valueParts.join(' ');

        if (!id || !field || !value) {
          console.log(JSON.stringify({ error: 'Usage: update <id> <field> <value>' }));
          process.exit(1);
        }

        const validFields = ['title', 'description', 'start_time', 'end_time', 'location', 'reminder_minutes', 'channel'];
        if (!validFields.includes(field)) {
          console.log(JSON.stringify({ error: `Invalid field. Valid: ${validFields.join(', ')}` }));
          process.exit(1);
        }

        let finalValue: string | number = value;
        if (field === 'start_time' || field === 'end_time') {
          const parsed = parseDateTime(value);
          if (!parsed) {
            console.log(JSON.stringify({ error: `Could not parse time: "${value}"` }));
            process.exit(1);
          }
          finalValue = parsed;
        } else if (field === 'reminder_minutes') {
          finalValue = parseInt(value, 10);
        }

        const result = db.prepare(`UPDATE calendar_events SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(finalValue, id);

        if (result.changes > 0) {
          console.log(JSON.stringify({ success: true, message: `Event ${id} updated`, field, value: finalValue }));
        } else {
          console.log(JSON.stringify({ success: false, error: `Event ${id} not found` }));
        }
        break;
      }

      default:
        console.log(JSON.stringify({ error: `Unknown command: ${command}` }));
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ error: error.message }));
  process.exit(1);
});

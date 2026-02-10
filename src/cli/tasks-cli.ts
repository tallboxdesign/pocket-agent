#!/usr/bin/env node
/**
 * CLI for Task Management
 *
 * Usage:
 *   node dist/cli/tasks-cli.js add <title> [options]
 *   node dist/cli/tasks-cli.js list [status]
 *   node dist/cli/tasks-cli.js complete <id>
 *   node dist/cli/tasks-cli.js delete <id>
 *   node dist/cli/tasks-cli.js update <id> <field> <value>
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
  const now = new Date();

  // "today", "tomorrow", "monday", etc.
  const dayMatch = input.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (dayMatch) {
    const [, dayStr, hourStr, minStr, ampm] = dayMatch;
    let targetDate = new Date(now);

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

    if (hourStr) {
      let hour = parseInt(hourStr, 10);
      const min = minStr ? parseInt(minStr, 10) : 0;
      if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;
      targetDate.setHours(hour, min, 0, 0);
    } else {
      targetDate.setHours(23, 59, 0, 0); // End of day
    }

    return targetDate.toISOString();
  }

  // "in X days/hours"
  const inMatch = input.match(/^in\s+(\d+)\s+(day|hour|week)s?$/i);
  if (inMatch) {
    const [, amount, unit] = inMatch;
    const ms = parseInt(amount, 10) * (
      unit.toLowerCase() === 'hour' ? 3600000 :
      unit.toLowerCase() === 'week' ? 604800000 :
      86400000
    );
    return new Date(now.getTime() + ms).toISOString();
  }

  // Try direct parse
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

function formatDateTime(isoString: string | null): string | null {
  if (!isoString) return null;
  const date = new Date(isoString);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) {
    return `Today ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  }
  if (isTomorrow) {
    return `Tomorrow ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  }

  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function getPriorityEmoji(priority: string): string {
  switch (priority) {
    case 'high': return '!!!';
    case 'medium': return '!!';
    case 'low': return '!';
    default: return '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(JSON.stringify({
      error: 'Usage: tasks-cli <add|list|complete|delete|update> [args]',
      commands: {
        add: 'tasks-cli add "<title>" [--due "<date>"] [--priority low|medium|high] [--reminder <minutes>]',
        list: 'tasks-cli list [pending|completed|all]',
        complete: 'tasks-cli complete <id>',
        delete: 'tasks-cli delete <id>',
        update: 'tasks-cli update <id> <field> <value>',
      },
      examples: {
        'Add task': 'tasks-cli add "Buy groceries" --due "tomorrow" --priority high',
        'Add with reminder': 'tasks-cli add "Call mom" --due "today 5pm" --reminder 30',
        'List pending': 'tasks-cli list pending',
        'Complete task': 'tasks-cli complete 1',
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
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
      reminder_minutes INTEGER,
      reminded INTEGER DEFAULT 0,
      channel TEXT DEFAULT 'desktop',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);

  try {
    switch (command) {
      case 'add': {
        const [, title] = args;

        if (!title) {
          console.log(JSON.stringify({ error: 'Usage: add "<title>" [options]' }));
          process.exit(1);
        }

        // Parse optional args
        let dueDate: string | null = null;
        let priority = 'medium';
        let reminderMinutes: number | null = null;
        let description: string | null = null;
        let channel = 'desktop';

        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--due' && args[i + 1]) {
            dueDate = parseDateTime(args[++i]);
          } else if (args[i] === '--priority' && args[i + 1]) {
            priority = args[++i].toLowerCase();
            if (!['low', 'medium', 'high'].includes(priority)) {
              console.log(JSON.stringify({ error: 'Priority must be: low, medium, or high' }));
              process.exit(1);
            }
          } else if (args[i] === '--reminder' && args[i + 1]) {
            reminderMinutes = parseInt(args[++i], 10);
          } else if (args[i] === '--description' && args[i + 1]) {
            description = args[++i];
          } else if (args[i] === '--channel' && args[i + 1]) {
            channel = args[++i];
          }
        }

        const result = db.prepare(`
          INSERT INTO tasks (title, description, due_date, priority, reminder_minutes, channel)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(title, description, dueDate, priority, reminderMinutes, channel);

        console.log(JSON.stringify({
          success: true,
          id: result.lastInsertRowid,
          title,
          due: dueDate ? formatDateTime(dueDate) : null,
          priority,
          reminder_minutes: reminderMinutes,
        }));
        break;
      }

      case 'list': {
        const [, statusFilter = 'pending'] = args;
        let query = 'SELECT * FROM tasks';
        const params: string[] = [];

        if (statusFilter !== 'all') {
          query += ' WHERE status = ?';
          params.push(statusFilter);
        }

        query += " ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC NULLS LAST";

        const tasks = db.prepare(query).all(...params) as Array<{
          id: number;
          title: string;
          due_date: string | null;
          priority: string;
          status: string;
          reminder_minutes: number | null;
        }>;

        console.log(JSON.stringify({
          success: true,
          filter: statusFilter,
          count: tasks.length,
          tasks: tasks.map(t => ({
            id: t.id,
            title: t.title,
            due: formatDateTime(t.due_date),
            priority: `${getPriorityEmoji(t.priority)} ${t.priority}`,
            status: t.status,
            reminder: t.reminder_minutes ? `${t.reminder_minutes} min before` : null,
          })),
        }));
        break;
      }

      case 'complete': {
        const id = parseInt(args[1], 10);
        if (!id) {
          console.log(JSON.stringify({ error: 'Usage: complete <id>' }));
          process.exit(1);
        }

        const result = db.prepare(`
          UPDATE tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?
        `).run(id);

        if (result.changes > 0) {
          console.log(JSON.stringify({ success: true, message: `Task ${id} completed` }));
        } else {
          console.log(JSON.stringify({ success: false, error: `Task ${id} not found` }));
        }
        break;
      }

      case 'start': {
        const id = parseInt(args[1], 10);
        if (!id) {
          console.log(JSON.stringify({ error: 'Usage: start <id>' }));
          process.exit(1);
        }

        const result = db.prepare(`
          UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?
        `).run(id);

        if (result.changes > 0) {
          console.log(JSON.stringify({ success: true, message: `Task ${id} started` }));
        } else {
          console.log(JSON.stringify({ success: false, error: `Task ${id} not found` }));
        }
        break;
      }

      case 'delete': {
        const id = parseInt(args[1], 10);
        if (!id) {
          console.log(JSON.stringify({ error: 'Usage: delete <id>' }));
          process.exit(1);
        }

        const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        if (result.changes > 0) {
          console.log(JSON.stringify({ success: true, message: `Task ${id} deleted` }));
        } else {
          console.log(JSON.stringify({ success: false, error: `Task ${id} not found` }));
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

        const validFields = ['title', 'description', 'due_date', 'priority', 'status', 'reminder_minutes', 'channel'];
        if (!validFields.includes(field)) {
          console.log(JSON.stringify({ error: `Invalid field. Valid: ${validFields.join(', ')}` }));
          process.exit(1);
        }

        let finalValue: string | number = value;
        if (field === 'due_date') {
          const parsed = parseDateTime(value);
          if (!parsed) {
            console.log(JSON.stringify({ error: `Could not parse date: "${value}"` }));
            process.exit(1);
          }
          finalValue = parsed;
        } else if (field === 'reminder_minutes') {
          finalValue = parseInt(value, 10);
        } else if (field === 'priority' && !['low', 'medium', 'high'].includes(value)) {
          console.log(JSON.stringify({ error: 'Priority must be: low, medium, or high' }));
          process.exit(1);
        } else if (field === 'status' && !['pending', 'in_progress', 'completed'].includes(value)) {
          console.log(JSON.stringify({ error: 'Status must be: pending, in_progress, or completed' }));
          process.exit(1);
        }

        const result = db.prepare(`UPDATE tasks SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(finalValue, id);

        if (result.changes > 0) {
          console.log(JSON.stringify({ success: true, message: `Task ${id} updated`, field, value: finalValue }));
        } else {
          console.log(JSON.stringify({ success: false, error: `Task ${id} not found` }));
        }
        break;
      }

      case 'due': {
        // Show tasks due soon
        const hours = parseInt(args[1] || '24', 10);
        const now = new Date();
        const later = new Date(now.getTime() + hours * 3600000);

        const tasks = db.prepare(`
          SELECT * FROM tasks
          WHERE status != 'completed' AND due_date IS NOT NULL AND due_date <= ?
          ORDER BY due_date ASC
        `).all(later.toISOString()) as Array<{
          id: number;
          title: string;
          due_date: string;
          priority: string;
          status: string;
        }>;

        // Split into overdue and upcoming
        const overdue = tasks.filter(t => new Date(t.due_date) < now);
        const upcoming = tasks.filter(t => new Date(t.due_date) >= now);

        console.log(JSON.stringify({
          success: true,
          hours,
          overdue: overdue.map(t => ({
            id: t.id,
            title: t.title,
            due: formatDateTime(t.due_date),
            priority: t.priority,
          })),
          upcoming: upcoming.map(t => ({
            id: t.id,
            title: t.title,
            due: formatDateTime(t.due_date),
            priority: t.priority,
          })),
        }));
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

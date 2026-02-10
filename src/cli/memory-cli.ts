#!/usr/bin/env node
/**
 * CLI for Memory Management
 *
 * Can be called by the agent via Bash to save/retrieve facts.
 * Writes directly to SQLite - fast, local, no API calls.
 *
 * Usage:
 *   node dist/cli/memory-cli.js save <category> <subject> <content>
 *   node dist/cli/memory-cli.js list [category]
 *   node dist/cli/memory-cli.js delete <category> <subject>
 *   node dist/cli/memory-cli.js search <query>
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Get database path
function getDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'), // macOS
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'), // Linux
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'), // Windows
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return possiblePaths[0];
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(JSON.stringify({
      error: 'Usage: memory-cli <save|list|delete|search> [args]',
      commands: {
        save: 'memory-cli save <category> <subject> <content>',
        list: 'memory-cli list [category]',
        delete: 'memory-cli delete <category> <subject>',
        search: 'memory-cli search <query>',
      },
      categories: ['user_info', 'preferences', 'projects', 'people', 'work', 'notes', 'decisions'],
    }));
    process.exit(1);
  }

  const dbPath = getDbPath();

  if (!fs.existsSync(dbPath)) {
    console.log(JSON.stringify({ error: 'Database not found. Please start Pocket Agent first.' }));
    process.exit(1);
  }

  const db = new Database(dbPath);

  try {
    switch (command) {
      case 'save': {
        const [, category, subject, content] = args;

        if (!category || !subject || !content) {
          console.log(JSON.stringify({ error: 'Usage: save <category> <subject> <content>' }));
          process.exit(1);
        }

        const validCategories = ['user_info', 'preferences', 'projects', 'people', 'work', 'notes', 'decisions'];
        if (!validCategories.includes(category)) {
          console.log(JSON.stringify({
            error: `Invalid category: "${category}"`,
            validCategories,
          }));
          process.exit(1);
        }

        // Check if exists (update) or insert
        const existing = db.prepare('SELECT id FROM facts WHERE category = ? AND subject = ?').get(category, subject) as { id: number } | undefined;

        if (existing) {
          db.prepare('UPDATE facts SET content = ?, updated_at = datetime("now") WHERE id = ?')
            .run(content, existing.id);
          console.log(JSON.stringify({
            success: true,
            action: 'updated',
            id: existing.id,
            category,
            subject,
          }));
        } else {
          const result = db.prepare('INSERT INTO facts (category, subject, content) VALUES (?, ?, ?)')
            .run(category, subject, content);
          console.log(JSON.stringify({
            success: true,
            action: 'created',
            id: result.lastInsertRowid,
            category,
            subject,
          }));
        }
        break;
      }

      case 'list': {
        const [, category] = args;

        let facts;
        if (category) {
          facts = db.prepare('SELECT id, category, subject, content FROM facts WHERE category = ? ORDER BY updated_at DESC')
            .all(category);
        } else {
          facts = db.prepare('SELECT id, category, subject, content FROM facts ORDER BY category, updated_at DESC')
            .all();
        }

        if (facts.length === 0) {
          console.log(JSON.stringify({
            success: true,
            message: category ? `No facts in category: ${category}` : 'No facts stored yet',
            count: 0,
            facts: [],
          }));
        } else {
          console.log(JSON.stringify({
            success: true,
            count: facts.length,
            facts,
          }));
        }
        break;
      }

      case 'delete': {
        const [, category, subject] = args;

        if (!category || !subject) {
          console.log(JSON.stringify({ error: 'Usage: delete <category> <subject>' }));
          process.exit(1);
        }

        const result = db.prepare('DELETE FROM facts WHERE category = ? AND subject = ?').run(category, subject);

        if (result.changes > 0) {
          console.log(JSON.stringify({ success: true, message: `Deleted: ${category}/${subject}` }));
        } else {
          console.log(JSON.stringify({ success: false, error: `Fact not found: ${category}/${subject}` }));
        }
        break;
      }

      case 'search': {
        const [, ...queryParts] = args;
        const query = queryParts.join(' ');

        if (!query) {
          console.log(JSON.stringify({ error: 'Usage: search <query>' }));
          process.exit(1);
        }

        // Simple keyword search (fast, no API)
        const searchTerm = `%${query}%`;
        const facts = db.prepare(`
          SELECT id, category, subject, content
          FROM facts
          WHERE subject LIKE ? OR content LIKE ? OR category LIKE ?
          ORDER BY updated_at DESC
          LIMIT 10
        `).all(searchTerm, searchTerm, searchTerm);

        console.log(JSON.stringify({
          success: true,
          query,
          count: facts.length,
          facts,
        }));
        break;
      }

      case 'help':
      default:
        console.log(JSON.stringify({
          usage: {
            save: 'memory-cli save <category> <subject> "<content>"',
            list: 'memory-cli list [category]',
            delete: 'memory-cli delete <category> <subject>',
            search: 'memory-cli search <query>',
          },
          categories: ['user_info', 'preferences', 'projects', 'people', 'work', 'notes', 'decisions'],
          examples: {
            'Save name': 'memory-cli save user_info name "John Smith"',
            'Save preference': 'memory-cli save preferences color "Favorite color is blue"',
            'List all': 'memory-cli list',
            'List category': 'memory-cli list preferences',
            'Search': 'memory-cli search coffee',
          },
        }));
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ error: error.message }));
  process.exit(1);
});

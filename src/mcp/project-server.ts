#!/usr/bin/env node
/**
 * MCP Server for Project Management
 *
 * Handles setting and persisting the active project directory.
 */

import { createInterface } from 'readline';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH =
  process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library/Application Support/pocket-agent/pocket-agent.db')
    : process.platform === 'linux'
      ? path.join(process.env.HOME || '', '.config/pocket-agent/pocket-agent.db')
      : path.join(process.env.USERPROFILE || '', 'AppData/Roaming/pocket-agent/pocket-agent.db');

// Types
interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Tool definitions
const TOOLS = [
  {
    name: 'set_project',
    description: `Set and lock the working directory to a specific project path.

This changes the agent's working directory. The path will be:
1. Validated to exist
2. Persisted to database (survives restarts)
3. Used as the cwd for subsequent file and bash operations

Use when the user wants to work from a specific project directory.

Example: { "path": "/Users/kenkai/Documents/my-project" }`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_project',
    description: 'Get the currently active project directory, if any.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Get database connection
 */
function getDb(): Database.Database | null {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return null;
    }
    return new Database(DB_PATH);
  } catch {
    return null;
  }
}

/**
 * Ensure the settings table exists
 */
function ensureSettingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Validate and normalize path
 */
function validatePath(inputPath: string): { valid: boolean; normalized?: string; error?: string } {
  // Prevent path traversal
  if (inputPath.includes('..') || inputPath.includes('\0')) {
    return { valid: false, error: 'Invalid path: contains traversal characters' };
  }

  // Must be absolute
  if (!path.isAbsolute(inputPath)) {
    return { valid: false, error: 'Path must be absolute' };
  }

  // Normalize
  const normalized = path.normalize(inputPath);

  // Check exists
  if (!fs.existsSync(normalized)) {
    return { valid: false, error: `Path does not exist: ${normalized}` };
  }

  // Check is directory
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    return { valid: false, error: `Path is not a directory: ${normalized}` };
  }

  return { valid: true, normalized };
}

/**
 * Handle set_project tool
 */
async function handleSetProject(args: Record<string, unknown>): Promise<string> {
  const inputPath = args.path as string;

  if (!inputPath) {
    return JSON.stringify({ error: 'path is required' });
  }

  // Validate path
  const validation = validatePath(inputPath);
  if (!validation.valid) {
    return JSON.stringify({ error: validation.error });
  }

  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found. Please start Pocket Agent first.' });
  }

  try {
    ensureSettingsTable(db);

    // Save to settings
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('active_project', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    stmt.run(validation.normalized);

    return JSON.stringify({
      success: true,
      message: `Project locked to: ${validation.normalized}. All file operations will now use this directory.`,
      path: validation.normalized,
    });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    db.close();
  }
}

/**
 * Handle get_project tool
 */
async function handleGetProject(): Promise<string> {
  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found' });
  }

  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'active_project'")
      .get() as { value: string } | undefined;

    if (!row) {
      return JSON.stringify({
        success: true,
        hasProject: false,
        message: 'No active project set',
      });
    }

    // Verify path still exists
    if (!fs.existsSync(row.value)) {
      return JSON.stringify({
        success: true,
        hasProject: true,
        path: row.value,
        warning: 'Project path no longer exists',
        exists: false,
      });
    }

    return JSON.stringify({
      success: true,
      hasProject: true,
      path: row.value,
      exists: true,
    });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    db.close();
  }
}

// Handle tool calls
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  console.error(`[MCP Project] Tool call: ${name}`, JSON.stringify(args).slice(0, 200));

  switch (name) {
    case 'set_project':
      return handleSetProject(args);
    case 'get_project':
      return handleGetProject();
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// MCP protocol handler
async function handleRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'pocket-agent-project', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const { name, arguments: toolArgs } = params as { name: string; arguments: Record<string, unknown> };
      const result = await handleToolCall(name, toolArgs || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } };
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// Main loop
const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  try {
    const request = JSON.parse(line) as MCPRequest;
    const response = await handleRequest(request);
    console.log(JSON.stringify(response));
  } catch (error) {
    console.error('[MCP Project] Parse error:', error);
  }
});

console.error('[MCP Project] Server started');

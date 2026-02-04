/**
 * Project management tools for the agent
 *
 * - set_project: Lock working directory to a specific project path
 * - get_project: Get the currently active project directory
 * - clear_project: Clear the active project (return to default workspace)
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentManager } from '../agent/index.js';

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

/**
 * Get database connection
 */
function getDb(): Database.Database | null {
  try {
    if (!fs.existsSync(getDbPath())) {
      return null;
    }
    return new Database(getDbPath());
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
 * Set project tool definition
 */
export function getSetProjectToolDefinition() {
  return {
    name: 'set_project',
    description: 'Set and lock the working directory to a project path. Persisted to database. Takes effect on next message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
      },
      required: ['path'],
    },
  };
}

/**
 * Set project tool handler
 */
export async function handleSetProjectTool(input: unknown): Promise<string> {
  const { path: inputPath } = input as { path: string };

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

    // Update AgentManager's workspace so the next SDK query uses the new cwd
    AgentManager.setWorkspace(validation.normalized!);

    return JSON.stringify({
      success: true,
      message: `Project switched to: ${validation.normalized}`,
      path: validation.normalized,
      note: 'All file and bash operations will use this directory starting from the next message.',
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
 * Get project tool definition
 */
export function getGetProjectToolDefinition() {
  return {
    name: 'get_project',
    description: 'Get the currently active project directory, if any. Returns the path and whether it exists.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  };
}

/**
 * Get project tool handler
 */
export async function handleGetProjectTool(): Promise<string> {
  // Get current runtime workspace from AgentManager
  const currentWorkspace = AgentManager.getWorkspace();
  const defaultWorkspace = AgentManager.getProjectRoot();

  const db = getDb();
  if (!db) {
    return JSON.stringify({
      success: true,
      hasProject: false,
      message: 'Database not found, using runtime workspace',
      currentWorkspace,
      defaultWorkspace,
    });
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
        currentWorkspace,
        defaultWorkspace,
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
        currentWorkspace,
        defaultWorkspace,
      });
    }

    return JSON.stringify({
      success: true,
      hasProject: true,
      path: row.value,
      exists: true,
      currentWorkspace,
      defaultWorkspace,
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
 * Clear project tool definition
 */
export function getClearProjectToolDefinition() {
  return {
    name: 'clear_project',
    description: 'Clear the active project and return to the default workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  };
}

/**
 * Clear project tool handler
 */
export async function handleClearProjectTool(): Promise<string> {
  const db = getDb();
  if (!db) {
    return JSON.stringify({ error: 'Database not found' });
  }

  try {
    ensureSettingsTable(db);

    const result = db.prepare("DELETE FROM settings WHERE key = 'active_project'").run();

    // Reset AgentManager's workspace to default
    AgentManager.resetWorkspace();
    const defaultPath = AgentManager.getProjectRoot();

    if (result.changes > 0) {
      return JSON.stringify({
        success: true,
        message: `Active project cleared. Workspace reset to: ${defaultPath}`,
        path: defaultPath,
      });
    } else {
      return JSON.stringify({
        success: true,
        message: `No active project was set. Current workspace: ${defaultPath}`,
        path: defaultPath,
      });
    }
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    db.close();
  }
}

/**
 * Get all project tools
 */
export function getProjectTools() {
  return [
    {
      ...getSetProjectToolDefinition(),
      handler: handleSetProjectTool,
    },
    {
      ...getGetProjectToolDefinition(),
      handler: handleGetProjectTool,
    },
    {
      ...getClearProjectToolDefinition(),
      handler: handleClearProjectTool,
    },
  ];
}

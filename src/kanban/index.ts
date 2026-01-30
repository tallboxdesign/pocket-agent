/**
 * Kanban Project Management Service
 *
 * Session-independent project and task management with activity logging.
 * Uses shared SQLite database with WAL mode for concurrent access.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ============================================================================
// Types
// ============================================================================

export type KanbanStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type KanbanPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface KanbanProject {
  id: number;
  name: string;
  description: string | null;
  workspace_path: string | null;
  status: 'active' | 'archived';
  color: string;
  created_at: string;
  updated_at: string;
}

export interface KanbanProjectWithCounts extends KanbanProject {
  task_counts: Record<KanbanStatus, number>;
  total_tasks: number;
}

export interface KanbanTask {
  id: number;
  project_id: number;
  parent_task_id: number | null;
  title: string;
  description: string | null;
  status: KanbanStatus;
  priority: KanbanPriority;
  assignee_model: string;
  position: number;
  estimated_minutes: number | null;
  approval_status: ApprovalStatus | null;
  approval_feedback: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface KanbanAttachment {
  id: number;
  task_id: number;
  type: 'file' | 'screenshot' | 'link' | 'folder';
  name: string;
  path: string | null;
  thumbnail: string | null;
  size: number | null;
  mime_type: string | null;
  created_at: string;
}

export interface KanbanTaskDetail extends KanbanTask {
  subtasks: KanbanTask[];
  recent_activity: ActivityEntry[];
  attachments: KanbanAttachment[];
}

export interface KanbanBoard {
  project: KanbanProject;
  columns: Record<KanbanStatus, KanbanTask[]>;
}

export interface ActivityEntry {
  id: number;
  task_id: number;
  project_id: number | null;
  action: string;
  old_value: string | null;
  new_value: string | null;
  details: string | null;
  actor: string;
  created_at: string;
}

export interface CreateTaskInput {
  project_id: number;
  title: string;
  description?: string;
  status?: KanbanStatus;
  priority?: KanbanPriority;
  assignee_model?: string;
  parent_task_id?: number;
  tags?: string;
  estimated_minutes?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: KanbanStatus;
  priority?: KanbanPriority;
  assignee_model?: string;
  tags?: string;
  estimated_minutes?: number;
  position?: number;
}

// ============================================================================
// Database Connection (Singleton)
// ============================================================================

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

function getDb(): Database.Database {
  if (sharedDb && !dbInitialized) {
    ensureTables(sharedDb);
    dbInitialized = true;
    return sharedDb;
  }

  if (sharedDb) {
    return sharedDb;
  }

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('Database not found. Start Pocket Agent first.');
  }

  console.log('[Kanban] Opening shared database connection');
  sharedDb = new Database(dbPath);
  sharedDb.pragma('journal_mode = WAL');
  sharedDb.pragma('busy_timeout = 5000');
  sharedDb.pragma('foreign_keys = ON');

  ensureTables(sharedDb);
  dbInitialized = true;

  return sharedDb;
}

export function closeKanbanDb(): void {
  if (sharedDb) {
    console.log('[Kanban] Closing shared database connection');
    sharedDb.close();
    sharedDb = null;
    dbInitialized = false;
  }
}

function ensureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      workspace_path TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      color TEXT DEFAULT '#a855f7',
      created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
      updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );

    CREATE TABLE IF NOT EXISTS kanban_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES kanban_projects(id) ON DELETE CASCADE,
      parent_task_id INTEGER REFERENCES kanban_tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'backlog' CHECK(status IN ('backlog','todo','in_progress','review','done')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      assignee_model TEXT DEFAULT 'claude',
      position INTEGER DEFAULT 0,
      estimated_minutes INTEGER,
      approval_status TEXT CHECK(approval_status IN ('pending','approved','rejected')),
      approval_feedback TEXT,
      tags TEXT,
      created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
      updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );

    CREATE TABLE IF NOT EXISTS kanban_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES kanban_projects(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      details TEXT,
      actor TEXT DEFAULT 'user',
      created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );

    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_project ON kanban_tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_parent ON kanban_tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_priority ON kanban_tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_kanban_activity_task ON kanban_activity_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_activity_project ON kanban_activity_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_projects_status ON kanban_projects(status);

    CREATE TABLE IF NOT EXISTS kanban_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('file','screenshot','link','folder')),
      name TEXT NOT NULL,
      path TEXT,
      thumbnail TEXT,
      size INTEGER,
      mime_type TEXT,
      created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );

    CREATE INDEX IF NOT EXISTS idx_kanban_attachments_task ON kanban_attachments(task_id);
  `);
}

// ============================================================================
// Activity Logging (automatic on every mutation)
// ============================================================================

function logActivity(
  taskId: number,
  projectId: number | null,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  details: string | null = null,
  actor: string = 'agent'
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO kanban_activity_log (task_id, project_id, action, old_value, new_value, details, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, action, oldValue, newValue, details, actor);
}

// ============================================================================
// KanbanService
// ============================================================================

export const KanbanService = {
  // ---- Projects ----

  createProject(name: string, description?: string, color?: string): KanbanProject {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO kanban_projects (name, description, color)
      VALUES (?, ?, ?)
    `).run(name, description || null, color || '#a855f7');

    const project = db.prepare('SELECT * FROM kanban_projects WHERE id = ?')
      .get(result.lastInsertRowid) as KanbanProject;

    console.log(`[Kanban] Created project: ${name} (#${project.id})`);
    return project;
  },

  getProject(id: number): KanbanProject | null {
    const db = getDb();
    return (db.prepare('SELECT * FROM kanban_projects WHERE id = ?').get(id) as KanbanProject) || null;
  },

  listProjects(): KanbanProjectWithCounts[] {
    const db = getDb();
    const projects = db.prepare(`
      SELECT * FROM kanban_projects WHERE status = 'active' ORDER BY updated_at DESC
    `).all() as KanbanProject[];

    return projects.map(project => {
      const counts = db.prepare(`
        SELECT status, COUNT(*) as count FROM kanban_tasks
        WHERE project_id = ? GROUP BY status
      `).all(project.id) as Array<{ status: KanbanStatus; count: number }>;

      const task_counts: Record<KanbanStatus, number> = {
        backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0,
      };
      let total_tasks = 0;
      for (const row of counts) {
        task_counts[row.status] = row.count;
        total_tasks += row.count;
      }

      return { ...project, task_counts, total_tasks };
    });
  },

  archiveProject(id: number): boolean {
    const db = getDb();
    const result = db.prepare(`
      UPDATE kanban_projects SET status = 'archived', updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
      WHERE id = ?
    `).run(id);
    return result.changes > 0;
  },

  updateProject(id: number, updates: { name?: string; description?: string; color?: string; workspace_path?: string }): KanbanProject | null {
    const db = getDb();
    const setClauses: string[] = [];
    const values: (string | null)[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push('description = ?'); values.push(updates.description); }
    if (updates.color !== undefined) { setClauses.push('color = ?'); values.push(updates.color); }
    if (updates.workspace_path !== undefined) { setClauses.push('workspace_path = ?'); values.push(updates.workspace_path); }

    if (setClauses.length === 0) return this.getProject(id);

    setClauses.push("updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))");
    values.push(String(id));

    db.prepare(`UPDATE kanban_projects SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getProject(id);
  },

  // ---- Tasks ----

  createTask(input: CreateTaskInput): KanbanTask {
    const db = getDb();

    // Get max position in the target column
    const maxPos = db.prepare(`
      SELECT COALESCE(MAX(position), -1) as max_pos FROM kanban_tasks
      WHERE project_id = ? AND status = ?
    `).get(input.project_id, input.status || 'backlog') as { max_pos: number };

    const result = db.prepare(`
      INSERT INTO kanban_tasks (project_id, parent_task_id, title, description, status, priority, assignee_model, position, tags, estimated_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.project_id,
      input.parent_task_id || null,
      input.title,
      input.description || null,
      input.status || 'backlog',
      input.priority || 'medium',
      input.assignee_model || 'claude',
      maxPos.max_pos + 1,
      input.tags || null,
      input.estimated_minutes || null
    );

    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?')
      .get(result.lastInsertRowid) as KanbanTask;

    // Auto-log activity
    logActivity(task.id, task.project_id, 'created', null, task.status,
      `Created task: ${task.title}`, 'agent');

    // Touch project updated_at
    db.prepare("UPDATE kanban_projects SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id = ?")
      .run(task.project_id);

    return task;
  },

  getTask(id: number): KanbanTaskDetail | null {
    const db = getDb();
    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask | undefined;
    if (!task) return null;

    const subtasks = db.prepare(`
      SELECT * FROM kanban_tasks WHERE parent_task_id = ? ORDER BY position ASC
    `).all(id) as KanbanTask[];

    const recent_activity = db.prepare(`
      SELECT * FROM kanban_activity_log WHERE task_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(id) as ActivityEntry[];

    const attachments = db.prepare(`
      SELECT * FROM kanban_attachments WHERE task_id = ? ORDER BY created_at DESC
    `).all(id) as KanbanAttachment[];

    return { ...task, subtasks, recent_activity, attachments };
  },

  updateTask(id: number, updates: UpdateTaskInput, actor: string = 'agent'): KanbanTask | null {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask | undefined;
    if (!existing) return null;

    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
      if (updates.title !== existing.title) {
        logActivity(id, existing.project_id, 'title_changed', existing.title, updates.title, null, actor);
      }
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      values.push(updates.description);
      logActivity(id, existing.project_id, 'description_updated', null, null,
        'Description updated', actor);
    }
    if (updates.priority !== undefined && updates.priority !== existing.priority) {
      setClauses.push('priority = ?');
      values.push(updates.priority);
      logActivity(id, existing.project_id, 'priority_changed', existing.priority, updates.priority, null, actor);
    }
    if (updates.assignee_model !== undefined && updates.assignee_model !== existing.assignee_model) {
      setClauses.push('assignee_model = ?');
      values.push(updates.assignee_model);
      logActivity(id, existing.project_id, 'assignee_changed', existing.assignee_model, updates.assignee_model, null, actor);
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      values.push(updates.tags);
    }
    if (updates.estimated_minutes !== undefined) {
      setClauses.push('estimated_minutes = ?');
      values.push(updates.estimated_minutes);
    }
    if (updates.position !== undefined) {
      setClauses.push('position = ?');
      values.push(updates.position);
    }
    if (updates.status !== undefined && updates.status !== existing.status) {
      setClauses.push('status = ?');
      values.push(updates.status);
      logActivity(id, existing.project_id, 'status_changed', existing.status, updates.status, null, actor);

      // Auto-set approval_status when moving to review
      if (updates.status === 'review') {
        setClauses.push('approval_status = ?');
        values.push('pending');
      }
    }

    if (setClauses.length === 0) return existing;

    setClauses.push("updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))");
    values.push(id);

    db.prepare(`UPDATE kanban_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    // Touch project updated_at
    db.prepare("UPDATE kanban_projects SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id = ?")
      .run(existing.project_id);

    return db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask;
  },

  moveTask(id: number, newStatus: KanbanStatus, actor: string = 'user'): KanbanTask | null {
    return this.updateTask(id, { status: newStatus }, actor);
  },

  deleteTask(id: number): boolean {
    const db = getDb();
    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask | undefined;
    if (!task) return false;

    logActivity(id, task.project_id, 'deleted', task.title, null, `Deleted task: ${task.title}`, 'user');
    const result = db.prepare('DELETE FROM kanban_tasks WHERE id = ?').run(id);
    return result.changes > 0;
  },

  getBoard(projectId: number): KanbanBoard | null {
    const db = getDb();
    const project = db.prepare('SELECT * FROM kanban_projects WHERE id = ?').get(projectId) as KanbanProject | undefined;
    if (!project) return null;

    const tasks = db.prepare(`
      SELECT * FROM kanban_tasks WHERE project_id = ? AND parent_task_id IS NULL
      ORDER BY position ASC
    `).all(projectId) as KanbanTask[];

    const columns: Record<KanbanStatus, KanbanTask[]> = {
      backlog: [], todo: [], in_progress: [], review: [], done: [],
    };

    for (const task of tasks) {
      columns[task.status].push(task);
    }

    return { project, columns };
  },

  getSubtasks(parentId: number): KanbanTask[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM kanban_tasks WHERE parent_task_id = ? ORDER BY position ASC
    `).all(parentId) as KanbanTask[];
  },

  // ---- Comments & Activity ----

  addComment(taskId: number, comment: string, actor: string = 'user'): void {
    const db = getDb();
    const task = db.prepare('SELECT project_id FROM kanban_tasks WHERE id = ?').get(taskId) as { project_id: number } | undefined;
    if (!task) return;

    logActivity(taskId, task.project_id, 'comment', null, null, comment, actor);
  },

  getActivityLog(taskId: number, limit: number = 20): ActivityEntry[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM kanban_activity_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(taskId, limit) as ActivityEntry[];
  },

  // ---- Review / Approval ----

  approveTask(id: number, actor: string = 'user'): KanbanTask | null {
    const db = getDb();
    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask | undefined;
    if (!task) return null;

    db.prepare(`
      UPDATE kanban_tasks SET approval_status = 'approved', status = 'done',
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
      WHERE id = ?
    `).run(id);

    logActivity(id, task.project_id, 'approved', 'review', 'done', 'Task approved', actor);

    return db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask;
  },

  rejectTask(id: number, feedback: string, actor: string = 'user'): KanbanTask | null {
    const db = getDb();
    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask | undefined;
    if (!task) return null;

    db.prepare(`
      UPDATE kanban_tasks SET approval_status = 'rejected', approval_feedback = ?,
        status = 'in_progress', updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))
      WHERE id = ?
    `).run(feedback, id);

    logActivity(id, task.project_id, 'rejected', 'review', 'in_progress', feedback, actor);

    return db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id) as KanbanTask;
  },

  // ---- Attachments ----

  addAttachment(taskId: number, attachment: {
    type: 'file' | 'screenshot' | 'link' | 'folder';
    name: string;
    path?: string;
    thumbnail?: string;
    size?: number;
    mime_type?: string;
  }): KanbanAttachment {
    const db = getDb();
    const task = db.prepare('SELECT project_id FROM kanban_tasks WHERE id = ?').get(taskId) as { project_id: number } | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);

    const result = db.prepare(`
      INSERT INTO kanban_attachments (task_id, type, name, path, thumbnail, size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId, attachment.type, attachment.name,
      attachment.path || null, attachment.thumbnail || null,
      attachment.size || null, attachment.mime_type || null
    );

    logActivity(taskId, task.project_id, 'attachment_added', null, attachment.name,
      `Added ${attachment.type}: ${attachment.name}`, 'user');

    return db.prepare('SELECT * FROM kanban_attachments WHERE id = ?')
      .get(result.lastInsertRowid) as KanbanAttachment;
  },

  getAttachments(taskId: number): KanbanAttachment[] {
    const db = getDb();
    return db.prepare('SELECT * FROM kanban_attachments WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as KanbanAttachment[];
  },

  deleteAttachment(id: number): boolean {
    const db = getDb();
    const att = db.prepare('SELECT * FROM kanban_attachments WHERE id = ?').get(id) as KanbanAttachment | undefined;
    if (!att) return false;

    const task = db.prepare('SELECT project_id FROM kanban_tasks WHERE id = ?').get(att.task_id) as { project_id: number } | undefined;
    if (task) {
      logActivity(att.task_id, task.project_id, 'attachment_removed', att.name, null,
        `Removed ${att.type}: ${att.name}`, 'user');
    }

    return db.prepare('DELETE FROM kanban_attachments WHERE id = ?').run(id).changes > 0;
  },

  // ---- Search ----

  searchTasks(query: string, projectId?: number): KanbanTask[] {
    const db = getDb();
    const pattern = `%${query}%`;

    if (projectId) {
      return db.prepare(`
        SELECT * FROM kanban_tasks
        WHERE project_id = ? AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)
        ORDER BY updated_at DESC LIMIT 50
      `).all(projectId, pattern, pattern, pattern) as KanbanTask[];
    }

    return db.prepare(`
      SELECT * FROM kanban_tasks
      WHERE title LIKE ? OR description LIKE ? OR tags LIKE ?
      ORDER BY updated_at DESC LIMIT 50
    `).all(pattern, pattern, pattern) as KanbanTask[];
  },
};

/**
 * Task/Todo tools for the agent
 *
 * MCP tools for managing tasks with priorities and due dates.
 * Rewired to use KanbanService (Personal project) instead of direct SQL on tasks table.
 */

import { getCurrentSessionId } from './session-context';
import { KanbanService, type KanbanStatus, type KanbanPriority, type KanbanTask } from '../kanban';

/**
 * Close legacy task database connection (no-op since tasks now use KanbanService)
 */
export function closeTaskDb(): void {
  // Legacy tasks table is no longer used directly.
  // KanbanService manages its own DB connection via closeKanbanDb().
}

function parseDateTime(input: string): string | null {
  const now = new Date();

  // "today", "tomorrow", "monday", etc. with optional time
  const dayMatch = input.match(
    /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i
  );
  if (dayMatch) {
    const [, dayStr, hourStr, minStr, ampm] = dayMatch;
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

  // "in X minutes/hours/days/weeks"
  const inMatch = input.match(/^in\s+(\d+)\s+(minute|min|hour|hr|day|week)s?$/i);
  if (inMatch) {
    const [, amount, unit] = inMatch;
    const num = parseInt(amount, 10);
    const unitLower = unit.toLowerCase();
    let ms: number;
    if (unitLower === 'minute' || unitLower === 'min') {
      ms = num * 60000;
    } else if (unitLower === 'hour' || unitLower === 'hr') {
      ms = num * 3600000;
    } else if (unitLower === 'week') {
      ms = num * 604800000;
    } else {
      ms = num * 86400000; // day
    }
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

// ============================================================================
// Status mapping helpers
// ============================================================================

function reverseStatusMap(kanbanStatus: KanbanStatus): string {
  switch (kanbanStatus) {
    case 'backlog':
    case 'todo':
      return 'pending';
    case 'in_progress':
    case 'review':
      return 'in_progress';
    case 'done':
      return 'completed';
  }
}

function toPriority(p: string | undefined): KanbanPriority {
  const val = p?.toLowerCase();
  if (val === 'low' || val === 'medium' || val === 'high' || val === 'urgent') return val;
  return 'medium';
}

// ============================================================================
// Task Add Tool
// ============================================================================

export function getTaskAddToolDefinition() {
  return {
    name: 'task_add',
    description: `Add a new task/todo item with optional due date, priority, and reminder.

Use when user wants to:
- Create a todo item
- Add something to their task list
- Set a task with a deadline

Priority levels: low, medium (default), high

Examples:
- task_add("Buy groceries")
- task_add("Call mom", due="tomorrow 5pm", priority="high")
- task_add("Submit report", due="friday", reminder_minutes=60)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Optional task description' },
        due: { type: 'string', description: 'Due date (e.g., "tomorrow", "friday 5pm")' },
        priority: { type: 'string', description: 'Priority: low, medium, high (default: medium)' },
        reminder_minutes: { type: 'number', description: 'Minutes before due to remind' },
        channel: { type: 'string', description: 'Where to send reminder: desktop or telegram' },
      },
      required: ['title'],
    },
  };
}

export async function handleTaskAddTool(input: unknown): Promise<string> {
  const params = input as {
    title: string;
    description?: string;
    due?: string;
    priority?: string;
    reminder_minutes?: number;
    channel?: string;
  };

  if (!params.title) {
    return JSON.stringify({ error: 'title is required' });
  }

  const dueDate = params.due ? parseDateTime(params.due) : null;
  if (params.due && !dueDate) {
    return JSON.stringify({ error: `Could not parse due date: "${params.due}"` });
  }

  const priority = toPriority(params.priority);

  try {
    const personal = KanbanService.getOrCreatePersonalProject();

    const task = KanbanService.createTask({
      project_id: personal.id,
      title: params.title,
      description: params.description,
      status: 'todo',
      priority,
      due_date: dueDate || undefined,
      reminder_minutes: params.reminder_minutes,
      notify_channels: params.channel || 'desktop',
    });

    return JSON.stringify({
      success: true,
      id: task.id,
      title: task.title,
      due: dueDate ? formatDateTime(dueDate) : null,
      priority,
      session_id: getCurrentSessionId(),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_add failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task List Tool
// ============================================================================

export function getTaskListToolDefinition() {
  return {
    name: 'task_list',
    description: `List tasks/todos. Optionally filter by status.

Status options: pending (default), completed, in_progress, all

Examples:
- task_list() - pending tasks
- task_list(status="all")
- task_list(status="completed")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending, completed, in_progress, all' },
      },
      required: [],
    },
  };
}

export async function handleTaskListTool(input: unknown): Promise<string> {
  const params = input as { status?: string };
  const statusFilter = params.status || 'pending';

  try {
    const personal = KanbanService.getOrCreatePersonalProject();
    const board = KanbanService.getBoard(personal.id);
    if (!board) {
      return JSON.stringify({ success: true, filter: statusFilter, count: 0, tasks: [] });
    }

    // Collect tasks from all columns
    let allTasks: KanbanTask[] = [];
    for (const tasks of Object.values(board.columns)) {
      allTasks = allTasks.concat(tasks);
    }

    // Filter by requested status
    if (statusFilter !== 'all') {
      allTasks = allTasks.filter(t => reverseStatusMap(t.status) === statusFilter);
    }

    // Sort by priority then due_date
    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    allTasks.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
      if (a.due_date) return -1;
      if (b.due_date) return 1;
      return 0;
    });

    return JSON.stringify({
      success: true,
      filter: statusFilter,
      count: allTasks.length,
      tasks: allTasks.map(t => ({
        id: t.id,
        title: t.title,
        due: formatDateTime(t.due_date),
        priority: t.priority,
        status: reverseStatusMap(t.status),
      })),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_list failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task Complete Tool
// ============================================================================

export function getTaskCompleteToolDefinition() {
  return {
    name: 'task_complete',
    description: 'Mark a task as completed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID to complete' },
      },
      required: ['id'],
    },
  };
}

export async function handleTaskCompleteTool(input: unknown): Promise<string> {
  const params = input as { id: number };

  if (!params.id) {
    return JSON.stringify({ error: 'id is required' });
  }

  try {
    const result = KanbanService.moveTask(params.id, 'done', 'agent');
    if (result) {
      return JSON.stringify({ success: true, message: `Task ${params.id} completed` });
    } else {
      return JSON.stringify({ success: false, error: `Task ${params.id} not found` });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_complete failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task Delete Tool
// ============================================================================

export function getTaskDeleteToolDefinition() {
  return {
    name: 'task_delete',
    description: 'Delete a task by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID to delete' },
      },
      required: ['id'],
    },
  };
}

export async function handleTaskDeleteTool(input: unknown): Promise<string> {
  const params = input as { id: number };

  if (!params.id) {
    return JSON.stringify({ error: 'id is required' });
  }

  try {
    const success = KanbanService.deleteTask(params.id);
    if (success) {
      return JSON.stringify({ success: true, message: `Task ${params.id} deleted` });
    } else {
      return JSON.stringify({ success: false, error: `Task ${params.id} not found` });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_delete failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task Due Tool
// ============================================================================

export function getTaskDueToolDefinition() {
  return {
    name: 'task_due',
    description: `Get tasks due within the next N hours, including overdue tasks.

Examples:
- task_due() - due in next 24 hours (default)
- task_due(hours=48)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: { type: 'number', description: 'Hours to look ahead (default: 24)' },
      },
      required: [],
    },
  };
}

export async function handleTaskDueTool(input: unknown): Promise<string> {
  const params = input as { hours?: number };
  const hours = params.hours ?? 24;

  try {
    const personal = KanbanService.getOrCreatePersonalProject();

    const now = new Date();
    const later = new Date(now.getTime() + hours * 3600000);

    const tasks = KanbanService.getTasksDueSoon(personal.id, later.toISOString());

    const overdue = tasks.filter(t => new Date(t.due_date!) < now);
    const upcoming = tasks.filter(t => new Date(t.due_date!) >= now);

    return JSON.stringify({
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
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_due failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Export all task tools
// ============================================================================

export function getTaskTools() {
  return [
    { ...getTaskAddToolDefinition(), handler: handleTaskAddTool },
    { ...getTaskListToolDefinition(), handler: handleTaskListTool },
    { ...getTaskCompleteToolDefinition(), handler: handleTaskCompleteTool },
    { ...getTaskDeleteToolDefinition(), handler: handleTaskDeleteTool },
    { ...getTaskDueToolDefinition(), handler: handleTaskDueTool },
  ];
}

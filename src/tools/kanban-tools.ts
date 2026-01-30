/**
 * Kanban tools for the agent
 *
 * 10 tools for project/task management via the Kanban board.
 * Session-independent - accessible from any conversation.
 */

import {
  KanbanService,
  type KanbanStatus,
  type KanbanPriority,
  type CreateTaskInput,
} from '../kanban';

// ============================================================================
// kanban_create_project
// ============================================================================

export function getKanbanCreateProjectToolDefinition() {
  return {
    name: 'kanban_create_project',
    description: `Create a new Kanban project. Projects organize tasks into a board with columns: Backlog, Todo, In Progress, Review, Done.

Examples:
- kanban_create_project("Landing Page Redesign")
- kanban_create_project("Mobile App", "React Native app for iOS/Android", "#3b82f6")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Project description' },
        color: { type: 'string', description: 'Hex color for the project (default: #a855f7)' },
      },
      required: ['name'],
    },
  };
}

export async function handleKanbanCreateProjectTool(input: unknown): Promise<string> {
  const params = input as { name: string; description?: string; color?: string };
  if (!params.name) return JSON.stringify({ error: 'name is required' });

  try {
    const project = KanbanService.createProject(params.name, params.description, params.color);
    return JSON.stringify({
      success: true,
      project: { id: project.id, name: project.name, description: project.description, color: project.color },
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to create project' });
  }
}

// ============================================================================
// kanban_list_projects
// ============================================================================

export function getKanbanListProjectsToolDefinition() {
  return {
    name: 'kanban_list_projects',
    description: `List all active Kanban projects with task counts per column.

Shows each project's name, task distribution across columns, and total tasks.`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

export async function handleKanbanListProjectsTool(): Promise<string> {
  try {
    const projects = KanbanService.listProjects();
    return JSON.stringify({
      success: true,
      count: projects.length,
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        color: p.color,
        total_tasks: p.total_tasks,
        task_counts: p.task_counts,
      })),
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to list projects' });
  }
}

// ============================================================================
// kanban_create_task
// ============================================================================

export function getKanbanCreateTaskToolDefinition() {
  return {
    name: 'kanban_create_task',
    description: `Add a task to a Kanban project.

Status: backlog (default), todo, in_progress, review, done
Priority: low, medium (default), high, urgent

Examples:
- kanban_create_task(project_id=1, title="Design hero section")
- kanban_create_task(project_id=1, title="Write copy", priority="high", status="todo")
- kanban_create_task(project_id=1, title="Fix header", parent_task_id=5, tags="bug,frontend")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'number', description: 'Project ID to add the task to' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        status: { type: 'string', description: 'Column: backlog, todo, in_progress, review, done' },
        priority: { type: 'string', description: 'Priority: low, medium, high, urgent' },
        assignee_model: { type: 'string', description: 'Model to execute: claude, codex, kimi, glm (default: claude)' },
        parent_task_id: { type: 'number', description: 'Parent task ID for subtasks' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        estimated_minutes: { type: 'number', description: 'Estimated time in minutes' },
      },
      required: ['project_id', 'title'],
    },
  };
}

export async function handleKanbanCreateTaskTool(input: unknown): Promise<string> {
  const params = input as CreateTaskInput;
  if (!params.project_id || !params.title) {
    return JSON.stringify({ error: 'project_id and title are required' });
  }

  const validStatuses: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
  if (params.status && !validStatuses.includes(params.status)) {
    return JSON.stringify({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
  }

  const validPriorities: KanbanPriority[] = ['low', 'medium', 'high', 'urgent'];
  if (params.priority && !validPriorities.includes(params.priority)) {
    return JSON.stringify({ error: `Invalid priority. Use: ${validPriorities.join(', ')}` });
  }

  try {
    const task = KanbanService.createTask(params);
    return JSON.stringify({
      success: true,
      task: {
        id: task.id,
        project_id: task.project_id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assignee_model: task.assignee_model,
      },
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to create task' });
  }
}

// ============================================================================
// kanban_update_task
// ============================================================================

export function getKanbanUpdateTaskToolDefinition() {
  return {
    name: 'kanban_update_task',
    description: `Update any field on a Kanban task. Changes are automatically logged to the activity timeline.

Examples:
- kanban_update_task(id=1, priority="urgent")
- kanban_update_task(id=1, title="Updated title", description="New description")
- kanban_update_task(id=1, assignee_model="codex")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        priority: { type: 'string', description: 'Priority: low, medium, high, urgent' },
        assignee_model: { type: 'string', description: 'Model: claude, codex, kimi, glm' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        estimated_minutes: { type: 'number', description: 'Estimated time in minutes' },
      },
      required: ['id'],
    },
  };
}

export async function handleKanbanUpdateTaskTool(input: unknown): Promise<string> {
  const params = input as { id: number; title?: string; description?: string; priority?: string; assignee_model?: string; tags?: string; estimated_minutes?: number };
  if (!params.id) return JSON.stringify({ error: 'id is required' });

  try {
    const { id, ...updates } = params;
    const task = KanbanService.updateTask(id, updates as Record<string, unknown>);
    if (!task) return JSON.stringify({ error: `Task ${id} not found` });

    return JSON.stringify({
      success: true,
      task: { id: task.id, title: task.title, status: task.status, priority: task.priority },
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to update task' });
  }
}

// ============================================================================
// kanban_move_task
// ============================================================================

export function getKanbanMoveTaskToolDefinition() {
  return {
    name: 'kanban_move_task',
    description: `Move a task to a different column on the Kanban board.

Columns: backlog, todo, in_progress, review, done

Moving to 'review' auto-sets approval_status to 'pending'.

Examples:
- kanban_move_task(id=1, status="in_progress")
- kanban_move_task(id=1, status="review")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID' },
        status: { type: 'string', description: 'Target column: backlog, todo, in_progress, review, done' },
      },
      required: ['id', 'status'],
    },
  };
}

export async function handleKanbanMoveTaskTool(input: unknown): Promise<string> {
  const params = input as { id: number; status: string };
  if (!params.id || !params.status) return JSON.stringify({ error: 'id and status are required' });

  const validStatuses: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
  if (!validStatuses.includes(params.status as KanbanStatus)) {
    return JSON.stringify({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
  }

  try {
    const task = KanbanService.moveTask(params.id, params.status as KanbanStatus);
    if (!task) return JSON.stringify({ error: `Task ${params.id} not found` });

    return JSON.stringify({
      success: true,
      task: { id: task.id, title: task.title, status: task.status, priority: task.priority },
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to move task' });
  }
}

// ============================================================================
// kanban_get_board
// ============================================================================

export function getKanbanGetBoardToolDefinition() {
  return {
    name: 'kanban_get_board',
    description: `Get the full Kanban board for a project. Returns all tasks grouped by column (Backlog, Todo, In Progress, Review, Done).

Use this to see the current state of a project.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'number', description: 'Project ID' },
      },
      required: ['project_id'],
    },
  };
}

export async function handleKanbanGetBoardTool(input: unknown): Promise<string> {
  const params = input as { project_id: number };
  if (!params.project_id) return JSON.stringify({ error: 'project_id is required' });

  try {
    const board = KanbanService.getBoard(params.project_id);
    if (!board) return JSON.stringify({ error: `Project ${params.project_id} not found` });

    const summary: Record<string, number> = {};
    for (const [col, tasks] of Object.entries(board.columns)) {
      summary[col] = tasks.length;
    }

    return JSON.stringify({
      success: true,
      project: { id: board.project.id, name: board.project.name },
      summary,
      columns: Object.fromEntries(
        Object.entries(board.columns).map(([col, tasks]) => [
          col,
          tasks.map(t => ({
            id: t.id,
            title: t.title,
            priority: t.priority,
            assignee_model: t.assignee_model,
            tags: t.tags,
          })),
        ])
      ),
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to get board' });
  }
}

// ============================================================================
// kanban_get_task
// ============================================================================

export function getKanbanGetTaskToolDefinition() {
  return {
    name: 'kanban_get_task',
    description: `Get detailed information about a specific task, including subtasks and recent activity log.

Returns: title, description, status, priority, subtasks, and the last 10 activity entries.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID' },
      },
      required: ['id'],
    },
  };
}

export async function handleKanbanGetTaskTool(input: unknown): Promise<string> {
  const params = input as { id: number };
  if (!params.id) return JSON.stringify({ error: 'id is required' });

  try {
    const task = KanbanService.getTask(params.id);
    if (!task) return JSON.stringify({ error: `Task ${params.id} not found` });

    return JSON.stringify({
      success: true,
      task: {
        id: task.id,
        project_id: task.project_id,
        parent_task_id: task.parent_task_id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assignee_model: task.assignee_model,
        tags: task.tags,
        approval_status: task.approval_status,
        approval_feedback: task.approval_feedback,
        estimated_minutes: task.estimated_minutes,
        created_at: task.created_at,
        updated_at: task.updated_at,
        subtask_count: task.subtasks.length,
        subtasks: task.subtasks.map(s => ({
          id: s.id, title: s.title, status: s.status, priority: s.priority,
        })),
        recent_activity: task.recent_activity.map(a => ({
          action: a.action, old_value: a.old_value, new_value: a.new_value,
          details: a.details, actor: a.actor, created_at: a.created_at,
        })),
      },
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to get task' });
  }
}

// ============================================================================
// kanban_delete_task
// ============================================================================

export function getKanbanDeleteTaskToolDefinition() {
  return {
    name: 'kanban_delete_task',
    description: 'Delete a task from the Kanban board.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID to delete' },
      },
      required: ['id'],
    },
  };
}

export async function handleKanbanDeleteTaskTool(input: unknown): Promise<string> {
  const params = input as { id: number };
  if (!params.id) return JSON.stringify({ error: 'id is required' });

  try {
    const success = KanbanService.deleteTask(params.id);
    if (!success) return JSON.stringify({ error: `Task ${params.id} not found` });
    return JSON.stringify({ success: true, message: `Task ${params.id} deleted` });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to delete task' });
  }
}

// ============================================================================
// kanban_add_comment
// ============================================================================

export function getKanbanAddCommentToolDefinition() {
  return {
    name: 'kanban_add_comment',
    description: `Add a comment to a task's activity log. Use this to record notes, progress updates, or feedback.

Examples:
- kanban_add_comment(task_id=1, comment="Started working on this")
- kanban_add_comment(task_id=1, comment="Blocked by missing API docs")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        comment: { type: 'string', description: 'Comment text' },
      },
      required: ['task_id', 'comment'],
    },
  };
}

export async function handleKanbanAddCommentTool(input: unknown): Promise<string> {
  const params = input as { task_id: number; comment: string };
  if (!params.task_id || !params.comment) return JSON.stringify({ error: 'task_id and comment are required' });

  try {
    KanbanService.addComment(params.task_id, params.comment, 'agent');
    return JSON.stringify({ success: true, message: 'Comment added' });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to add comment' });
  }
}

// ============================================================================
// kanban_review_task
// ============================================================================

export function getKanbanReviewTaskToolDefinition() {
  return {
    name: 'kanban_review_task',
    description: `Approve or reject a task that's in the Review column.

Approve: moves task to Done
Reject: moves task back to In Progress with feedback

Examples:
- kanban_review_task(id=1, action="approve")
- kanban_review_task(id=1, action="reject", feedback="Needs more tests")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID' },
        action: { type: 'string', description: 'approve or reject' },
        feedback: { type: 'string', description: 'Rejection feedback (required for reject)' },
      },
      required: ['id', 'action'],
    },
  };
}

export async function handleKanbanReviewTaskTool(input: unknown): Promise<string> {
  const params = input as { id: number; action: string; feedback?: string };
  if (!params.id || !params.action) return JSON.stringify({ error: 'id and action are required' });

  if (params.action !== 'approve' && params.action !== 'reject') {
    return JSON.stringify({ error: 'action must be "approve" or "reject"' });
  }

  if (params.action === 'reject' && !params.feedback) {
    return JSON.stringify({ error: 'feedback is required when rejecting a task' });
  }

  try {
    let task;
    if (params.action === 'approve') {
      task = KanbanService.approveTask(params.id);
    } else {
      task = KanbanService.rejectTask(params.id, params.feedback!);
    }

    if (!task) return JSON.stringify({ error: `Task ${params.id} not found` });

    return JSON.stringify({
      success: true,
      action: params.action,
      task: { id: task.id, title: task.title, status: task.status, approval_status: task.approval_status },
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to review task' });
  }
}

// ============================================================================
// Export all kanban tools
// ============================================================================

export function getKanbanTools() {
  return [
    { ...getKanbanCreateProjectToolDefinition(), handler: handleKanbanCreateProjectTool },
    { ...getKanbanListProjectsToolDefinition(), handler: handleKanbanListProjectsTool },
    { ...getKanbanCreateTaskToolDefinition(), handler: handleKanbanCreateTaskTool },
    { ...getKanbanUpdateTaskToolDefinition(), handler: handleKanbanUpdateTaskTool },
    { ...getKanbanMoveTaskToolDefinition(), handler: handleKanbanMoveTaskTool },
    { ...getKanbanGetBoardToolDefinition(), handler: handleKanbanGetBoardTool },
    { ...getKanbanGetTaskToolDefinition(), handler: handleKanbanGetTaskTool },
    { ...getKanbanDeleteTaskToolDefinition(), handler: handleKanbanDeleteTaskTool },
    { ...getKanbanAddCommentToolDefinition(), handler: handleKanbanAddCommentTool },
    { ...getKanbanReviewTaskToolDefinition(), handler: handleKanbanReviewTaskTool },
  ];
}

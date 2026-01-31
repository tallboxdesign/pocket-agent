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
// kanban_move_task_to_project
// ============================================================================

export function getKanbanMoveTaskToProjectToolDefinition() {
  return {
    name: 'kanban_move_task_to_project',
    description: `Move a task to a different project on the Kanban board.

The task keeps its current status and priority but gets a new position in the target project.
Use kanban_list_projects first to find available project IDs.

Examples:
- kanban_move_task_to_project(task_id=5, project_id=2)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID to move' },
        project_id: { type: 'number', description: 'Target project ID' },
      },
      required: ['task_id', 'project_id'],
    },
  };
}

export async function handleKanbanMoveTaskToProjectTool(input: unknown): Promise<string> {
  const params = input as { task_id: number; project_id: number };
  if (!params.task_id || !params.project_id) {
    return JSON.stringify({ error: 'task_id and project_id are required' });
  }

  try {
    const task = KanbanService.moveTaskToProject(params.task_id, params.project_id, 'agent');
    if (!task) return JSON.stringify({ error: `Task ${params.task_id} or project ${params.project_id} not found` });

    return JSON.stringify({
      success: true,
      task: { id: task.id, title: task.title, project_id: task.project_id, status: task.status },
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to move task to project' });
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
// kanban_log_research
// ============================================================================

export function getKanbanLogResearchToolDefinition() {
  return {
    name: 'kanban_log_research',
    description: `Log completed research or work to the Kanban board. Creates a task in the Review column so the user can see and approve your work.

Use this after completing:
- Screenshots of websites or pages
- Web searches and analysis
- Data gathering or research tasks
- File analysis or code review
- Any work the user should review

The task is created in a "Research" project (auto-created if needed).

Examples:
- kanban_log_research(title="Screenshot of competitor site", description="Captured homepage of example.com", tags="research,screenshot", attachments=["/path/to/screenshot.png"])
- kanban_log_research(title="Market analysis for Sofia", description="Researched cost of living, neighborhoods, healthcare...", tags="research,analysis")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'What was researched or done' },
        description: { type: 'string', description: 'Research findings or results summary' },
        project_id: { type: 'number', description: 'Project ID (default: auto-created Research project)' },
        tags: { type: 'string', description: 'Comma-separated tags (e.g. "research,screenshot")' },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths (screenshots, documents) to attach',
        },
        links: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs to attach as link references (source pages, documentation)',
        },
        priority: { type: 'string', description: 'Priority: low, medium (default), high, urgent' },
      },
      required: ['title', 'description'],
    },
  };
}

export async function handleKanbanLogResearchTool(input: unknown): Promise<string> {
  const params = input as {
    title: string;
    description: string;
    project_id?: number;
    tags?: string;
    attachments?: string[];
    links?: string[];
    priority?: string;
  };

  if (!params.title || !params.description) {
    return JSON.stringify({ error: 'title and description are required' });
  }

  try {
    // Find or create the Research project
    let projectId = params.project_id;
    if (!projectId) {
      const projects = KanbanService.listProjects();
      const researchProject = projects.find(p => p.name === 'Research');
      if (researchProject) {
        projectId = researchProject.id;
      } else {
        const newProject = KanbanService.createProject('Research', 'Agent research results and findings', '#3b82f6');
        projectId = newProject.id;
      }
    }

    // Create task in review status
    const task = KanbanService.createTask({
      project_id: projectId,
      title: params.title,
      description: params.description,
      status: 'review',
      priority: (params.priority as KanbanPriority) || 'medium',
      tags: params.tags || 'research',
      assignee_model: 'claude',
    });

    // Add file attachments as real attachment records
    if (params.attachments && params.attachments.length > 0) {
      for (const filePath of params.attachments) {
        const name = filePath.split('/').pop() || filePath;
        const isImage = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(name);
        KanbanService.addAttachment(task.id, {
          type: isImage ? 'screenshot' : 'file',
          name,
          path: filePath,
        });
      }
    }

    // Auto-extract URLs from description + explicit links
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const descUrls = params.description.match(urlRegex) || [];
    const allLinks = [...new Set([...(params.links || []), ...descUrls])];
    for (const url of allLinks) {
      try {
        const urlObj = new URL(url);
        KanbanService.addAttachment(task.id, {
          type: 'link',
          name: urlObj.hostname + (urlObj.pathname !== '/' ? urlObj.pathname : ''),
          path: url,
        });
      } catch {
        KanbanService.addAttachment(task.id, {
          type: 'link',
          name: url.substring(0, 80),
          path: url,
        });
      }
    }

    return JSON.stringify({
      success: true,
      task: {
        id: task.id,
        project_id: projectId,
        title: task.title,
        status: task.status,
        priority: task.priority,
      },
      message: `Research logged to project #${projectId} as task #${task.id} (review)`,
    });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to log research' });
  }
}

// ============================================================================
// kanban_add_attachment
// ============================================================================

export function getKanbanAddAttachmentToolDefinition() {
  return {
    name: 'kanban_add_attachment',
    description: `Add a file, link, screenshot, or folder attachment to a Kanban task.

Examples:
- kanban_add_attachment(task_id=1, type="link", name="Design doc", path="https://figma.com/...")
- kanban_add_attachment(task_id=1, type="screenshot", name="homepage.png", path="/path/to/screenshot.png")
- kanban_add_attachment(task_id=1, type="folder", name="project-files", path="/Users/me/project")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID to attach to' },
        type: { type: 'string', enum: ['file', 'screenshot', 'link', 'folder'], description: 'Attachment type' },
        name: { type: 'string', description: 'Display name for the attachment' },
        path: { type: 'string', description: 'File path or URL' },
      },
      required: ['task_id', 'type', 'name', 'path'],
    },
  };
}

export async function handleKanbanAddAttachmentTool(input: unknown): Promise<string> {
  const params = input as { task_id: number; type: string; name: string; path: string };
  if (!params.task_id || !params.type || !params.name || !params.path) {
    return JSON.stringify({ error: 'task_id, type, name, and path are required' });
  }

  const validTypes = ['file', 'screenshot', 'link', 'folder'];
  if (!validTypes.includes(params.type)) {
    return JSON.stringify({ error: `Invalid type. Use: ${validTypes.join(', ')}` });
  }

  try {
    const attachment = KanbanService.addAttachment(params.task_id, {
      type: params.type as 'file' | 'screenshot' | 'link' | 'folder',
      name: params.name,
      path: params.path,
    });
    return JSON.stringify({ success: true, attachment: { id: attachment.id, name: attachment.name, type: attachment.type } });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to add attachment' });
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
    { ...getKanbanMoveTaskToProjectToolDefinition(), handler: handleKanbanMoveTaskToProjectTool },
    { ...getKanbanGetBoardToolDefinition(), handler: handleKanbanGetBoardTool },
    { ...getKanbanGetTaskToolDefinition(), handler: handleKanbanGetTaskTool },
    { ...getKanbanDeleteTaskToolDefinition(), handler: handleKanbanDeleteTaskTool },
    { ...getKanbanAddCommentToolDefinition(), handler: handleKanbanAddCommentTool },
    { ...getKanbanReviewTaskToolDefinition(), handler: handleKanbanReviewTaskTool },
    { ...getKanbanLogResearchToolDefinition(), handler: handleKanbanLogResearchTool },
    { ...getKanbanAddAttachmentToolDefinition(), handler: handleKanbanAddAttachmentTool },
  ];
}

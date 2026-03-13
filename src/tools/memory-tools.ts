/**
 * Memory tools for the agent
 *
 * - remember: Save facts to long-term memory
 * - forget: Remove facts from memory
 */

import { MemoryManager } from '../memory';

let memoryManager: MemoryManager | null = null;

export function setMemoryManager(memory: MemoryManager): void {
  memoryManager = memory;
}

/**
 * Remember tool definition
 */
export function getRememberToolDefinition() {
  return {
    name: 'remember',
    description: `Save important information to long-term memory. Use proactively when user shares personal info, preferences, projects, people, or decisions.

IMPORTANT: Use UNIQUE subject names to prevent overwriting previous facts:
- Good: project_rule_ken, project_rule_semantics, preference_voice_speed
- Bad: project_rule (overwrites previous rules with same subject)

Format: {type}_{identifier} -e.g., routing_ken, preference_coffee, person_mom

Categories: user_info, preferences, projects, people, work, notes, decisions, rules.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Category: user_info, preferences, projects, people, work, notes, decisions, rules',
        },
        subject: {
          type: 'string',
          description: 'UNIQUE identifier for this fact. Use format: type_specific (e.g., "routing_ken", "preference_voice", "person_mom"). Same category+subject OVERWRITES existing fact.',
        },
        content: {
          type: 'string',
          description: 'The fact to remember',
        },
      },
      required: ['category', 'subject', 'content'],
    },
  };
}

/**
 * Remember tool handler
 */
export async function handleRememberTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { category, subject, content } = input as {
    category: string;
    subject: string;
    content: string;
  };

  if (!category || !subject || !content) {
    return JSON.stringify({ error: 'Missing required fields: category, subject, content' });
  }

  const id = memoryManager.saveFact(category, subject, content);
  console.log(`[Remember] Saved: [${category}] ${subject}: ${content}`);

  return JSON.stringify({
    success: true,
    message: `Remembered: ${subject}`,
    id,
    category,
    subject,
  });
}

/**
 * Forget tool definition
 */
export function getForgetToolDefinition() {
  return {
    name: 'forget',
    description: 'Remove a fact from long-term memory. Forget by category + subject, or by fact ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Category of the fact to forget',
        },
        subject: {
          type: 'string',
          description: 'Subject of the fact to forget',
        },
        id: {
          type: 'number',
          description: 'Fact ID (alternative to category+subject)',
        },
      },
      required: [],
    },
  };
}

/**
 * Forget tool handler
 */
export async function handleForgetTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { category, subject, id } = input as {
    category?: string;
    subject?: string;
    id?: number;
  };

  let deleted = false;

  if (id !== undefined) {
    deleted = memoryManager.deleteFact(id);
  } else if (category && subject) {
    deleted = memoryManager.deleteFactBySubject(category, subject);
  } else {
    return JSON.stringify({ error: 'Provide either id OR category+subject' });
  }

  if (deleted) {
    console.log(`[Forget] Deleted: ${id ?? `${category}/${subject}`}`);
    return JSON.stringify({ success: true, message: 'Fact forgotten' });
  } else {
    return JSON.stringify({ success: false, message: 'Fact not found' });
  }
}

/**
 * List facts tool definition (for /facts command)
 */
export function getListFactsToolDefinition() {
  return {
    name: 'list_facts',
    description: 'List all known facts from memory. Use when user asks "what do you know about me" or similar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Optional: filter by category',
        },
      },
      required: [],
    },
  };
}

/**
 * List facts tool handler
 */
export async function handleListFactsTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { category } = input as { category?: string };

  let facts;
  if (category) {
    facts = memoryManager.getFactsByCategory(category);
  } else {
    facts = memoryManager.getAllFacts();
  }

  if (facts.length === 0) {
    return JSON.stringify({
      success: true,
      message: category ? `No facts in category: ${category}` : 'No facts stored yet',
      facts: [],
    });
  }

  return JSON.stringify({
    success: true,
    count: facts.length,
    facts: facts.map(f => ({
      id: f.id,
      category: f.category,
      subject: f.subject,
      content: f.content,
    })),
  });
}

/**
 * Memory search tool definition
 */
export function getMemorySearchToolDefinition() {
  return {
    name: 'memory_search',
    description: `Search EVERYTHING in the system: facts, conversation messages, cron jobs, reminders, kanban projects, kanban tasks, daily logs, cron history. This is your most powerful recall tool.

ALWAYS use this BEFORE saying you can't find something. Searches across ALL tables and ALL sessions.

Returns categorized results from every data source in the system.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query - use specific keywords. Try single important words if multi-word search returns nothing.',
        },
      },
      required: ['query'],
    },
  };
}

/**
 * Memory search tool handler
 */
export async function handleMemorySearchTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { query } = input as { query: string };

  if (!query || query.trim().length === 0) {
    return JSON.stringify({ error: 'Query is required' });
  }

  try {
    // Search facts (semantic + keyword) AND everything else (keyword) in parallel
    const [factResults, everything] = await Promise.all([
      memoryManager.searchFactsHybrid(query),
      Promise.resolve(memoryManager.searchEverything(query)),
    ]);

    const totalResults = factResults.length + everything.messages.length + everything.cronJobs.length +
      everything.kanbanTasks.length + everything.kanbanProjects.length + everything.tasks.length +
      everything.dailyLogs.length + everything.cronHistory.length;

    if (totalResults === 0) {
      return JSON.stringify({
        success: true,
        message: 'Nothing found anywhere in the system. Try different or simpler keywords.',
      });
    }

    console.log(`[MemorySearch] "${query}" => ${factResults.length} facts, ${everything.messages.length} messages, ${everything.cronJobs.length} crons, ${everything.kanbanTasks.length} kanban tasks, ${everything.kanbanProjects.length} projects, ${everything.tasks.length} tasks, ${everything.dailyLogs.length} logs, ${everything.cronHistory.length} history`);

    // Build compact response with only non-empty sections
    const response: Record<string, unknown> = { success: true, totalResults };

    if (factResults.length > 0) {
      response.facts = factResults.map(r => ({
        id: r.fact.id, category: r.fact.category, subject: r.fact.subject,
        content: r.fact.content, score: Math.round(r.score * 100) / 100,
      }));
    }
    if (everything.messages.length > 0) {
      response.messages = everything.messages.map(m => ({
        id: m.id, role: m.role, timestamp: m.timestamp,
        content: m.content.length > 1500 ? m.content.substring(0, 1500) + '...' : m.content,
      }));
    }
    if (everything.cronJobs.length > 0) {
      response.cronJobs = everything.cronJobs;
    }
    if (everything.kanbanProjects.length > 0) {
      response.kanbanProjects = everything.kanbanProjects;
    }
    if (everything.kanbanTasks.length > 0) {
      response.kanbanTasks = everything.kanbanTasks;
    }
    if (everything.tasks.length > 0) {
      response.tasks = everything.tasks;
    }
    if (everything.dailyLogs.length > 0) {
      response.dailyLogs = everything.dailyLogs.map(l => ({
        date: l.date, content: l.content.length > 1000 ? l.content.substring(0, 1000) + '...' : l.content,
      }));
    }
    if (everything.cronHistory.length > 0) {
      response.cronHistory = everything.cronHistory.map(h => ({
        jobName: h.jobName, timestamp: h.timestamp,
        response: h.response.length > 500 ? h.response.substring(0, 500) + '...' : h.response,
      }));
    }

    return JSON.stringify(response);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MemorySearch] Failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

/**
 * Daily log tool definition
 */
export function getDailyLogToolDefinition() {
  return {
    name: 'daily_log',
    description: "Add an entry to today's daily log. Record significant conversations, completed tasks, user mood, or key events.",
    input_schema: {
      type: 'object' as const,
      properties: {
        entry: {
          type: 'string',
          description: 'The log entry to add (will be timestamped automatically)',
        },
      },
      required: ['entry'],
    },
  };
}

/**
 * Daily log tool handler
 */
export async function handleDailyLogTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { entry } = input as { entry: string };

  if (!entry || entry.trim().length === 0) {
    return JSON.stringify({ error: 'Entry is required' });
  }

  const log = memoryManager.appendToDailyLog(entry.trim());
  console.log(`[DailyLog] Added: ${entry.trim()}`);

  return JSON.stringify({
    success: true,
    message: 'Entry added to daily log',
    date: log.date,
  });
}

/**
 * Get all memory tools
 */
export function getMemoryTools() {
  return [
    {
      ...getRememberToolDefinition(),
      handler: handleRememberTool,
    },
    {
      ...getForgetToolDefinition(),
      handler: handleForgetTool,
    },
    {
      ...getListFactsToolDefinition(),
      handler: handleListFactsTool,
    },
    {
      ...getMemorySearchToolDefinition(),
      handler: handleMemorySearchTool,
    },
    {
      ...getDailyLogToolDefinition(),
      handler: handleDailyLogTool,
    },
  ];
}

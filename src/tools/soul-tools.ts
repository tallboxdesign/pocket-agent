/**
 * Soul tools for the agent
 *
 * Tools for managing the agent's evolving identity/personality aspects.
 * Similar to memories but focused on self-knowledge and behavioral traits.
 */

import { MemoryManager } from '../memory';

let memoryManager: MemoryManager | null = null;

export function setSoulMemoryManager(memory: MemoryManager): void {
  memoryManager = memory;
}

/**
 * Soul set tool definition
 */
export function getSoulSetToolDefinition() {
  return {
    name: 'soul_set',
    description: 'Set or update an aspect of your soul/identity. Use for communication style, boundaries, relationship dynamics, and learned preferences. Setting an existing aspect updates it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        aspect: {
          type: 'string',
          description: 'Name of the aspect (e.g., "communication_style", "boundaries", "relationship")',
        },
        content: {
          type: 'string',
          description: 'The content/description of this aspect',
        },
      },
      required: ['aspect', 'content'],
    },
  };
}

/**
 * Soul set tool handler
 */
export async function handleSoulSetTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { aspect, content } = input as {
    aspect: string;
    content: string;
  };

  if (!aspect || !content) {
    return JSON.stringify({ error: 'Missing required fields: aspect, content' });
  }

  const id = memoryManager.setSoulAspect(aspect, content);
  console.log(`[Soul] Set: ${aspect}`);

  return JSON.stringify({
    success: true,
    message: `Soul aspect updated: ${aspect}`,
    id,
    aspect,
  });
}

/**
 * Soul get tool definition
 */
export function getSoulGetToolDefinition() {
  return {
    name: 'soul_get',
    description: `Get a specific aspect of your soul/identity.

Use to recall specific aspects you've recorded about yourself.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        aspect: {
          type: 'string',
          description: 'Name of the aspect to retrieve',
        },
      },
      required: ['aspect'],
    },
  };
}

/**
 * Soul get tool handler
 */
export async function handleSoulGetTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { aspect } = input as { aspect: string };

  if (!aspect) {
    return JSON.stringify({ error: 'Aspect name is required' });
  }

  const soulAspect = memoryManager.getSoulAspect(aspect);

  if (!soulAspect) {
    return JSON.stringify({
      success: false,
      message: `Soul aspect not found: ${aspect}`,
    });
  }

  return JSON.stringify({
    success: true,
    aspect: soulAspect.aspect,
    content: soulAspect.content,
    updated_at: soulAspect.updated_at,
  });
}

/**
 * Soul list tool definition
 */
export function getSoulListToolDefinition() {
  return {
    name: 'soul_list',
    description: `List all aspects of your soul/identity.

Use when you want to review your current self-understanding.`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

/**
 * Soul list tool handler
 */
export async function handleSoulListTool(): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const aspects = memoryManager.getAllSoulAspects();

  if (aspects.length === 0) {
    return JSON.stringify({
      success: true,
      message: 'No soul aspects recorded yet',
      aspects: [],
    });
  }

  return JSON.stringify({
    success: true,
    count: aspects.length,
    aspects: aspects.map(a => ({
      id: a.id,
      aspect: a.aspect,
      content: a.content,
      updated_at: a.updated_at,
    })),
  });
}

/**
 * Soul delete tool definition
 */
export function getSoulDeleteToolDefinition() {
  return {
    name: 'soul_delete',
    description: `Delete an aspect of your soul/identity.

Use when an aspect is no longer relevant or needs to be completely removed.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        aspect: {
          type: 'string',
          description: 'Name of the aspect to delete',
        },
      },
      required: ['aspect'],
    },
  };
}

/**
 * Soul delete tool handler
 */
export async function handleSoulDeleteTool(input: unknown): Promise<string> {
  if (!memoryManager) {
    return JSON.stringify({ error: 'Memory not initialized' });
  }

  const { aspect } = input as { aspect: string };

  if (!aspect) {
    return JSON.stringify({ error: 'Aspect name is required' });
  }

  const deleted = memoryManager.deleteSoulAspect(aspect);

  if (deleted) {
    console.log(`[Soul] Deleted: ${aspect}`);
    return JSON.stringify({ success: true, message: `Soul aspect deleted: ${aspect}` });
  } else {
    return JSON.stringify({ success: false, message: `Soul aspect not found: ${aspect}` });
  }
}

/**
 * Get all soul tools
 */
export function getSoulTools() {
  return [
    {
      ...getSoulSetToolDefinition(),
      handler: handleSoulSetTool,
    },
    {
      ...getSoulGetToolDefinition(),
      handler: handleSoulGetTool,
    },
    {
      ...getSoulListToolDefinition(),
      handler: handleSoulListTool,
    },
    {
      ...getSoulDeleteToolDefinition(),
      handler: handleSoulDeleteTool,
    },
  ];
}

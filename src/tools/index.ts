/**
 * Tool configurations for the agent
 *
 * Available capabilities:
 * - File/Terminal: Built-in with claude_code preset
 * - Browser: Three-tier system (HTTP, Electron, CDP)
 * - Desktop: Anthropic computer use tool (Docker recommended)
 *
 * Custom tools use SDK MCP servers (in-process) via createSdkMcpServer()
 */

import { execSync } from 'child_process';
import { getBrowserToolDefinition, handleBrowserTool } from '../browser';
import { getMemoryTools } from './memory-tools';
import { getSoulTools } from './soul-tools';
import { getSchedulerTools } from './scheduler-tools';
import { getCalendarTools } from './calendar-tools';
import { getTaskTools } from './task-tools';
import { getKanbanTools } from './kanban-tools';
import { getGmailTools } from './gmail-tools';
import { getGlmWorkerTools } from './glm-worker';
import { getVoiceTools } from './voice-tools';
import {
  getSendTelegramPhotoToolDefinition,
  handleSendTelegramPhotoTool,
} from './telegram-photo-tool';
import {
  getNotifyToolDefinition,
  handleNotifyTool,
  getPtyExecToolDefinition,
  handlePtyExecTool,
} from './macos';
import { wrapToolHandler, getToolTimeout, logActiveToolsStatus } from './diagnostics';

export { logActiveToolsStatus } from './diagnostics';

// Start periodic check for stuck tools (every 30 seconds)
setInterval(() => {
  logActiveToolsStatus();
}, 30000);

export { setMemoryManager } from './memory-tools';
export { setSoulMemoryManager } from './soul-tools';
export { setPhotoToolMemoryManager } from './telegram-photo-tool';
export { getSchedulerTools } from './scheduler-tools';
export { getCalendarTools } from './calendar-tools';
export { getTaskTools, closeTaskDb } from './task-tools';
export { getKanbanTools } from './kanban-tools';
export { getGmailTools } from './gmail-tools';
export { getGlmWorkerTools } from './glm-worker';
export { closeKanbanDb } from '../kanban';
export { showNotification, execWithPty } from './macos';
export { setCurrentSessionId, getCurrentSessionId } from './session-context';

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ToolsConfig {
  mcpServers: Record<string, MCPServerConfig>;
  computerUse: {
    enabled: boolean;
    dockerized: boolean;
    displaySize?: { width: number; height: number };
  };
  browser: {
    enabled: boolean;
    cdpUrl?: string; // Default: http://localhost:9222
  };
}

/**
 * Default tools configuration
 */
export function getDefaultToolsConfig(): ToolsConfig {
  return {
    mcpServers: {},
    computerUse: {
      enabled: false,
      dockerized: true,
      displaySize: { width: 1920, height: 1080 },
    },
    browser: {
      enabled: true,
      cdpUrl: 'http://localhost:9222',
    },
  };
}

/**
 * Build MCP server configurations (for child process MCP servers)
 */
export function buildMCPServers(config: ToolsConfig): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};

  // Computer use server (for desktop automation) - runs as child process
  if (config.computerUse.enabled) {
    if (config.computerUse.dockerized) {
      servers['computer'] = {
        command: 'docker',
        args: [
          'run',
          '-i',
          '--rm',
          '-e',
          `DISPLAY_WIDTH=${config.computerUse.displaySize?.width || 1920}`,
          '-e',
          `DISPLAY_HEIGHT=${config.computerUse.displaySize?.height || 1080}`,
          'ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest',
        ],
      };
    } else {
      servers['computer'] = {
        command: 'npx',
        args: ['-y', '@anthropic-ai/computer-use-server'],
      };
    }
  }

  // Merge with any custom servers
  return { ...servers, ...config.mcpServers };
}

/**
 * Build SDK MCP servers (in-process tools)
 * These run in the same process as the agent, so they can access Electron APIs
 */
export async function buildSdkMcpServers(
  config: ToolsConfig
): Promise<Record<string, unknown> | null> {
  // Dynamically import SDK to avoid CommonJS issues
  // Using Function constructor for dynamic ESM imports in CommonJS context
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = any>(
    specifier: string
  ) => Promise<T>;

  try {
    const sdk = await dynamicImport<typeof import('@anthropic-ai/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');
    const { createSdkMcpServer, tool } = sdk;
    const zodModule = await dynamicImport<typeof import('zod')>('zod');
    const { z } = zodModule;

    const tools = [];

    // Wrap handlers with diagnostics (timing, logging, timeouts)
    const wrappedBrowserHandler = wrapToolHandler('browser', handleBrowserTool, getToolTimeout('browser'));
    const wrappedNotifyHandler = wrapToolHandler('notify', handleNotifyTool, getToolTimeout('notify'));
    const wrappedPtyExecHandler = wrapToolHandler('pty_exec', handlePtyExecTool, getToolTimeout('pty_exec'));

    // Browser tool (if enabled)
    if (config.browser.enabled) {
      const browserTool = tool(
        'browser',
        getBrowserToolDefinition().description,
        {
          action: z.enum([
            'navigate',
            'screenshot',
            'click',
            'type',
            'evaluate',
            'extract',
            'scroll',
            'hover',
            'download',
            'upload',
            'tabs_list',
            'tabs_open',
            'tabs_close',
            'tabs_focus',
          ]),
          url: z.string().optional(),
          selector: z.string().optional(),
          text: z.string().optional(),
          script: z.string().optional(),
          extract_type: z.enum(['text', 'html', 'links', 'tables', 'structured']).optional(),
          scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
          scroll_amount: z.number().optional(),
          download_path: z.string().optional(),
          file_path: z.string().optional(),
          tab_id: z.string().optional(),
          requires_auth: z.boolean().optional(),
          tier: z.enum(['electron', 'cdp']).optional(),
          wait_for: z.union([z.string(), z.number()]).optional(),
        },
        async (args) => {
          const result = await wrappedBrowserHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(browserTool);
    }

    // Notify tool
    const notifyTool = tool(
      'notify',
      getNotifyToolDefinition().description,
      {
        title: z.string(),
        body: z.string().optional(),
        subtitle: z.string().optional(),
        silent: z.boolean().optional(),
        urgency: z.enum(['low', 'normal', 'critical']).optional(),
      },
      async (args) => {
        const result = await wrappedNotifyHandler(args);
        return { content: [{ type: 'text', text: result }] };
      }
    );
    tools.push(notifyTool);

    // PTY exec tool
    const ptyExecTool = tool(
      'pty_exec',
      getPtyExecToolDefinition().description,
      {
        command: z.string(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        timeout: z.number().optional(),
      },
      async (args) => {
        const result = await wrappedPtyExecHandler(args);
        return { content: [{ type: 'text', text: result }] };
      }
    );
    tools.push(ptyExecTool);

    // Memory tools (with diagnostics wrapper)
    const memoryTools = getMemoryTools();
    for (const memTool of memoryTools) {
      const wrappedHandler = wrapToolHandler(memTool.name, memTool.handler, getToolTimeout(memTool.name));
      const sdkTool = tool(
        memTool.name,
        memTool.description,
        // Convert JSON schema to Zod (simplified - assumes string fields)
        Object.fromEntries(
          Object.entries(memTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Soul tools (with diagnostics wrapper)
    const soulTools = getSoulTools();
    for (const soulTool of soulTools) {
      const wrappedHandler = wrapToolHandler(soulTool.name, soulTool.handler, getToolTimeout(soulTool.name));
      const sdkTool = tool(
        soulTool.name,
        soulTool.description,
        Object.fromEntries(
          Object.entries(soulTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Scheduler tools (with diagnostics wrapper)
    const schedulerTools = getSchedulerTools();
    for (const schedTool of schedulerTools) {
      const wrappedHandler = wrapToolHandler(schedTool.name, schedTool.handler, getToolTimeout(schedTool.name));
      const sdkTool = tool(
        schedTool.name,
        schedTool.description,
        Object.fromEntries(
          Object.entries(schedTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            if (prop.type === 'boolean') return [key, z.boolean().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Calendar tools (with diagnostics wrapper)
    const calendarTools = getCalendarTools();
    for (const calTool of calendarTools) {
      const wrappedHandler = wrapToolHandler(calTool.name, calTool.handler, getToolTimeout(calTool.name));
      const sdkTool = tool(
        calTool.name,
        calTool.description,
        Object.fromEntries(
          Object.entries(calTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Task tools (with diagnostics wrapper)
    const taskTools = getTaskTools();
    for (const taskTool of taskTools) {
      const wrappedHandler = wrapToolHandler(taskTool.name, taskTool.handler, getToolTimeout(taskTool.name));
      const sdkTool = tool(
        taskTool.name,
        taskTool.description,
        Object.fromEntries(
          Object.entries(taskTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Kanban tools (with diagnostics wrapper)
    const kanbanTools = getKanbanTools();
    for (const kanbanTool of kanbanTools) {
      const wrappedHandler = wrapToolHandler(kanbanTool.name, kanbanTool.handler, getToolTimeout(kanbanTool.name));
      const sdkTool = tool(
        kanbanTool.name,
        kanbanTool.description,
        Object.fromEntries(
          Object.entries(kanbanTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            if (prop.type === 'boolean') return [key, z.boolean().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Gmail tools (with diagnostics wrapper)
    const gmailTools = getGmailTools();
    for (const gmailTool of gmailTools) {
      const wrappedHandler = wrapToolHandler(gmailTool.name, gmailTool.handler, getToolTimeout(gmailTool.name));
      const sdkTool = tool(
        gmailTool.name,
        gmailTool.description,
        Object.fromEntries(
          Object.entries(gmailTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            if (prop.type === 'boolean') return [key, z.boolean().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // GLM Worker tools (with diagnostics wrapper)
    const glmWorkerTools = getGlmWorkerTools();
    for (const glmTool of glmWorkerTools) {
      const wrappedHandler = wrapToolHandler(glmTool.name, glmTool.handler, getToolTimeout(glmTool.name));
      const sdkTool = tool(
        glmTool.name,
        glmTool.description,
        Object.fromEntries(
          Object.entries(glmTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            if (prop.type === 'boolean') return [key, z.boolean().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Voice tools (with diagnostics wrapper)
    const voiceTools = getVoiceTools();
    for (const voiceTool of voiceTools) {
      const wrappedHandler = wrapToolHandler(voiceTool.name, voiceTool.handler, getToolTimeout(voiceTool.name));
      const sdkTool = tool(
        voiceTool.name,
        voiceTool.description,
        Object.fromEntries(
          Object.entries(voiceTool.input_schema.properties || {}).map(([key, value]: [string, unknown]) => {
            const prop = value as { type?: string };
            if (prop.type === 'string') return [key, z.string().optional()];
            if (prop.type === 'number') return [key, z.number().optional()];
            if (prop.type === 'boolean') return [key, z.boolean().optional()];
            return [key, z.any().optional()];
          })
        ),
        async (args) => {
          const result = await wrappedHandler(args);
          return { content: [{ type: 'text', text: result }] };
        }
      );
      tools.push(sdkTool);
    }

    // Telegram photo tool
    const wrappedPhotoHandler = wrapToolHandler('send_telegram_photo', handleSendTelegramPhotoTool, getToolTimeout('send_telegram_photo'));
    const photoTool = tool(
      'send_telegram_photo',
      getSendTelegramPhotoToolDefinition().description,
      {
        photo_path: z.string(),
        caption: z.string().optional(),
      },
      async (args) => {
        const result = await wrappedPhotoHandler(args);
        return { content: [{ type: 'text', text: result }] };
      }
    );
    tools.push(photoTool);

    // Create the SDK MCP server
    const server = createSdkMcpServer({
      name: 'pocket-agent-tools',
      version: '1.0.0',
      tools,
    });

    return { 'pocket-agent': server };
  } catch (error) {
    console.error('[Tools] Failed to build SDK MCP servers:', error);
    return null;
  }
}

/**
 * Get custom tools for the agent
 */
export function getCustomTools(config: ToolsConfig): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: unknown) => Promise<string>;
}> {
  const tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    handler: (input: unknown) => Promise<string>;
  }> = [];

  // Memory tools (always enabled)
  const memoryTools = getMemoryTools();
  for (const tool of memoryTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Soul tools (always enabled)
  const soulTools = getSoulTools();
  for (const tool of soulTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Browser tool
  if (config.browser.enabled) {
    const browserDef = getBrowserToolDefinition();
    tools.push({
      name: browserDef.name,
      description: browserDef.description,
      input_schema: browserDef.input_schema as Record<string, unknown>,
      handler: handleBrowserTool,
    });
  }

  // Scheduler tools (always enabled - scheduler availability checked at runtime)
  const schedulerTools = getSchedulerTools();
  for (const tool of schedulerTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // macOS tools (notifications and PTY exec)
  const notifyDef = getNotifyToolDefinition();
  tools.push({
    name: notifyDef.name,
    description: notifyDef.description,
    input_schema: notifyDef.input_schema as Record<string, unknown>,
    handler: handleNotifyTool,
  });

  const ptyExecDef = getPtyExecToolDefinition();
  tools.push({
    name: ptyExecDef.name,
    description: ptyExecDef.description,
    input_schema: ptyExecDef.input_schema as Record<string, unknown>,
    handler: handlePtyExecTool,
  });

  // Calendar tools
  const calendarTools = getCalendarTools();
  for (const tool of calendarTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Task tools
  const taskTools = getTaskTools();
  for (const tool of taskTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Kanban tools
  const kanbanTools = getKanbanTools();
  for (const tool of kanbanTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Gmail tools
  const gmailToolsCustom = getGmailTools();
  for (const gmailTool of gmailToolsCustom) {
    tools.push({
      name: gmailTool.name,
      description: gmailTool.description,
      input_schema: gmailTool.input_schema as Record<string, unknown>,
      handler: gmailTool.handler,
    });
  }

  // GLM Worker tools
  const glmWorkerToolsCustom = getGlmWorkerTools();
  for (const glmTool of glmWorkerToolsCustom) {
    tools.push({
      name: glmTool.name,
      description: glmTool.description,
      input_schema: glmTool.input_schema as Record<string, unknown>,
      handler: glmTool.handler,
    });
  }

  // Voice tools
  const voiceToolsCustom = getVoiceTools();
  for (const voiceTool of voiceToolsCustom) {
    tools.push({
      name: voiceTool.name,
      description: voiceTool.description,
      input_schema: voiceTool.input_schema as Record<string, unknown>,
      handler: voiceTool.handler,
    });
  }

  // Telegram photo tool
  const photoDef = getSendTelegramPhotoToolDefinition();
  tools.push({
    name: photoDef.name,
    description: photoDef.description,
    input_schema: photoDef.input_schema as Record<string, unknown>,
    handler: handleSendTelegramPhotoTool,
  });

  // Telegram restart tool
  tools.push({
    name: 'restart_telegram',
    description: 'Restart the Telegram bot connection. Use when Telegram is unresponsive or disconnected.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
    handler: async () => {
      try {
        const { restartTelegramBot } = await import('../channels/telegram');
        const result = await restartTelegramBot();
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Failed to restart Telegram' });
      }
    },
  });

  return tools;
}

/**
 * Validate that required environment variables are set
 */
export function validateToolsConfig(config: ToolsConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.computerUse.enabled && config.computerUse.dockerized) {
    // Check if Docker is available
    try {
      execSync('docker --version', { stdio: 'ignore' });
    } catch {
      errors.push('Docker not available (required for safe computer use)');
    }
  }

  return { valid: errors.length === 0, errors };
}

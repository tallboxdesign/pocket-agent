/**
 * Shared command/workflow loader
 *
 * Reads workflow command files from ~/Documents/Pocket-agent/.claude/commands/
 * Used by both the IPC handler (desktop) and Telegram bot.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface WorkflowCommand {
  name: string;
  description: string;
  filename: string;
  content: string;
}

function getCommandsDir(): string {
  return path.join(os.homedir(), 'Documents', 'Pocket-agent', '.claude', 'commands');
}

/**
 * Load all workflow commands from the commands directory
 */
export function loadWorkflowCommands(): WorkflowCommand[] {
  const commandsDir = getCommandsDir();

  try {
    if (!fs.existsSync(commandsDir)) return [];

    const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
    return files.map(filename => {
      const filePath = path.join(commandsDir, filename);
      const raw = fs.readFileSync(filePath, 'utf-8');

      // Parse YAML frontmatter
      let name = filename.replace(/\.md$/, '');
      let description = '';
      let content = raw;

      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (fmMatch) {
        const frontmatter = fmMatch[1];
        content = fmMatch[2].trim();
        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
      }

      return { name, description, filename, content };
    });
  } catch (err) {
    console.error('[Commands] Failed to list commands:', err);
    return [];
  }
}

/**
 * Find a specific workflow command by name
 */
export function findWorkflowCommand(commandName: string): WorkflowCommand | undefined {
  const commands = loadWorkflowCommands();
  return commands.find(c => c.name === commandName);
}

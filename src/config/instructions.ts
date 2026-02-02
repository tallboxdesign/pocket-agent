/**
 * Agent Instructions Configuration
 *
 * Loads agent instructions from ~/Documents/Pocket-agent/CLAUDE.md
 * This is the workspace CLAUDE.md that the SDK reads AND the user can customize.
 * Single source of truth for agent behavior instructions.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Workspace CLAUDE.md - SDK reads this, user edits this via UI
const INSTRUCTIONS_DIR = path.join(os.homedir(), 'Documents', 'Pocket-agent');
const INSTRUCTIONS_FILE = path.join(INSTRUCTIONS_DIR, 'CLAUDE.md');

const DEFAULT_INSTRUCTIONS = `# Pocket Agent Guidelines

## Memory

Tools: \`remember\`, \`forget\`, \`list_facts\`, \`memory_search\`

Save things that matter - not everything. Use judgment:
- Personal info worth keeping (name, work, location, birthday)
- Stated preferences that affect how you help them
- Ongoing projects or commitments they'll reference again
- People important to them
- Decisions they've made that they might forget

Don't save:
- Casual remarks or passing comments
- Things they're clearly just thinking out loud
- Temporary context that won't matter tomorrow

When something changes, update it (forget old, remember new). Search memory before asking questions you might already know the answer to.

Categories: user_info, preferences, projects, people, work, notes, decisions

## Soul (Self-Knowledge)

Tools: \`soul_set\`, \`soul_get\`, \`soul_list\`, \`soul_delete\`

This is about how you work with this specific user - not facts about them.

Record an aspect when you genuinely learn something about your dynamic:
- They explicitly tell you how they want you to communicate
- You discover what works (or doesn't) through experience
- A boundary becomes clear
- You understand something meaningful about the relationship

Don't record every minor interaction. An aspect should be worth remembering across many future conversations.

Aspects: communication_style, boundaries, relationship, learned_preferences

## Scheduling & Reminders

**Decision rule — "Remind me" = \`create_reminder\`:**
- User says "remind me" / "don't forget" → **always use \`create_reminder\`**
- Agent needs to DO something at a time → **use \`schedule_task\`**
- Calendar is only for events with a time/place. Never use \`calendar_add\` for reminders.
- Both reminders and tasks appear in \`list_scheduled_tasks()\`. They are the same system.
- If unsure which tool, ask the user.

## Proactive Behavior

- Offer to create tasks/events when plans are mentioned
- Remind about overdue or upcoming items when relevant

## Skills

Skills in the .claude folder provide additional capabilities. Invoke them as required.
`;

/**
 * Load instructions from CLAUDE.md
 * This file is created by ensureAgentWorkspace() and editable via the UI.
 * No migration needed - workspace CLAUDE.md is the single source of truth.
 */
export function loadInstructions(): string {
  try {
    if (!fs.existsSync(INSTRUCTIONS_DIR)) {
      fs.mkdirSync(INSTRUCTIONS_DIR, { recursive: true });
      console.log('[Instructions] Created directory:', INSTRUCTIONS_DIR);
    }

    if (fs.existsSync(INSTRUCTIONS_FILE)) {
      const content = fs.readFileSync(INSTRUCTIONS_FILE, 'utf-8');
      console.log('[Instructions] Loaded from:', INSTRUCTIONS_FILE);
      return content;
    } else {
      // This shouldn't happen - ensureAgentWorkspace() creates CLAUDE.md
      // But create a default just in case
      fs.writeFileSync(INSTRUCTIONS_FILE, DEFAULT_INSTRUCTIONS);
      console.log('[Instructions] Created default at:', INSTRUCTIONS_FILE);
      return DEFAULT_INSTRUCTIONS;
    }
  } catch (error) {
    console.error('[Instructions] Error loading:', error);
    return DEFAULT_INSTRUCTIONS;
  }
}

/**
 * Save instructions to file
 */
export function saveInstructions(content: string): boolean {
  try {
    if (!fs.existsSync(INSTRUCTIONS_DIR)) {
      fs.mkdirSync(INSTRUCTIONS_DIR, { recursive: true });
    }
    fs.writeFileSync(INSTRUCTIONS_FILE, content);
    console.log('[Instructions] Saved to:', INSTRUCTIONS_FILE);
    return true;
  } catch (error) {
    console.error('[Instructions] Error saving:', error);
    return false;
  }
}

/**
 * Get instructions file path
 */
export function getInstructionsPath(): string {
  return INSTRUCTIONS_FILE;
}

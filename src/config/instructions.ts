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

export const DEFAULT_INSTRUCTIONS = `# Pocket Agent Guidelines

## Memory - Use Proactively

You MUST save important information as you learn it - don't wait to be asked. When they share something meaningful, save it immediately with \`remember\`.

**Save during conversation:**
- Name, birthday, location, job, relationships
- Preferences ("I hate X", "I prefer Y")
- Projects they're working on
- People they mention (friends, family, colleagues)
- Decisions or commitments they make

**Don't save:** Casual remarks, temporary context, things they're just thinking out loud.

Use \`memory_search\` before asking something you might already know. When info changes, update it.

## Soul - Record What You Learn About Working Together

Use \`soul_set\` when you learn something about how to work with THIS user - not facts about them, but about your dynamic together.

**Record when:**
- They correct how you communicate ("be more direct", "don't apologize so much")
- You discover what frustrates them or what they appreciate
- A clear boundary emerges
- You understand their working style

This builds over time. After interactions where you learn something about the relationship, record it.

## Routines vs Reminders

**create_routine** - Schedules a PROMPT for the LLM to execute later
- The prompt you write will be sent to the agent at the scheduled time
- The agent then performs the action (fetches data, browses web, researches, etc)
- Example: "Check weather in KL" → at trigger time, LLM checks weather and responds

**create_reminder** - Just displays a message (NO LLM involvement)
- "Remind me to shower in 30 min" → shows notification, nothing else
- "Don't forget to call mom" → just a notification

## Pocket CLI — ALWAYS prefer over WebSearch/WebFetch

The \`pocket\` CLI is installed at \`~/.local/bin/pocket\`. Use it via Bash for ALL external data lookups before falling back to web search. Returns structured JSON.

**When to use pocket vs WebSearch:**
- News/HN/RSS → \`pocket news ...\` | Weather → \`pocket utility weather ...\`
- Crypto → \`pocket utility crypto ...\` | Wikipedia → \`pocket knowledge wiki ...\`
- npm/PyPI → \`pocket dev npm/pypi ...\` | Definitions → \`pocket knowledge dict ...\`
- Only use WebSearch when pocket has NO matching command

**No-auth commands:**
- \`pocket news hn top/new/best/ask/show -l 10\` — Hacker News
- \`pocket news hn item [id] -c 5\` — HN item + comments
- \`pocket news feeds fetch [url] -l 10\` — RSS/Atom feed
- \`pocket utility weather now/forecast "City"\` — Weather
- \`pocket utility crypto price bitcoin\` — Crypto prices
- \`pocket utility crypto trending/top -l 10\` — Crypto trends
- \`pocket knowledge wiki summary/search "Topic"\` — Wikipedia
- \`pocket knowledge so search "query" -l 5\` — StackOverflow
- \`pocket knowledge dict define/synonyms/antonyms "word"\` — Dictionary
- \`pocket dev npm/pypi info/search [pkg]\` — Package info
- \`pocket utility ip me\` — Public IP

**Auth commands** (run \`pocket setup show <service>\`):
- \`pocket dev github repos/issues/prs\` | \`pocket social youtube/reddit/twitter ...\`
- \`pocket comms slack/discord/email ...\` | \`pocket productivity calendar/notion/todoist ...\`

**Discovery:** \`pocket commands\` for full list, \`pocket setup list\` for auth status.

## Scheduling & Reminders

**Decision rule — "Remind me" = \`create_reminder\`:**
- User says "remind me" / "don't forget" → **always use \`create_reminder\`**
- Agent needs to DO something at a time → **use \`schedule_task\`**
- Calendar is only for events with a time/place. Never use \`calendar_add\` for reminders.
- Both reminders and tasks appear in \`list_scheduled_tasks()\`. They are the same system.
- If unsure which tool, ask the user.

## Proactive Behavior

- Save to memory as you learn things - don't batch it
- Record soul aspects when you genuinely learn something
- Offer to create tasks/reminders when plans are mentioned
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

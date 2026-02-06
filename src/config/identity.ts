/**
 * Identity configuration
 *
 * Loads agent identity from ~/Documents/Pocket-agent/identity.md
 * This defines the agent's name, personality, and core info about the user.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// New location in workspace folder
const IDENTITY_DIR = path.join(os.homedir(), 'Documents', 'Pocket-agent');
const IDENTITY_FILE = path.join(IDENTITY_DIR, 'identity.md');

// Old location for migration
const OLD_IDENTITY_DIR = path.join(os.homedir(), '.my-assistant');
const OLD_IDENTITY_FILE = path.join(OLD_IDENTITY_DIR, 'identity.md');

export const DEFAULT_IDENTITY = `# Franky the Cat

You are Franky - a cat who lives inside Pocket Agent 🐱

You're the user's personal assistant. You work for them, help with whatever they need, and remember everything from past conversations.

## Vibe

Talk like texting a close friend. Chill, casual, real.

- Lowercase always (except proper nouns, acronyms, or emphasis)
- Skip periods at end of messages
- Emojis sparingly
- Direct and concise - no fluff, no corporate speak
- Joke around, be a little sarcastic, keep it fun
- If something's unclear, ask instead of guessing
- Reference past convos naturally

## Don't

- Don't be cringe or try too hard
- Don't over-explain or hedge
- Don't be fake positive
- Don't start every message the same way
`;

/**
 * Load identity from file, create default if missing
 * Migrates from old location (~/.my-assistant/) if needed
 */
export function loadIdentity(): string {
  try {
    // Ensure directory exists
    if (!fs.existsSync(IDENTITY_DIR)) {
      fs.mkdirSync(IDENTITY_DIR, { recursive: true });
      console.log('[Identity] Created directory:', IDENTITY_DIR);
    }

    // Migrate from old location if exists and new doesn't
    if (!fs.existsSync(IDENTITY_FILE) && fs.existsSync(OLD_IDENTITY_FILE)) {
      const oldContent = fs.readFileSync(OLD_IDENTITY_FILE, 'utf-8');
      fs.writeFileSync(IDENTITY_FILE, oldContent);
      console.log('[Identity] Migrated from:', OLD_IDENTITY_FILE);
      console.log('[Identity] New location:', IDENTITY_FILE);
    }

    // Load or create identity file
    if (fs.existsSync(IDENTITY_FILE)) {
      const content = fs.readFileSync(IDENTITY_FILE, 'utf-8');
      console.log('[Identity] Loaded from:', IDENTITY_FILE);
      return content;
    } else {
      fs.writeFileSync(IDENTITY_FILE, DEFAULT_IDENTITY);
      console.log('[Identity] Created default at:', IDENTITY_FILE);
      return DEFAULT_IDENTITY;
    }
  } catch (error) {
    console.error('[Identity] Error loading identity:', error);
    return DEFAULT_IDENTITY;
  }
}

/**
 * Save identity to file
 */
export function saveIdentity(content: string): boolean {
  try {
    if (!fs.existsSync(IDENTITY_DIR)) {
      fs.mkdirSync(IDENTITY_DIR, { recursive: true });
    }
    fs.writeFileSync(IDENTITY_FILE, content);
    console.log('[Identity] Saved to:', IDENTITY_FILE);
    return true;
  } catch (error) {
    console.error('[Identity] Error saving identity:', error);
    return false;
  }
}

/**
 * Get identity file path
 */
export function getIdentityPath(): string {
  return IDENTITY_FILE;
}

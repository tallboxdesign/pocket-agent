/**
 * Telegram photo sending tool
 *
 * Allows the agent to send photos/screenshots to the current Telegram chat.
 * Uses the session context to find the linked Telegram chat.
 */

import { getTelegramBot } from '../channels/telegram';
import { getCurrentSessionId } from './session-context';
import type { MemoryManager } from '../memory';

let memoryManager: MemoryManager | null = null;

export function setPhotoToolMemoryManager(memory: MemoryManager): void {
  memoryManager = memory;
}

export function getSendTelegramPhotoToolDefinition() {
  return {
    name: 'send_telegram_photo',
    description: `Send a photo/image file to the current Telegram chat. Use this after taking a screenshot or when you have an image to share.

The photo is sent to the Telegram chat linked to the current session.

Examples:
- send_telegram_photo(photo_path="/path/to/screenshot.png", caption="Homepage of example.com")
- send_telegram_photo(photo_path="/path/to/chart.png")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        photo_path: { type: 'string', description: 'Absolute path to the image file' },
        caption: { type: 'string', description: 'Optional caption for the photo' },
      },
      required: ['photo_path'],
    },
  };
}

export async function handleSendTelegramPhotoTool(input: unknown): Promise<string> {
  const params = input as { photo_path: string; caption?: string };
  if (!params.photo_path) {
    return JSON.stringify({ error: 'photo_path is required' });
  }

  const bot = getTelegramBot();
  if (!bot) {
    return JSON.stringify({ error: 'Telegram bot is not running' });
  }

  // Find the linked chat for the current session, or fall back to any active chat
  const sessionId = getCurrentSessionId();
  let chatId: number | undefined;

  if (memoryManager) {
    chatId = memoryManager.getChatForSession(sessionId) ?? undefined;
  }

  // Fallback: use any active Telegram chat (e.g. when triggered from desktop UI)
  if (!chatId) {
    const activeChats = bot.getActiveChatIds();
    if (activeChats.length > 0) {
      chatId = activeChats[0];
    }
  }

  if (!chatId) {
    return JSON.stringify({ error: 'No active Telegram chat found. Send a message on Telegram first.' });
  }

  try {
    const success = await bot.sendPhoto(chatId, params.photo_path, params.caption);
    if (success) {
      return JSON.stringify({ success: true, message: `Photo sent to Telegram chat ${chatId}` });
    }
    return JSON.stringify({ error: 'Failed to send photo — file may not exist or bot error' });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to send photo' });
  }
}

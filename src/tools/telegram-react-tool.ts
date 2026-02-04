/**
 * Telegram emoji reaction tool
 *
 * Allows the agent to place an emoji reaction on the user's Telegram message
 * instead of generating a full text reply, saving output tokens.
 */

import { getTelegramBot } from '../channels/telegram';
import { getTelegramMessageContext } from './session-context';

export function getTelegramReactToolDefinition() {
  return {
    name: 'telegram_react',
    description: `Place an emoji reaction on the user's current Telegram message. Use this when a reaction alone is sufficient (e.g., acknowledging a request you're about to execute) instead of sending a text reply.

Examples:
- telegram_react(emoji="👍")  — acknowledge / got it
- telegram_react(emoji="❤️")  — love it
- telegram_react(emoji="🔥")  — impressive`,
    input_schema: {
      type: 'object' as const,
      properties: {
        emoji: { type: 'string', description: 'A single emoji to react with (e.g. 👍, ❤️, 🔥, 😂, 🎉, 👀, 🤔)' },
      },
      required: ['emoji'],
    },
  };
}

export async function handleTelegramReactTool(input: unknown): Promise<string> {
  const params = input as { emoji: string };
  if (!params.emoji) {
    return JSON.stringify({ error: 'emoji is required' });
  }

  const bot = getTelegramBot();
  if (!bot) {
    return JSON.stringify({ error: 'Telegram bot is not running' });
  }

  const msgCtx = getTelegramMessageContext();
  if (!msgCtx) {
    return JSON.stringify({ error: 'No Telegram message context — this tool only works when responding to a Telegram message' });
  }

  try {
    const success = await bot.reactToMessage(msgCtx.chatId, msgCtx.messageId, params.emoji);
    if (success) {
      return JSON.stringify({ success: true, message: `Reacted with ${params.emoji}` });
    }
    return JSON.stringify({ error: 'Failed to set reaction — the emoji may not be supported by Telegram' });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to set reaction' });
  }
}

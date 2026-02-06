/**
 * Telegram text message handler
 */

import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';
import { setTelegramMessageContext } from '../../../tools/session-context';

export interface MessageHandlerDeps {
  onMessageCallback: MessageCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Handle incoming text messages
 */
export async function handleTextMessage(
  ctx: Context,
  deps: MessageHandlerDeps
): Promise<void> {
  const message = ctx.message?.text;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (!message || !chatId) return;

  const { onMessageCallback, sendResponse } = deps;

  if (messageId) setTelegramMessageContext({ chatId, messageId });
  try {
    const result = await withTyping(ctx, async () => {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      return AgentManager.processMessage(message, 'telegram', sessionId);
    });

    await sendResponse(ctx, result.response);

    if (onMessageCallback) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      onMessageCallback({
        userMessage: message,
        response: result.response,
        channel: 'telegram',
        chatId,
        sessionId,
        wasCompacted: result.wasCompacted,
      });
    }

    if (result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error: ${errorMsg}`);
  } finally {
    setTelegramMessageContext(null);
  }
}

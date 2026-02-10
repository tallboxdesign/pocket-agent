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

  console.log(`[Telegram:Text] Received message: "${message?.slice(0, 50)}..." chatId=${chatId}`);

  if (!message || !chatId) {
    console.log('[Telegram:Text] No message or chatId, returning early');
    return;
  }

  const { onMessageCallback, sendResponse } = deps;

  if (messageId) setTelegramMessageContext({ chatId, messageId });

  console.log('[Telegram:Text] Starting withTyping...');
  try {
    const result = await withTyping(ctx, async () => {
      console.log('[Telegram:Text] Inside withTyping, getting sessionId...');
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';
      console.log(`[Telegram:Text] SessionId=${sessionId}, calling processMessage...`);

      const res = await AgentManager.processMessage(message, 'telegram', sessionId);
      console.log(`[Telegram:Text] processMessage returned, response length=${res.response.length}`);
      return res;
    });
    console.log('[Telegram:Text] withTyping completed successfully');

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

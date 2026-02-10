/**
 * Telegram text message handler
 */

import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';
import { setTelegramMessageContext } from '../../../tools/session-context';
import { findWorkflowCommand } from '../../../config/commands-loader';

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

  // Check if this is a workflow slash command (e.g., /create-workflow some context)
  let fullMessage = message;
  if (message.startsWith('/')) {
    const spaceIdx = message.indexOf(' ');
    const commandName = (spaceIdx !== -1 ? message.substring(1, spaceIdx) : message.substring(1))
      .replace(/@\w+$/, ''); // Strip @botname suffix
    const userText = spaceIdx !== -1 ? message.substring(spaceIdx + 1).trim() : '';
    const workflow = findWorkflowCommand(commandName);

    if (workflow) {
      fullMessage = `[Workflow: ${workflow.name}]\n${workflow.content}\n[/Workflow]`;
      if (userText) fullMessage += `\n\n${userText}`;
    }
  }

  console.log('[Telegram:Text] Starting withTyping...');
  try {
    const result = await withTyping(ctx, async () => {
      console.log('[Telegram:Text] Inside withTyping, getting sessionId...');
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';
      console.log(`[Telegram:Text] SessionId=${sessionId}, calling processMessage...`);

      const res = await AgentManager.processMessage(fullMessage, 'telegram', sessionId);
      console.log(`[Telegram:Text] processMessage returned, response length=${res.response.length}`);
      return res;
    });
    console.log('[Telegram:Text] withTyping completed successfully');

    await sendResponse(ctx, result.response);

    // Send media photos if present
    if (result.media && result.media.length > 0 && ctx.chat?.id) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.sendPhotos(ctx.chat.id, result.media);
      }
    }

    // Notify callback for cross-channel sync (to desktop)
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
        media: result.media,
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

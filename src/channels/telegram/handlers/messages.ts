/**
 * Telegram text message handler
 */

import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';
import { setTelegramMessageContext } from '../../../tools/session-context';
import { setActiveChannel } from '../../../tools/voice-tools';
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
  let message = ctx.message?.text;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  console.log(`[Telegram:Text] Received message: "${message?.slice(0, 50)}..." chatId=${chatId}`);

  if (!message || !chatId) {
    console.log('[Telegram:Text] No message or chatId, returning early');
    return;
  }

  // Include quoted reply context so agent sees what the user is responding to
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo) {
    const quotedText = ('text' in replyTo ? replyTo.text : null)
      || ('caption' in replyTo ? replyTo.caption : null);
    if (quotedText) {
      const sender = replyTo.from?.first_name || 'Someone';
      message = `[Replying to ${sender}: "${quotedText.slice(0, 300)}"]\n${message}`;
      console.log(`[Telegram:Text] Reply context added from ${sender}`);
    }
  }

  const { onMessageCallback, sendResponse } = deps;

  if (messageId) setTelegramMessageContext({ chatId, messageId });
  setActiveChannel('telegram');

  // Skip built-in commands — grammy's bot.command() should handle these, but
  // if they fall through (Electron/grammy timing issue), don't send to agent
  if (message.startsWith('/')) {
    const spaceIdx = message.indexOf(' ');
    const cmdName = (spaceIdx !== -1 ? message.substring(1, spaceIdx) : message.substring(1))
      .replace(/@\w+$/, '').toLowerCase();
    const builtInCommands = new Set([
      'start', 'help', 'status', 'mychatid', 'new', 'facts', 'workflow',
      'model', 'voice', 'restart', 'unanswered', 'approve', 'reject',
      'link', 'unlink',
    ]);
    if (builtInCommands.has(cmdName)) {
      console.log(`[Telegram:Text] Built-in command /${cmdName} fell through to text handler, ignoring`);
      return;
    }
  }

  // Check if this is a workflow slash command (e.g., /create-workflow some context)
  let fullMessage = message;
  if (message.startsWith('/')) {
    const spaceIdx = message.indexOf(' ');
    const commandName = (spaceIdx !== -1 ? message.substring(1, spaceIdx) : message.substring(1))
      .replace(/@\w+$/, ''); // Strip @botname suffix
    const userText = spaceIdx !== -1 ? message.substring(spaceIdx + 1).trim() : '';
    // Try exact match first, then try with hyphens instead of underscores (Telegram normalizes to underscores)
    const workflow = findWorkflowCommand(commandName)
      || findWorkflowCommand(commandName.replace(/_/g, '-'));

    console.log(`[Telegram:Text] Slash command: /${commandName}, workflow found: ${!!workflow}`);

    if (workflow) {
      fullMessage = `[Workflow: ${workflow.name}]\n${workflow.content}\n[/Workflow]`;
      if (userText) fullMessage += `\n\n${userText}`;
      console.log(`[Telegram:Text] Executing workflow: ${workflow.name}`);
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
    await ctx.reply(`⚠️ ${errorMsg}`);
  } finally {
    setTelegramMessageContext(null);
    setActiveChannel('desktop');
  }
}

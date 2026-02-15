/**
 * Telegram callback query handler
 * Handles inline keyboard button clicks
 */

import { Context, Bot } from 'grammy';
import { AgentManager } from '../../../agent';
import { CallbackQueryData, MessageCallback } from '../types';
import { withTyping } from '../utils/typing';

export interface CallbackHandlerDeps {
  onMessageCallback: MessageCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Parse callback data string into structured format
 */
export function parseCallbackData(data: string): CallbackQueryData {
  const parts = data.split(':');

  // Format: action:payload or action:subaction:payload or pagination:page
  if (parts[0] === 'page') {
    return {
      action: 'pagination',
      page: parseInt(parts[1], 10) || 0,
    };
  }

  return {
    action: parts[0],
    payload: parts.slice(1).join(':'),
  };
}

/**
 * Handle confirmation dialogs (yes/no)
 */
async function handleConfirmation(
  ctx: Context,
  callbackData: CallbackQueryData,
  deps: CallbackHandlerDeps
): Promise<void> {
  const { sendResponse } = deps;
  const [actionId, response] = (callbackData.payload || '').split(':');

  if (response === 'yes') {
    // Execute the confirmed action
    await ctx.answerCallbackQuery({ text: 'Confirmed!' });

    // Update the message to show it was confirmed
    await ctx.editMessageText(
      `Confirmed: ${actionId}\n\nProcessing...`,
      { reply_markup: undefined }
    );

    // Process the action through the agent
    const chatId = ctx.chat?.id;
    if (chatId) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      try {
        const result = await withTyping(ctx, async () => {
          return AgentManager.processMessage(
            `User confirmed action: ${actionId}`,
            'telegram',
            sessionId
          );
        });

        await sendResponse(ctx, result.response);
      } catch (error) {
        console.error('[Telegram] Confirmation action error:', error);
        await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  } else {
    // Cancelled
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageText(
      `Cancelled: ${actionId}`,
      { reply_markup: undefined }
    );
  }
}

/**
 * Handle location quick actions
 */
async function handleLocationAction(
  ctx: Context,
  callbackData: CallbackQueryData,
  deps: CallbackHandlerDeps
): Promise<void> {
  const { sendResponse } = deps;
  const [action, ...queryParts] = (callbackData.payload || '').split(':');
  const query = queryParts.join(':');

  await ctx.answerCallbackQuery({ text: `Searching for ${query}...` });

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const memory = AgentManager.getMemory();
  const sessionId = memory?.getSessionForChat(chatId) || 'default';

  let prompt: string;

  switch (action) {
    case 'search_nearby':
      prompt = `Search for ${query} near my current location`;
      break;
    case 'directions':
      prompt = `Get directions to ${query} from my current location`;
      break;
    case 'weather':
      prompt = `What's the weather like in ${query}?`;
      break;
    default:
      prompt = `Help me with: ${action} ${query}`;
  }

  try {
    const result = await withTyping(ctx, async () => {
      return AgentManager.processMessage(prompt, 'telegram', sessionId);
    });

    await sendResponse(ctx, result.response);
  } catch (error) {
    console.error('[Telegram] Location action error:', error);
    await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Handle pagination callbacks
 */
async function handlePagination(
  ctx: Context,
  callbackData: CallbackQueryData
): Promise<void> {
  const page = callbackData.page || 0;

  // This is a placeholder - actual pagination would depend on
  // what content is being paginated (facts, tasks, etc.)
  await ctx.answerCallbackQuery({ text: `Page ${page + 1}` });

  // The specific implementation would update the message with new page content
  console.log(`[Telegram] Pagination requested: page ${page}`);
}

/**
 * Handle reaction callbacks (when user clicks a reaction button)
 */
async function handleReactionCallback(
  ctx: Context,
  callbackData: CallbackQueryData,
  _deps: CallbackHandlerDeps
): Promise<void> {
  const [messageId, emoji] = (callbackData.payload || '').split(':');

  await ctx.answerCallbackQuery({ text: emoji });

  // Log the reaction for context
  const userId = ctx.from?.id;

  console.log(`[Telegram] Reaction ${emoji} on message ${messageId} from user ${userId}`);

  // Handle special reactions
  if (emoji === '👎') {
    // Thumbs down - offer clarification
    await ctx.reply(
      'I see you weren\'t satisfied with that response. Would you like me to:\n' +
      '* Try again with a different approach?\n' +
      '* Provide more detail?\n' +
      '* Explain my reasoning?'
    );
  }
}

/**
 * Register callback query handler on the bot
 */
export function registerCallbackHandler(bot: Bot, deps: CallbackHandlerDeps): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data) {
      await ctx.answerCallbackQuery();
      return;
    }

    const callbackData = parseCallbackData(data);
    console.log(`[Telegram] Callback: ${callbackData.action}`, callbackData.payload || '');

    try {
      switch (callbackData.action) {
        case 'confirm':
          await handleConfirmation(ctx, callbackData, deps);
          break;

        case 'location':
          await handleLocationAction(ctx, callbackData, deps);
          break;

        case 'pagination':
          await handlePagination(ctx, callbackData);
          break;

        case 'reaction':
          await handleReactionCallback(ctx, callbackData, deps);
          break;

        default:
          // Unknown action - acknowledge and log
          await ctx.answerCallbackQuery({ text: 'Action received' });
          console.log(`[Telegram] Unknown callback action: ${callbackData.action}`);
      }
    } catch (error) {
      console.error('[Telegram] Callback error:', error);
      await ctx.answerCallbackQuery({ text: 'Error processing action' });
    }
  });
}

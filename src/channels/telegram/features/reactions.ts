/**
 * Telegram message reactions feature
 * Handles message_reaction events and agent reactions
 */

import { Bot, Api } from 'grammy';
import { ReactionData, ReactionEmoji } from '../types';

/**
 * Track reaction history for context
 */
const reactionHistory: Map<string, ReactionData[]> = new Map();

/**
 * Get reaction history key
 */
function getHistoryKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Add reaction to history
 */
function recordReaction(data: ReactionData): void {
  const key = getHistoryKey(data.chatId, data.messageId);
  const history = reactionHistory.get(key) || [];
  history.push(data);
  reactionHistory.set(key, history);

  // Keep history manageable (last 100 reactions per message)
  if (history.length > 100) {
    history.shift();
  }
}

/**
 * Get reactions for a message
 */
export function getMessageReactions(chatId: number, messageId: number): ReactionData[] {
  const key = getHistoryKey(chatId, messageId);
  return reactionHistory.get(key) || [];
}

/**
 * Clear old reaction history
 */
export function cleanupReactionHistory(_maxAge: number = 24 * 60 * 60 * 1000): void {
  // Note: We don't track timestamps in ReactionData, so this is a placeholder
  // In a real implementation, you'd add timestamps to ReactionData
  console.log(`[Telegram] Reaction history cleanup (${reactionHistory.size} entries)`);
}

/**
 * Handle a message_reaction update
 */
export interface ReactionHandler {
  onReaction: (data: ReactionData) => Promise<void>;
}

/**
 * Create reaction handler callback
 */
export function createReactionHandler(
  onNegativeReaction?: (chatId: number, messageId: number) => Promise<void>
): ReactionHandler {
  return {
    onReaction: async (data: ReactionData) => {
      recordReaction(data);

      console.log(
        `[Telegram] Reaction: ${data.emoji} ${data.isAdded ? 'added' : 'removed'} ` +
        `on message ${data.messageId} in chat ${data.chatId} by user ${data.userId}`
      );

      // Handle negative reactions specially (thumbs down)
      if (data.emoji === '👎' && data.isAdded && onNegativeReaction) {
        await onNegativeReaction(data.chatId, data.messageId);
      }
    },
  };
}

/**
 * Register reaction handler on the bot
 */
export function registerReactionHandler(
  bot: Bot,
  handler: ReactionHandler
): void {
  // Handle message_reaction updates
  bot.on('message_reaction', async (ctx) => {
    const reaction = ctx.messageReaction;
    if (!reaction) return;

    const chatId = reaction.chat.id;
    const messageId = reaction.message_id;
    const userId = reaction.user?.id;

    if (!userId) return;

    // Process new reactions
    const newReactions = reaction.new_reaction || [];
    const oldReactions = reaction.old_reaction || [];

    // Find added reactions
    for (const r of newReactions) {
      if (r.type === 'emoji' && r.emoji) {
        const wasInOld = oldReactions.some(
          old => old.type === 'emoji' && old.emoji === r.emoji
        );
        if (!wasInOld) {
          await handler.onReaction({
            chatId,
            messageId,
            userId,
            emoji: r.emoji as ReactionEmoji,
            isAdded: true,
          });
        }
      }
    }

    // Find removed reactions
    for (const r of oldReactions) {
      if (r.type === 'emoji' && r.emoji) {
        const isInNew = newReactions.some(
          newR => newR.type === 'emoji' && newR.emoji === r.emoji
        );
        if (!isInNew) {
          await handler.onReaction({
            chatId,
            messageId,
            userId,
            emoji: r.emoji as ReactionEmoji,
            isAdded: false,
          });
        }
      }
    }
  });
}

/**
 * Send a reaction to a message (agent reacting)
 */
export async function sendReaction(
  api: Api,
  chatId: number,
  messageId: number,
  emoji: ReactionEmoji
): Promise<boolean> {
  try {
    // Use type assertion to handle grammy's strict emoji typing
    // The grammy API expects specific emoji literals, but our ReactionEmoji type covers them
    const reaction = { type: 'emoji' as const, emoji };
    await api.setMessageReaction(chatId, messageId, [reaction as Parameters<typeof api.setMessageReaction>[2][number]]);
    console.log(`[Telegram] Sent reaction ${emoji} to message ${messageId}`);
    return true;
  } catch (error) {
    console.error('[Telegram] Failed to send reaction:', error);
    return false;
  }
}

/**
 * Remove agent's reaction from a message
 */
export async function removeReaction(
  api: Api,
  chatId: number,
  messageId: number
): Promise<boolean> {
  try {
    await api.setMessageReaction(chatId, messageId, []);
    console.log(`[Telegram] Removed reaction from message ${messageId}`);
    return true;
  } catch (error) {
    console.error('[Telegram] Failed to remove reaction:', error);
    return false;
  }
}

/**
 * Common reaction shortcuts for the agent
 */
export const AgentReactions = {
  acknowledge: '👍' as ReactionEmoji,
  thinking: '🤔' as ReactionEmoji,
  done: '✍️' as ReactionEmoji,
  error: '😢' as ReactionEmoji,
  love: '❤️' as ReactionEmoji,
  celebrate: '🎉' as ReactionEmoji,
  understood: '👌' as ReactionEmoji,
  working: '🔥' as ReactionEmoji,
} as const;

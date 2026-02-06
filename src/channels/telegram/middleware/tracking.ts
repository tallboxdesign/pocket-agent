/**
 * Telegram chat tracking middleware
 * Manages active chat IDs for proactive messaging
 */

import { Context, NextFunction } from 'grammy';
import { SettingsManager } from '../../../settings';

/**
 * Active chat ID tracker
 */
export class ChatTracker {
  private activeChatIds: Set<number> = new Set();

  constructor() {
    this.loadPersistedChatIds();
  }

  /**
   * Load persisted chat IDs from settings
   */
  private loadPersistedChatIds(): void {
    const savedIds = SettingsManager.getArray('telegram.activeChatIds');
    for (const id of savedIds) {
      const parsed = parseInt(id, 10);
      if (!isNaN(parsed)) {
        this.activeChatIds.add(parsed);
      }
    }
    if (this.activeChatIds.size > 0) {
      console.log(`[Telegram] Loaded ${this.activeChatIds.size} persisted chat IDs`);
    }
  }

  /**
   * Persist chat IDs to settings
   */
  private persistChatIds(): void {
    const ids = Array.from(this.activeChatIds).map(String);
    SettingsManager.set('telegram.activeChatIds', JSON.stringify(ids));
  }

  /**
   * Track a chat ID
   * @returns true if this is a new chat
   */
  track(chatId: number): boolean {
    const isNew = !this.activeChatIds.has(chatId);
    if (isNew) {
      this.activeChatIds.add(chatId);
      this.persistChatIds();
      console.log(`[Telegram] New chat ID registered: ${chatId}`);
    }
    return isNew;
  }

  /**
   * Remove a chat ID from tracking
   */
  untrack(chatId: number): void {
    if (this.activeChatIds.has(chatId)) {
      this.activeChatIds.delete(chatId);
      this.persistChatIds();
      console.log(`[Telegram] Chat ID removed: ${chatId}`);
    }
  }

  /**
   * Check if a chat is being tracked
   */
  isTracked(chatId: number): boolean {
    return this.activeChatIds.has(chatId);
  }

  /**
   * Get all active chat IDs
   */
  getAll(): number[] {
    return Array.from(this.activeChatIds);
  }

  /**
   * Get count of active chats
   */
  get count(): number {
    return this.activeChatIds.size;
  }
}

/**
 * Create tracking middleware
 */
export function createTrackingMiddleware(tracker: ChatTracker) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId) {
      tracker.track(chatId);
    }
    await next();
  };
}

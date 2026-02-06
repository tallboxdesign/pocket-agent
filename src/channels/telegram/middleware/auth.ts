/**
 * Telegram authentication middleware
 * Handles user allowlist checking
 */

import { Context, NextFunction } from 'grammy';
import { SettingsManager } from '../../../settings';

/**
 * Create authentication middleware that checks user allowlist
 */
export function createAuthMiddleware() {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;

    // Security: Always enforce allowlist - check current settings on every message
    // (not cached, so changes take effect immediately without restart)
    const currentAllowedUsers = SettingsManager.getArray('telegram.allowedUserIds')
      .map(id => parseInt(id, 10))
      .filter(id => !isNaN(id));

    if (currentAllowedUsers.length === 0 || !userId || !currentAllowedUsers.includes(userId)) {
      console.log(`[Telegram] Unauthorized user attempted access: ${userId}`);
      await ctx.reply(
        '[ ] Sorry, you are not authorized to use this bot.\n\n' +
        'This is a personal AI assistant. If you are the owner, ' +
        'add your Telegram user ID to the allowlist in Settings.'
      );
      return;
    }

    await next();
  };
}

/**
 * Check if a user ID is in the allowlist
 */
export function isUserAllowed(userId: number): boolean {
  const allowedUsers = SettingsManager.getArray('telegram.allowedUserIds')
    .map(id => parseInt(id, 10))
    .filter(id => !isNaN(id));

  return allowedUsers.includes(userId);
}

/**
 * Get the current allowlist
 */
export function getAllowedUsers(): number[] {
  return SettingsManager.getArray('telegram.allowedUserIds')
    .map(id => parseInt(id, 10))
    .filter(id => !isNaN(id));
}

/**
 * Telegram typing indicator manager
 * Keeps typing indicator active during long operations
 */

import { Context } from 'grammy';

/**
 * Typing indicator manager
 * Automatically sends typing action every 4 seconds until stopped
 */
export class TypingIndicator {
  private interval: ReturnType<typeof setInterval> | null = null;
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /**
   * Start showing typing indicator
   */
  async start(): Promise<void> {
    // Send immediately
    await this.sendTyping();

    // Keep sending every 4 seconds (Telegram typing indicator expires after 5s)
    this.interval = setInterval(() => {
      this.sendTyping().catch(() => {
        // Ignore errors - chat may have been deleted
      });
    }, 4000);
  }

  /**
   * Stop the typing indicator
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Send a typing action
   */
  private async sendTyping(): Promise<void> {
    await this.ctx.replyWithChatAction('typing');
  }
}

/**
 * Create and start a typing indicator
 */
export function startTyping(ctx: Context): TypingIndicator {
  const indicator = new TypingIndicator(ctx);
  indicator.start().catch(() => {});
  return indicator;
}

/**
 * Execute a function with typing indicator
 */
export async function withTyping<T>(
  ctx: Context,
  fn: () => Promise<T>
): Promise<T> {
  const indicator = startTyping(ctx);
  try {
    return await fn();
  } finally {
    indicator.stop();
  }
}

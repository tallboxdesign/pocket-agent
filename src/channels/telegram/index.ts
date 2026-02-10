/**
 * Telegram channel - Main orchestrator
 *
 * Modular Telegram bot with:
 * - Text, photo, voice, audio message handling
 * - Document processing (PDF, code, CSV)
 * - Location sharing with reverse geocoding
 * - Inline keyboards with callbacks
 * - Reply keyboards (persistent)
 * - Message reactions
 * - TTS voice replies
 * - Reconnection with exponential backoff
 */

import fs from 'fs';
import { Bot, Context, InputFile } from 'grammy';
import type { ReactionTypeEmoji } from '@grammyjs/types';
import { Notification } from 'electron';
import { BaseChannel } from '../index';
import { SettingsManager } from '../../settings';

// Types
import { MessageCallback, SessionLinkCallback, AttachmentType } from './types';

// Formatting
import { markdownToTelegramHtml, splitMessage } from './formatting';

// Middleware
import { createAuthMiddleware, getAllowedUsers } from './middleware/auth';
import { ChatTracker, createTrackingMiddleware } from './middleware/tracking';

// Handlers
import {
  registerCommandHandlers,
  registerSessionHandlers,
  CommandHandlerDeps,
} from './handlers/commands';
import { handleTextMessage } from './handlers/messages';
import { handlePhotoMessage, handleVoiceMessage, handleAudioMessage } from './handlers/media';
import { handleDocumentMessage } from './handlers/documents';
import { handleLocationMessage, handleEditedLocation } from './handlers/location';
import { registerCallbackHandler, CallbackHandlerDeps } from './handlers/callbacks';

// Features
import {
  createReactionHandler,
  registerReactionHandler,
  sendVoiceReply,
} from './features';

// Re-export types
export type { MessageCallback, SessionLinkCallback, AttachmentType };

// Re-export utilities for external use
export { markdownToTelegramHtml, splitMessage } from './formatting';
export { InlineKeyboardBuilder, confirmationKeyboard, optionsKeyboard } from './keyboards/inline';
export { ReplyKeyboardBuilder, defaultKeyboard, contextKeyboard } from './keyboards/reply';

/**
 * TelegramBot - Main Telegram channel implementation
 */
export class TelegramBot extends BaseChannel {
  name = 'telegram';
  private bot: Bot;
  private chatTracker: ChatTracker;
  private onMessageCallback: MessageCallback | null = null;
  private onSessionLinkCallback: SessionLinkCallback | null = null;

  // Reconnection state
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessfulPoll = 0;
  private intentionalStop = false;

  constructor() {
    super();
    const botToken = SettingsManager.get('telegram.botToken');
    if (!botToken) {
      throw new Error('Telegram bot token not configured');
    }

    const allowedUsers = getAllowedUsers();

    // Security: Require at least one allowed user ID
    if (allowedUsers.length === 0) {
      throw new Error(
        'Telegram allowlist is empty. For security, you must add at least one user ID.\n\n' +
        'To get your Telegram user ID:\n' +
        '1. Open Telegram and message @userinfobot\n' +
        '2. It will reply with your user ID\n' +
        '3. Add that ID to Settings -> Telegram -> Allowed User IDs'
      );
    }

    this.bot = new Bot(botToken);
    this.chatTracker = new ChatTracker();

    this.setupMiddleware();
    this.setupHandlers();
  }

  setOnMessageCallback(callback: MessageCallback): void {
    this.onMessageCallback = callback;
  }

  setOnSessionLinkCallback(callback: SessionLinkCallback): void {
    this.onSessionLinkCallback = callback;
  }

  private setupMiddleware(): void {
    this.bot.use(createTrackingMiddleware(this.chatTracker));
    this.bot.use(createAuthMiddleware());
  }

  private setupHandlers(): void {
    const commandDeps: CommandHandlerDeps = {
      bot: this.bot,
      onSessionLinkCallback: this.onSessionLinkCallback,
      sendResponse: this.sendResponse.bind(this),
    };

    const callbackDeps: CallbackHandlerDeps = {
      onMessageCallback: this.onMessageCallback,
      sendResponse: this.sendResponse.bind(this),
    };

    registerCommandHandlers(commandDeps);
    registerSessionHandlers(commandDeps);
    registerCallbackHandler(this.bot, callbackDeps);

    // Register reaction handler
    const reactionHandler = createReactionHandler(async (chatId, messageId) => {
      await this.bot.api.sendMessage(
        chatId,
        'I see you weren\'t satisfied with that response. Would you like me to:\n' +
        '* Try again with a different approach?\n' +
        '* Provide more detail?\n' +
        '* Explain my reasoning?',
        { reply_to_message_id: messageId }
      );
    });
    registerReactionHandler(this.bot, reactionHandler);

    // Document messages - register BEFORE text to ensure proper handling
    this.bot.on('message:document', async (ctx: Context) => {
      this.lastSuccessfulPoll = Date.now();  // Update on any message
      await handleDocumentMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Location messages
    this.bot.on('message:location', async (ctx: Context) => {
      this.lastSuccessfulPoll = Date.now();
      await handleLocationMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    this.bot.on('edited_message:location', async (ctx: Context) => {
      this.lastSuccessfulPoll = Date.now();
      await handleEditedLocation(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Photo messages
    this.bot.on('message:photo', async (ctx: Context) => {
      this.lastSuccessfulPoll = Date.now();
      await handlePhotoMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Voice messages
    this.bot.on('message:voice', async (ctx: Context) => {
      this.lastSuccessfulPoll = Date.now();
      await handleVoiceMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Audio files
    this.bot.on('message:audio', async (ctx: Context) => {
      this.lastSuccessfulPoll = Date.now();
      await handleAudioMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    // Text messages - register LAST as fallback
    this.bot.on('message:text', async (ctx: Context) => {
      this.lastSuccessfulPoll = Date.now();
      await handleTextMessage(ctx, {
        onMessageCallback: this.onMessageCallback,
        sendResponse: this.sendResponse.bind(this),
      });
    });

    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
    });
  }

  /**
   * Send a response, splitting into multiple messages if needed
   * Converts markdown to Telegram HTML format, then sends TTS voice if enabled
   */
  private async sendResponse(ctx: Context, text: string): Promise<void> {
    const MAX_LENGTH = 4000;

    if (text.length <= MAX_LENGTH) {
      const html = markdownToTelegramHtml(text);
      try {
        await ctx.reply(html, { parse_mode: 'HTML' });
      } catch (error) {
        console.error('[Telegram] HTML parse failed, falling back to plain text:', error);
        await ctx.reply(text);
      }
    } else {
      const chunks = splitMessage(text, MAX_LENGTH);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
        const html = markdownToTelegramHtml(prefix + chunks[i]);
        try {
          await ctx.reply(html, { parse_mode: 'HTML' });
        } catch {
          await ctx.reply(prefix + chunks[i]);
        }
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }

    // Send TTS voice message if enabled
    await sendVoiceReply(ctx, text);
  }

  async sendMessage(chatId: number, text: string): Promise<boolean> {
    if (!this.isRunning) {
      console.error('[Telegram] Bot not running, cannot send message');
      return false;
    }

    try {
      const MAX_LENGTH = 4000;

      if (text.length <= MAX_LENGTH) {
        const html = markdownToTelegramHtml(text);
        try {
          await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        } catch {
          await this.bot.api.sendMessage(chatId, text);
        }
      } else {
        const chunks = splitMessage(text, MAX_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
          const html = markdownToTelegramHtml(prefix + chunks[i]);
          try {
            await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
          } catch {
            await this.bot.api.sendMessage(chatId, prefix + chunks[i]);
          }
          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }

      console.log(`[Telegram] Sent proactive message to chat ${chatId}`);
      return true;
    } catch (error) {
      console.error(`[Telegram] Failed to send message to chat ${chatId}:`, error);
      return false;
    }
  }

  /**
   * Send a photo to a specific chat
   */
  async sendPhoto(chatId: number, photoPath: string, caption?: string): Promise<boolean> {
    if (!this.isRunning) {
      console.error('[Telegram] Bot not running, cannot send photo');
      return false;
    }

    try {
      if (!fs.existsSync(photoPath)) {
        console.error(`[Telegram] Photo not found: ${photoPath}`);
        return false;
      }
      const photo = new InputFile(fs.readFileSync(photoPath));
      await this.bot.api.sendPhoto(chatId, photo, caption ? { caption } : undefined);
      console.log(`[Telegram] Sent photo to chat ${chatId}: ${photoPath}`);
      return true;
    } catch (error) {
      console.error(`[Telegram] Failed to send photo to chat ${chatId}:`, error);
      return false;
    }
  }

  /**
   * React to a message with a raw emoji string
   * Telegram validates supported emojis server-side
   */
  async reactToMessage(chatId: number, messageId: number, emoji: string): Promise<boolean> {
    if (!this.isRunning) {
      console.error('[Telegram] Bot not running, cannot react');
      return false;
    }

    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ]);
      console.log(`[Telegram] Reacted with ${emoji} on message ${messageId} in chat ${chatId}`);
      return true;
    } catch (error) {
      console.error(`[Telegram] Failed to react on message ${messageId}:`, error);
      return false;
    }
  }

  async broadcast(text: string): Promise<number> {
    let sent = 0;
    for (const chatId of this.chatTracker.getAll()) {
      const success = await this.sendMessage(chatId, text);
      if (success) sent++;
    }
    return sent;
  }

  /**
   * Send photos to a Telegram chat from local file paths
   */
  async sendPhotos(chatId: number, media: Array<{ type: string; filePath: string; mimeType: string }>): Promise<void> {
    for (const item of media) {
      if (item.type === 'image' && fs.existsSync(item.filePath)) {
        try {
          await this.bot.api.sendPhoto(chatId, new InputFile(item.filePath));
        } catch (err) {
          console.error(`[Telegram] Failed to send photo ${item.filePath}:`, err);
        }
      }
    }
  }

  /**
   * Send a response with optional media attachments
   */
  async sendResponseWithMedia(ctx: Context, text: string, media?: Array<{ type: string; filePath: string; mimeType: string }>): Promise<void> {
    await this.sendResponse(ctx, text);

    if (media && media.length > 0 && ctx.chat?.id) {
      await this.sendPhotos(ctx.chat.id, media);
    }
  }

  /**
   * Sync a desktop conversation to a specific Telegram chat
   */
  async syncToChat(userMessage: string, response: string, chatId: number, media?: Array<{ type: string; filePath: string; mimeType: string }>): Promise<boolean> {
    const text = `[Desktop]\n\nYou: ${userMessage}\n\nAssistant: ${response}`;
    const success = await this.sendMessage(chatId, text);

    // Send media photos if present
    if (success && media && media.length > 0) {
      await this.sendPhotos(chatId, media);
    }

    return success;
  }

  /** @deprecated Use syncToChat with explicit chatId instead */
  async syncFromDesktop(userMessage: string, response: string): Promise<number> {
    const text = `[Desktop]\n\nYou: ${userMessage}\n\nAssistant: ${response}`;
    return this.broadcast(text);
  }

  getActiveChatIds(): number[] {
    return this.chatTracker.getAll();
  }

  addAllowedUser(userId: number): void {
    const current = SettingsManager.getArray('telegram.allowedUserIds');
    if (!current.includes(String(userId))) {
      current.push(String(userId));
      SettingsManager.set('telegram.allowedUserIds', JSON.stringify(current));
    }
  }

  removeAllowedUser(userId: number): void {
    const current = SettingsManager.getArray('telegram.allowedUserIds');
    const filtered = current.filter(id => id !== String(userId));
    SettingsManager.set('telegram.allowedUserIds', JSON.stringify(filtered));
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.intentionalStop = false;

    const botToken = SettingsManager.get('telegram.botToken');
    if (!botToken) {
      console.error('[Telegram] No bot token configured');
      return;
    }

    try {
      this.bot.start({
        onStart: (botInfo) => {
          this.isRunning = true;
          this.reconnectAttempts = 0;
          this.lastSuccessfulPoll = Date.now();
          try {
            console.log(`[Telegram] Bot @${botInfo.username} started`);
            console.log(`[Telegram] Authorized users: ${getAllowedUsers().join(', ')}`);
          } catch {
            // Ignore EPIPE errors
          }
        },
      }).then(() => {
        this.isRunning = false;
        if (!this.intentionalStop) {
          console.log('[Telegram] Bot polling ended unexpectedly');
          this.scheduleReconnect('Polling loop ended');
        }
      }).catch((error) => {
        this.isRunning = false;
        if (!this.intentionalStop) {
          console.error('[Telegram] Bot polling crashed:', error);
          this.scheduleReconnect(`Polling error: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      this.startHealthCheck();
    } catch (error) {
      console.error('[Telegram] Failed to start bot:', error);
      this.isRunning = false;
      if (!this.intentionalStop) {
        this.scheduleReconnect(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    this.stopHealthCheck();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.isRunning) return;
    await this.bot.stop();
    this.isRunning = false;
    console.log('[Telegram] Bot stopped');
  }

  private scheduleReconnect(reason: string): void {
    if (this.intentionalStop) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[Telegram] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'Telegram Disconnected',
            body: 'Could not reconnect after multiple attempts. Use Reboot from tray menu.',
          }).show();
        }
      } catch { /* Notification may not be available */ }
      return;
    }

    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    console.log(`[Telegram] Reconnect #${this.reconnectAttempts} in ${delay}ms (reason: ${reason})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log(`[Telegram] Reconnect attempt #${this.reconnectAttempts}...`);

      try {
        const botToken = SettingsManager.get('telegram.botToken');
        if (!botToken) {
          console.error('[Telegram] No bot token, cannot reconnect');
          return;
        }
        this.bot = new Bot(botToken);
        this.setupHandlers();
        await this.start();
      } catch (error) {
        console.error('[Telegram] Reconnect failed:', error);
        this.scheduleReconnect(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, delay);
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      if (!this.isRunning || this.intentionalStop) return;
      const elapsed = Date.now() - this.lastSuccessfulPoll;
      if (elapsed > 120_000) {
        console.warn(`[Telegram] No activity for ${Math.round(elapsed / 1000)}s — connection stale, reconnecting...`);
        // Actually reconnect instead of just logging!
        try {
          await this.bot.stop();
        } catch (e) {
          console.warn('[Telegram] Error stopping bot during health check reconnect:', e);
        }
        this.scheduleReconnect('health check detected stale connection');
      }
    }, 60_000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

// Singleton instance
let telegramBotInstance: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot | null {
  return telegramBotInstance;
}

export function createTelegramBot(): TelegramBot | null {
  if (!telegramBotInstance) {
    try {
      telegramBotInstance = new TelegramBot();
    } catch (error) {
      console.error('[Telegram] Failed to create bot:', error);
      return null;
    }
  }
  return telegramBotInstance;
}

export async function restartTelegramBot(): Promise<{ success: boolean; error?: string }> {
  try {
    if (telegramBotInstance) {
      await telegramBotInstance.stop();
      telegramBotInstance = null;
    }
    telegramBotInstance = new TelegramBot();
    await telegramBotInstance.start();
    console.log('[Telegram] Bot restarted successfully');
    return { success: true };
  } catch (error) {
    console.error('[Telegram] Restart failed:', error);
    telegramBotInstance = null;
    return { success: false, error: error instanceof Error ? error.message : 'Restart failed' };
  }
}

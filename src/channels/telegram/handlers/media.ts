/**
 * Telegram media handlers (photo, voice, audio)
 * Photos are saved locally for agent access via Read tool
 * Voice/audio are transcribed via Whisper API
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { SettingsManager } from '../../../settings';
import { transcribeAudio, isTranscriptionAvailable } from '../../../utils/transcribe';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';
import { setTelegramMessageContext } from '../../../tools/session-context';
import { setActiveChannel } from '../../../tools/voice-tools';
import { getTelegramSavedReaction, isTelegramAckReactionEnabled, shouldUseSavedReaction } from '../utils/reaction-policy';

export interface MediaHandlerDeps {
  onMessageCallback: MessageCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Get the files directory path (creates if doesn't exist)
 */
function getFilesDirectory(): string {
  const filesDir = path.join(os.homedir(), 'Documents', 'Pocket-agent', 'files');

  if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir, { recursive: true });
    console.log(`[Telegram] Created files directory: ${filesDir}`);
  }

  return filesDir;
}

/**
 * Schedule deletion of a temporary file after a delay (default 5 minutes).
 * Gives the agent enough time to read the file, then cleans up.
 */
export function scheduleFileCleanup(filePath: string, delayMs: number = 5 * 60 * 1000): void {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Telegram] Cleaned up temp file: ${filePath}`);
      }
    } catch {
      // Ignore cleanup errors -file may already be gone
    }
  }, delayMs);
}

/**
 * Get image extension from file path or default to jpg
 */
function getImageExtension(filePath: string): string {
  if (filePath.endsWith('.png')) return '.png';
  if (filePath.endsWith('.gif')) return '.gif';
  if (filePath.endsWith('.webp')) return '.webp';
  return '.jpg';
}

/**
 * Handle incoming photo messages
 * Downloads image to local workspace for agent access via Read tool
 */
export async function handlePhotoMessage(
  ctx: Context,
  deps: MediaHandlerDeps
): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const photo = ctx.message?.photo;
  const caption = ctx.message?.caption || '';

  if (!chatId || !photo || photo.length === 0) return;

  const { onMessageCallback, sendResponse } = deps;
  let savedFilePath: string | null = null;

  if (messageId) setTelegramMessageContext({ chatId, messageId });
  setActiveChannel('telegram');
  try {
    const result = await withTyping(ctx, async () => {
      // Get the largest photo (last in array)
      const largestPhoto = photo[photo.length - 1];

      // Get file info from Telegram
      const file = await ctx.api.getFile(largestPhoto.file_id);
      if (!file.file_path) {
        throw new Error('Could not get file path from Telegram');
      }

      // Download the photo
      const botToken = SettingsManager.get('telegram.botToken');
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download photo: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to local files directory
      const filesDir = getFilesDirectory();
      const ext = getImageExtension(file.file_path);
      const timestamp = Date.now();
      const filename = `telegram_${timestamp}_photo${ext}`;
      const localPath = path.join(filesDir, filename);
      savedFilePath = localPath;

      fs.writeFileSync(localPath, buffer);

      const fileSizeKB = (buffer.length / 1024).toFixed(1);
      console.log(`[Telegram] Saved photo: ${localPath} (${largestPhoto.width}x${largestPhoto.height}, ${fileSizeKB}KB)`);

      // Build prompt for agent - tell it the file path so it can use Read tool
      const prompt = caption
        ? `${caption}\n\n[User sent an image via Telegram]\nImage saved to: ${localPath}\n\nPlease view and analyze this image.`
        : `[User sent an image via Telegram]\nImage saved to: ${localPath}\n\nPlease view and describe what you see in this image.`;

      // Look up which session this chat is linked to
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      return AgentManager.processMessage(prompt, 'telegram', sessionId, undefined, {
        hasAttachment: true,
        attachmentType: 'photo',
      });
    });

    // Send response
    await sendResponse(ctx, result.response);

    if (chatId && messageId && isTelegramAckReactionEnabled() && shouldUseSavedReaction(caption, result.response)) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.reactToMessage(chatId, messageId, getTelegramSavedReaction());
      }
    }

    // Send media photos if present
    if (result.media && result.media.length > 0 && ctx.chat?.id) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.sendPhotos(ctx.chat.id, result.media);
      }
    }

    // Notify callback for cross-channel sync
    if (onMessageCallback) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';
      const displayMessage = ctx.message?.caption || 'Sent a photo';

      onMessageCallback({
        userMessage: displayMessage,
        response: result.response,
        channel: 'telegram',
        chatId,
        sessionId,
        hasAttachment: true,
        attachmentType: 'photo',
        wasCompacted: result.wasCompacted,
        media: result.media,
      });
    }

    // If compaction happened, notify
    if (result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }

    // Schedule cleanup of the downloaded file
    if (savedFilePath) scheduleFileCleanup(savedFilePath);
  } catch (error) {
    if (savedFilePath) scheduleFileCleanup(savedFilePath);
    console.error('[Telegram] Photo error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error processing photo: ${errorMsg}`);
  } finally {
    setTelegramMessageContext(null);
    setActiveChannel('desktop');
  }
}

/**
 * Handle incoming voice messages
 */
export async function handleVoiceMessage(
  ctx: Context,
  deps: MediaHandlerDeps
): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const voice = ctx.message?.voice;
  const caption = ctx.message?.caption || '';

  if (!chatId || !voice) return;

  // Check if transcription is available before processing
  if (!isTranscriptionAvailable()) {
    await ctx.reply(
      'Voice notes require an OpenAI API key for transcription.\n\n' +
      'Add your OpenAI key in Settings -> API Keys to enable voice messages.'
    );
    return;
  }

  const { onMessageCallback, sendResponse } = deps;

  if (messageId) setTelegramMessageContext({ chatId, messageId });
  setActiveChannel('telegram');
  try {
    const result = await withTyping(ctx, async () => {
      // Get file info from Telegram
      const file = await ctx.api.getFile(voice.file_id);
      if (!file.file_path) {
        throw new Error('Could not get file path from Telegram');
      }

      // Download the voice file (Telegram voice notes are OGG/Opus)
      const botToken = SettingsManager.get('telegram.botToken');
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      // Determine format from file path (usually .oga or .ogg)
      const format = file.file_path.split('.').pop() || 'ogg';

      console.log(
        `[Telegram] Processing voice: ${voice.duration}s, ${(audioBuffer.length / 1024).toFixed(1)}KB`
      );

      // Transcribe the audio
      const transcription = await transcribeAudio(audioBuffer, format);

      if (!transcription.success || !transcription.text) {
        throw new Error(transcription.error || 'Transcription failed');
      }

      console.log(
        `[Telegram] Transcribed in ${transcription.duration?.toFixed(1)}s: "${transcription.text.substring(0, 50)}..."`
      );

      // Build the prompt with transcript
      const prompt = caption ? `${caption}\n\n${transcription.text}` : transcription.text;

      // Look up which session this chat is linked to
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      return {
        result: await AgentManager.processMessage(prompt, 'telegram', sessionId, undefined, {
          hasAttachment: true,
          attachmentType: 'voice',
        }),
        transcription,
      };
    });

    // Send response
    await sendResponse(ctx, result.result.response);

    if (chatId && messageId && isTelegramAckReactionEnabled() && shouldUseSavedReaction(caption, result.result.response)) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.reactToMessage(chatId, messageId, getTelegramSavedReaction());
      }
    }

    // Send media photos if present
    if (result.result.media && result.result.media.length > 0 && ctx.chat?.id) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.sendPhotos(ctx.chat.id, result.result.media);
      }
    }

    // Notify callback for cross-channel sync
    if (onMessageCallback) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';
      const transcriptPreview =
        result.transcription.text && result.transcription.text.length > 50
          ? result.transcription.text.substring(0, 50) + '...'
          : result.transcription.text || '';
      const displayMessage = caption
        ? `${caption}\n\n${transcriptPreview}`
        : transcriptPreview;

      onMessageCallback({
        userMessage: displayMessage,
        response: result.result.response,
        channel: 'telegram',
        chatId,
        sessionId,
        hasAttachment: true,
        attachmentType: 'voice',
        wasCompacted: result.result.wasCompacted,
        media: result.result.media,
      });
    }

    // If compaction happened, notify
    if (result.result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Voice error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error processing voice message: ${errorMsg}`);
  } finally {
    setTelegramMessageContext(null);
    setActiveChannel('desktop');
  }
}

/**
 * Handle incoming audio files (longer recordings, music)
 */
export async function handleAudioMessage(
  ctx: Context,
  deps: MediaHandlerDeps
): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const audio = ctx.message?.audio;
  const caption = ctx.message?.caption || '';

  if (!chatId || !audio) return;

  // Check if transcription is available
  if (!isTranscriptionAvailable()) {
    await ctx.reply(
      'Audio transcription requires an OpenAI API key.\n\n' +
      'Add your OpenAI key in Settings -> API Keys to enable audio transcription.'
    );
    return;
  }

  // Check file size (Whisper has a 25MB limit)
  if (audio.file_size && audio.file_size > 25 * 1024 * 1024) {
    await ctx.reply('Audio file too large. Maximum size is 25MB for transcription.');
    return;
  }

  const { onMessageCallback, sendResponse } = deps;

  if (messageId) setTelegramMessageContext({ chatId, messageId });
  setActiveChannel('telegram');
  try {
    const result = await withTyping(ctx, async () => {
      // Get file info from Telegram
      const file = await ctx.api.getFile(audio.file_id);
      if (!file.file_path) {
        throw new Error('Could not get file path from Telegram');
      }

      // Download the audio file
      const botToken = SettingsManager.get('telegram.botToken');
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download audio: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      // Get format from file path or mime type
      const format = file.file_path.split('.').pop() || audio.mime_type?.split('/')[1] || 'mp3';

      console.log(
        `[Telegram] Processing audio: ${audio.duration}s, ${(audioBuffer.length / 1024).toFixed(1)}KB, ${audio.title || 'untitled'}`
      );

      // Transcribe the audio
      const transcription = await transcribeAudio(audioBuffer, format);

      if (!transcription.success || !transcription.text) {
        throw new Error(transcription.error || 'Transcription failed');
      }

      console.log(
        `[Telegram] Transcribed in ${transcription.duration?.toFixed(1)}s: "${transcription.text.substring(0, 50)}..."`
      );

      // Build the prompt with transcript and audio metadata
      const audioInfo = audio.title ? `"${audio.title}"` : 'Audio file';
      const durationStr = audio.duration ? ` (${audio.duration}s)` : '';
      const prompt = caption
        ? `${caption}\n\n${audioInfo}${durationStr} transcript:\n"${transcription.text}"`
        : `${audioInfo}${durationStr} transcript:\n"${transcription.text}"`;

      // Look up which session this chat is linked to
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      return {
        result: await AgentManager.processMessage(prompt, 'telegram', sessionId, undefined, {
          hasAttachment: true,
          attachmentType: 'audio',
        }),
        transcription,
      };
    });

    // Send response
    await sendResponse(ctx, result.result.response);

    if (chatId && messageId && isTelegramAckReactionEnabled() && shouldUseSavedReaction(caption, result.result.response)) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.reactToMessage(chatId, messageId, getTelegramSavedReaction());
      }
    }

    // Send media photos if present
    if (result.result.media && result.result.media.length > 0 && ctx.chat?.id) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.sendPhotos(ctx.chat.id, result.result.media);
      }
    }

    // Notify callback for cross-channel sync
    if (onMessageCallback) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';
      const transcriptPreview =
        result.transcription.text && result.transcription.text.length > 50
          ? result.transcription.text.substring(0, 50) + '...'
          : result.transcription.text || '';
      const displayMessage = caption
        ? `${caption} [${audio.title || 'Audio'}: "${transcriptPreview}"]`
        : `${audio.title || 'Audio'}: "${transcriptPreview}"`;

      onMessageCallback({
        userMessage: displayMessage,
        response: result.result.response,
        channel: 'telegram',
        chatId,
        sessionId,
        hasAttachment: true,
        attachmentType: 'audio',
        wasCompacted: result.result.wasCompacted,
        media: result.result.media,
      });
    }

    // If compaction happened, notify
    if (result.result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Audio error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error processing audio: ${errorMsg}`);
  } finally {
    setTelegramMessageContext(null);
    setActiveChannel('desktop');
  }
}

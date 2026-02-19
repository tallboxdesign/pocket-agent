/**
 * Telegram WAQ adapter
 * Enqueue helpers and dispatcher for sending Telegram messages via WriteAheadQueue
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bot, InputFile } from 'grammy';
import { WriteAheadQueue } from '../../queue/write-ahead-queue';
import type {
  QueueOperation,
  QueuePayload,
  TextPayload,
  VoicePayload,
  PhotoPayload,
} from '../../queue/types';
import { markdownToTelegramHtml, splitMessage } from './formatting';
import { synthesizeSpeech, stripMarkdown, splitForVoice } from '../../voice/tts';

/** Try to get Electron's userData path for TTS cache, fall back to os.tmpdir() */
async function getTTSCacheDir(): Promise<string> {
  try {
    const electron = await import('electron');
    return path.join(electron.app.getPath('userData'), 'tts-cache');
  } catch {
    return path.join(os.tmpdir(), 'pocket-agent-tts-cache');
  }
}

/**
 * Enqueue text message chunks into WAQ
 */
export function enqueueText(
  waq: WriteAheadQueue,
  chatId: number,
  text: string,
): number[] {
  const chunks = splitMessage(text, 4000);
  const groupId = randomUUID();
  const ids: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const payload: TextPayload = {
      text: chunks[i],
      chunkIndex: i,
      totalChunks: chunks.length,
      groupId,
    };
    ids.push(waq.enqueue(chatId, 'text', payload));
  }

  return ids;
}

/**
 * Enqueue voice message chunks into WAQ
 */
export function enqueueVoice(
  waq: WriteAheadQueue,
  chatId: number,
  text: string,
  startIndex: number,
  totalChunks: number,
  groupId: string,
): number[] {
  const cleaned = stripMarkdown(text);
  const voiceChunks = splitForVoice(cleaned);
  const ids: number[] = [];

  for (let i = 0; i < voiceChunks.length; i++) {
    const payload: VoicePayload = {
      text: text,
      audioText: voiceChunks[i],
      chunkIndex: startIndex + i,
      totalChunks: totalChunks,
      groupId,
    };
    ids.push(waq.enqueue(chatId, 'voice', payload));
  }

  return ids;
}

/**
 * Enqueue text chunks followed by voice chunks (if enabled)
 */
export function enqueueTextWithVoice(
  waq: WriteAheadQueue,
  chatId: number,
  text: string,
  voiceEnabled: boolean,
): number[] {
  const textChunks = splitMessage(text, 4000);
  const groupId = randomUUID();

  let voiceChunkCount = 0;
  if (voiceEnabled) {
    const cleaned = stripMarkdown(text);
    voiceChunkCount = splitForVoice(cleaned).length;
  }

  const totalChunks = textChunks.length + voiceChunkCount;
  const ids: number[] = [];

  // Enqueue text chunks
  for (let i = 0; i < textChunks.length; i++) {
    const payload: TextPayload = {
      text: textChunks[i],
      chunkIndex: i,
      totalChunks,
      groupId,
    };
    ids.push(waq.enqueue(chatId, 'text', payload));
  }

  // Enqueue voice chunks
  if (voiceEnabled) {
    const voiceIds = enqueueVoice(waq, chatId, text, textChunks.length, totalChunks, groupId);
    ids.push(...voiceIds);
  }

  return ids;
}

/**
 * Enqueue a single photo message
 */
export function enqueuePhoto(
  waq: WriteAheadQueue,
  chatId: number,
  filePath: string,
  caption?: string,
): number {
  const payload: PhotoPayload = { filePath, caption };
  return waq.enqueue(chatId, 'photo', payload);
}

/**
 * Create a dispatcher function for the QueueProcessor
 * Maps queue operations to Telegram bot API calls
 */
export function createTelegramDispatcher(
  bot: Bot,
): (chatId: number, operation: QueueOperation, payload: QueuePayload) => Promise<void> {
  return async (
    chatId: number,
    operation: QueueOperation,
    payload: QueuePayload,
  ) => {
    switch (operation) {
      case 'text': {
        const p = payload as TextPayload;
        const prefix = p.totalChunks > 1 ? `(${p.chunkIndex + 1}/${p.totalChunks}) ` : '';
        const html = markdownToTelegramHtml(prefix + p.text);
        try {
          await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        } catch {
          await bot.api.sendMessage(chatId, prefix + p.text);
        }
        break;
      }
      case 'voice': {
        const p = payload as VoicePayload;
        const cacheDir = await getTTSCacheDir();
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const audioPath = await synthesizeSpeech(p.audioText, cacheDir);
        const audioBuffer = fs.readFileSync(audioPath);
        await bot.api.sendVoice(chatId, new InputFile(audioBuffer, 'voice.mp3'));
        break;
      }
      case 'photo': {
        const p = payload as PhotoPayload;
        const photo = new InputFile(fs.readFileSync(p.filePath));
        await bot.api.sendPhoto(chatId, photo, p.caption ? { caption: p.caption } : undefined);
        break;
      }
    }
  };
}

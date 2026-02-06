/**
 * Telegram voice reply feature
 * Generates and sends TTS voice messages via Telegram
 */

import * as path from 'path';
import * as fs from 'fs';
import { Context, InputFile } from 'grammy';
import { app } from 'electron';
import { SettingsManager } from '../../../settings';
import { synthesizeSpeech, stripMarkdown, summarizeForVoice } from '../../../voice/tts';

/**
 * Send a TTS voice reply after a text response
 * Only sends if telegram.voiceReplies is enabled in settings
 */
export async function sendVoiceReply(ctx: Context, text: string): Promise<void> {
  if (!SettingsManager.getBoolean('telegram.voiceReplies')) return;

  // Skip TTS for very short or empty cleaned text
  const cleaned = stripMarkdown(text);
  if (!cleaned.trim() || cleaned.trim().length < 3) return;

  try {
    const cacheDir = path.join(app.getPath('userData'), 'tts-cache');
    const voiceText = summarizeForVoice(text);
    const audioPath = await synthesizeSpeech(voiceText, cacheDir);
    const audioBuffer = fs.readFileSync(audioPath);

    await ctx.replyWithVoice(new InputFile(audioBuffer, 'voice.mp3'));
  } catch (error) {
    console.error('[Telegram] TTS voice reply failed:', error);
    // Text was already sent, so just log the TTS failure
  }
}

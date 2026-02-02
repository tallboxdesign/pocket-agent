/**
 * Text-to-Speech service using Microsoft Edge TTS (Brian voice)
 */

import { EdgeTTS } from 'node-edge-tts';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TTS_VOICE = 'en-US-BrianMultilingualNeural';
const TTS_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

/**
 * Synthesize text to MP3 audio file using Edge TTS.
 * Returns the file path of the generated audio.
 * Caches results by text content hash.
 */
export async function synthesizeSpeech(text: string, outputDir: string): Promise<string> {
  const cleanText = stripMarkdown(text);
  if (!cleanText.trim()) {
    throw new Error('No text to synthesize');
  }

  // Deterministic filename for caching
  const hash = crypto.createHash('md5').update(cleanText).digest('hex').slice(0, 12);
  const outputPath = path.join(outputDir, `tts-${hash}.mp3`);

  // Return cached file if it exists
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const tts = new EdgeTTS({
    voice: TTS_VOICE,
    outputFormat: TTS_FORMAT,
  });

  await tts.ttsPromise(cleanText, outputPath);
  return outputPath;
}

/**
 * Strip markdown formatting from text before feeding to TTS.
 */
/**
 * Summarize text for voice output (Telegram short summaries).
 * Extracts first paragraph or 2-3 sentences, capped at maxLength.
 */
export function summarizeForVoice(text: string, maxLength: number = 300): string {
  const cleaned = stripMarkdown(text);
  if (cleaned.length <= maxLength) return cleaned;

  const firstPara = cleaned.split(/\n\n/)[0].trim();
  if (firstPara.length >= 40 && firstPara.length <= maxLength) return firstPara;

  const sentences = cleaned.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 0) {
    let summary = '';
    for (let i = 0; i < Math.min(3, sentences.length); i++) {
      if ((summary + sentences[i]).length > maxLength) break;
      summary += sentences[i];
    }
    if (summary.length >= 30) return summary.trim();
  }

  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLength / 2 ? truncated.slice(0, lastSpace) : truncated).trim() + '...';
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/`[^`]*`/g, '') // inline code
    .replace(/#{1,6}\s+/g, '') // headers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/__([^_]+)__/g, '$1') // bold alt
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/_([^_]+)_/g, '$1') // italic alt
    .replace(/~~([^~]+)~~/g, '$1') // strikethrough
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '') // images
    .replace(/^[-*+]\s+/gm, '') // list markers
    .replace(/^\d+\.\s+/gm, '') // numbered lists
    .replace(/^>\s+/gm, '') // blockquotes
    .replace(/\|[^|]*\|/g, '') // table rows
    .replace(/^---+$/gm, '') // horizontal rules
    .replace(/\n{3,}/g, '\n\n') // collapse newlines
    .trim();
}

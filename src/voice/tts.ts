/**
 * Text-to-Speech service with dual backends:
 * 1. Microsoft Edge TTS (Brian voice) — cloud, higher quality
 * 2. macOS `say` command — local, always works
 *
 * Tries Edge TTS first; falls back to macOS say if it fails.
 */

import { EdgeTTS } from 'edge-tts-universal';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TTS_VOICE = 'en-US-BrianMultilingualNeural';
const EDGE_TTS_TIMEOUT = 10000; // 10 seconds timeout for Edge TTS

// macOS fallback voice — Daniel (Enhanced) is high quality British English
const MACOS_VOICE = 'Daniel (Enhanced)';

/**
 * Promise with timeout wrapper
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}

/**
 * Synthesize text to MP3 audio file.
 * Tries Edge TTS first, falls back to macOS `say` + ffmpeg.
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

  // Try Edge TTS first (higher quality Brian voice)
  try {
    await synthesizeWithEdgeTTS(cleanText, outputPath);
    return outputPath;
  } catch (edgeError) {
    console.warn('[TTS] Edge TTS failed, falling back to macOS say:', (edgeError as Error).message);
  }

  // Fallback: macOS say + ffmpeg
  await synthesizeWithMacosSay(cleanText, outputPath);
  return outputPath;
}

/**
 * Edge TTS synthesis (cloud) with timeout
 */
async function synthesizeWithEdgeTTS(text: string, outputPath: string): Promise<void> {
  const tts = new EdgeTTS(text, TTS_VOICE);

  // Add timeout to prevent hanging
  const result = await withTimeout(
    tts.synthesize(),
    EDGE_TTS_TIMEOUT,
    `Edge TTS timed out after ${EDGE_TTS_TIMEOUT}ms`
  );

  // Convert Blob to Buffer for Node.js
  const arrayBuffer = await result.audio.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Write audio buffer to file
  fs.writeFileSync(outputPath, buffer);

  // Verify file was actually created with content
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 100) {
    throw new Error('Edge TTS produced empty output');
  }
}

/**
 * macOS say command synthesis (local, always works)
 * Generates AIFF then converts to MP3 via ffmpeg
 */
async function synthesizeWithMacosSay(text: string, outputPath: string): Promise<void> {
  const aiffPath = outputPath.replace(/\.mp3$/, '.aiff');

  // Generate speech with macOS say
  await new Promise<void>((resolve, reject) => {
    execFile('say', ['-v', MACOS_VOICE, '-o', aiffPath, text], (error) => {
      if (error) reject(new Error(`macOS say failed: ${error.message}`));
      else resolve();
    });
  });

  // Convert AIFF to MP3 with ffmpeg
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', aiffPath, '-codec:a', 'libmp3lame', '-b:a', '128k', outputPath], (error) => {
      // Clean up AIFF regardless
      try { fs.unlinkSync(aiffPath); } catch { /* ignore */ }

      if (error) reject(new Error(`ffmpeg conversion failed: ${error.message}`));
      else resolve();
    });
  });

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 100) {
    throw new Error('macOS TTS produced empty output');
  }
}

/**
 * Summarize text for voice output (Telegram short summaries).
 * Extracts first paragraph or 2-3 sentences, capped at maxLength.
 * Skips meta-commentary lines about voice/audio that the agent may prepend.
 */
export function summarizeForVoice(text: string, maxLength: number = 300): string {
  const cleaned = stripMarkdownAndMeta(stripMarkdown(text));
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

/**
 * Strip meta-commentary about voice/audio the agent often prepends.
 * e.g. "Voice sent with the cleaner summary - should be playing now with Daniel's voice."
 */
function stripMarkdownAndMeta(text: string): string {
  const lines = text.split('\n');
  const filtered: string[] = [];
  let pastMeta = false;
  for (const line of lines) {
    if (!pastMeta && /^(voice sent|here.?s the voice|should be playing|text version for reference)/i.test(line.trim())) {
      continue;
    }
    pastMeta = true;
    filtered.push(line);
  }
  return filtered.join('\n').trim();
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

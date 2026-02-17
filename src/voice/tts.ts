/**
 * Text-to-Speech service with dual backends:
 * 1. Microsoft Edge TTS (Brian voice) — cloud, higher quality, via Python CLI
 * 2. macOS `say` command — local, always works
 *
 * Tries Edge TTS first; falls back to macOS say if it fails.
 */

import { execFile, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TTS_VOICE = 'en-US-BrianMultilingualNeural';
const EDGE_TTS_TIMEOUT = 30000; // 30 seconds — longer texts need more time
const EDGE_TTS_RETRIES = 2; // Retry once before falling back

// macOS fallback voice — Daniel (Enhanced) is high quality British English
const MACOS_VOICE = 'Daniel (Enhanced)';

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

  // Try Edge TTS with retries (Brian voice)
  let lastEdgeError: Error | undefined;
  for (let attempt = 1; attempt <= EDGE_TTS_RETRIES; attempt++) {
    try {
      await synthesizeWithEdgeTTS(cleanText, outputPath);
      return outputPath;
    } catch (edgeError) {
      lastEdgeError = edgeError as Error;
      console.warn(`[TTS] Edge TTS attempt ${attempt}/${EDGE_TTS_RETRIES} failed:`, lastEdgeError.message);
      // Clean up partial file before retry
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      if (attempt < EDGE_TTS_RETRIES) {
        await new Promise(r => setTimeout(r, 1000)); // 1s delay between retries
      }
    }
  }

  // Fallback: macOS say + ffmpeg (different voice!)
  console.warn('[TTS] All Edge TTS attempts failed, falling back to macOS Daniel voice. Last error:', lastEdgeError?.message);
  await synthesizeWithMacosSay(cleanText, outputPath);
  return outputPath;
}

/**
 * Edge TTS synthesis via Python CLI (more reliable than Node.js packages)
 * Uses: pip install edge-tts
 */
async function synthesizeWithEdgeTTS(text: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child?.kill('SIGTERM');
        reject(new Error(`Edge TTS timed out after ${EDGE_TTS_TIMEOUT}ms`));
      }
    }, EDGE_TTS_TIMEOUT);

    child = execFile('edge-tts', [
      '--voice', TTS_VOICE,
      '--text', text,
      '--write-media', outputPath
    ], (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(new Error(`Edge TTS CLI failed: ${error.message}`));
        return;
      }

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 100) {
        reject(new Error('Edge TTS produced empty output'));
        return;
      }

      resolve();
    });
  });
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

/**
 * Split text into chunks suitable for voice synthesis.
 * Splits on sentence boundaries, keeping each chunk under maxChars.
 */
export function splitForVoice(text: string, maxChars: number = 1200): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.match(/[^.!?]*[.!?]+[\s]*/g);
  if (!sentences) {
    // No sentence boundaries — split on word boundaries
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxChars) {
      const slice = remaining.slice(0, maxChars);
      const lastSpace = slice.lastIndexOf(' ');
      const splitAt = lastSpace > maxChars / 2 ? lastSpace : maxChars;
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining.trim()) chunks.push(remaining.trim());
    return chunks;
  }

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    // Single sentence exceeds maxChars — push as its own chunk
    if (sentence.length > maxChars && current.length === 0) {
      chunks.push(sentence.trim());
      continue;
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
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

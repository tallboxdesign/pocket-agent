/**
 * Audio transcription utility
 * Primary: macOS native SFSpeechRecognizer (free, on-device)
 * Fallback: OpenAI Whisper API (requires API key)
 */

import OpenAI from 'openai';
import { SettingsManager } from '../settings';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { app } from 'electron';

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
  duration?: number;
}

/**
 * Check if ffmpeg is available for audio format conversion
 */
let ffmpegPath: string | null | undefined = undefined;
function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    execFileSync('which', ['ffmpeg'], { encoding: 'utf-8' });
    ffmpegPath = 'ffmpeg';
    return ffmpegPath;
  } catch {
    ffmpegPath = null;
    return null;
  }
}

/**
 * Find the native transcriber binary
 */
function getNativeBinaryPath(): string | null {
  if (process.platform !== 'darwin') return null;

  let binaryPath: string;
  if (app.isPackaged) {
    binaryPath = path.join(process.resourcesPath, 'app', 'assets', 'transcribe-speech');
  } else {
    binaryPath = path.join(__dirname, '..', '..', 'assets', 'transcribe-speech');
  }
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

/**
 * Convert audio buffer to WAV using ffmpeg
 */
async function convertToWav(buffer: Buffer, format: string, tempDir: string): Promise<string> {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    throw new Error('ffmpeg not found. Install with: brew install ffmpeg');
  }

  const inputFile = path.join(tempDir, `input-${Date.now()}.${format}`);
  const outputFile = path.join(tempDir, `converted-${Date.now()}.wav`);

  fs.writeFileSync(inputFile, buffer);

  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-i', inputFile, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', '-y', outputFile],
      { timeout: 30000 },
      (error, _stdout, stderr) => {
        try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
        if (error) {
          reject(new Error(`ffmpeg conversion failed: ${stderr?.trim() || error.message}`));
        } else {
          resolve(outputFile);
        }
      }
    );
  });
}

/**
 * Transcribe a WAV file using the native macOS binary, with chunking for long audio
 */
async function transcribeWavFile(
  wavPath: string,
  binaryPath: string,
  tempDir: string
): Promise<string> {
  const wavBuffer = fs.readFileSync(wavPath);

  // Parse WAV header
  const sampleRate = wavBuffer.readUInt32LE(24);
  const blockAlign = wavBuffer.readUInt16LE(32);
  const dataStart = 44;
  const dataLength = wavBuffer.length - dataStart;
  const totalSeconds = Math.round(dataLength / (sampleRate * blockAlign));

  // Split into ~55-second chunks
  const chunkSeconds = 55;
  const bytesPerChunk = sampleRate * blockAlign * chunkSeconds;
  const chunkCount = Math.ceil(dataLength / bytesPerChunk);

  console.log(`[Transcribe] Native: ${totalSeconds}s audio in ${chunkCount} chunk(s)`);

  const writeChunkWav = (chunkIndex: number): string => {
    const chunkStart = chunkIndex * bytesPerChunk;
    const chunkEnd = Math.min(chunkStart + bytesPerChunk, dataLength);
    const chunkDataLen = chunkEnd - chunkStart;
    const chunkFile = path.join(tempDir, `chunk-${Date.now()}-${chunkIndex}.wav`);

    const chunkBuf = Buffer.alloc(44 + chunkDataLen);
    wavBuffer.copy(chunkBuf, 0, 0, 44);
    chunkBuf.writeUInt32LE(36 + chunkDataLen, 4);
    chunkBuf.writeUInt32LE(chunkDataLen, 40);
    wavBuffer.copy(chunkBuf, 44, dataStart + chunkStart, dataStart + chunkEnd);
    fs.writeFileSync(chunkFile, chunkBuf);
    return chunkFile;
  };

  const transcribeChunk = (filePath: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      execFile(binaryPath, [filePath], { timeout: 90000 }, (error, stdout, stderr) => {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        if (error) {
          if (stderr?.includes('not authorized')) {
            reject(
              new Error(
                'Speech recognition permission denied. Allow in System Settings > Privacy & Security > Speech Recognition.'
              )
            );
          } else {
            reject(new Error(stderr?.trim() || error.message));
          }
        } else {
          resolve(stdout.trim());
        }
      });
    });
  };

  const results: string[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunkFile = writeChunkWav(i);
    try {
      const text = await transcribeChunk(chunkFile);
      if (text) results.push(text);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('not authorized') || errMsg.includes('permission')) {
        throw err;
      }
      console.warn(`[Transcribe] Chunk ${i + 1}/${chunkCount} failed: ${errMsg}`);
    }
  }

  return results.join(' ').trim();
}

/**
 * Transcribe audio using macOS native SFSpeechRecognizer (free, on-device)
 */
async function transcribeWithNative(
  buffer: Buffer,
  format: string
): Promise<TranscriptionResult> {
  const binaryPath = getNativeBinaryPath();
  if (!binaryPath) {
    return { success: false, error: 'Native transcriber not available' };
  }

  const tempDir = path.join(os.tmpdir(), 'pocket-agent-voice');
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    let wavPath: string;
    const startTime = Date.now();

    if (format === 'wav') {
      // Already WAV - write directly
      wavPath = path.join(tempDir, `direct-${Date.now()}.wav`);
      fs.writeFileSync(wavPath, buffer);
    } else {
      // Convert to WAV via ffmpeg
      wavPath = await convertToWav(buffer, format, tempDir);
    }

    const text = await transcribeWavFile(wavPath, binaryPath, tempDir);
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }

    const duration = (Date.now() - startTime) / 1000;

    if (!text) {
      return { success: false, error: 'No speech detected.' };
    }

    return { success: true, text, duration };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Native transcription failed',
    };
  }
}

/**
 * Transcribe audio buffer using OpenAI Whisper API
 */
async function transcribeWithWhisper(
  buffer: Buffer,
  format: string,
  language?: string
): Promise<TranscriptionResult> {
  const apiKey = SettingsManager.get('openai.apiKey');

  if (!apiKey) {
    return {
      success: false,
      error: 'OpenAI API key not configured.',
    };
  }

  try {
    const openai = new OpenAI({ apiKey });

    const mimeType = getMimeType(format);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
    const file = new File([arrayBuffer], `audio.${format}`, { type: mimeType });

    const startTime = Date.now();

    const response = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language,
    });

    const duration = (Date.now() - startTime) / 1000;

    return {
      success: true,
      text: response.text,
      duration,
    };
  } catch (error) {
    console.error('[Transcribe] Whisper error:', error);

    if (error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        return { success: false, error: 'Invalid OpenAI API key.' };
      }
      if (error.status === 429) {
        return { success: false, error: 'OpenAI rate limit exceeded. Try again shortly.' };
      }
      return { success: false, error: `OpenAI API error: ${error.message}` };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown transcription error',
    };
  }
}

/**
 * Transcribe audio buffer
 * Tries native macOS transcription first (free), falls back to OpenAI Whisper
 */
export async function transcribeAudio(
  buffer: Buffer,
  format: string,
  language?: string
): Promise<TranscriptionResult> {
  // Try native macOS transcription first (free, on-device)
  if (process.platform === 'darwin') {
    const nativeBinary = getNativeBinaryPath();
    const ffmpeg = findFfmpeg();

    // Native is available if we have the binary AND either WAV input or ffmpeg for conversion
    if (nativeBinary && (format === 'wav' || ffmpeg)) {
      console.log(`[Transcribe] Using native macOS transcription for ${format} audio`);
      const result = await transcribeWithNative(buffer, format);
      if (result.success) {
        return result;
      }
      // If native failed for a non-permission reason, try OpenAI as fallback
      if (!result.error?.includes('permission') && !result.error?.includes('not authorized')) {
        console.warn(`[Transcribe] Native failed (${result.error}), trying OpenAI fallback...`);
      } else {
        return result; // Permission errors should not fall through
      }
    }
  }

  // Fallback to OpenAI Whisper
  return transcribeWithWhisper(buffer, format, language);
}

/**
 * Check if voice transcription is available
 * True if macOS native transcriber is available OR OpenAI key is configured
 */
export function isTranscriptionAvailable(): boolean {
  if (process.platform === 'darwin' && getNativeBinaryPath() && findFfmpeg()) {
    return true;
  }
  return !!SettingsManager.get('openai.apiKey');
}

/**
 * Get MIME type for audio format
 */
function getMimeType(format: string): string {
  const mimeTypes: Record<string, string> = {
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    wav: 'audio/wav',
    webm: 'audio/webm',
    mpeg: 'audio/mpeg',
    mpga: 'audio/mpeg',
  };
  return mimeTypes[format.toLowerCase()] || 'audio/ogg';
}

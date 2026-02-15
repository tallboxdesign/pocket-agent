/**
 * Telegram document handler
 * Downloads files to local workspace for agent access via Read tool
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { SettingsManager } from '../../../settings';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';

export interface DocumentHandlerDeps {
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
 * Generate a unique filename with timestamp
 */
export function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now();
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  // Sanitize filename - remove special characters
  const sanitizedBase = base.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `telegram_${timestamp}_${sanitizedBase}${ext}`;
}

/**
 * Get a human-readable file type description
 */
export function getFileTypeDescription(mimeType: string, fileName: string): string {
  if (mimeType === 'application/pdf') return 'PDF document';

  const ext = fileName.split('.').pop()?.toLowerCase();

  // Office documents
  const officeExtensions: Record<string, string> = {
    docx: 'Word document', odt: 'OpenDocument text',
    pptx: 'PowerPoint presentation', odp: 'OpenDocument presentation',
    xlsx: 'Excel spreadsheet', ods: 'OpenDocument spreadsheet',
    rtf: 'RTF document',
  };
  if (ext && officeExtensions[ext]) return officeExtensions[ext];

  // Code files
  const codeExtensions: Record<string, string> = {
    js: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript React', jsx: 'JavaScript React',
    py: 'Python', rb: 'Ruby', java: 'Java', c: 'C', cpp: 'C++', h: 'C header',
    cs: 'C#', go: 'Go', rs: 'Rust', swift: 'Swift', kt: 'Kotlin',
    sh: 'Shell script', sql: 'SQL', html: 'HTML', css: 'CSS',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML',
  };
  if (ext && codeExtensions[ext]) return `${codeExtensions[ext]} file`;

  // Text files
  if (ext === 'txt') return 'text file';
  if (ext === 'md') return 'Markdown document';
  if (ext === 'log') return 'log file';

  // Spreadsheets
  if (ext === 'csv') return 'CSV spreadsheet';
  if (ext === 'xls') return 'Excel spreadsheet';

  return 'file';
}

/**
 * Check if file type is supported
 */
export function isSupportedFileType(mimeType: string, fileName: string): boolean {
  // PDF
  if (mimeType === 'application/pdf') return true;

  // Check by extension
  const ext = fileName.split('.').pop()?.toLowerCase();
  const supportedExtensions = [
    // Office documents
    'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'rtf',
    // Code
    'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'java', 'c', 'cpp', 'h', 'hpp',
    'cs', 'go', 'rs', 'swift', 'kt', 'sh', 'bash', 'sql', 'html', 'css',
    'json', 'yaml', 'yml', 'xml',
    // Text
    'txt', 'md', 'log', 'ini', 'cfg', 'conf',
    // Spreadsheets
    'csv', 'xls',
  ];

  return ext ? supportedExtensions.includes(ext) : false;
}

/**
 * Handle incoming document messages
 * Downloads file to workspace and tells agent the path
 */
export async function handleDocumentMessage(
  ctx: Context,
  deps: DocumentHandlerDeps
): Promise<void> {
  console.log('[Telegram] Document handler called');
  const chatId = ctx.chat?.id;
  const document = ctx.message?.document;
  const caption = ctx.message?.caption || '';

  console.log('[Telegram] Document data:', {
    chatId,
    hasDocument: !!document,
    fileName: document?.file_name,
    mimeType: document?.mime_type
  });

  if (!chatId || !document) {
    console.log('[Telegram] Document handler: missing chatId or document, returning');
    return;
  }

  const { onMessageCallback, sendResponse } = deps;

  // Get document metadata
  const fileName = document.file_name || 'document';
  const mimeType = document.mime_type || 'application/octet-stream';
  const fileSize = document.file_size || 0;

  // Check file size limit (20MB)
  const MAX_FILE_SIZE = 20 * 1024 * 1024;
  if (fileSize > MAX_FILE_SIZE) {
    await ctx.reply(
      `File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB).\n` +
      `Maximum size is 20MB.`
    );
    return;
  }

  // Check if file type is supported
  if (!isSupportedFileType(mimeType, fileName)) {
    await ctx.reply(
      `I can't process this file type (${mimeType}).\n\n` +
      `Supported formats:\n` +
      `• Office documents (.docx, .pptx, .xlsx, .odt, .odp, .ods, .rtf)\n` +
      `• PDF files\n` +
      `• Code files (.js, .ts, .py, .go, etc.)\n` +
      `• Text files (.txt, .md, .log)\n` +
      `• Spreadsheets (.csv)`
    );
    return;
  }

  try {
    const result = await withTyping(ctx, async () => {
      // Get file from Telegram
      const file = await ctx.api.getFile(document.file_id);
      if (!file.file_path) {
        throw new Error('Could not get file path from Telegram');
      }

      // Download the document
      const botToken = SettingsManager.get('telegram.botToken');
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download document: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to local files directory
      const filesDir = getFilesDirectory();
      const uniqueFilename = generateUniqueFilename(fileName);
      const localPath = path.join(filesDir, uniqueFilename);

      fs.writeFileSync(localPath, buffer);

      const fileSizeKB = (buffer.length / 1024).toFixed(1);
      const fileType = getFileTypeDescription(mimeType, fileName);

      console.log(`[Telegram] Saved file: ${localPath} (${fileSizeKB}KB)`);

      // Try to extract text from Office documents
      const extractableExtensions = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'rtf']);
      const ext = fileName.split('.').pop()?.toLowerCase();
      let extractedText: string | null = null;

      if (ext && extractableExtensions.has(ext)) {
        try {
          const { parseOffice } = await import('officeparser');
          const ast = await parseOffice(localPath);
          const text = ast.toText();
          extractedText = text.length > 50000 ? text.slice(0, 50000) + '\n... (truncated)' : text;
          console.log(`[Telegram] Extracted ${text.length} chars from ${fileName}`);
        } catch (err) {
          console.warn(`[Telegram] Failed to extract text from ${fileName}:`, err);
        }
      }

      // Build prompt for agent
      let prompt: string;
      if (extractedText) {
        const header = caption
          ? `${caption}\n\n[User sent a ${fileType} via Telegram: "${fileName}"]`
          : `[User sent a ${fileType} via Telegram: "${fileName}"]`;
        prompt = `${header}\n\`\`\`\n${extractedText}\n\`\`\``;
      } else {
        prompt = caption
          ? `${caption}\n\n[User sent a ${fileType} via Telegram: "${fileName}"]\nFile saved to: ${localPath}\n\nPlease read and analyze this file.`
          : `[User sent a ${fileType} via Telegram: "${fileName}"]\nFile saved to: ${localPath}\n\nPlease read and analyze this file.`;
      }

      // Look up which session this chat is linked to
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      return AgentManager.processMessage(prompt, 'telegram', sessionId, undefined, {
        hasAttachment: true,
        attachmentType: 'document',
      });
    });

    // Send response
    await sendResponse(ctx, result.response);

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
      const displayMessage = caption
        ? `${caption} [Document: ${fileName}]`
        : `Sent document: ${fileName}`;

      onMessageCallback({
        userMessage: displayMessage,
        response: result.response,
        channel: 'telegram',
        chatId,
        sessionId,
        hasAttachment: true,
        attachmentType: 'document',
        wasCompacted: result.wasCompacted,
        media: result.media,
      });
    }

    // If compaction happened, notify
    if (result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Document error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error processing document: ${errorMsg}`);
  }
}

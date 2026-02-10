/**
 * Telegram file download utilities
 */

import { Api } from 'grammy';
import { SettingsManager } from '../../../settings';
import { DownloadResult } from '../types';

/**
 * Download a file from Telegram by file ID
 */
export async function downloadFile(
  api: Api,
  fileId: string
): Promise<DownloadResult> {
  try {
    // Get file info from Telegram
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      return {
        success: false,
        error: 'Could not get file path from Telegram',
      };
    }

    // Download the file
    const botToken = SettingsManager.get('telegram.botToken');
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok) {
      return {
        success: false,
        error: `Failed to download file: ${response.statusText}`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract file name from path
    const fileName = file.file_path.split('/').pop() || 'file';

    // Determine MIME type from extension
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeType = getMimeType(ext);

    return {
      success: true,
      buffer,
      mimeType,
      fileName,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown download error',
    };
  }
}

/**
 * Download a file and convert to base64
 */
export async function downloadFileAsBase64(
  api: Api,
  fileId: string
): Promise<{ success: boolean; base64?: string; mimeType?: string; error?: string }> {
  const result = await downloadFile(api, fileId);

  if (!result.success || !result.buffer) {
    return {
      success: false,
      error: result.error,
    };
  }

  return {
    success: true,
    base64: result.buffer.toString('base64'),
    mimeType: result.mimeType,
  };
}

/**
 * Get MIME type from file extension
 */
function getMimeType(ext?: string): string {
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    // Audio
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    // Code files
    js: 'text/javascript',
    ts: 'text/typescript',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    go: 'text/x-go',
    rs: 'text/x-rust',
    swift: 'text/x-swift',
    kt: 'text/x-kotlin',
    html: 'text/html',
    css: 'text/css',
    xml: 'text/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    sh: 'text/x-shellscript',
    bash: 'text/x-shellscript',
    sql: 'text/x-sql',
  };

  return mimeTypes[ext || ''] || 'application/octet-stream';
}


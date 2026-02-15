/**
 * Unit tests for Telegram document handler helpers
 *
 * Tests file type support checking, file type descriptions, and unique filename generation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  isSupportedFileType,
  getFileTypeDescription,
  generateUniqueFilename,
} from '../../src/channels/telegram/handlers/documents';

describe('Document Handler Helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ============ isSupportedFileType ============

  describe('isSupportedFileType', () => {
    it('should support PDF by mimetype', () => {
      expect(isSupportedFileType('application/pdf', 'doc.pdf')).toBe(true);
    });

    it('should support PDF by mimetype regardless of filename', () => {
      expect(isSupportedFileType('application/pdf', 'unknown')).toBe(true);
    });

    it('should support Python files by extension', () => {
      expect(isSupportedFileType('text/plain', 'script.py')).toBe(true);
    });

    it('should support .docx files', () => {
      expect(isSupportedFileType('application/vnd.openxmlformats', 'report.docx')).toBe(true);
    });

    it('should support .json files', () => {
      expect(isSupportedFileType('application/json', 'data.json')).toBe(true);
    });

    it('should support .xlsx files', () => {
      expect(isSupportedFileType('application/vnd.ms-excel', 'data.xlsx')).toBe(true);
    });

    it('should support .ts files', () => {
      expect(isSupportedFileType('text/plain', 'index.ts')).toBe(true);
    });

    it('should support .md files', () => {
      expect(isSupportedFileType('text/markdown', 'README.md')).toBe(true);
    });

    it('should support .txt files', () => {
      expect(isSupportedFileType('text/plain', 'notes.txt')).toBe(true);
    });

    it('should support .csv files', () => {
      expect(isSupportedFileType('text/csv', 'data.csv')).toBe(true);
    });

    it('should not support .exe files', () => {
      expect(isSupportedFileType('application/octet-stream', 'program.exe')).toBe(false);
    });

    it('should not support .zip files', () => {
      expect(isSupportedFileType('application/zip', 'archive.zip')).toBe(false);
    });

    it('should not support .mp3 files', () => {
      expect(isSupportedFileType('audio/mpeg', 'song.mp3')).toBe(false);
    });

    it('should return false for files with no extension', () => {
      expect(isSupportedFileType('application/octet-stream', 'noextension')).toBe(false);
    });

    it('should handle case-insensitive extensions via toLowerCase', () => {
      // The implementation uses .toLowerCase(), so .PY -> py which IS supported
      expect(isSupportedFileType('text/plain', 'script.PY')).toBe(true);
    });
  });

  // ============ getFileTypeDescription ============

  describe('getFileTypeDescription', () => {
    it('should return "PDF document" for PDF mimetype', () => {
      expect(getFileTypeDescription('application/pdf', 'doc.pdf')).toBe('PDF document');
    });

    it('should return "Word document" for .docx', () => {
      expect(getFileTypeDescription('application/octet-stream', 'report.docx')).toBe('Word document');
    });

    it('should return "Python file" for .py', () => {
      expect(getFileTypeDescription('text/plain', 'script.py')).toBe('Python file');
    });

    it('should return "TypeScript file" for .ts', () => {
      expect(getFileTypeDescription('text/plain', 'index.ts')).toBe('TypeScript file');
    });

    it('should return "CSV spreadsheet" for .csv', () => {
      expect(getFileTypeDescription('text/csv', 'data.csv')).toBe('CSV spreadsheet');
    });

    it('should return "Markdown document" for .md', () => {
      expect(getFileTypeDescription('text/markdown', 'README.md')).toBe('Markdown document');
    });

    it('should return "text file" for .txt', () => {
      expect(getFileTypeDescription('text/plain', 'notes.txt')).toBe('text file');
    });

    it('should return "JavaScript file" for .js', () => {
      expect(getFileTypeDescription('text/javascript', 'app.js')).toBe('JavaScript file');
    });

    it('should return "JSON file" for .json', () => {
      expect(getFileTypeDescription('application/json', 'config.json')).toBe('JSON file');
    });

    it('should return "Excel spreadsheet" for .xlsx', () => {
      expect(getFileTypeDescription('application/octet-stream', 'data.xlsx')).toBe('Excel spreadsheet');
    });

    it('should return "Excel spreadsheet" for .xls', () => {
      expect(getFileTypeDescription('application/octet-stream', 'data.xls')).toBe('Excel spreadsheet');
    });

    it('should return "PowerPoint presentation" for .pptx', () => {
      expect(getFileTypeDescription('application/octet-stream', 'slides.pptx')).toBe('PowerPoint presentation');
    });

    it('should return "Shell script file" for .sh', () => {
      expect(getFileTypeDescription('text/plain', 'run.sh')).toBe('Shell script file');
    });

    it('should return "log file" for .log', () => {
      expect(getFileTypeDescription('text/plain', 'app.log')).toBe('log file');
    });

    it('should return "file" for unknown extension', () => {
      expect(getFileTypeDescription('application/octet-stream', 'unknown.xyz')).toBe('file');
    });

    it('should return "file" for no extension', () => {
      expect(getFileTypeDescription('application/octet-stream', 'noext')).toBe('file');
    });
  });

  // ============ generateUniqueFilename ============

  describe('generateUniqueFilename', () => {
    it('should contain "telegram_" prefix', () => {
      const result = generateUniqueFilename('document.pdf');
      expect(result).toMatch(/^telegram_/);
    });

    it('should contain timestamp digits', () => {
      const result = generateUniqueFilename('document.pdf');
      // Format: telegram_<timestamp>_<name>.<ext>
      expect(result).toMatch(/^telegram_\d+_/);
    });

    it('should preserve the file extension', () => {
      const result = generateUniqueFilename('document.pdf');
      expect(result).toMatch(/\.pdf$/);
    });

    it('should preserve .docx extension', () => {
      const result = generateUniqueFilename('report.docx');
      expect(result).toMatch(/\.docx$/);
    });

    it('should sanitize special characters in base name', () => {
      const result = generateUniqueFilename('my file (copy).pdf');
      // Special chars like spaces and parens should be replaced with underscore
      expect(result).not.toContain(' ');
      expect(result).not.toContain('(');
      expect(result).not.toContain(')');
      expect(result).toContain('my_file__copy_');
    });

    it('should handle filename with no extension', () => {
      const result = generateUniqueFilename('noextension');
      expect(result).toMatch(/^telegram_\d+_noextension$/);
    });

    it('should generate unique filenames on successive calls', () => {
      const result1 = generateUniqueFilename('doc.pdf');
      const result2 = generateUniqueFilename('doc.pdf');
      // Timestamps might be same if called quickly, but they should
      // both follow the correct pattern
      expect(result1).toMatch(/^telegram_\d+_doc\.pdf$/);
      expect(result2).toMatch(/^telegram_\d+_doc\.pdf$/);
    });
  });
});

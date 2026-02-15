/**
 * Unit tests for the Instructions configuration module
 *
 * Tests loading, saving, and path resolution for the instructions file
 * at ~/Documents/Pocket-agent/CLAUDE.md
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

// Mock os module
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
  },
}));

// Import mocked modules
import fs from 'fs';
import os from 'os';

// Import the module under test after mocks are set up
import {
  loadInstructions,
  saveInstructions,
  getInstructionsPath,
  DEFAULT_INSTRUCTIONS,
} from '../../src/config/instructions';

describe('Instructions Configuration', () => {
  const mockHomedir = '/mock/home';
  const expectedDir = path.join(mockHomedir, 'Documents', 'Pocket-agent');
  const expectedFile = path.join(expectedDir, 'CLAUDE.md');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
  });

  // ============ getInstructionsPath ============

  describe('getInstructionsPath', () => {
    it('should return the correct path based on os.homedir()', () => {
      const result = getInstructionsPath();
      expect(result).toBe(expectedFile);
    });
  });

  // ============ loadInstructions ============

  describe('loadInstructions', () => {
    it('should create directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false); // directory doesn't exist
      vi.mocked(fs.existsSync).mockReturnValueOnce(false); // file doesn't exist

      loadInstructions();

      expect(fs.mkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
    });

    it('should create default instructions file if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // directory exists
      vi.mocked(fs.existsSync).mockReturnValueOnce(false); // file doesn't exist

      const result = loadInstructions();

      expect(fs.writeFileSync).toHaveBeenCalledWith(expectedFile, DEFAULT_INSTRUCTIONS);
      expect(result).toBe(DEFAULT_INSTRUCTIONS);
    });

    it('should read and return existing instructions file content', () => {
      const customInstructions = '# Custom Instructions\n\nDo this and that.';
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // directory exists
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // file exists
      vi.mocked(fs.readFileSync).mockReturnValue(customInstructions);

      const result = loadInstructions();

      expect(fs.readFileSync).toHaveBeenCalledWith(expectedFile, 'utf-8');
      expect(result).toBe(customInstructions);
    });

    it('should return default instructions on file read error', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // directory exists
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // file exists
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = loadInstructions();

      expect(result).toBe(DEFAULT_INSTRUCTIONS);
    });

    it('should return default instructions on directory creation error', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false); // directory doesn't exist
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('Cannot create directory');
      });

      const result = loadInstructions();

      expect(result).toBe(DEFAULT_INSTRUCTIONS);
    });

    it('should return default instructions on file write error when creating default', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true); // directory exists
      vi.mocked(fs.existsSync).mockReturnValueOnce(false); // file doesn't exist
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Disk full');
      });

      const result = loadInstructions();

      expect(result).toBe(DEFAULT_INSTRUCTIONS);
    });
  });

  // ============ saveInstructions ============

  describe('saveInstructions', () => {
    it('should write content to instructions file and return true', () => {
      const newContent = '# New Instructions\n\nUpdated content.';
      vi.mocked(fs.existsSync).mockReturnValue(true); // directory exists
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const result = saveInstructions(newContent);

      expect(fs.writeFileSync).toHaveBeenCalledWith(expectedFile, newContent);
      expect(result).toBe(true);
    });

    it('should create directory if it does not exist', () => {
      const newContent = '# New Instructions\n\nContent.';
      vi.mocked(fs.existsSync).mockReturnValue(false); // directory doesn't exist
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const result = saveInstructions(newContent);

      expect(fs.mkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(expectedFile, newContent);
      expect(result).toBe(true);
    });

    it('should return false on write error', () => {
      const newContent = '# New Instructions';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = saveInstructions(newContent);

      expect(result).toBe(false);
    });

    it('should return false on directory creation error', () => {
      const newContent = '# New Instructions';
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('Cannot create directory');
      });

      const result = saveInstructions(newContent);

      expect(result).toBe(false);
    });

    it('should save empty string content', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const result = saveInstructions('');

      expect(fs.writeFileSync).toHaveBeenCalledWith(expectedFile, '');
      expect(result).toBe(true);
    });

    it('should handle content with special characters', () => {
      const specialContent = '# Instructions\n\nUnicode: 日本語 🎉\nSpecial: <>&"\'';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const result = saveInstructions(specialContent);

      expect(fs.writeFileSync).toHaveBeenCalledWith(expectedFile, specialContent);
      expect(result).toBe(true);
    });
  });

  // ============ DEFAULT_INSTRUCTIONS structure ============

  describe('DEFAULT_INSTRUCTIONS content structure', () => {
    it('should have Pocket Agent Guidelines header', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('# Pocket Agent Guidelines');
    });

    it('should include Memory section', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('## Memory');
    });

    it('should include Soul section', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('## Soul');
    });

    it('should include Routines vs Reminders section', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('## Routines vs Reminders');
    });

    it('should include Pocket CLI section', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('## Pocket CLI');
    });

    it('should include Proactive Behavior section', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('## Proactive Behavior');
    });

    it('should mention memory_search tool', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('memory_search');
    });

    it('should mention remember tool', () => {
      expect(DEFAULT_INSTRUCTIONS).toContain('remember');
    });
  });
});

/**
 * Unit tests for the workflow commands loader
 *
 * Tests loading, parsing, and finding workflow commands from the filesystem
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
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
import { loadWorkflowCommands, findWorkflowCommand } from '../../src/config/commands-loader';

describe('Commands Loader', () => {
  const mockHomedir = '/mock/home';
  const expectedDir = path.join(mockHomedir, 'Documents', 'Pocket-agent', '.claude', 'commands');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
  });

  // ============ loadWorkflowCommands ============

  describe('loadWorkflowCommands', () => {
    it('should return empty array if directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadWorkflowCommands();

      expect(result).toEqual([]);
      expect(fs.existsSync).toHaveBeenCalledWith(expectedDir);
    });

    it('should read .md files and parse frontmatter', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['my-workflow.md', 'another.md'] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(
          '---\nname: my-workflow\ndescription: A test workflow\n---\n# My Workflow\n\nDo stuff.'
        )
        .mockReturnValueOnce(
          '---\nname: another\ndescription: Another workflow\n---\n# Another\n\nMore stuff.'
        );

      const result = loadWorkflowCommands();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'my-workflow',
        description: 'A test workflow',
        filename: 'my-workflow.md',
        content: '# My Workflow\n\nDo stuff.',
      });
      expect(result[1]).toEqual({
        name: 'another',
        description: 'Another workflow',
        filename: 'another.md',
        content: '# Another\n\nMore stuff.',
      });
    });

    it('should use filename as name fallback when no frontmatter', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['plain-file.md'] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.readFileSync).mockReturnValue('# Just a plain file\n\nNo frontmatter here.');

      const result = loadWorkflowCommands();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('plain-file');
      expect(result[0].description).toBe('');
      expect(result[0].filename).toBe('plain-file.md');
    });

    it('should only read .md files, ignoring others', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'workflow.md',
        'readme.txt',
        'config.json',
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.readFileSync).mockReturnValue('---\nname: test\ndescription: test\n---\nContent');

      const result = loadWorkflowCommands();

      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('workflow.md');
    });

    it('should handle fs error gracefully and return empty array', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = loadWorkflowCommands();

      expect(result).toEqual([]);
    });

    it('should return empty array when directory exists but has no .md files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['file.txt', 'image.png'] as unknown as ReturnType<typeof fs.readdirSync>);

      const result = loadWorkflowCommands();

      expect(result).toEqual([]);
    });

    it('should parse frontmatter with name only', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['test.md'] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.readFileSync).mockReturnValue('---\nname: custom-name\n---\nBody content');

      const result = loadWorkflowCommands();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('custom-name');
      expect(result[0].description).toBe('');
    });
  });

  // ============ findWorkflowCommand ============

  describe('findWorkflowCommand', () => {
    it('should find a command by name', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['review.md', 'deploy.md'] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce('---\nname: review\ndescription: Code review\n---\nReview code.')
        .mockReturnValueOnce('---\nname: deploy\ndescription: Deploy app\n---\nDeploy the app.');

      const result = findWorkflowCommand('deploy');

      expect(result).toBeDefined();
      expect(result!.name).toBe('deploy');
      expect(result!.description).toBe('Deploy app');
    });

    it('should return undefined for non-existent command', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['review.md'] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.readFileSync).mockReturnValue('---\nname: review\ndescription: Code review\n---\nReview code.');

      const result = findWorkflowCommand('nonexistent');

      expect(result).toBeUndefined();
    });

    it('should return undefined when no commands directory exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = findWorkflowCommand('anything');

      expect(result).toBeUndefined();
    });
  });
});

/**
 * Unit tests for default command configuration
 *
 * Tests the structure and content of DEFAULT_COMMANDS
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { DEFAULT_COMMANDS } from '../../src/config/commands';

describe('Commands Configuration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('DEFAULT_COMMANDS', () => {
    it('should be a non-empty array', () => {
      expect(Array.isArray(DEFAULT_COMMANDS)).toBe(true);
      expect(DEFAULT_COMMANDS.length).toBeGreaterThan(0);
    });

    it('should have entries with filename ending in .md', () => {
      for (const command of DEFAULT_COMMANDS) {
        expect(command.filename).toMatch(/\.md$/);
      }
    });

    it('should have entries with non-empty content', () => {
      for (const command of DEFAULT_COMMANDS) {
        expect(command.content).toBeDefined();
        expect(command.content.length).toBeGreaterThan(0);
      }
    });

    it('should have entries with non-empty filename', () => {
      for (const command of DEFAULT_COMMANDS) {
        expect(command.filename).toBeDefined();
        expect(command.filename.length).toBeGreaterThan(0);
      }
    });

    it('should have content with YAML frontmatter', () => {
      for (const command of DEFAULT_COMMANDS) {
        // Content should start with ---
        expect(command.content.trimStart()).toMatch(/^---/);
        // Content should contain name: field
        expect(command.content).toMatch(/^name:\s*.+$/m);
        // Content should contain description: field
        expect(command.content).toMatch(/^description:\s*.+$/m);
      }
    });

    it('should include create-workflow.md command', () => {
      const createWorkflow = DEFAULT_COMMANDS.find(c => c.filename === 'create-workflow.md');
      expect(createWorkflow).toBeDefined();
    });

    it('should have create-workflow.md with correct name frontmatter', () => {
      const createWorkflow = DEFAULT_COMMANDS.find(c => c.filename === 'create-workflow.md');
      expect(createWorkflow).toBeDefined();
      expect(createWorkflow!.content).toMatch(/^name:\s*create-workflow$/m);
    });

    it('should have create-workflow.md with description frontmatter', () => {
      const createWorkflow = DEFAULT_COMMANDS.find(c => c.filename === 'create-workflow.md');
      expect(createWorkflow).toBeDefined();
      expect(createWorkflow!.content).toMatch(/^description:\s*.+$/m);
    });

    it('should have entries conforming to DefaultCommand interface', () => {
      for (const command of DEFAULT_COMMANDS) {
        expect(typeof command.filename).toBe('string');
        expect(typeof command.content).toBe('string');
      }
    });
  });
});

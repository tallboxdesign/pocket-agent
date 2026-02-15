import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock embeddings
vi.mock('../../src/memory/embeddings', () => ({
  initEmbeddings: vi.fn(),
  hasEmbeddings: vi.fn(() => false),
  embed: vi.fn(),
  cosineSimilarity: vi.fn(),
  serializeEmbedding: vi.fn(),
  deserializeEmbedding: vi.fn(),
}));

import { MemoryManager } from '../../src/memory/index';
import {
  setSoulMemoryManager,
  handleSoulSetTool,
  handleSoulGetTool,
  handleSoulListTool,
  handleSoulDeleteTool,
  getSoulSetToolDefinition,
} from '../../src/tools/soul-tools';

describe('Soul Tools', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    memory = new MemoryManager(':memory:');
    setSoulMemoryManager(memory);
  });

  afterEach(() => {
    if (memory) {
      memory.close();
    }
  });

  // ============================================================================
  // getSoulSetToolDefinition
  // ============================================================================

  describe('getSoulSetToolDefinition', () => {
    it('has correct name', () => {
      const def = getSoulSetToolDefinition();
      expect(def.name).toBe('soul_set');
    });

    it('has required fields: aspect and content', () => {
      const def = getSoulSetToolDefinition();
      expect(def.input_schema.required).toContain('aspect');
      expect(def.input_schema.required).toContain('content');
    });
  });

  // ============================================================================
  // handleSoulSetTool
  // ============================================================================

  describe('handleSoulSetTool', () => {
    it('returns error when memory is not initialized', async () => {
      setSoulMemoryManager(null as unknown as MemoryManager);

      const result = await handleSoulSetTool({ aspect: 'style', content: 'casual' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Memory not initialized');

      // Restore for other tests
      setSoulMemoryManager(memory);
    });

    it('returns error when fields are missing', async () => {
      const result1 = await handleSoulSetTool({ aspect: 'style' });
      const parsed1 = JSON.parse(result1);
      expect(parsed1.error).toContain('Missing required fields');

      const result2 = await handleSoulSetTool({ content: 'casual' });
      const parsed2 = JSON.parse(result2);
      expect(parsed2.error).toContain('Missing required fields');
    });

    it('succeeds setting an aspect', async () => {
      const result = await handleSoulSetTool({
        aspect: 'communication_style',
        content: 'Friendly and casual, uses humor',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.aspect).toBe('communication_style');
      expect(parsed.id).toBeDefined();
    });

    it('updates an existing aspect', async () => {
      // Set initial
      await handleSoulSetTool({
        aspect: 'boundaries',
        content: 'Respects personal space',
      });

      // Update
      const result = await handleSoulSetTool({
        aspect: 'boundaries',
        content: 'Updated: Very respectful of personal boundaries',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      // Verify the content was updated
      const getResult = await handleSoulGetTool({ aspect: 'boundaries' });
      const getParsed = JSON.parse(getResult);
      expect(getParsed.content).toBe('Updated: Very respectful of personal boundaries');
    });
  });

  // ============================================================================
  // handleSoulGetTool
  // ============================================================================

  describe('handleSoulGetTool', () => {
    it('returns success: false when aspect not found', async () => {
      const result = await handleSoulGetTool({ aspect: 'nonexistent' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain('not found');
    });

    it('returns aspect and content when found', async () => {
      await handleSoulSetTool({
        aspect: 'relationship',
        content: 'Trusted partner in creative work',
      });

      const result = await handleSoulGetTool({ aspect: 'relationship' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.aspect).toBe('relationship');
      expect(parsed.content).toBe('Trusted partner in creative work');
      expect(parsed.updated_at).toBeDefined();
    });

    it('returns error when aspect name is missing', async () => {
      const result = await handleSoulGetTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Aspect name is required');
    });

    it('returns error when memory is not initialized', async () => {
      setSoulMemoryManager(null as unknown as MemoryManager);

      const result = await handleSoulGetTool({ aspect: 'style' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Memory not initialized');

      setSoulMemoryManager(memory);
    });
  });

  // ============================================================================
  // handleSoulListTool
  // ============================================================================

  describe('handleSoulListTool', () => {
    it('returns empty when no aspects exist', async () => {
      const result = await handleSoulListTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.aspects).toEqual([]);
    });

    it('returns count and aspects array when aspects exist', async () => {
      await handleSoulSetTool({ aspect: 'style', content: 'Casual' });
      await handleSoulSetTool({ aspect: 'boundaries', content: 'Respectful' });
      await handleSoulSetTool({ aspect: 'humor', content: 'Dry wit' });

      const result = await handleSoulListTool();
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(3);
      expect(parsed.aspects).toHaveLength(3);

      const aspectNames = parsed.aspects.map((a: { aspect: string }) => a.aspect);
      expect(aspectNames).toContain('style');
      expect(aspectNames).toContain('boundaries');
      expect(aspectNames).toContain('humor');
    });

    it('returns error when memory is not initialized', async () => {
      setSoulMemoryManager(null as unknown as MemoryManager);

      const result = await handleSoulListTool();
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Memory not initialized');

      setSoulMemoryManager(memory);
    });
  });

  // ============================================================================
  // handleSoulDeleteTool
  // ============================================================================

  describe('handleSoulDeleteTool', () => {
    it('returns success when aspect is deleted', async () => {
      await handleSoulSetTool({ aspect: 'temp_aspect', content: 'Temporary' });

      const result = await handleSoulDeleteTool({ aspect: 'temp_aspect' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('temp_aspect');

      // Verify it was actually deleted
      const getResult = await handleSoulGetTool({ aspect: 'temp_aspect' });
      const getParsed = JSON.parse(getResult);
      expect(getParsed.success).toBe(false);
    });

    it('returns success: false when aspect not found', async () => {
      const result = await handleSoulDeleteTool({ aspect: 'nonexistent' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain('not found');
    });

    it('returns error when aspect name is missing', async () => {
      const result = await handleSoulDeleteTool({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Aspect name is required');
    });

    it('returns error when memory is not initialized', async () => {
      setSoulMemoryManager(null as unknown as MemoryManager);

      const result = await handleSoulDeleteTool({ aspect: 'style' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Memory not initialized');

      setSoulMemoryManager(memory);
    });
  });
});

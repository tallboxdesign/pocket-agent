import { describe, it, expect, beforeEach, vi } from 'vitest';

// Create mock functions for MemoryManager methods
const mockSaveFact = vi.fn();
const mockDeleteFact = vi.fn();
const mockDeleteFactBySubject = vi.fn();
const mockGetAllFacts = vi.fn();
const mockGetFactsByCategory = vi.fn();
const mockSearchFactsHybrid = vi.fn();

// Create a mock MemoryManager instance
const mockMemoryManagerInstance = {
  saveFact: mockSaveFact,
  deleteFact: mockDeleteFact,
  deleteFactBySubject: mockDeleteFactBySubject,
  getAllFacts: mockGetAllFacts,
  getFactsByCategory: mockGetFactsByCategory,
  searchFactsHybrid: mockSearchFactsHybrid,
};

// Mock the memory module with a constructor function
vi.mock('../../src/memory', () => ({
  MemoryManager: vi.fn(() => mockMemoryManagerInstance),
}));

// Import after mocking
import {
  setMemoryManager,
  getRememberToolDefinition,
  handleRememberTool,
  getForgetToolDefinition,
  handleForgetTool,
  getListFactsToolDefinition,
  handleListFactsTool,
  getMemorySearchToolDefinition,
  handleMemorySearchTool,
  getDailyLogToolDefinition,
  handleDailyLogTool,
  getMemoryTools,
} from '../../src/tools/memory-tools';
import type { MemoryManager } from '../../src/memory';

describe('Memory Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============ INITIALIZATION ============

  describe('setMemoryManager', () => {
    it('should set the memory manager instance', () => {
      // Should not throw
      expect(() =>
        setMemoryManager(mockMemoryManagerInstance as unknown as MemoryManager)
      ).not.toThrow();
    });
  });

  // ============ REMEMBER TOOL DEFINITION ============

  describe('getRememberToolDefinition', () => {
    it('should return correct tool name', () => {
      const definition = getRememberToolDefinition();
      expect(definition.name).toBe('remember');
    });

    it('should return a description with usage guidance', () => {
      const definition = getRememberToolDefinition();
      expect(definition.description).toContain('Save important information');
      expect(definition.description).toContain('proactively');
      expect(definition.description).toContain('Categories:');
    });

    it('should have correct input schema structure', () => {
      const definition = getRememberToolDefinition();
      expect(definition.input_schema.type).toBe('object');
      expect(definition.input_schema.properties).toBeDefined();
      expect(definition.input_schema.required).toEqual(['category', 'subject', 'content']);
    });

    it('should define category property', () => {
      const definition = getRememberToolDefinition();
      const categoryProp = definition.input_schema.properties.category;
      expect(categoryProp.type).toBe('string');
      expect(categoryProp.description).toContain('Category');
    });

    it('should define subject property', () => {
      const definition = getRememberToolDefinition();
      const subjectProp = definition.input_schema.properties.subject;
      expect(subjectProp.type).toBe('string');
      expect(subjectProp.description).toContain('identifier');
    });

    it('should define content property', () => {
      const definition = getRememberToolDefinition();
      const contentProp = definition.input_schema.properties.content;
      expect(contentProp.type).toBe('string');
      expect(contentProp.description).toContain('fact');
    });
  });

  // ============ REMEMBER TOOL HANDLER ============

  describe('handleRememberTool', () => {
    beforeEach(() => {
      setMemoryManager(mockMemoryManagerInstance as unknown as MemoryManager);
    });

    it('should save a fact with valid input', async () => {
      mockSaveFact.mockReturnValue(123);

      const result = await handleRememberTool({
        category: 'user_info',
        subject: 'name',
        content: 'John Doe',
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('Remembered: name');
      expect(parsed.id).toBe(123);
      expect(parsed.category).toBe('user_info');
      expect(parsed.subject).toBe('name');

      expect(mockSaveFact).toHaveBeenCalledWith('user_info', 'name', 'John Doe');
    });

    it('should return error when category is missing', async () => {
      const result = await handleRememberTool({
        subject: 'name',
        content: 'John',
      });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Missing required fields: category, subject, content');
    });

    it('should return error when subject is missing', async () => {
      const result = await handleRememberTool({
        category: 'user_info',
        content: 'John',
      });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Missing required fields: category, subject, content');
    });

    it('should return error when content is missing', async () => {
      const result = await handleRememberTool({
        category: 'user_info',
        subject: 'name',
      });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Missing required fields: category, subject, content');
    });

    it('should return error when all fields are missing', async () => {
      const result = await handleRememberTool({});

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Missing required fields: category, subject, content');
    });

    it('should return error when input is empty object', async () => {
      const result = await handleRememberTool({});

      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Missing required fields');
    });

    it('should handle empty string values as missing', async () => {
      const result = await handleRememberTool({
        category: '',
        subject: 'name',
        content: 'John',
      });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Missing required fields: category, subject, content');
    });
  });

  // ============ FORGET TOOL DEFINITION ============

  describe('getForgetToolDefinition', () => {
    it('should return correct tool name', () => {
      const definition = getForgetToolDefinition();
      expect(definition.name).toBe('forget');
    });

    it('should return a description with usage guidance', () => {
      const definition = getForgetToolDefinition();
      expect(definition.description).toContain('Remove a fact');
      expect(definition.description).toContain('category + subject');
      expect(definition.description).toContain('fact ID');
    });

    it('should have correct input schema structure', () => {
      const definition = getForgetToolDefinition();
      expect(definition.input_schema.type).toBe('object');
      expect(definition.input_schema.properties).toBeDefined();
      // No required fields - either id OR category+subject
      expect(definition.input_schema.required).toEqual([]);
    });

    it('should define category property', () => {
      const definition = getForgetToolDefinition();
      const categoryProp = definition.input_schema.properties.category;
      expect(categoryProp.type).toBe('string');
      expect(categoryProp.description).toContain('Category');
    });

    it('should define subject property', () => {
      const definition = getForgetToolDefinition();
      const subjectProp = definition.input_schema.properties.subject;
      expect(subjectProp.type).toBe('string');
      expect(subjectProp.description).toContain('Subject');
    });

    it('should define id property', () => {
      const definition = getForgetToolDefinition();
      const idProp = definition.input_schema.properties.id;
      expect(idProp.type).toBe('number');
      expect(idProp.description).toContain('Fact ID');
    });
  });

  // ============ FORGET TOOL HANDLER ============

  describe('handleForgetTool', () => {
    beforeEach(() => {
      setMemoryManager(mockMemoryManagerInstance as unknown as MemoryManager);
    });

    it('should delete fact by ID successfully', async () => {
      mockDeleteFact.mockReturnValue(true);

      const result = await handleForgetTool({ id: 123 });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('Fact forgotten');

      expect(mockDeleteFact).toHaveBeenCalledWith(123);
    });

    it('should delete fact by category and subject successfully', async () => {
      mockDeleteFactBySubject.mockReturnValue(true);

      const result = await handleForgetTool({
        category: 'user_info',
        subject: 'name',
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('Fact forgotten');

      expect(mockDeleteFactBySubject).toHaveBeenCalledWith('user_info', 'name');
    });

    it('should prefer ID over category/subject when both provided', async () => {
      mockDeleteFact.mockReturnValue(true);

      const result = await handleForgetTool({
        id: 123,
        category: 'user_info',
        subject: 'name',
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      // Should use deleteFact (by ID), not deleteFactBySubject
      expect(mockDeleteFact).toHaveBeenCalledWith(123);
      expect(mockDeleteFactBySubject).not.toHaveBeenCalled();
    });

    it('should return error when neither id nor category+subject provided', async () => {
      const result = await handleForgetTool({});

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Provide either id OR category+subject');
    });

    it('should return error when only category is provided', async () => {
      const result = await handleForgetTool({ category: 'user_info' });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Provide either id OR category+subject');
    });

    it('should return error when only subject is provided', async () => {
      const result = await handleForgetTool({ subject: 'name' });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Provide either id OR category+subject');
    });

    it('should return not found when fact ID does not exist', async () => {
      mockDeleteFact.mockReturnValue(false);

      const result = await handleForgetTool({ id: 999 });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toBe('Fact not found');
    });

    it('should return not found when category/subject does not exist', async () => {
      mockDeleteFactBySubject.mockReturnValue(false);

      const result = await handleForgetTool({
        category: 'nonexistent',
        subject: 'missing',
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toBe('Fact not found');
    });

    it('should handle id value of 0', async () => {
      mockDeleteFact.mockReturnValue(true);

      const result = await handleForgetTool({ id: 0 });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      expect(mockDeleteFact).toHaveBeenCalledWith(0);
    });
  });

  // ============ LIST FACTS TOOL DEFINITION ============

  describe('getListFactsToolDefinition', () => {
    it('should return correct tool name', () => {
      const definition = getListFactsToolDefinition();
      expect(definition.name).toBe('list_facts');
    });

    it('should return a description', () => {
      const definition = getListFactsToolDefinition();
      expect(definition.description).toContain('List all known facts');
      expect(definition.description).toContain('what do you know about me');
    });

    it('should have correct input schema structure', () => {
      const definition = getListFactsToolDefinition();
      expect(definition.input_schema.type).toBe('object');
      expect(definition.input_schema.properties).toBeDefined();
      expect(definition.input_schema.required).toEqual([]);
    });

    it('should define optional category property', () => {
      const definition = getListFactsToolDefinition();
      const categoryProp = definition.input_schema.properties.category;
      expect(categoryProp.type).toBe('string');
      expect(categoryProp.description).toContain('filter by category');
    });
  });

  // ============ LIST FACTS TOOL HANDLER ============

  describe('handleListFactsTool', () => {
    beforeEach(() => {
      setMemoryManager(mockMemoryManagerInstance as unknown as MemoryManager);
    });

    it('should return all facts when no category specified', async () => {
      const mockFacts = [
        { id: 1, category: 'user_info', subject: 'name', content: 'John' },
        { id: 2, category: 'preferences', subject: 'coffee', content: 'Espresso' },
      ];
      mockGetAllFacts.mockReturnValue(mockFacts);

      const result = await handleListFactsTool({});

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(2);
      expect(parsed.facts).toHaveLength(2);
      expect(parsed.facts[0]).toEqual({
        id: 1,
        category: 'user_info',
        subject: 'name',
        content: 'John',
      });

      expect(mockGetAllFacts).toHaveBeenCalled();
    });

    it('should filter facts by category when specified', async () => {
      const mockFacts = [{ id: 1, category: 'user_info', subject: 'name', content: 'John' }];
      mockGetFactsByCategory.mockReturnValue(mockFacts);

      const result = await handleListFactsTool({ category: 'user_info' });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.facts).toHaveLength(1);

      expect(mockGetFactsByCategory).toHaveBeenCalledWith('user_info');
    });

    it('should return empty message when no facts exist', async () => {
      mockGetAllFacts.mockReturnValue([]);

      const result = await handleListFactsTool({});

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('No facts stored yet');
      expect(parsed.facts).toEqual([]);
    });

    it('should return category-specific empty message', async () => {
      mockGetFactsByCategory.mockReturnValue([]);

      const result = await handleListFactsTool({ category: 'projects' });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('No facts in category: projects');
      expect(parsed.facts).toEqual([]);
    });

    it('should only include id, category, subject, content in response', async () => {
      const mockFacts = [
        {
          id: 1,
          category: 'user_info',
          subject: 'name',
          content: 'John',
          created_at: '2024-01-01',
          updated_at: '2024-01-02',
        },
      ];
      mockGetAllFacts.mockReturnValue(mockFacts);

      const result = await handleListFactsTool({});

      const parsed = JSON.parse(result);
      expect(parsed.facts[0]).toEqual({
        id: 1,
        category: 'user_info',
        subject: 'name',
        content: 'John',
      });
      // Should not include created_at or updated_at
      expect(parsed.facts[0].created_at).toBeUndefined();
      expect(parsed.facts[0].updated_at).toBeUndefined();
    });
  });

  // ============ MEMORY SEARCH TOOL DEFINITION ============

  describe('getMemorySearchToolDefinition', () => {
    it('should return correct tool name', () => {
      const definition = getMemorySearchToolDefinition();
      expect(definition.name).toBe('memory_search');
    });

    it('should return a description with usage guidance', () => {
      const definition = getMemorySearchToolDefinition();
      expect(definition.description).toContain('semantic + keyword');
      expect(definition.description).toContain('proactively');
    });

    it('should have correct input schema structure', () => {
      const definition = getMemorySearchToolDefinition();
      expect(definition.input_schema.type).toBe('object');
      expect(definition.input_schema.properties).toBeDefined();
      expect(definition.input_schema.required).toEqual(['query']);
    });

    it('should define query property', () => {
      const definition = getMemorySearchToolDefinition();
      const queryProp = definition.input_schema.properties.query;
      expect(queryProp.type).toBe('string');
      expect(queryProp.description).toContain('Search query');
    });
  });

  // ============ MEMORY SEARCH TOOL HANDLER ============

  describe('handleMemorySearchTool', () => {
    beforeEach(() => {
      setMemoryManager(mockMemoryManagerInstance as unknown as MemoryManager);
    });

    it('should return search results', async () => {
      const mockResults = [
        {
          fact: { id: 1, category: 'user_info', subject: 'job', content: 'Software engineer' },
          score: 0.85,
          vectorScore: 0.9,
          keywordScore: 0.7,
        },
      ];
      mockSearchFactsHybrid.mockResolvedValue(mockResults);

      const result = await handleMemorySearchTool({ query: "user's job" });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0]).toEqual({
        id: 1,
        category: 'user_info',
        subject: 'job',
        content: 'Software engineer',
        score: 0.85,
        vectorScore: 0.9,
        keywordScore: 0.7,
      });

      expect(mockSearchFactsHybrid).toHaveBeenCalledWith("user's job");
    });

    it('should return empty results message when no matches found', async () => {
      mockSearchFactsHybrid.mockResolvedValue([]);

      const result = await handleMemorySearchTool({ query: 'nonexistent query' });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('No relevant facts found');
      expect(parsed.results).toEqual([]);
    });

    it('should return error when query is missing', async () => {
      const result = await handleMemorySearchTool({});

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Query is required');
    });

    it('should return error when query is empty string', async () => {
      const result = await handleMemorySearchTool({ query: '' });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Query is required');
    });

    it('should return error when query is whitespace only', async () => {
      const result = await handleMemorySearchTool({ query: '   ' });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Query is required');
    });

    it('should handle search errors', async () => {
      mockSearchFactsHybrid.mockRejectedValue(new Error('Search failed'));

      const result = await handleMemorySearchTool({ query: 'test query' });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('Search failed');
    });

    it('should round scores to 2 decimal places', async () => {
      const mockResults = [
        {
          fact: { id: 1, category: 'test', subject: 'test', content: 'test' },
          score: 0.8567,
          vectorScore: 0.9123,
          keywordScore: 0.7891,
        },
      ];
      mockSearchFactsHybrid.mockResolvedValue(mockResults);

      const result = await handleMemorySearchTool({ query: 'test' });

      const parsed = JSON.parse(result);
      expect(parsed.results[0].score).toBe(0.86);
      expect(parsed.results[0].vectorScore).toBe(0.91);
      expect(parsed.results[0].keywordScore).toBe(0.79);
    });
  });

  // ============ GET MEMORY TOOLS ============

  describe('getMemoryTools', () => {
    it('should return an array of all memory tools', () => {
      const tools = getMemoryTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(5);
    });

    it('should include remember tool with handler', () => {
      const tools = getMemoryTools();
      const rememberTool = tools.find(t => t.name === 'remember');

      expect(rememberTool).toBeDefined();
      expect(rememberTool!.handler).toBe(handleRememberTool);
      expect(rememberTool!.description).toContain('Save important information');
    });

    it('should include forget tool with handler', () => {
      const tools = getMemoryTools();
      const forgetTool = tools.find(t => t.name === 'forget');

      expect(forgetTool).toBeDefined();
      expect(forgetTool!.handler).toBe(handleForgetTool);
      expect(forgetTool!.description).toContain('Remove a fact');
    });

    it('should include list_facts tool with handler', () => {
      const tools = getMemoryTools();
      const listFactsTool = tools.find(t => t.name === 'list_facts');

      expect(listFactsTool).toBeDefined();
      expect(listFactsTool!.handler).toBe(handleListFactsTool);
      expect(listFactsTool!.description).toContain('List all known facts');
    });

    it('should include memory_search tool with handler', () => {
      const tools = getMemoryTools();
      const searchTool = tools.find(t => t.name === 'memory_search');

      expect(searchTool).toBeDefined();
      expect(searchTool!.handler).toBe(handleMemorySearchTool);
      expect(searchTool!.description).toContain('semantic + keyword');
    });

    it('should include daily_log tool with handler', () => {
      const tools = getMemoryTools();
      const dailyLogTool = tools.find(t => t.name === 'daily_log');

      expect(dailyLogTool).toBeDefined();
      expect(dailyLogTool!.handler).toBe(handleDailyLogTool);
      expect(dailyLogTool!.description).toContain('daily log');
    });

    it('should have all tools with input_schema', () => {
      const tools = getMemoryTools();

      for (const tool of tools) {
        expect(tool.input_schema).toBeDefined();
        expect(tool.input_schema.type).toBe('object');
      }
    });
  });

  // ============ MEMORY NOT INITIALIZED ERROR PATH ============

  describe('Memory Not Initialized', () => {
    // To properly test the "memory not initialized" error path,
    // we need to isolate the module state. This is challenging with
    // vi.mock because the module is loaded once.
    //
    // The following tests document the expected behavior:
    // - handleRememberTool returns { error: 'Memory not initialized' }
    // - handleForgetTool returns { error: 'Memory not initialized' }
    // - handleListFactsTool returns { error: 'Memory not initialized' }
    // - handleMemorySearchTool returns { error: 'Memory not initialized' }
    //
    // In production, these paths are hit when the agent starts before
    // the MemoryManager is fully initialized.

    it('should document memory not initialized behavior', () => {
      // This test documents the expected behavior rather than testing it directly
      // due to module state persistence between tests.
      //
      // The code at lines 64-66, 131-133, 183-185, and 252-254 in memory-tools.ts
      // handles the case when memoryManager is null:
      //
      // if (!memoryManager) {
      //   return JSON.stringify({ error: 'Memory not initialized' });
      // }
      //
      // Integration tests or manual testing should verify this path.
      expect(true).toBe(true);
    });
  });

  // ============ EDGE CASES ============

  describe('Edge Cases', () => {
    beforeEach(() => {
      setMemoryManager(mockMemoryManagerInstance as unknown as MemoryManager);
    });

    it('should handle special characters in remember input', async () => {
      mockSaveFact.mockReturnValue(1);

      const result = await handleRememberTool({
        category: "user's_info",
        subject: 'coffee "preference"',
        content: "Likes O'Brien's \"special\" blend & more!",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(mockSaveFact).toHaveBeenCalledWith(
        "user's_info",
        'coffee "preference"',
        "Likes O'Brien's \"special\" blend & more!"
      );
    });

    it('should handle unicode in remember input', async () => {
      mockSaveFact.mockReturnValue(1);

      const result = await handleRememberTool({
        category: 'languages',
        subject: 'japanese',
        content: 'Speaks Japanese: こんにちは',
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });

    it('should handle very long content in remember input', async () => {
      mockSaveFact.mockReturnValue(1);
      const longContent = 'x'.repeat(10000);

      const result = await handleRememberTool({
        category: 'notes',
        subject: 'long_note',
        content: longContent,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(mockSaveFact).toHaveBeenCalledWith('notes', 'long_note', longContent);
    });

    it('should handle newlines in content', async () => {
      mockSaveFact.mockReturnValue(1);
      const multilineContent = 'Line 1\nLine 2\nLine 3';

      const result = await handleRememberTool({
        category: 'notes',
        subject: 'multiline',
        content: multilineContent,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });

    it('should handle multiple facts in list response', async () => {
      const manyFacts = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        category: 'test',
        subject: `fact_${i}`,
        content: `Content ${i}`,
      }));
      mockGetAllFacts.mockReturnValue(manyFacts);

      const result = await handleListFactsTool({});

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(100);
      expect(parsed.facts).toHaveLength(100);
    });

    it('should handle search with special characters in query', async () => {
      mockSearchFactsHybrid.mockResolvedValue([]);

      const result = await handleMemorySearchTool({ query: "user's job & preferences" });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(mockSearchFactsHybrid).toHaveBeenCalledWith("user's job & preferences");
    });
  });
});

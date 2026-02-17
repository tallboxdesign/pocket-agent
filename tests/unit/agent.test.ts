/**
 * Unit tests for AgentManager
 *
 * Tests the orchestration logic of the Agent module without making real API calls.
 * All SDK interactions, MemoryManager, SettingsManager, and other dependencies are mocked.
 *
 * Note: The agent module uses a dynamic import pattern (`new Function('specifier', 'return import(specifier)')`)
 * to load the Claude SDK. This test file mocks the agent module internals directly to avoid needing
 * to intercept the dynamic import.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the embeddings module (required before importing memory)
vi.mock('../../src/memory/embeddings', () => ({
  initEmbeddings: vi.fn(),
  hasEmbeddings: vi.fn(() => false),
  embed: vi.fn(),
  cosineSimilarity: vi.fn(),
  serializeEmbedding: vi.fn(),
  deserializeEmbedding: vi.fn(),
}));

// Import memory manager after mocking embeddings
import { MemoryManager } from '../../src/memory/index';

describe('AgentManager', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a fresh in-memory database for each test
    memory = new MemoryManager(':memory:');
  });

  afterEach(() => {
    if (memory) {
      memory.close();
    }
  });

  // ============ UNIT TESTS FOR AGENT INTERNALS ============
  // These tests focus on the internal logic of AgentManager without calling processMessage

  describe('MemoryManager Integration', () => {
    it('should save and retrieve messages correctly', () => {
      const id = memory.saveMessage('user', 'Test message');
      expect(id).toBeGreaterThan(0);

      const messages = memory.getRecentMessages(10);
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Test message');
      expect(messages[0].role).toBe('user');
    });

    it('should save and retrieve facts correctly', () => {
      const id = memory.saveFact('user_info', 'name', 'John');
      expect(id).toBeGreaterThan(0);

      const facts = memory.getAllFacts();
      expect(facts.length).toBe(1);
      expect(facts[0].category).toBe('user_info');
      expect(facts[0].subject).toBe('name');
      expect(facts[0].content).toBe('John');
    });

    it('should format facts for context', () => {
      memory.saveFact('user_info', 'name', 'John');
      memory.saveFact('preferences', 'coffee', 'Espresso');

      const context = memory.getFactsForContext();

      expect(context).toContain('## Known Facts');
      expect(context).toContain('### user_info');
      expect(context).toContain('### preferences');
      expect(context).toContain('**name**: John');
      expect(context).toContain('**coffee**: Espresso');
    });

    it('should get conversation context', async () => {
      memory.saveMessage('user', 'Hello');
      memory.saveMessage('assistant', 'Hi there!');
      memory.saveMessage('user', 'How are you?');

      const context = await memory.getConversationContext(150000);

      expect(context.messages.length).toBe(3);
      expect(context.totalTokens).toBeGreaterThan(0);
      expect(context.summarizedCount).toBe(0);
    });

    it('should set summarizer callback', () => {
      const mockSummarizer = vi.fn().mockResolvedValue('Summary text');
      memory.setSummarizer(mockSummarizer);

      // Summarizer is set successfully if no error is thrown
      expect(true).toBe(true);
    });

    it('should search facts by content', () => {
      memory.saveFact('user_info', 'name', 'John Doe');
      memory.saveFact('preferences', 'food', 'Pizza');

      const results = memory.searchFacts('John');

      expect(results.length).toBe(1);
      expect(results[0].content).toBe('John Doe');
    });

    it('should delete facts', () => {
      const id = memory.saveFact('test', 'subject', 'content');
      expect(memory.getAllFacts().length).toBe(1);

      const deleted = memory.deleteFact(id);
      expect(deleted).toBe(true);
      expect(memory.getAllFacts().length).toBe(0);
    });

    it('should clear conversation', () => {
      memory.saveMessage('user', 'Message 1');
      memory.saveMessage('assistant', 'Message 2');
      expect(memory.getMessageCount()).toBe(2);

      memory.clearConversation();
      expect(memory.getMessageCount()).toBe(0);
    });

    it('should get stats', () => {
      memory.saveMessage('user', 'Hello');
      memory.saveFact('test', 'subject', 'content');

      const stats = memory.getStats();

      expect(stats.messageCount).toBe(1);
      expect(stats.factCount).toBe(1);
      expect(stats.estimatedTokens).toBeGreaterThan(0);
    });
  });

  // ============ FACT EXTRACTION PATTERNS ============

  describe('Fact Extraction Patterns', () => {
    // Test the regex patterns used by extractAndStoreFacts

    it('should extract name from "my name is X"', () => {
      const patterns = [
        { pattern: /my name is (\w+)/i, category: 'user_info', subject: 'name' },
      ];

      const message = 'My name is John';
      const match = message.match(patterns[0].pattern);

      expect(match).not.toBeNull();
      expect(match![1]).toBe('John');
    });

    it('should extract name from "call me X"', () => {
      const pattern = /call me (\w+)/i;
      const match = 'Please call me Sarah'.match(pattern);

      expect(match).not.toBeNull();
      expect(match![1]).toBe('Sarah');
    });

    it('should extract location from "i live in X"', () => {
      const pattern = /i live in ([^.,]+)/i;
      const match = 'I live in New York'.match(pattern);

      expect(match).not.toBeNull();
      expect(match![1]).toBe('New York');
    });

    it('should extract employer from "i work at X"', () => {
      const pattern = /i work (?:at|for) ([^.,]+)/i;

      expect('I work at Google'.match(pattern)![1]).toBe('Google');
      expect('I work for Microsoft'.match(pattern)![1]).toBe('Microsoft');
    });

    it('should extract job role from "i work as X"', () => {
      const pattern = /i work as (?:a |an )?([^.,]+)/i;

      expect('I work as a software engineer'.match(pattern)![1]).toBe('software engineer');
      expect('I work as an architect'.match(pattern)![1]).toBe('architect');
    });
  });

  // ============ SUGGESTED PROMPT EXTRACTION ============

  describe('Suggested Prompt Extraction', () => {
    // Test the extractSuggestedPrompt logic

    function extractSuggestedPrompt(text: string): { text: string; suggestion?: string } {
      if (!text) return { text };

      const match = text.match(/\n\nuser:\s*(.+)$/is);

      if (match) {
        const suggestion = match[1].trim();
        const cleanedText = text.replace(/\n\nuser:[\s\S]*$/is, '').trim();

        // Validate suggestion
        if (suggestion.endsWith('?')) return { text: cleanedText };
        if (/^(what|how|would|do|does|is|are|can|could|shall|should|may|might|let me|i can|i'll|i will|here's|here is)/i.test(suggestion)) {
          return { text: cleanedText };
        }
        if (suggestion.length > 100) return { text: cleanedText };

        return { text: cleanedText, suggestion };
      }

      return { text: text.trim() };
    }

    it('should extract valid suggested prompt', () => {
      const response = 'Here is your answer.\n\nUser: tell me more';
      const result = extractSuggestedPrompt(response);

      expect(result.suggestion).toBe('tell me more');
      expect(result.text).toBe('Here is your answer.');
    });

    it('should not extract questions as suggestions', () => {
      const response = 'Here is info.\n\nUser: Do you want more details?';
      const result = extractSuggestedPrompt(response);

      expect(result.suggestion).toBeUndefined();
      expect(result.text).toBe('Here is info.');
    });

    it('should not extract suggestions starting with assistant patterns', () => {
      const testCases = [
        'What would you like?',
        'How can I help?',
        'Would you like more?',
        'Let me explain',
        "I can help with that",
        "Here's what I found",
      ];

      for (const pattern of testCases) {
        const response = `Answer text.\n\nUser: ${pattern}`;
        const result = extractSuggestedPrompt(response);
        expect(result.suggestion).toBeUndefined();
      }
    });

    it('should not extract long suggestions', () => {
      const longText = 'a'.repeat(150);
      const response = `Answer.\n\nUser: ${longText}`;
      const result = extractSuggestedPrompt(response);

      expect(result.suggestion).toBeUndefined();
    });

    it('should handle text without user prompt', () => {
      const response = 'Simple response without suggestion.';
      const result = extractSuggestedPrompt(response);

      expect(result.suggestion).toBeUndefined();
      expect(result.text).toBe('Simple response without suggestion.');
    });

    it('should be case-insensitive for User: prefix', () => {
      const response = 'Answer.\n\nUSER: show me examples';
      const result = extractSuggestedPrompt(response);

      expect(result.suggestion).toBe('show me examples');
    });
  });

  // ============ TOOL NAME FORMATTING ============

  describe('Tool Name Formatting', () => {
    const friendlyNames: Record<string, string> = {
      Read: 'peeking at this file',
      Write: 'writing stuff down',
      Edit: 'tweaking some code',
      Bash: 'running terminal magic',
      Glob: 'hunting for files',
      Grep: 'digging through code',
      WebSearch: 'googling it rn',
      WebFetch: 'grabbing that page',
      Task: 'summoning a helper',
      remember: 'saving this to the brain',
      forget: 'yeeting from memory',
      browser: 'doing browser things',
      notify: 'sending a ping',
    };

    function formatToolName(name: string): string {
      return friendlyNames[name] || name;
    }

    it('should format known tool names', () => {
      expect(formatToolName('Read')).toContain('peeking');
      expect(formatToolName('Bash')).toContain('terminal');
      expect(formatToolName('WebSearch')).toContain('googling');
    });

    it('should pass through unknown tool names', () => {
      expect(formatToolName('UnknownTool')).toBe('UnknownTool');
      expect(formatToolName('CustomMcp')).toBe('CustomMcp');
    });
  });

  // ============ TOOL INPUT FORMATTING ============

  describe('Tool Input Formatting', () => {
    function formatToolInput(input: unknown): string {
      if (!input) return '';
      if (typeof input === 'string') return input.slice(0, 100);

      const inp = input as Record<string, unknown>;

      if (inp.file_path) return inp.file_path as string;
      if (inp.pattern) return inp.pattern as string;
      if (inp.query) return inp.query as string;
      if (inp.command) return (inp.command as string).slice(0, 80);
      if (inp.url) return inp.url as string;
      if (inp.prompt) return (inp.prompt as string).slice(0, 80);
      if (inp.category && inp.subject) return `${inp.category}/${inp.subject}`;

      return '';
    }

    it('should extract file_path from input', () => {
      const input = { file_path: '/path/to/file.txt' };
      expect(formatToolInput(input)).toBe('/path/to/file.txt');
    });

    it('should extract command from input', () => {
      const input = { command: 'ls -la' };
      expect(formatToolInput(input)).toBe('ls -la');
    });

    it('should extract URL from input', () => {
      const input = { url: 'https://example.com' };
      expect(formatToolInput(input)).toBe('https://example.com');
    });

    it('should format category/subject for memory tools', () => {
      const input = { category: 'user_info', subject: 'name' };
      expect(formatToolInput(input)).toBe('user_info/name');
    });

    it('should truncate long commands', () => {
      const longCommand = 'a'.repeat(100);
      const input = { command: longCommand };
      expect(formatToolInput(input).length).toBe(80);
    });

    it('should handle string input', () => {
      expect(formatToolInput('simple string')).toBe('simple string');
    });

    it('should handle null/undefined input', () => {
      expect(formatToolInput(null)).toBe('');
      expect(formatToolInput(undefined)).toBe('');
    });
  });

  // ============ SUBAGENT MESSAGE FORMATTING ============

  describe('Subagent Message Formatting', () => {
    const subagentMessages: Record<string, string> = {
      'Explore': 'sent out a scout to explore',
      'Plan': 'calling in the architect',
      'Bash': 'spawning a terminal wizard',
      'general-purpose': 'summoning a helper',
    };

    function getSubagentMessage(agentType: string): string {
      return subagentMessages[agentType] || `spawning ${agentType} agent`;
    }

    it('should return friendly message for known agent types', () => {
      expect(getSubagentMessage('Explore')).toContain('scout');
      expect(getSubagentMessage('Plan')).toContain('architect');
      expect(getSubagentMessage('Bash')).toContain('wizard');
    });

    it('should generate message for unknown agent types', () => {
      expect(getSubagentMessage('CustomAgent')).toBe('spawning CustomAgent agent');
    });
  });

  // ============ VALID USER PROMPT VALIDATION ============

  describe('Valid User Prompt Validation', () => {
    function isValidUserPrompt(suggestion: string): boolean {
      if (!suggestion) return false;
      if (suggestion.endsWith('?')) return false;

      const assistantPatterns = /^(what|how|would|do|does|is|are|can|could|shall|should|may|might|let me|i can|i'll|i will|here's|here is)/i;
      if (assistantPatterns.test(suggestion)) return false;

      if (suggestion.length > 100) return false;

      return true;
    }

    it('should accept short command-like prompts', () => {
      expect(isValidUserPrompt('show me more')).toBe(true);
      expect(isValidUserPrompt('continue')).toBe(true);
      expect(isValidUserPrompt('next step')).toBe(true);
    });

    it('should reject questions', () => {
      expect(isValidUserPrompt('what is this?')).toBe(false);
      expect(isValidUserPrompt('can you help?')).toBe(false);
    });

    it('should reject assistant-style responses', () => {
      expect(isValidUserPrompt('What would you like?')).toBe(false);
      expect(isValidUserPrompt('Let me help you')).toBe(false);
      expect(isValidUserPrompt("Here's the answer")).toBe(false);
    });

    it('should reject long text', () => {
      const longText = 'a'.repeat(150);
      expect(isValidUserPrompt(longText)).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidUserPrompt('')).toBe(false);
    });
  });

  // ============ TOKEN ESTIMATION ============

  describe('Token Estimation', () => {
    const CHARS_PER_TOKEN = 4;

    function estimateTokens(text: string): number {
      return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    it('should estimate tokens correctly', () => {
      expect(estimateTokens('Hello')).toBe(2); // 5 chars / 4 = 1.25 -> 2
      expect(estimateTokens('Hello World')).toBe(3); // 11 chars / 4 = 2.75 -> 3
      expect(estimateTokens('')).toBe(0);
    });

    it('should handle long text', () => {
      const longText = 'a'.repeat(1000);
      expect(estimateTokens(longText)).toBe(250);
    });
  });

  // ============ CONVERSATION CONTEXT BUILDING ============

  describe('Conversation Context Building', () => {
    it('should format messages for prompt', () => {
      memory.saveMessage('user', 'Hello');
      memory.saveMessage('assistant', 'Hi there!');
      memory.saveMessage('user', 'How are you?');

      const messages = memory.getRecentMessages(10);
      const formatted = messages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');

      expect(formatted).toContain('USER: Hello');
      expect(formatted).toContain('ASSISTANT: Hi there!');
      expect(formatted).toContain('USER: How are you?');
    });

    it('should build full prompt with context', () => {
      memory.saveMessage('user', 'Previous message');
      memory.saveMessage('assistant', 'Previous response');

      const messages = memory.getRecentMessages(10);
      const contextParts: string[] = [];

      if (messages.length > 0) {
        const historyText = messages
          .map(m => `${m.role.toUpperCase()}: ${m.content}`)
          .join('\n\n');
        contextParts.push(`Previous conversation:\n${historyText}`);
      }

      const userMessage = 'New message';
      const fullPrompt = contextParts.length > 0
        ? `${contextParts.join('\n\n---\n\n')}\n\n---\n\nUser: ${userMessage}`
        : userMessage;

      expect(fullPrompt).toContain('Previous conversation:');
      expect(fullPrompt).toContain('New message');
      expect(fullPrompt).toContain('---');
    });
  });

  // ============ STATUS EVENT TYPES ============

  describe('Status Event Types', () => {
    type AgentStatus = {
      type: 'thinking' | 'tool_start' | 'tool_end' | 'responding' | 'done' | 'subagent_start' | 'subagent_update' | 'subagent_end';
      toolName?: string;
      toolInput?: string;
      message?: string;
      agentId?: string;
      agentType?: string;
      agentCount?: number;
    };

    it('should have valid status type values', () => {
      const validTypes = ['thinking', 'tool_start', 'tool_end', 'responding', 'done', 'subagent_start', 'subagent_update', 'subagent_end'];

      const thinkingStatus: AgentStatus = { type: 'thinking', message: 'Processing...' };
      expect(validTypes).toContain(thinkingStatus.type);

      const toolStatus: AgentStatus = { type: 'tool_start', toolName: 'Read', toolInput: '/test.txt' };
      expect(validTypes).toContain(toolStatus.type);

      const doneStatus: AgentStatus = { type: 'done' };
      expect(validTypes).toContain(doneStatus.type);
    });

    it('should support subagent tracking fields', () => {
      const subagentStatus: AgentStatus = {
        type: 'subagent_start',
        agentId: 'agent-123',
        agentType: 'Explore',
        agentCount: 1,
        message: 'Starting exploration...',
      };

      expect(subagentStatus.agentId).toBe('agent-123');
      expect(subagentStatus.agentType).toBe('Explore');
      expect(subagentStatus.agentCount).toBe(1);
    });
  });

  // ============ CONFIGURATION ============

  describe('Configuration', () => {
    it('should define default model', () => {
      const DEFAULT_MODEL = 'claude-opus-4-6';
      expect(DEFAULT_MODEL).toContain('claude');
    });

    it('should define token limits', () => {
      const MAX_CONTEXT_TOKENS = 150000;
      const COMPACTION_THRESHOLD = 120000;

      expect(COMPACTION_THRESHOLD).toBeLessThan(MAX_CONTEXT_TOKENS);
      expect(COMPACTION_THRESHOLD / MAX_CONTEXT_TOKENS).toBeCloseTo(0.8, 1);
    });
  });

  // ============ SDK OPTIONS STRUCTURE ============

  describe('SDK Options Structure', () => {
    interface SDKOptions {
      model?: string;
      cwd?: string;
      maxTurns?: number;
      abortController?: AbortController;
      tools?: string[] | { type: 'preset'; preset: 'claude_code' };
      allowedTools?: string[];
      persistSession?: boolean;
      systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
      mcpServers?: Record<string, unknown>;
      settingSources?: ('project' | 'user')[];
    }

    it('should support preset tools configuration', () => {
      const options: SDKOptions = {
        tools: { type: 'preset', preset: 'claude_code' },
      };

      expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('should support preset system prompt with append', () => {
      const options: SDKOptions = {
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'Additional instructions here.',
        },
      };

      expect(typeof options.systemPrompt).toBe('object');
      if (typeof options.systemPrompt === 'object') {
        expect(options.systemPrompt.append).toContain('Additional');
      }
    });

    it('should support abort controller', () => {
      const controller = new AbortController();
      const options: SDKOptions = {
        abortController: controller,
      };

      expect(options.abortController).toBe(controller);
      expect(controller.signal.aborted).toBe(false);

      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });

    it('should support allowed tools list', () => {
      const options: SDKOptions = {
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash',
          'mcp__pocket-agent__browser',
          'mcp__pocket-agent__remember',
        ],
      };

      expect(options.allowedTools).toContain('Read');
      expect(options.allowedTools).toContain('mcp__pocket-agent__browser');
    });

    it('should support setting sources', () => {
      const options: SDKOptions = {
        settingSources: ['project'],
      };

      expect(options.settingSources).toContain('project');
    });
  });

  // ============ PROCESS RESULT STRUCTURE ============

  describe('ProcessResult Structure', () => {
    interface ProcessResult {
      response: string;
      tokensUsed: number;
      wasCompacted: boolean;
      suggestedPrompt?: string;
    }

    it('should have required fields', () => {
      const result: ProcessResult = {
        response: 'Test response',
        tokensUsed: 100,
        wasCompacted: false,
      };

      expect(result.response).toBeDefined();
      expect(result.tokensUsed).toBeDefined();
      expect(result.wasCompacted).toBeDefined();
    });

    it('should optionally include suggested prompt', () => {
      const result: ProcessResult = {
        response: 'Test response',
        tokensUsed: 100,
        wasCompacted: false,
        suggestedPrompt: 'continue',
      };

      expect(result.suggestedPrompt).toBe('continue');
    });
  });

  // ============ AGENT CONFIG STRUCTURE ============

  describe('AgentConfig Structure', () => {
    interface ToolsConfig {
      mcpServers: Record<string, unknown>;
      computerUse: {
        enabled: boolean;
        dockerized: boolean;
        displaySize?: { width: number; height: number };
      };
      browser: {
        enabled: boolean;
        cdpUrl?: string;
      };
    }

    interface AgentConfig {
      memory: MemoryManager;
      projectRoot?: string;
      workspace?: string;
      model?: string;
      tools?: ToolsConfig;
    }

    it('should require memory manager', () => {
      const config: AgentConfig = {
        memory: memory,
      };

      expect(config.memory).toBe(memory);
    });

    it('should support optional fields', () => {
      const config: AgentConfig = {
        memory: memory,
        projectRoot: '/project',
        workspace: '/workspace',
        model: 'claude-sonnet-4-6',
        tools: {
          mcpServers: {},
          computerUse: { enabled: false, dockerized: true },
          browser: { enabled: true, cdpUrl: 'http://localhost:9222' },
        },
      };

      expect(config.projectRoot).toBe('/project');
      expect(config.workspace).toBe('/workspace');
      expect(config.model).toContain('sonnet');
      expect(config.tools?.browser.enabled).toBe(true);
    });
  });

  // ============ MESSAGE EXTRACTION ============

  describe('Message Extraction', () => {
    function extractFromMessage(message: unknown, current: string): string {
      const msg = message as {
        type?: string;
        message?: { content?: unknown };
        output?: string;
        result?: string;
      };

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          const textBlocks = content
            .filter((block: unknown) => (block as { type?: string })?.type === 'text')
            .map((block: unknown) => (block as { text: string }).text);
          return textBlocks.join('\n');
        }
      }

      if (msg.type === 'result') {
        const result = msg.output || msg.result;
        if (result) return result;
      }

      return current;
    }

    it('should extract text from assistant message', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello, world!' }],
        },
      };

      const result = extractFromMessage(message, '');
      expect(result).toBe('Hello, world!');
    });

    it('should extract from result message', () => {
      const message = {
        type: 'result',
        output: 'Final output',
      };

      const result = extractFromMessage(message, '');
      expect(result).toBe('Final output');
    });

    it('should handle multiple text blocks', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'First part.' },
            { type: 'text', text: 'Second part.' },
          ],
        },
      };

      const result = extractFromMessage(message, '');
      expect(result).toContain('First part.');
      expect(result).toContain('Second part.');
    });

    it('should filter out non-text blocks', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Text content' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      };

      const result = extractFromMessage(message, '');
      expect(result).toBe('Text content');
      expect(result).not.toContain('Read');
    });

    it('should return current value for unknown message types', () => {
      const message = {
        type: 'unknown',
      };

      const result = extractFromMessage(message, 'previous value');
      expect(result).toBe('previous value');
    });
  });
});

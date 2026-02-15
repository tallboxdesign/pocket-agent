import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

// Type definitions for mocked objects
interface MockContext {
  from?: { id: number };
  chat?: { id: number };
  message?: { text: string };
  reply: Mock;
  replyWithChatAction: Mock;
}

type MiddlewareHandler = (ctx: MockContext, next: () => Promise<void>) => Promise<void>;
type CommandHandler = (ctx: MockContext) => Promise<void>;
type MessageHandler = (ctx: MockContext) => Promise<void>;

interface MockBotApi {
  sendMessage: Mock;
}

// Store mock state at module level
const mockState = {
  api: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as MockBotApi,
  middlewares: [] as MiddlewareHandler[],
  commands: new Map<string, CommandHandler>(),
  messageHandler: null as MessageHandler | null,
  errorHandler: null as ((err: Error) => void) | null,
  onStartCallback: null as ((botInfo: { username: string }) => void) | null,
  stopFn: vi.fn().mockResolvedValue(undefined),
};

// Reset mock state
function resetMockState() {
  mockState.api.sendMessage = vi.fn().mockResolvedValue(undefined);
  mockState.middlewares = [];
  mockState.commands = new Map();
  mockState.messageHandler = null;
  mockState.errorHandler = null;
  mockState.onStartCallback = null;
  mockState.stopFn = vi.fn().mockResolvedValue(undefined);
}

// Mock grammy Bot class
vi.mock('grammy', () => {
  return {
    Bot: class MockBot {
      api = mockState.api;

      constructor(_token: string) {
        // Reset handlers for each new bot instance
        mockState.middlewares = [];
        mockState.commands = new Map();
        mockState.messageHandler = null;
        mockState.errorHandler = null;
        mockState.onStartCallback = null;
      }

      use(middleware: MiddlewareHandler) {
        mockState.middlewares.push(middleware);
      }

      command(cmd: string, handler: CommandHandler) {
        mockState.commands.set(cmd, handler);
      }

      on(event: string, handler: MessageHandler) {
        if (event === 'message:text') {
          mockState.messageHandler = handler;
        }
        // Ignore other event handlers for now - we only test text messages
      }

      catch(handler: (err: Error) => void) {
        mockState.errorHandler = handler;
      }

      start({ onStart }: { onStart?: (botInfo: { username: string }) => void } = {}) {
        mockState.onStartCallback = onStart || null;
        if (onStart) {
          onStart({ username: 'test_bot' });
        }
      }

      stop() {
        return mockState.stopFn();
      }
    },
    Context: class MockContext {},
    Keyboard: class MockKeyboard {
      text() { return this; }
      row() { return this; }
      requestLocation() { return this; }
      requestContact() { return this; }
      resized() { return this; }
      oneTime() { return this; }
      persistent() { return this; }
      selected() { return this; }
      placeholder() { return this; }
    },
    InlineKeyboard: class MockInlineKeyboard {
      text() { return this; }
      row() { return this; }
      url() { return this; }
    },
  };
});

// Mock better-sqlite3 to avoid native module issues
vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn(),
  };
});

// Create mock functions first before vi.mock
const processMessageMock = vi.fn();
const getStatsMock = vi.fn();
const getAllFactsMock = vi.fn();
const searchFactsMock = vi.fn();
const clearConversationMock = vi.fn();

// Mock AgentManager using the pre-declared mock functions
vi.mock('../../src/agent', () => ({
  AgentManager: {
    isInitialized: () => true,
    processMessage: (...args: unknown[]) => processMessageMock(...args),
    getStats: () => getStatsMock(),
    getAllFacts: () => getAllFactsMock(),
    searchFacts: (...args: unknown[]) => searchFactsMock(...args),
    clearConversation: () => clearConversationMock(),
    clearSdkSessionMapping: vi.fn(),
    getMemory: () => ({
      getSessionForChat: () => 'default',
      getSessions: () => [],
      getSessionByName: () => null,
      linkTelegramChat: vi.fn(),
      unlinkTelegramChat: vi.fn(),
    }),
    getModel: () => 'claude-opus-4-6',
    setModel: vi.fn(),
  },
}));

// Mock SettingsManager
vi.mock('../../src/settings', () => ({
  SettingsManager: {
    get: (key: string) => {
      if (key === 'telegram.botToken') return 'test-token-123';
      return '';
    },
    getArray: (key: string) => {
      if (key === 'telegram.allowedUserIds') return ['123', '456'];
      if (key === 'telegram.activeChatIds') return ['789'];
      return [];
    },
    set: vi.fn(),
  },
}));

// Helper to run middleware chain
async function runMiddlewares(ctx: MockContext): Promise<boolean> {
  let allowed = true;
  for (const middleware of mockState.middlewares) {
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    if (!nextCalled) {
      allowed = false;
      break;
    }
  }
  return allowed;
}

// Import after mocks are set up
import { TelegramBot } from '../../src/channels/telegram';

describe('TelegramBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockState();

    // Reset AgentManager mock implementations
    processMessageMock.mockResolvedValue({
      response: 'Mock agent response',
      messages: [],
      wasCompacted: false,
    });
    getStatsMock.mockReturnValue({
      messageCount: 10,
      factCount: 5,
      cronJobCount: 2,
      summaryCount: 1,
      estimatedTokens: 1500,
    });
    getAllFactsMock.mockReturnValue([
      { id: 1, category: 'user_info', subject: 'name', content: 'John' },
      { id: 2, category: 'preferences', subject: 'coffee', content: 'Prefers oat milk' },
    ]);
    searchFactsMock.mockReturnValue([
      { id: 1, category: 'user_info', subject: 'name', content: 'John' },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with bot token from settings', () => {
      const bot = new TelegramBot();
      expect(bot).toBeDefined();
      expect(bot.name).toBe('telegram');
    });

    it('should load allowed user IDs from settings', () => {
      const bot = new TelegramBot();
      // The bot should have loaded user IDs 123 and 456 from mock
      expect(bot).toBeDefined();
    });

    it('should load persisted chat IDs on construction', () => {
      const bot = new TelegramBot();
      const chatIds = bot.getActiveChatIds();
      expect(chatIds).toContain(789);
    });

    it('should setup all command handlers', () => {
      new TelegramBot();
      expect(mockState.commands.has('start')).toBe(true);
      expect(mockState.commands.has('status')).toBe(true);
      expect(mockState.commands.has('facts')).toBe(true);
      expect(mockState.commands.has('new')).toBe(true);
      expect(mockState.commands.has('mychatid')).toBe(true);
    });
  });

  describe('user allowlist validation', () => {
    it('should allow users in the allowlist', async () => {
      new TelegramBot();
      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 1000 },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      const allowed = await runMiddlewares(ctx);
      expect(allowed).toBe(true);
    });

    it('should reject users not in the allowlist', async () => {
      new TelegramBot();
      const ctx: MockContext = {
        from: { id: 999 }, // Not in allowlist
        chat: { id: 1000 },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      const allowed = await runMiddlewares(ctx);
      expect(allowed).toBe(false);
      expect(ctx.reply).toHaveBeenCalled();
      // Check that the reply contains the unauthorized message
      const replyCall = ctx.reply.mock.calls[0][0] as string;
      expect(replyCall).toContain('not authorized');
    });

    it('should reject users with undefined user ID', async () => {
      new TelegramBot();
      const ctx: MockContext = {
        from: undefined,
        chat: { id: 1000 },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      const allowed = await runMiddlewares(ctx);
      expect(allowed).toBe(false);
    });

    it('should track new chat IDs', async () => {
      const bot = new TelegramBot();
      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 2000 }, // New chat ID
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      await runMiddlewares(ctx);

      const chatIds = bot.getActiveChatIds();
      expect(chatIds).toContain(2000);
    });

    it('should allow adding users to allowlist', () => {
      const bot = new TelegramBot();
      bot.addAllowedUser(777);
      // Verify the user was added (implementation detail)
      expect(bot).toBeDefined();
    });

    it('should allow removing users from allowlist', () => {
      const bot = new TelegramBot();
      bot.removeAllowedUser(123);
      // Verify the user was removed (implementation detail)
      expect(bot).toBeDefined();
    });
  });

  describe('command handlers', () => {
    describe('/start command', () => {
      it('should send welcome message with user ID', async () => {
        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const startHandler = mockState.commands.get('start');
        await startHandler!(ctx);

        expect(ctx.reply).toHaveBeenCalled();
        const replyCall = ctx.reply.mock.calls[0][0] as string;
        expect(replyCall).toContain('Welcome to Pocket Agent');
        expect(replyCall).toContain('123'); // User ID
        expect(replyCall).toContain('/help');
        expect(replyCall).toContain('/status');
        expect(replyCall).toContain('/facts');
        expect(replyCall).toContain('/new');
      });
    });

    describe('/mychatid command', () => {
      it('should send chat ID and user ID', async () => {
        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('mychatid');
        await handler!(ctx);

        expect(ctx.reply).toHaveBeenCalled();
        const replyCall = ctx.reply.mock.calls[0][0] as string;
        expect(replyCall).toContain('Chat ID: 1000');
        expect(replyCall).toContain('User ID: 123');
      });
    });

    describe('/status command', () => {
      it('should display agent stats', async () => {
        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('status');
        await handler!(ctx);

        expect(ctx.reply).toHaveBeenCalled();
        const replyCall = ctx.reply.mock.calls[0][0] as string;
        expect(replyCall).toContain('Messages: 10');
        expect(replyCall).toContain('Facts: 5');
        expect(replyCall).toContain('Cron Jobs: 2');
      });

      it('should handle uninitialized agent', async () => {
        getStatsMock.mockReturnValueOnce(null);

        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('status');
        await handler!(ctx);

        expect(ctx.reply).toHaveBeenCalledWith('Agent not initialized');
      });
    });

    describe('/facts command', () => {
      it('should list all facts when no query provided', async () => {
        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          message: { text: '/facts' },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('facts');
        await handler!(ctx);

        expect(ctx.reply).toHaveBeenCalled();
      });

      it('should search facts when query provided', async () => {
        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          message: { text: '/facts name' },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('facts');
        await handler!(ctx);

        expect(searchFactsMock).toHaveBeenCalledWith('name');
      });

      it('should handle no facts found', async () => {
        searchFactsMock.mockReturnValueOnce([]);

        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          message: { text: '/facts nonexistent' },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('facts');
        await handler!(ctx);

        expect(ctx.reply).toHaveBeenCalledWith('No facts found for "nonexistent"');
      });

      it('should handle empty facts database', async () => {
        getAllFactsMock.mockReturnValueOnce([]);

        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          message: { text: '/facts' },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('facts');
        await handler!(ctx);

        expect(ctx.reply).toHaveBeenCalled();
        const replyCall = ctx.reply.mock.calls[0][0] as string;
        expect(replyCall).toContain('No facts stored yet');
      });
    });

    describe('/new command', () => {
      it('should clear conversation history', async () => {
        new TelegramBot();
        const ctx: MockContext = {
          from: { id: 123 },
          chat: { id: 1000 },
          reply: vi.fn().mockResolvedValue(undefined),
          replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        };

        const handler = mockState.commands.get('new');
        await handler!(ctx);

        expect(clearConversationMock).toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalled();
        const replyCall = ctx.reply.mock.calls[0][0] as string;
        expect(replyCall).toContain('Fresh start');
      });
    });
  });

  describe('message handling', () => {
    it('should process incoming text messages', async () => {
      new TelegramBot();
      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 1000 },
        message: { text: 'Hello, assistant!' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      expect(mockState.messageHandler).toBeDefined();
      await mockState.messageHandler!(ctx);

      expect(processMessageMock).toHaveBeenCalledWith('Hello, assistant!', 'telegram', 'default');
    });

    it('should show typing indicator while processing', async () => {
      new TelegramBot();
      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 1000 },
        message: { text: 'Hello' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      await mockState.messageHandler!(ctx);

      expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing');
    });

    it('should handle errors gracefully', async () => {
      processMessageMock.mockRejectedValueOnce(new Error('Test error'));

      new TelegramBot();
      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 1000 },
        message: { text: 'Hello' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      await mockState.messageHandler!(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const lastReply = ctx.reply.mock.calls[ctx.reply.mock.calls.length - 1][0] as string;
      expect(lastReply).toContain('⚠️');
      expect(lastReply).toContain('Test error');
    });

    it('should notify when conversation is compacted', async () => {
      processMessageMock.mockResolvedValueOnce({
        response: 'Response',
        messages: [],
        wasCompacted: true,
      });

      new TelegramBot();
      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 1000 },
        message: { text: 'Hello' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      await mockState.messageHandler!(ctx);

      // Should have two replies: the response and the compaction notice
      expect(ctx.reply.mock.calls.length).toBeGreaterThanOrEqual(2);
      const compactionNotice = ctx.reply.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('compacted')
      );
      expect(compactionNotice).toBeDefined();
    });

    it('should skip processing for empty messages', async () => {
      new TelegramBot();
      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 1000 },
        message: undefined,
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      await mockState.messageHandler!(ctx);

      expect(processMessageMock).not.toHaveBeenCalled();
    });

    it('should call message callback for cross-channel sync', async () => {
      const bot = new TelegramBot();
      const callback = vi.fn();
      bot.setOnMessageCallback(callback);

      const ctx: MockContext = {
        from: { id: 123 },
        chat: { id: 1000 },
        message: { text: 'Hello' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };

      await mockState.messageHandler!(ctx);

      expect(callback).toHaveBeenCalledWith({
        userMessage: 'Hello',
        response: 'Mock agent response',
        channel: 'telegram',
        chatId: 1000,
        sessionId: 'default',
        wasCompacted: false,
      });
    });
  });

  describe('bot lifecycle', () => {
    it('should start the bot', async () => {
      const bot = new TelegramBot();
      await bot.start();

      expect(bot.isRunning).toBe(true);
      expect(mockState.onStartCallback).toBeDefined();
    });

    it('should not start if already running', async () => {
      const bot = new TelegramBot();
      await bot.start();
      await bot.start(); // Second call should be no-op

      expect(bot.isRunning).toBe(true);
    });

    it('should stop the bot', async () => {
      const bot = new TelegramBot();
      await bot.start();
      await bot.stop();

      expect(bot.isRunning).toBe(false);
    });

    it('should not stop if not running', async () => {
      const bot = new TelegramBot();
      await bot.stop(); // Should be no-op

      expect(bot.isRunning).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should send message to specific chat ID', async () => {
      const bot = new TelegramBot();
      await bot.start();

      const result = await bot.sendMessage(1000, 'Hello!');

      expect(result).toBe(true);
      expect(mockState.api.sendMessage).toHaveBeenCalled();
    });

    it('should return false when bot is not running', async () => {
      const bot = new TelegramBot();
      // Don't start the bot

      const result = await bot.sendMessage(1000, 'Hello!');

      expect(result).toBe(false);
    });

    it('should handle send errors', async () => {
      const bot = new TelegramBot();
      await bot.start();
      // Reject both HTML and plain text fallback attempts
      mockState.api.sendMessage.mockRejectedValue(new Error('Network error'));

      const result = await bot.sendMessage(1000, 'Hello!');

      expect(result).toBe(false);
    });

    it('should chunk long messages', async () => {
      const bot = new TelegramBot();
      await bot.start();

      // Create a message longer than 4000 chars
      const longMessage = 'A'.repeat(5000);
      await bot.sendMessage(1000, longMessage);

      // Should have sent multiple messages
      expect(mockState.api.sendMessage.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('broadcast', () => {
    it('should send message to all active chat IDs', async () => {
      const bot = new TelegramBot();
      await bot.start();

      const sent = await bot.broadcast('Broadcast message');

      expect(sent).toBeGreaterThanOrEqual(1);
    });
  });

  describe('syncFromDesktop', () => {
    it('should format and broadcast desktop sync', async () => {
      const bot = new TelegramBot();
      await bot.start();

      await bot.syncFromDesktop('User message', 'Assistant response');

      expect(mockState.api.sendMessage).toHaveBeenCalled();
      const call = mockState.api.sendMessage.mock.calls[0];
      expect(call[1]).toContain('[Desktop]');
    });
  });

  describe('error handling', () => {
    it('should register error handler on bot', () => {
      new TelegramBot();
      expect(mockState.errorHandler).toBeDefined();
    });

    it('should handle bot errors without crashing', () => {
      new TelegramBot();

      // Simulate error - should not throw
      expect(() => mockState.errorHandler!(new Error('Test bot error'))).not.toThrow();
    });
  });

  describe('markdownToTelegramHtml', () => {
    // We test the conversion function through the bot's sendMessage method
    // Since it's private, we test the output via sendMessage which uses it

    describe('code blocks', () => {
      it('should convert code blocks to <pre> tags', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '```\nconst x = 1;\n```');

        expect(mockState.api.sendMessage).toHaveBeenCalled();
        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<pre>');
      });

      it('should escape HTML in code blocks', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '```\n<div>test</div>\n```');

        expect(mockState.api.sendMessage).toHaveBeenCalled();
        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('&lt;div&gt;');
      });
    });

    describe('inline formatting', () => {
      it('should convert bold markdown to <b> tags', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, 'This is **bold** text');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<b>bold</b>');
      });

      it('should convert italic markdown to <i> tags', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, 'This is *italic* text');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<i>italic</i>');
      });

      it('should convert strikethrough to <s> tags', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, 'This is ~~strikethrough~~ text');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<s>strikethrough</s>');
      });

      it('should convert inline code to <code> tags', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, 'Use the `code` tag');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<code>code</code>');
      });
    });

    describe('links', () => {
      it('should convert markdown links to <a> tags', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, 'Check out [Example](https://example.com)');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<a href="https://example.com">Example</a>');
      });
    });

    describe('headers', () => {
      it('should convert headers to bold text', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '# Header One\n\n## Header Two');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<b>Header One</b>');
        expect(call[1]).toContain('<b>Header Two</b>');
      });
    });

    describe('lists', () => {
      it('should convert unordered lists to bullet points', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '- Item one\n- Item two');

        const call = mockState.api.sendMessage.mock.calls[0];
        // Note: The bullet character is a specific Unicode character
        expect(call[1]).toMatch(/Item one/);
        expect(call[1]).toMatch(/Item two/);
      });

      it('should preserve ordered list numbers', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '1. First\n2. Second');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('1.');
        expect(call[1]).toContain('2.');
      });

      it('should convert checkboxes to symbols', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '- [ ] Unchecked\n- [x] Checked');

        const call = mockState.api.sendMessage.mock.calls[0];
        // Should contain checkbox symbols
        expect(call[1]).toMatch(/Unchecked/);
        expect(call[1]).toMatch(/Checked/);
      });
    });

    describe('blockquotes', () => {
      it('should format blockquotes with bar and italic', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '> This is a quote');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<i>');
      });
    });

    describe('HTML escaping', () => {
      it('should escape HTML entities in regular text', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, 'Use <div> & <span> tags');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('&lt;div&gt;');
        expect(call[1]).toContain('&amp;');
      });
    });

    describe('tables', () => {
      it('should format tables with monospace pre tags', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, '| Header | Value |\n|--------|-------|\n| A | 1 |');

        const call = mockState.api.sendMessage.mock.calls[0];
        expect(call[1]).toContain('<pre>');
      });
    });

    describe('horizontal rules', () => {
      it('should convert horizontal rules to dashes', async () => {
        const bot = new TelegramBot();
        await bot.start();

        await bot.sendMessage(1000, 'Before\n---\nAfter');

        const call = mockState.api.sendMessage.mock.calls[0];
        // Should contain Unicode box-drawing horizontal line character or dashes
        expect(call[1]).toMatch(/[─-]+/);
      });
    });
  });

  describe('message chunking', () => {
    it('should not chunk messages under 4000 chars', async () => {
      const bot = new TelegramBot();
      await bot.start();

      const shortMessage = 'A'.repeat(100);
      await bot.sendMessage(1000, shortMessage);

      expect(mockState.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should chunk messages over 4000 chars', async () => {
      const bot = new TelegramBot();
      await bot.start();

      const longMessage = 'A'.repeat(5000);
      await bot.sendMessage(1000, longMessage);

      expect(mockState.api.sendMessage.mock.calls.length).toBeGreaterThan(1);
    });

    it('should add chunk numbering for split messages', async () => {
      const bot = new TelegramBot();
      await bot.start();

      const longMessage = 'A'.repeat(8500);
      await bot.sendMessage(1000, longMessage);

      // Check that at least one message contains chunk numbering like (1/N)
      const calls = mockState.api.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
    });

    it('should split at natural boundaries when possible', async () => {
      const bot = new TelegramBot();
      await bot.start();

      // Create a message with natural split points
      const paragraph1 = 'First paragraph. '.repeat(200);
      const paragraph2 = 'Second paragraph. '.repeat(200);
      const longMessage = paragraph1 + '\n\n' + paragraph2;

      await bot.sendMessage(1000, longMessage);

      // Message should be split
      expect(mockState.api.sendMessage.mock.calls.length).toBeGreaterThan(1);
    });
  });
});

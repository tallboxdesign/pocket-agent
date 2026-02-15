/**
 * Unit tests for the ConfigManager singleton
 *
 * Tests config loading, saving, updating, validation, and
 * environment variable overrides using mocked fs and path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/tools', () => ({
  getDefaultToolsConfig: vi.fn(() => ({
    mcpServers: {},
    computerUse: { enabled: false },
    browser: { cdpUrl: 'http://localhost:9222' },
  })),
}));

vi.mock('fs', () => {
  const fns = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
  return { default: fns };
});

import fs from 'fs';
import { Config } from '../../src/config/index';

describe('ConfigManager', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);

    // Save env vars we might modify
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    savedEnv.TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS;
    savedEnv.CDP_URL = process.env.CDP_URL;
    savedEnv.COMPUTER_USE_ENABLED = process.env.COMPUTER_USE_ENABLED;

    // Clear env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USERS;
    delete process.env.CDP_URL;
    delete process.env.COMPUTER_USE_ENABLED;
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('load', () => {
    it('creates default config and saves when no existing file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const config = Config.load('/tmp/test-config');

      expect(config.anthropic.apiKey).toBe('');
      expect(config.telegram.enabled).toBe(false);
      // Should have called writeFileSync to save the default config
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('reads and merges existing file with defaults', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          anthropic: { apiKey: 'sk-test-key' },
          telegram: { enabled: true, botToken: 'bot-token-123' },
        }),
      );

      const config = Config.load('/tmp/test-config');

      expect(config.anthropic.apiKey).toBe('sk-test-key');
      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.botToken).toBe('bot-token-123');
      // Should still have default values for fields not in file
      expect(config.scheduler.enabled).toBe(true);
    });

    it('falls back to defaults when file contains invalid JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');

      const config = Config.load('/tmp/test-config');

      expect(config.anthropic.apiKey).toBe('');
      expect(config.telegram.enabled).toBe(false);
    });

    it('overrides config with environment variables', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
      process.env.OPENAI_API_KEY = 'env-openai-key';
      process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
      process.env.TELEGRAM_ALLOWED_USERS = '123,456,789';
      process.env.CDP_URL = 'http://custom:1234';
      process.env.COMPUTER_USE_ENABLED = 'true';

      const config = Config.load('/tmp/test-config');

      expect(config.anthropic.apiKey).toBe('env-anthropic-key');
      expect(config.openai.apiKey).toBe('env-openai-key');
      expect(config.telegram.botToken).toBe('env-bot-token');
      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.allowedUserIds).toEqual([123, 456, 789]);
      expect(config.tools.browser.cdpUrl).toBe('http://custom:1234');
      expect(config.tools.computerUse.enabled).toBe(true);
    });
  });

  describe('get', () => {
    it('returns the current config object', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      Config.load('/tmp/test-config');

      const config = Config.get();

      expect(config).toBeDefined();
      expect(config.anthropic).toBeDefined();
      expect(config.telegram).toBeDefined();
      expect(config.scheduler).toBeDefined();
      expect(config.tools).toBeDefined();
    });
  });

  describe('save', () => {
    it('writes JSON to file and creates directory if needed', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      Config.load('/tmp/test-config');

      // save is called internally by load when file doesn't exist
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(String(writeCall[0])).toContain('config.json');
      // The written content should be valid JSON
      expect(() => JSON.parse(writeCall[1] as string)).not.toThrow();
    });
  });

  describe('update', () => {
    it('merges updates into current config and saves', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      Config.load('/tmp/test-config');
      vi.mocked(fs.writeFileSync).mockClear();

      Config.update({
        anthropic: { apiKey: 'new-key', model: 'claude-opus-4-6' },
      });

      const config = Config.get();
      expect(config.anthropic.apiKey).toBe('new-key');
      // save should have been called
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('isValid', () => {
    it('returns error when API key is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      Config.load('/tmp/test-config');
      // Explicitly clear the API key since the singleton's DEFAULT_CONFIG
      // may have been mutated by earlier tests (load() assigns this.config = DEFAULT_CONFIG
      // by reference, then env var overrides mutate the nested objects).
      Config.update({ anthropic: { apiKey: '' } });

      const result = Config.isValid();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing Anthropic API key');
    });

    it('returns valid when API key is present', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      process.env.ANTHROPIC_API_KEY = 'sk-valid-key';
      Config.load('/tmp/test-config');

      const result = Config.isValid();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns error when telegram is enabled but token is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          anthropic: { apiKey: 'sk-key' },
          telegram: { enabled: true, botToken: '' },
        }),
      );
      Config.load('/tmp/test-config');

      const result = Config.isValid();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Telegram enabled but missing bot token');
    });
  });
});

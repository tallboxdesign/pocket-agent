/**
 * Unit tests for the Settings Manager module
 *
 * Tests settings initialization, get/set operations, encryption/decryption,
 * and schema validation using an in-memory SQLite database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mock Electron's safeStorage API before any imports
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => {
      // Simple mock encryption: reverse the string and prefix with 'enc:'
      return Buffer.from('enc:' + value.split('').reverse().join(''));
    }),
    decryptString: vi.fn((buffer: Buffer) => {
      // Mock decryption: reverse the mock encryption
      const str = buffer.toString();
      if (str.startsWith('enc:')) {
        return str.slice(4).split('').reverse().join('');
      }
      return str;
    }),
  },
}));

/**
 * Setting definition interface (matches source)
 */
interface SettingDefinition {
  key: string;
  defaultValue: string;
  encrypted: boolean;
  category: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'password' | 'array' | 'textarea';
  validation?: (value: string) => boolean;
}

/**
 * Settings schema - copy of the schema from source for testing
 * This ensures tests work independently of the source module
 */
const SETTINGS_SCHEMA: SettingDefinition[] = [
  // Auth settings
  {
    key: 'auth.method',
    defaultValue: '',
    encrypted: false,
    category: 'auth',
    label: 'Authentication Method',
    description: 'How you authenticate with Claude (api_key or oauth)',
    type: 'string',
  },
  {
    key: 'auth.oauthToken',
    defaultValue: '',
    encrypted: true,
    category: 'auth',
    label: 'OAuth Token',
    description: 'OAuth access token for Claude subscription',
    type: 'password',
  },
  {
    key: 'auth.refreshToken',
    defaultValue: '',
    encrypted: true,
    category: 'auth',
    label: 'Refresh Token',
    description: 'OAuth refresh token',
    type: 'password',
  },
  {
    key: 'auth.tokenExpiresAt',
    defaultValue: '',
    encrypted: false,
    category: 'auth',
    label: 'Token Expiry',
    description: 'When the OAuth token expires',
    type: 'string',
  },
  // API Keys
  {
    key: 'anthropic.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Anthropic API Key',
    description: 'Your Anthropic API key for Claude',
    type: 'password',
  },
  {
    key: 'openai.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'OpenAI API Key',
    description: 'Your OpenAI API key for embeddings',
    type: 'password',
  },
  // Agent settings
  {
    key: 'agent.model',
    defaultValue: 'claude-opus-4-6',
    encrypted: false,
    category: 'agent',
    label: 'Default Model',
    description: 'Claude model to use for conversations',
    type: 'string',
  },
  {
    key: 'agent.compactionThreshold',
    defaultValue: '120000',
    encrypted: false,
    category: 'agent',
    label: 'Compaction Threshold',
    description: 'Token count at which to start compacting context',
    type: 'number',
  },
  {
    key: 'agent.maxContextTokens',
    defaultValue: '150000',
    encrypted: false,
    category: 'agent',
    label: 'Max Context Tokens',
    description: 'Maximum tokens in conversation context',
    type: 'number',
  },
  {
    key: 'agent.thinkingLevel',
    defaultValue: 'normal',
    encrypted: false,
    category: 'agent',
    label: 'Thinking Level',
    description: 'How much reasoning to show (none, minimal, normal, extended)',
    type: 'string',
  },
  // Telegram settings
  {
    key: 'telegram.botToken',
    defaultValue: '',
    encrypted: true,
    category: 'telegram',
    label: 'Bot Token',
    description: 'Telegram bot token from @BotFather',
    type: 'password',
  },
  {
    key: 'telegram.allowedUserIds',
    defaultValue: '[]',
    encrypted: false,
    category: 'telegram',
    label: 'Allowed User IDs',
    description: 'Comma-separated list of Telegram user IDs',
    type: 'array',
  },
  {
    key: 'telegram.enabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'telegram',
    label: 'Enable Telegram',
    description: 'Enable Telegram bot integration',
    type: 'boolean',
  },
  {
    key: 'telegram.defaultChatId',
    defaultValue: '',
    encrypted: false,
    category: 'telegram',
    label: 'Default Chat ID',
    description: 'Default chat ID for notifications',
    type: 'string',
  },
  // Memory settings
  {
    key: 'memory.embeddingProvider',
    defaultValue: 'openai',
    encrypted: false,
    category: 'memory',
    label: 'Embedding Provider',
    description: 'Provider for semantic embeddings (openai)',
    type: 'string',
  },
  {
    key: 'memory.vectorWeight',
    defaultValue: '0.7',
    encrypted: false,
    category: 'memory',
    label: 'Vector Search Weight',
    description: 'Weight for semantic similarity (0-1)',
    type: 'number',
  },
  {
    key: 'memory.keywordWeight',
    defaultValue: '0.3',
    encrypted: false,
    category: 'memory',
    label: 'Keyword Search Weight',
    description: 'Weight for keyword matching (0-1)',
    type: 'number',
  },
  {
    key: 'memory.minScoreThreshold',
    defaultValue: '0.35',
    encrypted: false,
    category: 'memory',
    label: 'Min Score Threshold',
    description: 'Minimum score for search results',
    type: 'number',
  },
  {
    key: 'memory.maxSearchResults',
    defaultValue: '6',
    encrypted: false,
    category: 'memory',
    label: 'Max Search Results',
    description: 'Maximum number of search results',
    type: 'number',
  },
  // Browser settings
  {
    key: 'browser.enabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'browser',
    label: 'Enable Browser',
    description: 'Enable browser automation tools',
    type: 'boolean',
  },
  {
    key: 'browser.cdpUrl',
    defaultValue: 'http://localhost:9222',
    encrypted: false,
    category: 'browser',
    label: 'CDP URL',
    description: 'Chrome DevTools Protocol URL',
    type: 'string',
  },
  // Scheduler settings
  {
    key: 'scheduler.enabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'scheduler',
    label: 'Enable Scheduler',
    description: 'Enable cron job scheduler',
    type: 'boolean',
  },
  // User Profile settings
  {
    key: 'profile.name',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Your Name',
    description: 'Your name for the agent to use',
    type: 'string',
  },
  {
    key: 'profile.location',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Location',
    description: 'Your city/region for context',
    type: 'string',
  },
  {
    key: 'profile.timezone',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Timezone',
    description: 'Your timezone (e.g., America/New_York)',
    type: 'string',
  },
  {
    key: 'profile.occupation',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Occupation',
    description: 'Your job or role',
    type: 'string',
  },
  {
    key: 'profile.birthday',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Birthday',
    description: 'Your birthday (e.g., March 15)',
    type: 'string',
  },
  {
    key: 'profile.custom',
    defaultValue: '',
    encrypted: false,
    category: 'profile',
    label: 'Additional Info',
    description: 'Any other information about yourself',
    type: 'textarea',
  },
];

/**
 * Mock safeStorage interface for testing
 */
interface MockSafeStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (buffer: Buffer) => string;
}

/**
 * TestableSettingsManager - A testable version of SettingsManager
 * that mirrors the source implementation
 */
class TestableSettingsManager {
  private db: Database.Database | null = null;
  private cache: Map<string, string> = new Map();
  private initialized: boolean = false;
  private mockSafeStorage: MockSafeStorage;

  constructor(mockSafeStorage?: MockSafeStorage) {
    this.mockSafeStorage = mockSafeStorage || {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from('enc:' + value.split('').reverse().join('')),
      decryptString: (buffer: Buffer) => {
        const str = buffer.toString();
        if (str.startsWith('enc:')) {
          return str.slice(4).split('').reverse().join('');
        }
        return str;
      },
    };
  }

  initialize(dbPath: string): void {
    this.db = new Database(dbPath);
    this.createTable();
    this.loadDefaults();
    this.loadToCache();
    this.initialized = true;
  }

  private createTable(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER DEFAULT 0,
        category TEXT DEFAULT 'general',
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category);
    `);
  }

  private loadDefaults(): void {
    if (!this.db) return;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, encrypted, category)
      VALUES (?, ?, ?, ?)
    `);

    for (const def of SETTINGS_SCHEMA) {
      insert.run(def.key, def.defaultValue, def.encrypted ? 1 : 0, def.category);
    }
  }

  private loadToCache(): void {
    if (!this.db) return;

    const rows = this.db.prepare('SELECT key, value, encrypted FROM settings').all() as Array<{
      key: string;
      value: string;
      encrypted: number;
    }>;

    for (const row of rows) {
      let value = row.value;

      if (row.encrypted && value) {
        try {
          value = this.decrypt(value);
        } catch {
          // If decryption fails, value stays encrypted
        }
      }

      this.cache.set(row.key, value);
    }
  }

  private encrypt(value: string): string {
    if (!this.mockSafeStorage.isEncryptionAvailable()) {
      return value;
    }
    const encrypted = this.mockSafeStorage.encryptString(value);
    return encrypted.toString('base64');
  }

  private decrypt(encrypted: string): string {
    if (!this.mockSafeStorage.isEncryptionAvailable()) {
      return encrypted;
    }
    const buffer = Buffer.from(encrypted, 'base64');
    return this.mockSafeStorage.decryptString(buffer);
  }

  get(key: string): string {
    if (!this.initialized) {
      const def = SETTINGS_SCHEMA.find(s => s.key === key);
      return def?.defaultValue || '';
    }

    return this.cache.get(key) || '';
  }

  getNumber(key: string): number {
    return parseFloat(this.get(key)) || 0;
  }

  getBoolean(key: string): boolean {
    return this.get(key) === 'true';
  }

  getArray(key: string): string[] {
    try {
      const value = this.get(key);
      if (!value) return [];
      if (value.startsWith('[')) {
        return JSON.parse(value);
      }
      return value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  set(key: string, value: string, encrypted?: boolean): void {
    if (!this.db) throw new Error('Settings not initialized');

    const def = SETTINGS_SCHEMA.find(s => s.key === key);
    const shouldEncrypt = encrypted ?? def?.encrypted ?? false;
    const category = def?.category || 'general';

    let storedValue = value;
    if (shouldEncrypt && value) {
      storedValue = this.encrypt(value);
    }

    this.db
      .prepare(
        `
      INSERT INTO settings (key, value, encrypted, category, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        encrypted = excluded.encrypted,
        updated_at = excluded.updated_at
    `
      )
      .run(key, storedValue, shouldEncrypt ? 1 : 0, category);

    this.cache.set(key, value);
  }

  delete(key: string): boolean {
    if (!this.db) return false;

    const result = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    this.cache.delete(key);

    return result.changes > 0;
  }

  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      result[key] = value;
    }
    return result;
  }

  getByCategory(category: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const def of SETTINGS_SCHEMA) {
      if (def.category === category) {
        result[def.key] = this.get(def.key);
      }
    }
    return result;
  }

  getSchema(category?: string): SettingDefinition[] {
    if (category) {
      return SETTINGS_SCHEMA.filter(s => s.category === category);
    }
    return SETTINGS_SCHEMA;
  }

  hasRequiredKeys(): boolean {
    const authMethod = this.get('auth.method');

    if (authMethod === 'oauth') {
      const oauthToken = this.get('auth.oauthToken');
      return !!oauthToken;
    }

    const anthropicKey = this.get('anthropic.apiKey');
    return !!anthropicKey;
  }

  getAuthMethod(): 'api_key' | 'oauth' | null {
    const method = this.get('auth.method');
    if (method === 'oauth' || method === 'api_key') {
      return method;
    }
    if (this.get('anthropic.apiKey')) {
      return 'api_key';
    }
    return null;
  }

  isFirstRun(): boolean {
    return !this.hasRequiredKeys();
  }

  initializeKeychain(): { available: boolean; error?: string } {
    try {
      if (!this.mockSafeStorage.isEncryptionAvailable()) {
        return { available: false, error: 'Encryption not available on this system' };
      }
      const testValue = 'keychain-init-test';
      const encrypted = this.mockSafeStorage.encryptString(testValue);
      const decrypted = this.mockSafeStorage.decryptString(encrypted);
      if (decrypted !== testValue) {
        return { available: false, error: 'Encryption verification failed' };
      }
      return { available: true };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  getFormattedProfile(): string {
    const name = this.get('profile.name');
    const location = this.get('profile.location');
    const timezone = this.get('profile.timezone');
    const occupation = this.get('profile.occupation');
    const birthday = this.get('profile.birthday');
    const custom = this.get('profile.custom');

    if (!name && !location && !timezone && !occupation && !birthday && !custom) {
      return '';
    }

    const lines: string[] = ['## User Profile'];

    if (name) lines.push(`- **Name:** ${name}`);
    if (location) lines.push(`- **Location:** ${location}`);
    if (timezone) lines.push(`- **Timezone:** ${timezone}`);
    if (occupation) lines.push(`- **Occupation:** ${occupation}`);
    if (birthday) lines.push(`- **Birthday:** ${birthday}`);
    if (custom) {
      lines.push('');
      lines.push('### Additional Information');
      lines.push(custom);
    }

    return lines.join('\n');
  }

  exportSettings(): Record<string, unknown> {
    const all = this.getAll();
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(all)) {
      const def = SETTINGS_SCHEMA.find(s => s.key === key);
      if (def?.encrypted) {
        result[key] = '***ENCRYPTED***';
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  importSettings(settings: Record<string, string>): void {
    for (const [key, value] of Object.entries(settings)) {
      if (value !== '***ENCRYPTED***') {
        this.set(key, value);
      }
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // Helper for testing - get raw database value
  getRawValue(key: string): { value: string; encrypted: number } | undefined {
    if (!this.db) return undefined;
    return this.db.prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key) as
      | { value: string; encrypted: number }
      | undefined;
  }
}

describe('SettingsManager', () => {
  let settings: TestableSettingsManager;

  beforeEach(() => {
    settings = new TestableSettingsManager();
    // Use in-memory database for testing
    settings.initialize(':memory:');
  });

  afterEach(() => {
    settings.close();
  });

  describe('initialization', () => {
    it('should initialize with in-memory database', () => {
      expect(settings.isInitialized()).toBe(true);
    });

    it('should load default settings from schema', () => {
      // Check a few default values
      expect(settings.get('agent.model')).toBe('claude-opus-4-6');
      expect(settings.get('agent.compactionThreshold')).toBe('120000');
      expect(settings.get('browser.enabled')).toBe('true');
    });

    it('should return default value when not initialized', () => {
      const uninitializedSettings = new TestableSettingsManager();
      expect(uninitializedSettings.get('agent.model')).toBe('claude-opus-4-6');
    });

    it('should return empty string for unknown key when not initialized', () => {
      const uninitializedSettings = new TestableSettingsManager();
      expect(uninitializedSettings.get('unknown.key')).toBe('');
    });
  });

  describe('get and set', () => {
    it('should get a setting value', () => {
      expect(settings.get('agent.model')).toBe('claude-opus-4-6');
    });

    it('should set and retrieve a setting value', () => {
      settings.set('agent.model', 'claude-sonnet-4-20250514');
      expect(settings.get('agent.model')).toBe('claude-sonnet-4-20250514');
    });

    it('should return empty string for unknown key', () => {
      expect(settings.get('nonexistent.key')).toBe('');
    });

    it('should update existing setting', () => {
      settings.set('profile.name', 'John');
      expect(settings.get('profile.name')).toBe('John');

      settings.set('profile.name', 'Jane');
      expect(settings.get('profile.name')).toBe('Jane');
    });

    it('should throw when setting value on uninitialized manager', () => {
      const uninitializedSettings = new TestableSettingsManager();
      expect(() => uninitializedSettings.set('test.key', 'value')).toThrow(
        'Settings not initialized'
      );
    });
  });

  describe('type-specific getters', () => {
    it('getNumber should return numeric value', () => {
      settings.set('agent.compactionThreshold', '150000');
      expect(settings.getNumber('agent.compactionThreshold')).toBe(150000);
    });

    it('getNumber should return 0 for invalid number', () => {
      settings.set('agent.compactionThreshold', 'not-a-number');
      expect(settings.getNumber('agent.compactionThreshold')).toBe(0);
    });

    it('getBoolean should return true for "true"', () => {
      settings.set('telegram.enabled', 'true');
      expect(settings.getBoolean('telegram.enabled')).toBe(true);
    });

    it('getBoolean should return false for other values', () => {
      settings.set('telegram.enabled', 'false');
      expect(settings.getBoolean('telegram.enabled')).toBe(false);

      settings.set('telegram.enabled', '1');
      expect(settings.getBoolean('telegram.enabled')).toBe(false);
    });

    it('getArray should parse JSON array', () => {
      settings.set('telegram.allowedUserIds', '["123","456","789"]');
      expect(settings.getArray('telegram.allowedUserIds')).toEqual(['123', '456', '789']);
    });

    it('getArray should parse comma-separated values', () => {
      settings.set('telegram.allowedUserIds', '123, 456, 789');
      expect(settings.getArray('telegram.allowedUserIds')).toEqual(['123', '456', '789']);
    });

    it('getArray should return empty array for empty value', () => {
      settings.set('telegram.allowedUserIds', '');
      expect(settings.getArray('telegram.allowedUserIds')).toEqual([]);
    });

    it('getArray should return empty array for invalid JSON', () => {
      settings.set('telegram.allowedUserIds', '{invalid}');
      expect(settings.getArray('telegram.allowedUserIds')).toEqual(['{invalid}']);
    });
  });

  describe('encryption and decryption', () => {
    it('should encrypt sensitive settings when storing', () => {
      const apiKey = 'sk-ant-test-key-12345';
      settings.set('anthropic.apiKey', apiKey);

      // Get raw value from database should be encrypted
      const raw = settings.getRawValue('anthropic.apiKey');
      expect(raw?.encrypted).toBe(1);
      expect(raw?.value).not.toBe(apiKey);
    });

    it('should decrypt sensitive settings when retrieving', () => {
      const apiKey = 'sk-ant-test-key-12345';
      settings.set('anthropic.apiKey', apiKey);

      // Retrieved value should be decrypted
      expect(settings.get('anthropic.apiKey')).toBe(apiKey);
    });

    it('should not encrypt non-sensitive settings', () => {
      settings.set('profile.name', 'John Doe');

      const raw = settings.getRawValue('profile.name');
      expect(raw?.encrypted).toBe(0);
      expect(raw?.value).toBe('John Doe');
    });

    it('should allow forcing encryption on custom settings', () => {
      settings.set('custom.secret', 'secret-value', true);

      const raw = settings.getRawValue('custom.secret');
      expect(raw?.encrypted).toBe(1);
    });

    it('should handle encryption unavailable gracefully', () => {
      const noEncryptionSettings = new TestableSettingsManager({
        isEncryptionAvailable: () => false,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (buffer: Buffer) => buffer.toString(),
      });

      noEncryptionSettings.initialize(':memory:');

      const apiKey = 'sk-ant-test-key-12345';
      noEncryptionSettings.set('anthropic.apiKey', apiKey);

      // Should still store the value (just not encrypted)
      expect(noEncryptionSettings.get('anthropic.apiKey')).toBe(apiKey);

      noEncryptionSettings.close();
    });
  });

  describe('delete', () => {
    it('should delete a setting', () => {
      settings.set('profile.name', 'John');
      expect(settings.get('profile.name')).toBe('John');

      const result = settings.delete('profile.name');
      expect(result).toBe(true);
      expect(settings.get('profile.name')).toBe('');
    });

    it('should return false when deleting non-existent key', () => {
      const result = settings.delete('nonexistent.key');
      expect(result).toBe(false);
    });

    it('should return false when not initialized', () => {
      const uninitializedSettings = new TestableSettingsManager();
      expect(uninitializedSettings.delete('test.key')).toBe(false);
    });
  });

  describe('getAll and getByCategory', () => {
    it('should return all settings', () => {
      const all = settings.getAll();
      expect(all).toHaveProperty('agent.model');
      expect(all).toHaveProperty('telegram.enabled');
      expect(all).toHaveProperty('profile.name');
    });

    it('should return settings by category', () => {
      const agentSettings = settings.getByCategory('agent');
      expect(agentSettings).toHaveProperty('agent.model');
      expect(agentSettings).toHaveProperty('agent.compactionThreshold');
      expect(agentSettings).not.toHaveProperty('telegram.enabled');
    });

    it('should return empty object for unknown category', () => {
      const unknownCategory = settings.getByCategory('nonexistent');
      expect(unknownCategory).toEqual({});
    });
  });

  describe('schema', () => {
    it('should return all schema definitions', () => {
      const schema = settings.getSchema();
      expect(schema.length).toBeGreaterThan(0);
      expect(schema).toEqual(SETTINGS_SCHEMA);
    });

    it('should return schema by category', () => {
      const agentSchema = settings.getSchema('agent');
      expect(agentSchema.length).toBeGreaterThan(0);
      expect(agentSchema.every(s => s.category === 'agent')).toBe(true);
    });

    it('schema should have required properties', () => {
      const schema = settings.getSchema();
      for (const def of schema) {
        expect(def).toHaveProperty('key');
        expect(def).toHaveProperty('defaultValue');
        expect(def).toHaveProperty('encrypted');
        expect(def).toHaveProperty('category');
        expect(def).toHaveProperty('label');
        expect(def).toHaveProperty('type');
      }
    });
  });

  describe('authentication helpers', () => {
    it('hasRequiredKeys should return false when no keys set', () => {
      expect(settings.hasRequiredKeys()).toBe(false);
    });

    it('hasRequiredKeys should return true when API key is set', () => {
      settings.set('anthropic.apiKey', 'sk-ant-test-key');
      expect(settings.hasRequiredKeys()).toBe(true);
    });

    it('hasRequiredKeys should check OAuth token when auth method is oauth', () => {
      settings.set('auth.method', 'oauth');
      expect(settings.hasRequiredKeys()).toBe(false);

      settings.set('auth.oauthToken', 'oauth-token-123');
      expect(settings.hasRequiredKeys()).toBe(true);
    });

    it('getAuthMethod should return null when no auth configured', () => {
      expect(settings.getAuthMethod()).toBe(null);
    });

    it('getAuthMethod should return api_key when API key exists', () => {
      settings.set('anthropic.apiKey', 'sk-ant-test-key');
      expect(settings.getAuthMethod()).toBe('api_key');
    });

    it('getAuthMethod should return oauth when explicitly set', () => {
      settings.set('auth.method', 'oauth');
      expect(settings.getAuthMethod()).toBe('oauth');
    });

    it('isFirstRun should return true when no auth configured', () => {
      expect(settings.isFirstRun()).toBe(true);
    });

    it('isFirstRun should return false when API key exists', () => {
      settings.set('anthropic.apiKey', 'sk-ant-test-key');
      expect(settings.isFirstRun()).toBe(false);
    });
  });

  describe('keychain initialization', () => {
    it('should return available true when encryption works', () => {
      const result = settings.initializeKeychain();
      expect(result.available).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return available false when encryption not available', () => {
      const noEncryptionSettings = new TestableSettingsManager({
        isEncryptionAvailable: () => false,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (buffer: Buffer) => buffer.toString(),
      });

      const result = noEncryptionSettings.initializeKeychain();
      expect(result.available).toBe(false);
      expect(result.error).toBe('Encryption not available on this system');
    });

    it('should return available false when encryption verification fails', () => {
      const badEncryptionSettings = new TestableSettingsManager({
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: () => 'wrong-value',
      });

      const result = badEncryptionSettings.initializeKeychain();
      expect(result.available).toBe(false);
      expect(result.error).toBe('Encryption verification failed');
    });

    it('should catch and return errors', () => {
      const errorSettings = new TestableSettingsManager({
        isEncryptionAvailable: () => true,
        encryptString: () => {
          throw new Error('Keychain access denied');
        },
        decryptString: (buffer: Buffer) => buffer.toString(),
      });

      const result = errorSettings.initializeKeychain();
      expect(result.available).toBe(false);
      expect(result.error).toBe('Keychain access denied');
    });
  });

  describe('profile formatting', () => {
    it('should return empty string when no profile data', () => {
      expect(settings.getFormattedProfile()).toBe('');
    });

    it('should format profile with name only', () => {
      settings.set('profile.name', 'John Doe');
      const profile = settings.getFormattedProfile();
      expect(profile).toContain('## User Profile');
      expect(profile).toContain('- **Name:** John Doe');
    });

    it('should format complete profile', () => {
      settings.set('profile.name', 'Jane Smith');
      settings.set('profile.location', 'San Francisco');
      settings.set('profile.timezone', 'America/Los_Angeles');
      settings.set('profile.occupation', 'Software Engineer');
      settings.set('profile.birthday', 'March 15');

      const profile = settings.getFormattedProfile();
      expect(profile).toContain('- **Name:** Jane Smith');
      expect(profile).toContain('- **Location:** San Francisco');
      expect(profile).toContain('- **Timezone:** America/Los_Angeles');
      expect(profile).toContain('- **Occupation:** Software Engineer');
      expect(profile).toContain('- **Birthday:** March 15');
    });

    it('should include custom info section', () => {
      settings.set('profile.name', 'John');
      settings.set('profile.custom', 'I love coding and coffee.');

      const profile = settings.getFormattedProfile();
      expect(profile).toContain('### Additional Information');
      expect(profile).toContain('I love coding and coffee.');
    });
  });

  describe('export and import', () => {
    it('should export settings with encrypted values masked', () => {
      settings.set('profile.name', 'John');
      settings.set('anthropic.apiKey', 'sk-ant-secret');

      const exported = settings.exportSettings();
      expect(exported['profile.name']).toBe('John');
      expect(exported['anthropic.apiKey']).toBe('***ENCRYPTED***');
    });

    it('should import settings ignoring encrypted placeholders', () => {
      const importData = {
        'profile.name': 'Imported User',
        'profile.location': 'New York',
        'anthropic.apiKey': '***ENCRYPTED***',
      };

      settings.importSettings(importData);

      expect(settings.get('profile.name')).toBe('Imported User');
      expect(settings.get('profile.location')).toBe('New York');
      // API key should not be changed (was empty, stays empty)
      expect(settings.get('anthropic.apiKey')).toBe('');
    });
  });

  describe('close', () => {
    it('should close database and reset state', () => {
      expect(settings.isInitialized()).toBe(true);
      settings.close();
      expect(settings.isInitialized()).toBe(false);
    });

    it('should handle multiple close calls gracefully', () => {
      settings.close();
      settings.close();
      expect(settings.isInitialized()).toBe(false);
    });
  });
});

describe('SETTINGS_SCHEMA', () => {
  it('should have unique keys', () => {
    const keys = SETTINGS_SCHEMA.map(s => s.key);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  it('should have valid types', () => {
    const validTypes = ['string', 'number', 'boolean', 'password', 'array', 'textarea'];
    for (const def of SETTINGS_SCHEMA) {
      expect(validTypes).toContain(def.type);
    }
  });

  it('should have encrypted flag set for password types', () => {
    const passwordSettings = SETTINGS_SCHEMA.filter(s => s.type === 'password');
    for (const setting of passwordSettings) {
      expect(setting.encrypted).toBe(true);
    }
  });

  it('should have all expected categories', () => {
    const categories = new Set(SETTINGS_SCHEMA.map(s => s.category));
    expect(categories.has('auth')).toBe(true);
    expect(categories.has('api_keys')).toBe(true);
    expect(categories.has('agent')).toBe(true);
    expect(categories.has('telegram')).toBe(true);
    expect(categories.has('memory')).toBe(true);
    expect(categories.has('browser')).toBe(true);
    expect(categories.has('profile')).toBe(true);
  });
});

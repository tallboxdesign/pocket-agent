import fs from 'fs';
import path from 'path';
import { ToolsConfig, getDefaultToolsConfig } from '../tools';

// Re-export identity functions
export { loadIdentity, saveIdentity, getIdentityPath } from './identity';

// Re-export instructions functions (internal CLAUDE.md)
export { loadInstructions, saveInstructions, getInstructionsPath } from './instructions';

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
}

export interface OpenAIConfig {
  apiKey: string;
}

export interface TelegramConfig {
  botToken: string;
  allowedUserIds: number[];
  enabled: boolean;
}

export interface SchedulerConfig {
  enabled: boolean;
}

export interface AppConfig {
  anthropic: AnthropicConfig;
  openai: OpenAIConfig;
  telegram: TelegramConfig;
  scheduler: SchedulerConfig;
  tools: ToolsConfig;
}

const DEFAULT_CONFIG: AppConfig = {
  anthropic: {
    apiKey: '',
    model: 'claude-opus-4-6',
  },
  openai: {
    apiKey: '',
  },
  telegram: {
    botToken: '',
    allowedUserIds: [],
    enabled: false,
  },
  scheduler: {
    enabled: true,
  },
  tools: getDefaultToolsConfig(),
};

class ConfigManager {
  private static instance: ConfigManager | null = null;
  private config: AppConfig = DEFAULT_CONFIG;
  private configPath: string = '';
  private loaded: boolean = false;

  private constructor() {}

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Load config from file
   */
  load(configDir: string): AppConfig {
    this.configPath = path.join(configDir, 'config.json');

    if (fs.existsSync(this.configPath)) {
      try {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        const fileConfig = JSON.parse(content);
        this.config = this.mergeConfig(DEFAULT_CONFIG, fileConfig);
        console.log('[Config] Loaded from:', this.configPath);
      } catch (error) {
        console.error('[Config] Error loading config:', error);
        this.config = DEFAULT_CONFIG;
      }
    } else {
      // Create default config file
      this.config = DEFAULT_CONFIG;
      this.save();
      console.log('[Config] Created default config at:', this.configPath);
    }

    // Override with environment variables if present
    if (process.env.ANTHROPIC_API_KEY) {
      this.config.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    if (process.env.OPENAI_API_KEY) {
      this.config.openai.apiKey = process.env.OPENAI_API_KEY;
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      this.config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
      this.config.telegram.enabled = true;
    }
    if (process.env.TELEGRAM_ALLOWED_USERS) {
      this.config.telegram.allowedUserIds = process.env.TELEGRAM_ALLOWED_USERS
        .split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id));
    }

    // Browser tool config from env
    if (process.env.CDP_URL) {
      this.config.tools.browser.cdpUrl = process.env.CDP_URL;
    }
    if (process.env.COMPUTER_USE_ENABLED === 'true') {
      this.config.tools.computerUse.enabled = true;
    }

    this.loaded = true;
    return this.config;
  }

  /**
   * Deep merge configs
   */
  private mergeConfig(defaults: AppConfig, overrides: Partial<AppConfig>): AppConfig {
    return {
      anthropic: { ...defaults.anthropic, ...overrides.anthropic },
      openai: { ...defaults.openai, ...overrides.openai },
      telegram: { ...defaults.telegram, ...overrides.telegram },
      scheduler: { ...defaults.scheduler, ...overrides.scheduler },
      tools: {
        ...defaults.tools,
        ...overrides.tools,
        mcpServers: { ...defaults.tools.mcpServers, ...overrides.tools?.mcpServers },
        computerUse: { ...defaults.tools.computerUse, ...overrides.tools?.computerUse },
        browser: { ...defaults.tools.browser, ...overrides.tools?.browser },
      },
    };
  }

  /**
   * Save current config to file
   */
  save(): void {
    if (!this.configPath) return;

    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      console.log('[Config] Saved to:', this.configPath);
    } catch (error) {
      console.error('[Config] Error saving config:', error);
    }
  }

  /**
   * Get current config
   */
  get(): AppConfig {
    if (!this.loaded) {
      console.warn('[Config] Config not loaded, using defaults');
    }
    return this.config;
  }

  /**
   * Update config values
   */
  update(updates: Partial<AppConfig>): void {
    this.config = this.mergeConfig(this.config, updates);
    this.save();
  }

  /**
   * Check if config is valid for running
   */
  isValid(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.config.anthropic.apiKey) {
      errors.push('Missing Anthropic API key');
    }

    if (this.config.telegram.enabled && !this.config.telegram.botToken) {
      errors.push('Telegram enabled but missing bot token');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export const Config = ConfigManager.getInstance();

/**
 * Settings Manager - SQLite-based configuration with encryption
 *
 * Uses Electron's safeStorage API to encrypt sensitive values like API keys.
 * All settings stored in SQLite for persistence and atomic updates.
 */

import Database from 'better-sqlite3';
import { safeStorage } from 'electron';

export interface Setting {
  key: string;
  value: string;
  encrypted: boolean;
  category: string;
  updated_at: string;
}

export interface SettingDefinition {
  key: string;
  defaultValue: string;
  encrypted: boolean;
  category: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'password' | 'array' | 'textarea';
  validation?: (value: string) => boolean;
}

// Default settings schema
export const SETTINGS_SCHEMA: SettingDefinition[] = [
  {
    key: 'dailyLogs.days',
    defaultValue: '3',
    encrypted: false,
    category: 'memory',
    label: 'Daily Logs Range (Days)',
    description: 'How many recent days to show in Daily Logs and inject for context (minimum 3).',
    type: 'number',
  },
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
    description: 'Your OpenAI API key for embeddings and image generation',
    type: 'password',
  },
  {
    key: 'gemini.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Google Gemini API Key',
    description: 'For Gemini-powered skills (nano-banana-pro)',
    type: 'password',
  },
  {
    key: 'zhipu.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Zhipu AI API Key',
    description: 'GLM models for worker tasks (summarization, classification, extraction)',
    type: 'password',
  },
  {
    key: 'zhipu.model',
    defaultValue: 'glm-5',
    encrypted: false,
    category: 'llm',
    label: 'GLM Worker Model',
    description: 'Primary GLM model for quality summaries and extraction',
    type: 'string',
  },
  {
    key: 'zhipu.flashModel',
    defaultValue: 'glm-4.7-flash',
    encrypted: false,
    category: 'llm',
    label: 'GLM Flash Model',
    description: 'Fast GLM model for classification and bulk tasks',
    type: 'string',
  },
  {
    key: 'zhipu.bulkModel',
    defaultValue: 'glm-4.7-flashx',
    encrypted: false,
    category: 'llm',
    label: 'GLM Bulk Model',
    description: 'High-throughput model for batch classification (3 concurrent)',
    type: 'string',
  },
  {
    key: 'zhipu.baseUrl',
    defaultValue: 'https://open.bigmodel.cn/api/paas/v4',
    encrypted: false,
    category: 'llm',
    label: 'GLM API Base URL',
    description: 'Zhipu API endpoint',
    type: 'string',
  },
  {
    key: 'moonshot.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Moonshot/Kimi API Key',
    description: 'Your Moonshot API key for Kimi models',
    type: 'password',
  },
  {
    key: 'glm.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Z.AI GLM API Key',
    description: 'Your Z.AI API key for GLM models',
    type: 'password',
  },
  {
    key: 'minimax.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'MiniMax API Key',
    description: 'Your MiniMax API key for MiniMax chat models',
    type: 'password',
  },
  {
    key: 'qwen.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'Qwen API Key',
    description: 'Alibaba Model Studio API key for Qwen (Anthropic-compatible endpoint)',
    type: 'password',
  },
  {
    key: 'openrouter.apiKey',
    defaultValue: '',
    encrypted: true,
    category: 'api_keys',
    label: 'OpenRouter API Key',
    description: 'OpenRouter API key for Qwen/OpenRouter models',
    type: 'password',
  },
  {
    key: 'openrouter.favoriteModels',
    defaultValue: '',
    encrypted: false,
    category: 'llm',
    label: 'OpenRouter Favorite Models',
    description: 'Comma/newline separated OpenRouter model IDs to pin at top (for example: qwen/qwen3.5-plus-02-15)',
    type: 'string',
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
    key: 'agent.mode',
    defaultValue: 'coder',
    encrypted: false,
    category: 'agent',
    label: 'Default Agent Mode',
    description: 'Default mode for new sessions: coder or manager',
    type: 'string',
  },
  // DEPRECATED: SDK handles compaction natively via persistSession + resume
  {
    key: 'agent.fallbackModel',
    defaultValue: '',
    encrypted: false,
    category: 'agent',
    label: 'Backup Model',
    description: 'Model to use when primary fails (empty = no fallback)',
    type: 'string',
  },
  {
    key: 'app.launchAtLogin',
    defaultValue: 'false',
    encrypted: false,
    category: 'agent',
    label: 'Launch at Login',
    description: 'Automatically start Pocket Agent when you log in to your Mac',
    type: 'boolean',
  },
  {
    key: 'agent.compactionThreshold',
    defaultValue: '120000',
    encrypted: false,
    category: 'agent',
    label: 'Compaction Threshold',
    description: 'Deprecated - SDK handles this natively',
    type: 'number',
  },
  // DEPRECATED: SDK handles context window natively via persistSession + resume
  {
    key: 'agent.maxContextTokens',
    defaultValue: '150000',
    encrypted: false,
    category: 'agent',
    label: 'Max Context Tokens',
    description: 'Deprecated - SDK handles this natively',
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
  {
    key: 'agent.allowHostIntegrations',
    defaultValue: 'false',
    encrypted: false,
    category: 'agent',
    label: 'Allow Host Integrations',
    description: 'Allow Bash commands that interact with host apps/system integrations outside Pocket Agent',
    type: 'boolean',
  },
  {
    key: 'agent.managerHardToolRestrictions',
    defaultValue: 'false',
    encrypted: false,
    category: 'agent',
    label: 'Manager Hard Tool Restrictions',
    description: 'If enabled, Manager mode hard-blocks risky coding/shell tools instead of using behavior guidance first',
    type: 'boolean',
  },
  // DEPRECATED: SDK handles conversation history natively via persistSession + resume
  {
    key: 'agent.recentMessageLimit',
    defaultValue: '20',
    encrypted: false,
    category: 'agent',
    label: 'Recent Message Limit',
    description: 'Deprecated - SDK handles this natively',
    type: 'number',
  },
  // DEPRECATED: SDK handles summarization natively via auto-compaction
  {
    key: 'agent.rollingSummaryInterval',
    defaultValue: '50',
    encrypted: false,
    category: 'agent',
    label: 'Rolling Summary Interval',
    description: 'Deprecated - SDK handles this natively',
    type: 'number',
  },
  // DEPRECATED: SDK handles context retrieval natively via persistSession + resume
  {
    key: 'agent.semanticRetrievalCount',
    defaultValue: '5',
    encrypted: false,
    category: 'agent',
    label: 'Semantic Retrieval Count',
    description: 'Deprecated - SDK handles this natively',
    type: 'number',
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
    key: 'telegram.reactionAckEnabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'telegram',
    label: 'Auto Reactions',
    description: 'React to incoming Telegram messages automatically',
    type: 'boolean',
  },
  {
    key: 'telegram.strictHeuristics',
    defaultValue: 'false',
    encrypted: false,
    category: 'telegram',
    label: 'Strict Telegram Heuristics',
    description: 'Enable extra Telegram parsing rules. Keep OFF for normal LLM-first behavior.',
    type: 'boolean',
  },
  {
    key: 'telegram.reactionAckEmoji',
    defaultValue: '👍',
    encrypted: false,
    category: 'telegram',
    label: 'Ack Emoji',
    description: 'Emoji used for normal acknowledgement',
    type: 'string',
  },
  {
    key: 'telegram.reactionSavedEmoji',
    defaultValue: '❤️',
    encrypted: false,
    category: 'telegram',
    label: 'Saved Emoji',
    description: 'Emoji used when something is saved/logged',
    type: 'string',
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
  {
    key: 'browser.useMyBrowser',
    defaultValue: 'false',
    encrypted: false,
    category: 'browser',
    label: 'Use My Browser',
    description: 'Always use your browser instead of headless mode',
    type: 'boolean',
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

  // Notification settings
  {
    key: 'notifications.soundEnabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'notifications',
    label: 'Response Sound',
    description: 'Play a sound when responses complete',
    type: 'boolean',
  },

  // Voice settings
  {
    key: 'voice.ttsEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'voice',
    label: 'Auto TTS',
    description: 'Automatically read agent responses aloud',
    type: 'boolean',
  },
  {
    key: 'telegram.voiceReplies',
    defaultValue: 'true',
    encrypted: false,
    category: 'telegram',
    label: 'Voice Replies',
    description: 'Send voice messages alongside text replies in Telegram',
    type: 'boolean',
  },

  // Gmail settings
  {
    key: 'gmail.enabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'gmail',
    label: 'Enable Gmail',
    description: 'Enable Gmail integration via gog CLI',
    type: 'boolean',
  },
  {
    key: 'gmail.userEmail',
    defaultValue: '',
    encrypted: false,
    category: 'gmail',
    label: 'Gmail Address',
    description: 'Your Gmail address (must match gog auth account)',
    type: 'string',
  },
  {
    key: 'gmail.defaultRecipient',
    defaultValue: '',
    encrypted: false,
    category: 'gmail',
    label: 'Default Recipient',
    description: 'Default email recipient for scheduled job notifications',
    type: 'string',
  },

  // Email Processing settings (GLM background job)
  {
    key: 'gmail.emailProcessing.enabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'gmail',
    label: 'Enable Email Processing',
    description: 'GLM automatically classifies and labels incoming emails',
    type: 'boolean',
  },
  {
    key: 'gmail.emailProcessing.intervalMin',
    defaultValue: '30',
    encrypted: false,
    category: 'gmail',
    label: 'Scan Frequency (minutes)',
    description: 'How often to check for new emails (20, 30, or 60)',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.accounts',
    defaultValue: '[]',
    encrypted: false,
    category: 'gmail',
    label: 'Accounts to Monitor',
    description: 'JSON array of Gmail addresses to process',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.categories',
    defaultValue: '[]',
    encrypted: false,
    category: 'gmail',
    label: 'Categories to Scan',
    description: 'JSON array of Gmail categories (empty = all inbox)',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.labelConfig',
    defaultValue: '{}',
    encrypted: false,
    category: 'gmail',
    label: 'Label Configuration',
    description: 'JSON: per-label config with notify, description, examples',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.processedLabel',
    defaultValue: 'AI/Processed',
    encrypted: false,
    category: 'gmail',
    label: 'Processed Marker Label',
    description: 'Gmail label applied to processed emails for idempotency',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.reviewLabel',
    defaultValue: 'AI/Review',
    encrypted: false,
    category: 'gmail',
    label: 'Review Label',
    description: 'Gmail label for low-confidence classifications needing manual review',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.maxEmailsPerRun',
    defaultValue: '100',
    encrypted: false,
    category: 'gmail',
    label: 'Max Emails Per Run',
    description: 'Maximum emails to process in a single run',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.gmailConcurrency',
    defaultValue: '4',
    encrypted: false,
    category: 'gmail',
    label: 'Gmail Concurrency',
    description: 'Max concurrent Gmail API calls (getMessage)',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.glmConcurrency',
    defaultValue: '3',
    encrypted: false,
    category: 'gmail',
    label: 'GLM Concurrency',
    description: 'Max concurrent GLM classification calls',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.lookbackDays',
    defaultValue: '7',
    encrypted: false,
    category: 'gmail',
    label: 'Lookback Days',
    description: 'Safety net: fetch emails from last N days (filtered locally by checkpoint)',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.activeLabels',
    defaultValue: '[]',
    encrypted: false,
    category: 'gmail',
    label: 'Active Labels',
    description: 'JSON array of label names to classify into (empty = all user labels)',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.rulesEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'gmail',
    label: 'Enable Rules Engine',
    description: 'Run deterministic rules on classified emails (actions, notifications, drafts)',
    type: 'boolean',
  },
  {
    key: 'gmail.emailProcessing.dailySummaryTime',
    defaultValue: '08:00',
    encrypted: false,
    category: 'gmail',
    label: 'Daily Summary Time',
    description: 'Time of day to send daily email digest (HH:MM)',
    type: 'string',
  },
  {
    key: 'gmail.emailProcessing.draftReply.blockedDomains',
    defaultValue: '',
    encrypted: false,
    category: 'gmail',
    label: 'Draft Reply Blocked Domains',
    description: 'Comma-separated domains to never create draft replies for (e.g. newsletter.com,noreply.example.com)',
    type: 'string',
  },

  // LinkedIn settings
  {
    key: 'linkedin.enabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Enable LinkedIn',
    description: 'Enable LinkedIn automation tools',
    type: 'boolean',
  },
  {
    key: 'linkedin.plannerEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Enable Content Planner',
    description: 'Enable the LinkedIn Content Planner for creating and scheduling original posts across targets',
    type: 'boolean',
  },
  {
    key: 'linkedin.autoConfirm',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto-Confirm Posts',
    description: 'Allow agent to post and comment without asking for confirmation',
    type: 'boolean',
  },
  {
    key: 'linkedin.feedKeywords',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Default Feed Keywords',
    description: 'Comma-separated keywords to filter feed by default',
    type: 'string',
  },
  {
    key: 'linkedin.voiceStyle',
    defaultValue: 'casual but smart. lowercase most things. short sentences. challenge bs. never sound like a consultant or a report.',
    encrypted: false,
    category: 'linkedin',
    label: 'Writing Voice & Style',
    description: 'Describe your writing voice for LinkedIn posts and comments',
    type: 'string',
  },
  {
    key: 'linkedin.writingRules',
    defaultValue: 'no citations or source names. no exact stats with attribution. no ending questions. no em dashes. just say what you think in plain language.',
    encrypted: false,
    category: 'linkedin',
    label: 'Writing Rules',
    description: 'Specific rules for sentence structure, formatting, tone',
    type: 'string',
  },
  {
    key: 'linkedin.postBankEntries',
    defaultValue: '[]',
    encrypted: false,
    category: 'linkedin',
    label: 'Post Bank Entries',
    description: 'JSON array of post/reply examples used as style references',
    type: 'textarea',
  },
  {
    key: 'linkedin.contentDirection',
    defaultValue: 'seo, ai search, web development. practical takes from someone who builds stuff daily.',
    encrypted: false,
    category: 'linkedin',
    label: 'Content Direction',
    description: 'Topics, themes, and angles you want to focus on',
    type: 'string',
  },
  {
    key: 'linkedin.postTargets',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Post Targets',
    description: 'LinkedIn destination URLs (one per line): your profile, company page, or allowed groups',
    type: 'textarea',
  },
  {
    key: 'linkedin.postsPerDay',
    defaultValue: '3',
    encrypted: false,
    category: 'linkedin',
    label: 'Posts Per Day',
    description: 'Daily target count for original post publishing workflow',
    type: 'number',
  },
  {
    key: 'linkedin.postStrategy',
    defaultValue: 'Use top-engagement feed topics as inspiration, then publish a stronger, clearer narrative with original angle and practical takeaway.',
    encrypted: false,
    category: 'linkedin',
    label: 'Post Strategy',
    description: 'High-level strategy for turning feed signals into stronger original posts',
    type: 'textarea',
  },
  {
    key: 'linkedin.imagePromptStyle',
    defaultValue: 'Generate authentic, non-generic visuals that reinforce the post argument. Avoid clickbait aesthetics.',
    encrypted: false,
    category: 'linkedin',
    label: 'Image Prompt Style',
    description: 'Instructions used when generating supporting images for LinkedIn posts',
    type: 'textarea',
  },
  {
    key: 'linkedin.roughnessLevel',
    defaultValue: '0',
    encrypted: false,
    category: 'linkedin',
    label: 'Writing Roughness',
    description: 'How intentionally imperfect the writing should feel (0-3). 0 = polished, 3 = most raw.',
    type: 'number',
  },
  {
    key: 'linkedin.roughnessAllowDiscourse',
    defaultValue: 'true',
    encrypted: false,
    category: 'linkedin',
    label: 'Allow Discourse Markers',
    description: 'Allow a small amount of informal discourse markers in rough drafts (casual pivot/edge words)',
    type: 'boolean',
  },
  {
    key: 'linkedin.presentSimple',
    defaultValue: 'true',
    encrypted: false,
    category: 'linkedin',
    label: 'Present Simple Tense',
    description: 'Prefer present simple tense in LinkedIn replies (avoid progressive/future tense)',
    type: 'boolean',
  },
  {
    key: 'linkedin.qualityGateEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Quality Gate Enabled',
    description: 'Require quality metadata before approving or scheduling LinkedIn drafts',
    type: 'boolean',
  },
  {
    key: 'linkedin.qualityGateMinHook',
    defaultValue: '7',
    encrypted: false,
    category: 'linkedin',
    label: 'Minimum Hook Score',
    description: 'Minimum hook score required before approval or scheduling',
    type: 'number',
  },
  {
    key: 'linkedin.qualityGateRequireEmotion',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Require Emotion Tag',
    description: 'Require an emotion tag before approval or scheduling',
    type: 'boolean',
  },
  {
    key: 'linkedin.qualityGateRequireNiche',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Require Niche Target',
    description: 'Require a niche target before approval or scheduling',
    type: 'boolean',
  },
  {
    key: 'linkedin.qualityGateRequireAuthenticity',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Require Authenticity Flag',
    description: 'Require a human or AI assist flag before approval or scheduling',
    type: 'boolean',
  },

  {
    key: 'linkedin.feedScroll',
    defaultValue: '12',
    encrypted: false,
    category: 'linkedin',
    label: 'Feed Scroll Depth',
    description: 'How many times to scroll the feed (more = more posts, slower). Recommended baseline: 12. Use 18 for deep scans.',
    type: 'string',
  },
  {
    key: 'linkedin.feedLimit',
    defaultValue: '20',
    encrypted: false,
    category: 'linkedin',
    label: 'Max Posts',
    description: 'Maximum posts to return per scrape',
    type: 'string',
  },
  {
    key: 'linkedin.autoScrapeEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto Feed Scrape Alerts',
    description: 'Automatically scrape feed on an interval and flag high-engagement posts for drafting',
    type: 'boolean',
  },
  {
    key: 'linkedin.autoScrapeIntervalMin',
    defaultValue: '60',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto Scrape Interval (min)',
    description: 'Minutes between automatic feed scrapes (recommended: 60, optional: 30)',
    type: 'number',
  },
  {
    key: 'linkedin.autoScrapeScroll',
    defaultValue: '12',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto Scrape Scroll Depth',
    description: 'Scroll depth used by automatic scrape runs',
    type: 'number',
  },
  {
    key: 'linkedin.autoScrapeLimit',
    defaultValue: '50',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto Scrape Max Posts',
    description: 'Maximum posts collected per automatic scrape run',
    type: 'number',
  },
  {
    key: 'linkedin.autoScrapeMinReactions',
    defaultValue: '5',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto Scrape Min Reactions',
    description: 'Minimum reactions required to flag a post as a drafting candidate',
    type: 'number',
  },
  {
    key: 'linkedin.autoScrapeMinComments',
    defaultValue: '1',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto Scrape Min Comments',
    description: 'Minimum comments required to flag a post as a drafting candidate',
    type: 'number',
  },
  {
    key: 'linkedin.autoScrapeMaxFlagged',
    defaultValue: '8',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto Scrape Max Flagged',
    description: 'Maximum number of posts to flag per auto scrape cycle',
    type: 'number',
  },
  {
    key: 'linkedin.discoveryModeEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Discovery Mode',
    description: 'Also scrape LinkedIn content search pages for focus keywords/hashtags',
    type: 'boolean',
  },
  {
    key: 'linkedin.discoveryQueries',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Discovery Queries',
    description: 'Comma-separated keywords/hashtags for search discovery (e.g. ai seo,#llmseo,geo)',
    type: 'string',
  },
  {
    key: 'linkedin.discoveryScroll',
    defaultValue: '10',
    encrypted: false,
    category: 'linkedin',
    label: 'Discovery Scroll',
    description: 'Scroll depth for each discovery query scrape',
    type: 'number',
  },
  {
    key: 'linkedin.discoveryLimit',
    defaultValue: '35',
    encrypted: false,
    category: 'linkedin',
    label: 'Discovery Limit',
    description: 'Max posts to collect per discovery query',
    type: 'number',
  },
  {
    key: 'linkedin.discoveryQueryLeaderboard',
    defaultValue: '[]',
    encrypted: false,
    category: 'linkedin',
    label: 'Discovery Query Leaderboard',
    description: 'Auto-maintained query performance history (runs, new hit rate, refreshed hit rate)',
    type: 'string',
  },
  {
    key: 'linkedin.commentDelay',
    defaultValue: '3',
    encrypted: false,
    category: 'linkedin',
    label: 'Comment Delay (min)',
    description: 'Minutes between posting comments to avoid LinkedIn detection (recommended: 3-5)',
    type: 'string',
  },
  {
    key: 'linkedin.draftMode',
    defaultValue: 'balanced',
    encrypted: false,
    category: 'linkedin',
    label: 'Draft Mode',
    description: 'Depth profile for LinkedIn drafting: fast, balanced, or deep',
    type: 'string',
  },
  {
    key: 'linkedin.postModel',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Primary Draft Model',
    description: 'Primary model for LinkedIn drafting. Empty uses the active chat model.',
    type: 'string',
  },
  {
    key: 'linkedin.draftTimeoutSec',
    defaultValue: '95',
    encrypted: false,
    category: 'linkedin',
    label: 'Draft Timeout (sec)',
    description: 'Maximum total time budget per post for research + drafting before abort',
    type: 'number',
  },
  {
    key: 'linkedin.researchMaxTurns',
    defaultValue: '5',
    encrypted: false,
    category: 'linkedin',
    label: 'Research Turns',
    description: 'Max SDK turns for the research pass',
    type: 'number',
  },
  {
    key: 'linkedin.writeMaxTurns',
    defaultValue: '4',
    encrypted: false,
    category: 'linkedin',
    label: 'Write Turns',
    description: 'Max SDK turns for the writing pass',
    type: 'number',
  },
  {
    key: 'linkedin.researchMaxQueries',
    defaultValue: '2',
    encrypted: false,
    category: 'linkedin',
    label: 'Research Queries',
    description: 'Target max number of web search queries in research pass',
    type: 'number',
  },
  {
    key: 'linkedin.researchFallbackModel',
    defaultValue: 'claude-sonnet-4-6',
    encrypted: false,
    category: 'linkedin',
    label: 'Research Fallback Model',
    description: 'Primary fallback model for LinkedIn draft runs (recommended: authenticated Claude subscription)',
    type: 'string',
  },
  {
    key: 'linkedin.researchFallbackModel2',
    defaultValue: 'gpt-4.1',
    encrypted: false,
    category: 'linkedin',
    label: 'Research Fallback Model #2',
    description: 'Second fallback model for LinkedIn draft runs (recommended: OpenAI gpt-4.1 API)',
    type: 'string',
  },
  {
    key: 'linkedin.researchFallbackModel3',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Research Fallback Model #3',
    description: 'Third fallback model for LinkedIn draft runs (optional)',
    type: 'string',
  },
  {
    key: 'linkedin.dailyLimit',
    defaultValue: '15',
    encrypted: false,
    category: 'linkedin',
    label: 'Daily Limit',
    description: 'Daily auto-post cap. 15 is the recommended safe limit; you can raise it up to 50.',
    type: 'number',
  },
  {
    key: 'linkedin.dailyLimitMin',
    defaultValue: '8',
    encrypted: false,
    category: 'linkedin',
    label: 'Daily Limit Min',
    description: 'Minimum daily auto-post limit (random between min and max)',
    type: 'number',
  },
  {
    key: 'linkedin.dailyLimitMax',
    defaultValue: '18',
    encrypted: false,
    category: 'linkedin',
    label: 'Daily Limit Max',
    description: 'Maximum daily auto-post limit (random between min and max)',
    type: 'number',
  },
  {
    key: 'linkedin.autoPosterEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Auto-Poster',
    description: 'Enable automatic posting of approved and scheduled drafts',
    type: 'boolean',
  },
  {
    key: 'linkedin.dayWindowEnabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'linkedin',
    label: 'Day Window Enabled',
    description: 'Allow auto-posting during daytime posting window',
    type: 'boolean',
  },
  {
    key: 'linkedin.dayWindowStart',
    defaultValue: '09:00',
    encrypted: false,
    category: 'linkedin',
    label: 'Day Window Start',
    description: 'Local start time for daytime auto-post window (HH:MM)',
    type: 'string',
  },
  {
    key: 'linkedin.dayWindowEnd',
    defaultValue: '18:00',
    encrypted: false,
    category: 'linkedin',
    label: 'Day Window End',
    description: 'Local end time for daytime auto-post window (HH:MM)',
    type: 'string',
  },
  {
    key: 'linkedin.dayWindowIntervalMin',
    defaultValue: '45',
    encrypted: false,
    category: 'linkedin',
    label: 'Day Window Interval (min)',
    description: 'Minimum spacing between auto-posted comments during daytime window',
    type: 'number',
  },
  {
    key: 'linkedin.nightWindowEnabled',
    defaultValue: 'false',
    encrypted: false,
    category: 'linkedin',
    label: 'Night Window Enabled',
    description: 'Allow auto-posting during overnight posting window',
    type: 'boolean',
  },
  {
    key: 'linkedin.nightWindowStart',
    defaultValue: '22:00',
    encrypted: false,
    category: 'linkedin',
    label: 'Night Window Start',
    description: 'Local start time for overnight auto-post window (HH:MM)',
    type: 'string',
  },
  {
    key: 'linkedin.nightWindowEnd',
    defaultValue: '06:00',
    encrypted: false,
    category: 'linkedin',
    label: 'Night Window End',
    description: 'Local end time for overnight auto-post window (HH:MM)',
    type: 'string',
  },
  {
    key: 'linkedin.nightWindowIntervalMin',
    defaultValue: '120',
    encrypted: false,
    category: 'linkedin',
    label: 'Night Window Interval (min)',
    description: 'Minimum spacing between auto-posted comments during overnight window',
    type: 'number',
  },
  {
    key: 'linkedin.recoveryRebalanceEnabled',
    defaultValue: 'true',
    encrypted: false,
    category: 'linkedin',
    label: 'Recovery Rebalance Enabled',
    description: 'When the app launches or wakes after downtime, reschedule stale posts and rebalance the pending queue automatically',
    type: 'boolean',
  },
  {
    key: 'linkedin.lightDaysPerWeek',
    defaultValue: '0',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Days Per Week',
    description: 'Number of lower-volume days per week, selected automatically and spread more broadly',
    type: 'number',
  },
  {
    key: 'linkedin.lightDayMinPosts',
    defaultValue: '10',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day Min Posts',
    description: 'Minimum post cap for a light day',
    type: 'number',
  },
  {
    key: 'linkedin.lightDayMaxPosts',
    defaultValue: '10',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day Max Posts',
    description: 'Maximum post cap for a light day',
    type: 'number',
  },
  {
    key: 'linkedin.lightDay1Weekday',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day #1 Weekday',
    description: 'Exact weekday for the first manually controlled light day (overrides automatic light-day selection)',
    type: 'string',
  },
  {
    key: 'linkedin.lightDay1MinPosts',
    defaultValue: '10',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day #1 Min Posts',
    description: 'Minimum posts for manually controlled light day #1',
    type: 'number',
  },
  {
    key: 'linkedin.lightDay1MaxPosts',
    defaultValue: '10',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day #1 Max Posts',
    description: 'Maximum posts for manually controlled light day #1',
    type: 'number',
  },
  {
    key: 'linkedin.lightDay2Weekday',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day #2 Weekday',
    description: 'Exact weekday for the second manually controlled light day (overrides automatic light-day selection)',
    type: 'string',
  },
  {
    key: 'linkedin.lightDay2MinPosts',
    defaultValue: '10',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day #2 Min Posts',
    description: 'Minimum posts for manually controlled light day #2',
    type: 'number',
  },
  {
    key: 'linkedin.lightDay2MaxPosts',
    defaultValue: '10',
    encrypted: false,
    category: 'linkedin',
    label: 'Light Day #2 Max Posts',
    description: 'Maximum posts for manually controlled light day #2',
    type: 'number',
  },
  {
    key: 'linkedin.voicePresets',
    defaultValue: '',
    encrypted: false,
    category: 'linkedin',
    label: 'Voice Presets (JSON)',
    description: 'JSON array of voice presets for comment variety',
    type: 'string',
  },
  {
    key: 'linkedin.authorMaxCommentsPerWeek',
    defaultValue: '2',
    encrypted: false,
    category: 'linkedin',
    label: 'Max Comments/Author/Week',
    description: 'Maximum comments on a single author per week',
    type: 'number',
  },

  // Window state settings
  {
    key: 'window.chatBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Chat Window Bounds',
    description: 'Saved position and size of chat window (JSON)',
    type: 'string',
  },
  {
    key: 'window.cronBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Cron Window Bounds',
    description: 'Saved position and size of cron window (JSON)',
    type: 'string',
  },
  {
    key: 'window.settingsBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Settings Window Bounds',
    description: 'Saved position and size of settings window (JSON)',
    type: 'string',
  },
  {
    key: 'window.factsGraphBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Facts Graph Window Bounds',
    description: 'Saved position and size of facts graph window (JSON)',
    type: 'string',
  },
  {
    key: 'window.customizeBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Customize Window Bounds',
    description: 'Saved position and size of customize window (JSON)',
    type: 'string',
  },
  {
    key: 'window.factsBounds',
    defaultValue: '',
    encrypted: false,
    category: 'window',
    label: 'Facts Window Bounds',
    description: 'Saved position and size of facts window (JSON)',
    type: 'string',
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

class SettingsManagerClass {
  private static instance: SettingsManagerClass | null = null;
  private db: Database.Database | null = null;
  private cache: Map<string, string> = new Map();
  private initialized: boolean = false;

  private constructor() {}

  static getInstance(): SettingsManagerClass {
    if (!SettingsManagerClass.instance) {
      SettingsManagerClass.instance = new SettingsManagerClass();
    }
    return SettingsManagerClass.instance;
  }

  /**
   * Initialize settings with database path
   */
  initialize(dbPath: string): void {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.createTable();
    this.loadDefaults();
    this.loadToCache();
    this.initialized = true;
    console.log('[Settings] Initialized');
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

  /**
   * Load default settings that don't exist yet
   */
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

  /**
   * Load all settings to memory cache
   */
  private loadToCache(): void {
    if (!this.db) return;

    const rows = this.db.prepare('SELECT key, value, encrypted FROM settings').all() as Array<{
      key: string;
      value: string;
      encrypted: number;
    }>;

    for (const row of rows) {
      let value = row.value;

      // Decrypt if needed
      if (row.encrypted && value) {
        try {
          value = this.decrypt(value);
        } catch {
          // Decryption failed (app re-signed, keychain issue, etc.)
          // Store empty string — NOT the encrypted blob, which would look like a valid value
          // and cause silent failures (e.g. hasRequiredKeys() returning true with corrupt token).
          console.warn(`[Settings] Failed to decrypt ${row.key} — clearing cached value`);
          value = '';
        }
      }

      this.cache.set(row.key, value);
    }
  }

  /**
   * Encrypt a value using safeStorage
   */
  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[Settings] Encryption not available, storing as plain text');
      return value;
    }
    const encrypted = safeStorage.encryptString(value);
    return encrypted.toString('base64');
  }

  /**
   * Decrypt a value using safeStorage
   */
  private decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return encrypted;
    }
    const buffer = Buffer.from(encrypted, 'base64');
    return safeStorage.decryptString(buffer);
  }

  /**
   * Get a setting value
   */
  get(key: string): string {
    if (!this.initialized) {
      console.warn('[Settings] Not initialized, returning default');
      const def = SETTINGS_SCHEMA.find(s => s.key === key);
      return def?.defaultValue || '';
    }

    return this.cache.get(key) || '';
  }

  /**
   * Get a setting as a specific type
   */
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
      // Try JSON parse first
      if (value.startsWith('[')) {
        return JSON.parse(value);
      }
      // Fall back to comma-separated
      return value.split(',').map(s => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Set a setting value
   */
  set(key: string, value: string, encrypted?: boolean): void {
    if (!this.db) {
      console.warn('[Settings] Not initialized, cannot save:', key);
      return;
    }

    // Determine if should be encrypted
    const def = SETTINGS_SCHEMA.find(s => s.key === key);
    const shouldEncrypt = encrypted ?? def?.encrypted ?? false;
    const category = def?.category || 'general';

    // Encrypt if needed
    let storedValue = value;
    if (shouldEncrypt && value) {
      storedValue = this.encrypt(value);
    }

    // Update database
    this.db.prepare(`
      INSERT INTO settings (key, value, encrypted, category, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        encrypted = excluded.encrypted,
        updated_at = excluded.updated_at
    `).run(key, storedValue, shouldEncrypt ? 1 : 0, category);

    // Update cache with unencrypted value
    this.cache.set(key, value);

    console.log(`[Settings] Updated: ${key}`);
  }

  /**
   * Delete a setting
   */
  delete(key: string): boolean {
    if (!this.db) return false;

    const result = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    this.cache.delete(key);

    return result.changes > 0;
  }

  /**
   * Get all settings
   */
  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Get all settings with encrypted values redacted.
   * Safe to send to renderer processes.
   */
  getAllSafe(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      const def = SETTINGS_SCHEMA.find(s => s.key === key);
      if (def?.encrypted && value) {
        result[key] = '••••••••';
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Get all settings by category
   */
  getByCategory(category: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const def of SETTINGS_SCHEMA) {
      if (def.category === category) {
        result[def.key] = this.get(def.key);
      }
    }
    return result;
  }

  /**
   * Get schema for a category
   */
  getSchema(category?: string): SettingDefinition[] {
    if (category) {
      return SETTINGS_SCHEMA.filter(s => s.category === category);
    }
    return SETTINGS_SCHEMA;
  }

  /**
   * Check if required authentication is set
   * Returns true if any supported LLM provider key is configured (or OAuth)
   */
  hasRequiredKeys(): boolean {
    const authMethod = this.get('auth.method');

    // Check for OAuth authentication
    if (authMethod === 'oauth') {
      const oauthToken = this.get('auth.oauthToken');
      return !!oauthToken;
    }

    // Check for API key authentication (any supported provider)
    const anthropicKey = this.get('anthropic.apiKey');
    const moonshotKey = this.get('moonshot.apiKey');
    const glmKey = this.get('glm.apiKey');
    const minimaxKey = this.get('minimax.apiKey');
    const qwenKey = this.get('qwen.apiKey');
    const openRouterKey = this.get('openrouter.apiKey');
    return !!anthropicKey || !!moonshotKey || !!glmKey || !!minimaxKey || !!qwenKey || !!openRouterKey;
  }

  /**
   * Get the current authentication method
   */
  getAuthMethod(): 'api_key' | 'oauth' | null {
    const method = this.get('auth.method');
    if (method === 'oauth' || method === 'api_key') {
      return method;
    }
    // Legacy check - if API key exists, assume api_key method
    if (this.get('anthropic.apiKey')) {
      return 'api_key';
    }
    return null;
  }

  /**
   * Check if first run (no authentication set)
   */
  isFirstRun(): boolean {
    return !this.hasRequiredKeys();
  }

  /**
   * Initialize keychain access by triggering a test encryption.
   * This prompts macOS for keychain permission upfront during onboarding
   * rather than surprising users later when saving API keys.
   * Returns true if encryption is available and working.
   */
  initializeKeychain(): { available: boolean; error?: string } {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return { available: false, error: 'Encryption not available on this system' };
      }
      // Trigger keychain access with a test encryption
      const testValue = 'keychain-init-test';
      const encrypted = safeStorage.encryptString(testValue);
      const decrypted = safeStorage.decryptString(encrypted);
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

  /**
   * Get formatted user profile for agent context
   */
  getFormattedProfile(): string {
    const name = this.get('profile.name');
    const location = this.get('profile.location');
    const timezone = this.get('profile.timezone');
    const occupation = this.get('profile.occupation');
    const birthday = this.get('profile.birthday');
    const custom = this.get('profile.custom');

    // If no profile data, return empty string
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

  /**
   * Validate an API key by making a test call
   */
  async validateAnthropicKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateOpenAIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateTelegramToken(token: string): Promise<{ valid: boolean; error?: string; botInfo?: unknown }> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await response.json();

      if (data.ok) {
        return { valid: true, botInfo: data.result };
      }

      return { valid: false, error: data.description || 'Invalid token' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  /**
   * Validate a Moonshot/Kimi API key by making a test call
   */
  async validateMoonshotKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Moonshot uses Anthropic-compatible API with Bearer token auth
      const response = await fetch('https://api.moonshot.ai/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'kimi-k2.5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateMinimaxKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.minimax.io/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'MiniMax-M2.5-Lightning',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateQwenKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'qwen3.5-plus-2026-02-15',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || data.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateOpenRouterKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'HTTP-Referer': 'https://github.com/google-gemini/pocket-agent',
          'X-Title': 'Pocket Agent',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-lite:free',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || data.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  async validateGlmKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Z.AI GLM uses Anthropic-compatible API with Bearer token auth
      const response = await fetch('https://api.z.ai/api/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'glm-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        return { valid: true };
      }

      const data = await response.json();
      return { valid: false, error: data.error?.message || 'Invalid API key' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  /**
   * Get API keys as environment variables for skill execution.
   * Maps settings keys to the environment variable names that skills expect.
   * Returns empty object if SettingsManager is not initialized yet.
   */
  getApiKeysAsEnv(): Record<string, string> {
    if (!this.initialized) {
      return {};
    }

    const env: Record<string, string> = {};

    // Map settings keys to environment variable names
    const keyMappings: Record<string, string> = {
      'openai.apiKey': 'OPENAI_API_KEY',
      'gemini.apiKey': 'GEMINI_API_KEY',
      'zhipu.apiKey': 'ZHIPU_API_KEY',
      'anthropic.apiKey': 'ANTHROPIC_API_KEY',
      'moonshot.apiKey': 'MOONSHOT_API_KEY',
      'minimax.apiKey': 'MINIMAX_API_KEY',
      'qwen.apiKey': 'QWEN_API_KEY',
      'openrouter.apiKey': 'OPENROUTER_API_KEY',
    };

    for (const [settingKey, envVar] of Object.entries(keyMappings)) {
      const value = this.get(settingKey);
      if (value) {
        env[envVar] = value;
      }
    }

    return env;
  }

  /**
   * Check if a specific API key is configured.
   * Returns false if SettingsManager is not initialized yet.
   */
  hasApiKey(envVarName: string): boolean {
    if (!this.initialized) {
      return false;
    }

    const reverseMapping: Record<string, string> = {
      'OPENAI_API_KEY': 'openai.apiKey',
      'GEMINI_API_KEY': 'gemini.apiKey',
      'ZHIPU_API_KEY': 'zhipu.apiKey',
      'ANTHROPIC_API_KEY': 'anthropic.apiKey',
      'MOONSHOT_API_KEY': 'moonshot.apiKey',
      'MINIMAX_API_KEY': 'minimax.apiKey',
      'QWEN_API_KEY': 'qwen.apiKey',
      'OPENROUTER_API_KEY': 'openrouter.apiKey',
    };

    const settingKey = reverseMapping[envVarName];
    if (!settingKey) return false;

    return !!this.get(settingKey);
  }

  /**
   * Export settings for backup (excluding encrypted values)
   */
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

  /**
   * Import settings from backup
   */
  importSettings(settings: Record<string, string>): void {
    for (const [key, value] of Object.entries(settings)) {
      if (value !== '***ENCRYPTED***') {
        this.set(key, value);
      }
    }
  }

  /**
   * Migrate settings from old config.json file
   */
  async migrateFromConfig(configPath: string): Promise<boolean> {
    try {
      const fs = await import('fs');
      if (!fs.existsSync(configPath)) {
        return false;
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);

      // Migrate Anthropic settings
      if (config.anthropic?.apiKey) {
        this.set('anthropic.apiKey', config.anthropic.apiKey);
      }
      if (config.anthropic?.model) {
        this.set('agent.model', config.anthropic.model);
      }

      // Migrate OpenAI settings
      if (config.openai?.apiKey) {
        this.set('openai.apiKey', config.openai.apiKey);
      }

      // Migrate Telegram settings
      if (config.telegram?.botToken) {
        this.set('telegram.botToken', config.telegram.botToken);
      }
      if (config.telegram?.enabled !== undefined) {
        this.set('telegram.enabled', config.telegram.enabled.toString());
      }
      if (config.telegram?.allowedUserIds?.length) {
        this.set('telegram.allowedUserIds', JSON.stringify(config.telegram.allowedUserIds));
      }

      // Migrate scheduler settings
      if (config.scheduler?.enabled !== undefined) {
        this.set('scheduler.enabled', config.scheduler.enabled.toString());
      }

      // Migrate browser settings
      if (config.tools?.browser?.enabled !== undefined) {
        this.set('browser.enabled', config.tools.browser.enabled.toString());
      }
      if (config.tools?.browser?.cdpUrl) {
        this.set('browser.cdpUrl', config.tools.browser.cdpUrl);
      }

      console.log('[Settings] Migrated settings from config.json');

      // Rename the old config file to indicate migration
      fs.renameSync(configPath, configPath + '.migrated');

      return true;
    } catch (error) {
      console.error('[Settings] Migration failed:', error);
      return false;
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }
}

export const SettingsManager = SettingsManagerClass.getInstance();

/**
 * Telegram command handlers
 * /start, /help, /status, /model, /new, /facts, /workflow, /link, /unlink, /mychatid
 */

import { Context, Bot } from 'grammy';
import { AgentManager } from '../../../agent';
import { SettingsManager } from '../../../settings';
import { SessionLinkCallback } from '../types';
import { loadWorkflowCommands } from '../../../config/commands-loader';

export interface CommandHandlerDeps {
  bot: Bot;
  onSessionLinkCallback: SessionLinkCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Register all command handlers on the bot
 */
export function registerCommandHandlers(deps: CommandHandlerDeps): void {
  const { bot, sendResponse } = deps;

  // /start command
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    await ctx.reply(
      `Welcome to Pocket Agent!\n\n` +
      `I'm your personal AI assistant with persistent memory. ` +
      `I remember our conversations across sessions.\n\n` +
      `Your user ID: ${userId}\n\n` +
      `Commands:\n` +
      `/help - How to use Pocket Agent\n` +
      `/new - Fresh start (keeps facts & reminders)\n` +
      `/model - List or switch AI models\n` +
      `/status - Show agent status\n` +
      `/restart - Stop stuck query\n` +
      `/facts [query] - Search stored facts\n` +
      `/workflow - List available workflows` +
      (isGroup ? `\n/link <session> - Link this group to a session\n/unlink - Unlink this group` : '')
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    const helpText =
`<b>Pocket Agent</b>

Your AI assistant with persistent memory. I remember our conversations and learn about you over time.

<b>Commands</b>
/new - Clear chat history (fresh start)
/model - View or switch AI models
/status - See stats and memory usage
/restart - Stop stuck query
/facts - Browse what I remember about you
/workflow - List available workflows

<b>Workflows</b>
Workflows are reusable command templates. Use /workflow to see what's available, then run them directly (e.g. /create-workflow).

<b>Tips</b>
* Send text, photos, or voice messages
* I remember context across sessions
* Use /new to reset without losing memories`;

    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // /status command
  bot.command('status', async (ctx) => {
    const stats = AgentManager.getStats();
    if (!stats) {
      await ctx.reply('Agent not initialized');
      return;
    }

    const memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;

    await ctx.reply(
      `Agent Status\n` +
      `--------------------\n` +
      `Messages: ${stats.messageCount}\n` +
      `Facts: ${stats.factCount}\n` +
      `Cron Jobs: ${stats.cronJobCount}\n` +
      `Summaries: ${stats.summaryCount}\n` +
      `Est. Tokens: ${stats.estimatedTokens.toLocaleString()}\n` +
      `Memory: ${memoryMB.toFixed(1)} MB`
    );
  });

  // /mychatid command
  bot.command('mychatid', async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    await ctx.reply(
      `Your IDs for cron job configuration:\n\n` +
      `Chat ID: ${chatId}\n` +
      `User ID: ${userId}\n\n` +
      `Use the Chat ID when scheduling tasks that should message you.`
    );
  });

  // /new command (fresh start - session-aware)
  bot.command('new', async (ctx) => {
    const chatId = ctx.chat?.id;
    const memory = AgentManager.getMemory();
    const sessionId = chatId && memory ? memory.getSessionForChat(chatId) || 'default' : 'default';

    AgentManager.clearConversation(sessionId);
    AgentManager.clearSdkSessionMapping(sessionId);
    await ctx.reply('Fresh start! Conversation cleared.\nDon\'t worry - I still remember everything about you.');
  });

  // /facts command
  bot.command('facts', async (ctx) => {
    const query = ctx.message?.text?.replace('/facts', '').trim();

    if (!query) {
      // List all facts grouped by category
      const facts = AgentManager.getAllFacts();
      if (facts.length === 0) {
        await ctx.reply('No facts stored yet.\n\nI learn facts when you tell me things about yourself, or when I use the remember tool.');
        return;
      }

      // Group by category
      const byCategory = new Map<string, typeof facts>();
      for (const fact of facts) {
        const list = byCategory.get(fact.category) || [];
        list.push(fact);
        byCategory.set(fact.category, list);
      }

      const lines: string[] = [`Known Facts (${facts.length} total)`];
      for (const [category, categoryFacts] of byCategory) {
        lines.push(`\n${category}`);
        for (const fact of categoryFacts) {
          lines.push(`  * ${fact.subject}: ${fact.content}`);
        }
      }

      await sendResponse(ctx, lines.join('\n'));
      return;
    }

    const facts = AgentManager.searchFacts(query);
    if (facts.length === 0) {
      await ctx.reply(`No facts found for "${query}"`);
      return;
    }

    const response = facts
      .slice(0, 15)
      .map(f => `[${f.category}] ${f.subject}: ${f.content}`)
      .join('\n');

    await ctx.reply(`Found ${facts.length} fact(s):\n\n${response}`);
  });

  // /workflow command - list available workflows
  bot.command('workflow', async (ctx) => {
    const commands = loadWorkflowCommands();

    if (commands.length === 0) {
      await ctx.reply('No workflows available.\n\nWorkflows are command files in .claude/commands/');
      return;
    }

    const list = commands
      .map(c => `/${c.name} - ${c.description || 'No description'}`)
      .join('\n');

    await ctx.reply(
      `<b>Available Workflows</b>\n\n${list}\n\n` +
      `Run a workflow by typing its command, e.g. /${commands[0].name}`,
      { parse_mode: 'HTML' }
    );
  });

  // /model command
  bot.command('model', async (ctx) => {
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    const subcommand = args[0]?.toLowerCase();

    // Get available models based on configured API keys
    const availableModels: Array<{ id: string; name: string; provider: string }> = [];

    const authMethod = SettingsManager.get('auth.method');
    const hasOAuth = authMethod === 'oauth' && SettingsManager.get('auth.oauthToken');
    const hasAnthropicKey = SettingsManager.get('anthropic.apiKey');

    if (hasOAuth || hasAnthropicKey) {
      availableModels.push(
        { id: 'claude-opus-4-6', name: 'Opus 4.6', provider: 'Anthropic' },
        { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', provider: 'Anthropic' },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', provider: 'Anthropic' }
      );
    }

    if (SettingsManager.get('moonshot.apiKey')) {
      availableModels.push({ id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'Moonshot' });
    }

    if (SettingsManager.get('glm.apiKey')) {
      availableModels.push({ id: 'glm-4.7', name: 'GLM 4.7', provider: 'Z.AI' });
    }

    const currentModel = AgentManager.getModel();

    // /model or /model list - show available models
    if (!subcommand || subcommand === 'list') {
      if (availableModels.length === 0) {
        await ctx.reply('No models available. Please configure API keys in Settings.');
        return;
      }

      const modelList = availableModels
        .map(m => {
          const isCurrent = m.id === currentModel ? ' [x]' : '';
          return `* ${m.name}${isCurrent}`;
        })
        .join('\n');

      await ctx.reply(
        `Available models:\n\n${modelList}\n\n` +
        `Use /model <name> to switch.\n` +
        `Example: /model sonnet`
      );
      return;
    }

    // /model <name> - switch to that model
    const searchTerm = subcommand;
    const matchedModel = availableModels.find(m =>
      m.id.toLowerCase().includes(searchTerm) ||
      m.name.toLowerCase().includes(searchTerm)
    );

    if (!matchedModel) {
      await ctx.reply(
        `Model "${searchTerm}" not found.\n\n` +
        `Available: ${availableModels.map(m => m.name).join(', ')}`
      );
      return;
    }

    if (matchedModel.id === currentModel) {
      await ctx.reply(`Already using ${matchedModel.name}.`);
      return;
    }

    AgentManager.setModel(matchedModel.id);
    await ctx.reply(`Switched to ${matchedModel.name}.`);
  });

  // /voice command - toggle voice replies
  bot.command('voice', async (ctx) => {
    const current = SettingsManager.getBoolean('telegram.voiceReplies');
    const newValue = !current;
    SettingsManager.set('telegram.voiceReplies', String(newValue));
    await ctx.reply(newValue
      ? 'Voice replies ON — I\'ll send voice summaries with my text replies.'
      : 'Voice replies OFF — text only.');
  });

  // /restart command - abort any stuck processing
  bot.command('restart', async (ctx) => {
    const chatId = ctx.chat?.id;
    const memory = AgentManager.getMemory();
    const sessionId = chatId && memory ? memory.getSessionForChat(chatId) || 'default' : 'default';

    const wasProcessing = AgentManager.isQueryProcessing(sessionId);

    if (wasProcessing) {
      AgentManager.stopQuery(sessionId, true);
      await ctx.reply('⚡ Stopped running query and cleared queue.\nReady for new messages.');
    } else {
      // Check if any session is stuck
      const anyProcessing = AgentManager.isQueryProcessing();
      if (anyProcessing) {
        AgentManager.stopQuery(undefined, true);
        await ctx.reply('⚡ Stopped stuck query (different session).\nReady for new messages.');
      } else {
        await ctx.reply('No active query to stop. Agent is ready.');
      }
    }
  });

  // /unanswered command - list threads needing response
  bot.command('unanswered', async (ctx) => {
    const arg = ctx.message?.text?.replace('/unanswered', '').trim() || '';
    try {
      const { getUnansweredEngine } = await import('../../../scheduler/unanswered-engine');
      const engine = getUnansweredEngine();
      if (!engine) {
        await ctx.reply('Unanswered engine not initialized. Enable it in Settings > Email Processing > Unanswered.');
        return;
      }

      const filter: { labels?: string[]; ageMinutesGt?: number; state?: string; limit?: number } = { state: 'unanswered', limit: 20 };
      if (arg) {
        const labelMatch = arg.match(/label:(\S+)/);
        if (labelMatch) filter.labels = [labelMatch[1]];
        const ageMatch = arg.match(/age:(\d+)([hm])/);
        if (ageMatch) {
          const val = parseInt(ageMatch[1], 10);
          filter.ageMinutesGt = ageMatch[2] === 'h' ? val * 60 : val;
        }
      }

      const threads = engine.list(filter);
      if (threads.length === 0) {
        await ctx.reply('No unanswered threads found.');
        return;
      }

      const lines = threads.map((t, i) =>
        `${i + 1}. ${t.subject || '(no subject)'}\n   From: ${t.sender || 'unknown'} | ${t.label || '-'}\n   Since: ${t.first_seen_at}`,
      );

      await sendResponse(ctx, `Unanswered threads (${threads.length}):\n\n${lines.join('\n\n')}`);
    } catch (err) {
      console.warn('[Telegram] /unanswered failed:', err);
      await ctx.reply('Failed to fetch unanswered threads.');
    }
  });

  // Kanban commands
  bot.command('approve', async (ctx) => {
    const text = ctx.message?.text?.replace('/approve', '').trim() || '';
    const taskId = parseInt(text.split(/\s+/)[0], 10);
    if (!taskId) {
      await ctx.reply('Usage: /approve [task_id]');
      return;
    }
    try {
      const { KanbanService } = await import('../../../kanban');
      const task = KanbanService.approveTask(taskId);
      if (task) {
        await ctx.reply(`Approved: #${task.id} ${task.title}\nMoved to Done.`);
      } else {
        await ctx.reply(`Task #${taskId} not found.`);
      }
    } catch {
      await ctx.reply('Failed to approve task.');
    }
  });

  bot.command('reject', async (ctx) => {
    const text = ctx.message?.text?.replace('/reject', '').trim() || '';
    const parts = text.split(/\s+/);
    const taskId = parseInt(parts[0], 10);
    const feedback = parts.slice(1).join(' ') || 'Rejected';
    if (!taskId) {
      await ctx.reply('Usage: /reject [task_id] [feedback]');
      return;
    }
    try {
      const { KanbanService } = await import('../../../kanban');
      const task = KanbanService.rejectTask(taskId, feedback);
      if (task) {
        await ctx.reply(`Rejected: #${task.id} ${task.title}\nFeedback: ${feedback}\nMoved back to In Progress.`);
      } else {
        await ctx.reply(`Task #${taskId} not found.`);
      }
    } catch {
      await ctx.reply('Failed to reject task.');
    }
  });
}

/**
 * Register session linking handlers
 */
export function registerSessionHandlers(deps: CommandHandlerDeps): void {
  const { bot, onSessionLinkCallback } = deps;

  // Handle bot being added to a group - auto-link to session
  bot.on('my_chat_member', async (ctx) => {
    const chatId = ctx.chat?.id;
    const newStatus = ctx.myChatMember?.new_chat_member?.status;
    const chatType = ctx.chat?.type;

    // Only handle when bot is added to a group (not kicked/left)
    if (!chatId || !['member', 'administrator'].includes(newStatus || '')) {
      return;
    }

    // Only handle group chats (not private chats)
    if (chatType !== 'group' && chatType !== 'supergroup') {
      return;
    }

    const groupName = ctx.chat?.title || '';
    console.log(`[Telegram] Bot added to group "${groupName}" (chatId: ${chatId})`);

    // Try to match group name to a session
    const memory = AgentManager.getMemory();
    if (!memory) {
      await ctx.reply('Memory not initialized. Please try again later.');
      return;
    }

    const session = memory.getSessionByName(groupName);
    if (session) {
      // Link the chat to the session
      memory.linkTelegramChat(chatId, session.id, groupName);
      await ctx.reply(
        `Linked to session "${session.name}"\n\n` +
        `Messages in this group will now sync with the "${session.name}" session in the desktop app.\n\n` +
        `Note: To see all messages (not just commands), either:\n` +
        `* Make me an admin in this group, OR\n` +
        `* Disable Privacy Mode via @BotFather (/setprivacy -> Disable)`
      );
      console.log(`[Telegram] Linked group "${groupName}" (chatId: ${chatId}) to session "${session.id}"`);
      onSessionLinkCallback?.({ sessionId: session.id, linked: true });
    } else {
      // List available sessions
      const sessions = memory.getSessions();
      const sessionNames = sessions.map(s => `* ${s.name}`).join('\n');
      await ctx.reply(
        `No session found with name "${groupName}"\n\n` +
        `Available sessions:\n${sessionNames}\n\n` +
        `To link this group, rename it to match one of the session names above, or use /link <session-name>.`
      );
    }
  });

  // Handle /link command for manual linking
  bot.command('link', async (ctx) => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    const sessionName = ctx.message?.text?.replace('/link', '').trim();

    if (!chatId) return;

    // Only allow linking in groups
    if (chatType !== 'group' && chatType !== 'supergroup') {
      await ctx.reply('The /link command only works in group chats. Create a group and add me to it first.');
      return;
    }

    if (!sessionName) {
      const memory = AgentManager.getMemory();
      const sessions = memory?.getSessions() || [];
      const sessionNames = sessions.map(s => `* ${s.name}`).join('\n');
      await ctx.reply(
        `Usage: /link <session-name>\n\n` +
        `Available sessions:\n${sessionNames}`
      );
      return;
    }

    const memory = AgentManager.getMemory();
    if (!memory) {
      await ctx.reply('Memory not initialized. Please try again later.');
      return;
    }

    const session = memory.getSessionByName(sessionName);
    if (!session) {
      const sessions = memory.getSessions();
      const sessionNames = sessions.map(s => `* ${s.name}`).join('\n');
      await ctx.reply(
        `No session found with name "${sessionName}"\n\n` +
        `Available sessions:\n${sessionNames}`
      );
      return;
    }

    // Link the chat to the session
    memory.linkTelegramChat(chatId, session.id, ctx.chat?.title || undefined);
    await ctx.reply(
      `Linked to session "${session.name}"\n\n` +
      `Messages in this group will now sync with the "${session.name}" session.\n\n` +
      `Note: To see all messages (not just commands), either:\n` +
      `* Make me an admin in this group, OR\n` +
      `* Disable Privacy Mode via @BotFather (/setprivacy -> Disable)`
    );
    console.log(`[Telegram] Manually linked chat ${chatId} to session "${session.id}"`);
    onSessionLinkCallback?.({ sessionId: session.id, linked: true });
  });

  // Handle /unlink command
  bot.command('unlink', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const memory = AgentManager.getMemory();
    if (!memory) {
      await ctx.reply('Memory not initialized.');
      return;
    }

    const currentSessionId = memory.getSessionForChat(chatId);
    if (!currentSessionId) {
      await ctx.reply('This chat is not linked to any session.');
      return;
    }

    memory.unlinkTelegramChat(chatId);
    await ctx.reply('Chat unlinked. Messages will now go to the default session.');
    console.log(`[Telegram] Unlinked chat ${chatId}`);
    onSessionLinkCallback?.({ sessionId: currentSessionId, linked: false });
  });

}

/**
 * Register the bot's command menu with Telegram API.
 * Call this after bot.start() succeeds (in onStart callback).
 * Includes built-in commands + all workflow commands from .claude/commands/
 */
export async function registerBotCommands(bot: Bot): Promise<void> {
  const builtIn: Array<{ command: string; description: string }> = [
    { command: 'help', description: 'Show available commands' },
    { command: 'status', description: 'Agent status and stats' },
    { command: 'new', description: 'Start a new session' },
    { command: 'model', description: 'View or change AI model' },
    { command: 'workflow', description: 'List available workflows' },
    { command: 'facts', description: 'Show stored facts' },
    { command: 'voice', description: 'Toggle voice replies' },
    { command: 'unanswered', description: 'Scan for unanswered emails' },
    { command: 'link', description: 'Link this chat to a session' },
    { command: 'unlink', description: 'Unlink this chat from a session' },
    { command: 'restart', description: 'Restart agent or Telegram bot' },
  ];

  // Add workflow commands dynamically
  // Telegram allows only [a-z0-9_] in command names, max 32 chars
  const workflows = loadWorkflowCommands();
  const workflowCommands = workflows
    .map(w => ({
      command: w.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32),
      description: (w.description || `Run ${w.name} workflow`).slice(0, 256),
    }))
    .filter(w => !builtIn.some(b => b.command === w.command)); // avoid duplicates

  const allCommands = [...builtIn, ...workflowCommands];

  // Clear all existing command scopes first (removes stale commands from previous bot projects)
  await bot.api.deleteMyCommands();
  await bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } });
  await bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } });

  // Telegram limits to 100 commands
  await bot.api.setMyCommands(allCommands.slice(0, 100));
  console.log(`[Telegram] Registered ${allCommands.length} bot commands (${builtIn.length} built-in + ${workflowCommands.length} workflows)`);
}

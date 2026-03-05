/**
 * Telegram text message handler
 */

import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';
import { setTelegramMessageContext } from '../../../tools/session-context';
import { setActiveChannel } from '../../../tools/voice-tools';
import { SettingsManager } from '../../../settings';
import { findWorkflowCommand } from '../../../config/commands-loader';
import { tryHandleLinkedInNaturalAction } from './linkedin';
import { getTelegramSavedReaction, isTelegramAckReactionEnabled, shouldUseSavedReaction } from '../utils/reaction-policy';

export interface MessageHandlerDeps {
  onMessageCallback: MessageCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

interface RecentMessageLike {
  role: string;
  content: string;
}

function isSaveVerificationFollowUp(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('/')) return false;
  const asksWhere = /\b(where|what|when|did you|have you|is it)\b/.test(normalized);
  const mentionsSave = /\b(save|saved|store|stored|remember|remembered|log|logged|record|recorded)\b/.test(normalized);
  return asksWhere && mentionsSave;
}

function compactSnippet(value: string, max = 320): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function isShortFollowUp(text: string): boolean {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  if (/^\?+$/.test(normalized)) return true;
  if (/^(what|wtf|huh|wat|hm|hmm|why|how)(\?|!)*$/.test(normalized)) return true;
  return normalized.length <= 18;
}

function isContextRecallFollowUp(text: string): boolean {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  return /\b(what did we talk about|what were we talking about|recap|catch me up|summary|summarize|last \d+ messages|previous messages|earlier messages|remind me|what was i saying|what was i asking)\b/.test(normalized);
}

function buildRecentContextSnippet(recentMessages: RecentMessageLike[], maxChars = 800): string {
  if (!recentMessages.length) return '';
  const lines: string[] = [];
  let budget = maxChars;
  for (const msg of recentMessages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const snippet = compactSnippet(String(msg.content || ''), Math.min(220, budget));
    if (!snippet) continue;
    const line = `${role}: ${snippet}`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length + 1;
    if (budget <= 0) break;
  }
  return lines.join('\n');
}

function parseChoiceNumber(text: string): number | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (normalized.length > 40) return null;
  // Ignore timestamps/clock-like text from Telegram quote previews.
  if (/\b\d{1,2}:\d{2}\b/.test(normalized) || /\b(?:am|pm)\b/.test(normalized)) return null;

  const wordMap: Record<string, number> = {
    one: 1,
    first: 1,
    two: 2,
    second: 2,
    three: 3,
    third: 3,
    four: 4,
    fourth: 4,
    five: 5,
    fifth: 5,
    six: 6,
    sixth: 6,
    seven: 7,
    seventh: 7,
    eight: 8,
    eighth: 8,
    nine: 9,
    ninth: 9,
    ten: 10,
    tenth: 10,
  };

  const pickRe = /^(?:yes|yeah|yep|ok|okay|sure|go with|pick|choose|select)?[\s,:-]*(?:option\s*)?(#?[1-9]|10|one|first|two|second|three|third|four|fourth|five|fifth|six|sixth|seven|seventh|eight|eighth|nine|ninth|ten|tenth)\.?$/i;
  const match = normalized.match(pickRe);
  if (!match?.[1]) return null;

  const raw = match[1].replace(/^#/, '').toLowerCase();
  if (/^\d+$/.test(raw)) {
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value >= 1 && value <= 10 ? value : null;
  }
  return wordMap[raw] ?? null;
}

function extractEnumeratedOption(text: string, optionNumber: number): string | null {
  if (!text || !Number.isFinite(optionNumber) || optionNumber < 1) return null;
  const lines = String(text).split(/\r?\n/);
  const numberedRe = new RegExp(`^\\s*${optionNumber}\\.\\s+(.+)`, 'i');

  for (const line of lines) {
    const match = line.match(numberedRe);
    if (match?.[1]) return compactSnippet(match[1], 260);
  }

  // Handle bullets that continue from a "Are you asking about:" line.
  const altRe = new RegExp(`^\\s*${optionNumber}\\)\\s+(.+)`, 'i');
  for (const line of lines) {
    const match = line.match(altRe);
    if (match?.[1]) return compactSnippet(match[1], 260);
  }

  return null;
}

export function buildTelegramTurnHints(
  originalMessage: string,
  recentMessagesNewestFirst: RecentMessageLike[]
): string[] {
  const hints: string[] = [];

  const choiceNumber = parseChoiceNumber(originalMessage);
  const latestAssistantEnumerated = recentMessagesNewestFirst.find(
    m =>
      m.role === 'assistant' &&
      (/(^|\n)\s*1\.\s+/.test(String(m.content || '')) || /are you asking about:/i.test(String(m.content || '')))
  );
  if (choiceNumber && latestAssistantEnumerated) {
    const selected = extractEnumeratedOption(String(latestAssistantEnumerated.content || ''), choiceNumber);
    const selectedText = selected || `option ${choiceNumber}`;
    hints.push(
      `User selected option ${choiceNumber} from your previous list. Interpret it as "${selectedText}" and act on it directly.`
    );
    return hints;
  }

  if (isSaveVerificationFollowUp(originalMessage)) {
    hints.push(
      'User is verifying whether something was saved. Answer only from real tool evidence in this session; if not saved, say so clearly.'
    );
  }

  if (isShortFollowUp(originalMessage)) {
    hints.push(
      'User sent a short follow-up that likely refers to your most recent reply. Use the immediate prior assistant message as context and respond directly.'
    );
  }

  return hints;
}

/**
 * Handle incoming text messages
 */
export async function handleTextMessage(
  ctx: Context,
  deps: MessageHandlerDeps
): Promise<void> {
  let message = ctx.message?.text;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  console.log(`[Telegram:Text] Received message: "${message?.slice(0, 50)}..." chatId=${chatId}`);

  if (!message || !chatId) {
    console.log('[Telegram:Text] No message or chatId, returning early');
    return;
  }
  const originalMessage = message;
  const strictHeuristicsEnabled = SettingsManager.get('telegram.strictHeuristics') === 'true';
  const memory = AgentManager.getMemory();
  const sessionId = memory?.getSessionForChat(chatId) || 'default';
  const recent = memory?.getRecentMessages(12, sessionId) || [];
  const latestFirst = [...recent].reverse();

  // Include quoted reply context so agent sees what the user is responding to
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo) {
    const quotedText = ('text' in replyTo ? replyTo.text : null)
      || ('caption' in replyTo ? replyTo.caption : null);
    if (quotedText) {
      const sender = replyTo.from?.first_name || 'Someone';
      message = `[Replying to ${sender}: "${quotedText.slice(0, 300)}"]\n${message}`;
      console.log(`[Telegram:Text] Reply context added from ${sender}`);
    }
  }

  const shouldIncludeContext = isShortFollowUp(originalMessage) || isContextRecallFollowUp(originalMessage) || !!replyTo;
  if (recent.length > 0 && shouldIncludeContext) {
    const snippet = buildRecentContextSnippet(recent.slice(-4));
    if (snippet) {
      message = `[Recent context]\n${snippet}\n\n${message}`;
    }
  }

  const { onMessageCallback, sendResponse } = deps;

  if (messageId) setTelegramMessageContext({ chatId, messageId });
  setActiveChannel('telegram');

  // Skip built-in commands -grammy's bot.command() should handle these, but
  // if they fall through (Electron/grammy timing issue), don't send to agent
  if (message.startsWith('/')) {
    const spaceIdx = message.indexOf(' ');
    const cmdName = (spaceIdx !== -1 ? message.substring(1, spaceIdx) : message.substring(1))
      .replace(/@\w+$/, '').toLowerCase();
    const builtInCommands = new Set([
      'start', 'help', 'status', 'mychatid', 'new', 'facts', 'workflow',
      'model', 'mode', 'tools', 'diag', 'limode', 'voice', 'restart', 'unanswered', 'approve', 'reject',
      'link', 'unlink',
      'li', 'lidraft', 'liapprove', 'lischedule', 'lireject',
      'linkedin', 'linkedin_draft', 'linkedin_approve', 'linkedin_schedule', 'linkedin_reject',
    ]);
    if (builtInCommands.has(cmdName)) {
      console.log(`[Telegram:Text] Built-in command /${cmdName} fell through to text handler, ignoring`);
      return;
    }
  }

  // Check if this is a workflow slash command (e.g., /create-workflow some context)
  let fullMessage = message;

  // Natural LinkedIn selection actions from Telegram list context.
  // Example: "draft one, two and five".
  const handledNaturalLinkedIn = await tryHandleLinkedInNaturalAction(ctx, message, sendResponse);
  if (handledNaturalLinkedIn) {
    return;
  }

  if (message.startsWith('/')) {
    const spaceIdx = message.indexOf(' ');
    const commandName = (spaceIdx !== -1 ? message.substring(1, spaceIdx) : message.substring(1))
      .replace(/@\w+$/, ''); // Strip @botname suffix
    const userText = spaceIdx !== -1 ? message.substring(spaceIdx + 1).trim() : '';
    // Try exact match first, then try with hyphens instead of underscores (Telegram normalizes to underscores)
    const workflow = findWorkflowCommand(commandName)
      || findWorkflowCommand(commandName.replace(/_/g, '-'));

    console.log(`[Telegram:Text] Slash command: /${commandName}, workflow found: ${!!workflow}`);

    if (workflow) {
      fullMessage = `[Workflow: ${workflow.name}]\n${workflow.content}\n[/Workflow]`;
      if (userText) fullMessage += `\n\n${userText}`;
      console.log(`[Telegram:Text] Executing workflow: ${workflow.name}`);
    } else {
      // Not a workflow -strip leading / so the SDK doesn't intercept it as a slash command
      fullMessage = fullMessage.substring(1);
      console.log(`[Telegram:Text] Unknown command /${commandName}, stripping slash and sending to agent`);
    }
  }

  const turnHints = buildTelegramTurnHints(
    originalMessage,
    latestFirst.map(m => ({ role: m.role, content: String(m.content || '') }))
  );

  if (strictHeuristicsEnabled) {
    console.log('[Telegram:Text] strict heuristics flag is ON (minimal parser currently active)');
  }

  console.log('[Telegram:Text] Starting withTyping...');
  try {
    const result = await withTyping(ctx, async () => {
      console.log('[Telegram:Text] Inside withTyping, getting sessionId...');
      console.log(`[Telegram:Text] SessionId=${sessionId}, calling processMessage...`);

      const res = await AgentManager.processMessage(
        fullMessage,
        'telegram',
        sessionId,
        undefined,
        undefined,
        turnHints.length > 0 ? { hints: turnHints } : undefined
      );
      console.log(`[Telegram:Text] processMessage returned, response length=${res.response.length}`);
      return res;
    });
    console.log('[Telegram:Text] withTyping completed successfully');

    await sendResponse(ctx, result.response);

    // If this turn saved/logged something, promote reaction from ack -> saved.
    if (chatId && messageId && isTelegramAckReactionEnabled() && shouldUseSavedReaction(originalMessage, result.response)) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.reactToMessage(chatId, messageId, getTelegramSavedReaction());
      }
    }

    // Send media photos if present
    if (result.media && result.media.length > 0 && ctx.chat?.id) {
      const { getTelegramBot } = await import('../index');
      const bot = getTelegramBot();
      if (bot) {
        await bot.sendPhotos(ctx.chat.id, result.media);
      }
    }

    // Notify callback for cross-channel sync (to desktop)
    if (onMessageCallback) {
      onMessageCallback({
        userMessage: message,
        response: result.response,
        channel: 'telegram',
        chatId,
        sessionId,
        wasCompacted: result.wasCompacted,
        media: result.media,
      });
    }

    if (result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`⚠️ ${errorMsg}`);
  } finally {
    setTelegramMessageContext(null);
    setActiveChannel('desktop');
  }
}

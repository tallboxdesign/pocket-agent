/**
 * Telegram reaction policy helpers.
 * Keeps emoji behavior centralized for inbound acknowledgements and save events.
 */

import { SettingsManager } from '../../../settings';
import { AgentReactions } from '../features/reactions';
import { ReactionEmoji } from '../types';

const SAVE_INTENT_RE =
  /\b(save|remember|note|store|log|add|create|record|track|backlog|kanban|daily log|my brain|mind map|project)\b/i;
const SAVE_SUCCESS_RE =
  /\b(saved|remembered|noted|stored|logged|added|created|recorded|captured|linked|queued|scheduled|updated)\b/i;
const SAVE_FAILURE_RE =
  /\b(cannot|can't|unable|failed|failure|error|did not|didn't|not saved|could not|won't)\b/i;

function asReactionEmoji(raw: string | undefined, fallback: ReactionEmoji): ReactionEmoji {
  const value = String(raw || '').trim();
  if (!value) return fallback;
  return value as ReactionEmoji;
}

export function isTelegramAckReactionEnabled(): boolean {
  // Defaults to enabled unless explicitly turned off.
  return SettingsManager.get('telegram.reactionAckEnabled') !== 'false';
}

export function getTelegramAckReaction(): ReactionEmoji {
  return asReactionEmoji(
    SettingsManager.get('telegram.reactionAckEmoji'),
    AgentReactions.acknowledge
  );
}

export function getTelegramSavedReaction(): ReactionEmoji {
  return asReactionEmoji(
    SettingsManager.get('telegram.reactionSavedEmoji'),
    AgentReactions.love
  );
}

export function shouldUseSavedReaction(userInput: string, agentResponse: string): boolean {
  const input = String(userInput || '').toLowerCase();
  const response = String(agentResponse || '').toLowerCase();
  if (!response) return false;
  if (SAVE_FAILURE_RE.test(response)) return false;

  // Strong save signal in response is the primary trigger.
  if (!SAVE_SUCCESS_RE.test(response)) return false;

  // If user explicitly asked to save/log, treat as save action.
  if (SAVE_INTENT_RE.test(input)) return true;

  // Also allow save acknowledgements that clearly mention stored artifacts.
  return /\b(task|backlog|daily log|memory|project|kanban|mind map|entry)\b/i.test(response);
}


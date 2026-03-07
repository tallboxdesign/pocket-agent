/**
 * Telegram reaction policy helpers.
 * Keeps emoji behavior centralized for inbound acknowledgements and save events.
 */

import { SettingsManager } from '../../../settings';
import { AgentReactions } from '../features/reactions';
import { ReactionEmoji } from '../types';

const SAVE_INTENT_RE =
  /\b(save|remember|note|store|log|record|track|add\s+(?:to|into)|create\s+(?:task|entry|note|log))\b/i;
const SAVE_SUCCESS_RE =
  /\b(saved|remembered|noted|stored|logged|added|created|recorded|captured|linked|queued|scheduled|updated)\b/i;
const SAVE_FAILURE_RE =
  /\b(cannot|can't|unable|failed|failure|error|did not|didn't|not saved|could not|won't)\b/i;
const LOOKUP_ONLY_SAVE_RE =
  /\b(where|what|when|did you|have you|which|show|find)\b[\s\S]{0,80}\b(save|saved|remember|stored|logged|recorded)\b/i;
const EXECUTED_NOW_RE =
  /\b(just saved|saved now|saved it now|created task #?\d+|created an entry|logged this now|recorded this now)\b/i;

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

  // If the user is asking "where/what did you save", don't send ❤️ unless this
  // turn actually performs a fresh save operation right now.
  if (LOOKUP_ONLY_SAVE_RE.test(input) && !EXECUTED_NOW_RE.test(response)) {
    return false;
  }

  // Strong save signal in response is the primary trigger.
  if (!SAVE_SUCCESS_RE.test(response)) return false;

  // If user explicitly asked to save/log, treat as save action.
  if (SAVE_INTENT_RE.test(input)) return true;

  // Also allow save acknowledgements that clearly mention stored artifacts.
  return /\b(task|backlog|daily log|memory|project|kanban|mind map|entry)\b/i.test(response);
}

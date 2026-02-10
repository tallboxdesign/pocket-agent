/**
 * Session context for MCP tools
 *
 * Uses AsyncLocalStorage to propagate session context through async call chains,
 * preventing race conditions when concurrent sessions call executeMessage().
 * Each concurrent execution has its own isolated context without changing
 * any tool handler signatures.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const asyncLocalStorage = new AsyncLocalStorage<string>();

// Fallback for contexts outside AsyncLocalStorage (e.g. tests, initialization)
let fallbackSessionId: string = 'default';

/**
 * Set the current session ID (fallback for use outside async context)
 * Prefer runWithSessionId() for production use.
 */
export function setCurrentSessionId(sessionId: string): void {
  fallbackSessionId = sessionId;
}

/**
 * Get the current session ID.
 * Reads from AsyncLocalStorage first, falls back to the global variable.
 */
export function getCurrentSessionId(): string {
  return asyncLocalStorage.getStore() ?? fallbackSessionId;
}

/**
 * Run a function with an isolated session context.
 * All calls to getCurrentSessionId() within fn (including async continuations)
 * will return the provided sessionId.
 */
export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return asyncLocalStorage.run(sessionId, fn);
}

// Telegram message context — set before each agent query so tools can target the right message
let telegramMessageContext: { chatId: number; messageId: number } | null = null;

/**
 * Set the Telegram message context (chatId + messageId) for the current query
 */
export function setTelegramMessageContext(ctx: { chatId: number; messageId: number } | null): void {
  telegramMessageContext = ctx;
}

/**
 * Get the Telegram message context for the current query
 */
export function getTelegramMessageContext(): { chatId: number; messageId: number } | null {
  return telegramMessageContext;
}

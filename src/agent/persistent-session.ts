/**
 * Persistent SDK Session
 *
 * Wraps a single Query object for multi-turn use.
 * Uses the canonical SDK pattern: passes an AsyncIterable<SDKUserMessage> as
 * the prompt to query(), backed by a push/pull MessageQueue. Each send()
 * pushes a message to the queue. Turn completion is detected via the SDK's
 * 'result' message type (not a timer-based heuristic).
 *
 * The subprocess stays alive as long as the queue's AsyncIterable hasn't
 * returned, preserving background tasks across turns.
 */

import { EventEmitter } from 'events';
import { runWithSessionId, setCurrentSessionId } from '../tools';

// Re-export types used by AgentManager
export interface TurnResult {
  response: string;
  sdkSessionId?: string;
  wasCompacted: boolean;
  contextTokens?: number;
  contextWindow?: number;
  errors?: string[];
}

// Typed references to SDK objects (loaded dynamically)
interface SDKQuery extends AsyncGenerator<unknown, void> {
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
}

interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ContentBlock = TextBlock | ImageBlock;

// Callbacks provided by AgentManager
type ProcessStatusCallback = (message: unknown) => void;
type ExtractTextCallback = (message: unknown, current: string) => string;

// Query factory function type
type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) => SDKQuery;

// Maximum time to wait for a turn to complete (ms)
const TURN_MAX_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Push/pull async queue for feeding messages to the SDK.
 * Implements AsyncIterable so it can be passed directly as the prompt to query().
 * The iterable stays alive as long as close() hasn't been called, keeping the
 * SDK subprocess alive between turns.
 */
class MessageQueue {
  private pending: SDKUserMessage[] = [];
  private waiters: Array<(value: SDKUserMessage | null) => void> = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.pending.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      // Pull next message: return from pending queue or wait for push
      let msg: SDKUserMessage | null;
      const queued = this.pending.shift();
      if (queued) {
        msg = queued;
      } else if (this.closed) {
        return;
      } else {
        msg = await new Promise<SDKUserMessage | null>((resolve) => {
          this.waiters.push(resolve);
        });
      }

      if (msg === null) return; // Queue closed
      yield msg;
    }
  }
}

export class PersistentSDKSession extends EventEmitter {
  private sessionId: string;
  private query: SDKQuery | null = null;
  private alive = false;
  private sdkSessionId: string | undefined;
  private wasCompacted = false;
  private messageQueue: MessageQueue | null = null;

  // Callbacks from AgentManager
  private processStatus: ProcessStatusCallback;
  private extractText: ExtractTextCallback;

  // Turn management
  private turnResolve: ((result: TurnResult) => void) | null = null;
  private turnReject: ((error: Error) => void) | null = null;
  private turnResponse = '';
  private turnTimeout: ReturnType<typeof setTimeout> | null = null;

  // Context window tracking (from SDK result)
  private contextTokens?: number;
  private contextWindow?: number;
  private turnErrors?: string[];

  constructor(
    sessionId: string,
    processStatus: ProcessStatusCallback,
    extractText: ExtractTextCallback
  ) {
    super();
    this.sessionId = sessionId;
    this.processStatus = processStatus;
    this.extractText = extractText;
  }

  /**
   * Start a new persistent session with the first message.
   * Creates a MessageQueue, pushes the first message, and passes the queue's
   * AsyncIterable to query() — the canonical SDK multi-turn pattern.
   */
  async start(
    queryFn: QueryFn,
    firstMessage: string,
    options: Record<string, unknown>,
    contentBlocks?: ContentBlock[]
  ): Promise<TurnResult> {
    this.alive = true;
    this.wasCompacted = false;

    // Create the message queue that feeds the SDK
    this.messageQueue = new MessageQueue();

    // Push the first message
    this.messageQueue.push({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks || firstMessage,
      },
      parent_tool_use_id: null,
      session_id: 'default',
    });

    // Create the query with the async iterable prompt (canonical Pattern A)
    this.query = queryFn({ prompt: this.messageQueue, options });

    // Start the output loop in the background (runs for lifetime of session)
    this.runOutputLoop();

    // Wait for the first turn to complete
    return this.waitForTurn();
  }

  /**
   * Send a subsequent message. Pushes to the message queue; the SDK picks
   * it up via the existing AsyncIterable.
   */
  async send(
    message: string,
    contentBlocks?: ContentBlock[]
  ): Promise<TurnResult> {
    if (!this.query || !this.alive || !this.messageQueue) {
      throw new Error('Session is not alive');
    }

    this.wasCompacted = false;

    this.messageQueue.push({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks || message,
      },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId || 'default',
    });

    return this.waitForTurn();
  }

  /**
   * Interrupt the current turn. Session stays alive, background tasks survive.
   */
  async interrupt(): Promise<void> {
    if (!this.query || !this.alive) return;

    try {
      await this.query.interrupt();
      // Resolve the current turn with whatever we have
      this.completeTurn();
    } catch (err) {
      console.error(`[PersistentSession:${this.sessionId}] interrupt error:`, err);
      // Fall back to close
      this.close();
    }
  }

  /**
   * Close the session entirely. Kills subprocess and all background tasks.
   */
  close(): void {
    if (!this.query) return;

    this.alive = false;

    // Close the message queue (unblocks the generator, ends the iterable)
    if (this.messageQueue) {
      this.messageQueue.close();
      this.messageQueue = null;
    }

    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }

    try {
      this.query.close();
    } catch {
      // Ignore close errors
    }

    this.query = null;

    // Reject any pending turn
    if (this.turnReject) {
      this.turnReject(new Error('Session closed'));
      this.turnResolve = null;
      this.turnReject = null;
    }

    this.emit('closed', this.sessionId);
  }

  isAlive(): boolean {
    return this.alive;
  }

  getSdkSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  async setModel(model: string): Promise<void> {
    if (!this.query || !this.alive) return;
    try {
      await this.query.setModel(model);
      console.log(`[PersistentSession:${this.sessionId}] Model changed to: ${model}`);
    } catch (err) {
      console.error(`[PersistentSession:${this.sessionId}] setModel error:`, err);
    }
  }

  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    if (!this.query || !this.alive) return;
    try {
      await this.query.setMaxThinkingTokens(tokens);
    } catch (err) {
      console.error(`[PersistentSession:${this.sessionId}] setMaxThinkingTokens error:`, err);
    }
  }

  // ---- Internal mechanics ----

  /**
   * The output loop runs for the lifetime of the session.
   * Iterates over all messages from the Query, processes them, and detects
   * turn boundaries via the SDK's 'result' message type.
   */
  private async runOutputLoop(): Promise<void> {
    if (!this.query) return;

    try {
      // Set fallback session ID for MCP tool handlers that may run outside AsyncLocalStorage context
      setCurrentSessionId(this.sessionId);
      await runWithSessionId(this.sessionId, async () => {
        for await (const message of this.query!) {
          // Process status updates (tool_start, tool_end, etc.)
          this.processStatus(message);

          // Extract text response
          this.turnResponse = this.extractText(message, this.turnResponse);

          // Capture SDK session ID from first message that has one
          const msg = message as { type?: string; subtype?: string; session_id?: string };
          if (msg.session_id && !this.sdkSessionId) {
            this.sdkSessionId = msg.session_id;
            this.emit('sdkSessionId', this.sdkSessionId);
            console.log(`[PersistentSession:${this.sessionId}] Captured SDK session ID: ${this.sdkSessionId}`);
          }

          // Detect compaction
          if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
            this.wasCompacted = true;
          }

          // Turn boundary: SDK emits 'result' when a turn is complete
          if (msg.type === 'result') {
            // Capture errors from result
            const errResult = message as { errors?: string[]; subtype?: string };
            if (errResult.errors && errResult.errors.length > 0) {
              this.turnErrors = errResult.errors;
              console.warn(`[PersistentSession:${this.sessionId}] Result errors:`, errResult.errors);
            }

            // Extract context window usage from SDK result
            const resultMsg = message as {
              usage?: { input_tokens?: number; cache_read_input_tokens?: number };
              modelUsage?: Record<string, { contextWindow?: number; inputTokens?: number; cacheReadInputTokens?: number }>;
            };

            if (resultMsg.usage?.input_tokens !== undefined) {
              // Total context = fresh tokens + cached tokens (both count toward the context window)
              const cached = resultMsg.usage.cache_read_input_tokens ?? 0;
              this.contextTokens = resultMsg.usage.input_tokens + cached;
            }
            if (resultMsg.modelUsage) {
              // Get contextWindow from first model in modelUsage
              const firstModel = Object.values(resultMsg.modelUsage)[0];
              if (firstModel?.contextWindow) {
                this.contextWindow = firstModel.contextWindow;
              }
            }

            this.completeTurn();
          }
        }
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PersistentSession:${this.sessionId}] Output loop error:`, errMsg);
    } finally {
      console.log(`[PersistentSession:${this.sessionId}] Output loop ended`);
      this.alive = false;

      if (this.turnTimeout) {
        clearTimeout(this.turnTimeout);
        this.turnTimeout = null;
      }

      // Complete any pending turn with what we have
      if (this.turnResolve) {
        this.turnResolve({
          response: this.turnResponse,
          sdkSessionId: this.sdkSessionId,
          wasCompacted: this.wasCompacted,
          contextTokens: this.contextTokens,
          contextWindow: this.contextWindow,
          errors: this.turnErrors,
        });
        this.turnResolve = null;
        this.turnReject = null;
      }

      this.emit('closed', this.sessionId);
    }
  }

  /**
   * Wait for the current turn to complete (result message detection).
   */
  private waitForTurn(): Promise<TurnResult> {
    this.turnResponse = '';

    return new Promise<TurnResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;

      // Safety net: max timeout for the turn
      this.turnTimeout = setTimeout(() => {
        console.error(`[PersistentSession:${this.sessionId}] Turn timed out after ${TURN_MAX_TIMEOUT}ms`);
        this.completeTurn();
      }, TURN_MAX_TIMEOUT);
    });
  }

  /**
   * Complete the current turn - resolve the turn promise with accumulated response.
   */
  private completeTurn(): void {
    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }

    if (this.turnResolve) {
      const result: TurnResult = {
        response: this.turnResponse,
        sdkSessionId: this.sdkSessionId,
        wasCompacted: this.wasCompacted,
        contextTokens: this.contextTokens,
        contextWindow: this.contextWindow,
        errors: this.turnErrors,
      };
      this.turnResolve(result);
      this.turnResolve = null;
      this.turnReject = null;
      this.turnErrors = undefined;
    }
  }
}

import { QueueItem, QueueOperation, QueuePayload } from './types.js';
import { WriteAheadQueue } from './write-ahead-queue.js';

export type DispatchFn = (chatId: number, operation: QueueOperation, payload: QueuePayload) => Promise<void>;

function calcBackoff(attempts: number): number {
  const base = Math.min(5000 * Math.pow(2, attempts - 1), 300000);
  const jitter = base * (0.8 + Math.random() * 0.4); // ±20%
  return Math.round(jitter);
}

export class QueueProcessor {
  private queue: WriteAheadQueue;
  private dispatch: DispatchFn;
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<number>(); // chatIds currently being processed
  private running = false;

  constructor(queue: WriteAheadQueue, dispatch: DispatchFn) {
    this.queue = queue;
    this.dispatch = dispatch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.queue.recoverStuckProcessing();
    this.sweepInterval = setInterval(() => this.processReady(), 30000);
    this.processReady();
  }

  stop(timeout: number = 10000): Promise<void> {
    this.running = false;
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    // Wait for in-flight to drain
    return new Promise((resolve) => {
      if (this.inFlight.size === 0) {
        resolve();
        return;
      }
      const check = setInterval(() => {
        if (this.inFlight.size === 0) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, timeout);
    });
  }

  nudge(): void {
    if (this.running) {
      this.processReady();
    }
  }

  private processReady(): void {
    const items = this.queue.dequeueNext();
    for (const item of items) {
      if (this.inFlight.has(item.chat_id)) continue;
      this.processItem(item);
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    this.inFlight.add(item.chat_id);
    this.queue.markProcessing(item.id);

    try {
      const payload = JSON.parse(item.payload) as QueuePayload;
      await this.dispatch(item.chat_id, item.operation, payload);
      this.queue.markCompleted(item.id);
      // Process next for this chat
      this.inFlight.delete(item.chat_id);
      if (this.running) this.processReady();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const backoff = calcBackoff(item.attempts + 1);
      this.queue.markFailed(item.id, error, backoff);
      this.inFlight.delete(item.chat_id);
    }
  }
}

export class WAQManager {
  readonly queue: WriteAheadQueue;
  readonly processor: QueueProcessor;

  constructor(dbPath: string, dispatch: DispatchFn) {
    this.queue = new WriteAheadQueue(dbPath);
    this.processor = new QueueProcessor(this.queue, dispatch);
  }

  enqueue(chatId: number, operation: QueueOperation, payload: QueuePayload): number {
    const id = this.queue.enqueue(chatId, operation, payload);
    this.processor.nudge();
    return id;
  }

  start(): void {
    this.processor.start();
  }

  async stop(timeout?: number): Promise<void> {
    await this.processor.stop(timeout);
    this.queue.close();
  }
}

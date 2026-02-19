import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WriteAheadQueue } from '../../src/queue/write-ahead-queue';
import { QueueProcessor } from '../../src/queue/processor';
import type { QueueOperation, QueuePayload } from '../../src/queue/types';

describe('QueueProcessor', () => {
  let waq: WriteAheadQueue;

  beforeEach(() => {
    waq = new WriteAheadQueue(':memory:');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    waq.close();
  });

  it('sweep processes pending items by calling dispatch', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });

    const proc = new QueueProcessor(waq, dispatch);
    proc.start();

    // Let the async processItem resolve
    await vi.advanceTimersByTimeAsync(100);
    await proc.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(100, 'text', expect.objectContaining({ text: 'hi' }));
  });

  it('failed dispatch marks item as failed', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('network fail'));
    const id = waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });

    const proc = new QueueProcessor(waq, dispatch);
    proc.start();

    await vi.advanceTimersByTimeAsync(100);
    await proc.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
    // Item should not be pending anymore (it's failed with future scheduled_at)
    const items = waq.dequeueNext();
    expect(items).toHaveLength(0);
  });

  it('dispatch throwing triggers markFailed', async () => {
    const dispatch = vi.fn().mockImplementation(() => {
      throw new Error('sync throw');
    });
    waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });

    const proc = new QueueProcessor(waq, dispatch);
    proc.start();

    await vi.advanceTimersByTimeAsync(100);
    await proc.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
    // Item should be failed, not pending
    const items = waq.dequeueNext();
    expect(items).toHaveLength(0);
  });

  it('stop() resolves after in-flight items complete', async () => {
    let resolveDispatch: () => void;
    const dispatch = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveDispatch = resolve; }),
    );
    waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });

    const proc = new QueueProcessor(waq, dispatch);
    proc.start();

    await vi.advanceTimersByTimeAsync(50);

    const stopPromise = proc.stop();
    // Resolve the in-flight dispatch
    resolveDispatch!();
    await vi.advanceTimersByTimeAsync(200);
    await stopPromise;

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('multiple items from different chats processed', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    waq.enqueue(100, 'text', { text: 'a', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.enqueue(200, 'text', { text: 'b', chunkIndex: 0, totalChunks: 1, groupId: 'g2' });

    const proc = new QueueProcessor(waq, dispatch);
    proc.start();

    await vi.advanceTimersByTimeAsync(100);
    await proc.stop();

    expect(dispatch).toHaveBeenCalledTimes(2);
    const chatIds = dispatch.mock.calls.map((c: [number, QueueOperation, QueuePayload]) => c[0]).sort();
    expect(chatIds).toEqual([100, 200]);
  });
});

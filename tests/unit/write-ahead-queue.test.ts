import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WriteAheadQueue } from '../../src/queue/write-ahead-queue';

describe('WriteAheadQueue', () => {
  let waq: WriteAheadQueue;

  beforeEach(() => {
    waq = new WriteAheadQueue(':memory:');
  });

  afterEach(() => {
    waq.close();
  });

  it('enqueue returns an id > 0', () => {
    const id = waq.enqueue(123, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    expect(id).toBeGreaterThan(0);
  });

  it('dequeueNext returns oldest pending item per chat', () => {
    waq.enqueue(100, 'text', { text: 'first', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.enqueue(100, 'text', { text: 'second', chunkIndex: 0, totalChunks: 1, groupId: 'g2' });
    const items = waq.dequeueNext();
    expect(items).toHaveLength(1);
    expect(JSON.parse(items[0].payload).text).toBe('first');
  });

  it('dequeueNext returns empty array when empty', () => {
    const items = waq.dequeueNext();
    expect(items).toHaveLength(0);
  });

  it('markProcessing sets status and increments attempts', () => {
    const id = waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.markProcessing(id);
    // Item should no longer appear in dequeueNext
    const items = waq.dequeueNext();
    expect(items).toHaveLength(0);
  });

  it('markCompleted sets status to completed', () => {
    const id = waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.markProcessing(id);
    waq.markCompleted(id);
    const items = waq.dequeueNext();
    expect(items).toHaveLength(0);
  });

  it('markFailed with attempts < max sets status to failed with backoff', () => {
    const id = waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.markProcessing(id); // attempts becomes 1
    waq.markFailed(id, 'network error', 60000);
    // Item should not be immediately dequeueable (scheduled in future)
    const items = waq.dequeueNext();
    expect(items).toHaveLength(0);
  });

  it('markFailed with attempts >= max sets status to dead', () => {
    const id = waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    // markProcessing increments attempts each time; markFailed with backoff 0 sets scheduled_at=now
    // We need attempts to reach max_attempts (5)
    for (let i = 0; i < 4; i++) {
      waq.markProcessing(id); // attempts: i+1
      waq.markFailed(id, 'error', 0); // status -> failed, scheduled_at = now
    }
    // attempts is now 4, one more markProcessing makes it 5
    waq.markProcessing(id); // attempts = 5 = max_attempts
    waq.markFailed(id, 'final error', 0); // should set dead
    const items = waq.dequeueNext();
    expect(items).toHaveLength(0);
  });

  it('recoverStuckProcessing resets processing to pending', () => {
    const id = waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.markProcessing(id);
    // Recover: use negative stale threshold so cutoff is in the future
    const recovered = waq.recoverStuckProcessing(-60000);
    expect(recovered).toBe(1);
    const items = waq.dequeueNext();
    expect(items).toHaveLength(1);
  });

  it('cleanup removes old completed and dead items', () => {
    const id = waq.enqueue(100, 'text', { text: 'hi', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.markProcessing(id);
    waq.markCompleted(id);
    // Cleanup compares updated_at < cutoff; use a future cutoff to ensure removal
    const removed = waq.cleanup(-60000);
    expect(removed).toBe(1);
  });

  it('FIFO: multiple items same chat returns lowest id', () => {
    const id1 = waq.enqueue(100, 'text', { text: 'a', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.enqueue(100, 'text', { text: 'b', chunkIndex: 0, totalChunks: 1, groupId: 'g2' });
    const items = waq.dequeueNext();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id1);
  });

  it('cross-chat: items from different chats both available', () => {
    waq.enqueue(100, 'text', { text: 'chat100', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    waq.enqueue(200, 'text', { text: 'chat200', chunkIndex: 0, totalChunks: 1, groupId: 'g2' });
    const items = waq.dequeueNext();
    expect(items).toHaveLength(2);
    const chatIds = items.map((i) => i.chat_id).sort();
    expect(chatIds).toEqual([100, 200]);
  });

  it('failed item blocks same-chat pending items', () => {
    waq.enqueue(100, 'text', { text: 'first', chunkIndex: 0, totalChunks: 1, groupId: 'g1' });
    const id2 = waq.enqueue(100, 'text', { text: 'second', chunkIndex: 0, totalChunks: 1, groupId: 'g2' });
    // Process and fail the first item with future backoff
    const items = waq.dequeueNext();
    waq.markProcessing(items[0].id);
    waq.markFailed(items[0].id, 'error', 999999999); // far-future scheduled_at
    // Second item should be blocked
    const next = waq.dequeueNext();
    // The failed item has a future scheduled_at, so it blocks chat 100
    expect(next.every((i) => i.chat_id !== 100 || i.id === id2)).toBe(true);
    // Actually, the blocker check looks for failed items with scheduled_at > now
    // So chat 100 should be completely blocked
    expect(next.filter((i) => i.chat_id === 100)).toHaveLength(0);
  });
});

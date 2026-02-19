import Database from 'better-sqlite3';
import { QueueItem, QueueOperation, QueuePayload } from './types.js';

export class WriteAheadQueue {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS waq_queue (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       INTEGER NOT NULL,
        operation     TEXT NOT NULL CHECK(operation IN ('text', 'voice', 'photo')),
        payload       TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 5,
        scheduled_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
        last_error    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_waq_status_scheduled ON waq_queue(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_waq_chat_status ON waq_queue(chat_id, status, id);
    `);
  }

  enqueue(chatId: number, operation: QueueOperation, payload: QueuePayload): number {
    const stmt = this.db.prepare(`
      INSERT INTO waq_queue (chat_id, operation, payload)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(chatId, operation, JSON.stringify(payload));
    return result.lastInsertRowid as number;
  }

  dequeueNext(): QueueItem[] {
    const stmt = this.db.prepare(`
      SELECT q.* FROM waq_queue q
      WHERE q.status = 'pending'
        AND datetime(q.scheduled_at) <= datetime('now')
        AND NOT EXISTS (
          SELECT 1 FROM waq_queue blocker
          WHERE blocker.chat_id = q.chat_id
            AND blocker.status = 'failed'
            AND datetime(blocker.scheduled_at) > datetime('now')
        )
      GROUP BY q.chat_id
      HAVING q.id = MIN(q.id)
      ORDER BY q.scheduled_at ASC
    `);
    return stmt.all() as QueueItem[];
  }

  markProcessing(id: number): void {
    this.db.prepare(`
      UPDATE waq_queue
      SET status = 'processing', attempts = attempts + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
      WHERE id = ?
    `).run(id);
  }

  markCompleted(id: number): void {
    this.db.prepare(`
      UPDATE waq_queue
      SET status = 'completed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
      WHERE id = ?
    `).run(id);
  }

  markFailed(id: number, error: string, backoffMs: number): void {
    const scheduledAt = new Date(Date.now() + backoffMs).toISOString();
    const item = this.db.prepare('SELECT attempts, max_attempts FROM waq_queue WHERE id = ?').get(id) as Pick<QueueItem, 'attempts' | 'max_attempts'> | undefined;

    if (item && item.attempts >= item.max_attempts) {
      this.db.prepare(`
        UPDATE waq_queue
        SET status = 'dead', last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
        WHERE id = ?
      `).run(error, id);
    } else {
      this.db.prepare(`
        UPDATE waq_queue
        SET status = 'failed', last_error = ?, scheduled_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
        WHERE id = ?
      `).run(error, scheduledAt, id);
    }
  }

  recoverStuckProcessing(staleMs: number = 60000): number {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const result = this.db.prepare(`
      UPDATE waq_queue
      SET status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
      WHERE status = 'processing' AND updated_at < ?
    `).run(cutoff);
    return result.changes;
  }

  cleanup(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db.prepare(`
      DELETE FROM waq_queue
      WHERE status IN ('completed', 'dead') AND updated_at < ?
    `).run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

import cron, { ScheduledTask } from 'node-cron';
import Database from 'better-sqlite3';
import { AgentManager } from '../agent';
import { MemoryManager, CronJob } from '../memory';
import { SettingsManager } from '../settings';
import { sendEmail as gogSendEmail } from '../tools/gog-wrapper';
import { findWorkflowCommand } from '../config/commands-loader';
import type { TelegramBot } from '../channels/telegram';


interface CalendarEvent {
  id: number;
  title: string;
  description: string | null;
  start_time: string;
  location: string | null;
  reminder_minutes: number;
  channel: string;
  session_id: string | null;
}

interface Task {
  id: number;
  title: string;
  description: string | null;
  due_date: string;
  priority: string;
  reminder_minutes: number;
  channel: string;
  session_id: string | null;
}

export interface ScheduledJob {
  id: number;
  name: string;
  scheduleType?: 'cron' | 'at' | 'every';
  schedule: string | null;
  runAt?: string | null;
  intervalMs?: number | null;
  prompt: string;
  channel: string;
  recipient?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  contextMessages?: number;
  nextRunAt?: string | null;
  sessionId?: string | null;
}

export interface JobResult {
  jobName: string;
  response: string;
  channel: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

/**
 * CronScheduler - Manages scheduled jobs from SQLite
 *
 * Loads jobs from cron_jobs table, runs them on schedule,
 * calls AgentManager.processMessage() and routes responses.
 */
export class CronScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private jobs: Map<string, ScheduledJob> = new Map();
  private memory: MemoryManager | null = null;
  private telegramBot: TelegramBot | null = null;
  private jobHistory: JobResult[] = [];
  private maxHistorySize: number = 100;
  private reloadInterval: ReturnType<typeof setInterval> | null = null;
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private lastJobCount: number = 0;
  private dbPath: string | null = null;
  private db: Database.Database | null = null; // Persistent DB connection for reminders
  private isCheckingReminders: boolean = false; // Mutex to prevent overlapping checks
  private checkStartedAt: number = 0; // Timestamp when check started (for stale mutex detection)
  private autoPosterInterval: ReturnType<typeof setInterval> | null = null;
  private engagementCheckInterval: ReturnType<typeof setInterval> | null = null;
  private linkedInAutoScrapeInterval: ReturnType<typeof setInterval> | null = null;
  private linkedInAutoScrapeRunning: boolean = false;
  private linkedInAutoScrapeLastRunAt: number = 0;

  constructor() {}

  /**
   * Initialize scheduler with memory manager and load jobs
   */
  async initialize(memory: MemoryManager, dbPath?: string): Promise<void> {
    this.memory = memory;
    this.dbPath = dbPath || null;

    // Open persistent DB connection for reminder checks (avoids creating new connection every 30s)
    if (this.dbPath) {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
    }

    await this.loadJobsFromDatabase();
    // Use DB count (includes timer-based jobs) not this.jobs.size (cron only)
    this.lastJobCount = this.memory.getCronJobs(false).length;
    console.log(`[Scheduler] Initialized with ${this.jobs.size} jobs`);

    // Start periodic check for new jobs (every 60 seconds)
    this.reloadInterval = setInterval(() => {
      this.checkForNewJobs();
    }, 60000);

    // Start periodic check for calendar/task reminders (every 30 seconds)
    this.reminderInterval = setInterval(() => {
      this.checkReminders().catch(err => console.error('[Scheduler] Error checking reminders:', err));
    }, 30000);

    // Run initial reminder check
    this.checkReminders().catch(err => console.error('[Scheduler] Error checking reminders:', err));

    // Start LinkedIn auto-poster (every 60s) and engagement checks (every 30min)
    import('../tools/linkedin-autoposter').then(({ checkAndPostNext, checkDueEngagement, syncAuthorsFromPosts, notifyTelegram }) => {
      this.autoPosterInterval = setInterval(() => {
        checkAndPostNext().catch(err => console.error('[Scheduler] AutoPoster error:', err));
      }, 60000);
      this.engagementCheckInterval = setInterval(() => {
        checkDueEngagement().catch(err => console.error('[Scheduler] Engagement check error:', err));
      }, 30 * 60 * 1000);
      this.linkedInAutoScrapeInterval = setInterval(() => {
        this.runLinkedInAutoScrapeTick(notifyTelegram).catch(err => console.error('[Scheduler] LinkedIn auto-scrape error:', err));
      }, 60000);
      // Sync authors on startup
      try { syncAuthorsFromPosts(); } catch (err) { console.error('[Scheduler] Author sync error:', err); }
      this.runLinkedInAutoScrapeTick(notifyTelegram).catch(err => console.error('[Scheduler] LinkedIn auto-scrape start error:', err));
    }).catch(err => console.error('[Scheduler] Failed to load autoposter:', err));
  }

  private async runLinkedInAutoScrapeTick(notifyLinkedIn: (message: string) => Promise<void>): Promise<void> {
    if (this.linkedInAutoScrapeRunning) return;
    if (SettingsManager.get('linkedin.enabled') !== 'true') return;
    if (SettingsManager.get('linkedin.autoScrapeEnabled') !== 'true') return;

    const rawInterval = parseInt(SettingsManager.get('linkedin.autoScrapeIntervalMin') || '60', 10);
    const intervalMin = Math.max(30, Math.min(240, Number.isFinite(rawInterval) ? rawInterval : 60));
    const now = Date.now();
    if (this.linkedInAutoScrapeLastRunAt > 0 && now - this.linkedInAutoScrapeLastRunAt < intervalMin * 60 * 1000) {
      return;
    }

    this.linkedInAutoScrapeRunning = true;
    try {
      const scrollRaw = parseInt(SettingsManager.get('linkedin.autoScrapeScroll') || SettingsManager.get('linkedin.feedScroll') || '12', 10);
      const limitRaw = parseInt(SettingsManager.get('linkedin.autoScrapeLimit') || SettingsManager.get('linkedin.feedLimit') || '50', 10);
      const minReactsRaw = parseInt(SettingsManager.get('linkedin.autoScrapeMinReactions') || '5', 10);
      const minCommentsRaw = parseInt(SettingsManager.get('linkedin.autoScrapeMinComments') || '1', 10);
      const maxFlaggedRaw = parseInt(SettingsManager.get('linkedin.autoScrapeMaxFlagged') || '8', 10);
      const discoveryEnabled = SettingsManager.get('linkedin.discoveryModeEnabled') === 'true';
      const discoveryQueriesRaw = String(SettingsManager.get('linkedin.discoveryQueries') || '').trim();
      const discoveryQueries = discoveryQueriesRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 6);
      const discoveryScrollRaw = parseInt(SettingsManager.get('linkedin.discoveryScroll') || '10', 10);
      const discoveryLimitRaw = parseInt(SettingsManager.get('linkedin.discoveryLimit') || '35', 10);
      const scroll = Math.max(1, Math.min(24, Number.isFinite(scrollRaw) ? scrollRaw : 12));
      const limit = Math.max(5, Math.min(120, Number.isFinite(limitRaw) ? limitRaw : 50));
      const minReactions = Math.max(0, Math.min(10000, Number.isFinite(minReactsRaw) ? minReactsRaw : 5));
      const minComments = Math.max(0, Math.min(5000, Number.isFinite(minCommentsRaw) ? minCommentsRaw : 1));
      const maxFlagged = Math.max(1, Math.min(20, Number.isFinite(maxFlaggedRaw) ? maxFlaggedRaw : 8));
      const discoveryScroll = Math.max(1, Math.min(24, Number.isFinite(discoveryScrollRaw) ? discoveryScrollRaw : 10));
      const discoveryLimit = Math.max(5, Math.min(120, Number.isFinite(discoveryLimitRaw) ? discoveryLimitRaw : 35));

      const { runLinkedInAutoScrapeCycle } = await import('../tools/linkedin-tools');
      const result = await runLinkedInAutoScrapeCycle({
        scroll,
        limit,
        minReactions,
        minComments,
        maxFlagged,
        discoveryEnabled,
        discoveryQueries,
        discoveryScroll,
        discoveryLimit,
      });
      this.linkedInAutoScrapeLastRunAt = now;

      if (!result.success) {
        console.warn('[Scheduler] LinkedIn auto-scrape failed:', result.error || 'unknown error');
        return;
      }

      if (result.flagged > 0) {
        const preview = result.flagged_posts
          .slice(0, 4)
          .map((p, idx) => `${idx + 1}) ${p.author} (${p.reactions}r/${p.comments}c)`)
          .join(' | ');
        const message = `LinkedIn auto-scrape: flagged ${result.flagged} post(s) for drafting (>=${minReactions} reacts, >=${minComments} comments). ${preview}`;
        await notifyLinkedIn(message);
      }
    } finally {
      this.linkedInAutoScrapeRunning = false;
    }
  }

  /**
   * Check if new jobs have been added to the database
   */
  private async checkForNewJobs(): Promise<void> {
    if (!this.memory) return;

    const dbJobs = this.memory.getCronJobs(false); // Get all jobs
    const currentCount = dbJobs.length;

    // If job count changed, reload
    if (currentCount !== this.lastJobCount) {
      console.log(`[Scheduler] Job count changed (${this.lastJobCount} -> ${currentCount}), reloading...`);
      await this.loadJobsFromDatabase();
      this.lastJobCount = currentCount;
    }
  }

  /**
   * Check for calendar events and tasks that need reminders
   * Uses mutex to prevent overlapping executions
   */
  private async checkReminders(): Promise<void> {
    if (!this.db) return;

    // Mutex: prevent overlapping executions (with 10-minute stale guard)
    if (this.isCheckingReminders) {
      const elapsed = Date.now() - this.checkStartedAt;
      if (elapsed < 10 * 60 * 1000) {
        console.log('[Scheduler] Skipping reminder check - previous check still running');
        return;
      }
      console.warn(`[Scheduler] Releasing stale mutex (stuck for ${Math.round(elapsed / 1000)}s)`);
    }

    this.isCheckingReminders = true;
    this.checkStartedAt = Date.now();

    try {
      const db = this.db;
      const now = new Date();

      // Check calendar events
      const events = db.prepare(`
        SELECT id, title, description, start_time, location, reminder_minutes, channel, session_id
        FROM calendar_events
        WHERE reminded = 0
          AND datetime(start_time, '-' || reminder_minutes || ' minutes') <= datetime(?)
          AND datetime(start_time) > datetime(?)
      `).all(now.toISOString(), now.toISOString()) as CalendarEvent[];

      for (const event of events) {
        const startTime = new Date(event.start_time);
        const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60000);

        let message = `Upcoming event: "${event.title}"`;
        if (minutesUntil > 0) {
          message += ` in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}`;
        } else {
          message += ' starting now';
        }
        if (event.location) {
          message += ` at ${event.location}`;
        }

        const sessionId = event.session_id || 'default';
        await this.sendReminder('calendar', event.title, message, event.channel, sessionId);

        // Mark as reminded
        db.prepare('UPDATE calendar_events SET reminded = 1 WHERE id = ?').run(event.id);
      }

      // Check kanban tasks with due dates
      const tasks = db.prepare(`
        SELECT id, title, description, due_date, priority, reminder_minutes,
          COALESCE(notify_channels, 'desktop') as channel
        FROM kanban_tasks
        WHERE status != 'done'
          AND reminded = 0
          AND reminder_minutes IS NOT NULL
          AND due_date IS NOT NULL
          AND datetime(due_date, '-' || reminder_minutes || ' minutes') <= datetime(?)
          AND datetime(due_date) > datetime(?)
      `).all(now.toISOString(), now.toISOString()) as Task[];

      for (const task of tasks) {
        const dueDate = new Date(task.due_date);
        const minutesUntil = Math.round((dueDate.getTime() - now.getTime()) / 60000);

        let message = `Task due soon: "${task.title}"`;
        if (minutesUntil > 0) {
          message += ` in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}`;
        } else {
          message += ' due now';
        }
        if (task.priority === 'high' || task.priority === 'urgent') {
          message += ' (High Priority)';
        }

        const sessionId = task.session_id || 'default';
        await this.sendReminder('task', task.title, message, task.channel, sessionId);

        // Mark as reminded
        db.prepare('UPDATE kanban_tasks SET reminded = 1 WHERE id = ?').run(task.id);
      }

      // Check for due cron jobs
      await this.checkDueJobs(db, now);

      // Check for stale reminders (fired but not acknowledged after 2 days)
      await this.checkStaleReminders(db);
    } catch (error) {
      console.error('[Scheduler] Reminder check failed:', error);
    } finally {
      // Release mutex (DB stays open for reuse)
      this.isCheckingReminders = false;
    }
  }

  /**
   * Check for cron jobs that are due to run
   */
  private async checkDueJobs(db: Database.Database, now: Date): Promise<void> {
    interface DueJob {
      id: number;
      name: string;
      schedule_type: string;
      schedule: string | null;
      run_at: string | null;
      interval_ms: number | null;
      prompt: string;
      channel: string;
      delete_after_run: number;
      context_messages: number;
      session_id: string | null;
      job_type: string | null;
    }

    // Check all job types - including 'cron' as catch-up for missed ticks during macOS sleep
    const dueJobs = db.prepare(`
      SELECT id, name, schedule_type, schedule, run_at, interval_ms, prompt, channel, delete_after_run, context_messages, session_id, job_type, last_run_at
      FROM cron_jobs
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND datetime(next_run_at) <= datetime(?)
    `).all(now.toISOString()) as (DueJob & { last_run_at: string | null })[];

    for (const job of dueJobs) {
      // Guard against double-execution for cron-type jobs:
      // If node-cron already ran this job recently (within 5 minutes), skip the catch-up
      if (job.schedule_type === 'cron' && job.last_run_at) {
        const lastRun = new Date(job.last_run_at).getTime();
        const fiveMinutesAgo = now.getTime() - 5 * 60 * 1000;
        if (lastRun > fiveMinutesAgo) {
          console.log(`[Scheduler] Skipping cron catch-up for "${job.name}" - already ran at ${job.last_run_at}`);
          continue;
        }
      }

      const startTime = Date.now();
      const sessionId = job.session_id || 'default';

      try {
        console.log(`[Scheduler] Executing job: ${job.name}`);
        let response: string;

        if (job.job_type === 'reminder') {
          // Reminders: display the pre-composed message directly, NO LLM call
          response = job.prompt;
          console.log(`[Scheduler] Reminder (no LLM): ${job.name}`);
        } else {
          // Routines: call LLM with context
          let contextText = '';
          if (job.context_messages > 0 && this.memory) {
            const history = this.memory.getRecentMessages(job.context_messages, sessionId);
            if (history.length > 0) {
              const lines = history.map(m => {
                const role = m.role === 'user' ? 'User' : 'Assistant';
                const text = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
                return `- ${role}: ${text}`;
              });
              contextText = '\n\nRecent context:\n' + lines.join('\n');
            }
          }

          const fullPrompt = `[SCHEDULED ROUTINE "${job.name}" - EXECUTE NOW]\nYou are running as an automated scheduled routine. Do NOT discuss scheduling or your capabilities. Execute the following task immediately and always provide a full report:\n\n${job.prompt}${contextText}`;

          if (!AgentManager.isInitialized()) {
            throw new Error('AgentManager not initialized');
          }

          const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minute timeout for LLM calls
          const result = await Promise.race([
            AgentManager.processMessage(
              fullPrompt,
              `cron:${job.name}`,
              sessionId
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Job "${job.name}" timed out after ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS)
            ),
          ]);
          response = result.response;
        }

        const duration = Date.now() - startTime;

        // Deliver BEFORE marking DB as done — prevents silent message loss on crash
        const displayPrompt = job.job_type === 'reminder' ? '' : job.prompt;
        await this.routeJobResponse(job.name, displayPrompt, response, job.channel, sessionId);

        // Update job state
        const nextRunAt = this.calculateNextRun(job.schedule_type, job.schedule, job.interval_ms);

        if (job.delete_after_run === 1) {
          // One-time reminder: mark as fired, disable, no follow-up
          db.prepare(`
            UPDATE cron_jobs SET
              last_run_at = datetime(?),
              last_status = 'ok',
              last_error = NULL,
              last_duration_ms = ?,
              next_run_at = NULL,
              enabled = 0,
              status = 'fired',
              fired_at = datetime(?),
              updated_at = datetime('now')
            WHERE id = ?
          `).run(now.toISOString(), duration, now.toISOString(), job.id);
          console.log(`[Scheduler] One-time job "${job.name}" fired, status set to 'fired'`);
        } else {
          // Update state
          db.prepare(`
            UPDATE cron_jobs SET
              last_run_at = datetime(?),
              last_status = 'ok',
              last_error = NULL,
              last_duration_ms = ?,
              next_run_at = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(now.toISOString(), duration, nextRunAt, job.id);
        }

        this.addToHistory({
          jobName: job.name,
          response: response,
          channel: job.channel,
          success: true,
          timestamp: now,
        });

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';

        console.error(`[Scheduler] Job ${job.name} failed:`, errorMsg);

        // Update state with error
        const nextRunAt = this.calculateNextRun(job.schedule_type, job.schedule, job.interval_ms);
        db.prepare(`
          UPDATE cron_jobs SET
            last_run_at = datetime(?),
            last_status = 'error',
            last_error = ?,
            last_duration_ms = ?,
            next_run_at = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(now.toISOString(), errorMsg, duration, nextRunAt, job.id);

        this.addToHistory({
          jobName: job.name,
          response: '',
          channel: job.channel,
          success: false,
          error: errorMsg,
          timestamp: now,
        });

        // Surface error to user through the same channels as success
        const errorResponse = `Job "${job.name}" failed: ${errorMsg}`;
        try {
          await this.routeJobResponse(job.name, '', errorResponse, job.channel, sessionId);
        } catch (routeErr) {
          console.error(`[Scheduler] Failed to route job error:`, routeErr);
        }
      }
    }
  }

  /**
   * Check for reminders that fired but were never acknowledged (older than 2 days)
   */
  private async checkStaleReminders(db: Database.Database): Promise<void> {
    interface StaleJob {
      id: number;
      name: string;
      prompt: string;
      channel: string;
      session_id: string | null;
      fired_at: string;
    }

    const staleJobs = db.prepare(`
      SELECT id, name, prompt, channel, session_id, fired_at
      FROM cron_jobs
      WHERE status = 'fired' AND fired_at IS NOT NULL AND datetime(fired_at) < datetime('now', '-2 days')
    `).all() as StaleJob[];

    if (staleJobs.length === 0) return;

    // Send notification BEFORE marking DB as stale — prevents silent message loss on crash
    const lines = staleJobs.map(j => {
      const firedDate = new Date(j.fired_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `⚠️ MISSED TASK (${firedDate}):\n${j.prompt}\n`;
    });
    const count = staleJobs.length;
    const message = `🔴 OVERDUE — ${count} task${count > 1 ? 's were' : ' was'} scheduled but never completed:\n\n${lines.join('\n')}\nThese tasks are still pending. Should I execute ${count > 1 ? 'them' : 'it'} now, or dismiss?`;

    // Process through agent so the exchange enters conversation history.
    // This ensures the agent remembers surfacing these reminders when the user replies.
    const representative = staleJobs[0];
    const sessionId = representative.session_id || 'default';
    if (AgentManager.isInitialized()) {
      try {
        const result = await AgentManager.processMessage(message, `cron:stale_reminders`, sessionId);
        await this.routeJobResponse('stale_reminders', '', result.response, representative.channel, sessionId);
      } catch (err) {
        console.error('[Scheduler] Failed to process stale reminders through agent:', err);
        await this.routeJobResponse('stale_reminders', '', message, representative.channel, sessionId);
      }
    } else {
      await this.routeJobResponse('stale_reminders', '', message, representative.channel, sessionId);
    }

    // Mark all as stale
    const ids = staleJobs.map(j => j.id);
    db.prepare(`UPDATE cron_jobs SET status = 'stale', updated_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);

    console.log(`[Scheduler] Marked ${staleJobs.length} reminders as stale`);
  }

  /**
   * Calculate next run time based on schedule type
   */
  private calculateNextRun(type: string, schedule: string | null, intervalMs: number | null): string | null {
    const now = new Date();

    if (type === 'at') {
      // One-time job, no next run
      return null;
    }

    if (type === 'every' && intervalMs) {
      return new Date(now.getTime() + intervalMs).toISOString();
    }

    if (type === 'cron' && schedule) {
      // Parse cron expression for next run calculation
      const parts = schedule.split(/\s+/);
      if (parts.length !== 5) {
        console.warn(`[Scheduler] Invalid cron expression (expected 5 parts): "${schedule}"`);
        return new Date(now.getTime() + 86400000).toISOString();
      }

      const [min, hour] = parts;

      // If both minute and hour are wildcards (e.g. "* * * * *"), next run is the next minute
      if (min === '*' && hour === '*') {
        const next = new Date(now);
        next.setSeconds(0, 0);
        next.setMinutes(next.getMinutes() + 1);
        return next.toISOString();
      }

      // If only minute is wildcard (e.g. "* 14 * * *"), next run is next minute within that hour
      if (min === '*' && hour !== '*') {
        const targetHour = parseInt(hour, 10);
        const next = new Date(now);
        next.setSeconds(0, 0);
        if (next.getHours() === targetHour && next > now) {
          return next.toISOString();
        } else if (next.getHours() === targetHour) {
          next.setMinutes(next.getMinutes() + 1);
          if (next.getHours() !== targetHour) {
            next.setDate(next.getDate() + 1);
            next.setHours(targetHour, 0, 0, 0);
          }
          return next.toISOString();
        } else {
          next.setHours(targetHour, 0, 0, 0);
          if (next <= now) next.setDate(next.getDate() + 1);
          return next.toISOString();
        }
      }

      // If only hour is wildcard (e.g. "30 * * * *"), next run is :30 of the next matching hour
      if (min !== '*' && hour === '*') {
        const targetMin = parseInt(min, 10);
        const next = new Date(now);
        next.setSeconds(0, 0);
        next.setMinutes(targetMin);
        if (next <= now) {
          next.setHours(next.getHours() + 1);
        }
        return next.toISOString();
      }

      // Both specified (e.g. "30 14 * * *")
      const next = new Date(now);
      next.setSeconds(0, 0);
      next.setMinutes(parseInt(min, 10));
      next.setHours(parseInt(hour, 10));
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next.toISOString();
    }

    // Fallback for unknown schedule types - don't disable the job
    console.warn(`[Scheduler] Unknown schedule type "${type}", defaulting to 24h interval`);
    return new Date(now.getTime() + 86400000).toISOString();
  }

  /**
   * Route job response to appropriate channel(s).
   * Always sends to desktop (to the correct session), and also to Telegram if configured.
   */
  private async routeJobResponse(jobName: string, prompt: string, response: string, channel: string, sessionId: string = 'default'): Promise<void> {
    // Always send to desktop (notification + chat to the correct session)
    const plainResponse = this.stripMarkdown(response);
    if (this.onNotification) {
      this.onNotification('Pocket Agent', plainResponse.slice(0, 200));
    }
    if (this.onChatMessage) {
      this.onChatMessage(jobName, prompt, response, sessionId);
    }

    // Also send to Telegram if channel includes 'telegram'
    if (channel.includes('telegram') && this.telegramBot && this.memory) {
      const linkedChatId = this.memory.getChatForSession(sessionId);
      const fallbackChatId = linkedChatId || parseInt(SettingsManager.get('telegram.defaultChatId') || '', 10) || null;
      if (fallbackChatId) {
        // Check for screenshot paths in response and send as photos
        const screenshotPaths = this.extractScreenshotPaths(response);
        for (const photoPath of screenshotPaths) {
          await this.telegramBot.sendPhoto(fallbackChatId, photoPath);
        }
        // Send text response (strip screenshot paths for cleaner message)
        const cleanResponse = this.stripScreenshotPaths(response);
        if (cleanResponse.trim()) {
          await this.telegramBot.sendMessage(fallbackChatId, cleanResponse);
        }
      }
    }

    // Also send to email if channel includes 'email'
    if (channel.includes('email')) {
      const gmailEnabled = SettingsManager.getBoolean('gmail.enabled');
      const recipient = SettingsManager.get('gmail.defaultRecipient');
      if (gmailEnabled && recipient) {
        gogSendEmail({ to: recipient, subject: `Pocket Agent: ${jobName}`, body: plainResponse })
          .catch(err => console.error('[Scheduler] Email send failed:', err));
      }
    }
  }

  /**
   * Send a reminder notification.
   * Always sends to desktop (to the correct session), and also to Telegram/email if configured.
   */
  private async sendReminder(type: 'calendar' | 'task', title: string, message: string, channel: string, sessionId: string = 'default'): Promise<void> {
    console.log(`[Scheduler] Sending ${type} reminder: ${title} (session: ${sessionId})`);

    // Always send to desktop (notification + chat to the correct session)
    if (this.onNotification) {
      this.onNotification('Pocket Agent', message);
    }
    if (this.onChatMessage) {
      this.onChatMessage(`${type}_reminder`, message, message, sessionId);
    }

    // Also send to Telegram if channel includes 'telegram'
    if (channel.includes('telegram') && this.telegramBot && this.memory) {
      const linkedChatId = this.memory.getChatForSession(sessionId);
      const fallbackChatId = linkedChatId || parseInt(SettingsManager.get('telegram.defaultChatId') || '', 10) || null;
      if (fallbackChatId) {
        await this.telegramBot.sendMessage(fallbackChatId, `${type === 'calendar' ? '📅' : '✓'} ${message}`);
      }
    }

    // Also send to email if channel includes 'email'
    if (channel.includes('email')) {
      const gmailEnabled = SettingsManager.getBoolean('gmail.enabled');
      const recipient = SettingsManager.get('gmail.defaultRecipient');
      if (gmailEnabled && recipient) {
        const prefix = type === 'calendar' ? '[Calendar]' : '[Task]';
        gogSendEmail({ to: recipient, subject: `${prefix} ${title}`, body: message })
          .catch(err => console.error('[Scheduler] Email reminder failed:', err));
      }
    }

    // Log to history
    this.addToHistory({
      jobName: `${type}:${title}`,
      response: message,
      channel,
      success: true,
      timestamp: new Date(),
    });
  }

  /**
   * Set Telegram bot for routing messages
   */
  setTelegramBot(bot: TelegramBot | null): void {
    this.telegramBot = bot;
    console.log(`[Scheduler] Telegram bot ${bot ? 'connected' : 'disconnected'}`);
  }

  /**
   * Load all enabled jobs from database and schedule them
   * Note: Only 'cron' type jobs are scheduled with node-cron.
   * 'at' and 'every' jobs are handled by checkDueJobs() timer.
   */
  async loadJobsFromDatabase(): Promise<void> {
    if (!this.memory) {
      console.error('[Scheduler] Memory not initialized');
      return;
    }

    // Stop all existing cron tasks (but not the reminder interval)
    for (const [name, task] of this.tasks) {
      task.stop();
      console.log(`[Scheduler] Stopped: ${name}`);
    }
    this.tasks.clear();
    this.jobs.clear();

    // Load jobs from SQLite
    const dbJobs = this.memory.getCronJobs(true); // enabled only
    let cronJobCount = 0;

    for (const dbJob of dbJobs) {
      // Only schedule 'cron' type jobs with node-cron
      // 'at' and 'every' jobs are handled by the timer in checkDueJobs()
      const scheduleType = dbJob.schedule_type || 'cron';
      if (scheduleType !== 'cron' || !dbJob.schedule) {
        continue;
      }

      const job: ScheduledJob = {
        id: dbJob.id,
        name: dbJob.name,
        scheduleType: 'cron',
        schedule: dbJob.schedule,
        prompt: dbJob.prompt,
        channel: dbJob.channel,
        recipient: this.extractRecipient(dbJob.prompt),
        enabled: dbJob.enabled,
        sessionId: dbJob.session_id || 'default',
      };

      if (this.scheduleJob(job)) {
        cronJobCount++;
      }
    }

    console.log(`[Scheduler] Loaded ${dbJobs.length} jobs (${cronJobCount} cron, ${dbJobs.length - cronJobCount} timer-based)`);
  }

  /**
   * Extract recipient from prompt if specified (format: @recipient: prompt)
   */
  private extractRecipient(prompt: string): string | undefined {
    const match = prompt.match(/^@(\S+):\s*/);
    return match ? match[1] : undefined;
  }

  /**
   * Schedule a single job
   */
  scheduleJob(job: ScheduledJob): boolean {
    if (!job.schedule || !cron.validate(job.schedule)) {
      console.error(`[Scheduler] Invalid cron expression for ${job.name}: ${job.schedule}`);
      return false;
    }

    // Stop existing task with same name
    this.stopJob(job.name);

    const schedule = job.schedule;
    const task = cron.schedule(schedule, async () => {
      await this.executeJob(job);
    });

    this.tasks.set(job.name, task);
    this.jobs.set(job.name, job);

    console.log(`[Scheduler] Scheduled: ${job.name} (${job.schedule}) → ${job.channel}`);
    return true;
  }

  /**
   * Execute a job
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    console.log(`[Scheduler] Executing: ${job.name}`);

    const result: JobResult = {
      jobName: job.name,
      response: '',
      channel: job.channel,
      success: false,
      timestamp: new Date(),
    };

    if (!AgentManager.isInitialized()) {
      result.error = 'AgentManager not initialized';
      this.addToHistory(result);
      console.error(`[Scheduler] ${result.error}`);
      return;
    }

    try {
      // Clean prompt (remove recipient prefix if present)
      let cleanPrompt = job.prompt.replace(/^@\S+:\s*/, '');

      // Expand workflow references: @workflow:name optional context
      const workflowMatch = cleanPrompt.match(/^@workflow:(\S+)\s*([\s\S]*)$/);
      if (workflowMatch) {
        const [, workflowName, extraContext] = workflowMatch;
        const workflow = findWorkflowCommand(workflowName);
        if (workflow) {
          cleanPrompt = `[Workflow: ${workflow.name}]\n${workflow.content}\n[/Workflow]`;
          if (extraContext.trim()) {
            cleanPrompt += `\n\n${extraContext.trim()}`;
          }
          console.log(`[Scheduler] Expanded workflow: ${workflowName}`);
        } else {
          console.warn(`[Scheduler] Workflow not found: ${workflowName}, sending raw prompt`);
        }
      }

      // Wrap prompt so the LLM knows it's executing a scheduled routine, not being asked to create one
      const routinePrompt = `[SCHEDULED ROUTINE "${job.name}" - EXECUTE NOW]\nYou are running as an automated scheduled routine. Do NOT discuss scheduling or your capabilities. Execute the following task immediately and always provide a full report:\n\n${cleanPrompt}`;

      // Process through agent (use job's session)
      const sessionId = job.sessionId || 'default';
      const agentResult = await AgentManager.processMessage(
        routinePrompt,
        `cron:${job.name}`,
        sessionId
      );

      result.response = agentResult.response;
      result.success = true;

      // Deliver BEFORE marking DB as done — prevents silent message loss on crash
      await this.routeJobResponse(job.name, job.prompt, result.response, job.channel || 'desktop', job.sessionId || 'default');

      // Sync DB timestamps so checkDueJobs knows this job already ran
      if (this.db) {
        const runTime = new Date();
        const nextRunAt = this.calculateNextRun('cron', job.schedule || null, null);
        this.db.prepare(`
          UPDATE cron_jobs SET last_run_at = datetime(?), last_status = 'ok',
          next_run_at = ?, updated_at = datetime('now') WHERE name = ?
        `).run(runTime.toISOString(), nextRunAt, job.name);
      }

    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Scheduler] Job ${job.name} failed:`, result.error);

      // Sync DB error state
      if (this.db) {
        const runTime = new Date();
        const nextRunAt = this.calculateNextRun('cron', job.schedule || null, null);
        this.db.prepare(`
          UPDATE cron_jobs SET last_run_at = datetime(?), last_status = 'error',
          last_error = ?, next_run_at = ?, updated_at = datetime('now') WHERE name = ?
        `).run(runTime.toISOString(), result.error, nextRunAt, job.name);
      }
    }

    this.addToHistory(result);
  }

  /**
   * Strip markdown formatting for plain text (notifications)
   */
  private extractScreenshotPaths(text: string): string[] {
    const pattern = /(?:\/[\w./-]+\/screenshots\/screenshot-\d+\.png)/g;
    const matches = text.match(pattern);
    return matches || [];
  }

  private stripScreenshotPaths(text: string): string {
    return text
      .replace(/(?:saved to |screenshot: )?\/[\w./-]+\/screenshots\/screenshot-\d+\.png/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private stripMarkdown(text: string): string {
    return text
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '[code]')
      .replace(/`([^`]+)`/g, '$1')
      // Remove links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove bullet points
      .replace(/^[\s]*[-*+]\s+/gm, '• ')
      // Remove extra whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Set notification handler
   */
  setNotificationHandler(handler: (title: string, body: string) => void): void {
    this.onNotification = handler;
  }

  /**
   * Set chat message handler (for sending to chat window)
   */
  setChatHandler(handler: (jobName: string, prompt: string, response: string, sessionId: string) => void): void {
    this.onChatMessage = handler;
  }

  private onNotification?: (title: string, body: string) => void;
  private onChatMessage?: (jobName: string, prompt: string, response: string, sessionId: string) => void;

  /**
   * Add result to history
   */
  private addToHistory(result: JobResult): void {
    this.jobHistory.unshift(result);
    if (this.jobHistory.length > this.maxHistorySize) {
      this.jobHistory.pop();
    }
  }

  /**
   * Create a new job and save to database
   */
  async createJob(
    name: string,
    schedule: string,
    prompt: string,
    channel: string = 'default',
    sessionId: string = 'default'
  ): Promise<boolean> {
    if (!this.memory) return false;

    if (!cron.validate(schedule)) {
      console.error(`[Scheduler] Invalid cron: ${schedule}`);
      return false;
    }

    // Save to database
    const id = this.memory.saveCronJob(name, schedule, prompt, channel, sessionId);

    // Schedule it
    const job: ScheduledJob = {
      id,
      name,
      schedule,
      prompt,
      channel,
      recipient: this.extractRecipient(prompt),
      enabled: true,
      sessionId,
    };

    return this.scheduleJob(job);
  }

  /**
   * Update a job's prompt and optionally session
   */
  updateJob(name: string, prompt: string, sessionId?: string): boolean {
    if (!this.memory) return false;
    const updated = this.memory.updateCronJobPrompt(name, prompt, sessionId);
    if (updated) {
      const job = this.jobs.get(name);
      if (job) {
        job.prompt = prompt;
        if (sessionId) job.sessionId = sessionId;
      }
    }
    return updated;
  }

  /**
   * Delete a job
   */
  deleteJob(name: string): boolean {
    this.stopJob(name);

    if (this.memory) {
      return this.memory.deleteCronJob(name);
    }

    return false;
  }

  /**
   * Stop a specific job
   */
  stopJob(name: string): boolean {
    const task = this.tasks.get(name);
    if (task) {
      task.stop();
      this.tasks.delete(name);
      this.jobs.delete(name);
      console.log(`[Scheduler] Stopped: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Stop all jobs
   */
  stopAll(): void {
    // Stop reload interval
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
    }

    // Stop reminder interval
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }

    // Stop auto-poster and engagement check intervals
    if (this.autoPosterInterval) {
      clearInterval(this.autoPosterInterval);
      this.autoPosterInterval = null;
    }
    if (this.engagementCheckInterval) {
      clearInterval(this.engagementCheckInterval);
      this.engagementCheckInterval = null;
    }
    if (this.linkedInAutoScrapeInterval) {
      clearInterval(this.linkedInAutoScrapeInterval);
      this.linkedInAutoScrapeInterval = null;
    }

    // Close persistent DB connection
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors
      }
      this.db = null;
    }

    for (const [name, task] of this.tasks) {
      task.stop();
      console.log(`[Scheduler] Stopped: ${name}`);
    }
    this.tasks.clear();
    this.jobs.clear();
  }

  /**
   * Enable/disable a job
   */
  setJobEnabled(name: string, enabled: boolean): boolean {
    if (!this.memory) return false;

    const success = this.memory.setCronJobEnabled(name, enabled);

    if (success) {
      if (enabled) {
        // Reload from database to reschedule
        const dbJobs = this.memory.getCronJobs(false);
        const dbJob = dbJobs.find(j => j.name === name);
        if (dbJob) {
          this.scheduleJob({
            id: dbJob.id,
            name: dbJob.name,
            schedule: dbJob.schedule,
            prompt: dbJob.prompt,
            channel: dbJob.channel,
            recipient: this.extractRecipient(dbJob.prompt),
            enabled: true,
            sessionId: dbJob.session_id || 'default',
          });
        }
      } else {
        this.stopJob(name);
      }
    }

    return success;
  }

  /**
   * Run a job immediately (for testing)
   */
  async runJobNow(name: string): Promise<JobResult | null> {
    const job = this.jobs.get(name);
    if (!job) {
      console.error(`[Scheduler] Job not found: ${name}`);
      return null;
    }

    await this.executeJob(job);
    return this.jobHistory[0] || null;
  }

  /**
   * Catch up any jobs missed during macOS sleep/wake
   */
  async catchUpMissedJobs(): Promise<void> {
    console.log('[Scheduler] Catching up missed jobs after wake');

    // Reset mutex in case a previous check was stuck mid-flight when sleep happened
    this.isCheckingReminders = false;

    // Reload node-cron tasks (they die during macOS sleep)
    await this.loadJobsFromDatabase();

    // Run check immediately to catch up missed jobs
    await this.checkReminders();
  }

  /**
   * Get all jobs
   */
  getJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get all jobs including disabled ones
   */
  getAllJobs(): CronJob[] {
    return this.memory?.getCronJobs(false) || [];
  }

  /**
   * Get job history
   */
  getHistory(limit: number = 20): JobResult[] {
    return this.jobHistory.slice(0, limit);
  }

  /**
   * Check if a job is running
   */
  isRunning(name: string): boolean {
    return this.tasks.has(name);
  }

  /**
   * Get scheduler stats
   */
  getStats(): { activeJobs: number; totalExecutions: number; lastExecution?: Date } {
    return {
      activeJobs: this.tasks.size,
      totalExecutions: this.jobHistory.length,
      lastExecution: this.jobHistory[0]?.timestamp,
    };
  }
}

// Singleton instance
let schedulerInstance: CronScheduler | null = null;

export function getScheduler(): CronScheduler | null {
  return schedulerInstance;
}

export function createScheduler(): CronScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new CronScheduler();
  }
  return schedulerInstance;
}

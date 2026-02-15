import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronScheduler, ScheduledJob } from '../../src/scheduler';
import type { MemoryManager, CronJob } from '../../src/memory';

// Mock node-cron
vi.mock('node-cron', () => {
  return {
    default: {
      validate: vi.fn((expr: string) => {
        // Simple validation: must have 5 space-separated parts
        const parts = expr.split(/\s+/);
        if (parts.length !== 5) return false;
        // Check for valid patterns (numbers, *, ranges, etc.)
        const pattern = /^(\*|[0-9]+(-[0-9]+)?)(\/[0-9]+)?$/;
        return parts.every((p) => pattern.test(p) || p === '*');
      }),
      schedule: vi.fn((_schedule: string, _callback: () => void) => {
        return {
          stop: vi.fn(),
        };
      }),
    },
  };
});

// Mock better-sqlite3 to avoid native module issues
vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn(),
  };
});

// Mock AgentManager to avoid actual agent processing
vi.mock('../../src/agent', () => ({
  AgentManager: {
    isInitialized: vi.fn(() => true),
    processMessage: vi.fn(async () => ({
      response: 'Mock agent response',
      messages: [],
    })),
  },
}));

/**
 * Create a mock MemoryManager for testing
 */
function createMockMemoryManager(): MemoryManager & { _jobs: Map<string, CronJob> } {
  const jobs = new Map<string, CronJob>();
  let jobIdCounter = 0;

  return {
    _jobs: jobs,
    saveCronJob: vi.fn((name: string, schedule: string, prompt: string, channel: string) => {
      const id = ++jobIdCounter;
      jobs.set(name, {
        id,
        name,
        schedule,
        prompt,
        channel,
        enabled: true,
      });
      return id;
    }),
    getCronJobs: vi.fn((enabledOnly: boolean) => {
      const allJobs = Array.from(jobs.values());
      if (enabledOnly) {
        return allJobs.filter((j) => j.enabled);
      }
      return allJobs;
    }),
    setCronJobEnabled: vi.fn((name: string, enabled: boolean) => {
      const job = jobs.get(name);
      if (job) {
        job.enabled = enabled;
        return true;
      }
      return false;
    }),
    deleteCronJob: vi.fn((name: string) => {
      return jobs.delete(name);
    }),
    getRecentMessages: vi.fn(() => []),
    close: vi.fn(),
  } as unknown as MemoryManager & { _jobs: Map<string, CronJob> };
}

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let mockMemory: ReturnType<typeof createMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock memory manager for each test
    mockMemory = createMockMemoryManager();

    // Create fresh scheduler instance
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    // Clean up
    if (scheduler) {
      scheduler.stopAll();
    }
  });

  describe('initialization', () => {
    it('should initialize with memory manager', async () => {
      await scheduler.initialize(mockMemory);

      const jobs = scheduler.getJobs();
      expect(jobs).toEqual([]);
      expect(mockMemory.getCronJobs).toHaveBeenCalledWith(true);
    });

    it('should load existing jobs from database on initialization', async () => {
      // Pre-add a job to the mock
      mockMemory._jobs.set('test-job', {
        id: 1,
        name: 'test-job',
        schedule: '0 9 * * *',
        prompt: 'Test prompt',
        channel: 'desktop',
        enabled: true,
      });

      await scheduler.initialize(mockMemory);

      const jobs = scheduler.getJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].name).toBe('test-job');
      expect(jobs[0].schedule).toBe('0 9 * * *');
    });
  });

  describe('createJob (addJob)', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should create a new job with valid cron expression', async () => {
      const result = await scheduler.createJob(
        'daily-report',
        '0 9 * * *',
        'Generate daily report',
        'desktop'
      );

      expect(result).toBe(true);
      expect(mockMemory.saveCronJob).toHaveBeenCalledWith(
        'daily-report',
        '0 9 * * *',
        'Generate daily report',
        'desktop',
        'default'
      );

      const jobs = scheduler.getJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].name).toBe('daily-report');
      expect(jobs[0].schedule).toBe('0 9 * * *');
      expect(jobs[0].prompt).toBe('Generate daily report');
      expect(jobs[0].channel).toBe('desktop');
      expect(jobs[0].enabled).toBe(true);
    });

    it('should reject invalid cron expression', async () => {
      const result = await scheduler.createJob('bad-job', 'not-a-cron', 'Some prompt', 'desktop');

      expect(result).toBe(false);
      expect(mockMemory.saveCronJob).not.toHaveBeenCalled();

      const jobs = scheduler.getJobs();
      expect(jobs.length).toBe(0);
    });

    it('should persist job to database', async () => {
      await scheduler.createJob('persistent-job', '30 8 * * *', 'Morning reminder', 'telegram');

      expect(mockMemory.saveCronJob).toHaveBeenCalledWith(
        'persistent-job',
        '30 8 * * *',
        'Morning reminder',
        'telegram',
        'default'
      );

      // Verify in mock
      const savedJob = mockMemory._jobs.get('persistent-job');
      expect(savedJob).toBeDefined();
      expect(savedJob?.name).toBe('persistent-job');
      expect(savedJob?.schedule).toBe('30 8 * * *');
      expect(savedJob?.prompt).toBe('Morning reminder');
      expect(savedJob?.channel).toBe('telegram');
    });

    it('should use default channel when not specified', async () => {
      await scheduler.createJob('default-channel-job', '0 12 * * *', 'Lunch reminder');

      const jobs = scheduler.getJobs();
      expect(jobs[0].channel).toBe('default');
    });

    it('should extract recipient from prompt with @ prefix', async () => {
      await scheduler.createJob('targeted-job', '0 10 * * *', '@123456789: Hello user!', 'telegram');

      const jobs = scheduler.getJobs();
      expect(jobs[0].recipient).toBe('123456789');
    });

    it('should create multiple jobs', async () => {
      await scheduler.createJob('job-1', '0 8 * * *', 'Morning', 'desktop');
      await scheduler.createJob('job-2', '0 12 * * *', 'Noon', 'desktop');
      await scheduler.createJob('job-3', '0 18 * * *', 'Evening', 'desktop');

      const jobs = scheduler.getJobs();
      expect(jobs.length).toBe(3);
    });
  });

  describe('getJobs (listing)', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should return empty array when no jobs exist', () => {
      const jobs = scheduler.getJobs();
      expect(jobs).toEqual([]);
    });

    it('should return all active jobs', async () => {
      await scheduler.createJob('job-a', '0 9 * * *', 'Task A', 'desktop');
      await scheduler.createJob('job-b', '0 10 * * *', 'Task B', 'telegram');

      const jobs = scheduler.getJobs();
      expect(jobs.length).toBe(2);
      expect(jobs.map((j) => j.name).sort()).toEqual(['job-a', 'job-b']);
    });

    it('should return job with correct properties', async () => {
      await scheduler.createJob('detailed-job', '15 14 * * *', 'Detailed task', 'desktop');

      const jobs = scheduler.getJobs();
      const job = jobs[0];

      expect(job).toMatchObject({
        name: 'detailed-job',
        schedule: '15 14 * * *',
        prompt: 'Detailed task',
        channel: 'desktop',
        enabled: true,
      });
      expect(job.id).toBeDefined();
    });
  });

  describe('getAllJobs', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should return all jobs including disabled ones', async () => {
      await scheduler.createJob('enabled-job', '0 9 * * *', 'Enabled', 'desktop');
      await scheduler.createJob('to-disable', '0 10 * * *', 'Will disable', 'desktop');

      // Disable one job
      scheduler.setJobEnabled('to-disable', false);

      // getJobs returns only enabled/scheduled jobs
      const activeJobs = scheduler.getJobs();
      expect(activeJobs.length).toBe(1);

      // getAllJobs returns all from database
      const allJobs = scheduler.getAllJobs();
      expect(allJobs.length).toBe(2);
    });
  });

  describe('deleteJob', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should delete an existing job', async () => {
      await scheduler.createJob('to-delete', '0 9 * * *', 'Delete me', 'desktop');

      const result = scheduler.deleteJob('to-delete');

      expect(result).toBe(true);
      expect(scheduler.getJobs().length).toBe(0);
      expect(mockMemory.deleteCronJob).toHaveBeenCalledWith('to-delete');
    });

    it('should return false when deleting non-existent job', () => {
      const result = scheduler.deleteJob('non-existent');

      expect(result).toBe(false);
    });

    it('should remove job from database', async () => {
      await scheduler.createJob('db-delete', '0 9 * * *', 'DB delete', 'desktop');

      scheduler.deleteJob('db-delete');

      expect(mockMemory._jobs.has('db-delete')).toBe(false);
    });

    it('should stop the scheduled task', async () => {
      await scheduler.createJob('stop-task', '0 9 * * *', 'Stop me', 'desktop');

      scheduler.deleteJob('stop-task');

      // Verify task was stopped
      expect(scheduler.isRunning('stop-task')).toBe(false);
    });
  });

  describe('setJobEnabled (toggleJob)', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should disable an enabled job', async () => {
      await scheduler.createJob('toggle-job', '0 9 * * *', 'Toggle me', 'desktop');

      const result = scheduler.setJobEnabled('toggle-job', false);

      expect(result).toBe(true);
      expect(scheduler.isRunning('toggle-job')).toBe(false);
      expect(mockMemory.setCronJobEnabled).toHaveBeenCalledWith('toggle-job', false);
    });

    it('should enable a disabled job', async () => {
      await scheduler.createJob('disabled-job', '0 9 * * *', 'Enable me', 'desktop');
      scheduler.setJobEnabled('disabled-job', false);

      const result = scheduler.setJobEnabled('disabled-job', true);

      expect(result).toBe(true);
      expect(scheduler.isRunning('disabled-job')).toBe(true);
    });

    it('should persist enabled state to database', async () => {
      await scheduler.createJob('persist-toggle', '0 9 * * *', 'Persist toggle', 'desktop');

      scheduler.setJobEnabled('persist-toggle', false);

      expect(mockMemory.setCronJobEnabled).toHaveBeenCalledWith('persist-toggle', false);
      const job = mockMemory._jobs.get('persist-toggle');
      expect(job?.enabled).toBe(false);
    });

    it('should return false for non-existent job', () => {
      const result = scheduler.setJobEnabled('non-existent', true);

      expect(result).toBe(false);
    });
  });

  describe('cron expression validation', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should accept valid cron expressions', async () => {
      const validExpressions = [
        '* * * * *', // Every minute
        '0 * * * *', // Every hour
        '0 0 * * *', // Every day at midnight
        '0 9 * * 1', // Every Monday at 9am
        '30 8 * * *', // Daily at 8:30
      ];

      for (const expr of validExpressions) {
        const result = await scheduler.createJob(`job-${expr.replace(/\s+/g, '-')}`, expr, 'Test', 'desktop');
        expect(result).toBe(true);
      }
    });

    it('should reject invalid cron expressions', async () => {
      const invalidExpressions = [
        'invalid',
        '* * *', // Only 3 parts
        '', // Empty
        '* * * * * *', // 6 parts (seconds not supported in standard format)
      ];

      for (const expr of invalidExpressions) {
        const result = await scheduler.createJob(`job-${expr || 'empty'}`, expr, 'Test', 'desktop');
        expect(result).toBe(false);
      }
    });
  });

  describe('stopJob', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should stop a running job', async () => {
      await scheduler.createJob('running-job', '0 9 * * *', 'Running', 'desktop');

      const result = scheduler.stopJob('running-job');

      expect(result).toBe(true);
      expect(scheduler.isRunning('running-job')).toBe(false);
    });

    it('should return false for non-existent job', () => {
      const result = scheduler.stopJob('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('stopAll', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should stop all running jobs', async () => {
      await scheduler.createJob('job-1', '0 8 * * *', 'Task 1', 'desktop');
      await scheduler.createJob('job-2', '0 9 * * *', 'Task 2', 'desktop');
      await scheduler.createJob('job-3', '0 10 * * *', 'Task 3', 'desktop');

      scheduler.stopAll();

      expect(scheduler.getJobs().length).toBe(0);
      expect(scheduler.isRunning('job-1')).toBe(false);
      expect(scheduler.isRunning('job-2')).toBe(false);
      expect(scheduler.isRunning('job-3')).toBe(false);
    });
  });

  describe('isRunning', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should return true for running jobs', async () => {
      await scheduler.createJob('running', '0 9 * * *', 'Running', 'desktop');

      expect(scheduler.isRunning('running')).toBe(true);
    });

    it('should return false for non-existent jobs', () => {
      expect(scheduler.isRunning('non-existent')).toBe(false);
    });

    it('should return false for stopped jobs', async () => {
      await scheduler.createJob('stopped', '0 9 * * *', 'Stopped', 'desktop');
      scheduler.stopJob('stopped');

      expect(scheduler.isRunning('stopped')).toBe(false);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should return correct stats with no jobs', () => {
      const stats = scheduler.getStats();

      expect(stats.activeJobs).toBe(0);
      expect(stats.totalExecutions).toBe(0);
      expect(stats.lastExecution).toBeUndefined();
    });

    it('should return correct active job count', async () => {
      await scheduler.createJob('job-1', '0 8 * * *', 'Task 1', 'desktop');
      await scheduler.createJob('job-2', '0 9 * * *', 'Task 2', 'desktop');

      const stats = scheduler.getStats();

      expect(stats.activeJobs).toBe(2);
    });
  });

  describe('getHistory', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should return empty history initially', () => {
      const history = scheduler.getHistory();

      expect(history).toEqual([]);
    });

    it('should respect limit parameter', () => {
      const history = scheduler.getHistory(5);

      expect(history.length).toBeLessThanOrEqual(5);
    });
  });

  describe('scheduleJob', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should schedule a job directly', () => {
      const job: ScheduledJob = {
        id: 1,
        name: 'direct-schedule',
        schedule: '0 9 * * *',
        prompt: 'Direct scheduled job',
        channel: 'desktop',
        enabled: true,
      };

      const result = scheduler.scheduleJob(job);

      expect(result).toBe(true);
      expect(scheduler.isRunning('direct-schedule')).toBe(true);
    });

    it('should reject invalid schedule in scheduleJob', () => {
      const job: ScheduledJob = {
        id: 1,
        name: 'invalid-schedule',
        schedule: 'invalid',
        prompt: 'Invalid job',
        channel: 'desktop',
        enabled: true,
      };

      const result = scheduler.scheduleJob(job);

      expect(result).toBe(false);
    });

    it('should replace existing job with same name', async () => {
      await scheduler.createJob('replace-me', '0 8 * * *', 'Original', 'desktop');

      const job: ScheduledJob = {
        id: 2,
        name: 'replace-me',
        schedule: '0 10 * * *',
        prompt: 'Replacement',
        channel: 'desktop',
        enabled: true,
      };

      scheduler.scheduleJob(job);

      const jobs = scheduler.getJobs();
      const found = jobs.find((j) => j.name === 'replace-me');
      expect(found?.schedule).toBe('0 10 * * *');
      expect(found?.prompt).toBe('Replacement');
    });
  });

  describe('notification and chat handlers', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should accept notification handler', () => {
      const handler = vi.fn();

      // Should not throw
      expect(() => scheduler.setNotificationHandler(handler)).not.toThrow();
    });

    it('should accept chat handler', () => {
      const handler = vi.fn();

      // Should not throw
      expect(() => scheduler.setChatHandler(handler)).not.toThrow();
    });
  });

  describe('telegram bot integration', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should accept telegram bot', () => {
      const mockBot = {
        broadcast: vi.fn(),
        sendMessage: vi.fn(),
      };

      // Should not throw
      expect(() => scheduler.setTelegramBot(mockBot as never)).not.toThrow();
    });
  });

  describe('runJobNow', () => {
    beforeEach(async () => {
      await scheduler.initialize(mockMemory);
    });

    it('should return null for non-existent job', async () => {
      const result = await scheduler.runJobNow('non-existent');

      expect(result).toBeNull();
    });
  });
});

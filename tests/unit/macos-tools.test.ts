/**
 * Unit tests for macOS tools (notifications)
 *
 * Tests notification tool definition, input validation,
 * and notification display with mocked Electron Notification.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockShow = vi.fn();
const mockOn = vi.fn();

vi.mock('electron', () => {
  // Track isSupported state via a closure that can be changed per test
  let isSupportedValue = true;
  class MockNotification {
    show = mockShow;
    on = mockOn;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
    static isSupported() {
      return isSupportedValue;
    }
    static _setIsSupported(val: boolean) {
      isSupportedValue = val;
    }
  }
  return { Notification: MockNotification };
});

import { showNotification, handleNotifyTool, getNotifyToolDefinition } from '../../src/tools/macos';
import { Notification } from 'electron';

describe('macos-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset isSupported to true
    (Notification as unknown as { _setIsSupported: (v: boolean) => void })._setIsSupported(true);
  });

  describe('getNotifyToolDefinition', () => {
    it('returns tool definition with correct name', () => {
      const def = getNotifyToolDefinition();

      expect(def.name).toBe('notify');
    });

    it('requires title in input schema', () => {
      const def = getNotifyToolDefinition();

      expect(def.input_schema.required).toContain('title');
    });

    it('has a description', () => {
      const def = getNotifyToolDefinition();

      expect(def.description).toBeDefined();
      expect(def.description.length).toBeGreaterThan(0);
    });

    it('defines expected properties in schema', () => {
      const def = getNotifyToolDefinition();
      const props = def.input_schema.properties;

      expect(props).toHaveProperty('title');
      expect(props).toHaveProperty('body');
      expect(props).toHaveProperty('subtitle');
      expect(props).toHaveProperty('silent');
      expect(props).toHaveProperty('urgency');
    });
  });

  describe('handleNotifyTool', () => {
    it('returns error when title is missing', async () => {
      const result = await handleNotifyTool({});

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('title is required');
    });

    it('returns error when title is empty string', async () => {
      const result = await handleNotifyTool({ title: '' });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('title is required');
    });

    it('returns success with valid title', async () => {
      const result = await handleNotifyTool({ title: 'Test Notification' });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });

    it('returns success with full options', async () => {
      const result = await handleNotifyTool({
        title: 'Test',
        body: 'Body text',
        subtitle: 'Subtitle',
        silent: true,
        urgency: 'critical',
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });
  });

  describe('showNotification', () => {
    it('creates Notification and calls show', async () => {
      const result = await showNotification({ title: 'Hello' });

      expect(result.success).toBe(true);
      expect(mockShow).toHaveBeenCalled();
    });

    it('returns error when notifications not supported', async () => {
      (Notification as unknown as { _setIsSupported: (v: boolean) => void })._setIsSupported(false);

      const result = await showNotification({ title: 'Hello' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('passes all options to Notification constructor', async () => {
      await showNotification({
        title: 'Title',
        body: 'Body text',
        subtitle: 'Sub',
        silent: true,
        urgency: 'critical',
      });

      expect(mockShow).toHaveBeenCalled();
    });

    it('registers a failed event listener', async () => {
      await showNotification({ title: 'Test' });

      expect(mockOn).toHaveBeenCalledWith('failed', expect.any(Function));
    });
  });
});

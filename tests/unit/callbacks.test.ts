/**
 * Unit tests for Telegram callback query parser
 *
 * Tests parsing of callback data strings into structured CallbackQueryData
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { parseCallbackData } from '../../src/channels/telegram/handlers/callbacks';

describe('Callback Query Parser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('parseCallbackData', () => {
    it('should parse page:3 as pagination with page 3', () => {
      const result = parseCallbackData('page:3');
      expect(result).toEqual({
        action: 'pagination',
        page: 3,
      });
    });

    it('should parse page:0 as pagination with page 0', () => {
      const result = parseCallbackData('page:0');
      expect(result).toEqual({
        action: 'pagination',
        page: 0,
      });
    });

    it('should parse page:invalid as pagination with page 0 (NaN fallback)', () => {
      const result = parseCallbackData('page:invalid');
      expect(result).toEqual({
        action: 'pagination',
        page: 0,
      });
    });

    it('should parse page with large number', () => {
      const result = parseCallbackData('page:999');
      expect(result).toEqual({
        action: 'pagination',
        page: 999,
      });
    });

    it('should parse confirm:delete:123 as confirm action with payload', () => {
      const result = parseCallbackData('confirm:delete:123');
      expect(result).toEqual({
        action: 'confirm',
        payload: 'delete:123',
      });
    });

    it('should parse location:search_nearby:cafes correctly', () => {
      const result = parseCallbackData('location:search_nearby:cafes');
      expect(result).toEqual({
        action: 'location',
        payload: 'search_nearby:cafes',
      });
    });

    it('should parse reaction:msg1:thumbs_up emoji', () => {
      const result = parseCallbackData('reaction:msg1:👍');
      expect(result).toEqual({
        action: 'reaction',
        payload: 'msg1:👍',
      });
    });

    it('should parse unknown single-word action', () => {
      const result = parseCallbackData('unknown');
      expect(result).toEqual({
        action: 'unknown',
        payload: '',
      });
    });

    it('should parse action with empty payload after colon', () => {
      const result = parseCallbackData('action:');
      expect(result).toEqual({
        action: 'action',
        payload: '',
      });
    });

    it('should handle multiple colons in payload', () => {
      const result = parseCallbackData('data:a:b:c:d');
      expect(result).toEqual({
        action: 'data',
        payload: 'a:b:c:d',
      });
    });

    it('should parse simple action:value format', () => {
      const result = parseCallbackData('cancel:task42');
      expect(result).toEqual({
        action: 'cancel',
        payload: 'task42',
      });
    });
  });
});

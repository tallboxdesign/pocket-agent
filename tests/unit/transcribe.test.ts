/**
 * Unit tests for the audio transcription utility
 *
 * Tests transcription success/failure paths and availability checks
 * with mocked OpenAI client and SettingsManager.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  // Must use function/class syntax for constructor mocks
  class MockOpenAI {
    audio = {
      transcriptions: {
        create: mockCreate,
      },
    };
  }
  // Attach APIError as a static property
  class MockAPIError extends Error {
    status: number;
    constructor(status: number, _body: unknown, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }
  (MockOpenAI as unknown as Record<string, unknown>).APIError = MockAPIError;
  return {
    default: MockOpenAI,
  };
});

vi.mock('../../src/settings', () => ({
  SettingsManager: {
    get: vi.fn(() => 'test-openai-api-key'),
  },
}));

import { transcribeAudio, isTranscriptionAvailable } from '../../src/utils/transcribe';
import { SettingsManager } from '../../src/settings';

describe('transcribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SettingsManager.get).mockReturnValue('test-openai-api-key');
  });

  describe('transcribeAudio', () => {
    it('returns text and duration on success', async () => {
      mockCreate.mockResolvedValue({ text: 'Hello, world!' });

      const result = await transcribeAudio(Buffer.from('fake-audio'), 'ogg');

      expect(result.success).toBe(true);
      expect(result.text).toBe('Hello, world!');
      expect(result.duration).toBeTypeOf('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('returns error when API key is not configured', async () => {
      vi.mocked(SettingsManager.get).mockReturnValue('');

      const result = await transcribeAudio(Buffer.from('fake-audio'), 'mp3');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('returns error on generic Error', async () => {
      mockCreate.mockRejectedValue(new Error('Network timeout'));

      const result = await transcribeAudio(Buffer.from('fake-audio'), 'wav');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });

    it('handles unknown error types', async () => {
      mockCreate.mockRejectedValue('string error');

      const result = await transcribeAudio(Buffer.from('fake-audio'), 'ogg');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown transcription error');
    });

    it('passes language parameter when provided', async () => {
      mockCreate.mockResolvedValue({ text: 'Bonjour' });

      await transcribeAudio(Buffer.from('fake-audio'), 'mp3', 'fr');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'whisper-1',
          language: 'fr',
        }),
      );
    });
  });

  describe('isTranscriptionAvailable', () => {
    it('returns true when OpenAI API key is set', () => {
      vi.mocked(SettingsManager.get).mockReturnValue('sk-test-key');

      expect(isTranscriptionAvailable()).toBe(true);
    });

    it('returns false when OpenAI API key is empty', () => {
      vi.mocked(SettingsManager.get).mockReturnValue('');

      expect(isTranscriptionAvailable()).toBe(false);
    });

    it('returns false when OpenAI API key is undefined', () => {
      vi.mocked(SettingsManager.get).mockReturnValue(undefined as unknown as string);

      expect(isTranscriptionAvailable()).toBe(false);
    });
  });
});

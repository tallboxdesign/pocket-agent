/**
 * Voice tools for the agent
 *
 * Provides TTS (text-to-speech) capabilities:
 * - speak: Synthesize and play text aloud
 * - voice_status: Check current voice settings
 * - voice_toggle: Enable/disable auto-TTS
 * - voice_config: Configure voice-related settings
 */

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { synthesizeSpeech } from '../voice/tts';
import { SettingsManager } from '../settings';

// ============================================================================
// speak — Synthesize and play text aloud
// ============================================================================

export function getSpeakToolDefinition() {
  return {
    name: 'speak',
    description: `Synthesize text and play it aloud to the user via TTS (text-to-speech).

Use this to speak to the user:
- When the user sent a voice message (respond with voice too)
- When delivering reminders or announcements
- When the user asks you to "say" or "read" something aloud
- When greeting the user verbally

The text will be converted to speech using Edge TTS and played in the chat window.
Markdown is automatically stripped before synthesis.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The text to speak aloud',
        },
      },
      required: ['text'],
    },
  };
}

export async function handleSpeakTool(input: unknown): Promise<string> {
  const params = input as { text?: string };

  if (!params.text) {
    return JSON.stringify({ success: false, error: 'text is required' });
  }

  try {
    const outputDir = path.join(app.getPath('userData'), 'tts-cache');
    const audioPath = await synthesizeSpeech(params.text, outputDir);

    // Push audio to all open windows for playback
    BrowserWindow.getAllWindows().forEach((w) => {
      w.webContents.send('voice:play', audioPath);
    });

    return JSON.stringify({ success: true, audioPath });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'TTS synthesis failed',
    });
  }
}

// ============================================================================
// voice_status — Check current voice settings
// ============================================================================

export function getVoiceStatusToolDefinition() {
  return {
    name: 'voice_status',
    description: `Check the current voice/TTS settings.

Returns whether auto-TTS is enabled (reads all responses aloud)
and whether Telegram voice replies are enabled.`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

export async function handleVoiceStatusTool(): Promise<string> {
  const autoTTS = SettingsManager.get('voice.ttsEnabled') === 'true';
  const telegramVoiceReplies = SettingsManager.get('telegram.voiceReplies') !== 'false';

  return JSON.stringify({
    success: true,
    autoTTS,
    telegramVoiceReplies,
  });
}

// ============================================================================
// voice_toggle — Enable/disable auto-TTS
// ============================================================================

export function getVoiceToggleToolDefinition() {
  return {
    name: 'voice_toggle',
    description: `Enable or disable auto-TTS (automatic text-to-speech for all agent responses).

When enabled, every response you send will also be spoken aloud.
When disabled, only explicit speak() calls will produce audio.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        enabled: {
          type: 'boolean',
          description: 'true to enable auto-TTS, false to disable',
        },
      },
      required: ['enabled'],
    },
  };
}

export async function handleVoiceToggleTool(input: unknown): Promise<string> {
  const params = input as { enabled?: boolean };

  if (params.enabled === undefined) {
    return JSON.stringify({ success: false, error: 'enabled is required' });
  }

  SettingsManager.set('voice.ttsEnabled', String(params.enabled));

  // Sync the toggle state to all open windows
  BrowserWindow.getAllWindows().forEach((w) => {
    w.webContents.send('voice:ttsToggled', params.enabled);
  });

  return JSON.stringify({ success: true, autoTTS: params.enabled });
}

// ============================================================================
// voice_config — Configure voice settings
// ============================================================================

export function getVoiceConfigToolDefinition() {
  return {
    name: 'voice_config',
    description: `Configure voice-related settings.

Currently supports:
- telegramVoiceReplies: Send voice messages alongside text replies in Telegram`,
    input_schema: {
      type: 'object' as const,
      properties: {
        telegramVoiceReplies: {
          type: 'boolean',
          description: 'Enable/disable voice message replies in Telegram',
        },
      },
      required: [],
    },
  };
}

export async function handleVoiceConfigTool(input: unknown): Promise<string> {
  const params = input as { telegramVoiceReplies?: boolean };

  if (params.telegramVoiceReplies !== undefined) {
    SettingsManager.set('telegram.voiceReplies', String(params.telegramVoiceReplies));
  }

  // Return current state of all voice settings
  const autoTTS = SettingsManager.get('voice.ttsEnabled') === 'true';
  const telegramVoiceReplies = SettingsManager.get('telegram.voiceReplies') !== 'false';

  return JSON.stringify({
    success: true,
    autoTTS,
    telegramVoiceReplies,
  });
}

// ============================================================================
// Collection
// ============================================================================

export function getVoiceTools() {
  return [
    {
      ...getSpeakToolDefinition(),
      handler: handleSpeakTool,
    },
    {
      ...getVoiceStatusToolDefinition(),
      handler: handleVoiceStatusTool,
    },
    {
      ...getVoiceToggleToolDefinition(),
      handler: handleVoiceToggleTool,
    },
    {
      ...getVoiceConfigToolDefinition(),
      handler: handleVoiceConfigTool,
    },
  ];
}

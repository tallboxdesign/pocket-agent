/**
 * macOS-specific tools for Pocket Agent
 *
 * Provides:
 * - Native notifications via Electron
 */

import { Notification } from 'electron';

// ============================================================================
// Native Notifications
// ============================================================================

export interface NotifyInput {
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
  urgency?: 'normal' | 'critical' | 'low';
  timeout?: number; // ms before auto-dismiss (not supported on all platforms)
}

export interface NotifyResult {
  success: boolean;
  error?: string;
  clicked?: boolean;
}

/**
 * Show a native desktop notification
 *
 * Returns immediately after showing (fire-and-forget).
 * Does NOT wait for user interaction since macOS notifications
 * can sit in notification center indefinitely.
 */
export function showNotification(input: NotifyInput): Promise<NotifyResult> {
  return new Promise(resolve => {
    try {
      if (!Notification.isSupported()) {
        resolve({ success: false, error: 'Notifications not supported on this system' });
        return;
      }

      const notification = new Notification({
        title: input.title,
        body: input.body || '',
        subtitle: input.subtitle,
        silent: input.silent ?? false,
        urgency: input.urgency || 'normal',
      });

      // Listen for errors only (don't block on click/close)
      notification.on('failed', (_event, error) => {
        console.error('[Notify] Notification failed:', error);
      });

      notification.show();

      // Resolve immediately - don't wait for user interaction
      // macOS notifications can stay in notification center forever
      resolve({ success: true });

    } catch (error) {
      resolve({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

/**
 * Tool definition for native notifications
 */
export function getNotifyToolDefinition() {
  return {
    name: 'notify',
    description: 'Send a native desktop notification to the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Notification title (required)',
        },
        body: {
          type: 'string',
          description: 'Notification body text',
        },
        subtitle: {
          type: 'string',
          description: 'Subtitle (macOS only)',
        },
        silent: {
          type: 'boolean',
          description: 'Suppress notification sound (default: false)',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'critical'],
          description: 'Notification urgency level (default: normal)',
        },
      },
      required: ['title'],
    },
  };
}

/**
 * Handle notify tool invocation
 */
export async function handleNotifyTool(input: unknown): Promise<string> {
  const params = input as NotifyInput;

  if (!params.title) {
    return JSON.stringify({ success: false, error: 'title is required' });
  }

  const result = await showNotification(params);
  return JSON.stringify(result);
}


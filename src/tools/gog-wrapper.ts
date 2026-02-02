/**
 * gog CLI wrapper for Google Workspace operations (Gmail, Calendar, etc.)
 *
 * Uses execFile (not exec) to avoid shell injection.
 * Requires gog to be installed: brew install steipete/tap/gogcli
 * And authenticated: gog auth add user@gmail.com --services gmail
 */

import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/**
 * Execute a gog command and return stdout.
 */
export async function gogExec(args: string[]): Promise<string> {
  const { stdout } = await execFile('gog', args, { timeout: 30000 });
  return stdout.trim();
}

/**
 * Send an email via gog gmail send.
 * Uses spawn with stdin for multi-line body support (--body-file -).
 */
export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  cc?: string;
  account?: string;
}): Promise<{ success: boolean; error?: string }> {
  const args = ['gmail', 'send', '--to', params.to, '--subject', params.subject];

  if (params.cc) {
    args.push('--cc', params.cc);
  }
  if (params.account) {
    args.push('--account', params.account);
  }

  if (params.html) {
    args.push('--body-html', params.body);
    try {
      await execFile('gog', args, { timeout: 30000 });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[gog] sendEmail failed:', msg);
      return { success: false, error: msg };
    }
  }

  // For plain text, use --body-file - with stdin to support multi-line
  args.push('--body-file', '-');

  return new Promise((resolve) => {
    const proc = spawn('gog', args, { timeout: 30000 });
    let stderr = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        console.error('[gog] sendEmail failed (exit', code, '):', stderr);
        resolve({ success: false, error: stderr.trim() || `gog exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      console.error('[gog] sendEmail spawn error:', err.message);
      resolve({ success: false, error: err.message });
    });

    proc.stdin.write(params.body);
    proc.stdin.end();
  });
}

/**
 * Search and read emails via gog gmail messages search.
 */
export async function readEmails(params: {
  query?: string;
  max?: number;
  account?: string;
}): Promise<{ success: boolean; emails?: string; error?: string }> {
  const args = ['gmail', 'messages', 'search', params.query || 'newer_than:1d', '--max', String(params.max || 10), '--json'];

  if (params.account) {
    args.push('--account', params.account);
  }

  try {
    const stdout = await gogExec(args);
    return { success: true, emails: stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[gog] readEmails failed:', msg);
    return { success: false, error: msg };
  }
}

/**
 * List Gmail labels.
 */
export async function listLabels(params: {
  account?: string;
}): Promise<{ success: boolean; labels?: string; error?: string }> {
  const args = ['gmail', 'labels', 'list', '--json'];
  if (params.account) args.push('--account', params.account);

  try {
    const stdout = await gogExec(args);
    return { success: true, labels: stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Create a Gmail label.
 */
export async function createLabel(params: {
  name: string;
  account?: string;
}): Promise<{ success: boolean; output?: string; error?: string }> {
  const args = ['gmail', 'labels', 'create', params.name, '--json'];
  if (params.account) args.push('--account', params.account);

  try {
    const stdout = await gogExec(args);
    return { success: true, output: stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Modify labels on threads (add/remove).
 */
export async function modifyLabels(params: {
  threadIds: string[];
  add?: string;
  remove?: string;
  account?: string;
}): Promise<{ success: boolean; output?: string; error?: string }> {
  const args = ['gmail', 'labels', 'modify', ...params.threadIds];
  if (params.add) args.push('--add', params.add);
  if (params.remove) args.push('--remove', params.remove);
  if (params.account) args.push('--account', params.account);

  try {
    const stdout = await gogExec(args);
    return { success: true, output: stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Create a Gmail draft.
 */
export async function createDraft(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  replyToMessageId?: string;
  account?: string;
}): Promise<{ success: boolean; output?: string; error?: string }> {
  const args = ['gmail', 'drafts', 'create', '--to', params.to, '--subject', params.subject];
  if (params.cc) args.push('--cc', params.cc);
  if (params.replyToMessageId) args.push('--reply-to-message-id', params.replyToMessageId);
  if (params.account) args.push('--account', params.account);

  // Use stdin for body
  args.push('--body-file', '-');

  return new Promise((resolve) => {
    const proc = spawn('gog', args, { timeout: 30000 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() });
      } else {
        resolve({ success: false, error: stderr.trim() || `gog exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    proc.stdin.write(params.body);
    proc.stdin.end();
  });
}

/**
 * List Gmail drafts.
 */
export async function listDrafts(params: {
  max?: number;
  account?: string;
}): Promise<{ success: boolean; drafts?: string; error?: string }> {
  const args = ['gmail', 'drafts', 'list', '--json', '--max', String(params.max || 10)];
  if (params.account) args.push('--account', params.account);

  try {
    const stdout = await gogExec(args);
    return { success: true, drafts: stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Get full email message content.
 */
export async function getMessage(params: {
  messageId: string;
  account?: string;
}): Promise<{ success: boolean; message?: string; error?: string }> {
  const args = ['gmail', 'get', params.messageId, '--json'];
  if (params.account) args.push('--account', params.account);

  try {
    const stdout = await gogExec(args);
    return { success: true, message: stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Get a Gmail thread (all messages with headers).
 */
export async function getThread(params: {
  threadId: string;
  account?: string;
}): Promise<{ success: boolean; thread?: string; error?: string }> {
  const args = ['gmail', 'thread', 'get', params.threadId, '--json'];
  if (params.account) args.push('--account', params.account);

  try {
    const stdout = await gogExec(args);
    return { success: true, thread: stdout };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[gog] getThread failed:', msg);
    return { success: false, error: msg };
  }
}

/**
 * Check if gog CLI is available on the system.
 */
export async function isGogAvailable(): Promise<boolean> {
  try {
    await execFile('gog', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

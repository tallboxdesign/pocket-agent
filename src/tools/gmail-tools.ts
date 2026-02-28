/**
 * Gmail agent tools -send, read, label, draft, and manage emails via gog CLI.
 */

import {
  sendEmail, readEmails, listLabels, createLabel,
  modifyLabels, createDraft, listDrafts, getMessage, getThread,
} from './gog-wrapper';
import { SettingsManager } from '../settings';

/** Resolve account: explicit param > settings default */
function resolveAccount(account?: string): string | undefined {
  return account || SettingsManager.get('gmail.userEmail') || undefined;
}

function checkEnabled(): string | null {
  if (!SettingsManager.getBoolean('gmail.enabled')) {
    return JSON.stringify({ error: 'Gmail integration is not enabled. Enable it in Settings → Gmail.' });
  }
  return null;
}

// ============================================================================
// Send Email Tool
// ============================================================================

function getSendEmailToolDefinition() {
  return {
    name: 'send_email',
    description: `Send an email via Gmail using the gog CLI.

Requires Gmail to be enabled in settings and gog CLI to be authenticated.
Always confirm with the user before sending an email.

Examples:
- send_email(to="alice@example.com", subject="Meeting", body="See you at 3pm")
- send_email(to="team@company.com", subject="Update", body="Project is done", cc="boss@company.com")
- send_email(to="x@y.com", subject="Hi", body="Hello", account="other@gmail.com")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text or HTML if html=true)' },
        html: { type: 'boolean', description: 'Send as HTML email (default: false)' },
        cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
        account: { type: 'string', description: 'Gmail account to send from (default: settings gmail.userEmail)' },
      },
      required: ['to', 'subject', 'body'],
    },
  };
}

async function handleSendEmailTool(input: unknown): Promise<string> {
  const p = input as { to: string; subject: string; body: string; html?: boolean; cc?: string; account?: string };
  const err = checkEnabled();
  if (err) return err;
  if (!p.to || !p.subject || !p.body) return JSON.stringify({ error: 'to, subject, and body are required' });

  try {
    const result = await sendEmail({ ...p, account: resolveAccount(p.account) });
    return result.success
      ? JSON.stringify({ success: true, message: `Email sent to ${p.to}` })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Gmail] send_email failed:', msg);
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// Read Emails Tool
// ============================================================================

function getReadEmailsToolDefinition() {
  return {
    name: 'read_emails',
    description: `Search and read emails from Gmail using the gog CLI.

Returns email subjects, senders, dates, and snippets as JSON.
Uses Gmail search syntax for queries.

Gmail categories: category:primary, category:updates, category:social, category:promotions, category:forums
Combine with OR: "category:primary OR category:updates"

IMPORTANT -Finding emails that need a response:
Threads can start months ago but have NEW replies today. To find ALL threads needing the user's attention:
1. Search broadly: "is:unread newer_than:7d" (catches replies on old threads too)
2. For each thread with multiple messages, use get_thread to check who sent the last message
3. If the last message is NOT from the user → that thread needs the user's response
4. Don't over-filter with keywords in the Gmail query -search broadly, filter in your analysis

IMPORTANT -Old threads with recent replies:
Gmail "newer_than:Xd" matches individual messages, so a reply from today on an October thread WILL appear. But keyword-based searches may miss them if the recent reply doesn't contain the keywords. Always search broadly first, then filter by topic in your analysis.

When user asks to "check emails" or find emails on a topic:
- Always include "is:unread" as an additional search to catch replies on old threads
- Use get_thread on threads with multiple messages to determine who needs to respond
- Search category:primary and category:updates by default
- Cross-reference with /unanswered results for completeness

Examples:
- read_emails() -emails from last 24 hours (all folders)
- read_emails(query="category:primary newer_than:1d") -primary inbox only
- read_emails(query="is:unread newer_than:7d", max=50) -all unread recent messages (catches old thread replies)
- read_emails(query="category:primary OR category:updates newer_than:1d") -primary + updates
- read_emails(query="from:alice@example.com")
- read_emails(query="is:unread", max=5)
- read_emails(query="subject:invoice newer_than:7d")
- read_emails(account="jorgepa.tallbox@gmail.com") -read from secondary account`,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Gmail search query (default: "newer_than:1d")' },
        max: { type: 'number', description: 'Maximum emails to return (default: 10)' },
        account: { type: 'string', description: 'Gmail account to read from (default: settings gmail.userEmail)' },
      },
      required: [],
    },
  };
}

async function handleReadEmailsTool(input: unknown): Promise<string> {
  const p = input as { query?: string; max?: number; account?: string };
  const err = checkEnabled();
  if (err) return err;

  try {
    const result = await readEmails({ ...p, account: resolveAccount(p.account) });
    return result.success
      ? JSON.stringify({ success: true, emails: result.emails })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Gmail] read_emails failed:', msg);
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// Get Email Tool
// ============================================================================

function getGetEmailToolDefinition() {
  return {
    name: 'get_email',
    description: `Get the full content of a specific email by message ID.

Use read_emails first to find the message ID, then get_email to read the full body.

Examples:
- get_email(message_id="19c13e623b4d5e39")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID' },
        account: { type: 'string', description: 'Gmail account (default: settings gmail.userEmail)' },
      },
      required: ['message_id'],
    },
  };
}

async function handleGetEmailTool(input: unknown): Promise<string> {
  const p = input as { message_id: string; account?: string };
  const err = checkEnabled();
  if (err) return err;
  if (!p.message_id) return JSON.stringify({ error: 'message_id is required' });

  try {
    const result = await getMessage({ messageId: p.message_id, account: resolveAccount(p.account) });
    return result.success
      ? JSON.stringify({ success: true, message: result.message })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// Get Thread Tool
// ============================================================================

function getGetThreadToolDefinition() {
  return {
    name: 'get_thread',
    description: `Get all messages in a Gmail thread by thread ID.

Returns the full thread with all messages including From headers, dates, and content.

KEY USE CASE -Determining who needs to respond:
Each message in the thread has a "From" header. Look at the LAST message's From field:
- If the last message is FROM the user → user is waiting for a reply (awaiting_reply)
- If the last message is NOT from the user → user needs to respond (unanswered)
This is how you determine which threads need the user's attention.

Workflow for finding threads needing response:
1. read_emails(query="is:unread newer_than:7d", max=50) -find threads with recent activity
2. get_thread(thread_id=...) on each -check who sent the last message
3. Report threads where the last message is NOT from the user

Also use this to:
- See complete conversation history before replying
- Check if an old thread (started months ago) has new recent replies
- Understand full context of a multi-message thread

Examples:
- get_thread(thread_id="19c13e623b4d5e39")
- get_thread(thread_id="19c13e623b4d5e39", account="other@gmail.com")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread ID' },
        account: { type: 'string', description: 'Gmail account (default: settings gmail.userEmail)' },
      },
      required: ['thread_id'],
    },
  };
}

async function handleGetThreadTool(input: unknown): Promise<string> {
  const p = input as { thread_id: string; account?: string };
  const err = checkEnabled();
  if (err) return err;
  if (!p.thread_id) return JSON.stringify({ error: 'thread_id is required' });

  try {
    const result = await getThread({ threadId: p.thread_id, account: resolveAccount(p.account) });
    return result.success
      ? JSON.stringify({ success: true, thread: result.thread })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// List Labels Tool
// ============================================================================

function getListLabelsToolDefinition() {
  return {
    name: 'list_email_labels',
    description: `List all Gmail labels for an account.

Returns label names, IDs, and types (system vs user).

Examples:
- list_email_labels()
- list_email_labels(account="other@gmail.com")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Gmail account (default: settings gmail.userEmail)' },
      },
      required: [],
    },
  };
}

async function handleListLabelsTool(input: unknown): Promise<string> {
  const p = input as { account?: string };
  const err = checkEnabled();
  if (err) return err;

  try {
    const result = await listLabels({ account: resolveAccount(p.account) });
    return result.success
      ? JSON.stringify({ success: true, labels: result.labels })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// Create Label Tool
// ============================================================================

function getCreateLabelToolDefinition() {
  return {
    name: 'create_email_label',
    description: `Create a new Gmail label.

Examples:
- create_email_label(name="Projects/Active")
- create_email_label(name="Clients", account="other@gmail.com")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Label name (use / for nested labels, e.g. "Projects/Active")' },
        account: { type: 'string', description: 'Gmail account (default: settings gmail.userEmail)' },
      },
      required: ['name'],
    },
  };
}

async function handleCreateLabelTool(input: unknown): Promise<string> {
  const p = input as { name: string; account?: string };
  const err = checkEnabled();
  if (err) return err;
  if (!p.name) return JSON.stringify({ error: 'name is required' });

  try {
    const result = await createLabel({ name: p.name, account: resolveAccount(p.account) });
    return result.success
      ? JSON.stringify({ success: true, message: `Label "${p.name}" created`, output: result.output })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// Modify Labels Tool
// ============================================================================

function getModifyLabelsToolDefinition() {
  return {
    name: 'modify_email_labels',
    description: `Add or remove labels on email threads. Use to organize, archive, or categorize emails.

Use read_emails first to find thread IDs. Labels can be names or IDs.
System labels: INBOX, SPAM, TRASH, UNREAD, STARRED, IMPORTANT.

Examples:
- modify_email_labels(thread_ids=["abc123"], add="Projects/Active")
- modify_email_labels(thread_ids=["abc123","def456"], remove="INBOX", add="Archive")
- modify_email_labels(thread_ids=["abc123"], remove="UNREAD")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        thread_ids: { type: 'array', items: { type: 'string' }, description: 'Thread IDs to modify' },
        add: { type: 'string', description: 'Labels to add (comma-separated)' },
        remove: { type: 'string', description: 'Labels to remove (comma-separated)' },
        account: { type: 'string', description: 'Gmail account (default: settings gmail.userEmail)' },
      },
      required: ['thread_ids'],
    },
  };
}

async function handleModifyLabelsTool(input: unknown): Promise<string> {
  const p = input as { thread_ids: string[]; add?: string; remove?: string; account?: string };
  const err = checkEnabled();
  if (err) return err;
  if (!p.thread_ids?.length) return JSON.stringify({ error: 'thread_ids is required' });
  if (!p.add && !p.remove) return JSON.stringify({ error: 'at least one of add or remove is required' });

  try {
    const result = await modifyLabels({
      threadIds: p.thread_ids,
      add: p.add,
      remove: p.remove,
      account: resolveAccount(p.account),
    });
    return result.success
      ? JSON.stringify({ success: true, message: `Labels modified on ${p.thread_ids.length} thread(s)` })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// Create Draft Tool
// ============================================================================

function getCreateDraftToolDefinition() {
  return {
    name: 'create_email_draft',
    description: `Create a Gmail draft for the user to review before sending.

Great for preparing emails that need user approval or edits.

Examples:
- create_email_draft(to="client@co.com", subject="Proposal", body="Draft content...")
- create_email_draft(to="x@y.com", subject="Re: Hi", body="reply text", reply_to_message_id="abc123")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Draft body (plain text)' },
        cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to (sets thread)' },
        account: { type: 'string', description: 'Gmail account (default: settings gmail.userEmail)' },
      },
      required: ['to', 'subject', 'body'],
    },
  };
}

async function handleCreateDraftTool(input: unknown): Promise<string> {
  const p = input as { to: string; subject: string; body: string; cc?: string; reply_to_message_id?: string; account?: string };
  const err = checkEnabled();
  if (err) return err;
  if (!p.to || !p.subject || !p.body) return JSON.stringify({ error: 'to, subject, and body are required' });

  try {
    const result = await createDraft({
      to: p.to,
      subject: p.subject,
      body: p.body,
      cc: p.cc,
      replyToMessageId: p.reply_to_message_id,
      account: resolveAccount(p.account),
    });
    return result.success
      ? JSON.stringify({ success: true, message: `Draft created for ${p.to}`, output: result.output })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// List Drafts Tool
// ============================================================================

function getListDraftsToolDefinition() {
  return {
    name: 'list_email_drafts',
    description: `List Gmail drafts.

Examples:
- list_email_drafts()
- list_email_drafts(max=5, account="other@gmail.com")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        max: { type: 'number', description: 'Maximum drafts to return (default: 10)' },
        account: { type: 'string', description: 'Gmail account (default: settings gmail.userEmail)' },
      },
      required: [],
    },
  };
}

async function handleListDraftsTool(input: unknown): Promise<string> {
  const p = input as { max?: number; account?: string };
  const err = checkEnabled();
  if (err) return err;

  try {
    const result = await listDrafts({ ...p, account: resolveAccount(p.account) });
    return result.success
      ? JSON.stringify({ success: true, drafts: result.drafts })
      : JSON.stringify({ success: false, error: result.error });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return JSON.stringify({ error: msg });
  }
}

// ============================================================================
// Export
// ============================================================================

export function getGmailTools() {
  return [
    { ...getSendEmailToolDefinition(), handler: handleSendEmailTool },
    { ...getReadEmailsToolDefinition(), handler: handleReadEmailsTool },
    { ...getGetEmailToolDefinition(), handler: handleGetEmailTool },
    { ...getGetThreadToolDefinition(), handler: handleGetThreadTool },
    { ...getListLabelsToolDefinition(), handler: handleListLabelsTool },
    { ...getCreateLabelToolDefinition(), handler: handleCreateLabelTool },
    { ...getModifyLabelsToolDefinition(), handler: handleModifyLabelsTool },
    { ...getCreateDraftToolDefinition(), handler: handleCreateDraftTool },
    { ...getListDraftsToolDefinition(), handler: handleListDraftsTool },
  ];
}

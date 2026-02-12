---
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
homepage: https://gogcli.sh
---

# gog

Use `gog` for Gmail/Calendar/Drive/Contacts/Sheets/Docs. Requires OAuth setup.

Setup (once)
- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
- `gog auth list`

Common commands
- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Gmail send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Gmail send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Gmail send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Gmail draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send draft: `gog gmail drafts send <draftId>`
- Gmail reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Calendar list events: `gog calendar events <calendarId> --from <iso> --to <iso>`
- Calendar create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Calendar create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Calendar update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`
- Calendar show colors: `gog calendar colors`
- Drive search: `gog drive search "query" --max 10`
- Contacts: `gog contacts list --max 20`
- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets metadata: `gog sheets metadata <sheetId> --json`
- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat: `gog docs cat <docId>`

Calendar Colors
- Use `gog calendar colors` to see all available event colors (IDs 1-11)
- Add colors to events with `--event-color <id>` flag
- Event color IDs (from `gog calendar colors` output):
  - 1: #a4bdfc
  - 2: #7ae7bf
  - 3: #dbadff
  - 4: #ff887c
  - 5: #fbd75b
  - 6: #ffb878
  - 7: #46d6db
  - 8: #e1e1e1
  - 9: #5484ed
  - 10: #51b749
  - 11: #dc2127

Email Formatting
- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).
- Same `--body-file` pattern works for drafts and replies.
- `--body` does not unescape `\n`. If you need inline newlines, use a heredoc or `$'Line 1\n\nLine 2'`.
- Use `--body-html` only when you need rich formatting.
- HTML tags: `<p>` for paragraphs, `<br>` for line breaks, `<strong>` for bold, `<em>` for italic, `<a href="url">` for links, `<ul>`/`<li>` for lists.
- Example (plain text via stdin):
  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-file - <<'EOF'
  Hi Name,

  Thanks for meeting today. Next steps:
  - Item one
  - Item two

  Best regards,
  Your Name
  EOF
  ```
- Example (HTML list):
  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-html "<p>Hi Name,</p><p>Thanks for meeting today. Here are the next steps:</p><ul><li>Item one</li><li>Item two</li></ul><p>Best regards,<br>Your Name</p>"
  ```

Email Reply Safety Rules
- **When the user references emails by number (e.g., "reply to 2, 3 and 6"), use YOUR OWN numbered list from the conversation.** Do NOT re-search or pick different emails. Match the numbers exactly to the emails you previously listed.
- **NEVER reply to threads where you/the user already replied.** Before replying, check who sent the LAST message in the thread. If the last sender is jorgepa.tallbox@gmail.com (or any of the user's own accounts), the thread is already answered — do NOT reply again. Warn the user: "Thread X already has your reply as the last message, skipping."
- **Check thread state before every reply.** Run `gog gmail messages search "rfc822msgid:<messageId>"` or read the thread to see the latest message. If the user's account sent the most recent message, the thread is concluded.
- **Verify email identity before replying.** When the user says "reply to email 3", confirm which email that is (subject + sender) before sending. If ambiguous, ask.
- **Read the full email before summarizing.** When asked "what does email X say", use `gog gmail read <messageId>` to get the full body, not just the thread subject/snippet.

Accounts & Roles
- **office.tallbox@gmail.com** — the office/business account. **READ-ONLY.** The agent may search and read emails, export Drive files, and view calendars — but must NEVER send, draft, label, modify, move, delete, or alter anything on this account.
- **jorgepa.tallbox@gmail.com** — the manager's account (Jorge). Full access. The agent manages this inbox: sorting, labeling, archiving, drafting replies, creating Drive docs, managing calendar.
- Always pass `--account <email>` to target the right mailbox.

office.tallbox@gmail.com — Restricted Access
- **Email: READ-ONLY.** May: `read_emails`, `get_email`, `list_email_labels`, search. NEVER send, draft, label, modify, archive, or delete emails.
- **Drive: READ-ONLY (enforced by OAuth scope).** May export/read files. Cannot modify, move, or delete — the API will reject writes.
- **Calendar, Docs, Sheets:** Full access — the agent can manage these when asked.

jorgepa.tallbox@gmail.com — Full Access
- The agent can send (only when user explicitly asks), draft, label, create labels, organize inbox, create Drive docs, manage calendar events.
- **NEVER send emails unless the user explicitly asks.** Always prepare drafts instead. The only exception is routine notifications (reminders, routine outputs) routed via the scheduler.
- When CC'd or forwarded threads arrive: read the full thread, summarize key points, and prepare a draft reply. Do NOT send it.
- Use plain text for most emails. Use HTML only when formatting matters (tables, links, lists).

Label Rules (jorgepa only)
- **NEVER create new labels on your own.** Only use labels that already exist in the account.
- Before labeling, always run `list_email_labels` to see what's available.
- Only apply labels the user specifically asks for. Do not invent categories or auto-sort unless instructed.
- If the user asks for a new label, create it only after they confirm the name.

Notes
- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.

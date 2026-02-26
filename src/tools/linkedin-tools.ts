/**
 * LinkedIn agent tools — browse feed, read posts, comment, create posts, manage auth.
 */

import { linkedinExec } from './linkedin-wrapper';
import { SettingsManager } from '../settings';
import { glmFlash, glmChat, isGlmConfigured } from './glm-client';
import { KanbanService } from '../kanban';

function checkEnabled(): string | null {
  if (!SettingsManager.getBoolean('linkedin.enabled')) {
    return JSON.stringify({ error: 'LinkedIn integration is not enabled. Enable it in Settings → LinkedIn.' });
  }
  return null;
}

// ============================================================================
// Browse Feed Tool
// ============================================================================

function getBrowseFeedToolDefinition() {
  return {
    name: 'linkedin_feed',
    description: `Browse your LinkedIn feed and extract posts with engagement data.

Returns posts sorted by engagement (reactions + comments) as JSON.
Useful for finding trending content, monitoring topics, or discovering posts to engage with.

The first call may be slow (~60s) if the Python environment needs setup.

Examples:
- linkedin_feed() — browse feed with default settings
- linkedin_feed(scroll=5, keyword="AI") — scroll more, filter by keyword
- linkedin_feed(person="Sam Altman") — find posts by a specific person
- linkedin_feed(min_engagement=50, limit=10) — high-engagement posts only`,
    input_schema: {
      type: 'object' as const,
      properties: {
        scroll: { type: 'number', description: 'Number of scroll iterations (default: 3, more = more posts but slower)' },
        person: { type: 'string', description: 'Filter posts by author name (case-insensitive)' },
        keyword: { type: 'string', description: 'Filter posts containing this keyword (case-insensitive)' },
        min_engagement: { type: 'number', description: 'Minimum reactions+comments (default: 0)' },
        limit: { type: 'number', description: 'Max posts to return (default: 20)' },
      },
      required: [],
    },
  };
}

async function handleBrowseFeedTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as {
    scroll?: number; person?: string; keyword?: string;
    min_engagement?: number; limit?: number;
  };

  const args: string[] = [];
  if (p.scroll) args.push('--scroll', String(p.scroll));
  if (p.limit) args.push('--limit', String(p.limit));
  if (p.min_engagement) args.push('--min-engagement', String(p.min_engagement));

  // Apply explicit filters or fall back to settings defaults
  const person = p.person || SettingsManager.get('linkedin.feedPersons');
  const keyword = p.keyword || SettingsManager.get('linkedin.feedKeywords');
  if (person) args.push('--person', person);
  if (keyword) args.push('--keyword', keyword);

  try {
    const stdout = await linkedinExec('feed', args, 180000);
    const posts = JSON.parse(stdout);
    return JSON.stringify({ success: true, count: posts.length, posts });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] feed failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Read Post Tool
// ============================================================================

function getReadPostToolDefinition() {
  return {
    name: 'linkedin_read_post',
    description: `Read the full content of a specific LinkedIn post by URL.

Returns the post author, full text content, and URL as JSON.

Examples:
- linkedin_read_post(url="https://www.linkedin.com/feed/update/urn:li:activity:123/")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'LinkedIn post URL' },
      },
      required: ['url'],
    },
  };
}

async function handleReadPostTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { url: string };
  if (!p.url) return JSON.stringify({ error: 'url is required' });

  try {
    const stdout = await linkedinExec('reply', ['--url', p.url, '--read-only'], 60000);
    const post = JSON.parse(stdout);
    return JSON.stringify({ success: true, ...post });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] read_post failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Comment Tool
// ============================================================================

function getCommentToolDefinition() {
  return {
    name: 'linkedin_comment',
    description: `Comment on a LinkedIn post.

Always pass --no-confirm to avoid hanging on stdin prompt.
The agent should use its own judgment about whether to ask the user for confirmation before commenting.
Check linkedin.autoConfirm setting — if false, ask the user first.

Examples:
- linkedin_comment(url="https://...", comment="Great insights!")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'LinkedIn post URL' },
        comment: { type: 'string', description: 'Comment text to post' },
      },
      required: ['url', 'comment'],
    },
  };
}

async function handleCommentTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { url: string; comment: string };
  if (!p.url || !p.comment) return JSON.stringify({ error: 'url and comment are required' });

  try {
    await linkedinExec(
      'reply',
      ['--url', p.url, '--comment', p.comment, '--no-confirm'],
      90000
    );
    return JSON.stringify({ success: true, message: 'Comment posted', post_url: p.url });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] comment failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Create Post Tool
// ============================================================================

function getCreatePostToolDefinition() {
  return {
    name: 'linkedin_post',
    description: `Create a new LinkedIn post.

Always uses --no-confirm to avoid hanging on stdin prompt.
The agent should use its own judgment about whether to ask the user for confirmation before posting.
Check linkedin.autoConfirm setting — if false, ask the user first.

Examples:
- linkedin_post(text="Excited to share...")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Post text content' },
      },
      required: ['text'],
    },
  };
}

async function handleCreatePostTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { text: string };
  if (!p.text) return JSON.stringify({ error: 'text is required' });

  try {
    await linkedinExec('post', ['--text', p.text, '--no-confirm'], 120000);
    return JSON.stringify({ success: true, message: 'Post published' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] post failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Auth Status Tool
// ============================================================================

function getAuthStatusToolDefinition() {
  return {
    name: 'linkedin_auth_status',
    description: `Check or manage LinkedIn authentication status.

Actions:
- status: Check if authenticated and session age
- validate: Actually test the session by loading LinkedIn
- setup: Start interactive auth (opens browser for manual login)
- clear: Remove all authentication data

The first call may be slow (~60s) if the Python environment needs setup.

Examples:
- linkedin_auth_status(action="status")
- linkedin_auth_status(action="validate")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: status, validate, setup, or clear (default: status)',
        },
      },
      required: [],
    },
  };
}

async function handleAuthStatusTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { action?: string };
  const action = p.action || 'status';

  if (!['status', 'validate', 'setup', 'clear'].includes(action)) {
    return JSON.stringify({ error: 'action must be one of: status, validate, setup, clear' });
  }

  try {
    const stdout = await linkedinExec('auth_manager', [action], 30000);
    return JSON.stringify({ success: true, action, output: stdout });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] auth_status failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Classify LinkedIn Posts Tool
// ============================================================================

const LINKEDIN_POST_CATEGORIES = [
  'thought-leadership', 'technical', 'news', 'personal-story',
  'promotion', 'job-posting', 'event', 'question', 'other',
] as const;

function getClassifyPostsToolDefinition() {
  return {
    name: 'classify_linkedin_posts',
    description: `Classify LinkedIn feed posts by type using AI.

Takes an array of posts (from linkedin_feed) and classifies each into one of:
thought-leadership, technical, news, personal-story, promotion, job-posting, event, question, other.

Returns posts with added "type" field, grouped by category.
Requires GLM (worker model) to be configured. Falls back gracefully if not available.

Examples:
- classify_linkedin_posts(posts=<output from linkedin_feed>)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        posts: {
          type: 'array',
          description: 'Array of post objects from linkedin_feed (must have text_preview field)',
          items: {
            type: 'object',
            properties: {
              author: { type: 'string' },
              text_preview: { type: 'string' },
              post_url: { type: 'string' },
              engagement: { type: 'number' },
            },
          },
        },
      },
      required: ['posts'],
    },
  };
}

async function handleClassifyPostsTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { posts: Array<{ author?: string; text_preview?: string; post_url?: string; engagement?: number }> };
  if (!p.posts || !Array.isArray(p.posts)) {
    return JSON.stringify({ error: 'posts array is required' });
  }

  if (!isGlmConfigured()) {
    // Graceful degradation — return posts without classification
    return JSON.stringify({
      success: true,
      classified: false,
      note: 'GLM not configured. Posts returned without classification. Set up a worker model in Settings > Keys.',
      posts: p.posts,
    });
  }

  const CONCURRENCY = 3;
  const classified: Array<Record<string, unknown>> = [];

  // Process in batches of CONCURRENCY
  for (let i = 0; i < p.posts.length; i += CONCURRENCY) {
    const batch = p.posts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (post) => {
        const preview = (post.text_preview || '').slice(0, 500);
        const result = await glmFlash({
          messages: [
            {
              role: 'system',
              content: `Classify this LinkedIn post into exactly ONE of: ${LINKEDIN_POST_CATEGORIES.join(', ')}. Return ONLY the category name, nothing else.`,
            },
            { role: 'user', content: `Author: ${post.author || 'Unknown'}\n\n${preview}` },
          ],
          maxTokens: 20,
          temperature: 0.1,
        });
        const type = result.success && result.content
          ? result.content.trim().toLowerCase().replace(/[^a-z-]/g, '')
          : 'other';
        return { ...post, type: LINKEDIN_POST_CATEGORIES.includes(type as typeof LINKEDIN_POST_CATEGORIES[number]) ? type : 'other' };
      })
    );
    for (const r of results) {
      classified.push(r.status === 'fulfilled' ? r.value : { ...batch[results.indexOf(r)], type: 'other' });
    }
  }

  // Group by type
  const byType: Record<string, Array<Record<string, unknown>>> = {};
  for (const post of classified) {
    const t = post.type as string;
    if (!byType[t]) byType[t] = [];
    byType[t].push(post);
  }

  return JSON.stringify({ success: true, classified: true, count: classified.length, posts: classified, by_type: byType });
}

// ============================================================================
// Draft LinkedIn Post Tool
// ============================================================================

const LINKEDIN_STYLES = ['insight', 'story', 'contrarian', 'how-to', 'listicle'] as const;

const STYLE_INSTRUCTIONS: Record<string, string> = {
  insight: 'Share a key insight or lesson learned. Start with a bold hook statement.',
  story: 'Tell a short personal or professional story. Use "I" voice and build to a takeaway.',
  contrarian: 'Challenge a common belief or popular opinion. Start with "Most people think X. They\'re wrong."',
  'how-to': 'Provide actionable steps. Use numbered steps or bullet points.',
  listicle: 'List format with numbered items. Each item should be concise and valuable.',
};

function getDraftPostToolDefinition() {
  return {
    name: 'draft_linkedin_post',
    description: `Generate a LinkedIn post draft from a topic and optional research, storing it in Kanban for review.

Creates a draft using AI with LinkedIn best practices (hook line, short paragraphs, CTA, hashtags).
Stores the draft as a Kanban task in the "LinkedIn" project with status "review" for user approval.

Styles: insight (default), story, contrarian, how-to, listicle

Examples:
- draft_linkedin_post(topic="AI in healthcare", style="insight")
- draft_linkedin_post(topic="Remote work tips", research_report="...", style="how-to")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Topic or theme for the post' },
        research_report: { type: 'string', description: 'Optional research report to base the post on' },
        style: { type: 'string', description: 'Post style: insight, story, contrarian, how-to, listicle (default: insight)' },
        reference_post_url: { type: 'string', description: 'Optional URL of a reference post for style inspiration' },
      },
      required: ['topic'],
    },
  };
}

async function handleDraftPostTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { topic: string; research_report?: string; style?: string; reference_post_url?: string };
  if (!p.topic) return JSON.stringify({ error: 'topic is required' });

  if (!isGlmConfigured()) {
    return JSON.stringify({ error: 'GLM not configured. Set up a worker model in Settings > Keys to generate drafts.' });
  }

  const style = (p.style && LINKEDIN_STYLES.includes(p.style as typeof LINKEDIN_STYLES[number]))
    ? p.style : 'insight';

  const systemPrompt = `You are a LinkedIn content writer. Write a LinkedIn post following these rules:
- Start with a strong hook line (first 1-2 lines are critical for engagement)
- Use short paragraphs (1-3 sentences each)
- Include line breaks between paragraphs for readability
- End with a clear call-to-action or question to drive engagement
- Add 3-5 relevant hashtags at the end
- Keep it under 1300 characters for optimal engagement
- Style: ${STYLE_INSTRUCTIONS[style] || STYLE_INSTRUCTIONS.insight}
- Write the post text ONLY — no meta-commentary, no "here's a draft", just the post content.`;

  let userMessage = `Topic: ${p.topic}`;
  if (p.research_report) {
    userMessage += `\n\nResearch to draw from:\n${p.research_report.slice(0, 3000)}`;
  }
  if (p.reference_post_url) {
    userMessage += `\n\nReference post URL for style inspiration: ${p.reference_post_url}`;
  }

  try {
    const result = await glmChat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      maxTokens: 1024,
      temperature: 0.7,
    });

    if (!result.success || !result.content) {
      return JSON.stringify({ success: false, error: result.error || 'Failed to generate draft' });
    }

    const draft = result.content.trim();

    // Get or create LinkedIn project
    let project = KanbanService.getProjectByName('LinkedIn');
    if (!project) {
      project = KanbanService.createProject('LinkedIn', 'LinkedIn content drafts and posts', '#0a66c2');
    }

    // Create Kanban task with draft as description
    const task = KanbanService.createTask({
      project_id: project.id,
      title: `Draft: ${p.topic.slice(0, 80)}`,
      description: draft,
      status: 'review',
      priority: 'medium',
      tags: 'linkedin,draft',
    });

    return JSON.stringify({
      success: true,
      draft,
      kanban_task_id: task.id,
      kanban_project_id: project.id,
      style,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] draft_post failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Revise LinkedIn Draft Tool
// ============================================================================

function getReviseDraftToolDefinition() {
  return {
    name: 'revise_linkedin_draft',
    description: `Revise an existing LinkedIn post draft based on user feedback.

Reads the current draft from a Kanban task, applies the feedback using AI, and updates the task.
The task stays in "review" status for further iteration or approval.

Examples:
- revise_linkedin_draft(kanban_task_id=42, feedback="Make it shorter and more punchy")
- revise_linkedin_draft(kanban_task_id=42, feedback="Add more data points")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        kanban_task_id: { type: 'number', description: 'Kanban task ID containing the draft' },
        feedback: { type: 'string', description: 'User feedback for revision' },
      },
      required: ['kanban_task_id', 'feedback'],
    },
  };
}

async function handleReviseDraftTool(input: unknown): Promise<string> {
  const err = checkEnabled();
  if (err) return err;

  const p = input as { kanban_task_id: number; feedback: string };
  if (!p.kanban_task_id || !p.feedback) {
    return JSON.stringify({ error: 'kanban_task_id and feedback are required' });
  }

  if (!isGlmConfigured()) {
    return JSON.stringify({ error: 'GLM not configured. Set up a worker model in Settings > Keys.' });
  }

  const task = KanbanService.getTask(p.kanban_task_id);
  if (!task) {
    return JSON.stringify({ error: `Kanban task #${p.kanban_task_id} not found` });
  }

  const currentDraft = task.description || '';
  if (!currentDraft) {
    return JSON.stringify({ error: `Task #${p.kanban_task_id} has no draft content in description` });
  }

  try {
    const result = await glmChat({
      messages: [
        {
          role: 'system',
          content: 'You are revising a LinkedIn post draft. Apply the user\'s feedback while maintaining LinkedIn best practices (hook line, short paragraphs, CTA, hashtags). Return ONLY the revised post text.',
        },
        {
          role: 'user',
          content: `Original draft:\n${currentDraft}\n\nFeedback:\n${p.feedback}\n\nRevise the post accordingly.`,
        },
      ],
      maxTokens: 1024,
      temperature: 0.7,
    });

    if (!result.success || !result.content) {
      return JSON.stringify({ success: false, error: result.error || 'Failed to revise draft' });
    }

    const revisedDraft = result.content.trim();

    // Update Kanban task with revised draft, keep in review
    KanbanService.updateTask(p.kanban_task_id, {
      description: revisedDraft,
      status: 'review',
    });

    return JSON.stringify({
      success: true,
      draft: revisedDraft,
      kanban_task_id: p.kanban_task_id,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[LinkedIn] revise_draft failed:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ============================================================================
// Export
// ============================================================================

export function getLinkedInTools() {
  return [
    { ...getBrowseFeedToolDefinition(), handler: handleBrowseFeedTool },
    { ...getReadPostToolDefinition(), handler: handleReadPostTool },
    { ...getCommentToolDefinition(), handler: handleCommentTool },
    { ...getCreatePostToolDefinition(), handler: handleCreatePostTool },
    { ...getAuthStatusToolDefinition(), handler: handleAuthStatusTool },
    { ...getClassifyPostsToolDefinition(), handler: handleClassifyPostsTool },
    { ...getDraftPostToolDefinition(), handler: handleDraftPostTool },
    { ...getReviseDraftToolDefinition(), handler: handleReviseDraftTool },
  ];
}

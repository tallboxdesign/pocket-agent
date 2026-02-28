/**
 * GLM Worker tools -cheap bulk processing via Zhipu GLM models.
 *
 * The orchestrator (Claude/Kimi) calls these tools to offload repetitive,
 * token-heavy tasks to GLM instead of burning expensive primary model tokens.
 */

import { glmChat, glmFlash, isGlmConfigured } from './glm-client';

function checkConfigured(): string | null {
  if (!isGlmConfigured()) {
    return JSON.stringify({ error: 'GLM worker not configured. Add your Zhipu API key in Settings > Keys.' });
  }
  return null;
}

// ============================================================================
// Summarize Text
// ============================================================================

function getSummarizeTextToolDefinition() {
  return {
    name: 'summarize_text',
    description: `Summarize text using the GLM worker model (cheap, saves primary model tokens).

Use this for email summaries, article digests, long message condensation.
The GLM worker handles this instead of the primary model.

Examples:
- summarize_text(text="<long email thread>")
- summarize_text(text="<article>", style="bullets")
- summarize_text(text="<report>", style="brief")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to summarize' },
        style: {
          type: 'string',
          enum: ['brief', 'detailed', 'bullets'],
          description: 'Summary style (default: brief)',
        },
      },
      required: ['text'],
    },
  };
}

async function handleSummarizeTextTool(input: unknown): Promise<string> {
  const p = input as { text: string; style?: string };
  const err = checkConfigured();
  if (err) return err;
  if (!p.text) return JSON.stringify({ error: 'text is required' });

  const styleInstructions: Record<string, string> = {
    brief: 'Provide a concise 2-3 sentence summary.',
    detailed: 'Provide a thorough summary covering all key points.',
    bullets: 'Provide a bullet-point summary of key points.',
  };

  const style = p.style || 'brief';
  const systemPrompt = `You are a summarization assistant. ${styleInstructions[style] || styleInstructions.brief} Preserve important names, dates, numbers, and action items.`;

  const result = await glmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: p.text },
    ],
  });

  return result.success
    ? JSON.stringify({ success: true, summary: result.content, tokens: result.usage?.total_tokens })
    : JSON.stringify({ success: false, error: result.error });
}

// ============================================================================
// Classify Content
// ============================================================================

function getClassifyContentToolDefinition() {
  return {
    name: 'classify_content',
    description: `Classify text into categories using the GLM Flash model (very fast and cheap).

Use for email categorization, label suggestions, sentiment analysis, priority scoring.

Examples:
- classify_content(text="Meeting at 3pm tomorrow", categories=["work","personal","spam"])
- classify_content(text="Invoice #123 attached", categories=["urgent","normal","low"], multi=true)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to classify' },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of possible categories',
        },
        multi: { type: 'boolean', description: 'Allow multiple categories (default: false)' },
      },
      required: ['text', 'categories'],
    },
  };
}

async function handleClassifyContentTool(input: unknown): Promise<string> {
  const p = input as { text: string; categories: string[]; multi?: boolean };
  const err = checkConfigured();
  if (err) return err;
  if (!p.text || !p.categories?.length) {
    return JSON.stringify({ error: 'text and categories are required' });
  }

  const catList = p.categories.join(', ');
  const systemPrompt = p.multi
    ? `Classify the text into one or more of these categories: ${catList}. Return ONLY the matching category names as a JSON array, e.g. ["cat1","cat2"]. No explanation.`
    : `Classify the text into exactly ONE of these categories: ${catList}. Return ONLY the category name, nothing else.`;

  const result = await glmFlash({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: p.text },
    ],
    maxTokens: 100,
  });

  if (!result.success) {
    return JSON.stringify({ success: false, error: result.error });
  }

  const raw = (result.content || '').trim();

  if (p.multi) {
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify({ success: true, categories: parsed, tokens: result.usage?.total_tokens });
    } catch {
      return JSON.stringify({ success: true, categories: [raw], tokens: result.usage?.total_tokens });
    }
  }

  return JSON.stringify({ success: true, category: raw, tokens: result.usage?.total_tokens });
}

// ============================================================================
// Extract Info
// ============================================================================

function getExtractInfoToolDefinition() {
  return {
    name: 'extract_info',
    description: `Extract structured information from text using the GLM worker model.

Use for pulling specific fields from emails, documents, or messages.

Examples:
- extract_info(text="<email>", fields=["sender","subject","action_items","deadline"])
- extract_info(text="<invoice>", fields=["amount","due_date","vendor"])`,
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to extract from' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fields to extract (e.g. ["sender","deadline","action_items"])',
        },
      },
      required: ['text', 'fields'],
    },
  };
}

async function handleExtractInfoTool(input: unknown): Promise<string> {
  const p = input as { text: string; fields: string[] };
  const err = checkConfigured();
  if (err) return err;
  if (!p.text || !p.fields?.length) {
    return JSON.stringify({ error: 'text and fields are required' });
  }

  const fieldList = p.fields.join(', ');
  const systemPrompt = `Extract these fields from the text: ${fieldList}. Return a JSON object with the field names as keys. Use null for fields not found. No explanation, just the JSON.`;

  const result = await glmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: p.text },
    ],
  });

  if (!result.success) {
    return JSON.stringify({ success: false, error: result.error });
  }

  const raw = (result.content || '').trim();
  try {
    // Try to parse as JSON, stripping markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    return JSON.stringify({ success: true, extracted: parsed, tokens: result.usage?.total_tokens });
  } catch {
    return JSON.stringify({ success: true, extracted: raw, tokens: result.usage?.total_tokens });
  }
}

// ============================================================================
// Bulk Process
// ============================================================================

function getBulkProcessToolDefinition() {
  return {
    name: 'bulk_process',
    description: `Process multiple items with a single instruction using GLM Flash (very cheap).

Use for batch operations: labeling emails, summarizing threads, extracting data from multiple items.
Processes items sequentially to avoid rate limits.

Examples:
- bulk_process(items=["email1 text","email2 text"], instruction="Classify as work/personal/spam")
- bulk_process(items=["msg1","msg2","msg3"], instruction="Extract the sender name and subject")
- bulk_process(items=["text1","text2"], instruction="Summarize in one sentence", use_flash=false)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of text items to process',
        },
        instruction: { type: 'string', description: 'What to do with each item' },
        use_flash: { type: 'boolean', description: 'Use Flash model for speed (default: true). Set false for quality.' },
      },
      required: ['items', 'instruction'],
    },
  };
}

async function handleBulkProcessTool(input: unknown): Promise<string> {
  const p = input as { items: string[]; instruction: string; use_flash?: boolean };
  const err = checkConfigured();
  if (err) return err;
  if (!p.items?.length || !p.instruction) {
    return JSON.stringify({ error: 'items and instruction are required' });
  }

  const useFlash = p.use_flash !== false;
  const caller = useFlash ? glmFlash : glmChat;
  const systemPrompt = `Process the following item according to this instruction: ${p.instruction}\nReturn only the result, no explanation.`;

  const results: Array<{ index: number; result?: string; error?: string }> = [];
  let totalTokens = 0;

  for (let i = 0; i < p.items.length; i++) {
    const item = p.items[i];
    const response = await caller({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: item },
      ],
      maxTokens: 512,
    });

    if (response.success) {
      results.push({ index: i, result: response.content });
      totalTokens += response.usage?.total_tokens ?? 0;
    } else {
      results.push({ index: i, error: response.error });
    }
  }

  return JSON.stringify({
    success: true,
    results,
    total_items: p.items.length,
    total_tokens: totalTokens,
  });
}

// ============================================================================
// Export
// ============================================================================

export function getGlmWorkerTools() {
  return [
    { ...getSummarizeTextToolDefinition(), handler: handleSummarizeTextTool },
    { ...getClassifyContentToolDefinition(), handler: handleClassifyContentTool },
    { ...getExtractInfoToolDefinition(), handler: handleExtractInfoTool },
    { ...getBulkProcessToolDefinition(), handler: handleBulkProcessTool },
  ];
}

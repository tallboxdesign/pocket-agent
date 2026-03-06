/**
 * LinkedIn Content Planner
 *
 * Manages publishing targets, content plans, and plan assets.
 * Research and drafting delegate to the existing SDK infrastructure
 * with a topic-focused prompt (vs the comment-focused drafter).
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { SettingsManager } from '../settings';
import { KanbanService } from '../kanban';
import { AgentManager } from '../agent';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerTarget {
  id: number;
  target_type: 'profile' | 'company' | 'group' | 'article';
  url: string | null;
  label: string;
  enabled: number;
  audience_summary: string | null;
  tone_rules: string | null;
  topic_fit_rules: string | null;
  cta_style: string | null;
  posts_per_day: number;
  approval_mode: 'review_required' | 'auto';
  can_auto_publish: number;
  created_at: string;
  updated_at: string;
}

export interface ContentPlan {
  id: number;
  title: string;
  prompt: string;
  topic: string | null;
  source_urls: string | null;
  research_mode: 'fast' | 'balanced' | 'deep';
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PlanAsset {
  id: number;
  plan_id: number;
  target_id: number;
  draft_text: string | null;
  final_text: string | null;
  quality_score: number | null;
  fingerprint: string | null;
  evidence_id: number | null;
  kanban_task_id: number | null;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  publish_error: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields (optional)
  target_label?: string;
  target_type?: string;
  target_url?: string | null;
  plan_title?: string;
  plan_prompt?: string;
  can_auto_publish?: number;
}

export interface PlanWithAssets extends ContentPlan {
  assets: PlanAsset[];
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function getDb(): Database.Database | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const db = new Database(p);
      db.pragma('journal_mode = WAL');
      return db;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Target CRUD
// ---------------------------------------------------------------------------

export function listTargets(): PlannerTarget[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM linkedin_targets ORDER BY target_type, label').all() as PlannerTarget[];
  } finally {
    db.close();
  }
}

export function getTarget(id: number): PlannerTarget | null {
  const db = getDb();
  if (!db) return null;
  try {
    return (db.prepare('SELECT * FROM linkedin_targets WHERE id = ?').get(id) as PlannerTarget) || null;
  } finally {
    db.close();
  }
}

export function addTarget(target: {
  target_type: string;
  url?: string;
  label: string;
  audience_summary?: string;
  tone_rules?: string;
  topic_fit_rules?: string;
  cta_style?: string;
  posts_per_day?: number;
  approval_mode?: string;
}): PlannerTarget {
  const db = getDb();
  if (!db) throw new Error('Database not available');
  try {
    const canAutoPublish = target.target_type === 'profile' ? 1 : 0;
    const result = db.prepare(`
      INSERT INTO linkedin_targets (target_type, url, label, audience_summary, tone_rules, topic_fit_rules, cta_style, posts_per_day, approval_mode, can_auto_publish)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      target.target_type || 'profile',
      target.url || null,
      target.label,
      target.audience_summary || null,
      target.tone_rules || null,
      target.topic_fit_rules || null,
      target.cta_style || null,
      target.posts_per_day ?? 1,
      target.approval_mode || 'review_required',
      canAutoPublish,
    );
    return db.prepare('SELECT * FROM linkedin_targets WHERE id = ?').get(result.lastInsertRowid) as PlannerTarget;
  } finally {
    db.close();
  }
}

export function updateTarget(id: number, updates: Partial<{
  target_type: string;
  url: string | null;
  label: string;
  enabled: number;
  audience_summary: string | null;
  tone_rules: string | null;
  topic_fit_rules: string | null;
  cta_style: string | null;
  posts_per_day: number;
  approval_mode: string;
}>): PlannerTarget | null {
  const db = getDb();
  if (!db) return null;
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'id') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return getTarget(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE linkedin_targets SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    // Sync can_auto_publish when target_type changes
    if (updates.target_type) {
      const canAuto = updates.target_type === 'profile' ? 1 : 0;
      db.prepare('UPDATE linkedin_targets SET can_auto_publish = ? WHERE id = ?').run(canAuto, id);
    }

    return db.prepare('SELECT * FROM linkedin_targets WHERE id = ?').get(id) as PlannerTarget || null;
  } finally {
    db.close();
  }
}

export function deleteTarget(id: number): boolean {
  const db = getDb();
  if (!db) return false;
  try {
    // Check for assets referencing this target
    const assetCount = (db.prepare('SELECT COUNT(*) as c FROM linkedin_plan_assets WHERE target_id = ?').get(id) as { c: number }).c;
    if (assetCount > 0) {
      throw new Error(`Cannot delete target: ${assetCount} asset(s) reference it. Delete or reassign them first.`);
    }
    const result = db.prepare('DELETE FROM linkedin_targets WHERE id = ?').run(id);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function toggleTarget(id: number, enabled: boolean): PlannerTarget | null {
  const db = getDb();
  if (!db) return null;
  try {
    db.prepare("UPDATE linkedin_targets SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
    return db.prepare('SELECT * FROM linkedin_targets WHERE id = ?').get(id) as PlannerTarget || null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Plan CRUD
// ---------------------------------------------------------------------------

export function listPlans(status?: string): ContentPlan[] {
  const db = getDb();
  if (!db) return [];
  try {
    if (status) {
      return db.prepare('SELECT * FROM linkedin_content_plans WHERE status = ? ORDER BY created_at DESC').all(status) as ContentPlan[];
    }
    return db.prepare('SELECT * FROM linkedin_content_plans ORDER BY created_at DESC').all() as ContentPlan[];
  } finally {
    db.close();
  }
}

export function getPlan(id: number): ContentPlan | null {
  const db = getDb();
  if (!db) return null;
  try {
    return (db.prepare('SELECT * FROM linkedin_content_plans WHERE id = ?').get(id) as ContentPlan) || null;
  } finally {
    db.close();
  }
}

export function getPlanWithAssets(id: number): PlanWithAssets | null {
  const db = getDb();
  if (!db) return null;
  try {
    const plan = db.prepare('SELECT * FROM linkedin_content_plans WHERE id = ?').get(id) as ContentPlan | undefined;
    if (!plan) return null;
    const assets = db.prepare(`
      SELECT a.*, t.label as target_label, t.target_type, t.url as target_url, t.can_auto_publish
      FROM linkedin_plan_assets a
      JOIN linkedin_targets t ON t.id = a.target_id
      WHERE a.plan_id = ?
      ORDER BY t.target_type, t.label, a.id
    `).all(id) as PlanAsset[];
    return { ...plan, assets };
  } finally {
    db.close();
  }
}

export function createPlan(input: {
  title: string;
  prompt: string;
  topic?: string;
  source_urls?: string[];
  research_mode?: string;
  target_ids: number[];
  posts_per_target?: Record<number, number>;
}): PlanWithAssets {
  const db = getDb();
  if (!db) throw new Error('Database not available');
  try {
    const result = db.prepare(`
      INSERT INTO linkedin_content_plans (title, prompt, topic, source_urls, research_mode)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.title,
      input.prompt,
      input.topic || null,
      input.source_urls ? JSON.stringify(input.source_urls) : null,
      input.research_mode || 'balanced',
    );
    const planId = result.lastInsertRowid as number;

    // Create assets for each target
    const insertAsset = db.prepare(`
      INSERT INTO linkedin_plan_assets (plan_id, target_id, status)
      VALUES (?, ?, 'pending')
    `);
    const targets = db.prepare('SELECT * FROM linkedin_targets WHERE id IN (' + input.target_ids.map(() => '?').join(',') + ')').all(...input.target_ids) as PlannerTarget[];

    for (const target of targets) {
      const count = input.posts_per_target?.[target.id] ?? target.posts_per_day;
      for (let i = 0; i < count; i++) {
        insertAsset.run(planId, target.id);
      }
    }

    return getPlanWithAssets(planId)!;
  } finally {
    db.close();
  }
}

export function updatePlan(id: number, updates: Partial<{
  title: string;
  prompt: string;
  topic: string | null;
  source_urls: string[];
  research_mode: string;
  status: string;
}>): ContentPlan | null {
  const db = getDb();
  if (!db) return null;
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'id') continue;
      if (key === 'source_urls') {
        fields.push('source_urls = ?');
        values.push(JSON.stringify(val));
      } else {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (fields.length === 0) return getPlan(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE linkedin_content_plans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return db.prepare('SELECT * FROM linkedin_content_plans WHERE id = ?').get(id) as ContentPlan || null;
  } finally {
    db.close();
  }
}

export function deletePlan(id: number): boolean {
  const db = getDb();
  if (!db) return false;
  try {
    // CASCADE will handle assets
    const result = db.prepare('DELETE FROM linkedin_content_plans WHERE id = ?').run(id);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Asset CRUD
// ---------------------------------------------------------------------------

export function listAssets(filters?: {
  status?: string;
  target_id?: number;
  plan_id?: number;
}): PlanAsset[] {
  const db = getDb();
  if (!db) return [];
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters?.status) { conditions.push('a.status = ?'); params.push(filters.status); }
    if (filters?.target_id) { conditions.push('a.target_id = ?'); params.push(filters.target_id); }
    if (filters?.plan_id) { conditions.push('a.plan_id = ?'); params.push(filters.plan_id); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`
      SELECT a.*, t.label as target_label, t.target_type, t.url as target_url, t.can_auto_publish,
             p.title as plan_title, p.prompt as plan_prompt
      FROM linkedin_plan_assets a
      JOIN linkedin_targets t ON t.id = a.target_id
      JOIN linkedin_content_plans p ON p.id = a.plan_id
      ${where}
      ORDER BY a.created_at DESC
    `).all(...params) as PlanAsset[];
  } finally {
    db.close();
  }
}

export function getAsset(id: number): PlanAsset | null {
  const db = getDb();
  if (!db) return null;
  try {
    return (db.prepare(`
      SELECT a.*, t.label as target_label, t.target_type, t.url as target_url, t.can_auto_publish,
             p.title as plan_title, p.prompt as plan_prompt
      FROM linkedin_plan_assets a
      JOIN linkedin_targets t ON t.id = a.target_id
      JOIN linkedin_content_plans p ON p.id = a.plan_id
      WHERE a.id = ?
    `).get(id) as PlanAsset) || null;
  } finally {
    db.close();
  }
}

export function updateAsset(id: number, updates: Partial<{
  draft_text: string | null;
  final_text: string | null;
  quality_score: number | null;
  fingerprint: string | null;
  evidence_id: number | null;
  kanban_task_id: number | null;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  publish_error: string | null;
  image_path: string | null;
}>): PlanAsset | null {
  const db = getDb();
  if (!db) return null;
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'id') continue;
      fields.push(`${key} = ?`);
      values.push(val ?? null);
    }
    if (fields.length === 0) return getAsset(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE linkedin_plan_assets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return getAsset(id);
  } finally {
    db.close();
  }
}

export function approveAsset(id: number): PlanAsset | null {
  const db = getDb();
  if (!db) return null;
  try {
    const asset = db.prepare('SELECT * FROM linkedin_plan_assets WHERE id = ?').get(id) as PlanAsset | undefined;
    if (!asset) return null;
    const text = asset.final_text || asset.draft_text;
    if (!text) throw new Error('Cannot approve asset without draft text');
    db.prepare(`
      UPDATE linkedin_plan_assets
      SET status = 'approved', final_text = COALESCE(final_text, draft_text), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);

    // Move kanban task if exists
    if (asset.kanban_task_id) {
      try { KanbanService.updateTask(asset.kanban_task_id, { status: 'review' }); } catch { /* ok */ }
    }

    return getAsset(id);
  } finally {
    db.close();
  }
}

export function rejectAsset(id: number): PlanAsset | null {
  const db = getDb();
  if (!db) return null;
  try {
    db.prepare("UPDATE linkedin_plan_assets SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(id);
    return getAsset(id);
  } finally {
    db.close();
  }
}

export function markAssetCopied(id: number): PlanAsset | null {
  const db = getDb();
  if (!db) return null;
  try {
    db.prepare("UPDATE linkedin_plan_assets SET status = 'copied', updated_at = datetime('now') WHERE id = ?").run(id);
    return getAsset(id);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Fingerprint dedup (reuses same normalization as comment drafter)
// ---------------------------------------------------------------------------

function normalizeFingerprint(text: string): string {
  const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'how', 'if', 'when', 'where', 'why', 'about']);
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .sort()
    .join(' ');
}

export function isDuplicateAsset(draftText: string, planId: number): boolean {
  const db = getDb();
  if (!db) return false;
  try {
    const fp = normalizeFingerprint(draftText);
    const existing = db.prepare(`
      SELECT fingerprint FROM linkedin_plan_assets
      WHERE plan_id = ? AND status NOT IN ('rejected') AND fingerprint IS NOT NULL
    `).all(planId) as Array<{ fingerprint: string }>;
    return existing.some(row => row.fingerprint === fp);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Research + Draft orchestration (via agent processMessage)
// ---------------------------------------------------------------------------

export interface PlanResearchResult {
  thesis: string;
  evidence: string;
  sources: string[];
  implications: string;
}

export async function runPlanResearch(planId: number): Promise<PlanResearchResult> {
  const plan = getPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  updatePlan(planId, { status: 'researching' });

  const sourceUrls = plan.source_urls ? JSON.parse(plan.source_urls) as string[] : [];
  const sourceSection = sourceUrls.length > 0
    ? `\n\nReference URLs to analyze:\n${sourceUrls.map(u => `- ${u}`).join('\n')}`
    : '';

  const researchPrompt = `You are a LinkedIn content researcher. Research the following topic thoroughly and return structured findings.

Topic/Prompt: ${plan.prompt}${sourceSection}

Research mode: ${plan.research_mode}

Return your findings in this exact format:
THESIS: [One-sentence core thesis]
EVIDENCE: [Key facts, data points, and supporting evidence found]
SOURCES: [List of sources consulted, one per line]
IMPLICATIONS: [What this means practically, actionable insights]

Be specific and factual. Cite real data where possible.`;

  try {
    const response = await AgentManager.processMessage(researchPrompt, 'planner:research');
    const text = typeof response === 'string' ? response : String(response || '');

    // Parse structured response
    const thesisMatch = text.match(/THESIS:\s*(.+?)(?=\nEVIDENCE:|\n\n|$)/s);
    const evidenceMatch = text.match(/EVIDENCE:\s*(.+?)(?=\nSOURCES:|\n\n|$)/s);
    const sourcesMatch = text.match(/SOURCES:\s*(.+?)(?=\nIMPLICATIONS:|\n\n|$)/s);
    const implicationsMatch = text.match(/IMPLICATIONS:\s*(.+?)$/s);

    const result: PlanResearchResult = {
      thesis: thesisMatch?.[1]?.trim() || text.slice(0, 200),
      evidence: evidenceMatch?.[1]?.trim() || '',
      sources: (sourcesMatch?.[1]?.trim() || '').split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean),
      implications: implicationsMatch?.[1]?.trim() || '',
    };

    updatePlan(planId, { status: 'ready' });
    return result;
  } catch (err) {
    updatePlan(planId, { status: 'draft' });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Image generation (Nano Banana / Gemini 3 Pro Image)
// ---------------------------------------------------------------------------

function getNanoBananaScript(): string | null {
  const skillPath = path.join(
    os.homedir(), '.claude', 'plugins', 'marketplaces', 'opc-skills',
    'skills', 'nanobanana', 'scripts', 'generate.py'
  );
  return fs.existsSync(skillPath) ? skillPath : null;
}

function findPython3(): string {
  for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (fs.existsSync(p)) return p;
  }
  return 'python3';
}

/**
 * Generate a LinkedIn post image using Nano Banana (Gemini 3 Pro Image).
 * Returns the image path on success, null on failure.
 */
export async function generatePostImage(
  postText: string,
  planTitle: string,
  assetId: number,
): Promise<string | null> {
  const script = getNanoBananaScript();
  if (!script) {
    console.warn('[Planner] Nano Banana skill not found, skipping image generation');
    return null;
  }

  const geminiKey = process.env.GEMINI_API_KEY || SettingsManager.get('gemini.apiKey') || '';
  if (!geminiKey) {
    console.warn('[Planner] No GEMINI_API_KEY available, skipping image generation');
    return null;
  }

  // Build image prompt from the post text
  const hook = postText.split('\n')[0].slice(0, 100);
  const imagePrompt = `Professional LinkedIn post illustration. Topic: "${planTitle}". `
    + `Key message: "${hook}". `
    + `Style: clean, modern, professional, subtle gradient background, minimal text overlay. `
    + `No people faces. No text in the image. Suitable as a LinkedIn post header image.`;

  const outputDir = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'planner-images');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `asset_${assetId}_${Date.now()}.png`);

  try {
    const python = findPython3();
    const { stdout } = await execFile(python, [
      script, imagePrompt,
      '-o', outputPath,
      '--ratio', '3:2',
    ], {
      timeout: 60000,
      env: {
        ...process.env,
        GEMINI_API_KEY: geminiKey,
        HOME: process.env.HOME || os.homedir(),
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      },
    });

    if (fs.existsSync(outputPath)) {
      console.log(`[Planner] Generated image for asset #${assetId}: ${outputPath}`);
      return outputPath;
    }

    // generate.py prints the path to stdout on success
    const resultPath = stdout.trim();
    if (resultPath && fs.existsSync(resultPath)) {
      return resultPath;
    }

    console.warn('[Planner] Image generation produced no file');
    return null;
  } catch (err) {
    console.error(`[Planner] Image generation failed for asset #${assetId}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Screenshot & Annotate
// ---------------------------------------------------------------------------

function getScreenshotScript(): string {
  return path.join(__dirname, '..', 'skills', 'linkedin', 'scripts', 'screenshot_annotate.py');
}

interface ScreenshotAnnotation {
  type?: 'rect' | 'highlight' | 'number' | 'arrow';
  selector?: string;
  from_selector?: string;
  to_selector?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  thickness?: number;
  label?: string;
}

interface ScreenshotOptions {
  url?: string;
  html?: string;
  css?: string;
  selector?: string;
  scrollTo?: string;
  annotations?: ScreenshotAnnotation[];
  fullPage?: boolean;
  crop?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  wait?: number;
}

/**
 * Take a screenshot of a URL or HTML string, optionally with visual annotations
 * (red rectangles, highlights, numbered callouts, arrows).
 * Returns the image path on success, null on failure.
 */
export async function screenshotAnnotate(
  options: ScreenshotOptions,
  outputPath?: string,
): Promise<string | null> {
  const script = getScreenshotScript();
  if (!fs.existsSync(script)) {
    console.warn('[Screenshot] screenshot_annotate.py not found');
    return null;
  }

  const python = findPython3();
  const imgDir = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'screenshots');
  fs.mkdirSync(imgDir, { recursive: true });
  const out = outputPath || path.join(imgDir, `screenshot_${Date.now()}.png`);

  const args: string[] = [script, '-o', out];

  if (options.url) {
    args.push('--url', options.url);
  } else if (options.html) {
    args.push('--html', options.html);
    if (options.css) args.push('--css', options.css);
  } else {
    console.warn('[Screenshot] No --url or --html provided');
    return null;
  }

  if (options.selector) args.push('--selector', options.selector);
  if (options.scrollTo) args.push('--scroll-to', options.scrollTo);
  if (options.fullPage) args.push('--full-page');
  if (options.crop) args.push('--crop', options.crop);
  if (options.viewportWidth) args.push('--width', String(options.viewportWidth));
  if (options.viewportHeight) args.push('--height', String(options.viewportHeight));
  if (options.wait) args.push('--wait', String(options.wait));
  if (options.annotations?.length) {
    args.push('--annotations', JSON.stringify(options.annotations));
  }

  try {
    await execFile(python, args, {
      timeout: 60000,
      env: {
        ...process.env,
        HOME: process.env.HOME || os.homedir(),
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      },
    });

    if (fs.existsSync(out)) {
      console.log(`[Screenshot] Captured: ${out}`);
      return out;
    }
    console.warn('[Screenshot] No output file produced');
    return null;
  } catch (err) {
    console.error('[Screenshot] Failed:', err);
    return null;
  }
}

/**
 * Render an HTML table/code block/custom visual as an image for LinkedIn posts.
 * Useful for data tables, comparison charts, code snippets, etc.
 */
export async function renderHtmlAsImage(
  html: string,
  css?: string,
  outputPath?: string,
): Promise<string | null> {
  return screenshotAnnotate({ html, css }, outputPath);
}

// ---------------------------------------------------------------------------
// Post Bank & voice loading (mirrors linkedin-drafter.ts)
// ---------------------------------------------------------------------------

interface PostBankEntry {
  id: string;
  title: string;
  type: string;
  text: string;
  tags?: string[];
  group?: string;
  disabled?: boolean;
}

function loadPostBankEntries(): PostBankEntry[] {
  try {
    const raw = SettingsManager.get('linkedin.postBankEntries') || '[]';
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e: Record<string, unknown>) => e && typeof e === 'object')
      .map((e: Record<string, unknown>) => ({
        id: String(e.id || ''),
        title: String(e.title || ''),
        type: String(e.type || ''),
        text: String(e.text || ''),
        tags: Array.isArray(e.tags) ? (e.tags as string[]).map(String).filter(Boolean) : [],
        group: String(e.group || '').trim(),
        disabled: Boolean(e.disabled),
      }))
      .filter((e: PostBankEntry) => e.id && e.text && !e.disabled);
  } catch {
    return [];
  }
}

function buildPostBankBlock(entries: PostBankEntry[], count = 3): string {
  if (!entries.length) return '';
  const shuffled = [...entries].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, count);
  const blocks = selected.map(e => {
    const title = e.title ? ` (${e.title})` : '';
    return `---\n${e.text.trim()}${title}\n---`;
  });
  return `\nVOICE EXAMPLES (style anchor, not content):\n${blocks.join('\n')}\n\nLet these examples shape opener pressure, rhythm, sentence length variation, and how the post flows.\nDo not copy phrases or content, but do let the human texture influence the draft.\n`;
}

function cleanPlannerDraft(draft: string): string {
  let text = draft.trim()
    .replace(/\s*-\s*/g, ', ')   // em dashes (already hyphens from model)
    .replace(/\s*-\s*/g, ', ')   // en dashes
    .replace(/,,/g, ',')
    .replace(/^["']|["']$/g, '');

  // Strip emojis
  text = text
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/[\uFE0F\uFE0E]/g, '')
    .replace(/\u200D/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '');

  // Strip preamble
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length > 1) {
    const preamble = /^(here['']?s|sure|okay|draft|below|the final|my reply)/i;
    while (lines.length > 1 && lines[0].length < 80 && preamble.test(lines[0].trim())) {
      lines.shift();
    }
    text = lines.join('\n');
  }

  // Replace em/en dashes with hyphens
  text = text.replace(/[—–]/g, '-');

  // Straight quotes only
  text = text.replace(/[""]/g, '"').replace(/['']/g, "'");

  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

const AI_SLOP_PATTERN = /\b(landscape|leverage|robust|comprehensive|holistic|streamline|optimize|paradigm|game[- ]changing|cutting-edge|transformative|unprecedented|synergy|foster|harness|delve|elevate|dramatically|significantly|meaningful|importantly|more importantly|most importantly)\b/i;

const DEFAULT_HARD_RULES = `- No emojis, no hashtags, no em dashes, no en dashes. Hyphens only.
- No generic openers: "I'm excited to share", "In today's world", "Let me tell you."
- No AI jargon: "landscape", "leverage", "robust", "holistic", "transformative", "game-changing", "paradigm", "ecosystem", "scalable", "actionable", "double down."
- Straight quotes and apostrophes only. No curly/smart quotes.
- No metaphors or analogies. Never "it's like X." Say the thing directly.
- No intro-body-conclusion structure. Read like one continuous thought that stopped mid-momentum.
- No formula phrasing like "the pattern this year is pretty clear."
- Do not use: "importantly", "more importantly", "most importantly."
- Format: 2-4 short chunks, single line breaks between them. No walls of text.
- Write in present simple tense.
- Concrete stance with practical takeaway.
- End with a statement or a take. Never a question.`;

const DEFAULT_POST_FORMAT = 'Write a LinkedIn post (100-300 words). Strong hook in first line, clear structure, practical takeaway.';
const DEFAULT_ARTICLE_FORMAT = 'Write a long-form LinkedIn article (800-1500 words) with clear sections and headers.';
const DEFAULT_GROUP_FORMAT = 'Write a group discussion post (100-250 words). Frame as a question or discussion starter, not self-promotion.';

export async function generatePlanAssets(planId: number): Promise<PlanAsset[]> {
  const planData = getPlanWithAssets(planId);
  if (!planData) throw new Error(`Plan ${planId} not found`);

  updatePlan(planId, { status: 'generating' });

  const pendingAssets = planData.assets.filter(a => a.status === 'pending');
  if (pendingAssets.length === 0) {
    updatePlan(planId, { status: 'ready' });
    return [];
  }

  // All configurable via settings - current values are defaults
  const voiceStyle = SettingsManager.get('linkedin.voiceStyle') || '';
  const writingRules = SettingsManager.get('linkedin.writingRules') || '';
  const contentDirection = SettingsManager.get('linkedin.contentDirection') || '';
  const postStrategy = SettingsManager.get('linkedin.postStrategy') || '';
  const hardRules = SettingsManager.get('linkedin.plannerHardRules') || DEFAULT_HARD_RULES;
  const postFormat = SettingsManager.get('linkedin.plannerPostFormat') || DEFAULT_POST_FORMAT;
  const articleFormat = SettingsManager.get('linkedin.plannerArticleFormat') || DEFAULT_ARTICLE_FORMAT;
  const groupFormat = SettingsManager.get('linkedin.plannerGroupFormat') || DEFAULT_GROUP_FORMAT;
  const bankEntryCount = parseInt(SettingsManager.get('linkedin.plannerBankEntries') || '3', 10);

  // Load Post Bank entries for voice anchoring
  const postBankEntries = loadPostBankEntries();
  const postBankBlock = buildPostBankBlock(postBankEntries, bankEntryCount);

  const results: PlanAsset[] = [];
  const usedOpenings: string[] = [];

  for (const asset of pendingAssets) {
    const target = getTarget(asset.target_id);
    if (!target) continue;

    const targetContext = [
      target.audience_summary ? `Audience: ${target.audience_summary}` : '',
      target.tone_rules ? `Tone: ${target.tone_rules}` : '',
      target.topic_fit_rules ? `Topic fit: ${target.topic_fit_rules}` : '',
      target.cta_style ? `CTA style: ${target.cta_style}` : '',
    ].filter(Boolean).join('\n');

    const formatGuidance = target.target_type === 'article'
      ? articleFormat
      : target.target_type === 'group'
        ? groupFormat
        : postFormat;

    const avoidOpeningsBlock = usedOpenings.length
      ? `\nAvoid these opening patterns already used in this plan: ${usedOpenings.join(' | ')}`
      : '';

    const draftPrompt = `You are writing an original LinkedIn post. Write ONLY the post text - no commentary, no labels, no "Here's your post:" preamble.

Plan prompt: ${planData.prompt}
${planData.topic ? `Topic: ${planData.topic}` : ''}

Target: ${target.label} (${target.target_type})
${targetContext}

${formatGuidance}

${voiceStyle ? `Voice/Style: ${voiceStyle}` : ''}
${writingRules ? `Writing rules: ${writingRules}` : ''}
${contentDirection ? `Content direction: ${contentDirection}` : ''}
${postStrategy ? `Strategy: ${postStrategy}` : ''}
${postBankBlock}
HARD RULES:
${hardRules}
- Each post in this plan must have a unique hook and framing - do NOT repeat patterns.${avoidOpeningsBlock}

OUTPUT:
Return only the final post text.`;

    try {
      const response = await AgentManager.processMessage(draftPrompt, 'planner:draft');
      let draftText = typeof response === 'string' ? response : String(response || '');

      // Clean draft (strip emojis, dashes, preamble, AI slop)
      draftText = cleanPlannerDraft(draftText);

      if (!draftText || draftText.length < 50) {
        console.warn(`[Planner] Draft too short for asset ${asset.id}, skipping`);
        continue;
      }

      // Quality gate: check for AI slop and retry once
      if (AI_SLOP_PATTERN.test(draftText)) {
        console.warn(`[Planner] AI slop detected in asset ${asset.id}, retrying`);
        const retryResponse = await AgentManager.processMessage(
          draftPrompt + '\n\nThe previous draft contained AI-sounding jargon. Rewrite with natural, direct language. No corporate buzzwords.',
          'planner:draft'
        );
        const retryText = cleanPlannerDraft(typeof retryResponse === 'string' ? retryResponse : String(retryResponse || ''));
        if (retryText && retryText.length >= 50) draftText = retryText;
      }

      // Track opening for diversity
      const firstLine = draftText.split('\n')[0]?.slice(0, 60) || '';
      usedOpenings.push(firstLine);

      // Check for duplicates within this plan
      const fp = normalizeFingerprint(draftText);
      if (isDuplicateAsset(draftText, planId)) {
        console.warn(`[Planner] Duplicate draft detected for asset ${asset.id}, skipping`);
        continue;
      }

      // Create kanban task
      let kanbanTaskId: number | null = null;
      try {
        let project = KanbanService.getProjectByName('LinkedIn');
        if (!project) {
          KanbanService.createProject('LinkedIn');
          project = KanbanService.getProjectByName('LinkedIn');
        }
        if (project) {
          const task = KanbanService.createTask({
            project_id: project.id,
            title: `[Post] ${planData.title} → ${target.label}`,
            description: draftText.slice(0, 500),
            status: 'todo',
          });
          kanbanTaskId = task.id;
        }
      } catch { /* kanban is optional */ }

      // Generate post image if enabled
      let imagePath: string | null = null;
      if (SettingsManager.get('linkedin.plannerAutoImage') !== 'false') {
        try {
          imagePath = await generatePostImage(draftText, planData.title, asset.id);
        } catch { /* image generation is optional */ }
      }

      const updated = updateAsset(asset.id, {
        draft_text: draftText,
        fingerprint: fp,
        kanban_task_id: kanbanTaskId,
        image_path: imagePath,
        status: 'drafted',
      });

      if (updated) results.push(updated);
    } catch (err) {
      console.error(`[Planner] Failed to generate draft for asset ${asset.id}:`, err);
    }
  }

  // Update plan status
  const allAssets = getPlanWithAssets(planId)?.assets || [];
  const allDone = allAssets.every(a => a.status !== 'pending');
  updatePlan(planId, { status: allDone ? 'ready' : 'generating' });

  return results;
}

// ---------------------------------------------------------------------------
// Publishing (delegates to existing post.py via linkedinExec)
// ---------------------------------------------------------------------------

export async function publishAsset(id: number): Promise<PlanAsset> {
  // Import dynamically to avoid circular dependency
  const { linkedinExec } = await import('./linkedin-wrapper');

  const asset = getAsset(id);
  if (!asset) throw new Error(`Asset ${id} not found`);

  const text = asset.final_text || asset.draft_text;
  if (!text) throw new Error('No text to publish');

  if (!asset.can_auto_publish) {
    throw new Error(`Target "${asset.target_label}" does not support auto-publishing. Use "Copy Text" and post manually.`);
  }

  try {
    const postArgs = ['--text', text, '--no-confirm'];
    if (asset.image_path) postArgs.push('--image', asset.image_path);
    await linkedinExec('post', postArgs);

    const updated = updateAsset(id, {
      status: 'published',
      published_at: new Date().toISOString(),
      publish_error: null,
    });

    // Update kanban
    if (asset.kanban_task_id) {
      try { KanbanService.updateTask(asset.kanban_task_id, { status: 'done' }); } catch { /* ok */ }
    }

    // Log to activity log
    const db = getDb();
    if (db) {
      try {
        db.prepare(`
          INSERT INTO linkedin_activity_log (post_id, post_url, action, reason, comment_text)
          VALUES (?, ?, 'plan_published', ?, ?)
        `).run(asset.id, asset.target_url || 'profile', `Plan asset published to ${asset.target_label}`, text.slice(0, 500));
      } finally {
        db.close();
      }
    }

    return updated!;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateAsset(id, { publish_error: errMsg });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Agent tool definitions
// ---------------------------------------------------------------------------

export function getPlannerTools() {
  return [
    {
      name: 'linkedin_manage_targets',
      description: 'Manage LinkedIn publishing targets (profile, company page, group, article stream). Actions: list, add, update, delete, toggle.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'update', 'delete', 'toggle'], description: 'Action to perform' },
          id: { type: 'number', description: 'Target ID (for update/delete/toggle)' },
          target_type: { type: 'string', enum: ['profile', 'company', 'group', 'article'], description: 'Target type (for add)' },
          url: { type: 'string', description: 'LinkedIn URL of the target (for add/update)' },
          label: { type: 'string', description: 'Human-readable name (for add/update)' },
          enabled: { type: 'boolean', description: 'Enable/disable (for toggle)' },
          audience_summary: { type: 'string', description: 'Target audience description' },
          tone_rules: { type: 'string', description: 'Tone/voice overrides for this target' },
          topic_fit_rules: { type: 'string', description: 'What topics fit this target' },
          cta_style: { type: 'string', description: 'CTA approach' },
          posts_per_day: { type: 'number', description: 'Default daily quota' },
          approval_mode: { type: 'string', enum: ['review_required', 'auto'], description: 'Approval mode' },
        },
        required: ['action'],
      },
      handler: async (params: Record<string, unknown>): Promise<string> => {
        const action = String(params.action);
        if (action === 'list') {
          const targets = listTargets();
          if (targets.length === 0) return 'No targets configured. Use action "add" to create one.';
          return targets.map(t =>
            `[${t.id}] ${t.enabled ? '✓' : '✗'} ${t.target_type} "${t.label}"${t.url ? ` (${t.url})` : ''} — ${t.posts_per_day}/day, ${t.approval_mode}${t.can_auto_publish ? ', auto-publish' : ', manual only'}`
          ).join('\n');
        }
        if (action === 'add') {
          if (!params.label) return 'Error: label is required';
          const target = addTarget(params as Parameters<typeof addTarget>[0]);
          return `Created target [${target.id}] "${target.label}" (${target.target_type})`;
        }
        if (action === 'update') {
          if (!params.id) return 'Error: id is required';
          const target = updateTarget(Number(params.id), params as Parameters<typeof updateTarget>[1]);
          return target ? `Updated target [${target.id}] "${target.label}"` : 'Target not found';
        }
        if (action === 'delete') {
          if (!params.id) return 'Error: id is required';
          try {
            return deleteTarget(Number(params.id)) ? 'Target deleted' : 'Target not found';
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (action === 'toggle') {
          if (!params.id) return 'Error: id is required';
          const target = toggleTarget(Number(params.id), params.enabled !== false);
          return target ? `Target [${target.id}] "${target.label}" is now ${target.enabled ? 'enabled' : 'disabled'}` : 'Target not found';
        }
        return `Unknown action: ${action}`;
      },
    },
    {
      name: 'linkedin_create_content_plan',
      description: 'Create a LinkedIn content plan from a prompt. Optionally provide reference URLs and select targets. Returns the plan with pending assets.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Short plan title' },
          prompt: { type: 'string', description: 'Content prompt / topic to write about' },
          topic: { type: 'string', description: 'Topic label' },
          source_urls: { type: 'array', items: { type: 'string' }, description: 'Reference URLs' },
          research_mode: { type: 'string', enum: ['fast', 'balanced', 'deep'], description: 'Research depth' },
          target_ids: { type: 'array', items: { type: 'number' }, description: 'Target IDs to create assets for. If omitted, uses all enabled targets.' },
          posts_per_target: { type: 'object', description: 'Override post count per target ID, e.g. {"1": 2, "3": 1}' },
        },
        required: ['title', 'prompt'],
      },
      handler: async (params: Record<string, unknown>): Promise<string> => {
        let targetIds = params.target_ids as number[] | undefined;
        if (!targetIds || targetIds.length === 0) {
          targetIds = listTargets().filter(t => t.enabled).map(t => t.id);
        }
        if (targetIds.length === 0) return 'Error: No targets available. Create targets first with linkedin_manage_targets.';

        const plan = createPlan({
          title: String(params.title),
          prompt: String(params.prompt),
          topic: params.topic ? String(params.topic) : undefined,
          source_urls: params.source_urls as string[] | undefined,
          research_mode: params.research_mode ? String(params.research_mode) : undefined,
          target_ids: targetIds,
          posts_per_target: params.posts_per_target as Record<number, number> | undefined,
        });

        const summary = plan.assets.length > 0
          ? `\nAssets created: ${plan.assets.length} (${plan.assets.map(a => `${a.target_label}: pending`).join(', ')})`
          : '\nNo assets created.';

        return `Plan [${plan.id}] "${plan.title}" created (${plan.research_mode} mode).${summary}\n\nUse linkedin_generate_plan_assets to research and generate drafts.`;
      },
    },
    {
      name: 'linkedin_generate_plan_assets',
      description: 'Research the plan topic and generate target-specific draft posts for all pending assets in a plan.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plan_id: { type: 'number', description: 'Plan ID to generate assets for' },
        },
        required: ['plan_id'],
      },
      handler: async (params: Record<string, unknown>): Promise<string> => {
        const planId = Number(params.plan_id);
        const assets = await generatePlanAssets(planId);
        if (assets.length === 0) return 'No assets were generated. Check plan status and pending assets.';
        return `Generated ${assets.length} draft(s):\n` + assets.map(a =>
          `  [${a.id}] ${a.target_label} (${a.target_type}) — ${a.draft_text?.slice(0, 80)}...`
        ).join('\n');
      },
    },
    {
      name: 'linkedin_publish_plan_asset',
      description: 'Publish an approved plan asset to LinkedIn. Only works for targets with auto-publish capability (currently profile only).',
      input_schema: {
        type: 'object' as const,
        properties: {
          asset_id: { type: 'number', description: 'Asset ID to publish' },
        },
        required: ['asset_id'],
      },
      handler: async (params: Record<string, unknown>): Promise<string> => {
        try {
          const asset = await publishAsset(Number(params.asset_id));
          return `Published asset [${asset.id}] to ${asset.target_label}. Status: ${asset.status}`;
        } catch (err) {
          return `Publish failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'linkedin_plan_status',
      description: 'Show status summary of content plans and their assets.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plan_id: { type: 'number', description: 'Specific plan ID, or omit for all plans' },
        },
      },
      handler: async (params: Record<string, unknown>): Promise<string> => {
        if (params.plan_id) {
          const plan = getPlanWithAssets(Number(params.plan_id));
          if (!plan) return 'Plan not found';
          const assetLines = plan.assets.map(a =>
            `  [${a.id}] ${a.target_label} (${a.target_type}) — ${a.status}${a.scheduled_at ? ` @ ${a.scheduled_at}` : ''}${a.draft_text ? ` — "${a.draft_text.slice(0, 60)}..."` : ''}`
          );
          return `Plan [${plan.id}] "${plan.title}" (${plan.status})\nPrompt: ${plan.prompt.slice(0, 100)}...\nAssets (${plan.assets.length}):\n${assetLines.join('\n')}`;
        }

        const plans = listPlans();
        if (plans.length === 0) return 'No content plans exist. Create one with linkedin_create_content_plan.';
        const lines: string[] = [];
        for (const plan of plans) {
          const assets = listAssets({ plan_id: plan.id });
          const statusCounts: Record<string, number> = {};
          for (const a of assets) {
            statusCounts[a.status] = (statusCounts[a.status] || 0) + 1;
          }
          const statusSummary = Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`).join(', ');
          lines.push(`[${plan.id}] "${plan.title}" (${plan.status}) — ${assets.length} assets: ${statusSummary || 'none'}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'linkedin_screenshot_annotate',
      description: 'Screenshot a web page or render HTML as an image, with optional visual annotations (red rectangles, highlights, numbered callouts, arrows). Use for: annotated patent screenshots, data tables as images, comparison charts, code snippets, visual breakdowns.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to screenshot' },
          html: { type: 'string', description: 'HTML string to render as image (alternative to url). For tables, charts, code blocks, custom visuals.' },
          css: { type: 'string', description: 'Extra CSS for html mode' },
          selector: { type: 'string', description: 'CSS selector to screenshot (element only, not full page)' },
          scroll_to: { type: 'string', description: 'CSS selector to scroll to before screenshot' },
          full_page: { type: 'boolean', description: 'Capture full scrollable page' },
          crop: { type: 'string', description: 'Crop region: x,y,width,height' },
          viewport_width: { type: 'number', description: 'Viewport width (default 1440)' },
          viewport_height: { type: 'number', description: 'Viewport height (default 900)' },
          wait: { type: 'number', description: 'Seconds to wait after page load (default 2)' },
          annotations: {
            type: 'array',
            description: 'Visual annotations to overlay on the screenshot',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['rect', 'highlight', 'number', 'arrow'], description: 'Annotation type (default: rect)' },
                selector: { type: 'string', description: 'CSS selector for target element' },
                from_selector: { type: 'string', description: 'Arrow start element (for type=arrow)' },
                to_selector: { type: 'string', description: 'Arrow end element (for type=arrow)' },
                x: { type: 'number', description: 'X position (px, alternative to selector)' },
                y: { type: 'number', description: 'Y position (px)' },
                width: { type: 'number', description: 'Width (px)' },
                height: { type: 'number', description: 'Height (px)' },
                color: { type: 'string', description: 'Color (default: red)' },
                thickness: { type: 'number', description: 'Border thickness (default: 3)' },
                label: { type: 'string', description: 'Label text for rect/number annotations' },
              },
            },
          },
          asset_id: { type: 'number', description: 'If provided, attach the screenshot to this plan asset as its image' },
        },
      },
      handler: async (params: Record<string, unknown>): Promise<string> => {
        try {
          const options: ScreenshotOptions = {};
          if (params.url) options.url = String(params.url);
          if (params.html) options.html = String(params.html);
          if (params.css) options.css = String(params.css);
          if (params.selector) options.selector = String(params.selector);
          if (params.scroll_to) options.scrollTo = String(params.scroll_to);
          if (params.full_page) options.fullPage = true;
          if (params.crop) options.crop = String(params.crop);
          if (params.viewport_width) options.viewportWidth = Number(params.viewport_width);
          if (params.viewport_height) options.viewportHeight = Number(params.viewport_height);
          if (params.wait) options.wait = Number(params.wait);
          if (Array.isArray(params.annotations)) options.annotations = params.annotations as ScreenshotAnnotation[];

          const imagePath = await screenshotAnnotate(options);
          if (!imagePath) return 'Screenshot failed - no output produced';

          // Optionally attach to a plan asset
          if (params.asset_id) {
            updateAsset(Number(params.asset_id), { image_path: imagePath });
            return `Screenshot saved and attached to asset [${params.asset_id}]: ${imagePath}`;
          }

          return `Screenshot saved: ${imagePath}`;
        } catch (err) {
          return `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

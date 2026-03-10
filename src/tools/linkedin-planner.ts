/**
 * LinkedIn Content Planner
 *
 * Manages publishing targets, content plans, and plan assets.
 * Research and drafting delegate to the existing SDK infrastructure
 * with a topic-focused prompt (vs the comment-focused drafter).
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
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
  session_id?: number | null;
  idea_card_id?: number | null;
  batch_rules?: string | null;
  per_idea_rules?: string | null;
  discussion_context?: string | null;
  last_error?: string | null;
  error_step?: string | null;
  retry_count?: number | null;
  image_model?: string | null;
  image_preset?: string | null;
  image_caption?: string | null;
  source_urls_json?: string | null;
  trace_json?: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields (optional)
  target_label?: string;
  target_type?: string;
  target_url?: string | null;
  plan_title?: string;
  plan_prompt?: string;
  can_auto_publish?: number;
  idea_angle?: string | null;
  idea_hook?: string | null;
  idea_sort_order?: number | null;
}

export interface PlanWithAssets extends ContentPlan {
  assets: PlanAsset[];
}

export type ImagePreset = 'meme' | 'explainer_card' | 'annotated_screenshot' | 'data_visual' | 'quote_card' | 'comparison' | 'none';
export const PLANNER_IMAGE_MODELS = [
  { id: 'nano-banana-2', label: 'Nano Banana 2', model: 'gemini-3.1-flash-image-preview' },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', model: 'gemini-3-pro-image-preview' },
  { id: 'nano-banana-fast', label: 'Nano Banana Fast', model: 'gemini-2.5-flash-image' },
  { id: 'none', label: 'No auto-image', model: 'none' },
] as const;
type PlannerImageModelId = typeof PLANNER_IMAGE_MODELS[number]['id'];

const PRESET_STYLE_SETTING_KEYS: Record<string, string> = {
  meme: 'linkedin.plannerImageStylePreset.meme',
  explainer_card: 'linkedin.plannerImageStylePreset.explainer_card',
  annotated_screenshot: 'linkedin.plannerImageStylePreset.annotated_screenshot',
  data_visual: 'linkedin.plannerImageStylePreset.data_visual',
  quote_card: 'linkedin.plannerImageStylePreset.quote_card',
  comparison: 'linkedin.plannerImageStylePreset.comparison',
  none: 'linkedin.plannerImageStylePreset.none',
};

export interface IdeaSession {
  id: number;
  status: string;
  initial_dump: string | null;
  discussion_history: string | null;
  batch_rules: string | null;
  research_sources: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaCard {
  id: number;
  session_id: number;
  target_id: number | null;
  angle: string;
  hook: string | null;
  key_points: string | null;
  source_urls: string | null;
  image_model: string | null;
  image_preset: ImagePreset;
  image_concept: string | null;
  image_caption: string | null;
  per_idea_rules: string | null;
  selected: number;
  sort_order: number;
  asset_id: number | null;
  created_at: string;
}

export interface UrlRegistryEntry {
  id: number;
  url: string;
  url_hash: string;
  domain: string | null;
  url_type: string;
  title: string | null;
  snippet: string | null;
  topic_tags: string | null;
  times_used: number;
  first_seen_at: string;
  last_used_at: string;
  created_at: string;
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
      SELECT a.*, t.label as target_label, t.target_type, t.url as target_url, t.can_auto_publish,
             ic.angle as idea_angle, ic.hook as idea_hook, ic.sort_order as idea_sort_order
      FROM linkedin_plan_assets a
      JOIN linkedin_targets t ON t.id = a.target_id
      LEFT JOIN linkedin_idea_cards ic ON ic.asset_id = a.id
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
    conditions.push(`NOT (
      a.status = 'rejected'
      AND COALESCE(TRIM(a.final_text), '') = ''
      AND COALESCE(TRIM(a.draft_text), '') = ''
      AND a.image_path IS NULL
    )`);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`
      SELECT a.*, t.label as target_label, t.target_type, t.url as target_url, t.can_auto_publish,
             p.title as plan_title, p.prompt as plan_prompt,
             ic.angle as idea_angle, ic.hook as idea_hook, ic.sort_order as idea_sort_order
      FROM linkedin_plan_assets a
      JOIN linkedin_targets t ON t.id = a.target_id
      JOIN linkedin_content_plans p ON p.id = a.plan_id
      LEFT JOIN linkedin_idea_cards ic ON ic.asset_id = a.id
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
             p.title as plan_title, p.prompt as plan_prompt,
             ic.angle as idea_angle, ic.hook as idea_hook, ic.sort_order as idea_sort_order
      FROM linkedin_plan_assets a
      JOIN linkedin_targets t ON t.id = a.target_id
      JOIN linkedin_content_plans p ON p.id = a.plan_id
      LEFT JOIN linkedin_idea_cards ic ON ic.asset_id = a.id
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
  session_id: number | null;
  idea_card_id: number | null;
  batch_rules: string | null;
  per_idea_rules: string | null;
  discussion_context: string | null;
  last_error: string | null;
  error_step: string | null;
  retry_count: number | null;
  image_model: string | null;
  image_preset: string | null;
  image_caption: string | null;
  source_urls_json: string | null;
  trace_json: string | null;
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

export function syncInheritedImageModelDefaults(nextModel: string, previousModel?: string | null): { assetsUpdated: number; cardsUpdated: number } {
  const db = getDb();
  if (!db) return { assetsUpdated: 0, cardsUpdated: 0 };
  const normalizedNext = resolvePlannerImageModel(nextModel);
  const normalizedPrev = previousModel ? resolvePlannerImageModel(previousModel) : null;
  try {
    const assetWhere = normalizedPrev
      ? `status IN ('pending', 'draft', 'drafted', 'approved') AND image_path IS NULL AND (image_model IS NULL OR image_model = ?)`
      : `status IN ('pending', 'draft', 'drafted', 'approved') AND image_path IS NULL AND image_model IS NULL`;
    const assetResult = normalizedPrev
      ? db.prepare(`UPDATE linkedin_plan_assets SET image_model = ?, updated_at = datetime('now') WHERE ${assetWhere}`).run(normalizedNext, normalizedPrev)
      : db.prepare(`UPDATE linkedin_plan_assets SET image_model = ?, updated_at = datetime('now') WHERE ${assetWhere}`).run(normalizedNext);

    const cardWhere = normalizedPrev
      ? `asset_id IS NULL AND (image_model IS NULL OR image_model = ?)`
      : `asset_id IS NULL AND image_model IS NULL`;
    const cardResult = normalizedPrev
      ? db.prepare(`UPDATE linkedin_idea_cards SET image_model = ? WHERE ${cardWhere}`).run(normalizedNext, normalizedPrev)
      : db.prepare(`UPDATE linkedin_idea_cards SET image_model = ? WHERE ${cardWhere}`).run(normalizedNext);

    return {
      assetsUpdated: assetResult.changes,
      cardsUpdated: cardResult.changes,
    };
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

export function forkAssetForRewrite(id: number): PlanAsset | null {
  const db = getDb();
  if (!db) return null;
  try {
    const asset = db.prepare('SELECT * FROM linkedin_plan_assets WHERE id = ?').get(id) as PlanAsset | undefined;
    if (!asset) return null;
    const text = asset.final_text || asset.draft_text;
    if (!text) throw new Error('Cannot rework asset without draft text');

    const nowIso = new Date().toISOString();
    let priorTrace: PlannerAssetTrace = {};
    try {
      priorTrace = asset.trace_json ? JSON.parse(asset.trace_json) as PlannerAssetTrace : {};
    } catch {
      priorTrace = {};
    }
    const forkTrace: PlannerAssetTrace = {
      sourceUrls: priorTrace.sourceUrls || [],
      queries: priorTrace.queries || [],
      prompts: priorTrace.prompts || {},
      postMeta: priorTrace.postMeta || {},
      image: priorTrace.image || {},
      events: [
        {
          at: nowIso,
          phase: 'forked',
          message: `Forked from asset #${id} (${asset.status}) for rework`,
        },
      ],
      timings: {
        ...(priorTrace.timings || {}),
        forkedAt: nowIso,
      },
    };

    const result = db.prepare(`
      INSERT INTO linkedin_plan_assets (
        plan_id, target_id, draft_text, final_text, quality_score, fingerprint, evidence_id,
        kanban_task_id, status, scheduled_at, published_at, publish_error, image_path, session_id,
        idea_card_id, batch_rules, per_idea_rules, discussion_context, last_error, error_step,
        retry_count, image_model, image_preset, image_caption, source_urls_json, trace_json
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 'draft', NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, ?)
    `).run(
      asset.plan_id,
      asset.target_id,
      text,
      asset.quality_score || null,
      asset.fingerprint || null,
      asset.evidence_id || null,
      asset.image_path || null,
      asset.session_id || null,
      asset.batch_rules || null,
      asset.per_idea_rules || null,
      asset.discussion_context || null,
      asset.image_model || null,
      asset.image_preset || null,
      asset.image_caption || null,
      asset.source_urls_json || null,
      JSON.stringify(forkTrace),
    );

    return getAsset(Number(result.lastInsertRowid)) || null;
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
// URL Registry
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('utm_content');
    u.searchParams.delete('utm_term');
    u.searchParams.delete('fbclid');
    u.searchParams.delete('gclid');
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

function hashUrl(url: string): string {
  return crypto.createHash('sha256').update(normalizeUrl(url)).digest('hex');
}

function extractDomain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export function registerUrl(entry: {
  url: string;
  url_type?: string;
  title?: string;
  snippet?: string;
  topic_tags?: string[];
}): UrlRegistryEntry | null {
  const db = getDb();
  if (!db) return null;
  try {
    const normalized = normalizeUrl(entry.url);
    const hash = hashUrl(entry.url);
    const domain = extractDomain(entry.url);
    const tags = entry.topic_tags?.length ? JSON.stringify(entry.topic_tags) : null;

    // Upsert: increment times_used if exists, insert if not
    const existing = db.prepare('SELECT * FROM linkedin_url_registry WHERE url_hash = ?').get(hash) as UrlRegistryEntry | undefined;
    if (existing) {
      db.prepare(`
        UPDATE linkedin_url_registry
        SET times_used = times_used + 1, last_used_at = datetime('now'),
            title = COALESCE(?, title), snippet = COALESCE(?, snippet),
            topic_tags = COALESCE(?, topic_tags)
        WHERE id = ?
      `).run(entry.title || null, entry.snippet || null, tags, existing.id);
      return db.prepare('SELECT * FROM linkedin_url_registry WHERE id = ?').get(existing.id) as UrlRegistryEntry;
    }

    const result = db.prepare(`
      INSERT INTO linkedin_url_registry (url, url_hash, domain, url_type, title, snippet, topic_tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(normalized, hash, domain, entry.url_type || 'reference', entry.title || null, entry.snippet || null, tags);

    return db.prepare('SELECT * FROM linkedin_url_registry WHERE id = ?').get(result.lastInsertRowid) as UrlRegistryEntry;
  } finally {
    db.close();
  }
}

export function checkUrlUsed(url: string): { used: boolean; entry?: UrlRegistryEntry; sessions?: number[] } {
  const db = getDb();
  if (!db) return { used: false };
  try {
    const hash = hashUrl(url);
    const entry = db.prepare('SELECT * FROM linkedin_url_registry WHERE url_hash = ?').get(hash) as UrlRegistryEntry | undefined;
    if (!entry) return { used: false };
    const sessions = db.prepare('SELECT session_id FROM linkedin_session_urls WHERE url_id = ?').all(entry.id) as Array<{ session_id: number }>;
    return { used: true, entry, sessions: sessions.map(s => s.session_id) };
  } finally {
    db.close();
  }
}

export function linkUrlToSession(urlId: number, sessionId: number, role = 'research'): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR IGNORE INTO linkedin_session_urls (session_id, url_id, role) VALUES (?, ?, ?)').run(sessionId, urlId, role);
  } finally { db.close(); }
}

export function linkUrlToIdea(urlId: number, ideaCardId: number): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR IGNORE INTO linkedin_idea_urls (idea_card_id, url_id) VALUES (?, ?)').run(ideaCardId, urlId);
  } finally { db.close(); }
}

export function linkUrlToAsset(urlId: number, assetId: number, role = 'source'): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR IGNORE INTO linkedin_asset_urls (asset_id, url_id, role) VALUES (?, ?, ?)').run(assetId, urlId, role);
  } finally { db.close(); }
}

export function getUrlsBySession(sessionId: number): UrlRegistryEntry[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT r.* FROM linkedin_url_registry r
      JOIN linkedin_session_urls su ON su.url_id = r.id
      WHERE su.session_id = ?
      ORDER BY r.last_used_at DESC
    `).all(sessionId) as UrlRegistryEntry[];
  } finally { db.close(); }
}

export function getUrlsByAsset(assetId: number): Array<UrlRegistryEntry & { role: string }> {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT r.*, au.role FROM linkedin_url_registry r
      JOIN linkedin_asset_urls au ON au.url_id = r.id
      WHERE au.asset_id = ?
      ORDER BY r.last_used_at DESC
    `).all(assetId) as Array<UrlRegistryEntry & { role: string }>;
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Idea Lab: Sessions
// ---------------------------------------------------------------------------

export function createIdeaSession(input: {
  initial_dump: string;
  research_sources?: Record<string, boolean>;
  batch_rules?: string;
}): IdeaSession | null {
  const db = getDb();
  if (!db) return null;
  try {
    const sources = input.research_sources ? JSON.stringify(input.research_sources) : null;
    const result = db.prepare(`
      INSERT INTO linkedin_idea_sessions (initial_dump, research_sources, batch_rules)
      VALUES (?, ?, ?)
    `).run(input.initial_dump, sources, input.batch_rules || null);
    return db.prepare('SELECT * FROM linkedin_idea_sessions WHERE id = ?').get(result.lastInsertRowid) as IdeaSession;
  } finally { db.close(); }
}

export function getIdeaSession(id: number): IdeaSession | null {
  const db = getDb();
  if (!db) return null;
  try {
    return (db.prepare('SELECT * FROM linkedin_idea_sessions WHERE id = ?').get(id) as IdeaSession) || null;
  } finally { db.close(); }
}

export function updateIdeaSession(id: number, updates: Partial<{
  status: string;
  discussion_history: string;
  batch_rules: string;
}>): IdeaSession | null {
  const db = getDb();
  if (!db) return null;
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) { fields.push(`${key} = ?`); values.push(val); }
    }
    if (!fields.length) return getIdeaSession(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE linkedin_idea_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return getIdeaSession(id);
  } finally { db.close(); }
}

export function listIdeaSessions(status?: string): IdeaSession[] {
  const db = getDb();
  if (!db) return [];
  try {
    if (status) {
      return db.prepare('SELECT * FROM linkedin_idea_sessions WHERE status = ? ORDER BY created_at DESC').all(status) as IdeaSession[];
    }
    return db.prepare('SELECT * FROM linkedin_idea_sessions ORDER BY created_at DESC').all() as IdeaSession[];
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Idea Lab: Cards
// ---------------------------------------------------------------------------

export function createIdeaCard(card: {
  session_id: number;
  target_id?: number;
  angle: string;
  hook?: string;
  key_points?: string[];
  source_urls?: string[];
  image_model?: string;
  image_preset?: ImagePreset;
  image_concept?: string;
  image_caption?: string;
  per_idea_rules?: string;
  sort_order?: number;
}): IdeaCard | null {
  const db = getDb();
  if (!db) return null;
  try {
    const result = db.prepare(`
      INSERT INTO linkedin_idea_cards (session_id, target_id, angle, hook, key_points, source_urls,
        image_model, image_preset, image_concept, image_caption, per_idea_rules, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      card.session_id, card.target_id || null, card.angle, card.hook || null,
      card.key_points ? JSON.stringify(card.key_points) : null,
      card.source_urls ? JSON.stringify(card.source_urls) : null,
      card.image_model || SettingsManager.get('linkedin.plannerImageModel') || 'nano-banana-pro',
      card.image_preset || 'none', card.image_concept || null,
      card.image_caption || null, card.per_idea_rules || null, card.sort_order || 0,
    );
    return db.prepare('SELECT * FROM linkedin_idea_cards WHERE id = ?').get(result.lastInsertRowid) as IdeaCard;
  } finally { db.close(); }
}

export function getIdeaCards(sessionId: number): IdeaCard[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM linkedin_idea_cards WHERE session_id = ? ORDER BY sort_order, id').all(sessionId) as IdeaCard[];
  } finally { db.close(); }
}

export function updateIdeaCard(id: number, updates: Partial<{
  angle: string;
  hook: string;
  key_points: string;
  source_urls: string;
  image_model: string;
  image_preset: string;
  image_concept: string;
  image_caption: string;
  per_idea_rules: string;
  selected: number;
  sort_order: number;
  target_id: number;
  asset_id: number;
}>): IdeaCard | null {
  const db = getDb();
  if (!db) return null;
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) { fields.push(`${key} = ?`); values.push(val); }
    }
    if (!fields.length) return null;
    values.push(id);
    db.prepare(`UPDATE linkedin_idea_cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return db.prepare('SELECT * FROM linkedin_idea_cards WHERE id = ?').get(id) as IdeaCard;
  } finally { db.close(); }
}

export function deleteIdeaCard(id: number): boolean {
  const db = getDb();
  if (!db) return false;
  try {
    return db.prepare('DELETE FROM linkedin_idea_cards WHERE id = ?').run(id).changes > 0;
  } finally { db.close(); }
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

interface PlannerAssetTraceEvent {
  phase: string;
  at: string;
  message?: string;
}

interface PlannerAssetTrace {
  createdAt?: string;
  postMeta?: {
    targetLabel?: string;
    targetType?: string;
    planTitle?: string;
    ideaTitle?: string;
    ideaHook?: string;
    ideaIndex?: number;
    continuityMode?: string;
    batchShape?: string;
  };
  prompts?: {
    assetBrief?: string;
    sharedContext?: string;
    draftPrompt?: string;
    imagePrompt?: string;
  };
  image?: {
    model?: string;
    modelLabel?: string;
    modelApiName?: string;
    preset?: string;
    direction?: string;
    prompt?: string;
    generatedAt?: string;
    outputPath?: string;
    stripEnabled?: boolean;
    stripStatus?: string;
    stripNote?: string;
  };
  queries?: string[];
  sourceUrls?: string[];
  timings?: {
    startedAt?: string;
    finishedAt?: string;
    imageStartedAt?: string;
    imageFinishedAt?: string;
    forkedAt?: string;
  };
  events?: PlannerAssetTraceEvent[];
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function updatePlannerAssetTrace(assetId: number, updater: (trace: PlannerAssetTrace) => PlannerAssetTrace): void {
  const asset = getAsset(assetId);
  if (!asset) return;
  const next = updater(safeParseJson<PlannerAssetTrace>(asset.trace_json, {}));
  updateAsset(assetId, { trace_json: JSON.stringify(next) });
}

function appendPlannerAssetTraceEvent(assetId: number, phase: string, message?: string): void {
  updatePlannerAssetTrace(assetId, (trace) => ({
    ...trace,
    events: [
      ...(trace.events || []),
      { phase, message, at: new Date().toISOString() },
    ],
  }));
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
    const response = await AgentManager.processMessage(researchPrompt, 'planner:research', `planner:research:${planId}`);
    const text = extractAgentText(response);

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

function resolvePlannerImageModel(raw: string | null | undefined): PlannerImageModelId {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'nano-banana') return 'nano-banana-pro';
  if (PLANNER_IMAGE_MODELS.some(item => item.id === normalized)) return normalized as PlannerImageModelId;
  return 'nano-banana-pro';
}

function getPlannerImageModelMeta(raw: string | null | undefined) {
  const resolved = resolvePlannerImageModel(raw);
  return PLANNER_IMAGE_MODELS.find(item => item.id === resolved) || PLANNER_IMAGE_MODELS[1];
}

function getNanoBananaScript(): string | null {
  const localScript = path.resolve(__dirname, '..', '..', 'src', 'skills', 'nanobanana', 'scripts', 'generate.py');
  if (fs.existsSync(localScript)) return localScript;
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
function buildPlannerImagePrompt(
  postText: string,
  planTitle: string,
  imageModel: string | null | undefined,
  preset: string | null | undefined,
  direction: string | null | undefined,
): string {
  const hook = postText.split('\n')[0].slice(0, 100);
  const styleTemplate = (SettingsManager.get('linkedin.plannerImageStyle') || SettingsManager.get('linkedin.imagePromptStyle') || '').trim();
  const presetStyleTemplate = (SettingsManager.get(PRESET_STYLE_SETTING_KEYS[preset || 'none'] || PRESET_STYLE_SETTING_KEYS.none) || '').trim();
  const presetGuide: Record<string, string> = {
    meme: 'Use a punchy social meme composition. Prioritize humor, contrast, immediacy, and one clear visual joke or misconception callout.',
    explainer_card: 'Use an explainer-card treatment with strong hierarchy, clean educational framing, and easy visual scanning.',
    annotated_screenshot: 'Use an annotated screenshot treatment with callouts, highlights, and a more real-world product or interface feel.',
    data_visual: 'Use a data-led visual with chart-like composition, evidence emphasis, and less decorative filler.',
    quote_card: 'Use a premium text-led quote-card style with typography-driven composition and minimal supporting elements.',
    comparison: 'Use a side-by-side comparison layout with strong contrast between wrong approach and correct approach.',
    none: 'Use a clean, modern social visual, not a generic technical diagram.',
  };
  const modelMeta = getPlannerImageModelMeta(imageModel);
  const directionGuide = direction ? `Per-post image direction: "${direction}".` : '';
  const presetStyleGuide = presetStyleTemplate ? `Preset style default: "${presetStyleTemplate}".` : '';
  const styleGuide = styleTemplate ? `Global image style template: "${styleTemplate}".` : '';
  return [
    `Create a LinkedIn social image for the post titled "${planTitle}".`,
    `Core message: "${hook}".`,
    presetGuide[preset || 'none'] || presetGuide.none,
    directionGuide,
    presetStyleGuide,
    styleGuide,
    `Render intent: strong single-idea composition, social-first, distinctive, suitable for a LinkedIn feed image.`,
    `Model note: use the strengths of ${modelMeta.label}.`,
    'Avoid bland stock visuals, generic blue technical diagrams, and overloaded text blocks.',
    'No people faces unless clearly necessary. Keep any text minimal and only if the preset strongly implies a text-led card.',
  ].filter(Boolean).join(' ');
}

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

  const asset = getAsset(assetId);
  const imageModel = asset?.image_model || SettingsManager.get('linkedin.plannerImageModel') || 'nano-banana-pro';
  const imageModelMeta = getPlannerImageModelMeta(imageModel);
  const stripMetadata = SettingsManager.get('linkedin.plannerExifStrip') !== 'false';
  if (imageModelMeta.id === 'none') {
    console.log(`[Planner] Skipping image generation for asset #${assetId}: model disabled`);
    return null;
  }
  const imagePrompt = buildPlannerImagePrompt(
    postText,
    planTitle,
    imageModel,
    asset?.image_preset,
    asset?.image_caption,
  );
  updatePlannerAssetTrace(assetId, (trace) => ({
    ...trace,
    prompts: {
      ...(trace.prompts || {}),
      imagePrompt,
    },
    timings: {
      ...(trace.timings || {}),
      imageStartedAt: new Date().toISOString(),
    },
    image: {
      ...((trace as PlannerAssetTrace & { image?: Record<string, unknown> }).image || {}),
      model: imageModelMeta.id,
      modelLabel: imageModelMeta.label,
      modelApiName: imageModelMeta.model,
      preset: asset?.image_preset || 'none',
      direction: asset?.image_caption || '',
      prompt: imagePrompt,
      stripEnabled: stripMetadata,
      stripStatus: 'pending',
    },
  } as PlannerAssetTrace));

  const outputDir = path.join(os.homedir(), '.pocket-agent', 'linkedin', 'planner-images');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `asset_${assetId}_${Date.now()}.png`);

  try {
    const python = findPython3();
    const { stdout, stderr } = await execFile(python, [
      script, imagePrompt,
      '-o', outputPath,
      '--model', imageModelMeta.model,
      '--ratio', '3:2',
      '--strip-metadata', stripMetadata ? 'true' : 'false',
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
      const stripStatusMatch = stderr.match(/strip_result=([a-z_]+)/i);
      const stripStatus = (stripStatusMatch?.[1] || (stripMetadata ? 'unknown' : 'disabled')).toLowerCase();
      const stripNoteMap: Record<string, string> = {
        stripped: 'Planner removed embedded image metadata before saving.',
        disabled: 'Planner kept the original generated file metadata because EXIF auto-strip is disabled.',
        unavailable: 'Planner could not strip metadata because the sanitizer dependency was unavailable.',
        fallback_raw: 'Planner failed to sanitize metadata cleanly and kept the original generated file.',
        unknown: stripMetadata ? 'Planner generated the image, but strip status was not reported.' : 'Metadata stripping was not requested.',
      };
      console.log(`[Planner] Generated image for asset #${assetId}: ${outputPath}`);
      updatePlannerAssetTrace(assetId, (trace) => ({
        ...trace,
        timings: {
          ...(trace.timings || {}),
          imageFinishedAt: new Date().toISOString(),
        },
        image: {
          ...((trace as PlannerAssetTrace & { image?: Record<string, unknown> }).image || {}),
          generatedAt: new Date().toISOString(),
          outputPath,
          stripEnabled: stripMetadata,
          stripStatus,
          stripNote: stripNoteMap[stripStatus] || stripNoteMap.unknown,
        },
      } as PlannerAssetTrace));
      return outputPath;
    }

    // generate.py prints the path to stdout on success
    const resultPath = stdout.trim();
    if (resultPath && fs.existsSync(resultPath)) {
      const stripStatusMatch = stderr.match(/strip_result=([a-z_]+)/i);
      const stripStatus = (stripStatusMatch?.[1] || (stripMetadata ? 'unknown' : 'disabled')).toLowerCase();
      const stripNoteMap: Record<string, string> = {
        stripped: 'Planner removed embedded image metadata before saving.',
        disabled: 'Planner kept the original generated file metadata because EXIF auto-strip is disabled.',
        unavailable: 'Planner could not strip metadata because the sanitizer dependency was unavailable.',
        fallback_raw: 'Planner failed to sanitize metadata cleanly and kept the original generated file.',
        unknown: stripMetadata ? 'Planner generated the image, but strip status was not reported.' : 'Metadata stripping was not requested.',
      };
      updatePlannerAssetTrace(assetId, (trace) => ({
        ...trace,
        timings: {
          ...(trace.timings || {}),
          imageFinishedAt: new Date().toISOString(),
        },
        image: {
          ...((trace as PlannerAssetTrace & { image?: Record<string, unknown> }).image || {}),
          generatedAt: new Date().toISOString(),
          outputPath: resultPath,
          stripEnabled: stripMetadata,
          stripStatus,
          stripNote: stripNoteMap[stripStatus] || stripNoteMap.unknown,
        },
      } as PlannerAssetTrace));
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
      await overlayAvatar(out);
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

/**
 * Overlay the user's avatar photo on the top-right corner of an image.
 * Avatar path is configured in settings (linkedin.plannerAvatarPath).
 * Uses Pillow via the LinkedIn venv for compositing.
 */
async function overlayAvatar(imagePath: string): Promise<void> {
  const avatarPath = SettingsManager.get('linkedin.plannerAvatarPath') || '';
  if (!avatarPath || !fs.existsSync(avatarPath)) return;

  const venvPython = path.join(os.homedir(), '.pocket-agent', 'linkedin', '.venv', 'bin', 'python');
  if (!fs.existsSync(venvPython)) return;

  const script = `
import sys
from PIL import Image, ImageDraw

img = Image.open(sys.argv[1]).convert('RGBA')
avatar = Image.open(sys.argv[2]).convert('RGBA')

# Scale avatar to ~12% of image width
size = max(80, int(img.width * 0.12))
avatar = avatar.resize((size, size), Image.LANCZOS)

# Create circular mask
mask = Image.new('L', (size, size), 0)
draw = ImageDraw.Draw(mask)
draw.ellipse((0, 0, size, size), fill=255)

# Add thin white border
border = 3
bordered = Image.new('RGBA', (size + border * 2, size + border * 2), (255, 255, 255, 220))
bmask = Image.new('L', bordered.size, 0)
bdraw = ImageDraw.Draw(bmask)
bdraw.ellipse((0, 0, bordered.size[0], bordered.size[1]), fill=255)
bordered.putalpha(bmask)
bordered.paste(avatar, (border, border), mask)

# Position: top-right with margin
margin = int(img.width * 0.03)
pos = (img.width - bordered.width - margin, margin)
img.paste(bordered, pos, bordered)

img.convert('RGB').save(sys.argv[1])
`;

  const tmpScript = path.join(os.tmpdir(), 'pocket-agent-avatar-overlay.py');
  fs.writeFileSync(tmpScript, script);

  try {
    await execFile(venvPython, [tmpScript, imagePath, avatarPath], { timeout: 15000 });
    console.log(`[Planner] Avatar overlaid on ${imagePath}`);
  } catch (err) {
    console.warn('[Planner] Avatar overlay failed:', err);
  }
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

function extractIdeaRule(rules: string | null | undefined, label: string): string {
  const match = String(rules || '')
    .split('\n')
    .find(line => line.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`));
  return match ? match.replace(new RegExp(`^${label}:\\s*`, 'i'), '').trim() : '';
}

function getOpeningLead(text: string): string {
  const firstLine = String(text || '').split('\n').find(line => line.trim()) || '';
  return firstLine
    .trim()
    .replace(/^[^A-Za-z0-9]+/, '')
    .split(/\s+/)
    .slice(0, 4)
    .join(' ')
    .toLowerCase();
}

function hasRepeatedOpeningLead(text: string, priorOpenings: string[]): boolean {
  const lead = getOpeningLead(text);
  if (!lead) return false;
  return priorOpenings.some(prev => getOpeningLead(prev) === lead);
}

const AI_SLOP_PATTERN = /\b(landscape|leverage|robust|comprehensive|holistic|streamline|optimize|paradigm|game[- ]changing|cutting-edge|transformative|unprecedented|synergy|foster|harness|delve|elevate|dramatically|significantly|meaningful|importantly|more importantly|most importantly)\b/i;
const PLANNER_REFUSAL_PATTERN = /\b(duplicate request|brief is identical|i just wrote this exact post|i wrote this exact post already|i['']?ve written this same post|i have written this same post|this appears to be a duplicate request)\b/i;

function isPlannerMetaResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (PLANNER_REFUSAL_PATTERN.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('this appears to be a duplicate request')) return true;
  if (lower.startsWith('i just wrote this exact post for you')) return true;
  if (lower.startsWith('i wrote this exact post already')) return true;
  if (lower.includes('the brief is identical')) return true;
  return false;
}

export const DEFAULT_HARD_RULES = `- No emojis, no hashtags, no em dashes, no en dashes. Hyphens only.
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

const DEFAULT_POST_FORMAT = 'Write a LinkedIn post (100-240 words). Strong hook in first line, clear structure, practical takeaway.';
const DEFAULT_ARTICLE_FORMAT = 'Write a long-form LinkedIn article (800-1500 words) with clear sections and headers.';
const DEFAULT_GROUP_FORMAT = 'Write a group discussion post (100-250 words). Frame as a question or discussion starter, not self-promotion.';
export const DEFAULT_POST_STRUCTURE = 'Use a highly scannable LinkedIn structure. Build the post in short readable chunks. Open with a concrete claim or scenario, not a long setup. If the post covers multiple points, feel free to number them. Keep each paragraph focused on one move at a time. If you use examples, make them easy to scan instead of burying them in a dense block.';
export const DEFAULT_STRUCTURE_GUIDANCE = 'Format for LinkedIn mobile reading. Avoid walls of text. Most paragraphs should be one sentence or two short sentences max. Use white space aggressively. Break dense explanations into smaller blocks. If examples, lessons, or takeaways are easier to scan as bullets or numbered sections, format them that way. Preserve the substance, but make the reading rhythm lighter, sharper, and easier to scan in-feed.';
export function getPlannerLengthGuidance(targetChars: number): string {
  return `Keep the post under ${targetChars} characters total, including line breaks. Aim to land comfortably below that limit, ideally by roughly 50-150 characters, so it remains safe for LinkedIn auto-publish without feeling cut down.`;
}

function getPlannerTargetPostChars(): number {
  const raw = Number(SettingsManager.get('linkedin.plannerMaxPostChars') || '2200');
  if (!Number.isFinite(raw)) return 2200;
  return Math.min(2800, Math.max(800, Math.floor(raw)));
}

export type PlannerDraftPhase = 'queued' | 'writing' | 'drafted' | 'image_generating' | 'image_done' | 'done' | 'error';

export interface PlannerDraftProgressEvent {
  planId: number;
  assetId: number;
  index: number;
  total: number;
  phase: PlannerDraftPhase;
  message: string;
}

function extractAgentText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const maybe = result as { response?: unknown; content?: unknown };
    if (typeof maybe.response === 'string') return maybe.response;
    if (typeof maybe.content === 'string') return maybe.content;
  }
  return String(result || '');
}

export async function generatePlanAssets(
  planId: number,
  onProgress?: (event: PlannerDraftProgressEvent) => void,
  assetIds?: number[],
): Promise<PlanAsset[]> {
  const planData = getPlanWithAssets(planId);
  if (!planData) throw new Error(`Plan ${planId} not found`);

  updatePlan(planId, { status: 'generating' });

  const assetFilter = Array.isArray(assetIds) && assetIds.length
    ? new Set(assetIds.map(id => Number(id)).filter(id => Number.isFinite(id)))
    : null;
  const pendingAssets = planData.assets.filter(a => {
    if (assetFilter && !assetFilter.has(a.id)) return false;
    return a.status === 'pending';
  });
  if (pendingAssets.length === 0) {
    const hasAnyPending = planData.assets.some(a => a.status === 'pending');
    updatePlan(planId, { status: hasAnyPending ? 'generating' : 'ready' });
    return [];
  }

  // All configurable via settings - current values are defaults
  const voiceStyle = SettingsManager.get('linkedin.voiceStyle') || '';
  const writingRules = SettingsManager.get('linkedin.writingRules') || '';
  const contentDirection = SettingsManager.get('linkedin.contentDirection') || '';
  const postStrategy = SettingsManager.get('linkedin.postStrategy') || '';
  const postStructure = (SettingsManager.get('linkedin.plannerPostStructure') || DEFAULT_POST_STRUCTURE).trim();
  const structureGuidance = (SettingsManager.get('linkedin.plannerStructureGuidance') || DEFAULT_STRUCTURE_GUIDANCE).trim();
  const customRules = SettingsManager.get('linkedin.plannerHardRules') || '';
  const hardRules = customRules
    ? `${DEFAULT_HARD_RULES}\n${customRules}`
    : DEFAULT_HARD_RULES;
  const prePublishChecklist = SettingsManager.get('linkedin.plannerPrePublishChecklist') || '';
  const postFormat = SettingsManager.get('linkedin.plannerPostFormat') || DEFAULT_POST_FORMAT;
  const articleFormat = SettingsManager.get('linkedin.plannerArticleFormat') || DEFAULT_ARTICLE_FORMAT;
  const groupFormat = SettingsManager.get('linkedin.plannerGroupFormat') || DEFAULT_GROUP_FORMAT;
  const bankEntryCount = parseInt(SettingsManager.get('linkedin.plannerBankEntries') || '3', 10);
  const [briefsBlock, sharedContextRaw] = planData.prompt.includes('## SHARED_CONTEXT')
    ? planData.prompt.split('\n\n## SHARED_CONTEXT\n', 2)
    : [planData.prompt, ''];
  const perAssetBriefs = briefsBlock.includes('<<<POST_BRIEF_SEPARATOR>>>')
    ? briefsBlock.split('\n\n<<<POST_BRIEF_SEPARATOR>>>\n\n').map(s => s.trim()).filter(Boolean)
    : [];
  const sharedContext = sharedContextRaw.trim();

  // Load Post Bank entries for voice anchoring
  const postBankEntries = loadPostBankEntries();
  const postBankBlock = buildPostBankBlock(postBankEntries, bankEntryCount);

  const results: PlanAsset[] = [];
  const usedOpenings: string[] = [];
  const emitProgress = (event: PlannerDraftProgressEvent) => {
    try {
      onProgress?.(event);
    } catch (err) {
      console.warn('[Planner] Progress callback failed:', err);
    }
  };

  pendingAssets.forEach((asset, idx) => {
    appendPlannerAssetTraceEvent(asset.id, 'queued', `Queued ${idx + 1}/${pendingAssets.length}`);
    emitProgress({
      planId,
      assetId: asset.id,
      index: idx + 1,
      total: pendingAssets.length,
      phase: 'queued',
      message: `Queued ${idx + 1}/${pendingAssets.length}`,
    });
  });

  for (let idx = 0; idx < pendingAssets.length; idx++) {
    const asset = pendingAssets[idx];
    const target = getTarget(asset.target_id);
    if (!target) continue;
    const lens = extractIdeaRule(asset.per_idea_rules, 'Series role');
    const openingStyle = extractIdeaRule(asset.per_idea_rules, 'Opening style');
    const exampleAnchor = extractIdeaRule(asset.per_idea_rules, 'Example anchor');
    const takeawayStyle = extractIdeaRule(asset.per_idea_rules, 'Takeaway style');

    emitProgress({
      planId,
      assetId: asset.id,
      index: idx + 1,
      total: pendingAssets.length,
      phase: 'writing',
      message: `Writing post ${idx + 1}/${pendingAssets.length}`,
    });

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
    const targetPostChars = getPlannerTargetPostChars();

    const priorOpeningLeads = Array.from(new Set(usedOpenings.map(getOpeningLead).filter(Boolean)));
    const avoidOpeningsBlock = usedOpenings.length
      ? `\nAvoid these opening patterns already used in this plan: ${usedOpenings.join(' | ')}\nDo not reuse these first-line leads: ${priorOpeningLeads.join(' | ')}`
      : '';
    const openingStyleBlock = openingStyle
      ? `\nFIRST-LINE OPENING STYLE:\n${openingStyle}\nMake the first line clearly feel like this opening style. Do not default back to a generic explanatory "Google ..." opener.`
      : '\nFIRST-LINE OPENING STYLE:\nUse a fresh opener. Do not default to a generic explanatory "Google ..." opener.';
    const distinctnessBlock = [
      lens ? `Lens: ${lens}` : '',
      exampleAnchor ? `Example anchor: ${exampleAnchor}` : '',
      takeawayStyle ? `Takeaway style: ${takeawayStyle}` : '',
    ].filter(Boolean).join('\n');

    const assetBrief = perAssetBriefs[idx] || planData.prompt;
    const sharedContextBlock = sharedContext ? `\n\nShared batch context:\n${sharedContext}` : '';
    const draftPrompt = `You are writing an original LinkedIn post. Write ONLY the post text - no commentary, no labels, no "Here's your post:" preamble.

Plan prompt: ${assetBrief}${sharedContextBlock}
${planData.topic ? `Topic: ${planData.topic}` : ''}

Target: ${target.label} (${target.target_type})
${targetContext}

${formatGuidance}
${getPlannerLengthGuidance(targetPostChars)}

${voiceStyle ? `Voice/Style: ${voiceStyle}` : ''}
${writingRules ? `Writing rules: ${writingRules}` : ''}
${postStructure ? `Post structure: ${postStructure}` : ''}
${structureGuidance ? `Structure guidance: ${structureGuidance}` : ''}
${distinctnessBlock ? `${distinctnessBlock}` : ''}
${openingStyleBlock}
${contentDirection ? `Content direction: ${contentDirection}` : ''}
${postStrategy ? `Strategy: ${postStrategy}` : ''}
${postBankBlock}
HARD RULES:
${hardRules}
- Each post in this plan must have a unique hook and framing - do NOT repeat patterns.${avoidOpeningsBlock}
- Never ask the user for clarification, links, content, or confirmation. If a detail is missing, make the best reasonable assumption and write the post anyway.
${prePublishChecklist ? `\nPRE-PUBLISH CHECKLIST (verify ALL before finishing):\n${prePublishChecklist}` : ''}
OUTPUT:
Return only the final post text.`;

    updatePlannerAssetTrace(asset.id, (trace) => ({
      ...trace,
      createdAt: trace.createdAt || new Date().toISOString(),
      postMeta: {
        targetLabel: target.label,
        targetType: target.target_type,
        planTitle: planData.title,
        ideaTitle: asset.idea_angle || undefined,
        ideaHook: asset.idea_hook || undefined,
        ideaIndex: Number.isFinite(Number(asset.idea_sort_order)) ? Number(asset.idea_sort_order) + 1 : undefined,
        continuityMode: sharedContext ? 'standalone but connected' : 'independent',
        batchShape: pendingAssets.length > 1 ? `${pendingAssets.length}-post batch` : 'single post',
      },
      prompts: {
        ...(trace.prompts || {}),
        assetBrief,
        sharedContext,
        draftPrompt,
      },
      queries: Array.from(new Set([
        String(target.label || '').trim(),
        String(planData.topic || '').trim(),
        String(asset.idea_angle || '').trim(),
        String(asset.idea_hook || '').trim(),
      ].filter(Boolean))),
      sourceUrls: safeParseJson<string[]>(asset.source_urls_json, []),
      timings: {
        ...(trace.timings || {}),
        startedAt: trace.timings?.startedAt || new Date().toISOString(),
      },
    }));

    try {
      appendPlannerAssetTraceEvent(asset.id, 'writing', `Writing post ${idx + 1}/${pendingAssets.length}`);
      const response = await AgentManager.processMessage(draftPrompt, 'planner:draft', `planner:draft:${planId}`);
      let draftText = extractAgentText(response);

      // Clean draft (strip emojis, dashes, preamble, AI slop)
      draftText = cleanPlannerDraft(draftText);

      if (!draftText || draftText.length < 50) {
        console.warn(`[Planner] Draft too short for asset ${asset.id}, retrying once with stricter length guidance`);
        appendPlannerAssetTraceEvent(asset.id, 'retry', 'Draft too short, retrying with stricter length guidance');
        const retryResponse = await AgentManager.processMessage(
          `${draftPrompt}\n\nThe previous draft was too short. Rewrite as a complete LinkedIn post between 120 and 220 words while still staying under the character limit above. Return only the finished post text.`,
          'planner:draft',
          `planner:draft:${planId}`
        );
        const retryText = cleanPlannerDraft(extractAgentText(retryResponse));
        if (retryText && retryText.length >= 50) {
          draftText = retryText;
        } else {
          updateAsset(asset.id, {
            status: 'failed',
            last_error: 'Draft too short',
            error_step: 'writing',
          });
          appendPlannerAssetTraceEvent(asset.id, 'error', `Draft ${idx + 1}/${pendingAssets.length} was too short`);
          emitProgress({
            planId,
            assetId: asset.id,
            index: idx + 1,
            total: pendingAssets.length,
            phase: 'error',
            message: `Draft ${idx + 1}/${pendingAssets.length} was too short`,
          });
          continue;
        }
      }

      // Quality gate: reject meta/refusal responses and retry once with stronger uniqueness guidance
      if (isPlannerMetaResponse(draftText)) {
        console.warn(`[Planner] Meta/refusal draft detected for asset ${asset.id}, retrying with stronger uniqueness guidance`);
        appendPlannerAssetTraceEvent(asset.id, 'retry', 'Model returned meta/refusal text, retrying with stronger uniqueness guidance');
        const retryResponse = await AgentManager.processMessage(
          `${draftPrompt}\n\nThe previous response was not a draft. It was meta commentary about duplication. Do NOT comment on whether the brief is similar to other posts. Write the post anyway. Stay on the same branch, but make this card distinct through its assigned lens, opening style, example anchor, and takeaway style. Return only the finished post text.`,
          'planner:draft',
          `planner:draft:${planId}`
        );
        const retryText = cleanPlannerDraft(extractAgentText(retryResponse));
        if (retryText && retryText.length >= 50 && !isPlannerMetaResponse(retryText)) {
          draftText = retryText;
        } else {
          updateAsset(asset.id, {
            status: 'failed',
            last_error: 'Model returned a duplicate-refusal response instead of a post',
            error_step: 'writing',
          });
          appendPlannerAssetTraceEvent(asset.id, 'error', `Draft ${idx + 1}/${pendingAssets.length} returned meta/refusal text`);
          emitProgress({
            planId,
            assetId: asset.id,
            index: idx + 1,
            total: pendingAssets.length,
            phase: 'error',
            message: `Draft ${idx + 1}/${pendingAssets.length} returned meta/refusal text`,
          });
          continue;
        }
      }

      // Quality gate: check for AI slop and retry once
      if (AI_SLOP_PATTERN.test(draftText)) {
        console.warn(`[Planner] AI slop detected in asset ${asset.id}, retrying`);
        const retryResponse = await AgentManager.processMessage(
          draftPrompt + '\n\nThe previous draft contained AI-sounding jargon. Rewrite with natural, direct language. No corporate buzzwords.',
          'planner:draft',
          `planner:draft:${planId}`
        );
        const retryText = cleanPlannerDraft(extractAgentText(retryResponse));
        if (retryText && retryText.length >= 50) draftText = retryText;
      }

      if (hasRepeatedOpeningLead(draftText, usedOpenings)) {
        console.warn(`[Planner] Repeated opening lead detected for asset ${asset.id}, retrying with stronger first-line guidance`);
        appendPlannerAssetTraceEvent(asset.id, 'retry', 'Opening lead repeated an earlier post, retrying with stronger first-line guidance');
        const retryResponse = await AgentManager.processMessage(
          `${draftPrompt}\n\nThe previous draft reused the same first-line lead as another post in this batch. Rewrite it with a genuinely different opener. Do not start with the same first 3-4 words as earlier posts. Do not start with a generic explanatory "Google ..." lead. Return only the final post text.`,
          'planner:draft',
          `planner:draft:${planId}`
        );
        const retryText = cleanPlannerDraft(extractAgentText(retryResponse));
        if (retryText && retryText.length >= 50 && !hasRepeatedOpeningLead(retryText, usedOpenings)) {
          draftText = retryText;
        }
      }

      // Track opening for diversity
      const firstLine = draftText.split('\n')[0]?.slice(0, 60) || '';
      usedOpenings.push(firstLine);

      // Check for duplicates within this plan
      const fp = normalizeFingerprint(draftText);
      if (isDuplicateAsset(draftText, planId)) {
        console.warn(`[Planner] Duplicate draft detected for asset ${asset.id}, skipping`);
        updateAsset(asset.id, {
          status: 'failed',
          last_error: 'Draft matched an existing idea in this plan',
          error_step: 'writing',
        });
        appendPlannerAssetTraceEvent(asset.id, 'error', `Draft ${idx + 1}/${pendingAssets.length} matched an existing idea`);
        emitProgress({
          planId,
          assetId: asset.id,
          index: idx + 1,
          total: pendingAssets.length,
          phase: 'error',
          message: `Draft ${idx + 1}/${pendingAssets.length} matched an existing idea`,
        });
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

      let updated = updateAsset(asset.id, {
        draft_text: draftText,
        fingerprint: fp,
        kanban_task_id: kanbanTaskId,
        status: 'drafted',
        last_error: null,
        error_step: null,
      });

      appendPlannerAssetTraceEvent(asset.id, 'drafted', `Drafted post ${idx + 1}/${pendingAssets.length}`);

      emitProgress({
        planId,
        assetId: asset.id,
        index: idx + 1,
        total: pendingAssets.length,
        phase: 'drafted',
        message: `Drafted post ${idx + 1}/${pendingAssets.length}`,
      });

      // Generate post image after the draft is already persisted and visible.
      let imagePath: string | null = null;
      if (SettingsManager.get('linkedin.plannerAutoImage') !== 'false') {
        appendPlannerAssetTraceEvent(asset.id, 'image_generating', `Generating image ${idx + 1}/${pendingAssets.length}`);
        updatePlannerAssetTrace(asset.id, (trace) => ({
          ...trace,
          prompts: {
            ...(trace.prompts || {}),
            imagePrompt: buildPlannerImagePrompt(draftText, planData.title, asset.image_model, asset.image_preset, asset.image_caption),
          },
        }));
        emitProgress({
          planId,
          assetId: asset.id,
          index: idx + 1,
          total: pendingAssets.length,
          phase: 'image_generating',
          message: `Generating image ${idx + 1}/${pendingAssets.length}`,
        });
        try {
          imagePath = await generatePostImage(draftText, planData.title, asset.id);
          if (imagePath) {
            updated = updateAsset(asset.id, { image_path: imagePath });
            appendPlannerAssetTraceEvent(asset.id, 'image_done', `Image ready for post ${idx + 1}/${pendingAssets.length}`);
            emitProgress({
              planId,
              assetId: asset.id,
              index: idx + 1,
              total: pendingAssets.length,
              phase: 'image_done',
              message: `Image ready for post ${idx + 1}/${pendingAssets.length}`,
            });
          }
        } catch {
          /* image generation is optional */
        }
      }

      if (updated) {
        updatePlannerAssetTrace(asset.id, (trace) => ({
          ...trace,
          timings: {
            ...(trace.timings || {}),
            finishedAt: new Date().toISOString(),
          },
        }));
        appendPlannerAssetTraceEvent(asset.id, 'done', `Completed post ${idx + 1}/${pendingAssets.length}`);
        results.push(updated);
        emitProgress({
          planId,
          assetId: asset.id,
          index: idx + 1,
          total: pendingAssets.length,
          phase: 'done',
          message: `Completed post ${idx + 1}/${pendingAssets.length}`,
        });
      }
    } catch (err) {
      console.error(`[Planner] Failed to generate draft for asset ${asset.id}:`, err);
      updateAsset(asset.id, {
        status: 'failed',
        last_error: err instanceof Error ? err.message : String(err),
        error_step: 'writing',
      });
      appendPlannerAssetTraceEvent(asset.id, 'error', err instanceof Error ? err.message : String(err));
      emitProgress({
        planId,
        assetId: asset.id,
        index: idx + 1,
        total: pendingAssets.length,
        phase: 'error',
        message: `Failed post ${idx + 1}/${pendingAssets.length}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Update plan status
  const allAssets = getPlanWithAssets(planId)?.assets || [];
  const allDone = allAssets.every(a => a.status !== 'pending');
  updatePlan(planId, { status: allDone ? 'ready' : 'generating' });

  return results;
}

export async function retryPlanAsset(
  assetId: number,
  onProgress?: (event: PlannerDraftProgressEvent) => void,
): Promise<PlanAsset | null> {
  const asset = getAsset(assetId);
  if (!asset) throw new Error(`Asset ${assetId} not found`);

  updateAsset(assetId, {
    status: 'pending',
    publish_error: null,
    retry_count: (asset.retry_count || 0) + 1,
  });
  appendPlannerAssetTraceEvent(assetId, 'retry', 'Manual retry requested');

  const generated = await generatePlanAssets(asset.plan_id, onProgress, [assetId]);
  return generated.find(item => item.id === assetId) || getAsset(assetId);
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
    // Write text to temp file to avoid CLI arg length limits
    const tmpDir = path.join(os.tmpdir(), 'pocket-agent-planner');
    fs.mkdirSync(tmpDir, { recursive: true });
    const textFile = path.join(tmpDir, `publish_${id}_${Date.now()}.txt`);
    fs.writeFileSync(textFile, text, 'utf-8');

    const postArgs = ['--text-file', textFile, '--no-confirm'];
    if (asset.image_path) postArgs.push('--image', asset.image_path);
    await linkedinExec('post', postArgs, 120000);

    // Cleanup temp file
    try { fs.unlinkSync(textFile); } catch { /* ok */ }

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

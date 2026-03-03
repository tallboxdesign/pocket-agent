# LinkedIn Post Campaign Plan

## Goal
Build an original-post workflow that:
- Uses feed engagement signals as input
- Generates stronger original narratives
- Generates supporting images
- Publishes to explicit user-defined LinkedIn targets
- Runs on a controlled cadence (for example 2-3 posts/day)

## User-Defined Inputs (Settings)
- `linkedin.postTargets`: one URL per line (profile/company/group destinations)
- `linkedin.postsPerDay`: daily target count
- `linkedin.postStrategy`: narrative strategy and angle rules
- `linkedin.imagePromptStyle`: image guidance for generation prompts
- Existing voice/style settings still apply:
  - `linkedin.voiceStyle`
  - `linkedin.writingRules`
  - `linkedin.contentDirection`

## Pipeline Stages
1. Signal Collection
- Scrape feed and rank by engagement velocity, comment depth, and topical relevance.
- Keep a rolling shortlist of high-signal posts.

2. Topic Extraction
- Extract repeated themes and tensions from top-signal posts.
- Produce candidate post angles with novelty score.

3. Narrative Drafting
- Draft original posts that are "better than source":
  - clearer claim
  - stronger structure
  - practical takeaway
  - concrete stance
- Apply `voiceStyle`, `writingRules`, `contentDirection`, and `postStrategy`.

4. Image Brief + Generation
- Build image prompt using post claim + `imagePromptStyle`.
- Generate variations, pick best candidate by relevance/readability.
- Store image metadata and source prompt for traceability.

5. Targeted Publishing
- Select destination from `postTargets` using round-robin with cooldown.
- Enforce cadence and spacing using `postsPerDay`.
- Publish and log result.

6. Safety + Anti-Duplicate
- Block near-duplicate text within recent window.
- Block image reuse by perceptual hash threshold.
- Enforce per-target cooldown and daily cap.

## Data Model Additions (Proposed)
- `linkedin_post_campaigns`
  - `id`, `topic_seed`, `source_post_ids`, `status`, `target_url`, `scheduled_at`, `posted_at`
- `linkedin_generated_posts`
  - `campaign_id`, `draft_text`, `final_text`, `quality_score`, `fingerprint`
- `linkedin_generated_images`
  - `campaign_id`, `image_path`, `prompt`, `provider`, `phash`, `approved`

## UI Additions (Proposed)
- New "Post Campaign" panel in LinkedIn Activity:
  - Signals shortlist
  - Candidate post drafts
  - Image preview + regenerate
  - Approve/schedule/publish actions
- Show destination target explicitly on every queued post item.

## Rollout Steps
1. Add settings (done)
2. Add DB tables + service layer
3. Add topic extraction + drafting worker
4. Add image generation adapter
5. Add posting scheduler and UI controls
6. Add Telegram command parity for campaign control

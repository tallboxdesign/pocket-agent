# LinkedIn Content Planner v2 — Idea Lab Architecture

## What Changed (v1 → v2)

The rigid "New Plan" form (Title + Prompt + URLs + Targets) is replaced by a freeform **Idea Lab** — a creative workspace where you dump ideas, discuss with AI, review generated post concepts, and batch-approve them for drafting.

---

## The 3-Phase Flow

```
Phase 1: DUMP & DISCUSS          Phase 2: IDEAS BOARD          Phase 3: DRAFT & PUBLISH
┌──────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────────┐
│ Freeform textarea    │    │ Idea cards generated     │    │ Approved ideas drafted   │
│ + chat thread        │───>│ by AI from discussion    │───>│ 1-by-1 with all rules    │
│ + research toggles   │    │ User edits/deletes/adds  │    │ Images generated         │
│ + paste images/URLs  │    │ Batch + per-idea rules   │    │ Avatar overlaid          │
│                      │    │ Approve selected         │    │ Schedule/publish         │
└──────────────────────┘    └──────────────────────────┘    └──────────────────────────┘
```

---

## Phase 1: Dump & Discuss

### UI Layout

```
┌─ Idea Lab ──────────────────────────────────────────────────────────────┐
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ This week let's do 3 posts about Google patents on page quality.  │  │
│  │ Find the most interesting ones from 2025-2026. Also I saw this    │  │
│  │ article [paste URL] - could be a good angle. Make them practical  │  │
│  │ with examples of what to actually do.                              │  │
│  │                                                                    │  │
│  │ [Drop images/screenshots here or paste]                           │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  RESEARCH SOURCES                                                        │
│  [x] Web Search    [x] Google Patents    [ ] LinkedIn*    [ ] My Feed*  │
│  * LinkedIn search requires browser session                              │
│                                                                          │
│  [Go — Research & Ideate]                                                │
│                                                                          │
│  ── Discussion ──────────────────────────────────────────────────────── │
│                                                                          │
│  AI: Found 5 relevant patents. Here are the 3 most interesting:         │
│      1. "Distance-based page ranking" (US-20250XXXX) - measures how...  │
│      2. "Query-dependent content freshness" - defines freshness...      │
│      3. "Entity salience in ranking" - weights entities by...           │
│                                                                          │
│  YOU: The first one is great. For the second one, can you find real     │
│       examples of freshness affecting rankings? And skip the third,     │
│       let's do something about Core Web Vitals instead.                  │
│                                                                          │
│  AI: Good call. For freshness I found these examples: [...]             │
│      For CWV, here are 3 angles: [...]                                  │
│                                                                          │
│  YOU: Perfect. Generate the ideas.                                       │
│                                                                          │
│  [Generate Ideas from Discussion]                                        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Features

**Freeform Input**
- Single textarea — no title, no structured fields
- Paste URLs inline (auto-detected and researched)
- Drag/paste images and screenshots (stored, passed to AI as context)
- Mix multiple ideas in one dump: "do 3 on patents AND 2 on CWV case studies"

**Research Source Toggles**
- `Web Search` — uses existing web research pipeline
- `Google Patents` — targeted patent search
- `LinkedIn` — **checkbox with warning** — searches LinkedIn via browser automation (uses login session, headless). Finds trending posts, competitor content, topic discussions
- `My Feed` — scrapes user's own feed for inspiration/signals
- LinkedIn toggles require active browser session (shows status indicator)

**Discussion Thread**
- Mini chat scoped to this planning session
- AI researches based on toggles, proposes angles, finds sources
- User refines: "skip that one", "find examples for this", "make it more provocative"
- Supports multiple rounds of back-and-forth before generating ideas
- Discussion context is preserved and fed into drafting for continuity

**Image/Screenshot Handling**
- Paste or drag images into the textarea
- Images stored in `~/.pocket-agent/linkedin/screenshots/`
- AI can: describe them, suggest annotations, use as post visual basis
- "Annotate this screenshot and make a post about it" workflow

---

## Image Presets System

Each idea card has an `image_preset` field. The AI suggests the best preset based on the post angle, but the user can override. Presets control both how the image is generated AND how text is treated.

### Preset Definitions

**Meme**
- Purpose: Hot takes, absurd truths, ironic observations
- Generation: Nano Banana creates a funny/ironic scene. Comic book style, exaggerated characters, bold colors, hand-drawn feel. The image IS the joke.
- Prompt template: `"Comic book illustration: [AI-generated scene description based on post irony]. Exaggerated cartoon characters, bold colors, vintage aesthetic mixed with modern web/tech elements. Humorous. NO text in the image."`
- Text overlay (Pillow): 1 short line MAX. Ironic/punchy. Impact-style font, white with black outline, bottom of image. The caption is the punchline, not the explanation.
- Example: Post about everyone claiming AI expertise → Image: cartoon character copy-pasting ChatGPT output into a LinkedIn post while wearing a "Thought Leader" crown. Caption: "Original thinking."

**Explainer Card**
- Purpose: Patent breakdowns, frameworks, step-by-step, comparisons
- Generation: HTML/CSS rendered via `screenshotAnnotate()`. Structured layout with sections, icons, bold headers, accent colors.
- Text overlay: None — the content IS the rendered HTML. Key points, steps, data laid out visually.
- Template: Clean dark card with numbered sections, brand colors, avatar in corner.

**Annotated Screenshot**
- Purpose: Proving a point with real evidence, "look at this"
- Generation: `screenshotAnnotate()` captures a real URL, adds CSS overlay annotations (arrows, highlights, numbered callouts).
- Text overlay: Callout labels only — pointing to specific elements on the page.
- Use case: Patent claim text highlighted, Google SERP feature called out, tool output annotated.

**Data Visual**
- Purpose: Data-backed claims, benchmarks, before/after results
- Generation: HTML chart/table rendered as image. Bar charts, comparison tables, metric cards.
- Text overlay: Numbers and labels are part of the HTML render.

**Quote Card**
- Purpose: Strong opinions, provocative statements
- Generation: Minimal background (gradient or solid), large text, avatar badge in corner.
- Text overlay: The quote IS the image — 1-2 sentences max, large bold font. Author name small below.

**Comparison**
- Purpose: X vs Y, expectation vs reality, old way vs new way
- Generation: Side-by-side HTML layout OR Nano Banana split scene.
- Text overlay: Column headers ("Before" / "After") and minimal labels.

**None**
- Text-only post, no image generated.

### How Presets Flow Through the System

1. **Idea generation** (Phase 2): AI suggests `image_preset` + `image_concept` per idea card
2. **User override**: User can change preset on any card via dropdown
3. **Drafting** (Phase 3): After text is drafted, image pipeline runs based on preset:
   - `meme` → Nano Banana generate + Pillow text overlay + avatar overlay
   - `explainer_card` → Build HTML from post key points + render screenshot + avatar overlay
   - `annotated_screenshot` → Capture URL + add annotations + avatar overlay
   - `data_visual` → Build HTML chart/table + render screenshot + avatar overlay
   - `quote_card` → Build HTML quote layout + render screenshot + avatar overlay
   - `comparison` → Build HTML or Nano Banana + avatar overlay
   - `none` → skip image
4. **All presets**: Avatar overlay applied last, EXIF stripped

### Meme Text Overlay (Pillow)

The meme overlay is the only preset that adds text AFTER image generation. All others bake text into HTML rendering.

```python
# Meme overlay: Impact font, white text, black outline, bottom of image
from PIL import Image, ImageDraw, ImageFont

def add_meme_text(image_path, caption, position='bottom'):
    img = Image.open(image_path)
    draw = ImageDraw.Draw(img)
    # Impact or bold sans-serif, scaled to image width
    font_size = int(img.width * 0.06)
    font = ImageFont.truetype('/System/Library/Fonts/Impact.ttf', font_size)
    # Black outline + white fill
    # Centered at bottom with padding
    ...
```

### Preset Storage

Presets are defined in code (not user-configurable initially). The `image_preset` field on idea cards and assets is a string enum. Future: user can create custom presets in Settings.

---

## Phase 2: Ideas Board

### UI Layout

```
┌─ Ideas from Discussion ─────────────────────────────────────────────────┐
│                                                                          │
│  BATCH RULES (apply to all ideas below)                                  │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Every post must include one good and one bad example with text.   │  │
│  │ Keep all posts under 250 words. Always include the patent URL.    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  TARGET: [v] Georgi Georgiev Profile                                     │
│                                                                          │
│  ┌─ Idea 1 ──────────────────────────────────────── [x] ─ [Delete] ──┐ │
│  │ ANGLE: Distance-based page ranking patent breakdown                │ │
│  │ HOOK: Google filed a patent that makes PageRank look primitive     │ │
│  │ KEY POINTS: Physical/topical distance, link neighborhoods,         │ │
│  │   practical implications for internal linking                      │ │
│  │ SOURCES: US-20250XXXX, [patent URL]                                │ │
│  │ IMAGE: [v Explainer Card] Annotated patent diagram showing...     │ │
│  │                                                                    │ │
│  │ v Per-idea rules:                                                  │ │
│  │ ┌────────────────────────────────────────────────────────────────┐ │ │
│  │ │ Include the actual patent formula as a screenshot              │ │ │
│  │ └────────────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ Idea 2 ──────────────────────────────────────── [x] ─ [Delete] ──┐ │
│  │ ANGLE: Content freshness — what Google actually measures            │ │
│  │ HOOK: "Fresh content" doesn't mean what you think it means         │ │
│  │ KEY POINTS: Query-dependent freshness, byline dates vs signals,    │ │
│  │   real examples of freshness-sensitive vs evergreen queries         │ │
│  │ SOURCES: Patent + 3 SERP examples                                  │ │
│  │ IMAGE: [v Meme] Caption: "Fresh content." Scene: marketer...       │ │
│  │                                                                    │ │
│  │ v Per-idea rules: (empty)                                          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ Idea 3 ──────────────────────────────────────── [x] ─ [Delete] ──┐ │
│  │ ANGLE: CWV reality check — what actually moves the needle          │ │
│  │ ...                                                                │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  [+ Add idea manually]                                                   │
│                                                                          │
│  [Draft Selected (2)]    [Back to Discussion]                            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Features

**Idea Cards**
- Auto-generated from the discussion by AI
- Each card: angle, hook, key points, source URLs, image concept
- Editable — click any field to modify
- Checkbox to select/deselect for drafting
- Delete button to remove unwanted ideas
- Reorderable (drag)

**3-Level Rules System**

| Level | Scope | Where |
|-------|-------|-------|
| Global | Every post ever | Settings → Hard Rules + Pre-Publish Checklist |
| Batch | All ideas in this session | Batch Rules field above the ideas |
| Per-idea | Single specific idea | Expandable field on each idea card |

All three levels feed into the draft prompt: `global rules + batch rules + per-idea rules`

**Target Selection**
- Pick which target(s) these ideas go to
- Can vary per idea if needed (dropdown on each card)
- Default: user's primary profile target

**Manual Ideas**
- "+ Add idea manually" creates a blank card
- User fills in angle/hook/points directly
- Can paste text, URLs, images into the card

---

## Phase 3: Draft & Publish

When user clicks "Draft Selected":

1. Each selected idea becomes a `linkedin_plan_asset` with status `pending`
2. AI drafts them one-by-one, applying:
   - Discussion context (from Phase 1 chat)
   - Global rules (Hard Rules + Pre-Publish Checklist from settings)
   - Batch rules
   - Per-idea rules
   - Voice + Post Bank anchoring
   - Target audience/tone config
3. Images generated per the image concept on each idea
4. Avatar overlaid on every image
5. EXIF stripped
6. Drafts appear in the main asset list for review

From there, the asset detail view shows action buttons mirroring the comment poster:

### Per-Asset Action Buttons

```
┌─ Asset Detail (expanded) ────────────────────────────────────────────┐
│                                                                       │
│  Distance-based page ranking patent breakdown                         │
│  Status: drafted    Quality: 78/100                                   │
│                                                                       │
│  [full draft text here...]                                            │
│                                                                       │
│  ERROR (if any):                                                      │
│  ┌─ red border box ───────────────────────────────────────────────┐  │
│  │ Draft failed: API rate limit exceeded (429). Provider: openai  │  │
│  │ Timestamp: 2026-03-06 21:45:12                                 │  │
│  │ Step: research phase, query 2 of 3                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  [Rewrite]  [Re-draft]  [Re-research & Draft]  [Approve]  [Reject]  │
│                                                                       │
│  Feedback: [textarea for user notes]                                  │
│  [AI Improve]  [AI Re-do]                                             │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

**Action buttons (same behavior pattern as LinkedIn Activity comment poster):**

| Button | What it does |
|--------|-------------|
| **Rewrite** | Keeps same research/evidence, regenerates draft text only. Quick — just re-runs the writing step with same inputs. Use when the angle is right but the writing is off. |
| **Re-draft** | Regenerates from the idea card (angle, hook, key points) but does NOT re-research. Medium — re-runs writing with fresh approach while keeping existing sources. |
| **Re-research & Draft** | Full redo — goes back to research phase, finds new sources, then drafts. Slow — use when the whole angle needs fresh data or the sources were bad. |
| **Approve** | Marks as approved, moves to scheduling queue. |
| **Reject** | Marks as rejected, removed from active queue. |
| **AI Improve** | Takes user feedback from textarea, improves current draft (keeps structure, fixes issues). |
| **AI Re-do** | Takes user feedback, writes completely new draft considering the feedback. |

**Error display:**
- Errors shown inline on the asset in a red-bordered box
- Shows: error message, which step failed (research/draft/publish), which provider, timestamp
- Error stored in `publish_error` column (renamed to `last_error` to cover all failure types)
- Failed assets get status `error` — visible in status filter
- Retry buttons (Rewrite/Re-draft/Re-research) clear the error and retry from the appropriate step
- If publish fails: error shows the Chromium/network error, user can retry publish directly

---

## LinkedIn Research (New Capability)

### Why

Finding what's trending, what competitors are posting, what angles are working — this is the research that makes posts relevant rather than generic.

### Implementation

Two new research modes accessible via toggles in the Idea Lab:

**LinkedIn Search** (`[ ] LinkedIn`)
- Uses existing `feed.py` script via `linkedinExec('feed', ['--search', query])`
- Searches LinkedIn for posts matching keywords from the user's dump
- Returns: post text snippets, author, engagement counts, URLs
- Headless mode (no visible browser)
- Requires active LinkedIn session (shows auth status indicator)

**My Feed** (`[ ] My Feed`)
- Uses existing `feed.py` script via `linkedinExec('feed', [])`
- Scrapes user's own feed for trending topics and signals
- Useful for: "what's my network talking about this week?"
- Can identify gaps: topics discussed but not covered by user

### Safety

- LinkedIn research is **opt-in per session** (checkbox, not default)
- Clear indicator when LinkedIn browser is active
- Rate-limited: max 1 LinkedIn search per ideation session
- Results cached so repeat sessions don't re-scrape
- All scraping uses existing stealth measures (Patchright, human delays, realistic UA)

---

## Data Model Changes

### New: URL Registry (Central Source Database)

Every URL that enters the system is tracked — research sources, references used in posts, competitor LinkedIn posts, patent links, published post URLs. This enables dedup ("already used this source"), source library queries ("everything I researched about CWV"), and post-to-source traceability.

```sql
CREATE TABLE IF NOT EXISTS linkedin_url_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL,                 -- SHA-256 of normalized URL for fast dedup
  domain TEXT,                            -- Extracted domain (google.com, linkedin.com, etc.)

  -- Classification
  url_type TEXT NOT NULL DEFAULT 'reference',
  -- reference    = research source, article, patent
  -- linkedin_post = someone else's LinkedIn post (found via search/feed)
  -- our_post     = our published LinkedIn post URL
  -- image        = image/screenshot URL or local path
  -- other        = misc

  -- Content snapshot
  title TEXT,                             -- Page title at time of capture
  snippet TEXT,                           -- First 500 chars of content
  topic_tags TEXT,                        -- JSON array: ["cwv", "page-quality", "patents"]

  -- Usage tracking
  times_used INTEGER DEFAULT 1,          -- How many times referenced across sessions
  first_seen_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT DEFAULT (datetime('now')),

  -- Relationships (many-to-many via junction tables below)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_url_hash ON linkedin_url_registry(url_hash);
CREATE INDEX IF NOT EXISTS idx_url_type ON linkedin_url_registry(url_type);
CREATE INDEX IF NOT EXISTS idx_url_domain ON linkedin_url_registry(domain);
```

Junction tables linking URLs to sessions, ideas, and assets:

```sql
-- URLs discovered/used during an idea session
CREATE TABLE IF NOT EXISTS linkedin_session_urls (
  session_id INTEGER NOT NULL REFERENCES linkedin_idea_sessions(id) ON DELETE CASCADE,
  url_id INTEGER NOT NULL REFERENCES linkedin_url_registry(id),
  role TEXT DEFAULT 'research',          -- research | inspiration | reference
  PRIMARY KEY (session_id, url_id)
);

-- URLs referenced by a specific idea card
CREATE TABLE IF NOT EXISTS linkedin_idea_urls (
  idea_card_id INTEGER NOT NULL REFERENCES linkedin_idea_cards(id) ON DELETE CASCADE,
  url_id INTEGER NOT NULL REFERENCES linkedin_url_registry(id),
  PRIMARY KEY (idea_card_id, url_id)
);

-- URLs referenced in a published asset (including the published post URL itself)
CREATE TABLE IF NOT EXISTS linkedin_asset_urls (
  asset_id INTEGER NOT NULL REFERENCES linkedin_plan_assets(id) ON DELETE CASCADE,
  url_id INTEGER NOT NULL REFERENCES linkedin_url_registry(id),
  role TEXT DEFAULT 'source',            -- source | published_url
  PRIMARY KEY (asset_id, url_id, role)
);
```

**How it works:**
- Every URL pasted by user, found by AI research, or scraped from LinkedIn is upserted into `linkedin_url_registry`
- Junction tables track which sessions/ideas/assets used which URLs
- On publish, the published LinkedIn post URL is added with `url_type = 'our_post'` and linked to the asset with `role = 'published_url'`
- Dedup: before researching, check `url_hash` — if already in registry, show "previously used in session X" warning
- Topic tags auto-extracted by AI during research, enable queries like "all sources about page quality"

### New: Idea Lab Sessions

```sql
CREATE TABLE IF NOT EXISTS linkedin_idea_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'active',           -- active | ideas_generated | drafted | archived
  initial_dump TEXT,                      -- User's freeform input
  discussion_history TEXT,                -- JSON array of chat messages
  batch_rules TEXT,                       -- Rules for all ideas in this session
  research_sources TEXT,                  -- JSON: { web: true, patents: true, linkedin: false, feed: false }
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### New: Idea Cards

```sql
CREATE TABLE IF NOT EXISTS linkedin_idea_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES linkedin_idea_sessions(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES linkedin_targets(id),

  -- Content
  angle TEXT NOT NULL,
  hook TEXT,
  key_points TEXT,                        -- JSON array
  source_urls TEXT,                       -- JSON array
  image_preset TEXT DEFAULT 'none',       -- meme | explainer_card | annotated_screenshot | data_visual | quote_card | comparison | none
  image_concept TEXT,                     -- AI-generated description of what the image should show
  image_caption TEXT,                     -- For meme preset: the short ironic punchline text
  per_idea_rules TEXT,

  -- State
  selected INTEGER DEFAULT 1,            -- Checked for drafting
  sort_order INTEGER DEFAULT 0,

  -- Link to asset once drafted
  asset_id INTEGER REFERENCES linkedin_plan_assets(id),

  created_at TEXT DEFAULT (datetime('now'))
);
```

### Modified: linkedin_plan_assets

Add columns:
```sql
ALTER TABLE linkedin_plan_assets ADD COLUMN session_id INTEGER REFERENCES linkedin_idea_sessions(id);
ALTER TABLE linkedin_plan_assets ADD COLUMN idea_card_id INTEGER REFERENCES linkedin_idea_cards(id);
ALTER TABLE linkedin_plan_assets ADD COLUMN batch_rules TEXT;
ALTER TABLE linkedin_plan_assets ADD COLUMN per_idea_rules TEXT;
ALTER TABLE linkedin_plan_assets ADD COLUMN discussion_context TEXT;  -- Summary of relevant discussion
ALTER TABLE linkedin_plan_assets ADD COLUMN last_error TEXT;          -- Error message + step + provider + timestamp (JSON)
ALTER TABLE linkedin_plan_assets ADD COLUMN error_step TEXT;          -- research | draft | publish | image
ALTER TABLE linkedin_plan_assets ADD COLUMN retry_count INTEGER DEFAULT 0;
```

Status values updated:
```
pending | researching | drafted | approved | scheduled | published | rejected | copied | error
```

The `error` status is recoverable — user clicks Rewrite/Re-draft/Re-research to retry from the appropriate step. `retry_count` tracks how many times this asset has been retried.

---

## Existing Infrastructure Reused

| Component | How It's Used |
|-----------|--------------|
| `AgentManager.processMessage()` | Discussion chat + idea generation + drafting |
| `linkedinExec('feed', ...)` | LinkedIn search + feed scraping |
| `screenshotAnnotate()` | Image generation from ideas |
| `overlayAvatar()` | Avatar on every generated image |
| `DEFAULT_HARD_RULES` | Always applied to every draft |
| `Pre-Publish Checklist` | Verified during drafting |
| `Post Bank` | Voice anchoring during drafting |
| `linkedin-autoposter.ts` | Scheduling + auto-publishing |
| `post.py` | Actual LinkedIn publishing |

---

## UI Implementation Plan

### File Changes

**`ui/linkedin-planner.html`** — Major rewrite of the New Plan panel:
- Replace form with Idea Lab (freeform textarea + discussion thread + research toggles)
- Add Ideas Board view (cards with batch/per-idea rules)
- Keep existing asset list, detail view, feedback, lightbox, settings

**`src/main/index.ts`** — New IPC handlers:
- `planner:startIdeaSession` — create session, start research
- `planner:sendMessage` — chat message in discussion
- `planner:generateIdeas` — AI generates idea cards from discussion
- `planner:updateIdeaCard` — edit card fields
- `planner:deleteIdeaCard` — remove card
- `planner:draftSelected` — approve selected cards, create assets, start drafting

**`src/tools/linkedin-planner.ts`** — New functions:
- `createIdeaSession()` — store session + initial research
- `processDiscussionMessage()` — handle chat with research context
- `generateIdeaCards()` — AI parses discussion into structured cards
- `draftFromIdeaCard()` — draft with all 3 rule levels + discussion context

**`src/memory/index.ts`** — 6 new tables (idea_sessions, idea_cards, url_registry, 3 junction tables) + asset column additions

**`src/tools/linkedin-planner.ts`** — URL registry functions:
- `registerUrl()` — upsert URL into registry, return id
- `linkUrlToSession()` / `linkUrlToIdea()` / `linkUrlToAsset()` — junction table writes
- `getUrlsByAsset()` / `getUrlsBySession()` — lookups
- `checkUrlUsed()` — dedup check ("this URL was used in session X")
- On publish success: register published LinkedIn post URL with `url_type = 'our_post'`

### Build Order

1. DB tables (url_registry + junction tables + idea_sessions + idea_cards + asset columns)
2. URL registry CRUD functions
3. Idea Lab UI (textarea + research toggles + Go button)
4. Discussion thread (chat messages + AI responses + URL auto-capture)
5. LinkedIn research integration (wire existing feed.py to toggles)
6. Idea generation (discussion → cards, with URLs linked to cards)
7. Ideas Board UI (cards + batch rules + per-idea rules)
8. Draft selected flow (cards → assets with all rules + URL linkage)
9. Publish flow: capture published post URL into registry

---

## Commits Plan

1. `Add URL registry, idea session, and idea card tables to database`
2. `Add URL registry CRUD and dedup functions`
3. `Replace New Plan form with Idea Lab freeform input`
4. `Add discussion thread with AI research integration`
5. `Add LinkedIn search toggle with feed.py integration`
6. `Auto-capture URLs from research into registry`
7. `Add idea card generation from discussion context`
8. `Add Ideas Board UI with batch and per-idea rules`
9. `Wire draft flow: idea cards to assets with 3-level rules`
10. `Capture published post URLs into registry on publish success`

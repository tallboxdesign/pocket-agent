"""
Configuration for LinkedIn Skill
Centralizes constants, selectors, and paths

Selectors discovered Feb 2026 via --show-browser HTML dump analysis.
"""

import os
from pathlib import Path

# Paths — data lives outside the app bundle at ~/.pocket-agent/linkedin/
# so it survives app updates and reinstalls
DATA_DIR = Path(os.path.expanduser("~/.pocket-agent/linkedin/data"))
BROWSER_STATE_DIR = DATA_DIR / "browser_state"
BROWSER_PROFILE_DIR = BROWSER_STATE_DIR / "browser_profile"
STATE_FILE = BROWSER_STATE_DIR / "state.json"
AUTH_INFO_FILE = DATA_DIR / "auth_info.json"

# Browser Configuration
BROWSER_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
]

# GPU flags — only for headless mode (counterproductive in headed mode on macOS)
BROWSER_ARGS_HEADLESS_EXTRA = [
    '--disable-gpu',
    '--disable-software-rasterizer',
]

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

# Timeouts
LOGIN_TIMEOUT_MINUTES = 10
PAGE_LOAD_TIMEOUT = 30000

# LinkedIn URLs
LINKEDIN_LOGIN_URL = "https://www.linkedin.com/login"
LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/"

# ─── DISCOVERED SELECTORS (Feb 2026) ───

# Feed post containers
FEED_POST_SELECTORS = [
    ".feed-shared-update-v2",                    # Main card div
    "[role='article'][data-urn]",                # Article with URN
    "div[data-id^='urn:li:activity']",           # Outer wrapper with URN
]

# Post author name within a post container
POST_AUTHOR_SELECTORS = [
    ".update-components-actor__title span[aria-hidden='true']",  # Clean name text
    ".update-components-actor__title",
    ".update-components-actor__single-line-truncate",
]

# Post text content within a post container
POST_TEXT_SELECTORS = [
    ".update-components-update-v2__commentary",  # Commentary div
    ".feed-shared-update-v2__description",       # Outer wrapper
]

# Post URL — constructed from data-urn attribute, not a link
# Use data-urn on article to build: linkedin.com/feed/update/{urn}/

# Engagement: reaction count
POST_REACTION_COUNT_SELECTORS = [
    ".social-details-social-counts__reactions-count",
    "button.social-details-social-counts__count-value--long",
    "span.social-details-social-counts__reactions-count",
]

# Engagement: comment count
POST_COMMENT_COUNT_SELECTORS = [
    "button.social-details-social-counts__comments",
    "button[aria-label*='comment']",
    ".social-details-social-counts__comments",
]

# "Start a post" button on feed
START_POST_SELECTORS = [
    ".share-box-feed-entry__top-bar button",
    "button:has-text('Start a post')",
]

# Post editor text area (after clicking "Start a post")
POST_EDITOR_SELECTORS = [
    ".ql-editor[contenteditable='true']",
    "[role='textbox'][contenteditable='true']",
    "[data-placeholder*='What do you want to talk about']",
]

# Image/media upload button in post editor toolbar
POST_MEDIA_BUTTON_SELECTORS = [
    "button[aria-label='Add media']",
    ".share-promoted-detour-button[aria-label='Add media']",
    "button[aria-label='Add a photo']",
]

# File input for image upload (hidden, revealed after clicking Add media)
POST_IMAGE_INPUT_SELECTORS = [
    "#media-editor-file-selector__file-input",
    ".media-editor-file-selector__upload-media-input",
    "input[type='file'][accept*='image']",
    "input[type='file']",
]

# Post submit button
POST_SUBMIT_SELECTORS = [
    "button.share-actions__primary-action",
    "button:has-text('Post')",
]

# Comment button on a post (to open comment box)
COMMENT_BUTTON_SELECTORS = [
    "button.comment-button",
    "button[aria-label='Comment']",
    "[data-finite-scroll-hotkey='c']",
]

# Comment box (dynamic — appears after clicking Comment button)
COMMENT_BOX_SELECTORS = [
    ".ql-editor[contenteditable='true']",
    ".comments-comment-texteditor .ql-editor",
    "[data-placeholder='Add a comment…']",
]

# Comment submit button (dynamic)
COMMENT_SUBMIT_SELECTORS = [
    "button.comments-comment-box__submit-button--cr",
    "button[class*='comments-comment-box__submit-button']",
    "button.comments-comment-box__submit-button",
]

# Search bar
SEARCH_INPUT_SELECTORS = [
    "input[aria-label='Search']",
    "input.search-global-typeahead__input",
]

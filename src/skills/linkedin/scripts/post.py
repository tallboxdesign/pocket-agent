#!/usr/bin/env python3
"""
LinkedIn Post Creator
Create new posts with optional confirmation before publishing
"""

import argparse
import json
import sys
import time
from pathlib import Path

from patchright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

from config import (
    LINKEDIN_FEED_URL, PAGE_LOAD_TIMEOUT,
    START_POST_SELECTORS, POST_EDITOR_SELECTORS,
    POST_SUBMIT_SELECTORS
)
from browser_utils import BrowserFactory, StealthUtils


def create_post(page, text: str) -> bool:
    """Create a new LinkedIn post"""
    # Click "Start a post"
    clicked = False
    for sel in START_POST_SELECTORS:
        btn = page.query_selector(sel)
        if btn:
            StealthUtils.realistic_click(page, sel)
            StealthUtils.random_delay(2000, 4000)
            clicked = True
            break

    if not clicked:
        print("ERROR: Could not find 'Start a post' button", file=sys.stderr)
        return False

    # Find editor and type content
    editor = None
    for sel in POST_EDITOR_SELECTORS:
        editor = page.query_selector(sel)
        if editor:
            editor.click()
            StealthUtils.short_delay()
            # contenteditable divs — use fill or type
            editor.fill(text)
            StealthUtils.random_delay(1000, 2000)
            break

    if not editor:
        print("ERROR: Could not find post editor", file=sys.stderr)
        return False

    # Find Post button
    for sel in POST_SUBMIT_SELECTORS:
        btn = page.query_selector(sel)
        if btn and btn.is_enabled():
            btn.click()
            StealthUtils.random_delay(3000, 5000)
            print("Post published successfully")
            return True

    print("ERROR: Could not find Post button", file=sys.stderr)
    return False


def main():
    parser = argparse.ArgumentParser(description='Create LinkedIn posts')
    parser.add_argument('--text', type=str, help='Post text content')
    parser.add_argument('--text-file', type=str, help='Read post text from file')
    parser.add_argument('--show-browser', action='store_true', help='Show browser')
    parser.add_argument('--no-confirm', action='store_true', help='Skip confirmation prompt (for automation)')
    args = parser.parse_args()

    # Get post text
    post_text = args.text
    if args.text_file:
        post_text = Path(args.text_file).read_text().strip()

    if not post_text:
        print("ERROR: Provide --text or --text-file", file=sys.stderr)
        sys.exit(1)

    # Confirm before proceeding (unless --no-confirm)
    if not args.no_confirm:
        print(f"--- Draft post ---\n{post_text}\n---", file=sys.stderr)
        print("Press Enter to publish, or Ctrl+C to cancel.", file=sys.stderr)
        input()

    headless = not args.show_browser
    playwright = None
    context = None

    try:
        playwright = sync_playwright().start()
        context = BrowserFactory.launch_persistent_context(playwright, headless=headless)

        page = context.new_page()
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(LINKEDIN_FEED_URL, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)

        if "login" in page.url:
            print("ERROR: Not authenticated. Run: python run.py auth_manager setup", file=sys.stderr)
            sys.exit(1)

        StealthUtils.random_delay(2000, 4000)

        success = create_post(page, post_text)

        if not success:
            sys.exit(1)

    except KeyboardInterrupt:
        print("\nCancelled", file=sys.stderr)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    finally:
        if context:
            try:
                context.close()
            except Exception:
                pass
        if playwright:
            try:
                playwright.stop()
            except Exception:
                pass


if __name__ == "__main__":
    main()

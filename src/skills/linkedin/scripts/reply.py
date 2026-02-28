#!/usr/bin/env python3
"""
LinkedIn Post Reader & Commenter
Read a post's content and optionally post a comment
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from patchright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

from config import (
    PAGE_LOAD_TIMEOUT, DATA_DIR,
    POST_AUTHOR_SELECTORS, POST_TEXT_SELECTORS,
    COMMENT_BOX_SELECTORS, COMMENT_SUBMIT_SELECTORS,
    COMMENT_BUTTON_SELECTORS
)
from browser_utils import BrowserFactory, StealthUtils


DEBUG_HTML = str(DATA_DIR / "debug_reply.html")


def extract_post_content(page) -> dict:
    """Extract the main post content from a post page"""
    author = None
    text = None

    for sel in POST_AUTHOR_SELECTORS:
        el = page.query_selector(sel)
        if el:
            author = el.inner_text().strip()
            if author:
                break

    for sel in POST_TEXT_SELECTORS:
        el = page.query_selector(sel)
        if el:
            text = el.inner_text().strip()
            if text:
                break

    return {
        "author": author or "Unknown",
        "text": text or "",
        "url": page.url
    }


def post_comment(page, comment_text: str) -> bool:
    """Post a comment on the current post page with robust retry logic"""

    # Scroll down to make sure the social actions bar is in view
    page.evaluate("window.scrollBy(0, 400)")
    StealthUtils.random_delay(1000, 2000)

    # Try clicking Comment button up to 3 times with increasing waits
    comment_btn_clicked = False
    for attempt in range(3):
        for sel in COMMENT_BUTTON_SELECTORS:
            btn = page.query_selector(sel)
            if btn:
                try:
                    btn.scroll_into_view_if_needed(timeout=3000)
                except Exception:
                    pass
                StealthUtils.random_delay(500, 1000)
                StealthUtils.realistic_click(page, sel)
                StealthUtils.random_delay(2000, 3000)
                comment_btn_clicked = True
                break
        if comment_btn_clicked:
            break
        # Scroll more and retry
        page.evaluate("window.scrollBy(0, 300)")
        StealthUtils.random_delay(1500, 2500)

    # Wait for comment box with longer timeout and multiple attempts
    comment_el = None
    for attempt in range(3):
        for sel in COMMENT_BOX_SELECTORS:
            try:
                comment_el = page.wait_for_selector(sel, timeout=8000)
            except Exception:
                continue
            if comment_el:
                break
        if comment_el:
            break
        # If not found, try clicking Comment button again
        for sel in COMMENT_BUTTON_SELECTORS:
            btn = page.query_selector(sel)
            if btn:
                btn.click()
                StealthUtils.random_delay(2000, 3000)
                break

    if not comment_el:
        # Dump HTML for debugging
        try:
            Path(DEBUG_HTML).write_text(page.content())
            print(f"DEBUG: HTML dumped to {DEBUG_HTML}", file=sys.stderr)
        except Exception:
            pass
        print("ERROR: Could not find comment box after 3 attempts", file=sys.stderr)
        return False

    # Click into the contenteditable div and type
    comment_el.click()
    StealthUtils.random_delay(500, 1000)
    page.keyboard.type(comment_text, delay=80)
    StealthUtils.random_delay(1500, 2500)

    # Wait for submit button to become enabled, then click
    for attempt in range(3):
        for sel in COMMENT_SUBMIT_SELECTORS:
            try:
                btn = page.wait_for_selector(sel, timeout=5000)
            except Exception:
                continue
            if btn:
                StealthUtils.random_delay(500, 1000)
                if btn.is_enabled():
                    btn.click()
                    StealthUtils.random_delay(2000, 4000)
                    print("Comment posted successfully")
                    return True
        StealthUtils.random_delay(1000, 2000)

    print("ERROR: Could not find or click submit button", file=sys.stderr)
    return False


def main():
    parser = argparse.ArgumentParser(description='Read LinkedIn posts and comment')
    parser.add_argument('--url', type=str, required=True, help='Post URL')
    parser.add_argument('--comment', type=str, help='Comment text to post')
    parser.add_argument('--read-only', action='store_true', help='Just extract post content, no comment')
    parser.add_argument('--show-browser', action='store_true', help='Show browser')
    parser.add_argument('--no-confirm', action='store_true', help='Skip confirmation prompt (for automation)')
    parser.add_argument('--dump-html', type=str, help='Dump page HTML for debugging')
    args = parser.parse_args()

    headless = not args.show_browser
    playwright = None
    context = None

    try:
        playwright = sync_playwright().start()
        context = BrowserFactory.launch_persistent_context(playwright, headless=headless)

        page = context.new_page()
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(args.url, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)

        if "login" in page.url:
            print("ERROR: Not authenticated. Run: python run.py auth_manager setup", file=sys.stderr)
            sys.exit(1)

        # Wait for page to fully render (LinkedIn loads content dynamically)
        StealthUtils.random_delay(3000, 5000)

        # Extract post content
        post = extract_post_content(page)
        print(json.dumps(post, indent=2, ensure_ascii=False))

        if args.read_only or not args.comment:
            return

        # Confirm before posting (skipped with --no-confirm)
        if not args.no_confirm:
            print(f"\n--- Draft comment ---\n{args.comment}\n---", file=sys.stderr)
            print("Press Enter to post, or Ctrl+C to cancel.", file=sys.stderr)
            input()

        success = post_comment(page, args.comment)

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

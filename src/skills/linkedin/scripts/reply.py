#!/usr/bin/env python3
"""
LinkedIn Post Reader & Commenter
Read a post's content and optionally post a comment
"""

import argparse
import json
import sys
import time
from pathlib import Path

from patchright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

from config import (
    PAGE_LOAD_TIMEOUT,
    POST_AUTHOR_SELECTORS, POST_TEXT_SELECTORS,
    COMMENT_BOX_SELECTORS, COMMENT_SUBMIT_SELECTORS,
    COMMENT_BUTTON_SELECTORS
)
from browser_utils import BrowserFactory, StealthUtils


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


def post_comment(page, comment_text: str, dump_html: str = None) -> bool:
    """Post a comment on the current post page"""
    # Click "Comment" button to open comment box if needed
    for sel in COMMENT_BUTTON_SELECTORS:
        btn = page.query_selector(sel)
        if btn:
            StealthUtils.realistic_click(page, sel)
            StealthUtils.random_delay(2000, 3000)
            break

    # Wait for comment box to appear (it's dynamically rendered)
    comment_el = None
    for sel in COMMENT_BOX_SELECTORS:
        try:
            comment_el = page.wait_for_selector(sel, timeout=5000)
        except Exception:
            continue
        if comment_el:
            break

    if not comment_el:
        print("ERROR: Could not find comment box", file=sys.stderr)
        if dump_html:
            Path(dump_html).write_text(page.content())
            print(f"DEBUG: HTML dumped to {dump_html}", file=sys.stderr)
        return False

    # Click into the contenteditable div and type (fill() doesn't work on contenteditable)
    comment_el.click()
    StealthUtils.random_delay(500, 1000)
    page.keyboard.type(comment_text, delay=80)
    StealthUtils.random_delay(1500, 2500)

    # Dump HTML after typing for selector debugging
    if dump_html:
        Path(dump_html).write_text(page.content())
        print(f"DEBUG: HTML dumped to {dump_html}", file=sys.stderr)

    # Wait for submit button to become enabled, then click
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

    print("ERROR: Could not find submit button", file=sys.stderr)
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

        StealthUtils.random_delay(2000, 4000)

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

        success = post_comment(page, args.comment, dump_html=args.dump_html)

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

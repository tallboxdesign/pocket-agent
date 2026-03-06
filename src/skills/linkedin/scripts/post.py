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
    POST_SUBMIT_SELECTORS, POST_MEDIA_BUTTON_SELECTORS,
    POST_IMAGE_INPUT_SELECTORS
)
from browser_utils import BrowserFactory, StealthUtils


def attach_image(page, image_path: str) -> bool:
    """Attach an image to the post being composed."""
    # Try clicking the media button first
    clicked = False
    for sel in POST_MEDIA_BUTTON_SELECTORS:
        btn = page.query_selector(sel)
        if btn:
            StealthUtils.realistic_click(page, sel)
            StealthUtils.random_delay(1500, 3000)
            clicked = True
            break

    # Whether or not we found a button, look for the file input
    # LinkedIn often has a hidden file input we can use directly
    file_input = None
    for sel in POST_IMAGE_INPUT_SELECTORS:
        file_input = page.query_selector(sel)
        if file_input:
            break

    if not file_input:
        # If no file input found after clicking, try waiting for it
        if clicked:
            page.wait_for_selector("input[type='file']", timeout=5000)
            file_input = page.query_selector("input[type='file']")

    if not file_input:
        print("ERROR: Could not find file input for image upload", file=sys.stderr)
        return False

    file_input.set_input_files(image_path)
    # Wait for the image to upload and thumbnail to appear
    StealthUtils.random_delay(3000, 6000)
    print(f"Image attached: {image_path}", file=sys.stderr)
    return True


def create_post(page, text: str, image_path: str = None) -> bool:
    """Create a new LinkedIn post, optionally with an image."""
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

    # Attach image first (before typing text) if provided
    if image_path:
        if not attach_image(page, image_path):
            print("WARNING: Image attach failed, posting text only", file=sys.stderr)

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
    parser.add_argument('--image', type=str, help='Path to image file to attach')
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

    # Validate image path if provided
    image_path = args.image
    if image_path and not Path(image_path).exists():
        print(f"ERROR: Image file not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    # Confirm before proceeding (unless --no-confirm)
    if not args.no_confirm:
        print(f"--- Draft post ---\n{post_text}\n---", file=sys.stderr)
        if image_path:
            print(f"Image: {image_path}", file=sys.stderr)
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

        success = create_post(page, post_text, image_path=image_path)

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

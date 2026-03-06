#!/usr/bin/env python3
"""
LinkedIn Engagement Checker
Navigate to a post URL and extract current reaction/comment counts.
"""

import argparse
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

from config import (
    PAGE_LOAD_TIMEOUT,
    POST_REACTION_COUNT_SELECTORS,
    POST_COMMENT_COUNT_SELECTORS,
)
from browser_utils import BrowserFactory
from feed import parse_count, find_text


def check_engagement(url, show_browser=False):
    """Navigate to post URL and extract engagement counts."""
    with sync_playwright() as pw:
        context = BrowserFactory.launch_persistent_context(pw, headless=not show_browser)
        page = None

        try:
            page = context.new_page()
            page.goto(url, timeout=PAGE_LOAD_TIMEOUT, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)

            # Extract counts from the page
            reactions_text = find_text(page, POST_REACTION_COUNT_SELECTORS)
            comments_text = find_text(page, POST_COMMENT_COUNT_SELECTORS)

            reactions = parse_count(reactions_text)
            comments = parse_count(comments_text)

            return {"url": url, "reactions": reactions, "comments": comments}
        finally:
            if page:
                page.close()
            context.close()


def main():
    parser = argparse.ArgumentParser(description="Check LinkedIn post engagement")
    parser.add_argument("--url", required=True, help="LinkedIn post URL")
    parser.add_argument("--show-browser", action="store_true", help="Show browser window")
    args = parser.parse_args()

    result = check_engagement(args.url, args.show_browser)
    print(json.dumps(result))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
LinkedIn Feed Browser
Scroll feed, extract posts with engagement data, filter by topic/engagement
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

from patchright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

from config import (
    LINKEDIN_FEED_URL, PAGE_LOAD_TIMEOUT, DATA_DIR,
    FEED_POST_SELECTORS, POST_AUTHOR_SELECTORS,
    POST_TEXT_SELECTORS, POST_REACTION_COUNT_SELECTORS,
    POST_COMMENT_COUNT_SELECTORS
)
from browser_utils import BrowserFactory, StealthUtils


def find_text(container, selectors):
    """Try multiple selectors, return first match text or None"""
    for sel in selectors:
        el = container.query_selector(sel)
        if el:
            text = el.inner_text().strip()
            if text:
                return text
    return None


def parse_count(text):
    """Parse engagement count strings like '4', '1,234', '2K' into int"""
    if not text:
        return 0
    text = text.strip().replace(',', '')
    # Match just the number part
    m = re.search(r'([\d.]+)\s*([KkMm]?)', text)
    if not m:
        return 0
    num = float(m.group(1))
    suffix = m.group(2).upper()
    if suffix == 'K':
        num *= 1000
    elif suffix == 'M':
        num *= 1000000
    return int(num)


def get_engagement(container):
    """Extract reaction and comment counts from a post container"""
    reactions_text = find_text(container, POST_REACTION_COUNT_SELECTORS)
    comments_text = find_text(container, POST_COMMENT_COUNT_SELECTORS)

    reactions = parse_count(reactions_text)

    # Comment count often in format "X comments"
    comments = 0
    if comments_text:
        m = re.search(r'(\d[\d,]*)', comments_text)
        if m:
            comments = parse_count(m.group(1))

    return reactions, comments


def get_post_url(container):
    """Construct post URL from data-urn attribute"""
    # Try on the container itself
    urn = container.get_attribute("data-urn")
    if not urn:
        # Try finding an article child with data-urn
        article = container.query_selector("[data-urn]")
        if article:
            urn = article.get_attribute("data-urn")
    if not urn:
        # Try parent with data-id
        data_id = container.get_attribute("data-id")
        if data_id:
            urn = data_id

    if urn:
        return f"https://www.linkedin.com/feed/update/{urn}/"
    return None


def extract_posts(page) -> list:
    """Extract visible post data with engagement metrics"""
    posts = []
    for sel in FEED_POST_SELECTORS:
        containers = page.query_selector_all(sel)
        if containers:
            for container in containers:
                author = find_text(container, POST_AUTHOR_SELECTORS)
                text = find_text(container, POST_TEXT_SELECTORS)
                url = get_post_url(container)
                reactions, comments = get_engagement(container)

                if author or text:
                    posts.append({
                        "author": author or "Unknown",
                        "text_preview": (text[:300] + "...") if text and len(text) > 300 else text,
                        "post_url": url,
                        "reactions": reactions,
                        "comments": comments,
                        "engagement": reactions + comments,
                    })
            break
    return posts


def scroll_feed(page, times: int = 3):
    """Scroll feed N times using keyboard"""
    for i in range(times):
        page.keyboard.press("End")
        StealthUtils.random_delay(3000, 5000)
        page.keyboard.press("PageDown")
        StealthUtils.random_delay(2000, 4000)


def dump_page_html(page, path: str):
    """Save page HTML for selector discovery"""
    html = page.content()
    Path(path).write_text(html)
    print(f"Saved page HTML to {path} ({len(html)} bytes)", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description='Browse LinkedIn feed')
    parser.add_argument('--scroll', type=int, default=3, help='Scroll iterations (default: 3)')
    parser.add_argument('--person', type=str, help='Filter posts by person name')
    parser.add_argument('--keyword', type=str, help='Filter posts by keyword in text')
    parser.add_argument('--min-engagement', type=int, default=0, help='Min reactions+comments (default: 0)')
    parser.add_argument('--show-browser', action='store_true', help='Show browser')
    parser.add_argument('--limit', type=int, default=20, help='Max posts to return (default: 20)')
    parser.add_argument('--dump-html', type=str, help='Save page HTML to file')
    args = parser.parse_args()

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

        # Wait for feed posts to render (JS-heavy SPA)
        try:
            page.wait_for_selector(".feed-shared-update-v2", timeout=15000)
        except Exception:
            print("Warning: feed posts not found after 15s, continuing anyway", file=sys.stderr)

        StealthUtils.random_delay(3000, 5000)

        # Scroll
        scroll_feed(page, args.scroll)

        # Dump HTML if requested
        dump_path = args.dump_html or (str(DATA_DIR / "feed_dump.html") if args.show_browser else None)
        if dump_path:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            dump_page_html(page, dump_path)

        # Extract
        posts = extract_posts(page)

        # Filter by person
        if args.person:
            person_lower = args.person.lower()
            posts = [p for p in posts if person_lower in (p["author"] or "").lower()]

        # Filter by keyword
        if args.keyword:
            kw_lower = args.keyword.lower()
            posts = [p for p in posts if kw_lower in (p["text_preview"] or "").lower()]

        # Filter by engagement
        if args.min_engagement > 0:
            posts = [p for p in posts if p["engagement"] >= args.min_engagement]

        # Deduplicate by URL
        seen = set()
        unique = []
        for p in posts:
            key = p["post_url"] or p["text_preview"]
            if key and key not in seen:
                seen.add(key)
                unique.append(p)

        # Sort by engagement descending
        unique.sort(key=lambda p: p["engagement"], reverse=True)
        posts = unique[:args.limit]

        # Output
        print(json.dumps(posts, indent=2, ensure_ascii=False))

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

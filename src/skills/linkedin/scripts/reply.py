#!/usr/bin/env python3
"""
LinkedIn Post Reader & Commenter
Read a post's content and optionally post a comment
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

from patchright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

from config import (
    PAGE_LOAD_TIMEOUT, DATA_DIR,
    FEED_POST_SELECTORS,
    POST_AUTHOR_SELECTORS, POST_TEXT_SELECTORS,
    COMMENT_BOX_SELECTORS, COMMENT_SUBMIT_SELECTORS,
    COMMENT_BUTTON_SELECTORS
)
from browser_utils import BrowserFactory, StealthUtils


DEBUG_HTML = str(DATA_DIR / "debug_reply.html")
DEBUG_SCREENSHOT = str(DATA_DIR / "debug_reply.png")


def _is_visible(el) -> bool:
    try:
        if not el:
            return False
        if hasattr(el, "is_visible") and not el.is_visible():
            return False
        box = el.bounding_box()
        return bool(box and box.get("width", 0) > 0 and box.get("height", 0) > 0)
    except Exception:
        return False


def _is_comment_editor(el) -> bool:
    try:
        cls = (el.get_attribute("class") or "").lower()
        if "ql-clipboard" in cls:
            return False
        contenteditable = (el.get_attribute("contenteditable") or "").lower()
        if contenteditable != "true":
            return False

        placeholder = " ".join([
            el.get_attribute("data-placeholder") or "",
            el.get_attribute("aria-placeholder") or "",
            el.get_attribute("aria-label") or "",
            cls,
        ]).lower()

        if "comment" in placeholder:
            return True

        role = (el.get_attribute("role") or "").lower()
        return role == "textbox" and "creating content" in placeholder
    except Exception:
        return False


def _find_comment_editor(page):
    seen = set()
    for sel in COMMENT_BOX_SELECTORS + ["[contenteditable='true']"]:
        try:
            elements = page.query_selector_all(sel)
        except Exception:
            continue
        for el in elements:
            try:
                key = str(el)
            except Exception:
                key = None
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            if not _is_visible(el):
                continue
            if _is_comment_editor(el):
                return el
    return None


def _find_comment_button(page):
    for sel in COMMENT_BUTTON_SELECTORS:
        try:
            elements = page.query_selector_all(sel)
        except Exception:
            continue
        for el in elements:
            if not _is_visible(el):
                continue
            return el
    return None


def _find_submit_button(page):
    for sel in COMMENT_SUBMIT_SELECTORS:
        try:
            elements = page.query_selector_all(sel)
        except Exception:
            continue
        for el in elements:
            if not _is_visible(el):
                continue
            try:
                if not el.is_enabled():
                    continue
            except Exception:
                pass
            return el
    return None


def _click_element(page, el, label: str) -> bool:
    if not el:
        return False
    try:
        el.scroll_into_view_if_needed(timeout=3000)
    except Exception:
        pass

    try:
        box = el.bounding_box()
        if box:
            page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2, steps=4)
    except Exception:
        pass

    click_attempts = (
        lambda: el.click(timeout=3000),
        lambda: el.click(force=True, timeout=3000),
        lambda: el.evaluate("(node) => node.click()"),
    )
    for attempt in click_attempts:
        try:
            attempt()
            return True
        except Exception:
            continue
    print(f"DEBUG: Failed to click {label}", file=sys.stderr)
    return False


def _wait_for_comment_editor(page, timeout_ms: int = 12000):
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        editor = _find_comment_editor(page)
        if editor:
            return editor
        time.sleep(0.35)
    return None


def _wait_for_submit_button(page, timeout_ms: int = 8000):
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        btn = _find_submit_button(page)
        if btn:
            return btn
        time.sleep(0.3)
    return None


def _dump_reply_debug(page, reason: str):
    try:
        Path(DEBUG_HTML).write_text(page.content())
        print(f"DEBUG: HTML dumped to {DEBUG_HTML}", file=sys.stderr)
    except Exception:
        pass
    try:
        page.screenshot(path=DEBUG_SCREENSHOT, full_page=True)
        print(f"DEBUG: Screenshot dumped to {DEBUG_SCREENSHOT}", file=sys.stderr)
    except Exception:
        pass
    try:
        visible_editors = sum(1 for el in page.query_selector_all("[contenteditable='true']") if _is_visible(el))
        print(f"DEBUG: {reason}; visible contenteditable nodes={visible_editors}", file=sys.stderr)
    except Exception:
        pass


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


def _is_noise_image(alt: str, src: str, cls: str) -> bool:
    low = f"{alt} {src} {cls}".lower()
    noise_terms = [
        "profile", "avatar", "logo", "reaction", "emoji", "icon",
        "badge", "presence-entity", "company-logo", "mini-profile",
    ]
    return any(term in low for term in noise_terms)


def _pick_post_root(page):
    for sel in FEED_POST_SELECTORS:
        root = page.query_selector(sel)
        if root:
            return root
    return page.query_selector("article") or page.query_selector("main") or page


def extract_post_images(page, limit: int = 2) -> list:
    """Extract image metadata and a compact data URI snapshot for vision/OCR."""
    root = _pick_post_root(page)
    if not root:
        return []

    images = root.query_selector_all("img")
    out = []
    seen = set()

    for img in images:
        if len(out) >= limit:
            break

        src = (
            img.get_attribute("src")
            or img.get_attribute("data-delayed-url")
            or img.get_attribute("data-ghost-url")
            or ""
        ).strip()
        alt = (img.get_attribute("alt") or "").strip()
        cls = (img.get_attribute("class") or "").strip()

        if not src and not alt:
            continue
        if _is_noise_image(alt, src, cls):
            continue

        try:
            bbox = img.bounding_box()
        except Exception:
            bbox = None
        if bbox and (bbox.get("width", 0) < 120 or bbox.get("height", 0) < 120):
            continue

        dedupe_key = (src or f"alt:{alt}").strip().lower()
        if not dedupe_key or dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        data_uri = ""
        try:
            snap = img.screenshot(type="jpeg", quality=42, timeout=5000)
            if snap:
                b64 = base64.b64encode(snap).decode("ascii")
                # Keep JSON payload bounded (stdout has a hard cap upstream)
                if len(b64) <= 550000:
                    data_uri = f"data:image/jpeg;base64,{b64}"
        except Exception:
            data_uri = ""

        out.append({
            "url": src,
            "alt": alt,
            "data_uri": data_uri,
        })

    return out


def post_comment(page, comment_text: str) -> bool:
    """Post a comment on the current post page with robust retry logic"""

    # Scroll down to make sure the social actions bar is in view
    page.evaluate("window.scrollBy(0, 400)")
    StealthUtils.random_delay(1000, 2000)

    # LinkedIn often renders the composer already open. Use it directly if present.
    comment_el = _wait_for_comment_editor(page, timeout_ms=2500)

    # Try opening the comment UI only when the editor is not already available.
    for attempt in range(3):
        if comment_el:
            break
        btn = _find_comment_button(page)
        if btn:
            StealthUtils.random_delay(400, 900)
            _click_element(page, btn, "comment button")
        StealthUtils.random_delay(1500, 2500)
        comment_el = _wait_for_comment_editor(page, timeout_ms=7000)
        if comment_el:
            break
        page.evaluate("window.scrollBy(0, 250)")
        StealthUtils.random_delay(1200, 2200)

    if not comment_el:
        _dump_reply_debug(page, "comment editor not found")
        print("ERROR: Could not find comment box after 3 attempts", file=sys.stderr)
        return False

    # Click into the contenteditable div and type
    _click_element(page, comment_el, "comment editor")
    StealthUtils.random_delay(500, 1000)
    try:
        page.keyboard.insert_text(comment_text)
    except Exception:
        page.keyboard.type(comment_text, delay=60)
    StealthUtils.random_delay(1500, 2500)

    # Wait for submit button to become enabled, then click
    for _ in range(3):
        btn = _wait_for_submit_button(page, timeout_ms=5000)
        if btn:
            StealthUtils.random_delay(400, 900)
            if _click_element(page, btn, "submit comment"):
                StealthUtils.random_delay(2000, 4000)
                print("Comment posted successfully")
                return True
        StealthUtils.random_delay(800, 1500)

    _dump_reply_debug(page, "submit button not found or not clickable")
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

        # Extract post content + media context for image-aware drafting
        post = extract_post_content(page)
        post["images"] = extract_post_images(page, limit=2)
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

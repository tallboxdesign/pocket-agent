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
    """Attach an image to the post being composed.

    Flow: JS-click "Add media" -> media editor panel opens ->
    set_input_files on hidden file input -> click "Done" or "Next" to
    return to share modal with image attached.
    """
    # Step 1: Click "Add media" via JS (bypasses modal overlay)
    # Retry a few times since the button may take a moment to render
    clicked_media = False
    for attempt in range(5):
        clicked_media = page.evaluate('''() => {
            const btn = document.querySelector('button[aria-label="Add media"]');
            if (btn) { btn.click(); return true; }
            return false;
        }''')
        if clicked_media:
            break
        time.sleep(1)

    if not clicked_media:
        print("ERROR: Could not find 'Add media' button", file=sys.stderr)
        return False

    print("Clicked 'Add media'", file=sys.stderr)
    StealthUtils.random_delay(2000, 3000)

    # Step 2: Find the file input (now visible in media editor)
    file_input = None
    for sel in POST_IMAGE_INPUT_SELECTORS:
        file_input = page.query_selector(sel)
        if file_input:
            break

    if not file_input:
        try:
            page.wait_for_selector("input[type='file']", timeout=5000)
            file_input = page.query_selector("input[type='file']")
        except Exception:
            pass

    if not file_input:
        print("ERROR: Could not find file input after media click", file=sys.stderr)
        return False

    # Step 3: Upload the file
    file_input.set_input_files(image_path)
    print(f"Image file set: {image_path}", file=sys.stderr)
    StealthUtils.random_delay(4000, 7000)

    # Step 4: Click "Done" or "Next" to return to share modal
    done_clicked = page.evaluate('''() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
            const text = (btn.innerText || '').trim().toLowerCase();
            if (text === 'done' || text === 'next') {
                btn.click();
                return text;
            }
        }
        return null;
    }''')

    if done_clicked:
        print(f"Clicked '{done_clicked}' to confirm image", file=sys.stderr)
        StealthUtils.random_delay(2000, 3000)
    else:
        # Some flows auto-return to share modal
        StealthUtils.random_delay(1000, 2000)

    # Step 5: Make sure we are back in the share composer, not stuck in media editor
    for _ in range(6):
        state = page.evaluate('''() => {
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const editorOpen = Array.from(document.querySelectorAll('[role="textbox"], .ql-editor'))
                .some((el) => isVisible(el));

            const fileInputVisible = Array.from(document.querySelectorAll("input[type='file']"))
                .some((el) => isVisible(el));

            const buttons = Array.from(document.querySelectorAll('button')).filter((btn) => isVisible(btn) && !btn.disabled);
            const buttonText = (btn) => ((btn.innerText || btn.getAttribute('aria-label') || '').trim().toLowerCase());

            if (editorOpen && !fileInputVisible) {
                const closeBtn = buttons.find((btn) => ['close', 'dismiss'].includes(buttonText(btn)));
                if (closeBtn) closeBtn.click();
                return { action: 'ready' };
            }

            for (const label of ['done', 'next', 'save']) {
                const btn = buttons.find((candidate) => buttonText(candidate) === label);
                if (btn) {
                    btn.click();
                    return { action: 'confirm', label };
                }
            }

            const closeBtn = buttons.find((btn) => ['close', 'dismiss'].includes(buttonText(btn)));
            if (closeBtn) {
                closeBtn.click();
                return { action: 'close' };
            }

            return { action: 'wait', editorOpen, fileInputVisible };
        }''')

        if state.get('action') == 'ready':
            break
        if state.get('action') in ('confirm', 'close'):
            print(f"Settled media flow via '{state.get('label', state.get('action'))}'", file=sys.stderr)
        StealthUtils.random_delay(1200, 2200)

    print(f"Image attached: {image_path}", file=sys.stderr)
    return True


def finalize_publish(page) -> bool:
    """Handle any extra LinkedIn audience/confirmation modals after clicking Post."""
    for attempt in range(6):
        state = page.evaluate('''() => {
            const visibleButtons = Array.from(document.querySelectorAll('button')).filter((btn) => {
                const rect = btn.getBoundingClientRect();
                const style = window.getComputedStyle(btn);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !btn.disabled;
            });
            const buttonText = (btn) => ((btn.innerText || btn.getAttribute('aria-label') || '').trim().toLowerCase());
            const texts = visibleButtons.map(buttonText);
            const composerOpen = Boolean(
                document.querySelector('[data-placeholder*="What do you want to talk about"]') ||
                document.querySelector('[role="textbox"][contenteditable="true"]') ||
                document.querySelector('.ql-editor')
            );

            const clickByLabels = (labels, action) => {
                for (const label of labels) {
                    const btn = visibleButtons.find((candidate) => buttonText(candidate) === label);
                    if (btn) {
                        btn.click();
                        return { action, label, composerOpen, texts };
                    }
                }
                return null;
            };

            const audienceChoice = clickByLabels(['anyone', 'public', 'connections only', 'connections'], 'audience');
            if (audienceChoice) return audienceChoice;

            const confirmChoice = clickByLabels(['done', 'save', 'next', 'post'], 'confirm');
            if (confirmChoice) return confirmChoice;

            if (!composerOpen) return { action: 'success', composerOpen, texts };
            return { action: 'wait', composerOpen, texts };
        }''')

        action = state.get('action')
        if action == 'success':
            return True

        if action in ('audience', 'confirm'):
            print(f"Handled LinkedIn publish modal: {state.get('label')}", file=sys.stderr)
            StealthUtils.random_delay(1500, 2500)
            continue

        StealthUtils.random_delay(1500, 2500)

    return False


def cleanup_composer_state(page) -> None:
    """Dismiss any lingering composer/save-draft UI before shutdown."""
    for _ in range(8):
        state = page.evaluate('''() => {
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const buttons = Array.from(document.querySelectorAll('button')).filter((btn) => isVisible(btn) && !btn.disabled);
            const buttonText = (btn) => ((btn.innerText || btn.getAttribute('aria-label') || '').trim().toLowerCase());
            const composerOpen = Array.from(document.querySelectorAll('[role="dialog"], [role="textbox"], .ql-editor'))
                .some((el) => isVisible(el));

            for (const label of ['discard', 'discard draft']) {
                const btn = buttons.find((candidate) => buttonText(candidate) === label);
                if (btn) {
                    btn.click();
                    return { action: 'discard', label };
                }
            }

            for (const label of ['close', 'dismiss', 'cancel']) {
                const btn = buttons.find((candidate) => buttonText(candidate) === label);
                if (btn) {
                    btn.click();
                    return { action: 'close', label, composerOpen };
                }
            }

            return { action: composerOpen ? 'wait' : 'done', composerOpen };
        }''')

        action = state.get('action')
        if action == 'done':
            return
        if action in ('discard', 'close'):
            print(f"Cleared lingering composer via '{state.get('label')}'", file=sys.stderr)
        StealthUtils.random_delay(800, 1500)


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

    # Attach image FIRST (before text - LinkedIn renders media button cleanly)
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
            if finalize_publish(page):
                print("Post published successfully")
                return True
            print("ERROR: Publish flow did not fully complete", file=sys.stderr)
            return False

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

    # Force headed mode when uploading images (headless doesn't render media buttons)
    headless = not args.show_browser and not image_path
    playwright = None
    context = None
    page = None

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
        if page:
            try:
                cleanup_composer_state(page)
            except Exception:
                pass
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

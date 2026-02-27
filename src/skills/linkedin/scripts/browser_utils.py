"""
Browser Utilities for LinkedIn Skill
Handles browser launching, stealth features, and common interactions
"""

import json
import time
import random
from typing import Optional, List

from patchright.sync_api import Playwright, BrowserContext, Page
from config import BROWSER_PROFILE_DIR, STATE_FILE, BROWSER_ARGS, USER_AGENT


class BrowserFactory:
    """Factory for creating configured browser contexts"""

    @staticmethod
    def launch_persistent_context(
        playwright: Playwright,
        headless: bool = True,
        user_data_dir: str = str(BROWSER_PROFILE_DIR)
    ) -> BrowserContext:
        """Launch a persistent browser context with anti-detection features"""
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            headless=headless,
            no_viewport=True,
            ignore_default_args=["--enable-automation"],
            user_agent=USER_AGENT,
            args=BROWSER_ARGS
        )

        # Cookie Workaround for Playwright bug #36139
        BrowserFactory._inject_cookies(context)

        return context

    @staticmethod
    def _inject_cookies(context: BrowserContext):
        """Inject cookies from state.json if available"""
        if STATE_FILE.exists():
            try:
                with open(STATE_FILE, 'r') as f:
                    state = json.load(f)
                    if 'cookies' in state and len(state['cookies']) > 0:
                        context.add_cookies(state['cookies'])
            except Exception as e:
                print(f"  Could not load state.json: {e}")


class StealthUtils:
    """Human-like interaction utilities — slower delays for LinkedIn"""

    @staticmethod
    def random_delay(min_ms: int = 2000, max_ms: int = 5000):
        """Add random delay (LinkedIn-appropriate: 2-5s default)"""
        time.sleep(random.uniform(min_ms / 1000, max_ms / 1000))

    @staticmethod
    def short_delay(min_ms: int = 500, max_ms: int = 1500):
        """Shorter delay for non-critical waits"""
        time.sleep(random.uniform(min_ms / 1000, max_ms / 1000))

    @staticmethod
    def human_type(page: Page, selector: str, text: str):
        """Type with human-like speed"""
        element = page.query_selector(selector)
        if not element:
            try:
                element = page.wait_for_selector(selector, timeout=5000)
            except:
                pass

        if not element:
            print(f"Element not found for typing: {selector}")
            return

        element.click()
        for char in text:
            element.type(char, delay=random.uniform(40, 120))
            if random.random() < 0.05:
                time.sleep(random.uniform(0.2, 0.6))

    @staticmethod
    def realistic_click(page: Page, selector: str):
        """Click with realistic movement"""
        element = page.query_selector(selector)
        if not element:
            return

        box = element.bounding_box()
        if box:
            x = box['x'] + box['width'] / 2
            y = box['y'] + box['height'] / 2
            page.mouse.move(x, y, steps=5)

        StealthUtils.random_delay(500, 1500)
        element.click()
        StealthUtils.random_delay(1000, 3000)

"""
Browser Utilities for LinkedIn Skill
Handles browser launching, stealth features, and common interactions
"""

import json
import os
import signal
import subprocess
import time
import random
from pathlib import Path
from typing import Optional, List

from patchright.sync_api import Playwright, BrowserContext, Page
from config import BROWSER_PROFILE_DIR, STATE_FILE, BROWSER_ARGS, BROWSER_ARGS_HEADLESS_EXTRA, USER_AGENT


class BrowserFactory:
    """Factory for creating configured browser contexts"""

    @staticmethod
    def _cleanup_stale_profile(user_data_dir: str):
        """Remove stale SingletonLock and kill zombie browser/driver processes"""
        # Kill zombie patchright drivers and stale Chromium processes
        try:
            result = subprocess.run(
                ['ps', '-eo', 'pid,etime,args'],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.strip().split('\n'):
                is_driver = 'patchright/driver' in line and 'run-driver' in line
                is_chromium = 'chromium' in line.lower() and user_data_dir in line
                if not is_driver and not is_chromium:
                    continue
                parts = line.strip().split(None, 2)
                if len(parts) < 2:
                    continue
                pid = int(parts[0])
                etime = parts[1]  # Format: MM:SS, HH:MM:SS, or D-HH:MM:SS
                # Parse elapsed time to minutes
                mins = 0
                if '-' in etime:
                    mins = int(etime.split('-')[0]) * 24 * 60  # days
                elif etime.count(':') == 2:
                    h, m, _ = etime.split(':')
                    mins = int(h) * 60 + int(m)
                elif etime.count(':') == 1:
                    m, _ = etime.split(':')
                    mins = int(m)
                # Kill drivers after 5min, Chromium using our profile after 2min
                threshold = 5 if is_driver else 2
                if mins >= threshold:
                    label = "patchright driver" if is_driver else "Chromium"
                    print(f"  Killing stale {label} {pid} (running {etime})", flush=True)
                    os.kill(pid, signal.SIGKILL if mins >= 10 else signal.SIGTERM)
        except Exception:
            pass

        lock_file = Path(user_data_dir) / "SingletonLock"
        if not lock_file.exists() and not lock_file.is_symlink():
            return

        # SingletonLock is a symlink like hostname-pid on Linux/Mac
        try:
            target = os.readlink(str(lock_file))
            # Format: hostname-pid
            parts = target.rsplit('-', 1)
            if len(parts) == 2:
                pid = int(parts[1])
                try:
                    os.kill(pid, 0)  # Check if alive
                    # Process alive — try to kill it (it's our stale browser)
                    print(f"  Killing stale browser process {pid}", flush=True)
                    os.kill(pid, signal.SIGTERM)
                    time.sleep(2)
                except ProcessLookupError:
                    pass  # Already dead
        except (OSError, ValueError):
            pass

        # Remove stale lock
        try:
            lock_file.unlink(missing_ok=True)
            print("  Removed stale SingletonLock", flush=True)
        except OSError:
            pass

    @staticmethod
    def launch_persistent_context(
        playwright: Playwright,
        headless: bool = True,
        user_data_dir: str = str(BROWSER_PROFILE_DIR)
    ) -> BrowserContext:
        """Launch a persistent browser context with anti-detection features"""
        BrowserFactory._cleanup_stale_profile(user_data_dir)
        args = list(BROWSER_ARGS)
        if headless:
            args.extend(BROWSER_ARGS_HEADLESS_EXTRA)
        else:
            # Launch off-screen so headed mode doesn't cover user's workspace
            args.append('--window-position=-2400,-2400')
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            headless=headless,
            no_viewport=True,
            ignore_default_args=["--enable-automation"],
            user_agent=USER_AGENT,
            args=args
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

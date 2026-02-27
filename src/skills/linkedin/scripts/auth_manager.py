#!/usr/bin/env python3
"""
Authentication Manager for LinkedIn
Handles LinkedIn login and browser state persistence

Implements hybrid auth approach:
- Persistent browser profile (user_data_dir) for fingerprint consistency
- Manual cookie injection from state.json for session cookies (Playwright bug workaround)
"""

import json
import time
import argparse
import shutil
import re
import sys
from pathlib import Path
from typing import Dict, Any

from patchright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))

from config import (
    BROWSER_STATE_DIR, STATE_FILE, AUTH_INFO_FILE, DATA_DIR,
    LINKEDIN_LOGIN_URL, LINKEDIN_FEED_URL, LOGIN_TIMEOUT_MINUTES
)
from browser_utils import BrowserFactory


class AuthManager:
    """Manages authentication and browser state for LinkedIn"""

    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        BROWSER_STATE_DIR.mkdir(parents=True, exist_ok=True)

        self.state_file = STATE_FILE
        self.auth_info_file = AUTH_INFO_FILE
        self.browser_state_dir = BROWSER_STATE_DIR

    def is_authenticated(self) -> bool:
        if not self.state_file.exists():
            return False
        age_days = (time.time() - self.state_file.stat().st_mtime) / 86400
        if age_days > 7:
            print(f"Browser state is {age_days:.1f} days old, may need re-authentication")
        return True

    def get_auth_info(self) -> Dict[str, Any]:
        info = {
            'authenticated': self.is_authenticated(),
            'state_file': str(self.state_file),
            'state_exists': self.state_file.exists()
        }
        if self.auth_info_file.exists():
            try:
                with open(self.auth_info_file, 'r') as f:
                    info.update(json.load(f))
            except Exception:
                pass
        if info['state_exists']:
            info['state_age_hours'] = (time.time() - self.state_file.stat().st_mtime) / 3600
        return info

    def setup_auth(self, headless: bool = False, timeout_minutes: int = LOGIN_TIMEOUT_MINUTES) -> bool:
        """Interactive authentication setup — launches visible browser for manual LinkedIn login"""
        print("Starting authentication setup...")
        print(f"  Timeout: {timeout_minutes} minutes")

        playwright = None
        context = None

        try:
            playwright = sync_playwright().start()
            context = BrowserFactory.launch_persistent_context(playwright, headless=headless)

            page = context.new_page()
            page.goto(LINKEDIN_LOGIN_URL, wait_until="domcontentloaded")

            # Check if already authenticated
            if "linkedin.com/feed" in page.url:
                print("  Already authenticated!")
                self._save_browser_state(context)

                if not headless:
                    self._keep_browser_open()

                return True

            print("\n  Please log in to your LinkedIn account...")
            print(f"  Waiting up to {timeout_minutes} minutes for login...")

            try:
                timeout_ms = int(timeout_minutes * 60 * 1000)
                page.wait_for_url(re.compile(r"https://www\.linkedin\.com/feed"), timeout=timeout_ms)
                print("  Login successful!")
                self._save_browser_state(context)
                self._save_auth_info()

                if not headless:
                    self._keep_browser_open()

                return True
            except Exception as e:
                print(f"  Authentication timeout: {e}")
                return False

        except Exception as e:
            print(f"  Error: {e}")
            return False

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

    @staticmethod
    def _keep_browser_open():
        """Keep browser open until the process is killed (user stops the command)."""
        print("\n  Browser is open. Stop this command (Ctrl+C) when you're done.")
        try:
            while True:
                time.sleep(60)
        except (KeyboardInterrupt, EOFError):
            print("\n  Closing browser...")

    def _save_browser_state(self, context):
        try:
            context.storage_state(path=str(self.state_file))
            self._patch_session_cookies()
            print(f"  Saved browser state to: {self.state_file}")
        except Exception as e:
            print(f"  Failed to save browser state: {e}")
            raise

    def _patch_session_cookies(self):
        """Convert session cookies (expires=-1) to 30-day persistent cookies."""
        with open(self.state_file, 'r') as f:
            state = json.load(f)

        future_expiry = time.time() + (30 * 24 * 3600)
        patched = 0
        for cookie in state.get('cookies', []):
            if cookie.get('expires', -1) == -1:
                cookie['expires'] = future_expiry
                patched += 1

        with open(self.state_file, 'w') as f:
            json.dump(state, f, indent=2)

        if patched:
            print(f"  Patched {patched} session cookies to persist for 30 days")

    def _save_auth_info(self):
        try:
            info = {
                'authenticated_at': time.time(),
                'authenticated_at_iso': time.strftime('%Y-%m-%d %H:%M:%S')
            }
            with open(self.auth_info_file, 'w') as f:
                json.dump(info, f, indent=2)
        except Exception:
            pass

    def clear_auth(self) -> bool:
        print("Clearing authentication data...")
        try:
            if self.state_file.exists():
                self.state_file.unlink()
            if self.auth_info_file.exists():
                self.auth_info_file.unlink()
            if self.browser_state_dir.exists():
                shutil.rmtree(self.browser_state_dir)
                self.browser_state_dir.mkdir(parents=True, exist_ok=True)
            print("  Authentication cleared")
            return True
        except Exception as e:
            print(f"  Error clearing auth: {e}")
            return False

    def re_auth(self, headless: bool = False, timeout_minutes: int = LOGIN_TIMEOUT_MINUTES) -> bool:
        print("Starting re-authentication...")
        self.clear_auth()
        return self.setup_auth(headless, timeout_minutes)

    def validate_auth(self) -> bool:
        if not self.is_authenticated():
            return False

        print("Validating authentication...")
        playwright = None
        context = None

        try:
            playwright = sync_playwright().start()
            context = BrowserFactory.launch_persistent_context(playwright, headless=True)

            page = context.new_page()
            page.goto(LINKEDIN_FEED_URL, wait_until="domcontentloaded", timeout=30000)

            if "linkedin.com/feed" in page.url and "login" not in page.url:
                print("  Authentication is valid")
                return True
            else:
                print("  Authentication is invalid (redirected to login)")
                return False

        except Exception as e:
            print(f"  Validation failed: {e}")
            return False

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


def main():
    parser = argparse.ArgumentParser(description='Manage LinkedIn authentication')
    subparsers = parser.add_subparsers(dest='command', help='Commands')

    setup_parser = subparsers.add_parser('setup', help='Setup authentication')
    setup_parser.add_argument('--headless', action='store_true')
    setup_parser.add_argument('--timeout', type=float, default=LOGIN_TIMEOUT_MINUTES)

    subparsers.add_parser('status', help='Check authentication status')
    subparsers.add_parser('validate', help='Validate authentication')
    subparsers.add_parser('clear', help='Clear authentication')

    reauth_parser = subparsers.add_parser('reauth', help='Re-authenticate')
    reauth_parser.add_argument('--timeout', type=float, default=LOGIN_TIMEOUT_MINUTES)

    args = parser.parse_args()
    auth = AuthManager()

    if args.command == 'setup':
        if auth.setup_auth(headless=args.headless, timeout_minutes=args.timeout):
            print("\nAuthentication setup complete!")
        else:
            print("\nAuthentication setup failed")
            exit(1)

    elif args.command == 'status':
        info = auth.get_auth_info()
        print("\nAuthentication Status:")
        print(f"  Authenticated: {'Yes' if info['authenticated'] else 'No'}")
        if info.get('state_age_hours'):
            print(f"  State age: {info['state_age_hours']:.1f} hours")
        if info.get('authenticated_at_iso'):
            print(f"  Last auth: {info['authenticated_at_iso']}")

    elif args.command == 'validate':
        if auth.validate_auth():
            print("Authentication is valid and working")
        else:
            print("Authentication is invalid or expired. Run: auth_manager.py setup")

    elif args.command == 'clear':
        auth.clear_auth()

    elif args.command == 'reauth':
        if auth.re_auth(timeout_minutes=args.timeout):
            print("\nRe-authentication complete!")
        else:
            print("\nRe-authentication failed")
            exit(1)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()

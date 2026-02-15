/**
 * Claude OAuth Implementation
 *
 * Uses PKCE flow with manual code entry (user copies code from browser).
 * Based on Claude Code's OAuth implementation.
 */

import crypto from 'crypto';
import { net, shell } from 'electron';
import { SettingsManager } from '../settings';

// OAuth Configuration (same as Claude Code)
const OAUTH_CONFIG = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
};

interface PKCEPair {
  verifier: string;
  challenge: string;
  state: string;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

class ClaudeOAuthManager {
  private static instance: ClaudeOAuthManager | null = null;
  private currentPKCE: PKCEPair | null = null;
  private pendingAuth: boolean = false;

  private constructor() {}

  static getInstance(): ClaudeOAuthManager {
    if (!ClaudeOAuthManager.instance) {
      ClaudeOAuthManager.instance = new ClaudeOAuthManager();
    }
    return ClaudeOAuthManager.instance;
  }

  /**
   * Generate PKCE pair for OAuth
   */
  private generatePKCE(): PKCEPair {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    return { verifier, challenge, state };
  }

  /**
   * Build authorization URL
   */
  private getAuthorizationURL(): string {
    this.currentPKCE = this.generatePKCE();

    const params = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
      response_type: 'code',
      redirect_uri: OAUTH_CONFIG.redirectUri,
      scope: OAUTH_CONFIG.scopes,
      code_challenge: this.currentPKCE.challenge,
      code_challenge_method: 'S256',
      state: this.currentPKCE.state,
    });

    return `${OAUTH_CONFIG.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Start OAuth flow - opens browser for user to authenticate
   */
  async startFlow(): Promise<{ success: boolean; error?: string }> {
    try {
      const authUrl = this.getAuthorizationURL();
      this.pendingAuth = true;

      // Open browser for authentication
      await shell.openExternal(authUrl);

      return { success: true };
    } catch (error) {
      this.pendingAuth = false;
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start OAuth flow',
      };
    }
  }

  /**
   * Check if OAuth flow is pending (waiting for code)
   */
  isPending(): boolean {
    return this.pendingAuth;
  }

  /**
   * Complete OAuth flow with authorization code from user
   */
  async completeWithCode(code: string): Promise<{ success: boolean; error?: string }> {
    if (!this.currentPKCE) {
      return { success: false, error: 'No pending OAuth flow' };
    }

    try {
      const tokens = await this.exchangeCodeForTokens(code, this.currentPKCE);

      // Save tokens securely
      SettingsManager.set('auth.method', 'oauth');
      SettingsManager.set('auth.oauthToken', tokens.accessToken);
      SettingsManager.set('auth.refreshToken', tokens.refreshToken);
      SettingsManager.set('auth.tokenExpiresAt', tokens.expiresAt.toString());

      this.pendingAuth = false;
      this.currentPKCE = null;

      console.log('[OAuth] Successfully authenticated');
      return { success: true };
    } catch (error) {
      this.pendingAuth = false;
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to exchange code for tokens',
      };
    }
  }

  /**
   * Exchange authorization code for tokens
   */
  private async exchangeCodeForTokens(code: string, pkce: PKCEPair): Promise<OAuthTokens> {
    // Handle code#state format (user pastes the full callback code)
    const parts = code.trim().split('#');
    const authCode = parts[0];
    const state = parts.length > 1 ? parts[1] : pkce.state;

    console.log('[OAuth] Exchanging code:', {
      codeLength: authCode.length,
      hasState: parts.length > 1,
      stateMatch: state === pkce.state
    });

    const response = await net.fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: authCode,
        state: state,
        code_verifier: pkce.verifier,
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: OAUTH_CONFIG.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${errorText}`);
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  /**
   * Refresh access token if needed
   */
  async refreshTokenIfNeeded(): Promise<boolean> {
    const expiresAt = parseInt(SettingsManager.get('auth.tokenExpiresAt') || '0', 10);
    const refreshToken = SettingsManager.get('auth.refreshToken');

    // Check if token expires within 60 seconds
    if (Date.now() < expiresAt - 60000) {
      return true; // Token still valid
    }

    if (!refreshToken) {
      return false;
    }

    try {
      const tokens = await this.refreshAccessToken(refreshToken);

      SettingsManager.set('auth.oauthToken', tokens.accessToken);
      SettingsManager.set('auth.refreshToken', tokens.refreshToken);
      SettingsManager.set('auth.tokenExpiresAt', tokens.expiresAt.toString());

      console.log('[OAuth] Token refreshed');
      return true;
    } catch (error) {
      console.error('[OAuth] Token refresh failed:', error);
      return false;
    }
  }

  /**
   * Refresh access token
   */
  private async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const response = await net.fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        client_id: OAUTH_CONFIG.clientId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${errorText}`);
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  /**
   * Get current access token (refreshing if needed)
   */
  async getAccessToken(): Promise<string | null> {
    const authMethod = SettingsManager.get('auth.method');
    if (authMethod !== 'oauth') {
      return null;
    }

    const refreshed = await this.refreshTokenIfNeeded();
    if (!refreshed) {
      return null;
    }

    return SettingsManager.get('auth.oauthToken') || null;
  }

  /**
   * Cancel pending OAuth flow
   */
  cancelFlow(): void {
    this.pendingAuth = false;
    this.currentPKCE = null;
  }

  /**
   * Clear stored OAuth credentials
   */
  logout(): void {
    SettingsManager.set('auth.method', '');
    SettingsManager.set('auth.oauthToken', '');
    SettingsManager.set('auth.refreshToken', '');
    SettingsManager.set('auth.tokenExpiresAt', '');
    this.pendingAuth = false;
    this.currentPKCE = null;
  }
}

export const ClaudeOAuth = ClaudeOAuthManager.getInstance();

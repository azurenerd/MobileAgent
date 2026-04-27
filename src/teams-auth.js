/**
 * Microsoft Teams OAuth authentication — PKCE browser flow + device code fallback.
 *
 * Adapted from Squad framework's comms-teams.ts pattern.
 * Uses the Microsoft Graph PowerShell first-party client ID by default.
 * Tokens cached per-identity in ~/.copilot/teams-tokens-{hash}.json.
 *
 * @module teams-auth
 */

import { join } from 'path';
import { homedir, platform } from 'os';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  chmodSync, unlinkSync,
} from 'fs';
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { execFile } from 'child_process';
import { createLogger } from './logger.js';

const log = createLogger('teams-auth');

// ─── Constants ──────────────────────────────────────────────────────

const SCOPES = 'Chat.ReadWrite ChatMessage.Send ChatMessage.Read User.Read offline_access';
const TOKEN_DIR = join(homedir(), '.copilot');
const PERMANENT_AUTH_ERRORS = ['invalid_grant', 'interaction_required', 'consent_required', 'invalid_client'];

// ─── Token Storage ──────────────────────────────────────────────────

function getTokenPath(tenantId, clientId) {
  const hash = createHash('sha256').update(`${tenantId}:${clientId}`).digest('hex').slice(0, 16);
  return join(TOKEN_DIR, `teams-tokens-${hash}.json`);
}

export function loadTokens(tenantId, clientId) {
  const tokenPath = getTokenPath(tenantId, clientId);
  try {
    if (!existsSync(tokenPath)) return null;
    const raw = readFileSync(tokenPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.accessToken || !parsed.expiresAt || !parsed.refreshToken) return null;
    if (parsed.configTenantId && parsed.configTenantId !== tenantId) return null;
    if (parsed.clientId && parsed.clientId !== clientId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveTokens(tenantId, clientId, tokens) {
  const tokenPath = getTokenPath(tenantId, clientId);
  if (!existsSync(TOKEN_DIR)) {
    mkdirSync(TOKEN_DIR, { recursive: true });
  }
  const jwtClaims = extractJwtClaims(tokens.accessToken);
  const withMeta = {
    ...tokens,
    configTenantId: tenantId,
    clientId,
    authenticatedTenantId: jwtClaims.tid,
    authenticatedUserId: jwtClaims.oid,
  };
  writeFileSync(tokenPath, JSON.stringify(withMeta, null, 2), { encoding: 'utf-8' });

  // Restrict file permissions
  if (platform() === 'win32') {
    execFile('icacls', [
      tokenPath, '/inheritance:r', '/grant:r',
      `${process.env.USERNAME ?? 'CURRENT_USER'}:(R,W)`,
    ], (err) => {
      if (err) log.warn('Could not restrict token file permissions:', err.message);
    });
  } else {
    try { chmodSync(tokenPath, 0o600); } catch {}
  }
}

export function clearTokens(tenantId, clientId) {
  const tokenPath = getTokenPath(tenantId, clientId);
  try {
    if (existsSync(tokenPath)) unlinkSync(tokenPath);
  } catch {}
}

function extractJwtClaims(accessToken) {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3 || !parts[1]) return {};
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    return {
      tid: typeof decoded.tid === 'string' ? decoded.tid : undefined,
      oid: typeof decoded.oid === 'string' ? decoded.oid : undefined,
    };
  } catch {
    return {};
  }
}

function parseTokenResponse(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// ─── Base64-URL ─────────────────────────────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Browser Auth (Authorization Code + PKCE) ────────────────────────

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Copilot Mobile — Authenticated</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
.card{text-align:center;padding:2rem 3rem;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{margin:0 0 .5rem;font-size:1.4rem}p{color:#555;margin:0}</style></head>
<body><div class="card"><h1>✅ Authentication successful!</h1><p>You can close this tab and return to the terminal.</p></div></body></html>`;

function openBrowser(url) {
  const p = platform();
  if (p === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`], () => {});
  } else if (p === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function startBrowserAuthFlow(tenantId, clientId) {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const oauthState = base64url(randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://localhost');
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      const returnedState = reqUrl.searchParams.get('state');

      if (error) {
        const errorDesc = reqUrl.searchParams.get('error_description') ?? '';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authentication failed</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(errorDesc)}</p></body></html>`);
        cleanup();
        reject(new Error(`Browser auth denied: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing authorization code');
        return;
      }

      if (returnedState !== oauthState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid state parameter');
        cleanup();
        reject(new Error('OAuth state mismatch — possible CSRF'));
        return;
      }

      const redirectUri = `http://localhost:${server.address().port}`;
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

      try {
        const tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
            scope: SCOPES,
          }),
        });
        const data = await tokenRes.json();
        if (!data.access_token) {
          throw new Error(`Token exchange failed: ${data.error} — ${data.error_description}`);
        }
        const tokens = parseTokenResponse(data);
        saveTokens(tenantId, clientId, tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        cleanup();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Token exchange failed');
        cleanup();
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Browser auth timed out after 120 seconds'));
    }, 120_000);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.on('error', (err) => {
      cleanup();
      reject(new Error(`OAuth callback server failed: ${err.message}`));
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}`;
      const authorizeUrl =
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&code_challenge_method=S256` +
        `&state=${encodeURIComponent(oauthState)}` +
        `&prompt=select_account`;

      log.info('Opening browser for Teams authentication...');
      openBrowser(authorizeUrl);
    });
  });
}

// ─── Device Code Flow (fallback) ─────────────────────────────────────

async function startDeviceCodeFlow(tenantId, clientId) {
  const deviceCodeUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`;
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const dcRes = await fetch(deviceCodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
  });
  if (!dcRes.ok) {
    throw new Error(`Device code request failed: ${dcRes.status} ${await dcRes.text()}`);
  }
  const dcData = await dcRes.json();

  console.log(`\n🔐 Teams authentication required`);
  console.log(`   ${dcData.message}\n`);

  const pollInterval = Math.max(2000, Math.min((dcData.interval || 5) * 1000, 30000));
  const deadline = Date.now() + Math.min((dcData.expires_in || 900) * 1000, 15 * 60 * 1000);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: dcData.device_code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      const tokens = parseTokenResponse(tokenData);
      saveTokens(tenantId, clientId, tokens);
      console.log('✅ Teams authentication successful — tokens saved\n');
      return tokens;
    }
    if (tokenData.error === 'authorization_pending') continue;
    if (tokenData.error === 'slow_down') {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw new Error(`Device code auth failed: ${tokenData.error} — ${tokenData.error_description}`);
  }
  throw new Error('Device code flow timed out');
}

// ─── Token Refresh ──────────────────────────────────────────────────

async function refreshAccessToken(tenantId, clientId, refreshToken) {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      scope: SCOPES,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    const err = new Error(`Token refresh failed: ${data.error} — ${data.error_description}`);
    err.authError = data.error ?? 'unknown';
    throw err;
  }
  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tenantId, clientId, tokens);
  return tokens;
}

// ─── TeamsAuth class ────────────────────────────────────────────────

export class TeamsAuth {
  constructor(clientId, tenantId) {
    this.clientId = clientId;
    this.tenantId = tenantId;
    this.tokens = null;
    this.cachedUserId = null;
  }

  /**
   * Ensure we have a valid access token.
   * Priority: cached → refresh → browser PKCE → device code fallback.
   */
  async ensureAuthenticated() {
    if (!this.tokens) {
      this.tokens = loadTokens(this.tenantId, this.clientId);
      if (this.tokens) this.cachedUserId = null;
    }

    // Valid token — return it
    if (this.tokens && Date.now() < this.tokens.expiresAt - 60_000) {
      return this.tokens.accessToken;
    }

    // Expired but have refresh token — try refresh
    if (this.tokens?.refreshToken) {
      try {
        this.tokens = await refreshAccessToken(this.tenantId, this.clientId, this.tokens.refreshToken);
        this.cachedUserId = null;
        return this.tokens.accessToken;
      } catch (err) {
        const authError = err.authError ?? '';
        if (PERMANENT_AUTH_ERRORS.includes(authError)) {
          clearTokens(this.tenantId, this.clientId);
          this.tokens = null;
          this.cachedUserId = null;
          log.warn(`Token refresh permanently failed (${authError}) — re-authenticating...`);
        } else {
          log.warn('Token refresh failed (transient) — re-authenticating...');
        }
      }
    }

    // Try browser auth first
    try {
      this.tokens = await startBrowserAuthFlow(this.tenantId, this.clientId);
      this.cachedUserId = null;
      log.info('Teams authentication successful — tokens saved');
      return this.tokens.accessToken;
    } catch {
      log.info('Browser auth unavailable, falling back to device code...');
    }

    // Fallback — device code
    this.tokens = await startDeviceCodeFlow(this.tenantId, this.clientId);
    this.cachedUserId = null;
    return this.tokens.accessToken;
  }

  async logout() {
    clearTokens(this.tenantId, this.clientId);
    this.tokens = null;
    this.cachedUserId = null;
  }

  /** Get authenticated user's Graph ID */
  getMyUserId() {
    return this.cachedUserId;
  }

  setMyUserId(userId) {
    this.cachedUserId = userId;
  }
}

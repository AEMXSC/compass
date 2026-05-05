/**
 * aem-connect-server.mjs
 *
 * Persistent local OAuth helper — same pattern Claude Code uses.
 * Runs on http://localhost:80, catches oauth.adobeaemcloud.com callbacks,
 * exchanges the code for a write-capable MCP token, and serves it to Compass.
 *
 * Chrome allows HTTPS pages (Compass) to fetch http://localhost without
 * mixed-content blocking — localhost is a trusted origin per the W3C spec.
 *
 * First-run setup (one-time, admin PowerShell):
 *   netsh http add urlacl url=http://localhost/ user=Everyone
 * After that, start without admin:
 *   node scripts/aem-connect-server.mjs
 *
 * Or just use start-aem-connect.bat which handles first-run setup.
 */

import http from 'http';
import { createHash, randomBytes } from 'crypto';
import { execSync } from 'child_process';

const CLIENT_ID = 'MTAwNy1VOUJTNS15QUdRUnhTTVlZZzFUcDV3LmhWLUlvNVNPZEl3dURaaTNEV0RxMHZ4WU1uSmt6SnYy';
const CLIENT_SECRET = '1007-U9BS5-yAGQRxSMYYg1Tp5whV-Io5SOdIwuDZi3DWDq0vxYMnJkzJv2Bd2jjwP9J362Ev_aFF0MKbeaN7cyRivr_-Xb7Fk2mUY';
const REDIRECT_URI = 'http://localhost';
const AUTH_BASE = 'https://oauth.adobeaemcloud.com';
const COMPASS_ORIGIN = 'https://eds-migration--compass--aemxsc.aem.page';
const PORT = 80;

// In-memory token state — one user per machine, ephemeral
let currentToken = null;       // { access_token, refresh_token, expires_at }
let pendingVerifier = null;    // codeVerifier for in-flight auth

function corsHeaders(origin) {
  // Only serve Compass or localhost (no open CORS)
  const allowed = origin === COMPASS_ORIGIN || (origin || '').startsWith('http://localhost');
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || COMPASS_ORIGIN) : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function tokenExpired() {
  return !currentToken || Date.now() >= currentToken.expires_at - 60_000;
}

async function refreshToken() {
  if (!currentToken?.refresh_token) return false;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: currentToken.refresh_token,
    });
    const resp = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json();
    if (data.access_token) {
      currentToken = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || currentToken.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      };
      console.log('[AEM Connect] Token refreshed');
      return true;
    }
  } catch { /* */ }
  return false;
}

function startAuthFlow(res, origin = '') {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  pendingVerifier = codeVerifier;

  const authUrl = `${AUTH_BASE}/oauth/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  // Open the browser to the auth URL
  try { execSync(`start "" "${authUrl}"`, { stdio: 'ignore' }); } catch { /* */ }

  console.log('[AEM Connect] Auth flow started — waiting for callback...');
  res.writeHead(202, corsHeaders(origin));
  res.end(JSON.stringify({ status: 'auth_required', message: 'Browser opened for authentication' }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin || '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  // GET /token — Compass calls this to get the current token
  if (url.pathname === '/token' && req.method === 'GET') {
    // Auto-refresh if close to expiry
    if (tokenExpired() && currentToken?.refresh_token) {
      await refreshToken();
    }

    if (!tokenExpired()) {
      res.writeHead(200, corsHeaders(origin));
      res.end(JSON.stringify({
        access_token: currentToken.access_token,
        expires_in: Math.round((currentToken.expires_at - Date.now()) / 1000),
      }));
      return;
    }

    // No valid token — kick off auth flow
    startAuthFlow(res, origin);
    return;
  }

  // GET / — OAuth callback from adobe.adobeaemcloud.com
  if (url.pathname === '/' && url.searchParams.has('code')) {
    const code = url.searchParams.get('code');

    if (!pendingVerifier) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font:14px system-ui;padding:2rem;color:#dc2626">No pending auth flow. Try connecting from Compass again.</body></html>');
      return;
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pendingVerifier,
    });
    pendingVerifier = null;

    try {
      const tokenResp = await fetch(`${AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      });
      const data = await tokenResp.json();

      if (data.access_token) {
        currentToken = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || null,
          expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        };
        const expiresHrs = Math.round((data.expires_in || 3600) / 3600);
        console.log(`[AEM Connect] Token stored (expires ~${expiresHrs}h)`);

        // Redirect back to Compass — it will poll /token and get the fresh token
        res.writeHead(302, { Location: COMPASS_ORIGIN });
        res.end();
      } else {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font:14px system-ui;padding:2rem;color:#dc2626">Token exchange failed: ${JSON.stringify(data)}</body></html>`);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font:14px system-ui;padding:2rem;color:#dc2626">Error: ${err.message}</body></html>`);
    }
    return;
  }

  // GET /status — health check
  if (url.pathname === '/status') {
    res.writeHead(200, corsHeaders(origin));
    res.end(JSON.stringify({
      running: true,
      authenticated: !tokenExpired(),
      expires_in: currentToken ? Math.round((currentToken.expires_at - Date.now()) / 1000) : 0,
    }));
    return;
  }

  res.writeHead(204);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n[AEM Connect] Listening on http://localhost:${PORT}`);
  console.log('[AEM Connect] Compass can now connect AEM Content automatically.\n');
  console.log('Press Ctrl+C to stop.\n');
}).on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error('\n[AEM Connect] Port 80 requires elevated permissions.');
    console.error('Run this one-time command in an admin PowerShell, then restart:\n');
    console.error('  netsh http add urlacl url=http://localhost/ user=Everyone\n');
  } else if (err.code === 'EADDRINUSE') {
    console.error('\n[AEM Connect] Port 80 is in use by another service (IIS, Apache, etc.).');
    console.error('Stop that service first, then restart.\n');
  } else {
    console.error('[AEM Connect] Error:', err.message);
  }
  process.exit(1);
});

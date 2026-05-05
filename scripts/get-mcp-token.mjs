/**
 * get-mcp-token.mjs
 *
 * Runs the oauth.adobeaemcloud.com PKCE flow with a real localhost server,
 * then redirects the browser directly to Compass with the token in the URL hash.
 * Compass detects the hash on load and stores the token automatically — no copy/paste.
 *
 * Usage (must run as Administrator for port 80):
 *   node scripts/get-mcp-token.mjs
 *
 * Or use the companion launcher:
 *   scripts/connect-aem.bat   (right-click → Run as Administrator)
 */

import http from 'http';
import { createHash, randomBytes } from 'crypto';
import { execSync } from 'child_process';

const CLIENT_ID = 'MTAwNy1VOUJTNS15QUdRUnhTTVlZZzFUcDV3LmhWLUlvNVNPZEl3dURaaTNEV0RxMHZ4WU1uSmt6SnYy';
const CLIENT_SECRET = '1007-U9BS5-yAGQRxSMYYg1Tp5whV-Io5SOdIwuDZi3DWDq0vxYMnJkzJv2Bd2jjwP9J362Ev_aFF0MKbeaN7cyRivr_-Xb7Fk2mUY';
const REDIRECT_URI = 'http://localhost';
const AUTH_BASE = 'https://oauth.adobeaemcloud.com';
const COMPASS_URL = 'https://eds-migration--compass--aemxsc.aem.page/';

// Generate PKCE
const codeVerifier = randomBytes(32).toString('base64url');
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
const state = randomBytes(16).toString('base64url');

const authUrl = `${AUTH_BASE}/oauth/authorize?` + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
  state,
}).toString();

console.log('\nOpening AEM Content MCP authentication...');
console.log('Sign in with your Adobe ID in the browser window that opens.\n');

function openBrowser(url) {
  try { execSync(`start "" "${url}"`, { stdio: 'ignore' }); return; } catch { /* */ }
  try { execSync(`open "${url}"`, { stdio: 'ignore' }); } catch { /* */ }
}

openBrowser(authUrl);

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const code = reqUrl.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body style="font:14px system-ui;padding:2rem;color:#dc2626">No auth code received. Close this and try again.</body></html>');
    server.close();
    return;
  }

  // Exchange code for token
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  let tokenData;
  try {
    const resp = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    tokenData = await resp.json();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font:14px system-ui;padding:2rem;color:#dc2626">Token exchange error: ${err.message}</body></html>`);
    server.close();
    return;
  }

  if (!tokenData.access_token) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font:14px system-ui;padding:2rem;color:#dc2626">Token exchange failed: ${JSON.stringify(tokenData)}</body></html>`);
    server.close();
    return;
  }

  // Build redirect URL — Compass reads the hash and stores the token automatically
  const params = new URLSearchParams({ mcp_token: tokenData.access_token });
  if (tokenData.refresh_token) params.set('mcp_refresh', tokenData.refresh_token);
  const compassRedirect = `${COMPASS_URL}#${params.toString()}`;

  // Redirect the browser tab (the one that hit localhost) to Compass with token
  res.writeHead(302, { Location: compassRedirect });
  res.end();

  const expiresHrs = Math.round((tokenData.expires_in || 3600) / 3600);
  console.log(`✓ Token acquired (expires ~${expiresHrs}h). Compass is opening...`);
  server.close();
});

server.listen(80, '127.0.0.1', () => {
  console.log('Waiting for OAuth callback on http://localhost...');
}).on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error('\n✗ Port 80 requires Administrator privileges.\n');
    console.error('Right-click the .bat file and choose "Run as Administrator".\n');
  } else if (err.code === 'EADDRINUSE') {
    console.error('\n✗ Port 80 is already in use by another process (IIS, Apache, etc.).\n');
    console.error('Stop that service first, then retry.\n');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

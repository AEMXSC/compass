/**
 * Cloudflare Worker — Compass Auth Gateway
 *
 * Routes:
 *   GET  /auth              → S2S access token (Adobe IMS, CORS-protected)
 *   POST /token             → Legacy CORS proxy for IMS token exchange
 *   GET  /github/login      → Redirect to GitHub OAuth authorize
 *   GET  /github/callback   → Exchange code for token, redirect back to Compass
 *
 * Secrets (set via wrangler secret put):
 *   IMS_CLIENT_ID        — from Adobe Developer Console
 *   IMS_CLIENT_SECRET     — from Adobe Developer Console
 *   GITHUB_CLIENT_ID     — from GitHub OAuth App settings
 *   GITHUB_CLIENT_SECRET  — from GitHub OAuth App settings
 */

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const IMS_SCOPE = 'aem.frontend.all,openid,AdobeID,read_organizations,additional_info.projectedProductContext';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_SCOPE = 'repo,user';

const ALLOWED_ORIGINS = [
  'https://aemxsc.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
];

// Allowed return-to base URLs (must start with one of these)
const ALLOWED_RETURN_URLS = [
  'https://aemxsc.github.io/compass/',
  'http://localhost:3000/',
  'http://localhost:3001/',
];

// Cache the S2S token in memory (lives as long as the Worker instance)
let cachedToken = null;
let tokenExpiry = 0;

// CSRF state uses HMAC-signed tokens (stateless — works across all Worker isolates).
// State format: base64url(JSON({ returnTo, exp, nonce })) + '.' + base64url(HMAC-SHA256)
const STATE_TTL_MS = 600000; // 10 minutes

/* ─── Router ─── */

addEventListener('fetch', (event) => {
  event.respondWith(route(event.request));
});

async function route(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return handleCors(request);
  }
  if (url.pathname === '/auth' && request.method === 'GET') {
    return handleAuth(request);
  }
  if (url.pathname === '/github/login' && request.method === 'GET') {
    return handleGitHubLogin(request);
  }
  if (url.pathname === '/github/callback' && request.method === 'GET') {
    return handleGitHubCallback(request);
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    return handleTokenProxy(request);
  }
  if (request.method === 'POST') {
    return handleTokenProxy(request);
  }

  return new Response('Compass Auth Gateway', { status: 200 });
}

/* ─── GET /auth — S2S token for Compass ─── */

async function handleAuth(request) {
  const origin = request.headers.get('Origin') || '';

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders(origin) });
  }

  // Check secrets
  if (typeof IMS_CLIENT_ID === 'undefined' || !IMS_CLIENT_ID) {
    return jsonResponse({ error: 'IMS_CLIENT_ID not configured' }, 500, origin);
  }
  if (typeof IMS_CLIENT_SECRET === 'undefined' || !IMS_CLIENT_SECRET) {
    return jsonResponse({ error: 'IMS_CLIENT_SECRET not configured' }, 500, origin);
  }

  // Return cached token if still valid (with 5 min buffer)
  const now = Date.now();
  if (cachedToken && tokenExpiry > now + 300000) {
    return jsonResponse({ access_token: cachedToken, expires_at: tokenExpiry, cached: true }, 200, origin);
  }

  // Generate new S2S token via client_credentials
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: IMS_CLIENT_ID,
      client_secret: IMS_CLIENT_SECRET,
      scope: IMS_SCOPE,
    });

    const imsResp = await fetch(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!imsResp.ok) {
      const errText = await imsResp.text();
      console.error('S2S token generation failed:', imsResp.status, errText);
      return jsonResponse({ error: 'token_generation_failed', details: errText }, imsResp.status, origin);
    }

    const data = await imsResp.json();

    if (!data.access_token) {
      return jsonResponse({ error: 'no_access_token', response: data }, 502, origin);
    }

    // Cache it (expires_in is in milliseconds from IMS)
    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in || 86400000);

    return jsonResponse({
      access_token: data.access_token,
      expires_at: tokenExpiry,
    }, 200, origin);
  } catch (err) {
    console.error('S2S auth error:', err);
    return jsonResponse({ error: err.message }, 502, origin);
  }
}

/* ─── GET /github/login — Redirect to GitHub OAuth ─── */

async function handleGitHubLogin(request) {
  const url = new URL(request.url);

  // Check GitHub secrets
  if (typeof GITHUB_CLIENT_ID === 'undefined' || !GITHUB_CLIENT_ID) {
    return new Response('GITHUB_CLIENT_ID not configured', { status: 500 });
  }
  if (typeof GITHUB_CLIENT_SECRET === 'undefined' || !GITHUB_CLIENT_SECRET) {
    return new Response('GITHUB_CLIENT_SECRET not configured', { status: 500 });
  }

  // Validate return_to URL
  const returnTo = url.searchParams.get('return_to') || ALLOWED_RETURN_URLS[0];
  if (!ALLOWED_RETURN_URLS.some((allowed) => returnTo.startsWith(allowed))) {
    return new Response('Invalid return_to URL', { status: 400 });
  }

  // Generate HMAC-signed state (stateless — no in-memory storage needed)
  const state = await signState({ returnTo, exp: Date.now() + STATE_TTL_MS, nonce: crypto.randomUUID() });

  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = '/github/callback';
  callbackUrl.search = '';

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl.toString(),
    scope: GITHUB_SCOPE,
    state,
  });

  return Response.redirect(`${GITHUB_AUTHORIZE_URL}?${params}`, 302);
}

/* ─── GET /github/callback — Exchange code for token ─── */

async function handleGitHubCallback(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response('Missing code or state parameter', { status: 400 });
  }

  // Check GitHub secrets
  if (typeof GITHUB_CLIENT_ID === 'undefined' || !GITHUB_CLIENT_ID ||
      typeof GITHUB_CLIENT_SECRET === 'undefined' || !GITHUB_CLIENT_SECRET) {
    return new Response('GitHub OAuth not configured', { status: 500 });
  }

  // Verify HMAC-signed state (stateless — works across all Worker isolates)
  const payload = await verifyState(state);
  if (!payload) {
    return new Response('Invalid or expired state. Please try signing in again.', { status: 403 });
  }
  const { returnTo } = payload;

  // Exchange code for access token
  try {
    const tokenResp = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenResp.ok) {
      console.error('GitHub token exchange failed:', tokenResp.status);
      return new Response('GitHub token exchange failed', { status: 502 });
    }

    const data = await tokenResp.json();

    if (data.error) {
      console.error('GitHub OAuth error:', data.error, data.error_description);
      return new Response(`GitHub error: ${data.error_description || data.error}`, { status: 400 });
    }

    if (!data.access_token) {
      return new Response('No access token returned from GitHub', { status: 502 });
    }

    // Redirect back to Compass with the token in a fragment (not query param).
    // Fragments are never sent to servers, proxies, or in Referer headers.
    const redirectUrl = `${returnTo}#github_token=${encodeURIComponent(data.access_token)}`;

    return Response.redirect(redirectUrl, 302);
  } catch (err) {
    console.error('GitHub callback error:', err);
    return new Response(`OAuth error: ${err.message}`, { status: 502 });
  }
}

/* ─── POST /token (legacy CORS proxy) ─── */

async function handleTokenProxy(request) {
  const origin = request.headers.get('Origin') || '';

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const body = await request.text();
    const imsResp = await fetch(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const imsBody = await imsResp.text();
    return new Response(imsBody, {
      status: imsResp.status,
      headers: {
        'Content-Type': imsResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(origin),
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

/* ─── CORS ─── */

function handleCors(request) {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/* ─── Helpers ─── */

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/* ─── HMAC-signed CSRF State (stateless) ─── */

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - str.length % 4) % 4);
  const binary = atob(padded);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

async function getHmacKey() {
  const enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(GITHUB_CLIENT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signState(payload) {
  const data = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await getHmacKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${base64url(sig)}`;
}

async function verifyState(state) {
  try {
    const [data, sig] = state.split('.');
    if (!data || !sig) return null;
    const key = await getHmacKey();
    const valid = await crypto.subtle.verify('HMAC', key, base64urlDecode(sig), new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(data)));
    if (payload.exp < Date.now()) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

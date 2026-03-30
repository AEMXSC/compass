/**
 * Cloudflare Worker — Compass Auth Gateway
 *
 * S2S (Server-to-Server) OAuth: the Worker holds the credential,
 * generates tokens via client_credentials grant, and serves them
 * to Compass. No per-user IMS sign-in needed.
 *
 * Routes:
 *   GET  /auth   → Returns S2S access token (CORS-protected)
 *   POST /token  → Legacy CORS proxy for direct token exchange
 *
 * Secrets (set via wrangler secret put):
 *   IMS_CLIENT_ID      — from Adobe Developer Console
 *   IMS_CLIENT_SECRET   — from Adobe Developer Console
 */

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const IMS_SCOPE = 'aem.frontend.all,openid,AdobeID,read_organizations,additional_info.projectedProductContext';

const ALLOWED_ORIGINS = [
  'https://aemxsc.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
];

// Cache the S2S token in memory (lives as long as the Worker instance)
let cachedToken = null;
let tokenExpiry = 0;

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

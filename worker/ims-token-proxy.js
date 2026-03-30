/**
 * Cloudflare Worker — IMS OAuth BFF (Backend for Frontend)
 *
 * Routes:
 *   GET  /login    → Redirects to Adobe IMS authorize
 *   GET  /callback → Exchanges auth code for token, redirects to Compass
 *   POST /token    → CORS proxy for direct token exchange (legacy)
 *
 * Setup:
 *   1. Create OAuth Web App in Adobe Developer Console
 *   2. Set redirect URI: https://compass-ims-proxy.compass-xsc.workers.dev/callback
 *   3. wrangler secret put IMS_CLIENT_ID
 *   4. wrangler secret put IMS_CLIENT_SECRET
 *   5. npx wrangler deploy
 */

const IMS_AUTH_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

const IMS_SCOPE = 'AdobeID,openid,session,additional_info.projectedProductContext';

const ALLOWED_REDIRECTS = [
  'https://aemxsc.github.io/compass/',
  'http://localhost:3000/',
  'http://localhost:3001/',
];

const ALLOWED_ORIGINS = [
  'https://aemxsc.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
];

/* ─── Router ─── */

addEventListener('fetch', (event) => {
  event.respondWith(route(event.request));
});

async function route(request) {
  const url = new URL(request.url);

  if (url.pathname === '/login' && request.method === 'GET') {
    return handleLogin(request);
  }
  if (url.pathname === '/callback' && request.method === 'GET') {
    return handleCallback(request);
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    return handleTokenProxy(request);
  }

  // Legacy: POST to root also proxies tokens
  if (request.method === 'POST') {
    return handleTokenProxy(request);
  }
  if (request.method === 'OPTIONS') {
    return handleCors(request);
  }

  return new Response('Not found', { status: 404 });
}

/* ─── GET /login ─── */

async function handleLogin(request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('redirect') || ALLOWED_REDIRECTS[0];

  // Validate redirect target
  if (!ALLOWED_REDIRECTS.some((r) => returnTo.startsWith(r))) {
    return new Response('Invalid redirect target', { status: 400 });
  }

  // Client ID from wrangler secret (global in Service Worker format)
  if (typeof IMS_CLIENT_ID === 'undefined' || !IMS_CLIENT_ID) {
    return new Response('Server misconfigured: IMS_CLIENT_ID not set', { status: 500 });
  }

  const callbackUrl = `${url.origin}/callback`;

  // State encodes both CSRF nonce and the return URL
  const nonce = crypto.randomUUID();
  const stateObj = { n: nonce, r: returnTo };
  const stateB64 = btoa(JSON.stringify(stateObj));

  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: callbackUrl,
    scope: IMS_SCOPE,
    state: stateB64,
    locale: 'en_US',
  });

  return new Response(null, {
    status: 302,
    headers: {
      'Location': `${IMS_AUTH_URL}?${params}`,
      'Set-Cookie': `ims_nonce=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  });
}

/* ─── GET /callback ─── */

async function handleCallback(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateB64 = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');

  // Default redirect on error
  const fallbackRedirect = ALLOWED_REDIRECTS[0];

  // Parse state
  let returnTo = fallbackRedirect;
  let expectedNonce = '';
  try {
    const stateObj = JSON.parse(atob(stateB64));
    expectedNonce = stateObj.n || '';
    returnTo = stateObj.r || fallbackRedirect;
    // Re-validate redirect
    if (!ALLOWED_REDIRECTS.some((r) => returnTo.startsWith(r))) {
      returnTo = fallbackRedirect;
    }
  } catch { /* use fallback */ }

  // IMS returned an error
  if (error) {
    const msg = errorDesc || error;
    return redirect302(returnTo, `error=${encodeURIComponent(msg)}`);
  }
  if (!code) {
    return redirect302(returnTo, 'error=missing_code');
  }

  // Validate CSRF nonce from cookie
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  if (cookies.ims_nonce !== expectedNonce) {
    return redirect302(returnTo, 'error=state_mismatch');
  }

  // Exchange code for token (server-side — no CORS issues)
  if (typeof IMS_CLIENT_SECRET === 'undefined' || !IMS_CLIENT_SECRET) {
    return redirect302(returnTo, 'error=server_misconfigured');
  }

  const callbackUrl = `${url.origin}/callback`;

  try {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: IMS_CLIENT_ID,
      client_secret: IMS_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
    });

    const imsResp = await fetch(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });

    if (!imsResp.ok) {
      const errText = await imsResp.text();
      console.error('Token exchange failed:', imsResp.status, errText);
      return redirect302(returnTo, 'error=token_exchange_failed');
    }

    const data = await imsResp.json();
    if (!data.access_token) {
      return redirect302(returnTo, 'error=no_access_token');
    }

    // Redirect to Compass with token in hash (hash never sent to server)
    return new Response(null, {
      status: 302,
      headers: {
        'Location': `${returnTo}#access_token=${data.access_token}`,
        'Set-Cookie': 'ims_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Callback error:', err);
    return redirect302(returnTo, 'error=server_error');
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

/* ─── CORS preflight ─── */

function handleCors(request) {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/* ─── Helpers ─── */

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function redirect302(baseUrl, hashParams) {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': `${baseUrl}#${hashParams}`,
      'Cache-Control': 'no-store',
    },
  });
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return cookies;
}

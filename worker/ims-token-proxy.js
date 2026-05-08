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
const IMS_SCOPE = 'aem.frontend.all,openid,AdobeID,read_organizations,additional_info.projectedProductContext,firefly_api';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_SCOPE = 'repo,user';

// Allowed external MCP hosts the worker may proxy to
const ALLOWED_MCP_HOSTS = [
  'mcp.adobeaemcloud.com',
  'mcp-gateway.adobe.io',
  'aa-mcp.adobe.io',
  'cja-mcp.adobe.io',
  'rtcdp-mcp.adobe.io',
  'aep-mcp.adobe.io',
  'targetmcp.adobe.io',
  'ajo-mcp.adobe.io',
  'targetmcp.adobe.io',
  'express-mcp-service.adobe.io',
  'aep-ai-ama-stage.adobe.io',
  'emcee-stage.adobe.io',
  'm-mcp-demo.adobe.io',
  'spacecat.experiencecloud.live',
  'aemshowcase2.my.workfront.adobe.com',
];

const ALLOWED_ORIGINS = [
  'https://aemxsc.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
  'https://main--compass--aemxsc.aem.page',
  'https://eds-migration--compass--aemxsc.aem.page',
  'https://main--compass--aemxsc.aem.live',
  'https://compass.aemxsc.com',
];

// Allowed return-to base URLs (must start with one of these)
// Includes *.aem.page and *.aem.live for EDS-hosted Compass
const ALLOWED_RETURN_URLS = [
  'https://aemxsc.github.io/compass/',
  'http://localhost:3000/',
  'http://localhost:3001/',
  'https://main--compass--aemxsc.aem.page/',
  'https://eds-migration--compass--aemxsc.aem.page/',
  'https://main--compass--aemxsc.aem.live/',
  'https://compass.aemxsc.com/',
];

// Cache the S2S token in memory (lives as long as the Worker instance)
let cachedToken = null;
let tokenExpiry = 0;

async function getS2SToken(env) {
  const now = Date.now();
  if (cachedToken && tokenExpiry > now + 300000) return cachedToken;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.IMS_CLIENT_ID,
    client_secret: env.IMS_CLIENT_SECRET,
    scope: IMS_SCOPE,
  });
  const resp = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', { method: 'POST', body });
  if (!resp.ok) throw new Error('S2S token fetch failed');
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in ? data.expires_in * 1000 : 86400000);
  return cachedToken;
}

// CSRF state uses HMAC-signed tokens (stateless — works across all Worker isolates).
// State format: base64url(JSON({ returnTo, exp, nonce })) + '.' + base64url(HMAC-SHA256)
const STATE_TTL_MS = 600000; // 10 minutes

/* ─── Router ─── */

export default {
  async fetch(request, env) {
    return route(request, env);
  },
};

// Module-level env reference for secrets (set on each request)
let _env = {};

async function route(request, env) {
  _env = env || {};
  // Make secrets available globally for existing functions
  if (typeof globalThis.IMS_CLIENT_ID === 'undefined' && env?.IMS_CLIENT_ID) {
    globalThis.IMS_CLIENT_ID = env.IMS_CLIENT_ID;
    globalThis.IMS_CLIENT_SECRET = env.IMS_CLIENT_SECRET;
    globalThis.GITHUB_CLIENT_ID = env.GITHUB_CLIENT_ID;
    globalThis.GITHUB_CLIENT_SECRET = env.GITHUB_CLIENT_SECRET;
    globalThis.COMPASS_OAUTH_SECRET = env.COMPASS_OAUTH_SECRET;
    globalThis.OVERRIDE_TOKEN = env.OVERRIDE_TOKEN;
  }
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
  if (url.pathname === '/proxy' && request.method === 'GET') {
    return handleAuthorProxy(request);
  }
  if (url.pathname === '/preview' && request.method === 'GET') {
    return handlePreview(request);
  }
  if (url.pathname === '/render' && request.method === 'GET') {
    return handleBrowserRender(request, env);
  }
  if (url.pathname === '/mcp' && request.method === 'POST') {
    return handleMcpProxy(request, env);
  }
  if (url.pathname === '/mcp-discovery' && request.method === 'GET') {
    return handleMcpDiscovery(request, env);
  }
  if (url.pathname === '/mcp-oauth/start' && request.method === 'GET') {
    return handleMcpOAuthStart(request);
  }
  if (url.pathname === '/mcp-oauth/callback' && request.method === 'GET') {
    return handleMcpOAuthCallback(request);
  }
  if (url.pathname === '/mcp-oauth/token' && request.method === 'POST') {
    return handleMcpOAuthToken(request);
  }
  if (url.pathname === '/mcp-oauth/register' && request.method === 'POST') {
    return handleMcpOAuthRegister(request);
  }
  if (url.pathname === '/gemini-image' && request.method === 'POST') {
    return handleGeminiImage(request, env);
  }
  if (url.pathname.startsWith('/img/') && request.method === 'GET') {
    return handleImageServe(request, env);
  }
  if (url.pathname === '/asset' && request.method === 'GET') {
    return handleAssetProxy(request);
  }
  if (url.pathname.startsWith('/aem/') && (request.method === 'GET' || request.method === 'OPTIONS')) {
    return handleAemReverseProxy(request);
  }
  if (url.pathname === '/ims/login' && request.method === 'GET') {
    return handleImsLogin(request);
  }
  if (url.pathname === '/ims/callback' && request.method === 'GET') {
    return handleImsCallback(request);
  }

  return new Response('Compass Auth Gateway', { status: 200 });
}

/* ─── GET /auth — S2S token for Compass ─── */

async function handleAuth(request) {
  const origin = request.headers.get('Origin') || '';

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Check secrets
  if (typeof IMS_CLIENT_ID === 'undefined' || !IMS_CLIENT_ID) {
    return jsonResponse({ error: 'IMS_CLIENT_ID not configured' }, 500, origin);
  }
  if (typeof IMS_CLIENT_SECRET === 'undefined' || !IMS_CLIENT_SECRET) {
    return jsonResponse({ error: 'IMS_CLIENT_SECRET not configured' }, 500, origin);
  }

  const now = Date.now();

  // Return manually-set override token if still valid (5 min buffer)
  if (typeof OVERRIDE_TOKEN !== 'undefined' && OVERRIDE_TOKEN) {
    try {
      const payload = JSON.parse(atob(OVERRIDE_TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const expiresAt = Number(payload.created_at) + Number(payload.expires_in);
      if (expiresAt > now + 300000) {
        return jsonResponse({ access_token: OVERRIDE_TOKEN, expires_at: expiresAt, cached: true }, 200, origin);
      }
    } catch { /* token malformed — fall through */ }
  }

  // Return in-memory cached token if still valid (with 5 min buffer)
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

    // Cache it
    cachedToken = data.access_token;
    // Adobe IMS returns expires_in in milliseconds (not seconds per OAuth2 spec)
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
      return new Response(`GitHub error: ${data.error_description || data.error}`, { status: 400, headers: { 'Content-Type': 'text/plain' } });
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

/* ─── POST /mcp — Proxy MCP calls to expose mcp-session-id header ─── */
/* CORS on mcp.adobeaemcloud.com doesn't expose mcp-session-id to browsers. */
/* This proxy forwards MCP requests and returns the session ID in an exposed header. */

async function handleMcpProxy(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const mcpEndpoint = url.searchParams.get('endpoint') || '/adobe/mcp/aem';

  // Support full URLs for external MCPs (mcp-gateway.adobe.io, rtcdp-mcp.adobe.io, etc.)
  // Relative paths are resolved against mcp.adobeaemcloud.com
  let targetUrl;
  if (mcpEndpoint.startsWith('https://')) {
    // Validate against allowlist to prevent open-proxy abuse
    try {
      const host = new URL(mcpEndpoint).hostname;
      if (!ALLOWED_MCP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
        return new Response('MCP endpoint not in allowlist', { status: 403 });
      }
    } catch {
      return new Response('Invalid MCP endpoint URL', { status: 400 });
    }
    targetUrl = mcpEndpoint;
  } else {
    targetUrl = `https://mcp.adobeaemcloud.com${mcpEndpoint}`;
  }

  // Endpoints that use their own auth headers (not IMS Bearer) — skip IMS token requirement
  const targetHostname = (() => { try { return new URL(targetUrl).hostname; } catch { return ''; } })();
  const usesOwnAuth = targetHostname.includes('workfront.adobe.com') || targetHostname.includes('workfront.com');

  // Prefer user token — needed for write operations (S2S lacks AEM user permissions)
  const userToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || null;
  let mcpToken = userToken;
  if (!mcpToken && !usesOwnAuth) {
    try {
      mcpToken = await getS2SToken(env);
    } catch {
      return new Response(JSON.stringify({ error: 'No auth token available — sign in to Compass or check worker S2S credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  }

  const incomingBody = await request.text();
  const clientSessionId = request.headers.get('mcp-session-id');

  async function forwardToMcp(token) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (clientSessionId) headers['Mcp-Session-Id'] = clientSessionId;

    // Inject product-specific context headers for Experience Cloud MCPs
    try {
      const targetHost = new URL(targetUrl).hostname;
      const isGateway = targetHost.includes('mcp-gateway.adobe.io')
        || targetHost.includes('rtcdp-mcp.adobe.io')
        || targetHost.includes('aep-mcp.adobe.io')
        || targetHost.includes('targetmcp.adobe.io')
        || targetHost.includes('ajo-mcp.adobe.io');
      if (isGateway) {
        if (env.IMS_ORG_ID) headers['x-gw-ims-org-id'] = env.IMS_ORG_ID;
        if (env.AA_GLOBAL_COMPANY_ID && targetUrl.includes('/aa/')) {
          headers['x-global-company-id'] = env.AA_GLOBAL_COMPANY_ID;
        }
        if (env.AEP_SANDBOX_NAME
          && (targetHost.includes('rtcdp-mcp') || targetHost.includes('aep-mcp'))) {
          headers['x-sandbox-name'] = env.AEP_SANDBOX_NAME;
        }
      }
      // Workfront uses apiKey header auth, not IMS Bearer
      const isWorkfront = targetHost.includes('workfront.adobe.com') || targetHost.includes('workfront.com');
      if (isWorkfront) {
        delete headers.Authorization;
        if (env.WORKFRONT_API_KEY) headers.apiKey = env.WORKFRONT_API_KEY;
        headers['x-forwarded-host'] = targetHost;
      }
    } catch { /* header injection best-effort */ }

    return fetch(targetUrl, { method: 'POST', headers, body: incomingBody });
  }

  const mcpResp = await forwardToMcp(mcpToken);
  const sessionId = mcpResp.headers.get('mcp-session-id') || '';
  const responseBody = await mcpResp.text();

  return new Response(responseBody, {
    status: mcpResp.status,
    headers: {
      'Content-Type': mcpResp.headers.get('content-type') || 'application/json',
      'Mcp-Session-Id': sessionId,
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}

/* ─── GET /mcp-discovery — Fetch .well-known OAuth metadata for an MCP endpoint ─── */

async function handleMcpDiscovery(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) {
    return jsonResponse({ error: 'Missing ?endpoint= parameter' }, 400, origin);
  }

  // Validate endpoint is in allowlist
  try {
    const host = new URL(endpoint).hostname;
    if (!ALLOWED_MCP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return jsonResponse({ error: 'Endpoint not in allowlist' }, 403, origin);
    }
  } catch {
    return jsonResponse({ error: 'Invalid endpoint URL' }, 400, origin);
  }

  // Step 1: Fetch OAuth Protected Resource metadata
  let resourceMeta = null;
  try {
    const rmResp = await fetch(`${endpoint}/.well-known/oauth-protected-resource`, {
      headers: { Accept: 'application/json' },
    });
    if (rmResp.ok) resourceMeta = await rmResp.json();
  } catch { /* not available */ }

  // Step 2: Resolve authorization server metadata URL
  let authMeta = null;
  const authServerBase = resourceMeta?.authorization_servers?.[0]
    || (() => { try { return new URL(endpoint).origin; } catch { return null; } })();

  if (authServerBase) {
    const wellKnown = authServerBase.includes('/.well-known/')
      ? authServerBase
      : `${authServerBase}/.well-known/oauth-authorization-server`;
    try {
      const amResp = await fetch(wellKnown, { headers: { Accept: 'application/json' } });
      if (amResp.ok) authMeta = await amResp.json();
    } catch { /* not available */ }
  }

  return jsonResponse({ resourceMeta, authMeta }, 200, origin);
}

/* ─── GET /preview — Full-page proxy for AEM JCR/xwalk content ─── */
/*
 * Fetches page HTML and optionally inlines CSS. Supports three auth tiers:
 *   1. User IMS token (passed via Authorization header from browser)
 *   2. S2S cached token (service account — for author CSS)
 *   3. Public publish tier (no auth — fallback)
 *
 * Query params:
 *   publish  - Publish tier base URL (required)
 *   author   - Author tier base URL (optional, derived from publish if omitted)
 *   path     - JCR content path with .html (required)
 *   mode     - "raw" returns HTML without stripping scripts/UE attributes (for client-side EDS decoration)
 *   _t       - Cache-bust timestamp (disables caching)
 */

async function handlePreview(request) {
  const url = new URL(request.url);
  const publishUrl = url.searchParams.get('publish');
  const authorUrl = url.searchParams.get('author');
  const pagePath = url.searchParams.get('path');
  const cacheBust = url.searchParams.get('_t');
  const rawMode = url.searchParams.get('mode') === 'raw';

  if (!publishUrl || !pagePath) {
    return new Response('Missing ?publish= and ?path= params', { status: 400 });
  }

  // Validate hosts — only allow adobeaemcloud.com
  try {
    const pubHost = new URL(publishUrl).hostname;
    if (!pubHost.endsWith('.adobeaemcloud.com')) {
      return new Response('Only adobeaemcloud.com hosts allowed', { status: 403 });
    }
    if (authorUrl) {
      const authHost = new URL(authorUrl).hostname;
      if (!authHost.endsWith('.adobeaemcloud.com')) {
        return new Response('Only adobeaemcloud.com author hosts allowed', { status: 403 });
      }
    }
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  // Resolve auth token: prefer user token (header or query param), fall back to S2S
  // Query param used because iframe.src can't set Authorization headers
  const userToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    || url.searchParams.get('token')
    || null;
  let authToken = userToken;
  let authLevel = userToken ? 'user' : 'none';

  // If no user token, try S2S
  if (!authToken) {
    const now = Date.now();
    if (!cachedToken || tokenExpiry <= now + 300000) {
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
        if (imsResp.ok) {
          const data = await imsResp.json();
          if (data.access_token) {
            cachedToken = data.access_token;
            // Adobe IMS returns expires_in in milliseconds (not seconds per OAuth2 spec)
            tokenExpiry = now + (data.expires_in || 86400000);
          }
        }
      } catch { /* S2S unavailable */ }
    }
    if (cachedToken) {
      authToken = cachedToken;
      authLevel = 's2s';
    }
  }

  const authorBase = authorUrl || publishUrl.replace('publish-', 'author-');

  try {
    // Step 1: Fetch HTML — try author first (if token available), fall back to publish
    let html = null;
    let htmlSource = 'publish';
    const pageUrl = `${publishUrl}${pagePath}`;
    const authorPageUrl = `${authorBase}${pagePath}`;

    // Strategy: try .aem.page first (xwalk EDS delivery — public, styled, fast)
    // Then author with Bearer, then publish as last resort
    const aemPageUrl = url.searchParams.get('aemPage');
    if (aemPageUrl) {
      try {
        const resp = await fetch(aemPageUrl, { headers: { 'Cache-Control': 'no-cache' } });
        if (resp.ok) {
          html = await resp.text();
          htmlSource = 'aem.page';
        }
      } catch { /* .aem.page failed */ }
    }

    if (!html && authToken) {
      try {
        const resp = await fetch(authorPageUrl, {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Cache-Control': 'no-cache',
          },
        });
        if (resp.ok) {
          html = await resp.text();
          htmlSource = 'author';
        }
      } catch { /* author fetch failed */ }
    }

    if (!html) {
      // Last resort: try publish (public, no auth needed)
      try {
        const resp = await fetch(pageUrl);
        if (resp.ok) {
          html = await resp.text();
          htmlSource = 'publish';
        }
      } catch { /* publish failed */ }
    }

    if (!html) {
      return new Response(
        `<!DOCTYPE html><html><body style="font:14px/1.5 system-ui;color:#94a3b8;background:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:500px"><h2 style="color:#e5e7eb">Page not found</h2><p>Could not load from .aem.page, author, or publish tier.</p><p style="font-size:12px;color:#64748b">${pagePath}</p></div></body></html>`,
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }

    // Raw mode: return HTML with minimal processing (for client-side EDS decoration)
    if (rawMode) {
      // Only add <base> for asset resolution and strip empty whitespace
      html = html.replace(/<head>/, `<head><base href="${authorBase}/">`);
      html = html.replace(/\n{3,}/g, '\n\n');

      const cacheHeader = cacheBust ? 'no-store, no-cache' : 'public, max-age=60';
      const origin = request.headers.get('Origin') || '';
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': cacheHeader,
          'X-Preview-Auth': authLevel,
          'X-Preview-Source': htmlSource,
          'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
          'Access-Control-Expose-Headers': 'X-Preview-Auth, X-Preview-Source',
        },
      });
    }

    // Hybrid mode: inline CSS (using S2S auth available here) + keep scripts proxied.
    // Best of both worlds — styled AND decorated.
    const mode = url.searchParams.get('mode') || 'standard';
    const isHybridOrFull = mode === 'hybrid' || mode === 'full';

    // Step 2: Inline CSS — try publish first, then author with token
    // This works for all modes because we have the S2S token in this request context.
    const cssLinks = [...html.matchAll(/<link[^>]*(?:rel=["']stylesheet["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*rel=["']stylesheet["'])[^>]*\/?>/gi)];
    for (const match of cssLinks) {
      const hrefVal = match[1] || match[2];
      if (!hrefVal) continue;

      const authorCssUrl = hrefVal.startsWith('http') ? hrefVal : `${authorBase}${hrefVal}`;

      let css = null;
      if (authToken) {
        try {
          const resp = await fetch(authorCssUrl, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (resp.ok) css = await resp.text();
        } catch { /* author failed */ }
      }

      if (css) {
        css = css.replace(/url\(\s*["']?\//g, `url("${authorBase}/`);
        html = html.replace(match[0], `<style>/* ${hrefVal.split('/').pop()} */\n${css}</style>`);
      } else {
        html = html.replace(match[0], '');
      }
    }

    if (isHybridOrFull) {
      // Hybrid/Full: keep scripts, rewrite <script src> to proxy through /asset
      const workerOrigin = url.origin;
      const codeBase = url.searchParams.get('codeBase') || '';
      // Pass user token to /asset for .resource/ paths (browser <script> tags can't send headers)
      const assetTokenParam = authToken ? `&token=${encodeURIComponent(authToken)}` : '';

      html = html.replace(
        /(<script[^>]*src=["'])([^"']+)(["'])/gi,
        (match, prefix, assetPath, suffix) => {
          if (assetPath.startsWith('data:') || assetPath.startsWith('#') || assetPath.startsWith('javascript:')) return match;

          let resolvedUrl;
          if (assetPath.startsWith('http://') || assetPath.startsWith('https://')) {
            try {
              const h = new URL(assetPath).hostname;
              if (h.endsWith('.adobeaemcloud.com') || h.endsWith('.aem.page') || h.endsWith('.aem.live')) {
                resolvedUrl = assetPath;
              } else {
                return match;
              }
            } catch { return match; }
          } else if (assetPath.includes('.resource/')) {
            resolvedUrl = `${authorBase}${assetPath}`;
          } else if (assetPath.startsWith('/etc.clientlibs/') || assetPath.startsWith('/etc/')) {
            resolvedUrl = `${publishUrl}${assetPath}`;
          } else if (assetPath.startsWith('/') && codeBase) {
            resolvedUrl = `${codeBase}${assetPath}`;
          } else if (assetPath.startsWith('/')) {
            resolvedUrl = `${publishUrl}${assetPath}`;
          } else {
            return match;
          }

          const needsToken = resolvedUrl.includes('.resource/') || resolvedUrl.includes('author-');
          return `${prefix}${workerOrigin}/asset?url=${encodeURIComponent(resolvedUrl)}${needsToken ? assetTokenParam : ''}${suffix}`;
        },
      );

      // Fetch interceptor for dynamic block loading by aem.js
      const fetchInterceptor = `<script>
(function(){
  var W='${workerOrigin}',A='${authorBase}',C='${codeBase}',P='${publishUrl}';
  var _f=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'){
      if(u.includes('.resource/')){u=W+'/asset?url='+encodeURIComponent(A+u);}
      else if(u.startsWith('/blocks/')||u.startsWith('/scripts/')||u.startsWith('/styles/')){
        u=W+'/asset?url='+encodeURIComponent((C||P)+u);
      }
    }
    return _f.call(this,u,o);
  };
})();
<\/script>`;

      html = html.replace(/<head([^>]*)>/, `<head$1><base href="${authorBase}/">${fetchInterceptor}`);
    } else {
      // Standard: strip all scripts
      html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      html = html.replace(/<head>/, `<head><base href="${authorBase}/">`);
    }

    // Strip xwalk UE instrumentation (all modes)
    html = html.replace(/<div[^>]*data-aue-prop=[^>]*>[^<]*<\/div>/gi, '');
    html = html.replace(/<div[^>]*class="[^"]*section-metadata[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '');
    html = html.replace(/<div>\s*(false|true|overlay|button|sec-spacing[^<]*|section-none|sec-full-width|sec-full-width-background|image-left|image-right|cta-button[^<]*|text-center|light|dark|hidden|teaser-card|teaser-overlay|image-top|image-bottom|teaserStyle|ctastyle|style)\s*<\/div>/gi, '');
    html = html.replace(/<div>\s*(title|videoReference|imageRef|buttonText|video|bg-default|bg-dark|bg-light|description|altText|linkUrl|linkText|eyebrow|subtitle|fragmentRef|teaserStyle|displayStyle|herolayout|sectionStyle)\s*<\/div>/gi, '');
    html = html.replace(/<div>\s*([a-z][a-zA-Z]{2,19})\s*<\/div>/g, (m, word) => {
      if (/^[a-z]+[A-Z]/.test(word) || /^(bg|sec|cta)-/.test(word)) return '';
      return m;
    });
    html = html.replace(/<div[^>]*class="[^"]*separator[^"]*"[^>]*>\s*<\/div>/gi, '<hr>');
    html = html.replace(/<div>\s*<\/div>/g, '');
    html = html.replace(/\n{3,}/g, '\n\n');

    // Inject fallback CSS (supplements inlined site CSS for blocks that need JS decoration)
    const aemFallbackCss = `<style>
:root{--brand:#1473e6;--bg:#fff;--text:#2c2c2c;--text-light:#666;--font:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--max-w:1200px;--gap:2rem;--radius:8px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);color:var(--text);background:var(--bg);line-height:1.6}
img,video,picture{max-width:100%;height:auto;display:block;border-radius:var(--radius)}
a{color:var(--brand);text-decoration:none} a:hover{text-decoration:underline}
h1{font-size:2.5rem;line-height:1.15;margin-bottom:.5rem}
h2{font-size:2rem;line-height:1.2;margin-bottom:.5rem}
h3{font-size:1.5rem;line-height:1.3;margin-bottom:.5rem}
p{margin-bottom:.75rem}
hr{border:none;border-top:1px solid #e0e0e0;margin:2rem 0}
main{max-width:var(--max-w);margin:0 auto;padding:0 var(--gap)}
header,nav{padding:1rem var(--gap);background:#f5f5f5;display:flex;align-items:center;gap:1rem}
footer{padding:2rem var(--gap);background:#1a1a1a;color:#ccc;font-size:.875rem}
.hero{position:relative;min-height:400px;display:flex;align-items:center;padding:3rem var(--gap);overflow:hidden}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1}
.hero h1,.hero h2,.hero p{position:relative;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.5)}
.hero h1{font-size:3rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--gap);padding:var(--gap) 0}
.cards>div{border:1px solid #e0e0e0;border-radius:var(--radius);overflow:hidden;background:#fff}
.cards>div>div:last-child{padding:1rem}
.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:var(--gap);padding:var(--gap) 0;align-items:center}
.carousel{overflow-x:auto;display:flex;gap:1rem;scroll-snap-type:x mandatory;padding:var(--gap) 0}
.carousel>div{flex:0 0 80%;scroll-snap-align:start;border-radius:var(--radius);overflow:hidden}
.teaser{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap);padding:var(--gap) 0;align-items:center}
.video{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:var(--radius)}
.video iframe,.video video{position:absolute;top:0;left:0;width:100%;height:100%}
main>div{padding:var(--gap) 0}
main>div+div{border-top:1px solid #f0f0f0}
.compass-preview-banner{position:sticky;top:0;z-index:999;background:#1e293b;color:#94a3b8;font:12px/1.4 system-ui;padding:6px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #334155}
.compass-preview-banner strong{color:#e2e8f0}
</style>`;
    html = html.replace(/<head[^>]*>/, (m) => `${m}${aemFallbackCss}`);

    // Add content preview banner
    const bannerHtml = `<div class="compass-preview-banner"><strong>Content preview</strong> — Use the Preview button in toolbar for the full styled page</div>`;
    html = html.replace(/<body[^>]*>/, (m) => `${m}${bannerHtml}`);

    const cacheHeader = cacheBust ? 'no-store, no-cache, must-revalidate' : 'public, max-age=300';
    const origin = request.headers.get('Origin') || '';

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': cacheHeader,
        'X-Preview-Auth': authLevel,
        'X-Preview-Source': htmlSource,
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Expose-Headers': 'X-Preview-Auth, X-Preview-Source',
      },
    });
  } catch (err) {
    return new Response(`Preview error: ${err.message}`, { status: 502 });
  }
}

/* ─── GET /asset — Proxy static assets (JS/CSS/fonts) from AEM or EDS CDN ─── */
/* Allows scripts to load same-origin in the preview iframe, bypassing CORS. */

async function handleAssetProxy(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin) && origin) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response('Missing ?url= parameter', { status: 400 });
  }

  // Validate: only proxy from AEM and EDS origins
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }
  const host = target.hostname;
  const allowed = host.endsWith('.adobeaemcloud.com')
    || host.endsWith('.aem.page') || host.endsWith('.aem.live')
    || host.endsWith('.hlx.page') || host.endsWith('.hlx.live');
  if (!allowed) {
    return new Response('Only AEM and EDS origins allowed', { status: 403 });
  }

  // Author tier and .resource/ paths need auth
  const needsAuth = host.includes('author-') || targetUrl.includes('.resource/');
  const headers = {};
  if (needsAuth) {
    const userToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
      || url.searchParams.get('token') || '';
    if (userToken) {
      headers.Authorization = `Bearer ${userToken}`;
    } else {
      // Ensure S2S token is available (may be null in a fresh Worker isolate)
      const now = Date.now();
      if (!cachedToken || tokenExpiry <= now + 300000) {
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
          if (imsResp.ok) {
            const data = await imsResp.json();
            if (data.access_token) {
              cachedToken = data.access_token;
              tokenExpiry = now + (data.expires_in || 86400000);
            }
          }
        } catch { /* S2S unavailable */ }
      }
      if (cachedToken) {
        headers.Authorization = `Bearer ${cachedToken}`;
      }
    }
  }

  try {
    const resp = await fetch(targetUrl, { headers });
    if (!resp.ok) {
      return new Response(`Upstream ${resp.status}`, { status: resp.status });
    }

    const contentType = resp.headers.get('Content-Type') || 'application/octet-stream';
    const body = await resp.arrayBuffer();

    // Cache CDN assets aggressively, author assets briefly
    const isEds = host.endsWith('.aem.page') || host.endsWith('.aem.live');
    const cacheTime = isEds ? 3600 : 300;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${cacheTime}`,
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  } catch (err) {
    return new Response(`Asset proxy error: ${err.message}`, { status: 502 });
  }
}

/* ─── GET /aem/* — Full reverse proxy for AEM author/publish ─── */
/*
 * Proxies ALL requests to AEM author tier. The iframe loads from Worker origin,
 * so ALL sub-requests (CSS, JS, images, dynamic fetch) automatically go through
 * the Worker. No URL rewriting, no fetch interceptor needed.
 *
 * URL pattern: /aem/{authorHost}/{path}
 * Example: /aem/author-p153659-e1614585.adobeaemcloud.com/content/wknd-universal/.../en.html
 *
 * Auth: user token from ?token= param, or S2S fallback
 */

async function handleAemReverseProxy(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return handleCors(request);
  }

  // Parse: /aem/{host}/{path...}
  const pathParts = url.pathname.replace(/^\/aem\//, '').split('/');
  const aemHost = pathParts.shift();
  const aemPath = '/' + pathParts.join('/');

  if (!aemHost || !aemHost.endsWith('.adobeaemcloud.com')) {
    return new Response('Invalid AEM host — must be *.adobeaemcloud.com', { status: 400 });
  }

  // Resolve auth: user token from query param, then S2S
  let authToken = url.searchParams.get('token') || null;
  if (!authToken) {
    const now = Date.now();
    if (!cachedToken || tokenExpiry <= now + 300000) {
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
        if (imsResp.ok) {
          const data = await imsResp.json();
          if (data.access_token) {
            cachedToken = data.access_token;
            tokenExpiry = now + (data.expires_in || 86400000);
          }
        }
      } catch { /* S2S unavailable */ }
    }
    authToken = cachedToken;
  }

  // Build the upstream URL (strip ?token= from query)
  const upstreamUrl = new URL(`https://${aemHost}${aemPath}`);
  // Forward query params except token
  for (const [k, v] of url.searchParams) {
    if (k !== 'token') upstreamUrl.searchParams.set(k, v);
  }

  // Fetch from AEM
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  try {
    const resp = await fetch(upstreamUrl.toString(), { headers, redirect: 'follow' });

    // Get response body and content type
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const isHTML = contentType.includes('text/html');

    let body;
    if (isHTML) {
      // Rewrite absolute URLs in HTML to go through the reverse proxy
      let html = await resp.text();
      // Rewrite links/scripts/images that point to the same AEM host
      html = html.replace(
        /((?:src|href|action)=["'])(\/[^"']*)(["'])/gi,
        (match, pre, path, post) => `${pre}/aem/${aemHost}${path}${post}`,
      );
      // Rewrite CSS url() references
      html = html.replace(
        /url\(\s*(['"]?)(\/[^'")]+)\1\s*\)/g,
        (match, q, path) => `url(${q}/aem/${aemHost}${path}${q})`,
      );
      body = html;
    } else {
      body = await resp.arrayBuffer();
    }

    // Cache: short for HTML, longer for static assets
    const isStatic = /\.(css|js|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico)$/i.test(aemPath);
    const cacheTime = isStatic ? 3600 : 60;

    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${cacheTime}`,
        // No X-Frame-Options — we WANT this to be iframeable
      },
    });
  } catch (err) {
    return new Response(`AEM proxy error: ${err.message}`, { status: 502 });
  }
}

/* ─── GET /ims/login — Redirect to Adobe IMS for user-level auth ─── */

const COMPASS_OAUTH_CLIENT_ID = 'aem-extension-builder';
const COMPASS_OAUTH_USER_SCOPE = 'AdobeID,openid,read_organizations,additional_info.projectedProductContext,aem.frontend.all';

async function handleImsLogin(request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('return_to') || ALLOWED_RETURN_URLS[0];

  if (!ALLOWED_RETURN_URLS.some((a) => returnTo.startsWith(a))) {
    return new Response('Invalid return_to URL', { status: 400 });
  }

  // HMAC-signed state for CSRF protection (stateless — works across all Worker isolates)
  const state = await signState({ returnTo, exp: Date.now() + STATE_TTL_MS, nonce: crypto.randomUUID() });

  const callbackUrl = `${url.origin}/ims/callback`;

  const params = new URLSearchParams({
    client_id: COMPASS_OAUTH_CLIENT_ID,
    scope: COMPASS_OAUTH_USER_SCOPE,
    response_type: 'code',
    redirect_uri: callbackUrl,
    state,
  });

  return Response.redirect(
    `https://ims-na1.adobelogin.com/ims/authorize/v2?${params}`,
    302,
  );
}

/* ─── GET /ims/callback — Capture token from hash, relay back to Compass ─── */

async function handleImsCallback(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  if (error) {
    return new Response(`Adobe sign-in error: ${error} — ${url.searchParams.get('error_description') || ''}`, {
      status: 400, headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (!code || !state) {
    return new Response('Sign-in failed. Missing authorization code or state.', {
      status: 400, headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Verify HMAC-signed state (CSRF protection)
  const payload = await verifyState(state);
  if (!payload) {
    return new Response('Invalid or expired state. Please try signing in again.', {
      status: 403, headers: { 'Content-Type': 'text/plain' },
    });
  }
  const { returnTo } = payload;

  // Exchange authorization code for access token (server-side — secret never exposed)
  try {
    const callbackUrl = `${url.origin}/ims/callback`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: COMPASS_OAUTH_CLIENT_ID,
      client_secret: typeof COMPASS_OAUTH_SECRET !== 'undefined' ? COMPASS_OAUTH_SECRET : IMS_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
    });

    const tokenResp = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      return new Response(`Token exchange failed (${tokenResp.status}): ${errText}`, {
        status: 502, headers: { 'Content-Type': 'text/plain' },
      });
    }

    const data = await tokenResp.json();
    if (!data.access_token) {
      return new Response('No access token in response', {
        status: 502, headers: { 'Content-Type': 'text/plain' },
      });
    }

    const token = data.access_token;
    const expiresIn = data.expires_in || '86400000';

    // Redirect popup back to Compass origin with token in hash.
    // When Compass loads in the popup, loadIms() saves token to localStorage.
    // The MAIN window detects this via the 'storage' event and picks up the token.
    // The popup then auto-closes.
    const separator = returnTo.includes('#') ? '&' : '#';
    const redirectUrl = returnTo + separator
      + 'ims_token=' + encodeURIComponent(token)
      + '&expires_in=' + encodeURIComponent(String(expiresIn))
      + '&auth_popup=1';

    return Response.redirect(redirectUrl, 302);
  } catch (err) {
    return new Response(`Token exchange error: ${err.message}`, {
      status: 502, headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/* ─── GET /proxy — Fetch AEM author resources (CSS, images) with S2S auth ─── */

async function handleAuthorProxy(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing ?url= parameter' }, 400, origin);
  }

  // Only allow proxying to AEM author hosts
  try {
    const target = new URL(targetUrl);
    if (!target.hostname.endsWith('.adobeaemcloud.com')) {
      return jsonResponse({ error: 'Only adobeaemcloud.com hosts allowed' }, 403, origin);
    }
  } catch {
    return jsonResponse({ error: 'Invalid URL' }, 400, origin);
  }

  // Ensure we have a valid S2S token
  const now = Date.now();
  if (!cachedToken || tokenExpiry <= now + 300000) {
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
      if (imsResp.ok) {
        const data = await imsResp.json();
        if (data.access_token) {
          cachedToken = data.access_token;
          tokenExpiry = now + (data.expires_in || 86400000);
        }
      }
    } catch { /* token refresh failed */ }
  }

  // Fetch the resource from AEM author with Bearer token
  try {
    const resp = await fetch(targetUrl, {
      headers: cachedToken ? { Authorization: `Bearer ${cachedToken}` } : {},
    });

    if (!resp.ok) {
      return new Response(`Upstream ${resp.status}`, {
        status: resp.status,
        headers: corsHeaders(origin),
      });
    }

    const contentType = resp.headers.get('Content-Type') || 'application/octet-stream';
    const body = await resp.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders(origin),
      },
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502, origin);
  }
}

/* ─── POST /gemini-image — Generate image via Gemini, store in R2, return public URL ─── */

async function handleGeminiImage(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured — run: npx wrangler secret put GEMINI_API_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let prompt;
  try {
    ({ prompt } = await request.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Missing prompt' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const geminiResp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      }),
    },
  );

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    console.error('[Gemini] Generation failed:', geminiResp.status, errText);
    return new Response(JSON.stringify({ error: `Gemini ${geminiResp.status}`, detail: errText }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const result = await geminiResp.json();
  const parts = result.candidates?.[0]?.content?.parts || [];
  const imageData = parts.find((p) => p.inlineData)?.inlineData;
  const text = parts.find((p) => p.text)?.text || '';

  if (!imageData?.data) {
    return new Response(JSON.stringify({ error: 'No image in Gemini response', raw: result }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Decode base64 and upload to R2
  const ext = (imageData.mimeType || 'image/png').split('/')[1] || 'png';
  const imageKey = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const imageBytes = Uint8Array.from(atob(imageData.data), (c) => c.charCodeAt(0));

  await env.IMAGES.put(imageKey, imageBytes, {
    httpMetadata: { contentType: imageData.mimeType || 'image/png' },
  });

  const workerOrigin = new URL(request.url).origin;
  const imageUrl = `${workerOrigin}/img/${imageKey}`;

  console.log(`[Gemini] Generated image → R2 key: ${imageKey}`);

  return new Response(JSON.stringify({
    imageUrl,
    mimeType: imageData.mimeType,
    text,
    model: 'gemini-2.0-flash-preview-image-generation',
    provider: 'gemini',
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/* ─── GET /img/:key — Serve images from R2 ─── */

async function handleImageServe(request, env) {
  const key = new URL(request.url).pathname.replace(/^\/img\//, '');
  if (!key) return new Response('Not found', { status: 404 });

  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
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

/* ─── GET /render — Pixel-perfect author preview via Browser Rendering ─── */
/* Uses CF Browser Rendering to load the AEM author page in a headless browser,
   authenticate with the user's IMS token, wait for JS decoration, and return
   the fully-rendered DOM as HTML. Session keep-alive for sub-second re-renders. */

import puppeteer from '@cloudflare/puppeteer';

const KEEP_ALIVE_MS = 60000;

async function handleBrowserRender(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const pageUrl = url.searchParams.get('url');
  let token = url.searchParams.get('token');

  if (!pageUrl) {
    return new Response('Missing ?url= parameter', { status: 400 });
  }

  let pageHost;
  try {
    pageHost = new URL(pageUrl).hostname;
    if (!pageHost.endsWith('.adobeaemcloud.com')) {
      return new Response('Only adobeaemcloud.com URLs allowed', { status: 403 });
    }
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  if (!env.BROWSER) {
    return new Response('Browser Rendering not available — upgrade to Workers Paid plan', { status: 503 });
  }

  // If no user token provided, get S2S token as fallback
  if (!token) {
    try {
      const s2s = await getS2SToken(env);
      token = s2s;
    } catch { /* no token available */ }
  }

  try {
    const now = Date.now();

    let browser;
    try {
      browser = await puppeteer.connect(env.BROWSER);
    } catch {
      browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    if (token) {
      // Bearer header injection — S2S client_id is allowlisted in AEM Config Pipeline
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const reqUrl = req.url();
        if (reqUrl.includes('.adobeaemcloud.com')) {
          req.continue({ headers: { ...req.headers(), Authorization: `Bearer ${token}` } });
        } else {
          req.continue();
        }
      });
    }

    await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 20000 });

    // Wait for EDS block decoration scripts and lazy-loaded CSS
    await new Promise(r => setTimeout(r, 3000));

    // Check if we got an auth error or login page instead of actual content
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const isAuthError = bodyText.includes('Client ID not allowlisted')
      || bodyText.includes('unauthorized')
      || bodyText.includes('Forbidden');
    const title = await page.title();
    const isLoginPage = title.toLowerCase().includes('sign in') || title.toLowerCase().includes('login');

    let renderedHTML;
    if (isAuthError || isLoginPage) {
      await page.close();
      browser.disconnect();
      const detail = isAuthError ? bodyText.slice(0, 200) : 'Login page returned';
      return new Response(`Authentication failed: ${detail}`, {
        status: 401,
        headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'text/plain' },
      });
    }

    // Inline CSS + convert images to data URIs (srcdoc can't load auth-protected resources)
    renderedHTML = await page.evaluate(async () => {
      // 1. Inline all CSS
      const styles = [];
      for (const sheet of document.styleSheets) {
        try {
          let css = '';
          for (const rule of sheet.cssRules) css += rule.cssText + '\n';
          if (css) styles.push(css);
        } catch { /* cross-origin sheet */ }
      }
      if (styles.length > 0) {
        const styleEl = document.createElement('style');
        styleEl.textContent = styles.join('\n');
        document.head.appendChild(styleEl);
        document.querySelectorAll('link[rel="stylesheet"]').forEach(l => l.remove());
      }

      // 2. Convert ALL images to base64 (img src + picture source + CSS backgrounds)
      async function toDataUri(url) {
        try {
          const resp = await fetch(url, { credentials: 'include' });
          if (!resp.ok) return null;
          const blob = await resp.blob();
          if (blob.size > 2000000) return null;
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        } catch { return null; }
      }

      // img tags
      const imgs = document.querySelectorAll('img[src]');
      await Promise.allSettled([...imgs].map(async (img) => {
        const src = img.getAttribute('src');
        if (!src || src.startsWith('data:')) return;
        const dataUri = await toDataUri(src);
        if (dataUri) img.setAttribute('src', dataUri);
      }));

      // picture > source tags
      const sources = document.querySelectorAll('picture source[srcset]');
      await Promise.allSettled([...sources].map(async (source) => {
        const srcset = source.getAttribute('srcset');
        if (!srcset || srcset.startsWith('data:')) return;
        const firstUrl = srcset.split(',')[0].trim().split(' ')[0];
        const dataUri = await toDataUri(firstUrl);
        if (dataUri) source.setAttribute('srcset', dataUri);
      }));

      // CSS background-image (inline styles only)
      const bgEls = document.querySelectorAll('[style*="background-image"]');
      await Promise.allSettled([...bgEls].map(async (el) => {
        const match = el.style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
        if (!match || match[1].startsWith('data:')) return;
        const dataUri = await toDataUri(match[1]);
        if (dataUri) el.style.backgroundImage = `url("${dataUri}")`;
      }));

      return document.documentElement.outerHTML;
    });

    await page.close();
    browser.disconnect();

    return new Response(renderedHTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Render-Source': 'browser',
        'X-Render-Time': `${Date.now() - now}ms`,
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Expose-Headers': 'X-Render-Source, X-Render-Time',
      },
    });
  } catch (err) {
    return new Response(`Render error: ${err.message}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'text/plain' },
    });
  }
}

/* ─── MCP OAuth Flow (for Content MCP write access) ─── */
/* Uses oauth.adobeaemcloud.com with http://localhost redirect + PKCE */

const MCP_OAUTH_CLIENT_ID = 'MTAwNy1VOUJTNS15QUdRUnhTTVlZZzFUcDV3LmhWLUlvNVNPZEl3dURaaTNEV0RxMHZ4WU1uSmt6SnYy';
const MCP_OAUTH_CLIENT_SECRET = '1007-U9BS5-yAGQRxSMYYg1Tp5whV-Io5SOdIwuDZi3DWDq0vxYMnJkzJv2Bd2jjwP9J362Ev_aFF0MKbeaN7cyRivr_-Xb7Fk2mUY';
// Callback served by this Worker — popup relays code via postMessage, no cross-origin polling needed
const MCP_OAUTH_REDIRECT_URI = 'https://compass-ims-proxy.compass-xsc.workers.dev/mcp-oauth/callback';

// PKCE is generated in the browser — Worker is fully stateless for OAuth

async function handleMcpOAuthStart(request) {
  const url = new URL(request.url);

  const codeChallenge = url.searchParams.get('code_challenge');
  const state = url.searchParams.get('state');

  if (!codeChallenge || !state) {
    return new Response('Missing code_challenge or state', { status: 400 });
  }

  // Generic: accepts any discovered auth endpoint, defaults to AEM Cloud
  const authEndpoint = url.searchParams.get('auth_endpoint') || 'https://oauth.adobeaemcloud.com/oauth/authorize';
  const clientId = url.searchParams.get('client_id') || MCP_OAUTH_CLIENT_ID;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: MCP_OAUTH_REDIRECT_URI,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  return Response.redirect(`${authEndpoint}?${params}`, 302);
}

/**
 * GET /mcp-oauth/callback — OAuth redirect landing page served by this Worker.
 * Receives the auth code from oauth.adobeaemcloud.com, relays it to the opener
 * via postMessage, then closes itself. Avoids cross-origin popup.location.href polling.
 */
async function handleMcpOAuthCallback(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const error = url.searchParams.get('error') || '';
  const errorDesc = url.searchParams.get('error_description') || '';

  const html = `<!DOCTYPE html>
<html><head><title>Connecting to AEM Content…</title>
<style>body{font:14px/1.5 system-ui;background:#0f172a;color:#94a3b8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
</head><body>
<p>${error ? `Auth error: ${escapeHtmlInline(errorDesc || error)}` : 'Connecting… this window will close automatically.'}</p>
<script>
(function () {
  const code = ${JSON.stringify(code)};
  const error = ${JSON.stringify(error)};
  if (window.opener) {
    window.opener.postMessage({ type: 'mcp-oauth-callback', code, error }, '*');
  }
  // Give postMessage time to deliver before closing
  setTimeout(() => window.close(), 300);
})();
function escapeHtmlInline(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
</script>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtmlInline(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * POST /mcp-oauth/register — Dynamic Client Registration (RFC 7591).
 * Accepts a registrationEndpoint from the body to support any MCP's auth server.
 * Defaults to oauth.adobeaemcloud.com for backward compat.
 */
async function handleMcpOAuthRegister(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const registrationEndpoint = body.registrationEndpoint || 'https://oauth.adobeaemcloud.com/oauth/register';
  const redirectUri = body.redirectUri || MCP_OAUTH_REDIRECT_URI;

  const regResp = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: 'Compass Web App',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client — PKCE, no secret
      scope: 'openid AdobeID',
    }),
  });

  const regText = await regResp.text();
  let regData;
  try { regData = JSON.parse(regText); } catch { regData = { raw: regText }; }

  return new Response(JSON.stringify({ status: regResp.status, data: regData }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
    },
  });
}

async function handleMcpOAuthToken(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  const body = await request.json();
  const { code, codeVerifier, tokenEndpoint, clientId } = body;

  if (!code || !codeVerifier) {
    return new Response(JSON.stringify({ error: 'Missing code or codeVerifier' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
    });
  }

  const resolvedTokenEndpoint = tokenEndpoint || 'https://oauth.adobeaemcloud.com/oauth/token';
  const resolvedClientId = clientId || MCP_OAUTH_CLIENT_ID;

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: resolvedClientId,
    code,
    redirect_uri: MCP_OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  // Only add client_secret for the default AEM Cloud client (public PKCE clients omit it)
  if (!clientId || clientId === MCP_OAUTH_CLIENT_ID) {
    tokenBody.append('client_secret', MCP_OAUTH_CLIENT_SECRET);
  }

  const tokenResp = await fetch(resolvedTokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });

  const tokenData = await tokenResp.json();

  return new Response(JSON.stringify(tokenData), {
    status: tokenResp.ok ? 200 : 502,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

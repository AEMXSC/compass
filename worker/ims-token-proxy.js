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
const IMS_SCOPE = 'aem.frontend.all,openid,AdobeID,read_organizations,additional_info.projectedProductContext,aem_mcp';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_SCOPE = 'repo,user';

const ALLOWED_ORIGINS = [
  'https://aemxsc.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
  'https://main--compass--aemxsc.aem.page',
  'https://eds-migration--compass--aemxsc.aem.page',
  'https://main--compass--aemxsc.aem.live',
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
  if (url.pathname === '/proxy' && request.method === 'GET') {
    return handleAuthorProxy(request);
  }
  if (url.pathname === '/preview' && request.method === 'GET') {
    return handlePreview(request);
  }
  if (url.pathname === '/mcp' && request.method === 'POST') {
    return handleMcpProxy(request);
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

async function handleMcpProxy(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin) && !origin.endsWith('.aem.page') && !origin.endsWith('.aem.live')) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const mcpEndpoint = url.searchParams.get('endpoint') || '/adobe/mcp/aem';
  const targetUrl = `https://mcp.adobeaemcloud.com${mcpEndpoint}`;

  // Ensure we have an S2S token
  const now = Date.now();
  if (!cachedToken || tokenExpiry <= now + 300000) {
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
  }

  // Forward the request to MCP, preserving session ID
  const incomingBody = await request.text();
  const forwardHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${cachedToken}`,
  };

  // Pass through the client's session ID if provided
  const clientSessionId = request.headers.get('mcp-session-id');
  if (clientSessionId) {
    forwardHeaders['Mcp-Session-Id'] = clientSessionId;
  }

  const mcpResp = await fetch(targetUrl, {
    method: 'POST',
    headers: forwardHeaders,
    body: incomingBody,
  });

  // Capture session ID from MCP response
  const sessionId = mcpResp.headers.get('mcp-session-id') || '';

  // Forward response body and status, adding session ID as an exposed header
  const responseBody = await mcpResp.text();
  return new Response(responseBody, {
    status: mcpResp.status,
    headers: {
      'Content-Type': mcpResp.headers.get('content-type') || 'application/json',
      'Mcp-Session-Id': sessionId,
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}

/* ─── GET /preview — Full-page proxy for AEM JCR/xwalk content ─── */
/* Fetches HTML from publish (public), CSS from author (S2S auth), returns self-contained page */

async function handlePreview(request) {
  const url = new URL(request.url);
  const publishUrl = url.searchParams.get('publish');
  const authorUrl = url.searchParams.get('author');
  const pagePath = url.searchParams.get('path');
  const cacheBust = url.searchParams.get('_t');

  if (!publishUrl || !pagePath) {
    return new Response('Missing ?publish= and ?path= params', { status: 400 });
  }

  // Validate hosts — only allow adobeaemcloud.com (prevents S2S token leak to arbitrary hosts)
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

  try {
    // Step 1: Fetch HTML from publish tier (public, no auth)
    const pageUrl = `${publishUrl}${pagePath}`;
    const htmlResp = await fetch(pageUrl);
    if (!htmlResp.ok) {
      return new Response(`Publish tier returned ${htmlResp.status} for ${pageUrl}`, { status: 502 });
    }
    let html = await htmlResp.text();

    // Step 2: Ensure we have an S2S token for author CSS fetch
    const now = Date.now();
    if (!cachedToken || tokenExpiry <= now + 300000) {
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
    }

    // Step 3: Try to inline CSS from author tier (with S2S Bearer token)
    // Note: S2S may not have access to .resource/ paths (403). Fallback CSS handles this.
    const authorBase = authorUrl || publishUrl.replace('publish-', 'author-');
    let cssInlined = false;
    // Match <link> with rel="stylesheet" in either attribute order
    const cssLinks = [...html.matchAll(/<link[^>]*(?:rel=["']stylesheet["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*rel=["']stylesheet["'])[^>]*\/?>/gi)];
    for (const match of cssLinks) {
      const hrefVal = match[1] || match[2];
      if (!hrefVal) continue;
      const cssHref = hrefVal.startsWith('http') ? hrefVal : `${authorBase}${hrefVal}`;
      try {
        const cssResp = await fetch(cssHref, {
          headers: cachedToken ? { Authorization: `Bearer ${cachedToken}` } : {},
        });
        if (cssResp.ok) {
          let css = await cssResp.text();
          css = css.replace(/url\(\s*["']?\//g, `url("${authorBase}/`);
          html = html.replace(match[0], `<style>/* ${hrefVal.split('/').pop()} */\n${css}</style>`);
          cssInlined = true;
        } else {
          console.log(`[Preview] CSS fetch ${cssResp.status} for ${cssHref} — using fallback CSS`);
          // Remove the <link> tag since it won't resolve in the iframe
          html = html.replace(match[0], '');
        }
      } catch (cssErr) {
        console.log(`[Preview] CSS fetch error: ${cssErr.message} — using fallback CSS`);
        html = html.replace(match[0], '');
      }
    }

    // Step 4: Strip <script> tags (won't execute properly out of context)
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

    // Step 5: Strip xwalk UE instrumentation and section-metadata
    // Remove data-aue-* divs that contain raw property values (overlay, button, sec-spacing, etc.)
    html = html.replace(/<div[^>]*data-aue-prop=[^>]*>[^<]*<\/div>/gi, '');
    html = html.replace(/<div[^>]*class="[^"]*section-metadata[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '');
    html = html.replace(/<div>\s*(false|true|overlay|button|sec-spacing[^<]*|section-none|sec-full-width|sec-full-width-background|image-left|image-right|cta-button[^<]*|text-center|light|dark|hidden|teaser-card|teaser-overlay|image-top|image-bottom|teaserStyle|ctastyle|style)\s*<\/div>/gi, '');
    // Strip empty separator divs
    html = html.replace(/<div[^>]*class="[^"]*separator[^"]*"[^>]*>\s*<\/div>/gi, '<hr>');

    // Step 6: Add <base> for images and relative links (publish tier serves these publicly)
    html = html.replace(/<head>/, `<head><base href="${publishUrl}/">`);

    // Step 7: Comprehensive AEM/EDS fallback CSS (always inject — covers xwalk block types)
    const aemFallbackCss = `<style>
/* Compass Preview — AEM Fallback Styles */
:root{--brand:#1473e6;--bg:#fff;--text:#2c2c2c;--text-light:#666;--font:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--max-w:1200px;--gap:2rem;--radius:8px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);color:var(--text);background:var(--bg);line-height:1.6}
img,video,picture{max-width:100%;height:auto;display:block;border-radius:var(--radius)}
a{color:var(--brand);text-decoration:none} a:hover{text-decoration:underline}
h1{font-size:2.5rem;line-height:1.15;margin-bottom:.5rem}
h2{font-size:2rem;line-height:1.2;margin-bottom:.5rem}
h3{font-size:1.5rem;line-height:1.3;margin-bottom:.5rem}
h4,h5,h6{font-size:1.1rem;margin-bottom:.25rem}
p{margin-bottom:.75rem}
hr{border:none;border-top:1px solid #e0e0e0;margin:2rem 0}

/* Layout */
main{max-width:var(--max-w);margin:0 auto;padding:0 var(--gap)}
header,nav{padding:1rem var(--gap);background:#f5f5f5;display:flex;align-items:center;gap:1rem}
footer{padding:2rem var(--gap);background:#1a1a1a;color:#ccc;font-size:.875rem}
footer a{color:#aaa}

/* Hero */
.hero{position:relative;min-height:400px;display:flex;align-items:center;padding:3rem var(--gap);overflow:hidden}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1}
.hero h1,.hero h2,.hero p{position:relative;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.5)}
.hero h1{font-size:3rem}

/* Cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--gap);padding:var(--gap) 0}
.cards>div{border:1px solid #e0e0e0;border-radius:var(--radius);overflow:hidden;background:#fff}
.cards>div>div:last-child{padding:1rem}

/* Columns */
.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:var(--gap);padding:var(--gap) 0;align-items:center}

/* Carousel */
.carousel{overflow-x:auto;display:flex;gap:1rem;scroll-snap-type:x mandatory;padding:var(--gap) 0}
.carousel>div{flex:0 0 80%;scroll-snap-align:start;border-radius:var(--radius);overflow:hidden}

/* Teaser */
.teaser{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap);padding:var(--gap) 0;align-items:center}

/* Content Fragment */
.content-fragment{padding:var(--gap);background:#f9f9f9;border-radius:var(--radius);margin:var(--gap) 0}

/* Video */
.video{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:var(--radius)}
.video iframe,.video video{position:absolute;top:0;left:0;width:100%;height:100%}

/* Dynamic Media */
.dynamicmedia-image img,.dynamicmedia-template img{width:100%;border-radius:var(--radius)}

/* CTA buttons */
a[href]:not([href="#"]){display:inline-block;padding:.5rem 1.5rem;background:var(--brand);color:#fff;border-radius:var(--radius);font-weight:600;text-decoration:none;margin:.25rem .25rem .25rem 0}

/* Section spacing */
main>div{padding:var(--gap) 0}
main>div+div{border-top:1px solid #f0f0f0}
</style>`;
    html = html.replace(/<head>/, `<head>${aemFallbackCss}`);

    // Cache: 5min default, no-cache if _t= param present (post-write refresh)
    const cacheHeader = cacheBust
      ? 'no-store, no-cache, must-revalidate'
      : 'public, max-age=300';

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': cacheHeader,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(`Preview error: ${err.message}`, { status: 502 });
  }
}

/* ─── GET /ims/login — Redirect to Adobe IMS for user-level auth ─── */

const COMPASS_OAUTH_CLIENT_ID = '8477ad6112764435814b12d28a778647';
const COMPASS_OAUTH_USER_SCOPE = 'AdobeID,openid';

async function handleImsLogin(request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('return_to') || ALLOWED_RETURN_URLS[0];

  if (!ALLOWED_RETURN_URLS.some((a) => returnTo.startsWith(a))) {
    return new Response('Invalid return_to URL', { status: 400 });
  }

  const callbackUrl = `${url.origin}/ims/callback`;

  // OAuth Web App uses authorization_code flow (not implicit)
  const params = new URLSearchParams({
    client_id: COMPASS_OAUTH_CLIENT_ID,
    scope: COMPASS_OAUTH_USER_SCOPE,
    response_type: 'code',
    redirect_uri: callbackUrl,
    state: encodeURIComponent(returnTo),
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
  const returnTo = state ? decodeURIComponent(state) : ALLOWED_RETURN_URLS[0];

  if (error) {
    return new Response(`Adobe sign-in error: ${error} — ${url.searchParams.get('error_description') || ''}`, {
      status: 400, headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (!code) {
    return new Response('Sign-in failed. No authorization code received.', {
      status: 400, headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Exchange authorization code for access token (server-side — secret never exposed)
  try {
    const callbackUrl = `${url.origin}/ims/callback`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: COMPASS_OAUTH_CLIENT_ID,
      client_secret: typeof COMPASS_OAUTH_SECRET !== 'undefined' ? COMPASS_OAUTH_SECRET : '',
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

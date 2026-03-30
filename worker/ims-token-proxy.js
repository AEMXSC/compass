/**
 * Cloudflare Worker — IMS Token Exchange Proxy
 *
 * Proxies the PKCE token exchange to Adobe IMS because
 * ims-na1.adobelogin.com/ims/token/v3 doesn't send CORS headers
 * for browser-based SPAs.
 *
 * Deploy: npx wrangler deploy
 */

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

const ALLOWED_ORIGINS = [
  'https://aemxsc.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const origin = request.headers.get('Origin') || '';

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
  }

  // Only allow requests from known origins
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    // Forward the form body directly to IMS
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

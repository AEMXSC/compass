/*
 * SpaceCat / AEM Sites Optimizer — Direct REST Client
 * spacecat.experiencecloud.live/api/v1
 *
 * Auth: SpaceCat issues its own JWT via POST /auth/login (exchange of IMS user token).
 * The returned JWT (aud: spacecat-users, iss: spacecat.experiencecloud.live) is
 * used on all subsequent requests in the `authorization` header.
 */

import { getUserToken } from './ims.js';

const SPACECAT_BASE = 'https://spacecat.experiencecloud.live/api/v1';

let cachedSpacecatToken = null;
let cachedSpacecatExpiry = 0;

async function getSpacecatToken() {
  const now = Date.now();
  if (cachedSpacecatToken && now < cachedSpacecatExpiry - 60_000) return cachedSpacecatToken;

  const imsToken = getUserToken();
  if (!imsToken) throw new Error('User sign-in required for Sites Optimizer');

  const resp = await fetch(`${SPACECAT_BASE}/auth/login`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${imsToken}`,
      'content-type': 'application/json',
      'x-client-type': 'sites-optimizer-ui',
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`SpaceCat login ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const data = await resp.json();
  // Response is either { token: '...' } or the token string directly
  const token = data?.token || data?.access_token || (typeof data === 'string' ? data : null);
  if (!token) throw new Error('SpaceCat login: no token in response');

  // Parse exp from JWT payload (middle segment)
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    cachedSpacecatExpiry = (payload.exp || 0) * 1000;
  } catch {
    cachedSpacecatExpiry = now + 3600_000; // fallback: 1 hour
  }
  cachedSpacecatToken = token;
  return token;
}

async function spacecatFetch(path) {
  const token = await getSpacecatToken();
  const resp = await fetch(`${SPACECAT_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-client-type': 'sites-optimizer-ui',
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`SpaceCat ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return resp.json();
}

/**
 * Resolve a site UUID by its base URL.
 */
export async function getSiteId(baseUrl) {
  const encoded = btoa(baseUrl);
  const data = await spacecatFetch(`/sites/by-base-url/${encoded}`);
  return data?.id || data?.siteId || null;
}

/**
 * Get all opportunities for a site.
 * Returns { opportunities, summary } shaped for the existing result renderer.
 */
export async function getSiteOpportunities(siteUrl, options = {}) {
  let siteId;
  if (siteUrl.startsWith('http')) {
    siteId = await getSiteId(siteUrl);
    if (!siteId) throw new Error(`Site not found in SpaceCat for URL: ${siteUrl}`);
  } else {
    siteId = siteUrl;
  }

  const raw = await spacecatFetch(`/sites/${siteId}/opportunities`);
  const items = Array.isArray(raw) ? raw : (raw?.opportunities || raw?.items || []);

  let filtered = items;
  if (options.category && options.category !== 'all') {
    filtered = filtered.filter((o) => o.type?.toLowerCase().includes(options.category.toLowerCase()));
  }
  if (options.priority && options.priority !== 'all') {
    filtered = filtered.filter((o) => normalizePriority(o.opportunityImpact) === options.priority);
  }

  const opportunities = filtered.map((o) => ({
    id: o.id,
    title: o.title || o.type || 'Opportunity',
    category: o.type || 'general',
    priority: normalizePriority(o.opportunityImpact || o.priority),
    impact: scoreImpact(o.opportunityImpact || o.priority),
    pages_affected: o.data?.pageCount || o.pageCount || 0,
    status: o.status,
    description: o.description || '',
  }));

  const high = opportunities.filter((o) => o.priority === 'high').length;
  const medium = opportunities.filter((o) => o.priority === 'medium').length;
  const low = opportunities.filter((o) => o.priority === 'low').length;

  return {
    site_id: siteId,
    opportunities,
    summary: { total: opportunities.length, high_priority: high, medium_priority: medium, low_priority: low },
  };
}

/**
 * Get the latest audit for a site.
 */
export async function getSiteAudit(siteUrl, options = {}) {
  let siteId;
  if (siteUrl.startsWith('http')) {
    siteId = await getSiteId(siteUrl);
    if (!siteId) throw new Error(`Site not found in SpaceCat for URL: ${siteUrl}`);
  } else {
    siteId = siteUrl;
  }
  const auditType = options.auditType || 'cwv';
  return spacecatFetch(`/sites/${siteId}/latest-audit/${auditType}`);
}

function normalizePriority(val) {
  if (!val) return 'medium';
  const v = String(val).toLowerCase();
  if (v === 'high' || v === 'critical') return 'high';
  if (v === 'low' || v === 'minimal') return 'low';
  return 'medium';
}

function scoreImpact(val) {
  const v = String(val || '').toLowerCase();
  if (v === 'high' || v === 'critical') return 8;
  if (v === 'low' || v === 'minimal') return 3;
  return 5;
}

// No-op stubs so existing imports don't break
export const initSession = () => Promise.resolve();
export const isAvailable = () => true;
export const discoverTools = () => Promise.resolve([]);

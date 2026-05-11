/*
 * SpaceCat / AEM Sites Optimizer — Direct REST Client
 * spacecat.experiencecloud.live/api/v1
 *
 * Auth: IMS Bearer token (ims_key scheme — user token with Sites Optimizer entitlement).
 * No MCP protocol — SpaceCat exposes a REST API only.
 */

import { getUserToken } from './ims.js';

const SPACECAT_BASE = 'https://spacecat.experiencecloud.live/api/v1';

async function spacecatFetch(path) {
  const token = getUserToken();
  if (!token) throw new Error('User sign-in required for Sites Optimizer');
  const resp = await fetch(`${SPACECAT_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`SpaceCat ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return resp.json();
}

/**
 * Resolve a site UUID by its base URL.
 * baseUrl e.g. "https://main--frescopa--aemshowcase2.aem.live"
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
  // Accept raw UUID or a URL — derive UUID if needed
  if (siteUrl.startsWith('https://') || siteUrl.startsWith('http://')) {
    siteId = await getSiteId(siteUrl);
    if (!siteId) throw new Error(`Site not found in SpaceCat for URL: ${siteUrl}`);
  } else {
    siteId = siteUrl;
  }

  const path = options.priority && options.priority !== 'all'
    ? `/sites/${siteId}/opportunities/by-status/NEW`
    : `/sites/${siteId}/opportunities`;
  const raw = await spacecatFetch(path);

  // Normalize to array
  const items = Array.isArray(raw) ? raw : (raw?.opportunities || raw?.items || []);

  // Filter by category/priority if requested
  let filtered = items;
  if (options.category && options.category !== 'all') {
    filtered = filtered.filter((o) => o.type?.toLowerCase().includes(options.category.toLowerCase()));
  }
  if (options.priority && options.priority !== 'all') {
    filtered = filtered.filter((o) => o.opportunityImpact?.toLowerCase() === options.priority.toLowerCase());
  }

  // Map SpaceCat schema → existing renderer schema
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
 * Get the latest audit data for a site.
 */
export async function getSiteAudit(siteUrl, options = {}) {
  let siteId;
  if (siteUrl.startsWith('https://') || siteUrl.startsWith('http://')) {
    siteId = await getSiteId(siteUrl);
    if (!siteId) throw new Error(`Site not found in SpaceCat for URL: ${siteUrl}`);
  } else {
    siteId = siteUrl;
  }

  const auditType = options.auditType || 'cwv';
  const data = await spacecatFetch(`/sites/${siteId}/latest-audit/${auditType}`);
  return data;
}

/**
 * Get the latest KPI metrics for a site.
 */
export async function getSiteMetrics(siteId) {
  return spacecatFetch(`/sites/${siteId}/latest-metrics`);
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

// No-op stubs so ai.js imports don't break
export const initSession = () => Promise.resolve();
export const isAvailable = () => true;
export const discoverTools = () => Promise.resolve([]);

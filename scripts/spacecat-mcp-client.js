/*
 * SpaceCat / AEM Sites Optimizer — REST Client via Worker Proxy
 * spacecat.experiencecloud.live/api/v1
 *
 * All calls route through the Compass worker at /spacecat/*.
 * The worker exchanges the user's IMS token for a SpaceCat JWT
 * (POST /auth/login) and adds x-client-type: sites-optimizer-ui.
 * This avoids CORS issues — SpaceCat only allows experience.adobe.com origin.
 */

import { getUserToken } from './ims.js';

const WORKER_BASE = (localStorage.getItem('ew-ims-proxy') || 'https://compass-ims-proxy.compass-xsc.workers.dev');
const SPACECAT_PROXY = `${WORKER_BASE}/spacecat/api/v1`;

async function spacecatFetch(path) {
  const imsToken = getUserToken();
  if (!imsToken) throw new Error('User sign-in required for Sites Optimizer');
  const resp = await fetch(`${SPACECAT_PROXY}${path}`, {
    headers: { Authorization: `Bearer ${imsToken}` },
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

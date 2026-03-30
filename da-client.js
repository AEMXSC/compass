/*
 * DA (Document Authoring) API Client
 * Routes content operations through DA MCP (mcp.adobeaemcloud.com)
 * Falls back to direct admin.da.live calls if MCP is unavailable.
 *
 * Preview/Publish still go through admin.hlx.page (not in MCP scope).
 * Configurable via configure() — call from app.js with AEM_ORG values.
 */

import { fetchWithToken, getToken } from './ims.js';
import * as mcp from './da-mcp-client.js';

const DA_ADMIN = 'https://admin.da.live';
let DA_ORG = 'AEMXSC';
let DA_REPO = 'xscteamsite';
let DA_BRANCH = 'main';

/* MCP availability flag — starts null (unknown), set on first attempt */
let mcpAvailable = null;

export function configure({ org, repo, branch } = {}) {
  if (org) DA_ORG = org;
  if (repo) DA_REPO = repo;
  if (branch) DA_BRANCH = branch;
}

export function getOrg() { return DA_ORG; }
export function getRepo() { return DA_REPO; }
export function getBranch() { return DA_BRANCH; }

export function getBasePath() {
  return `${DA_ADMIN}/source/${DA_ORG}/${DA_REPO}`;
}

/**
 * Check if MCP is available. Caches the result after first probe.
 */
async function checkMcp() {
  if (mcpAvailable !== null) return mcpAvailable;
  try {
    mcpAvailable = await mcp.isAvailable();
    console.log(`[DA] MCP ${mcpAvailable ? 'available' : 'unavailable'} — using ${mcpAvailable ? 'MCP' : 'direct API'}`);
  } catch {
    mcpAvailable = false;
    console.log('[DA] MCP unavailable — using direct API');
  }
  return mcpAvailable;
}

/* ─── Content operations — MCP first, fallback to direct ─── */

export async function listPages(path = '/') {
  if (await checkMcp()) {
    try {
      return await mcp.listSources(DA_ORG, DA_REPO, path);
    } catch (err) {
      console.warn('[DA] MCP listSources failed, falling back:', err.message);
    }
  }
  // Direct fallback
  const url = `${getBasePath()}${path}`;
  const resp = await fetchWithToken(url);
  if (!resp.ok) throw new Error(`DA list failed: ${resp.status}`);
  return resp.json();
}

export async function getPage(path) {
  if (await checkMcp()) {
    try {
      return await mcp.getSource(DA_ORG, DA_REPO, path);
    } catch (err) {
      console.warn('[DA] MCP getSource failed, falling back:', err.message);
    }
  }
  // Direct fallback
  const url = `${getBasePath()}${path}`;
  const resp = await fetchWithToken(url);
  if (!resp.ok) throw new Error(`DA get failed: ${resp.status}`);
  const contentType = resp.headers.get('content-type');
  if (contentType?.includes('text/html')) return resp.text();
  return resp.json();
}

export async function createPage(path, html) {
  if (await checkMcp()) {
    try {
      return await mcp.createSource(DA_ORG, DA_REPO, path, html);
    } catch (err) {
      console.warn('[DA] MCP createSource failed, falling back:', err.message);
    }
  }
  // Direct fallback
  const url = `${getBasePath()}${path}`;
  const blob = new Blob([html], { type: 'text/html' });
  const formData = new FormData();
  formData.append('data', blob, path.split('/').pop());

  const resp = await fetchWithToken(url, {
    method: 'PUT',
    body: formData,
  });
  if (!resp.ok) throw new Error(`DA create failed: ${resp.status}`);
  return resp;
}

export async function updatePage(path, html) {
  if (await checkMcp()) {
    try {
      return await mcp.updateSource(DA_ORG, DA_REPO, path, html);
    } catch (err) {
      console.warn('[DA] MCP updateSource failed, falling back:', err.message);
    }
  }
  // Direct fallback
  return createPage(path, html);
}

export async function deletePage(path) {
  if (await checkMcp()) {
    try {
      return await mcp.deleteSource(DA_ORG, DA_REPO, path);
    } catch (err) {
      console.warn('[DA] MCP deleteSource failed, falling back:', err.message);
    }
  }
  // Direct fallback
  const url = `${getBasePath()}${path}`;
  const resp = await fetchWithToken(url, { method: 'DELETE' });
  if (!resp.ok) throw new Error(`DA delete failed: ${resp.status}`);
  return resp;
}

/* ─── Admin API — admin.hlx.page ─── */

export async function previewPage(path) {
  const url = `https://admin.hlx.page/preview/${DA_ORG}/${DA_REPO}/${DA_BRANCH}${path}`;
  const resp = await fetchWithToken(url, { method: 'POST' });
  return resp;
}

export async function publishPage(path) {
  const url = `https://admin.hlx.page/live/${DA_ORG}/${DA_REPO}/${DA_BRANCH}${path}`;
  const resp = await fetchWithToken(url, { method: 'POST' });
  return resp;
}

/**
 * Get resource status from admin.hlx.page — NO AUTH REQUIRED.
 * Returns preview/live status, URLs, last modified, permissions.
 */
export async function getStatus(path) {
  const url = `https://admin.hlx.page/status/${DA_ORG}/${DA_REPO}/${DA_BRANCH}${path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Status check failed: ${resp.status}`);
  return resp.json();
}

/** Unpublish from preview (.aem.page) */
export async function unpublishPreview(path) {
  const url = `https://admin.hlx.page/preview/${DA_ORG}/${DA_REPO}/${DA_BRANCH}${path}`;
  const resp = await fetchWithToken(url, { method: 'DELETE' });
  return resp;
}

/** Unpublish from live (.aem.live) */
export async function unpublishLive(path) {
  const url = `https://admin.hlx.page/live/${DA_ORG}/${DA_REPO}/${DA_BRANCH}${path}`;
  const resp = await fetchWithToken(url, { method: 'DELETE' });
  return resp;
}

/** Purge CDN cache for a path */
export async function purgeCache(path) {
  const url = `https://admin.hlx.page/cache/${DA_ORG}/${DA_REPO}/${DA_BRANCH}${path}`;
  const resp = await fetchWithToken(url, { method: 'POST' });
  return resp;
}

/** Sync code from GitHub to CDN */
export async function syncCode() {
  const url = `https://admin.hlx.page/code/${DA_ORG}/${DA_REPO}/${DA_BRANCH}`;
  const resp = await fetchWithToken(url, { method: 'POST' });
  return resp;
}

/** Bulk preview — preview all pages under a path (use "/*" for entire site) */
export async function bulkPreview(paths) {
  const url = `https://admin.hlx.page/preview/${DA_ORG}/${DA_REPO}/${DA_BRANCH}/*`;
  const resp = await fetchWithToken(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  return resp;
}

/** Bulk publish — publish all pages under a path */
export async function bulkPublish(paths) {
  const url = `https://admin.hlx.page/live/${DA_ORG}/${DA_REPO}/${DA_BRANCH}/*`;
  const resp = await fetchWithToken(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  return resp;
}

/** Re-index a path (updates query-index) */
export async function reindex(path) {
  const url = `https://admin.hlx.page/index/${DA_ORG}/${DA_REPO}/${DA_BRANCH}${path}`;
  const resp = await fetchWithToken(url, { method: 'POST' });
  return resp;
}

/* ─── URL helpers ─── */

export function getPreviewUrl(path) {
  return `https://${DA_BRANCH}--${DA_REPO.toLowerCase()}--${DA_ORG.toLowerCase()}.aem.page${path}`;
}

export function getLiveUrl(path) {
  return `https://${DA_BRANCH}--${DA_REPO.toLowerCase()}--${DA_ORG.toLowerCase()}.aem.live${path}`;
}

export function isAuthenticated() {
  return !!getToken();
}

/**
 * Force MCP re-check (e.g. after sign-in).
 */
export function resetMcpState() {
  mcpAvailable = null;
  mcp.resetSession();
}

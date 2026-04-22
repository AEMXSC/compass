/*
 * Site Type Detection
 *
 * Determines whether a connected site uses DA (Document Authoring) or
 * AEM CS (xwalk / Universal Editor) by parsing fstab.yaml from the code repo.
 *
 * Detection rules:
 *   - content.da.live → DA mode → GitHub API for writes
 *   - author-*.adobeaemcloud.com → AEM CS mode → Content MCP for writes
 *   - Anything else → unknown (no write path from EW)
 *
 * The detected site type is stored on window.__EW_SITE_TYPE and window.__EW_AEM_HOST.
 */

import { hasGitHubToken, getGitHubToken } from './github-content.js';

/**
 * Fetch and parse fstab.yaml from a code repo via GitHub API.
 * @param {string} org
 * @param {string} repo
 * @param {string} branch
 * @returns {object|null} parsed mountpoints or null
 */
export async function fetchFstab(org, repo, branch = 'main') {
  const url = `https://api.github.com/repos/${org}/${repo}/contents/fstab.yaml?ref=${branch}`;
  const headers = { Accept: 'application/vnd.github.v3+json' };
  const token = getGitHubToken();
  if (token) headers.Authorization = `token ${token}`;

  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = atob(data.content.replace(/\n/g, ''));
    return parseFstabYaml(content);
  } catch {
    return null;
  }
}

/**
 * Minimal YAML parser for fstab.yaml — extracts mountpoints URL and type.
 * fstab.yaml is simple enough that we don't need a full YAML parser.
 */
function parseFstabYaml(yamlStr) {
  const result = { url: null, type: null };
  const lines = yamlStr.split('\n');

  for (const line of lines) {
    const urlMatch = line.match(/^\s+url:\s*(.+)/);
    if (urlMatch) result.url = urlMatch[1].trim();
    const typeMatch = line.match(/^\s+type:\s*(.+)/);
    if (typeMatch) result.type = typeMatch[1].trim();
  }

  return result;
}

/**
 * Detect the site type from fstab.yaml content source URL.
 * @param {string} url — the content source URL from fstab.yaml
 * @returns {{ siteType: string, aemHost: string|null, contentOrg: string|null, contentRepo: string|null }}
 */
export function detectSiteType(url) {
  if (!url) return { siteType: 'unknown', aemHost: null, contentOrg: null, contentRepo: null };

  // DA: content.da.live/{org}/{repo}
  if (url.includes('content.da.live')) {
    const match = url.match(/content\.da\.live\/([^/]+)\/([^/]+)/);
    return {
      siteType: 'da',
      aemHost: null,
      contentOrg: match ? match[1] : null,
      contentRepo: match ? match[2] : null,
    };
  }

  // AEM CS: author-pXXXXX-eXXXXX.adobeaemcloud.com
  if (url.includes('.adobeaemcloud.com')) {
    const match = url.match(/(author-[^/]+\.adobeaemcloud\.com)/);
    return {
      siteType: 'aem-cs',
      aemHost: match ? match[1] : url.replace(/^https?:\/\//, '').split('/')[0],
      contentOrg: null,
      contentRepo: null,
    };
  }

  // Anything else (SharePoint, Google Drive, etc.) — no write path from EW
  return { siteType: 'unknown', aemHost: null, contentOrg: null, contentRepo: null };
}

/**
 * Detect and cache site type for the currently connected site.
 * Sets window.__EW_SITE_TYPE and window.__EW_AEM_HOST.
 * @param {string} org — code repo org
 * @param {string} repo — code repo name
 * @param {string} branch
 */
export async function detectAndCacheSiteType(org, repo, branch = 'main') {
  const fstab = await fetchFstab(org, repo, branch);

  if (!fstab || !fstab.url) {
    window.__EW_SITE_TYPE = 'unknown';
    window.__EW_AEM_HOST = null;
    window.__EW_CONTENT_ORG = null;
    window.__EW_CONTENT_REPO = null;
    console.debug('[SiteDetect] No fstab.yaml found, type: unknown');
    return 'unknown';
  }

  const { siteType, aemHost, contentOrg, contentRepo } = detectSiteType(fstab.url);

  window.__EW_SITE_TYPE = siteType;
  window.__EW_AEM_HOST = aemHost;
  window.__EW_CONTENT_ORG = contentOrg;
  window.__EW_CONTENT_REPO = contentRepo;
  window.__EW_FSTAB_URL = fstab.url;

  console.debug(`[SiteDetect] ${org}/${repo}: type=${siteType}, host=${aemHost || 'n/a'}, contentOrg=${contentOrg || 'n/a'}, contentRepo=${contentRepo || 'n/a'}`);
  return siteType;
}

/**
 * Get the cached site type. Returns 'da', 'aem-cs', or 'unknown'.
 */
export function getSiteType() {
  return window.__EW_SITE_TYPE || 'unknown';
}

/**
 * Get the cached AEM author host (only set for aem-cs sites).
 */
export function getAemHost() {
  return window.__EW_AEM_HOST || null;
}

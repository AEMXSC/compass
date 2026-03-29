/*
 * AEM Content MCP Client
 * JCR content CRUD via mcp.adobeaemcloud.com/adobe/mcp/content
 *
 * This is the real write path for AEM CS / xwalk / Universal Editor sites.
 * Handles pages and content fragments in JCR. NO AI credits consumed.
 *
 * Auth: IMS Bearer token (same as DA MCP).
 *
 * Tool names are discovered dynamically via tools/list.
 * We provide convenience wrappers that map to expected tool patterns.
 */

import { contentMcp } from './mcp-client.js';

export const initSession = () => contentMcp.initSession();
export const callTool = (name, args) => contentMcp.callTool(name, args);
export const getToolSchemas = () => contentMcp.getToolSchemas();
export const resetSession = () => contentMcp.resetSession();
export const isAvailable = () => contentMcp.isAvailable();

/* ─── Page operations ─── */

/**
 * Get page content by path.
 * @param {string} host — AEM author host (e.g. 'author-pXXXXX-eXXXXX.adobeaemcloud.com')
 * @param {string} pagePath — JCR page path (e.g. '/content/mysite/en/homepage')
 */
export async function getPage(host, pagePath) {
  return callTool('get_page', { host, path: pagePath });
}

/**
 * Create a new page.
 */
export async function createPage(host, pagePath, title, template) {
  return callTool('create_page', { host, path: pagePath, title, template });
}

/**
 * Update/patch page content.
 * @param {object} updates — field-value pairs to update
 * @param {string} etag — optimistic concurrency token
 */
export async function updatePage(host, pagePath, updates, etag) {
  const args = { host, path: pagePath, updates };
  if (etag) args.etag = etag;
  return callTool('update_page', args);
}

/**
 * Copy a page to a new location.
 */
export async function copyPage(host, sourcePath, destinationPath, title) {
  return callTool('copy_page', { host, source: sourcePath, destination: destinationPath, title });
}

/**
 * Delete a page.
 */
export async function deletePage(host, pagePath) {
  return callTool('delete_page', { host, path: pagePath });
}

/**
 * List child pages.
 */
export async function listPages(host, parentPath) {
  return callTool('list_pages', { host, path: parentPath });
}

/* ─── Content Fragment operations ─── */

export async function getFragment(host, fragmentPath) {
  return callTool('get_fragment', { host, path: fragmentPath });
}

export async function createFragment(host, parentPath, title, model, data) {
  return callTool('create_fragment', { host, parent: parentPath, title, model, data });
}

export async function updateFragment(host, fragmentPath, data, etag) {
  const args = { host, path: fragmentPath, data };
  if (etag) args.etag = etag;
  return callTool('update_fragment', args);
}

/* ─── Launch operations ─── */

export async function createLaunch(host, pagePaths, launchName) {
  return callTool('create_launch', { host, pages: pagePaths, name: launchName });
}

export async function promoteLaunch(host, launchId) {
  return callTool('promote_launch', { host, launch_id: launchId });
}

/* ─── Dynamic tool discovery ─── */

/**
 * List all available tools from this endpoint.
 * Useful for discovering exact tool names and schemas at runtime.
 */
export async function discoverTools() {
  await initSession();
  return getToolSchemas();
}

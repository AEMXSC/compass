/*
 * Discovery MCP Client
 * Search assets, content fragments, forms, pages via mcp.adobeaemcloud.com/adobe/mcp/discovery
 *
 * Uses AI credits. Provides intelligent search across AEM content.
 * Auth: IMS Bearer token.
 */

import { discoveryMcp } from './mcp-client.js';

export const initSession = () => discoveryMcp.initSession();
export const callTool = (name, args) => discoveryMcp.callTool(name, args);
export const getToolSchemas = () => discoveryMcp.getToolSchemas();
export const resetSession = () => discoveryMcp.resetSession();
export const isAvailable = () => discoveryMcp.isAvailable();

/**
 * Search for assets in the DAM.
 */
export async function searchAssets(host, query, options = {}) {
  return callTool('search_assets', {
    host,
    query,
    asset_type: options.assetType || 'any',
    limit: options.limit || 10,
    ...options,
  });
}

/**
 * Search for content fragments.
 */
export async function searchFragments(host, query, options = {}) {
  return callTool('search_fragments', {
    host,
    query,
    limit: options.limit || 10,
    ...options,
  });
}

/**
 * Search for pages.
 */
export async function searchPages(host, query, options = {}) {
  return callTool('search_pages', {
    host,
    query,
    limit: options.limit || 10,
    ...options,
  });
}

/**
 * Check asset expiry / DRM status.
 */
export async function checkAssetExpiry(host, options = {}) {
  return callTool('check_asset_expiry', {
    host,
    days_until_expiry: options.days || 30,
    folder: options.folder,
    include_expired: options.includeExpired !== false,
  });
}

/**
 * Audit content for staleness.
 */
export async function auditContent(host, options = {}) {
  return callTool('audit_content', {
    host,
    content_type: options.contentType || 'all',
    stale_days: options.staleDays || 90,
    status_filter: options.statusFilter || 'published',
  });
}

/**
 * Add assets to a DAM collection.
 */
export async function addToCollection(host, collectionName, assetPaths, options = {}) {
  return callTool('add_to_collection', {
    host,
    collection_name: collectionName,
    asset_paths: assetPaths,
    create_if_missing: options.createIfMissing !== false,
  });
}

/**
 * Discover available discovery tools at runtime.
 */
export async function discoverTools() {
  await initSession();
  return getToolSchemas();
}

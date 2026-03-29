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
 * Discover available discovery tools at runtime.
 */
export async function discoverTools() {
  await initSession();
  return getToolSchemas();
}

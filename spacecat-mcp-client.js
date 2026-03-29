/*
 * Spacecat / AEM Sites Optimizer MCP Client
 * Site audits, SEO opportunities, CWV metrics, broken backlinks
 * via spacecat.experiencecloud.live/api/v1/mcp
 *
 * Auth: IMS Bearer token.
 */

import { spacecatMcp } from './mcp-client.js';

export const initSession = () => spacecatMcp.initSession();
export const callTool = (name, args) => spacecatMcp.callTool(name, args);
export const getToolSchemas = () => spacecatMcp.getToolSchemas();
export const resetSession = () => spacecatMcp.resetSession();
export const isAvailable = () => spacecatMcp.isAvailable();

/**
 * Get optimization opportunities for a site.
 */
export async function getSiteOpportunities(siteUrl, options = {}) {
  return callTool('get_opportunities', {
    url: siteUrl,
    category: options.category || 'all',
    priority: options.priority || 'all',
    ...options,
  });
}

/**
 * Run or retrieve the latest site audit.
 */
export async function getSiteAudit(siteUrl, options = {}) {
  return callTool('run_audit', {
    url: siteUrl,
    type: options.auditType || 'full',
    ...options,
  });
}

/**
 * Discover available Spacecat tools at runtime.
 */
export async function discoverTools() {
  await initSession();
  return getToolSchemas();
}

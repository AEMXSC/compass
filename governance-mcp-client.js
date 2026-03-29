/*
 * Experience Governance MCP Client
 * Brand policy get + check via mcp.adobeaemcloud.com/adobe/mcp/experience-governance
 *
 * Uses AI credits. Provides skills to retrieve and validate brand policies.
 * Auth: IMS Bearer token.
 */

import { governanceMcp } from './mcp-client.js';

export const initSession = () => governanceMcp.initSession();
export const callTool = (name, args) => governanceMcp.callTool(name, args);
export const getToolSchemas = () => governanceMcp.getToolSchemas();
export const resetSession = () => governanceMcp.resetSession();
export const isAvailable = () => governanceMcp.isAvailable();

/**
 * Get the brand policy for an org/site.
 */
export async function getBrandPolicy(host, siteId) {
  return callTool('get_brand_policy', { host, site_id: siteId });
}

/**
 * Check a page against brand governance policy.
 * Returns compliance status, violations, and recommendations.
 */
export async function checkPagePolicy(host, pagePath, policyId) {
  const args = { host, path: pagePath };
  if (policyId) args.policy_id = policyId;
  return callTool('check_brand_policy', args);
}

/**
 * Discover available governance tools at runtime.
 */
export async function discoverTools() {
  await initSession();
  return getToolSchemas();
}

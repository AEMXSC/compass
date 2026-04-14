/*
 * DA MCP Client
 * Calls DA operations via the MCP endpoint at mcp.adobeaemcloud.com/adobe/mcp/da
 *
 * Now uses the generic MCP client factory from mcp-client.js.
 * Auth: IMS Bearer token.
 */

import { daMcp } from './mcp-client.js';

// Re-export core methods from the factory-created client
export const initSession = () => daMcp.initSession();
export const callTool = (name, args) => daMcp.callTool(name, args);
export const getToolSchemas = () => daMcp.getToolSchemas();
export const resetSession = () => daMcp.resetSession();
export const isAvailable = () => daMcp.isAvailable();

/* ─── Convenience wrappers mapping to DA MCP tools ─── */

export async function listSources(org, repo, path = '/') {
  return callTool('da_list_sources', { org, repo, path });
}

export async function getSource(org, repo, path) {
  return callTool('da_get_source', { org, repo, path });
}

export async function createSource(org, repo, path, content) {
  return callTool('da_create_source', { org, repo, path, content });
}

export async function updateSource(org, repo, path, content) {
  return callTool('da_update_source', { org, repo, path, content });
}

export async function deleteSource(org, repo, path) {
  return callTool('da_delete_source', { org, repo, path });
}

export async function copyContent(org, repo, source, destination) {
  return callTool('da_copy_content', { org, repo, source, destination });
}

export async function moveContent(org, repo, source, destination) {
  return callTool('da_move_content', { org, repo, source, destination });
}

export async function getVersions(org, repo, path) {
  return callTool('da_get_versions', { org, repo, path });
}

/*
 * Generic MCP Client Factory
 *
 * All AEM MCP endpoints at mcp.adobeaemcloud.com share the same protocol:
 * MCP Streamable HTTP (JSON-RPC 2.0) with IMS Bearer auth.
 *
 * This factory creates endpoint-specific clients with identical transport
 * logic — only the base URL differs.
 *
 * Endpoints:
 *   /adobe/mcp/da              — DA content operations (CRUD)
 *   /adobe/mcp/content         — AEM CS JCR content operations (CRUD)
 *   /adobe/mcp/content-readonly — Read-only content/asset search
 *   /adobe/mcp/content-updater — AI-powered content updates (uses credits)
 *   /adobe/mcp/experience-governance — Brand policy check (uses credits)
 *   /adobe/mcp/discovery       — Asset/CF/form/page search (uses credits)
 *   /adobe/mcp/development     — Pipeline troubleshooting (uses credits)
 */

import { getToken } from './ims.js';

const MCP_BASE = 'https://mcp.adobeaemcloud.com';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const WORKER_MCP_BASE = (localStorage.getItem('ew-ims-proxy') || 'https://compass-ims-proxy.compass-xsc.workers.dev') + '/mcp?endpoint=';

/**
 * Create an MCP client for a specific endpoint path.
 * @param {string} endpointPath — e.g. '/adobe/mcp/content' or full URL 'https://...'
 * @param {string} label — human-readable name for console logs
 * @returns MCP client object with initSession, callTool, getToolSchemas, resetSession, isAvailable
 */
export function createMcpClient(endpointPath, label = 'MCP') {
  const endpoint = endpointPath.startsWith('https://') ? endpointPath : `${MCP_BASE}${endpointPath}`;
  let sessionId = null;
  let requestId = 0;
  let toolSchemas = null;
  let initPromise = null;

  function nextId() {
    requestId += 1;
    return `ew-${label.toLowerCase().replace(/\s+/g, '-')}-${requestId}`;
  }

  /**
   * Send a JSON-RPC request to the MCP endpoint.
   * Handles both direct JSON and SSE response formats.
   */
  async function mcpRequest(method, params = {}, { isNotification = false } = {}) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const body = {
      jsonrpc: '2.0',
      method,
      params,
    };
    if (!isNotification) {
      body.id = nextId();
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // Capture session ID from response headers
    const newSessionId = resp.headers.get('mcp-session-id');
    if (newSessionId) {
      sessionId = newSessionId;
    }

    if (isNotification) return null;

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => '');
      throw new Error(`[${label}] MCP error ${resp.status}: ${errorText.slice(0, 300)}`);
    }

    const contentType = resp.headers.get('content-type') || '';

    // SSE response — parse event stream for the result
    if (contentType.includes('text/event-stream')) {
      const text = await resp.text();
      const lines = text.split('\n');
      let lastData = null;
      for (const line of lines) {
        if (line.startsWith('data: ')) lastData = line.slice(6);
      }
      if (!lastData) return null;
      try {
        const json = JSON.parse(lastData);
        if (json.error) throw new Error(`[${label}] RPC error: ${json.error.message || JSON.stringify(json.error)}`);
        return json.result;
      } catch (e) {
        if (e.message.includes('RPC error')) throw e;
        return lastData;
      }
    }

    // Direct JSON response
    const json = await resp.json();
    if (json.error) {
      throw new Error(`[${label}] RPC error: ${json.error.message || JSON.stringify(json.error)}`);
    }
    return json.result;
  }

  /**
   * Initialize MCP session — handshake + tool discovery.
   */
  async function initSession() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const initResult = await mcpRequest('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'experience-workspace', version: '1.0.0' },
        });
        console.debug(`[${label}] Session initialized:`, initResult?.serverInfo?.name || 'unknown');

        await mcpRequest('notifications/initialized', {}, { isNotification: true });

        const toolsResult = await mcpRequest('tools/list', {});
        if (toolsResult?.tools) {
          toolSchemas = {};
          for (const tool of toolsResult.tools) {
            toolSchemas[tool.name] = tool;
          }
          console.debug(`[${label}] Tools:`, Object.keys(toolSchemas).join(', '));
        }
        return true;
      } catch (err) {
        console.warn(`[${label}] Init failed:`, err.message);
        initPromise = null;
        throw err;
      }
    })();

    return initPromise;
  }

  /**
   * Call an MCP tool by name. Auto-initializes session if needed.
   */
  async function callTool(toolName, args = {}) {
    await initSession();

    const result = await mcpRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    if (result?.content) {
      const textItems = result.content.filter((c) => c.type === 'text');
      if (textItems.length === 1) {
        try { return JSON.parse(textItems[0].text); } catch { return textItems[0].text; }
      }
      return result.content;
    }
    return result;
  }

  function getToolSchemasFn() { return toolSchemas; }

  function resetSession() {
    sessionId = null;
    toolSchemas = null;
    initPromise = null;
    requestId = 0;
  }

  async function isAvailable() {
    try { await initSession(); return true; } catch { return false; }
  }

  return {
    initSession,
    callTool,
    getToolSchemas: getToolSchemasFn,
    resetSession,
    isAvailable,
    get endpoint() { return endpoint; },
    get label() { return label; },
  };
}

/* ─── Pre-built endpoint clients ─── */
/* ALL routed through CF Worker /mcp proxy for CORS (mcp-session-id header) + S2S auth injection */

// ── AEM Content (Critical) ──
export const daMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/da', 'DA-MCP');
export const contentMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/content', 'AEM-Content');
export const contentReadonlyMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/content-readonly', 'AEM-ReadOnly');
export const contentUpdaterMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/content-updater', 'AEM-Updater');
export const aemUnifiedMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/aem', 'AEM-Unified');

// ── AEM Governance & Discovery (Critical) ──
export const governanceMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/experience-governance', 'AEM-Governance');
export const discoveryMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/discovery', 'AEM-Discovery');

// ── AEM Development ──
export const developmentMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/development', 'AEM-Dev');

// ── Analytics & Insights (High Value) ──
export const cjaMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/cja', 'CJA');
export const aaMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/adobe-analytics', 'Adobe-Analytics');

// ── Cross-Product (High Value) ──
export const acrobatMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/acrobat', 'Acrobat');
export const marketingMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/marketing-agent', 'Marketing-Agent');
export const targetMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/target', 'Target');
export const rtcdpMcp = createMcpClient(WORKER_MCP_BASE + '/adobe/mcp/rtcdp', 'RT-CDP');

// ── External (not Adobe MCP — different protocol) ──
export const spacecatMcp = createMcpClient('https://spacecat.experiencecloud.live/api/v1/mcp', 'Spacecat');

/**
 * Pre-warm critical MCP sessions in parallel on site connect.
 * Each session takes ~350ms for handshake. Running 4 in parallel = ~400ms total.
 * Subsequent tool calls skip the handshake entirely.
 */
export async function prewarmSessions() {
  const critical = [aemUnifiedMcp, discoveryMcp, governanceMcp, contentMcp];
  const results = await Promise.allSettled(critical.map((c) => c.initSession()));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  console.debug(`[MCP] Pre-warmed ${ok}/${critical.length} sessions`);
  return ok;
}

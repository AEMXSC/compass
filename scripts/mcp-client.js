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

import { getToken, ensureToken, signInMcpOAuth } from './ims.js';

const MCP_BASE = 'https://mcp.adobeaemcloud.com';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const WORKER_MCP_BASE = (localStorage.getItem('ew-ims-proxy') || 'https://compass-ims-proxy.compass-xsc.workers.dev') + '/mcp?endpoint=';

/**
 * Flatten a nested AEM page items tree into a compact summary for Claude.
 * Returns { eTag, properties, components[] } where each component entry has
 * the FULL patch-ready path so Claude can use it directly in jsonPatch without guessing.
 * e.g. { patchPath: "/items/0/items/0:0/items/0:0:0/properties/text", value: "<h1>..." }
 */
function summarizePageContent(eTag, content) {
  const components = [];

  function walk(items, prefix) {
    if (!items || typeof items !== 'object') return;
    for (const [key, val] of Object.entries(items)) {
      if (!val || typeof val !== 'object') continue;
      const itemPath = `${prefix}/${key}`;
      if (val.properties) {
        const p = val.properties;
        const id = val.id || key;
        const name = p.name || p['jcr:title'] || p.title || id;
        // Emit one entry per editable text/title property with its full patch path
        if (p.text !== undefined) {
          components.push({ name, patchPath: `${itemPath}/properties/text`, value: p.text });
        }
        if (p['jcr:title'] !== undefined) {
          components.push({ name, patchPath: `${itemPath}/properties/jcr:title`, value: p['jcr:title'] });
        } else if (p.title !== undefined) {
          components.push({ name, patchPath: `${itemPath}/properties/title`, value: p.title });
        }
      }
      if (val.items) walk(val.items, `${itemPath}/items`);
    }
  }

  walk(content.items, '/items');

  return {
    eTag,
    pageProperties: {
      'jcr:title': content.properties?.['jcr:title'],
      pageTitle: content.properties?.pageTitle,
    },
    components,
  };
}

/**
 * Create an MCP client for a specific endpoint path.
 * @param {string} endpointPath — e.g. '/adobe/mcp/content' or full URL 'https://...'
 * @param {string} label — human-readable name for console logs
 * @param {object} options — { tokenKey: 'ew-mcp-token-aa' } for per-product token storage
 * @returns MCP client object with initSession, callTool, getToolSchemas, resetSession, isAvailable
 */
export function createMcpClient(endpointPath, label = 'MCP', options = {}) {
  // All endpoints route through the worker — needed for auth header injection and CORS
  // Full URLs are passed as ?endpoint=<url> so the worker can proxy with product headers
  const endpoint = endpointPath.startsWith('https://')
    ? `${WORKER_MCP_BASE}${encodeURIComponent(endpointPath)}`
    : `${WORKER_MCP_BASE}${endpointPath}`;
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
  async function mcpRequest(method, params = {}, { isNotification = false, _isRetry = false } = {}) {
    // Token priority: per-product token → MCP OAuth → Dev Console S2S → IMS session
    const productToken = options.tokenKey ? localStorage.getItem(options.tokenKey) : null;
    const mcpToken = productToken || localStorage.getItem('ew-mcp-token');
    const s2sToken = localStorage.getItem('ew-s2s-token');
    const token = mcpToken || s2sToken || getToken();
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
      // 401 with a stale/malformed MCP OAuth token — re-auth, retry once.
      // Only remove the token AFTER a successful refresh (avoids clearing it for
      // parallel prewarm clients that haven't sent their request yet).
      if (resp.status === 401 && !_isRetry) {
        if (options.tokenKey) {
          // Product-specific token is stale — clear it and fall back to IMS on retry
          localStorage.removeItem(options.tokenKey);
        } else {
          try {
            const fresh = await signInMcpOAuth();
            if (fresh) {
              localStorage.setItem('ew-mcp-token', fresh);
              return mcpRequest(method, params, { isNotification, _isRetry: true });
            }
          } catch { /* fall through to error below */ }
          localStorage.removeItem('ew-mcp-token');
        }
      }
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
        // Ensure we have a valid token before MCP init
        await ensureToken();

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

    // Resolve underscore variant back to the server's hyphenated name if needed
    const serverName = toolSchemas?.[toolName]
      ? toolName
      : (toolSchemas?.[toolName.replace(/_/g, '-')] ? toolName.replace(/_/g, '-') : toolName);

    // Normalize patch-aem-page-content args — Claude naturally sends the wrong types
    const normalizedArgs = { ...args };
    if (serverName === 'patch-aem-page-content' || toolName === 'patch_aem_page_content') {
      // eTag must be a quoted HTTP ETag string e.g. '"abc123"' — Claude strips the quotes
      if (normalizedArgs.eTag && !String(normalizedArgs.eTag).startsWith('"')) {
        normalizedArgs.eTag = `"${normalizedArgs.eTag}"`;
      }
      // jsonPatch must be a JSON string — Claude passes it as an array/object
      if (normalizedArgs.jsonPatch && typeof normalizedArgs.jsonPatch !== 'string') {
        normalizedArgs.jsonPatch = JSON.stringify(normalizedArgs.jsonPatch);
      }
    }

    const result = await mcpRequest('tools/call', {
      name: serverName,
      arguments: normalizedArgs,
    });

    if (result?.content) {
      const textItems = result.content.filter((c) => c.type === 'text');
      if (textItems.length === 1) {
        const text = textItems[0].text;
        // Try pure JSON first
        try { return JSON.parse(text); } catch { /* fall through */ }
        // get-aem-page-content: "Page Content (map-based):\nETag: "abc"\n{...}"
        // Must check ETag BEFORE array — page JSON body contains arrays that would match otherwise
        const eTagMatch = text.match(/ETag:\s*("?[^"\n]+"?)/);
        if (eTagMatch) {
          const jsonMatch = text.match(/(\{[\s\S]*\})/);
          if (jsonMatch) {
            try {
              const content = JSON.parse(jsonMatch[1]);
              // Summarize the items tree into a flat list so Claude gets compact, actionable data
              // instead of a 50KB nested JSON that causes slow reasoning
              return summarizePageContent(eTagMatch[1], content);
            } catch { /* fall through */ }
          }
        }
        // search-aem-pages: "Showing N items:\n\n[{...}]" — extract the JSON array
        if (!text.startsWith('{')) {
          const arrMatch = text.match(/(\[[\s\S]*\])/);
          if (arrMatch) {
            try { return JSON.parse(arrMatch[1]); } catch { /* fall through */ }
          }
        }
        return text;
      }
      return result.content;
    }
    return result;
  }

  function getToolSchemasFn() { return toolSchemas; }

  function getClaudeTools() {
    if (!toolSchemas) return [];
    return Object.values(toolSchemas).map((t) => ({
      // Claude tool names must be [a-zA-Z0-9_] — convert hyphens to underscores
      name: t.name.replace(/-/g, '_'),
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

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
    getClaudeTools,
    resetSession,
    isAvailable,
    get endpoint() { return endpoint; },
    get label() { return label; },
  };
}

/* ─── Pre-built endpoint clients ─── */
/* Direct connection — CORS is open on all Adobe MCP endpoints */

const IMS = { tokenKey: 'ew-ims-token' };

// ── AEM Content (Critical) ──
export const daMcp = createMcpClient('/adobe/mcp/da', 'DA-MCP', IMS);
export const contentMcp = createMcpClient('/adobe/mcp/content', 'AEM-Content', IMS);
export const contentReadonlyMcp = createMcpClient('/adobe/mcp/content-readonly', 'AEM-ReadOnly', IMS);
export const contentUpdaterMcp = createMcpClient('/adobe/mcp/content-updater', 'AEM-Updater', IMS);
export const aemUnifiedMcp = createMcpClient('/adobe/mcp/aem', 'AEM-Unified', IMS);

// ── AEM Governance & Discovery ──
export const governanceMcp = createMcpClient('/adobe/mcp/experience-governance', 'AEM-Governance', IMS);
export const discoveryMcp = createMcpClient('/adobe/mcp/discovery', 'AEM-Discovery', IMS);

// ── AEM Development ──
export const developmentMcp = createMcpClient('/adobe/mcp/development', 'AEM-Dev', IMS);

// ── AEM Odin (Cloud Manager) ──
export const odinMcp = createMcpClient('/adobe/mcp/odin/prod', 'AEM-Odin', IMS);

// ── Experience Production Agent (DA content authoring via MCP) ──
export const experienceProductionMcp = createMcpClient('/adobe/mcp/experience-production', 'Experience-Production', IMS);

// ── Firefly (Image Generation) ──
export const fireflyMcp = createMcpClient('/adobe/mcp/loki/firefly', 'Firefly', IMS);

// ── Adobe Journey Optimizer ──
export const ajoMcp = createMcpClient('/adobe/mcp/loki/ajo', 'AJO', IMS);

// ── Content QA Agent ──
export const contentQaMcp = createMcpClient('/adobe/mcp/loki/content-qa', 'Content-QA', IMS);

// ── Content Generation Skills ──
export const contentGenMcp = createMcpClient('/adobe/mcp/loki/skills', 'Content-Gen', IMS);

// ── Analytics & Insights (prod gateway) ──
export const cjaMcp = createMcpClient('https://mcp-gateway.adobe.io/cja/mcp', 'CJA', IMS);
export const aaMcp = createMcpClient('https://mcp-gateway.adobe.io/aa/mcp', 'Adobe-Analytics', IMS);

// ── Adobe Express ──
export const expressMcp = createMcpClient('https://express-mcp-service.adobe.io/mcp', 'Adobe-Express', IMS);

// ── Cross-Product ──
export const acrobatMcp = createMcpClient('/adobe/mcp/acrobat', 'Acrobat', IMS);
export const marketingMcp = createMcpClient('https://aep-ai-ama-stage.adobe.io/mcp', 'Marketing-Agent', IMS);
export const targetMcp = createMcpClient('https://targetmcp.adobe.io/mcp', 'Target', IMS);
export const rtcdpMcp = createMcpClient('https://rtcdp-mcp.adobe.io/mcp', 'RT-CDP', IMS);

// ── AEP (Adobe Experience Platform) ──
export const aepMcp = createMcpClient('https://aep-mcp.adobe.io/mcp', 'AEP', IMS);

// ── AJO Prod (standalone host) ──
export const ajoProdMcp = createMcpClient('https://ajo-mcp.adobe.io/mcp', 'AJO-Prod', IMS);

// ── ACPC (Adobe Campaign/Personalization) ──
export const acpcMcp = createMcpClient('https://emcee-stage.adobe.io/mcp', 'ACPC', IMS);

// ── Sites & LLM Optimizer ──
export const sitesOptimizerMcp = createMcpClient('https://m-mcp-demo.adobe.io/mcp', 'Sites-Optimizer', IMS);

// ── External ──
export const spacecatMcp = createMcpClient('https://spacecat.experiencecloud.live/api/v1/mcp', 'Spacecat');

/**
 * MCP Tool Registry — maps tool names to their client instance.
 * Populated lazily when sessions initialize. Used by ai.js to route tool calls.
 */
const mcpToolRegistry = {};

export function registerMcpTools(client) {
  const schemas = client.getToolSchemas();
  if (schemas) {
    for (const name of Object.keys(schemas)) {
      // Register under both hyphenated (server name) and underscored (Claude name)
      mcpToolRegistry[name] = client;
      mcpToolRegistry[name.replace(/-/g, '_')] = client;
    }
  }
}

export function getMcpRegistry() { return mcpToolRegistry; }

export function getAllMcpClaudeTools() {
  const tools = [];
  const seen = new Set();
  for (const [, client] of Object.entries(mcpToolRegistry)) {
    const schemas = client.getToolSchemas();
    if (!schemas) continue;
    for (const [name, schema] of Object.entries(schemas)) {
      const claudeName = name.replace(/-/g, '_');
      if (seen.has(claudeName)) continue;
      seen.add(claudeName);
      tools.push({
        name: claudeName,
        description: schema.description || '',
        input_schema: schema.inputSchema || { type: 'object', properties: {} },
      });
    }
  }
  return tools;
}

// All MCP clients available for session init
export const ALL_MCP_CLIENTS = [
  contentMcp, daMcp, governanceMcp, discoveryMcp, odinMcp,
  experienceProductionMcp, fireflyMcp, contentQaMcp, contentGenMcp,
  ajoMcp, cjaMcp, aaMcp, expressMcp, rtcdpMcp, aepMcp,
  sitesOptimizerMcp, spacecatMcp,
];

/**
 * Initialize MCP sessions and register their tools in the registry.
 * Critical sessions init on load; others lazy.
 */
export async function prewarmSessions() {
  // Critical = clients that work with the general MCP OAuth token on load.
  // contentMcp, governanceMcp, experienceProductionMcp need JCR/site-specific auth (Connect AEM).
  // spacecatMcp needs a different API key — never works with IMS.
  // Those four are lazy-init (triggered on first use after auth).
  const critical = [
    discoveryMcp, fireflyMcp, daMcp, contentGenMcp,
  ];
  const results = await Promise.allSettled(critical.map(async (c) => {
    await c.initSession();
    registerMcpTools(c);
  }));
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      ok++;
    } else {
      console.warn(`[MCP] ${critical[i].label} init failed:`, r.reason?.message?.slice(0, 120));
    }
  });
  console.log(`[MCP] Pre-warmed ${ok}/${critical.length} sessions, ${Object.keys(mcpToolRegistry).length} tools registered`);
  return ok;
}

/**
 * Init a specific MCP client and register its tools (lazy init for non-critical servers).
 */
export async function initAndRegister(client) {
  await client.initSession();
  registerMcpTools(client);
}

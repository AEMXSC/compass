# Project Compass — Architecture

## System Overview

```
                         Browser (eds-migration--compass--aemxsc.aem.page)
                         ┌──────────────────────────────────────────────────┐
                         │  scripts/app.js — UI + chat orchestration        │
                         │  scripts/ai.js — Claude API (streaming, tools)   │
                         │  scripts/ims.js — imslib auth (aem-ext-builder)  │
                         │  scripts/mcp-client.js — 27 MCP clients          │
                         └──────────┬───────────────────┬───────────────────┘
                                    │                   │
                    Direct MCP      │                   │  Worker proxy
                    (user OAuth)    │                   │  (S2S + render)
                                    ▼                   ▼
                ┌───────────────────────┐   ┌──────────────────────────────┐
                │  mcp.adobeaemcloud.com│   │  compass-ims-proxy           │
                │  mcp-gateway.adobe.io │   │  (.compass-xsc.workers.dev)  │
                │  express-mcp-service  │   │                              │
                │  rtcdp-mcp.adobe.io   │   │  /auth — S2S token           │
                │  aep-mcp.adobe.io     │   │  /mcp — session proxy        │
                │  ajo-mcp.adobe.io     │   │  /render — headless Chrome   │
                │  spacecat.exp...live  │   │  /mcp-oauth — token exchange │
                └───────────────────────┘   └──────────────────────────────┘
```

## Intelligence Stack

Compass assembles a 4-layer system prompt for every AI conversation:

```
┌─────────────────────────────────────┐
│  Layer 4: Customer Context (dynamic)│  Page HTML + site type + pageId
├─────────────────────────────────────┤
│  Layer 3: XSC Playbook (~7 KB)     │  Revenue motions, objection handling
├─────────────────────────────────────┤
│  Layer 2: AEM Knowledge (~8 KB)    │  24 skills distilled (CDD, blocks, migration)
├─────────────────────────────────────┤
│  Layer 1: AEM System Prompt (~18KB)│  EDS architecture + tool definitions
└─────────────────────────────────────┘
```

Built in `ai.js` via `buildSystemParts()`.

## Dual-Brain Architecture

| Brain | Trigger | Max Rounds | Tools | Purpose |
|-------|---------|-----------|-------|---------|
| **OPS** | Simple edits ("change", "update", "fix") | 3 | MCP `get-aem-page-content` + `patch-aem-page-content` (JCR) or `edit_page_content` (DA) | Fast 2-call pattern matching Claude.ai |
| **FULL** | Complex prompts, governance, multi-step | 8 | All Compass tools + all MCP-discovered tools | Full reasoning with cross-product orchestration |

## Auth Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Three Token Types                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. imslib User Token (aem-extension-builder)                   │
│     Source: imslib redirect flow → onReady callback             │
│     Storage: imslib internal (adobeid_ims_access_token/...)     │
│     Used for: MCP reads, profile display, org detection         │
│     Limitation: Cannot write via Content MCP (needs MCP OAuth)  │
│                                                                 │
│  2. S2S Service Token                                           │
│     Source: Worker /auth → client_credentials grant             │
│     Storage: localStorage (ew-ims-token)                        │
│     Used for: /render (headless Chrome), MCP session init       │
│     Limitation: Read-only — 403 on content writes               │
│                                                                 │
│  3. MCP OAuth Token (NOT YET WORKING)                           │
│     Source: oauth.adobeaemcloud.com PKCE flow                   │
│     Storage: localStorage (ew-mcp-token)                        │
│     Used for: MCP content writes (patch-aem-page-content)       │
│     Blocker: redirect_uri registration (only localhost accepted) │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## MCP Registry Pattern

```javascript
// scripts/mcp-client.js exports 27 MCP client instances
// Each created via createMcpClient(endpoint, label)

// On session init, tools are registered in a global registry:
//   tool_name → mcp_client_instance

// ai.js routes tool calls:
//   AI returns tool_use(name, args)
//   → lookup name in mcpToolRegistry
//   → if found: route to mcp_client.callTool(name, args)
//   → if not found: route to local executeTool(name, args)
```

## Key Modules

### scripts/app.js — Application Core (~6700 lines)
- Site connect flow (DA detection vs JCR)
- Preview management (DA: .aem.page iframe, JCR: /render endpoint)
- Design mode (DA: da.live/canvas, JCR: rendered srcdoc)
- File browser (DA Admin API tree)
- Chat UI + message rendering
- Tool result display with agent badges

### scripts/ai.js — AI Engine
- Claude API streaming (SSE parsing)
- Dual-brain routing (OPS vs FULL)
- Tool definition generation (Compass + MCP-discovered)
- MCP tool call routing via registry
- History compaction for long conversations

### scripts/ims.js — Authentication
- imslib initialization (aem-extension-builder client)
- Redirect flow sign-in (registered redirect_uri)
- Token retrieval (imslib → localStorage fallback)
- S2S auto-fetch via Worker /auth
- MCP OAuth flow (localhost popup capture — prototype)

### scripts/mcp-client.js — MCP Framework
- Generic MCP client factory (JSON-RPC 2.0 + SSE)
- 27 pre-configured endpoint clients
- Session management (init → session ID → tool calls)
- Tool schema discovery (tools/list → Claude API format)
- Unified registry for cross-client tool routing

### worker/ims-token-proxy.js — Cloudflare Worker
- `/auth` — S2S token generation (client_credentials)
- `/mcp` — MCP proxy (adds Mcp-Session-Id to expose headers)
- `/render` — Headless Chrome page rendering (Browser Rendering API)
- `/mcp-oauth/start` — MCP OAuth PKCE initiation
- `/mcp-oauth/token` — Auth code → token exchange
- CORS management for .aem.page and localhost origins

### aem-knowledge.js — Skill Intelligence (~8 KB)
- Distilled from 24 aemcoder skills (~400KB → ~8KB)
- Content-Driven Development workflow
- 4 Canonical Block Models
- Block development patterns (JS + CSS)
- Three-Phase Loading (E-L-D)
- Migration intelligence

### xsc-playbook.js — Pre-Sales Intelligence (~7 KB)
- Three Revenue Motions (Agentic SKU, Move-to-Cloud, Generative Websites)
- RFP Checkbox Choreography (14 items)
- Demo Patterns That Close Deals
- Conversational Intelligence
- Response Calibration

## JCR Author Preview (Browser Rendering)

```
Client requests /render?url=<author-page>&token=<optional>
  → Worker launches headless Chrome (Cloudflare Browser Rendering)
  → Sets Authorization: Bearer <S2S token> via request interception
  → Navigates to AEM author page (networkidle + 3s wait)
  → Inlines all CSS (reads computed stylesheets)
  → Converts images to base64 data URIs (up to 2MB each)
  → Handles <picture>/<source> srcset and background-image CSS
  → Strips all <script> tags (visual preview only)
  → Returns self-contained HTML (~800KB-1MB)
  → Client renders via blob URL in iframe (avoids main-thread freeze)
```

Cold start: ~12-15s. Warm (session keep-alive): ~5-8s.

## Config Pipeline (AEM Cloud Manager)

S2S client_id `acd5f7410f024fb29412f6add92d3751` + `aem-extension-builder` are allowlisted for AEM author via:

```yaml
# Deployed to git.cloudmanager.adobe.com/aemshowcase2/xsc-cdn-stage/config/api.yaml
kind: "API"
version: "1.0"
metadata:
  envTypes: ["dev", "stage", "prod"]
data:
  allowedClientIDs:
    author:
      - "darkalley"
      - "aem-extension-builder"
      - "acd5f7410f024fb29412f6add92d3751"
```

Deployed via "Stage CDN Deploy" config pipeline in Cloud Manager.

## File Structure (Source of Truth)

```
compass/
├── scripts/
│   ├── app.js              ← THE app (6700 lines) — this is what runs
│   ├── ai.js               ← AI engine + tool routing
│   ├── ims.js              ← Auth (aem-extension-builder, imslib)
│   ├── mcp-client.js       ← 27 MCP client instances + registry
│   ├── scripts.js          ← EDS bootstrap (loads app.js)
│   └── aem.js              ← EDS core decoration
├── worker/
│   ├── ims-token-proxy.js  ← CF Worker (auth, MCP proxy, /render)
│   └── wrangler.toml       ← Worker config
├── styles/
│   └── styles.css          ← Global styles
├── aem-knowledge.js        ← Layer 2 intelligence
├── xsc-playbook.js         ← Layer 3 intelligence
├── customer-profiles.js    ← Per-account context
├── known-sites.js          ← Site registry
├── app.js.disabled         ← OLD root app.js (do not use)
├── index.html              ← OLD entry point (GH Pages, not EDS)
└── docs/
    ├── ARCHITECTURE.md     ← This file
    └── Project-Compass-Wiki-v2.md ← Executive wiki
```

**Important:** The EDS site (`eds-migration--compass--aemxsc.aem.page`) loads from `scripts/`. Root-level `app.js` is disabled. Root `index.html` is for the legacy GitHub Pages deployment only.

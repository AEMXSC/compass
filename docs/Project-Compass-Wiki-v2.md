# Project Compass

*Cross-Product AI Orchestration for AEM — Built by XSC*

**Owner:** Courtney Remekie, Sr. Manager AEM XSC | **Repo:** AEMXSC/compass | **Status:** Functional Prototype, Seeking Production Investment

---

## What It Is

Project Compass is an AI assistant that chains actions across Adobe's product stack from a single conversation. It connects to every Adobe MCP server — AEM Content, Document Authoring, Firefly, Experience Governance, Analytics, Journey Optimizer — and orchestrates multi-product workflows that no single product AI can do alone.

Today it runs as a standalone web app. An XSC connects a site, and Compass reads the page, understands the customer context, and executes operations across Adobe products in response to natural language prompts.

---

## Why It Matters

The native AEM AI Assistant is product-scoped. It helps with AEM tasks but doesn't know your demo environment, your customer's vertical, or how to chain actions across the Adobe stack.

XSCs need an AI that understands the full picture — page context + customer vertical + deal stage + the full product portfolio available to solve the problem. Compass is that AI.

### Validated Differentiators

| Capability | Native AEM AI Assistant | Project Compass |
|---|---|---|
| Cross-product orchestration | AEM only | AEM + DA + Workfront + Firefly + Governance + CJA + AJO via MCP |
| Page-aware context | Requires user to describe page | Reads current page structure + content automatically |
| Customer-specific intelligence | Generic | Per-account system prompt, vertical-specific demo flows |
| Content governance | Not available | Brand policy evaluation across pages (7 governance tools) |
| Author page preview | Requires browser tab switch | Inline preview via headless Chrome rendering |
| DA + JCR unified | Separate tools | Single interface for both authoring backends |

---

## Current Architecture

### Stack (What's Actually Deployed)

| Layer | Technology | Purpose |
|---|---|---|
| UI | Vanilla JS SPA on AEM Edge Delivery Services | Single-page app at `eds-migration--compass--aemxsc.aem.page` |
| Auth | imslib + `aem-extension-builder` IMS client | User OAuth for MCP operations |
| Service Auth | S2S via Cloudflare Worker | Read-only AEM access, JCR page rendering |
| AI Engine | Claude API (Sonnet) | Reasoning, tool selection, content generation |
| MCP Connectivity | Direct browser connections to all Adobe MCP servers | Full product stack integration (CORS verified working) |
| Preview | Cloudflare Worker + Browser Rendering API | Headless Chrome renders authenticated AEM author pages |
| Proxy | Cloudflare Worker (`compass-ims-proxy`) | Auth gateway, MCP session management, page rendering |

### How It Works

```
User connects a site (DA or JCR)
  -> Compass detects site type (DA-backed EDS or AEM Cloud Service)
  -> For DA: loads .aem.page preview directly
  -> For JCR: renders author page via headless Chrome with S2S Bearer auth
  -> MCP sessions initialize (Content, Governance, DA, etc.)
  -> User types a request
  -> Claude reasons + calls MCP tools (same tools Claude.ai uses)
  -> Results shown in chat + preview refreshes
```

### MCP Integrations (All CORS-Verified from .aem.page Origins)

27 MCP clients are wired in `scripts/mcp-client.js`. Key servers:

| MCP Server | Endpoint | Status | Capabilities |
|---|---|---|---|
| AEM Content | `.../adobe/mcp/content` | **Read: Working, Write: Blocked (OAuth)** | 64 tools: get/patch/create pages, fragments, assets |
| AEM Content Read-Only | `.../content-readonly` | **Working** | Asset/page search without write risk |
| AEM Content Updater | `.../content-updater` | **Session Ready** | AI-powered content updates (uses credits) |
| AEM DA | `.../da` | **Working** | Get/create/update/delete/copy/move source, upload media |
| Experience Governance | `.../experience-governance` | **Needs User OAuth** | 7 tools: evaluate page/text/image against brand policies |
| Experience Production | `.../experience-production` | **Working (async, ~30s)** | AI page generation from natural language |
| Discovery | `.../discovery` | **Session Ready** | Asset/CF/form/page search |
| Development | `.../development` | **Session Ready** | Pipeline troubleshooting |
| Cloud Manager (Odin) | `.../odin/prod` | **Session Ready** | Programs, environments, pipelines |
| Firefly | `.../loki/firefly` | **Session Ready** | AI image generation |
| AJO | `.../loki/ajo` | **Session Ready** | Journey orchestration |
| Content QA Agent | `.../loki/content-qa` | **Session Ready** | Content quality validation |
| Content Gen Skills | `.../loki/skills` | **Session Ready** | AI writing with brand voice |
| Target | `.../target` | **Session Ready** | Personalization |
| Acrobat | `.../acrobat` | **Session Ready** | PDF operations |
| CJA | `mcp-gateway.adobe.io/cja/mcp` | **Session Ready** | Customer journey analytics |
| Adobe Analytics | `mcp-gateway.adobe.io/aa/mcp` | **Session Ready** | Reporting queries |
| Adobe Express | `express-mcp-service.adobe.io` | **Session Ready** | Design operations |
| Marketing Agent | `aep-ai-ama-stage.adobe.io` | **Stage** | Marketing orchestration |
| RT-CDP | `rtcdp-mcp.adobe.io` | **Session Ready** | Segments, audiences |
| AEP | `aep-mcp.adobe.io` | **Session Ready** | Platform data operations |
| Sites Optimizer | `m-mcp-demo.adobe.io` | **Session Ready** | SEO, performance audits |
| Spacecat | `spacecat.experiencecloud.live` | **Session Ready** | Site audits |

All `mcp.adobeaemcloud.com` endpoints and external MCP gateways return proper CORS headers for `.aem.page` origins. No proxy required for connectivity — Worker proxy used only for session ID header exposure (browser CORS limitation on `Mcp-Session-Id`).

---

## What Works Today (Demo-Ready)

### DA Site Editing
- Connect any DA-backed EDS site
- Edit content via natural language ("Change the hero headline to...")
- Preview refreshes automatically after edits
- Design mode loads DA canvas (same renderer as da.live)
- File browser shows DA content tree with expandable folders

### JCR Author Page Preview
- Connect any AEM Cloud Service site
- Headless Chrome renders the authenticated author page
- Full CSS + images inlined (self-contained preview)
- S2S Bearer token allowlisted via AEM Config Pipeline
- ~12s cold start, subsequent renders faster with session keep-alive

### MCP Tool Discovery
- All Adobe MCP servers accept CORS from `.aem.page` origins
- Native MCP tool schemas discovered dynamically (not hardcoded)
- Unified registry routes tool calls to correct MCP session
- Same tools Claude.ai uses — identical schemas and parameters

### Intelligence Stack
- 4-layer system prompt: AEM architecture + distilled skills + XSC playbook + customer context
- Operations Brain for fast edits (2-tool pattern: read + patch)
- Thinking Brain for complex multi-step reasoning
- Customer profiles for per-account demo customization

---

## What Doesn't Work Yet (Primary Blocker)

### JCR Content Writes via MCP

**The problem:** MCP Content writes (patch-aem-page-content) require a token from `oauth.adobeaemcloud.com` — the MCP server's own OAuth endpoint. This is separate from standard Adobe IMS authentication.

**Why it's hard:** The MCP OAuth server only accepts redirect URIs that are registered in IMS for the given client. Currently, only `http://localhost` variants are accepted for dynamic client registration. Our production URL (`eds-migration--compass--aemxsc.aem.page`) is rejected.

**What Claude.ai does differently:** Claude.ai's MCP client handles the MCP OAuth flow natively — it registers, does the PKCE auth dance, and gets a write-capable token. Compass needs to replicate this flow.

**Impact:** Reads work (page content, structure, ETags). Writes fail with 403 "Insufficient permissions." The Experience Production Agent works as an alternative (slower, async) but the direct 2-call pattern (read + patch) that Claude.ai uses in 10 seconds cannot complete the write step.

### Resolution Path

| Option | Effort | Dependency |
|--------|--------|-----------|
| Register Compass URL in `darkalley` IMS client for MCP OAuth | Low | Requires IMS admin access (not available to XSC team) |
| Implement localhost popup capture pattern | Medium | Already prototyped in Worker — needs polish |
| Get Compass recognized as a first-party MCP client | Low | Requires MCP team to add our origin to their OAuth registration allowlist |
| Contribute upstream to AEM MCP to support custom redirect URIs | Medium | Requires engagement with AEM MCP team (easingthemes/aem-mcp-server) |

**The ask:** One of these options requires a decision and a small amount of help from an IMS admin or the MCP server team. This unblocks the entire JCR write path.

---

## Relationship to Existing Adobe AI Efforts

### vs. Native AEM AI Assistant
Complementary. The native assistant is product-scoped and ships with AEM. Compass is the cross-product orchestration layer above it — useful for pre-sales demos that span multiple products.

### vs. da-agent (adobe-rnd/da-agent)
da-agent is DA-scoped. Compass uses DA MCP tools for the same operations but adds cross-product context, customer intelligence, and JCR support. The recommended path: contribute XSC-validated patterns upstream to da-agent.

### vs. AEMcoder (aemcoder.adobe.io)
AEMcoder focuses on code generation and block development. Compass focuses on content operations and multi-product orchestration. Different use cases, no conflict.

---

## Strategic Value

### For the Platform Story
Every Compass demo validates Adobe's MCP ecosystem as a real orchestration layer. When an XSC shows a customer that one AI conversation can read AEM content, generate a Firefly image, run a governance check, and update a journey — that's the platform story made tangible.

### For Revenue Motions

| Motion | How Compass Helps |
|--------|------------------|
| **Agentic SKU upsell** | Live demo of Brand Experience Agent running on AEM CS with governance guardrails |
| **Move-to-Cloud** | AI layer that makes cloud AEM productive immediately after migration |
| **Generative Websites** | Experience Production Agent generates full pages from briefs inside the editor |

### Competitive Moat
AI is the layer everyone sells. Governance is the layer nobody wants to rebuild. Compass demonstrates AEM's governance layer (MSM, ACLs, approval chains, audit trails) working alongside AI — the defensible advantage in an AI-first market.

---

## What's Needed to Go Production

### Immediate (Unblocks JCR Writes)
- [ ] IMS admin registers `https://eds-migration--compass--aemxsc.aem.page/` as redirect_uri for `darkalley` in the MCP OAuth registration flow — OR — MCP team adds `.aem.page` origins to their OAuth allowlist
- **Effort:** 1 configuration change, <1 hour
- **Impact:** Unlocks the full 2-call edit pattern (same as Claude.ai)

### Short-Term (Production Quality)
- [ ] Dedicated IMS client for Compass (not borrowing `aem-extension-builder`)
- [ ] Token refresh handling (silent re-auth when tokens expire)
- [ ] Error boundaries and retry logic for MCP session drops
- [ ] Performance: cache page structure, pre-warm MCP sessions on connect
- [ ] Deploy to `main` branch (currently on `eds-migration` feature branch)

### Medium-Term (Scale)
- [ ] Multi-user support (currently single-user demo tool)
- [ ] Persistent conversation history
- [ ] Proper CI/CD (currently manual `git push` + `wrangler deploy`)
- [ ] Observability (Worker analytics, MCP call tracing)
- [ ] Security audit for production deployment

### Longer-Term (Product Integration)
- [ ] UE side panel extension (requires App Builder or UE extension framework)
- [ ] First-party Adobe hosting (eliminates CORS and auth complexity)
- [ ] Native MCP client registration (no OAuth workarounds needed)
- [ ] Integration with Workfront for approval workflows

---

## Demo Environments

| Site | Type | Status |
|------|------|--------|
| SecurBank (`markszulc/securbank-aem-ue`) | AEM CS (xwalk) | Preview working, edits blocked (OAuth) |
| Lifepoint (`aemxsc/lifepoint`) | DA-backed EDS | Fully working (edit + preview + design) |
| XSC Team Site (`aemxsc/xscteamsite`) | DA-backed EDS | Fully working |
| Frescopa | AEM CS (xwalk) | Preview working, edits blocked |
| WKND Universal | AEM CS (xwalk) | Preview working, edits blocked |

**AEM Author Environment:** `author-p153659-e1614585.adobeaemcloud.com` (AEM XSC Showcase org)

---

## Resources

| Resource | Location |
|---|---|
| Source Code | `github.com/AEMXSC/compass` (branch: `eds-migration`) |
| Live App | `eds-migration--compass--aemxsc.aem.page` |
| Worker | `compass-ims-proxy.compass-xsc.workers.dev` |
| AEM MCP Docs | `github.com/easingthemes/aem-mcp-server` |
| DA MCP Docs | `docs.da.live/about/early-access/da-mcp` |
| Config Pipeline | Cloud Manager: `aem-xsc-showcase-program-prod` |
| Stakeholder Sponsor | Jeff Figueiredo (Sr. Director, Americas XSC) |
| Owner | Courtney Remekie (Senior Manager, AEM XSC) |

---

## The One-Line Ask

**We need one IMS configuration change (or MCP team approval) to unblock JCR writes. Everything else is built, tested, and working.** With that single change, Compass matches Claude.ai's edit speed for AEM pages — and adds cross-product orchestration, customer context, and governance that Claude.ai doesn't have.

---

*Accurate as of: May 5, 2026*
*Based on: production codebase + verified testing session*

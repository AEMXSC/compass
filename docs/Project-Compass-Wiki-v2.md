# Project Compass

*Cross-Product AI Orchestration for AEM — Built by XSC*

**Owner:** Courtney Remekie, Sr. Manager AEM XSC | **Repo:** AEMXSC/compass | **Status:** Functional Prototype, Seeking Production Investment

---

## What It Is

Project Compass is an AI assistant that chains actions across Adobe's product stack from a single conversation. It connects to every Adobe MCP server — AEM Content, Document Authoring, Firefly, Experience Governance, Analytics, Journey Optimizer — and orchestrates multi-product workflows that no single product AI can do alone.

Today it runs as a standalone web app. An XSC connects a site, and Compass reads the page, understands the customer context, and executes operations across Adobe products in response to natural language prompts.

**Compass is also a live proof of concept for the BYO Orchestration Layer pattern** — the deployment mode that enterprise customers (developers and technical teams) are asking for. It demonstrates exactly what "bring your own harness and use AEM's MCP + A2A endpoints" looks like in practice.

---

## Where Compass Fits: The Three Agentic Tiers

Adobe's agentic story is structured around three deployment models. Understanding which tier a customer lives in shapes every conversation about AI and AEM.

| Tier | Name | How It Works | Best For |
|------|------|-------------|---------|
| **1** | **Full-stack AEM** | AEM AI Assistant + Experience Workspace — Adobe owns the AI layer, orchestration, and execution context end-to-end | Marketers & practitioners |
| **2** | **AEM-orchestrated** | Customer uses their preferred AI surface (Copilot, Claude, ChatGPT, Gemini) — AEM's Agent Orchestrator provides the content context and manages approved content actions | Business teams |
| **3** | **BYO Orchestration Layer** | Customer builds on their own harness and UI — AEM exposes its capabilities as MCP tools, APIs, and A2A endpoints for the customer to consume | Developers & technical teams |

**Compass lives in Tier 3.** It is a working, customer-demonstrable example of the BYO Orchestration Layer in action:

- Custom AI harness (Claude via Anthropic API)
- Custom UI (EDS-hosted SPA)
- AEM capabilities consumed as MCP tools and APIs
- Governance, authoring, analytics, and creative tools all orchestrated from outside AEM's native UI

> Enterprise customers — especially those with existing internal AI platforms, proprietary orchestration layers, or multi-vendor AI strategies — are actively asking for this tier. Compass gives XSCs something concrete to show them.

### The AEM Stack Context

Compass works across all three AEM deployment architectures:

| Stack | How Compass Connects | Auth Pattern |
|-------|---------------------|-------------|
| **Traditional Stack** (AEM Author + AEM Publish) | JCR MCP — headless Chrome renders author pages, reads + patches JCR content via `patch-aem-page-content` | IMS + MCP OAuth |
| **Edge Delivery Stack** (Document Authoring + Edge Delivery) | DA MCP — direct read/write to DA source, previews via `.aem.page` | IMS |
| **Hybrid** (AEM Author + Edge Delivery) | Either path depending on what's being edited | IMS + MCP OAuth |

~65% of AEM customers are on the Traditional Stack. ~35% are on or moving to the Edge Delivery Stack. Compass is one of very few tools that works natively with both — a meaningful XSC differentiator.

---

## Why It Matters

### The Gap in Adobe's AI Story

Adobe's native AEM AI Assistant is product-scoped. It helps with AEM tasks but doesn't know your demo environment, your customer's vertical, or how to chain actions across the Adobe stack.

XSCs need an AI that understands the full picture — page context + customer vertical + deal stage + the full product portfolio available to solve the problem. Compass is that AI.

More importantly: **enterprise customers are asking for the BYO Orchestration pattern**. They want to surface AEM's capabilities inside their own AI platforms — whether that's an internal enterprise copilot, an industry-specific model, or a multi-cloud AI stack. The question is no longer "does AEM have AI?" It's "can AEM plug into *our* AI?"

Compass proves that answer is yes — and shows how.

### The CMS Value Underneath

The agentic layer only matters because of what's underneath it. AEM's CMS capabilities — versioning & history, omnichannel content delivery, localization & translation, structured authoring, developer efficiency — are what make the MCP integration worth building. Compass demonstrates AI unlocking those capabilities, not replacing them.

### Validated Differentiators

| Capability | Native AEM AI Assistant | Project Compass |
|---|---|---|
| Cross-product orchestration | AEM only | AEM + DA + Workfront + Firefly + Governance + CJA + AJO via MCP |
| Page-aware context | Requires user to describe page | Reads current page structure + content automatically |
| Customer-specific intelligence | Generic | Per-account system prompt, vertical-specific demo flows |
| Content governance | Not available | Brand policy evaluation across pages (7 governance tools) |
| Author page preview | Requires browser tab switch | Inline preview via headless Chrome rendering |
| DA + JCR unified | Separate tools | Single interface for both authoring backends |
| BYO orchestration pattern | Not demonstrable | Live working example — MCP + A2A + custom harness |

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
  -> Page components pre-fetched in background (enables 1-round edits)
  -> User types a request
  -> Claude reasons + calls MCP tools (same tools Claude.ai uses)
  -> Results shown in chat + preview refreshes
```

### Speed Optimization: Pre-Fetch + Synthetic Injection

JCR edits complete in **~10–18 seconds** (vs. 45–60s without optimization). On page connect, Compass pre-fetches `get-aem-page-content` and stores the eTag + component structure. When an edit request arrives, a synthetic tool result is injected before the first API call — Claude's first response is always `patch-aem-page-content`. No intermediate round trips.

### MCP Integrations (All CORS-Verified from .aem.page Origins)

27 MCP clients are wired in `scripts/mcp-client.js`. Key servers:

| MCP Server | Endpoint | Status | Capabilities |
|---|---|---|---|
| AEM Content | `.../adobe/mcp/content` | **Working (Read + Write)** | 64 tools: get/patch/create pages, fragments, assets |
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

---

## What Works Today (Demo-Ready)

### DA Site Editing
- Connect any DA-backed EDS site
- Edit content via natural language ("Change the hero headline to...")
- Preview refreshes automatically after edits (~2s)
- Design mode loads DA canvas (same renderer as da.live)
- File browser shows DA content tree with expandable folders

### JCR Author Page Editing (Now Fully Working)
- Connect any AEM Cloud Service site
- Headless Chrome renders the authenticated author page
- Edit JCR content via natural language — reads, patches, and re-renders in ~10–18s
- Full CSS + images inlined (self-contained preview)
- S2S Bearer token allowlisted via AEM Config Pipeline

### MCP Tool Discovery
- All Adobe MCP servers accept CORS from `.aem.page` origins
- Native MCP tool schemas discovered dynamically (not hardcoded)
- Unified registry routes tool calls to correct MCP session
- Same tools Claude.ai uses — identical schemas and parameters

### Intelligence Stack
- 4-layer system prompt: AEM architecture + distilled skills + XSC playbook + customer context
- Operations Brain for fast edits (pre-fetch + 1-round synthetic injection)
- Thinking Brain for complex multi-step reasoning
- Customer profiles for per-account demo customization

---

## Relationship to Existing Adobe AI Efforts

### vs. Native AEM AI Assistant (Full-stack AEM / Tier 1)
Complementary. The native assistant is product-scoped and ships with AEM. Compass is the BYO orchestration layer above it — useful for pre-sales demos targeting enterprise technical teams who want to integrate AEM into their own AI platforms.

### vs. AEM-orchestrated Pattern (Tier 2)
Compass can also demonstrate the Tier 2 pattern: Claude (or any model) as the preferred UI surface, with AEM's Agent Orchestrator providing content context. The same Compass architecture illustrates both Tier 2 and Tier 3 depending on how the conversation is framed.

### vs. da-agent (adobe-rnd/da-agent)
da-agent is DA-scoped. Compass uses DA MCP tools for the same operations but adds cross-product context, customer intelligence, and JCR support. The recommended path: contribute XSC-validated patterns upstream to da-agent.

### vs. AEMcoder (aemcoder.adobe.io)
AEMcoder focuses on code generation and block development. Compass focuses on content operations and multi-product orchestration. Different use cases, no conflict.

---

## Strategic Value

### For the BYO Orchestration Story (Primary)

Enterprise customers — particularly developers and technical teams — want to plug AEM's capabilities into their own AI platforms. Compass is the only demonstrable proof that this works at full fidelity: content reads, content writes, governance, analytics, creative tools, all from a custom harness via MCP.

When an enterprise customer asks "can we use our own AI?" — Compass is the answer.

### For the Platform Story
Every Compass demo validates Adobe's MCP ecosystem as a real orchestration layer. When an XSC shows a customer that one AI conversation can read AEM content, generate a Firefly image, run a governance check, and update a journey — that's the platform story made tangible.

### For Revenue Motions

| Motion | How Compass Helps |
|--------|------------------|
| **BYO Orchestration Layer** | Live demo for enterprise technical teams who want to extend AEM capabilities into their own AI platforms using MCP + A2A endpoints |
| **Agentic SKU upsell** | Live demo of Brand Experience Agent running on AEM CS with governance guardrails |
| **Move-to-Cloud** | AI layer that makes cloud AEM productive immediately after migration |
| **Generative Websites** | Experience Production Agent generates full pages from briefs inside the editor |
| **EDS Adoption** | Shows DA MCP editing pipeline end-to-end — author → preview → publish via AI |

### Competitive Moat
AI is the layer everyone sells. Governance is the layer nobody wants to rebuild. Compass demonstrates AEM's governance layer (MSM, ACLs, approval chains, audit trails) working alongside AI — the defensible advantage in an AI-first market. The BYO pattern amplifies this: even when the AI model is the customer's own, the governance still runs through Adobe.

---

## What's Needed to Go Production

### Short-Term (Production Quality)
- [ ] Dedicated IMS client for Compass (not borrowing `aem-extension-builder`)
- [ ] Token refresh handling (silent re-auth when tokens expire)
- [ ] Error boundaries and retry logic for MCP session drops
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
- [ ] Reference implementation / starter kit for enterprise BYO orchestration customers

---

## Demo Environments

| Site | Type | Status |
|------|------|--------|
| SecurBank (`markszulc/securbank-aem-ue`) | AEM CS (xwalk) | **Fully working** — preview + edits + re-render |
| Lifepoint (`aemxsc/lifepoint`) | DA-backed EDS | Fully working (edit + preview + design) |
| XSC Team Site (`aemxsc/xscteamsite`) | DA-backed EDS | Fully working |
| Frescopa | AEM CS (xwalk) | Fully working |
| WKND Universal | AEM CS (xwalk) | Fully working |

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

**Compass is fully working — JCR writes, DA edits, cross-product orchestration, and governance all functional. The ask is production investment to take this from XSC prototype to the reference implementation enterprise customers need for the BYO Orchestration Layer.**

---

*Accurate as of: May 5, 2026*
*Based on: production codebase + verified testing session*

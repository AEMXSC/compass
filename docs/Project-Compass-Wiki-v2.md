# Project Compass

*Cross-Product AI Orchestration for AEM — Built by the AEM XSC Team

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
| **1** | **Full-stack AEM** | AEM AI Assistant — Adobe owns the AI layer, orchestration, and execution context end-to-end | Marketers & practitioners |
| **2** | **AEM-orchestrated** | Customer uses their preferred AI surface (Copilot, Claude, ChatGPT, Gemini) — AEM's Agent Orchestrator provides the content context and manages approved content actions | Business teams |
| **3** | **BYO Orchestration Layer** | Customer builds on their own harness and UI — AEM exposes its capabilities as MCP tools, APIs, and A2A endpoints for the customer to consume | Developers & technical teams |

**Compass lives in Tier 3.** It is a working, customer-demonstrable example of the BYO Orchestration Layer in action:

- Custom AI harness (Claude today — swappable for OpenAI, Gemini, or any LLM API)
- Custom UI (EDS-hosted web app)
- AEM capabilities consumed as MCP tools and APIs
- Governance, authoring, analytics, and creative tools all orchestrated from outside AEM's native UI

> Enterprise customers — especially those with existing internal AI platforms, proprietary orchestration layers, or multi-vendor AI strategies — are actively asking for this tier. Compass gives XSCs something concrete to show them.

### The AEM Stack Context

Compass works across all three AEM deployment architectures:

| Stack | How Compass Connects | Auth Pattern |
|-------|---------------------|-------------|
| **Traditional Stack** (AEM Author + AEM Publish) | JCR MCP — headless Chrome renders author pages, reads + patches JCR content via `patch-aem-page-content` | IMS |
| **Edge Delivery Stack** (Document Authoring + Edge Delivery) | DA MCP — direct read/write to DA source, previews via `.aem.page` | IMS |
| **Hybrid** (AEM Author + Edge Delivery) | Either path depending on what's being edited | IMS |

~85% of AEM customers are on the Traditional Stack. ~15% are on or moving to the Edge Delivery Stack. Compass is one of very few tools that works natively with both — a meaningful XSC differentiator.

---

## Problem Statement

Pre-sales demos for AEM's AI story are fragmented. AEM's native AI Assistant is product-scoped and has produced mixed results in front of customers — it doesn't cross into DA, ASO, LLMO, Firefly, Analytics, or Journey Optimizer, and it has no awareness of the customer's vertical, deal stage, or demo environment. XSCs stitching multi-product stories together are doing it manually, with browser tabs and rehearsed click paths.

At the same time, enterprise customers — particularly technical teams — are no longer asking "does AEM have AI?" They're asking **"can AEM plug into *our* AI?"** They have existing AI platforms, internal copilots, or multi-vendor AI strategies, and they want AEM's capabilities as a composable layer inside their own orchestration, not another product UI to log into.

Neither need is served by what exists today. Compass addresses both.

---

## Why It Matters

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
| UI | Vanilla JS web app on AEM Edge Delivery Services | `compass.aemxsc.com` / `eds-migration--compass--aemxsc.aem.page` |
| Auth | imslib + `aem-extension-builder` IMS client | Single IMS sign-in covers all 25 MCP servers — no per-product Connect flow |
| Service Auth | S2S via Cloudflare Worker | Read-only AEM access, JCR page rendering |
| AI Engine | Claude API (Sonnet) | Reasoning, tool selection, content generation |
| MCP Connectivity | All external MCPs routed through Cloudflare Worker BFF | CORS handling, product header injection, allowlist security |
| Preview | Cloudflare Worker + Browser Rendering API | Headless Chrome renders authenticated AEM author pages |
| Proxy | Cloudflare Worker (`compass-ims-proxy`) | Auth gateway, MCP session management, page rendering, MCP proxy |

### How It Works

```
User signs in (IMS — one sign-in covers all 25 MCP servers)
  -> User connects a site (DA or JCR)
  -> Compass detects site type (DA-backed EDS or AEM Cloud Service)
  -> For DA: loads .aem.page preview directly
  -> For JCR: renders author page via headless Chrome with S2S Bearer auth
  -> MCP sessions initialize (Content, Governance, DA, etc.)
  -> Page components pre-fetched in background (enables 1-round edits)
  -> User types a request
  -> If analytics query: AA/CJA tools lazy-loaded on first use
  -> Claude reasons + calls MCP tools (same tools Claude.ai uses)
  -> Results shown in chat + preview refreshes
```

### Speed Optimization: Pre-Fetch + Synthetic Injection

JCR edits complete in **~10–18 seconds** (vs. 45–60s without optimization). On page connect, Compass pre-fetches `get-aem-page-content` and stores the eTag + component structure. When an edit request arrives, a synthetic tool result is injected before the first API call — Claude's first response is always `patch-aem-page-content`. No intermediate round trips.

### MCP Integrations

25 MCP clients are wired in `scripts/mcp-client.js`, all using the user's IMS token. External MCPs (gateway, RT-CDP, AEP, Target, Express, AJO) route through the Cloudflare Worker BFF for CORS handling and product header injection.

**AEM Cloud MCPs** (`mcp.adobeaemcloud.com`)

| MCP Server | Endpoint | Status | Capabilities |
|---|---|---|---|
| AEM Content | `.../adobe/mcp/content` | **Working (Read + Write)** | 64 tools: get/patch/create pages, fragments, assets |
| AEM Content Read-Only | `.../content-readonly` | **Working** | Asset/page search without write risk |
| AEM Content Updater | `.../content-updater` | **Session Ready** | AI-powered content updates (uses credits) |
| AEM DA | `.../da` | **Working** | Get/create/update/delete/copy/move source, upload media |
| Experience Governance | `.../experience-governance` | **Working** | 7 tools: evaluate page/text/image against brand policies |
| Experience Production | `.../experience-production` | **Working (async, ~30s)** | AI page generation from natural language |
| Discovery | `.../discovery` | **Session Ready** | Asset/CF/form/page search |
| Development | `.../development` | **Session Ready** | Pipeline troubleshooting |
| Cloud Manager (Odin) | `.../odin/prod` | **Session Ready** | Programs, environments, pipelines |
| Firefly | `.../loki/firefly` | **Session Ready** | AI image generation |
| AJO | `.../loki/ajo` | **Session Ready** | Journey orchestration |
| Content QA Agent | `.../loki/content-qa` | **Session Ready** | Content quality validation |
| Content Gen Skills | `.../loki/skills` | **Session Ready** | AI writing with brand voice |
| Acrobat | `.../acrobat` | **Session Ready** | PDF operations |

**Experience Cloud MCPs** (via Worker BFF → external gateway)

| MCP Server | Endpoint | Status | Capabilities |
|---|---|---|---|
| Adobe Analytics | `mcp-gateway.adobe.io/aa/mcp` | **Session Ready** | Reporting queries — lazy-loaded on first analytics question |
| CJA | `mcp-gateway.adobe.io/cja/mcp` | **Session Ready** | Customer journey analytics — lazy-loaded on first analytics question |
| Target | `targetmcp.adobe.io/mcp` | **Session Ready** | A/B testing, personalization, activity management |
| RT-CDP | `rtcdp-mcp.adobe.io/mcp` | **Session Ready** | Segments, audiences |
| AEP | `aep-mcp.adobe.io/mcp` | **Session Ready** | Platform data operations |
| AJO Prod | `ajo-mcp.adobe.io/mcp` | **Session Ready** | Journey orchestration (standalone host) |
| Adobe Express | `express-mcp-service.adobe.io/mcp` | **Session Ready** | Design operations |
| Marketing Agent | `aep-ai-ama-stage.adobe.io/mcp` | **Stage** | Marketing orchestration |
| Sites Optimizer | `m-mcp-demo.adobe.io/mcp` | **Session Ready** | SEO, performance audits |
| Spacecat | `spacecat.experiencecloud.live/api/v1/mcp` | **Session Ready** | Site audits |

---

## What Works Today (Demo-Ready)

| Capability | Status | Notes |
|---|---|---|
| DA content editing | **Working** | Edit + preview refresh (~2s) via natural language |
| DA design view / file browser | **Working** | Same renderer as da.live, full content tree |
| JCR content editing | **Working** | ~10–18s end-to-end with pre-fetch optimization |
| AEM author page preview | **Working** | Headless Chrome, full CSS + images inlined |
| Content governance checks | **Working** | No extra OAuth step — IMS sign-in covers it |
| Generative page creation | **Working** | Experience Production Agent, ~30s async |
| Analytics Q&A | **Working** | AA/CJA tools lazy-loaded on first analytics question; AA tool sequence: findCompanies → findReportSuites → setSessionDefaults → runReport |
| Cross-product tool execution | **Working** | 25 MCP servers via single IMS sign-in |
| Customer-specific context | **Working** | Per-account system prompt + vertical demo flows |

---

## Known Limitations

### Not Supported

| Limitation | Notes |
|---|---|
| Multi-user / concurrent sessions | Single-user demo tool — no session isolation |
| Persistent conversation history | Resets on page reload |
| Universal Editor side-panel | Requires App Builder extension framework — not built |
| AEM 6.x / on-premise | JCR path targets AEM Cloud Service only |
| AA/CJA analytics without worker secrets | `AA_GLOBAL_COMPANY_ID` and `IMS_ORG_ID` must be set as Cloudflare Worker secrets for AA reporting to return real data |

### Requires Manual Steps

| Task | Why |
|---|---|
| New JCR environment | S2S Bearer token must be added to Config Pipeline for each new AEM environment |
| Customer profiles | Per-account system prompts are hand-authored — no automated ingestion |
| Worker secrets for analytics | `IMS_ORG_ID`, `AA_GLOBAL_COMPANY_ID`, `AEP_SANDBOX_NAME` — set via `wrangler secret put` in `worker/` |

---

## Gotchas

### Auth: Single IMS Sign-In

All 25 MCP servers — AEM Cloud, DA, Firefly, Governance, AA, CJA, Target, RT-CDP, AEP, AJO — now accept the user's IMS token directly. One sign-in at app load covers everything. No per-product "Connect" buttons, no separate OAuth popups, no local server required for governance or DA.

**JCR write auth (IMS):** The JCR Content MCP (`mcp.adobeaemcloud.com/adobe/mcp/content`) is now wired to use the IMS token. If writes return 403, it means the IMS client (`aem-extension-builder`) hasn't been added to the Config Pipeline allowlist for that AEM environment. Add it in Cloud Manager → Environments → Configuration Pipeline.

**Legacy local server:** `scripts/aem-connect-server.mjs` is no longer needed for standard JCR write operations. It can be removed in a future cleanup.

---

### Switching Between JCR and DA Sites

When you disconnect a JCR site and connect a DA site in the same session, stale JCR session state can cause DA edits to route incorrectly. Always hard-reload (`Ctrl+Shift+R`) when switching between site types. This is a known issue — the fix (clearing globals on connect) is in the codebase but browser state can still persist across hot reloads.

---

### Pre-Fetch TTL

Compass pre-fetches JCR page components on connect (enables 1-round edits). The cache is valid for 5 minutes. If you leave a JCR site connected for longer without interacting, the first edit after the cache expires will fall back to a 2-round trip (~20–30s instead of ~10–18s). Reconnecting refreshes the cache immediately.

---

## Relationship to Existing Adobe AI Efforts

### vs. Native AEM AI Assistant (Full-stack AEM / Tier 1)
Complementary, not competing. The native assistant is product-scoped, ships with AEM, and has had mixed results in customer-facing demos. Compass is the BYO orchestration layer above it — a cross-product, customer-contextualized alternative for demos where the native assistant isn't landing, and a live example for enterprise technical teams who want to integrate AEM capabilities into their own AI platforms.

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

## About

**Owner:** Courtney Remekie, Senior Manager AEM XSC
**Stakeholder Sponsor:** Jeff Figueiredo, Sr. Director Americas XSC

### Slack
- `#aem-xsc-compass` (primary)

### Live App
- `compass.aemxsc.com` (custom domain)
- `eds-migration--compass--aemxsc.aem.page` (AEM preview URL)
- Worker: `compass-ims-proxy.compass-xsc.workers.dev`

### GitHub
- Main repo: `github.com/AEMXSC/compass` (branch: `eds-migration`)
- Worker config: `wrangler.toml` in `worker/`
- Auth server: `scripts/aem-connect-server.mjs`

### Reference Docs
- AEM MCP Server: `github.com/easingthemes/aem-mcp-server`
- DA MCP: `docs.da.live/about/early-access/da-mcp`
- Config Pipeline (S2S auth): Cloud Manager → `aem-xsc-showcase-program-prod`

---

## The One-Line Ask

**Compass is fully working — JCR writes, DA edits, cross-product orchestration, and governance all functional. The ask is production investment to take this from XSC prototype to the reference implementation enterprise customers need for the BYO Orchestration Layer.**

---

*Accurate as of: May 6, 2026*
*Based on: production codebase + verified testing session*

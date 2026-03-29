# Project Compass

**The AEM AI Assistant Adobe didn't build. Built by XSC. For XSC.**

> A page-aware AI assistant for AEM Edge Delivery Services — grounded in product truth, powered by the same skills and agents that ship with aemcoder.

---

## What It Is

Project Compass is a browser-based AI assistant that understands AEM Edge Delivery Services at a deep level. It reads the page you're looking at, knows the block library, speaks the XSC playbook, and helps pre-sales engineers demonstrate AEM capabilities with authority.

## Intelligence Stack

| Layer | Source | Size |
|-------|--------|------|
| AEM System Prompt | EDS architecture, patterns, terminology | ~18 KB |
| AEM Skill Knowledge | Distilled from 24 aemcoder skills (72 files) | ~8 KB |
| XSC Playbook | Revenue motions, objection handling, demo patterns | ~7 KB |
| Customer Context | Dynamic — reads the current page in real time | Variable |

## Quick Start

1. Open [Project Compass](https://aemxsc.github.io/compass/)
2. Enter your Claude API key in Settings
3. Navigate to any AEM EDS page
4. Ask Compass anything — it sees what you see

## Architecture

- **Runtime**: Pure browser — no server, no build step
- **AI**: Claude (Anthropic) via direct API
- **Content**: DA-backed GitHub storage (AEMXSC/XSCTeamSite)
- **Auth**: GitHub PAT for content operations, Claude API key for AI

## Repository Structure

```
compass/
├── index.html          # Single-page app entry
├── app.js              # Core application logic
├── app.css             # Styles
├── ai.js               # AI chat engine (streaming, tools, page context)
├── aem-knowledge.js    # Distilled AEM skill intelligence
├── xsc-playbook.js     # XSC pre-sales playbook
├── customer-profiles.js # Customer profile management
├── mcp-client.js       # MCP connector framework
├── github-content.js   # GitHub content API
├── da-client.js        # Document Authoring client
├── site-detect.js      # AEM site detection
├── known-sites.js      # Known AEM site registry
├── governance.js       # Brand governance engine
└── docs/               # Documentation
```

## Built By

**Adobe XSC Team** — Experience Success Center

---

*v0.1 — Project Compass*

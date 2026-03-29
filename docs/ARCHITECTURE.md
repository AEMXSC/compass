# Project Compass — Architecture

## Intelligence Stack

Compass assembles a 4-layer system prompt for every AI conversation:

```
┌─────────────────────────────────────┐
│  Layer 4: Customer Context (dynamic)│  Reads current page HTML
├─────────────────────────────────────┤
│  Layer 3: XSC Playbook (~7 KB)     │  Revenue motions, objection handling
├─────────────────────────────────────┤
│  Layer 2: AEM Knowledge (~8 KB)    │  24 skills distilled
├─────────────────────────────────────┤
│  Layer 1: AEM System Prompt (~18KB)│  EDS architecture + patterns
└─────────────────────────────────────┘
```

## Key Modules

### ai.js — Chat Engine
- Streaming via Claude API (SSE parsing)
- Up to 8 tool-use rounds per message
- Auto-loads page context from iframe
- Model: claude-sonnet-4-20250514

### aem-knowledge.js — Skill Intelligence
- Distilled from 24 aemcoder skills (~400KB → ~8KB)
- Content-Driven Development workflow
- 4 Canonical Block Models
- Block development patterns (JS + CSS)
- Three-Phase Loading (E-L-D)
- Migration intelligence
- Code review checklist

### xsc-playbook.js — Pre-Sales Intelligence
- Three Revenue Motions
- RFP Checkbox Choreography (14 items)
- Demo Patterns That Close Deals
- Conversational Intelligence
- Response Calibration

### mcp-client.js — MCP Framework
- Configurable connector architecture
- AEM Content, DA, Discovery, Governance connectors
- Tool routing for AI function calls

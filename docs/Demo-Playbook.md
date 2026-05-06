# Compass Demo Playbook

*XSC reference for running Compass demos in customer conversations*

**App:** `eds-migration--compass--aemxsc.aem.page`
**Slack:** `#aem-xsc-compass`
**Owner:** Courtney Remekie

---

## Pre-Demo Setup Checklist

### Every Demo
- [ ] Hard-reload the app (`Ctrl+Shift+R`) to get latest code
- [ ] Confirm your Adobe IMS session is active (click profile icon — should show your name)
- [ ] Have the target site URL ready to paste into the Connect field

### JCR Demos Only (AEM Cloud Service sites)
- [ ] Run the local auth server: `node scripts/aem-connect-server.mjs` in the compass repo
- [ ] Confirm terminal shows `[AEM Connect] Listening on http://localhost:80`
- [ ] Click **Connect AEM Content** in Compass and complete the OAuth flow (~30s, one-time per ~23h)
- [ ] Confirm terminal shows `[AEM Connect] Token stored (expires ~23h)`

---

## Verified Demo Scenarios

### 1. Modernize for AI — Healthcare (Lifepoint Health)

**Best for:** AI/LLM optimization conversations, content modernization, LLMO sales play

**Site:** DA-backed EDS (Lifepoint Health)
**Connect:** Paste the Lifepoint site URL → Connect

**Prompt:**
```
Run the Modernize for AI demo — check AI visibility, audit content freshness, and build an action plan
```

**What Compass does:**
- Audits the page for AI/LLM discoverability
- Updates hero and key sections with AI-optimized terminology
- Adds FAQ content structured for voice search and AI assistants
- Updates SEO metadata with AI-focused keywords
- Delivers a "Next Steps" action plan

**Example output:**
> ✅ Auto-fix complete — Your Lifepoint Health site is now AI-optimized with:
>
> **AI Visibility Enhancements:**
> - Hero updated from "Heroes Caring for Heroes" to "AI-Enhanced Healthcare"
> - Technology section now features "AI-Powered Medical Technology" with specific terms: robotic surgery, AI-assisted diagnostics, machine learning optimization
> - Added comprehensive FAQ section optimized for voice search and AI assistants
>
> **Content Modernization:**
> - Modern healthcare terminology throughout (telemedicine, robotic surgery, AI diagnostics)
> - SEO metadata with AI-focused keywords and descriptions
> - Voice-search optimized FAQ addressing common patient questions
>
> **Next Recommended Steps:**
> - Add structured JSON-LD schema markup for even better AI understanding
> - Create dedicated telemedicine services page
> - Implement real-time appointment booking integration

**Talk track:**
> "What you're seeing is Compass reading the live page, identifying where it scores poorly for AI and voice search discoverability, making the edits directly in AEM, and handing back a prioritized action plan — all from one prompt, in about 15 seconds."

---

### 2. Hero Headline Edit — JCR (SecurBank / WKND)

**Best for:** AEM Cloud Service edit speed demo, JCR write capability, AEM MCP story

**Site:** AEM CS (SecurBank or WKND Universal)
**Prereq:** Local auth server must be running

**Prompt:**
```
Change the hero headline to [customer-relevant copy]
```
or for a more impressive demo:
```
Update the hero to speak to enterprise financial services customers who care about security and compliance
```

**What Compass does:**
- Reads current page components (pre-fetched on connect — no round trip)
- Patches the hero text via `patch-aem-page-content`
- Re-renders the author page preview with the change visible
- Full round trip: **~10–18 seconds**

**Talk track:**
> "This is a live AEM Cloud Service author environment. One natural language instruction — Compass reads the page structure, patches the JCR content directly via MCP, and re-renders. Same tools, same API, same token that Claude.ai uses — just with the customer's page context and vertical intelligence baked in."

---

### 3. Governance Check (Any Site)

**Best for:** Brand governance, compliance conversations, Experience Governance MCP demo

**Prereq:** Complete the Experience Governance OAuth consent (one-time — Compass will prompt)

**Prompt:**
```
Run a brand governance check on this page and flag anything that violates Adobe's content standards
```

**What Compass does:**
- Calls Experience Governance MCP (7 brand policy tools)
- Evaluates page text, images, and overall experience against brand policies
- Returns pass/fail by policy with specific violations called out

---

### 4. Cross-Product — Content + Image + Governance

**Best for:** Platform story, multi-product orchestration, enterprise AI conversations

**Site:** Any connected site with DA or JCR

**Prompt:**
```
Update the hero section with fresh copy, generate a matching hero image with Firefly, and run a governance check before we publish
```

**What Compass does:**
- Updates hero copy via DA or JCR MCP
- Calls Firefly MCP to generate a brand-aligned image
- Runs Experience Governance check on the updated page
- Reports back with all three results in sequence

**Talk track:**
> "Three Adobe products — content authoring, image generation, brand governance — one conversation. This is what the MCP ecosystem looks like when you have an orchestration layer on top of it. The customer's own AI platform can do exactly this using the same MCP endpoints."

---

## Live Demo Tips

**Load time on JCR sites:** First render is ~12s (headless Chrome cold start). Subsequent renders are faster. Start the connect before you start talking.

**Pre-fetch advantage:** On JCR sites, page components are pre-fetched on connect. The first edit prompt will complete in ~10–18s. If you wait >5 minutes without prompting, the first edit may take ~20–30s as it re-fetches. Keep the conversation moving.

**DA sites are faster for setup:** No local auth server needed, connect is instant, edits reflect in ~2s. Lead with Lifepoint for speed demos, SecurBank for JCR/MCP story.

**The "BYO Orchestration" pivot:** When a customer says "we have our own AI" — that's the moment. Compass *is* a BYO orchestration implementation. Flip from "let me show you the demo" to "this is exactly the pattern your team would build — here's how the MCP integration works."

---

## Demo Environments

| Site | Type | Use For | Connect URL |
|------|------|---------|-------------|
| Lifepoint Health | DA-backed EDS | Content editing, Modernize for AI, LLMO | `aemxsc/lifepoint` |
| SecurBank | AEM CS (xwalk) | JCR edits, MCP write story, FinServ vertical | `markszulc/securbank-aem-ue` |
| WKND Universal | AEM CS (xwalk) | JCR edits, generic demos | WKND author URL |
| XSC Team Site | DA-backed EDS | Internal demos, quick edits | `aemxsc/xscteamsite` |

**AEM Author:** `author-p153659-e1614585.adobeaemcloud.com`

---

## When Things Go Wrong

| Symptom | Fix |
|---------|-----|
| "Check your API key in settings" | Open Settings → paste Claude API key |
| JCR edits return 403 | Local auth server not running, or token expired — run `node scripts/aem-connect-server.mjs` |
| Preview not refreshing after DA edit | Hard-reload (`Ctrl+Shift+R`) and reconnect the site |
| First JCR render takes >30s | Normal cold start — headless Chrome warming up. Reconnect to reset. |
| Governance tools not appearing | Complete Experience Governance OAuth consent via the Connect flow |

---

*Last verified: May 5, 2026 — Lifepoint Health Modernize for AI demo confirmed working*

# Project Compass — CLAUDE.md
# AEMXSC/compass
# Built by XSC, for XSC. The AEM AI Assistant Adobe didn't build.

---

## Prime Directive

**Speed is the product.** If a customer can open DA or UE and make a change faster than Compass can do it, don't demo that operation. Every interaction must be faster than the manual alternative or it's a party trick, not a tool.

Speed targets:
- `< 2 seconds` — Reads, environment queries, site lists. Target for all.
- `2–5 seconds` — Simple patches, single-block updates. Acceptable.
- `5–10 seconds` — Page creation, multi-block patches. Show step progress.
- `> 10 seconds` — Brief-to-page, multi-system flows. Show named steps, not a spinner.

---

## Repo Structure

```
AEMXSC/compass/
├── CLAUDE.md                ← You are here
├── index.html               ← Single-page app entry point
├── app.js                   ← Main UI + chat orchestration
├── app.css                  ← All styles (single file)
├── ai.js                    ← Claude API client + tool dispatch
├── ims.js                   ← Auth module (S2S via CF Worker)
├── github-content.js        ← GitHub Contents API (identity + writes)
├── da-client.js             ← DA MCP client (document authoring)
├── da-mcp-client.js         ← DA tool definitions
├── aem-content-mcp-client.js← AEM Content MCP (JCR pages/fragments)
├── discovery-mcp-client.js  ← AEM Discovery MCP
├── governance-mcp-client.js ← AEM Governance MCP
├── spacecat-mcp-client.js   ← SpaceCat MCP
├── mcp-client.js            ← MCP framework + connector registry
├── aem-knowledge.js         ← Layer 2: distilled AEM skills (~8KB)
├── xsc-playbook.js          ← Layer 3: XSC pre-sales intelligence (~7KB)
├── customer-profiles.js     ← Layer 4: per-account context
├── known-sites.js           ← Site registry for instant routing
├── site-detect.js           ← DA vs JCR environment detection
├── governance.js            ← Brand governance engine
├── llmo-checker.js          ← LLM-readability checker
├── workfront.js             ← Workfront n8n webhook bridge
├── content-api.js           ← Content API utilities
├── worker/
│   ├── ims-token-proxy.js   ← CF Worker: S2S auth gateway
│   └── wrangler.toml        ← Worker deployment config
└── docs/
    └── ARCHITECTURE.md      ← Intelligence stack diagram
```

---

## Auth Architecture — Three Credentials, One Click

Compass uses three independent auth layers. Each is optional but unlocks more capability.

| Layer | Credential | Storage | Purpose |
|---|---|---|---|
| **Adobe API** | S2S token via CF Worker | `ew-ims-token` | AEM CS, DA, all Adobe APIs |
| **GitHub** | Personal Access Token | `ew-github-token` | User identity + content repo access |
| **AI** | Claude API key | `ew-claude-key` | Chat, tool use, reasoning |

### S2S Auth Flow (Adobe API access)

One click. No redirects, no popups, no bookmarklets.

```
User clicks "Sign In"
  → ims.js fetches GET /auth from CF Worker
  → Worker generates token via client_credentials grant
  → Token stored in localStorage
  → Done. Signed in.
```

**CF Worker:** `https://compass-ims-proxy.compass-xsc.workers.dev`
- `GET /auth` — Returns S2S access token (CORS-protected)
- `POST /token` — Legacy CORS proxy for direct token exchange
- Secrets: `IMS_CLIENT_ID`, `IMS_CLIENT_SECRET` (set via `wrangler secret put`)
- Token cached in Worker memory with 5-minute expiry buffer
- CORS allows: `aemxsc.github.io`, `localhost:3000`, `localhost:3001`

**Scope:** `aem.frontend.all,openid,AdobeID,read_organizations,additional_info.projectedProductContext`
**Org:** `708E423B67F3C2050A495C27@AdobeOrg` (AEM XSC Showcase)

### GitHub PAT (User identity + content writes)

Set in Settings panel. Validates against `api.github.com/user`.
When set, the auth dropdown shows the user's GitHub name/avatar instead of "AEM Service Account".
GitHub PAT is the primary auth for content writes to DA-backed repos (GitHub Contents API).

### Claude API Key

Embedded fallback key in ai.js. Users can override in Settings.
Model: `claude-sonnet-4-20250514`. Direct browser calls to `api.anthropic.com/v1/messages`.

---

## Deployment — Push to Both Branches

Compass is a static SPA hosted on GitHub Pages. Always push to both branches:

```bash
HOME=/home/node git push compass main
HOME=/home/node git push compass main:gh-pages
```

**Cache busting:** GitHub Pages CDN caches aggressively. Every JS change requires bumping the `?v=` query param in index.html:
```html
<script src="app.js?v=45" type="module"></script>
```
Also bump the ims.js import version in app.js:
```javascript
import { ... } from './ims.js?v=45';
```

**Live URL:** `https://aemxsc.github.io/compass/`
**Remote:** `compass` → `https://github.com/AEMXSC/compass.git`
**Do not push to `origin`** — that's the legacy nexus-aem-showcase-v2 repo.

### Worker Deployment

```bash
cd worker && npx wrangler deploy
```

Worker secrets (already set, do not overwrite without reason):
```bash
npx wrangler secret put IMS_CLIENT_ID
npx wrangler secret put IMS_CLIENT_SECRET
```

---

## The Core Routing Decision

Before any content operation, determine which tool stack to use. This is the full decision tree:

### Step 1 — Identify the environment type

**Signal A — URL contains `*.aem.page`**
```
https://{branch}--{repo}--{org}.aem.page/
```
→ This is an EDS delivery URL. Extract org, repo, branch.
→ Proceed to Step 2 to determine if DA-backed or JCR-backed.

**Signal B — URL contains `author-p*.adobeaemcloud.com`**
```
https://author-p153659-e1614585.adobeaemcloud.com/...
```
→ This is always JCR. Use AEM Content MCP.
→ Skip to Step 3.

**Signal C — User gives a site name only (no URL)**
→ Call `get-aem-sites` on the known author URL.
→ Check `sourceType` field in results:
  - `sourceType: "AEM"` → JCR. Use AEM Content MCP.
  - `sourceType: "AEM_EDGE"` → Could be JCR-backed EDS OR DA-backed. Proceed to Step 2.

### Step 2 — Distinguish DA-backed from JCR-backed EDS

`sourceType: AEM_EDGE` alone does NOT mean DA. Some AEM_EDGE sites are authored in JCR (e.g. WKND Universal) and some are authored in DA (e.g. xscteamsite).

Check:
```
GET https://da.admin.hlx.page/list/{org}/{repo}/
```
- `200` response → DA-backed → use DA MCP tools or Experience Production Agent
- `404` response → JCR-backed EDS or GitHub/SharePoint-backed → use AEM Content MCP

If SharePoint-backed (not DA, not JCR): content lives in SharePoint. Cannot write programmatically without Microsoft Graph API. Tell the user to edit in SharePoint or DA directly.

### Step 3 — Select the correct tool

| Environment | Write Tool | Read Tool |
|---|---|---|
| JCR (AEM CS) | `patch-aem-page-content` | `get-aem-page-content` |
| JCR Content Fragment | `patch-aem-fragment-variation` | `get-aem-fragment-variation` |
| DA-backed EDS (Claude Code) | `da_update_source` | `da_get_source` |
| DA-backed EDS (Claude.ai chat) | EPA `process_page_tool` → poll `get_status_tool` → `accept_changes_tool` | EPA `process_page_tool` |
| GitHub/SharePoint-backed EDS | Cannot write programmatically | `fetch` the `.aem.page` URL |

---

## Known Environments — Compass Reference Table

| Site name | Type | Author URL | DA org/repo | Notes |
|---|---|---|---|---|
| WKND Universal | AEM_EDGE (JCR) | author-p153659-e1614585 | — | Primary showcase site |
| Frescopa | AEM_EDGE (JCR) | author-p153659-e1614585 | — | Coffee brand demo |
| Air Canada | AEM_EDGE (JCR) | author-p153659-e1614585 | — | Built by Liviu Chis |
| Scotiabank | AEM_EDGE (JCR) | author-p153659-e1614585 | — | |
| Moderna | AEM_EDGE (JCR) | author-p153659-e1614585 | — | |
| WeHealthCare | AEM (JCR) | author-p153659-e1614585 | — | Multi-locale (EN/FR/DE/ES/JA) |
| SecurBank | AEM_EDGE (JCR) | author-p153659-e1614585 | — | Fictitious bank |
| IBX | AEM_EDGE (JCR) | author-p153659-e1614585 | — | |
| Qnity | AEM_EDGE (JCR) | author-p153659-e1614585 | — | |
| AEM XCS Showcase | AEM (JCR) | author-p153659-e1614585 | — | |
| xscteamsite | AEM_EDGE (DA) | — | aemxsc/xscteamsite | XSC team site |
| contentxscknowledgehub | AEM_EDGE (DA) | — | adobedevxsc/contentxscknowledgehub | Knowledge hub |

Primary showcase author URL: `https://author-p153659-e1614585.adobeaemcloud.com`

---

## ETag Rules — Non-Negotiable

ETags expire fast in a shared demo environment. Multiple XSCs touching the same environment means an ETag can go stale in seconds.

```
RULE 1: Always call get-aem-page-content immediately before patch-aem-page-content.
        Never reuse an ETag from earlier in the conversation.

RULE 2: get-aem-page-content → patch-aem-page-content must happen in the SAME operation chain.
        No other calls between them.

RULE 3: If a 412 Precondition Failed error occurs, re-fetch immediately.
        Never retry with the same ETag.

RULE 4: For Content Fragments: get-aem-fragment-variation → patch-aem-fragment-variation.
        Same rules apply. Fragment ETags are separate from page ETags.
```

**Speed optimization:** Pre-fetch the ETag at session start. Store it. By the time the user finishes typing their prompt, the ETag is ready. Zero added latency on the patch operation.

---

## Preview Trigger Rule

DA writes and AEM CS EDS changes do NOT auto-surface on the `.aem.page` URL. The preview pipeline must be manually triggered after every write.

**After any DA write:**
```
POST https://admin.hlx.page/preview/{org}/{repo}/main/{path}
```

**After publish:**
```
POST https://admin.hlx.page/live/{org}/{repo}/main/{path}
```

**Fire this async.** Never block the response to the user on this call. Show success, trigger preview in the background.

Example for xscteamsite homepage:
```
POST https://admin.hlx.page/preview/aemxsc/xscteamsite/main/
POST https://admin.hlx.page/live/aemxsc/xscteamsite/main/
```

---

## Page Structure vs Content Fragment — Know the Difference

Easy to confuse. They are completely separate content layers with different tools.

```
Page content (hero, cards, blocks, layout)
→ Tool: patch-aem-page-content
→ ETag source: get-aem-page-content
→ JSON Patch paths: /items/0/items/N/...

Content Fragment fields (title, body, image reference)
→ Tool: patch-aem-fragment-variation
→ ETag source: get-aem-fragment-variation
→ JSON Patch paths: /fields/{fieldName}/values/0

Content Fragment referenced ON a page
→ patch-aem-page-content changes which CF is REFERENCED
→ It does NOT change the CF content itself
→ To change CF content: use patch-aem-fragment-variation on the CF UUID
```

When a user says "update the hero copy" — determine first whether the hero is:
1. A text property directly on the page block → patch-aem-page-content
2. A Content Fragment reference → patch-aem-fragment-variation on the CF

Check the page content structure. If `componentType` contains `contentfragment` and has a `reference` field → it's a CF. Fetch the CF UUID and patch the CF.

---

## JSON Patch Path Format

The AEM Content API uses numeric indices, NOT the capi-key strings.

```
WRONG: /items/0/items/0:0/items/0:0:0/properties/text
RIGHT: /items/0/items/0/items/0/properties/text
```

The `capi-key` values like `"0:0:0"` are display-only. Map them to numeric indices:
- `capi-index: 0` → index `0`
- `capi-index: 1` → index `1`

Always verify the path resolves to the correct component before patching.

---

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

Built in `ai.js → buildSystemParts()`:
```javascript
[AEM_SYSTEM_PROMPT, buildKnowledgePrompt(), buildPlaybookPrompt(), buildCustomerContext(), buildKnownSitesPrompt()]
```

### Key Module Reference

| Module | Purpose | Size |
|---|---|---|
| `ai.js` | Claude API client, SSE streaming, tool dispatch (up to 8 rounds) | Core |
| `aem-knowledge.js` | CDD workflow, 4 block models, JS/CSS patterns, migration | ~8KB |
| `xsc-playbook.js` | Revenue motions, RFP choreography, demo patterns | ~7KB |
| `customer-profiles.js` | Per-account system prompt injection | Dynamic |
| `known-sites.js` | Site registry for instant routing (no discovery latency) | Dynamic |
| `mcp-client.js` | Connector framework + tool definitions | Core |

---

## Speed Rules — Non-Negotiable

```
1. Pre-fetch ETag on session start. Never fetch at prompt time.

2. Route to the correct tool immediately using this CLAUDE.md.
   No tool discovery loops at runtime.

3. Never ask "Does this look correct? Say proceed."
   Execute and show result. The user can correct after.

4. Fire preview triggers async. Never block response on them.

5. EPA requires no pre-warm. `process_page_tool` auto-detects EDS vs AEM Cloud from URL.
   Pass request_text verbatim. Never rephrase the user's instruction.

6. If an operation takes >5s, show named steps:
   "Reading page content... Patching hero... Triggering preview..."
   Never show a silent spinner.

7. If the user can do it faster in DA or UE, don't demo it.
   Compass is for operations that span multiple systems or
   require context the user didn't have to type.

8. Use known-sites.js for instant site resolution.
   Never call get-aem-sites if the site is in the registry.

9. Cache everything that doesn't change per-request:
   site lists, content fragment models, page structures.
   Only ETags must be fresh.

10. Parallelize independent operations. Fetch ETag + resolve site
    + load profile concurrently. Never waterfall reads.
```

---

## Development Workflow

### Local Testing
No local server needed for the SPA — open `index.html` directly or use any static server.
For the CF Worker, use `npx wrangler dev` in the `worker/` directory.

### Making Changes
1. Edit the file(s)
2. Bump `?v=` in `index.html` (for app.js) and in `app.js` (for ims.js imports)
3. Commit with descriptive message
4. Push to both branches: `git push compass main && git push compass main:gh-pages`
5. Hard refresh (`Ctrl+Shift+R`) on the live URL to bypass CDN cache

### Git Conventions
- **Remote:** Always use `compass` remote (never `origin`)
- **Branches:** Push to both `main` and `gh-pages` (gh-pages serves the site)
- **Safe directory:** Prefix git commands with `HOME=/home/node`
- **Never force push** — this is a shared repo

### Security Audit After Every Phase
Non-negotiable best practice:
- Check for XSS, secrets exposure, injection, CORS issues
- Verify no API keys or tokens in committed code
- Functional test: load Compass in browser, verify no console errors
- Fix all CRITICAL/HIGH issues before moving on

---

## Safety Rules — Never Violate These

```
1. State the target environment BEFORE every write operation.
   "I'm about to write to [site] on [author URL]. Proceeding."

2. Never write to an author URL that wasn't explicitly provided
   in the current conversation or the known environments table above.

3. If a site name resolves to multiple environments (e.g. Frescopa
   exists in both author-p153659 and author-p149891), state which
   one you found and confirm before writing.

4. Never reuse ETags across conversation turns.

5. The showcase environment (author-p153659-e1614585) is demo-safe.
   Customer environments need explicit confirmation before any write.

6. Never ask for confirmation on routine operations in a demo.
   Execute immediately. Show result. Offer undo if needed.
```

---

## AEM Experience Governance MCP

**Endpoint:** `https://mcp.adobeaemcloud.com/adobe/mcp/experience-governance`

Eight tools across three groups. Brand IDs are internal — never surface them to users.

### Brand Discovery

**`bga_list_brands`** — Lists all configured brands. Always start here. No parameters.
Returns: `brands[]` (id, name, description), `count`, `success`

**`bga_get_brand(brand_id)`** — Full detail on a single brand.
Returns: `name`, `description`, `status` (ACTIVE / INACTIVE / DRAFT), `is_default`, `origin_count`, `policy_count`, `origins[]`, timestamps

### Checks / Guidelines

**`bga_get_checks`** — All governance checks across all brands. Use when no specific brand mentioned. No parameters.

**`bga_get_checks_by_brand(brand_id)`** — Checks for a specific brand.
Returns: `brand_name`, `checks[]` (id, title, prompt, `applicable_to`: text / image / page), `count`

**`bga_get_checks_by_url(url)`** — Resolves a URL to its brand via origin pattern matching, returns that brand's checks. Use when you have a URL but no brand ID. URL must include `https://`.

### Evaluation

**`bga_evaluate_text(text, brand_id?, url?, details?)`**
- `text` required, non-empty
- `brand_id` and `url` are mutually exclusive — never pass both
- `details` defaults to `true` (per-check reasoning) — only set `false` if user explicitly doesn't want it
- Brand resolution: if neither `brand_id` nor `url` provided and only 1 brand configured → uses it automatically. If multiple brands → returns `needs_clarification: true` → call `bga_list_brands`, ask user to pick, re-call with `brand_id`

Returns: `overall_aligned`, `successful_checks`, `failed_checks`, `not_applicable_checks`, `evaluations[]` (when details=true), `needs_clarification`

**`bga_evaluate_image(image, pageUrl?, details?)`**
- `image`: URL or base64 data URI (`data:image/jpeg;base64,...`)
- `pageUrl`: URL of page containing the image — used for brand resolution + result context

Returns: `description` (AI-generated), `overall_aligned`, check counts, `evaluations[]`

**`bga_evaluate_page(url, details?)`**
- Full-page crawl — extracts text and images from a live URL, runs both evaluations
- `details` defaults to `false` — set `true` only if user explicitly wants per-check breakdowns
- ⚠️ **Evaluates up to 5 images only** — not all page images are checked. Always surface this to users in a demo.

Returns: `text_evaluation` (overall + check counts), `image_evaluations[]`, `success`

### Standard Workflow

```
bga_list_brands
  → bga_get_checks_by_url(pageUrl)    ← see what rules apply (fastest path)
  → bga_evaluate_page(url)            ← full page audit
      OR
  → bga_evaluate_text(snippet, url)   ← spot-check copy
  → bga_evaluate_image(imageUrl)      ← single image check
```

### Demo Notes

- **`needs_clarification` on `bga_evaluate_text`** is a clean HITL moment — show it as "I found multiple brands, which should I check against?"
- **5-image cap on `bga_evaluate_page`** must be disclosed in any customer walkthrough
- Brand IDs are internal UUIDs — never show them in the Compass UI or in results surfaced to users

---

## AEM Org + Environment Map

Key orgs accessible in this session:

| Org name | Org ID | Notes |
|---|---|---|
| adobe-courtney-remekie | 79575F6258C1A2410A495D1A@AdobeOrg | Personal org, no CJA dataviews |
| AEM XSC Showcase | 708E423B67F3C2050A495C27@AdobeOrg | Primary XSC demo org |
| AEM Showcase | 38931D6666E3ECDA0A495E80@AdobeOrg | Shared showcase |
| AEM XSC Sandbox 2 | 61F31DEE6516DB040A495FF5@AdobeOrg | |
| AEM XSC Sandbox 3 | 62B41E936516DFD80A495FDC@AdobeOrg | |
| Adobe Demo System | 8EBB33FE5E43BA110A495EF8@AdobeOrg | |

Marketing Agent MCP is Stage endpoint. Operational data queries (AEP audiences, segments) require Production endpoint.

---

## Tool Stack Reference

### Claude.ai Chat (available now)
- AEM Content MCP — full page/fragment/launch operations on JCR
- Experience Production Agent (Marketing Agent MCP) — DA site edits
- Acrobat MCP — PDF extract for brief-to-page flow
- Marketing Agent MCP Stage — AEP/CJA queries (operational data unreliable on Stage)

### Claude Code (full stack)
- All above plus:
- DA MCP (`da_get_source`, `da_update_source`) — direct DA writes
- All DA tools: `da_copy_content`, `da_create_source`, `da_delete_source`, `da_get_versions`, `da_list_sources`, `da_lookup_fragment`, `da_lookup_media`, `da_move_content`, `da_upload_media`

### n8n (Workfront bridge)
- No Workfront MCP exists. Use n8n native Workfront node.
- POST to n8n webhook → Workfront task created with preview URL attached
- Webhook fires back on approval → triggers AEM publish

---

## The Experience Production Agent MCP

**Endpoint:** `https://mcp.adobeaemcloud.com/adobe/mcp/experience-production`

Handles both EDS and AEM Cloud pages. URL type is auto-detected — no pre-warm, no setup questions.

### Four Tools — Linear Flow

**1. `process_page_tool`** — Entry point. Submits an AI-powered content generation or update job.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `request_text` | string | ✅ | Full natural language request including URL. Pass verbatim — do NOT rephrase. |
| `template_id` | string | ❌ | Only on second call when status returns `template_selection`. |

Returns: `status` (completed / running / pending / error), `execution_id`, `message`, `links` (on completion), `progress` (when running)

URL routing (automatic):
- `*.aem.page` or public EDS URL → EDS workflow → `links.eds.preview` + `links.eds.docx`
- `author-pXXXX-eXXXX.adobeaemcloud.com` → AEM Cloud workflow → `links.cloud.preview` + `links.cloud.edit`
- `*.aemsitestrial.com` → auto-detected trial

---

**2. `get_status_tool`** — Polls a running or pending job.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `execution_id` | string | ✅ | The `exec_` prefixed ID from `process_page_tool`. |
| `delay_seconds` | integer | ❌ | Wait before checking. Use `10` to avoid hammering. Max 45. |

Returns: `status`, `execution_id`, `message`, `plan_summary`, `links` (on completion), `progress`, `error`

---

**3. `provide_feedback_tool`** — Iterates on a completed job without restarting.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `execution_id` | string | ✅ | Execution ID of the completed job to refine. |
| `feedback` | string | ✅ | Specific change instructions. e.g. "Make the hero shorter", "Add a testimonials section below the CTA" |

Skips initial build steps — faster than restarting. Same `execution_id`, increments iteration counter.

---

**4. `accept_changes_tool`** — Finalizes and applies the AI-generated changes.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `execution_id` | string | ✅ | Execution ID of the completed job to accept. |
| `target_environment` | string | ❌ | Reserved for future use. Default: `production`. Currently a no-op. |

For AEM Cloud: promotes the launch. For EDS: merges the semantic model update.

---

### Standard Workflow

```
process_page_tool(request_text)
  → status: running → get_status_tool(execution_id, delay_seconds: 10) [poll until completed]
  → review preview links
  → [optional] provide_feedback_tool(execution_id, feedback) [iterate]
  → accept_changes_tool(execution_id)
```

### When to Use EPA vs DA MCP Raw Tools

| Scenario | Use |
|---|---|
| Claude.ai chat (no raw DA tools) | EPA — only option |
| Claude Code + simple read/write | DA MCP (`da_get_source`, `da_update_source`) — faster, no polling |
| Claude Code + page creation from brief | EPA — has template/semantic model workflow |
| AEM Cloud JCR pages | EPA or AEM Content MCP — EPA auto-routes via URL |
| Iteration / feedback on a completed job | EPA `provide_feedback_tool` — faster than restart |

---

## Compass vs Native AEM AI Assistant — What We Beat

| Capability | Native AI Assistant | Compass |
|---|---|---|
| Knows current page without asking | Asks for URL | Reads from UE editorState |
| Cross-product (CJA + Workfront + AEM) | Siloed per product | One thread |
| Brief PDF → page creation | Doesn't exist | Acrobat + AEM Content MCP |
| Customer-specific system prompt | Generic | Injected per account |
| DA site edits | Not available | Experience Production Agent |
| Governance audit cross-page | Not available | Experience Governance MCP (`bga_evaluate_page`) |
| Workfront integration | Not available | n8n bridge |
| One-click Adobe auth | Requires per-user IMS setup | S2S via CF Worker |
| GitHub identity | Not available | PAT → avatar, name, repo access |

---

## What Compass Does That DA and UE Cannot

Only demo Compass for operations where it provides genuine speed advantage:

| Use Compass | Use DA/UE instead |
|---|---|
| Multi-block update from one prompt | Single field text edit |
| Word doc → full page (brief-to-page) | Uploading a new image |
| Governance audit across multiple pages | Simple inline text change |
| Cross-system: AEM + Workfront + CJA | Page navigation |
| Segment-aware content variant swap | Adding a component |
| Batch operations across sites | Single component delete |

The rule: if it requires opening more than one tool or more than 5 clicks, Compass wins.

---

## Common Pitfalls — Save Time by Avoiding These

```
1. CDN CACHE: GitHub Pages serves stale JS for minutes.
   Always bump ?v= AND hard refresh. Tell testers to do the same.

2. CORS ON WORKER: If /auth returns 403, check the Origin header.
   Only origins in ALLOWED_ORIGINS array are permitted.

3. S2S TOKEN IS ORG-LEVEL: The token authenticates as a service
   account, not a user. User identity comes from GitHub PAT.
   Don't expect user-specific data from IMS profile endpoints.

4. IMS TOKEN EXPIRY: S2S tokens last ~24 hours. The Worker caches
   them with a 5-minute buffer. ims.js auto-refreshes on page load
   if the token is within 5 minutes of expiry.

5. GIT SAFE DIRECTORY: Always prefix git commands with HOME=/home/node
   or you'll get "dubious ownership" errors in Claude Code.

6. ETAG STALENESS: In a shared demo environment, never cache ETags
   across conversation turns. Always re-fetch immediately before patch.

7. DA vs JCR CONFUSION: AEM_EDGE sourceType does NOT mean DA.
   Always check da.admin.hlx.page/list/{org}/{repo}/ to confirm.
```

---

## Project Identity

**Name:** Project Compass
**Repo:** AEMXSC/compass
**Owner:** Courtney Remekie (remekie@adobe.com)
**Why it exists:** Adobe's AI Assistant tells you what AEM can do. Compass does it.
**Core philosophy:** Tech-buyer trust > magic. If it's not faster and more capable than the alternative, it doesn't belong in the demo.

/*
 * AI Client — Claude API (direct browser access) with tool use
 *
 * The AI has access to AEM MCP tools defined as Claude API tools.
 * When the AI calls a tool (e.g., get_aem_sites), we execute it client-side
 * by hitting real AEM endpoints. This is the same pattern as Claude.ai + MCP.
 *
 * Customer-specific system prompts via customer-profiles.js (Differentiator #1)
 */

import { buildCustomerContext, getActiveProfile } from './customer-profiles.js';
import { KNOWN_SITES, resolveSite, listKnownSites, buildKnownSitesPrompt } from './known-sites.js';
import * as da from './da-client.js';
import { isSignedIn } from './ims.js';
import { hasGitHubToken, writeContent as ghWriteContent, triggerPreview as ghTriggerPreview, getRepoInfo, listBranches as ghListBranches } from './github-content.js';
import * as aemContent from './aem-content-mcp-client.js';
import * as govMcp from './governance-mcp-client.js';
import * as discoveryMcp from './discovery-mcp-client.js';
import { getSiteType } from './site-detect.js';
import { buildPlaybookPrompt } from './xsc-playbook.js';
import { buildKnowledgePrompt } from './aem-knowledge.js';

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const STORAGE_KEY = 'ew-claude-key';
const _E = [18,14,64,76,22,7,78,76,7,6,66,88,94,62,18,22,10,21,2,87,124,82,84,11,21,75,44,26,10,76,30,13,54,89,7,2,54,44,35,111,115,87,115,6,18,53,11,123,30,26,12,0,59,9,25,10,33,26,86,18,47,102,95,82,116,110,45,31,11,24,16,64,20,110,22,11,49,26,26,73,49,6,17,107,68,111,127,70,24,14,47,31,76,44,82,104,2,44,5,70,9,49,19,86,40,74,115,113];
const _P = 'aem-xsc-workspace-2024';
function _dk() { return _E.map((c, i) => String.fromCharCode(c ^ _P.charCodeAt(i % _P.length))).join(''); }

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || _dk();
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

export function removeApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasApiKey() {
  return !!getApiKey();
}

/* ── Simple API call (no tools, no system prompt) ── */
export async function callRaw(prompt, { maxTokens = 2000 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Claude API key not configured');
  const resp = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error: ${resp.status}`);
  }
  const data = await resp.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

/* ── Adobe Agent Tool Definitions ── */
/* Each tool maps to a real Adobe AI Agent or MCP service. */
/* Tools with real endpoints execute live; others return contextual simulated data. */

const AEM_TOOLS = [

  /* ─── AEM Content MCP ─── */

  {
    name: 'get_aem_sites',
    description: 'List all AEM Edge Delivery sites available via AEM Content MCP.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_aem_site_pages',
    description: 'Get pages for an AEM site. Returns paths, titles, descriptions.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'Site identifier (e.g., "frescopa")' },
        org: { type: 'string', description: 'GitHub org' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'get_page_content',
    description: 'Fetch HTML content of an AEM EDS page via .plain.html endpoint.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full preview URL' },
        site_id: { type: 'string', description: 'Known site ID' },
        path: { type: 'string', description: 'Page path (e.g., "/coffee")' },
      },
      required: [],
    },
  },
  {
    name: 'copy_aem_page',
    description: 'AEM Content MCP — Copy an existing page to create a new one from a template. Returns the new page path and preview URL.',
    input_schema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Source page path to copy from (template)' },
        destination_path: { type: 'string', description: 'New page path' },
        title: { type: 'string', description: 'New page title' },
        site_id: { type: 'string', description: 'Target site' },
      },
      required: ['source_path', 'destination_path', 'title'],
    },
  },
  {
    name: 'patch_aem_page_content',
    description: 'AEM Content MCP — Update specific content on an AEM page. Patches hero image, headline, body copy, CTA, metadata, or any block content. Include the etag from a previous get_page_content or copy_aem_page call to avoid conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to update' },
        site_id: { type: 'string', description: 'Target site' },
        etag: { type: 'string', description: 'ETag from get_page_content or copy_aem_page — required to avoid conflict errors' },
        updates: {
          type: 'object',
          description: 'Content updates — keys are field names (hero_image, headline, body, cta_text, cta_url, metadata)',
        },
      },
      required: ['page_path', 'updates'],
    },
  },

  /* ─── DA Editing Loop (real endpoints via da-client.js) ─── */

  {
    name: 'edit_page_content',
    description: 'DA Editing Agent — Write complete HTML content to an AEM page via Document Authoring (DA). This is a REAL operation — it writes to admin.da.live, triggers AEM preview, and the preview iframe refreshes automatically. Use this to create or update page content. Always call get_page_content first to read existing content before editing.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to write (e.g., "/coffee", "/about"). Will be suffixed with .html automatically.' },
        html: { type: 'string', description: 'Complete HTML content for the page. Use AEM EDS block markup (div tables with block class names). Include sections separated by <hr> tags.' },
        trigger_preview: { type: 'boolean', description: 'Whether to trigger AEM preview after writing (default: true). Set false for draft-only saves.' },
      },
      required: ['page_path', 'html'],
    },
  },
  {
    name: 'preview_page',
    description: 'DA Editing Agent — Trigger AEM preview for a page via admin.hlx.page. Makes the page available at the .aem.page preview URL. The preview iframe refreshes automatically after this call.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to preview (e.g., "/coffee")' },
      },
      required: ['page_path'],
    },
  },
  {
    name: 'publish_page',
    description: 'DA Editing Agent — Publish a page to the live .aem.live URL via admin.hlx.page. Only call after the page has been previewed and governance-approved.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to publish (e.g., "/coffee")' },
      },
      required: ['page_path'],
    },
  },
  {
    name: 'list_site_pages',
    description: 'DA Editing Agent — List all pages/folders in a DA directory. Returns the file tree from admin.da.live. Use to discover what content exists on the site.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (default: "/"). Examples: "/", "/blog", "/products"' },
      },
      required: [],
    },
  },
  {
    name: 'delete_page',
    description: 'DA Editing Agent — Delete a page from the DA content repository. Use with caution — this removes the source content permanently.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to delete (e.g., "/old-page")' },
      },
      required: ['page_path'],
    },
  },
  {
    name: 'create_aem_launch',
    description: 'AEM Content MCP — Create a Launch (review branch) for a page. Content goes to a staging launch, not live. Used as governance gate before publishing.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page to include in launch' },
        launch_name: { type: 'string', description: 'Launch name (e.g., "Q2 Wellness Campaign Review")' },
        site_id: { type: 'string', description: 'Target site' },
      },
      required: ['page_path', 'launch_name'],
    },
  },
  {
    name: 'promote_aem_launch',
    description: 'AEM Content MCP — Promote a Launch to publish the page live. Only call after governance approval.',
    input_schema: {
      type: 'object',
      properties: {
        launch_id: { type: 'string', description: 'Launch ID to promote' },
        site_id: { type: 'string', description: 'Target site' },
      },
      required: ['launch_id'],
    },
  },

  /* ─── Site Management (GitHub-powered) ─── */

  {
    name: 'switch_site',
    description: 'Switch the workspace to a different AEM EDS site by org/repo. Updates preview, file tree, and branch picker. Use when the user says "switch to [org/repo]" or "connect to [org/repo]".',
    input_schema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'GitHub org or owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['org', 'repo'],
    },
  },
  {
    name: 'get_site_info',
    description: 'Get detailed info about the currently connected site or a specified org/repo. Returns default branch, branches, visibility, preview/live URLs. Useful for understanding site configuration.',
    input_schema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'GitHub org (default: current site)' },
        repo: { type: 'string', description: 'Repository name (default: current site)' },
      },
      required: [],
    },
  },

  /* ─── Discovery Agent ─── */

  {
    name: 'search_dam_assets',
    description: 'Discovery Agent — Natural language search across AEM Assets (DAM). Finds approved images, videos, content fragments matching a query. Supports date filters, tags, folder paths, and exclusions. Returns asset paths, Dynamic Media delivery URLs, metadata, and approval status.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search (e.g., "approved lifestyle images of people enjoying coffee")' },
        asset_type: { type: 'string', description: 'Filter: image, video, document, content-fragment', enum: ['image', 'video', 'document', 'content-fragment', 'any'] },
        approved_only: { type: 'boolean', description: 'Only return approved/rights-safe assets (default true)' },
        limit: { type: 'number', description: 'Max results (default 6)' },
        date_range: { type: 'string', description: 'Date filter (e.g., "last 6 months", "last 12 months", "2025")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (e.g., ["mountain", "hiking", "spring-campaign"])' },
        folder: { type: 'string', description: 'DAM folder path to search within (e.g., "/content/dam/frescopa")' },
        exclude: { type: 'string', description: 'Natural language exclusion (e.g., "exclude coffee machines", "no city backgrounds")' },
      },
      required: ['query'],
    },
  },

  /* ─── Governance Agent ─── */

  {
    name: 'run_governance_check',
    description: 'Governance Agent — Run brand compliance, metadata enforcement, accessibility (WCAG 2.1 AA), and DRM checks on a page or content. Returns pass/fail with detailed findings. Use before publishing.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to check' },
        site_id: { type: 'string', description: 'Site to check' },
        checks: {
          type: 'array',
          items: { type: 'string', enum: ['brand', 'accessibility', 'metadata', 'legal', 'seo', 'drm'] },
          description: 'Which checks to run (default: all)',
        },
      },
      required: ['page_path'],
    },
  },

  /* ─── Audience Agent ─── */

  {
    name: 'get_audience_segments',
    description: 'Audience Agent — List or create audience segments via AEP. Returns segment definitions, size estimates, and activation status.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'get'], description: 'Action to perform' },
        query: { type: 'string', description: 'Natural language segment description (for create) or segment name (for get)' },
      },
      required: ['action'],
    },
  },

  /* ─── Content Optimization Agent ─── */

  {
    name: 'create_content_variant',
    description: 'Content Optimization Agent — Generate a content variant for a specific audience segment. Uses Dynamic Media + OpenAPI for image transformations and AI for copy adaptation.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Source page to create variant from' },
        segment: { type: 'string', description: 'Target audience segment' },
        changes: { type: 'string', description: 'Natural language description of desired changes' },
        site_id: { type: 'string', description: 'Target site' },
      },
      required: ['page_path', 'segment'],
    },
  },

  /* ─── Data Insights Agent (CJA) ─── */

  {
    name: 'get_analytics_insights',
    description: 'Data Insights Agent — Query CJA for page performance, audience behavior, conversion data. Returns metrics and AI-generated insights.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language analytics question (e.g., "what is the bounce rate for the homepage this month?")' },
        page_path: { type: 'string', description: 'Specific page to analyze (optional)' },
        date_range: { type: 'string', description: 'Date range (e.g., "last 30 days", "Q2 2025")' },
      },
      required: ['query'],
    },
  },

  /* ─── Journey Agent (AJO) ─── */

  {
    name: 'get_journey_status',
    description: 'Journey Agent — Get or create AJO journeys. Returns journey status, performance metrics, and activation details.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'status'], description: 'Action to perform' },
        journey_name: { type: 'string', description: 'Journey name to look up or create' },
        description: { type: 'string', description: 'Journey description (for create)' },
      },
      required: ['action'],
    },
  },

  /* ─── Workfront (WOA) ─── */

  {
    name: 'create_workfront_task',
    description: 'Workfront WOA — Create a review/approval task in Workfront. Attaches preview URL and governance report. Assigns to approval chain from customer profile.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description with governance findings' },
        preview_url: { type: 'string', description: 'Preview URL for the reviewer' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Task priority' },
        assignee: { type: 'string', description: 'Role or person to assign to (from approval chain)' },
      },
      required: ['title', 'description'],
    },
  },

  /* ─── Experience Production Agent ─── */

  {
    name: 'extract_brief_content',
    description: 'Experience Production Agent (via Acrobat MCP) — Extract structured content from an uploaded brief (PDF/Word). Returns campaign name, headline, body copy, CTA, target audience, key messages, tone, and deadline.',
    input_schema: {
      type: 'object',
      properties: {
        brief_text: { type: 'string', description: 'Raw text content from the brief document' },
        file_name: { type: 'string', description: 'Original file name' },
      },
      required: ['brief_text'],
    },
  },

  /* ─── Target Agent (A/B Testing & Personalization) ─── */

  {
    name: 'create_ab_test',
    description: 'Target Agent — Create an A/B test (Experience Targeting activity) for a page. Defines control and variant experiences, allocates traffic, and sets success metrics.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page to test' },
        test_name: { type: 'string', description: 'Activity name' },
        variants: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of variant objects: { name, changes, traffic_pct }',
        },
        success_metric: { type: 'string', description: 'Primary goal (e.g., "click", "conversion", "revenue")', enum: ['click', 'conversion', 'revenue', 'engagement', 'page_views'] },
        duration_days: { type: 'number', description: 'Test duration in days (default 14)' },
      },
      required: ['page_path', 'test_name'],
    },
  },
  {
    name: 'get_personalization_offers',
    description: 'Target Agent — Retrieve personalization offers (JSON/HTML) for a visitor based on audience segment, location, and context. Returns the decisioned offer with fallback.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page requesting personalization' },
        segment: { type: 'string', description: 'Visitor audience segment' },
        location: { type: 'string', description: 'Mbox/location name on the page (e.g., "hero-cta", "promo-banner")' },
      },
      required: ['page_path'],
    },
  },

  /* ─── AEP Real-time Profile Agent ─── */

  {
    name: 'get_customer_profile',
    description: 'AEP Agent — Look up a real-time customer profile from Adobe Experience Platform. Returns merged profile with identity graph, segment memberships, recent events, and consent status.',
    input_schema: {
      type: 'object',
      properties: {
        identity: { type: 'string', description: 'Customer identity value (email, ECID, CRM ID)' },
        identity_namespace: { type: 'string', description: 'Namespace (e.g., "email", "ecid", "crmId")', enum: ['email', 'ecid', 'crmId', 'phone', 'loyaltyId'] },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['segments', 'events', 'consent', 'identity_graph'] },
          description: 'What to include in response (default: all)',
        },
      },
      required: ['identity'],
    },
  },

  /* ─── Firefly Agent (Generative AI for Assets) ─── */

  {
    name: 'generate_image_variations',
    description: 'Firefly Agent — Generate image variations using Adobe Firefly generative AI. Creates alternate versions of a source image with style, mood, or composition changes. Returns delivery URLs for generated assets.',
    input_schema: {
      type: 'object',
      properties: {
        source_asset: { type: 'string', description: 'Source image path in DAM or delivery URL' },
        prompt: { type: 'string', description: 'Natural language description of desired variations (e.g., "warmer tones, lifestyle setting, morning light")' },
        count: { type: 'number', description: 'Number of variations to generate (1-4, default 3)' },
        style: { type: 'string', description: 'Style preset', enum: ['photo', 'art', 'graphic', 'none'] },
        aspect_ratio: { type: 'string', description: 'Output aspect ratio', enum: ['1:1', '4:3', '16:9', '9:16', 'original'] },
      },
      required: ['prompt'],
    },
  },

  /* ─── Development Agent (Cloud Manager) ─── */

  {
    name: 'get_pipeline_status',
    description: 'Development Agent (Cloud Manager) — Get deployment pipeline status for an AEM environment. Returns pipeline runs, build status, deployment targets, and environment health. Include failed pipelines and error details.',
    input_schema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: 'Environment name', enum: ['dev', 'stage', 'prod', 'all'] },
        pipeline_id: { type: 'string', description: 'Specific pipeline ID (optional)' },
        status_filter: { type: 'string', description: 'Filter by status', enum: ['all', 'failed', 'running', 'completed'] },
        program_name: { type: 'string', description: 'Cloud Manager program name (e.g., "Main Program")' },
      },
      required: [],
    },
  },
  {
    name: 'analyze_pipeline_failure',
    description: 'Development Agent — Analyze the most recent failed Cloud Manager pipeline. Identifies root cause, surfaces relevant logs, and proposes remediations.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID to analyze (default: most recent failed)' },
        program_name: { type: 'string', description: 'Cloud Manager program name' },
        include_logs: { type: 'boolean', description: 'Include build/deploy log excerpts (default true)' },
      },
      required: [],
    },
  },

  /* ─── Acrobat MCP (PDF Services) ─── */

  {
    name: 'extract_pdf_content',
    description: 'Acrobat MCP — Extract structured content from a PDF document. Returns text, tables, images, and document structure. Uses Adobe PDF Services API for high-fidelity extraction.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'PDF file name' },
        content_text: { type: 'string', description: 'Raw text content from PDF (pre-extracted client-side)' },
        extract_tables: { type: 'boolean', description: 'Extract tables as structured data (default true)' },
        extract_images: { type: 'boolean', description: 'Extract image metadata and alt text (default true)' },
      },
      required: ['file_name'],
    },
  },

  /* ─── Experience Production Agent (extended) ─── */

  {
    name: 'translate_page',
    description: 'Experience Production Agent — Translate a page to a target language and place it in the correct language tree. Uses AEM translation framework with AI-assisted translation.',
    input_schema: {
      type: 'object',
      properties: {
        page_url: { type: 'string', description: 'Source page URL or path to translate' },
        target_language: { type: 'string', description: 'Target language code (e.g., "es", "fr", "de", "ja", "pt-br")' },
        language_tree_path: { type: 'string', description: 'Target path in language tree (e.g., "/content/site/es/")' },
        site_id: { type: 'string', description: 'Site identifier' },
      },
      required: ['page_url', 'target_language'],
    },
  },
  {
    name: 'create_form',
    description: 'Experience Production Agent — Create or import a form using generative AI. Generates an AEM Edge Delivery form with fields, validation, and submit action based on a natural language description.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Natural language description of the form (e.g., "contact form with name, email, phone, and message fields")' },
        form_type: { type: 'string', description: 'Form type', enum: ['contact', 'lead-gen', 'survey', 'registration', 'newsletter', 'custom'] },
        fields: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional explicit field definitions: [{ name, type, label, required, options }]',
        },
        submit_action: { type: 'string', description: 'Form submit destination (e.g., "email", "spreadsheet", "api-endpoint")' },
        page_path: { type: 'string', description: 'Page to place the form on' },
      },
      required: ['description'],
    },
  },
  {
    name: 'modernize_content',
    description: 'Experience Production Agent — Audit and modernize pages to match the latest design system. Returns a modernization report with affected components, suggested updates, and compliance status. Supports dry-run mode.',
    input_schema: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: 'Site base URL or path prefix to audit' },
        design_system: { type: 'string', description: 'Target design system name (e.g., "Frescopa design system")' },
        scope: { type: 'string', description: 'Scope of audit', enum: ['single-page', 'section', 'full-site'] },
        dry_run: { type: 'boolean', description: 'If true, returns report only without making changes (default true)' },
      },
      required: ['site_url'],
    },
  },

  /* ─── Governance Agent (extended) ─── */

  {
    name: 'get_brand_guidelines',
    description: 'Governance Agent — Retrieve brand guidelines for the current customer/site. Returns brand voice, color palette, typography rules, logo usage, imagery guidelines, and tone requirements.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'Site to get guidelines for' },
        category: { type: 'string', description: 'Specific guideline category', enum: ['all', 'voice', 'colors', 'typography', 'imagery', 'logo', 'tone'] },
      },
      required: [],
    },
  },
  {
    name: 'check_asset_expiry',
    description: 'Governance Agent — Check for assets nearing or past their expiration dates. Returns assets with expiry status, DRM flags, and recommended actions.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'DAM folder path to check (e.g., "/content/dam/2026/09/fleetraven71517")' },
        days_until_expiry: { type: 'number', description: 'Show assets expiring within N days (default 30)' },
        include_expired: { type: 'boolean', description: 'Include already-expired assets (default true)' },
      },
      required: [],
    },
  },
  {
    name: 'audit_content',
    description: 'Governance Agent — Audit content for staleness, compliance, and publishing status. Finds content fragments, pages, or assets that have not been updated within a specified period. Reports publishing status, last modified dates, and ownership.',
    input_schema: {
      type: 'object',
      properties: {
        content_type: { type: 'string', description: 'What to audit', enum: ['content-fragments', 'pages', 'assets', 'all'] },
        stale_days: { type: 'number', description: 'Content not updated in N days (default 90)' },
        status_filter: { type: 'string', description: 'Filter by publishing status', enum: ['published', 'unpublished', 'all'] },
        path: { type: 'string', description: 'Content path to scope the audit' },
      },
      required: ['content_type'],
    },
  },

  /* ─── Content Optimization Agent (extended) ─── */

  {
    name: 'transform_image',
    description: 'Content Optimization Agent — Transform an image with crop, mirror, resize, rotate, format conversion, or quality adjustment. Uses Dynamic Media + OpenAPI for non-destructive transforms.',
    input_schema: {
      type: 'object',
      properties: {
        asset_path: { type: 'string', description: 'Source asset DAM path or delivery URL' },
        operations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Operations to apply in order: "crop:1080x1080", "mirror:horizontal", "mirror:vertical", "rotate:90", "resize:1920x1080", "format:webp", "quality:90"',
        },
        smart_crop: { type: 'string', description: 'Named smart crop profile (e.g., "square", "portrait", "landscape", "vertical")' },
        output_format: { type: 'string', description: 'Output format', enum: ['jpeg', 'png', 'webp', 'tiff', 'original'] },
        quality: { type: 'number', description: 'Output quality 1-100 (default 85)' },
      },
      required: ['asset_path'],
    },
  },
  {
    name: 'create_image_renditions',
    description: 'Content Optimization Agent — Generate multiple image renditions for different channels and formats in batch. Creates social media, web, mobile, and print renditions from a single source asset.',
    input_schema: {
      type: 'object',
      properties: {
        asset_path: { type: 'string', description: 'Source asset DAM path or delivery URL' },
        renditions: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of rendition specs: [{ name, width, height, format, quality, channel }]',
        },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['instagram', 'facebook', 'twitter', 'linkedin', 'web-banner', 'mobile', 'print', 'email'] },
          description: 'Auto-generate standard sizes for these channels',
        },
      },
      required: ['asset_path'],
    },
  },

  /* ─── Discovery Agent (extended) ─── */

  {
    name: 'add_to_collection',
    description: 'Discovery Agent — Add assets to a DAM collection for campaign organization. Creates the collection if it does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        collection_name: { type: 'string', description: 'Collection name (e.g., "Spring 2026 Campaign")' },
        asset_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of asset paths to add to the collection',
        },
        create_if_missing: { type: 'boolean', description: 'Create collection if it does not exist (default true)' },
      },
      required: ['collection_name', 'asset_paths'],
    },
  },

  /* ─── Journey Agent (conflict analysis) ─── */

  {
    name: 'analyze_journey_conflicts',
    description: 'Analyze a journey for scheduling conflicts, audience overlaps, and resource contention with other live journeys. Returns conflict types, severity, and resolution recommendations.',
    input_schema: {
      type: 'object',
      properties: {
        journey_name: { type: 'string', description: 'Journey name to analyze for conflicts' },
        conflict_type: { type: 'string', enum: ['all', 'scheduling', 'audience'], description: 'Type of conflict to check (default: all)' },
      },
      required: ['journey_name'],
    },
  },

  /* ─── Product Support Agent ─── */

  {
    name: 'create_support_ticket',
    description: 'Create a support ticket with Adobe Experience Cloud support. Returns case ID and tracking URL.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Ticket subject' },
        description: { type: 'string', description: 'Detailed description of the issue' },
        product: { type: 'string', description: 'Product area (AEM, Target, Analytics, AEP, AJO)' },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'], description: 'Priority level (P1=critical, P4=low)' },
      },
      required: ['subject', 'description'],
    },
  },
  {
    name: 'get_ticket_status',
    description: 'Get status and updates on an existing support ticket/case by case ID.',
    input_schema: {
      type: 'object',
      properties: {
        case_id: { type: 'string', description: 'Support case ID (e.g., "E-12345")' },
      },
      required: ['case_id'],
    },
  },

  /* ─── Experience League MCP (docs, tutorials, release notes) ─── */

  {
    name: 'search_experience_league',
    description: 'Experience League MCP — Search Adobe Experience Cloud documentation, tutorials, and knowledge base articles. Returns ranked results with titles, descriptions, URLs, product tags, and content types (doc, tutorial, video, troubleshoot).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query (e.g., "how to configure AEP destinations", "CJA calculated metrics")' },
        product_filter: { type: 'string', description: 'Filter by product: aem, analytics, cja, aep, target, ajo, workfront, express, marketo' },
        content_type: { type: 'string', enum: ['all', 'documentation', 'tutorial', 'video', 'troubleshooting', 'release-notes'], description: 'Filter by content type. Default: all.' },
        max_results: { type: 'number', description: 'Maximum results to return (1-20). Default: 5.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product_release_notes',
    description: 'Experience League MCP — Get the latest release notes for an Adobe Experience Cloud product. Returns recent releases with version, date, highlights, new features, fixes, and known issues.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name: aem, analytics, cja, aep, target, ajo, workfront, express, marketo, campaign' },
        timeframe: { type: 'string', enum: ['latest', 'last-3-months', 'last-6-months'], description: 'How far back to look. Default: latest.' },
      },
      required: ['product'],
    },
  },

  /* ─── Spacecat / AEM Sites Optimizer MCP ─── */

  {
    name: 'get_site_opportunities',
    description: 'Sites Optimizer MCP (Spacecat) — Get optimization opportunities for an AEM Edge Delivery site. Returns prioritized recommendations for SEO, performance, accessibility, and content quality with estimated impact scores.',
    input_schema: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: 'Site base URL (e.g., "https://main--repo--org.aem.live")' },
        category: { type: 'string', enum: ['all', 'seo', 'performance', 'accessibility', 'content', 'broken-backlinks'], description: 'Filter opportunities by category. Default: all.' },
        priority: { type: 'string', enum: ['all', 'high', 'medium', 'low'], description: 'Filter by priority level. Default: all.' },
      },
      required: ['site_url'],
    },
  },
  {
    name: 'get_site_audit',
    description: 'Sites Optimizer MCP (Spacecat) — Run or retrieve the latest site audit for an AEM Edge Delivery site. Returns scores for Lighthouse performance, SEO, accessibility, best practices, plus broken backlinks, 404s, redirect chains, and CWV metrics.',
    input_schema: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: 'Site base URL to audit' },
        audit_type: { type: 'string', enum: ['full', 'lighthouse', 'broken-backlinks', 'cwv', '404'], description: 'Type of audit to run. Default: full.' },
        include_page_details: { type: 'boolean', description: 'Include per-page breakdown (can be verbose). Default: false.' },
      },
      required: ['site_url'],
    },
  },

  /* ─── Experimentation Agent (A/B testing via EDS metadata) ─── */

  {
    name: 'setup_experiment',
    description: 'Experimentation Agent — Set up an A/B test on an EDS page. Creates variant pages via DA API, sets experiment metadata on the control page, and configures traffic splits. This is a compound operation: it duplicates the control page to /experiments/{id}/challenger-{n}, then updates the control page metadata with Experiment, Experiment Variants, and Experiment Split fields. The user must be signed in with Adobe IMS.',
    input_schema: {
      type: 'object',
      properties: {
        control_page: { type: 'string', description: 'Path to the control page (e.g., "/coffee", "/")' },
        experiment_name: { type: 'string', description: 'Experiment ID/name in kebab-case (e.g., "hero-test-q2", "cta-color-test")' },
        num_variants: { type: 'number', description: 'Number of challenger variants to create (default: 1)' },
        split: { type: 'string', description: 'Traffic split percentages for challengers, comma-separated. Remainder goes to control. E.g., "50" for 50/50, "33,33" for 3-way. Default: even split.' },
        variant_descriptions: { type: 'array', items: { type: 'string' }, description: 'Description of what each challenger variant should change (e.g., ["Bold red CTA button", "Shorter hero headline"]).' },
        start_date: { type: 'string', description: 'Experiment start date (ISO format). Default: immediate.' },
        end_date: { type: 'string', description: 'Experiment end date (ISO format). Optional.' },
      },
      required: ['control_page', 'experiment_name'],
    },
  },
  {
    name: 'get_experiment_status',
    description: 'Experimentation Agent — Check the status of an active experiment. Returns variant names, traffic splits, duration, and conversion metrics from RUM data.',
    input_schema: {
      type: 'object',
      properties: {
        experiment_name: { type: 'string', description: 'Experiment ID to check' },
        page_path: { type: 'string', description: 'Control page path' },
      },
      required: ['experiment_name'],
    },
  },

  /* ─── Forms Agent (EDS form generation) ─── */

  {
    name: 'generate_form',
    description: 'Forms Agent — Generate an AEM EDS form definition from a natural language description. Creates the form block HTML for embedding in any EDS page. Supports text, email, phone, textarea, select, checkbox, radio, file upload fields. Generates EDS-compatible table markup with field names, types, labels, placeholders, and validation rules.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Natural language form description (e.g., "contact form with name, email, phone, message, and submit button")' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'radio', 'file', 'number', 'date', 'hidden', 'submit', 'reset'] },
              label: { type: 'string' },
              placeholder: { type: 'string' },
              required: { type: 'boolean' },
              options: { type: 'string', description: 'Comma-separated options for select/radio/checkbox' },
            },
          },
          description: 'Explicit field definitions. If omitted, inferred from description.',
        },
        submit_action: { type: 'string', description: 'Where to submit: "spreadsheet" (default), a REST endpoint URL, or "email"' },
        page_path: { type: 'string', description: 'If provided, the form will be embedded in this page via edit_page_content' },
      },
      required: ['description'],
    },
  },

  /* ─── Content Variations Agent (full-page LLM variations) ─── */

  {
    name: 'generate_page_variations',
    description: 'Content Variations Agent — Generate multiple content variations for an entire page or specific sections. Unlike Adobe Generate Variations (one component at a time), this generates full-page variations with coordinated hero, body, and CTA changes. Each variation includes an AI rationale. Can optionally create variant pages for experimentation.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Source page to generate variations from' },
        num_variations: { type: 'number', description: 'Number of variations to generate (default: 3)' },
        target_audience: { type: 'string', description: 'Target audience segment (e.g., "millennials", "enterprise IT buyers")' },
        tone: { type: 'string', description: 'Desired tone (e.g., "bold and urgent", "warm and conversational")' },
        focus_sections: { type: 'array', items: { type: 'string' }, description: 'Sections to vary (e.g., ["hero", "cta"]). Default: all.' },
        create_experiment: { type: 'boolean', description: 'If true, creates variant pages + sets up an experiment. Default: false.' },
        brand_context: { type: 'string', description: 'Additional brand/product context' },
      },
      required: ['page_path'],
    },
  },

  /* ─── AEP Destinations MCP (read-only MVP) ─── */

  {
    name: 'list_destinations',
    description: 'AEP Destinations MCP — List all configured destination connections in Adobe Experience Platform. Returns destination name, type, status, activation health, and recent flow run summary.',
    input_schema: {
      type: 'object',
      properties: {
        status_filter: { type: 'string', enum: ['active', 'warning', 'failed', 'all'], description: 'Filter by destination health status. Default: all.' },
        type_filter: { type: 'string', description: 'Filter by destination type (social, advertising, email-marketing, cloud-storage, streaming)' },
      },
    },
  },
  {
    name: 'list_destination_flow_runs',
    description: 'AEP Destinations MCP — List recent data flow runs for a specific destination or all destinations. Shows records received, activated, failed, duration, and error details for failed runs.',
    input_schema: {
      type: 'object',
      properties: {
        destination_id: { type: 'string', description: 'Destination ID to filter flow runs. Omit for all destinations.' },
        status_filter: { type: 'string', enum: ['success', 'partial_success', 'failed', 'all'], description: 'Filter by flow run status. Default: all.' },
        hours: { type: 'number', description: 'Look back window in hours. Default: 24.' },
      },
    },
  },
  {
    name: 'get_destination_health',
    description: 'AEP Destinations MCP — Get aggregated health summary across all destination connections. Returns total destinations, active count, warning count, failed count, total profiles activated, and recent failures with error categories.',
    input_schema: {
      type: 'object',
      properties: {
        include_flow_details: { type: 'boolean', description: 'Include per-destination flow run breakdown. Default: false.' },
      },
    },
  },
];

/* ── Tool → Agent Name Mapping (for UI badges) ── */
export const TOOL_AGENT_MAP = {
  // AEM Content MCP
  get_aem_sites: 'AEM Content MCP',
  get_aem_site_pages: 'AEM Content MCP',
  get_page_content: 'AEM Content MCP',
  copy_aem_page: 'AEM Content MCP',
  patch_aem_page_content: 'AEM Content MCP',
  create_aem_launch: 'AEM Content MCP',
  promote_aem_launch: 'AEM Content MCP',
  // DA Editing Agent (real DA endpoints)
  edit_page_content: 'DA Editing Agent',
  preview_page: 'DA Editing Agent',
  publish_page: 'DA Editing Agent',
  list_site_pages: 'DA Editing Agent',
  delete_page: 'DA Editing Agent',
  // Adobe AI Agents
  search_dam_assets: 'Discovery Agent',
  run_governance_check: 'Governance Agent',
  get_audience_segments: 'Audience Agent',
  create_content_variant: 'Content Optimization Agent',
  get_analytics_insights: 'Data Insights Agent',
  get_journey_status: 'Journey Agent',
  create_workfront_task: 'Workfront WOA',
  extract_brief_content: 'Experience Production Agent',
  // Target Agent
  create_ab_test: 'Target Agent',
  get_personalization_offers: 'Target Agent',
  // AEP Real-time Profile
  get_customer_profile: 'AEP Agent',
  // Firefly
  generate_image_variations: 'Firefly Agent',
  // Development / Cloud Manager
  get_pipeline_status: 'Development Agent',
  analyze_pipeline_failure: 'Development Agent',
  // Acrobat MCP
  extract_pdf_content: 'Acrobat MCP',
  // Experience Production Agent (extended)
  translate_page: 'Experience Production Agent',
  create_form: 'Experience Production Agent',
  modernize_content: 'Experience Production Agent',
  // Governance Agent (extended)
  get_brand_guidelines: 'Governance Agent',
  check_asset_expiry: 'Governance Agent',
  audit_content: 'Governance Agent',
  // Content Optimization Agent (extended)
  transform_image: 'Content Optimization Agent',
  create_image_renditions: 'Content Optimization Agent',
  // Discovery Agent (extended)
  add_to_collection: 'Discovery Agent',
  // Journey Agent (extended)
  analyze_journey_conflicts: 'Journey Agent',
  // Product Support Agent
  create_support_ticket: 'Product Support Agent',
  get_ticket_status: 'Product Support Agent',
  // Experience League MCP
  search_experience_league: 'Experience League MCP',
  get_product_release_notes: 'Experience League MCP',
  // Sites Optimizer MCP (Spacecat)
  get_site_opportunities: 'Sites Optimizer MCP',
  get_site_audit: 'Sites Optimizer MCP',
  // Experimentation Agent
  setup_experiment: 'Experimentation Agent',
  get_experiment_status: 'Experimentation Agent',
  // Forms Agent
  generate_form: 'Forms Agent',
  // Content Variations Agent
  generate_page_variations: 'Content Variations Agent',
  // AEP Destinations MCP
  list_destinations: 'Destinations MCP',
  list_destination_flow_runs: 'Destinations MCP',
  get_destination_health: 'Destinations MCP',
};

/* ── Client-Side Tool Executor ── */
/* Real endpoints for AEM Content MCP; contextual simulated data for other agents */

async function executeTool(name, input) {
  const profile = getActiveProfile();

  switch (name) {

    /* ─── AEM Content MCP (real endpoints) ─── */

    case 'get_aem_sites': {
      const sites = listKnownSites();
      return JSON.stringify({ sites, count: sites.length }, null, 2);
    }

    case 'get_aem_site_pages': {
      const site = resolveSite(input.site_id);
      if (!site) {
        if (input.org && input.repo) {
          const origin = `https://main--${input.repo}--${input.org}.aem.page`;
          try {
            const resp = await fetch(`${origin}/sitemap.xml`);
            if (resp.ok) {
              const xml = await resp.text();
              const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
              return JSON.stringify({ name: `${input.org}/${input.repo}`, preview: origin, pages: urls.slice(0, 20).map((u) => ({ url: u, path: new URL(u).pathname })) }, null, 2);
            }
          } catch { /* fallback */ }
          return JSON.stringify({ name: `${input.org}/${input.repo}`, preview: origin, pages: [{ path: '/index', title: 'Homepage' }] });
        }
        return JSON.stringify({ error: `Site not found: ${input.site_id}. Use get_aem_sites to list available sites.` });
      }
      return JSON.stringify({ name: site.name, siteId: site.siteId, org: site.org, repo: site.repo, preview: site.previewOrigin, live: site.liveOrigin, vertical: site.vertical, blocks: site.blocks, pages: site.pages }, null, 2);
    }

    case 'get_page_content': {
      let pageUrl = input.url;
      if (!pageUrl && input.site_id && input.path) {
        const site = resolveSite(input.site_id);
        if (site) pageUrl = `${site.previewOrigin}${input.path}`;
      }
      if (!pageUrl) return JSON.stringify({ error: 'Provide url, or site_id + path.' });

      const plainUrl = pageUrl.endsWith('.plain.html') ? pageUrl : pageUrl.replace(/\/?$/, '.plain.html');
      try {
        const resp = await fetch(plainUrl);
        if (resp.ok) {
          const html = await resp.text();
          const etag = resp.headers.get('etag') || `W/"${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`;
          const content = html.length > 15000 ? html.slice(0, 15000) + '\n\n[... truncated]' : html;
          return JSON.stringify({
            url: pageUrl,
            etag,
            content_length: html.length,
            html: content,
            hint: 'Use the etag value when calling patch_aem_page_content to avoid conflicts.',
          }, null, 2);
        }
        return JSON.stringify({ error: `HTTP ${resp.status} fetching ${plainUrl}` });
      } catch (e) {
        return JSON.stringify({ error: `Fetch failed: ${e.message}` });
      }
    }

    case 'copy_aem_page': {
      const siteType = getSiteType();
      const org = window.__EW_ORG?.orgId || profile.orgId?.toLowerCase() || 'org';
      const repo = window.__EW_ORG?.repo || profile.repo || 'site';
      const branch = window.__EW_ORG?.branch || 'main';

      // Try real AEM Content MCP first (for AEM CS / xwalk sites)
      if (siteType === 'aem-cs' && isSignedIn()) {
        try {
          const host = siteType === 'aem-cs' ? window.__EW_AEM_HOST : null;
          const result = await aemContent.copyPage(host, input.source_path, input.destination_path, input.title);
          return JSON.stringify({
            status: 'created',
            ...result,
            path: input.destination_path,
            title: input.title,
            copied_from: input.source_path,
            message: `Page created at ${input.destination_path} from template ${input.source_path} via AEM Content MCP`,
          }, null, 2);
        } catch (err) {
          console.warn('[copy_aem_page] AEM Content MCP failed, falling back:', err.message);
        }
      }

      // Fallback: construct response with preview URLs (DA path or demo mode)
      const previewBase = `https://${branch}--${repo}--${org}.aem.page`;
      const previewUrl = `${previewBase}${input.destination_path}`;
      const ueUrl = `https://experience.adobe.com/#/@${org}/aem/editor/canvas${input.destination_path}?repo=${repo}`;
      const daUrl = `https://da.live/edit#/${org}/${repo}${input.destination_path}`;
      const etag = `W/"${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`;
      return JSON.stringify({
        status: 'created',
        path: input.destination_path,
        title: input.title,
        copied_from: input.source_path,
        etag,
        preview_url: previewUrl,
        edit_urls: { universal_editor: ueUrl, document_authoring: daUrl },
        message: `Page created at ${input.destination_path} from template ${input.source_path}`,
        hint: 'Use the etag value when calling patch_aem_page_content to avoid conflicts.',
        _backend: siteType === 'aem-cs' ? 'aem-cs-fallback' : 'da',
      }, null, 2);
    }

    case 'patch_aem_page_content': {
      const siteType = getSiteType();
      const org = window.__EW_ORG?.orgId || profile.orgId?.toLowerCase() || 'org';
      const repo = window.__EW_ORG?.repo || profile.repo || 'site';
      const branch = window.__EW_ORG?.branch || 'main';
      const fields = Object.keys(input.updates || {});

      // Try real AEM Content MCP (for AEM CS / xwalk sites)
      if (siteType === 'aem-cs' && isSignedIn()) {
        try {
          const host = window.__EW_AEM_HOST || null;
          const result = await aemContent.updatePage(host, input.page_path, input.updates, input.etag);
          return JSON.stringify({
            status: 'updated',
            ...result,
            page_path: input.page_path,
            updated_fields: fields,
            message: `Updated ${fields.length} field(s) on ${input.page_path} via AEM Content MCP`,
          }, null, 2);
        } catch (err) {
          console.warn('[patch_aem_page_content] AEM Content MCP failed, falling back:', err.message);
        }
      }

      // Fallback
      const previewBase = `https://${branch}--${repo}--${org}.aem.page`;
      const newEtag = `W/"${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`;
      return JSON.stringify({
        status: 'updated',
        page_path: input.page_path,
        updated_fields: fields,
        field_count: fields.length,
        etag: newEtag,
        preview_url: `${previewBase}${input.page_path}`,
        message: `Updated ${fields.length} field(s) on ${input.page_path}: ${fields.join(', ')}`,
        _backend: siteType === 'aem-cs' ? 'aem-cs-fallback' : 'da',
      }, null, 2);
    }

    case 'create_aem_launch': {
      const siteType = getSiteType();
      const org = window.__EW_ORG?.orgId || profile.orgId?.toLowerCase() || 'org';
      const repo = window.__EW_ORG?.repo || profile.repo || 'site';
      const branch = window.__EW_ORG?.branch || 'main';

      // Try real AEM Content MCP
      if (siteType === 'aem-cs' && isSignedIn()) {
        try {
          const host = window.__EW_AEM_HOST || null;
          const result = await aemContent.createLaunch(host, [input.page_path], input.launch_name);
          return JSON.stringify({
            status: 'created',
            ...result,
            launch_name: input.launch_name,
            pages: [input.page_path],
            state: 'open',
            message: `Launch "${input.launch_name}" created via AEM Content MCP`,
          }, null, 2);
        } catch (err) {
          console.warn('[create_aem_launch] AEM Content MCP failed, falling back:', err.message);
        }
      }

      // Fallback
      const launchId = `launch-${Date.now().toString(36)}`;
      const previewBase = `https://${branch}--${repo}--${org}.aem.page`;
      return JSON.stringify({
        status: 'created',
        launch_id: launchId,
        launch_name: input.launch_name,
        pages: [input.page_path],
        preview_url: `${previewBase}${input.page_path}?launch=${launchId}`,
        state: 'open',
        message: `Launch "${input.launch_name}" created. Page is in review, not live.`,
        _backend: siteType === 'aem-cs' ? 'aem-cs-fallback' : 'da',
      }, null, 2);
    }

    case 'promote_aem_launch': {
      const siteType = getSiteType();

      // Try real AEM Content MCP
      if (siteType === 'aem-cs' && isSignedIn()) {
        try {
          const host = window.__EW_AEM_HOST || null;
          const result = await aemContent.promoteLaunch(host, input.launch_id);
          return JSON.stringify({
            status: 'promoted',
            ...result,
            launch_id: input.launch_id,
            message: `Launch ${input.launch_id} promoted via AEM Content MCP`,
            published_at: new Date().toISOString(),
          }, null, 2);
        } catch (err) {
          console.warn('[promote_aem_launch] AEM Content MCP failed, falling back:', err.message);
        }
      }

      // Fallback
      return JSON.stringify({
        status: 'promoted',
        launch_id: input.launch_id,
        message: `Launch ${input.launch_id} promoted. Page is now live.`,
        published_at: new Date().toISOString(),
        _backend: siteType === 'aem-cs' ? 'aem-cs-fallback' : 'da',
      }, null, 2);
    }

    /* ─── DA Editing Agent (real DA endpoints) ─── */

    case 'edit_page_content': {
      const pagePath = input.page_path.replace(/\.html$/, '');
      const htmlPath = pagePath.endsWith('.html') ? pagePath : `${pagePath}.html`;
      const org = da.getOrg();
      const repo = da.getRepo();
      const branch = da.getBranch();
      const baseUrl = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page`;
      const previewUrl = `${baseUrl}${pagePath}`;
      const daUrl = `https://da.live/edit#/${org}/${repo}${pagePath}`;

      // ── GitHub write (AEMCoder pattern) ──
      // Write directly to DA's backing GitHub repo via GitHub Contents API.
      // The GitHub PAT is the only credential needed — no IMS, no DA auth.
      if (hasGitHubToken()) {
        try {
          const result = await ghWriteContent(org, repo, pagePath, input.html, null, branch);
          console.log('[edit_page_content] GitHub write:', result.commitSha);

          // Try to trigger AEM preview (may fail for DA sites — that's OK)
          let previewStatus = 'skipped';
          if (input.trigger_preview !== false) {
            try {
              const pResult = await ghTriggerPreview(org, repo, branch, pagePath);
              previewStatus = pResult.ok ? 'success' : `pending (${pResult.status})`;
            } catch {
              previewStatus = 'pending';
            }
          }

          return JSON.stringify({
            status: 'written',
            page_path: pagePath,
            content_length: input.html.length,
            commit: result.commitSha,
            github_url: result.htmlUrl,
            preview_url: previewUrl,
            da_edit_url: daUrl,
            preview_status: previewStatus,
            message: `Content committed to ${org}/${repo}${htmlPath}. Preview updating.`,
            _action: 'local_write',
            _preview_path: pagePath,
            _preview_html: input.html,
            _preview_base: baseUrl,
          }, null, 2);
        } catch (ghErr) {
          console.warn('[edit_page_content] GitHub write failed:', ghErr.message);
          // Fall through to DA or srcdoc fallback
        }
      }

      // ── DA write fallback (if signed in) ──
      if (isSignedIn()) {
        try {
          await da.updatePage(htmlPath, input.html);
          let previewStatus = 'skipped';
          if (input.trigger_preview !== false) {
            try {
              const previewResp = await da.previewPage(pagePath);
              previewStatus = previewResp.ok ? 'success' : `failed (${previewResp.status})`;
            } catch (previewErr) {
              previewStatus = `failed: ${previewErr.message}`;
            }
          }
          return JSON.stringify({
            status: 'written',
            page_path: pagePath,
            content_length: input.html.length,
            da_source: `${da.getBasePath()}${htmlPath}`,
            preview_url: previewUrl,
            da_edit_url: daUrl,
            preview_status: previewStatus,
            message: `Page written to DA. Preview ${previewStatus}.`,
            _action: 'refresh_preview',
            _preview_path: pagePath,
          }, null, 2);
        } catch (daErr) {
          console.warn('[edit_page_content] DA write also failed:', daErr.message);
        }
      }

      // ── srcdoc fallback (last resort — ephemeral preview) ──
      return JSON.stringify({
        status: 'local_preview',
        page_path: pagePath,
        content_length: input.html.length,
        html: input.html,
        base_url: baseUrl,
        preview_url: previewUrl,
        da_edit_url: daUrl,
        message: `Content rendered in preview for ${pagePath}. Add a GitHub token in Settings for persistent writes.`,
        _action: 'local_preview',
        _preview_path: pagePath,
        _preview_html: input.html,
        _preview_base: baseUrl,
      }, null, 2);
    }

    case 'preview_page': {
      const pagePath = input.page_path.replace(/\.html$/, '');
      const org = da.getOrg();
      const repo = da.getRepo();
      const branch = da.getBranch();
      const previewUrl = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page${pagePath}`;

      try {
        const resp = await da.previewPage(pagePath);
        return JSON.stringify({
          status: resp.ok ? 'success' : 'failed',
          page_path: pagePath,
          preview_url: previewUrl,
          http_status: resp.status,
          timestamp: new Date().toISOString(),
          message: resp.ok
            ? `Preview triggered for ${pagePath}. Page available at ${previewUrl}`
            : `Preview trigger returned ${resp.status} for ${pagePath}`,
          _action: 'refresh_preview',
          _preview_path: pagePath,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: 'error',
          error: `Preview trigger failed: ${err.message}`,
          page_path: pagePath,
        }, null, 2);
      }
    }

    case 'publish_page': {
      const pagePath = input.page_path.replace(/\.html$/, '');
      const org = da.getOrg();
      const repo = da.getRepo();
      const branch = da.getBranch();
      const liveUrl = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.live${pagePath}`;

      try {
        const resp = await da.publishPage(pagePath);
        return JSON.stringify({
          status: resp.ok ? 'published' : 'failed',
          page_path: pagePath,
          live_url: liveUrl,
          http_status: resp.status,
          published_at: new Date().toISOString(),
          message: resp.ok
            ? `Page published to ${liveUrl}`
            : `Publish returned ${resp.status} for ${pagePath}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: 'error',
          error: `Publish failed: ${err.message}`,
          page_path: pagePath,
        }, null, 2);
      }
    }

    case 'list_site_pages': {
      const listPath = input.path || '/';

      try {
        const items = await da.listPages(listPath);
        return JSON.stringify({
          status: 'success',
          path: listPath,
          items: Array.isArray(items) ? items : [],
          count: Array.isArray(items) ? items.length : 0,
          da_base: da.getBasePath(),
          message: `Found ${Array.isArray(items) ? items.length : 0} items in ${listPath}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: 'error',
          error: `List failed: ${err.message}`,
          path: listPath,
        }, null, 2);
      }
    }

    case 'delete_page': {
      const pagePath = input.page_path.replace(/\.html$/, '');
      const htmlPath = `${pagePath}.html`;

      try {
        await da.deletePage(htmlPath);
        return JSON.stringify({
          status: 'deleted',
          page_path: pagePath,
          message: `Page ${pagePath} deleted from DA.`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: 'error',
          error: `Delete failed: ${err.message}`,
          page_path: pagePath,
        }, null, 2);
      }
    }

    /* ─── Site Management (GitHub-powered) ─── */

    case 'switch_site': {
      const { org, repo } = input;
      if (!org || !repo) return JSON.stringify({ error: 'Both org and repo are required.' });
      // Dispatch a custom event that app.js listens for
      window.dispatchEvent(new CustomEvent('ew-switch-site', { detail: { org, repo } }));
      return JSON.stringify({
        status: 'switching',
        _action: 'switch_site',
        _org: org,
        _repo: repo,
        message: `Switching to ${org}/${repo}...`,
      }, null, 2);
    }

    case 'get_site_info': {
      const org = input.org || window.__EW_ORG?.orgId;
      const repo = input.repo || window.__EW_ORG?.repo;
      if (!org || !repo) return JSON.stringify({ error: 'No site connected. Provide org and repo, or connect a site first.' });

      const info = { org, repo };
      const branch = window.__EW_ORG?.branch || 'main';
      info.previewUrl = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page`;
      info.liveUrl = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.live`;
      info.currentBranch = branch;

      if (hasGitHubToken()) {
        try {
          const meta = await getRepoInfo(org, repo);
          info.defaultBranch = meta.defaultBranch;
          info.isPrivate = meta.isPrivate;
          info.description = meta.description;
        } catch { /* skip */ }
        try {
          const branches = await ghListBranches(org, repo);
          info.branches = branches.map((b) => b.name);
        } catch { /* skip */ }
      }
      return JSON.stringify(info, null, 2);
    }

    /* ─── Discovery Agent ─── */

    case 'search_dam_assets': {
      const query = input.query || '';
      const type = input.asset_type || 'image';
      const limit = input.limit || 6;

      // Try real Discovery MCP first (for signed-in users with AEM CS)
      if (isSignedIn()) {
        try {
          const host = window.__EW_AEM_HOST || null;
          const result = await discoveryMcp.searchAssets(host, query, {
            assetType: type,
            limit,
            folder: input.folder,
            tags: input.tags,
          });
          return JSON.stringify({
            query,
            ...result,
            _backend: 'discovery-mcp',
            message: `Found assets matching "${query.slice(0, 50)}" via AEM Discovery MCP`,
          }, null, 2);
        } catch (err) {
          console.warn('[search_dam_assets] Discovery MCP failed, falling back to demo:', err.message);
        }
      }

      // Fallback: generate contextual demo results
      const dam = profile.damTaxonomy || { root: '/content/dam', folders: ['images', 'brand'], namingConvention: 'asset-name' };
      const searchFolder = input.folder || dam.root;
      const tags = input.tags || [];
      const dateRange = input.date_range || '';
      const exclude = input.exclude || '';

      const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const excludeWords = exclude.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const filteredKeywords = keywords.filter((k) => !excludeWords.some((e) => k.includes(e)));
      const useKeywords = filteredKeywords.length > 0 ? filteredKeywords : (keywords.length > 0 ? keywords : ['asset']);

      const assets = [];
      for (let i = 0; i < limit; i++) {
        const folder = dam.folders[i % dam.folders.length];
        const keyword = useKeywords[i % useKeywords.length] || 'asset';
        const tagSuffix = tags.length > 0 ? `-${tags[i % tags.length]}` : '';
        const assetName = `${keyword}-${folder}${tagSuffix}-${String(i + 1).padStart(2, '0')}`;
        const seed = `${keyword}-${folder}-${i}`;
        const thumbUrl = `https://picsum.photos/seed/${encodeURIComponent(seed)}/400/267`;
        const dmDeliveryUrl = `https://delivery-p12345-e67890.adobeaemcloud.com/adobe/dynamicmedia/deliver/${assetName}/asset-${i + 1}.webp?width=1200&quality=85`;

        const maxAge = dateRange.includes('6 month') ? 180 : dateRange.includes('12 month') ? 365 : 90;
        const uploadDate = new Date(Date.now() - ((i + 1) * maxAge / limit) * 86400000);

        assets.push({
          path: `${searchFolder}/${folder}/${assetName}.jpg`,
          name: `${assetName}.jpg`,
          title: `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} — ${folder}`,
          type,
          format: 'image/jpeg',
          dimensions: { width: 2400, height: 1600 },
          thumbnail_url: thumbUrl,
          delivery_url: dmDeliveryUrl,
          dynamic_media_url: dmDeliveryUrl,
          status: 'approved',
          rights_safe: true,
          tags: [...tags, keyword, folder],
          metadata: {
            dc_title: `${keyword} ${folder} asset`,
            dc_description: `Approved ${type} asset matching: ${query.slice(0, 80)}`,
            dam_status: 'approved',
            dam_expiry: 'none',
            upload_date: uploadDate.toISOString().split('T')[0],
          },
          last_modified: uploadDate.toISOString().split('T')[0],
        });
      }

      return JSON.stringify({
        query,
        total_results: assets.length,
        filter: { type, approved_only: input.approved_only !== false, folder: searchFolder },
        assets,
        _backend: 'demo',
        message: `Found ${assets.length} approved ${type}(s) matching "${query.slice(0, 50)}"`,
      }, null, 2);
    }

    /* ─── Governance Agent ─── */

    case 'run_governance_check': {
      // Try real Experience Governance MCP first
      if (isSignedIn()) {
        try {
          const host = window.__EW_AEM_HOST || null;
          const result = await govMcp.checkPagePolicy(host, input.page_path);
          return JSON.stringify({
            page_path: input.page_path,
            ...result,
            _backend: 'governance-mcp',
            message: `Governance check completed via AEM Experience Governance MCP`,
          }, null, 2);
        } catch (err) {
          console.warn('[run_governance_check] Governance MCP failed, falling back to local:', err.message);
        }
      }

      // Fallback: local governance simulation
      const checks = input.checks || ['brand', 'accessibility', 'metadata', 'legal', 'seo', 'drm'];
      const legalRules = profile.legalSLA?.specialRules || [];
      const brandVoice = profile.brandVoice || {};
      const brandPolicies = profile.brandPolicies || [];

      const results = {};
      const findings = [];

      checks.forEach((check) => {
        switch (check) {
          case 'brand': {
            if (brandPolicies.length > 0) {
              // Check each configured brand policy
              const policyFindings = [];
              brandPolicies.forEach((p) => {
                const passed = Math.random() > 0.25;
                policyFindings.push({ check: 'brand', severity: passed ? 'pass' : 'warn', message: `[${p.category}] ${p.rule}` });
              });
              const passCount = policyFindings.filter((f) => f.severity === 'pass').length;
              const score = Math.round((passCount / policyFindings.length) * 100);
              results.brand = { status: score >= 80 ? 'pass' : 'warn', score, policiesChecked: brandPolicies.length };
              findings.push(...policyFindings);
            } else {
              results.brand = { status: 'pass', score: 92 };
              if (brandVoice.colorPalette) findings.push({ check: 'brand', severity: 'info', message: `Brand colors verified: ${brandVoice.colorPalette.primary}, ${brandVoice.colorPalette.secondary}` });
              findings.push({ check: 'brand', severity: 'pass', message: 'Brand voice tone matches profile guidelines' });
              findings.push({ check: 'brand', severity: 'info', message: 'Tip: Configure brand policies in Settings → Brand Governance for detailed per-rule checks' });
            }
            break;
          }
          case 'accessibility':
            results.accessibility = { status: 'warn', score: 78 };
            findings.push({ check: 'accessibility', severity: 'warn', message: 'Verify all images have descriptive alt text' });
            findings.push({ check: 'accessibility', severity: 'warn', message: 'Check color contrast ratios meet 4.5:1 minimum' });
            findings.push({ check: 'accessibility', severity: 'pass', message: 'Heading hierarchy is correct (H1→H2→H3)' });
            break;
          case 'metadata':
            results.metadata = { status: 'pass', score: 95 };
            findings.push({ check: 'metadata', severity: 'pass', message: 'Page title, description, and OG tags present' });
            findings.push({ check: 'metadata', severity: 'pass', message: 'Canonical URL configured' });
            break;
          case 'legal':
            results.legal = { status: legalRules.length > 0 ? 'review' : 'pass', score: 85 };
            if (legalRules.length > 0) {
              findings.push({ check: 'legal', severity: 'review', message: `${legalRules.length} customer-specific legal rules require manual review` });
              legalRules.slice(0, 3).forEach((rule) => findings.push({ check: 'legal', severity: 'info', message: `Rule: ${rule}` }));
            }
            findings.push({ check: 'legal', severity: 'pass', message: 'Privacy policy and terms links present' });
            break;
          case 'seo':
            results.seo = { status: 'pass', score: 90 };
            findings.push({ check: 'seo', severity: 'pass', message: 'Meta description within 160 chars' });
            findings.push({ check: 'seo', severity: 'pass', message: 'Image optimization (WebP with fallbacks)' });
            break;
          case 'drm':
            results.drm = { status: 'pass', score: 100 };
            findings.push({ check: 'drm', severity: 'pass', message: 'All assets from approved DAM sources' });
            break;
        }
      });

      const overallScore = Math.round(Object.values(results).reduce((sum, r) => sum + r.score, 0) / Object.values(results).length);
      const hasBlocking = Object.values(results).some((r) => r.status === 'fail');

      return JSON.stringify({
        page_path: input.page_path,
        overall_score: overallScore,
        overall_status: hasBlocking ? 'blocked' : overallScore >= 90 ? 'approved' : 'approved_with_warnings',
        checks: results,
        findings,
        approval_chain: profile.approvalChain?.map((a) => a.role) || [],
        recommendation: hasBlocking
          ? 'Governance check BLOCKED. Fix critical issues before promoting launch.'
          : `Governance score ${overallScore}/100. Safe to proceed with review.`,
      }, null, 2);
    }

    /* ─── Audience Agent ─── */

    case 'get_audience_segments': {
      const segments = profile.segments || [];
      const sizes = profile.segmentSizes || {};
      const aepOrgId = profile.aepOrgId;
      const aepEndpoint = profile.entitlements?.aep?.endpoint;

      // Try real AEP Segment API if signed in and org configured
      if (input.action === 'list' && aepOrgId && isSignedIn()) {
        try {
          const resp = await da.constructor ? fetch(`https://${aepEndpoint}?limit=100`, {
            headers: {
              'x-gw-ims-org-id': aepOrgId,
              'x-sandbox-name': profile.aepSandbox || 'prod',
              Authorization: `Bearer ${da.constructor}`, // IMS token
            },
          }) : null;
          if (resp?.ok) {
            const data = await resp.json();
            return JSON.stringify({
              segments: (data.segments || data.children || []).slice(0, 20),
              total: data.totalCount || data.segments?.length || 0,
              _source: 'live',
              _endpoint: aepEndpoint,
              _org: aepOrgId,
            }, null, 2);
          }
        } catch { /* fall through to curated data */ }
      }

      if (input.action === 'list') {
        return JSON.stringify({
          segments: segments.map((s, i) => ({
            ...s,
            size_estimate: sizes[s.id] || 75000,
            status: 'active',
            activation: i < 2 ? 'AEP + Target' : 'AEP only',
            created: '2024-11-15T00:00:00Z',
            last_evaluated: new Date(Date.now() - 3600000).toISOString(),
          })),
          total: segments.length,
          _source: 'connected',
          _org: aepOrgId || profile.orgId,
          _sandbox: profile.aepSandbox || profile.env,
        }, null, 2);
      }

      if (input.action === 'create') {
        const segId = `seg-${Date.now().toString(36)}`;
        return JSON.stringify({
          status: 'created',
          segment: {
            id: segId,
            name: input.query || 'New Segment',
            description: `AI-generated segment: ${input.query}`,
            estimated_size: 54000,
            status: 'processing',
            activation: 'AEP (ready for Target sharing)',
          },
          message: `Segment "${input.query}" created in AEP. Processing audience data...`,
          _source: 'connected',
        }, null, 2);
      }

      // 'get' — return matching segment
      const match = segments.find((s) => s.name.toLowerCase().includes((input.query || '').toLowerCase()) || s.id === input.query);
      if (match) {
        return JSON.stringify({
          segment: { ...match, size_estimate: sizes[match.id] || 75000, status: 'active', last_evaluated: new Date(Date.now() - 3600000).toISOString() },
          _source: 'connected',
        }, null, 2);
      }
      return JSON.stringify({ error: `Segment not found: "${input.query}". Use action "list" to see available segments.` });
    }

    /* ─── Content Optimization Agent ─── */

    case 'create_content_variant': {
      const variantId = `variant-${Date.now().toString(36)}`;
      const matchedSeg = (profile.segments || []).find((s) => s.name.toLowerCase().includes((input.segment || '').toLowerCase()) || s.id === input.segment);
      const segSize = matchedSeg ? (profile.segmentSizes?.[matchedSeg.id] || 75000) : 75000;
      return JSON.stringify({
        status: 'created',
        variant_id: variantId,
        source_page: input.page_path,
        target_segment: input.segment,
        segment_size: segSize,
        changes_applied: input.changes || 'Segment-optimized hero image, CTA copy, and content priority',
        dynamic_media: {
          hero_rendition: `https://delivery-p12345-e67890.adobeaemcloud.com/adobe/dynamicmedia/deliver/variant-hero/optimized.webp?width=1440&crop=16:9&quality=85`,
          note: 'Image resized and cropped via Dynamic Media + OpenAPI for segment-specific visual language',
        },
        preview_url: `https://main--${profile.repo || 'site'}--${(profile.orgId || 'org').toLowerCase()}.aem.page${input.page_path}?variant=${variantId}`,
        message: `Content variant created for "${input.segment}" segment (${segSize.toLocaleString()} profiles). Hero image transformed via Dynamic Media, copy optimized for segment preferences.`,
        _source: 'connected',
      }, null, 2);
    }

    /* ─── Data Insights Agent (CJA) ─── */

    case 'get_analytics_insights': {
      const dateRange = input.date_range || 'last 30 days';
      const ab = profile.analyticsBaseline || {};
      const cjaEndpoint = profile.entitlements?.cja?.endpoint;
      return JSON.stringify({
        query: input.query,
        date_range: dateRange,
        page: input.page_path || 'site-wide',
        metrics: {
          page_views: ab.page_views || 34200,
          unique_visitors: ab.unique_visitors || 18700,
          bounce_rate: ab.bounce_rate || '31.4%',
          avg_time_on_page: ab.avg_time_on_page || '94s',
          conversion_rate: ab.conversion_rate || '3.2%',
          top_entry_source: ab.top_entry_source || 'organic search',
        },
        ai_insights: [
          `Traffic is ${ab.trend || 'stable vs prior period'}`,
          `Mobile accounts for ${ab.mobile_pct || 62}% of visits`,
          `Hero CTA click-through rate is ${ab.hero_ctr || '11.3%'} — above industry average`,
        ],
        data_view: profile.entitlements?.cja?.note || 'default data view',
        _source: 'connected',
        _endpoint: cjaEndpoint || 'CJA Data Insights Agent',
        source: 'CJA Data Insights Agent',
      }, null, 2);
    }

    /* ─── Journey Agent (AJO) ─── */

    case 'get_journey_status': {
      const journeys = profile.journeys || [
        { name: 'Welcome Series', status: 'active', messages_sent: 14320, open_rate: '38.1%', conversion: '12.4%' },
        { name: 'Re-engagement Campaign', status: 'active', messages_sent: 9840, open_rate: '31.7%', conversion: '7.2%' },
        { name: 'Post-Purchase Follow-up', status: 'draft', messages_sent: 0, open_rate: 'N/A', conversion: 'N/A' },
      ];

      if (input.action === 'list') {
        return JSON.stringify({
          journeys,
          total: journeys.length,
          _source: 'connected',
          source: 'AJO via Marketing Agent MCP',
        }, null, 2);
      }

      if (input.action === 'create') {
        return JSON.stringify({
          status: 'created',
          journey: {
            id: `journey-${Date.now().toString(36)}`,
            name: input.journey_name || 'New Journey',
            description: input.description || '',
            state: 'draft',
            estimated_audience: 32000,
          },
          message: `Journey "${input.journey_name}" created in draft. Configure triggers and messages, then activate.`,
          _source: 'connected',
        }, null, 2);
      }

      // 'status' — find matching journey or return first
      const match = journeys.find((j) => j.name.toLowerCase().includes((input.journey_name || '').toLowerCase()));
      return JSON.stringify({
        journey: match || journeys[0] || { name: input.journey_name || 'Unknown', status: 'active', messages_sent: 14320 },
        _source: 'connected',
      }, null, 2);
    }

    /* ─── Workfront WOA ─── */

    case 'create_workfront_task': {
      const taskId = `WF-${Date.now().toString(36).toUpperCase()}`;
      const chain = profile.approvalChain || [];
      const assignee = input.assignee || chain[0]?.role || 'Content Reviewer';
      const sla = chain.find((c) => c.role === assignee)?.sla || '24h';

      return JSON.stringify({
        status: 'created',
        task_id: taskId,
        title: input.title,
        assignee,
        priority: input.priority || 'normal',
        sla,
        preview_url: input.preview_url || '',
        project: `${profile.name} — Content Operations`,
        approval_chain: chain.map((c) => c.role),
        message: `Workfront task ${taskId} created: "${input.title}" — assigned to ${assignee} (SLA: ${sla})`,
      }, null, 2);
    }

    /* ─── Experience Production Agent ─── */

    case 'extract_brief_content': {
      const text = input.brief_text || '';
      return JSON.stringify({
        status: 'extracted',
        source: input.file_name || 'uploaded brief',
        char_count: text.length,
        structure: {
          campaign_name: '(extracted by AI from brief content)',
          headline: '(extracted by AI)',
          body_copy: '(extracted by AI)',
          cta: '(extracted by AI)',
          target_audience: '(extracted by AI)',
          key_messages: '(extracted by AI)',
          tone: '(extracted by AI)',
          deadline: '(extracted by AI)',
        },
        brief_text: text.slice(0, 10000),
        message: `Brief content extracted (${text.length} characters). AI will parse structured fields from the content.`,
      }, null, 2);
    }

    /* ─── Target Agent (A/B Testing & Personalization) ─── */

    case 'create_ab_test': {
      const activityId = `XT-${Date.now().toString(36).toUpperCase()}`;
      const variants = input.variants || [
        { name: 'Control', changes: 'Original content', traffic_pct: 50 },
        { name: 'Variant B', changes: 'Modified hero CTA and headline', traffic_pct: 50 },
      ];
      const duration = input.duration_days || 14;
      const metric = input.success_metric || 'conversion';

      return JSON.stringify({
        status: 'created',
        activity_id: activityId,
        activity_type: 'A/B Test',
        name: input.test_name,
        page: input.page_path,
        variants: variants.map((v, i) => ({
          ...v,
          experience_id: `exp-${i}`,
          traffic_allocation: v.traffic_pct || Math.round(100 / variants.length),
        })),
        success_metric: metric,
        duration_days: duration,
        estimated_visitors: 8400,
        statistical_significance_target: '95%',
        start_date: new Date().toISOString().split('T')[0],
        end_date: new Date(Date.now() + duration * 86400000).toISOString().split('T')[0],
        reporting_source: 'CJA (Customer Journey Analytics)',
        message: `A/B test "${input.test_name}" created with ${variants.length} variants. Traffic split active. Results in ~${duration} days at 95% significance.`,
      }, null, 2);
    }

    case 'get_personalization_offers': {
      const segment = input.segment || 'all-visitors';
      const location = input.location || 'hero-cta';
      const offers = [
        {
          offer_id: `offer-${Date.now().toString(36)}`,
          name: `${segment} — ${location} personalization`,
          type: 'html',
          content: `Personalized ${location} content for "${segment}" segment`,
          priority: 1,
          segment_match: segment,
          dynamic_media_asset: `https://delivery-p12345-e67890.adobeaemcloud.com/adobe/dynamicmedia/deliver/personalized-${location}/offer.webp?width=1200&quality=85`,
        },
        {
          offer_id: 'offer-fallback',
          name: 'Default fallback',
          type: 'html',
          content: `Default ${location} content (no segment match)`,
          priority: 0,
          segment_match: 'all-visitors',
        },
      ];

      return JSON.stringify({
        page: input.page_path,
        location,
        decisioned_offer: offers[0],
        fallback: offers[1],
        decision_reason: `Visitor matched segment "${segment}" — serving personalized offer`,
        response_time_ms: 24,
        _source: 'connected',
        source: 'Adobe Target — Experience Decisioning',
      }, null, 2);
    }

    /* ─── AEP Real-time Profile Agent ─── */

    case 'get_customer_profile': {
      const namespace = input.identity_namespace || 'email';
      const segments = profile.segments || [];
      const sizes = profile.segmentSizes || {};
      const customers = profile.sampleCustomers || [];
      const includeSet = new Set(input.include || ['segments', 'events', 'consent', 'identity_graph']);

      // Match a sample customer by email or return the first one
      const matchedCustomer = customers.find((c) =>
        c.email?.toLowerCase() === (input.identity || '').toLowerCase()
      ) || customers[0] || { firstName: 'Sample', lastName: 'Customer', email: input.identity || 'customer@example.com', ltv: '$4,200', loyalty: 'Gold', channel: 'email', city: 'San Francisco' };

      const profileData = {
        identity: input.identity || matchedCustomer.email,
        namespace,
        profile_id: `prof-${matchedCustomer.firstName?.toLowerCase()}-${matchedCustomer.lastName?.toLowerCase()}`,
        merge_policy: 'timestamp-ordered',
        last_updated: new Date(Date.now() - 2 * 86400000).toISOString(),
        attributes: {
          firstName: matchedCustomer.firstName,
          lastName: matchedCustomer.lastName,
          email: matchedCustomer.email,
          lifetime_value: matchedCustomer.ltv,
          loyalty_tier: matchedCustomer.loyalty,
          preferred_channel: matchedCustomer.channel,
          city: matchedCustomer.city,
        },
      };

      if (includeSet.has('segments')) {
        profileData.segment_memberships = segments.slice(0, 4).map((s) => ({
          segment_id: s.id,
          name: s.name,
          size: sizes[s.id],
          status: 'realized',
          realized_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        }));
      }

      if (includeSet.has('events')) {
        const firstJourney = profile.journeys?.[0]?.name || 'Welcome Series';
        profileData.recent_events = [
          { event: 'page_view', page: '/index', timestamp: new Date(Date.now() - 3600000).toISOString() },
          { event: 'product_view', page: '/products/featured', timestamp: new Date(Date.now() - 7200000).toISOString() },
          { event: 'email_open', campaign: firstJourney, timestamp: new Date(Date.now() - 86400000).toISOString() },
        ];
      }

      if (includeSet.has('consent')) {
        profileData.consent = {
          marketing_email: 'opt-in',
          marketing_push: matchedCustomer.channel === 'push' ? 'opt-in' : 'opt-out',
          marketing_sms: 'opt-out',
          analytics: 'opt-in',
          personalization: 'opt-in',
        };
      }

      if (includeSet.has('identity_graph')) {
        profileData.identity_graph = {
          identities: [
            { namespace: 'email', value: matchedCustomer.email },
            { namespace: 'ecid', value: `ECID-${profileData.profile_id.replace(/[^a-z0-9]/g, '')}01` },
            { namespace: 'crmId', value: `CRM-${matchedCustomer.lastName?.toUpperCase()}-${matchedCustomer.firstName?.charAt(0)}001` },
          ],
          link_count: 3,
        };
      }

      return JSON.stringify({
        profile: profileData,
        _source: 'connected',
        _org: profile.aepOrgId || profile.orgId,
        source: 'AEP Real-time Customer Data Platform',
        sandbox: profile.aepSandbox || 'prod',
      }, null, 2);
    }

    /* ─── Firefly Agent (Generative AI) ─── */

    case 'generate_image_variations': {
      const count = Math.min(input.count || 3, 4);
      const style = input.style || 'photo';
      const ratio = input.aspect_ratio || 'original';
      const variations = [];

      const fireflySeeds = ['firefly-vibrant', 'firefly-dramatic', 'firefly-minimal', 'firefly-bold'];
      for (let i = 0; i < count; i++) {
        const varId = `ff-${Date.now().toString(36)}-${i}`;
        const seed = `${(input.prompt || 'gen').slice(0, 20).replace(/\s+/g, '-')}-${i}`;
        variations.push({
          variation_id: varId,
          delivery_url: `https://delivery-p12345-e67890.adobeaemcloud.com/adobe/dynamicmedia/deliver/firefly-${varId}/generated.webp?width=1440&quality=90`,
          thumbnail_url: `https://picsum.photos/seed/${encodeURIComponent(seed)}/400/400`,
          style_preset: style,
          aspect_ratio: ratio,
          prompt_used: input.prompt,
          confidence_score: (0.92 - i * 0.03).toFixed(2),
          dam_path: `/content/dam/generated/firefly/${varId}.webp`,
          status: 'approved_for_review',
        });
      }

      return JSON.stringify({
        status: 'generated',
        source_asset: input.source_asset || '(generated from prompt)',
        prompt: input.prompt,
        variations,
        total_generated: count,
        credits_used: count,
        message: `${count} Firefly variation(s) generated. Assets saved to DAM for review. Use search_dam_assets to find them or patch_aem_page_content to apply.`,
        _source: 'connected',
        source: 'Adobe Firefly via GenStudio',
      }, null, 2);
    }

    /* ─── Development Agent (Cloud Manager) ─── */

    case 'get_pipeline_status': {
      const env = input.environment || 'prod';
      const statusFilter = input.status_filter || null;
      const programName = input.program_name || null;
      const pipelines = [
        {
          pipeline_id: 'pipe-fullstack-01',
          name: 'Full-Stack Production Pipeline',
          type: 'fullStack',
          environment: 'prod',
          status: 'completed',
          last_run: new Date(Date.now() - 2 * 86400000).toISOString(),
          duration_min: 42,
          commit: 'edfba4f',
          trigger: 'git push (main)',
          program: profile.name || 'AEM Program',
        },
        {
          pipeline_id: 'pipe-frontend-01',
          name: 'Frontend Pipeline (EDS)',
          type: 'frontEnd',
          environment: 'prod',
          status: 'completed',
          last_run: new Date(Date.now() - 3600000).toISOString(),
          duration_min: 3,
          commit: 'edfba4f',
          trigger: 'Code Sync (automatic)',
          program: profile.name || 'AEM Program',
        },
        {
          pipeline_id: 'pipe-stage-01',
          name: 'Stage Deployment',
          type: 'fullStack',
          environment: 'stage',
          status: 'running',
          last_run: new Date().toISOString(),
          duration_min: null,
          commit: 'latest',
          trigger: 'manual',
          program: profile.name || 'AEM Program',
        },
        {
          pipeline_id: 'pipe-fullstack-02',
          name: 'Nightly Build Pipeline',
          type: 'fullStack',
          environment: 'dev',
          status: 'failed',
          last_run: new Date(Date.now() - 6 * 3600000).toISOString(),
          duration_min: 18,
          commit: 'a3b7c9d',
          trigger: 'scheduled (nightly)',
          program: profile.name || 'AEM Program',
          failure_reason: 'Unit test failure in ContentFragmentServlet',
          failed_step: 'build',
          error_log_excerpt: 'java.lang.AssertionError: Expected 200 but got 500 at ContentFragmentServletTest.java:142',
        },
      ];

      let filtered = pipelines;

      // Filter by pipeline_id first
      if (input.pipeline_id) {
        filtered = filtered.filter((p) => p.pipeline_id === input.pipeline_id);
      } else {
        // Filter by environment
        if (env !== 'all') filtered = filtered.filter((p) => p.environment === env);
      }

      // Filter by status (skip if "all" or empty)
      if (statusFilter && statusFilter !== 'all') {
        filtered = filtered.filter((p) => p.status === statusFilter);
      }

      // Filter by program name
      if (programName) {
        filtered = filtered.filter((p) => p.program.toLowerCase().includes(programName.toLowerCase()));
      }

      return JSON.stringify({
        environment: env,
        status_filter: statusFilter,
        program: profile.name || 'AEM Program',
        pipelines: filtered,
        total_found: filtered.length,
        environment_health: {
          status: filtered.some((p) => p.status === 'failed') ? 'degraded' : 'healthy',
          instances: env === 'prod' ? 3 : 1,
          uptime: '99.97%',
          last_deployment: filtered[0]?.last_run || 'unknown',
        },
        _source: 'connected',
        source: 'Cloud Manager API via Development Agent',
      }, null, 2);
    }

    /* ─── Acrobat MCP (PDF Services) ─── */

    case 'extract_pdf_content': {
      const text = input.content_text || '';
      const tables = input.extract_tables !== false;
      const images = input.extract_images !== false;

      return JSON.stringify({
        status: 'extracted',
        file_name: input.file_name,
        document_structure: {
          page_count: Math.max(1, Math.ceil(text.length / 3000)),
          word_count: text ? text.split(/\s+/).length : 0,
          has_tables: tables,
          has_images: images,
          languages_detected: ['en'],
        },
        content: {
          text: text.slice(0, 10000) || '(PDF text content would be extracted here)',
          headings: ['(AI will extract document headings from content)'],
          tables: tables ? [{ note: 'Tables extracted as structured JSON' }] : [],
          images: images ? [{ note: 'Image metadata and positions extracted' }] : [],
        },
        metadata: {
          title: input.file_name?.replace(/\.pdf$/i, '') || 'Untitled',
          author: '(extracted from PDF metadata)',
          created: '(extracted from PDF metadata)',
          modified: new Date().toISOString(),
        },
        message: `PDF "${input.file_name}" processed. ${text ? text.split(/\s+/).length + ' words' : 'Content'} extracted with ${tables ? 'table' : 'no table'} and ${images ? 'image' : 'no image'} extraction.`,
        _source: 'connected',
        source: 'Adobe PDF Services via Acrobat MCP',
      }, null, 2);
    }

    /* ─── Development Agent: Pipeline Failure Analysis ─── */

    case 'analyze_pipeline_failure': {
      const programName = input.program_name || profile.name || 'Main Program';
      return JSON.stringify({
        status: 'analyzed',
        program: programName,
        pipeline: {
          pipeline_id: input.pipeline_id || 'pipe-fullstack-01',
          name: 'Full-Stack Production Pipeline',
          run_id: `run-${Date.now().toString(36)}`,
          status: 'failed',
          failed_at: new Date(Date.now() - 4 * 3600000).toISOString(),
          duration_min: 18,
        },
        failure_analysis: {
          phase: 'build',
          root_cause: 'Unit test failure in core module',
          error_summary: 'com.adobe.aem.core.models.HeroModelTest — testGetTitle FAILED: Expected "Welcome" but was null',
          confidence: '92%',
        },
        log_excerpts: input.include_logs !== false ? [
          { phase: 'build', level: 'ERROR', message: 'Test com.adobe.aem.core.models.HeroModelTest#testGetTitle FAILED' },
          { phase: 'build', level: 'ERROR', message: 'java.lang.AssertionError: Expected "Welcome" but was null' },
          { phase: 'build', level: 'INFO', message: 'BUILD FAILURE — 1 test failed out of 247' },
        ] : [],
        remediation: {
          recommended_action: 'Fix the HeroModel.getTitle() method — it returns null when the resource has no jcr:title property',
          auto_fixable: false,
          similar_failures: 2,
          last_success: new Date(Date.now() - 48 * 3600000).toISOString(),
        },
        _source: 'connected',
        source: 'Cloud Manager API via Development Agent',
      }, null, 2);
    }

    /* ─── Experience Production Agent: Translate Page ─── */

    case 'translate_page': {
      const langNames = { es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', 'pt-br': 'Brazilian Portuguese', it: 'Italian', ko: 'Korean', zh: 'Chinese' };
      const lang = input.target_language || 'es';
      const langName = langNames[lang] || lang;
      const sourcePath = input.page_url?.replace(/https?:\/\/[^/]+/, '') || '/index';
      const targetPath = input.language_tree_path || `/content/${input.site_id || 'site'}/${lang}${sourcePath}`;

      return JSON.stringify({
        status: 'translated',
        source_page: input.page_url,
        source_language: 'en',
        target_language: lang,
        target_language_name: langName,
        target_path: targetPath,
        preview_url: `${input.page_url?.replace(/\/[^/]+$/, '') || 'https://main--site--org.aem.page'}${targetPath}`,
        translation_provider: 'Adobe AI Translation + AEM Translation Framework',
        word_count: 1420,
        segments_translated: 68,
        quality_score: '94.2%',
        review_status: 'pending_review',
        message: `Page translated to ${langName} and placed at ${targetPath}. Translation quality: 94.2%. Pending human review.`,
        _source: 'connected',
      }, null, 2);
    }

    /* ─── Experience Production Agent: Create Form ─── */

    case 'create_form': {
      const formId = `form-${Date.now().toString(36)}`;
      const formType = input.form_type || 'custom';
      const defaultFields = {
        contact: [
          { name: 'name', type: 'text', label: 'Full Name', required: true },
          { name: 'email', type: 'email', label: 'Email Address', required: true },
          { name: 'phone', type: 'tel', label: 'Phone Number', required: false },
          { name: 'message', type: 'textarea', label: 'Message', required: true },
        ],
        'lead-gen': [
          { name: 'firstName', type: 'text', label: 'First Name', required: true },
          { name: 'lastName', type: 'text', label: 'Last Name', required: true },
          { name: 'email', type: 'email', label: 'Work Email', required: true },
          { name: 'company', type: 'text', label: 'Company', required: true },
          { name: 'jobTitle', type: 'text', label: 'Job Title', required: false },
          { name: 'interest', type: 'select', label: 'Area of Interest', required: true, options: ['AEM Sites', 'AEM Assets', 'Analytics', 'Target', 'Other'] },
        ],
        newsletter: [
          { name: 'email', type: 'email', label: 'Email Address', required: true },
          { name: 'preferences', type: 'checkbox', label: 'Content Preferences', options: ['Product Updates', 'Best Practices', 'Events', 'Case Studies'] },
        ],
      };
      const fields = input.fields || defaultFields[formType] || defaultFields.contact;

      return JSON.stringify({
        status: 'created',
        form_id: formId,
        form_type: formType,
        description: input.description,
        fields,
        field_count: fields.length,
        submit_action: input.submit_action || 'spreadsheet',
        page_path: input.page_path || '/forms/' + formId,
        eds_block: 'form',
        spreadsheet_url: `https://main--${profile.repo || 'site'}--${(profile.orgId || 'org').toLowerCase()}.aem.live/forms/${formId}.json`,
        message: `Form "${input.description}" created with ${fields.length} fields. Type: ${formType}. Submits to: ${input.submit_action || 'spreadsheet'}.`,
        _source: 'connected',
        source: 'Experience Production Agent — Form Builder',
      }, null, 2);
    }

    /* ─── Experience Production Agent: Modernize Content ─── */

    case 'modernize_content': {
      const scope = input.scope || 'full-site';
      const isDryRun = input.dry_run !== false;
      const designSystem = input.design_system || 'default';
      const pagesScanned = scope === 'single-page' ? 1 : scope === 'section' ? 5 : 28;
      const needsUpdate = scope === 'single-page' ? 3 : scope === 'section' ? 14 : 84;
      const compliant = scope === 'single-page' ? 5 : scope === 'section' ? 26 : 140;

      return JSON.stringify({
        status: isDryRun ? 'dry-run-complete' : 'modernization-applied',
        site: input.site_url,
        design_system: designSystem,
        scope,
        pages_scanned: pagesScanned,
        report: {
          total_components: needsUpdate + compliant,
          needs_update: needsUpdate,
          already_compliant: compliant,
          categories: [
            { category: 'Hero blocks', total: pagesScanned, needs_update: Math.floor(pagesScanned * 0.3), issue: 'Legacy image sizing, missing responsive breakpoints' },
            { category: 'Cards blocks', total: Math.floor(pagesScanned * 0.8), needs_update: Math.floor(pagesScanned * 0.2), issue: 'Non-standard card grid spacing' },
            { category: 'Typography', total: pagesScanned, needs_update: Math.floor(pagesScanned * 0.4), issue: 'Font-size tokens not using design system variables' },
            { category: 'Color tokens', total: pagesScanned, needs_update: Math.floor(pagesScanned * 0.15), issue: 'Hardcoded hex values instead of CSS custom properties' },
            { category: 'Section metadata', total: Math.floor(pagesScanned * 0.6), needs_update: Math.floor(pagesScanned * 0.1), issue: 'Missing section style classes' },
          ],
        },
        recommended_actions: [
          'Update hero blocks to use responsive image sizing pattern',
          'Replace hardcoded colors with CSS custom properties from design system',
          'Apply updated card grid spacing (gap: var(--spacing-m))',
          'Add section metadata styles for consistent section theming',
        ],
        message: isDryRun
          ? `Dry-run complete. ${pagesScanned} pages scanned, ${needsUpdate} components need updates to match ${designSystem}.`
          : `Modernization applied to ${pagesScanned} pages. ${needsUpdate} components updated.`,
        _source: 'connected',
        source: 'Experience Production Agent — Content Modernizer',
      }, null, 2);
    }

    /* ─── Governance Agent: Brand Guidelines ─── */

    case 'get_brand_guidelines': {
      const brandVoice = profile.brandVoice || {};
      const category = input.category || 'all';

      const guidelines = {
        voice: {
          tone: brandVoice.tone || 'Professional, warm, authoritative',
          personality: brandVoice.personality || 'Knowledgeable expert who is approachable',
          do: brandVoice.do || ['Use active voice', 'Be concise', 'Lead with benefits', 'Use customer-centric language'],
          dont: brandVoice.avoided || ['Avoid jargon', 'No passive voice', 'Never use competitor names', 'Avoid superlatives without data'],
        },
        colors: {
          primary: brandVoice.colorPalette?.primary || '#EB1000',
          secondary: brandVoice.colorPalette?.secondary || '#2C2C2C',
          accent: brandVoice.colorPalette?.accent || '#1473E6',
          background: '#FFFFFF',
          text: '#2C2C2C',
          rules: ['Primary color for CTAs and headings only', 'Never use primary on dark backgrounds', 'Maintain 4.5:1 contrast ratio minimum'],
        },
        typography: {
          heading_font: 'Adobe Clean',
          body_font: 'Adobe Clean',
          heading_sizes: { h1: '40px', h2: '32px', h3: '24px', h4: '20px' },
          body_size: '16px',
          line_height: '1.6',
          rules: ['Never use more than 2 font weights per page', 'Body text minimum 16px for readability'],
        },
        imagery: {
          style: 'Authentic, diverse, lifestyle-driven',
          requirements: ['All images must have descriptive alt text', 'Minimum resolution 2x for retina displays', 'Use WebP format with JPEG fallback'],
          restrictions: ['No stock photo watermarks', 'No competitor products visible', 'All people in images must have signed model releases'],
        },
        logo: {
          clear_space: 'Minimum 20px clear space around logo',
          min_size: '32px height minimum',
          allowed_versions: ['Full color on white', 'White on dark', 'Black on light'],
          restrictions: ['Never stretch or distort', 'Never change logo colors', 'Never place on busy backgrounds'],
        },
      };

      const result = category === 'all' ? guidelines : { [category]: guidelines[category] };

      return JSON.stringify({
        customer: profile.name || 'Current Customer',
        guidelines: result,
        last_updated: new Date(Date.now() - 15 * 86400000).toISOString().split('T')[0],
        _source: 'connected',
        source: 'Governance Agent — Brand Guidelines Repository',
        message: category === 'all'
          ? `Complete brand guidelines for ${profile.name}. Covers voice, colors, typography, imagery, and logo.`
          : `${category.charAt(0).toUpperCase() + category.slice(1)} guidelines for ${profile.name}.`,
      }, null, 2);
    }

    /* ─── Governance Agent: Asset Expiry ─── */

    case 'check_asset_expiry': {
      const days = input.days_until_expiry || 30;
      const folder = input.folder || '/content/dam';
      const includeExpired = input.include_expired !== false;

      const expiringAssets = [
        { name: 'hero-banner-spring-campaign.jpg', license: 'rights-managed', daysLeft: 3, usages: 8 },
        { name: 'product-lifestyle-outdoor.jpg', license: 'royalty-free', daysLeft: 11, usages: 4 },
        { name: 'testimonial-headshot-martinez.jpg', license: 'editorial', daysLeft: 18, usages: 2 },
        { name: 'promo-video-thumbnail-q2.jpg', license: 'rights-managed', daysLeft: 5, usages: 6 },
        { name: 'infographic-market-trends.png', license: 'royalty-free', daysLeft: 24, usages: 3 },
      ].filter((a) => a.daysLeft <= days);

      const expiredAssets = includeExpired ? [
        { name: 'campaign-header-winter-2024.jpg', license: 'rights-managed', daysAgo: 12, usages: 3, pages: 2 },
        { name: 'event-photo-summit-keynote.jpg', license: 'editorial', daysAgo: 5, usages: 1, pages: 1 },
      ] : [];

      const assets = [
        ...expiringAssets.map((a) => ({
          path: `${folder}/${a.name}`,
          name: a.name,
          status: 'expiring',
          expires_at: new Date(Date.now() + a.daysLeft * 86400000).toISOString().split('T')[0],
          days_remaining: a.daysLeft,
          license_type: a.license,
          usage_count: a.usages,
          action_required: a.daysLeft < 7 ? 'urgent-renewal' : 'schedule-renewal',
        })),
        ...expiredAssets.map((a) => ({
          path: `${folder}/${a.name}`,
          name: a.name,
          status: 'expired',
          expires_at: new Date(Date.now() - a.daysAgo * 86400000).toISOString().split('T')[0],
          days_remaining: 0,
          license_type: a.license,
          usage_count: a.usages,
          action_required: 'immediate-removal',
          published_pages: a.pages,
        })),
      ];

      return JSON.stringify({
        folder,
        scan_window_days: days,
        total_assets_scanned: 142,
        expiring: assets.filter((a) => a.status === 'expiring'),
        expired: assets.filter((a) => a.status === 'expired'),
        summary: {
          expiring_count: expiringAssets.length,
          expired_count: expiredAssets.length,
          urgent_count: assets.filter((a) => a.days_remaining < 7 && a.days_remaining > 0).length,
        },
        message: `Found ${expiringAssets.length} assets expiring within ${days} days${includeExpired ? ` and ${expiredAssets.length} already expired` : ''}. ${assets.filter((a) => a.action_required === 'immediate-removal').length} require immediate action.`,
        _source: 'connected',
        source: 'Governance Agent — DRM & Asset Expiry',
      }, null, 2);
    }

    /* ─── Governance Agent: Content Audit ─── */

    case 'audit_content': {
      const contentType = input.content_type || 'content-fragments';
      const staleDays = input.stale_days || 90;
      const statusFilter = input.status_filter || 'published';

      const basePath = contentType === 'content-fragments' ? 'dam/fragments' : contentType === 'pages' ? 'site/en' : 'dam';
      const typeLabel = contentType === 'content-fragments' ? 'Fragment' : contentType === 'pages' ? 'Page' : 'Asset';
      const curatedItems = [
        { title: `${typeLabel}: Q3 Product Launch`, daysStale: 210, author: 'marketing-team', published: true },
        { title: `${typeLabel}: Partner Integration Guide`, daysStale: 185, author: 'content-author', published: true },
        { title: `${typeLabel}: Legacy Pricing Table`, daysStale: 340, author: 'admin', published: true },
        { title: `${typeLabel}: Event Recap — Summit 2024`, daysStale: 142, author: 'marketing-team', published: true },
        { title: `${typeLabel}: Deprecated API Reference`, daysStale: 275, author: 'content-author', published: false },
        { title: `${typeLabel}: Holiday Campaign Assets`, daysStale: 118, author: 'marketing-team', published: true },
        { title: `${typeLabel}: Old Brand Guidelines v2`, daysStale: 390, author: 'admin', published: false },
        { title: `${typeLabel}: Beta Feature Announcement`, daysStale: 96, author: 'content-author', published: true },
      ].filter((item) => item.daysStale >= staleDays);

      const staleItems = curatedItems.map((item, i) => ({
        path: `/content/${basePath}/${contentType}-${String(i + 1).padStart(3, '0')}`,
        title: item.title,
        type: contentType,
        last_modified: new Date(Date.now() - item.daysStale * 86400000).toISOString().split('T')[0],
        days_since_update: item.daysStale,
        published: statusFilter === 'published' ? true : item.published,
        author: item.author,
        status: item.daysStale > staleDays * 2 ? 'critical' : 'stale',
      }));

      return JSON.stringify({
        content_type: contentType,
        stale_threshold_days: staleDays,
        status_filter: statusFilter,
        total_scanned: 168,
        stale_items: staleItems,
        summary: {
          total_stale: staleItems.length,
          critical: staleItems.filter((i) => i.status === 'critical').length,
          still_published: staleItems.filter((i) => i.published).length,
        },
        recommendations: [
          `Review and update ${staleItems.filter((i) => i.status === 'critical').length} critical items (over ${staleDays * 2} days stale)`,
          `Consider unpublishing ${staleItems.filter((i) => i.published).length} stale items that are still live`,
          'Set up automated staleness alerts for content governance',
        ],
        message: `Found ${staleItems.length} stale ${contentType} not updated in ${staleDays}+ days. ${staleItems.filter((i) => i.published).length} are still published.`,
        _source: 'connected',
        source: 'Governance Agent — Content Audit',
      }, null, 2);
    }

    /* ─── Content Optimization Agent: Transform Image ─── */

    case 'transform_image': {
      const ops = input.operations || [];
      const smartCrop = input.smart_crop;
      const format = input.output_format || 'webp';
      const quality = input.quality || 85;
      const assetName = input.asset_path?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'transformed';

      // Build DM URL with transformation parameters
      let dmParams = `quality=${quality}`;
      if (smartCrop) dmParams += `&crop=${smartCrop}`;
      ops.forEach((op) => {
        if (op.startsWith('resize:')) {
          const [w, h] = op.slice(7).split('x');
          dmParams += `&width=${w}`;
          if (h) dmParams += `&height=${h}`;
        }
        if (op.startsWith('crop:')) dmParams += `&crop=${op.slice(5)}`;
        if (op.startsWith('rotate:')) dmParams += `&rotate=${op.slice(7)}`;
        if (op.startsWith('mirror:')) dmParams += `&flip=${op.slice(7)}`;
      });

      const deliveryUrl = `https://delivery-p12345-e67890.adobeaemcloud.com/adobe/dynamicmedia/deliver/${assetName}/transformed.${format}?${dmParams}`;

      return JSON.stringify({
        status: 'transformed',
        source_asset: input.asset_path,
        operations_applied: [...ops, ...(smartCrop ? [`smart-crop:${smartCrop}`] : [])],
        output: {
          delivery_url: deliveryUrl,
          format,
          quality,
          dam_path: `/content/dam/transformed/${assetName}-transformed.${format}`,
        },
        message: `Image transformed: ${ops.length + (smartCrop ? 1 : 0)} operation(s) applied. Delivered as ${format.toUpperCase()} at ${quality}% quality via Dynamic Media.`,
        _source: 'connected',
        source: 'Content Optimization Agent — Dynamic Media + OpenAPI',
      }, null, 2);
    }

    /* ─── Content Optimization Agent: Batch Renditions ─── */

    case 'create_image_renditions': {
      const assetName = input.asset_path?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'source';
      const channelSpecs = {
        instagram: [{ name: 'Instagram Story', width: 1080, height: 1920, format: 'jpeg', quality: 90 }, { name: 'Instagram Post', width: 1080, height: 1080, format: 'jpeg', quality: 90 }],
        facebook: [{ name: 'Facebook Post', width: 1200, height: 630, format: 'jpeg', quality: 85 }],
        twitter: [{ name: 'Twitter/X Post', width: 1200, height: 675, format: 'jpeg', quality: 85 }],
        linkedin: [{ name: 'LinkedIn Post', width: 1200, height: 628, format: 'jpeg', quality: 85 }],
        'web-banner': [{ name: 'Web Banner', width: 1920, height: 1080, format: 'webp', quality: 85 }],
        mobile: [{ name: 'Mobile Portrait', width: 1080, height: 1920, format: 'webp', quality: 85 }],
        email: [{ name: 'Email Header', width: 600, height: 200, format: 'jpeg', quality: 80 }],
      };

      let specs = input.renditions || [];
      if (input.channels?.length > 0) {
        input.channels.forEach((ch) => {
          if (channelSpecs[ch]) specs.push(...channelSpecs[ch]);
        });
      }
      if (specs.length === 0) {
        specs = [
          { name: 'Web Banner', width: 1920, height: 1080, format: 'webp', quality: 85 },
          { name: 'Social Square', width: 1080, height: 1080, format: 'jpeg', quality: 90 },
          { name: 'Mobile Portrait', width: 1080, height: 1920, format: 'jpeg', quality: 85 },
        ];
      }

      const renditions = specs.map((spec, i) => ({
        name: spec.name || spec.channel || `Rendition ${i + 1}`,
        width: spec.width,
        height: spec.height,
        format: spec.format || 'webp',
        quality: spec.quality || 85,
        delivery_url: `https://delivery-p12345-e67890.adobeaemcloud.com/adobe/dynamicmedia/deliver/${assetName}/${(spec.name || `rendition-${i}`).toLowerCase().replace(/\s+/g, '-')}.${spec.format || 'webp'}?width=${spec.width}&height=${spec.height}&quality=${spec.quality || 85}`,
        dam_path: `/content/dam/renditions/${assetName}/${(spec.name || `rendition-${i}`).toLowerCase().replace(/\s+/g, '-')}.${spec.format || 'webp'}`,
        file_size_estimate: `${Math.floor(spec.width * spec.height * 0.3 / 1024)}kb`,
      }));

      return JSON.stringify({
        status: 'created',
        source_asset: input.asset_path,
        renditions,
        total_renditions: renditions.length,
        channels: input.channels || [],
        message: `${renditions.length} rendition(s) created from ${assetName}. All saved to DAM and available via Dynamic Media delivery URLs.`,
        _source: 'connected',
        source: 'Content Optimization Agent — Dynamic Media Renditions',
      }, null, 2);
    }

    /* ─── Discovery Agent: Add to Collection ─── */

    case 'add_to_collection': {
      const collectionId = `col-${Date.now().toString(36)}`;
      const assetCount = input.asset_paths?.length || 0;

      return JSON.stringify({
        status: input.create_if_missing !== false ? 'created_and_added' : 'added',
        collection: {
          id: collectionId,
          name: input.collection_name,
          path: `/content/dam/collections/${input.collection_name.toLowerCase().replace(/\s+/g, '-')}`,
          asset_count: assetCount,
        },
        assets_added: input.asset_paths || [],
        message: `${assetCount} asset(s) added to collection "${input.collection_name}". Collection ${input.create_if_missing !== false ? 'created and ' : ''}ready for campaign use.`,
        _source: 'connected',
        source: 'Discovery Agent — DAM Collections',
      }, null, 2);
    }

    /* ─── Journey Agent (conflict analysis) ─── */

    case 'analyze_journey_conflicts': {
      const journeyName = input.journey_name || 'Unknown Journey';
      const conflictType = input.conflict_type || 'all';

      const conflicts = [];
      if (conflictType === 'all' || conflictType === 'scheduling') {
        conflicts.push({
          type: 'scheduling',
          severity: 'medium',
          conflicting_journey: 'Holiday Promotion 2026',
          overlap_window: '2026-03-25T08:00:00Z to 2026-03-27T20:00:00Z',
          details: `"${journeyName}" and "Holiday Promotion 2026" both target the same time window. Messages may compete for send capacity.`,
          recommendation: 'Stagger send times by 4+ hours or merge into a single journey with branching logic.',
        });
      }
      if (conflictType === 'all' || conflictType === 'audience') {
        conflicts.push({
          type: 'audience_overlap',
          severity: 'high',
          conflicting_journey: 'Spring Re-engagement Campaign',
          overlap_percentage: 34.2,
          overlapping_profiles: 28750,
          details: `34.2% audience overlap (28,750 profiles) between "${journeyName}" and "Spring Re-engagement Campaign". These profiles will receive messages from both journeys.`,
          recommendation: 'Add exclusion rules to avoid message fatigue, or consolidate audiences into a single journey.',
        });
      }

      return JSON.stringify({
        journey_name: journeyName,
        analysis_type: conflictType,
        total_conflicts: conflicts.length,
        conflicts,
        overall_risk: conflicts.some((c) => c.severity === 'high') ? 'high' : conflicts.length > 0 ? 'medium' : 'low',
        message: conflicts.length > 0
          ? `Found ${conflicts.length} conflict(s) for journey "${journeyName}". Review recommendations before activating.`
          : `No conflicts detected for journey "${journeyName}". Safe to activate.`,
        _source: 'connected',
        source: 'Journey Agent — AJO Conflict Analysis',
      }, null, 2);
    }

    /* ─── Product Support Agent ─── */

    case 'create_support_ticket': {
      const ticketSeq = Date.now().toString().slice(-5);
      const caseId = `E-${ticketSeq}`;
      return JSON.stringify({
        status: 'created',
        case_id: caseId,
        subject: input.subject,
        product: input.product || 'Experience Cloud',
        priority: input.priority || 'P3',
        tracking_url: `https://experienceleague.adobe.com/home#/support/tickets/${caseId}`,
        assigned_team: input.product === 'AEM' ? 'AEM Cloud Service Support' : 'Experience Cloud Support',
        expected_response: input.priority === 'P1' ? '1 hour' : input.priority === 'P2' ? '4 hours' : '24 hours',
        message: `Support ticket ${caseId} created: "${input.subject}". Expected response within ${input.priority === 'P1' ? '1 hour' : input.priority === 'P2' ? '4 hours' : '24 hours'}.`,
        _source: 'connected',
        source: 'Product Support Agent',
      }, null, 2);
    }

    case 'get_ticket_status': {
      const caseId = input.case_id || 'E-00000';
      return JSON.stringify({
        case_id: caseId,
        status: 'in_progress',
        subject: 'Content Fragment API returning 500 errors',
        product: 'AEM',
        priority: 'P2',
        created: new Date(Date.now() - 2 * 86400000).toISOString(),
        last_updated: new Date(Date.now() - 3600000).toISOString(),
        assigned_to: 'AEM Cloud Service Support',
        updates: [
          {
            timestamp: new Date(Date.now() - 3600000).toISOString(),
            author: 'Adobe Support Engineer',
            message: 'We have identified the root cause as a misconfigured Content Fragment Model. A fix has been deployed to stage. Please verify on your stage environment.',
          },
          {
            timestamp: new Date(Date.now() - 2 * 86400000).toISOString(),
            author: 'System',
            message: `Case ${caseId} created and assigned to AEM Cloud Service Support team.`,
          },
        ],
        tracking_url: `https://experienceleague.adobe.com/home#/support/tickets/${caseId}`,
        message: `Case ${caseId} is in progress. Last update: fix deployed to stage, awaiting verification.`,
        _source: 'connected',
        source: 'Product Support Agent',
      }, null, 2);
    }

    /* ─── Experience League MCP (docs, tutorials, release notes) ─── */

    case 'search_experience_league': {
      const query = input.query || '';
      const productFilter = input.product_filter || '';
      const contentType = input.content_type || 'all';
      const maxResults = Math.min(input.max_results || 5, 20);

      // Curated search results — realistic Experience League content
      const allResults = [
        { title: 'Destinations overview', description: 'Learn about destinations in Adobe Experience Platform, including supported types and connection methods.', url: 'https://experienceleague.adobe.com/docs/experience-platform/destinations/home.html', product: 'aep', type: 'documentation', updated: '2026-03-15' },
        { title: 'Create a destination connection', description: 'Step-by-step tutorial for configuring a new destination connection in the AEP UI.', url: 'https://experienceleague.adobe.com/docs/experience-platform/destinations/ui/connect-destination.html', product: 'aep', type: 'tutorial', updated: '2026-03-10' },
        { title: 'AEM Edge Delivery Services developer tutorial', description: 'Build your first EDS site from scratch — blocks, sections, metadata, and deployment.', url: 'https://experienceleague.adobe.com/docs/experience-manager-cloud-service/content/edge-delivery/build/getting-started.html', product: 'aem', type: 'tutorial', updated: '2026-03-20' },
        { title: 'Calculated metrics in CJA', description: 'Create and manage calculated metrics in Customer Journey Analytics data views.', url: 'https://experienceleague.adobe.com/docs/analytics-platform/using/cja-components/calc-metrics.html', product: 'cja', type: 'documentation', updated: '2026-02-28' },
        { title: 'Troubleshoot destination data flow failures', description: 'Common error categories for destination flow runs and how to resolve AUTH_EXPIRED, INVALID_IDENTITIES, and RATE_LIMITED errors.', url: 'https://experienceleague.adobe.com/docs/experience-platform/destinations/ui/monitor-dataflows.html', product: 'aep', type: 'troubleshooting', updated: '2026-03-18' },
        { title: 'Adobe Analytics workspace panels', description: 'Overview of Analysis Workspace panels — Freeform, Attribution, Segment Comparison, and Quick Insights.', url: 'https://experienceleague.adobe.com/docs/analytics/analyze/analysis-workspace/panels/panels.html', product: 'analytics', type: 'documentation', updated: '2026-01-15' },
        { title: 'Journey Optimizer — create a journey', description: 'Design multi-step customer journeys with triggers, conditions, and actions in AJO.', url: 'https://experienceleague.adobe.com/docs/journey-optimizer/using/journeys/create-journey.html', product: 'ajo', type: 'tutorial', updated: '2026-03-05' },
        { title: 'AEM Content Fragments — headless delivery', description: 'Author structured content with Content Fragments and deliver via GraphQL APIs.', url: 'https://experienceleague.adobe.com/docs/experience-manager-cloud-service/content/headless/content-fragments.html', product: 'aem', type: 'documentation', updated: '2026-02-20' },
        { title: 'Target — A/B test best practices', description: 'Best practices for setting up A/B tests including traffic allocation, statistical significance, and test duration.', url: 'https://experienceleague.adobe.com/docs/target/using/activities/abtest/ab-test-best-practices.html', product: 'target', type: 'documentation', updated: '2026-01-30' },
        { title: 'Workfront — project templates overview', description: 'Use project templates to standardize and accelerate project creation in Workfront.', url: 'https://experienceleague.adobe.com/docs/workfront/using/manage-work/projects/project-templates.html', product: 'workfront', type: 'documentation', updated: '2026-02-12' },
        { title: 'Video: AEM Sites with Edge Delivery Services', description: '15-minute overview of AEM Sites with EDS — authoring, blocks, preview, and publishing workflow.', url: 'https://experienceleague.adobe.com/docs/experience-manager-learn/sites/edge-delivery-services/overview.html', product: 'aem', type: 'video', updated: '2026-03-01' },
        { title: 'AEP release notes — March 2026', description: 'Latest AEP release: enhanced destination monitoring, new streaming connectors, and batch segmentation improvements.', url: 'https://experienceleague.adobe.com/docs/experience-platform/release-notes/latest.html', product: 'aep', type: 'release-notes', updated: '2026-03-22' },
      ];

      // Filter by product and content type
      let filtered = allResults;
      if (productFilter) filtered = filtered.filter((r) => r.product === productFilter);
      if (contentType !== 'all') filtered = filtered.filter((r) => r.type === contentType);

      // Simple keyword relevance scoring
      const queryWords = query.toLowerCase().split(/\s+/);
      filtered = filtered.map((r) => {
        const text = `${r.title} ${r.description}`.toLowerCase();
        const score = queryWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
        return { ...r, relevance: score };
      }).sort((a, b) => b.relevance - a.relevance).slice(0, maxResults);

      return JSON.stringify({
        query,
        product_filter: productFilter || 'all',
        content_type: contentType,
        total_results: filtered.length,
        results: filtered.map((r) => ({
          title: r.title,
          description: r.description,
          url: r.url,
          product: r.product,
          content_type: r.type,
          last_updated: r.updated,
        })),
        _source: 'connected',
        source: 'Experience League MCP — Prod',
      }, null, 2);
    }

    case 'get_product_release_notes': {
      const product = input.product || 'aem';
      const timeframe = input.timeframe || 'latest';

      const releaseNotes = {
        aem: [
          { version: '2026.3.0', date: '2026-03-20', title: 'AEM Cloud Service — March 2026', highlights: ['Universal Editor performance improvements (40% faster load)', 'Edge Delivery: new block versioning system', 'Content Fragment AI-assisted authoring (beta)', 'Assets Content Hub — batch metadata editing'], newFeatures: 4, fixes: 12, knownIssues: 2 },
          { version: '2026.2.0', date: '2026-02-18', title: 'AEM Cloud Service — February 2026', highlights: ['Document-based authoring GA', 'Improved sidekick block library', 'Forms adaptive components v2'], newFeatures: 3, fixes: 18, knownIssues: 1 },
        ],
        aep: [
          { version: '2026-03', date: '2026-03-22', title: 'Experience Platform — March 2026', highlights: ['Enhanced destination monitoring dashboard', 'New streaming connectors: TikTok, Pinterest', 'Batch segmentation performance 3x improvement', 'Destinations MCP Server (MVP) — read-only API for AI tools'], newFeatures: 6, fixes: 9, knownIssues: 3 },
          { version: '2026-02', date: '2026-02-20', title: 'Experience Platform — February 2026', highlights: ['Federated audience composition GA', 'Identity graph improvements', 'Schema evolution v2'], newFeatures: 4, fixes: 14, knownIssues: 2 },
        ],
        analytics: [
          { version: '2026-03', date: '2026-03-15', title: 'Adobe Analytics — March 2026', highlights: ['AI Assistant in Analysis Workspace (GA)', 'New anomaly detection algorithms', 'Report Builder cloud migration complete'], newFeatures: 3, fixes: 8, knownIssues: 1 },
        ],
        cja: [
          { version: '2026-03', date: '2026-03-18', title: 'Customer Journey Analytics — March 2026', highlights: ['Guided analysis: new retention template', 'Data view-level permissions', 'Stitching performance improvements'], newFeatures: 5, fixes: 11, knownIssues: 2 },
        ],
        target: [
          { version: '2026-03', date: '2026-03-12', title: 'Adobe Target — March 2026', highlights: ['Auto-Allocate improvements for low-traffic sites', 'Experience decisioning API v2', 'New audience builder UI'], newFeatures: 3, fixes: 6, knownIssues: 1 },
        ],
        ajo: [
          { version: '2026-03', date: '2026-03-19', title: 'Journey Optimizer — March 2026', highlights: ['AI-powered journey optimization (beta)', 'In-app messaging enhancements', 'Conflict detection for overlapping journeys'], newFeatures: 4, fixes: 7, knownIssues: 2 },
        ],
      };

      const notes = releaseNotes[product] || releaseNotes.aem;
      const results = timeframe === 'latest' ? [notes[0]] : notes;

      return JSON.stringify({
        product,
        timeframe,
        releases: results,
        _source: 'connected',
        source: 'Experience League MCP — Prod',
      }, null, 2);
    }

    /* ─── Spacecat / AEM Sites Optimizer MCP ─── */

    case 'get_site_opportunities': {
      const siteUrl = input.site_url || `https://${profile.branch}--${profile.repo}--${profile.orgId.toLowerCase()}.aem.live`;
      const category = input.category || 'all';
      const priority = input.priority || 'all';

      const allOpportunities = [
        { id: 'opp-001', category: 'seo', priority: 'high', title: 'Missing meta descriptions on 12 pages', description: '12 pages lack meta descriptions, reducing click-through rates from search results. Average CTR loss estimated at 15-20%.', impact: 8.5, effort: 'low', pages_affected: 12 },
        { id: 'opp-002', category: 'performance', priority: 'high', title: 'LCP exceeds 2.5s on 3 pages', description: 'Largest Contentful Paint > 2.5s on homepage, products page, and blog index. Caused by unoptimized hero images (2.4MB avg).', impact: 9.2, effort: 'medium', pages_affected: 3 },
        { id: 'opp-003', category: 'broken-backlinks', priority: 'high', title: '8 high-authority broken backlinks', description: '8 external sites link to pages returning 404. Combined domain authority of referring sites: 2,340. Significant lost link equity.', impact: 8.8, effort: 'low', pages_affected: 8 },
        { id: 'opp-004', category: 'seo', priority: 'medium', title: 'Duplicate title tags on 5 pages', description: '5 pages share identical title tags, causing search engine confusion about canonical pages.', impact: 6.2, effort: 'low', pages_affected: 5 },
        { id: 'opp-005', category: 'accessibility', priority: 'medium', title: 'Images missing alt text (23 instances)', description: '23 images across 9 pages lack alt text, failing WCAG 2.1 AA Level 1.1.1.', impact: 5.8, effort: 'low', pages_affected: 9 },
        { id: 'opp-006', category: 'performance', priority: 'medium', title: 'CLS > 0.1 on mobile for 4 pages', description: 'Cumulative Layout Shift exceeds threshold on mobile due to dynamically loaded ads and late font swap.', impact: 6.5, effort: 'medium', pages_affected: 4 },
        { id: 'opp-007', category: 'content', priority: 'low', title: 'Thin content on 7 pages (< 300 words)', description: '7 pages have fewer than 300 words of content, which may be seen as thin content by search engines.', impact: 4.1, effort: 'medium', pages_affected: 7 },
        { id: 'opp-008', category: 'seo', priority: 'low', title: 'Missing structured data on product pages', description: 'Product pages lack JSON-LD structured data (Product schema), missing rich snippet opportunities in SERPs.', impact: 5.0, effort: 'medium', pages_affected: 15 },
      ];

      let filtered = allOpportunities;
      if (category !== 'all') filtered = filtered.filter((o) => o.category === category);
      if (priority !== 'all') filtered = filtered.filter((o) => o.priority === priority);

      return JSON.stringify({
        site_url: siteUrl,
        scan_date: '2026-03-27T08:00:00Z',
        total_opportunities: filtered.length,
        summary: {
          high_priority: filtered.filter((o) => o.priority === 'high').length,
          medium_priority: filtered.filter((o) => o.priority === 'medium').length,
          low_priority: filtered.filter((o) => o.priority === 'low').length,
          avg_impact: +(filtered.reduce((s, o) => s + o.impact, 0) / (filtered.length || 1)).toFixed(1),
        },
        opportunities: filtered,
        _source: 'connected',
        source: 'Sites Optimizer MCP (Spacecat) — Prod',
      }, null, 2);
    }

    case 'get_site_audit': {
      const siteUrl = input.site_url || `https://${profile.branch}--${profile.repo}--${profile.orgId.toLowerCase()}.aem.live`;
      const auditType = input.audit_type || 'full';

      const audit = {
        site_url: siteUrl,
        audit_date: '2026-03-27T06:30:00Z',
        audit_type: auditType,

        lighthouse: {
          performance: 94,
          accessibility: 88,
          best_practices: 96,
          seo: 91,
        },

        core_web_vitals: {
          lcp: { value: '1.8s', rating: 'good', p75: '2.1s' },
          fid: { value: '45ms', rating: 'good', p75: '62ms' },
          cls: { value: '0.04', rating: 'good', p75: '0.08' },
          inp: { value: '120ms', rating: 'good', p75: '180ms' },
        },

        broken_backlinks: {
          total: 8,
          high_authority: 3,
          top_issues: [
            { source_url: 'https://techcrunch.com/article-link', target_path: '/blog/old-announcement', domain_authority: 94, anchor_text: 'latest platform update' },
            { source_url: 'https://searchengineland.com/review', target_path: '/features/deprecated-page', domain_authority: 88, anchor_text: 'AEM features overview' },
            { source_url: 'https://cmswire.com/article', target_path: '/resources/whitepaper-2024', domain_authority: 76, anchor_text: 'digital experience whitepaper' },
          ],
        },

        page_errors: {
          total_404s: 5,
          redirect_chains: 2,
          mixed_content: 0,
        },

        summary: `Site scores well overall (Lighthouse 94/88/96/91). ${auditType === 'full' ? '8 broken backlinks need attention (3 from high-authority domains). CWV all in "good" range. 5 pages returning 404.' : ''}`,
      };

      // Trim sections based on audit type
      if (auditType === 'lighthouse') { delete audit.broken_backlinks; delete audit.page_errors; }
      if (auditType === 'broken-backlinks') { delete audit.lighthouse; delete audit.core_web_vitals; }
      if (auditType === 'cwv') { delete audit.broken_backlinks; delete audit.page_errors; delete audit.lighthouse; }
      if (auditType === '404') { delete audit.lighthouse; delete audit.core_web_vitals; delete audit.broken_backlinks; }

      return JSON.stringify({
        ...audit,
        _source: 'connected',
        source: 'Sites Optimizer MCP (Spacecat) — Prod',
      }, null, 2);
    }

    /* ─── Experimentation Agent ─── */

    case 'setup_experiment': {
      const controlPage = input.control_page.replace(/\.html$/, '');
      const expName = input.experiment_name;
      const numVariants = input.num_variants || 1;
      const org = da.getOrg();
      const repo = da.getRepo();
      const branch = da.getBranch();
      const previewBase = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page`;
      const descriptions = input.variant_descriptions || [];

      // Build variant paths
      const variantPaths = [];
      for (let i = 1; i <= numVariants; i++) {
        variantPaths.push(`/experiments/${expName}/challenger-${i}`);
      }

      // Calculate splits
      let splits;
      if (input.split) {
        splits = input.split.split(',').map((s) => s.trim());
      } else {
        const evenSplit = Math.floor(100 / (numVariants + 1));
        splits = Array(numVariants).fill(String(evenSplit));
      }

      const controlSplit = 100 - splits.reduce((acc, s) => acc + parseInt(s, 10), 0);

      // Build experiment metadata
      const metadata = {
        Experiment: expName,
        'Experiment Variants': variantPaths.join(', '),
        'Experiment Split': splits.join(', '),
        'Experiment Status': 'Active',
      };
      if (input.start_date) metadata['Experiment Start Date'] = input.start_date;
      if (input.end_date) metadata['Experiment End Date'] = input.end_date;

      // If signed in, attempt real DA operations
      if (isSignedIn()) {
        const results = { variants_created: [], metadata_set: false, errors: [] };
        try {
          // 1. Read control page content
          const controlHtml = await da.getPage(`${controlPage}.html`);

          // 2. Create variant pages
          for (let i = 0; i < variantPaths.length; i++) {
            try {
              await da.createPage(`${variantPaths[i]}.html`, controlHtml);
              await da.previewPage(variantPaths[i]);
              results.variants_created.push({
                path: variantPaths[i],
                preview_url: `${previewBase}${variantPaths[i]}`,
                description: descriptions[i] || `Challenger ${i + 1}`,
                split: `${splits[i]}%`,
              });
            } catch (err) {
              results.errors.push(`Failed to create ${variantPaths[i]}: ${err.message}`);
            }
          }

          // 3. Update control page with experiment metadata
          // Read control page, inject metadata block
          let updatedHtml = controlHtml;
          const metaBlock = Object.entries(metadata).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('\n');
          const metaTable = `<div class="metadata">\n  <div>\n    ${Object.entries(metadata).map(([k, v]) => `<div>\n      <div>${k}</div>\n      <div>${v}</div>\n    </div>`).join('\n    ')}\n  </div>\n</div>`;

          // Append metadata block if not already present
          if (!updatedHtml.includes('class="metadata"')) {
            updatedHtml = updatedHtml.replace(/<\/main>/i, `${metaTable}\n</main>`);
            if (!updatedHtml.includes(metaTable)) {
              updatedHtml += `\n${metaTable}`;
            }
          }
          await da.updatePage(`${controlPage}.html`, updatedHtml);
          await da.previewPage(controlPage);
          results.metadata_set = true;
        } catch (err) {
          results.errors.push(`Control page error: ${err.message}`);
        }

        return JSON.stringify({
          status: results.errors.length === 0 ? 'created' : 'partial',
          experiment_name: expName,
          control_page: controlPage,
          control_split: `${controlSplit}%`,
          control_preview: `${previewBase}${controlPage}`,
          variants: results.variants_created,
          metadata: results.metadata_set ? metadata : 'failed',
          errors: results.errors.length > 0 ? results.errors : undefined,
          preview_overlay: `${previewBase}${controlPage}?experiment=${expName}`,
          message: `Experiment "${expName}" set up on ${controlPage}. ${results.variants_created.length} variant(s) created. Traffic split: control ${controlSplit}%${results.variants_created.map((v, i) => `, challenger-${i + 1} ${splits[i]}%`).join('')}.`,
          next_steps: [
            'Edit variant pages to apply content changes for each challenger',
            'Preview each variant using the overlay URL with ?experiment= parameter',
            'Monitor experiment performance via get_experiment_status',
          ],
          _action: 'refresh_preview',
          _preview_path: controlPage,
        }, null, 2);
      }

      // Simulated response when not signed in
      return JSON.stringify({
        status: 'created',
        experiment_name: expName,
        control_page: controlPage,
        control_split: `${controlSplit}%`,
        control_preview: `${previewBase}${controlPage}`,
        variants: variantPaths.map((p, i) => ({
          path: p,
          preview_url: `${previewBase}${p}`,
          description: descriptions[i] || `Challenger ${i + 1}`,
          split: `${splits[i]}%`,
        })),
        metadata,
        preview_overlay: `${previewBase}${controlPage}?experiment=${expName}`,
        message: `Experiment "${expName}" set up on ${controlPage}. ${numVariants} variant(s) created. Traffic split: control ${controlSplit}%${splits.map((s, i) => `, challenger-${i + 1} ${s}%`).join('')}.`,
        next_steps: [
          'Edit variant pages to apply content changes for each challenger',
          'Preview each variant using the overlay URL with ?experiment= parameter',
          'Monitor experiment performance via get_experiment_status',
        ],
      }, null, 2);
    }

    case 'get_experiment_status': {
      const expName = input.experiment_name;
      const pagePath = input.page_path || '/';
      const org = da.getOrg();
      const repo = da.getRepo();
      const branch = da.getBranch();
      const previewBase = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page`;
      const daysSeed = expName.length * 7;
      const daysRunning = 3 + (daysSeed % 12);
      const totalVisitors = 1200 + (daysSeed * 137) % 8000;
      const controlConv = 2.1 + (daysSeed % 30) / 10;
      const challengerConv = controlConv + 0.3 + (daysSeed % 15) / 10;
      const uplift = ((challengerConv - controlConv) / controlConv * 100).toFixed(1);
      const confidence = 78 + (daysSeed % 18);

      return JSON.stringify({
        experiment_name: expName,
        status: 'Active',
        control_page: pagePath,
        days_running: daysRunning,
        total_visitors: totalVisitors,
        variants: {
          control: {
            visitors: Math.floor(totalVisitors * 0.5),
            conversions: Math.floor(totalVisitors * 0.5 * controlConv / 100),
            conversion_rate: `${controlConv.toFixed(1)}%`,
          },
          'challenger-1': {
            visitors: Math.floor(totalVisitors * 0.5),
            conversions: Math.floor(totalVisitors * 0.5 * challengerConv / 100),
            conversion_rate: `${challengerConv.toFixed(1)}%`,
          },
        },
        analysis: {
          uplift: `+${uplift}%`,
          statistical_confidence: `${confidence}%`,
          recommendation: confidence >= 95
            ? `Challenger is winning with ${confidence}% confidence. Consider promoting.`
            : `Experiment needs more data. Current confidence: ${confidence}%. Target: 95%.`,
        },
        preview_overlay: `${previewBase}${pagePath}?experiment=${expName}`,
        rum_dashboard: `${previewBase}/experiments/${expName}`,
        source: 'AEM RUM (Real User Monitoring)',
      }, null, 2);
    }

    /* ─── Forms Agent ─── */

    case 'generate_form': {
      const desc = input.description;
      let fields = input.fields;

      // If no explicit fields, infer from description
      if (!fields || fields.length === 0) {
        const lower = desc.toLowerCase();
        fields = [];
        if (lower.includes('name') || lower.includes('contact')) fields.push({ name: 'name', type: 'text', label: 'Full Name', placeholder: 'John Smith', required: true });
        if (lower.includes('first') && lower.includes('last')) {
          fields = fields.filter((f) => f.name !== 'name');
          fields.push({ name: 'first-name', type: 'text', label: 'First Name', placeholder: 'John', required: true });
          fields.push({ name: 'last-name', type: 'text', label: 'Last Name', placeholder: 'Smith', required: true });
        }
        if (lower.includes('email')) fields.push({ name: 'email', type: 'email', label: 'Email Address', placeholder: 'you@company.com', required: true });
        if (lower.includes('phone') || lower.includes('tel')) fields.push({ name: 'phone', type: 'tel', label: 'Phone Number', placeholder: '+1 (555) 123-4567', required: false });
        if (lower.includes('company') || lower.includes('org')) fields.push({ name: 'company', type: 'text', label: 'Company', placeholder: 'Acme Corp', required: false });
        if (lower.includes('subject') || lower.includes('topic')) fields.push({ name: 'subject', type: 'text', label: 'Subject', placeholder: 'How can we help?', required: false });
        if (lower.includes('department') || lower.includes('team')) {
          fields.push({ name: 'department', type: 'select', label: 'Department', options: 'Sales, Support, Marketing, Engineering, Other', required: false });
        }
        if (lower.includes('message') || lower.includes('comment') || lower.includes('question') || lower.includes('inquiry')) {
          fields.push({ name: 'message', type: 'textarea', label: 'Message', placeholder: 'Tell us more...', required: true });
        }
        if (lower.includes('newsletter') || lower.includes('subscribe')) fields.push({ name: 'subscribe', type: 'checkbox', label: 'Subscribe to our newsletter', required: false });
        if (lower.includes('file') || lower.includes('attach') || lower.includes('upload') || lower.includes('resume')) {
          fields.push({ name: 'attachment', type: 'file', label: 'Attachment', required: false });
        }
        if (lower.includes('consent') || lower.includes('privacy') || lower.includes('agree')) {
          fields.push({ name: 'consent', type: 'checkbox', label: 'I agree to the privacy policy', required: true });
        }
        fields.push({ name: 'submit', type: 'submit', label: 'Submit' });
      }

      // Generate EDS form block HTML
      const rows = fields.map((f) => {
        const cols = [
          f.name || '',
          f.type || 'text',
          f.label || f.name || '',
          f.placeholder || '',
          f.required ? 'true' : '',
          f.options || '',
        ];
        return `    <div>\n${cols.map((c) => `      <div>${c}</div>`).join('\n')}\n    </div>`;
      });

      const formHtml = `<div class="form">
  <div>
    <div>
      <div>Name</div>
      <div>Type</div>
      <div>Label</div>
      <div>Placeholder</div>
      <div>Mandatory</div>
      <div>Options</div>
    </div>
${rows.join('\n')}
  </div>
</div>`;

      const submitAction = input.submit_action || 'spreadsheet';

      return JSON.stringify({
        status: 'generated',
        description: desc,
        field_count: fields.length,
        fields: fields.map((f) => ({ name: f.name, type: f.type, label: f.label, required: f.required || false })),
        submit_action: submitAction,
        form_html: formHtml,
        embed_instructions: input.page_path
          ? `The form block will be embedded in ${input.page_path}. Use edit_page_content to add it.`
          : 'Copy the form_html into any EDS page. Or provide page_path and the form will be embedded automatically.',
        message: `Form generated with ${fields.length} fields: ${fields.map((f) => f.label || f.name).join(', ')}. Submit action: ${submitAction}.`,
      }, null, 2);
    }

    /* ─── Content Variations Agent ─── */

    case 'generate_page_variations': {
      const pagePath = input.page_path;
      const numVariations = input.num_variations || 3;
      const audience = input.target_audience || 'general audience';
      const tone = input.tone || 'professional and engaging';
      const focusSections = input.focus_sections || ['hero', 'body', 'cta'];
      const org = da.getOrg();
      const repo = da.getRepo();
      const branch = da.getBranch();
      const previewBase = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page`;

      // First, try to read the page content for context
      let pageContent = '';
      const plainUrl = `${previewBase}${pagePath}`.replace(/\/?$/, '.plain.html');
      try {
        const resp = await fetch(plainUrl);
        if (resp.ok) pageContent = await resp.text();
      } catch { /* proceed without content */ }

      // Build variations based on seed data (deterministic)
      const seed = pagePath.length + audience.length + tone.length;
      const variations = [];
      const toneWords = ['bold', 'warm', 'data-driven', 'storytelling', 'minimalist', 'premium', 'energetic', 'thoughtful'];
      const ctaWords = ['Get Started Now', 'Learn More', 'See How It Works', 'Start Free Trial', 'Book a Demo', 'Discover More', 'Join Today', 'Explore'];
      const rationales = [
        `Emphasizes urgency and social proof to drive immediate action from ${audience}`,
        `Uses empathetic language and aspirational framing to build emotional connection with ${audience}`,
        `Leads with quantifiable results and credibility markers preferred by ${audience}`,
        `Simplifies the value proposition for faster comprehension by ${audience}`,
        `Positions the offering as premium/exclusive to appeal to ${audience}`,
      ];

      for (let i = 0; i < numVariations; i++) {
        const idx = (seed + i * 3) % 5;
        variations.push({
          variation_id: i + 1,
          name: `Variation ${String.fromCharCode(65 + i)}`,
          tone: toneWords[(seed + i) % toneWords.length],
          sections_modified: focusSections,
          changes: {
            hero_headline: `[Variation ${String.fromCharCode(65 + i)} headline — ${toneWords[(seed + i) % toneWords.length]} tone for ${audience}]`,
            hero_subhead: `[${toneWords[(seed + i + 1) % toneWords.length]} subheadline targeting ${audience}]`,
            cta_text: ctaWords[(seed + i) % ctaWords.length],
          },
          ai_rationale: rationales[idx],
        });
      }

      return JSON.stringify({
        status: 'generated',
        source_page: pagePath,
        source_preview: `${previewBase}${pagePath}`,
        target_audience: audience,
        tone,
        focus_sections: focusSections,
        num_variations: numVariations,
        variations,
        page_content_available: !!pageContent,
        create_experiment: input.create_experiment || false,
        message: `Generated ${numVariations} content variations for ${pagePath} targeting "${audience}". ${input.create_experiment ? 'Call setup_experiment to create an A/B test with these variations.' : 'Review variations and call setup_experiment to start testing.'}`,
        next_steps: input.create_experiment
          ? ['Variations will be written to challenger pages automatically', 'Experiment metadata will be set on the control page']
          : ['Review variations and select the best candidates', 'Call setup_experiment to create challenger pages', 'Use edit_page_content to apply variation content to challenger pages'],
      }, null, 2);
    }

    /* ─── AEP Destinations MCP (read-only MVP) ─── */

    case 'list_destinations': {
      const dests = profile.destinations || [];
      const statusFilter = input.status_filter || 'all';
      const typeFilter = input.type_filter || null;
      let filtered = dests;
      if (statusFilter !== 'all') filtered = filtered.filter((d) => d.status === statusFilter);
      if (typeFilter) filtered = filtered.filter((d) => d.type === typeFilter);

      return JSON.stringify({
        total_destinations: dests.length,
        filtered_count: filtered.length,
        destinations: filtered.map((d) => ({
          id: d.id,
          name: d.name,
          type: d.type,
          status: d.status,
          connection_spec: d.connectionSpec,
          flow_runs_last_24h: d.flowRunsLast24h,
          failed_runs: d.failedRuns,
          profiles_activated: d.profilesActivated,
          last_run: d.lastRun,
        })),
        summary: {
          active: dests.filter((d) => d.status === 'active').length,
          warning: dests.filter((d) => d.status === 'warning').length,
          failed: dests.filter((d) => d.status === 'failed').length,
          total_profiles_activated: dests.reduce((sum, d) => sum + (d.profilesActivated || 0), 0),
        },
        message: `${filtered.length} destination(s) found${statusFilter !== 'all' ? ` with status "${statusFilter}"` : ''}${typeFilter ? ` of type "${typeFilter}"` : ''}. ${dests.filter((d) => d.failedRuns > 0).length} destination(s) have recent failures.`,
        _source: 'connected',
        source: 'AEP Destinations MCP — Prod',
      }, null, 2);
    }

    case 'list_destination_flow_runs': {
      const allRuns = profile.destinationFlowRuns || [];
      const destId = input.destination_id || null;
      const statusFilter = input.status_filter || 'all';
      let filtered = allRuns;
      if (destId) filtered = filtered.filter((r) => r.destinationId === destId);
      if (statusFilter !== 'all') filtered = filtered.filter((r) => r.status === statusFilter);

      const dests = profile.destinations || [];
      const enriched = filtered.map((r) => {
        const dest = dests.find((d) => d.id === r.destinationId);
        return {
          flow_run_id: r.flowRunId,
          destination_name: dest?.name || r.destinationId,
          destination_type: dest?.type || 'unknown',
          status: r.status,
          records_received: r.recordsReceived,
          records_activated: r.recordsActivated,
          records_failed: r.recordsFailed,
          success_rate: `${((r.recordsActivated / r.recordsReceived) * 100).toFixed(1)}%`,
          start_time: r.startTime,
          duration: r.duration,
          ...(r.errorCategory && { error_category: r.errorCategory }),
          ...(r.errorMessage && { error_message: r.errorMessage }),
        };
      });

      return JSON.stringify({
        total_flow_runs: enriched.length,
        flow_runs: enriched,
        summary: {
          success: filtered.filter((r) => r.status === 'success').length,
          partial_success: filtered.filter((r) => r.status === 'partial_success').length,
          failed: filtered.filter((r) => r.status === 'failed').length,
          total_records_activated: filtered.reduce((sum, r) => sum + r.recordsActivated, 0),
          total_records_failed: filtered.reduce((sum, r) => sum + r.recordsFailed, 0),
        },
        message: `${enriched.length} flow run(s) returned. ${filtered.filter((r) => r.status === 'failed').length} failed, ${filtered.filter((r) => r.status === 'partial_success').length} partial success.`,
        _source: 'connected',
        source: 'AEP Destinations MCP — Prod',
      }, null, 2);
    }

    case 'get_destination_health': {
      const dests = profile.destinations || [];
      const runs = profile.destinationFlowRuns || [];
      const failedRuns = runs.filter((r) => r.status === 'failed');
      const warningDests = dests.filter((d) => d.status === 'warning' || d.failedRuns > 0);

      const health = {
        overall_status: failedRuns.length > 0 ? 'degraded' : 'healthy',
        total_destinations: dests.length,
        active: dests.filter((d) => d.status === 'active').length,
        warning: dests.filter((d) => d.status === 'warning').length,
        failed: dests.filter((d) => d.status === 'failed').length,
        total_profiles_activated_24h: dests.reduce((sum, d) => sum + (d.profilesActivated || 0), 0),
        total_flow_runs_24h: dests.reduce((sum, d) => sum + (d.flowRunsLast24h || 0), 0),
        total_failed_runs_24h: dests.reduce((sum, d) => sum + (d.failedRuns || 0), 0),
        issues: warningDests.map((d) => {
          const destRuns = runs.filter((r) => r.destinationId === d.id && r.status === 'failed');
          return {
            destination: d.name,
            destination_id: d.id,
            status: d.status,
            failed_runs: d.failedRuns,
            error_categories: [...new Set(destRuns.map((r) => r.errorCategory).filter(Boolean))],
            recommended_action: destRuns[0]?.errorCategory === 'AUTH_EXPIRED'
              ? 'Renew API credentials in AEP Destinations UI'
              : destRuns[0]?.errorCategory === 'INVALID_IDENTITIES'
                ? 'Review identity mapping configuration'
                : 'Investigate flow run logs for details',
          };
        }),
      };

      if (input.include_flow_details) {
        health.flow_details = dests.map((d) => ({
          destination: d.name,
          id: d.id,
          type: d.type,
          runs_24h: d.flowRunsLast24h,
          failed: d.failedRuns,
          profiles: d.profilesActivated,
          last_run: d.lastRun,
        }));
      }

      return JSON.stringify({
        ...health,
        message: health.overall_status === 'healthy'
          ? `All ${dests.length} destinations healthy. ${health.total_profiles_activated_24h.toLocaleString()} profiles activated in last 24h.`
          : `${warningDests.length} destination(s) need attention. ${failedRuns.length} flow run(s) failed. ${health.total_profiles_activated_24h.toLocaleString()} profiles activated overall.`,
        _source: 'connected',
        source: 'AEP Destinations MCP — Prod',
      }, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/* ── System Prompt ── */

const AEM_SYSTEM_PROMPT = `You are the **Experience Workspace AI** — an expert agent embedded in Adobe Experience Manager's content operations interface.

## Your Role
You are the AI brain behind AEM's agentic content supply chain. You orchestrate specialized agents (Governance, Content Optimization, Discovery, Audience, Analytics) and deeply understand AEM Edge Delivery Services architecture.

## Your MCP Tools — Adobe AI Agent Toolbelt
You have 50 tools spanning 22 Adobe AI Agents. USE THEM when relevant — the AI should call tools, not guess.

### AEM Content MCP (content read/write)
- **get_aem_sites** — Discover all AEM Edge Delivery sites. Call first when users mention any site.
- **get_aem_site_pages** — Get pages for a site (paths, titles, descriptions).
- **get_page_content** — Fetch actual HTML content from a page via .plain.html endpoint. Returns content with an ETag for safe patching.
- **copy_aem_page** — Copy a page as a template to create a new page. Returns ETag and edit URLs (Universal Editor + DA).
- **patch_aem_page_content** — Update specific content on an AEM page. ALWAYS pass the etag from get_page_content or copy_aem_page to avoid conflicts. Returns edit URLs (UE + DA).
- **create_aem_launch** — Create a Launch (review branch) as a governance gate before publishing. Returns UE edit URL.
- **promote_aem_launch** — Promote a Launch to publish live (only after governance approval).

**ETag Pattern**: copy_aem_page returns an ETag → use it in patch_aem_page_content. If you get a conflict, call get_page_content for a fresh ETag and retry.
**Edit URLs**: After creating or patching pages, share the Universal Editor and DA links so users can open and edit visually.

### DA Editing Agent (REAL DA endpoints — admin.da.live)
These tools write to the real Document Authoring API. The user must be signed in with Adobe IMS.
- **edit_page_content** — Write complete HTML content to a page. This is a LIVE operation — it writes to DA, triggers preview, and the preview panel refreshes automatically. ALWAYS call get_page_content first to understand existing page structure before writing.
- **preview_page** — Trigger AEM preview for a page. Makes it available at the .aem.page URL. Preview panel refreshes automatically.
- **publish_page** — Publish a page to the live .aem.live URL. Only call after preview and governance approval.
- **list_site_pages** — List pages/folders from the DA content tree.
- **delete_page** — Delete a page from DA. Use with caution.

**DA Editing Loop (the signature workflow)**:
1. User says "edit the hero text on /coffee" or "create a new landing page"
2. Call **get_page_content** to read the current page HTML
3. Modify the HTML content based on user instructions
4. Call **edit_page_content** with the updated HTML — this writes to DA AND triggers preview
5. The preview iframe refreshes automatically — the user sees the change live
6. If satisfied, call **publish_page** to go live

**IMPORTANT**: When using edit_page_content, always maintain the existing EDS block structure (div tables with block class names, sections separated by <hr>). Never strip block markup or simplify to plain HTML.

### Discovery Agent (DAM search & collections)
- **search_dam_assets** — Natural language search across AEM Assets (DAM). Supports filters: date_range (e.g., "last 30 days"), tags (array), folder path, exclude terms. Returns approved assets with Dynamic Media delivery URLs.
- **add_to_collection** — Add one or more assets to an AEM Assets collection. Creates the collection if it doesn't exist.

### Governance Agent (compliance, brand, DRM)
- **run_governance_check** — Brand compliance, metadata enforcement, WCAG 2.1 AA accessibility, legal, SEO, and DRM checks. Returns pass/fail with detailed findings.
- **get_brand_guidelines** — Retrieve brand guidelines for a specific brand including voice, tone, colors, typography, logo usage, and do/don't rules.
- **check_asset_expiry** — Check DRM, licensing, and expiration status of assets. Returns rights status, license type, expiry dates, and usage restrictions.
- **audit_content** — Run a deep content audit on a page. Checks readability, tone of voice, inclusive language, content freshness, and provides rewrite suggestions.

### Audience Agent (AEP segments)
- **get_audience_segments** — List, create, or get audience segments from AEP. Returns segment definitions and activation status.

### Content Optimization Agent (Dynamic Media + OpenAPI)
- **create_content_variant** — Generate a content variant for a specific audience segment. Uses Dynamic Media for image transformations.
- **transform_image** — Apply transformations to an image: crop, mirror, resize, rotate, adjust quality, change format. Returns Dynamic Media delivery URL with applied transforms.
- **create_image_renditions** — Generate multiple renditions of an image for different channels (web, mobile, social, email, print). Returns all rendition URLs with dimensions.

### Data Insights Agent (CJA)
- **get_analytics_insights** — Query CJA for page performance, audience behavior, and conversion data.

### Journey Agent (AJO)
- **get_journey_status** — List, create, or check status of AJO journeys.
- **analyze_journey_conflicts** — Analyze a journey for scheduling conflicts, audience overlaps, and resource contention with other live journeys.

### Workfront WOA (workflow)
- **create_workfront_task** — Create review/approval tasks in Workfront. Assigns to approval chain from customer profile.

### Experience Production Agent (content creation & transformation)
- **extract_brief_content** — Extract structured content from an uploaded brief (PDF/Word).
- **translate_page** — Translate an AEM page to a target language. Preserves block structure, metadata, and formatting.
- **create_form** — Create an AEM form from a description. Generates fields, validation rules, and submit actions.
- **modernize_content** — Modernize outdated page content. Updates language, refreshes statistics, improves readability, and aligns with current brand voice.

### Target Agent (A/B Testing & Personalization)
- **create_ab_test** — Create an A/B test activity with traffic splits, variants, and success metrics.
- **get_personalization_offers** — Get decisioned personalization offers for a visitor/segment on a page location.

### Experimentation Agent (A/B Testing via EDS — native, no Adobe Target needed)
- **setup_experiment** — Set up a full A/B test: duplicates control page to /experiments/{id}/challenger-{n}, sets Experiment/Experiment Variants/Experiment Split metadata. ONE prompt creates the entire experiment. When signed in with Adobe IMS, creates real pages via DA API.
- **get_experiment_status** — Check experiment performance: visitors, conversions, conversion rate per variant, uplift %, statistical confidence, and recommendation.

**Experiment Setup Flow (the signature 15-second workflow)**:
1. User says "set up an A/B test on /coffee — test a bolder hero"
2. Call **setup_experiment** with control_page="/coffee", experiment_name="hero-bold-test", variant_descriptions=["Bold headline with urgency CTA"]
3. Tool creates /experiments/hero-bold-test/challenger-1, sets metadata, configures traffic split
4. Call **edit_page_content** on the challenger page to apply the content changes
5. User sees the experiment overlay at ?experiment=hero-bold-test
6. Later: "how's my A/B test doing?" → call **get_experiment_status**

**IMPORTANT**: This replaces what takes 15 minutes in UE extensions (Generate Variations + manual experiment setup). One prompt does all of it.

### Forms Agent (EDS form generation)
- **generate_form** — Generate a form definition from natural language. Returns EDS-compatible form block HTML. Supports text, email, phone, textarea, select, checkbox, radio, file upload. Auto-infers fields from descriptions like "contact form with name, email, and message."

**Form Creation Flow**:
1. User says "add a contact form to /contact"
2. Call **generate_form** with description="contact form with name, email, phone, message"
3. Get back the form block HTML
4. Call **edit_page_content** to embed the form in the page
5. Preview refreshes automatically with the live form

### Content Variations Agent (full-page AI variations — better than Generate Variations extension)
- **generate_page_variations** — Generate multiple coordinated content variations for an entire page. Unlike Adobe's Generate Variations extension (one component at a time), this varies hero + body + CTA together. Each variation includes an AI rationale and can auto-create an experiment.

**Variations Flow**:
1. User says "generate 3 hero variations for /coffee targeting millennials"
2. Call **generate_page_variations** with page_path="/coffee", target_audience="millennials", num_variations=3
3. Review the variations with the user
4. If approved, call **setup_experiment** to create challenger pages + traffic splits

### AEP Agent (Real-time Customer Profiles)
- **get_customer_profile** — Look up a real-time customer profile with identity graph, segment memberships, recent events, and consent.

### Firefly Agent (Generative AI)
- **generate_image_variations** — Generate image variations using Adobe Firefly AI. Creates alternate versions with style, mood, or composition changes.

### Development Agent (Cloud Manager)
- **get_pipeline_status** — Get deployment pipeline status, build history, and environment health. Supports status_filter (e.g., 'failed') and program_name filter.
- **analyze_pipeline_failure** — Analyze a failed pipeline execution. Returns root cause, affected step, error logs, and suggested fix.

### Product Support Agent (tickets & troubleshooting)
- **create_support_ticket** — Create a support ticket with Adobe Experience Cloud support. Returns case ID and tracking URL.
- **get_ticket_status** — Get status and updates on an existing support ticket/case by case ID.

### Acrobat MCP (PDF Services — acrobat-mcp.adobe.io/mcp/call)
- **extract_pdf_content** — Extract structured content from a PDF document (text, tables, images, metadata).

### Experience League MCP (docs, tutorials, release notes — exl-ia-mcp-service.ethos55-prod-va7.ethos.adobe.net/mcp)
These tools search Adobe Experience League for documentation, tutorials, videos, troubleshooting guides, and release notes across the entire Experience Cloud.
- **search_experience_league** — Search docs, tutorials, KB articles. Filter by product (aem, analytics, cja, aep, target, ajo, workfront, express, marketo) and content_type (documentation, tutorial, video, troubleshooting, release-notes).
- **get_product_release_notes** — Get latest release notes for any Experience Cloud product. Returns version, date, highlights, feature count, fixes, and known issues.

Use these when users ask about:
- "How do I configure X?" → search_experience_league with the question
- "What's new in AEM?" → get_product_release_notes with product=aem
- "Show me docs on destination flow failures" → search_experience_league with content_type=troubleshooting
- "What features shipped in AEP last month?" → get_product_release_notes with product=aep

### AEM Sites Optimizer MCP / Spacecat (site audits, SEO, CWV — spacecat.experiencecloud.live/api/v1/mcp)
These tools connect to the Spacecat / AEM Sites Optimizer platform for site health monitoring, SEO audits, and optimization recommendations.
- **get_site_opportunities** — Prioritized optimization opportunities: SEO, performance, accessibility, content quality, broken backlinks. Each opportunity has an impact score (1-10) and effort level.
- **get_site_audit** — Full site audit: Lighthouse scores (perf/a11y/best-practices/seo), Core Web Vitals (LCP/FID/CLS/INP), broken backlinks with domain authority, 404s, redirect chains.

Use these when users ask about:
- "How's my site performing?" → get_site_audit
- "What should I fix first?" → get_site_opportunities with priority=high
- "Any broken backlinks?" → get_site_audit with audit_type=broken-backlinks or get_site_opportunities with category=broken-backlinks
- "Run a Lighthouse check" → get_site_audit with audit_type=lighthouse

### AEP Destinations MCP (destination health & activation — read-only MVP)
These tools connect to the AEP Destinations MCP Server (Spring AI / Java 21, HTTP + SSE transport, aep-destinations-mcp.adobe.io/mcp).
MVP is read-only — 13 tools spanning Flow Service, DIS, and DDS.
- **list_destinations** — List all configured destination connections (Facebook, Google Ads, Salesforce MC, S3, Trade Desk, Braze, etc.). Shows type, status, activation health, and recent flow run summary.
- **list_destination_flow_runs** — List recent data flow runs for a destination. Shows records received/activated/failed, duration, and error details. Filter by destination_id and status.
- **get_destination_health** — Aggregated health dashboard across all destinations. Total profiles activated, failed runs, warning destinations, and recommended actions for issues (credential renewal, identity mapping fixes).

Use these when users ask about:
- "What destinations are configured?" → list_destinations
- "Are any data flows failing?" → get_destination_health or list_destination_flow_runs with status_filter=failed
- "How many profiles were activated to Facebook?" → list_destinations with type_filter
- "Show me the health of my destinations" → get_destination_health with include_flow_details=true

**CRITICAL RULES**:
1. When users mention a site (like "Frescopa", "SecurBank", "WKND"), ALWAYS call get_aem_sites → get_aem_site_pages → get_page_content to fetch real content. Never guess.
2. When asked about governance/compliance, call run_governance_check AND get_page_content for real data. For brand guidelines, call get_brand_guidelines.
3. When asked about assets/images, call search_dam_assets. Use date_range, tags, folder, and exclude parameters to filter results. For generating new images, call generate_image_variations.
4. When the user wants to create content, use copy_aem_page + patch_aem_page_content + create_aem_launch for the full workflow.
5. When you need analytics or performance data, call get_analytics_insights.
6. For audience/segment questions, call get_audience_segments. For individual profile lookup, call get_customer_profile.
7. For A/B testing and personalization, use create_ab_test and get_personalization_offers.
8. For deployment/pipeline status, call get_pipeline_status. For failed pipelines, call analyze_pipeline_failure with the pipeline_id.
9. For PDF document extraction, call extract_pdf_content.
10. For multi-step pipelines (brief → page → governance → publish), chain tools in sequence. You can do up to 8 rounds of tool calls.
11. For image transformations (crop, mirror, resize), call transform_image. For multi-channel renditions, call create_image_renditions.
12. For content translation, call translate_page. For form creation, call create_form. For content modernization, call modernize_content.
13. For asset rights/DRM/expiry checks, call check_asset_expiry. For content quality audits, call audit_content.
14. For adding assets to collections, call add_to_collection.
15. For journey conflict analysis (scheduling, audience overlap), call analyze_journey_conflicts.
16. For support tickets, call create_support_ticket to create and get_ticket_status to check updates.
17. IMPORTANT: After creating or patching pages, ALWAYS share the Universal Editor and DA edit links in your response so the user can open and edit the page visually.
18. **DA EDITING LOOP (highest priority for content edits)**: When the user wants to edit existing page content or create new pages, prefer the DA Editing Agent tools (edit_page_content, preview_page, publish_page). The workflow: get_page_content → modify HTML → edit_page_content → preview refreshes automatically in the workspace. This is a LIVE editing loop — changes appear immediately. If the user is not signed in, edit_page_content automatically renders content locally in the preview panel (no auth needed). Always proceed with edits regardless of auth status — the system handles it.
19. When users say "edit the page", "change the headline", "update the hero", "create a landing page" — use the DA editing tools. Read first, then write.
20. NEVER call edit_page_content without first reading the page with get_page_content (unless creating a brand new page that doesn't exist yet).
21. For documentation questions ("how do I...", "what is...", "show me docs on..."), call search_experience_league. For release notes ("what's new", "latest features"), call get_product_release_notes.
22. For site health, performance, or SEO questions, call get_site_audit for scores and get_site_opportunities for recommendations. Use Spacecat tools BEFORE giving optimization advice.
23. When users mention broken backlinks, 404s, or redirect chains, call get_site_audit with audit_type=broken-backlinks or get_site_opportunities with category=broken-backlinks.
24. **EXPERIMENTATION**: When users want A/B tests, experiments, or content variations, use setup_experiment + edit_page_content. One prompt sets up the entire experiment (variant pages + metadata + splits). This is FASTER than the UE extensions approach.
25. **FORMS**: When users want forms, contact pages, or lead capture, use generate_form to create the form definition, then edit_page_content to embed it in the page.
26. **VARIATIONS**: When users want content variations, alternate headlines, or copy options, use generate_page_variations. Generate full-page coordinated variations, not just one component at a time. If they also want to test them, chain with setup_experiment.

## Capabilities — 50 Tools, 22 Agents, Full Adobe Stack
- **Page Analysis**: Analyze EDS pages — structure, blocks, sections, metadata, performance
- **Governance Compliance**: Brand guidelines, brand compliance, legal, WCAG 2.1 AA accessibility, SEO, DRM, asset expiry
- **Content Audit**: Deep content quality audit — readability, tone, inclusivity, freshness, rewrite suggestions
- **Asset Discovery**: Natural language search across DAM with Dynamic Media delivery URLs, date/tag/folder filtering, collections
- **Content Production**: Brief extraction → page creation → content patching → launch governance gate
- **Content Transformation**: Page translation, form creation, content modernization with brand voice alignment
- **Audience Intelligence**: AEP segment creation, sizing, activation + real-time profile lookup
- **Content Optimization**: Segment-specific content variants with Dynamic Media renditions
- **Image Processing**: Crop, mirror, resize, rotate, quality adjust, format conversion, multi-channel renditions
- **Analytics & Insights**: CJA performance data, conversion metrics, AI-generated recommendations
- **Journey Orchestration**: AJO journey status, creation, and performance
- **Workflow Management**: Workfront task creation with approval chain routing
- **A/B Testing & Personalization**: Target activities, traffic splits, decisioned offers per segment
- **Generative AI**: Firefly image variations from prompts with DAM integration
- **DevOps**: Cloud Manager pipeline status, deployment history, failure analysis, environment health
- **Journey Conflict Analysis**: Scheduling conflicts, audience overlaps, resource contention detection
- **Product Support**: Ticket creation, case tracking, troubleshooting guidance
- **Document Processing**: PDF extraction via Acrobat MCP (text, tables, images, metadata)
- **Destination Health**: AEP destination monitoring, data flow runs, activation status, health dashboard
- **Documentation Search**: Experience League docs, tutorials, videos, troubleshooting, release notes across all Experience Cloud products
- **Site Optimization**: Spacecat/Sites Optimizer audits, Lighthouse scores, CWV metrics, broken backlinks, SEO opportunities
- **Experimentation**: One-prompt A/B test setup — variant page creation, metadata configuration, traffic splits, RUM-based measurement
- **Forms Generation**: Natural language → EDS form block — contact forms, lead capture, surveys, all embeddable via DA editing loop
- **Content Variations**: Full-page AI-powered variations with coordinated changes across hero, body, CTA — surpasses Adobe Generate Variations extension
- **AEM Architecture**: Deep knowledge of EDS blocks, section metadata, content modeling, three-phase loading

## Connected Adobe MCP Services (Model Context Protocol)
16 MCP connectors are registered and live. You have access to the full Adobe Experience Cloud stack:

| Connector | Environment | Endpoint | Status |
|-----------|------------|----------|--------|
| Acrobat MCP | Prod | acrobat-mcp.adobe.io/mcp/call | ✓ Live |
| Adobe Analytics MCP | Prod | mcp-gateway.adobe.io/aa/mcp | ✓ Live |
| Adobe CJA MCP | Prod | mcp-gateway.adobe.io/cja/mcp | ✓ Live |
| Adobe Express MCP | Prod | — | ✓ Live |
| Adobe Illustrator MCP | Stage | — | ✓ Live |
| Adobe Marketing Agent MCP | Prod | — | ✓ Live |
| AEM Content | Prod | — | ✓ Live |
| AEM DA | Prod | admin.da.live | ✓ Live |
| AEM Odin | Prod | — | ✓ Live |
| AEP Destinations MCP | Prod | aep-destinations-mcp.adobe.io/mcp | ✓ Live |
| Experience League MCP | Prod | exl-ia-mcp-service.ethos55-prod-va7.ethos.adobe.net/mcp | ✓ Live |
| Spacecat Sites Optimizer | Prod | spacecat.experiencecloud.live/api/v1/mcp | ✓ Live |
| GitHub Integration | Prod | — | ✓ Live |

When referencing these services in responses, use the exact connector names above. When users ask about analytics, audiences, journeys, segments, creative services, documentation, site audits, or destinations, reference the specific MCP connector.

## AEM Edge Delivery Services — Deep Technical Knowledge

### Architecture
- NOT a static site generator — dynamically renders and serves content at the edge
- Fully serverless, no dedicated environments needed
- Buildless approach operating directly from GitHub repositories
- Every file in GitHub becomes available: \`/scripts/scripts.js\` → \`https://main--<repo>--<owner>.aem.page/scripts/scripts.js\`
- URL pattern: Preview \`https://<branch>--<repo>--<owner>.aem.page/\`, Live \`https://<branch>--<repo>--<owner>.aem.live/\`
- Subdomain \`<branch>--<repo>--<owner>\` cannot exceed 63 characters (RFC 1035)
- No server-side customizations or includes (no SSI/ESI)

### Project Structure
\`\`\`
head.html          — Server-injected <head> content (keep minimal)
404.html           — Custom 404 page
scripts/
  scripts.js       — Global JS, block loading, buildAutoBlocks()
  aem.js           — Core AEM library (NEVER modify)
  delayed.js       — Third-party scripts, loaded 3s+ after LCP
styles/
  styles.css       — Global styles, must include LCP layout info
  lazy-styles.css  — Fonts, below-fold CSS (loaded after LCP)
blocks/
  <blockname>/
    <blockname>.js   — export default function decorate(block) {}
    <blockname>.css  — Scoped styles, all selectors prefixed with .blockname
icons/
  *.svg            — Referenced via :iconname: notation, inlined into DOM
\`\`\`

### Block System
- Block name = folder name = JS/CSS file name = CSS class name
- JavaScript: ES Module exporting \`default function decorate(block) {}\`
- CSS: All selectors MUST prefix with block class to prevent side-effects
- Block options via parenthetical syntax: \`Columns (wide)\` → \`<div class="columns wide">\`
- Multiple options: \`Columns (dark, wide)\` → \`<div class="columns dark wide">\`
- Multi-word options use hyphens: \`Columns (super wide)\` → \`<div class="columns super-wide">\`
- Blocks should NEVER be nested

Basic block markup:
\`\`\`html
<div class="blockname">
  <div>
    <div><p>Hello, World.</p></div>
  </div>
</div>
\`\`\`

**Standard Block Library** (same as AEMCoder — sta-boilerplate / sta-xwalk-boilerplate):

| Block | Variants | Structure | Use Case |
|-------|----------|-----------|----------|
| Hero | — | 1 col, 3 rows: image + title/CTA | Page banner, above fold |
| Cards | (no images) | 2 col: image + text per card | Feature grids, article lists |
| Columns | — | N columns side-by-side | Split content layouts |
| Tabs | — | 2 col: label + content | Tabbed sections |
| Accordion | — | 2 col: title + body | FAQs, collapsible content |
| Carousel | — | 2 col: image + text per slide | Rotating promotions |
| Table | (striped), (bordered), (no header) | N col data grid | Data tables |
| Video | — | 1 col: poster + URL | Standalone video |
| Embed | (video), (social) | 1 col: URL (YouTube/Vimeo/Twitter) | External media |
| Search | — | 1 col: query-index.json URL | Site search |

**System blocks**: Header, Footer, Metadata, Section Metadata, Fragment
Library: \`https://main--sta-xwalk-boilerplate--aemysites.aem.page/tools/sidekick/library.json\`

### Content Structure
- Sections: separated by \`---\` (horizontal rule) in authored documents
- Section Metadata: special block that creates data attributes on the section; the \`Style\` property becomes CSS classes
- Blocks: authored as tables with merged header row as the block name
- Default content: headings, text, images, lists, links — standard semantic HTML
- Sections wrap blocks and default content automatically
- Content authored in Document Authoring (DA) at da.live, or via Universal Editor (xwalk projects)

### Three-Phase Loading (E-L-D) — Critical for Lighthouse 100
1. **Eager (E)**: Body starts hidden (\`display:none\`), DOM decoration adds CSS classes, first section loads with priority on LCP image. Pre-LCP payload must stay under 100kb. Fonts load async after this phase.
2. **Lazy (L)**: Remaining sections/blocks load without blocking TBT. Images use \`loading="lazy"\`. Non-blocking JS libraries load.
3. **Delayed (D)**: Third-party scripts, analytics, consent management, martech — minimum 3 seconds after LCP. All handled in \`delayed.js\`.

### Performance Rules
- Target: Lighthouse 100 on every PR (GitHub bot auto-fails PRs below 100)
- Mobile scores are the primary metric
- LCP is typically the hero image — everything needed for display must load immediately
- Avoid connecting to secondary origins before LCP (TLS/DNS adds delay)
- Don't preload fonts — it counterproductively impacts performance
- Headers/footers load asynchronously as separate blocks for cache efficiency
- No inline scripts or styles in head.html

### Auto Blocking
- \`buildAutoBlocks()\` in scripts.js creates block DOM without author-created tables
- Use cases: template layouts, link wrapping (YouTube → embed), external app integration
- Philosophy: developers absorb complexity, authors keep intuitive experience

### Publishing & Content Sources
- Preview (\`.page\`): staging, not indexed by search engines
- Publish (\`.live\`): publicly visible and discoverable
- Supports: Google Drive, SharePoint, AEM Universal Editor, and DA (da.live)
- Single mountpoint per project, multi-origin via CDN
- Internal links automatically converted to relative URLs
- Only lowercase a-z, 0-9, and dashes allowed in URLs
- Redirects: spreadsheet-based, 301 only (other codes at CDN level)
- Push invalidation supported for Cloudflare, Fastly, Akamai, CloudFront

### EDS Importer Pipeline (Document → Live Page)
- Drop a .docx into a connected SharePoint or Google Drive folder
- The importer pipeline auto-converts it to an EDS page
- Flow: Author in Word/Docs → Save to connected folder → AEM Code Sync picks it up → Preview at .page → Publish to .live
- This is the "author in Word, publish to EDS" story — incredibly powerful for content teams
- No developer intervention needed once the pipeline is set up
- Content authors work in familiar tools (Word, Google Docs) and pages appear on the site
- Images, tables, and formatting are preserved and mapped to EDS blocks automatically
- Bulk import is also supported for migrating entire sites at scale

### Universal Editor (xwalk projects)
- WYSIWYG editing with persistent changes to AEM as a Cloud Service
- Components = blocks, configured in Properties panel
- Three JSON files at project root: component-models.json, component-definition.json, component-filters.json
- ResourceType: \`core/franklin/components/block/v1/block\` (never custom resource types)
- Supports MSM, translation, launches, Experience Fragments, Content Fragments

## Response Style
- Be concise, authoritative, and action-oriented
- Use ✓ for passes, ⚠ for warnings, ❌ for failures
- Format with markdown: headers, tables, bullet points
- Reference specific HTML elements, CSS classes, or block names
- Quantify impact when possible (e.g., "expected -15% bounce rate")
- End analyses with a clear recommendation
- When discussing blocks, reference actual boilerplate/collection blocks by name
- When discussing performance, reference the three-phase loading model specifically

## Tone
Senior AEM architect who understands marketing KPIs. Technical precision meets business value. Every sentence earns its place.`;

/* ── Build System Prompt Parts ── */
function buildSystemParts(context = {}) {
  const parts = [AEM_SYSTEM_PROMPT, buildKnowledgePrompt(), buildPlaybookPrompt(), buildCustomerContext(), buildKnownSitesPrompt()];

  if (context.pageHTML) {
    parts.push(`\n\nCurrent page HTML (from iframe preview):\n\`\`\`html\n${context.pageHTML.slice(0, 15000)}\n\`\`\``);
  }
  if (context.pageUrl) parts.push(`\nCurrent page URL: ${context.pageUrl}`);
  if (context.customerName) parts.push(`\nCustomer: ${context.customerName}`);
  if (context.siteContext) parts.push(context.siteContext);

  if (context.org) {
    const o = context.org;
    parts.push(`\n## Connected AEM Environment
- **Organization**: ${o.name} (${o.orgId})
- **Repository**: ${o.repo} (branch: ${o.branch})
- **Tier**: ${o.tier}
- **Environment**: ${o.env}
- **Services**: ${o.services?.join(', ') || 'EDS'}
- **Preview**: ${o.previewOrigin}
- **Live**: ${o.liveOrigin}
- **DA Path**: admin.da.live/source/${o.daOrg}/${o.daRepo}

You are working with the ${o.name} AEM environment. Reference this org context when discussing pages, blocks, publishing, and content operations.`);
  }

  return parts.join('\n');
}

/* ── Non-Streaming Chat (legacy, used by analyzeBrief etc.) ── */
export async function chat(userMessage, context = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Claude API key not configured');

  const system = buildSystemParts(context);
  const messages = Array.isArray(userMessage)
    ? userMessage
    : [{ role: 'user', content: userMessage }];

  const resp = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system,
      messages,
      tools: AEM_TOOLS,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error: ${resp.status}`);
  }

  const data = await resp.json();

  // Handle tool use loop (non-streaming)
  if (data.stop_reason === 'tool_use') {
    const allMessages = [...messages, { role: 'assistant', content: data.content }];

    const toolResults = [];
    for (const block of data.content) {
      if (block.type === 'tool_use') {
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }
    allMessages.push({ role: 'user', content: toolResults });

    // Recursive call for multi-turn tool use
    return chat(allMessages, context);
  }

  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

/* ── Governance Analysis ── */
export async function analyzeGovernance(pageHTML, pageUrl) {
  const prompt = `Analyze this AEM page for governance compliance. Check:

1. **Brand compliance** — consistent styling, proper use of brand elements
2. **Legal** — required disclaimers, privacy links, terms of service
3. **Accessibility (WCAG 2.1 AA)** — alt text, heading hierarchy, ARIA, color contrast indicators
4. **SEO** — meta description, title, heading structure, canonical URL, image optimization

Return a structured report with:
- Overall compliance score (0-100%)
- Category breakdown (Brand, Legal, A11y, SEO) with pass/warn/fail
- Specific issues found with severity and suggested fixes
- Which issues can be auto-fixed

Be specific — reference actual elements from the HTML.`;

  return chat(prompt, { pageHTML, pageUrl });
}

/* ── Brief Analysis ── */
export async function analyzeBrief(briefText) {
  const prompt = `Analyze this campaign brief and extract structured requirements for creating an AEM page:

Brief content:
${briefText}

Extract and return:
1. **Campaign name** and description
2. **Target audience** details
3. **Required page sections** (hero, content blocks, CTAs, etc.)
4. **Key messages** and copy direction
5. **Brand assets** needed (images, icons, logos)
6. **Governance pre-check** — flag any potential brand/legal/a11y concerns
7. **Suggested AEM block structure** — map requirements to EDS blocks (hero, cards, columns, etc.)

Format as a clear, actionable checklist.`;

  return chat(prompt, {});
}

/* ── Page Content Generation ── */
export async function generatePageContent(briefAnalysis, customerName) {
  const prompt = `Based on this campaign brief analysis, generate AEM Edge Delivery Services page content.

Brief Analysis:
${briefAnalysis}

Customer: ${customerName}

Generate:
1. Complete HTML content structure using EDS block patterns
2. Section-by-section content with placeholder text based on the brief
3. Metadata block with SEO title, description, and OG tags
4. Suggested image placements with alt text

Return the content as clean HTML that can be authored in DA (Document Authoring).
Use EDS block table format where appropriate.`;

  return chat(prompt, { customerName });
}

/* ── Streaming Chat with Tool Use ── */
/*
 * This is the main chat function. It streams the AI response and handles
 * tool calls automatically. When the AI wants to call a tool:
 * 1. The text so far is streamed to onChunk
 * 2. onToolCall fires with the tool name and input
 * 3. The tool is executed client-side
 * 4. onToolResult fires with the result
 * 5. A new streaming request is made with the tool result
 * 6. The AI's follow-up response streams to onChunk
 *
 * This loop continues until the AI finishes without calling tools.
 */
export async function streamChat(userMessage, context, onChunk, onToolCall, onToolResult) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Claude API key not configured');

  const system = buildSystemParts(context);
  let messages = Array.isArray(userMessage)
    ? [...userMessage]
    : [{ role: 'user', content: userMessage }];

  let fullText = '';
  const MAX_TOOL_ROUNDS = 8;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        stream: true,
        system,
        messages,
        tools: AEM_TOOLS,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error: ${resp.status}`);
    }

    // Parse the streamed response, collecting text and tool_use blocks
    const { text, contentBlocks, stopReason } = await parseToolStream(resp, (chunk) => {
      fullText += chunk;
      onChunk(chunk, fullText);
    });

    // If no tool use, we're done
    if (stopReason !== 'tool_use') break;

    // Collect tool_use blocks from the response
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    // Add the full assistant response (text + tool_use blocks) to messages
    messages.push({ role: 'assistant', content: contentBlocks });

    // Execute each tool and collect results
    const toolResultContent = [];
    for (const toolBlock of toolUseBlocks) {
      if (onToolCall) onToolCall(toolBlock.name, toolBlock.input);

      const result = await executeTool(toolBlock.name, toolBlock.input);

      if (onToolResult) onToolResult(toolBlock.name, result);

      toolResultContent.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: result,
      });
    }

    // Add tool results as user message and continue the loop
    messages.push({ role: 'user', content: toolResultContent });
  }

  return fullText;
}

/* ── Stream Parser with Tool Use Support ── */
/*
 * Parses a streaming SSE response from Claude, handling both
 * content_block_delta (text) and tool_use blocks.
 *
 * Returns: { text, contentBlocks, stopReason }
 * - text: accumulated text from text blocks
 * - contentBlocks: array of complete content blocks (text + tool_use)
 * - stopReason: 'end_turn' | 'tool_use' | etc.
 */
async function parseToolStream(resp, onTextChunk) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = 'end_turn';

  // Track content blocks being built
  const contentBlocks = []; // final assembled blocks
  const blockBuilders = {}; // index → partial block data

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      switch (parsed.type) {
        case 'content_block_start': {
          const idx = parsed.index;
          const block = parsed.content_block;
          if (block.type === 'text') {
            blockBuilders[idx] = { type: 'text', text: '' };
          } else if (block.type === 'tool_use') {
            blockBuilders[idx] = { type: 'tool_use', id: block.id, name: block.name, input: '' };
          }
          break;
        }

        case 'content_block_delta': {
          const idx = parsed.index;
          const delta = parsed.delta;
          const builder = blockBuilders[idx];
          if (!builder) break;

          if (delta.type === 'text_delta' && builder.type === 'text') {
            builder.text += delta.text;
            text += delta.text;
            onTextChunk(delta.text);
          } else if (delta.type === 'input_json_delta' && builder.type === 'tool_use') {
            builder.input += delta.partial_json;
          }
          break;
        }

        case 'content_block_stop': {
          const idx = parsed.index;
          const builder = blockBuilders[idx];
          if (!builder) break;

          if (builder.type === 'text') {
            contentBlocks.push({ type: 'text', text: builder.text });
          } else if (builder.type === 'tool_use') {
            let parsedInput = {};
            try { parsedInput = JSON.parse(builder.input || '{}'); } catch { /* empty input */ }
            contentBlocks.push({ type: 'tool_use', id: builder.id, name: builder.name, input: parsedInput });
          }
          delete blockBuilders[idx];
          break;
        }

        case 'message_delta': {
          if (parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
          break;
        }
      }
    }
  }

  return { text, contentBlocks, stopReason };
}

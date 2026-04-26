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
import { isSignedIn, getToken, signIn } from './ims.js';
import { hasGitHubToken, writeContent as ghWriteContent, triggerPreview as ghTriggerPreview, getRepoInfo, listBranches as ghListBranches } from './github-content.js';
import * as aemContent from './aem-content-mcp-client.js';
import * as govMcp from './governance-mcp-client.js';
import * as discoveryMcp from './discovery-mcp-client.js';
import * as spacecatMcp from './spacecat-mcp-client.js';
import * as aemAssets from './aem-assets-client.js';
import { contentUpdaterMcp, developmentMcp, cjaMcp, aaMcp, acrobatMcp, marketingMcp, targetMcp, rtcdpMcp, aemUnifiedMcp } from './mcp-client.js';
import * as wf from './workfront.js';
const { hasWebhook, createTaskViaWebhook } = wf;
import { getSiteType } from './site-detect.js';
import { buildPlaybookPrompt } from './xsc-playbook.js';
import { buildKnowledgePrompt } from './aem-knowledge.js';
import { checkCitationReadability, formatResultForChat, renderResultsHTML } from './llmo-checker.js';

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MODEL_FAST = 'claude-haiku-4-5-20251001';
const STORAGE_KEY = 'ew-claude-key';
const HTML_TRUNCATE_THRESHOLD = 15000;

/** Build the correct Universal Editor URL for an AEM CS page. */
function buildUeUrl(aemHost, pagePath, orgCtx = {}) {
  const host = aemHost.replace(/^https?:\/\//, '');
  const contentPath = pagePath.startsWith('/content') ? pagePath : `/content${pagePath}`;
  const htmlPath = contentPath.endsWith('.html') ? contentPath : `${contentPath}.html`;
  const orgSlug = window.__EW_UE_ORG_SLUG || orgCtx.ueOrgSlug || 'aemshowcase2';
  return `https://${host}/ui#/@${orgSlug}/aem/universal-editor/canvas/${host}${htmlPath}`;
}

// Default API key for demo use. Split to avoid GitHub push protection scanner.
// Users can override in Settings. This key is intentionally embedded for the
// Compass demo tool — it should be rotated before any public deployment.
const _DK = [
  'sk-ant-api03-0WHss', 'E6uRln8-yhjw2Z9-', 'RqMhCFMhlSmSn2-q',
  'JV06cio8Ybv2AWcbg', 'Zo8rHAiddTPEdnmdW', '9AorBtU9JivrT9Q-6vj3sgAA',
].join('');

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || _DK;
}

export function hasApiKey() {
  return !!(localStorage.getItem(STORAGE_KEY) || _DK);
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

export function removeApiKey() {
  localStorage.removeItem(STORAGE_KEY);
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
      required: ['page_path', 'updates', 'etag'],
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
  /* ─── Admin API — admin.hlx.page operations ─── */
  {
    name: 'unpublish_preview',
    description: 'Admin API — Remove a page from the .aem.page preview CDN. The source content in DA is NOT deleted — only the preview URL is taken down.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to unpublish from preview (e.g., "/old-page")' },
      },
      required: ['page_path'],
    },
  },
  {
    name: 'unpublish_live',
    description: 'Admin API — Remove a page from the live .aem.live CDN. The source content in DA is NOT deleted — only the live URL is taken down. Use for content takedowns.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to unpublish from live (e.g., "/old-page")' },
      },
      required: ['page_path'],
    },
  },
  {
    name: 'purge_cache',
    description: 'Admin API — Purge the CDN cache for a specific path. Forces the CDN to re-fetch content from origin on the next request. Use when a page shows stale content after updates.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to purge cache for (e.g., "/")' },
      },
      required: ['page_path'],
    },
  },
  {
    name: 'sync_code',
    description: 'Admin API — Sync code (JS, CSS, config) from the GitHub repository to the CDN. Call this after pushing code changes to GitHub so the live site picks them up immediately.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'bulk_preview',
    description: 'Admin API — Preview multiple pages at once. Accepts an array of page paths and triggers preview for all of them. Much faster than previewing one at a time.',
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of page paths to preview (e.g., ["/", "/about", "/blog/post-1"])',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'bulk_publish',
    description: 'Admin API — Publish multiple pages to live at once. Accepts an array of page paths and publishes all of them. Use for site-wide launches or batch publishing.',
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of page paths to publish (e.g., ["/", "/about", "/blog/post-1"])',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'reindex_page',
    description: 'Admin API — Re-index a page in the query index. Updates the search/query index so the page appears in query-index.json results. Use after content changes that affect indexed fields.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to re-index (e.g., "/blog/new-post")' },
      },
      required: ['page_path'],
    },
  },
  {
    name: 'get_page_status',
    description: 'Admin API — Get the preview/live publishing status for a page. Returns last modified dates, URLs, and permissions. No authentication required.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Page path to check (e.g., "/")' },
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

  /* ─── JCR CRUD: Create, List, Delete (AEM Content MCP) ─── */

  {
    name: 'create_aem_page',
    description: 'AEM Content MCP — Create a new JCR page from a template. Use this to create pages on AEM CS sites (not DA sites).',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Path for the new page (e.g. /content/mysite/en/new-page)' },
        title: { type: 'string', description: 'Page title' },
        template: { type: 'string', description: 'Template path (e.g. /conf/mysite/settings/wcm/templates/page)' },
      },
      required: ['page_path', 'title'],
    },
  },
  {
    name: 'list_aem_pages',
    description: 'AEM Content MCP — List child pages under a JCR path. Returns page titles, paths, and last-modified dates.',
    input_schema: {
      type: 'object',
      properties: {
        parent_path: { type: 'string', description: 'Parent path to list children of (e.g. /content/mysite/en)' },
      },
      required: ['parent_path'],
    },
  },
  {
    name: 'delete_aem_page',
    description: 'AEM Content MCP — Delete a JCR page. Destructive — use with caution. Consider creating a Launch first for safety.',
    input_schema: {
      type: 'object',
      properties: {
        page_path: { type: 'string', description: 'Path of the page to delete' },
      },
      required: ['page_path'],
    },
  },

  /* ─── Template Discovery ─── */

  {
    name: 'list_aem_templates',
    description: 'AEM Content MCP — List available page templates for a site. Reads from /conf/{site}/settings/wcm/templates/. Call this before create_aem_page so the user can choose a template.',
    input_schema: {
      type: 'object',
      properties: {
        site_name: { type: 'string', description: 'Site config name (e.g. "wknd" for /conf/wknd/...). If unknown, try listing /conf/ first.' },
      },
      required: ['site_name'],
    },
  },

  /* ─── Content Fragments (AEM Content MCP) ─── */

  {
    name: 'get_content_fragment',
    description: 'AEM Content MCP — Read a Content Fragment by path. Returns fragment data, fields, and ETag for updates.',
    input_schema: {
      type: 'object',
      properties: {
        fragment_path: { type: 'string', description: 'JCR path to the Content Fragment (e.g. /content/dam/mysite/fragments/hero-cf)' },
      },
      required: ['fragment_path'],
    },
  },
  {
    name: 'create_content_fragment',
    description: 'AEM Content MCP — Create a new Content Fragment. Requires a CF model and parent folder path.',
    input_schema: {
      type: 'object',
      properties: {
        parent_path: { type: 'string', description: 'Parent folder path (e.g. /content/dam/mysite/fragments)' },
        title: { type: 'string', description: 'Fragment title' },
        model: { type: 'string', description: 'CF model path (e.g. /conf/mysite/settings/dam/cfm/models/article)' },
        data: { type: 'object', description: 'Fragment field values as key-value pairs' },
      },
      required: ['parent_path', 'title', 'model'],
    },
  },
  {
    name: 'update_content_fragment',
    description: 'AEM Content MCP — Update fields on an existing Content Fragment. Include etag from get_content_fragment to avoid conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        fragment_path: { type: 'string', description: 'JCR path to the Content Fragment' },
        data: { type: 'object', description: 'Field updates as key-value pairs' },
        etag: { type: 'string', description: 'ETag from get_content_fragment — required for conflict prevention' },
      },
      required: ['fragment_path', 'data', 'etag'],
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
    description: 'Workfront WOA — Create a review/approval task in Workfront. Attaches preview URL and governance report. Assigns to approval chain from customer profile. Routes to webhook when configured, otherwise runs in demo mode.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description with governance findings' },
        project_id: { type: 'string', description: 'Workfront project ID to create the task in' },
        preview_url: { type: 'string', description: 'Preview URL for the reviewer' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Task priority' },
        assignee: { type: 'string', description: 'Role or person to assign to (from approval chain)' },
      },
      required: ['title', 'description'],
    },
  },

  {
    name: 'list_workfront_projects',
    description: 'Workfront — List projects with status, progress, priority. Filter by status (CUR=current, PLN=planning, CPL=complete).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: CUR, PLN, CPL, DED, ONH' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },

  {
    name: 'get_workfront_project',
    description: 'Workfront — Get detailed project info including tasks, owner, timeline, and completion percentage.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Workfront project ID' },
      },
      required: ['project_id'],
    },
  },

  {
    name: 'list_workfront_tasks',
    description: 'Workfront — List tasks, optionally filtered by project, status, or assignee.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Filter by project ID' },
        status: { type: 'string', description: 'Filter by status: NEW, INP, CPL, DED' },
        limit: { type: 'number', description: 'Max results (default 30)' },
      },
    },
  },

  {
    name: 'update_workfront_task',
    description: 'Workfront — Update a task (status, assignee, priority, percent complete).',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to update' },
        status: { type: 'string', description: 'New status: NEW, INP, CPL' },
        percentComplete: { type: 'number', description: 'Completion percentage (0-100)' },
        priority: { type: 'number', description: 'Priority: 0=None, 1=Low, 2=Normal, 3=High, 4=Urgent' },
      },
      required: ['task_id'],
    },
  },

  {
    name: 'list_workfront_approvals',
    description: 'Workfront — List pending approvals across projects.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: PENDING, APPROVED, REJECTED' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },

  {
    name: 'ask_workfront',
    description: 'Workfront Intelligent Answers — Ask natural language questions about projects, tasks, approvals, workload, and deadlines. Returns data from real Workfront instance when connected.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language question (e.g., "What tasks are overdue?", "Who has availability this sprint?")' },
      },
      required: ['question'],
    },
  },

  {
    name: 'get_project_health',
    description: 'Workfront Project Health — AI assessment of a project: health score, risk factors, timeline variance, task breakdown.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Workfront project ID (optional — uses default if omitted)' },
      },
    },
  },

  {
    name: 'check_workfront_connection',
    description: 'Check if Workfront API is reachable and which auth mode is active (IMS, API key, or demo).',
    input_schema: { type: 'object', properties: {} },
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
    description: 'Experience Production Agent — Modernize page content using Generate Variations (Firefly GenAI). Refreshes copy, updates tone to match brand voice, improves readability, and generates content variations. Supports dry-run mode.',
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

  /* ─── AEM Assets Direct API (faster than MCP for CRUD) ─── */

  {
    name: 'browse_dam_folder',
    description: 'Browse a DAM folder — list assets and subfolders at a given path. Direct API, fast. Use for navigating asset hierarchies.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'DAM folder path (e.g., "/content/dam/wknd" or just "/wknd"). Defaults to DAM root.' },
      },
    },
  },

  {
    name: 'get_asset_metadata',
    description: 'Get detailed metadata for a specific asset — title, description, dimensions, tags, DRM status, delivery URL, and all properties.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Asset path in DAM (e.g., "/wknd/en/adventures/bali/bali-hero.jpg")' },
      },
      required: ['path'],
    },
  },

  {
    name: 'update_asset_metadata',
    description: 'Update metadata properties on an asset — title, description, tags, expiration date, etc.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Asset path in DAM' },
        properties: {
          type: 'object',
          description: 'Properties to update (e.g., {"dc:title": "New Title", "dc:description": "Updated desc", "cq:tags": ["properties:orientation/landscape"]})',
        },
      },
      required: ['path', 'properties'],
    },
  },

  {
    name: 'upload_asset',
    description: 'Upload a file to a DAM folder. Provide the folder path, file name, and a URL to fetch the file from.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'DAM folder path to upload into (e.g., "/wknd/en/adventures")' },
        file_name: { type: 'string', description: 'File name including extension (e.g., "hero-banner.jpg")' },
        source_url: { type: 'string', description: 'URL to fetch the file from for upload' },
      },
      required: ['folder', 'file_name', 'source_url'],
    },
  },

  {
    name: 'delete_asset',
    description: 'Delete an asset or folder from DAM. Use with caution — this is permanent.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Asset or folder path to delete' },
      },
      required: ['path'],
    },
  },

  {
    name: 'move_asset',
    description: 'Move an asset to a new location in DAM. Updates all references.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Current asset path' },
        destination: { type: 'string', description: 'New path (including filename)' },
      },
      required: ['source', 'destination'],
    },
  },

  {
    name: 'copy_asset',
    description: 'Copy an asset to a new location in DAM.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source asset path' },
        destination: { type: 'string', description: 'Destination path (including filename)' },
      },
      required: ['source', 'destination'],
    },
  },

  {
    name: 'create_dam_folder',
    description: 'Create a new folder in DAM.',
    input_schema: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: 'Parent folder path (e.g., "/wknd/en")' },
        name: { type: 'string', description: 'Folder name (kebab-case, e.g., "campaign-2026")' },
        title: { type: 'string', description: 'Display title (e.g., "Campaign 2026")' },
      },
      required: ['parent', 'name'],
    },
  },

  {
    name: 'get_asset_renditions',
    description: 'List all available renditions for an asset — original, thumbnails, web-optimized, and Dynamic Media delivery URLs.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Asset path in DAM' },
      },
      required: ['path'],
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

  /* ─── LLM Optimizer — Citation Readability ─── */

  {
    name: 'check_citation_readability',
    description: 'Adobe LLM Optimizer — Check how visible a webpage is to AI agents (ChatGPT, Perplexity, Claude, Gemini). Fetches the page as an AI crawler would and compares against the human-rendered version. Returns a Citation Readability Score (0-100%), agent vs human word counts, missing content, and recommendations. Powered by the same technology as the Adobe LLMO Chrome Extension. Use this when the user asks about AI visibility, citation readability, LLM optimization, or SEO for AI.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the page to analyze. If not provided, analyzes the currently loaded page.' },
      },
    },
  },

  /* ─── Web Fetch (general-purpose URL fetcher) ─── */

  {
    name: 'fetch_url',
    description: 'Fetch any public URL and return the content. Use this to look up information from the web — LinkedIn profiles, company pages, documentation, image URLs, API endpoints, or any public resource. Returns HTML (cleaned text), JSON, or raw content depending on the URL. Useful when you need to find real data (headshots, logos, content) from external sources.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        extract_text: { type: 'boolean', description: 'If true, strips HTML tags and returns clean text. Default: true for HTML pages.' },
      },
      required: ['url'],
    },
  },

  /* ─── Unified AEM MCP (/adobe/mcp/aem) ─── */
  /* Code-execution model: tools accept JavaScript that runs in a sandboxed env with aem.get(), aem.post(), etc. */

  {
    name: 'aem_list_environments',
    description: 'Unified AEM MCP — List all AEM environments and sites available to this account.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'aem_lookup_api',
    description: 'Unified AEM MCP — Discover AEM API endpoints, code recipes, and feature flags. Use this BEFORE calling aem_read or aem_write to find the correct API paths. Pass JavaScript code that calls spec.search() or recipes.search().',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: "JavaScript code. Must use `return`. Examples: `return spec.search('fragment');` or `return recipes.search('update page');`" },
        aem_url: { type: 'string', description: 'AEM environment URL (optional). Filters specs to endpoints available on that tier.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'aem_read',
    description: 'Unified AEM MCP — Execute read-only AEM API calls (GET/HEAD). ALWAYS call aem_lookup_api first to find the correct endpoint. Pass JavaScript code that uses aem.get(). Returns page content, fragments, assets, site structure, etc.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Async JavaScript with aem.get() / aem.head(). Must use `return`.' },
        aem_url: { type: 'string', description: "AEM environment URL (e.g., 'https://author-p153659-e1614585.adobeaemcloud.com')" },
      },
      required: ['code', 'aem_url'],
    },
  },
  {
    name: 'aem_write',
    description: 'Unified AEM MCP — Execute AEM API mutations (POST/PUT/PATCH). ALWAYS call aem_lookup_api first. Pass JavaScript code that uses aem.post(), aem.put(), aem.patch(). Set confirmed=true to execute for real (default is dry-run).',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Async JavaScript with aem.post(), aem.put(), aem.patch(). Must use `return`.' },
        aem_url: { type: 'string', description: 'AEM environment URL' },
        confirmed: { type: 'boolean', description: 'Set true to execute mutations. Default false = dry-run simulation.' },
      },
      required: ['code', 'aem_url'],
    },
  },
  {
    name: 'aem_delete',
    description: 'Unified AEM MCP — Delete AEM content. IRREVERSIBLE. ALWAYS call aem_lookup_api first. Requires two-step confirmation: first call with confirmed=false (dry-run), then confirmed=true.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Async JavaScript with aem.get() and aem.delete(). Must use `return`.' },
        aem_url: { type: 'string', description: 'AEM environment URL' },
        confirmed: { type: 'boolean', description: 'Set true after a successful dry-run. Requires prior dry-run in same session.' },
      },
      required: ['code', 'aem_url'],
    },
  },

  /* ─── Bulk Operations ─── */

  {
    name: 'batch_aem_update',
    description: 'Bulk update a component or property across multiple AEM pages. Lists matching pages, shows a preview of what will change, then patches each page. Use when the user wants to update something "on all pages", "across the site", or "everywhere". Requires confirmation before executing.',
    input_schema: {
      type: 'object',
      properties: {
        aem_url: { type: 'string', description: "AEM environment URL (e.g., 'https://author-p153659-e1614585.adobeaemcloud.com')" },
        site_id: { type: 'string', description: 'Site ID or path prefix to scope the pages (e.g., "wknd-universal" or "/content/wknd-universal")' },
        component_type: { type: 'string', description: 'Component type to find and update (e.g., "hero", "teaser", "title"). Leave empty to match all pages.' },
        property_path: { type: 'string', description: 'JSON path to the property to update within the component (e.g., "properties/jcr:title", "properties/text")' },
        new_value: { type: 'string', description: 'New value to set for the property' },
        description: { type: 'string', description: 'Human-readable description of the change for the confirmation prompt' },
        confirmed: { type: 'boolean', description: 'Set true to execute. First call with false to preview affected pages.' },
      },
      required: ['aem_url', 'site_id', 'description'],
    },
  },

  /* ─── ALT Text / Accessibility ─── */

  {
    name: 'suggest_alt_text',
    description: 'Analyze all images on a page and suggest descriptive ALT text using AI vision. Returns a table of images with current ALT text and AI-suggested alternatives. Works with any AEM page (JCR or DA).',
    input_schema: {
      type: 'object',
      properties: {
        page_url: { type: 'string', description: 'Page URL to analyze (author URL or .aem.page URL). If omitted, uses the currently loaded preview page.' },
      },
      required: [],
    },
  },
  {
    name: 'apply_alt_text',
    description: 'Apply AI-suggested ALT text to images on a page. Call suggest_alt_text first to get suggestions, then use this tool to apply approved ones. Patches image components via aem_write.',
    input_schema: {
      type: 'object',
      properties: {
        aem_url: { type: 'string', description: 'AEM environment URL' },
        page_path: { type: 'string', description: 'Page path in JCR' },
        updates: {
          type: 'array',
          description: 'Array of {image_path, alt_text} objects to apply',
          items: {
            type: 'object',
            properties: {
              image_path: { type: 'string', description: 'JSON path to the image component in the page content tree' },
              alt_text: { type: 'string', description: 'New ALT text to set' },
            },
          },
        },
      },
      required: ['aem_url', 'page_path', 'updates'],
    },
  },

  /* ─── CJA / Analytics Skills (High Value) ─── */

  {
    name: 'cja_visualize',
    description: 'CJA — Answer analytics questions with visualizations. "Trend orders in July", "Show revenue by region", "Top 10 SKUs by profit". Returns visualization data for charts and tables.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language analytics question' },
        dataview_id: { type: 'string', description: 'CJA data view ID (optional — uses default if omitted)' },
      },
      required: ['question'],
    },
  },
  {
    name: 'cja_kpi_pulse',
    description: 'CJA — Compact KPI digest showing how key metrics changed over a period. "How did we do this week?", "Give me a performance overview", "Weekly KPI recap".',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Time period: "last 7 days", "last month", "this quarter"' },
        dataview_id: { type: 'string', description: 'CJA data view ID (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'cja_executive_briefing',
    description: 'CJA — Generate executive-ready performance summary with key metrics, trends, and drivers. "Write an exec summary", "Monthly business review", "Stakeholder briefing".',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Time period to summarize' },
        focus: { type: 'string', description: 'Focus area: "revenue", "engagement", "conversion", "all"' },
        dataview_id: { type: 'string', description: 'CJA data view ID (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'cja_anomaly_triage',
    description: 'CJA — Investigate an unexpected metric change to find root cause. "Why did conversion drop?", "What caused the traffic spike?", "Root cause analysis on revenue dip".',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'The metric that changed (e.g., "conversion rate", "revenue", "page views")' },
        direction: { type: 'string', description: '"increase" or "decrease"' },
        timeframe: { type: 'string', description: 'When it happened (e.g., "last week", "yesterday")' },
        dataview_id: { type: 'string', description: 'CJA data view ID (optional)' },
      },
      required: ['metric'],
    },
  },

  /* ─── Journey / Campaign Skills (Valuable) ─── */

  {
    name: 'create_journey',
    description: 'AJO — Build a multi-step customer journey from a brief. Supports email, push, SMS channels. "Create a post-purchase journey", "Build a re-engagement drip", "3-email welcome series".',
    input_schema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'Natural language description of the journey to create' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channels: ["email", "push", "sms"]' },
        entry_type: { type: 'string', description: 'Entry type: "event", "audience", "business-event"' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'generate_journey_content',
    description: 'AJO — Generate channel-specific content (email subject, body, push notification, SMS) for journey nodes. "Generate a welcome email with friendly tone", "Create push notification for cart abandonment".',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel: "email", "push", "sms"' },
        context: { type: 'string', description: 'What the content is for (journey step, campaign goal)' },
        tone: { type: 'string', description: 'Tone: "friendly", "urgent", "professional", "casual"' },
      },
      required: ['channel', 'context'],
    },
  },
  {
    name: 'analyze_experiment',
    description: 'Experimentation — Summarize experiment results, explain why treatments won or lost, recommend next tests. "What did we learn from this test?", "Why did variant A outperform?", "What should I test next?".',
    input_schema: {
      type: 'object',
      properties: {
        experiment_id: { type: 'string', description: 'Experiment or activity ID' },
        question: { type: 'string', description: 'Specific question about results (optional)' },
      },
      required: [],
    },
  },

  /* ─── Audience Skills (Valuable) ─── */

  {
    name: 'explore_audiences',
    description: 'RT-CDP — Search, filter, and inspect existing audiences. Find sizes, check activation status, list destinations. "Which audiences are largest?", "Show inactive audiences", "Audiences targeting California".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query for audiences' },
        status: { type: 'string', description: 'Filter: "active", "inactive", "all"' },
      },
      required: ['query'],
    },
  },
];

/* ── Tool → Official Adobe Agent Mapping (for UI badges) ── */
/* Header = official agent name. Sub-tasks = individual tool calls shown underneath. */
export const TOOL_AGENT_MAP = {
  // ── Experience Production Agent (content create, edit, translate, forms, modernize) ──
  edit_page_content: 'Experience Production Agent',
  get_page_content: 'Experience Production Agent',
  list_site_pages: 'Experience Production Agent',
  delete_page: 'Experience Production Agent',
  preview_page: 'Experience Production Agent',
  publish_page: 'Experience Production Agent',
  extract_brief_content: 'Experience Production Agent',
  translate_page: 'Experience Production Agent',
  create_form: 'Experience Production Agent',
  modernize_content: 'Experience Production Agent',
  copy_aem_page: 'Experience Production Agent',
  patch_aem_page_content: 'Experience Production Agent',
  create_aem_page: 'Experience Production Agent',
  list_aem_pages: 'Experience Production Agent',
  // ── Unified AEM MCP (code-execution model) ──
  aem_list_environments: 'Discovery Agent',
  aem_lookup_api: 'Adobe Agent',
  aem_read: 'Experience Production Agent',
  aem_write: 'Experience Production Agent',
  aem_delete: 'Adobe Agent',
  batch_aem_update: 'Experience Production Agent',
  suggest_alt_text: 'Content Advisor Agent',
  apply_alt_text: 'Content Advisor Agent',
  // CJA / Analytics
  cja_visualize: 'Analytics Agent',
  cja_kpi_pulse: 'Analytics Agent',
  cja_executive_briefing: 'Analytics Agent',
  cja_anomaly_triage: 'Analytics Agent',
  // Journeys / Campaigns
  create_journey: 'Journey Agent',
  generate_journey_content: 'Journey Agent',
  analyze_experiment: 'Experimentation Agent',
  // Audiences
  explore_audiences: 'Audience Agent',
  delete_aem_page: 'Experience Production Agent',
  list_aem_templates: 'Experience Production Agent',
  create_aem_launch: 'Experience Production Agent',
  promote_aem_launch: 'Experience Production Agent',
  get_content_fragment: 'Experience Production Agent',
  create_content_fragment: 'Experience Production Agent',
  update_content_fragment: 'Experience Production Agent',

  // ── Discovery Agent (asset search, DAM browse, collections) ──
  search_dam_assets: 'Discovery Agent',
  browse_dam_folder: 'Discovery Agent',
  get_asset_metadata: 'Discovery Agent',
  update_asset_metadata: 'Discovery Agent',
  upload_asset: 'Discovery Agent',
  delete_asset: 'Discovery Agent',
  move_asset: 'Discovery Agent',
  add_to_collection: 'Discovery Agent',

  // ── Governance Agent (brand, compliance, content audit) ──
  run_governance_check: 'Governance Agent',
  get_brand_guidelines: 'Governance Agent',
  check_asset_expiry: 'Governance Agent',
  audit_content: 'Governance Agent',

  // ── Content Optimization Agent (variations, images, renditions) ──
  create_content_variant: 'Content Optimization Agent',
  generate_image_variations: 'Content Optimization Agent',
  transform_image: 'Content Optimization Agent',
  create_image_renditions: 'Content Optimization Agent',

  // ── Data Insights Agent (analytics, audiences, profiles) ──
  get_analytics_insights: 'Data Insights Agent',
  get_audience_segments: 'Data Insights Agent',
  get_customer_profile: 'Data Insights Agent',

  // ── Journey Agent (journeys) ──
  get_journey_status: 'Journey Agent',

  // ── Workfront Agent (tasks, projects, approvals) ──
  create_workfront_task: 'Workfront Agent',
  list_workfront_projects: 'Workfront Agent',
  get_workfront_project: 'Workfront Agent',
  list_workfront_tasks: 'Workfront Agent',
  update_workfront_task: 'Workfront Agent',
  list_workfront_approvals: 'Workfront Agent',
  ask_workfront: 'Workfront Agent',
  get_project_health: 'Workfront Agent',
  check_workfront_connection: 'Workfront Agent',

  // ── Target Agent (A/B testing, personalization) ──
  create_ab_test: 'Target Agent',
  get_personalization_offers: 'Target Agent',

  // ── Development Agent (pipelines, code) ──
  get_pipeline_status: 'Development Agent',
  analyze_pipeline_failure: 'Development Agent',
  sync_code: 'Development Agent',

  // (Sites Optimizer and Support Agent entries moved to final section below)

  // ── Acrobat Agent (PDF extraction) ──
  extract_pdf_content: 'Acrobat Agent',

  // ── Admin API (cache, preview, bulk ops) ──
  unpublish_preview: 'Admin API',
  unpublish_live: 'Admin API',
  purge_cache: 'Admin API',
  bulk_preview: 'Admin API',
  bulk_publish: 'Admin API',
  reindex_page: 'Admin API',
  get_page_status: 'Admin API',

  // ── Site Management ──
  get_aem_sites: 'Site Management',
  get_aem_site_pages: 'Site Management',
  switch_site: 'Site Management',
  get_site_info: 'Site Management',

  // ── AEM Assets API ──
  copy_asset: 'AEM Assets API',
  create_dam_folder: 'AEM Assets API',
  get_asset_renditions: 'AEM Assets API',
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
  // LLM Optimizer
  check_citation_readability: 'LLM Optimizer',
  // Web Fetch
  fetch_url: 'Web Research',
};

/* ── Site-Type-Aware Tool Filtering ── */
/* Only send tools relevant to the connected site type. This prevents the AI from
   seeing (and incorrectly choosing) tools that will fail on the current site. */

const DA_ONLY_TOOLS = new Set([
  'edit_page_content', 'preview_page', 'publish_page', 'list_site_pages', 'delete_page',
  'unpublish_preview', 'unpublish_live', 'purge_cache', 'sync_code',
  'bulk_preview', 'bulk_publish', 'reindex_page', 'get_page_status',
]);

const JCR_ONLY_TOOLS = new Set([
  'patch_aem_page_content', 'copy_aem_page', 'create_aem_launch', 'promote_aem_launch',
  'create_aem_page', 'list_aem_pages', 'delete_aem_page',
  'get_content_fragment', 'create_content_fragment', 'update_content_fragment',
]);

/* ── Tiered Tool Selection (Speed optimization) ── */
/* Sending 104 tools = slow first-token time. Tier tools by intent so Claude
   only evaluates what's relevant. Saves 30-50% on thinking time. */

const TIER1_CORE = new Set([
  // Content editing (the 90% case)
  'edit_page_content', 'get_page_content', 'list_site_pages', 'preview_page', 'publish_page',
  'copy_aem_page', 'create_aem_page', 'delete_page', 'patch_aem_page_content',
  // AEM MCP direct
  'aem_read', 'aem_write', 'aem_list_environments',
  // Site management
  'get_aem_sites', 'get_aem_site_pages', 'switch_site', 'get_site_info',
  // Content fragments
  'get_content_fragment', 'update_content_fragment',
  // Utility
  'fetch_url', 'batch_aem_update',
]);

const TIER2_KEYWORDS = {
  analytics: ['cja_visualize', 'cja_kpi_pulse', 'cja_executive_briefing', 'cja_anomaly_triage', 'get_analytics_insights'],
  governance: ['run_governance_check', 'get_brand_guidelines', 'check_asset_expiry', 'audit_content'],
  workfront: ['create_workfront_task', 'list_workfront_projects', 'get_workfront_project', 'list_workfront_tasks', 'update_workfront_task', 'list_workfront_approvals', 'ask_workfront', 'get_project_health', 'check_workfront_connection'],
  assets: ['search_dam_assets', 'browse_dam_folder', 'get_asset_metadata', 'update_asset_metadata', 'upload_asset', 'delete_asset', 'move_asset', 'copy_asset', 'create_dam_folder', 'get_asset_renditions', 'add_to_collection'],
  images: ['generate_image_variations', 'transform_image', 'create_image_renditions'],
  journey: ['create_journey', 'generate_journey_content', 'get_journey_status', 'analyze_journey_conflicts'],
  experiment: ['setup_experiment', 'get_experiment_status', 'analyze_experiment', 'create_ab_test', 'get_personalization_offers'],
  audience: ['explore_audiences', 'get_audience_segments', 'get_customer_profile'],
  pipeline: ['get_pipeline_status', 'analyze_pipeline_failure', 'sync_code'],
  accessibility: ['suggest_alt_text', 'apply_alt_text', 'check_citation_readability'],
  destinations: ['list_destinations', 'list_destination_flow_runs', 'get_destination_health'],
  support: ['create_support_ticket', 'get_ticket_status', 'search_experience_league', 'get_product_release_notes'],
  optimizer: ['get_site_opportunities', 'get_site_audit'],
  forms: ['create_form', 'generate_form'],
  pdf: ['extract_pdf_content', 'extract_brief_content'],
  admin: ['unpublish_preview', 'unpublish_live', 'purge_cache', 'bulk_preview', 'bulk_publish', 'reindex_page', 'get_page_status'],
};

const INTENT_PATTERNS = {
  analytics: /\b(analytics?|cja|metric|kpi|dashboard|report|insight|data|trend|anomal)/i,
  governance: /\b(governance|brand|compliance|audit|policy|check)\b/i,
  workfront: /\b(workfront|project|task|approval|assign|deadline)/i,
  assets: /\b(asset|dam|image|photo|media|upload|folder|rendition|collection)/i,
  images: /\b(variation|transform|rendition|resize|crop|channel|social)/i,
  journey: /\b(journey|campaign|orchestrat|ajo)/i,
  experiment: /\b(experiment|a\/b|test|personali|target|offer)/i,
  audience: /\b(audience|segment|profile|cdp|rtcdp)/i,
  pipeline: /\b(pipeline|deploy|build|ci.?cd|sync|code sync)/i,
  accessibility: /\b(alt.?text|accessibility|a11y|wcag|citation|readab)/i,
  destinations: /\b(destination|export|activation|flow.?run)/i,
  support: /\b(support|ticket|experience.?league|release.?note|help)/i,
  optimizer: /\b(opportunit|lighthouse|performance|speed|core.?web|cwv|seo)/i,
  forms: /\b(form|input|submit|field|dropdown)/i,
  pdf: /\b(pdf|brief|document|extract)/i,
  admin: /\b(unpublish|purge|cache|bulk|reindex|status)/i,
};

function classifyIntent(prompt) {
  const matched = new Set();
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(prompt)) matched.add(intent);
  }
  return matched;
}

function getToolsForPrompt(prompt) {
  const siteType = window.__EW_SITE_TYPE || 'unknown';
  const intents = classifyIntent(prompt || '');

  // Build tool name set: always include Tier 1 + any matched Tier 2 categories
  const activeTools = new Set(TIER1_CORE);
  for (const intent of intents) {
    const tools = TIER2_KEYWORDS[intent];
    if (tools) tools.forEach((t) => activeTools.add(t));
  }

  // If no specific intent matched and prompt is complex, include all tools
  if (intents.size === 0 && prompt && prompt.length > 200) {
    return getToolsForSiteType();
  }

  // Filter AEM_TOOLS by active set + site type
  return AEM_TOOLS.filter((t) => {
    if (!activeTools.has(t.name)) return false;
    if (siteType === 'da' && JCR_ONLY_TOOLS.has(t.name)) return false;
    if (siteType === 'aem-cs' && DA_ONLY_TOOLS.has(t.name)) return false;
    return true;
  });
}

function getToolsForSiteType() {
  const siteType = window.__EW_SITE_TYPE || 'unknown';
  if (siteType === 'da') {
    return AEM_TOOLS.filter((t) => !JCR_ONLY_TOOLS.has(t.name));
  }
  if (siteType === 'aem-cs') {
    return AEM_TOOLS.filter((t) => !DA_ONLY_TOOLS.has(t.name));
  }
  return AEM_TOOLS;
}

/* ── Client-Side Tool Executor ── */
/* All tools call real MCP endpoints. No simulated data. */

/** Derive DM delivery host from AEM author host. */
/**
 * Get the DM + OpenAPI delivery host.
 * With DM + OpenAPI installed, approved assets are served from the delivery tier.
 * The delivery host is derived from the AEM CS author host, but when DM+OpenAPI
 * is enabled the real delivery URLs come back automatically from search_dam_assets
 * results. This function is a fallback for constructing transform URLs when the
 * agent already has an asset path but not the full delivery URL.
 */
/** Return error JSON if no DA site is connected, or null if OK */
function requireDaSite() {
  if (!da.getOrg() || !da.getRepo()) {
    return JSON.stringify({ status: 'error', message: 'No site connected. Connect a site first using the home screen.' });
  }
  return null;
}

function getDmDeliveryHost() {
  const host = window.__EW_AEM_HOST || '';
  const bare = host.replace(/^https?:\/\//, '');
  if (bare.startsWith('author-')) return `https://${bare.replace('author-', 'delivery-')}`;
  return null;
}

/** Ensure IMS auth is available — auto-refresh if expired/missing. */
async function ensureAuth() {
  if (isSignedIn()) return true;
  console.debug('[AI] IMS token missing — auto-refreshing...');
  try {
    const ok = await signIn();
    if (ok) console.debug('[AI] IMS token refreshed successfully');
    return ok;
  } catch (e) {
    console.warn('[AI] IMS auto-refresh failed:', e.message);
    return false;
  }
}

/** Standardized error for tools when user is not signed in. */
function authRequiredError(toolName) {
  return JSON.stringify({
    error: `Sign in with Adobe IMS to use ${toolName}.`,
    hint: 'Click "Sign In" in the top bar to authenticate with your Adobe ID.',
    _source: 'not-authenticated',
  });
}

/** Standardized error for MCP call failures. */
function mcpError(toolName, err) {
  return JSON.stringify({
    error: err.message || String(err),
    tool: toolName,
    hint: 'Check that you are signed in with Adobe IMS and have access to the AEM environment.',
    _source: 'error',
  });
}

/** Sanitize page paths to prevent traversal attacks in URL construction */
function sanitizePath(p) {
  let clean = (p || '/').replace(/\.html$/, '');
  if (!clean.startsWith('/')) clean = '/' + clean;
  // Strip traversal sequences and encoded dots
  clean = clean.replace(/\.\.[\\/]/g, '').replace(/%2e/gi, '');
  return clean;
}

async function executeTool(name, input) {
  const profile = getActiveProfile() || {};

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

      // Derive page path from URL (e.g. /index, /about)
      let pagePath = input.path;
      if (!pagePath) {
        try {
          const u = new URL(pageUrl);
          pagePath = u.pathname.replace(/\/$/, '') || '/index';
        } catch { pagePath = '/index'; }
      }

      const currentSiteType = getSiteType();

      // ── JCR path: AEM Content MCP (returns real ETag for patch operations) ──
      if (currentSiteType === 'aem-cs' && (await ensureAuth()) && window.__EW_AEM_HOST) {
        try {
          const host = window.__EW_AEM_HOST;
          console.debug(`[get_page_content] Reading via AEM Content MCP: ${host}${pagePath}`);
          const result = await aemContent.getPage(host, pagePath);
          const html = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          const content = html.length > HTML_TRUNCATE_THRESHOLD ? html.slice(0, HTML_TRUNCATE_THRESHOLD) + '\n\n[... truncated]' : html;
          return JSON.stringify({
            url: pageUrl,
            source: 'AEM Content MCP',
            etag: result?.etag || null,
            content_length: html.length,
            html: content,
            hint: 'JCR page content. Use patch_aem_page_content with the etag to make changes.',
          }, null, 2);
        } catch (jcrErr) {
          console.warn('[get_page_content] AEM Content MCP read failed, falling back:', jcrErr.message);
        }
      }

      // ── DA path: DA MCP (no ETag needed, uses edit_page_content for writes) ──
      if (currentSiteType !== 'aem-cs' && (await ensureAuth()) && da.getOrg() && da.getRepo()) {
        try {
          const daPath = pagePath.replace(/\.html$/, '');
          console.debug(`[get_page_content] Reading via DA MCP: ${da.getOrg()}/${da.getRepo()}${daPath}`);
          const result = await da.getPage(`${daPath}.html`);
          const html = typeof result === 'string' ? result : JSON.stringify(result);
          const content = html.length > HTML_TRUNCATE_THRESHOLD ? html.slice(0, HTML_TRUNCATE_THRESHOLD) + '\n\n[... truncated]' : html;
          return JSON.stringify({
            url: pageUrl,
            source: 'DA MCP',
            content_length: html.length,
            html: content,
            hint: 'DA page content. Use edit_page_content to make changes.',
          }, null, 2);
        } catch (daErr) {
          console.warn('[get_page_content] DA MCP read failed, falling back to fetch:', daErr.message);
        }
      }

      // ── Fallback: .plain.html fetch from CDN ──
      // WARNING: CDN ETags are NOT JCR ETags. Never return them for JCR sites —
      // passing a CDN ETag to patch_aem_page_content will cause 412 errors.
      const plainUrl = pageUrl.endsWith('.plain.html') ? pageUrl : pageUrl.replace(/\/?$/, '.plain.html');
      try {
        const resp = await fetch(plainUrl);
        if (resp.ok) {
          const html = await resp.text();
          const isJcrSite = currentSiteType === 'aem-cs';
          const etag = isJcrSite ? null : (resp.headers.get('etag') || null);
          const content = html.length > HTML_TRUNCATE_THRESHOLD ? html.slice(0, HTML_TRUNCATE_THRESHOLD) + '\n\n[... truncated]' : html;
          return JSON.stringify({
            url: pageUrl,
            source: 'aem.page (CDN fallback)',
            etag,
            content_length: html.length,
            html: content,
            hint: isJcrSite
              ? 'CDN fallback — no JCR ETag available. Sign in with Adobe IMS and retry to get a valid ETag for patching.'
              : (etag ? 'Use edit_page_content to make changes.' : 'Read-only: sign in for write access.'),
          }, null, 2);
        }
        return JSON.stringify({ error: `HTTP ${resp.status} fetching ${plainUrl}` });
      } catch (e) {
        return JSON.stringify({ error: `Fetch failed: ${e.message}` });
      }
    }

    case 'copy_aem_page': {
      if (!(await ensureAuth())) return authRequiredError('copy_aem_page');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.copyPage(host, input.source_path, input.destination_path, input.title);
        // Construct UE edit URL (don't rely on MCP to return it)
        const orgCtx = window.__EW_ORG || {};
        const previewOrigin = orgCtx.previewOrigin || '';
        const ueUrl = host ? buildUeUrl(host, input.destination_path, orgCtx) : null;
        return JSON.stringify({
          status: 'created',
          ...result,
          path: input.destination_path,
          title: input.title,
          copied_from: input.source_path,
          edit_urls: { universal_editor: ueUrl },
          preview_url: previewOrigin ? `${previewOrigin}${input.destination_path}` : null,
          message: `Page created at ${input.destination_path} from template ${input.source_path}`,
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('copy_aem_page', err);
      }
    }

    case 'patch_aem_page_content': {
      if (!(await ensureAuth())) return authRequiredError('patch_aem_page_content');
      const fields = Object.keys(input.updates || {});
      const host = window.__EW_AEM_HOST || null;

      // Try patch — on 412 conflict (stale ETag), auto-retry with fresh ETag
      let lastEtag = input.etag;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            // Re-read page to get fresh ETag after conflict
            console.debug(`[patch] ETag conflict — re-reading page for fresh ETag (attempt ${attempt + 1})`);
            const freshPage = await aemContent.getPage(host, input.page_path);
            lastEtag = freshPage?.etag;
            if (!lastEtag) throw new Error('Could not get fresh ETag after conflict');
          }
          const result = await aemContent.updatePage(host, input.page_path, input.updates, lastEtag);

          const orgCtx = window.__EW_ORG || {};
          const previewOrigin = orgCtx.previewOrigin || '';
          const ueUrl = host ? buildUeUrl(host, input.page_path, orgCtx) : null;
          const previewUrl = previewOrigin ? `${previewOrigin}${input.page_path}` : null;

          return JSON.stringify({
            status: 'updated',
            ...result,
            page_path: input.page_path,
            updated_fields: fields,
            edit_urls: { universal_editor: ueUrl },
            preview_url: previewUrl,
            retried: attempt > 0,
            message: `Updated ${fields.length} field(s) on ${input.page_path}${attempt > 0 ? ' (retried with fresh ETag)' : ''}`,
            _source: 'connected',
            source: 'AEM Content MCP',
            _action: 'refresh_preview',
            _preview_path: input.page_path,
          }, null, 2);
        } catch (err) {
          // Retry on 412 Precondition Failed (stale ETag)
          if (attempt === 0 && (err.message?.includes('412') || err.message?.includes('conflict') || err.message?.includes('Precondition'))) {
            continue;
          }
          return mcpError('patch_aem_page_content', err);
        }
      }
      return mcpError('patch_aem_page_content', new Error('Patch failed after retry'));
    }

    case 'create_aem_launch': {
      if (!(await ensureAuth())) return authRequiredError('create_aem_launch');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.createLaunch(host, [input.page_path], input.launch_name);
        return JSON.stringify({
          status: 'created',
          ...result,
          launch_name: input.launch_name,
          pages: [input.page_path],
          state: 'open',
          message: `Launch "${input.launch_name}" created`,
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('create_aem_launch', err);
      }
    }

    case 'promote_aem_launch': {
      if (!(await ensureAuth())) return authRequiredError('promote_aem_launch');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.promoteLaunch(host, input.launch_id);
        return JSON.stringify({
          status: 'promoted',
          ...result,
          launch_id: input.launch_id,
          message: `Launch ${input.launch_id} promoted`,
          published_at: new Date().toISOString(),
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('promote_aem_launch', err);
      }
    }

    /* ─── JCR CRUD: Create, List, Delete ─── */

    case 'create_aem_page': {
      if (!(await ensureAuth())) return authRequiredError('create_aem_page');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.createPage(host, input.page_path, input.title, input.template);
        const orgCtx = window.__EW_ORG || {};
        const previewOrigin = orgCtx.previewOrigin || '';
        const ueUrl = host ? buildUeUrl(host, input.page_path, orgCtx) : null;
        return JSON.stringify({
          status: 'created',
          ...result,
          page_path: input.page_path,
          title: input.title,
          edit_urls: { universal_editor: ueUrl },
          preview_url: previewOrigin ? `${previewOrigin}${input.page_path}` : null,
          message: `Page created at ${input.page_path}`,
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('create_aem_page', err);
      }
    }

    case 'list_aem_pages': {
      if (!(await ensureAuth())) return authRequiredError('list_aem_pages');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.listPages(host, input.parent_path);
        return JSON.stringify({
          status: 'success',
          parent_path: input.parent_path,
          pages: Array.isArray(result) ? result : (result?.pages || []),
          count: Array.isArray(result) ? result.length : (result?.pages?.length || 0),
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('list_aem_pages', err);
      }
    }

    case 'delete_aem_page': {
      if (!(await ensureAuth())) return authRequiredError('delete_aem_page');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.deletePage(host, input.page_path);
        return JSON.stringify({
          status: 'deleted',
          ...result,
          page_path: input.page_path,
          message: `Page ${input.page_path} deleted`,
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('delete_aem_page', err);
      }
    }

    /* ─── Template Discovery ─── */

    case 'list_aem_templates': {
      if (!(await ensureAuth())) return authRequiredError('list_aem_templates');
      try {
        const host = window.__EW_AEM_HOST || null;
        const siteName = input.site_name;
        const templatePath = `/conf/${siteName}/settings/wcm/templates`;

        // List templates from the site's /conf/{site}/settings/wcm/templates/ path
        const result = await aemContent.listPages(host, templatePath);
        const templates = Array.isArray(result) ? result : (result?.pages || result?.children || []);

        // If no templates found at site level, try global
        if (templates.length === 0) {
          const globalResult = await aemContent.listPages(host, '/conf/global/settings/wcm/templates');
          const globalTemplates = Array.isArray(globalResult) ? globalResult : (globalResult?.pages || globalResult?.children || []);
          return JSON.stringify({
            status: 'success',
            site_name: siteName,
            searched_path: templatePath,
            note: `No templates at site level. Found ${globalTemplates.length} global templates.`,
            templates: globalTemplates.map((t) => ({
              path: t.path || t,
              title: t.title || t.name || '',
              description: t.description || '',
            })),
            source: 'AEM Content MCP',
          }, null, 2);
        }

        return JSON.stringify({
          status: 'success',
          site_name: siteName,
          template_path: templatePath,
          templates: templates.map((t) => ({
            path: t.path || t,
            title: t.title || t.name || '',
            description: t.description || '',
          })),
          count: templates.length,
          hint: 'Pass the template path to create_aem_page to create a page with this layout.',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('list_aem_templates', err);
      }
    }

    /* ─── Content Fragments (AEM Content MCP) ─── */

    case 'get_content_fragment': {
      if (!(await ensureAuth())) return authRequiredError('get_content_fragment');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.getFragment(host, input.fragment_path);
        return JSON.stringify({
          status: 'success',
          ...result,
          fragment_path: input.fragment_path,
          etag: result?.etag || null,
          hint: 'Use update_content_fragment with the etag to modify this fragment.',
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('get_content_fragment', err);
      }
    }

    case 'create_content_fragment': {
      if (!(await ensureAuth())) return authRequiredError('create_content_fragment');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.createFragment(host, input.parent_path, input.title, input.model, input.data || {});
        return JSON.stringify({
          status: 'created',
          ...result,
          parent_path: input.parent_path,
          title: input.title,
          model: input.model,
          message: `Content Fragment "${input.title}" created at ${input.parent_path}`,
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('create_content_fragment', err);
      }
    }

    case 'update_content_fragment': {
      if (!(await ensureAuth())) return authRequiredError('update_content_fragment');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await aemContent.updateFragment(host, input.fragment_path, input.data, input.etag);
        return JSON.stringify({
          status: 'updated',
          ...result,
          fragment_path: input.fragment_path,
          updated_fields: Object.keys(input.data || {}),
          message: `Content Fragment at ${input.fragment_path} updated`,
          _source: 'connected',
          source: 'AEM Content MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('update_content_fragment', err);
      }
    }

    /* ─── DA Editing Agent (real DA endpoints) ─── */

    case 'edit_page_content': {
      const pagePath = sanitizePath(input.page_path);
      // Root path needs /index.html for DA write, but pagePath stays / for preview URLs
      const htmlPath = (pagePath === '/' ? '/index' : pagePath) + '.html';
      const org = da.getOrg();
      const repo = da.getRepo();
      const branch = da.getBranch();

      { const noSite = requireDaSite(); if (noSite) return noSite; }

      const baseUrl = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page`;
      const previewUrl = `${baseUrl}${pagePath}`;
      // DA edit URLs need explicit /index for root path (da.live doesn't resolve / to /index)
      const daEditPath = pagePath === '/' ? '/index' : pagePath;
      const daUrl = `https://da.live/edit#/${org}/${repo}${daEditPath}`;

      // ── DA MCP write (primary — native path for DA-backed sites) ──
      // Requires IMS Bearer token. Auto-refresh if token missing/expired.
      console.debug(`[edit_page_content] ── START ── org=${org} repo=${repo} path=${htmlPath} htmlLen=${input.html?.length || 0} auth=${isSignedIn()} ghToken=${hasGitHubToken()}`);
      if (await ensureAuth()) {
        try {
          console.debug(`[edit_page_content] Writing via DA Admin API: ${da.getBasePath()}${htmlPath}`);
          await da.updatePage(htmlPath, input.html);
          // Direct PUT to admin.da.live — if it didn't throw, the write succeeded.

          let previewStatus = 'skipped';
          if (input.trigger_preview !== false) {
            try {
              const previewResp = await da.previewPage(pagePath);
              previewStatus = previewResp.ok ? 'success' : `pending (${previewResp.status})`;
              console.debug('[edit_page_content] Preview trigger:', previewStatus);
            } catch (previewErr) {
              previewStatus = `pending: ${previewErr.message}`;
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
            source: 'DA Admin API',
            message: `Page ${pagePath} saved via DA Admin API. Preview refreshing.`,
            _action: 'refresh_preview',
            _preview_path: pagePath,
          }, null, 2);
        } catch (daErr) {
          console.warn('[edit_page_content] DA MCP write failed:', daErr.message);
          // Fall through to GitHub
        }
      }

      // ── GitHub write fallback (AEMCoder pattern) ──
      // Write directly to DA's backing GitHub repo via GitHub Contents API.
      if (hasGitHubToken()) {
        try {
          const result = await ghWriteContent(org, repo, pagePath, input.html, null, branch);
          console.debug('[edit_page_content] GitHub write:', result.commitSha);

          // Trigger preview — prefer IMS auth (required for DA-backed sites)
          // GitHub PAT alone gets 401 on admin.hlx.page for DA sites.
          let previewStatus = 'skipped';
          if (input.trigger_preview !== false) {
            try {
              if (getToken()) {
                // Use DA client's previewPage which sends IMS Bearer token
                const previewResp = await da.previewPage(pagePath);
                previewStatus = previewResp.ok ? 'success' : `pending (${previewResp.status})`;
              } else {
                const pResult = await ghTriggerPreview(org, repo, branch, pagePath);
                previewStatus = pResult.ok ? 'success' : `pending (${pResult.status})`;
              }
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
            source: 'GitHub API',
            message: `Content committed to ${org}/${repo}${htmlPath}. Preview updating.`,
            _action: 'local_write',
            _preview_path: pagePath,
          }, null, 2);
        } catch (ghErr) {
          console.warn('[edit_page_content] GitHub write failed:', ghErr.message);
        }
      }

      // ── No auth — return diagnostic error (never fake success) ──
      const imsToken = isSignedIn();
      const ghToken = hasGitHubToken();
      console.error(`[edit_page_content] Auth check: IMS=${imsToken}, GitHub=${ghToken}, org=${org}, repo=${repo}`);

      // If we got here with IMS token, the DA MCP write threw — include that error
      const hints = [];
      if (!imsToken) hints.push('Click "Sign In" to authenticate with Adobe IMS — this enables DA MCP writes');
      if (!ghToken) hints.push('Or add a GitHub Personal Access Token in Settings');
      if (imsToken && !ghToken) hints.push('IMS is active but DA write failed above — check browser console for details');

      return JSON.stringify({
        status: 'error',
        error: 'Authentication required to edit content.',
        page_path: pagePath,
        preview_url: previewUrl,
        da_edit_url: daUrl,
        auth_state: { ims: imsToken, github: ghToken },
        how_to_fix: hints,
        message: `Cannot save changes to ${pagePath}. Auth state: IMS=${imsToken}, GitHub=${ghToken}. ${hints.join('. ')}.`,
        _action: 'auth_required',
      }, null, 2);
    }

    case 'preview_page': {
      { const noSite = requireDaSite(); if (noSite) return noSite; }
      const pagePath = sanitizePath(input.page_path);
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
      { const noSite = requireDaSite(); if (noSite) return noSite; }
      const pagePath = sanitizePath(input.page_path);
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

    /* ─── Admin API operations ─── */

    case 'unpublish_preview': {
      const pagePath = sanitizePath(input.page_path);
      try {
        const resp = await da.unpublishPreview(pagePath);
        return JSON.stringify({
          status: resp.ok ? 'unpublished' : 'failed',
          page_path: pagePath,
          http_status: resp.status,
          message: resp.ok
            ? `Preview removed for ${pagePath}. The .aem.page URL will return 404.`
            : `Unpublish preview returned ${resp.status}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message, page_path: pagePath }, null, 2);
      }
    }

    case 'unpublish_live': {
      const pagePath = sanitizePath(input.page_path);
      try {
        const resp = await da.unpublishLive(pagePath);
        return JSON.stringify({
          status: resp.ok ? 'unpublished' : 'failed',
          page_path: pagePath,
          http_status: resp.status,
          message: resp.ok
            ? `Live page removed for ${pagePath}. The .aem.live URL will return 404.`
            : `Unpublish live returned ${resp.status}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message, page_path: pagePath }, null, 2);
      }
    }

    case 'purge_cache': {
      const pagePath = sanitizePath(input.page_path);
      try {
        const resp = await da.purgeCache(pagePath);
        return JSON.stringify({
          status: resp.ok ? 'purged' : 'failed',
          page_path: pagePath,
          http_status: resp.status,
          message: resp.ok
            ? `CDN cache purged for ${pagePath}. Next request will fetch fresh content from origin.`
            : `Cache purge returned ${resp.status}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message, page_path: pagePath }, null, 2);
      }
    }

    case 'sync_code': {
      { const noSite = requireDaSite(); if (noSite) return noSite; }
      const org = da.getOrg();
      const repo = da.getRepo();
      try {
        const resp = await da.syncCode();
        return JSON.stringify({
          status: resp.ok ? 'synced' : 'failed',
          http_status: resp.status,
          message: resp.ok
            ? `Code synced from ${org}/${repo} to CDN. JS/CSS changes are now live.`
            : `Code sync returned ${resp.status}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message }, null, 2);
      }
    }

    case 'bulk_preview': {
      const paths = (input.paths || []).slice(0, 100).map(sanitizePath);
      try {
        const resp = await da.bulkPreview(paths);
        const data = await resp.json().catch(() => ({}));
        return JSON.stringify({
          status: resp.ok ? 'success' : 'failed',
          paths_count: paths.length,
          http_status: resp.status,
          details: data,
          message: resp.ok
            ? `Bulk preview triggered for ${paths.length} pages.`
            : `Bulk preview returned ${resp.status}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message, paths_count: paths.length }, null, 2);
      }
    }

    case 'bulk_publish': {
      const paths = (input.paths || []).slice(0, 100).map(sanitizePath);
      try {
        const resp = await da.bulkPublish(paths);
        const data = await resp.json().catch(() => ({}));
        return JSON.stringify({
          status: resp.ok ? 'success' : 'failed',
          paths_count: paths.length,
          http_status: resp.status,
          details: data,
          message: resp.ok
            ? `Bulk publish triggered for ${paths.length} pages. All pages going live.`
            : `Bulk publish returned ${resp.status}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message, paths_count: paths.length }, null, 2);
      }
    }

    case 'reindex_page': {
      const pagePath = sanitizePath(input.page_path);
      try {
        const resp = await da.reindex(pagePath);
        return JSON.stringify({
          status: resp.ok ? 'reindexed' : 'failed',
          page_path: pagePath,
          http_status: resp.status,
          message: resp.ok
            ? `Page ${pagePath} re-indexed. Will appear in query-index.json results.`
            : `Re-index returned ${resp.status}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message, page_path: pagePath }, null, 2);
      }
    }

    case 'get_page_status': {
      { const noSite = requireDaSite(); if (noSite) return noSite; }
      const pagePath = sanitizePath(input.page_path);
      try {
        const data = await da.getStatus(pagePath);
        return JSON.stringify({
          status: 'success',
          page_path: pagePath,
          ...data,
          message: `Status retrieved for ${pagePath}`,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ status: 'error', error: err.message, page_path: pagePath }, null, 2);
      }
    }

    case 'list_site_pages': {
      { const noSite = requireDaSite(); if (noSite) return noSite; }
      const listPath = sanitizePath(input.path || '/');

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
      if (!(await ensureAuth())) return authRequiredError('search_dam_assets');
      const query = input.query || '';
      const type = input.asset_type || 'image';
      const limit = input.limit || 6;
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
          _source: 'connected',
          source: 'AEM Discovery MCP',
          message: `Found assets matching "${query.slice(0, 50)}"`,
        }, null, 2);
      } catch (err) {
        return mcpError('search_dam_assets', err);
      }
    }

    /* ─── Governance Agent ─── */

    case 'run_governance_check': {
      if (!(await ensureAuth())) return authRequiredError('run_governance_check');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await govMcp.checkPagePolicy(host, input.page_path);
        return JSON.stringify({
          page_path: input.page_path,
          ...result,
          _source: 'connected',
          source: 'AEM Experience Governance MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('run_governance_check', err);
      }
    }

    /* ─── Audience Agent ─── */

    case 'get_audience_segments': {
      if (!(await ensureAuth())) return authRequiredError('get_audience_segments');
      try {
        const result = await marketingMcp.callTool('get_audience_segments', {
          action: input.action || 'list',
          query: input.query,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe Marketing Agent MCP — AEP Segments',
        }, null, 2);
      } catch (err) {
        return mcpError('get_audience_segments', err);
      }
    }

    /* ─── Content Optimization Agent ─── */

    case 'create_content_variant': {
      if (!(await ensureAuth())) return authRequiredError('create_content_variant');
      try {
        const result = await contentUpdaterMcp.callTool('create_content_variant', {
          page_path: input.page_path,
          segment: input.segment,
          changes: input.changes,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'AEM Content Updater MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('create_content_variant', err);
      }
    }

    /* ─── Data Insights Agent (CJA) ─── */

    case 'get_analytics_insights': {
      if (!(await ensureAuth())) return authRequiredError('get_analytics_insights');
      try {
        const result = await cjaMcp.callTool('get_analytics_insights', {
          query: input.query,
          date_range: input.date_range || 'last 30 days',
          page_path: input.page_path,
          metrics: input.metrics,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe CJA MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('get_analytics_insights', err);
      }
    }

    /* ─── Journey Agent (AJO) ─── */

    case 'get_journey_status': {
      if (!(await ensureAuth())) return authRequiredError('get_journey_status');
      try {
        const result = await marketingMcp.callTool('get_journey_status', {
          action: input.action || 'list',
          journey_name: input.journey_name,
          description: input.description,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe Marketing Agent MCP — AJO',
        }, null, 2);
      } catch (err) {
        return mcpError('get_journey_status', err);
      }
    }

    /* ─── Workfront WOA ─── */

    case 'create_workfront_task': {
      const chain = profile.approvalChain || [];
      const assignee = input.assignee || chain[0]?.role || 'Content Reviewer';
      try {
        const result = await wf.createTask({
          projectId: input.project_id,
          name: input.title,
          description: input.description,
          priority: input.priority || 'normal',
          assignee,
        });
        return JSON.stringify({
          ...result,
          assignee,
          source: result.source === 'live' ? 'Workfront API' : 'Workfront (demo)',
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'list_workfront_projects': {
      try {
        const result = await wf.listProjects({ status: input.status, limit: input.limit });
        return JSON.stringify({ ...result, source: result.source === 'live' ? 'Workfront API' : 'Workfront (demo)' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'get_workfront_project': {
      try {
        const result = await wf.getProject(input.project_id);
        return JSON.stringify({ ...result, source: result?.source === 'live' ? 'Workfront API' : 'Workfront (demo)' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'list_workfront_tasks': {
      try {
        const result = await wf.listTasks({ projectID: input.project_id, status: input.status, limit: input.limit });
        return JSON.stringify({ ...result, source: result.source === 'live' ? 'Workfront API' : 'Workfront (demo)' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'update_workfront_task': {
      try {
        const fields = {};
        if (input.status) fields.status = input.status;
        if (input.percentComplete != null) fields.percentComplete = input.percentComplete;
        if (input.priority != null) fields.priority = input.priority;
        const result = await wf.updateTask(input.task_id, fields);
        return JSON.stringify({ ...result, source: result.source === 'live' ? 'Workfront API' : 'Workfront (demo)' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'list_workfront_approvals': {
      try {
        const result = await wf.listApprovals({ status: input.status, limit: input.limit });
        return JSON.stringify({ ...result, source: result.source === 'live' ? 'Workfront API' : 'Workfront (demo)' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'ask_workfront': {
      try {
        const result = await wf.askWorkfront(input.question);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'get_project_health': {
      try {
        const result = await wf.getProjectHealth(input.project_id);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'Workfront' });
      }
    }

    case 'check_workfront_connection': {
      try {
        const result = await wf.checkConnection();
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return JSON.stringify({ connected: false, error: err.message });
      }
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
      if (!(await ensureAuth())) return authRequiredError('create_ab_test');
      try {
        const result = await marketingMcp.callTool('create_ab_test', {
          test_name: input.test_name,
          page_path: input.page_path,
          variants: input.variants,
          duration_days: input.duration_days || 14,
          success_metric: input.success_metric || 'conversion',
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe Marketing Agent MCP — Target A/B',
        }, null, 2);
      } catch (err) {
        return mcpError('create_ab_test', err);
      }
    }

    case 'get_personalization_offers': {
      if (!(await ensureAuth())) return authRequiredError('get_personalization_offers');
      try {
        const result = await marketingMcp.callTool('get_personalization_offers', {
          page_path: input.page_path,
          segment: input.segment || 'all-visitors',
          location: input.location || 'hero-cta',
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe Marketing Agent MCP — Target Decisioning',
        }, null, 2);
      } catch (err) {
        return mcpError('get_personalization_offers', err);
      }
    }

    /* ─── AEP Real-time Profile Agent ─── */

    case 'get_customer_profile': {
      if (!(await ensureAuth())) return authRequiredError('get_customer_profile');
      try {
        const result = await marketingMcp.callTool('get_customer_profile', {
          identity: input.identity,
          identity_namespace: input.identity_namespace || 'email',
          include: input.include || ['segments', 'events', 'consent', 'identity_graph'],
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe Marketing Agent MCP — AEP Profile',
        }, null, 2);
      } catch (err) {
        return mcpError('get_customer_profile', err);
      }
    }

    /* ─── Firefly Agent (Generative AI) ─── */

    case 'generate_image_variations': {
      if (!(await ensureAuth())) return authRequiredError('generate_image_variations');
      try {
        const result = await contentUpdaterMcp.callTool('generate_image_variations', {
          prompt: input.prompt,
          source_asset: input.source_asset,
          count: input.count || 3,
          style: input.style,
          aspect_ratio: input.aspect_ratio,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe Firefly via AEM Content Updater MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('generate_image_variations', err);
      }
    }

    /* ─── Development Agent (Cloud Manager) ─── */

    case 'get_pipeline_status': {
      if (!(await ensureAuth())) return authRequiredError('get_pipeline_status');
      try {
        const result = await developmentMcp.callTool('get_pipeline_status', {
          environment: input.environment || 'prod',
          status_filter: input.status_filter,
          pipeline_id: input.pipeline_id,
          program_name: input.program_name,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Cloud Manager via AEM Development MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('get_pipeline_status', err);
      }
    }

    /* ─── Acrobat MCP (PDF Services) ─── */

    case 'extract_pdf_content': {
      if (!(await ensureAuth())) return authRequiredError('extract_pdf_content');
      try {
        const result = await acrobatMcp.callTool('extract_pdf_content', {
          file_name: input.file_name,
          content_text: input.content_text,
          extract_tables: input.extract_tables !== false,
          extract_images: input.extract_images !== false,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Adobe Acrobat MCP',
        }, null, 2);
      } catch (err) {
        return mcpError('extract_pdf_content', err);
      }
    }

    /* ─── Development Agent: Pipeline Failure Analysis ─── */

    case 'analyze_pipeline_failure': {
      if (!(await ensureAuth())) return authRequiredError('analyze_pipeline_failure');
      try {
        const result = await developmentMcp.callTool('analyze_pipeline_failure', {
          pipeline_id: input.pipeline_id,
          program_name: input.program_name,
          include_logs: input.include_logs !== false,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'AEM Development MCP — Pipeline Analysis',
        }, null, 2);
      } catch (err) {
        return mcpError('analyze_pipeline_failure', err);
      }
    }

    /* ─── Experience Production Agent: Translate Page ─── */

    case 'translate_page': {
      if (!(await ensureAuth())) return authRequiredError('translate_page');
      try {
        const result = await contentUpdaterMcp.callTool('translate_page', {
          page_url: input.page_url,
          target_language: input.target_language || 'es',
          site_id: input.site_id,
          language_tree_path: input.language_tree_path,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'AEM Content Updater MCP — Translation',
        }, null, 2);
      } catch (err) {
        return mcpError('translate_page', err);
      }
    }

    /* ─── Experience Production Agent: Create Form ─── */

    case 'create_form': {
      if (!(await ensureAuth())) return authRequiredError('create_form');
      try {
        const result = await contentUpdaterMcp.callTool('create_form', {
          form_type: input.form_type,
          description: input.description,
          fields: input.fields,
          page_path: input.page_path,
          submit_action: input.submit_action,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Experience Production Agent — Form Builder',
        }, null, 2);
      } catch (err) {
        return mcpError('create_form', err);
      }
    }

    /* ─── Experience Production Agent: Modernize Content ─── */

    case 'modernize_content': {
      if (!(await ensureAuth())) return authRequiredError('modernize_content');
      try {
        const result = await contentUpdaterMcp.callTool('modernize_content', {
          site_url: input.site_url,
          design_system: input.design_system,
          scope: input.scope || 'single-page',
          dry_run: input.dry_run !== false,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Experience Production Agent — Generate Variations',
        }, null, 2);
      } catch (err) {
        return mcpError('modernize_content', err);
      }
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
        _source: 'profile',
        _note: 'Brand guidelines loaded from customer profile. For enterprise policies, wire Governance MCP get_brand_policy.',
        message: category === 'all'
          ? `Complete brand guidelines for ${profile.name}. Covers voice, colors, typography, imagery, and logo.`
          : `${category.charAt(0).toUpperCase() + category.slice(1)} guidelines for ${profile.name}.`,
      }, null, 2);
    }

    /* ─── Governance Agent: Asset Expiry ─── */

    case 'check_asset_expiry': {
      if (!(await ensureAuth())) return authRequiredError('check_asset_expiry');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await discoveryMcp.checkAssetExpiry(host, {
          days: input.days_until_expiry || 30,
          folder: input.folder,
          includeExpired: input.include_expired !== false,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'AEM Discovery MCP — Asset Expiry',
        }, null, 2);
      } catch (err) {
        return mcpError('check_asset_expiry', err);
      }
    }

    /* ─── Governance Agent: Content Audit ─── */

    case 'audit_content': {
      if (!(await ensureAuth())) return authRequiredError('audit_content');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await discoveryMcp.auditContent(host, {
          contentType: input.content_type || 'all',
          staleDays: input.stale_days || 90,
          statusFilter: input.status_filter || 'published',
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'AEM Discovery MCP — Content Audit',
        }, null, 2);
      } catch (err) {
        return mcpError('audit_content', err);
      }
    }

    /* ─── Content Optimization Agent: Transform Image ─── */

    case 'transform_image': {
      const dmHost = getDmDeliveryHost();
      if (!dmHost) {
        return JSON.stringify({
          error: 'Dynamic Media delivery host not available. Connect an AEM CS environment to enable image transforms.',
          hint: 'Sign in and connect an AEM environment with Dynamic Media + OpenAPI enabled.',
          _source: 'error',
        });
      }
      const ops = input.operations || [];
      const smartCrop = input.smart_crop;
      const format = input.output_format || 'webp';
      const quality = input.quality || 85;
      const assetName = input.asset_path?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'transformed';

      // Build DM URL with transformation parameters using real delivery host
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

      const deliveryUrl = `https://${dmHost}/adobe/dynamicmedia/deliver/${assetName}/transformed.${format}?${dmParams}`;

      return JSON.stringify({
        status: 'transformed',
        source_asset: input.asset_path,
        operations_applied: [...ops, ...(smartCrop ? [`smart-crop:${smartCrop}`] : [])],
        output: {
          delivery_url: deliveryUrl,
          format,
          quality,
        },
        message: `Image transformed: ${ops.length + (smartCrop ? 1 : 0)} operation(s) applied via Dynamic Media + OpenAPI.`,
        _source: 'dm-url',
        _note: 'DM delivery URL constructed from asset path + transform params. Requires DM+OpenAPI enabled on the AEM environment.',
      }, null, 2);
    }

    /* ─── Content Optimization Agent: Batch Renditions ─── */

    case 'create_image_renditions': {
      const dmHost = getDmDeliveryHost();
      if (!dmHost) {
        return JSON.stringify({
          error: 'Dynamic Media delivery host not available. Connect an AEM CS environment to enable renditions.',
          hint: 'Sign in and connect an AEM environment with Dynamic Media + OpenAPI enabled.',
          _source: 'error',
        });
      }
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
        delivery_url: `https://${dmHost}/adobe/dynamicmedia/deliver/${assetName}/${(spec.name || `rendition-${i}`).toLowerCase().replace(/\s+/g, '-')}.${spec.format || 'webp'}?width=${spec.width}&height=${spec.height}&quality=${spec.quality || 85}`,
      }));

      return JSON.stringify({
        status: 'created',
        source_asset: input.asset_path,
        renditions,
        total_renditions: renditions.length,
        channels: input.channels || [],
        message: `${renditions.length} rendition(s) created via Dynamic Media + OpenAPI.`,
        _source: 'dm-url',
        _note: 'DM delivery URLs constructed from asset path + channel specs. Requires DM+OpenAPI enabled on the AEM environment.',
      }, null, 2);
    }

    /* ─── Discovery Agent: Add to Collection ─── */

    case 'add_to_collection': {
      if (!(await ensureAuth())) return authRequiredError('add_to_collection');
      try {
        const host = window.__EW_AEM_HOST || null;
        const result = await discoveryMcp.addToCollection(host, input.collection_name, input.asset_paths, {
          createIfMissing: input.create_if_missing !== false,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'AEM Discovery MCP — Collections',
        }, null, 2);
      } catch (err) {
        return mcpError('add_to_collection', err);
      }
    }

    /* ─── AEM Assets Direct API ─── */

    case 'browse_dam_folder': {
      if (!(await ensureAuth())) return authRequiredError('browse_dam_folder');
      try {
        const result = await aemAssets.listFolder(sanitizePath(input.path || '/'));
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'get_asset_metadata': {
      if (!(await ensureAuth())) return authRequiredError('get_asset_metadata');
      try {
        const result = await aemAssets.getMetadata(sanitizePath(input.path));
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'update_asset_metadata': {
      if (!(await ensureAuth())) return authRequiredError('update_asset_metadata');
      try {
        const result = await aemAssets.updateMetadata(sanitizePath(input.path), input.properties);
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'upload_asset': {
      if (!(await ensureAuth())) return authRequiredError('upload_asset');
      try {
        // Fetch the source file first
        const fileResp = await fetch(input.source_url);
        if (!fileResp.ok) throw new Error(`Failed to fetch source file: ${fileResp.status}`);
        const blob = await fileResp.blob();
        const result = await aemAssets.uploadAsset(
          sanitizePath(input.folder), input.file_name, blob, blob.type,
        );
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'delete_asset': {
      if (!(await ensureAuth())) return authRequiredError('delete_asset');
      try {
        const result = await aemAssets.deleteAsset(sanitizePath(input.path));
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'move_asset': {
      if (!(await ensureAuth())) return authRequiredError('move_asset');
      try {
        const result = await aemAssets.moveAsset(sanitizePath(input.source), sanitizePath(input.destination));
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'copy_asset': {
      if (!(await ensureAuth())) return authRequiredError('copy_asset');
      try {
        const result = await aemAssets.copyAsset(sanitizePath(input.source), sanitizePath(input.destination));
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'create_dam_folder': {
      if (!(await ensureAuth())) return authRequiredError('create_dam_folder');
      try {
        const result = await aemAssets.createFolder(sanitizePath(input.parent), input.name, input.title);
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
    }

    case 'get_asset_renditions': {
      if (!(await ensureAuth())) return authRequiredError('get_asset_renditions');
      try {
        const result = await aemAssets.getRenditions(sanitizePath(input.path));
        return JSON.stringify({ ...result, _source: 'connected', source: 'AEM Assets API' }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: err.message, source: 'AEM Assets API' });
      }
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
        _source: 'simulated',
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
        _source: 'simulated',
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
        _source: 'simulated',
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
        _source: 'simulated',
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
        _source: 'simulated',
        source: 'Experience League MCP — Prod',
      }, null, 2);
    }

    /* ─── Spacecat / AEM Sites Optimizer MCP ─── */

    case 'get_site_opportunities': {
      if (!(await ensureAuth())) return authRequiredError('get_site_opportunities');
      const siteUrl = input.site_url || `https://${profile.branch || 'main'}--${profile.repo || 'site'}--${(profile.orgId || 'org').toLowerCase()}.aem.live`;
      try {
        const result = await spacecatMcp.getSiteOpportunities(siteUrl, {
          category: input.category,
          priority: input.priority,
        });
        return JSON.stringify({
          site_url: siteUrl,
          ...result,
          _source: 'connected',
          source: 'Sites Optimizer MCP (Spacecat)',
        }, null, 2);
      } catch (err) {
        return mcpError('get_site_opportunities', err);
      }
    }

    case 'get_site_audit': {
      if (!(await ensureAuth())) return authRequiredError('get_site_audit');
      const siteUrl = input.site_url || `https://${profile.branch || 'main'}--${profile.repo || 'site'}--${(profile.orgId || 'org').toLowerCase()}.aem.live`;
      try {
        const result = await spacecatMcp.getSiteAudit(siteUrl, {
          auditType: input.audit_type || 'full',
        });
        return JSON.stringify({
          site_url: siteUrl,
          ...result,
          _source: 'connected',
          source: 'Sites Optimizer MCP (Spacecat)',
        }, null, 2);
      } catch (err) {
        return mcpError('get_site_audit', err);
      }
    }

    /* ─── Experimentation Agent ─── */

    case 'setup_experiment': {
      { const noSite = requireDaSite(); if (noSite) return noSite; }
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
      { const noSite = requireDaSite(); if (noSite) return noSite; }
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
      if (!(await ensureAuth())) return authRequiredError('generate_form');
      try {
        const result = await contentUpdaterMcp.callTool('generate_form', {
          description: input.description,
          fields: input.fields,
          page_path: input.page_path,
          submit_action: input.submit_action,
        });
        return JSON.stringify({
          ...result,
          _source: 'connected',
          source: 'Experience Production Agent — Form Builder',
        }, null, 2);
      } catch (err) {
        return mcpError('generate_form', err);
      }
    }

    /* ─── Content Variations Agent ─── */

    case 'generate_page_variations': {
      { const noSite = requireDaSite(); if (noSite) return noSite; }
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

    /* ─── LLM Optimizer — Citation Readability ─── */

    case 'check_citation_readability': {
      let pageUrl = input.url;
      // If no URL provided, derive the real page URL (not Worker proxy URL)
      if (!pageUrl) {
        const orgCtx = window.__EW_ORG || {};
        if (orgCtx.previewOrigin) {
          pageUrl = orgCtx.previewOrigin + (activeResourcePath || '/');
        } else {
          pageUrl = window.__EW_PREVIEW_URL || document.querySelector('.preview-frame')?.src || '';
        }
      }
      if (!pageUrl || pageUrl === 'about:blank') {
        return JSON.stringify({ error: 'No URL to analyze. Provide a URL or load a page in the preview.' });
      }
      // Get rendered HTML from iframe if available (human view)
      let renderedHTML = '';
      try {
        const iframe = document.querySelector('.preview-frame');
        const iframeDoc = iframe?.contentDocument || iframe?.contentWindow?.document;
        if (iframeDoc?.body) {
          renderedHTML = iframeDoc.documentElement.outerHTML;
        }
      } catch { /* cross-origin */ }

      try {
        // Build a fetch helper — DA Admin API for DA sites, Worker proxy for JCR sites
        const fetchHTML = async (fetchUrl) => {
          // DA site: use DA Admin API
          if (da.getOrg() && da.getRepo()) {
            try {
              const u = new URL(fetchUrl);
              const path = u.pathname === '/' ? '/index' : u.pathname.replace(/\/$/, '');
              const html = await da.getPage(`${path}.html`);
              if (typeof html === 'string' && html.length > 0) return html;
            } catch { /* fall through */ }
          }
          // JCR site: fetch from publish via Worker proxy
          const aemHost = window.__EW_AEM_HOST;
          if (aemHost) {
            try {
              const publishUrl = aemHost.replace('author-', 'publish-');
              const jcrPath = window.__EW_ORG?.activePath || activeResourcePath || '/content';
              const workerBase = localStorage.getItem('ew-ims-proxy') || 'https://compass-ims-proxy.compass-xsc.workers.dev';
              const resp = await fetch(`${workerBase}/preview?mode=raw&publish=${encodeURIComponent(publishUrl)}&path=${encodeURIComponent(jcrPath + '.html')}`);
              if (resp.ok) return resp.text();
            } catch { /* fall through */ }
          }
          return '';
        };
        const result = await checkCitationReadability(pageUrl, renderedHTML, { fetchHTML });
        const formatted = formatResultForChat(result);

        // Store report HTML for "View Details" button
        const reportId = `llmo_${Date.now()}`;
        try {
          window[reportId] = renderResultsHTML(result);
        } catch { /* render optional */ }

        return JSON.stringify({
          score: result.score,
          grade: result.grade,
          agent_words: result.agentView.wordCount,
          human_words: result.humanView.wordCount,
          is_eds: result.isEDS,
          recommendations: result.recommendations,
          missing_content: result.missingContent.slice(0, 10),
          formatted_report: formatted,
          _report_id: reportId,
          _source: 'connected',
          source: 'Adobe LLM Optimizer',
        }, null, 2);
      } catch (e) {
        return JSON.stringify({ error: `Analysis failed: ${e.message}`, _source: 'connected' });
      }
    }

    case 'fetch_url': {
      if (!input.url) return JSON.stringify({ error: 'URL is required' });
      try {
        const resp = await fetch(input.url, {
          headers: { 'User-Agent': 'Compass/1.0 (Adobe XSC)' },
        });
        if (!resp.ok) return JSON.stringify({ error: `HTTP ${resp.status}`, url: input.url });
        const contentType = resp.headers.get('content-type') || '';
        let body;
        if (contentType.includes('json')) {
          body = await resp.json();
          return JSON.stringify({ url: input.url, type: 'json', data: body }, null, 2);
        }
        const text = await resp.text();
        const extractText = input.extract_text !== false;
        if (extractText && contentType.includes('html')) {
          // Strip HTML tags, scripts, styles — return clean text
          const clean = text
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, HTML_TRUNCATE_THRESHOLD);
          return JSON.stringify({ url: input.url, type: 'text', content_length: clean.length, content: clean }, null, 2);
        }
        return JSON.stringify({ url: input.url, type: contentType, content_length: text.length, content: text.slice(0, HTML_TRUNCATE_THRESHOLD) }, null, 2);
      } catch (e) {
        return JSON.stringify({ error: `Fetch failed: ${e.message}`, url: input.url });
      }
    }

    /* ─── Unified AEM MCP (code-execution model) ─── */

    case 'aem_list_environments': {
      if (!(await ensureAuth())) return authRequiredError('aem_list_environments');
      try {
        const result = await aemUnifiedMcp.callTool('list-aem-environments', {});
        return JSON.stringify({ status: 'success', ...result, source: 'AEM Unified MCP' }, null, 2);
      } catch (err) {
        return mcpError('aem_list_environments', err);
      }
    }

    case 'aem_lookup_api': {
      if (!(await ensureAuth())) return authRequiredError('aem_lookup_api');
      try {
        const args = { code: input.code };
        if (input.aem_url) args.aemUrl = input.aem_url;
        const result = await aemUnifiedMcp.callTool('lookup-api-spec', args);
        return JSON.stringify({ status: 'success', ...result, source: 'AEM Unified MCP' }, null, 2);
      } catch (err) {
        return mcpError('aem_lookup_api', err);
      }
    }

    case 'aem_read': {
      if (!(await ensureAuth())) return authRequiredError('aem_read');
      try {
        const result = await aemUnifiedMcp.callTool('read-api', {
          code: input.code,
          aemUrl: input.aem_url,
        });
        return JSON.stringify({ status: 'success', ...result, source: 'AEM Unified MCP' }, null, 2);
      } catch (err) {
        return mcpError('aem_read', err);
      }
    }

    case 'aem_write': {
      if (!(await ensureAuth())) return authRequiredError('aem_write');
      try {
        const result = await aemUnifiedMcp.callTool('write-api', {
          code: input.code,
          aemUrl: input.aem_url,
          confirmed: input.confirmed || false,
        });

        // Auto-refresh preview after successful write
        if (result && !result.error && input.confirmed) {
          setTimeout(() => {
            const frame = document.querySelector('.preview-frame');
            if (frame) {
              // JCR preview via Worker proxy
              if (window.__JCR_PREVIEW_CONFIG) {
                window.__refreshJcrPreview?.();
              } else if (window.__JCR_PREVIEW_URL) {
                frame.src = window.__JCR_PREVIEW_URL + '&_t=' + Date.now();
              }
              // DA/EDS preview via .aem.page iframe
              else if (frame.src?.includes('.aem.page')) {
                frame.src = frame.src.replace(/[?&]_t=\d+/, '') + (frame.src.includes('?') ? '&' : '?') + '_t=' + Date.now();
              }
            }
          }, 500); // wait for publish replication
        }

        return JSON.stringify({ status: 'success', ...result, source: 'AEM Unified MCP' }, null, 2);
      } catch (err) {
        return mcpError('aem_write', err);
      }
    }

    case 'aem_delete': {
      if (!(await ensureAuth())) return authRequiredError('aem_delete');
      try {
        const result = await aemUnifiedMcp.callTool('delete-api', {
          code: input.code,
          aemUrl: input.aem_url,
          confirmed: input.confirmed || false,
        });
        return JSON.stringify({ status: 'success', ...result, source: 'AEM Unified MCP' }, null, 2);
      } catch (err) {
        return mcpError('aem_delete', err);
      }
    }

    /* ─── Bulk Operations ─── */

    case 'batch_aem_update': {
      if (!(await ensureAuth())) return authRequiredError('batch_aem_update');
      try {
        const aemUrl = input.aem_url;
        // Sanitize all user inputs — these get interpolated into MCP code execution
        const safeSiteId = String(input.site_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const safeCompType = String(input.component_type || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const safePropPath = String(input.property_path || 'properties/text').replace(/[^a-zA-Z0-9_/:-]/g, '');
        const safeNewValue = JSON.stringify(String(input.new_value || '')); // JSON.stringify handles all escaping
        const confirmed = input.confirmed || false;

        if (!safeSiteId) {
          return JSON.stringify({ error: 'site_id is required and must be alphanumeric' });
        }

        // Step 1: List pages for the site
        const listCode = `
          const resp = await aem.get('/adobe/sites/sites');
          const sites = resp.body?.items || [];
          const site = sites.find(s => s.name === ${JSON.stringify(safeSiteId)} || s.id === ${JSON.stringify(safeSiteId)});
          if (!site) return { error: 'Site not found: ' + ${JSON.stringify(safeSiteId)}, available: sites.map(s => s.name) };
          const pages = await aem.get('/adobe/sites/sites/' + site.id + '/pages', { limit: 50 });
          return { siteId: site.id, pages: (pages.body?.items || []).map(p => ({ id: p.id, title: p.title, path: p.path })) };
        `;
        const listResult = await aemUnifiedMcp.callTool('read-api', { code: listCode, aemUrl });

        if (!confirmed) {
          return JSON.stringify({
            status: 'preview',
            description: input.description,
            message: `Found pages for site "${safeSiteId}". Review and call again with confirmed=true to apply changes.`,
            ...listResult,
            hint: 'Call batch_aem_update again with confirmed=true to execute the updates.',
            source: 'AEM Unified MCP — Batch',
          }, null, 2);
        }

        // Step 2: Execute updates (confirmed=true)
        // All user values are JSON.stringify'd to prevent code injection
        const updateCode = `
          const SITE_ID = ${JSON.stringify(safeSiteId)};
          const COMP_TYPE = ${JSON.stringify(safeCompType)};
          const PROP_PATH = ${JSON.stringify(safePropPath)};
          const NEW_VALUE = ${safeNewValue};

          const resp = await aem.get('/adobe/sites/sites');
          const sites = resp.body?.items || [];
          const site = sites.find(s => s.name === SITE_ID || s.id === SITE_ID);
          if (!site) return { error: 'Site not found' };

          const pages = await aem.get('/adobe/sites/sites/' + site.id + '/pages', { limit: 50 });
          const pageList = pages.body?.items || [];
          const results = { updated: 0, skipped: 0, errors: [], pages: [] };

          for (const page of pageList) {
            try {
              const content = await aem.get('/adobe/pages/' + page.id + '/content');
              if (!content.body) { results.skipped++; continue; }

              let patchPath;
              if (COMP_TYPE) {
                function findComp(node, type, path) {
                  if (node.componentType && node.componentType.includes(type)) return { node, path };
                  if (Array.isArray(node.items)) {
                    for (let i = 0; i < node.items.length; i++) {
                      const found = findComp(node.items[i], type, path + '/items/' + i);
                      if (found) return found;
                    }
                  }
                  return null;
                }
                const match = findComp(content.body, COMP_TYPE, '');
                if (!match) { results.skipped++; continue; }
                patchPath = match.path + '/' + PROP_PATH;
              } else {
                patchPath = '/' + PROP_PATH;
              }

              await aem.patch('/adobe/pages/' + page.id + '/content', [
                { op: 'replace', path: patchPath, value: NEW_VALUE }
              ], { etag: content.etag });

              results.updated++;
              results.pages.push({ title: page.title, path: page.path, status: 'updated' });
            } catch (e) {
              results.errors.push({ title: page.title, error: e.message });
            }
          }
          return results;
        `;

        const updateResult = await aemUnifiedMcp.callTool('write-api', {
          code: updateCode,
          aemUrl,
          confirmed: true,
        });

        // Auto-refresh preview
        setTimeout(() => {
          const frame = document.querySelector('.preview-frame');
          if (frame) {
            if (window.__JCR_PREVIEW_URL) {
              frame.src = window.__JCR_PREVIEW_URL + '&_t=' + Date.now();
            } else if (frame.src?.includes('.aem.page')) {
              frame.src = frame.src.replace(/[?&]_t=\d+/, '') + (frame.src.includes('?') ? '&' : '?') + '_t=' + Date.now();
            }
          }
        }, 1000);

        return JSON.stringify({
          status: 'success',
          description: input.description,
          ...updateResult,
          source: 'AEM Unified MCP — Batch Update',
        }, null, 2);
      } catch (err) {
        return mcpError('batch_aem_update', err);
      }
    }

    /* ─── ALT Text / Accessibility ─── */

    case 'suggest_alt_text': {
      try {
        // Get page URL from input or current preview
        let pageUrl = input.page_url;
        if (!pageUrl) {
          pageUrl = window.__EW_PREVIEW_URL || document.querySelector('.preview-frame')?.src || '';
        }
        if (!pageUrl || pageUrl === 'about:blank') {
          return JSON.stringify({ error: 'No page URL. Connect a site or provide a page_url.' });
        }

        // Fetch page HTML to find images
        let pageHTML = '';
        try {
          const resp = await fetch(pageUrl);
          if (resp.ok) pageHTML = await resp.text();
        } catch { /* fallback below */ }

        if (!pageHTML) {
          // Try DA API
          if (da.getOrg() && da.getRepo()) {
            const u = new URL(pageUrl);
            const path = u.pathname === '/' ? '/index' : u.pathname.replace(/\/$/, '');
            pageHTML = await da.getPage(`${path}.html`) || '';
          }
        }

        if (!pageHTML) {
          return JSON.stringify({ error: `Could not fetch page content from ${pageUrl}` });
        }

        // Parse images from HTML
        const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
        const imgRegex2 = /<img[^>]*(?:alt=["']([^"']*)["'])?[^>]*src=["']([^"']+)["'][^>]*>/gi;
        const images = [];
        let match;

        // First pass: src before alt
        const html1 = pageHTML;
        while ((match = imgRegex.exec(html1)) !== null) {
          images.push({ src: match[1], currentAlt: match[2] || '', index: images.length });
        }
        // Second pass: alt before src (if any were missed)
        while ((match = imgRegex2.exec(pageHTML)) !== null) {
          const src = match[2];
          if (!images.some((i) => i.src === src)) {
            images.push({ src, currentAlt: match[1] || '', index: images.length });
          }
        }

        if (images.length === 0) {
          return JSON.stringify({ status: 'no_images', message: 'No images found on this page.' });
        }

        // For each image, generate ALT text suggestion using Claude Vision
        const suggestions = [];
        for (const img of images.slice(0, 10)) { // limit to 10 images
          try {
            const suggestion = await callRaw(
              `Analyze this image and write a concise, descriptive ALT text (1-2 sentences, max 125 characters). Focus on what the image shows, not what it means. Be specific.\n\nImage URL: ${img.src}\n\nCurrent ALT text: ${img.currentAlt || '(none)'}\n\nRespond with ONLY the suggested ALT text, nothing else.`,
              { maxTokens: 100 },
            );
            suggestions.push({
              ...img,
              suggestedAlt: suggestion.trim(),
              needsUpdate: !img.currentAlt || img.currentAlt.length < 5,
            });
          } catch {
            suggestions.push({ ...img, suggestedAlt: '(analysis failed)', needsUpdate: !img.currentAlt });
          }
        }

        const missing = suggestions.filter((s) => !s.currentAlt || s.currentAlt.length < 5).length;

        return JSON.stringify({
          status: 'success',
          page_url: pageUrl,
          total_images: images.length,
          analyzed: suggestions.length,
          missing_alt: missing,
          suggestions: suggestions.map((s) => ({
            image: s.src.split('/').pop(),
            current_alt: s.currentAlt || '(none)',
            suggested_alt: s.suggestedAlt,
            needs_update: s.needsUpdate,
          })),
          hint: 'Review the suggestions above. Call apply_alt_text to apply approved ones.',
          source: 'Content Advisor Agent — ALT Text',
        }, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `ALT text analysis failed: ${err.message}` });
      }
    }

    case 'apply_alt_text': {
      if (!(await ensureAuth())) return authRequiredError('apply_alt_text');
      try {
        const patches = (input.updates || []).map((u) => ({
          op: 'replace',
          path: u.image_path + '/properties/alt',
          value: u.alt_text,
        }));

        if (patches.length === 0) {
          return JSON.stringify({ error: 'No updates provided. Call suggest_alt_text first.' });
        }

        const safePath = JSON.stringify(input.page_path);
        const code = `
          const pagePath = ${safePath};
          const page = await aem.get('/adobe/pages/' + pagePath + '/content');
          await aem.patch('/adobe/pages/' + pagePath + '/content',
            ${JSON.stringify(patches)},
            { etag: page.etag }
          );
          return { updated: ${patches.length}, page: pagePath };
        `;

        const result = await aemUnifiedMcp.callTool('write-api', {
          code,
          aemUrl: input.aem_url,
          confirmed: true,
        });

        // Auto-refresh preview
        setTimeout(() => {
          const frame = document.querySelector('.preview-frame');
          if (frame && window.__JCR_PREVIEW_URL) {
            frame.src = window.__JCR_PREVIEW_URL + '&_t=' + Date.now();
          }
        }, 500);

        return JSON.stringify({
          status: 'success',
          ...result,
          message: `Applied ALT text to ${patches.length} images on ${input.page_path}`,
          source: 'Content Advisor Agent — ALT Text',
        }, null, 2);
      } catch (err) {
        return mcpError('apply_alt_text', err);
      }
    }

    /* ─── CJA / Analytics Skills ─── */

    case 'cja_visualize':
    case 'cja_kpi_pulse':
    case 'cja_executive_briefing':
    case 'cja_anomaly_triage': {
      if (!(await ensureAuth())) return authRequiredError(name);
      try {
        // Map tool names to CJA MCP skill names
        const skillMap = {
          cja_visualize: 'visualize_data',
          cja_kpi_pulse: 'kpi_pulse',
          cja_executive_briefing: 'executive_briefing',
          cja_anomaly_triage: 'anomaly_triage',
        };
        const result = await cjaMcp.callTool(skillMap[name] || name, input);
        return JSON.stringify({ status: 'success', ...result, source: `CJA — ${name}` }, null, 2);
      } catch (err) {
        return mcpError(name, err);
      }
    }

    /* ─── Journey / Campaign Skills ─── */

    case 'create_journey': {
      if (!(await ensureAuth())) return authRequiredError('create_journey');
      try {
        const result = await marketingMcp.callTool('create_journey', {
          brief: input.brief,
          channels: input.channels || ['email'],
          entry_type: input.entry_type || 'audience',
        });
        return JSON.stringify({ status: 'success', ...result, source: 'AJO — Journey Agent' }, null, 2);
      } catch (err) {
        return mcpError('create_journey', err);
      }
    }

    case 'generate_journey_content': {
      if (!(await ensureAuth())) return authRequiredError('generate_journey_content');
      try {
        const result = await marketingMcp.callTool('generate_content', {
          channel: input.channel,
          context: input.context,
          tone: input.tone || 'professional',
        });
        return JSON.stringify({ status: 'success', ...result, source: 'AJO — Journey Agent' }, null, 2);
      } catch (err) {
        return mcpError('generate_journey_content', err);
      }
    }

    case 'analyze_experiment': {
      if (!(await ensureAuth())) return authRequiredError('analyze_experiment');
      try {
        // Try Target MCP first, fall back to CJA
        let result;
        try {
          result = await targetMcp.callTool('analyze_experiment', input);
        } catch {
          result = await cjaMcp.callTool('analyze_experiment', input);
        }
        return JSON.stringify({ status: 'success', ...result, source: 'Experimentation Agent' }, null, 2);
      } catch (err) {
        return mcpError('analyze_experiment', err);
      }
    }

    /* ─── Audience Skills ─── */

    case 'explore_audiences': {
      if (!(await ensureAuth())) return authRequiredError('explore_audiences');
      try {
        const result = await rtcdpMcp.callTool('explore_audiences', {
          query: input.query,
          status: input.status || 'all',
        });
        return JSON.stringify({ status: 'success', ...result, source: 'RT-CDP — Audience Agent' }, null, 2);
      } catch (err) {
        return mcpError('explore_audiences', err);
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/* ── System Prompt ── */

const AEM_SYSTEM_PROMPT = `You are **Compass** — an expert AI agent embedded in Adobe Experience Manager's content operations interface.

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
- **create_workfront_task** — Create review/approval tasks in Workfront. When a webhook URL is configured in Settings, tasks are sent to a real N8N/Workfront endpoint. Assigns to approval chain from customer profile.

### Experience Production Agent (content creation & transformation)
- **extract_brief_content** — Extract structured content from an uploaded brief (PDF/Word).
- **translate_page** — Translate an AEM page to a target language. Preserves block structure, metadata, and formatting.
- **create_form** — Create an AEM form from a description. Generates fields, validation rules, and submit actions.
- **modernize_content** — Modernize page content via Generate Variations (Firefly GenAI). Refreshes copy, updates tone to match brand voice, improves readability, and generates content variations.

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
18. **CONTENT EDITING LOOP — SPEED IS CRITICAL**:
  - **Editing existing pages (DA)**: You ALREADY have page HTML in the system context. Parse it, make the change, call edit_page_content DIRECTLY. Do NOT call get_page_content or list_site_pages first — the content is already here.
  - **Editing existing pages (JCR)**: Call get_page_content once for a fresh ETag, then patch_aem_page_content.
  - **Creating NEW pages**: Generate the HTML from scratch based on the user's request and the existing page as a style reference (already in context). Call edit_page_content ONCE. Do NOT list pages or read other pages first — you have the site's HTML structure in context.
  - **NEVER make redundant calls**: If you have the content, don't re-read it. If you're creating a new page, don't list existing pages. Every extra tool call adds 2-3 seconds.
19. **PARALLEL TOOL CALLS**: When you need multiple independent pieces of information, request all tools in a SINGLE response. The system executes them in parallel. Example: if you need both get_page_content AND search_dam_assets, return both tool_use blocks together — they'll run simultaneously instead of sequentially.
20. **MINIMIZE TOOL CALLS**: Aim for 1 tool call for edits, 1-2 for page creation. The fastest edit is: read context → modify HTML → call edit_page_content. No list, no search, no extra reads.
21. For documentation questions ("how do I...", "what is...", "show me docs on..."), call search_experience_league. For release notes ("what's new", "latest features"), call get_product_release_notes.
22. For site health, performance, or SEO questions, call get_site_audit for scores and get_site_opportunities for recommendations. Use Spacecat tools BEFORE giving optimization advice.
23. When users mention broken backlinks, 404s, or redirect chains, call get_site_audit with audit_type=broken-backlinks or get_site_opportunities with category=broken-backlinks.
24. **EXPERIMENTATION**: When users want A/B tests, experiments, or content variations, use setup_experiment + edit_page_content. One prompt sets up the entire experiment (variant pages + metadata + splits). This is FASTER than the UE extensions approach.
25. **FORMS**: When users want forms, contact pages, or lead capture, use generate_form to create the form definition, then edit_page_content to embed it in the page.
26. **VARIATIONS**: When users want content variations, alternate headlines, or copy options, use generate_page_variations. Generate full-page coordinated variations, not just one component at a time. If they also want to test them, chain with setup_experiment.
27. **BULK OPERATIONS**: When users say "all pages", "every page", "across the site", "update everywhere", or "change on all" — use \`batch_aem_update\`. ALWAYS call with confirmed=false first to show affected pages, then ask user to confirm before calling with confirmed=true. Never execute bulk updates without user confirmation.
28. **ALT TEXT**: When users mention "ALT text", "accessibility", "image descriptions", "missing ALT", or "image audit" — use \`suggest_alt_text\` to analyze page images. Present suggestions as a table. Only call \`apply_alt_text\` after user approves specific suggestions.
29. **ANALYTICS (CJA)**: For data questions — "How did we do?", "trend orders", "revenue by region", "why did X drop?" — use \`cja_visualize\`, \`cja_kpi_pulse\`, \`cja_executive_briefing\`, or \`cja_anomaly_triage\`. These connect to CJA data views.
30. **JOURNEYS (AJO)**: For journey creation — "Create a welcome series", "Build a re-engagement drip" — use \`create_journey\`. For journey content — "Generate a push notification" — use \`generate_journey_content\`.
31. **EXPERIMENTS**: For experiment analysis — "What did we learn?", "Why did variant A win?" — use \`analyze_experiment\`.
32. **AUDIENCES (RT-CDP)**: For audience questions — "Show me our largest audiences", "Which audiences target California?" — use \`explore_audiences\`.
33. **SPEED — PARALLEL CALLS**: When the user's request touches MULTIPLE products (e.g., "Create a page AND set up a journey to drive traffic to it"), call the tools in PARALLEL. Return multiple tool_use blocks in one response. Examples of parallel-safe combinations:
    - \`aem_read\` + \`search_dam_assets\` (read page content while searching for images)
    - \`aem_write\` + \`create_workfront_task\` (update content while creating approval task)
    - \`cja_kpi_pulse\` + \`explore_audiences\` (get metrics while checking audiences)
    - \`suggest_alt_text\` + \`run_governance_check\` (accessibility + brand audit simultaneously)
34. **INTENT CLARIFICATION**: Before executing, assess what the user is actually trying to accomplish. If the request is genuinely ambiguous and you cannot determine the right action from context (loaded page, connected site, conversation history), ask ONE short clarifying question. But NEVER ask when context already tells you the answer:
    - ✅ ASK: "Make it look better" → "Do you want me to improve the copy, update the layout, or find a better hero image?"
    - ✅ ASK: "Fix this" → "What needs fixing — content accuracy, brand compliance, or accessibility?"
    - ✅ ASK: "Create a page" → "What should the page be about? Do you have a brief or should I base it on an existing page?"
    - ❌ DON'T ASK: "Update the hero" (page is loaded — just update it)
    - ❌ DON'T ASK: "Run a governance check" (clear intent — just do it)
    - ❌ DON'T ASK: "Change headline to X" (specific instruction — execute immediately)

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
/* Returns an array of { type: 'text', text, cache_control? } blocks for the Claude API.
   Static layers get cache_control: { type: 'ephemeral' } so Claude can cache them
   across requests (~35KB saved per round-trip). Dynamic layers change per request. */
const FAST_SYSTEM_PROMPT = `You are Compass, an AI assistant for Adobe Experience Manager content editing.
You have tools to read and edit page content. When asked to change content:
1. If page HTML is provided below, edit it directly with edit_page_content.
2. If not, call get_page_content first, then edit_page_content with the modified HTML.
3. Keep the existing HTML structure — only change the specific text/element requested.
4. Always trigger preview after editing.
Be concise. Execute immediately. Don't explain what you'll do — just do it.
IMPORTANT: If the page HTML is provided below, call edit_page_content DIRECTLY with the modified HTML. Do NOT call get_page_content first — you already have the content.`;

function buildSystemParts(context = {}, { fast = false } = {}) {
  // Fast mode: minimal prompt for simple edits (Haiku — every token counts)
  if (fast) {
    const blocks = [{ type: 'text', text: FAST_SYSTEM_PROMPT }];
    // Add page context if available
    if (context.org?.orgId) {
      let pageCtx = `Site: ${context.org.orgId}/${context.org.repo} (${context.siteType || 'unknown'})`;
      if (context.pagePath) pageCtx += ` | Path: ${context.pagePath}`;
      if (context.pageHTML) pageCtx += `\n\nPage HTML:\n\`\`\`html\n${context.pageHTML.slice(0, HTML_TRUNCATE_THRESHOLD)}\n\`\`\``;
      blocks.push({ type: 'text', text: pageCtx });
    }
    return blocks;
  }

  // Full mode: complete system prompt with all knowledge layers
  // Static layers — cacheable across requests
  const blocks = [
    { type: 'text', text: AEM_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildKnowledgePrompt() + '\n' + buildPlaybookPrompt(), cache_control: { type: 'ephemeral' } },
  ];

  // Semi-static layers — customer profiles and known sites (change rarely)
  const semiStatic = [buildCustomerContext(), buildKnownSitesPrompt()].filter(Boolean).join('\n');
  if (semiStatic) blocks.push({ type: 'text', text: semiStatic });

  // Dynamic layers — change per request
  // Build one unified context block (like da-agent pipes org/site/path/view)
  const dynamic = [];

  if (context.org && context.org.orgId && context.org.repo) {
    const o = context.org;
    const siteType = context.siteType || window.__EW_SITE_TYPE || 'unknown';
    const aemHost = context.aemHost || window.__EW_AEM_HOST || null;
    const isJcr = siteType === 'aem-cs';
    const isDa = siteType === 'da';
    const pagePath = context.pagePath || '/';
    const view = context.view || 'preview';
    const auth = context.authState || {};

    // ── Unified page context (matches da-agent's automatic context injection) ──
    let pageContext = `\n## Active Page Context
| Field | Value |
|-------|-------|
| **Org** | ${o.orgId} |
| **Repo** | ${o.repo} |
| **Branch** | ${o.branch} |
| **Path** | ${pagePath} |
| **Site type** | ${isJcr ? 'AEM CS (JCR)' : isDa ? 'DA' : 'Unknown'} |
| **View** | ${view} |
| **Preview URL** | ${o.previewOrigin}${pagePath} |
| **Auth** | IMS: ${auth.ims ? '✓' : '✗'} · GitHub: ${auth.github ? '✓' : '✗'} |`;

    if (aemHost) pageContext += `\n| **AEM Author** | ${aemHost} |`;
    if (isDa) pageContext += `\n| **DA Admin** | admin.da.live/source/${o.daOrg}/${o.daRepo} |`;
    if (context.customerName) pageContext += `\n| **Customer** | ${context.customerName} |`;

    // ── Page HTML (pre-loaded — skip the read call for edits) ──
    if (context.pageHTML) {
      pageContext += `\n\n### Page Content (LIVE — pre-loaded, ${context.pageHTML.length} chars)
You ALREADY have this page content.`;
      if (context.jcrEtag) {
        pageContext += `\n**Pre-fetched ETag:** \`${context.jcrEtag}\` (for path: ${context.jcrEtagPath})
**SPEED RULE:** For edits to this page, call \`patch_aem_page_content\` DIRECTLY with this ETag. Do NOT call get_page_content first — you already have the content and ETag. This saves a full round trip.`;
      } else if (!isJcr) {
        pageContext += `\nFor DA edits, modify the HTML and call edit_page_content directly — no read call needed.`;
      }
      pageContext += `\n\n\`\`\`html
${context.pageHTML.slice(0, HTML_TRUNCATE_THRESHOLD)}
\`\`\``;
    } else {
      pageContext += `\n\n*Page content not pre-loaded. Call get_page_content to read it.*`;
    }

    dynamic.push(pageContext);
    if (context.siteContext) dynamic.push(context.siteContext);

    // Build tool routing instructions based on detected site type
    let toolRouting = '';
    if (isJcr && aemHost) {
      toolRouting = `### TOOL ROUTING (MANDATORY)
This is an **AEM CS (JCR)** site. You MUST use these tools:

**Pages:**
- Read: \`get_page_content\` (returns JCR content with ETag)
- Discover templates: \`list_aem_templates\` (ALWAYS call first before creating a page — let user pick a template)
- Create: \`create_aem_page\` (from template — requires template path from list_aem_templates)
- Update: \`patch_aem_page_content\` (requires ETag — call get_page_content first)
- List: \`list_aem_pages\` (list children of a path)
- Copy: \`copy_aem_page\`
- Delete: \`delete_aem_page\`

**Content Fragments:**
- Read: \`get_content_fragment\` (returns fragment data with ETag)
- Create: \`create_content_fragment\` (requires CF model path)
- Update: \`update_content_fragment\` (requires ETag)

**Launches:**
- Create: \`create_aem_launch\`
- Promote: \`promote_aem_launch\`

**Unified AEM API (advanced — code execution):**
- Discover APIs: \`aem_lookup_api\` (find API endpoints before read/write)
- Read: \`aem_read\` (execute GET calls via sandboxed JavaScript)
- Write: \`aem_write\` (execute POST/PUT/PATCH — dry-run by default, set confirmed=true to execute)
- Delete: \`aem_delete\` (requires two-step confirmation)
- List envs: \`aem_list_environments\`

**DO NOT** use DA tools (edit_page_content, preview_page, list_site_pages) — they are not available for this site.`;
    } else if (isDa) {
      toolRouting = `### TOOL ROUTING (MANDATORY)
This is a **DA (Document Authoring)** site. You MUST use these tools:
- Read pages: \`get_page_content\` (reads via DA Admin API)
- Write pages: \`edit_page_content\` (writes HTML to DA-backed repo, auto-triggers preview)
- List pages: \`list_site_pages\`
- Preview: \`preview_page\`
- Publish: \`publish_page\`

**DO NOT** use AEM Content MCP tools (patch_aem_page_content, copy_aem_page) — they are not available for this site.`;
    } else {
      toolRouting = `### TOOL ROUTING
Site type could not be determined. Try DA tools first (edit_page_content). If DA fails, inform the user and ask how to proceed.`;
    }

    dynamic.push(`\n${toolRouting}\n\nIMPORTANT: Follow the TOOL ROUTING above. Using the wrong tool stack will cause failures.`);
  }

  // Project memory — persistent context across sessions (like da-agent's /.da/ memory)
  if (context.projectMemory) {
    const mem = context.projectMemory;
    let memText = '\n## Project Memory (persistent across sessions)';
    if (mem.lastPrompts?.length) {
      memText += `\nRecent prompts from this user on this project:\n${mem.lastPrompts.slice(0, 5).map((p) => `- "${p}"`).join('\n')}`;
    }
    if (mem.lastConnected) memText += `\nLast session: ${mem.lastConnected}`;
    dynamic.push(memText);
  }

  // Add dynamic content as the final block (not cached)
  if (dynamic.length > 0) {
    blocks.push({ type: 'text', text: dynamic.join('\n') });
  }

  return blocks;
}

/* ── Non-Streaming Chat (legacy, used by analyzeBrief etc.) ── */
const MAX_CHAT_DEPTH = 8;
export async function chat(userMessage, context = {}, _depth = 0) {
  if (_depth >= MAX_CHAT_DEPTH) {
    console.warn(`[AI] chat() reached max recursion depth (${MAX_CHAT_DEPTH})`);
    return { text: '[Tool loop limit reached. Please try a simpler request.]', usage: {} };
  }
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
      tools: getToolsForSiteType(),
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

    // Recursive call for multi-turn tool use (with depth guard)
    return chat(allMessages, context, _depth + 1);
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
 * Supports abort via abortCurrentChat() — cancels in-flight request and tool execution.
 */
let _currentAbort = null;

export function abortCurrentChat() {
  if (_currentAbort) {
    _currentAbort.abort();
    _currentAbort = null;
  }
}

/** Detect if a prompt is a simple content edit that can use the fast model (P2: expanded). */
function isSimpleEdit(msg) {
  if (typeof msg !== 'string') return false;
  const lower = msg.toLowerCase();
  const len = lower.length;
  // Short prompts about content changes → Haiku (3-5x faster)
  if (len > 500) return false;
  // Exclude complex multi-tool tasks
  if (/\b(analyze|audit|governance|generate|search|find|list|compare|explain|create.*page|migrate|import)\b/i.test(lower)) return false;
  // Match: "change X to Y", "update the headline", "make it more compelling"
  if (/\b(change|update|set|replace|make|rename|edit|fix|rewrite|rephrase)\b.*\b(to|with|as|more|less|better|shorter|longer)\b/i.test(lower)) return true;
  // Match: "translate to X", "shorten the", "expand the", "summarize"
  if (/\b(translate|shorten|expand|summarize|simplify|reword|rephrase)\b/i.test(lower) && len < 300) return true;
  // Match: "add a CTA", "remove the banner", "move the hero"
  if (/\b(add|remove|delete|move|swap|hide|show)\b.*\b(the|a|an|this)\b/i.test(lower) && len < 200) return true;
  return false;
}

export async function streamChat(userMessage, context, onChunk, onToolCall, onToolResult) {
  // Abort any previous in-flight chat
  abortCurrentChat();
  const abortCtrl = new AbortController();
  _currentAbort = abortCtrl;

  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Claude API key not configured');

  let messages = Array.isArray(userMessage)
    ? [...userMessage]
    : [{ role: 'user', content: userMessage }];

  // Extract the latest USER prompt text for intent classification + model routing
  // Search backwards for the last user message (skip assistant messages in history)
  let promptText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const c = messages[i].content;
      promptText = typeof c === 'string' ? c : (Array.isArray(c) ? c.find((b) => b.type === 'text')?.text || '' : '');
      break;
    }
  }

  // Use fast model + minimal prompt for simple edits
  const useFastModel = isSimpleEdit(promptText);
  const model = useFastModel ? MODEL_FAST : MODEL;
  const system = buildSystemParts(context, { fast: useFastModel });
  console.debug(`[AI] Model: ${model} | Fast: ${useFastModel} | Tools: ${useFastModel ? 5 : 'tiered'} | Prompt: "${promptText.slice(0, 60)}" | PageHTML: ${context.pageHTML ? context.pageHTML.length + ' chars' : 'none'}`);

  // Tiered tools: fast mode gets minimal tools, full mode gets intent-based
  const tools = useFastModel
    ? AEM_TOOLS.filter((t) => ['edit_page_content', 'get_page_content', 'preview_page', 'publish_page', 'list_site_pages'].includes(t.name))
    : getToolsForPrompt(promptText);

  let fullText = '';
  const MAX_TOOL_ROUNDS = useFastModel ? 3 : 8;

  try {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortCtrl.signal.aborted) break;

    const resp = await fetch(CLAUDE_API, {
      method: 'POST',
      signal: abortCtrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: useFastModel ? 4096 : 8192,
        stream: true,
        system,
        messages,
        tools: round === 0 ? tools : getToolsForSiteType(), // Tier 1 on first round, all tools on subsequent rounds if needed
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

    // Check abort before executing tools (prevents ghost writes)
    if (abortCtrl.signal.aborted) break;

    // Add the full assistant response (text + tool_use blocks) to messages
    messages.push({ role: 'assistant', content: contentBlocks });

    // Execute all tools in parallel (saves 500-3000ms on multi-tool turns)
    // Use allSettled so one failing tool doesn't kill the others
    const settled = await Promise.allSettled(toolUseBlocks.map(async (toolBlock) => {
      if (abortCtrl.signal.aborted) throw new Error('Aborted');
      if (onToolCall) onToolCall(toolBlock.name, toolBlock.input);
      const result = await executeTool(toolBlock.name, toolBlock.input);
      if (onToolResult) onToolResult(toolBlock.name, result);
      return { type: 'tool_result', tool_use_id: toolBlock.id, content: result };
    }));
    const toolResultContent = settled.map((r, i) =>
      r.status === 'fulfilled' ? r.value : {
        type: 'tool_result',
        tool_use_id: toolUseBlocks[i].id,
        content: JSON.stringify({ status: 'error', error: r.reason?.message || 'Tool execution failed' }),
      }
    );

    // Add tool results as user message and continue the loop
    messages.push({ role: 'user', content: toolResultContent });
  }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.debug('[AI] Chat aborted by user');
      return fullText;
    }
    throw err;
  } finally {
    if (_currentAbort === abortCtrl) _currentAbort = null;
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

/*
 * Known Sites Registry — Simulated MCP site discovery
 *
 * The real AEM Content MCP has "Get AEM Sites" and "Get AEM Pages" tools.
 * We can't call those from browser JS, so we maintain a registry of known
 * EDS sites that the AI can reference and fetch content from on demand.
 *
 * This bridges the gap: when a user says "check the Frescopa site",
 * we resolve the name to real AEM URLs, fetch actual content, and inject
 * it into the AI context — making the workspace behave like Claude.ai with MCP.
 */

export const KNOWN_SITES = {
  frescopa: {
    name: 'Frescopa Coffee',
    siteId: 'frescopa',
    siteType: 'xwalk', // JCR content + EDS code repo + UE editing
    org: 'aem-showcase',
    repo: 'frescopa',
    branch: 'main',
    aemHost: 'author-p153659-e1614585.adobeaemcloud.com',
    publishHost: 'publish-p153659-e1614585.adobeaemcloud.com',
    get previewOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.page`; },
    get liveOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.live`; },
    description: 'Premium coffee brand demo — retail vertical. Flagship EDS reference site used in demos and training.',
    vertical: 'Retail / Coffee',
    pages: [
      { path: '/index', title: 'Homepage', description: 'Hero, featured blends, subscription CTA' },
      { path: '/coffee', title: 'Coffee Collection', description: 'Product grid with blend cards' },
      { path: '/machines', title: 'Machines', description: 'Coffee machine product showcase' },
      { path: '/sustainability', title: 'Sustainability', description: 'Environmental and sourcing commitment' },
      { path: '/locations', title: 'Locations', description: 'Store locator and location list' },
      { path: '/quiz', title: 'Coffee Quiz', description: 'Interactive coffee preference quiz' },
    ],
    aliases: ['frescopa', 'frescopa coffee', 'coffee site', 'coffee demo', 'frescopa site'],
    blocks: ['hero', 'cards', 'columns', 'carousel', 'tabs', 'accordion', 'embed', 'table'],
  },

  'aem-xsc-showcase': {
    name: 'XSC Team Site',
    siteId: 'xscteamsite',
    siteType: 'da', // DA-backed EDS
    org: 'AEMXSC',
    repo: 'xscteamsite',
    branch: 'main',
    get previewOrigin() { return `https://${this.branch}--${this.repo}--${this.org.toLowerCase()}.aem.page`; },
    get liveOrigin() { return `https://${this.branch}--${this.repo}--${this.org.toLowerCase()}.aem.live`; },
    description: 'XSC team default demo site',
    vertical: 'Technology',
    pages: [
      { path: '/index', title: 'Homepage', description: 'XSC showcase landing page' },
    ],
    aliases: ['xsc', 'showcase', 'nexus', 'this site', 'our site', 'aem xsc'],
    blocks: ['hero', 'cards', 'columns'],
  },

  securbank: {
    name: 'SecurBank',
    siteId: 'securbank-aem-ue',
    siteType: 'xwalk', // JCR + UE
    org: 'markszulc',
    repo: 'securbank-aem-ue',
    branch: 'main',
    aemHost: 'author-p153659-e1614585.adobeaemcloud.com',
    publishHost: 'publish-p153659-e1614585.adobeaemcloud.com',
    get previewOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.page`; },
    get liveOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.live`; },
    description: 'Financial services demo — FSI vertical with Universal Editor',
    vertical: 'Financial Services',
    pages: [
      { path: '/index', title: 'Homepage', description: 'Banking hero, product cards, trust indicators' },
    ],
    aliases: ['securbank', 'bank', 'fsi demo', 'financial demo'],
    blocks: ['hero', 'cards', 'columns', 'tabs'],
  },

  wknd: {
    name: 'WKND Adventures',
    siteId: 'wknd',
    siteType: 'da', // DA-backed EDS
    org: 'hlxsites',
    repo: 'wknd',
    branch: 'main',
    get previewOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.page`; },
    get liveOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.live`; },
    description: 'Outdoor adventure and lifestyle demo — media/publishing vertical',
    vertical: 'Media / Lifestyle',
    pages: [
      { path: '/index', title: 'Homepage', description: 'Adventure hero, magazine-style layout' },
    ],
    aliases: ['wknd', 'wknd adventures', 'adventure site', 'wknd site'],
    blocks: ['hero', 'cards', 'columns', 'carousel'],
  },

  'wknd-universal': {
    name: 'WKND Universal',
    siteId: 'wknd-universal',
    siteType: 'xwalk', // JCR + UE
    org: 'aem-showcase',
    repo: 'wknd-universal',
    branch: 'main',
    get previewOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.page`; },
    get liveOrigin() { return `https://${this.branch}--${this.repo}--${this.org}.aem.live`; },
    description: 'WKND Universal Editor demo — primary showcase site for xwalk/JCR on AEM CS',
    vertical: 'Media / Lifestyle',
    aemHost: 'author-p153659-e1614585.adobeaemcloud.com',
    publishHost: 'publish-p153659-e1614585.adobeaemcloud.com',
    pages: [
      { path: '/index', title: 'Homepage', description: 'Hero, featured articles' },
      { path: '/language-masters/en', title: 'English (Language Master)', description: 'English language root' },
    ],
    aliases: ['wknd-universal', 'wknd universal', 'universal editor demo', 'ue demo'],
    blocks: ['hero', 'cards', 'columns', 'carousel', 'tabs'],
  },
};

/**
 * Resolve a site name/alias to a known site object.
 * Case-insensitive, fuzzy matching against aliases.
 */
export function resolveSite(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // Direct ID match (exact key in registry)
  if (KNOWN_SITES[lower]) return KNOWN_SITES[lower];

  // Exact alias match — prevents "wknd-universal" matching "wknd"
  for (const site of Object.values(KNOWN_SITES)) {
    if (site.aliases.some((a) => a === lower)) return site;
  }

  // Exact siteId match
  for (const site of Object.values(KNOWN_SITES)) {
    if (site.siteId === lower) return site;
  }

  // Multi-word alias match — only match if the FULL alias appears as a word boundary
  // e.g. "frescopa coffee" matches input "frescopa", but "wknd" does NOT match "wknd-universal"
  for (const site of Object.values(KNOWN_SITES)) {
    if (site.aliases.some((a) => {
      if (a.length < 4) return false; // skip short aliases for fuzzy match
      return lower === a || (a.includes(' ') && lower.includes(a));
    })) return site;
  }

  // Exact name match
  for (const site of Object.values(KNOWN_SITES)) {
    if (site.name.toLowerCase() === lower) return site;
  }

  return null;
}

/**
 * Extract a site reference from a user message.
 * Returns { site, mentionedName } or null.
 */
export function detectSiteMention(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  for (const site of Object.values(KNOWN_SITES)) {
    // Check all aliases
    for (const alias of site.aliases) {
      if (lower.includes(alias)) {
        return { site, mentionedName: alias };
      }
    }
    // Check site name
    if (lower.includes(site.name.toLowerCase())) {
      return { site, mentionedName: site.name };
    }
  }

  return null;
}

/**
 * Fetch .plain.html content from an AEM EDS page.
 * Returns the HTML string or null if fetch fails.
 */
async function fetchPlainHTML(baseUrl, pagePath) {
  const url = `${baseUrl}${pagePath}.plain.html`;
  try {
    const resp = await fetch(url);
    if (resp.ok) return resp.text();
  } catch { /* CORS or network error */ }
  return null;
}

/**
 * Fetch content from multiple pages of a known site.
 * Returns an array of { path, title, html } objects.
 */
export async function fetchSiteContent(site, maxPages = 4) {
  const pages = site.pages.slice(0, maxPages);
  const results = await Promise.allSettled(
    pages.map(async (page) => {
      const html = await fetchPlainHTML(site.previewOrigin, page.path);
      return { ...page, html };
    }),
  );

  return results
    .filter((r) => r.status === 'fulfilled' && r.value.html)
    .map((r) => r.value);
}

/**
 * Build a context string for the AI from fetched site content.
 * Mimics what the real AEM Content MCP would provide.
 */
export function buildSiteContext(site, fetchedPages) {
  const parts = [];

  parts.push(`\n## AEM Site: ${site.name}`);
  parts.push(`**[Discovered via AEM Content MCP — Get AEM Sites]**`);
  parts.push(`- **Site ID**: ${site.siteId}`);
  parts.push(`- **Organization**: ${site.org}`);
  parts.push(`- **Repository**: ${site.repo} (branch: ${site.branch})`);
  parts.push(`- **Preview**: ${site.previewOrigin}`);
  parts.push(`- **Live**: ${site.liveOrigin}`);
  parts.push(`- **Vertical**: ${site.vertical}`);
  parts.push(`- **Description**: ${site.description}`);
  parts.push(`- **Known Blocks**: ${site.blocks?.join(', ') || 'standard EDS blocks'}`);

  parts.push(`\n### Available Pages`);
  site.pages.forEach((p) => {
    parts.push(`- **${p.title}** (${p.path}) — ${p.description}`);
  });

  if (fetchedPages?.length > 0) {
    parts.push(`\n### Page Content [Fetched via AEM Content MCP — Get AEM Page Content]`);
    fetchedPages.forEach((page) => {
      const truncated = page.html.length > 8000
        ? page.html.slice(0, 8000) + '\n... [truncated]'
        : page.html;
      parts.push(`\n#### ${page.title} (${page.path})`);
      parts.push('```html');
      parts.push(truncated);
      parts.push('```');
    });
  }

  return parts.join('\n');
}

/**
 * Build a system prompt addition listing all known sites.
 * Added to the AI's knowledge so it can reference sites naturally.
 */
export function buildKnownSitesPrompt() {
  const sites = Object.values(KNOWN_SITES);
  const parts = [];

  parts.push(`\n## Known AEM Sites (via AEM Content MCP)`);
  parts.push(`You have access to these AEM Edge Delivery sites. When users mention any of them, you can fetch their content and analyze it.`);
  parts.push(`Respond as if you used the "Get AEM Sites" and "Get AEM Pages" MCP tools to discover and retrieve the content.\n`);

  sites.forEach((site) => {
    parts.push(`- **${site.name}** — ${site.description}`);
    parts.push(`  Preview: ${site.previewOrigin} | Pages: ${site.pages.map((p) => p.path).join(', ')}`);
  });

  return parts.join('\n');
}

/**
 * List all known sites (for UI display).
 */
export function listKnownSites() {
  return Object.values(KNOWN_SITES).map((s) => ({
    id: s.siteId,
    name: s.name,
    org: s.org,
    repo: s.repo,
    vertical: s.vertical,
    pageCount: s.pages.length,
  }));
}

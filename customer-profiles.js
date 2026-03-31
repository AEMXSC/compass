/*
 * Customer Profile System — Dynamic org-specific context injection
 *
 * Each profile contains everything the AI needs to act as a customer-specific agent:
 * brand voice, segment names, approval chains, legal SLAs, DAM taxonomy, etc.
 *
 * This is Differentiator #1 — the native agents' biggest gap.
 * Princess Cruises has different rules than Wells Fargo than Ralph Lauren.
 * We inject it the same day. The native agent gets a product release — maybe in Q3.
 */

const STORAGE_KEY = 'ew-active-profile';

export const PROFILES = {

  /* ── XSC Team Site (default demo) ── */
  'aem-xsc': {
    id: 'aem-xsc',
    name: 'XSC Team Site',
    logoUrl: '',
    orgId: 'AEMXSC',
    repo: 'xscteamsite',
    branch: 'main',
    tier: 'AEM CS + EDS',
    env: 'Prod (VA7)',
    services: ['EDS', 'Assets Content Hub', 'Sites', 'Forms'],
    vertical: 'Technology',

    brandVoice: {
      tone: 'Technical, confident, forward-looking',
      keywords: ['agentic', 'orchestration', 'content supply chain', 'experience production'],
      avoided: ['simple', 'easy', 'just'],
      style: 'Authoritative enterprise tech — short sentences, active voice, quantified claims',
    },

    segments: [
      { name: 'Enterprise AEM Customers', id: 'ent-aem', description: 'Existing AEM CS customers exploring EDS migration' },
      { name: 'Greenfield EDS', id: 'greenfield', description: 'New customers starting directly with Edge Delivery' },
      { name: 'Move-to-Cloud', id: 'mtc', description: 'AEM 6.5 customers migrating to Cloud Service' },
    ],

    approvalChain: [
      { role: 'Content Author', action: 'Create/edit content' },
      { role: 'Content Lead', action: 'Review & approve content' },
      { role: 'Brand Manager', action: 'Brand compliance sign-off' },
      { role: 'Legal', action: 'Legal review (if flagged)', sla: '48h' },
      { role: 'Publisher', action: 'Publish to .live' },
    ],

    legalSLA: { reviewTime: '48h', escalation: '72h', autoApprove: false },

    damTaxonomy: {
      root: '/content/dam/aem-xsc',
      folders: ['hero-images', 'icons', 'team-photos', 'logos'],
      namingConvention: 'kebab-case, descriptive, includes dimensions',
    },

    aepOrgId: '708E423B67F3C2050A495C27@AdobeOrg',
    aepSandbox: 'prod',

    /* ── Real MCP Connectors (matches Admin Console + discovered endpoints) ── */
    connectors: [
      { name: 'Acrobat MCP', env: 'Prod', type: 'CUSTOM', status: 'live', endpoint: 'acrobat-mcp.adobe.io/mcp/call' },
      { name: 'Adobe Analytics MCP', env: 'Prod', type: 'CUSTOM', status: 'live' },
      { name: 'Adobe CJA MCP', env: 'Prod', type: 'CUSTOM', status: 'live' },
      { name: 'Adobe Express MCP', env: 'Dev', type: 'CUSTOM', status: 'live' },
      { name: 'Adobe Express MCP', env: 'Prod', type: 'CUSTOM', status: 'live' },
      { name: 'Adobe Express MCP', env: 'Stage', type: 'CUSTOM', status: 'live' },
      { name: 'Adobe Illustrator MCP', env: 'Stage', type: 'CUSTOM', status: 'live' },
      { name: 'Adobe Marketing Agent MCP', env: 'Prod', type: 'CUSTOM', status: 'live' },
      { name: 'Adobe MCP', env: 'Stage', type: 'CUSTOM', status: 'live' },
      { name: 'AEM Content', env: 'Prod', type: 'CUSTOM', status: 'live' },
      { name: 'AEM DA', env: 'Prod', type: 'CUSTOM', status: 'live' },
      { name: 'AEM Odin', env: 'Prod', type: 'CUSTOM', status: 'live' },
      { name: 'AEP Destinations MCP', env: 'Prod', type: 'CUSTOM', status: 'live', endpoint: 'aep-destinations-mcp.adobe.io/mcp' },
      { name: 'Experience League MCP', env: 'Prod', type: 'CUSTOM', status: 'live', endpoint: 'exl-ia-mcp-service.ethos55-prod-va7.ethos.adobe.net/mcp' },
      { name: 'Spacecat Sites Optimizer MCP', env: 'Prod', type: 'CUSTOM', status: 'live', endpoint: 'spacecat.experiencecloud.live/api/v1/mcp' },
      { name: 'GitHub Integration', env: 'Prod', type: 'NATIVE', status: 'live' },
    ],

    entitlements: {
      acrobat: { name: 'Acrobat MCP', mcp: 'Acrobat MCP - Prod', status: 'live', endpoint: 'acrobat-mcp.adobe.io/mcp/call', note: 'PDF extract, merge, convert via MCP — Prod endpoint live' },
      aa: { name: 'Adobe Analytics', mcp: 'Adobe Analytics MCP - Prod', status: 'live', endpoint: 'mcp-gateway.adobe.io/aa/mcp', note: 'Connected via MCP Gateway' },
      cja: { name: 'Customer Journey Analytics', mcp: 'Adobe CJA MCP - Prod', status: 'live', endpoint: 'mcp-gateway.adobe.io/cja/mcp', note: 'Connected via MCP Gateway' },
      express: { name: 'Adobe Express', mcp: 'Adobe Express MCP - Prod', status: 'live', note: 'Creative generation, templates, brand kit' },
      illustrator: { name: 'Adobe Illustrator', mcp: 'Adobe Illustrator MCP - Stage', status: 'live', note: 'Vector generation and editing' },
      marketingAgent: { name: 'Adobe Marketing Agent', mcp: 'Adobe Marketing Agent MCP', status: 'live', note: 'AJO journey orchestration, campaign management' },
      aep: { name: 'Adobe Experience Platform', mcp: 'AEP MCP', status: 'live', endpoint: 'platform.adobe.io/data/core/ups/segment/definitions', note: 'Segment API live — Prod (VA7)' },
      target: { name: 'Adobe Target', mcp: 'Target MCP', status: 'active', note: 'Experience decisioning' },
      aemContent: { name: 'AEM Content', mcp: 'AEM Content - Prod', status: 'live', note: 'Content read/write, launches, fragments' },
      aemDA: { name: 'AEM DA', mcp: 'AEM DA - Prod', status: 'live', note: 'Document Authoring — real read/write/preview/publish via admin.da.live' },
      aemOdin: { name: 'AEM Odin', mcp: 'AEM Odin Prod', status: 'live', note: 'AEM Sites management and authoring' },
      destinations: { name: 'AEP Destinations', mcp: 'AEP Destinations MCP - Prod', status: 'live', endpoint: 'aep-destinations-mcp.adobe.io/mcp', note: 'Destination data flows, health monitoring, activation status — MVP read-only (13 tools)' },
      exl: { name: 'Experience League MCP', mcp: 'Experience League MCP - Prod', status: 'live', endpoint: 'exl-ia-mcp-service.ethos55-prod-va7.ethos.adobe.net/mcp', note: 'Doc search, tutorials, release notes — Experience Cloud product docs for AI tools' },
      sitesOptimizer: { name: 'Sites Optimizer (Spacecat)', mcp: 'Spacecat Sites Optimizer MCP - Prod', status: 'live', endpoint: 'spacecat.experiencecloud.live/api/v1/mcp', note: 'Site audit, SEO opportunities, performance recommendations, broken backlinks' },
      github: { name: 'GitHub Integration', mcp: 'GitHub Integration', status: 'live', note: 'Repo access, PR management, code sync' },
      workfront: { name: 'Workfront', mcp: 'Workfront WOA', status: 'active', note: 'P1 skills integrated — campaign ops' },
    },

    mcpCapabilities: [
      { capability: 'AEM content read/write', mcp: 'AEM Content - Prod', ready: true },
      { capability: 'AEM Launches', mcp: 'AEM Content - Prod', ready: true },
      { capability: 'DA page editing', mcp: 'AEM DA - Prod', ready: true },
      { capability: 'DA preview/publish', mcp: 'AEM DA - Prod', ready: true },
      { capability: 'AEM Sites (Odin)', mcp: 'AEM Odin Prod', ready: true },
      { capability: 'Analytics queries', mcp: 'Adobe Analytics MCP - Prod', ready: true, endpoint: 'mcp-gateway.adobe.io/aa/mcp' },
      { capability: 'CJA queries', mcp: 'Adobe CJA MCP - Prod', ready: true, endpoint: 'mcp-gateway.adobe.io/cja/mcp' },
      { capability: 'AEP Segment API', mcp: 'AEP MCP', ready: true, endpoint: 'platform.adobe.io/data/core/ups/segment/definitions' },
      { capability: 'AJO journey orchestration', mcp: 'Adobe Marketing Agent MCP', ready: true },
      { capability: 'PDF extraction/conversion', mcp: 'Acrobat MCP - Prod', ready: true, endpoint: 'acrobat-mcp.adobe.io/mcp/call' },
      { capability: 'Creative generation', mcp: 'Adobe Express MCP - Prod', ready: true },
      { capability: 'Vector editing', mcp: 'Adobe Illustrator MCP - Stage', ready: true },
      { capability: 'GitHub repo/PR management', mcp: 'GitHub Integration', ready: true },
      { capability: 'Destination data flow health', mcp: 'AEP Destinations MCP - Prod', ready: true, endpoint: 'aep-destinations-mcp.adobe.io/mcp' },
      { capability: 'Destination activation status', mcp: 'AEP Destinations MCP - Prod', ready: true },
      { capability: 'Experience League doc search', mcp: 'Experience League MCP - Prod', ready: true, endpoint: 'exl-ia-mcp-service.ethos55-prod-va7.ethos.adobe.net/mcp' },
      { capability: 'Product release notes', mcp: 'Experience League MCP - Prod', ready: true },
      { capability: 'Site SEO audit', mcp: 'Spacecat Sites Optimizer MCP - Prod', ready: true, endpoint: 'spacecat.experiencecloud.live/api/v1/mcp' },
      { capability: 'Site performance opportunities', mcp: 'Spacecat Sites Optimizer MCP - Prod', ready: true },
      { capability: 'Audience creation/sharing', mcp: 'AEP + Target', ready: true },
    ],

    /* ── Curated data (grounded, stable — never randomized) ── */

    segmentSizes: {
      'ent-aem': 142300,
      'greenfield': 87600,
      'mtc': 63400,
    },

    analyticsBaseline: {
      page_views: 34200,
      unique_visitors: 18700,
      bounce_rate: '31.4%',
      avg_time_on_page: '94s',
      conversion_rate: '3.2%',
      top_entry_source: 'organic search',
      mobile_pct: 62,
      hero_ctr: '11.3%',
      trend: 'up 8% vs prior period',
    },

    journeys: [
      { name: 'EDS Onboarding Series', status: 'active', messages_sent: 14320, open_rate: '38.1%', conversion: '12.4%' },
      { name: 'Cloud Migration Nurture', status: 'active', messages_sent: 9840, open_rate: '31.7%', conversion: '7.2%' },
      { name: 'Feature Adoption — Agentic AI', status: 'draft', messages_sent: 0, open_rate: 'N/A', conversion: 'N/A' },
    ],

    /* ── Destinations (AEP Destinations MCP — curated) ── */
    destinations: [
      { id: 'dest-fb-001', name: 'Facebook Custom Audiences', type: 'social', status: 'active', connectionSpec: 'facebook-custom-audiences', flowRunsLast24h: 12, failedRuns: 0, profilesActivated: 142300, lastRun: '2h ago' },
      { id: 'dest-ga-002', name: 'Google Ads Customer Match', type: 'advertising', status: 'active', connectionSpec: 'google-ads-customer-match', flowRunsLast24h: 8, failedRuns: 1, profilesActivated: 87600, lastRun: '45m ago' },
      { id: 'dest-sf-003', name: 'Salesforce Marketing Cloud', type: 'email-marketing', status: 'active', connectionSpec: 'salesforce-marketing-cloud', flowRunsLast24h: 6, failedRuns: 0, profilesActivated: 63400, lastRun: '3h ago' },
      { id: 'dest-s3-004', name: 'Amazon S3 (Data Lake Export)', type: 'cloud-storage', status: 'active', connectionSpec: 'amazon-s3', flowRunsLast24h: 4, failedRuns: 0, profilesActivated: 293300, lastRun: '1h ago' },
      { id: 'dest-tt-005', name: 'The Trade Desk', type: 'advertising', status: 'active', connectionSpec: 'the-trade-desk', flowRunsLast24h: 8, failedRuns: 0, profilesActivated: 218700, lastRun: '30m ago' },
      { id: 'dest-brz-006', name: 'Braze', type: 'mobile-engagement', status: 'warning', connectionSpec: 'braze', flowRunsLast24h: 6, failedRuns: 2, profilesActivated: 41200, lastRun: '4h ago' },
      { id: 'dest-http-007', name: 'HTTP API (Internal Analytics)', type: 'streaming', status: 'active', connectionSpec: 'http-api', flowRunsLast24h: 288, failedRuns: 3, profilesActivated: 0, lastRun: '5m ago' },
    ],

    destinationFlowRuns: [
      { flowRunId: 'fr-001', destinationId: 'dest-fb-001', status: 'success', recordsReceived: 14230, recordsActivated: 14118, recordsFailed: 112, startTime: '2h ago', duration: '4m 12s' },
      { flowRunId: 'fr-002', destinationId: 'dest-ga-002', status: 'partial_success', recordsReceived: 8760, recordsActivated: 8540, recordsFailed: 220, startTime: '45m ago', duration: '6m 38s', errorCategory: 'INVALID_IDENTITIES', errorMessage: '220 profiles missing required Google Ads identity (gclid or email)' },
      { flowRunId: 'fr-003', destinationId: 'dest-sf-003', status: 'success', recordsReceived: 6340, recordsActivated: 6340, recordsFailed: 0, startTime: '3h ago', duration: '2m 54s' },
      { flowRunId: 'fr-004', destinationId: 'dest-s3-004', status: 'success', recordsReceived: 29330, recordsActivated: 29330, recordsFailed: 0, startTime: '1h ago', duration: '8m 22s' },
      { flowRunId: 'fr-005', destinationId: 'dest-brz-006', status: 'failed', recordsReceived: 4120, recordsActivated: 0, recordsFailed: 4120, startTime: '4h ago', duration: '1m 03s', errorCategory: 'AUTH_EXPIRED', errorMessage: 'Braze API key expired — credential renewal required' },
      { flowRunId: 'fr-006', destinationId: 'dest-tt-005', status: 'success', recordsReceived: 21870, recordsActivated: 21870, recordsFailed: 0, startTime: '30m ago', duration: '5m 44s' },
    ],

    sampleCustomers: [
      { firstName: 'Sarah', lastName: 'Chen', email: 'schen@techcorp.io', ltv: '$12,400', loyalty: 'Platinum', channel: 'email', city: 'San Francisco' },
      { firstName: 'Marcus', lastName: 'Williams', email: 'mwilliams@acme.com', ltv: '$8,200', loyalty: 'Gold', channel: 'web', city: 'Austin' },
      { firstName: 'Priya', lastName: 'Sharma', email: 'psharma@global.co', ltv: '$23,100', loyalty: 'Platinum', channel: 'push', city: 'Singapore' },
    ],

    systemPromptExtras: '',
  },

  /* ── Ralph Lauren Corporate ── */
  'ralph-lauren': {
    id: 'ralph-lauren',
    name: 'Ralph Lauren Corporation',
    logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Ralph_Lauren_Logo.svg/200px-Ralph_Lauren_Logo.svg.png',
    orgId: 'ralphlauren',
    repo: 'corporate-site',
    branch: 'main',
    tier: 'AEM CS + EDS',
    env: 'Prod',
    services: ['EDS', 'Assets Content Hub', 'Sites'],
    vertical: 'Retail / Fashion',
    sourceUrl: 'https://corporate.ralphlauren.com',

    brandVoice: {
      tone: 'Refined, aspirational, heritage-driven, confident',
      keywords: ['timeless', 'craftsmanship', 'heritage', 'iconic', 'world of Ralph Lauren', 'American style'],
      avoided: ['cheap', 'discount', 'basic', 'trendy', 'fast fashion'],
      style: 'Premium luxury — elegant prose, restrained enthusiasm, let the brand speak through quality. Never oversell. Every word should feel curated.',
      colorPalette: {
        primary: '#041E42',    // Navy (RL Navy)
        secondary: '#8B6F4E',  // Gold
        accent: '#C41E3A',     // Polo Red
        background: '#FFFFFF',
        text: '#1A1A1A',
        muted: '#6B6B6B',
      },
      typography: {
        heading: 'Didot, Georgia, serif',
        body: 'Helvetica Neue, Arial, sans-serif',
        accent: 'Futura, sans-serif',
      },
    },

    segments: [
      { name: 'Investors & Analysts', id: 'investors', description: 'Wall Street analysts, institutional investors, financial media tracking RL performance' },
      { name: 'Prospective Employees', id: 'careers', description: 'Fashion industry professionals, creatives, MBAs seeking luxury brand careers' },
      { name: 'Media & Press', id: 'press', description: 'Fashion press, business journalists, lifestyle publications' },
      { name: 'Corporate Partners', id: 'partners', description: 'Licensees, wholesale partners, supplier relations' },
      { name: 'ESG Stakeholders', id: 'esg', description: 'Sustainability researchers, ESG analysts, conscious consumers tracking corporate responsibility' },
    ],

    approvalChain: [
      { role: 'Corporate Communications', action: 'Draft content for corporate site' },
      { role: 'Brand Stewardship', action: 'Brand voice & visual identity review', sla: '24h' },
      { role: 'Investor Relations', action: 'Financial content accuracy review (if investor-facing)', sla: '24h' },
      { role: 'Legal & Compliance', action: 'Legal review — SEC compliance for financial claims, trademark usage', sla: '48h' },
      { role: 'VP Corporate Communications', action: 'Final sign-off for public-facing content' },
      { role: 'Digital Publishing', action: 'Publish to corporate.ralphlauren.com' },
    ],

    legalSLA: {
      reviewTime: '48h',
      escalation: '72h',
      autoApprove: false,
      specialRules: [
        'All financial forward-looking statements require SEC safe harbor language',
        'Quarterly results must include standard disclaimer',
        'Executive quotes must be pre-approved by individual',
        'Brand imagery must follow RL Visual Standards v4.2',
        'No product pricing on corporate site',
      ],
    },

    damTaxonomy: {
      root: '/content/dam/ralph-lauren/corporate',
      folders: ['leadership', 'brand-imagery', 'press-releases', 'investor-presentations', 'sustainability', 'heritage'],
      namingConvention: 'rl-[category]-[description]-[year]. Example: rl-leadership-patrice-louvet-2024',
      brandAssets: {
        logos: ['rl-polo-player', 'rl-wordmark', 'rl-corporate-seal'],
        restrictedUsage: 'Polo Player logo: minimum 24px height, never rotate, never modify colors. RL Navy (#041E42) background only.',
      },
    },

    entitlements: {
      analytics: { name: 'Adobe Analytics', mcp: 'AA MCP', status: 'active', note: 'Report suite: rl-corporate-prod' },
      cja: { name: 'Customer Journey Analytics', mcp: 'CJA MCP', status: 'active', note: 'Data view: corporate-site' },
      aep: { name: 'Adobe Experience Platform', mcp: 'AEP MCP', status: 'active', note: 'Sandbox: rl-corporate' },
      target: { name: 'Adobe Target', mcp: 'Target MCP', status: 'active', note: 'Sandbox: rl-corporate' },
      aemContent: { name: 'AEM Content', mcp: 'AEM Content MCP', status: 'live', note: 'Working — connected to corporate site' },
      aemLaunches: { name: 'AEM Launches', mcp: 'AEM Content MCP', status: 'live', note: 'Active for quarterly earnings' },
      workfront: { name: 'Workfront', mcp: 'Workfront WOA', status: 'active', note: 'Integrated with brand review workflow' },
    },

    mcpCapabilities: [
      { capability: 'AEM content read/write', mcp: 'AEM Content MCP', ready: true },
      { capability: 'AEM Launches', mcp: 'AEM Content MCP', ready: true },
      { capability: 'Analytics queries', mcp: 'AA MCP', ready: true },
      { capability: 'CJA queries', mcp: 'CJA MCP', ready: true },
      { capability: 'AJO journey reporting', mcp: 'Marketing Agent MCP', ready: false, needs: 'License activation' },
      { capability: 'Audience creation/sharing', mcp: 'AEP + Target', ready: true },
      { capability: 'AI Data Insights', mcp: 'CJA Data Insights Agent', ready: true },
    ],

    systemPromptExtras: `
## Ralph Lauren Corporate — Customer-Specific Context

You are working with the **Ralph Lauren Corporation** corporate site (corporate.ralphlauren.com).
This is an assets-only customer today (very mature AEM Assets deployment) who is evaluating AEM Sites
for their corporate "About RL" site, which is currently hand-coded.

**Key Context:**
- RL is evaluating Sites after a competitive loss to Contentful
- The corporate site is NOT an e-commerce site — it's investor relations, careers, press, sustainability, brand heritage
- Audience is institutional investors, fashion press, prospective employees, and ESG analysts
- Content must reflect the premium luxury positioning — every word curated, never oversold
- Financial content has SEC compliance requirements (safe harbor language, forward-looking statement disclaimers)

**Brand Rules (enforced by Brand Stewardship):**
- RL Navy (#041E42) is the primary brand color — used for backgrounds, headers, key CTAs
- The Polo Player logo has strict usage rules: minimum 24px height, never rotated, never recolored
- Typography: Didot for headlines (premium serif), Helvetica Neue for body
- Imagery: aspirational lifestyle photography, never product-only shots on corporate site
- Tone: refined, heritage-driven, confident without being boastful

**Governance Specifics:**
- All financial content requires Legal & Compliance review (48h SLA)
- Executive quotes require individual pre-approval
- Brand imagery must follow RL Visual Standards v4.2
- No product pricing or promotional language on corporate site
- Quarterly earnings pages use a standardized template with SEC safe harbor boilerplate

**Current Site Structure (corporate.ralphlauren.com):**
- /about — Company overview, history, world of RL
- /brands — Portfolio: Ralph Lauren, Polo, Lauren, Club Monaco, RRL
- /investors — Quarterly results, SEC filings, stock info, events
- /careers — Job openings, culture, benefits, diversity & inclusion
- /press — Press releases, media contacts, image library
- /citizenship-sustainability — ESG reporting, environmental goals, community impact
- /contact — Corporate contacts, customer service

**What Success Looks Like for RL:**
Moving the corporate site from hand-coded to AEM Sites + EDS means:
1. Corporate comms team can update content without developer involvement
2. Quarterly earnings pages can be templated and published in minutes, not days
3. Brand compliance is built into the authoring workflow (governance scanning)
4. Analytics and CJA provide real insight into investor engagement
5. The corporate site becomes a showcase for what AEM can do — strengthening the relationship`,

    /* ── Curated data (grounded, stable) ── */

    segmentSizes: {
      'investors': 24800,
      'careers': 156200,
      'press': 8400,
      'partners': 3200,
      'esg': 41600,
    },

    analyticsBaseline: {
      page_views: 287000,
      unique_visitors: 142300,
      bounce_rate: '38.2%',
      avg_time_on_page: '127s',
      conversion_rate: '2.1%',
      top_entry_source: 'direct',
      mobile_pct: 48,
      hero_ctr: '6.8%',
      trend: 'stable vs prior period',
    },

    journeys: [
      { name: 'Investor Relations Quarterly Update', status: 'active', messages_sent: 4200, open_rate: '52.3%', conversion: '18.1%' },
      { name: 'Careers Newsletter', status: 'active', messages_sent: 28400, open_rate: '24.6%', conversion: '4.8%' },
      { name: 'ESG Impact Report Launch', status: 'draft', messages_sent: 0, open_rate: 'N/A', conversion: 'N/A' },
    ],

    sampleCustomers: [
      { firstName: 'James', lastName: 'Thornton', email: 'jthornton@goldmansachs.com', ltv: '$0', loyalty: 'Investor', channel: 'email', city: 'New York' },
      { firstName: 'Elena', lastName: 'Rodriguez', email: 'erodriguez@vogue.com', ltv: '$0', loyalty: 'Press', channel: 'email', city: 'New York' },
      { firstName: 'David', lastName: 'Park', email: 'dpark@ralphlauren.com', ltv: '$0', loyalty: 'Employee', channel: 'web', city: 'New York' },
    ],
  },

  /* ── Princess Cruises ── */
  'princess-cruises': {
    id: 'princess-cruises',
    name: 'Princess Cruises',
    logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/1/1e/Princess_Cruises_Logo.svg/200px-Princess_Cruises_Logo.svg.png',
    orgId: 'princess',
    repo: 'princess-eds',
    branch: 'main',
    tier: 'AEM CS + EDS',
    env: 'Prod (VA7)',
    services: ['EDS', 'Assets Content Hub', 'Sites', 'Forms'],
    vertical: 'Travel & Hospitality',

    brandVoice: {
      tone: 'Warm, inviting, adventurous yet refined',
      keywords: ['MedallionClass', 'Ocean Ready', 'come back new', 'sail away', 'voyage'],
      avoided: ['cheap', 'budget', 'old'],
      style: 'Premium travel — evocative descriptions, emotional appeal, sense of discovery. Aspirational but accessible.',
      colorPalette: {
        primary: '#00263E',
        secondary: '#C4A35A',
        accent: '#0077C8',
        background: '#FFFFFF',
        text: '#333333',
      },
    },

    segments: [
      { name: 'Elite Voyager', id: 'elite-voyager', description: 'Platinum+ loyalty tier, 15+ sailings, highest LTV, expect white-glove service' },
      { name: 'Adventure Seeker', id: 'adventure-seeker', description: 'Active couples 35-55, interested in excursions, MedallionClass tech' },
      { name: 'Luxury Relaxer', id: 'luxury-relaxer', description: 'Premium suite guests, spa-focused, dining experiences, 55+' },
      { name: 'Family Explorer', id: 'family-explorer', description: 'Multi-generational families, kids club, connecting staterooms' },
      { name: 'First Timer', id: 'first-timer', description: 'Never cruised before, need reassurance, value-conscious, digital-first' },
    ],

    approvalChain: [
      { role: 'Content Marketing', action: 'Draft campaign content' },
      { role: 'Brand Manager', action: 'Brand voice & imagery review', sla: '24h' },
      { role: 'Revenue Management', action: 'Pricing accuracy check (if pricing shown)', sla: '12h' },
      { role: 'Legal', action: 'Legal review — FTC compliance, disclaimer language', sla: '48h' },
      { role: 'Digital Director', action: 'Final approval & publish' },
    ],

    legalSLA: {
      reviewTime: '48h',
      escalation: '72h',
      autoApprove: false,
      specialRules: [
        'All pricing must include "from" qualifier and link to full terms',
        'Cruise imagery must show current fleet (no retired ships)',
        'MedallionClass claims must be substantiated',
        'COVID/health protocols must reference current CDC guidance',
        'Loyalty tier benefits must match current program terms',
      ],
    },

    damTaxonomy: {
      root: '/content/dam/princess',
      folders: ['ships', 'destinations', 'dining', 'staterooms', 'excursions', 'medallionclass', 'lifestyle'],
      namingConvention: 'pcl-[ship]-[category]-[description]. Example: pcl-discovery-pool-aerial-2024',
    },

    entitlements: {
      analytics: { name: 'Adobe Analytics', mcp: 'AA MCP', status: 'active', note: 'Report suite: pcl-web-prod' },
      cja: { name: 'Customer Journey Analytics', mcp: 'CJA MCP', status: 'active', note: 'Data view: booking-funnel' },
      aep: { name: 'Adobe Experience Platform', mcp: 'AEP MCP', status: 'active', note: 'Sandbox: pcl-prod' },
      ajo: { name: 'Adobe Journey Optimizer', mcp: 'Marketing Agent MCP', status: 'active', note: 'Authenticated and live' },
      target: { name: 'Adobe Target', mcp: 'Target MCP', status: 'active', note: 'Active AB tests on booking flow' },
      aemContent: { name: 'AEM Content', mcp: 'AEM Content MCP', status: 'live', note: 'Working today' },
      workfront: { name: 'Workfront', mcp: 'Workfront WOA', status: 'active', note: 'Connected to campaign ops' },
    },

    mcpCapabilities: [
      { capability: 'AEM content read/write', mcp: 'AEM Content MCP', ready: true },
      { capability: 'AEM Launches', mcp: 'AEM Content MCP', ready: true },
      { capability: 'Analytics queries', mcp: 'AA MCP', ready: true },
      { capability: 'CJA queries', mcp: 'CJA MCP', ready: true },
      { capability: 'AJO journey reporting', mcp: 'Marketing Agent MCP', ready: true },
      { capability: 'Audience creation/sharing', mcp: 'AEP + Target', ready: true },
    ],

    systemPromptExtras: `
## Princess Cruises — Customer-Specific Context

You are working with **Princess Cruises** (princess.com).

**Key Segments (know these by name — the native agent doesn't):**
- **Elite Voyager**: Platinum+ loyalty, 15+ sailings, highest LTV
- **Adventure Seeker**: Active couples 35-55, excursion-focused
- **Luxury Relaxer**: Premium suite guests, spa & dining, 55+
- **Family Explorer**: Multi-generational, kids club
- **First Timer**: Never cruised, value-conscious, needs reassurance

**Brand Governance:**
- All pricing: "from $X" with link to full terms (FTC requirement)
- MedallionClass claims must be substantiated
- No retired ship imagery
- Legal review SLA: 48h (escalation at 72h)

**Current Active Campaigns:**
- Alaska 2025 Early Bird (targeting Adventure Seekers)
- Mediterranean Luxury (targeting Luxury Relaxers)
- First Cruise Guarantee (targeting First Timers)`,

    /* ── Curated data (grounded, stable) ── */

    segmentSizes: {
      'elite-voyager': 18200,
      'adventure-seeker': 284000,
      'luxury-relaxer': 96400,
      'family-explorer': 412000,
      'first-timer': 1340000,
    },

    analyticsBaseline: {
      page_views: 2140000,
      unique_visitors: 876000,
      bounce_rate: '26.8%',
      avg_time_on_page: '184s',
      conversion_rate: '4.7%',
      top_entry_source: 'paid search',
      mobile_pct: 71,
      hero_ctr: '14.2%',
      trend: 'up 12% vs prior period',
    },

    journeys: [
      { name: 'Alaska 2025 Early Bird', status: 'active', messages_sent: 342000, open_rate: '29.4%', conversion: '6.1%' },
      { name: 'Mediterranean Luxury Nurture', status: 'active', messages_sent: 124000, open_rate: '33.8%', conversion: '8.9%' },
      { name: 'First Cruise Guarantee', status: 'active', messages_sent: 567000, open_rate: '41.2%', conversion: '3.4%' },
      { name: 'Post-Voyage Thank You', status: 'active', messages_sent: 89000, open_rate: '48.7%', conversion: '22.1%' },
    ],

    sampleCustomers: [
      { firstName: 'Patricia', lastName: 'Morrison', email: 'pmorrison@gmail.com', ltv: '$47,200', loyalty: 'Platinum Elite', channel: 'email', city: 'Scottsdale' },
      { firstName: 'Robert', lastName: 'Nakamura', email: 'rnakamura@outlook.com', ltv: '$18,400', loyalty: 'Gold', channel: 'push', city: 'Seattle' },
      { firstName: 'Erin', lastName: 'O\'Brien', email: 'eobrien@yahoo.com', ltv: '$3,200', loyalty: 'Blue', channel: 'web', city: 'Chicago' },
    ],
  },
};

/* ── Dynamic Profile Storage ── */
const CUSTOM_PROFILES_KEY = 'ew-custom-profiles';

function loadCustomProfiles() {
  try {
    const raw = localStorage.getItem(CUSTOM_PROFILES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCustomProfiles(profiles) {
  localStorage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(profiles));
}

export function addCustomProfile(profile) {
  const customs = loadCustomProfiles();
  customs[profile.id] = profile;
  saveCustomProfiles(customs);
}

export function deleteCustomProfile(profileId) {
  const customs = loadCustomProfiles();
  delete customs[profileId];
  saveCustomProfiles(customs);
}

function getAllProfiles() {
  return { ...PROFILES, ...loadCustomProfiles() };
}

/* ── Profile Management ── */

export function getActiveProfileId() {
  return localStorage.getItem(STORAGE_KEY) || null;
}

export function setActiveProfile(profileId) {
  const all = getAllProfiles();
  if (!all[profileId]) throw new Error(`Unknown profile: ${profileId}`);
  localStorage.setItem(STORAGE_KEY, profileId);
}

export function getActiveProfile() {
  const id = getActiveProfileId();
  if (!id) return null;
  const all = getAllProfiles();
  return all[id] || null;
}

export function listProfiles() {
  return Object.values(getAllProfiles()).map((p) => ({
    id: p.id,
    name: p.name,
    vertical: p.vertical,
    tier: p.tier,
    isCustom: !PROFILES[p.id],
  }));
}

/* ── AEM_ORG compat — builds the old AEM_ORG shape from active profile ── */
export function getOrgConfig() {
  const p = getActiveProfile();
  if (!p) {
    return {
      name: '', orgId: '', repo: '', branch: 'main',
      get previewOrigin() { return ''; },
      get liveOrigin() { return ''; },
      get daOrg() { return ''; },
      get daRepo() { return ''; },
      tier: '', env: '', services: [], entitlements: [], mcpCapabilities: [],
    };
  }
  return {
    name: p.name,
    orgId: p.orgId,
    repo: p.repo,
    branch: p.branch,
    get previewOrigin() { return `https://${this.branch}--${this.repo}--${this.orgId.toLowerCase()}.aem.page`; },
    get liveOrigin() { return `https://${this.branch}--${this.repo}--${this.orgId.toLowerCase()}.aem.live`; },
    get daOrg() { return this.orgId; },
    get daRepo() { return this.repo; },
    tier: p.tier,
    env: p.env,
    services: p.services,
    entitlements: p.entitlements,
    mcpCapabilities: p.mcpCapabilities,
  };
}

/* ── System Prompt Builder — the core of Differentiator #1 ── */
export function buildCustomerContext() {
  const p = getActiveProfile();
  if (!p) return '\n## No customer profile active. Site context comes from the connected repository.';
  const parts = [];

  parts.push(`\n## Customer Profile: ${p.name}`);
  parts.push(`- **Vertical**: ${p.vertical}`);
  parts.push(`- **Tier**: ${p.tier}`);
  parts.push(`- **Environment**: ${p.env}`);
  parts.push(`- **Repository**: ${p.orgId}/${p.repo} (branch: ${p.branch})`);
  parts.push(`- **Services**: ${p.services.join(', ')}`);

  // Brand voice
  if (p.brandVoice) {
    parts.push(`\n### Brand Voice`);
    parts.push(`- **Tone**: ${p.brandVoice.tone}`);
    parts.push(`- **Style**: ${p.brandVoice.style}`);
    parts.push(`- **Keywords**: ${p.brandVoice.keywords.join(', ')}`);
    parts.push(`- **Avoid**: ${p.brandVoice.avoided.join(', ')}`);
    if (p.brandVoice.colorPalette) {
      parts.push(`- **Colors**: Primary ${p.brandVoice.colorPalette.primary}, Secondary ${p.brandVoice.colorPalette.secondary}, Accent ${p.brandVoice.colorPalette.accent}`);
    }
    if (p.brandVoice.typography) {
      parts.push(`- **Typography**: Headings: ${p.brandVoice.typography.heading}, Body: ${p.brandVoice.typography.body}`);
    }
  }

  // Segments
  if (p.segments?.length) {
    parts.push(`\n### Audience Segments`);
    p.segments.forEach((s) => {
      parts.push(`- **${s.name}** (${s.id}): ${s.description}`);
    });
  }

  // Approval chain
  if (p.approvalChain?.length) {
    parts.push(`\n### Approval Workflow`);
    p.approvalChain.forEach((step, i) => {
      const sla = step.sla ? ` [SLA: ${step.sla}]` : '';
      parts.push(`${i + 1}. **${step.role}** — ${step.action}${sla}`);
    });
  }

  // Legal rules
  if (p.legalSLA?.specialRules?.length) {
    parts.push(`\n### Legal & Compliance Rules`);
    p.legalSLA.specialRules.forEach((rule) => {
      parts.push(`- ${rule}`);
    });
  }

  // DAM taxonomy
  if (p.damTaxonomy) {
    parts.push(`\n### DAM Taxonomy`);
    parts.push(`- **Root**: ${p.damTaxonomy.root}`);
    parts.push(`- **Folders**: ${p.damTaxonomy.folders.join(', ')}`);
    parts.push(`- **Naming**: ${p.damTaxonomy.namingConvention}`);
  }

  // Customer-specific extras
  if (p.systemPromptExtras) {
    parts.push(p.systemPromptExtras);
  }

  return parts.join('\n');
}

/* ── AI Profile Generation Prompt ── */
/* Given discovery notes + scraped site data, generate a complete customer profile */

export const PROFILE_GENERATION_PROMPT = `You are an AI-powered customer onboarding agent for Adobe Experience Manager XSC (Experience Success Consulting).

Given discovery call notes and/or a website analysis, generate a complete customer profile JSON object.

Return ONLY valid JSON (no markdown fences, no explanation) matching this exact structure:

{
  "id": "kebab-case-id",
  "name": "Company Name",
  "orgId": "github-org-id",
  "repo": "eds-repo-name",
  "branch": "main",
  "tier": "AEM CS + EDS",
  "env": "Prod",
  "services": ["EDS", "Assets Content Hub", "Sites"],
  "vertical": "Industry / Sub-industry",
  "sourceUrl": "https://their-site.com",

  "brandVoice": {
    "tone": "3-5 word tone description",
    "keywords": ["brand", "keywords", "they", "use"],
    "avoided": ["words", "they", "avoid"],
    "style": "One sentence describing their communication style",
    "colorPalette": {
      "primary": "#hex",
      "secondary": "#hex",
      "accent": "#hex",
      "background": "#hex",
      "text": "#hex"
    },
    "typography": {
      "heading": "Font Family, fallback",
      "body": "Font Family, fallback"
    }
  },

  "segments": [
    { "name": "Segment Name", "id": "segment-id", "description": "Who they are and what they want" }
  ],

  "approvalChain": [
    { "role": "Role Name", "action": "What they do in the workflow", "sla": "24h" }
  ],

  "legalSLA": {
    "reviewTime": "48h",
    "escalation": "72h",
    "autoApprove": false,
    "specialRules": ["Specific legal/compliance rules for this customer"]
  },

  "damTaxonomy": {
    "root": "/content/dam/customer-name",
    "folders": ["category1", "category2"],
    "namingConvention": "prefix-[category]-[description]-[year]"
  },

  "entitlements": {
    "analytics": { "name": "Adobe Analytics", "mcp": "AA MCP", "status": "active", "note": "Configuration note" },
    "cja": { "name": "Customer Journey Analytics", "mcp": "CJA MCP", "status": "active", "note": "Note" },
    "aep": { "name": "Adobe Experience Platform", "mcp": "AEP MCP", "status": "active", "note": "Note" },
    "target": { "name": "Adobe Target", "mcp": "Target MCP", "status": "active", "note": "Note" },
    "aemContent": { "name": "AEM Content", "mcp": "AEM Content MCP", "status": "live", "note": "Note" },
    "workfront": { "name": "Workfront", "mcp": "Workfront WOA", "status": "active", "note": "Note" }
  },

  "mcpCapabilities": [
    { "capability": "AEM content read/write", "mcp": "AEM Content MCP", "ready": true },
    { "capability": "Analytics queries", "mcp": "AA MCP", "ready": false, "needs": "Report suite ID" }
  ],

  "systemPromptExtras": "Multi-line string with customer-specific context that the AI should know. Include site structure, key business context, competitive landscape, and what success looks like for this customer."
}

RULES:
- Extract brand colors from CSS/design if website data is provided
- Extract typography from CSS if available
- Infer audience segments from site content and discovery notes
- Build realistic approval chains based on the customer's industry and size
- Include industry-specific legal/compliance rules
- Set entitlement statuses based on what the customer actually has (from discovery notes)
- The systemPromptExtras should be rich — include everything an AI agent would need to know to sound like an insider
- If information is missing, make informed inferences based on the industry and company size
- orgId should be a reasonable GitHub org slug
- repo should be a reasonable EDS repo name`;

export function buildProfilePrompt(discoveryNotes, siteData) {
  const parts = [PROFILE_GENERATION_PROMPT];

  if (discoveryNotes) {
    parts.push(`\n\n## Discovery Call Notes\n${discoveryNotes}`);
  }

  if (siteData) {
    parts.push(`\n\n## Website Analysis\n${siteData}`);
  }

  return parts.join('');
}

# AEM Edge Delivery Services - Combined Knowledge Base

This document combines key AEM Edge Delivery Services documentation for use as AI assistant context. Each section corresponds to an official AEM documentation page.

---

# 1. Developer Tutorial

**Source:** https://www.aem.live/developer/tutorial

## Overview

This tutorial establishes a new Adobe Experience Manager (AEM) project within 10-20 minutes, enabling site creation, content management, and publishing capabilities.

## Prerequisites

- GitHub account with Git fundamentals
- HTML, CSS, and JavaScript knowledge
- Node/npm installation for local development

**Note:** The tutorial references macOS, Chrome, and Visual Studio Code, though other environments are compatible with potential UI variations.

## Alternative Approach

For rapid project initialization, the documentation suggests using "the AEM Modernization Agent" to import existing sites after creating a boilerplate repository.

## Initial Setup Process

### Repository Creation

1. Access the boilerplate template at `https://github.com/adobe/aem-boilerplate`
2. Select `Use this template` -> `Create a new repository`
3. Choose your user organization as the repository owner
4. Set repository visibility to public (recommended)

### GitHub App Installation

Install the AEM Code Sync GitHub App via `https://github.com/apps/aem-code-sync/installations/new`

**Configuration:**
- Select `Only select Repositories` in Repository access settings
- Choose your newly created repository
- Click `Save`

**IP Allowlist Note:** For GitHub Enterprise with IP filtering, add `3.227.118.73` to the allowlist.

### Result

Your website deploys to `https://<branch>--<repo>--<owner>.aem.page/`

## Content Management

### Authoring

Navigate to `https://da.live/` to access Author environment and locate example content. Edit, preview, and publish content as required. Documentation available at `https://da.live/docs`.

### Sidekick Extension

Install the Sidekick Chrome extension from the Chrome Web Store (search: "AEM Sidekick") for cross-environment author interaction. Pin the extension for accessibility.

## Local Development

### CLI Installation and Repository Cloning

```bash
npm install -g @adobe/aem-cli
git clone https://github.com/<owner>/<repo>
```

### Local Environment Startup

```bash
cd <repo>
aem up
```

This launches `http://localhost:3000/` with immediate browser refresh on CSS/JavaScript modifications.

### Development Focus

The `blocks` folder contains primary styling and functionality. CSS and JavaScript changes reflect immediately in the browser.

### Deployment

Use Git commands to commit and push changes to preview (`https://<branch>--<repo>--<owner>.aem.page/`) and production (`https://<branch>--<repo>--<owner>.aem.live/`) environments.

## Advanced Configuration

**Universal Editor:** Can be configured for WYSIWYG and form-based authoring options via documentation at `https://docs.da.live/developers/reference/universal-editor#enable-your-project-for-universal-editor`

**Multiple Content Sources:** Edge Delivery Services supports Google Drive, Microsoft SharePoint, and AEM as content sources.

## Next Steps

- Create custom blocks from scratch via exploring blocks documentation
- Configure AI-assisted development through AI coding agents configuration

## Support Resources

- Discord community: `https://discord.gg/aem-live`
- Business inquiries: Adobe contact form available on documentation site

---

# 2. Anatomy of a Project

**Source:** https://www.aem.live/developer/anatomy-of-a-project

## Git and GitHub Integration

AEM uses a buildless approach operating directly from GitHub repositories. After installing the AEM GitHub bot, websites automatically generate for each branch at `https://<branch>--<repo>--<owner>.aem.page/` (preview) and `https://<branch>--<repo>--<owner>.aem.live/` (production).

**Key constraints:**
- The combination `<branch>--<repo>--<owner>` cannot exceed 63 characters (subdomain constraint)
- These segments cannot contain `--` (double hyphens)

Every file in your GitHub repo becomes available on the website. A file at `/scripts/scripts.js` on the main branch maps to `https://main--<repo>--<owner>.aem.page/scripts/scripts.js`.

## Special Files

### head.html

This file is "injected on the server side as part of the `<head>` HTML tag" and combines with metadata from content. It should remain largely unchanged from the boilerplate. The document advises against adding marketing technology, inline scripts, or styles here due to performance impacts.

Examples provided:
- helix-project-boilerplate
- express-website
- business-website

### 404.html

Custom 404 responses use a `404.html` file in the repository root. It replaces the default minimalist response for URLs without existing resources.

### .hlxignore

Files excluded from serving use `.hlxignore` formatting (similar to `.gitignore`). This prevents private files or non-essential project artifacts from being observed by the AEM bot.

## Configuration Management

Configuration occurs exclusively through the Configuration service, covering:

**Content Connection:** Defines where pages retrieve content during preview. Supported sources include Document Authoring, AEM Authoring, SharePoint, and Google Drive, with additional sources possible via Bring Your Own Markup.

**robots.txt:** Preview (`.page`) and origin (`.live`) sites serve a robots.txt disallowing all robots, protecting from indexing. Production configurations use the Robots Config API.

**Indexing:** A flexible facility maintains content pages as spreadsheets or JSON. Google Drive and SharePoint sources require no special configuration beyond specially named spreadsheets. Advanced indexing uses the Index Config API.

**Sitemaps:** Complex sitemaps generate automatically when authors publish, including flexible `hreflang` mappings based on indexing facilities.

## File and Folder Structure

Common folders typically reside in the repository root:

### Scripts and Styles

- `scripts.js`: Global custom JavaScript triggering block loading
- `styles.css`: Global styling, minimally containing layout information for Largest Contentful Paint (LCP)
- `aem.js`: Loaded before page display
- `lazy-styles.css`: Loaded after LCP, containing fonts and below-the-fold CSS
- `delayed.js`: Catch-all for libraries interfering with page delivery, including martech stacks

All three primary files load before page display, requiring "relatively small" execution.

### Blocks

Block-specific CSS and JavaScript code lives in blocks. The block name serves as:
- Folder name
- Filename for `.css` and `.js` files
- CSS class name on the block element

JavaScript exports a default function executed during block loading. The Columns Block exemplifies this by adding classes based on column count.

### Icons

SVG files typically stored in `/icons` use `:iconname:` notation. By default, icons inline into the DOM for CSS styling without requiring SVG symbols.

## Deployment and Structure Flexibility

When only portions of a website use AEM initially, folder structures relocate to subfolders matching CDN route mapping. For example, if `/en/blog/` maps to AEM, all folders (`/scripts`, `/styles`, `/blocks`) move into `/en/blog/`. References in `head.html` adjust accordingly without URL rewriting. As AEM adoption expands, code typically moves back to the root folder with updated references.

---

# 3. Block Collection

**Source:** https://www.aem.live/developer/block-collection

## Core Purpose

The block collection describes Adobe Experience Manager's block system, which provides reusable content components. As stated: "This is a collection of blocks considered a part of the AEM product and are recommended as blueprints for blocks in your project."

## Key Principles

Blocks in this collection adhere to seven technical standards:

- **Intuitive:** "Content structure that's intuitive and easy to author"
- **Useable:** "No dependencies, compatible with boilerplate"
- **Responsive:** "Works across all breakpoints"
- **Context Aware:** "Inherits CSS context such text and background colors"
- **Localizable:** "No hard-coded content"
- **Fast:** "No negative performance impact"
- **SEO and A11y:** "SEO friendly and accessible"

## Organizational Structure

**AEM Boilerplate** contains the most frequently used blocks and defaults, found in the [GitHub adobe/aem-boilerplate repository](https://github.com/adobe/aem-boilerplate/tree/main/blocks).

**AEM Block Collection** includes commonly-used but less universal blocks, maintained at [GitHub adobe/aem-block-collection](https://github.com/adobe/aem-block-collection/tree/main/blocks).

## Block Categories

**Boilerplate blocks** (default content types): Headings, Text, Images, Lists, Links, Buttons, Code, Sections, Icons, Hero, Columns, Cards, Header, Footer, Metadata, and Section Metadata.

**Block Collection blocks**: Embed, Fragment, Table, Video, Accordion, Breadcrumbs, Carousel, Modal, Quote, Search, Tabs, and Form (deprecated).

## Development Guidance

The document clarifies that "The primary value of these blocks is the content structure they provide," and blocks are "not backwards compatible to their respective older versions or upgradable."

## Community Contribution

Block Party offers a space where developers can showcase implementations, though Adobe maintains no responsibility for community-contributed code.

---

# 4. Markup, Sections, Blocks, and Auto Blocking

**Source:** https://www.aem.live/developer/markup-sections-blocks

## Document Structure Overview

Content organization follows a hierarchical pattern. Authors contribute using familiar semantic models (headings, lists, images, links) that translate across Word, Google Docs, markdown, and HTML -- termed **default content**.

"Sections" are separated by horizontal rules or `---` to group elements, typically for semantic or design purposes like background color changes. Within sections exist **blocks**, authored as tables with identifying headers. The foundational principle: "Sections can contain multiple blocks. Blocks should never be nested."

## Markup and DOM Construction

The system operates in two phases:

**Phase 1:** Server renders clean semantic markup containing sections, blocks, and default content.

**Phase 2:** The JavaScript library in `scripts.js` enhances markup into an augmented DOM through:
- Wrapping blocks and default content in `<div>` containers
- Dynamically adding CSS classes and data attributes
- Supporting the AEM block loader functionality

## Sections

Sections group content and employ a special "Section Metadata" block that creates data attributes. The recognized metadata property is `Style`, which converts into additional CSS classes on the section element.

"Blocks and default content are always wrapped in a section, even if the author doesn't specifically introduce section breaks."

## Default Content Rendering

The system leverages shared semantics across documentation platforms:
- Heading levels (`<h1>` through `<h6>`)
- Emphasis tags (`<em>`, `<strong>`)
- Lists (`<ul>`, `<ol>`)
- Images rendered as `<picture>` elements with multiple resolutions and formats (including webp support)

## Blocks: Structure and Implementation

Block names serve triple duty: folder names, CSS/JavaScript filenames, and CSS class identifiers. JavaScript loads as an ES Module (ESM) exporting a default function executed during block loading.

**CSS Scoping:** All selectors must prefix with the block class to prevent side-effects elsewhere in the project.

**Basic Block Markup:**

```html
<div class="blockname">
  <div>
     <div>
      <p>Hello, World.</p>
     </div>
  </div>
</div>
```

### Block Options

Authors can modify block behavior through parenthetical options in table headers:

- `Columns (wide)` generates: `<div class="columns wide">`
- `Columns (super wide)` generates: `<div class="columns super-wide">` (multi-word options use hyphens)
- `Columns (dark, wide)` generates: `<div class="columns dark wide">` (comma-separated become separate classes)

## Auto Blocking

This mechanism programmatically creates block DOM structures without requiring authors to manually construct tables. "Auto blocking turns default content and metadata into blocks without the author having to physically create them."

**Implementation location:** `buildAutoBlocks()` function in `scripts.js`

**Common use cases:**
- Template-based page layouts (article headers combining h1, images, metadata)
- Link wrapping (converting YouTube links into embed blocks)
- Integration of external applications, video embeds, content fragments, modals, and forms

**Design philosophy:** Developers absorb complexity in auto blocking logic, preserving intuitive authoring experiences. "Authors should always be able to simply copy/paste a block and intuitively understand what it is about."

---

# 5. Keeping it 100 (Web Performance & Lighthouse)

**Source:** https://www.aem.live/developer/keeping-it-100

## Core Concepts

Adobe Experience Manager (AEM) prioritizes web performance through Real User Monitoring (RUM) data collection and Google PageSpeed Insights testing. The document emphasizes that "field data collected in RUM" often differs from lab measurements due to variations in network conditions, geographic location, and device processing power.

## Rendering Strategy

**Server-side rendering** handles all canonical page content converted to markup. Client-side rendering applies only when no canonical content exists, such as dynamic block listings or applications. The approach excludes redundant, non-canonical content (headers, footers, reusable fragments) to prevent performance degradation affecting Largest Contentful Paint (LCP), Total Blocking Time (TBT), and Interaction to Next Paint (INP).

## Performance Metrics

**Core Web Vitals** represent real-world performance metrics collected through the CrUX report and influence search rankings. Google PageSpeed Insights provides standardized lab testing in configurations matching global mobile and desktop device distributions. While Lighthouse scores serve as "a valuable and reliable proxy," recommendations don't necessarily improve results near perfect scores.

## Three-Phase Loading Model (E-L-D)

### Phase E: Eager

- Body initially hidden with `display:none` to prevent premature image downloads and Cumulative Layout Shift (CLS)
- DOM decoration adds CSS classes and creates auto-blocks
- Full first section loads with priority on the LCP candidate image
- Keep aggregate pre-LCP payload below 100kb for optimal performance
- Fonts load asynchronously after this phase concludes

### Phase L: Lazy

- Subsequent sections and blocks load without blocking Total Blocking Time
- Images load according to `loading="lazy"` attributes
- Non-blocking JavaScript libraries load; content sourced from same origin

### Phase D: Delayed

- Third-party scripts, marketing tools, consent management, analytics load minimum three seconds after LCP
- Typically handled through `delayed.js` as a catch-all for blocking scripts

## LCP Optimization

The LCP, typically the hero image at page top, requires everything needed for display -- markup, CSS, and relevant JavaScript -- loaded immediately. Avoid connecting to secondary origins before LCP occurs, as establishing new connections (TLS, DNS) adds significant delay. When LCP elements require indirection (API calls, JSON lookups), page loading should wait until the first block modifies the DOM before identifying the LCP candidate. For responsive designs with separate hero images, remove unnecessary images from the DOM to avoid loading bandwidth-consuming assets.

## Common Performance Pitfalls

**Early hints, HTTP/2 push, and pre-connect** consume the limited network bandwidth budget. On mobile with PageSpeed Insights' bandwidth constraints, only a single host can deliver resources not exceeding 100kb before LCP.

**Path redirects** (www.domain.com -> www.domain.com/en -> www.domain.com/en/home) penalize performance with each redirect, impacting Core Web Vitals measured through RUM or CrUX.

**CDN client script injection** and protocol implementation differences can inject blocking scripts before LCP, negating AEM's optimization. Comparing `.aem.live` origins against customer CDN-fronted production sites reveals these negative impacts.

## Starting Point

New projects using the AEM Boilerplate achieve stable 100 Lighthouse scores on both mobile and desktop, providing buffer for project code while maintaining perfect scores.

## Pull Request Testing

The GitHub bot automatically fails pull requests when PageSpeed Insights scores fall below 100, enforcing continuous performance validation. Mobile scores serve as the primary metric due to their increased difficulty.

## Additional Considerations

**Font loading** relies on fallback techniques to prevent CLS when fonts arrive from external services like Adobe Fonts or Google Fonts. Pre-loading fonts counterproductively impacts performance.

**Header and footer** content loads asynchronously in separate blocks, improving cache efficiency and reducing invalidation complexity for independently-updated resources.

**Performance benefits sustainability**: Building fast, small, quick-rendering websites reduces carbon emissions alongside improving user experience and conversion rates.

---

# 6. Authoring and Publishing Content

**Source:** https://www.aem.live/docs/authoring

## Authoring Fundamentals

The platform supports direct content creation through familiar tools. As stated: "If you use Microsoft Word or Google Docs, then you already know how to create content." Formatting like bold, italic, underlining, and lists transfer automatically to published pages.

## Media Handling

**Images:** Drag-and-drop functionality is supported. The system automatically resizes images for browser compatibility, and manual resizing in source documents is ignored. Alternative text should be added for accessibility and SEO purposes using built-in document authoring features.

**Videos:** Direct drag-and-drop for videos isn't supported in Word or Google Docs. Instead, users can add videos via SharePoint or Google Drive, then "preview and publish them using the Sidekick and add the resulting URL as a link to a suitable block" in their document.

## Links and Navigation

Internal links use the format: `https://<your_host>/about-us#our-history` for heading anchors. Heading IDs are automatically generated as lowercase with spaces converted to dashes. Links within the same site are automatically converted to relative URLs.

## Content Structure

**Sections:** Created using `---` (three hyphens) on a single line, or in Google Docs via Insert -> Horizontal Line.

**Blocks:** Tables with merged header rows serving as block names. Blocks can include variants in parenthesis (e.g., `Columns (highlight)`).

## Publishing Workflow

- **Preview:** Opens a staging environment not indexed by search engines
- **Publish:** Makes content publicly visible and discoverable
- **Unpublish/Delete:** Two-step process requiring source document removal first, then Sidekick action

Deletion is permanent and requires document restoration to undo.

---

# 7. Authoring with AEM Sites for Edge Delivery Services

**Source:** https://www.aem.live/docs/aem-authoring

## Overview

This guide covers content authoring in AEM as a Cloud Service using the Universal Editor integrated with Edge Delivery Services. The combination provides content management capabilities alongside high-performance page delivery.

## Key Components

**AEM Sites Console**: Used for content management tasks including page creation, Experience Fragments, and Content Fragments. Full AEM features are available, such as workflows, multi-site management (MSM), translation, and launches.

**Universal Editor**: Delivers "a new and modern UI for content authoring." It persists all changes directly to AEM as a Cloud Service while rendering HTML that incorporates scripts, styles, and resources from Edge Delivery Services.

**Content Publishing**: Authored content is published to Edge Delivery Services, which renders semantic HTML suitable for Edge Delivery Services ingestion and delivers it with "a 100% core web vitals score."

## Authoring Workflow

The workflow follows four primary steps:

1. Content management through the AEM Sites console
2. Authoring via the Universal Editor with persistent changes to AEM
3. Publishing to Edge Delivery Services
4. High-performance delivery through Edge Delivery Services

## Page Structure

Content organization uses the same concepts as document-based authoring: blocks and sections structure pages. "Blocks are fundamental components of a page delivered by Edge Delivery Services." Authors select from default blocks provided by Adobe or custom blocks created by project developers. The Universal Editor GUI enables adding and arranging blocks, which are referred to as components. Component details are configured in the Properties panel.

## Getting Started Resources

- Universal Editor Developer Tutorial
- Creating Blocks for Universal Editor (covers definitions, decoration, and styles)
- Path mapping setup documentation
- Tabular data management via spreadsheet tools
- Publishing pages with AEM Assets

## Advanced Features

- Taxonomy data management through AEM tagging
- Code sharing across multiple sites
- Multi-site management for centralized authoring across locales and languages
- Separate staging and production environments
- Configuration templates for project setup
- Content Fragments from non-Edge Delivery Services AEM instances (Early Access)

---

# 8. Edge Delivery Services FAQ

**Source:** https://www.aem.live/docs/faq

## Architecture and Performance

- **Not a Static Site Generator**: Edge Delivery Services "dynamically renders and serves content at the edge, enabling instant updates without the need for a time-consuming build process."
- **Edge Caching**: The platform optimizes performance through "caching and real-time content rendering at the edge" with automated performance checks via Google PageSpeed Insights.
- **Target Score**: Every Edge Delivery Services site "can and should achieve a Lighthouse score of 100."

## Content Management

- **Document-Based Authoring**: Supports Microsoft Word/Excel, Google Docs/Sheets, and AEM Universal Editor.
- **Publishing Flow**: Content moves through `.page` (preview) and `.live` (published) domains.
- **URL Structure**: Only lowercase letters (a-z), numbers (0-9), and dashes (-) allowed in URLs; unsupported characters "are automatically transformed."

## Deployment and Infrastructure

- **No Build Required**: Follows "scaled trunk-based development model" with "no build process required."
- **GitHub Requirement**: "A GitHub repository is mandatory" though new BYOGIT feature allows Bitbucket, GitLab, and Azure repos.
- **Serverless Architecture**: "Fully serverless, eliminating the need for dedicated environments."
- **DNS Limit**: Subdomain format `branch--repo--owner` "cannot exceed 63 characters" per RFC 1035.

## Content Sources

- **Single Mountpoint**: "Each project can have only one content source in both fstab.yaml or the Configuration Service."
- **Multi-Origin Support**: "Many large, mature sites combine content from multiple origins" at the CDN tier.
- **Content Reuse**: Supports "fragment block" for embedding content across pages, with "headers and footers as fragments by default."

## Blocks (Components)

- **Table-Based Structure**: "Place your content inside a table with a header row containing the block name."
- **No Nesting**: "Does not support nested blocks to keep authoring simple and manageable."
- **Block Collection**: Serves as "the equivalent of Core Components."

## Authentication and Security

- **Secure Access**: Supports "secure content access for intranets, portals, and closed user groups" through CDN-tier authentication.
- **Access Control**: "Follows the access control model of its connected content source."
- **DOS Protection**: Origins "are designed to withstand common internet attacks, including typical scripted and DOS attacks."

## Backend Integration

- **Data Fetching Pattern**: "Browser -> Middleware (Edge Worker) -> Backend"
- **No SSI/ESI Support**: "Does not support *any* server-side customizations or includes."
- **Client-Side Rendering**: Generates "optimized, static markup that can be adjusted on the client side."

## Indexing and SEO

- **Auto Anchor Generation**: "Automatically generates `id` attributes for all headings" based on heading text.
- **Fragment Handling**: For dynamically loaded content, recommend "disable indexing for fragment URLs using the `noindex` directive."
- **Index Format**: Supports generating "an index (or multiple indices) of pages within a folder, storing the data in a spreadsheet and serving it as JSON."

## Performance Monitoring

- **Operational Telemetry**: Measures "how fast your site loads for actual visitors, what errors users experience, and where interactions are broken."
- **GDPR Compliance**: "All operational telemetry data is GDPR-compliant and does not collect personally identifiable information (PII)."
- **Sampling**: Operational telemetry "only samples visitor interactions and does *not* track individual users."

## Caching and Invalidation

- **Push Invalidation**: Supported for BYO CDNs including "Cloudflare, Fastly, Akamai, and CloudFront."
- **Automatic Purging**: When content publishes, "the system automatically, and surgically purges cached content at multiple levels."
- **head.html Updates**: "Automatically purges the cache for all HTML pages" when head.html changes.

## Development

- **Local Development**: Run `npm install -g @adobe/aem-cli && aem up` to start local server with "real time" updates using production content.
- **Branching**: "Create a branch in your GitHub repository" for testing new functionality.
- **Code Sync**: AEM Code Sync bot "automatically syncs it to the Codebus, making it available on both .page and .live."

## Frameworks and Technologies

- **Framework Flexibility**: "Does not require a specific frontend framework, but supports integration with frameworks like React, Angular, Vue, and Svelte."
- **CSS Frameworks**: "CSS frameworks like Less, PostCSS, and TailwindCSS can be used."
- **Web Components**: "Valuable for design systems" but "require careful lifecycle and performance management."
- **No SSR**: "Does not support *any* server-side customizations" for Lit-based or other Web Components.

## Integrations

- **AEM Ecosystem**: Integrates with AEM Forms, AEM Assets, Adobe Target, Adobe Analytics, Adobe Launch.
- **Third-Party Tools**: Supports Marketo, OneTrust, Google Tag Manager.
- **CDN Options**: Cloudflare, Fastly, CloudFront, Akamai supported.
- **Translation**: Compatible with existing "translation memory systems in content sources like SharePoint and Google Drive."
- **Forms**: No "default forms capability that sends emails on submission" but can integrate AEM Forms, Adobe Campaign, or Workfront.

## Licensing and Access

- **Part of AEM Sites**: "Part of AEM Sites and requires an AEM Sites license."
- **Free Development**: "Development access to the service does not require a separate license and is available for free."
- **Independent Operation**: "Can run independently without requiring an AEM Sites author or publish instance."

## Workflows and Approval

- **No Built-In Workflows**: "Does not provide built-in content approval workflows" but "delegates workflow management to the content source."
- **Recommended Tool**: For SharePoint/Google Drive reviews, "we recommend Adobe Workfront."

## Redirects

- **Spreadsheet-Based**: Managed through "redirects spreadsheet stored in the root folder of your project."
- **301 Only**: "Only supports 301 (permanently moved) redirects" to optimize caching.
- **Other Status Codes**: Other redirects "must be configured at the CDN level."

## Content Delivery

- **Media Bus Redirect**: Content-based assets "are uploaded to the media bus, which stores it immutably" and "redirected (via 301) to the immutable media bus URL."
- **Document Links**: "Links to documents point to their original locations in the content source."
- **Internal Links**: "Automatically converted into relative links" for `.page` and `.live` URLs.

## Localization

- **Translation Support**: Leverages "built-in translation tools of your chosen content source."
- **Folder Organization**: Organize "content into different folders for each language version."
- **HREFLang**: Supported "as part of sitemaps (sitemap.xml)" with language-specific configuration.

## Limits and Constraints

- **Branch Name Length**: Combined "branch--repo--owner" cannot exceed 63 characters.
- **Large Sites**: Largest sites "have over 100k pages and hundreds of authors."
- **Video Files**: "Short videos" supported with specific file-size limits.
- **Browser Support**: "All modern browsers, including Google Chrome, Apple Safari, and Microsoft Edge. Internet Explorer (IE) is *not* supported."

## Notable Features

- **Experimentation Framework**: Built-in framework enabling "quick test creation, execution without performance impact."
- **Snapshot Manifest**: Allows "Add/Remove individual pages to a collection" for coordinated publishing.
- **Smart Cropping**: Configurable "within AEM Assets."
- **E-Commerce**: "Can be used for e-commerce websites."
- **Landing Pages**: Well-suited; Adobe uses it for "hundreds of landing pages."

---

# Quick Reference: Key AEM EDS Concepts

## URL Pattern
- Preview: `https://<branch>--<repo>--<owner>.aem.page/`
- Live: `https://<branch>--<repo>--<owner>.aem.live/`
- Local: `http://localhost:3000`

## Project Structure
```
/
  head.html          # Server-injected <head> content
  404.html           # Custom 404 page
  scripts/
    scripts.js       # Global JS, block loading orchestration
    aem.js           # Core AEM library (do not modify)
    delayed.js       # Third-party scripts, loaded 3s+ after LCP
  styles/
    styles.css       # Global styles, LCP layout
    lazy-styles.css  # Fonts, below-fold CSS (loaded after LCP)
  blocks/
    <blockname>/
      <blockname>.js   # export default function decorate(block) {}
      <blockname>.css  # Scoped styles prefixed with .blockname
  icons/
    *.svg            # Referenced via :iconname: notation
```

## Block Pattern
- Block name = folder name = file name = CSS class name
- JS: ES Module with `export default function decorate(block) {}`
- CSS: All selectors prefixed with `.blockname`
- Options via parenthetical syntax: `BlockName (option1, option2)`

## Three-Phase Loading (E-L-D)
1. **Eager**: LCP content only, pre-LCP payload < 100kb
2. **Lazy**: Below-fold sections and blocks, lazy-loaded images
3. **Delayed**: Third-party scripts, analytics, martech (3s+ after LCP)

## Content Authoring
- Sections: separated by `---` (horizontal rule)
- Blocks: tables with merged header row as block name
- Section Metadata: special block for section-level styling
- No nested blocks allowed

## Performance Target
- Lighthouse 100 on every PR (GitHub bot enforces)
- Mobile scores are the primary metric

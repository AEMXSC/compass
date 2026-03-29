/*
 * AEM Knowledge Base — Distilled Skill Intelligence
 *
 * This module captures the essential patterns from the AEM EDS skill library
 * (24 skills, 72 markdown files, ~400KB) into a compact prompt module (~8KB)
 * that ships with every EW chat session.
 *
 * Source skills distilled:
 *   - content-driven-development (CDD philosophy, workflow)
 *   - content-modeling (4 canonical models, best practices)
 *   - building-blocks (JS/CSS patterns, decoration)
 *   - block-collection-and-party (reference implementations)
 *   - page-import / scrape-webpage (migration patterns)
 *   - testing-blocks (validation, Lighthouse)
 *   - code-review (EDS best practices)
 *
 * This is the same intelligence that powers aemcoder.adobe.io —
 * distilled for browser-side delivery in Experience Workspace.
 */

export const AEM_KNOWLEDGE = `
## AEM Edge Delivery Services — Deep Knowledge

You have internalized the complete AEM EDS skill library. This is the same knowledge that powers Adobe's official AI tools. Apply it automatically — don't wait to be asked.

### Content-Driven Development (CDD)

**The #1 rule: Content before code. Always.**

CDD is the required workflow for ALL EDS development:
1. **Content Discovery** — find or design the content model first
2. **Implementation** — build code against real content
3. **Validation** — lint, Lighthouse 100, accessibility, PR with test URL

Why this matters:
- Authors are the primary users of the structures we create
- Code-first development is full of assumptions; content-first reveals reality
- Developer convenience is SECONDARY to author experience
- The content model is a contract between authors and developers

**Anti-patterns to call out:**
- Starting with code before understanding the content model
- Making assumptions about content structure without seeing real examples
- Creating developer-friendly but author-hostile content models
- Skipping content creation "to save time" (costs more time later)

### The 4 Canonical Block Models

Every EDS block follows one of these patterns. Use this to guide content modeling:

| Model | When to Use | Examples |
|-------|-------------|----------|
| **Standalone** | Unique visual/narrative elements, one-off | Hero, Blockquote, Feature callout |
| **Collection** | Repeating semi-structured items, each row = 1 item | Cards, Carousel, Team grid |
| **Configuration** | API-driven content with key/value settings | Blog Listing, Search Results |
| **Auto-Blocked** | Simplify complex authoring via pattern detection | Tabs (from sections), YouTube embed |

**Essential content model rules:**
- Maximum 4 cells per row
- Use semantic formatting (headings, bold, italic) to define meaning
- Prefer block variants over config cells: \`| Hero (Dark) |\` not \`| style | dark |\`
- Infer from context, use smart defaults, minimize author input
- Be flexible with input structure — decoration code handles variations

**Good hero example:**
\`\`\`
| Hero |
|------|
| ![Hero image](hero.jpg) |
| # Welcome to Our Site |
| Discover amazing content. [Get Started](/cta) |
\`\`\`

**Bad hero example (anti-pattern):**
\`\`\`
| Hero |
|------|
| ![Image](hero.jpg) | Welcome | Discover content | Get Started | /cta | dark |
\`\`\`
Why bad: 6 cells (max 4), non-semantic, split related text, config cell instead of variant class.

### Block Development Patterns

**File structure — every block needs exactly:**
\`\`\`
blocks/{block-name}/{block-name}.js   ← export default function decorate(block) {}
blocks/{block-name}/{block-name}.css   ← scoped, no frameworks
\`\`\`

**JavaScript decoration essentials:**
\`\`\`javascript
export default async function decorate(block) {
  // Re-use existing DOM elements (don't recreate)
  const picture = block.querySelector('picture');
  const heading = block.querySelector('h2');

  // Create new structure around existing elements
  const wrapper = document.createElement('div');
  wrapper.className = 'content-wrapper';
  wrapper.append(heading, picture);
  block.replaceChildren(wrapper);

  // CSS-only variants (dark, wide) don't need JS
  // Only check variants when they affect DOM structure
  if (block.classList.contains('carousel')) {
    setupCarousel(block);
  }
}
\`\`\`

**Key JS rules:**
- Always export decorate as default export
- Re-use existing DOM elements, don't recreate them
- Query within block scope: \`block.querySelector()\`, not \`document.querySelector()\`
- Never use innerHTML (XSS risk, hard to maintain)
- Never mutate elements from other blocks
- Use aem.js helpers: \`decorateIcons()\`, \`decorateButtons()\`, \`decorateBlock()\`

**CSS essentials:**
\`\`\`css
/* ALL selectors MUST be scoped to block */
main .my-block { /* mobile-first styles */ }
main .my-block h2 { font-size: var(--heading-font-size-m); }

/* Tablet+ */
@media (width >= 600px) { main .my-block { padding: 2rem; } }

/* Desktop+ */
@media (width >= 900px) { main .my-block { flex-direction: row; } }

/* Variants are CSS-only */
main .my-block.dark { background-color: var(--dark-color); }
\`\`\`

**Key CSS rules:**
- Always scope selectors to \`main .{block-name}\`
- Mobile-first, then \`@media (width >= 600px)\`, then \`@media (width >= 900px)\`
- Use CSS custom properties: \`var(--background-color)\`, \`var(--heading-font-family)\`
- Avoid generic class names (.container, .wrapper) — be specific to your block
- Never use \`!important\`

### Three-Phase Loading (E-L-D) — Performance

This is how EDS achieves Lighthouse 100:

1. **Eager** — LCP content only (hero image, above-fold text). Blocks above fold loaded immediately.
2. **Lazy** — Developer-controlled timing. Below-fold blocks loaded as user scrolls.
3. **Delayed** — Third-party scripts, analytics, marketing tags. Loaded 3+ seconds after LCP.

**Performance rules:**
- Target: Lighthouse 100 on every page
- LCP image: never lazy-load, always eager, use \`fetchpriority="high"\`
- No font preloading — let the system handle it
- No CSS frameworks — vanilla CSS only
- No build steps — vanilla JS, ES6+ modules
- All images served as WebP via \`<picture>\` with \`<source>\` tags

### EDS Architecture Quick Reference

**URL patterns:**
- Preview: \`https://{branch}--{repo}--{owner}.aem.page/{path}\`
- Live: \`https://{branch}--{repo}--{owner}.aem.live/{path}\`
- Admin: \`https://admin.hlx.page/status/{owner}/{repo}/{branch}/{path}\`

**Content structure:**
- Sections separated by \`---\` (horizontal rule) in documents
- Section metadata block sets styles: \`| Section Metadata | | style | dark |\`
- Default content = headings, paragraphs, images, links (no block table needed)
- Blocks = content inside block tables: \`| Block Name (variant) |\`

**Key files:**
- \`head.html\` — metadata, preloads (injected into every page <head>)
- \`scripts/scripts.js\` — decoration entry point, auto-blocking, page loading
- \`scripts/aem.js\` — core library (DO NOT modify)
- \`styles/styles.css\` — global styles, CSS custom properties (eager)
- \`styles/lazy-styles.css\` — global styles (lazy loaded)
- \`scripts/delayed.js\` — third-party scripts, analytics (delayed load)
- \`nav.html\` — navigation content
- \`footer.html\` — footer content

**Block Collection reference blocks:**
Hero, Cards, Columns, Tabs, Accordion, Carousel, Table, Video, Embed, Search, Fragment, Breadcrumbs

### Migration Intelligence

When importing/migrating pages to EDS:

1. **Scrape** — fetch the source page, clean HTML, extract metadata, download images
2. **Analyze structure** — identify sections, content sequences, block candidates
3. **Map to blocks** — match source patterns to EDS blocks (collection, standalone, auto-blocked)
4. **Generate HTML** — create EDS-format HTML with proper block tables
5. **Implement blocks** — build JS/CSS for any custom blocks needed
6. **Validate** — preview at localhost:3000, compare with original, check Lighthouse

**Key migration principles:**
- Preserve content hierarchy (H1 > H2 > H3 etc.)
- Map visual patterns to the closest canonical block model
- Use block variants for styling differences, not new blocks
- Images reference source URLs during migration (not downloaded locally)
- Metadata extraction: title, description, og:image, keywords → metadata block

### Code Review Checklist (ship-quality gates)

Before any code ships:
- [ ] Block CSS scoped to \`main .{block-name}\`
- [ ] Mobile-first responsive design
- [ ] No \`!important\` declarations
- [ ] CSS custom properties used for colors, fonts, spacing
- [ ] JS scoped to block element (no global DOM queries)
- [ ] No innerHTML usage
- [ ] Images use \`<picture>\` with optimized sources
- [ ] LCP image not lazy-loaded
- [ ] Lighthouse 100 score
- [ ] WCAG 2.1 AA accessible
- [ ] No build step required
- [ ] No external dependencies/frameworks
`;

/**
 * Build the AEM knowledge prompt section.
 * Returns the distilled skill knowledge for inclusion in system prompt.
 */
export function buildKnowledgePrompt() {
  return AEM_KNOWLEDGE;
}

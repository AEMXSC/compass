# AEM EDS Block Catalog — Standard Library

Source: `sta-boilerplate` / `sta-xwalk-boilerplate` (same blocks used by AEMCoder)
Library: `https://main--sta-xwalk-boilerplate--aemysites.aem.page/tools/sidekick/library.json`

## Quick Reference

| Block | Variants | Columns | Use Case |
|-------|----------|---------|----------|
| Hero | — | 1 col, 3 rows | Banner with background image, headline, CTA |
| Cards | (no images) | 2 col or 1 col | Card grid with image + title + description |
| Columns | — | N columns | Side-by-side content layout |
| Tabs | — | 2 col | Tabbed content sections |
| Accordion | — | 2 col | Collapsible FAQ/content sections |
| Carousel | — | 2 col | Rotating slides with image + text |
| Table | (striped), (bordered), (striped & bordered), (no header) | N col | Data tables |
| Video | — | 1 col | Embedded video player |
| Embed | (video), (social) | 1 col | External media (YouTube, Vimeo, Twitter) |
| Search | — | 1 col | Site search with query index |

---

## Hero
Captures attention with prominent image, headline, and CTA. Placed at top of page.

**Structure:** 1 column, 3 rows
- Row 1: Block name `Hero`
- Row 2: Background image
- Row 3: Title (H1) + Subheading + CTA link

**HTML pattern:**
```html
<div class="hero">
  <div><div><picture>...</picture></div></div>
  <div><div>
    <h1><strong>Heading</strong></h1>
    <h2>Subheading</h2>
    <p>Description</p>
  </div></div>
</div>
```

---

## Cards
Card-based layout for features, products, or articles.

**Structure:** 2 columns (with images) or 1 column (no images)
- Row 1: Block name `Cards` or `Cards (no images)`
- Each row = one card: Image (col 1) + Text content (col 2)
- Text can include: bold title, description, CTA link

**HTML pattern:**
```html
<div class="cards">
  <div>
    <div><picture>...</picture></div>
    <div>
      <p><strong>Card Title</strong></p>
      <p>Card description text</p>
    </div>
  </div>
  <!-- more card rows -->
</div>
```

**No images variant:**
```html
<div class="cards">
  <div><div>
    <p><strong>Title</strong></p>
    <p>Description</p>
  </div></div>
</div>
```

---

## Columns
Side-by-side content in a responsive grid.

**Structure:** N columns, multiple rows
- Row 1: Block name `Columns`
- Each cell becomes a column (text, images, or mixed)
- All rows must have same number of columns

**HTML pattern:**
```html
<div class="columns">
  <div>
    <div><p>Left content</p><ul><li>Item</li></ul></div>
    <div><picture>...</picture></div>
  </div>
</div>
```

---

## Tabs
Tabbed interface for organizing related content.

**Structure:** 2 columns, multiple rows
- Row 1: Block name `Tabs`
- Col 1: Tab label (mandatory)
- Col 2: Tab content (mandatory)

**HTML pattern:**
```html
<div class="tabs">
  <div>
    <div>Tab One</div>
    <div>Content for tab one...</div>
  </div>
  <div>
    <div>Tab Two</div>
    <div><p>Content for tab two...</p></div>
  </div>
</div>
```

---

## Accordion
Collapsible sections for FAQs or grouped content.

**Structure:** 2 columns, multiple rows
- Row 1: Block name `Accordion`
- Col 1: Title/question (mandatory)
- Col 2: Content/answer (mandatory)

**HTML pattern:**
```html
<div class="accordion">
  <div>
    <div>Question text?</div>
    <div>Answer content with <strong>formatting</strong>.</div>
  </div>
</div>
```

---

## Carousel
Rotating slides with images and optional text.

**Structure:** 2 columns, multiple rows
- Row 1: Block name `Carousel`
- Col 1: Image (mandatory)
- Col 2: Title (H2) + description + optional CTA

**HTML pattern:**
```html
<div class="carousel">
  <div>
    <div><picture>...</picture></div>
    <div>
      <h2><strong>Slide Title</strong></h2>
      <p>Slide description.</p>
    </div>
  </div>
</div>
```

---

## Table
Tabular data display with multiple variant options.

**Variants:**
- `Table` — basic table with header row
- `Table (striped)` — alternating row backgrounds
- `Table (bordered)` — borders on every cell
- `Table (striped & bordered)` — both combined
- `Table (no header)` — no header row

**Structure:** N columns, multiple rows
- Row 1: Block name + variant
- Row 2: Header labels (unless no-header)
- Rows 3+: Data

**HTML pattern:**
```html
<div class="table striped">
  <div><div>Make</div><div>Model</div><div>Year</div></div>
  <div><div>Mazda</div><div>RX-7</div><div>1989</div></div>
</div>
```

---

## Video
Embedded video player for standalone video.

**Structure:** 1 column, 2 rows
- Row 1: Block name `Video`
- Row 2: Optional poster image + video URL

**HTML pattern:**
```html
<div class="video">
  <div><div>
    <p><picture>...</picture></p>
    <p><a href="https://youtube.com/watch?v=...">video URL</a></p>
  </div></div>
</div>
```

---

## Embed
External content embedding (video platforms, social media).

**Variants:**
- `Embed` — generic, auto-detects type
- Video: YouTube, Vimeo with optional poster image
- Social: Twitter/X posts

**Structure:** 1 column, 2 rows
- Row 1: Block name `Embed`
- Row 2: URL to external content (+ optional poster image above URL)

**HTML pattern:**
```html
<div class="embed">
  <div><div>
    <p><picture>...</picture></p>
    <p><a href="https://vimeo.com/454418448">https://vimeo.com/454418448</a></p>
  </div></div>
</div>
```

---

## Search
Site search powered by query index.

**Structure:** 1 column, 2 rows
- Row 1: Block name `Search`
- Row 2: Absolute URL to query-index.json

**HTML pattern:**
```html
<div class="search">
  <div><div>
    <a href="https://site.com/query-index.json">query index URL</a>
  </div></div>
</div>
```

---

## Block Rules (Universal)

1. **Naming:** block name = folder name = file name = CSS class (kebab-case)
2. **No nesting:** blocks cannot be placed inside other blocks
3. **Sections:** blocks live inside sections, separated by `---` (horizontal rule)
4. **Variants:** specified in parentheses: `Cards (no images)` → class `cards no-images`
5. **Section metadata:** `Section Metadata` block at end of section for style/background
6. **Metadata:** `Metadata` block at end of page for title, description, image
7. **Default content:** headings, paragraphs, images, links outside blocks = "default content"
8. **Three-phase loading:** Eager (LCP) → Lazy (below fold) → Delayed (3s+ martech)

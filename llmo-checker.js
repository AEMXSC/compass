/**
 * LLMO Citation Readability Checker
 *
 * Replicates the core logic of Adobe's LLM Optimizer Chrome Extension:
 * 1. Fetch the page as an AI crawler would (raw server HTML)
 * 2. Compare against fully rendered (human) HTML
 * 3. Convert both to text/markdown
 * 4. Calculate Citation Readability Score
 *
 * Uses Turndown.js (same lib the LLMO extension bundles) for HTML→Markdown.
 */

/* ── Turndown loader (lazy, from CDN) ── */
let TurndownService = null;

async function ensureTurndown() {
  if (TurndownService) return;
  if (window.TurndownService) { TurndownService = window.TurndownService; return; }
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.min.js';
    s.onload = () => { TurndownService = window.TurndownService; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* ── Text extraction helpers ── */

function htmlToMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg']);
  return td.turndown(html);
}

function extractVisibleText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove invisible elements
  doc.querySelectorAll('script, style, noscript, iframe, svg, [hidden], [aria-hidden="true"]').forEach((el) => el.remove());
  return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/* ── Similarity scoring ── */

function calculateOverlap(agentText, humanText) {
  if (!humanText || humanText.length === 0) return { score: 0, missing: [] };

  const agentWords = new Set(agentText.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const humanWords = humanText.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const humanWordSet = new Set(humanWords);

  if (humanWordSet.size === 0) return { score: 100, missing: [] };

  let found = 0;
  const missingWords = new Set();

  for (const word of humanWordSet) {
    if (agentWords.has(word)) {
      found += 1;
    } else {
      missingWords.add(word);
    }
  }

  const score = Math.round((found / humanWordSet.size) * 100);
  // Get top missing content words (skip common words)
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'will', 'with', 'this', 'that', 'from', 'they', 'were']);
  const missing = [...missingWords].filter((w) => !stopWords.has(w) && w.length > 3).slice(0, 20);

  return { score, missing };
}

/* ── Main analysis function ── */

/**
 * Analyze a URL for AI citation readability.
 * @param {string} url - The page URL to analyze
 * @param {string} [renderedHTML] - Pre-fetched rendered HTML (from iframe). If not provided, only agent view is analyzed.
 * @returns {Promise<object>} Analysis result with score, views, and recommendations
 */
export async function checkCitationReadability(url, renderedHTML) {
  await ensureTurndown();

  const result = {
    url,
    timestamp: new Date().toISOString(),
    agentView: { available: false, wordCount: 0, markdown: '' },
    humanView: { available: false, wordCount: 0 },
    score: null,
    grade: '',
    missingContent: [],
    recommendations: [],
    isEDS: false,
  };

  /* ── Step 1: Fetch as AI crawler (agent view) ── */
  let agentHTML = '';
  try {
    // For AEM EDS pages, .plain.html gives the pure server content
    const isAEMPage = /\.(aem\.(page|live)|hlx\.(page|live))/.test(url);
    const fetchUrl = isAEMPage
      ? url.replace(/\/?(\?.*)?$/, '.plain.html$1')
      : url;

    result.isEDS = isAEMPage;

    const resp = await fetch(fetchUrl, {
      headers: { Accept: 'text/html' },
    });

    if (resp.ok) {
      agentHTML = await resp.text();
      result.agentView.available = true;
    }
  } catch (e) {
    result.agentView.error = `Fetch failed: ${e.message}`;
  }

  /* ── Step 2: Process agent view ── */
  if (agentHTML) {
    const agentText = extractVisibleText(agentHTML);
    result.agentView.wordCount = wordCount(agentText);
    try {
      result.agentView.markdown = htmlToMarkdown(agentHTML);
    } catch {
      result.agentView.markdown = agentText;
    }
  }

  /* ── Step 3: Process human view ── */
  if (renderedHTML) {
    const humanText = extractVisibleText(renderedHTML);
    result.humanView.available = true;
    result.humanView.wordCount = wordCount(humanText);

    /* ── Step 4: Calculate Citation Readability Score ── */
    if (result.agentView.available) {
      const agentText = extractVisibleText(agentHTML);
      const { score, missing } = calculateOverlap(agentText, humanText);
      result.score = score;
      result.missingContent = missing;

      // Grade
      if (score >= 90) result.grade = 'A';
      else if (score >= 75) result.grade = 'B';
      else if (score >= 50) result.grade = 'C';
      else if (score >= 25) result.grade = 'D';
      else result.grade = 'F';
    }
  } else if (result.agentView.available) {
    // No human view — estimate content richness from agent view alone
    result.humanView.note = 'Human view not available. Scoring based on agent-visible content only.';

    // Heuristic: check for JS framework markers that signal client-rendered content
    const frameworkSignals = [
      'id="root"', 'id="app"', 'id="__next"', 'ng-app', 'ng-version',
      'data-reactroot', '__NEXT_DATA__', 'window.__INITIAL_STATE__',
      'noscript', '<app-root',
    ];
    const signalCount = frameworkSignals.filter((s) => agentHTML.includes(s)).length;
    const wc = result.agentView.wordCount;

    if (result.isEDS) {
      // EDS pages serve full content in raw HTML — high confidence
      result.score = wc > 50 ? 95 : (wc > 10 ? 75 : 40);
    } else if (signalCount >= 2 || wc < 50) {
      // Likely SPA / client-rendered — most content hidden from AI
      result.score = Math.min(wc, 30);
    } else {
      // Traditional server-rendered — moderate confidence
      result.score = Math.min(85, Math.round(wc / 5));
    }

    if (result.score >= 90) result.grade = 'A';
    else if (result.score >= 75) result.grade = 'B';
    else if (result.score >= 50) result.grade = 'C';
    else if (result.score >= 25) result.grade = 'D';
    else result.grade = 'F';

    result.agentView.frameworkSignals = signalCount;
    result.agentView.estimatedOnly = true;
  }

  /* ── Step 5: Generate recommendations ── */
  if (result.isEDS) {
    result.recommendations.push(
      'AEM Edge Delivery Services pages are server-rendered by default, which gives excellent AI visibility.',
    );
    if (result.score >= 90) {
      result.recommendations.push(
        'This page scores very high — AI agents can read nearly all the content. This is the EDS advantage.',
      );
    }
  }

  if (result.agentView.frameworkSignals >= 2) {
    result.recommendations.push(
      'This page appears to use a JavaScript framework (React, Angular, Next.js, etc.). Most content is likely rendered client-side and invisible to AI crawlers.',
    );
  }

  if (result.score !== null && result.score < 75) {
    result.recommendations.push(
      'Content hidden from AI agents may include: JavaScript-rendered text, content behind click interactions, lazy-loaded sections.',
    );
    if (!result.isEDS) {
      result.recommendations.push(
        'AEM Edge Delivery Services solves this — pages are server-rendered by default, making all content immediately visible to AI agents.',
      );
    }
  }

  if (result.missingContent.length > 0) {
    result.recommendations.push(
      `Key content words missing from agent view: ${result.missingContent.slice(0, 10).join(', ')}`,
    );
  }

  if (result.agentView.wordCount > 0 && result.humanView.wordCount > 0) {
    const ratio = result.agentView.wordCount / result.humanView.wordCount;
    if (ratio < 0.5) {
      result.recommendations.push(
        `Agent view has only ${result.agentView.wordCount} words vs. ${result.humanView.wordCount} words in human view (${Math.round(ratio * 100)}% content ratio). Significant content is invisible to AI.`,
      );
    }
  }

  return result;
}

/**
 * Format analysis result for chat display.
 */
export function formatResultForChat(result) {
  const lines = [];

  lines.push(`## Citation Readability Report`);
  lines.push(`**URL:** ${result.url}`);
  lines.push('');

  if (result.score !== null) {
    const est = result.agentView.estimatedOnly ? ' (estimated)' : '';
    lines.push(`### Score: ${result.score}%${est} (Grade: ${result.grade})`);
  } else {
    lines.push(`### Agent View Analysis`);
  }
  lines.push('');

  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Agent view words | ${result.agentView.wordCount} |`);
  if (result.humanView.available) {
    lines.push(`| Human view words | ${result.humanView.wordCount} |`);
  }
  if (result.agentView.frameworkSignals > 0) {
    lines.push(`| JS framework signals | ${result.agentView.frameworkSignals} detected |`);
  }
  if (result.score !== null) {
    lines.push(`| Citation readability | ${result.score}% |`);
  }
  lines.push(`| Page type | ${result.isEDS ? 'AEM Edge Delivery (server-rendered)' : 'Standard web page'} |`);
  lines.push('');

  if (result.recommendations.length > 0) {
    lines.push(`### Insights`);
    result.recommendations.forEach((r) => lines.push(`- ${r}`));
    lines.push('');
  }

  if (result.agentView.markdown) {
    const preview = result.agentView.markdown.length > 1500
      ? `${result.agentView.markdown.slice(0, 1500)}\n\n[... truncated]`
      : result.agentView.markdown;
    lines.push(`### Agent View (Markdown — what LLMs see)`);
    lines.push('```markdown');
    lines.push(preview);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Generate a full-page HTML report for rendering in the preview iframe.
 * Inspired by the Adobe LLMO Chrome Extension visual layout.
 */
export function renderResultsHTML(result) {
  const score = result.score ?? 0;
  const estimated = result.agentView.estimatedOnly;
  const scoreColor = score >= 90 ? '#34d399' : score >= 75 ? '#fbbf24' : score >= 50 ? '#f97316' : '#ef4444';
  const gradeLabel = result.grade || 'N/A';

  // SVG gauge arc (270 degree sweep)
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const arcFraction = (score / 100) * 0.75; // 270deg = 0.75 of full circle
  const dashOffset = circumference * (1 - arcFraction);

  // Escape HTML for safe rendering
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const agentMd = esc(result.agentView.markdown || '(no content)');
  const missingHTML = result.missingContent.length > 0
    ? result.missingContent.map((w) => `<span class="tag tag-missing">${esc(w)}</span>`).join('')
    : '<span class="tag tag-ok">None — all content visible</span>';

  const recsHTML = result.recommendations.map((r) => `<li>${esc(r)}</li>`).join('');

  const frameworkBadges = (result.agentView.frameworkSignals || 0) > 0
    ? `<div class="stat-card stat-warning">
        <div class="stat-value">${result.agentView.frameworkSignals}</div>
        <div class="stat-label">JS Framework Signals</div>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Visibility Report</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface-2: #232731;
    --border: rgba(255,255,255,0.08);
    --text: #e4e4e7;
    --text-muted: #71717a;
    --accent: ${scoreColor};
    --purple: #8b5cf6;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    overflow-x: hidden;
  }

  /* ── Header bar ── */
  .report-header {
    background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%);
    padding: 24px 32px;
    display: flex;
    align-items: center;
    gap: 24px;
    border-bottom: 1px solid var(--border);
  }
  .report-header .adobe-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: rgba(255,255,255,0.6);
    white-space: nowrap;
  }
  .report-header .adobe-badge svg { flex-shrink: 0; }
  .report-header .report-url {
    flex: 1;
    font-size: 13px;
    color: rgba(255,255,255,0.7);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .report-header .page-type-badge {
    font-size: 10px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-weight: 600;
    white-space: nowrap;
  }
  .page-type-badge.eds {
    background: rgba(52,211,153,0.15);
    color: #34d399;
  }
  .page-type-badge.standard {
    background: rgba(251,191,36,0.15);
    color: #fbbf24;
  }

  /* ── Score section ── */
  .score-section {
    display: flex;
    align-items: center;
    gap: 40px;
    padding: 32px;
    border-bottom: 1px solid var(--border);
  }
  .gauge-wrap {
    position: relative;
    width: 160px;
    height: 160px;
    flex-shrink: 0;
  }
  .gauge-svg {
    transform: rotate(135deg);
    width: 160px;
    height: 160px;
  }
  .gauge-bg {
    fill: none;
    stroke: var(--surface-2);
    stroke-width: 10;
    stroke-dasharray: ${(circumference * 0.75).toFixed(1)} ${circumference.toFixed(1)};
    stroke-linecap: round;
  }
  .gauge-fill {
    fill: none;
    stroke: var(--accent);
    stroke-width: 10;
    stroke-dasharray: ${(circumference * 0.75).toFixed(1)} ${circumference.toFixed(1)};
    stroke-dashoffset: ${dashOffset.toFixed(1)};
    stroke-linecap: round;
    transition: stroke-dashoffset 1.2s ease-out;
    filter: drop-shadow(0 0 8px ${scoreColor}40);
  }
  .gauge-center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
  }
  .gauge-score {
    font-size: 42px;
    font-weight: 700;
    color: var(--accent);
    line-height: 1;
  }
  .gauge-score sup {
    font-size: 18px;
    font-weight: 400;
    opacity: 0.7;
  }
  .gauge-label {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .gauge-grade {
    display: inline-block;
    margin-top: 6px;
    font-size: 12px;
    font-weight: 700;
    padding: 2px 12px;
    border-radius: 9999px;
    background: ${scoreColor}20;
    color: var(--accent);
  }

  .score-details {
    flex: 1;
  }
  .stat-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 20px;
    min-width: 120px;
    flex: 1;
  }
  .stat-card.stat-warning {
    border-color: rgba(249,115,22,0.3);
    background: rgba(249,115,22,0.05);
  }
  .stat-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text);
  }
  .stat-warning .stat-value { color: #f97316; }
  .stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 2px;
  }

  /* ── Recommendations ── */
  .insights-section {
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
  }
  .section-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 12px;
  }
  .insights-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .insights-list li {
    font-size: 13px;
    color: var(--text);
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    line-height: 1.5;
  }

  /* ── Missing content tags ── */
  .missing-section {
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
  }
  .tag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tag {
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  }
  .tag-missing {
    background: rgba(239,68,68,0.1);
    color: #f87171;
    border: 1px solid rgba(239,68,68,0.2);
  }
  .tag-ok {
    background: rgba(52,211,153,0.1);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.2);
  }

  /* ── Agent view markdown ── */
  .markdown-section {
    padding: 24px 32px 40px;
  }
  .view-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .view-tab {
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
  }
  .view-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .view-content {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    max-height: 500px;
    overflow-y: auto;
  }
  .view-content pre {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
  }
  .view-content::-webkit-scrollbar { width: 6px; }
  .view-content::-webkit-scrollbar-track { background: transparent; }
  .view-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  /* ── Footer ── */
  .report-footer {
    padding: 16px 32px;
    text-align: center;
    font-size: 11px;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
  }
  .report-footer a { color: var(--purple); text-decoration: none; }
</style>
</head>
<body>

  <!-- Header -->
  <div class="report-header">
    <div class="adobe-badge">
      <svg width="20" height="17" viewBox="0 0 30 26" fill="none"><path d="M11.5 0H0V26L11.5 0Z" fill="#EB1000"/><path d="M18.5 0H30V26L18.5 0Z" fill="#EB1000"/><path d="M15 9.5L21.5 26H17L14.5 19H10L15 9.5Z" fill="#EB1000"/></svg>
      AI Visibility Report
    </div>
    <div class="report-url">${esc(result.url)}</div>
    <span class="page-type-badge ${result.isEDS ? 'eds' : 'standard'}">
      ${result.isEDS ? 'AEM Edge Delivery' : 'Standard Web Page'}
    </span>
  </div>

  <!-- Score Gauge + Stats -->
  <div class="score-section">
    <div class="gauge-wrap">
      <svg class="gauge-svg" viewBox="0 0 140 140">
        <circle class="gauge-bg" cx="70" cy="70" r="${radius}"/>
        <circle class="gauge-fill" cx="70" cy="70" r="${radius}"/>
      </svg>
      <div class="gauge-center">
        <div class="gauge-score">${score}<sup>%</sup></div>
        <div class="gauge-label">Citation Readability${estimated ? ' (est.)' : ''}</div>
        <span class="gauge-grade">Grade ${gradeLabel}</span>
      </div>
    </div>
    <div class="score-details">
      <div class="stat-row">
        <div class="stat-card">
          <div class="stat-value">${result.agentView.wordCount.toLocaleString()}</div>
          <div class="stat-label">Agent View Words</div>
        </div>
        ${result.humanView.available ? `
        <div class="stat-card">
          <div class="stat-value">${result.humanView.wordCount.toLocaleString()}</div>
          <div class="stat-label">Human View Words</div>
        </div>` : ''}
        ${frameworkBadges}
        <div class="stat-card">
          <div class="stat-value">${result.missingContent.length}</div>
          <div class="stat-label">Missing Words</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Insights -->
  ${recsHTML ? `
  <div class="insights-section">
    <div class="section-title">Insights</div>
    <ul class="insights-list">${recsHTML}</ul>
  </div>` : ''}

  <!-- Missing Content -->
  <div class="missing-section">
    <div class="section-title">Missing Content Words</div>
    <div class="tag-row">${missingHTML}</div>
  </div>

  <!-- Agent View (Markdown) -->
  <div class="markdown-section">
    <div class="section-title">Agent View — What LLMs See</div>
    <div class="view-tabs">
      <button class="view-tab active" onclick="showTab('md')">Markdown</button>
      <button class="view-tab" onclick="showTab('raw')">Raw HTML</button>
    </div>
    <div class="view-content" id="viewContent">
      <pre id="mdView">${agentMd}</pre>
    </div>
  </div>

  <div class="report-footer">
    Powered by Adobe LLM Optimizer &middot; ${esc(result.timestamp)}
  </div>

  <script>
    const rawHTML = ${JSON.stringify(result.agentView.markdown || '')};
    function showTab(t) {
      document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      const pre = document.getElementById('mdView');
      pre.textContent = t === 'raw' ? document.body.parentElement.dataset.agentHtml || '(raw HTML not available)' : rawHTML;
    }
  </script>
</body>
</html>`;
}

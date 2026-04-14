/*
 * Governance Scanner — Client-side DOM analysis
 * Scans iframe content for a11y, SEO, brand, and legal compliance
 */

export function scanPage(iframeDoc) {
  if (!iframeDoc) return null;

  const results = {
    brand: { pass: 0, fail: 0, warn: 0, issues: [] },
    legal: { pass: 0, fail: 0, warn: 0, issues: [] },
    a11y: { pass: 0, fail: 0, warn: 0, issues: [] },
    seo: { pass: 0, fail: 0, warn: 0, issues: [] },
    images: { pass: 0, fail: 0, warn: 0, issues: [] },
  };

  scanAccessibility(iframeDoc, results.a11y);
  scanSEO(iframeDoc, results.seo);
  scanImages(iframeDoc, results.images);
  scanLegal(iframeDoc, results.legal);
  scanBrand(iframeDoc, results.brand);

  const total = Object.values(results).reduce(
    (acc, cat) => {
      acc.pass += cat.pass;
      acc.fail += cat.fail;
      acc.warn += cat.warn;
      return acc;
    },
    { pass: 0, fail: 0, warn: 0 },
  );

  const totalChecks = total.pass + total.fail + total.warn;
  const score = totalChecks > 0
    ? Math.round(((total.pass + total.warn * 0.5) / totalChecks) * 100)
    : 100;

  return { results, score, total };
}

function scanAccessibility(doc, a11y) {
  // Check images for alt text
  const imgs = doc.querySelectorAll('img');
  imgs.forEach((img) => {
    if (!img.alt || img.alt.trim() === '') {
      a11y.fail++;
      a11y.issues.push({
        severity: 'fail',
        message: `Image missing alt text: ${img.src?.split('/').pop() || 'unknown'}`,
        element: 'img',
        fixable: true,
        fix: 'Add descriptive alt text',
      });
    } else {
      a11y.pass++;
    }
  });

  // Check heading hierarchy
  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let lastLevel = 0;
  let h1Count = 0;
  headings.forEach((h) => {
    const level = parseInt(h.tagName[1], 10);
    if (level === 1) h1Count++;
    if (lastLevel > 0 && level > lastLevel + 1) {
      a11y.warn++;
      a11y.issues.push({
        severity: 'warn',
        message: `Heading hierarchy skip: h${lastLevel} → h${level} ("${h.textContent.slice(0, 40)}")`,
        element: h.tagName,
        fixable: false,
      });
    } else {
      a11y.pass++;
    }
    lastLevel = level;
  });

  if (h1Count === 0) {
    a11y.fail++;
    a11y.issues.push({ severity: 'fail', message: 'No h1 element found', element: 'h1', fixable: false });
  } else if (h1Count > 1) {
    a11y.warn++;
    a11y.issues.push({ severity: 'warn', message: `Multiple h1 elements (${h1Count})`, element: 'h1', fixable: false });
  } else {
    a11y.pass++;
  }

  // Check lang attribute
  if (!doc.documentElement.lang) {
    a11y.warn++;
    a11y.issues.push({ severity: 'warn', message: 'Missing lang attribute on <html>', element: 'html', fixable: true });
  } else {
    a11y.pass++;
  }

  // Check for skip links
  const firstLink = doc.querySelector('a');
  if (!firstLink || !firstLink.getAttribute('href')?.startsWith('#')) {
    a11y.warn++;
    a11y.issues.push({ severity: 'warn', message: 'No skip navigation link found', element: 'nav', fixable: true });
  } else {
    a11y.pass++;
  }

  // Check buttons have accessible names
  const buttons = doc.querySelectorAll('button');
  buttons.forEach((btn) => {
    if (!btn.textContent?.trim() && !btn.getAttribute('aria-label') && !btn.getAttribute('title')) {
      a11y.fail++;
      a11y.issues.push({ severity: 'fail', message: 'Button without accessible name', element: 'button', fixable: true });
    } else {
      a11y.pass++;
    }
  });

  // Check form inputs have labels
  const inputs = doc.querySelectorAll('input, textarea, select');
  inputs.forEach((input) => {
    const id = input.id;
    const hasLabel = id && doc.querySelector(`label[for="${id}"]`);
    const hasAriaLabel = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
    if (!hasLabel && !hasAriaLabel && input.type !== 'hidden') {
      a11y.warn++;
      a11y.issues.push({ severity: 'warn', message: `Form input without label: ${input.type || 'text'}`, element: 'input', fixable: true });
    } else {
      a11y.pass++;
    }
  });
}

function scanSEO(doc, seo) {
  // Title
  const title = doc.querySelector('title');
  if (!title || !title.textContent?.trim()) {
    seo.fail++;
    seo.issues.push({ severity: 'fail', message: 'Missing page title', element: 'title', fixable: true });
  } else if (title.textContent.length > 60) {
    seo.warn++;
    seo.issues.push({ severity: 'warn', message: `Title too long (${title.textContent.length} chars, max 60)`, element: 'title', fixable: true });
  } else {
    seo.pass++;
  }

  // Meta description
  const metaDesc = doc.querySelector('meta[name="description"]');
  if (!metaDesc || !metaDesc.content?.trim()) {
    seo.fail++;
    seo.issues.push({ severity: 'fail', message: 'Missing meta description', element: 'meta', fixable: true, fix: 'Generate from page content' });
  } else if (metaDesc.content.length > 160) {
    seo.warn++;
    seo.issues.push({ severity: 'warn', message: `Meta description too long (${metaDesc.content.length} chars, max 160)`, element: 'meta', fixable: true });
  } else {
    seo.pass++;
  }

  // OG tags
  const ogTitle = doc.querySelector('meta[property="og:title"]');
  const ogDesc = doc.querySelector('meta[property="og:description"]');
  const ogImage = doc.querySelector('meta[property="og:image"]');

  if (!ogTitle) {
    seo.warn++;
    seo.issues.push({ severity: 'warn', message: 'Missing og:title', element: 'meta', fixable: true });
  } else { seo.pass++; }

  if (!ogDesc) {
    seo.warn++;
    seo.issues.push({ severity: 'warn', message: 'Missing og:description', element: 'meta', fixable: true });
  } else { seo.pass++; }

  if (!ogImage) {
    seo.warn++;
    seo.issues.push({ severity: 'warn', message: 'Missing og:image', element: 'meta', fixable: true });
  } else { seo.pass++; }

  // Canonical
  const canonical = doc.querySelector('link[rel="canonical"]');
  if (!canonical) {
    seo.warn++;
    seo.issues.push({ severity: 'warn', message: 'Missing canonical URL', element: 'link', fixable: true });
  } else { seo.pass++; }

  // Check for empty links
  const links = doc.querySelectorAll('a');
  let emptyLinks = 0;
  links.forEach((link) => {
    if (!link.textContent?.trim() && !link.querySelector('img') && !link.getAttribute('aria-label')) {
      emptyLinks++;
    }
  });
  if (emptyLinks > 0) {
    seo.warn++;
    seo.issues.push({ severity: 'warn', message: `${emptyLinks} link(s) without text content`, element: 'a', fixable: false });
  } else {
    seo.pass++;
  }
}

function scanImages(doc, images) {
  const imgs = doc.querySelectorAll('img');

  imgs.forEach((img) => {
    // Check for width/height (CLS prevention)
    if (!img.width && !img.getAttribute('width') && !img.style.width) {
      images.warn++;
      images.issues.push({ severity: 'warn', message: `Image without explicit dimensions: ${img.src?.split('/').pop()?.slice(0, 30)}`, element: 'img', fixable: false });
    } else {
      images.pass++;
    }

    // Check loading attribute
    if (img.loading !== 'lazy' && !isAboveFold(img)) {
      images.warn++;
      images.issues.push({ severity: 'warn', message: `Below-fold image not lazy-loaded: ${img.src?.split('/').pop()?.slice(0, 30)}`, element: 'img', fixable: true });
    } else {
      images.pass++;
    }
  });

  if (imgs.length === 0) {
    images.pass++;
  }
}

function isAboveFold(el) {
  try {
    const rect = el.getBoundingClientRect();
    return rect.top < 800;
  } catch {
    return true;
  }
}

function scanLegal(doc, legal) {
  const bodyText = doc.body?.textContent?.toLowerCase() || '';
  const links = [...doc.querySelectorAll('a')].map((a) => ({
    text: a.textContent?.toLowerCase() || '',
    href: (a.href || '').toLowerCase(),
  }));

  // Privacy policy
  const hasPrivacy = links.some((l) => l.text.includes('privacy') || l.href.includes('privacy'));
  if (hasPrivacy) {
    legal.pass++;
  } else {
    legal.warn++;
    legal.issues.push({ severity: 'warn', message: 'No privacy policy link found', element: 'footer', fixable: true });
  }

  // Terms / legal
  const hasTerms = links.some((l) => l.text.includes('terms') || l.text.includes('legal') || l.href.includes('terms'));
  if (hasTerms) {
    legal.pass++;
  } else {
    legal.warn++;
    legal.issues.push({ severity: 'warn', message: 'No terms of use link found', element: 'footer', fixable: true });
  }

  // Copyright notice
  const hasCopyright = bodyText.includes('©') || bodyText.includes('copyright');
  if (hasCopyright) {
    legal.pass++;
  } else {
    legal.warn++;
    legal.issues.push({ severity: 'warn', message: 'No copyright notice found', element: 'footer', fixable: true });
  }

  // Cookie consent (check for common patterns)
  const hasCookies = bodyText.includes('cookie') || doc.querySelector('[class*="cookie"], [id*="cookie"], [class*="consent"]');
  if (hasCookies) {
    legal.pass++;
  } else {
    legal.warn++;
    legal.issues.push({ severity: 'warn', message: 'No cookie consent mechanism detected', element: 'body', fixable: false });
  }
}

function scanBrand(doc, brand) {
  // Check for consistent heading fonts
  const headings = doc.querySelectorAll('h1, h2, h3');
  const fonts = new Set();
  headings.forEach((h) => {
    try {
      const computed = doc.defaultView?.getComputedStyle(h);
      if (computed) fonts.add(computed.fontFamily);
    } catch { /* cross-origin */ }
  });

  if (fonts.size <= 1) {
    brand.pass++;
  } else {
    brand.warn++;
    brand.issues.push({ severity: 'warn', message: `Inconsistent heading fonts (${fonts.size} different families)`, element: 'headings', fixable: false });
  }

  // Check for broken images
  const imgs = doc.querySelectorAll('img');
  imgs.forEach((img) => {
    if (img.naturalWidth === 0 && img.complete) {
      brand.fail++;
      brand.issues.push({ severity: 'fail', message: `Broken image: ${img.src?.split('/').pop()?.slice(0, 40)}`, element: 'img', fixable: false });
    } else {
      brand.pass++;
    }
  });

  // Check for favicon
  const favicon = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
  if (favicon) {
    brand.pass++;
  } else {
    brand.warn++;
    brand.issues.push({ severity: 'warn', message: 'No favicon configured', element: 'head', fixable: true });
  }

  brand.pass++;
}

export function formatResults(scanResult) {
  if (!scanResult) return 'Unable to scan page.';

  const { results, score } = scanResult;
  let html = `<strong>Governance Report — Real Scan</strong>\n`;
  html += `<table class="gov-results" style="margin-top:10px">`;
  html += `<tr><th>Category</th><th>Pass</th><th>Fail</th><th>Warn</th></tr>`;

  const labels = {
    brand: 'Brand compliance',
    legal: 'Legal review',
    a11y: 'Accessibility',
    seo: 'SEO standards',
    images: 'Image optimization',
  };

  Object.entries(results).forEach(([key, cat]) => {
    html += `<tr><td>${labels[key]}</td>`;
    html += `<td class="count-pass">${cat.pass}</td>`;
    html += `<td class="count-fail">${cat.fail}</td>`;
    html += `<td class="count-warn">${cat.warn}</td></tr>`;
  });
  html += `</table>`;

  // Collect all issues by severity
  const allIssues = [];
  Object.values(results).forEach((cat) => {
    allIssues.push(...cat.issues);
  });

  const criticals = allIssues.filter((i) => i.severity === 'fail');
  const warnings = allIssues.filter((i) => i.severity === 'warn');
  const fixable = allIssues.filter((i) => i.fixable);

  if (criticals.length > 0) {
    html += `<div style="margin-top:10px"><strong style="color:var(--accent)">Critical issues:</strong>`;
    html += `<div class="issue-list">`;
    criticals.forEach((i) => {
      html += `<div class="issue-item critical">❌ ${i.message}</div>`;
    });
    html += `</div></div>`;
  }

  if (warnings.length > 0) {
    html += `<div style="margin-top:8px"><strong style="color:var(--yellow)">Warnings:</strong>`;
    html += `<div class="issue-list">`;
    warnings.slice(0, 8).forEach((i) => {
      html += `<div class="issue-item needs-review">⚠ ${i.message}</div>`;
    });
    if (warnings.length > 8) {
      html += `<div class="issue-item" style="opacity:0.6">...and ${warnings.length - 8} more</div>`;
    }
    html += `</div></div>`;
  }

  return { html, score, fixableCount: fixable.length, totalIssues: allIssues.length };
}

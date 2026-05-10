/**
 * Compass parallel agent test — v120.
 *
 * Opens 3 browser windows simultaneously, each testing a different agent cluster:
 *   Window A — Experience Production: list pages, edit hero, create from brief
 *   Window B — Quality Agents:        brand governance check, content QA
 *   Window C — Asset + Discovery:     image generation, DAM search, channel renditions
 *
 * Each window is independent. Results + screenshots collected from all three.
 * Timing shows where slowness lives so we can fix it.
 *
 * Run: node test-parallel.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const COMPASS_URL = 'https://eds-migration--compass--aemxsc.aem.page/';
const WORKER      = 'https://compass-ims-proxy.compass-xsc.workers.dev';
const LIFEPOINT   = 'https://main--lifepoint--aemxsc.aem.page/';
// Frescopa — xwalk/JCR on AEM CS. Real DAM assets + CFs + governance rules ingested.
// Win B (governance), Win C (assets), Win D (fragments/expiry) connect here.
const FRESCOPA    = 'https://main--frescopa--aem-showcase.aem.page/';
const SHOTS_DIR   = 'c:/Users/remekie/Documents/compass/test-screenshots';

mkdirSync(SHOTS_DIR, { recursive: true });

// ─── Shared auth state ────────────────────────────────────────────────────────
console.log('\n[bootstrap] Fetching S2S token...');
let TOKEN;
try {
  const r = await fetch(WORKER + '/auth', {
    headers: { Origin: 'https://eds-migration--compass--aemxsc.aem.page' },
  });
  TOKEN = (await r.json()).access_token;
  console.log(`[bootstrap] Token: ${TOKEN.slice(0, 24)}...`);
} catch (e) {
  console.error('[bootstrap] FAILED:', e.message); process.exit(1);
}

// ─── Window definitions ───────────────────────────────────────────────────────
const WINDOWS = [
  {
    id: 'A',
    label: 'Experience Production + Governance Chain',
    color: '\x1b[36m', // cyan
    prompts: [
      // Discovery
      { label: 'list pages',             text: 'What pages does this site have? List the paths.',                                                                         maxWait: 30 },
      // Edit
      { label: 'edit hero headline',     text: 'Update the hero headline on the home page to "World-Class Care, Close to Home"',                                          maxWait: 45, authNote: true },
      // Chain: governance on smarttiger URL (where Frescopa rules are ingested — expect real violations)
      { label: 'govern after edit',      text: 'Run a brand governance check on this page: https://main--smarttiger09543--aemsitestrial.aem.live/frescopa/en/home',          maxWait: 50 },
      // Chain: content QA on same page
      { label: 'content QA after edit',  text: 'Now run a content quality check on the home page — SEO, readability, missing meta tags',                                  maxWait: 45 },
      // Create
      { label: 'create from brief',      text: 'Create a new page at /en/emergency-services with headline "24/7 Emergency Care" and a CTA "Call 911 Ready Team" → /contact. Include three cards: Trauma Center, Air Transport, EMS Liaison.', maxWait: 90, authNote: true },
    ],
  },
  {
    id: 'B',
    label: 'Governance + Content QA Agents (Frescopa)',
    color: '\x1b[33m', // yellow
    site: FRESCOPA,    // Frescopa has brand rules ingested — expect real violations
    prompts: [
      // Governance with explicit URL — rules are ingested at smarttiger domain (not aem-showcase)
      { label: 'brand governance',       text: 'Run a brand governance check on this page: https://main--smarttiger09543--aemsitestrial.aem.live/frescopa/en/home',          maxWait: 50 },
      // Preview to confirm page loaded correctly
      { label: 'preview page',           text: 'Show me a preview of the Frescopa home page',                                                                               maxWait: 20 },
      // Combined governance in one prompt — brain should run both checks
      { label: 'governance + QA',        text: 'Run a brand governance check AND a content quality check on https://main--smarttiger09543--aemsitestrial.aem.live/frescopa/en/home at the same time', maxWait: 70 },
      // Search forms — should call search_forms, not page-crawl
      { label: 'search forms (B)',       text: 'Find any forms on the Frescopa site — newsletter signup, contact, or subscription forms',                                   maxWait: 30 },
    ],
  },
  {
    id: 'C',
    label: 'Asset + Image Generation (Frescopa DAM)',
    color: '\x1b[35m', // magenta
    site: FRESCOPA,    // Frescopa has real DAM assets at /content/dam/frescopa
    prompts: [
      // Image generation
      { label: 'generate hero image',    text: 'Generate a cinematic hero image for a premium coffee brand — espresso bar, warm lighting, artisan feel. 1440×810.',         maxWait: 60 },
      // DAM search — should return real Frescopa assets
      { label: 'search DAM assets',      text: 'Search for coffee images in the Frescopa DAM',                                                                              maxWait: 50 },
      // Brand-approved filter — should use tags filter
      { label: 'brand-approved DAM',     text: 'Find brand-approved Frescopa coffee images in the DAM',                                                                     maxWait: 35 },
      // Channel renditions — chained from DAM asset
      { label: 'TikTok + IG Story',      text: 'Create TikTok (1080×1920) and Instagram Story (1080×1920) variants of the Frescopa hero image',                            maxWait: 80, authNote: true },
      // LinkedIn banner
      { label: 'LinkedIn banner',        text: 'Create a LinkedIn company banner (1128×191) from the Frescopa home page hero image',                                        maxWait: 60, authNote: true },
    ],
  },
  {
    id: 'D',
    label: 'Language + Discovery (Frescopa CFs)',
    color: '\x1b[32m', // green
    site: FRESCOPA,    // Frescopa has real CFs and assets in AEM CS
    prompts: [
      // Spanish natural language
      { label: 'spanish prompt',         text: '¿Qué páginas tiene el sitio Frescopa? Lista las rutas.',                                                                    maxWait: 30 },
      // Content Fragment search — should call search_content_fragments, not page-crawl
      { label: 'search fragments',       text: 'Search for Frescopa product description content fragments',                                                                  maxWait: 45 },
      // Forms discovery — should call search_forms, not page-crawl
      { label: 'search forms',           text: 'Find any forms on the Frescopa site — newsletter signup, contact, or subscription forms',                                   maxWait: 45 },
      // Asset expiry — routes to check_asset_expiry via governance TIER2 (expir keyword)
      { label: 'asset expiry check',     text: 'Check if any Frescopa assets are expiring soon or have DRM license restrictions',                                            maxWait: 55 },
      // Translation
      { label: 'translate hero',         text: 'Translate the Frescopa home page hero headline and subtext to Spanish',                                                     maxWait: 45, authNote: true },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 19); }
function log(windowId, color, msg) {
  console.log(`${color}[${ts()}][Win ${windowId}] ${msg}\x1b[0m`);
}

async function shot(page, name) {
  const p = `${SHOTS_DIR}/${name}.png`;
  await page.screenshot({ path: p }).catch(() => {});
  return p;
}

async function sendAndWait(page, text, maxWaitSec) {
  const before = await page.$$eval('#chatMessages .message', (els) => els.length).catch(() => 0);
  const t0 = Date.now();

  // Use evaluate() — bypasses Playwright visibility checks that fail in headless multi-window mode.
  // Compass is vanilla JS so direct DOM manipulation + dispatchEvent works correctly.
  const sent = await page.evaluate((msg) => {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('sendBtn');
    if (!input || !btn) return false;
    input.value = msg;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    return true;
  }, text).catch(() => false);

  if (!sent) {
    return { ok: false, elapsed: '0', text: '(chatInput or sendBtn not found)' };
  }

  // Inner poll loop. Each page.evaluate is wrapped in Promise.race with a 4s timer so a
  // stuck app JS engine (MCP auth retry, infinite fetch loop) can't make evaluate() hang
  // forever. The outer Promise.race below adds a second hard-deadline layer.
  const pollLoop = async () => {
    const deadline = t0 + maxWaitSec * 1000;
    let settledFor = 0;
    let prevText = '';

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || page.isClosed()) break;
      await page.waitForTimeout(Math.min(2500, remaining)).catch(() => {});
      if (Date.now() >= deadline || page.isClosed()) break;

      // Each evaluate gets a 4s ceiling — prevents hanging when app JS is busy.
      const state = await Promise.race([
        page.evaluate((prevCount) => {
          const msgs = Array.from(document.querySelectorAll('#chatMessages .message'));
          const fresh = msgs.slice(prevCount);
          const last = [...fresh].reverse().find((el) => !el.classList.contains('user'));
          const txt = last?.textContent || '';
          // Word-boundary regex: catches "Running" at end of string
          const busy = /\b(Thinking|Processing|Running|Scanning|Fetching|Generating|Initializing|Connecting)\b/.test(txt);
          return { hasReply: fresh.length > 1, busy, lastText: txt.trim().replace(/\s+/g, ' ').slice(0, 350) };
        }, before).catch(() => ({ hasReply: false, busy: true, lastText: '' })),
        new Promise((r) => setTimeout(() => r({ hasReply: false, busy: true, lastText: '' }), 4000)),
      ]);

      if (state.hasReply && !state.busy) {
        if (state.lastText === prevText && prevText.length > 10) {
          settledFor += 2500;
          if (settledFor >= 5000) {
            return { ok: true, elapsed: ((Date.now() - t0) / 1000).toFixed(1), text: state.lastText };
          }
        } else {
          settledFor = 0;
        }
      } else {
        settledFor = 0;
      }
      prevText = state.lastText;
    }

    if (page.isClosed()) return { ok: false, elapsed: ((Date.now() - t0) / 1000).toFixed(1), text: '(page closed)' };
    const finalText = await Promise.race([
      page.$$eval('#chatMessages .message', (els) => {
        const last = [...els].reverse().find((el) => !el.classList.contains('user'));
        return last?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 350) || '';
      }).catch(() => ''),
      new Promise((r) => setTimeout(() => r(''), 3000)),
    ]);
    return { ok: false, elapsed: ((Date.now() - t0) / 1000).toFixed(1), text: finalText };
  };

  // Hard deadline: guarantees sendAndWait exits within maxWaitSec + 2s no matter what.
  return Promise.race([
    pollLoop(),
    new Promise((r) => setTimeout(() => r({
      ok: false,
      elapsed: maxWaitSec.toFixed(1),
      text: '(hard deadline)',
    }), (maxWaitSec + 2) * 1000)),
  ]);
}

// ─── Run a single window ───────────────────────────────────────────────────────
async function runWindow(browser, win) {
  const { id, label, color, prompts, site = LIFEPOINT } = win;
  const results = [];
  const logW = (msg) => log(id, color, msg);

  logW(`Starting — "${label}"`);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*imslib*', (r) => r.abort());
  await ctx.route('**/auth.services.adobe.com/**', (r) => r.abort());
  // Block IMS sign-in navigation — signIn() calls window.location.href = ims-na1.adobelogin.com
  // which kills the session. Intercept at network level so the page stays on Compass.
  await ctx.route('**/*.adobelogin.com/**', (r) => r.abort());
  await ctx.route('**/experience.adobe.com/**', (r) => r.abort());
  await ctx.addInitScript((tok) => {
    localStorage.setItem('ew-ims-token', tok);
    localStorage.setItem('ew-s2s-token', tok);
    localStorage.setItem('ew-ims-method', 'ims');
    localStorage.setItem('ew-ims-profile', JSON.stringify({ displayName: `Win ${tok.slice(0,4)}`, email: 'demo@adobe.com', initials: 'DU', type: 'adobe' }));
  }, TOKEN);

  const page = await ctx.newPage();

  // Block IMS auth navigation at the JS level — ctx.route() aborts the request but the browser
  // still navigates away, replacing the Compass SPA with an ERR_BLOCKED_BY_CLIENT page.
  // addInitScript runs before ANY page scripts and patches location.href/assign/replace so the
  // navigation never fires. The ctx.route() blocks remain as a belt-and-suspenders fallback.
  await page.addInitScript(() => {
    const BLOCKED = ['adobelogin.com', 'auth.services.adobe.com'];
    function shouldBlock(url) {
      try { const u = new URL(url); return BLOCKED.some(h => u.hostname.includes(h)); } catch { return false; }
    }
    try {
      const origDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (origDesc?.set) {
        Object.defineProperty(Location.prototype, 'href', {
          ...origDesc,
          set(val) {
            if (shouldBlock(val)) {
              console.warn('[nav-guard] blocked href — throwing to unwind auth stack:', val.slice(0, 60));
              throw new Error('IMS navigation blocked by test guard');
            }
            origDesc.set.call(this, val);
          },
        });
      }
      const origAssign = Location.prototype.assign;
      Location.prototype.assign = function navGuardAssign(url) {
        if (shouldBlock(url)) {
          console.warn('[nav-guard] blocked assign:', url.slice(0, 60));
          throw new Error('IMS navigation blocked by test guard');
        }
        return origAssign.call(this, url);
      };
      const origReplace = Location.prototype.replace;
      Location.prototype.replace = function navGuardReplace(url) {
        if (shouldBlock(url)) {
          console.warn('[nav-guard] blocked replace:', url.slice(0, 60));
          throw new Error('IMS navigation blocked by test guard');
        }
        return origReplace.call(this, url);
      };
    } catch (e) { console.warn('[nav-guard] init failed:', e.message); }
  });

  // Capture console errors + uncaught JS errors so we can diagnose app.js load failures
  page.on('pageerror', (err) => {
    // Suppress the expected navigation-blocked error from our nav-guard (thrown intentionally)
    if (!err.message.includes('IMS navigation blocked')) logW(`[pageerror] ${err.message.slice(0, 200)}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (!t.includes('imslib') && !t.includes('ERR_ABORTED') && !t.includes('auth.services')
          && !t.includes('403') && !t.includes('401') && !t.includes('net::ERR') && !t.includes('CORS')
          && !t.includes('nav-guard')) {
        logW(`[console.error] ${t.slice(0, 150)}`);
      }
    }
  });

  // Load Compass — chatInput exists in DOM but is hidden until site is connected
  await page.goto(COMPASS_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.locator('#chatInput').waitFor({ state: 'attached', timeout: 15000 });
  logW('Shell loaded');
  await page.waitForTimeout(1000);

  // Connect Lifepoint.
  // app.js loads as a dynamic module (appended after shell HTML is injected). We can't use
  // Playwright locator.click() — headless multi-window visibility checks fail. Instead we
  // use page.evaluate() to directly invoke connectCustomSite if it's been exported to window,
  // or fall back to clicking the button. We poll until AEM_ORG.orgId is set.
  const domState = await page.evaluate(() => ({
    hasInput: !!document.getElementById('connectSiteInput'),
    hasBtn:   !!document.getElementById('connectSiteBtn'),
    btnDisabled: document.getElementById('connectSiteBtn')?.disabled,
    btnClasses:  Array.from(document.getElementById('connectSiteBtn')?.classList || []).join(' '),
    hasEwOrg: !!window.__EW_ORG,
    hasSiteType: !!window.__EW_SITE_TYPE,
    hasConnectFn: typeof window.connectCustomSite === 'function',
  })).catch(() => ({}));
  logW(`DOM state: ${JSON.stringify(domState)}`);

  if (domState.hasBtn) {
    // Poll every 2s: inject the URL and click the button until app.js loads and
    // connectCustomSite() registers the click (evidenced by window.__EW_ORG.orgId being set).
    // Playwright waitForFunction arg order: (fn, arg, options) — NOT (fn, options, arg).
    // First: fill input + click once immediately
    await page.evaluate((url) => {
      const input = document.getElementById('connectSiteInput');
      const btn   = document.getElementById('connectSiteBtn');
      if (input) input.value = url;
      if (btn) btn.click();
    }, site).catch(() => {});

    // 800ms: if listener registered, connectCustomSite disables btn synchronously
    await page.waitForTimeout(800);
    const btnState = await page.evaluate(() => ({
      disabled: document.getElementById('connectSiteBtn')?.disabled,
      classes:  Array.from(document.getElementById('connectSiteBtn')?.classList || []).join(' '),
      orgId:    window.__EW_ORG?.orgId || null,
    })).catch(() => ({}));
    logW(`After click: ${JSON.stringify(btnState)}`);

    // If btn is still not disabled after 800ms, listener probably not registered — retry
    const connected = await page.waitForFunction(
      (url) => {
        const input = document.getElementById('connectSiteInput');
        const btn   = document.getElementById('connectSiteBtn');
        if (btn && !btn.disabled && !btn.classList.contains('connecting')) {
          if (input) input.value = url;
          btn.click();
        }
        return !!window.__EW_ORG?.orgId;
      },
      site,
      { timeout: 45000, polling: 2000 },
    ).then(() => true).catch(() => false);

    logW(connected ? 'AEM_ORG set — waiting for site type detection' : '⚠️  AEM_ORG.orgId never set after 45s');

    if (connected) {
      // fstab.yaml GitHub API detection takes ~30s — wait for SITE_TYPE to be set
      await page.waitForFunction(
        () => { try { return !!window.__EW_SITE_TYPE; } catch (e) { return false; } },
        { timeout: 60000 },
      ).catch(() => logW('⚠️  SITE_TYPE never set — proceeding anyway'));
    }
    logW(`${site.split('--')[1] || 'site'} connected`);
  }
  // Allow switchView('editor') to run (fires 600ms after siteType is set)
  await page.waitForTimeout(2000).catch(() => {});
  await shot(page, `win${id}-00-connected`);

  // Run prompts sequentially in this window
  for (const { label: pLabel, text, maxWait, authNote } of prompts) {
    if (page.isClosed()) { logW(`⚡ Page closed — skipping remaining prompts`); break; }
    logW(`→ ${pLabel}${authNote ? ' [needs IMS write]' : ''}`);
    try {
      const r = await sendAndWait(page, text, maxWait);
      const icon = r.ok ? '✅' : '⚠️ ';
      logW(`${icon} ${pLabel} — ${r.elapsed}s${r.ok ? '' : ' (timeout/closed)'}`);
      if (r.text) logW(`   "${r.text.slice(0, 180)}"`);
      results.push({ label: pLabel, ...r });
      await shot(page, `win${id}-${pLabel.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`);
      // After a timeout, wait longer so any in-flight tool call settles before next `before` capture
      await page.waitForTimeout(r.ok ? 2500 : 7000).catch(() => {});
    } catch (e) {
      logW(`❌ ${pLabel} crashed: ${e.message.slice(0, 80)}`);
      results.push({ label: pLabel, ok: false, elapsed: '?', text: e.message.slice(0, 80) });
    }
  }

  await ctx.close().catch(() => {});
  return { id, label, results };
}

// ─── Launch all windows in parallel ───────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
console.log(`\n[parallel] Launching ${WINDOWS.length} windows simultaneously...\n`);

const allResults = await Promise.all(WINDOWS.map((w) => runWindow(browser, w)));

// ─── Summary table ────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('PARALLEL RESULTS SUMMARY');
console.log('═'.repeat(70));

for (const { id, label, results } of allResults) {
  console.log(`\nWindow ${id} — ${label}`);
  for (const r of results) {
    const icon = r.ok ? '✅' : '⚠️ ';
    const speed = parseFloat(r.elapsed) < 10 ? '🟢' : parseFloat(r.elapsed) < 30 ? '🟡' : '🔴';
    console.log(`  ${icon} ${speed} ${r.label.padEnd(28)} ${r.elapsed}s`);
  }
}

console.log('\n[legend] 🟢 < 10s  🟡 10-30s  🔴 > 30s');
console.log(`\nScreenshots in ${SHOTS_DIR}/`);
console.log('\n[done] Closing browser in 20s...');
await new Promise((r) => setTimeout(r, 20000));
await browser.close();

/*
 * Compass — v4 (Phase 3: Customer-Specific Intelligence)
 *
 * Five ways this is better than native Adobe agents:
 * 1. Customer-specific system prompts (brand voice, segments, approval chains, legal SLAs)
 * 2. Cross-product orchestration (Acrobat → AEM → CJA → Workfront in one thread)
 * 3. Brief-to-page flow (PDF in → structured page → governance gate → WF task)
 * 4. Page context awareness on load (inject page context automatically)
 * 5. Speed of iteration (update system prompts same day, not next quarter)
 */

// IMPORTANT: Import specifiers must match EXACTLY across files (app.js + ai.js).
// Different query strings (e.g., './da-client.js' vs './da-client.js?v=57') create
// separate module instances with separate state — causing shared state (like DA org/repo)
// to be invisible across modules. Cache busting is handled by app.js?v=N in index.html only.
import { loadIms, isSignedIn, signIn, signOut, getProfile, getToken, relaySignIn, getBookmarkletCode, handlePkceCallback, fetchUserProfile } from './ims.js';
import * as ai from './ai.js';
import { TOOL_AGENT_MAP } from './ai.js';
import * as da from './da-client.js';
import * as gov from './governance.js';
import { getActiveProfile, getOrgConfig, setActiveProfile, listProfiles, addCustomProfile, deleteCustomProfile, buildProfilePrompt } from './customer-profiles.js';
import { detectSiteMention, resolveSite } from './known-sites.js';
import { getGitHubToken, setGitHubToken, hasGitHubToken, getRepoInfo, listBranches, getRepoTree } from './github-content.js';
import { detectAndCacheSiteType, getSiteType } from './site-detect.js';

/* ── Dynamic Org Configuration (from customer profile) ── */
let AEM_ORG = getOrgConfig();
let PREVIEW_URL = AEM_ORG.previewOrigin + '/';
window.__EW_ORG = AEM_ORG; // expose for ai.js tool handlers

/* ── DOM refs ── */
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const previewFrame = document.getElementById('previewFrame');
const authBtn = document.getElementById('authBtn');
const authStatus = document.getElementById('authStatus');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');

/* ── View & Panel DOM refs ── */
const viewHome = document.getElementById('viewHome');
const viewEditor = document.getElementById('viewEditor');
const editorToolbar = document.getElementById('editorToolbar');
const panels = document.getElementById('panels');
const resourcesTree = document.getElementById('resourcesTree');
const fileTreeEl = document.getElementById('fileTree');
const breadcrumbEl = document.getElementById('breadcrumb');
const localeSelect = document.getElementById('localeSelect');
const previewUrlText = document.getElementById('previewUrlText');
const previewDot = document.getElementById('previewDot');
const homeSiteName = document.getElementById('homeSiteName');
const homeSiteUrl = document.getElementById('homeSiteUrl');
const homePromptInput = document.getElementById('homePromptInput');

/* ── State ── */
let conversationHistory = [];
let isLiveMode = false;

/* ── Project Memory (persists across sessions, keyed by org/repo) ── */
/* Matches da-agent's persistent memory — context survives page reloads. */
const PROJECT_MEMORY_KEY = 'ew-project-memory';

function getProjectMemory() {
  const orgId = AEM_ORG?.orgId || '';
  const repo = AEM_ORG?.repo || '';
  if (!orgId || !repo) return null;
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_MEMORY_KEY) || '{}');
    return all[`${orgId}/${repo}`] || null;
  } catch { return null; }
}

function saveProjectMemory(data) {
  const orgId = AEM_ORG?.orgId || '';
  const repo = AEM_ORG?.repo || '';
  if (!orgId || !repo) return;
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_MEMORY_KEY) || '{}');
    all[`${orgId}/${repo}`] = {
      ...data,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(PROJECT_MEMORY_KEY, JSON.stringify(all));
  } catch (e) { console.warn('[Memory] Save failed:', e.message); }
}

function updateProjectMemory(patch) {
  const existing = getProjectMemory() || {};
  saveProjectMemory({ ...existing, ...patch });
}

let pendingFile = null; // { name, type, size, content (text or base64), mediaType }
let currentView = 'home'; // 'home' | 'editor'
let sitePages = []; // loaded from query-index.json
let activeResourcePath = null;
let detectedLocales = []; // e.g. ['en', 'fr', 'de'] — auto-detected from page paths
let activeLocale = ''; // current locale filter (empty = global / all)

/* ── Constants ── */
const TOAST_DURATION_MS = 4000;
const TOKEN_PREVIEW_LENGTH = 12;
const MAX_PDF_PAGES = 30;
const MAX_BRAND_TEXT_LENGTH = 3000;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_RATIO = 0.6;
const ONE_MINUTE_MS = 60000;
const ONE_HOUR_MS = 3600000;
const ONE_DAY_MS = 86400000;
const MAX_FILE_CONTENT_LENGTH = 30000;

/* ── Utility ── */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function scrollChat() { chatMessages.scrollTop = chatMessages.scrollHeight; }

/** Escape HTML entities to prevent XSS when inserting into innerHTML */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Truncate a string and add ellipsis */
function truncate(str, len = 30) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

/** Mask a token for display (show first N chars + ...) */
function maskToken(token, len = TOKEN_PREVIEW_LENGTH) {
  if (!token) return '(empty)';
  return token.slice(0, len) + '...';
}

/* ── Toast Notification System ── */
function showToast(message, type = 'info', duration = TOAST_DURATION_MS) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' };
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  // Trigger entrance animation
  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove());
  }, duration);
}

function md(text) {
  // Escape HTML first to prevent XSS, then apply markdown transforms
  return escapeHtml(text)
    .replace(/### (.*?)(\n|$)/g, '<h3>$1</h3>')
    .replace(/## (.*?)(\n|$)/g, '<h2>$1</h2>')
    .replace(/# (.*?)(\n|$)/g, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^[-*] (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/<\/ul>\s*<ul>/g, '')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

/* ── Chat Primitives ── */
function addMessage(type, html, agentBadge) {
  const msg = document.createElement('div');
  msg.classList.add('message', type);
  let inner = '';
  if (agentBadge) inner += `<div class="agent-badge">${agentBadge}</div>`;
  inner += `<div class="message-content">${html}</div>`;
  msg.innerHTML = inner;
  chatMessages.appendChild(msg);
  scrollChat();
  return msg;
}

function addRawHTML(html) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('message', 'assistant');
  wrapper.innerHTML = html;
  chatMessages.appendChild(wrapper);
  scrollChat();
  return wrapper;
}

function addTyping() {
  const el = document.createElement('div');
  el.classList.add('message', 'assistant');
  el.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  el.id = 'typingIndicator';
  chatMessages.appendChild(el);
  scrollChat();
}

function removeTyping() {
  document.getElementById('typingIndicator')?.remove();
}

function addStreamMessage(agentBadge) {
  const msg = document.createElement('div');
  msg.classList.add('message', 'assistant');
  let inner = '';
  if (agentBadge) inner += `<div class="agent-badge">${agentBadge}</div>`;
  inner += '<div class="message-content stream-content"></div>';
  msg.innerHTML = inner;
  chatMessages.appendChild(msg);
  scrollChat();
  return msg.querySelector('.stream-content');
}

/* ── Auth UI ── */
function updateAuthUI() {
  const profile = getProfile();
  const signedIn = isSignedIn();
  const hasKey = ai.hasApiKey();

  const userMenu = document.getElementById('userMenu');
  const userAvatar = document.getElementById('userAvatar');
  const userName = document.getElementById('userName');
  const userEmail = document.getElementById('userEmail');

  if (authBtn) {
    if (signedIn && profile?.displayName) {
      // Show avatar button, hide "Sign In" text
      const initials = (profile.firstName?.[0] || profile.displayName[0] || '').toUpperCase();
      authBtn.textContent = '';
      authBtn.classList.add('signed-in', 'avatar-mode');
      authBtn.title = `Signed in as ${profile.email || profile.displayName}`;
      authBtn.innerHTML = `<span class="auth-avatar">${initials}</span>`;
      // Populate dropdown
      if (userAvatar) userAvatar.textContent = initials;
      if (userName) userName.textContent = profile.displayName;
      if (userEmail) userEmail.textContent = profile.email || '';
    } else if (signedIn) {
      // Signed in but no profile (S2S service account)
      authBtn.textContent = '';
      authBtn.classList.add('signed-in', 'avatar-mode');
      authBtn.title = 'Signed in — Adobe S2S';
      authBtn.innerHTML = '<span class="auth-avatar">A</span>';
      // Populate dropdown with service account info
      if (userAvatar) userAvatar.textContent = 'A';
      if (userName) userName.textContent = 'AEM Service Account';
      if (userEmail) userEmail.textContent = 'S2S · OAuth Server-to-Server';
    } else {
      // Not signed in — show "Sign In" text button
      authBtn.classList.remove('signed-in', 'avatar-mode');
      authBtn.innerHTML = 'Sign In';
      authBtn.title = 'Sign in with Adobe';
      if (userMenu) userMenu.classList.remove('visible');
    }
  }

  if (authStatus) {
    const parts = [];
    if (hasGitHubToken()) parts.push('GitHub ✓');
    if (signedIn) parts.push('Adobe ✓');
    if (hasKey) parts.push('AI ✓');
    authStatus.textContent = parts.length > 0 ? parts.join(' · ') : '';
    authStatus.style.display = parts.length > 0 ? '' : 'none';
  }

  isLiveMode = signedIn || hasKey || hasGitHubToken();

  // Update connection status
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.connection-status span:last-child');
  if (statusDot && statusText) {
    if (isLiveMode) {
      statusDot.classList.add('live');
      statusText.textContent = signedIn && hasKey ? 'Live — AI + Adobe' : hasKey ? 'Live — AI' : 'Live — Adobe';
    } else {
      statusDot.classList.remove('live');
      statusText.textContent = 'Not Connected';
    }
  }
}

/* ── Settings Panel ── */
function toggleSettings() {
  if (!settingsPanel) return;
  settingsPanel.classList.toggle('visible');
  const keyInput = settingsPanel.querySelector('#claudeKeyInput');
  if (keyInput && ai.hasApiKey()) {
    keyInput.value = ai.getApiKey().slice(0, 8) + '...';
  }
  // Show GitHub token status
  const ghInput = document.getElementById('githubTokenInput');
  const ghStatus = document.getElementById('githubTokenStatus');
  const existingGhToken = getGitHubToken();
  if (ghInput && existingGhToken) {
    ghInput.value = existingGhToken.slice(0, 12) + '...';
    if (ghStatus) {
      ghStatus.textContent = 'Token set — GitHub content editing enabled';
      ghStatus.className = 'settings-token-status success';
    }
  }
  // Show IMS token status
  const imsInput = document.getElementById('imsTokenInput');
  const imsStatus = document.getElementById('imsTokenStatus');
  const existingToken = localStorage.getItem('ew-ims-token');
  if (imsInput && existingToken) {
    imsInput.value = existingToken.slice(0, 12) + '...';
    if (imsStatus) {
      imsStatus.textContent = 'Token set — DA editing enabled (fallback)';
      imsStatus.className = 'settings-token-status success';
    }
  }
  // Render brand policies
  if (settingsPanel.classList.contains('visible')) initBrandGovernance();

  // Populate MCP connectors list
  const connBox = document.getElementById('settingsConnectors');
  if (connBox && settingsPanel.classList.contains('visible')) {
    const profile = getActiveProfile() || {};
    const connectors = profile.connectors || [];
    if (connectors.length === 0) { connBox.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No connectors configured</div>'; return; }
    const liveCount = connectors.filter((c) => c.status === 'live').length;
    let html = `<div class="conn-summary">${liveCount} of ${connectors.length} live</div>`;
    html += '<div class="conn-list">';
    connectors.forEach((c) => {
      const dot = c.status === 'live' ? 'var(--green)' : 'var(--yellow)';
      const ep = c.endpoint ? `<span class="conn-endpoint">${escapeHtml(c.endpoint)}</span>` : '';
      html += `<div class="conn-row"><span class="conn-dot" style="background:${dot}"></span><span class="conn-name">${escapeHtml(c.name)}</span><span class="conn-env">${escapeHtml(c.env)}</span>${ep}</div>`;
    });
    html += '</div>';
    connBox.innerHTML = html;
  }
}

function saveSettings() {
  const keyInput = document.getElementById('claudeKeyInput');
  if (keyInput && keyInput.value && !keyInput.value.endsWith('...')) {
    ai.setApiKey(keyInput.value.trim());
  }
  toggleSettings();
  updateAuthUI();
  showToast('Settings saved');
}

// Wire settings Save / Cancel buttons (no page reload, preserves chat)
document.getElementById('settingsSaveBtn')?.addEventListener('click', saveSettings);
document.getElementById('settingsCancelBtn')?.addEventListener('click', toggleSettings);

// Close settings modal when clicking backdrop or close button
settingsPanel?.addEventListener('click', (e) => {
  if (e.target === settingsPanel) toggleSettings();
});
document.getElementById('settingsCloseBtn')?.addEventListener('click', toggleSettings);

/* ── GitHub Token paste ── */
const githubTokenBtn = document.getElementById('githubTokenBtn');
const githubTokenInput = document.getElementById('githubTokenInput');
const githubTokenStatus = document.getElementById('githubTokenStatus');

if (githubTokenBtn && githubTokenInput) {
  githubTokenBtn.addEventListener('click', async () => {
    const token = githubTokenInput.value.trim();
    if (!token || token.endsWith('...')) return;

    githubTokenStatus.textContent = 'Validating...';
    githubTokenStatus.className = 'settings-token-status';

    const result = await validateAndStoreGitHubToken(token);
    if (result.ok) {
      githubTokenInput.value = token.slice(0, 12) + '...';
      githubTokenStatus.textContent = `Authenticated as ${result.login} — content editing enabled!`;
      githubTokenStatus.className = 'settings-token-status success';
    } else {
      githubTokenStatus.textContent = result.error;
      githubTokenStatus.className = 'settings-token-status error';
    }
  });
}

/* ── IMS Token paste ── */
const imsTokenBtn = document.getElementById('imsTokenBtn');
const imsTokenInput = document.getElementById('imsTokenInput');
const imsTokenStatus = document.getElementById('imsTokenStatus');
const imsTokenHelp = document.getElementById('imsTokenHelp');

if (imsTokenBtn && imsTokenInput) {
  imsTokenBtn.addEventListener('click', async () => {
    const token = imsTokenInput.value.trim();
    if (!token || token.endsWith('...')) return;

    // Validate token by calling admin.hlx.page/status (no auth needed for GET, but test a simple endpoint)
    imsTokenStatus.textContent = 'Validating...';
    imsTokenStatus.className = 'settings-token-status';

    try {
      // Quick validation: try to list DA source with the token
      const resp = await fetch(`https://admin.da.live/source/${da.getOrg()}/${da.getRepo()}/`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.ok) {
        localStorage.setItem('ew-ims-token', token);
        localStorage.setItem('ew-ims', 'true');
        imsTokenInput.value = token.slice(0, 12) + '...';
        imsTokenStatus.textContent = 'Token valid — DA editing enabled! Reload to apply.';
        imsTokenStatus.className = 'settings-token-status success';
        updateAuthUI();
        // Reset MCP state so it re-probes with the new token
        da.resetMcpState?.();
      } else if (resp.status === 401) {
        imsTokenStatus.textContent = 'Token expired or invalid (401). Get a fresh one from da.live.';
        imsTokenStatus.className = 'settings-token-status error';
      } else {
        // Non-401 error — token might still work, store it
        localStorage.setItem('ew-ims-token', token);
        localStorage.setItem('ew-ims', 'true');
        imsTokenInput.value = token.slice(0, 12) + '...';
        imsTokenStatus.textContent = `Token set (DA returned ${resp.status}). Try editing a page.`;
        imsTokenStatus.className = 'settings-token-status success';
        updateAuthUI();
      }
    } catch (err) {
      // Network error — store token anyway, let the user try
      localStorage.setItem('ew-ims-token', token);
      localStorage.setItem('ew-ims', 'true');
      imsTokenInput.value = token.slice(0, 12) + '...';
      imsTokenStatus.textContent = 'Token saved (could not validate). Try editing a page.';
      imsTokenStatus.className = 'settings-token-status success';
      updateAuthUI();
    }
  });
}

if (imsTokenHelp) {
  imsTokenHelp.addEventListener('click', (e) => {
    e.preventDefault();
    const helpHtml = `
      <div style="font-size:12px;line-height:1.6;color:var(--text-secondary);margin-top:8px;padding:10px;background:var(--bg-secondary);border-radius:6px;">
        <strong style="color:var(--text-primary)">How to get your IMS token:</strong><br>
        1. Go to <a href="https://da.live" target="_blank" style="color:var(--accent-light)">da.live</a> and sign in with Adobe ID<br>
        2. Open browser DevTools (F12) → Console<br>
        3. Run: <code style="background:var(--bg-input);padding:2px 6px;border-radius:3px;font-size:11px;">copy(adobeIMS.getAccessToken().token)</code><br>
        4. Token is now on your clipboard — paste it above<br>
        <br>
        <em style="color:var(--text-muted)">Tokens expire after ~24hrs. Re-paste when needed.</em>
      </div>
    `;
    imsTokenStatus.innerHTML = helpHtml;
    imsTokenStatus.className = 'settings-token-status';
  });
}

/* ── Workfront Webhook config ── */
const wfWebhookBtn = document.getElementById('workfrontWebhookBtn');
const wfWebhookInput = document.getElementById('workfrontWebhookInput');
const wfWebhookStatus = document.getElementById('workfrontWebhookStatus');

if (wfWebhookBtn && wfWebhookInput) {
  // Populate from localStorage on load
  const savedUrl = localStorage.getItem('ew-workfront-webhook') || '';
  if (savedUrl) {
    wfWebhookInput.value = savedUrl;
    wfWebhookStatus.textContent = 'Webhook configured — tasks will be created via webhook.';
    wfWebhookStatus.className = 'settings-token-status success';
  }

  wfWebhookBtn.addEventListener('click', async () => {
    const url = wfWebhookInput.value.trim();

    // Allow clearing the webhook
    if (!url) {
      localStorage.removeItem('ew-workfront-webhook');
      wfWebhookStatus.textContent = 'Webhook cleared — using simulated mode.';
      wfWebhookStatus.className = 'settings-token-status';
      return;
    }

    // Basic URL validation
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('bad protocol');
    } catch {
      wfWebhookStatus.textContent = 'Invalid URL. Enter a valid https:// webhook endpoint.';
      wfWebhookStatus.className = 'settings-token-status error';
      return;
    }

    // Test the webhook with a ping
    wfWebhookStatus.textContent = 'Testing webhook...';
    wfWebhookStatus.className = 'settings-token-status';
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ping', timestamp: new Date().toISOString() }),
      });
      localStorage.setItem('ew-workfront-webhook', url);
      wfWebhookStatus.textContent = `Webhook set (${resp.status}). Workfront tasks will route here.`;
      wfWebhookStatus.className = 'settings-token-status success';
    } catch (err) {
      // Store anyway — CORS might block the test but webhook could still work server-to-server
      localStorage.setItem('ew-workfront-webhook', url);
      wfWebhookStatus.textContent = 'Webhook saved (test failed — CORS may block browser test). Try creating a task.';
      wfWebhookStatus.className = 'settings-token-status success';
    }
  });
}

/* ── Relay Sign-In Modal ── */
const relayModal = document.getElementById('relayModal');
const relayModalClose = document.getElementById('relayModalClose');
const relaySetup = document.getElementById('relaySetup');
const relayConnect = document.getElementById('relayConnect');
const relaySuccess = document.getElementById('relaySuccess');
const relayBookmarklet = document.getElementById('relayBookmarklet');
const relaySetupDone = document.getElementById('relaySetupDone');
const relayOpenDA = document.getElementById('relayOpenDA');
const relayWaiting = document.getElementById('relayWaiting');

// Set bookmarklet href
if (relayBookmarklet) {
  relayBookmarklet.href = getBookmarkletCode();
  // Prevent click from navigating (it's meant to be dragged)
  relayBookmarklet.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

function openRelayModal() {
  if (!relayModal) return;
  // Show setup step if bookmarklet hasn't been used before, else skip to connect
  const hasSetup = localStorage.getItem('ew-relay-setup');
  if (relaySetup) relaySetup.style.display = hasSetup ? 'none' : '';
  if (relayConnect) relayConnect.style.display = hasSetup ? '' : 'none';
  if (relaySuccess) relaySuccess.style.display = 'none';
  if (relayWaiting) relayWaiting.style.display = 'none';
  relayModal.classList.add('visible');
}

function closeRelayModal() {
  if (relayModal) relayModal.classList.remove('visible');
}

if (relayModalClose) {
  relayModalClose.addEventListener('click', closeRelayModal);
}
if (relayModal) {
  relayModal.addEventListener('click', (e) => {
    if (e.target === relayModal) closeRelayModal();
  });
}

// "I've added it" → skip to connect step
if (relaySetupDone) {
  relaySetupDone.addEventListener('click', () => {
    localStorage.setItem('ew-relay-setup', 'true');
    if (relaySetup) relaySetup.style.display = 'none';
    if (relayConnect) relayConnect.style.display = '';
  });
}

// "Open da.live" → open popup and wait for relay
if (relayOpenDA) {
  relayOpenDA.addEventListener('click', async () => {
    if (relayWaiting) relayWaiting.style.display = 'flex';
    try {
      const token = await relaySignIn();
      if (token) {
        // Show success
        if (relayConnect) relayConnect.style.display = 'none';
        if (relaySuccess) relaySuccess.style.display = '';
        updateAuthUI();
        da.resetMcpState?.();
        // Auto-close after 1.5s
        setTimeout(closeRelayModal, 1500);
      }
    } catch (err) {
      if (err.message === 'popup-blocked') {
        // eslint-disable-next-line no-alert
        alert('Pop-up blocked — please allow pop-ups for this site.');
      } else if (err.message === 'popup-closed') {
        // User closed popup without relaying — check if token arrived via paste
        if (isSignedIn()) {
          if (relayConnect) relayConnect.style.display = 'none';
          if (relaySuccess) relaySuccess.style.display = '';
          updateAuthUI();
          setTimeout(closeRelayModal, 1500);
        } else {
          if (relayWaiting) relayWaiting.style.display = 'none';
        }
      }
    }
  });
}

// Listen for auth changes (from PKCE callback, relay, IMS library)
window.addEventListener('ew-auth-change', async (e) => {
  if (e.detail?.signedIn) {
    // Reset MCP state so it re-initializes with fresh IMS token
    da.resetMcpState?.();

    // Pre-warm everything in parallel (profile + MCP sessions)
    // Don't await sequentially — speed is the product
    const warmups = [];

    // Fetch user profile if not already cached
    if (!getProfile()) {
      warmups.push(fetchUserProfile().catch(() => {}));
    }

    // Pre-warm DA MCP session so first edit is fast
    warmups.push(
      da.isAuthenticated()
        .then((ok) => console.log('[Auth] DA MCP ready:', ok))
        .catch(() => {})
    );

    console.log('[Auth] Signed in — warming sessions...');
    await Promise.all(warmups);
  }
  updateAuthUI();
});

/* ── Brand Governance Admin ── */
const BRAND_STORAGE_KEY = 'ew-brand-policies';
let activeBrandPolicies = JSON.parse(localStorage.getItem(BRAND_STORAGE_KEY) || '[]');
let brandPdfText = null;

function renderBrandPolicies() {
  const listEl = document.getElementById('brandPolicyList');
  const countEl = document.getElementById('brandPolicyCount');
  if (!listEl || !countEl) return;

  if (activeBrandPolicies.length === 0) {
    listEl.innerHTML = '<div class="brand-policy-empty">No brand policies configured. Upload a PDF, paste a URL, or connect an enterprise MCP endpoint above.</div>';
    countEl.textContent = '0 rules';
    return;
  }

  countEl.textContent = `${activeBrandPolicies.length} rules`;
  listEl.innerHTML = activeBrandPolicies.map((p) => `
    <div class="brand-policy-item">
      <span class="brand-policy-icon">${categoryIcon(p.category)}</span>
      <div>
        <div class="brand-policy-category">${escapeHtml(p.category || 'General')}</div>
        <div class="brand-policy-text">${escapeHtml(p.rule)}</div>
      </div>
    </div>
  `).join('');
}

function categoryIcon(cat) {
  const icons = { tone: '🎙️', terminology: '📝', visual: '🎨', editorial: '✏️', legal: '⚖️', accessibility: '♿', imagery: '📸', color: '🎨', typography: '🔤' };
  return icons[(cat || '').toLowerCase()] || '📋';
}

function saveBrandPolicies() {
  localStorage.setItem(BRAND_STORAGE_KEY, JSON.stringify(activeBrandPolicies));
  renderBrandPolicies();
  // Also inject into active profile's brandVoice for AI context
  const profile = getActiveProfile() || {};
  if (profile) {
    profile.brandPolicies = activeBrandPolicies;
  }
}

// PDF Upload
const brandUploadBtn = document.getElementById('brandUploadBtn');
const brandPdfInput = document.getElementById('brandPdfInput');
const brandPdfStatus = document.getElementById('brandPdfStatus');

if (brandUploadBtn && brandPdfInput) {
  brandUploadBtn.addEventListener('click', () => brandPdfInput.click());
  brandPdfInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    brandPdfStatus.textContent = 'Reading...';
    brandPdfStatus.className = 'brand-upload-status';
    try {
      // Use pdf.js to extract text (already loaded in index.html)
      const arrayBuffer = await file.arrayBuffer();
      if (window.pdfjsLib) {
        const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let text = '';
        for (let i = 1; i <= Math.min(pdf.numPages, 30); i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map((item) => item.str).join(' ') + '\n';
        }
        brandPdfText = text;
        brandPdfStatus.textContent = `${file.name} (${pdf.numPages} pages)`;
        brandPdfStatus.className = 'brand-upload-status loaded';
      } else {
        brandPdfStatus.textContent = 'PDF.js not loaded';
      }
    } catch (err) {
      brandPdfStatus.textContent = `Error: ${err.message}`;
    }
  });
}

// Extract Brand Policies button
const brandExtractBtn = document.getElementById('brandExtractBtn');
if (brandExtractBtn) {
  brandExtractBtn.addEventListener('click', async () => {
    const brandUrl = document.getElementById('brandUrlInput')?.value.trim();
    const mcpEndpoint = document.getElementById('brandMcpInput')?.value.trim();

    if (!brandPdfText && !brandUrl && !mcpEndpoint) {
      addMessage('assistant', md('**No brand source provided.** Upload a brand PDF, paste a guidelines URL, or configure an MCP endpoint first.'));
      return;
    }

    brandExtractBtn.classList.add('extracting');
    brandExtractBtn.innerHTML = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Extracting...';

    // Use the AI to extract brand policies
    if (ai.hasApiKey()) {
      try {
        const sources = [];
        if (brandPdfText) sources.push(`PDF Content (first 3000 chars):\n${brandPdfText.slice(0, 3000)}`);
        if (brandUrl) sources.push(`Brand Guidelines URL: ${brandUrl}`);
        if (mcpEndpoint) sources.push(`Enterprise MCP Endpoint: ${mcpEndpoint}`);

        const extractPrompt = `Extract brand governance policies from the following source(s). Return a JSON array of objects with "category" (tone, terminology, visual, editorial, legal, accessibility, imagery, color, typography) and "rule" (the specific policy). Extract 8-15 concrete, actionable rules. Only return the JSON array, no other text.\n\n${sources.join('\n\n')}`;

        const text = await ai.callRaw(extractPrompt);
        // Parse JSON from response
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          activeBrandPolicies = JSON.parse(jsonMatch[0]);
          saveBrandPolicies();
          addMessage('assistant', md(`**Brand policies extracted!** ${activeBrandPolicies.length} rules configured across ${[...new Set(activeBrandPolicies.map((p) => p.category))].length} categories. These will be enforced in every governance scan.`));
        } else {
          addMessage('assistant', md('**Could not parse brand policies.** The AI response did not contain a valid JSON array. Using demo defaults.'));
          // Fall through to trigger demo defaults below
        }
      } catch (err) {
        console.error('Brand extraction error:', err);
        addMessage('assistant', md(`**Extraction error:** ${err.message}`));
      }
    } else {
      // Demo mode: generate sample policies from the profile's brandVoice
      const profile = getActiveProfile() || {};
      const bv = profile.brandVoice || {};
      activeBrandPolicies = [
        { category: 'Tone', rule: `Brand voice must be: ${bv.tone || 'professional and confident'}` },
        { category: 'Tone', rule: `Writing style: ${bv.style || 'Active voice, short sentences, quantified claims'}` },
        { category: 'Terminology', rule: `Required keywords: ${(bv.keywords || []).join(', ') || 'none specified'}` },
        { category: 'Terminology', rule: `Avoided terms: ${(bv.avoided || []).join(', ') || 'none specified'}` },
        { category: 'Editorial', rule: 'Headlines must be under 10 words with active verbs' },
        { category: 'Editorial', rule: 'CTAs must use action-oriented language (Start, Get, Join, Try)' },
        { category: 'Visual', rule: 'Hero images must include alt text describing the scene' },
        { category: 'Accessibility', rule: 'Color contrast ratio must meet WCAG AA (4.5:1 for text)' },
        { category: 'Legal', rule: 'All claims must include source attribution or disclaimer' },
        { category: 'Legal', rule: `Legal review SLA: ${profile.legalSLA?.reviewTime || '48h'}, escalation at ${profile.legalSLA?.escalation || '72h'}` },
        { category: 'Imagery', rule: 'Stock photography must reflect brand diversity guidelines' },
        { category: 'Color', rule: 'Primary brand colors only — no off-palette colors in headers or CTAs' },
      ];
      if (brandUrl) {
        activeBrandPolicies.push({ category: 'Tone', rule: `Guidelines source: ${brandUrl}` });
      }
      if (mcpEndpoint) {
        activeBrandPolicies.push({ category: 'Editorial', rule: `Enterprise MCP policies loaded from: ${mcpEndpoint}` });
      }
      saveBrandPolicies();
      addMessage('assistant', md(`**Brand policies configured!** ${activeBrandPolicies.length} rules loaded from profile defaults${brandUrl ? ' + guidelines URL' : ''}${mcpEndpoint ? ' + MCP endpoint' : ''}. These will be enforced in every governance scan.\n\n*Tip: Add a Claude API key in Settings for AI-powered policy extraction from your brand documents.*`));
    }

    brandExtractBtn.classList.remove('extracting');
    brandExtractBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> Extract Brand Policies';
  });
}

// Restore saved brand policies on load + populate URL/MCP from profile
function initBrandGovernance() {
  renderBrandPolicies();
  // Pre-populate MCP endpoint from profile entitlements if available
  const profile = getActiveProfile() || {};
  if (profile?.brandMcpEndpoint) {
    const mcpInput = document.getElementById('brandMcpInput');
    if (mcpInput) mcpInput.value = profile.brandMcpEndpoint;
  }
}

// Export brand policies for use in governance scans
function getBrandPolicies() {
  return activeBrandPolicies;
}

/* ── Get Page Context ── */
let cachedPageHTML = null;
let cachedPageUrl = null;

async function fetchPageHTML(url) {
  // Method 0: DA Admin API (authenticated, no CORS issues — most reliable for DA sites)
  if (isSignedIn() && da.getOrg() && da.getRepo()) {
    try {
      const u = new URL(url);
      const path = u.pathname === '/' ? '/index' : u.pathname.replace(/\/$/, '');
      const result = await da.getPage(`${path}.html`);
      if (typeof result === 'string' && result.length > 0) {
        console.log(`[fetchPageHTML] DA Admin API: ${path} (${result.length} chars)`);
        return result;
      }
    } catch (e) { console.warn('[fetchPageHTML] DA Admin API failed:', e.message); }
  }

  // Method 1: AEM EDS .plain.html endpoint (same-origin or CORS-friendly)
  const plainUrl = url.replace(/\/?$/, '.plain.html');
  try {
    const resp = await fetch(plainUrl);
    if (resp.ok) return resp.text();
  } catch { /* CORS or network error */ }

  // Method 2: try the URL directly
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      return match ? match[1] : text;
    }
  } catch { /* ignore */ }

  // Method 3: GitHub raw content (CORS-friendly — works from any origin)
  // Parse the preview URL to extract org/repo/branch/path
  try {
    const u = new URL(url);
    const hostParts = u.hostname.split('--');
    if (hostParts.length >= 3) {
      const branch = hostParts[0];
      const repo = hostParts[1];
      const org = hostParts[2].replace('.aem.page', '').replace('.aem.live', '').replace('.hlx.page', '').replace('.hlx.live', '');
      const path = u.pathname === '/' ? '/index' : u.pathname.replace(/\/$/, '');
      const rawUrl = `https://raw.githubusercontent.com/${org}/${repo}/${branch}${path}.html`;
      const resp = await fetch(rawUrl);
      if (resp.ok) {
        const text = await resp.text();
        const match = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        return match ? match[1] : text;
      }
    }
  } catch { /* ignore */ }

  return null;
}

function getPageContext() {
  const ctx = {
    // ── Unified page context (piped automatically, like da-agent) ──
    customerName: AEM_ORG.name,
    pageUrl: PREVIEW_URL,
    pagePath: activeResourcePath || '/',
    org: AEM_ORG,
    siteType: window.__EW_SITE_TYPE || 'unknown',
    aemHost: window.__EW_AEM_HOST || null,
    view: currentPreviewView || 'preview',
    authState: {
      ims: typeof isSignedIn === 'function' ? isSignedIn() : false,
      github: typeof hasGitHubToken === 'function' ? hasGitHubToken() : false,
    },
  };
  // Try iframe DOM first (same-origin)
  try {
    const iframeDoc = previewFrame.contentDocument || previewFrame.contentWindow?.document;
    if (iframeDoc?.body) {
      ctx.pageHTML = iframeDoc.documentElement.outerHTML;
    }
  } catch { /* cross-origin */ }
  // Use cached fetched HTML
  if (!ctx.pageHTML && cachedPageHTML) {
    ctx.pageHTML = cachedPageHTML;
  }
  // Attach project memory (persistent across sessions)
  const mem = getProjectMemory();
  if (mem) ctx.projectMemory = mem;
  return ctx;
}

async function ensurePageContext() {
  const currentUrl = previewFrame.src || PREVIEW_URL;
  if (cachedPageHTML && cachedPageUrl === currentUrl) return;
  cachedPageUrl = currentUrl;
  cachedPageHTML = await fetchPageHTML(currentUrl);
}

/* ── Tool Result Renderers ── */
/* Declarative registry: maps tool names to UI renderer functions.
   Each renderer receives (parsedResult, profile) and returns HTML string or null. */
const TOOL_RENDERERS = {

  /* ─ Discovery Agent: Asset Grid with Thumbnails ─ */
  search_dam_assets(result) {
    const assets = result.assets;
    if (!assets?.length) return null;
    const query = result.query || 'assets';
    const total = result.total_results || assets.length;
    const cards = assets.map((a) => {
      const thumbSrc = a.thumbnail_url || a.delivery_url || a.dynamic_media_url || '';
      const name = a.title || a.name || 'Asset';
      const dims = a.dimensions ? `${a.dimensions.width} × ${a.dimensions.height}` : '';
      const date = a.last_modified || a.metadata?.upload_date || '';
      const tags = (a.tags || []).slice(0, 3).map((t) => `<span class="asset-tag">${t}</span>`).join('');
      const statusClass = a.status === 'approved' ? 'approved' : 'review';
      const linkUrl = a.delivery_url || a.dynamic_media_url || thumbSrc;
      return `
        <a href="${linkUrl}" target="_blank" rel="noopener" class="asset-card">
          <div class="asset-thumb" style="background-image:url('${thumbSrc}')">
            <span class="asset-status ${statusClass}">${a.status || 'approved'}</span>
          </div>
          <div class="asset-info">
            <div class="asset-name">${name}</div>
            <div class="asset-meta">${dims}${date ? ` · ${date}` : ''}</div>
            ${tags ? `<div class="asset-tags">${tags}</div>` : ''}
          </div>
        </a>`;
    }).join('');
    return `
      <div class="result-card asset-grid-card">
        <div class="result-card-header">
          <span class="result-card-icon">🖼️</span>
          <span class="result-card-title">${total} assets found for "${query}"</span>
        </div>
        <div class="asset-grid">${cards}</div>
      </div>`;
  },

  /* ─ Content Optimization Agent: Firefly Variations ─ */
  generate_image_variations(result) {
    const variations = result.variations;
    if (!variations?.length) return null;
    const cards = variations.map((v, i) => {
      const thumbUrl = v.thumbnail_url || v.delivery_url || '';
      const score = v.confidence_score ? `${Math.round(v.confidence_score * 100)}%` : '';
      return `
        <a href="${v.delivery_url || '#'}" target="_blank" rel="noopener" class="asset-card firefly-card">
          <div class="asset-thumb firefly-thumb" style="background-image:url('${thumbUrl}')">
            <span class="asset-status firefly">Firefly</span>
            ${score ? `<span class="firefly-score">${score}</span>` : ''}
          </div>
          <div class="asset-info">
            <div class="asset-name">Variation ${i + 1}</div>
            <div class="asset-meta">${v.style_preset || ''} · ${v.aspect_ratio || 'original'}</div>
          </div>
        </a>`;
    }).join('');
    return `
      <div class="result-card asset-grid-card">
        <div class="result-card-header">
          <span class="result-card-icon">✨</span>
          <span class="result-card-title">${variations.length} Firefly variations generated</span>
        </div>
        <div class="asset-grid">${cards}</div>
        <div class="result-card-footer">Prompt: "${(result.prompt || '').slice(0, 80)}" · ${result.credits_used || 0} credit(s) used</div>
      </div>`;
  },

  /* ─ Governance Agent: Visual Scorecard ─ */
  run_governance_check(result) {
    const checks = result.checks;
    if (!checks) return null;
    const score = result.overall_score || 0;
    const status = result.overall_status || 'unknown';
    const statusColor = status === 'approved' ? 'var(--green)' : status === 'blocked' ? 'var(--red)' : 'var(--yellow)';
    const statusLabel = status === 'approved' ? 'Approved' : status === 'blocked' ? 'Blocked' : 'Warnings';

    const checkRows = Object.entries(checks).map(([name, data]) => {
      const icon = data.status === 'pass' ? '✓' : data.status === 'warn' ? '!' : data.status === 'fail' ? '✗' : '?';
      const cls = data.status === 'pass' ? 'pass' : data.status === 'warn' ? 'warn' : data.status === 'fail' ? 'fail' : 'review';
      return `
        <div class="gov-check-row">
          <span class="gov-check-icon ${cls}">${icon}</span>
          <span class="gov-check-name">${name}</span>
          <span class="gov-check-score">${data.score}/100</span>
          <div class="gov-check-bar"><div class="gov-check-fill ${cls}" style="width:${data.score}%"></div></div>
        </div>`;
    }).join('');

    const findingsHtml = (result.findings || []).filter((f) => f.severity !== 'pass' && f.severity !== 'info').slice(0, 5).map((f) => {
      const cls = f.severity === 'warn' ? 'warn' : f.severity === 'review' ? 'review' : 'fail';
      return `<div class="gov-finding ${cls}"><span class="gov-finding-dot"></span>${f.message}</div>`;
    }).join('');

    return `
      <div class="result-card gov-card">
        <div class="result-card-header">
          <span class="result-card-icon">🛡️</span>
          <span class="result-card-title">Governance Check — ${result.page_path || 'Page'}</span>
        </div>
        <div class="gov-score-ring">
          <svg viewBox="0 0 100 100" class="gov-ring-svg">
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" stroke-width="6"/>
            <circle cx="50" cy="50" r="42" fill="none" stroke="${statusColor}" stroke-width="6"
              stroke-dasharray="${score * 2.64} ${264 - score * 2.64}" stroke-linecap="round"
              transform="rotate(-90 50 50)"/>
          </svg>
          <div class="gov-score-value">${score}</div>
          <div class="gov-score-label" style="color:${statusColor}">${statusLabel}</div>
        </div>
        <div class="gov-checks">${checkRows}</div>
        ${findingsHtml ? `<div class="gov-findings">${findingsHtml}</div>` : ''}
      </div>`;
  },

  /* ─ LLM Optimizer: Citation Readability Score Card ─ */
  check_citation_readability(result) {
    if (result.error) return null;
    const score = result.score ?? 0;
    const grade = result.grade || 'N/A';
    const estimated = result.agent_words && !result.human_words;
    const scoreColor = score >= 90 ? '#34d399' : score >= 75 ? '#fbbf24' : score >= 50 ? '#f97316' : '#ef4444';
    const circumference = 2 * Math.PI * 42;
    const dashLen = (score / 100) * circumference;

    const statsHTML = [
      `<div class="llmo-stat"><span class="llmo-stat-val">${(result.agent_words || 0).toLocaleString()}</span><span class="llmo-stat-lbl">Agent words</span></div>`,
      result.human_words ? `<div class="llmo-stat"><span class="llmo-stat-val">${result.human_words.toLocaleString()}</span><span class="llmo-stat-lbl">Human words</span></div>` : '',
      result.missing_content?.length ? `<div class="llmo-stat"><span class="llmo-stat-val" style="color:#f87171">${result.missing_content.length}</span><span class="llmo-stat-lbl">Missing</span></div>` : '',
    ].filter(Boolean).join('');

    const pageType = result.is_eds
      ? '<span class="llmo-badge llmo-badge-eds">AEM Edge Delivery</span>'
      : '<span class="llmo-badge llmo-badge-std">Standard Page</span>';

    // Use the report ID from the executor to link to stored report HTML
    const reportId = result._report_id || '';

    return `
      <div class="result-card llmo-card">
        <div class="result-card-header">
          <span class="result-card-icon">
            <svg width="16" height="16" viewBox="0 0 30 26" fill="none"><path d="M11.5 0H0V26L11.5 0Z" fill="#EB1000"/><path d="M18.5 0H30V26L18.5 0Z" fill="#EB1000"/><path d="M15 9.5L21.5 26H17L14.5 19H10L15 9.5Z" fill="#EB1000"/></svg>
          </span>
          <span class="result-card-title">AI Visibility Report</span>
          ${pageType}
        </div>
        <div class="llmo-body">
          <div class="llmo-gauge">
            <svg viewBox="0 0 100 100" class="llmo-ring-svg">
              <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" stroke-width="6"/>
              <circle cx="50" cy="50" r="42" fill="none" stroke="${scoreColor}" stroke-width="6"
                stroke-dasharray="${dashLen.toFixed(1)} ${(circumference - dashLen).toFixed(1)}" stroke-linecap="round"
                transform="rotate(-90 50 50)" style="filter:drop-shadow(0 0 6px ${scoreColor}60)"/>
            </svg>
            <div class="llmo-gauge-score" style="color:${scoreColor}">${score}</div>
            <div class="llmo-gauge-pct" style="color:${scoreColor}">%${estimated ? ' est.' : ''}</div>
            <div class="llmo-gauge-grade" style="background:${scoreColor}20;color:${scoreColor}">Grade ${grade}</div>
          </div>
          <div class="llmo-stats">${statsHTML}</div>
        </div>
        <div class="llmo-actions">
          <button class="llmo-detail-btn" onclick="window.__showLLMOReport && window.__showLLMOReport('${reportId}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            View Full Report
          </button>
        </div>
      </div>`;
  },

  /* ─ Development Agent: Pipeline Status Badges ─ */
  get_pipeline_status(result) {
    const pipelines = result.pipelines;
    if (!pipelines?.length) return null;
    const health = result.environment_health;

    const pipeRows = pipelines.map((p) => {
      const statusCls = p.status === 'completed' ? 'pass' : p.status === 'running' ? 'running' : p.status === 'failed' ? 'fail' : 'pending';
      const statusIcon = p.status === 'completed' ? '✓' : p.status === 'running' ? '◎' : p.status === 'failed' ? '✗' : '○';
      const dur = p.duration_min ? `${p.duration_min}m` : '—';
      const ago = p.last_run ? timeAgo(p.last_run) : '';
      return `
        <div class="pipe-row ${statusCls}">
          <span class="pipe-status-icon">${statusIcon}</span>
          <div class="pipe-info">
            <div class="pipe-name">${p.name}</div>
            <div class="pipe-meta">${p.type} · ${p.environment} · ${p.trigger || ''}${ago ? ` · ${ago}` : ''}</div>
            ${p.failure_reason ? `<div class="pipe-error">${p.failure_reason}</div>` : ''}
          </div>
          <div class="pipe-stats">
            <span class="pipe-duration">${dur}</span>
            <span class="pipe-badge ${statusCls}">${p.status}</span>
          </div>
        </div>`;
    }).join('');

    const healthCls = health?.status === 'healthy' ? 'pass' : 'warn';
    return `
      <div class="result-card pipe-card">
        <div class="result-card-header">
          <span class="result-card-icon">🚀</span>
          <span class="result-card-title">Pipeline Status — ${result.program || 'AEM Program'}</span>
          ${health ? `<span class="pipe-health ${healthCls}">${health.status} · ${health.uptime} uptime</span>` : ''}
        </div>
        <div class="pipe-list">${pipeRows}</div>
      </div>`;
  },

  /* ─ Sites Optimizer: Audit Scorecard ─ */
  get_site_audit(result) {
    const lh = result.lighthouse;
    if (!lh) return null;
    const cwv = result.core_web_vitals;
    const backlinks = result.broken_backlinks;

    const gaugeHTML = (label, value) => {
      const color = value >= 90 ? '#34d399' : value >= 50 ? '#fbbf24' : '#ef4444';
      const circ = 2 * Math.PI * 28;
      const dash = (value / 100) * circ;
      return `
        <div class="so-gauge">
          <svg viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border)" stroke-width="4"/>
            <circle cx="32" cy="32" r="28" fill="none" stroke="${color}" stroke-width="4"
              stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}" stroke-linecap="round"
              transform="rotate(-90 32 32)" style="filter:drop-shadow(0 0 4px ${color}40)"/>
          </svg>
          <span class="so-gauge-val" style="color:${color}">${value}</span>
          <span class="so-gauge-lbl">${label}</span>
        </div>`;
    };

    const gaugesHTML = [
      gaugeHTML('Perf', lh.performance),
      gaugeHTML('A11y', lh.accessibility),
      gaugeHTML('BP', lh.best_practices),
      gaugeHTML('SEO', lh.seo),
    ].join('');

    const cwvHTML = cwv ? Object.entries(cwv).map(([k, v]) => {
      const cls = v.rating === 'good' ? 'pass' : v.rating === 'needs-improvement' ? 'warn' : 'fail';
      return `<div class="so-cwv ${cls}"><span class="so-cwv-name">${k.toUpperCase()}</span><span class="so-cwv-val">${v.value}</span></div>`;
    }).join('') : '';

    const blHTML = backlinks ? `<div class="so-backlinks"><span class="so-bl-count">${backlinks.total}</span> broken backlinks (${backlinks.high_authority || 0} high-authority)</div>` : '';

    return `
      <div class="result-card so-card">
        <div class="result-card-header">
          <span class="result-card-icon">📊</span>
          <span class="result-card-title">Site Audit — ${result.site_url || 'Site'}</span>
        </div>
        <div class="so-gauges">${gaugesHTML}</div>
        ${cwvHTML ? `<div class="so-cwv-row">${cwvHTML}</div>` : ''}
        ${blHTML}
        ${result.summary ? `<div class="so-summary">${result.summary}</div>` : ''}
      </div>`;
  },

  /* ─ Sites Optimizer: Opportunities List ─ */
  get_site_opportunities(result) {
    const opps = result.opportunities;
    if (!opps?.length) return null;
    const summary = result.summary || {};

    const oppRows = opps.slice(0, 8).map((o) => {
      const prCls = o.priority === 'high' ? 'fail' : o.priority === 'medium' ? 'warn' : 'pass';
      const impactBar = Math.round((o.impact || 5) * 10);
      return `
        <div class="so-opp-row">
          <span class="so-opp-priority ${prCls}">${o.priority}</span>
          <div class="so-opp-info">
            <div class="so-opp-title">${o.title}</div>
            <div class="so-opp-meta">${o.category} · ${o.pages_affected || 0} page(s) · impact ${o.impact}/10</div>
          </div>
          <div class="so-opp-bar"><div class="so-opp-fill ${prCls}" style="width:${impactBar}%"></div></div>
        </div>`;
    }).join('');

    return `
      <div class="result-card so-card">
        <div class="result-card-header">
          <span class="result-card-icon">💡</span>
          <span class="result-card-title">${opps.length} Optimization Opportunities</span>
          <span class="so-opp-summary">${summary.high_priority || 0} high · ${summary.medium_priority || 0} med · ${summary.low_priority || 0} low</span>
        </div>
        <div class="so-opp-list">${oppRows}</div>
      </div>`;
  },

  /* ─ AEM Content Agent: Page Created Card ─ */
  copy_aem_page(result, profile) {
    if (result.status !== 'created') return null;
    const title = result.title || result.path?.replace(/^\//, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'New Page';
    const siteName = profile?.name || 'AEM Site';
    const ueUrl = result.edit_urls?.universal_editor;
    const daUrl = result.edit_urls?.document_authoring;
    const profileName = profile?.contactName || 'Author';
    return `
      <div class="page-card">
        <div class="page-card-header">
          <div class="page-card-icon">📄</div>
          <div class="page-card-meta">
            <div class="page-card-title">${title} — Live on ${siteName}</div>
            <div class="page-card-author">Created by: ${profileName} — just now</div>
          </div>
        </div>
        ${ueUrl ? `<a href="${ueUrl}" target="_blank" rel="noopener" class="page-card-link">Open in Universal Editor →</a>` : ''}
        ${daUrl ? `<a href="${daUrl}" target="_blank" rel="noopener" class="page-card-link page-card-link-secondary">Open in Document Authoring →</a>` : ''}
      </div>`;
  },

  /* ─ DA Editing Agent: Page Written Confirmation ─ */
  edit_page_content(result) {
    if (result.status === 'auth_required') {
      return `
        <div class="page-card page-card-warn">
          <div class="page-card-header">
            <div class="page-card-icon">🔐</div>
            <div class="page-card-meta">
              <div class="page-card-title">Adobe Sign-In Required</div>
              <div class="page-card-author">Click "Sign In" to authenticate with Adobe IMS for DA editing</div>
            </div>
          </div>
        </div>`;
    }
    if (result.status === 'error') {
      return `
        <div class="page-card page-card-error">
          <div class="page-card-header">
            <div class="page-card-icon">⚠</div>
            <div class="page-card-meta">
              <div class="page-card-title">DA Write Failed</div>
              <div class="page-card-author">${result.error || 'Unknown error'}</div>
            </div>
          </div>
        </div>`;
    }
    // Local preview mode — content rendered directly in iframe (no DA auth)
    if (result.status === 'local_preview') {
      const path = result.page_path || '/';
      return `
        <div class="page-card page-card-live">
          <div class="page-card-header">
            <div class="page-card-icon">✓</div>
            <div class="page-card-meta">
              <div class="page-card-title">${path} — Live Preview</div>
              <div class="page-card-author">${result.content_length?.toLocaleString() || '?'} chars · Rendered in preview</div>
            </div>
          </div>
        </div>`;
    }
    if (result.status !== 'written') return null;
    const path = result.page_path || '/';
    const previewOk = result.preview_status === 'success';
    return `
      <div class="page-card page-card-live">
        <div class="page-card-header">
          <div class="page-card-icon">${previewOk ? '✓' : '📝'}</div>
          <div class="page-card-meta">
            <div class="page-card-title">${path} — ${previewOk ? 'Saved & Previewing' : 'Saved to DA'}</div>
            <div class="page-card-author">${result.content_length?.toLocaleString() || '?'} chars · Preview ${result.preview_status || 'not triggered'}</div>
          </div>
        </div>
        ${result.preview_url ? `<a href="${result.preview_url}" target="_blank" rel="noopener" class="page-card-link">Open preview →</a>` : ''}
        ${result.da_edit_url ? `<a href="${result.da_edit_url}" target="_blank" rel="noopener" class="page-card-link page-card-link-secondary">Edit in DA →</a>` : ''}
      </div>`;
  },

  /* ─ AEM Content MCP: JCR Page Patch Card ─ */
  patch_aem_page_content(result) {
    if (result.status === 'error') {
      return `
        <div class="page-card page-card-error">
          <div class="page-card-header">
            <div class="page-card-icon">⚠</div>
            <div class="page-card-meta">
              <div class="page-card-title">AEM Patch Failed</div>
              <div class="page-card-author">${result.error || 'Unknown error'}</div>
            </div>
          </div>
        </div>`;
    }
    if (result.status !== 'updated') return null;
    const path = result.page_path || '';
    const fields = result.updated_fields || [];
    const ueUrl = result.edit_urls?.universal_editor;
    return `
      <div class="page-card page-card-live">
        <div class="page-card-header">
          <div class="page-card-icon">✓</div>
          <div class="page-card-meta">
            <div class="page-card-title">${path} — Updated via AEM Content MCP</div>
            <div class="page-card-author">${fields.length} field(s) updated · Preview refreshing</div>
          </div>
        </div>
        ${result.preview_url ? `<a href="${result.preview_url}" target="_blank" rel="noopener" class="page-card-link">Open preview →</a>` : ''}
        ${ueUrl ? `<a href="${ueUrl}" target="_blank" rel="noopener" class="page-card-link page-card-link-secondary">Edit in Universal Editor →</a>` : ''}
      </div>`;
  },

  /* ─ AEM Content MCP: JCR Page Copy Card ─ */
  copy_aem_page(result) {
    if (result.status !== 'created') return null;
    const path = result.path || '';
    const ueUrl = result.edit_urls?.universal_editor;
    return `
      <div class="page-card page-card-live">
        <div class="page-card-header">
          <div class="page-card-icon">✓</div>
          <div class="page-card-meta">
            <div class="page-card-title">${path} — Page Created</div>
            <div class="page-card-author">Copied from ${result.copied_from || 'template'}</div>
          </div>
        </div>
        ${result.preview_url ? `<a href="${result.preview_url}" target="_blank" rel="noopener" class="page-card-link">Open preview →</a>` : ''}
        ${ueUrl ? `<a href="${ueUrl}" target="_blank" rel="noopener" class="page-card-link page-card-link-secondary">Edit in Universal Editor →</a>` : ''}
      </div>`;
  },

  /* ─ Experimentation Agent: Experiment Setup Card ─ */
  setup_experiment(result) {
    if (result.status !== 'created' && result.status !== 'partial') return null;
    const variants = result.variants || [];
    const variantRows = variants.map((v) => `
      <div class="page-card-variant">
        <span class="page-card-variant-name">${v.path.split('/').pop()}</span>
        <span class="page-card-variant-split">${v.split}</span>
        <span class="page-card-variant-desc">${v.description || ''}</span>
      </div>
    `).join('');
    return `
      <div class="page-card page-card-live" style="border-left: 3px solid var(--accent)">
        <div class="page-card-header">
          <div class="page-card-icon">🧪</div>
          <div class="page-card-meta">
            <div class="page-card-title">Experiment: ${result.experiment_name}</div>
            <div class="page-card-author">Control: ${result.control_page} (${result.control_split}) · ${variants.length} challenger(s)</div>
          </div>
        </div>
        <div style="padding:0 14px 10px;font-size:11px;color:var(--text-secondary)">${variantRows}</div>
        ${result.preview_overlay ? `<a href="${result.preview_overlay}" target="_blank" rel="noopener" class="page-card-link">Preview experiment overlay →</a>` : ''}
      </div>`;
  },

  /* ─ Forms Agent: Form Generated Card ─ */
  generate_form(result) {
    if (result.status !== 'generated') return null;
    const fieldList = (result.fields || []).map((f) => `<span style="background:var(--bg-secondary);padding:2px 6px;border-radius:4px;font-size:10px">${f.label || f.name} (${f.type})</span>`).join(' ');
    return `
      <div class="page-card" style="border-left: 3px solid #2d7ff9">
        <div class="page-card-header">
          <div class="page-card-icon">📋</div>
          <div class="page-card-meta">
            <div class="page-card-title">Form Generated — ${result.field_count} fields</div>
            <div class="page-card-author">Submit to: ${result.submit_action}</div>
          </div>
        </div>
        <div style="padding:0 14px 10px;display:flex;flex-wrap:wrap;gap:4px">${fieldList}</div>
      </div>`;
  },

  /* ─ Content Variations Agent: Variations Card ─ */
  generate_page_variations(result) {
    if (result.status !== 'generated') return null;
    const vars = (result.variations || []).map((v) => `
      <div style="padding:6px 0;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;font-size:12px;color:var(--text-primary)">${v.name} — ${v.tone}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${v.ai_rationale}</div>
        <div style="font-size:10px;color:var(--accent);margin-top:2px">CTA: ${v.changes?.cta_text || ''}</div>
      </div>
    `).join('');
    return `
      <div class="page-card" style="border-left: 3px solid var(--green)">
        <div class="page-card-header">
          <div class="page-card-icon">✨</div>
          <div class="page-card-meta">
            <div class="page-card-title">${result.num_variations} Variations for ${result.source_page}</div>
            <div class="page-card-author">Audience: ${result.target_audience} · Tone: ${result.tone}</div>
          </div>
        </div>
        <div style="padding:0 14px 10px">${vars}</div>
      </div>`;
  },

  /* ─ DA Editing Agent: Publish Confirmation ─ */
  publish_page(result) {
    if (result.status !== 'published') return null;
    return `
      <div class="page-card page-card-live">
        <div class="page-card-header">
          <div class="page-card-icon">🌐</div>
          <div class="page-card-meta">
            <div class="page-card-title">${result.page_path} — Published Live</div>
            <div class="page-card-author">${result.published_at ? `Published ${new Date(result.published_at).toLocaleTimeString()}` : 'Just now'}</div>
          </div>
        </div>
        ${result.live_url ? `<a href="${result.live_url}" target="_blank" rel="noopener" class="page-card-link">Open live page →</a>` : ''}
      </div>`;
  },
};

/* ── Contextual Suggestion Engine ── */
/* Maps tool names to smart follow-up action chips.
   After AI completes, we look at which tools were called and surface
   the most relevant next steps as clickable chips (like AI Assistant). */
const TOOL_SUGGESTIONS = {
  search_dam_assets: [
    { icon: '📄', label: 'Use in a new page', prompt: 'Create a new page using the best assets from those results' },
    { icon: '✨', label: 'Generate variations', prompt: 'Generate Firefly variations of the top asset' },
    { icon: '🛡️', label: 'Check asset rights', prompt: 'Run a DRM and rights check on these assets' },
  ],
  copy_aem_page: [
    { icon: '✏️', label: 'Edit the content', prompt: 'Update the hero headline and body copy on the new page' },
    { icon: '🛡️', label: 'Run governance check', prompt: 'Run a full governance check on the new page' },
    { icon: '🚀', label: 'Create a Launch', prompt: 'Create a Launch for this page for review and approval' },
  ],
  patch_aem_page_content: [
    { icon: '👁️', label: 'Preview the page', prompt: 'Show me the current page content after the changes' },
    { icon: '🛡️', label: 'Run governance check', prompt: 'Run governance checks on the updated page' },
    { icon: '📋', label: 'Create review task', prompt: 'Create a Workfront task to review the content changes' },
  ],
  run_governance_check: [
    { icon: '🔧', label: 'Fix the issues', prompt: 'Fix the accessibility and governance issues found' },
    { icon: '🚀', label: 'Promote to production', prompt: 'Create a Launch and promote this page to production' },
    { icon: '📋', label: 'Assign to reviewer', prompt: 'Create a Workfront task for the approval chain to review' },
  ],
  get_pipeline_status: [
    { icon: '🔍', label: 'Analyze failure', prompt: 'Analyze the failed pipeline and suggest a fix' },
    { icon: '📊', label: 'View deployment history', prompt: 'Show me the full deployment history for production' },
    { icon: '🔔', label: 'Create alert task', prompt: 'Create a Workfront task for the pipeline failure' },
  ],
  generate_image_variations: [
    { icon: '📄', label: 'Apply to page', prompt: 'Apply the best Firefly variation to the hero section' },
    { icon: '✨', label: 'Generate more', prompt: 'Generate 4 more variations with different styles' },
    { icon: '🛡️', label: 'Brand compliance check', prompt: 'Check if these generated images match our brand guidelines' },
  ],
  get_audience_segments: [
    { icon: '👥', label: 'Create variant', prompt: 'Create a personalized content variant for the top segment' },
    { icon: '🎯', label: 'Setup A/B test', prompt: 'Create an A/B test targeting these audience segments' },
    { icon: '📊', label: 'View analytics', prompt: 'Show me analytics insights for these segments' },
  ],
  create_ab_test: [
    { icon: '📊', label: 'View test results', prompt: 'Show me the current A/B test performance metrics' },
    { icon: '🎯', label: 'Adjust targeting', prompt: 'Refine the targeting rules for this test' },
    { icon: '🏆', label: 'Pick winner', prompt: 'Analyze results and recommend the winning variant' },
  ],
  get_analytics_insights: [
    { icon: '📄', label: 'Optimize content', prompt: 'Suggest content optimizations based on these analytics' },
    { icon: '👥', label: 'Create segments', prompt: 'Create audience segments from the high-performing traffic' },
    { icon: '🎯', label: 'Setup personalization', prompt: 'Setup personalization rules based on these insights' },
  ],
  translate_page: [
    { icon: '🛡️', label: 'Review translation', prompt: 'Run governance and brand checks on the translated page' },
    { icon: '🌐', label: 'Translate more', prompt: 'Translate the same page into additional languages' },
    { icon: '📋', label: 'Create review task', prompt: 'Create a Workfront task for native speaker review' },
  ],
  extract_pdf_content: [
    { icon: '📄', label: 'Generate the page', prompt: 'Create an AEM page from the extracted brief content' },
    { icon: '🖼️', label: 'Find matching assets', prompt: 'Search DAM for images that match the brief themes' },
    { icon: '📋', label: 'Create project tasks', prompt: 'Break down the brief into Workfront tasks' },
  ],
  create_workfront_task: [
    { icon: '📋', label: 'View project status', prompt: 'Show me the current Workfront project health and timeline' },
    { icon: '👤', label: 'Check team capacity', prompt: 'Check team workload and capacity for this sprint' },
    { icon: '📊', label: 'View all tasks', prompt: 'Show all open tasks and their current status' },
  ],
  edit_page_content: [
    { icon: '🛡️', label: 'Run governance', prompt: 'Run a full governance check on the page I just edited' },
    { icon: '🌐', label: 'Publish live', prompt: 'Publish this page to the live .aem.live URL' },
    { icon: '✏️', label: 'Edit more', prompt: 'Show me the current page content so I can make more changes' },
  ],
  preview_page: [
    { icon: '🌐', label: 'Publish live', prompt: 'Publish this page live now' },
    { icon: '🛡️', label: 'Run governance', prompt: 'Run governance and compliance checks before publishing' },
  ],
  publish_page: [
    { icon: '📊', label: 'Check analytics', prompt: 'Show me analytics for this published page' },
    { icon: '🎯', label: 'Setup A/B test', prompt: 'Create an A/B test on this published page' },
    { icon: '📋', label: 'Notify stakeholders', prompt: 'Create a Workfront task to notify the team about the new publish' },
  ],
  search_experience_league: [
    { icon: '📖', label: 'View tutorial', prompt: 'Show me a step-by-step tutorial for this topic' },
    { icon: '📋', label: 'Release notes', prompt: 'What are the latest release notes for this product?' },
    { icon: '🔧', label: 'Troubleshoot', prompt: 'Search for troubleshooting guides related to this topic' },
  ],
  get_product_release_notes: [
    { icon: '📖', label: 'Deep dive', prompt: 'Search Experience League for docs on the new features mentioned' },
    { icon: '📊', label: 'Compare versions', prompt: 'Show me release notes from the last 3 months to see the trend' },
    { icon: '📋', label: 'Plan upgrades', prompt: 'Create a Workfront task to evaluate and adopt the new features' },
  ],
  get_site_opportunities: [
    { icon: '🔧', label: 'Fix top issue', prompt: 'Help me fix the highest-impact opportunity' },
    { icon: '📊', label: 'Full audit', prompt: 'Run a full site audit with Lighthouse scores and CWV metrics' },
    { icon: '📋', label: 'Create tasks', prompt: 'Create Workfront tasks for each high-priority opportunity' },
  ],
  get_site_audit: [
    { icon: '🎯', label: 'Get opportunities', prompt: 'What optimization opportunities do you recommend based on this audit?' },
    { icon: '🔗', label: 'Fix backlinks', prompt: 'Show me the broken backlinks and suggest redirects to fix them' },
    { icon: '📋', label: 'Track fixes', prompt: 'Create Workfront tasks for the issues found in the audit' },
  ],
  list_destinations: [
    { icon: '🏥', label: 'Check health', prompt: 'Get destination health summary — any issues I should know about?' },
    { icon: '📊', label: 'View flow runs', prompt: 'Show me recent data flow runs across all destinations' },
    { icon: '🔧', label: 'Fix failing', prompt: 'Investigate and suggest fixes for any failing destinations' },
  ],
  list_destination_flow_runs: [
    { icon: '🏥', label: 'Health dashboard', prompt: 'Get the overall destination health dashboard' },
    { icon: '🔍', label: 'Investigate failures', prompt: 'Investigate the failed flow runs and recommend fixes' },
    { icon: '📋', label: 'Create fix task', prompt: 'Create a Workfront task for the destination issues found' },
  ],
  get_destination_health: [
    { icon: '📊', label: 'Detailed flow runs', prompt: 'Show me detailed flow runs for the destinations with issues' },
    { icon: '🔔', label: 'Alert on issues', prompt: 'Create a support ticket for the destination health issues' },
    { icon: '👥', label: 'Check segments', prompt: 'Show me the audience segments feeding these destinations' },
  ],
  setup_experiment: [
    { icon: '✏️', label: 'Edit challengers', prompt: 'Edit the challenger page content to apply the variation' },
    { icon: '📊', label: 'Check results', prompt: 'How is the experiment performing? Show me conversion data' },
    { icon: '🏆', label: 'Pick winner', prompt: 'Analyze the experiment results and recommend a winner' },
  ],
  get_experiment_status: [
    { icon: '🏆', label: 'Pick winner', prompt: 'Based on these results, which variant should we promote?' },
    { icon: '⏱️', label: 'Extend test', prompt: 'The confidence is low — extend the experiment duration' },
    { icon: '📋', label: 'Create report', prompt: 'Create a summary report of this experiment for stakeholders' },
  ],
  generate_form: [
    { icon: '📄', label: 'Embed in page', prompt: 'Add this form to the page' },
    { icon: '✏️', label: 'Add more fields', prompt: 'Add a file upload and department dropdown to the form' },
    { icon: '🔗', label: 'Set submit action', prompt: 'Configure the form to submit to a REST API endpoint' },
  ],
  generate_page_variations: [
    { icon: '🧪', label: 'Setup A/B test', prompt: 'Create an A/B test with the best two variations' },
    { icon: '✏️', label: 'Refine variation', prompt: 'Refine Variation A with a more urgent tone' },
    { icon: '📊', label: 'More variations', prompt: 'Generate 3 more variations with a different audience focus' },
  ],
};

function getContextualSuggestions(toolsCalledSet) {
  const seen = new Set();
  const suggestions = [];
  // Prioritize: take suggestions from each tool called, avoid duplicates
  for (const tool of toolsCalledSet) {
    const candidates = TOOL_SUGGESTIONS[tool];
    if (!candidates) continue;
    for (const s of candidates) {
      if (!seen.has(s.label) && suggestions.length < 3) {
        seen.add(s.label);
        suggestions.push(s);
      }
    }
  }
  return suggestions;
}

/* Helper: relative time ago */
function timeAgo(isoStr) {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

/* ── REAL: AI Chat (with native tool use) ── */
async function handleRealChat(text, file) {
  // Abort any in-flight AI request before starting a new one
  ai.abortCurrentChat();

  // Build message content — with file attachment if present
  let messageContent;
  if (file && file.type === 'image') {
    // Claude vision: send image as base64 + text
    messageContent = [
      { type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.content } },
      { type: 'text', text: text || `Analyze this image: ${file.name}` },
    ];
  } else if (file && file.type === 'pdf') {
    // PDF: send as native Claude document block (base64)
    messageContent = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.content } },
      { type: 'text', text: text || `Analyze this document: ${file.name}` },
    ];
  } else if (file && file.type === 'document') {
    // Text document (DOCX extracted text, .txt, .csv, etc.): inject as text
    messageContent = `${text || `Analyze this document: ${file.name}`}\n\n--- Attached file: ${file.name} ---\n${file.content.slice(0, 30000)}${file.content.length > 30000 ? '\n\n[... truncated]' : ''}`;
  } else {
    messageContent = text;
  }

  conversationHistory.push({ role: 'user', content: messageContent });

  // Track prompt in project memory (for learning frequent patterns)
  if (text && text.length > 5 && text.length < 200) {
    try {
      const mem = getProjectMemory() || {};
      const prompts = mem.lastPrompts || [];
      prompts.unshift(text);
      updateProjectMemory({ lastPrompts: prompts.slice(0, 20) });
    } catch { /* non-blocking */ }
  }

  await ensurePageContext();
  const ctx = getPageContext();

  // Tool call UI container — collapsible tool calls (like Claude.ai)
  let toolContainer = null;
  let toolCount = 0;

  // Track which agent badges have been shown
  const shownAgents = new Set();
  const agentContainers = {};
  const toolsCalled = new Set(); // Track tools called this turn for suggestions

  function onToolCall(toolName, toolInput) {
    toolCount++;
    toolsCalled.add(toolName);
    const agentName = TOOL_AGENT_MAP[toolName] || 'Adobe Agent';

    // Create a new collapsible container per agent
    if (!agentContainers[agentName]) {
      shownAgents.add(agentName);
      toolContainer = addRawHTML(`
        <div class="tool-group" data-agent="${agentName}">
          <div class="tool-group-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="tool-group-indicator"><span class="gen-dot active"></span></span>
            <span class="tool-group-agent">${agentName}</span>
            <span class="tool-group-count"></span>
            <span class="tool-group-chevron">▾</span>
          </div>
          <div class="tool-group-body"></div>
        </div>
      `);
      agentContainers[agentName] = toolContainer.querySelector('.tool-group');
    }

    const group = agentContainers[agentName];
    const bodyEl = group.querySelector('.tool-group-body');
    const toolId = `tool-call-${toolCount}`;
    const inputSummary = formatToolInput(toolName, toolInput);

    bodyEl.innerHTML += `
      <div class="tool-call-row active" id="${toolId}">
        <span class="tool-call-dot"></span>
        <span class="tool-call-name">${escapeHtml(toolName)}</span>
        <span class="tool-call-args">(${escapeHtml(inputSummary)})</span>
        <span class="tool-call-status">Running</span>
      </div>
    `;

    // Update count badge
    const count = bodyEl.querySelectorAll('.tool-call-row').length;
    group.querySelector('.tool-group-count').textContent = count > 1 ? `${count} calls` : '';

    scrollChat();
  }

  async function onToolResult(toolName, resultStr) {
    const stepEl = document.querySelector(`#tool-call-${toolCount}`);
    if (stepEl) {
      stepEl.classList.replace('active', 'done');
      stepEl.querySelector('.tool-call-status').textContent = 'Result';
    }

    // ── Tool Result Renderer Dispatch ──
    // Declarative system: auto-renders structured tool results as rich UI
    const renderer = TOOL_RENDERERS[toolName];
    if (renderer) {
      try {
        const result = JSON.parse(resultStr);
        const html = renderer(result, getActiveProfile());
        if (html) { addRawHTML(html); scrollChat(); }
      } catch { /* not parseable JSON — skip rich render */ }
    }

    // ── DA Editing Loop: Auto-refresh preview iframe ──
    // When edit_page_content or preview_page completes, refresh the preview
    try {
      const result = JSON.parse(resultStr);

      // GitHub write — content committed, refresh after CDN propagation
      if (result._action === 'local_write' && result._preview_path) {
        const path = result._preview_path;
        setTimeout(() => {
          navigateToPage(path);
          showToast(`Page ${path} saved via GitHub — preview refreshed`, 'success');
        }, 1500);
      }

      // Content saved — optimistic preview (like EW's instant Y.js updates).
      // Render the new HTML immediately via srcdoc, then swap to real CDN once ready.
      if (result._action === 'refresh_preview' && result._preview_path) {
        const path = result._preview_path;
        const previewUrl = AEM_ORG.previewOrigin + path;
        activeResourcePath = path;

        // Step 1: Optimistic render — show new content instantly via DA Admin API
        if (previewFrame && isSignedIn() && da.getOrg()) {
          try {
            const htmlPath = (path === '/' ? '/index' : path) + '.html';
            const freshHTML = await da.getPage(htmlPath);
            if (typeof freshHTML === 'string' && freshHTML.length > 0) {
              const base = AEM_ORG.previewOrigin;
              previewFrame.srcdoc = `<!DOCTYPE html><html><head>
                <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
                <base href="${base}/"><link rel="stylesheet" href="${base}/styles/styles.css">
                <script src="${base}/scripts/aem.js" type="module"><\/script>
                <script src="${base}/scripts/scripts.js" type="module"><\/script>
              </head><body><header></header><main>${freshHTML}</main><footer></footer></body></html>`;
              cachedPageHTML = freshHTML;
              cachedPageUrl = previewUrl;
              showToast(`Page ${path} saved — preview updated`, 'success');
            }
          } catch (e) {
            console.warn('[Preview] Optimistic render failed:', e.message);
          }
        }

        // Step 2: Swap to real CDN URL after propagation (background, non-blocking)
        setTimeout(() => {
          if (previewFrame && previewFrame.srcdoc) {
            previewFrame.removeAttribute('srcdoc');
            previewFrame.src = previewUrl;
          }
        }, 5000);
      }

      // Auth required — no write happened, tell the user clearly
      if (result._action === 'auth_required') {
        showToast('Sign in with Adobe to enable content editing', 'error');
      }
      if (result.status === 'published' && result.live_url) {
        showToast(`Published to ${result.live_url}`, 'success');
      }
      if (result.status === 'auth_required') {
        showToast('Adobe sign-in required — click Sign In', 'warn');
      }
    } catch { /* not parseable — skip */ }

    // Check if all calls in this agent group are done — update the header dot
    const agentName = TOOL_AGENT_MAP[toolName] || 'Adobe Agent';
    const group = agentContainers[agentName];
    if (group) {
      const allDone = [...group.querySelectorAll('.tool-call-row')].every((r) => r.classList.contains('done'));
      if (allDone) {
        const dot = group.querySelector('.tool-group-header .gen-dot');
        if (dot) dot.classList.replace('active', 'done');
        // Auto-collapse completed agent groups after a short delay
        setTimeout(() => { group.classList.add('collapsed'); scrollChat(); }, 800);
      }
    }
  }

  const streamEl = addStreamMessage('Experience Agent');

  try {
    const rawResponse = await ai.streamChat(
      conversationHistory,
      ctx,
      (chunk, full) => {
        streamEl.innerHTML = md(full);
        scrollChat();
      },
      onToolCall,
      onToolResult,
    );

    conversationHistory.push({ role: 'assistant', content: rawResponse });

    // ── Contextual Suggestion Chips ──
    // Show smart follow-up actions based on which tools were called
    if (toolsCalled.size > 0) {
      const suggestions = getContextualSuggestions(toolsCalled);
      if (suggestions.length > 0) {
        const chips = suggestions.map((s) => `<button class="suggestion-chip" data-prompt="${s.prompt.replace(/"/g, '&quot;')}">${s.icon} ${s.label}</button>`).join('');
        const chipBar = addRawHTML(`
          <div class="suggestion-bar">
            <span class="suggestion-label">Related</span>
            ${chips}
          </div>
        `);
        // Wire click handlers
        chipBar.querySelectorAll('.suggestion-chip').forEach((btn) => {
          btn.addEventListener('click', () => {
            const prompt = btn.dataset.prompt;
            chatInput.value = prompt;
            chipBar.remove(); // Remove chips once one is clicked
            handleUserInput();
          });
        });
        scrollChat();
      }
    }
  } catch (err) {
    streamEl.innerHTML = `<span style="color:var(--accent)">AI Error: ${escapeHtml(err.message)}</span><br>Check your API key in settings.`;
  }
}

/* Format tool input for display */
function formatToolInput(toolName, input) {
  if (!input || Object.keys(input).length === 0) return '';

  switch (toolName) {
    case 'get_aem_sites': return '';
    case 'get_aem_site_pages': return `"${input.site_id || ''}"`;
    case 'get_page_content': {
      if (input.url) return `"${input.url.split('/').pop() || input.url}"`;
      if (input.path) return `"${input.site_id || ''}${input.path}"`;
      return '';
    }
    case 'copy_aem_page': return `"${input.destination_path || ''}"`;
    case 'patch_aem_page_content': return `"${input.page_path || ''}"`;
    case 'create_aem_launch': return `"${input.launch_name || ''}"`;
    case 'promote_aem_launch': return `"${input.launch_id || ''}"`;
    case 'search_dam_assets': return `"${(input.query || '').slice(0, 30)}"`;
    case 'run_governance_check': return `"${input.page_path || ''}"`;
    case 'get_audience_segments': return `${input.action || 'list'}`;
    case 'create_content_variant': return `"${input.segment || ''}"`;
    case 'get_analytics_insights': return `"${(input.query || '').slice(0, 30)}"`;
    case 'get_journey_status': return `${input.action || 'list'}`;
    case 'create_workfront_task': return `"${(input.title || '').slice(0, 30)}"`;
    case 'extract_brief_content': return `"${input.file_name || 'brief'}"`;
    case 'create_ab_test': return `"${(input.test_name || '').slice(0, 30)}"`;
    case 'get_personalization_offers': return `"${input.location || input.segment || ''}"`;
    case 'edit_page_content': return `"${input.page_path || ''}" (${input.html?.length || 0} chars)`;
    case 'preview_page': return `"${input.page_path || ''}"`;
    case 'publish_page': return `"${input.page_path || ''}"`;
    case 'list_site_pages': return `"${input.path || '/'}"`;
    case 'delete_page': return `"${input.page_path || ''}"`;
    case 'get_customer_profile': return `"${(input.identity || '').slice(0, 25)}"`;

    case 'generate_image_variations': return `"${(input.prompt || '').slice(0, 25)}"`;
    case 'get_pipeline_status': return `${input.environment || 'prod'}${input.status_filter ? ` (${input.status_filter})` : ''}`;
    case 'extract_pdf_content': return `"${input.file_name || 'document.pdf'}"`;
    case 'translate_page': return `"${input.page_path || ''}" → ${input.target_language || ''}`;
    case 'create_form': return `"${(input.description || '').slice(0, 30)}"`;
    case 'modernize_content': return `"${input.page_path || ''}"`;
    case 'get_brand_guidelines': return `"${input.brand || 'default'}"`;
    case 'check_asset_expiry': return `"${(input.asset_path || input.query || '').slice(0, 30)}"`;
    case 'audit_content': return `"${input.page_path || ''}"`;
    case 'transform_image': return `"${(input.asset_path || '').split('/').pop()}" ${input.action || ''}`;
    case 'create_image_renditions': return `"${(input.asset_path || '').split('/').pop()}"`;
    case 'add_to_collection': return `"${(input.collection_name || '').slice(0, 25)}"`;
    case 'analyze_pipeline_failure': return `"${input.pipeline_id || ''}"`;
    case 'analyze_journey_conflicts': return `"${(input.journey_name || '').slice(0, 25)}"`;
    case 'create_support_ticket': return `"${(input.subject || '').slice(0, 30)}"`;
    case 'get_ticket_status': return `"${input.case_id || ''}"`;
    case 'search_experience_league': return `"${(input.query || '').slice(0, 30)}"${input.product_filter ? ` (${input.product_filter})` : ''}`;
    case 'get_product_release_notes': return `${input.product || 'aem'} — ${input.timeframe || 'latest'}`;
    case 'get_site_opportunities': return `${input.category || 'all'}${input.priority ? ` (${input.priority})` : ''}`;
    case 'get_site_audit': return `${input.audit_type || 'full'}`;
    case 'list_destinations': return `${input.status_filter || 'all'}${input.type_filter ? ` (${input.type_filter})` : ''}`;
    case 'list_destination_flow_runs': return `"${input.destination_id || 'all'}"${input.hours ? ` ${input.hours}h` : ''}`;
    case 'get_destination_health': return input.include_flow_details ? 'detailed' : 'summary';
    case 'setup_experiment': return `"${input.experiment_name || ''}" on ${input.control_page || '/'}`;
    case 'get_experiment_status': return `"${input.experiment_name || ''}"`;
    case 'generate_form': return `"${(input.description || '').slice(0, 30)}"`;
    case 'generate_page_variations': return `"${input.page_path || ''}" × ${input.num_variations || 3}`;
    default: {
      const str = JSON.stringify(input);
      return str.length > 40 ? str.slice(0, 37) + '...' : str;
    }
  }
}

/* ── REAL: Governance Scan ── */
async function runRealGovernance() {
  // Guard: check if a page is actually loaded in the preview
  let hasPage = false;
  try {
    const iframeDoc = previewFrame.contentDocument || previewFrame.contentWindow?.document;
    if (iframeDoc?.body?.innerHTML?.trim()) hasPage = true;
  } catch { /* cross-origin — page might still be there */ hasPage = true; }
  if (!hasPage) {
    // Try fetching the page HTML to be sure
    const currentUrl = previewFrame.src || PREVIEW_URL;
    if (!currentUrl || currentUrl === 'about:blank') {
      addMessage('user', 'Run governance scan on the current page');
      addMessage('assistant', 'No page is loaded in the preview. Navigate to a page first, then run the governance scan.', 'Governance Agent');
      return;
    }
  }

  addMessage('user', 'Run governance scan on the current page');

  // Step 1: Client-side DOM scan
  const scanMsg = addRawHTML(`
    <div class="agent-badge">Governance Scanner</div>
    <div class="message-content">
      <strong>Scanning page...</strong>
      <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
    </div>
  `);
  const fill = scanMsg.querySelector('.progress-fill');

  let scanResult = null;
  let scanDoc = null;

  // Try iframe DOM first (same-origin), then fetch .plain.html
  try {
    scanDoc = previewFrame.contentDocument || previewFrame.contentWindow?.document;
    if (!scanDoc?.body?.innerHTML) scanDoc = null;
  } catch { scanDoc = null; }

  if (!scanDoc) {
    // Fetch page HTML and parse into a document
    fill.style.width = '20%';
    await ensurePageContext();
    fill.style.width = '40%';

    if (cachedPageHTML) {
      const parser = new DOMParser();
      scanDoc = parser.parseFromString(
        `<!DOCTYPE html><html><head></head><body>${cachedPageHTML}</body></html>`,
        'text/html',
      );
    }
  }

  if (scanDoc) {
    for (let i = 3; i <= 5; i++) {
      await sleep(250);
      fill.style.width = `${i * 20}%`;
    }

    scanResult = gov.scanPage(scanDoc);
    const formatted = gov.formatResults(scanResult);

    addRawHTML(`
      <div class="agent-badge">Governance Scanner</div>
      <div class="message-content">${formatted.html}</div>
    `);

    // Update governance bar
    const checks = {};
    Object.entries(scanResult.results).forEach(([key, cat]) => {
      if (['brand', 'legal', 'a11y', 'seo'].includes(key)) {
        if (cat.fail > 0) checks[key] = 'fail';
        else if (cat.warn > 0) checks[key] = 'warn';
        else checks[key] = true;
      }
    });
    // Governance results displayed in chat (bar removed in AEMCoder redesign)
  } else {
    fill.style.width = '100%';
    addMessage('assistant', '⚠ Could not fetch page content for scanning. Check the preview URL.', 'Governance Scanner');
  }

  // Step 2: AI-powered deep analysis (if Claude key available)
  if (ai.hasApiKey()) {
    addTyping();
    await sleep(400);
    removeTyping();

    try {
      await ensurePageContext();
      const ctx = getPageContext();
      if (ctx.pageHTML) {
        const streamEl = addStreamMessage('AI Governance Agent');
        await ai.streamChat(
          [{ role: 'user', content: `Analyze this AEM page for governance compliance. Check brand, legal, accessibility (WCAG 2.1 AA), and SEO. Be specific — reference actual elements. Return a structured report with scores and actionable fixes.\n\nPage URL: ${ctx.pageUrl}\n\nPage HTML:\n\`\`\`html\n${ctx.pageHTML.slice(0, 15000)}\n\`\`\`` }],
          ctx,
          (chunk, full) => { streamEl.innerHTML = md(full); scrollChat(); },
        );
      } else {
        addMessage('assistant', 'No page content available for AI analysis.', 'AI Governance Agent');
      }
    } catch (err) {
      addMessage('assistant', `AI analysis error: ${err.message}`, 'AI Governance Agent');
    }
  }

  if (scanResult) {
    const fixable = Object.values(scanResult.results)
      .flatMap((cat) => cat.issues)
      .filter((i) => i.fixable);

    if (fixable.length > 0) {
      addRawHTML(`
        <div class="agent-badge">Governance Agent</div>
        <div class="message-content">
          <strong>${fixable.length} issues can be auto-fixed</strong>
          <div class="money-line">
            Real scan completed. ${scanResult.total.pass} checks passed, ${scanResult.total.fail} failed, ${scanResult.total.warn} warnings.
          </div>
        </div>
      `);
    }

  }
}

/* ── REAL: Upload Brief (Differentiator #3) ── */
/* No native agent does: brief PDF in → structured page → governance gate → Workfront task */

async function runRealBrief() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.pdf,.txt,.doc,.docx';

  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const profile = getActiveProfile() || {};
    addMessage('user', escapeHtml(`Upload ${file.name} and create landing page`));
    addRawHTML(`
      <div class="upload-indicator">
        <span class="file-icon">📄</span>
        <div>
          <div style="font-weight:500">${escapeHtml(file.name)}</div>
          <div style="font-size:10px;color:var(--text-muted)">${(file.size / 1024 / 1024).toFixed(1)} MB — uploaded</div>
        </div>
      </div>
    `);

    // Step 1: Extract text from file (Acrobat MCP)
    const step1 = addOrchestrationStep('Acrobat MCP', 'Extracting brief content', 'active');
    let briefText = '';
    try {
      if (file.type === 'application/pdf') {
        briefText = await extractPdfText(file);
      } else {
        briefText = await file.text();
      }

      if (!briefText.trim()) {
        updateOrchestrationStep(step1, 'error');
        addMessage('assistant', '⚠ Could not extract text from file. Please try a .txt or .pdf file.', 'Acrobat MCP');
        return;
      }

      updateOrchestrationStep(step1, 'done');
      addMessage('assistant', md(
        `**Extracted ${briefText.split(/\s+/).length} words from brief**\n\n`
        + `Preview: "${briefText.slice(0, 200)}..."`,
      ), 'Acrobat MCP');
    } catch (err) {
      updateOrchestrationStep(step1, 'error');
      addMessage('assistant', `⚠ File extraction error: ${err.message}`, 'Acrobat MCP');
      return;
    }

    if (!ai.hasApiKey()) {
      addMessage('assistant', 'Configure your Claude API key in settings to continue.', 'Brief Analysis Agent');
      return;
    }

    // Step 2: Analyze brief with customer-specific context
    const step2 = addOrchestrationStep('Brief Analysis', 'Analyzing with brand context', 'active');
    const streamEl2 = addStreamMessage('Brief Analysis Agent');
    let analysis = '';
    try {
      analysis = await ai.streamChat(
        [{ role: 'user', content: `Analyze this campaign brief for ${profile.name} (${profile.vertical}).

Brief content:
${briefText}

Map requirements to:
- Customer segments: ${profile.segments?.map((s) => s.name).join(', ')}
- Brand voice: ${profile.brandVoice?.tone}
- AEM EDS blocks (hero, cards, columns, tabs, etc.)
- Governance checkpoints per approval chain

Return a structured, actionable analysis.` }],
        getPageContext(),
        (chunk, full) => { streamEl2.innerHTML = md(full); scrollChat(); },
      );
      updateOrchestrationStep(step2, 'done');
    } catch (err) {
      streamEl2.innerHTML = `Error: ${escapeHtml(err.message)}`;
      updateOrchestrationStep(step2, 'error');
      return;
    }

    await sleep(400);

    // Step 3: Generate page content
    const step3 = addOrchestrationStep('Experience Production', 'Generating page content', 'active');
    const streamEl3 = addStreamMessage('Experience Production');
    let pageContent = '';
    try {
      pageContent = await ai.streamChat(
        [{ role: 'user', content: `Generate an AEM Edge Delivery Services page based on this brief analysis for ${profile.name}:

${analysis.slice(0, 4000)}

Requirements:
1. Complete HTML content with real copy (not placeholder) in ${profile.name}'s brand voice
2. Use EDS block patterns: hero, cards, columns, tabs, accordion
3. Include metadata block with SEO-optimized title, description, OG tags
4. Image placements with alt text following DAM naming: ${profile.damTaxonomy?.namingConvention || 'descriptive kebab-case'}
5. Section metadata for styling

Generate ready-to-author content.` }],
        getPageContext(),
        (chunk, full) => { streamEl3.innerHTML = md(full); scrollChat(); },
      );
      updateOrchestrationStep(step3, 'done');
    } catch (err) {
      streamEl3.innerHTML = `Error: ${escapeHtml(err.message)}`;
      updateOrchestrationStep(step3, 'error');
      return;
    }

    await sleep(400);

    // Step 4: Governance Gate (Differentiator #3 — the gate before publish)
    const step4 = addOrchestrationStep('Governance Gate', 'Brand & legal compliance', 'active');
    const streamEl4 = addStreamMessage('Governance Agent');
    try {
      await ai.streamChat(
        [{ role: 'user', content: `GOVERNANCE GATE — Review generated content before publishing for ${profile.name}:

${pageContent.slice(0, 3000)}

Check against:
${profile.legalSLA?.specialRules?.map((r) => `- ${r}`).join('\n') || '- Standard brand and legal compliance'}

Brand voice rules: ${profile.brandVoice?.tone}
Avoided words: ${profile.brandVoice?.avoided?.join(', ') || 'none specified'}

Provide:
1. PASS/FAIL/WARN for: Brand Voice, Legal Compliance, Accessibility, SEO
2. Specific violations with severity
3. Recommended approval routing:
${profile.approvalChain?.map((s, i) => `   ${i + 1}. ${s.role}${s.sla ? ` (SLA: ${s.sla})` : ''}`).join('\n') || '   Standard review'}
4. Estimated time to publish based on SLAs
5. Auto-fixable issues vs. manual review required` }],
        getPageContext(),
        (chunk, full) => { streamEl4.innerHTML = md(full); scrollChat(); },
      );
      updateOrchestrationStep(step4, 'done');
    } catch (err) {
      streamEl4.innerHTML = `Error: ${escapeHtml(err.message)}`;
      updateOrchestrationStep(step4, 'error');
      return;
    }

    await sleep(400);

    // Step 5: Workfront Task Creation
    const step5 = addOrchestrationStep('Workfront WOA', 'Creating review tasks', 'active');
    const streamEl5 = addStreamMessage('Workfront WOA');
    try {
      await ai.streamChat(
        [{ role: 'user', content: `Create Workfront tasks for publishing this ${profile.name} page:

Approval chain:
${profile.approvalChain?.map((s, i) => `${i + 1}. ${s.role}: ${s.action}${s.sla ? ` (SLA: ${s.sla})` : ''}`).join('\n') || 'Standard approval'}

Generate a task table with: Task Name, Assignee (Role), Due Date, Dependencies, Status.
Include the governance findings from the previous step.
End with estimated time to publish.` }],
        getPageContext(),
        (chunk, full) => { streamEl5.innerHTML = md(full); scrollChat(); },
      );
      updateOrchestrationStep(step5, 'done');
    } catch (err) {
      streamEl5.innerHTML = `Error: ${escapeHtml(err.message)}`;
      updateOrchestrationStep(step5, 'error');
      return;
    }

    // Create in DA if authenticated
    if (isSignedIn()) {
      try {
        const pageName = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g, '-');
        await da.createPage(`/${pageName}.html`, pageContent);
        await da.previewPage(`/${pageName}`);
        const previewUrl = da.getPreviewUrl(`/${pageName}`);
        addRawHTML(`
          <div class="agent-badge">Experience Production</div>
          <div class="message-content">
            <strong>✓ Page created and routed for review</strong><br><br>
            Path: <code>/${pageName}</code><br>
            Preview: <a href="${previewUrl}" target="_blank">${previewUrl}</a>
          </div>
        `);
        previewFrame.src = previewUrl;
      } catch (err) {
        addMessage('assistant', `Page content generated but DA save failed: ${err.message}`, 'Experience Production');
      }
    }

    addRawHTML(`
      <div class="agent-badge">Pipeline Complete</div>
      <div class="message-content">
        <div class="money-line">
          <strong>Brief → analyzed → page generated → governance checked → tasks created.</strong><br>
          5 steps, 1 conversation. No native agent does this end-to-end today. This is Differentiator #3.
        </div>
      </div>
    `);
  };

  fileInput.click();
}

async function extractPdfText(file) {
  // Try PDF.js if available, fall back to regex extraction
  if (window.pdfjsLib) {
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => item.str).join(' '));
      }
      return pages.join('\n\n');
    } catch { /* fall through to regex */ }
  }

  // Regex fallback for basic PDFs
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const readable = text.replace(/[\x00-\x1f\x80-\xff]/g, ' ').replace(/\s+/g, ' ').trim();
  const matches = readable.match(/\(([^)]+)\)/g);
  if (matches) {
    return matches
      .map((m) => m.slice(1, -1))
      .filter((t) => t.length > 2 && /[a-zA-Z]/.test(t))
      .join(' ');
  }
  return readable.slice(0, 5000);
}

/* ── (Demo flows removed — all flows are real AI now) ── */

/* ── Workfront WOA Flows — Real AI ── */
async function runWorkfrontPanel() {
  addMessage('user', 'Show Workfront project status and WOA agent capabilities');
  await handleRealChat(`Show the current Workfront WOA (Workflow Optimization Agent) status for the AEM XSC Showcase project. Include:

1. **Connected WOA Agents** — list the four P1 skills with their current status:
   - AI Reviewer (brand guideline compliance for assets) — Open Beta, GA Q1 FY26
   - AI Form Fill (AI-powered form completion) — Open Beta, GA 12/3/25
   - Project Health (AI project/program performance assessment) — Open Beta, GA TBD
   - Intelligent Answers (NL questions across Workfront ecosystem) — GA Planned, 12/3/25

2. **Project Health Assessment** — provide an AI-driven assessment of the AEM XSC Showcase Launch project covering schedule, risks, blockers, and team capacity.

3. **Actionable Recommendations** — what should the team focus on next?

Format with tables and structured data. Use ✓/⚠/❌ indicators for status.`);
}

async function runAIReviewer() {
  addMessage('user', 'Run Workfront AI Reviewer — brand compliance check');
  await handleRealChat(`As the Workfront AI Reviewer agent, perform a brand compliance review on the current page assets. Check:
- Logo placement and usage
- Color palette adherence to brand guidelines
- Typography (Adobe Clean font usage)
- Image quality and resolution
- Tone of voice alignment

Provide a brand compliance score and specific findings with pass/warn/fail status for each check.`);
}

async function runWorkfrontQuery(question) {
  addMessage('user', question);
  await handleRealChat(`As the Workfront Intelligent Answers agent, answer this question about the Workfront ecosystem: "${question}"

Provide a detailed answer referencing projects, tasks, approvals, timesheets, and team capacity as relevant. Format with markdown tables and structured data where appropriate.`);
}

/* ── Cross-Product Orchestration (Differentiator #2) ── */
/* No native agent does: Acrobat → Discovery → AEM Content → CJA → Workfront in one conversation */

async function runOrchestration() {
  const profile = getActiveProfile() || {};
  addMessage('user', 'Run full cross-product orchestration');

  // Step 1: Brief Analysis (Acrobat MCP)
  const step1 = addOrchestrationStep('Acrobat MCP', 'Analyzing uploaded brief', 'active');
  await sleep(300);

  const briefPrompt = `You are orchestrating a cross-product workflow for ${profile.name}. This is the kind of agent chaining that doesn't exist natively — Discovery Agent, Data Insights Agent, Content Agent, and Workfront Agent are siloed by product. You're combining them in one thread.

Step 1 — BRIEF ANALYSIS (Acrobat MCP):
Simulate analyzing a campaign brief PDF. Generate a realistic brief analysis for ${profile.name} (${profile.vertical} vertical) that includes:
- Campaign objective
- Target audience (use these REAL customer segments: ${profile.segments?.map((s) => s.name).join(', ')})
- Key messages aligned with brand voice: "${profile.brandVoice?.tone}"
- Required content sections mapped to AEM EDS blocks
- Brand compliance checkpoints per the customer's rules

Make this feel like a real brief analysis — specific, actionable, ready for content generation.`;

  const streamEl1 = addStreamMessage('Acrobat MCP');
  let briefAnalysis = '';
  try {
    briefAnalysis = await ai.streamChat(
      [{ role: 'user', content: briefPrompt }],
      getPageContext(),
      (chunk, full) => { streamEl1.innerHTML = md(full); scrollChat(); },
    );
    updateOrchestrationStep(step1, 'done');
  } catch (err) {
    streamEl1.innerHTML = `Error: ${escapeHtml(err.message)}`;
    updateOrchestrationStep(step1, 'error');
    return;
  }

  await sleep(500);

  // Step 2: Content Generation (AEM Content MCP)
  const step2 = addOrchestrationStep('AEM Content MCP', 'Generating page from brief', 'active');
  const contentPrompt = `Step 2 — CONTENT GENERATION (AEM Content MCP):
Based on this brief analysis, generate a complete AEM Edge Delivery Services page structure:

${briefAnalysis.slice(0, 3000)}

Generate:
1. Complete section-by-section content with real copy (not lorem ipsum) aligned to ${profile.name}'s brand voice
2. Block structure using EDS patterns (hero, cards, columns, tabs, etc.)
3. Metadata with SEO title, description, OG tags
4. Image placements with descriptive alt text following DAM taxonomy: ${profile.damTaxonomy?.namingConvention || 'standard'}

This page would be created via AEM Content MCP in a real deployment.`;

  const streamEl2 = addStreamMessage('AEM Content MCP');
  let pageContent = '';
  try {
    pageContent = await ai.streamChat(
      [{ role: 'user', content: contentPrompt }],
      getPageContext(),
      (chunk, full) => { streamEl2.innerHTML = md(full); scrollChat(); },
    );
    updateOrchestrationStep(step2, 'done');
  } catch (err) {
    streamEl2.innerHTML = `Error: ${escapeHtml(err.message)}`;
    updateOrchestrationStep(step2, 'error');
    return;
  }

  await sleep(500);

  // Step 3: Governance Gate
  const step3 = addOrchestrationStep('Governance Agent', 'Running compliance checks', 'active');
  const govPrompt = `Step 3 — GOVERNANCE GATE:
Review this generated content for ${profile.name} compliance:

${pageContent.slice(0, 3000)}

Check against the customer's specific rules:
${profile.legalSLA?.specialRules?.map((r) => `- ${r}`).join('\n') || '- Standard brand and legal compliance'}

Approval chain for this content:
${profile.approvalChain?.map((s, i) => `${i + 1}. ${s.role}: ${s.action}${s.sla ? ` (SLA: ${s.sla})` : ''}`).join('\n') || 'Standard approval flow'}

Provide:
1. Brand compliance score (0-100%)
2. Legal compliance assessment with specific rule violations if any
3. A11y pre-check
4. Approval routing recommendation — who needs to review this and in what order
5. Estimated time to approval based on SLAs`;

  const streamEl3 = addStreamMessage('Governance Agent');
  try {
    await ai.streamChat(
      [{ role: 'user', content: govPrompt }],
      getPageContext(),
      (chunk, full) => { streamEl3.innerHTML = md(full); scrollChat(); },
    );
    updateOrchestrationStep(step3, 'done');
  } catch (err) {
    streamEl3.innerHTML = `Error: ${escapeHtml(err.message)}`;
    updateOrchestrationStep(step3, 'error');
    return;
  }

  await sleep(500);

  // Step 4: Analytics / CJA Insight
  const step4 = addOrchestrationStep('CJA Data Insights', 'Forecasting performance', 'active');
  const cjaPrompt = `Step 4 — CJA DATA INSIGHTS AGENT:
Based on the content we just generated for ${profile.name}, provide performance forecasting:

Target segments: ${profile.segments?.map((s) => s.name).join(', ')}

Provide:
1. Expected engagement metrics by segment (page views, time on page, scroll depth, CTA clicks)
2. Conversion rate predictions based on similar content in ${profile.vertical}
3. Personalization recommendations — which sections to A/B test, which segments see what variant
4. Revenue impact estimate

Reference CJA data views and AA report suites where applicable.`;

  const streamEl4 = addStreamMessage('CJA Data Insights');
  try {
    await ai.streamChat(
      [{ role: 'user', content: cjaPrompt }],
      getPageContext(),
      (chunk, full) => { streamEl4.innerHTML = md(full); scrollChat(); },
    );
    updateOrchestrationStep(step4, 'done');
  } catch (err) {
    streamEl4.innerHTML = `Error: ${escapeHtml(err.message)}`;
    updateOrchestrationStep(step4, 'error');
    return;
  }

  await sleep(500);

  // Step 5: Workfront Task
  const step5 = addOrchestrationStep('Workfront WOA', 'Creating tasks & routing', 'active');
  const wfPrompt = `Step 5 — WORKFRONT WOA (Workflow Optimization Agent):
Create a Workfront project plan for publishing this content for ${profile.name}:

Approval chain:
${profile.approvalChain?.map((s, i) => `${i + 1}. ${s.role}: ${s.action}${s.sla ? ` (SLA: ${s.sla})` : ''}`).join('\n') || 'Standard approval flow'}

Generate:
1. Workfront tasks for each approval step with due dates based on SLAs
2. Task assignments by role
3. Dependencies (what blocks what)
4. Project timeline — expected time from now to publish
5. Risk flags — any steps that could delay publication

Format as a clear project plan with task table. This is the Workfront integration that closes the loop — brief in, page generated, governance checked, tasks created, all in one conversation.

End with: "Full orchestration complete. 5 agents, 1 thread, 0 product boundaries."`;

  const streamEl5 = addStreamMessage('Workfront WOA');
  try {
    await ai.streamChat(
      [{ role: 'user', content: wfPrompt }],
      getPageContext(),
      (chunk, full) => { streamEl5.innerHTML = md(full); scrollChat(); },
    );
    updateOrchestrationStep(step5, 'done');
  } catch (err) {
    streamEl5.innerHTML = `Error: ${escapeHtml(err.message)}`;
    updateOrchestrationStep(step5, 'error');
    return;
  }

  // Final summary
  addRawHTML(`
    <div class="agent-badge">Orchestration Complete</div>
    <div class="message-content">
      <div class="money-line">
        <strong>5 agents. 1 thread. 0 product boundaries.</strong><br>
        Acrobat → AEM Content → Governance → CJA → Workfront — chained in a single conversation.
        No native Adobe agent can do this today. This is Differentiator #2.
      </div>
    </div>
  `);
}

function addOrchestrationStep(agent, label, state) {
  const el = document.createElement('div');
  el.classList.add('orchestration-step');
  el.innerHTML = `
    <div class="step-indicator ${state}"></div>
    <div class="step-agent">${agent}</div>
    <div class="step-label">${label}</div>
  `;
  chatMessages.appendChild(el);
  scrollChat();
  return el;
}

function updateOrchestrationStep(el, state) {
  const indicator = el.querySelector('.step-indicator');
  indicator.className = `step-indicator ${state}`;
}

/* ── MCP Services Status ── */
async function runServicesPanel() {
  addMessage('user', 'Show connected MCP services and entitlements');

  const profile = getActiveProfile() || {};
  const caps = profile.mcpCapabilities || AEM_ORG.mcpCapabilities;
  let html = '<strong>Adobe MCP Service Matrix</strong>';
  html += '<table class="gov-results" style="margin-top:10px"><tr><th>Capability</th><th>MCP Server</th><th>Status</th></tr>';
  caps.forEach((c) => {
    const statusIcon = c.ready
      ? '<span style="color:var(--green)">&#9679; Live</span>'
      : `<span style="color:var(--yellow)">&#9679; ${c.needs}</span>`;
    html += `<tr><td>${c.capability}</td><td><code>${c.mcp}</code></td><td>${statusIcon}</td></tr>`;
  });
  html += '</table>';

  const liveCount = caps.filter((c) => c.ready).length;
  const totalCount = caps.length;
  html += `<div style="margin-top:10px;font-size:11px;color:var(--text-muted)">${liveCount} of ${totalCount} capabilities live · ${totalCount - liveCount} need configuration</div>`;

  addRawHTML(`<div class="agent-badge">MCP Services</div><div class="message-content">${html}</div>`);

  addTyping();
  await sleep(400);
  removeTyping();

  // Show entitlements (connector inventory is in Settings)
  const ents = profile.entitlements || AEM_ORG.entitlements;
  let entHTML = '<strong>Mapped Entitlements</strong>';
  entHTML += '<div class="issue-list" style="margin-top:8px">';
  const liveEnts = Object.values(ents).filter((e) => e.status === 'live');
  const pendingEnts = Object.values(ents).filter((e) => e.status !== 'live');
  liveEnts.forEach((e) => {
    entHTML += `<div class="issue-item fixable">✓ <strong>${e.name}</strong> — ${e.mcp} · ${e.note}</div>`;
  });
  pendingEnts.forEach((e) => {
    entHTML += `<div class="issue-item">⚡ <strong>${e.name}</strong> — ${e.mcp} · ${e.note}</div>`;
  });
  entHTML += '</div>';
  entHTML += `<div class="money-line">${liveEnts.length} of ${Object.values(ents).length} services live.</div>`;

  addRawHTML(`<div class="agent-badge">Entitlements</div><div class="message-content">${entHTML}</div>`);
}

/* ── Block Library ── */
const BLOCK_CATALOG = [
  { name: 'Hero', variants: '—', cols: '1 col, 3 rows', use: 'Page banner with background image, headline, CTA' },
  { name: 'Cards', variants: '(no images)', cols: '2 col or 1 col', use: 'Feature grids, article lists, product cards' },
  { name: 'Columns', variants: '—', cols: 'N columns', use: 'Side-by-side content layouts' },
  { name: 'Tabs', variants: '—', cols: '2 col', use: 'Tabbed content sections' },
  { name: 'Accordion', variants: '—', cols: '2 col', use: 'FAQs, collapsible content' },
  { name: 'Carousel', variants: '—', cols: '2 col', use: 'Rotating slides with image + text' },
  { name: 'Table', variants: 'striped, bordered, no header', cols: 'N col', use: 'Data tables, comparison grids' },
  { name: 'Video', variants: '—', cols: '1 col', use: 'Standalone embedded video' },
  { name: 'Embed', variants: 'video, social', cols: '1 col', use: 'YouTube, Vimeo, Twitter embeds' },
  { name: 'Search', variants: '—', cols: '1 col', use: 'Site search with query index' },
];

async function runBlockLibrary() {
  addMessage('user', 'Show available EDS block library');

  let html = '<strong>AEM EDS Block Library</strong>';
  html += '<div style="font-size:11px;color:var(--text-muted);margin:4px 0 8px">Source: sta-xwalk-boilerplate (same as AEMCoder)</div>';
  html += '<table class="gov-results" style="margin-top:6px"><tr><th>Block</th><th>Variants</th><th>Structure</th><th>Use Case</th></tr>';
  BLOCK_CATALOG.forEach((b) => {
    html += `<tr><td><strong>${b.name}</strong></td><td><code>${b.variants}</code></td><td>${b.cols}</td><td>${b.use}</td></tr>`;
  });
  html += '</table>';
  html += '<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">10 standard blocks + system blocks (Header, Footer, Metadata, Section Metadata, Fragment)</div>';

  addRawHTML(`<div class="agent-badge">Block Library</div><div class="message-content">${html}</div>`);

  addTyping(); await sleep(500); removeTyping();

  // Show local project blocks
  const localBlocks = ['cards', 'carousel', 'columns', 'cta', 'demo-cards', 'footer', 'fragment', 'header', 'hero', 'revenue-motions', 'steps', 'team', 'ticker', 'verticals'];
  let localHTML = '<strong>Project Blocks (this repo)</strong>';
  localHTML += '<div class="issue-list" style="margin-top:8px">';
  localBlocks.forEach((b) => {
    const isStandard = BLOCK_CATALOG.some((c) => c.name.toLowerCase() === b);
    const icon = isStandard ? '✓' : '★';
    const label = isStandard ? 'standard' : 'custom';
    localHTML += `<div class="issue-item ${isStandard ? 'fixable' : ''}">${icon} <strong>${b}</strong> <span style="color:var(--text-muted)">${label}</span></div>`;
  });
  localHTML += '</div>';
  localHTML += `<div class="money-line">${localBlocks.length} blocks deployed · ${localBlocks.filter((b) => !BLOCK_CATALOG.some((c) => c.name.toLowerCase() === b)).length} custom blocks</div>`;

  addRawHTML(`<div class="agent-badge">Block Inventory</div><div class="message-content">${localHTML}</div>`);
}

/* ── Performance & Personalize — real AI ── */
async function runPerformanceFlow() {
  addMessage('user', 'Analyze performance of the current page');
  await handleRealChat('Analyze the performance of this page. Check for EDS three-phase loading compliance, image optimization, CLS/LCP issues, and provide specific recommendations. Reference any analytics data available via MCP.');
}

async function runPersonalizeFlow() {
  addMessage('user', 'Suggest personalization for this page');
  await handleRealChat('Analyze this page and suggest personalization strategies. Identify content sections that could be personalized, recommend audience segments, and estimate potential impact. Reference AEP and Target MCP capabilities.');
}

/* ══════════════════════════════════════════════════════════════
   VIEW SWITCHING (Home ↔ Editor)
   ══════════════════════════════════════════════════════════════ */

function switchView(view) {
  currentView = view;
  if (view === 'home') {
    viewHome.style.display = '';
    viewEditor.style.display = 'none';
    if (editorToolbar) editorToolbar.style.display = 'none';
  } else {
    viewHome.style.display = 'none';
    viewEditor.style.display = '';
    if (editorToolbar) editorToolbar.style.display = '';
  }
  // Update sidebar active state
  document.querySelectorAll('.sidebar-btn[data-panel]').forEach((b) => {
    b.classList.toggle('active', b.dataset.panel === (view === 'home' ? 'home' : 'content'));
  });
}

/* ── Layout Toggle (chat-only | chat-preview | full) ── */
function setLayout(layout) {
  if (!panels) return;
  panels.dataset.layout = layout;
  panels.style.gridTemplateColumns = ''; // Reset drag override
  document.querySelectorAll('.layout-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.layout === layout);
  });
}

/* ══════════════════════════════════════════════════════════════
   RESOURCES PANEL — Load site pages from query-index.json
   ══════════════════════════════════════════════════════════════ */

async function loadResources() {
  if (!resourcesTree) return;
  resourcesTree.innerHTML = '<div class="resources-loading">Loading pages...</div>';
  sitePages = [];

  const origin = AEM_ORG.previewOrigin;
  // Try query-index.json first
  try {
    const resp = await fetch(`${origin}/query-index.json`);
    if (resp.ok) {
      const data = await resp.json();
      const entries = data.data || data;
      if (Array.isArray(entries) && entries.length > 0) {
        sitePages = entries.map((e) => ({
          path: e.path,
          title: e.title || e.path.split('/').pop() || 'index',
          description: e.description || '',
          lastModified: e.lastModified || '',
          image: e.image || '',
        }));
      }
    }
  } catch { /* ignore */ }

  // Fallback: try sitemap
  if (sitePages.length === 0) {
    try {
      const resp = await fetch(`${origin}/sitemap.xml`);
      if (resp.ok) {
        const text = await resp.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        const locs = xml.querySelectorAll('url > loc');
        locs.forEach((loc) => {
          const url = loc.textContent;
          const path = new URL(url).pathname;
          sitePages.push({
            path,
            title: path.split('/').filter(Boolean).pop() || 'index',
            description: '',
          });
        });
      }
    } catch { /* ignore */ }
  }

  // Fallback: GitHub API tree (works for private repos with PAT)
  if (sitePages.length === 0 && hasGitHubToken()) {
    try {
      const org = AEM_ORG.orgId;
      const repo = AEM_ORG.repo;
      const branch = AEM_ORG.branch || 'main';
      const tree = await getRepoTree(org, repo, branch);
      const htmlFiles = tree.filter((f) => f.type === 'blob' && f.path.endsWith('.html'));
      sitePages = htmlFiles.map((f) => {
        const pagePath = '/' + f.path.replace(/\.html$/, '').replace(/\/index$/, '/');
        return {
          path: pagePath === '/index' ? '/' : pagePath,
          title: f.path.split('/').pop().replace('.html', '') || 'index',
          description: '',
        };
      });
    } catch { /* ignore */ }
  }

  // Fallback: at least show the homepage
  if (sitePages.length === 0) {
    sitePages = [{ path: '/', title: 'index', description: 'Homepage' }];
  }

  detectLocales();
  renderResources();
}

function renderResources() {
  if (!resourcesTree) return;
  if (sitePages.length === 0) {
    resourcesTree.innerHTML = '<div class="resources-empty">No pages found</div>';
    return;
  }

  // Filter by active locale if set
  const filteredPages = activeLocale
    ? sitePages.filter((p) => {
      const match = p.path.match(LOCALE_PATTERN);
      return match && match[1].toLowerCase().replace('_', '-') === activeLocale;
    })
    : sitePages;

  if (filteredPages.length === 0) {
    resourcesTree.innerHTML = '<div class="resources-empty">No pages for this locale</div>';
    return;
  }

  resourcesTree.innerHTML = '';
  filteredPages.forEach((page) => {
    const item = document.createElement('div');
    item.classList.add('resource-item');
    if (page.path === activeResourcePath) item.classList.add('active');
    item.dataset.path = page.path;

    const ext = page.path.endsWith('.json') ? 'json' : page.path.endsWith('.svg') ? 'svg' : 'page';
    const iconSvg = ext === 'page'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h5v5H7z"/></svg>';

    item.innerHTML = `
      <span class="resource-icon">${iconSvg}</span>
      <span class="resource-name">${escapeHtml(page.title)}</span>
      <span class="resource-status" data-path="${escapeHtml(page.path)}"></span>
    `;

    item.addEventListener('click', () => navigateToPage(page.path));
    resourcesTree.appendChild(item);
  });

  // Fetch status badges in background (no auth needed via admin.hlx.page)
  enrichResourceStatus();
}

/** Fetch preview/live status for each page via admin.hlx.page (no auth) */
async function enrichResourceStatus() {
  for (const page of sitePages) {
    try {
      const status = await da.getStatus(page.path);
      const badge = document.querySelector(`.resource-status[data-path="${page.path}"]`);
      if (!badge) continue;

      const previewOk = status.preview?.status === 200;
      const liveOk = status.live?.status === 200;

      if (liveOk) {
        badge.textContent = 'live';
        badge.className = 'resource-badge resource-badge-live';
      } else if (previewOk) {
        badge.textContent = 'preview';
        badge.className = 'resource-badge resource-badge-preview';
      }
    } catch { /* skip — status check is best-effort */ }
  }
}

/* ── Locale detection — scans page paths for language folders ── */

/** Common locale patterns: /en/, /fr-fr/, /us/en/, /content/site/en/, etc. */
const LOCALE_PATTERN = /^\/(?:content\/[^/]+\/)?([a-z]{2}(?:[_-][a-z]{2})?)(?:\/|$)/i;

/**
 * Scan sitePages for locale prefixes and populate the locale selector.
 * Called after loadResources() finishes.
 */
function detectLocales() {
  const localeCounts = new Map();

  for (const page of sitePages) {
    const match = page.path.match(LOCALE_PATTERN);
    if (match) {
      const loc = match[1].toLowerCase().replace('_', '-');
      localeCounts.set(loc, (localeCounts.get(loc) || 0) + 1);
    }
  }

  // Only treat as multi-locale if at least 2 locales with 2+ pages each
  const validLocales = [...localeCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  detectedLocales = validLocales.length >= 2 ? validLocales.map(([loc]) => loc) : [];

  if (!localeSelect) return;

  // Reset options
  localeSelect.innerHTML = '';
  const globalOpt = document.createElement('option');
  globalOpt.value = '';
  globalOpt.textContent = detectedLocales.length > 0 ? 'All Locales' : 'Global';
  localeSelect.appendChild(globalOpt);

  // Add detected locales
  for (const loc of detectedLocales) {
    const opt = document.createElement('option');
    opt.value = loc;
    // Format nicely: en-us → en-US, fr → FR
    const parts = loc.split('-');
    opt.textContent = parts.length > 1
      ? `${parts[0]}-${parts[1].toUpperCase()}`
      : loc.toUpperCase();
    localeSelect.appendChild(opt);
  }

  // Restore previous selection if still valid
  if (activeLocale && detectedLocales.includes(activeLocale)) {
    localeSelect.value = activeLocale;
  } else {
    activeLocale = '';
    localeSelect.value = '';
  }

  // Show/hide locale selector based on whether locales were detected
  const localeContainer = localeSelect.closest('.preview-locale');
  if (localeContainer) {
    localeContainer.style.display = detectedLocales.length > 0 ? 'flex' : 'none';
  }
}

/** Filter resources list by active locale and re-render */
function filterByLocale(locale) {
  activeLocale = locale;
  renderResources();
}

/* ── Breadcrumb — builds full clickable path ── */

function updateBreadcrumb(path) {
  if (!breadcrumbEl) return;

  breadcrumbEl.innerHTML = '';

  // Home link (always first)
  const homeSpan = document.createElement('span');
  homeSpan.className = 'breadcrumb-item';
  homeSpan.dataset.nav = 'home';
  homeSpan.textContent = 'Home';
  homeSpan.addEventListener('click', () => switchView('home'));
  breadcrumbEl.appendChild(homeSpan);

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    // Root path — show "Home > index"
    appendBreadcrumbSep();
    appendBreadcrumbLeaf('index');
    return;
  }

  // Build clickable segments for each folder level
  let accumulated = '';
  for (let i = 0; i < segments.length; i++) {
    appendBreadcrumbSep();
    accumulated += '/' + segments[i];
    const isLast = i === segments.length - 1;

    if (isLast) {
      // Last segment — page icon + bold name (not clickable)
      appendBreadcrumbLeaf(segments[i]);
    } else {
      // Intermediate folder — clickable
      const folderPath = accumulated + '/';
      const span = document.createElement('span');
      span.className = 'breadcrumb-item';
      span.textContent = segments[i];
      span.addEventListener('click', () => navigateToPage(folderPath));
      breadcrumbEl.appendChild(span);
    }
  }

  function appendBreadcrumbSep() {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.innerHTML = '&rsaquo;';
    breadcrumbEl.appendChild(sep);
  }

  function appendBreadcrumbLeaf(name) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'breadcrumb-icon');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.innerHTML = '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>';
    breadcrumbEl.appendChild(icon);

    const span = document.createElement('span');
    span.className = 'breadcrumb-page';
    span.textContent = name;
    breadcrumbEl.appendChild(span);
  }
}

/* ── Navigate preview iframe to a page ── */
function navigateToPage(path) {
  activeResourcePath = path;
  const url = AEM_ORG.previewOrigin + path;

  // Reset design mode on page navigation to avoid stale state
  if (designModeActive) {
    disableDesignMode();
    clearDesignSelection();
    currentPreviewView = 'preview';
    const tabs = document.getElementById('previewViewTabs');
    if (tabs) tabs.querySelectorAll('.preview-view-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.view === 'preview');
    });
  }

  if (previewFrame) previewFrame.src = url;
  if (previewUrlText) previewUrlText.textContent = url.replace(/^https?:\/\//, '');
  if (previewDot) previewDot.classList.add('connected');
  updateBreadcrumb(path);

  // Update active state in resources tree
  document.querySelectorAll('.resource-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === path);
  });

  // Pre-fetch page content in background so it's ready when the user chats.
  // Same pattern as EW: "Source: Live document from editor" — zero latency on first prompt.
  cachedPageHTML = null;
  cachedPageUrl = null;
  ensurePageContext().then(() => {
    if (cachedPageHTML) console.log(`[NAV] Page content pre-cached: ${path} (${cachedPageHTML.length} chars)`);
  }).catch(() => { /* non-blocking */ });
}
// Expose for ai.js tool handlers
window.__EW_NAV = navigateToPage;

/* ══════════════════════════════════════════════════════════════
   FILE TREE — GitHub API + admin.hlx.page (no auth required)
   ══════════════════════════════════════════════════════════════ */

let fileTreeLoaded = false;
let fileTreeData = null; // { dirs: Map, files: [] } built from GitHub tree
let activeResourceTab = 'pages'; // 'pages' | 'files'

/** SVG icons for the file tree */
const FT_ICONS = {
  chevron: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 18 15 12 9 6"/></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="8 13 10 15 8 17"/><line x1="14" y1="15" x2="16" y2="15"/></svg>',
  json: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2m4 0h2M10 17h4"/></svg>',
  js: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="8" y="18" font-size="7" fill="currentColor" stroke="none" font-weight="bold">JS</text></svg>',
  css: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13l2 2-2 2m4-1h2"/></svg>',
};

function getFileIcon(name, isDir) {
  if (isDir) return FT_ICONS.folder;
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'html') return FT_ICONS.html;
  if (ext === 'json') return FT_ICONS.json;
  if (ext === 'js' || ext === 'mjs') return FT_ICONS.js;
  if (ext === 'css') return FT_ICONS.css;
  return FT_ICONS.file;
}

/**
 * Build a nested tree structure from GitHub's flat tree API response.
 * Returns a Map of path → { name, children: Map, files: [] }
 */
function buildTreeFromGitHub(flatItems) {
  const root = { name: '/', children: new Map(), files: [] };

  // Filter: skip dot-directories at root level (except .sidekick)
  const skipRoots = new Set(['.agents', '.claude', '.github', '.husky', '.skills', '.migration']);

  for (const item of flatItems) {
    const parts = item.path.split('/');

    // Skip hidden root dirs
    if (skipRoots.has(parts[0])) continue;

    if (item.type === 'blob') {
      // It's a file — place it in the right directory
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!dir.children.has(parts[i])) {
          dir.children.set(parts[i], { name: parts[i], children: new Map(), files: [] });
        }
        dir = dir.children.get(parts[i]);
      }
      dir.files.push({ name: parts[parts.length - 1], path: item.path, size: item.size });
    } else if (item.type === 'tree') {
      // It's a directory — ensure it exists
      if (skipRoots.has(parts[0])) continue;
      let dir = root;
      for (const part of parts) {
        if (!dir.children.has(part)) {
          dir.children.set(part, { name: part, children: new Map(), files: [] });
        }
        dir = dir.children.get(part);
      }
    }
  }

  return root;
}

/** Render a tree node (recursive) */
function renderTreeNode(dirNode, depth, parentPath) {
  const fragment = document.createDocumentFragment();
  const paddingLeft = 10 + depth * 16;

  // Sort: directories first (alphabetical), then files (alphabetical)
  const sortedDirs = [...dirNode.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const sortedFiles = [...dirNode.files].sort((a, b) => a.name.localeCompare(b.name));

  // Render directories
  for (const [name, childDir] of sortedDirs) {
    const node = document.createElement('div');
    node.className = 'ft-node';

    const row = document.createElement('div');
    row.className = 'ft-item';
    row.style.paddingLeft = `${paddingLeft}px`;

    const chevron = document.createElement('span');
    chevron.className = 'ft-chevron';
    chevron.innerHTML = FT_ICONS.chevron;

    const icon = document.createElement('span');
    icon.className = 'ft-icon folder';
    icon.innerHTML = FT_ICONS.folder;

    const label = document.createElement('span');
    label.className = 'ft-name';
    label.textContent = name;

    row.append(chevron, icon, label);
    node.appendChild(row);

    const children = document.createElement('div');
    children.className = 'ft-children';
    // Pre-render children (all data is already loaded)
    const childPath = parentPath ? `${parentPath}/${name}` : name;
    children.appendChild(renderTreeNode(childDir, depth + 1, childPath));
    node.appendChild(children);

    row.addEventListener('click', () => {
      const isOpen = children.classList.contains('open');
      children.classList.toggle('open', !isOpen);
      chevron.classList.toggle('open', !isOpen);
    });

    fragment.appendChild(node);
  }

  // Render files
  for (const file of sortedFiles) {
    const filePath = parentPath ? `${parentPath}/${file.name}` : file.name;
    const node = document.createElement('div');
    node.className = 'ft-node';

    const row = document.createElement('div');
    row.className = 'ft-item';
    row.style.paddingLeft = `${paddingLeft}px`;

    const chevron = document.createElement('span');
    chevron.className = 'ft-chevron hidden';
    chevron.innerHTML = FT_ICONS.chevron;

    const icon = document.createElement('span');
    icon.className = 'ft-icon file';
    icon.innerHTML = getFileIcon(file.name, false);

    const label = document.createElement('span');
    label.className = 'ft-name';
    label.textContent = file.name;

    row.append(chevron, icon, label);
    node.appendChild(row);

    row.addEventListener('click', () => {
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'html') {
        // Navigate preview to this page
        const pagePath = '/' + filePath.replace(/\.html$/, '');
        navigateToPage(pagePath);
      } else if (ext === 'js' || ext === 'css' || ext === 'json') {
        // Open on GitHub for code files
        const ghUrl = `https://github.com/${AEM_ORG.orgId || da.getOrg()}/${AEM_ORG.repo || da.getRepo()}/blob/main/${filePath}`;
        window.open(ghUrl, '_blank');
      } else {
        // Open in DA for content files
        const daUrl = `https://da.live/edit#/${da.getOrg()}/${da.getRepo()}/${filePath}`;
        window.open(daUrl, '_blank');
      }
    });

    fragment.appendChild(node);
  }

  return fragment;
}

/**
 * Fetch the full repository tree from GitHub API (no auth needed for public repos).
 * Falls back to DA listing if GitHub fails.
 */
async function loadFileTree() {
  if (!fileTreeEl) return;
  fileTreeEl.innerHTML = '<div class="resources-loading">Loading files...</div>';

  // Determine GitHub org/repo — prefer profile config, fall back to DA config
  const ghOrg = AEM_ORG.orgId || da.getOrg();
  const ghRepo = AEM_ORG.repo || da.getRepo();

  try {
    const resp = await fetch(`https://api.github.com/repos/${ghOrg}/${ghRepo}/git/trees/main?recursive=1`);
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    const data = await resp.json();
    const items = data.tree || [];
    console.log(`[FileTree] GitHub tree: ${items.length} items from ${ghOrg}/${ghRepo}`);

    const root = buildTreeFromGitHub(items);
    fileTreeEl.innerHTML = '';
    fileTreeEl.appendChild(renderTreeNode(root, 0, ''));
    fileTreeLoaded = true;
    fileTreeData = root;
    return;
  } catch (err) {
    console.warn('[FileTree] GitHub API failed:', err.message);
  }

  // Fallback: try DA listing (needs auth)
  try {
    const items = await da.listPages('/');
    if (Array.isArray(items) && items.length > 0) {
      fileTreeEl.innerHTML = '';
      const sorted = items.sort((a, b) => {
        const aDir = !a.ext;
        const bDir = !b.ext;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '');
      });
      sorted.forEach((item) => {
        const isDir = !item.ext;
        const name = item.name || '?';
        const row = document.createElement('div');
        row.className = 'ft-item';
        row.style.paddingLeft = '10px';
        row.innerHTML = `
          <span class="ft-chevron${isDir ? '' : ' hidden'}">${FT_ICONS.chevron}</span>
          <span class="ft-icon ${isDir ? 'folder' : 'file'}">${getFileIcon(name, isDir)}</span>
          <span class="ft-name">${escapeHtml(name)}${item.ext ? `.${escapeHtml(item.ext)}` : ''}</span>
        `;
        fileTreeEl.appendChild(row);
      });
      fileTreeLoaded = true;
      return;
    }
  } catch { /* ignore */ }

  fileTreeEl.innerHTML = '<div class="resources-empty">Could not load file tree.</div>';
}

/** Switch between Pages and Files tabs */
function switchResourceTab(tab) {
  activeResourceTab = tab;
  document.querySelectorAll('.resources-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  if (tab === 'pages') {
    if (resourcesTree) resourcesTree.style.display = '';
    if (fileTreeEl) fileTreeEl.style.display = 'none';
  } else {
    if (resourcesTree) resourcesTree.style.display = 'none';
    if (fileTreeEl) fileTreeEl.style.display = '';
    if (!fileTreeLoaded) loadFileTree();
  }
}

// Wire up tab clicks
document.querySelectorAll('.resources-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchResourceTab(tab.dataset.tab));
});

/* ── Connect site: load preview + resources ── */
function connectSite() {
  const origin = AEM_ORG.previewOrigin;
  // Update home badge
  const badge = document.getElementById('homeSiteBadge');
  if (badge) badge.style.display = '';
  if (homeSiteName) homeSiteName.textContent = AEM_ORG.name;
  if (homeSiteUrl) {
    homeSiteUrl.textContent = origin.replace(/^https?:\/\//, '');
  }

  // Load preview iframe with homepage
  navigateToPage('/');

  // Load resources tree
  loadResources();

  // Reset file tree so it reloads with new site
  fileTreeLoaded = false;
  if (fileTreeEl) fileTreeEl.innerHTML = '<div class="resources-loading">Click Files tab to browse...</div>';
}

/* ── Recent Repos (localStorage persistence) ── */
const RECENT_REPOS_KEY = 'ew-recent-repos';
const MAX_RECENT_REPOS = 5;

function getRecentRepos() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_REPOS_KEY) || '[]');
  } catch { return []; }
}

function saveRecentRepo(org, repo, branch) {
  const recents = getRecentRepos().filter((r) => !(r.org === org && r.repo === repo));
  recents.unshift({ org, repo, branch, ts: Date.now() });
  localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(recents.slice(0, MAX_RECENT_REPOS)));
  renderRecentRepos();
}

function removeRecentRepo(org, repo) {
  const recents = getRecentRepos().filter((r) => !(r.org === org && r.repo === repo));
  localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(recents));
  renderRecentRepos();
}

function renderRecentRepos() {
  const container = document.getElementById('recentRepos');
  if (!container) return;
  const recents = getRecentRepos();
  if (recents.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = recents.map((r) => `<span class="recent-repo-chip" data-org="${escapeHtml(r.org)}" data-repo="${escapeHtml(r.repo)}" title="${escapeHtml(r.org)}/${escapeHtml(r.repo)} (${escapeHtml(r.branch)})"><span class="recent-repo-name">${escapeHtml(r.org)}/${escapeHtml(r.repo)}</span><button class="recent-repo-remove" data-org="${escapeHtml(r.org)}" data-repo="${escapeHtml(r.repo)}" title="Remove" aria-label="Remove ${escapeHtml(r.org)}/${escapeHtml(r.repo)}">&times;</button></span>`).join('');
  container.querySelectorAll('.recent-repo-name').forEach((name) => {
    name.addEventListener('click', () => {
      const chip = name.closest('.recent-repo-chip');
      const input = document.getElementById('connectSiteInput');
      if (input) input.value = `${chip.dataset.org}/${chip.dataset.repo}`;
      connectCustomSite(`${chip.dataset.org}/${chip.dataset.repo}`);
    });
  });
  container.querySelectorAll('.recent-repo-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentRepo(btn.dataset.org, btn.dataset.repo);
    });
  });
}

/* ── Connect Custom Site (AEMCoder-style org/repo input) ── */
let customSiteConnected = false;

/**
 * Parse any AEM-related URL or org/repo string into { org, repo, branch }.
 * Supported formats:
 *   org/repo                                          → { org, repo }
 *   https://github.com/org/repo                       → { org, repo }
 *   https://{branch}--{repo}--{org}.aem.page/...      → { org, repo, branch }
 *   https://{branch}--{repo}--{org}.aem.live/...      → { org, repo, branch }
 *   https://{branch}--{repo}--{org}.hlx.page/...      → { org, repo, branch } (legacy)
 *   https://{branch}--{repo}--{org}.hlx.live/...      → { org, repo, branch } (legacy)
 *   https://da.live/edit#/org/repo/...                 → { org, repo }
 *   https://da.admin.hlx.page/list/org/repo/...       → { org, repo }
 *   UE: https://experience.adobe.com/.../{branch}--{repo}--{org}.aem.page/... → { org, repo, branch }
 *
 * Returns { org, repo, branch?, error? }
 */
function parseConnectInput(input) {
  const trimmed = input.trim();

  // 1. EDS preview/live URLs: {branch}--{repo}--{org}.aem.page or .aem.live or .hlx.page or .hlx.live
  const edsMatch = trimmed.match(/(\w[\w-]*)--(\w[\w-]*)--(\w[\w-]*)\.(aem|hlx)\.(page|live)/);
  if (edsMatch) {
    return { branch: edsMatch[1], repo: edsMatch[2], org: edsMatch[3] };
  }

  // 2. DA editor URLs: https://da.live/edit#/org/repo/...
  const daEditMatch = trimmed.match(/da\.live\/edit#?\/?([^/]+)\/([^/]+)/);
  if (daEditMatch) {
    return { org: daEditMatch[1], repo: daEditMatch[2] };
  }

  // 3. DA admin URLs: https://da.admin.hlx.page/list/org/repo/...
  const daAdminMatch = trimmed.match(/da\.admin\.hlx\.page\/\w+\/([^/]+)\/([^/]+)/);
  if (daAdminMatch) {
    return { org: daAdminMatch[1], repo: daAdminMatch[2] };
  }

  // 3b. Malformed EDS URLs — has .aem.page/.aem.live but didn't match the branch--repo--org pattern
  if (/\.(aem|hlx)\.(page|live)/.test(trimmed)) {
    return { error: 'malformed-eds', message: 'Malformed EDS URL — expected format: https://main--repo--org.aem.page/' };
  }

  // 4. /content/ path = JCR/UE site — auto-resolve from known sites or known AEM instances
  //    Covers: author-p* URLs, UE editor URLs (both experience.adobe.com and author-hosted /ui#/), bare /content/ paths
  const contentMatch = trimmed.match(/\/content\/([^/]+)/);
  const authorHostMatch = trimmed.match(/(author-p\d+-e\d+)\.adobeaemcloud\.com/);
  if (contentMatch || authorHostMatch) {
    const siteName = contentMatch?.[1];
    const authorHost = authorHostMatch ? `${authorHostMatch[1]}.adobeaemcloud.com` : null;

    // Try known-sites registry first
    if (siteName) {
      const knownSite = resolveSite(siteName);
      if (knownSite) {
        return { org: knownSite.org, repo: knownSite.repo, branch: knownSite.branch, aemHost: authorHost, jcr: !!authorHost };
      }
    }

    // XSC Showcase instance (author-p153659-e1614585) — we have S2S access to all sites
    if (authorHost?.startsWith('author-p153659-e1614585')) {
      if (siteName) {
        // Best-guess EDS mapping: site name = repo, try common orgs
        return { org: 'aem-showcase', repo: siteName, branch: 'main', aemHost: authorHost, jcr: true };
      }
      return { error: 'jcr', message: 'AEM Showcase instance detected — add /content/{sitename}/ to the URL so Compass can identify the site.' };
    }

    // Unknown author instance
    return { error: 'jcr', message: 'JCR/UE site — not recognized. Paste the .aem.page delivery URL or enter org/repo.' };
  }

  // 5. GitHub URLs: https://github.com/org/repo
  const ghMatch = trimmed.match(/github\.com\/([^/]+)\/([^/?\s#]+)/);
  if (ghMatch) {
    return { org: ghMatch[1], repo: ghMatch[2].replace(/\.git$/, '') };
  }

  // 6. Plain org/repo (existing behavior)
  const parts = trimmed.split('/');
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { org: parts[0], repo: parts[1] };
  }

  return { error: 'invalid', message: 'Enter org/repo or paste an .aem.page URL' };
}

// Validate org/repo/branch segments — only allow safe characters for URL construction
function isValidSegment(s) { return /^[\w][\w.-]*$/.test(s); }

async function connectCustomSite(input) {
  const statusEl = document.getElementById('connectSiteStatus');
  const btn = document.getElementById('connectSiteBtn');

  try {
  // Parse the input (URL or org/repo)
  const parsed = parseConnectInput(input);
  console.log('[EW] parseConnectInput result:', JSON.stringify(parsed));
  if (parsed.error) {
    if (statusEl) {
      statusEl.textContent = parsed.message;
      statusEl.className = 'connect-site-status error';
    }
    return;
  }

  const { org, repo } = parsed;

  // Validate segments to prevent URL corruption from special characters
  if (!isValidSegment(org) || !isValidSegment(repo) || (parsed.branch && !isValidSegment(parsed.branch))) {
    if (statusEl) {
      statusEl.textContent = 'Invalid org/repo name — check the URL and try again';
      statusEl.className = 'connect-site-status error';
    }
    return;
  }

  // Use branch from URL if provided, otherwise detect via GitHub API (fallback to 'main')
  let branch = parsed.branch || 'main';
  let repoMeta = null;
  if (!parsed.branch && hasGitHubToken()) {
    try {
      repoMeta = await getRepoInfo(org, repo);
      branch = repoMeta.defaultBranch || 'main';
    } catch { /* fallback to main */ }
  }

  const edsPreviewOrigin = `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.page`;

  // For JCR sites, the .aem.page URL may not resolve (xwalk sites use different delivery).
  // Use the author URL for preview, or fall back to EDS URL if it works.
  let previewOrigin = edsPreviewOrigin;
  if (parsed.jcr && parsed.aemHost) {
    // Probe the EDS URL — some xwalk sites DO have EDS delivery, most don't.
    // Use cors mode so we can check resp.ok (no-cors returns opaque = always "success").
    let edsWorks = false;
    try {
      const probe = await fetch(edsPreviewOrigin + '/', { mode: 'cors' });
      edsWorks = probe.ok;
    } catch { /* DNS failure, CORS block, etc. */ }

    if (!edsWorks) {
      // EDS preview doesn't exist — use author URL for JCR preview
      previewOrigin = `https://${parsed.aemHost}`;
      console.log(`[EW] JCR site: EDS preview unavailable, using author URL: ${previewOrigin}`);
    }
  }

  // Show loading state (if home view elements exist)
  if (statusEl) {
    statusEl.textContent = `Connecting to ${org}/${repo}...`;
    statusEl.className = 'connect-site-status loading';
  }
  if (btn) {
    btn.disabled = true;
    btn.classList.add('connecting');
    btn.innerHTML = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Connecting...';
  }

  // For non-JCR sites, validate the EDS preview URL
  if (!parsed.jcr) {
    try {
      await fetch(previewOrigin, { mode: 'no-cors' });
    } catch {
      try {
        await fetch(`${previewOrigin}/`, { mode: 'cors' });
      } catch { /* ignore — demo-friendly, always accept */ }
    }
  }

  // Update the org config dynamically (explicitly set daOrg/daRepo — spread destroys getters)
  AEM_ORG = {
    ...AEM_ORG,
    name: `${org}/${repo}`,
    orgId: org,
    repo,
    branch,
    previewOrigin,
    liveOrigin: `https://${branch}--${repo.toLowerCase()}--${org.toLowerCase()}.aem.live`,
    daOrg: org,
    daRepo: repo,
  };
  // For JCR author URLs, include the content path; for EDS, just root
  if (parsed.jcr && parsed.aemHost && previewOrigin.includes('adobeaemcloud.com')) {
    // Extract content path from original input (e.g. /content/wknd-universal/language-masters/en)
    const contentPathMatch = input.match(/(\/content\/[^\s?#]*)/);
    const contentPath = contentPathMatch ? contentPathMatch[1].replace(/\.html$/, '') : '';
    PREVIEW_URL = previewOrigin + (contentPath || '/');
  } else {
    PREVIEW_URL = previewOrigin + '/';
  }
  customSiteConnected = true;
  window.__EW_ORG = AEM_ORG;

  // If parsed from a JCR/author URL, set the AEM host immediately (skip fstab detection)
  if (parsed.aemHost) {
    window.__EW_AEM_HOST = `https://${parsed.aemHost}`;
    window.__EW_SITE_TYPE = 'aem-cs';
    console.log(`[EW] AEM CS site: ${parsed.aemHost} — site type set to aem-cs`);
  }

  // Reconfigure DA client (skip for known JCR sites — DA won't work)
  if (!parsed.jcr) {
    da.configure({ org, repo, branch });
    console.log(`[EW] DA client reconfigured: ${org}/${repo} (${branch}), da.getOrg()=${da.getOrg()}, da.getRepo()=${da.getRepo()}`);
  } else {
    console.log(`[EW] JCR site — DA client not configured. AEM Content MCP tools available via ${parsed.aemHost}`);
  }

  // Detect site type (DA vs AEM CS) via fstab.yaml — AWAIT so AI knows the type before first prompt
  // Skip if already set from author URL
  const detectedType = parsed.aemHost ? 'aem-cs' : await detectAndCacheSiteType(org, repo, branch);
  const typeLabel = detectedType === 'aem-cs' ? 'AEM CS (xwalk)' : detectedType === 'da' ? 'DA' : detectedType;
  console.log(`[EW] Site type: ${typeLabel}`);

  // Update UI (home view elements may not exist when switching from toolbar)
  if (statusEl) {
    statusEl.textContent = `Connected to ${org}/${repo} · ${typeLabel}`;
    statusEl.className = 'connect-site-status success';
  }
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('connecting');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Connected';
  }

  // Update home badge
  if (homeSiteName) homeSiteName.textContent = `${org}/${repo}`;
  if (homeSiteUrl) homeSiteUrl.textContent = previewOrigin.replace(/^https?:\/\//, '');

  // Switch to editor and load
  activeResourcePath = null;
  cachedPageHTML = null;
  cachedPageUrl = null;

  // Small delay for visual feedback, then switch to editor
  await sleep(600);

  switchView('editor');

  // For JCR sites where iframe can't load (X-Frame-Options), render via AEM Content MCP
  if (parsed.jcr && parsed.aemHost && previewOrigin.includes('adobeaemcloud.com')) {
    const contentPathMatch = input.match(/(\/content\/[^\s?#]*)/);
    const jcrPath = contentPathMatch ? contentPathMatch[1].replace(/\.html$/, '') : '/content';
    activeResourcePath = jcrPath;

    // Show placeholder while loading
    if (previewFrame) {
      previewFrame.srcdoc = `<!DOCTYPE html><html><body style="font-family:system-ui;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a1a">
        <div style="text-align:center"><p>Loading JCR content via AEM Content MCP...</p><p style="font-size:12px">${jcrPath}</p></div></body></html>`;
    }

    // Fetch page content from AEM Content MCP and render as srcdoc
    (async () => {
      try {
        if (!isSignedIn()) await signIn();
        const host = window.__EW_AEM_HOST;
        if (host) {
          const aemContentMod = await import('./aem-content-mcp-client.js');
          const result = await aemContentMod.getPage(host, jcrPath);
          const html = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          if (html && previewFrame) {
            previewFrame.srcdoc = `<!DOCTYPE html><html><head>
              <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
              <style>body{font-family:system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;color:#333;line-height:1.6}img{max-width:100%;height:auto}h1,h2,h3{color:#1a1a1a}</style>
            </head><body>${html}</body></html>`;
            cachedPageHTML = html;
            console.log('[EW] JCR preview rendered via AEM Content MCP:', jcrPath, html.length, 'chars');
          }
        }
      } catch (e) {
        console.warn('[EW] JCR preview fetch failed:', e.message);
        if (previewFrame) {
          previewFrame.srcdoc = `<!DOCTYPE html><html><body style="font-family:system-ui;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a1a">
            <div style="text-align:center"><p>JCR preview unavailable</p><p style="font-size:12px">Use the <strong>UE</strong> button in the toolbar to open Universal Editor</p><p style="font-size:11px;color:#555">${e.message}</p></div></body></html>`;
        }
      }
    })();
  } else {
    navigateToPage('/');
  }
  loadResources();

  // Populate branch select — real branches from GitHub API
  const branchSelect = document.getElementById('branchSelect');
  if (branchSelect) {
    branchSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = branch;
    defaultOpt.textContent = branch;
    branchSelect.appendChild(defaultOpt);
    if (hasGitHubToken()) {
      listBranches(org, repo).then((branches) => {
        branchSelect.innerHTML = '';
        branches.forEach((b) => {
          const opt = document.createElement('option');
          opt.value = b.name;
          opt.textContent = b.name;
          if (b.name === branch) opt.selected = true;
          branchSelect.appendChild(opt);
        });
      }).catch(() => { /* keep current option */ });
    }
  }

  // Save to recent repos
  saveRecentRepo(org, repo, branch);

  // Welcome message in chat — different for JCR vs DA
  if (parsed.jcr) {
    addMessage('assistant', md(`**Connected to ${org}/${repo}** (AEM CS)\nAuthor: ${parsed.aemHost}\nYou can now:\n- **Prompt to edit**: "Change the hero headline"\n- **Read pages**: "Show me the homepage content"\n- **Governance**: "Run a governance check on this site"\n- **Edit visually**: Use the UE button in the toolbar`));
  } else {
    addMessage('assistant', md(`**Connected to ${org}/${repo}**\nSite loaded in preview. Page tree populated from query-index.json. You can now:\n- **Prompt to edit**: "Change the hero headline on /coffee"\n- **Set up experiments**: "A/B test the hero on the homepage"\n- **Generate variations**: "Create 3 hero variations targeting millennials"\n- **Add forms**: "Add a contact form to /contact"\n- **Edit visually**: Use the DA or UE buttons in the toolbar`));
  }

  // Clear conversation for fresh start
  conversationHistory = [];

  // Save + restore project memory
  const mem = getProjectMemory();
  updateProjectMemory({
    lastConnected: new Date().toISOString(),
    org, repo, branch: branch || 'main',
    siteType: window.__EW_SITE_TYPE || 'unknown',
  });
  if (mem?.lastPrompts?.length) {
    console.log(`[Memory] Restored project memory for ${org}/${repo}:`, mem);
  }

  } catch (err) {
    console.error('[EW] connectCustomSite error:', err);
    if (statusEl) {
      statusEl.textContent = `Connection failed: ${err.message}`;
      statusEl.className = 'connect-site-status error';
    }
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('connecting');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg> Connect';
    }
  }
}

/* ── Preview (hidden iframe for page context) ── */
function loadPreview() {
  navigateToPage(activeResourcePath || '/');
}

/* ── Flow Router ── */
function runBrief() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  runRealBrief();
}

function runGovernance() {
  if (!ai.hasApiKey() && !isSignedIn()) { requireApiKey(); return; }
  runRealGovernance();
}

function requireApiKey() {
  addMessage('assistant', md('**API key required.** Open ⚙ Settings and enter your Claude API key to use this feature.'));
}

function runLLMO() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  const pageUrl = previewFrame?.src;
  const hasPage = pageUrl && pageUrl !== 'about:blank';
  if (hasPage) {
    const prompt = 'Check the AI citation readability of the currently loaded page. Use the check_citation_readability tool and give me the full report with score, grade, and recommendations.';
    addMessage('user', prompt);
    handleRealChat(prompt);
  } else {
    addMessage('assistant', md('**AI Visibility Check** — Enter any URL to see how visible it is to AI agents like ChatGPT, Perplexity, and Claude.\n\nPaste a customer site URL below and I\'ll analyze it. For example:\n- `https://www.example.com` — check a customer\'s current site\n- Or load an EDS page in the preview and click this button again to compare.'));
  }
}

/* ── PMM "Find Your Path" Quick Action Flows ── */
function runFindContent() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'Find content in my DAM');
  handleRealChat('I need to find content fast. Search my DAM for the most relevant assets — images, documents, and content fragments. Use the search_dam_assets and search_fragments tools. Show me what\'s available and help me find exactly what I need for my next campaign.');
}

function runImageVariants() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'Generate channel-ready image variants');
  handleRealChat('I need channel-ready image variants for my campaign. Use the Dynamic Media tools (transform_image, create_image_renditions) to generate optimized crops and renditions for web, social, and email channels. Show me what delivery URLs are available with my current DM + OpenAPI setup.');
}

function runFixPipeline() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'My pipeline needs help');
  handleRealChat('Check my AEM pipeline status. Use the get_pipeline_status tool to diagnose any issues — failed builds, slow deploys, or configuration problems. Give me a clear status report and actionable fixes.');
}

function runBrandCompliance() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  const pageUrl = previewFrame?.src;
  const hasPage = pageUrl && pageUrl !== 'about:blank';
  if (hasPage) {
    addMessage('user', 'Check this page for brand compliance');
    handleRealChat('Run a brand governance check on the currently loaded page. Use the run_governance_check tool to evaluate brand voice, visual identity, accessibility, and legal compliance. Flag any violations and tell me exactly what to fix.');
  } else {
    addMessage('assistant', md('**Brand Compliance** — Load a page in the preview first, or paste a URL below to check it against your brand policies.\n\nI\'ll use the governance MCP to scan for:\n- Brand voice consistency\n- Visual identity compliance\n- Accessibility standards\n- Legal and regulatory rules'));
  }
}

function runUpdateContent() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'Help me update content quickly');
  handleRealChat('I need to update content fast. Show me what pages I have, identify any stale or expiring content using audit_content and check_asset_expiry tools, then help me update them. Use create_content_variant if I need fresh copy variations for different audiences.');
}

/* ── PMM Use-Case Demo Flows (3 choreographed sequences) ── */
async function runDemoModernizeAI() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'Demo: Modernize for AI-native discovery');
  await handleRealChat(`Run a complete AI-native discovery modernization demo. Execute these steps in sequence:

1. First, check the AI citation readability of our site using check_citation_readability. Show the score.
2. Then audit our content freshness with audit_content — how much is stale?
3. Search our DAM for hero assets using search_dam_assets to show content availability.
4. Finally, generate a brief action plan: what to update for better AI visibility, which stale pages to refresh, and which assets to feature.

Present each step clearly with the tool results so the audience can see the full AI-native content lifecycle.`);
}

async function runDemoBrandCompliance() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'Demo: Automate brand compliance');
  await handleRealChat(`Run a complete automated brand compliance demo. Execute these steps in sequence:

1. First, run a governance check on the current page using run_governance_check. Show the scorecard.
2. Search for content fragments using search_fragments to show how content is managed centrally.
3. Check for expiring assets with check_asset_expiry — any DRM issues approaching?
4. Generate a compliance summary: what passed, what needs attention, and recommended next steps.

Present each tool result clearly so the audience sees the full brand governance pipeline in action.`);
}

async function runDemoSpeedProduction() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'Demo: Speed up content production');
  await handleRealChat(`Run a complete content production acceleration demo. Execute these steps in sequence:

1. Check pipeline health with get_pipeline_status — are we clear to publish?
2. Search for available assets using search_dam_assets with query "campaign hero" to show DAM richness.
3. Generate an image rendition using create_image_renditions for web and social channels.
4. Create a content variant using create_content_variant for a personalized audience segment.
5. Show the site optimization opportunities with get_site_opportunities — what quick wins are available?

Present each step with results so the audience sees the full production pipeline from asset to delivery.`);
}

/* ── Enterprise Workflow Demo: Doc → AI Edit → Governance → Workfront Approval ── */
async function runDemoEnterpriseWorkflow() {
  if (!ai.hasApiKey()) { requireApiKey(); return; }
  addMessage('user', 'Demo: Enterprise compliance workflow — document to approval');
  await handleRealChat(`Run a complete enterprise content compliance workflow demo. This is the T-Mobile / regulated-industry use case: a marketing document is submitted, AI reviews and fixes it, then routes it for Workfront approval.

Execute these steps in sequence, using the REAL tools:

**Step 1 — Document Intake** (extract_brief_content):
Simulate receiving a marketing document that has compliance issues. Extract the structured content using extract_brief_content. The document is a product page update that:
- Contains outdated disclaimer language
- Has pricing claims without required footnotes
- Uses non-inclusive language in two places
- Is missing required accessibility alt text

**Step 2 — AI Content Fix** (edit_page_content):
Based on the issues found, show exactly what the AI would fix:
- Update the disclaimer to current legal language
- Add required pricing footnotes
- Fix non-inclusive language
- Add proper alt text for all images
Present a clear before/after showing each fix.

**Step 3 — Governance Gate** (run_governance_check):
Run governance check on the corrected content. Call run_governance_check to get a compliance score. Show the scorecard with specific pass/fail items.

**Step 4 — Workfront Approval Routing** (create_workfront_task):
Create a Workfront approval task using create_workfront_task with:
- title: "Content Compliance Review — Product Page Update"
- description: Include the governance findings summary, what the AI fixed, and what needs human review
- priority: "high"
- assignee: First person in the approval chain

**Step 5 — Summary**:
End with a clear timeline comparison:
- **Before**: SME submits doc → Content author manually reviews → Legal reviews → Brand reviews → Published (3-5 business days)
- **After**: Doc submitted → AI fixes compliance in seconds → Governance gate auto-scored → Workfront task created → Approval routed (10 minutes to approval stage)

This is the "what used to take 3 days now happens in 10 minutes" moment. Show every tool call so the audience sees real API responses.`);
}

const FLOWS = {
  brief: runBrief,
  governance: runGovernance,
  performance: runPerformanceFlow,
  personalize: runPersonalizeFlow,
  workfront: runWorkfrontPanel,
  services: runServicesPanel,
  blocks: runBlockLibrary,
  llmo: runLLMO,
  orchestrate: () => { if (!ai.hasApiKey()) { requireApiKey(); return; } runOrchestration(); },
  content: () => {
    switchView('editor');
    addMessage('assistant', md('Ready to create content. Tell me what you\'d like to build — new pages, blocks, or copy for your site.'));
  },
  /* PMM "Find Your Path" actions */
  'find-content': runFindContent,
  'image-variants': runImageVariants,
  'fix-pipeline': runFixPipeline,
  'brand-compliance': runBrandCompliance,
  'update-content': runUpdateContent,
  /* PMM Use-Case demos */
  'demo-modernize': runDemoModernizeAI,
  'demo-compliance': runDemoBrandCompliance,
  'demo-production': runDemoSpeedProduction,
  /* Enterprise Workflow demo */
  'demo-enterprise': runDemoEnterpriseWorkflow,
};

/* ── User Input ── */
function matchSpecializedFlow(text) {
  const lower = text.toLowerCase();

  // If the message mentions a known site + governance/compliance, route through AI chat
  // (which has site detection and content fetching) instead of the basic page scanner
  const mentionsSite = !!detectSiteMention(text);
  const mentionsGovernance = lower.includes('governance') || lower.includes('compliance')
    || lower.includes('scan') || lower.includes('check') || lower.includes('review')
    || lower.includes('audit') || lower.includes('look at');

  if (mentionsSite && ai.hasApiKey()) {
    // Let AI chat handle it — it will detect the site, fetch content via MCP, and analyze
    return null;
  }

  if (lower.includes('brief') || lower.includes('upload') || lower.includes('create page')) return runBrief;
  if (lower.includes('governance') || lower.includes('compliance') || lower.includes('scan all')
      || lower.includes('scan page') || lower.includes('run scan')) return runGovernance;
  if (lower.includes('perform') || lower.includes('analytics') || lower.includes('bounce')) return runPerformanceFlow;
  if (lower.includes('personal') || lower.includes('segment')) return runPersonalizeFlow;
  if (lower.includes('workfront') || lower.includes('project health') || lower.includes('project status')) return runWorkfrontPanel;
  if (lower.includes('mcp') || lower.includes('services') || lower.includes('entitlement') || lower.includes('connected services')) return runServicesPanel;
  if (lower.includes('block') || lower.includes('library') || lower.includes('catalog') || lower.includes('component')) return runBlockLibrary;
  if (lower.includes('review asset') || lower.includes('brand review') || lower.includes('brand check')) return runAIReviewer;
  if (lower.includes('orchestrat') || lower.includes('end to end') || lower.includes('end-to-end')
      || lower.includes('full pipeline') || lower.includes('brief to page') || lower.includes('5 agents')) {
    return runOrchestration;
  }
  if (lower.includes('overdue') || lower.includes('pending approval') || lower.includes('capacity') || lower.includes('workload')) {
    return () => runWorkfrontQuery(text);
  }
  // PMM "Find Your Path" natural language triggers
  if (lower.includes('find content') || lower.includes('search dam') || lower.includes('find asset') || lower.includes('search asset')) return runFindContent;
  if (lower.includes('image variant') || lower.includes('channel-ready') || lower.includes('rendition') || lower.includes('image crop')) return runImageVariants;
  if (lower.includes('pipeline') || lower.includes('deploy') || lower.includes('build fail') || lower.includes('fix my pipeline')) return runFixPipeline;
  if (lower.includes('brand compliance') || lower.includes('brand check') || lower.includes('off-brand')) return runBrandCompliance;
  if (lower.includes('update content') || lower.includes('stale content') || lower.includes('content fast') || lower.includes('expiring')) return runUpdateContent;
  // PMM demo triggers
  if (lower.includes('demo modernize') || lower.includes('ai-native') || lower.includes('ai discovery demo')) return runDemoModernizeAI;
  if (lower.includes('demo compliance') || lower.includes('demo brand') || lower.includes('compliance demo')) return runDemoBrandCompliance;
  if (lower.includes('demo production') || lower.includes('demo speed') || lower.includes('production demo')) return runDemoSpeedProduction;
  if (lower.includes('demo enterprise') || lower.includes('enterprise workflow') || lower.includes('doc to approval')
      || lower.includes('document to approval') || lower.includes('compliance workflow') || lower.includes('3 days')) return runDemoEnterpriseWorkflow;
  return null;
}

function handleUserInput() {
  const text = chatInput.value.trim();
  if (!text && !pendingFile) return;
  chatInput.value = '';
  autoResizeChatInput();

  // Capture and clear pending file
  const file = pendingFile;
  pendingFile = null;
  const indicator = document.querySelector('.file-attach-indicator');
  if (indicator) indicator.remove();

  const displayText = file
    ? (text || `Uploaded ${file.name}`)
    : text;

  // Always check for specialized flows first — even in AI mode
  if (!file) {
    const specializedFlow = matchSpecializedFlow(text);
    if (specializedFlow) {
      addMessage('user', escapeHtml(displayText));
      setTimeout(() => specializedFlow(), 400);
      return;
    }
  }

  // AI chat (with conversation history)
  if (ai.hasApiKey()) {
    // Show user message with file badge if attached
    if (file) {
      addRawHTML(`
        <div class="message user">
          <div class="message-content">
            <div class="upload-indicator" style="margin-bottom:6px">
              <span class="file-icon">${file.type === 'image' ? '🖼' : '📄'}</span>
              <div>
                <div style="font-weight:500">${escapeHtml(file.name)}</div>
                <div style="font-size:10px;color:var(--text-muted)">${(file.size / 1024).toFixed(0)} KB</div>
              </div>
            </div>
            ${text ? `<div>${escapeHtml(text)}</div>` : ''}
          </div>
        </div>
      `);
    } else {
      addMessage('user', escapeHtml(displayText));
    }
    // Augment prompt with design selection context + plan mode
    let augmentedText = text || `I've uploaded a file: ${file?.name}. Please analyze it.`;
    if (designSelectedElement) {
      augmentedText = `[Design Context — Selected element: ${designSelectedElement.selector}]\n${designSelectedElement.html}\n\n${augmentedText}`;
      clearDesignSelection();
    }
    if (currentMode === 'plan') {
      augmentedText = `[MODE: PLAN — Analyze and propose a strategy. Do NOT modify any files yet. Explain what changes you would make and why, then wait for approval before executing.]\n\n${augmentedText}`;
    }
    handleRealChat(augmentedText, file);
    return;
  }

  // No API key — prompt to configure
  addMessage('user', escapeHtml(displayText));
  requireApiKey();
}

/* ── Event Listeners ── */
document.querySelectorAll('.prompt-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    // If we're on the home view, switch to editor first
    if (currentView === 'home') switchView('editor');
    const fn = FLOWS[btn.dataset.flow];
    if (fn) setTimeout(() => fn(), currentView === 'home' ? 300 : 0);
  });
});

sendBtn.addEventListener('click', handleUserInput);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleUserInput(); }
});

// Auto-resize textarea as user types
function autoResizeChatInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
  chatInput.style.overflowY = chatInput.scrollHeight > 150 ? 'auto' : 'hidden';
}
chatInput.addEventListener('input', autoResizeChatInput);

// Attach file button (paperclip)
const attachBtn = document.querySelector('.attach-btn');
if (attachBtn) {
  attachBtn.addEventListener('click', () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.pdf,.txt,.doc,.docx,.csv,.json,.html,.md,.png,.jpg,.jpeg,.gif,.webp,.svg';
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Show file indicator in input area
      const existingIndicator = document.querySelector('.file-attach-indicator');
      if (existingIndicator) existingIndicator.remove();

      const indicator = document.createElement('div');
      indicator.className = 'file-attach-indicator';
      indicator.innerHTML = `
        <span class="file-attach-icon">${file.type.startsWith('image/') ? '🖼' : '📄'}</span>
        <span class="file-attach-name">${escapeHtml(file.name)}</span>
        <span class="file-attach-size">${(file.size / 1024).toFixed(0)} KB</span>
        <button class="file-attach-remove" title="Remove">✕</button>
      `;
      document.querySelector('.input-wrapper').prepend(indicator);
      indicator.querySelector('.file-attach-remove').addEventListener('click', () => {
        pendingFile = null;
        indicator.remove();
      });

      // Read file content
      try {
        if (file.type.startsWith('image/')) {
          // Images → base64 for Claude vision
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          pendingFile = { name: file.name, type: 'image', size: file.size, content: base64, mediaType: file.type };
        } else if (file.type === 'application/pdf') {
          // PDFs → base64 for Claude's native document handling
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          pendingFile = { name: file.name, type: 'pdf', size: file.size, content: base64, mediaType: 'application/pdf' };
        } else if (file.name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          // DOCX → extract text via mammoth.js
          if (window.mammoth) {
            const buffer = await file.arrayBuffer();
            const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
            pendingFile = { name: file.name, type: 'document', size: file.size, content: result.value, mediaType: 'text/plain' };
          } else {
            throw new Error('DOCX support not loaded. Please refresh and try again.');
          }
        } else {
          // Text files → read as text
          const text = await file.text();
          pendingFile = { name: file.name, type: 'document', size: file.size, content: text, mediaType: file.type };
        }
      } catch (err) {
        indicator.remove();
        addMessage('assistant', `Could not read file: ${err.message}`, 'System');
      }
    };
    fileInput.click();
  });
}

if (authBtn) {
  authBtn.addEventListener('click', () => {
    if (isSignedIn()) {
      // Toggle user menu dropdown
      const menu = document.getElementById('userMenu');
      if (menu) menu.classList.toggle('visible');
    } else {
      signIn();
    }
  });
}
// Sign out from the user menu dropdown
document.getElementById('userSignOutBtn')?.addEventListener('click', () => {
  const menu = document.getElementById('userMenu');
  if (menu) menu.classList.remove('visible');
  signOut();
  updateAuthUI();
});
// Close user menu when clicking outside
document.addEventListener('click', (e) => {
  const container = document.getElementById('authContainer');
  const menu = document.getElementById('userMenu');
  if (menu?.classList.contains('visible') && container && !container.contains(e.target)) {
    menu.classList.remove('visible');
  }
  // Also close GitHub menu when clicking outside
  const ghContainer = document.getElementById('githubContainer');
  const ghMenu = document.getElementById('githubMenu');
  if (ghMenu?.classList.contains('visible') && ghContainer && !ghContainer.contains(e.target)) {
    ghMenu.classList.remove('visible');
  }
});

/* ── GitHub Connection Menu ── */

let ghProfile = null; // cached GitHub user profile

function updateGitHubUI() {
  const btn = document.getElementById('githubBtn');
  const connState = document.getElementById('githubConnectedState');
  const discState = document.getElementById('githubDisconnectedState');
  if (!btn) return;

  const connected = hasGitHubToken();
  btn.classList.toggle('connected', connected);

  if (connState) connState.style.display = connected ? 'block' : 'none';
  if (discState) discState.style.display = connected ? 'none' : 'block';

  if (connected && ghProfile) {
    const avatarEl = document.getElementById('githubAvatar');
    const nameEl = document.getElementById('githubName');
    const loginEl = document.getElementById('githubLogin');
    if (avatarEl && ghProfile.avatar_url) avatarEl.src = ghProfile.avatar_url;
    if (nameEl) nameEl.textContent = ghProfile.name || ghProfile.login || '';
    if (loginEl) loginEl.textContent = `@${ghProfile.login || ''}`;
  }
}

async function validateAndStoreGitHubToken(token) {
  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return { ok: false, error: resp.status === 401 ? 'Token invalid or expired' : `GitHub returned ${resp.status}` };
    ghProfile = await resp.json();
    setGitHubToken(token);
    localStorage.setItem('ew-github-profile', JSON.stringify(ghProfile));
    // Also update IMS profile so auth avatar shows GitHub identity
    await fetchUserProfile();
    updateAuthUI();
    updateGitHubUI();
    return { ok: true, login: ghProfile.login };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const COMPASS_WORKER = 'https://compass-ims-proxy.compass-xsc.workers.dev';

// Handle OAuth redirect — check for #github_token= in URL fragment on page load.
// Fragments never hit servers/proxies/Referer headers, so the token stays private.
(function handleGitHubOAuthRedirect() {
  const hash = window.location.hash;
  if (!hash.includes('github_token=')) return;
  const params = new URLSearchParams(hash.substring(1)); // strip leading #
  const token = params.get('github_token');
  if (token) {
    // Clean the URL immediately (remove token from address bar)
    history.replaceState(null, '', window.location.pathname + window.location.search);
    // Validate and store async
    validateAndStoreGitHubToken(token).then((result) => {
      if (result.ok) {
        console.log(`[GH] OAuth sign-in: ${result.login}`);
      } else {
        console.warn('[GH] OAuth token invalid:', result.error);
        const status = document.getElementById('githubMenuStatus');
        if (status) { status.textContent = 'Sign-in failed — try again'; status.className = 'github-connect-status error'; }
      }
    }).catch((err) => console.error('[GH] OAuth redirect error:', err));
  }
})();

// Load cached GitHub profile on startup
(function loadCachedGhProfile() {
  try {
    const cached = localStorage.getItem('ew-github-profile');
    if (cached) ghProfile = JSON.parse(cached);
  } catch { /* ignore */ }
  updateGitHubUI();
})();

// Toggle GitHub menu
document.getElementById('githubBtn')?.addEventListener('click', () => {
  const menu = document.getElementById('githubMenu');
  if (menu) menu.classList.toggle('visible');
  // Close auth menu if open
  document.getElementById('userMenu')?.classList.remove('visible');
});

// Connect button in disconnected state
document.getElementById('githubMenuConnectBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('githubMenuTokenInput');
  const status = document.getElementById('githubMenuStatus');
  const btn = document.getElementById('githubMenuConnectBtn');
  const token = input?.value?.trim();
  if (!token) return;

  btn.disabled = true;
  btn.textContent = '...';
  status.textContent = 'Validating...';
  status.className = 'github-connect-status';

  const result = await validateAndStoreGitHubToken(token);
  btn.disabled = false;
  btn.textContent = 'Connect';

  if (result.ok) {
    status.textContent = `Connected as ${result.login}`;
    status.className = 'github-connect-status success';
    // Brief delay then switch to connected view
    setTimeout(() => {
      updateGitHubUI();
      input.value = '';
      status.textContent = '';
    }, 800);
  } else {
    status.textContent = result.error;
    status.className = 'github-connect-status error';
  }
});

// Enter key on token input
document.getElementById('githubMenuTokenInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('githubMenuConnectBtn')?.click(); }
});

// OAuth "Sign in with GitHub" button
document.getElementById('githubOAuthBtn')?.addEventListener('click', () => {
  const returnTo = encodeURIComponent(window.location.origin + window.location.pathname);
  window.location.href = `${COMPASS_WORKER}/github/login?return_to=${returnTo}`;
});

// PAT fallback toggle
document.getElementById('githubPatToggle')?.addEventListener('click', (e) => {
  e.preventDefault();
  const fallback = document.getElementById('githubPatFallback');
  if (fallback) fallback.style.display = fallback.style.display === 'none' ? 'block' : 'none';
});

// Helper: programmatically send a chat message
function sendChatMessage(text) {
  if (!chatInput) return;
  chatInput.value = text;
  handleUserInput();
}

// GitHub menu actions
document.getElementById('githubSyncBtn')?.addEventListener('click', () => {
  document.getElementById('githubMenu')?.classList.remove('visible');
  sendChatMessage('Sync the current site content from GitHub');
});

document.getElementById('githubPushBtn')?.addEventListener('click', () => {
  document.getElementById('githubMenu')?.classList.remove('visible');
  sendChatMessage('Push all pending content changes to GitHub');
});

document.getElementById('githubBranchBtn')?.addEventListener('click', () => {
  document.getElementById('githubMenu')?.classList.remove('visible');
  sendChatMessage('Show me the available branches and let me switch');
});

document.getElementById('githubReconnectBtn')?.addEventListener('click', async () => {
  document.getElementById('githubMenu')?.classList.remove('visible');
  const token = getGitHubToken();
  if (token) {
    const result = await validateAndStoreGitHubToken(token);
    if (result.ok) {
      addMessage('assistant', md(`Reconnected to GitHub as **${result.login}**`));
    } else {
      addMessage('assistant', md(`Reconnect failed: ${result.error}. Try updating your token.`));
    }
  }
});

document.getElementById('githubSwitchSiteBtn')?.addEventListener('click', () => {
  document.getElementById('githubMenu')?.classList.remove('visible');
  switchView('home');
});

document.getElementById('githubLogoutBtn')?.addEventListener('click', () => {
  document.getElementById('githubMenu')?.classList.remove('visible');
  localStorage.removeItem('ew-github-token');
  localStorage.removeItem('ew-github-profile');
  ghProfile = null;
  updateGitHubUI();
  updateAuthUI();
  // Clear settings panel GitHub token display
  const ghInput = document.getElementById('githubTokenInput');
  const ghStatus = document.getElementById('githubTokenStatus');
  if (ghInput) ghInput.value = '';
  if (ghStatus) { ghStatus.textContent = ''; ghStatus.className = 'settings-token-status'; }
});

if (settingsBtn) {
  settingsBtn.addEventListener('click', toggleSettings);
}

// Icon rail settings button — opens Demo Admin modal
const railSettingsBtn = document.getElementById('railSettingsBtn');
if (railSettingsBtn) {
  railSettingsBtn.addEventListener('click', () => openDemoAdmin());
}

// Sidebar panel switching (Home / Content / Code)
document.querySelectorAll('.sidebar-btn[data-panel]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    if (panel === 'home') {
      switchView('home');
    } else if (panel === 'content' || panel === 'code') {
      switchView('editor');
    }
  });
});

// Layout toggle buttons
document.querySelectorAll('.layout-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setLayout(btn.dataset.layout);
  });
});

// ── Panel resize handle (drag to resize chat ↔ preview) ──
const resizeHandle = document.getElementById('panelResizeHandle');
if (resizeHandle && panels) {
  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    const chatPanel = document.getElementById('panelChat');
    startWidth = chatPanel.getBoundingClientRect().width;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // Prevent iframe from stealing mouse events
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((f) => { f.style.pointerEvents = 'none'; });
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const newWidth = Math.max(280, Math.min(startWidth + dx, window.innerWidth * 0.6));
    const layout = panels.dataset.layout;
    if (layout === 'full') {
      panels.style.gridTemplateColumns = `${newWidth}px auto 1fr 220px`;
    } else if (layout === 'chat-preview') {
      panels.style.gridTemplateColumns = `${newWidth}px auto 1fr`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((f) => { f.style.pointerEvents = ''; });
  });
}

// Home card click → switch to editor + trigger flow
document.querySelectorAll('.home-card').forEach((card) => {
  card.addEventListener('click', () => {
    const prompt = card.dataset.prompt;
    switchView('editor');
    if (prompt && chatInput) {
      chatInput.value = prompt;
      autoResizeChatInput();
      chatInput.focus();
    }
  });
});

// Home prompt bar → switch to editor + send message
if (homePromptInput) {
  const homePromptSend = document.getElementById('homePromptSend');
  const sendHomePrompt = () => {
    const text = homePromptInput.value.trim();
    if (!text) return;
    switchView('editor');
    chatInput.value = text;
    homePromptInput.value = '';
    setTimeout(() => handleUserInput(), 300);
  };
  homePromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHomePrompt(); }
  });
  if (homePromptSend) homePromptSend.addEventListener('click', sendHomePrompt);
}

// AI tool: switch_site event handler
window.addEventListener('ew-switch-site', (e) => {
  const { org, repo } = e.detail;
  connectCustomSite(`${org}/${repo}`);
});

// Connect site input
const connectSiteInput = document.getElementById('connectSiteInput');
const connectSiteBtn = document.getElementById('connectSiteBtn');
if (connectSiteInput) {
  connectSiteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); connectCustomSite(connectSiteInput.value); }
  });
}
if (connectSiteBtn) {
  connectSiteBtn.addEventListener('click', () => {
    const val = document.getElementById('connectSiteInput')?.value;
    if (val) connectCustomSite(val);
  });
}

// Edit in DA button
const editInDABtn = document.getElementById('editInDABtn');
if (editInDABtn) {
  editInDABtn.addEventListener('click', () => {
    let path = activeResourcePath || '/';
    // Clean path for DA: strip .html, trailing slash, map / → /index
    path = path.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    if (path === '/') path = '/index';
    const daUrl = `https://da.live/edit#/${AEM_ORG.orgId}/${AEM_ORG.repo}${path}`;
    window.open(daUrl, '_blank');
  });
}

// Branch picker
const branchSelect = document.getElementById('branchSelect');
if (branchSelect) {
  branchSelect.addEventListener('change', () => {
    const branch = branchSelect.value;
    AEM_ORG = { ...AEM_ORG, branch };
    window.__EW_ORG = AEM_ORG;
    AEM_ORG.previewOrigin = `https://${branch}--${AEM_ORG.repo.toLowerCase()}--${AEM_ORG.orgId.toLowerCase()}.aem.page`;
    AEM_ORG.liveOrigin = `https://${branch}--${AEM_ORG.repo.toLowerCase()}--${AEM_ORG.orgId.toLowerCase()}.aem.live`;
    PREVIEW_URL = AEM_ORG.previewOrigin + '/';
    da.configure({ org: AEM_ORG.orgId, repo: AEM_ORG.repo, branch });
    navigateToPage(activeResourcePath || '/');
    loadResources();
    showToast(`Switched to branch: ${branch}`, 'info');
  });
}

/* ── Design Mode ── */
/* Uses postMessage to communicate with the srcdoc iframe instead of overlay
   coordinate mapping. This fixes scroll support, coordinate accuracy, and
   hover highlighting — the iframe handles its own events and posts results. */
let designModeActive = false;
let designSelectedElement = null;
const designOverlay = document.getElementById('designOverlay');
const designSelection = document.getElementById('designSelection');
const designSelectionLabel = document.getElementById('designSelectionLabel');
const designSelectionClear = document.getElementById('designSelectionClear');

// Script injected into the srcdoc iframe for design mode click/hover handling
const DESIGN_MODE_SCRIPT = `
(function() {
  let highlighted = null;
  let hovered = null;

  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    var cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    return tag + cls;
  }

  function clearHover() {
    if (hovered) { hovered.style.outline = ''; hovered = null; }
  }

  function clearHighlight() {
    if (highlighted) { highlighted.style.outline = ''; highlighted = null; }
  }

  document.addEventListener('mousemove', function(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.body || el === document.documentElement) { clearHover(); return; }
    if (el === highlighted || el === hovered) return;
    clearHover();
    if (el !== highlighted) {
      el.style.outline = '2px solid rgba(0,122,255,0.4)';
      hovered = el;
    }
  });

  document.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.body || el === document.documentElement) return;

    clearHighlight();
    clearHover();
    el.style.outline = '3px solid #007AFF';
    highlighted = el;

    var tag = el.tagName.toLowerCase();
    var cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.split(/\\s+/).slice(0, 2).join('.') : '';
    var text = (el.textContent || '').trim().slice(0, 40);
    var label = '<' + tag + cls + '>' + (text ? ' "' + text + (el.textContent.trim().length > 40 ? '...' : '') + '"' : '');

    window.parent.postMessage({
      type: 'ew-design-select',
      label: label,
      tag: tag,
      className: el.className || '',
      html: el.outerHTML.slice(0, 2000),
      textContent: (el.textContent || '').trim().slice(0, 500),
      selector: buildSelector(el)
    }, '*');
  }, true);

  // Signal ready
  window.parent.postMessage({ type: 'ew-design-ready' }, '*');
})();
`;

async function enableDesignMode() {
  designModeActive = true;
  if (designOverlay) designOverlay.classList.add('active');

  if (!previewFrame) return;

  const path = activeResourcePath || '/';
  const base = AEM_ORG.previewOrigin;
  showToast('Loading design mode...', 'info');

  // Fetch page HTML for srcdoc rendering (always use srcdoc for design mode —
  // the production iframe is cross-origin, so we need same-origin DOM access)
  await ensurePageContext();
  const html = cachedPageHTML;
  if (!html) {
    showToast('Could not load page content for design mode', 'warn');
    return;
  }

  // Save original src so we can restore on exit
  if (!previewFrame.dataset.designSavedSrc) {
    previewFrame.dataset.designSavedSrc = previewFrame.src;
  }

  // Render as srcdoc with injected design mode handler
  previewFrame.srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <base href="${base}/">
  <link rel="stylesheet" href="${base}/styles/styles.css">
  <script src="${base}/scripts/aem.js" type="module"><\/script>
  <script src="${base}/scripts/scripts.js" type="module"><\/script>
  <style>body { cursor: crosshair; } *:hover { cursor: crosshair; }</style>
</head>
<body>
  <header></header>
  <main>${html}</main>
  <footer></footer>
  <script>${DESIGN_MODE_SCRIPT}<\/script>
</body>
</html>`;
}

function disableDesignMode() {
  designModeActive = false;
  if (designOverlay) designOverlay.classList.remove('active');

  // Restore original iframe src if we switched to srcdoc for design mode
  if (previewFrame?.dataset.designSavedSrc) {
    previewFrame.removeAttribute('srcdoc');
    previewFrame.src = previewFrame.dataset.designSavedSrc;
    delete previewFrame.dataset.designSavedSrc;
  }
}

// Listen for postMessage from design mode iframe
window.addEventListener('message', (e) => {
  if (!designModeActive) return;
  const data = e.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'ew-design-select') {
    designSelectedElement = {
      label: data.label,
      tag: data.tag,
      className: data.className,
      html: data.html,
      textContent: data.textContent,
      selector: data.selector,
    };
    if (designSelection) designSelection.style.display = '';
    if (designSelectionLabel) designSelectionLabel.textContent = data.label;
  }
});

function clearDesignSelection() {
  designSelectedElement = null;
  if (designSelection) designSelection.style.display = 'none';
}

if (designSelectionClear) {
  designSelectionClear.addEventListener('click', clearDesignSelection);
}

/* ── Preview View Tabs (Preview / Design / JCR XML) ── */
let currentPreviewView = 'preview';
const previewViewTabs = document.getElementById('previewViewTabs');
const jcrView = document.getElementById('jcrView');
const jcrXmlContent = document.getElementById('jcrXmlContent');

if (previewViewTabs) {
  previewViewTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.preview-view-tab');
    if (!tab) return;
    const view = tab.dataset.view;
    if (view === currentPreviewView) return;

    // Update tab states
    previewViewTabs.querySelectorAll('.preview-view-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentPreviewView = view;

    // Toggle views
    if (view === 'design') {
      enableDesignMode();
      if (jcrView) jcrView.style.display = 'none';
      if (previewFrame) previewFrame.style.display = '';
    } else if (view === 'jcr') {
      disableDesignMode();
      if (previewFrame) previewFrame.style.display = 'none';
      if (jcrView) jcrView.style.display = '';
      loadJcrXml();
    } else {
      disableDesignMode();
      clearDesignSelection();
      if (jcrView) jcrView.style.display = 'none';
      if (previewFrame) previewFrame.style.display = '';
    }
  });
}

/* ── JCR XML View ── */
async function loadJcrXml() {
  if (!jcrXmlContent) return;
  const path = activeResourcePath || '/';
  jcrXmlContent.textContent = 'Loading JCR structure...';

  let html = null;

  // Strategy 1: Try reading from iframe contentDocument (same-origin only)
  try {
    const doc = previewFrame?.contentDocument || previewFrame?.contentWindow?.document;
    if (doc && doc.body && doc.body.innerHTML.trim()) {
      html = doc.body.innerHTML;
    }
  } catch { /* cross-origin — expected */ }

  // Strategy 2: Fetch .plain.html from preview origin
  if (!html) {
    try {
      const url = `${AEM_ORG.previewOrigin}${path}.plain.html`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`${resp.status}`);
      html = await resp.text();
    } catch (err) {
      jcrXmlContent.textContent = `<!-- Error loading JCR view: ${err.message} -->\n<!-- Path: ${path} -->\n<!-- Tip: JCR XML works best with same-origin preview or when CORS is enabled -->`;
      return;
    }
  }

  try {
    const xml = htmlToJcrXml(html, path);
    jcrXmlContent.textContent = xml;
  } catch (err) {
    jcrXmlContent.textContent = `<!-- Error parsing HTML to JCR: ${err.message} -->`;
  }
}

function htmlToJcrXml(html, pagePath) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const lines = [];
  const indent = (n) => '  '.repeat(n);
  const pageName = pagePath.split('/').filter(Boolean).pop() || 'index';

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0" xmlns:nt="http://www.jcp.org/jcr/nt/1.0" xmlns:sling="http://sling.apache.org/jcr/sling/1.0" xmlns:cq="http://www.day.com/jcr/cq/1.0"`);
  lines.push(`  jcr:primaryType="cq:Page">`);
  lines.push(`${indent(1)}<jcr:content`);
  lines.push(`${indent(2)}jcr:primaryType="cq:PageContent"`);
  lines.push(`${indent(2)}jcr:title="${pageName}"`);
  lines.push(`${indent(2)}sling:resourceType="core/franklin/components/page/v1/page">`);

  // Parse sections (separated by <hr> or section wrappers)
  const body = doc.body;
  let sectionIdx = 0;

  // Split content by <hr> or direct div children
  const children = [...body.children];
  let currentSection = [];
  const sections = [];

  children.forEach((child) => {
    if (child.tagName === 'HR') {
      if (currentSection.length) sections.push(currentSection);
      currentSection = [];
    } else {
      currentSection.push(child);
    }
  });
  if (currentSection.length) sections.push(currentSection);

  sections.forEach((sectionEls, si) => {
    lines.push(`${indent(2)}<section_${si}`);
    lines.push(`${indent(3)}jcr:primaryType="nt:unstructured"`);
    lines.push(`${indent(3)}sling:resourceType="core/franklin/components/section/v1/section">`);

    sectionEls.forEach((el, ei) => {
      const tag = el.tagName.toLowerCase();
      // Check if it's a block (has a class that's not generic)
      const blockClass = el.className?.trim().split(/\s+/)[0];
      const isBlock = el.tagName === 'DIV' && blockClass && !['section', 'default-content-wrapper'].includes(blockClass);

      if (isBlock) {
        lines.push(`${indent(3)}<${blockClass.replace(/[^a-z0-9_-]/gi, '_')}`);
        lines.push(`${indent(4)}jcr:primaryType="nt:unstructured"`);
        lines.push(`${indent(4)}sling:resourceType="core/franklin/components/block/v1/block"`);
        lines.push(`${indent(4)}name="${blockClass}"`);

        // Block children (rows)
        const rows = [...el.children];
        rows.forEach((row, ri) => {
          const cols = [...row.children];
          cols.forEach((col, ci) => {
            const text = col.textContent?.trim().slice(0, 100);
            if (text) {
              lines.push(`${indent(4)}item_${ri}_${ci}="${escapeXml(text)}"`);
            }
          });
        });

        lines.push(`${indent(3)}/>`);
      } else {
        // Default content
        const text = el.textContent?.trim().slice(0, 80);
        const nodeName = tag === 'p' ? `text_${ei}` : `${tag}_${ei}`;
        lines.push(`${indent(3)}<${nodeName}`);
        lines.push(`${indent(4)}jcr:primaryType="nt:unstructured"`);

        if (tag.match(/^h[1-6]$/)) {
          lines.push(`${indent(4)}sling:resourceType="core/franklin/components/title/v1/title"`);
          lines.push(`${indent(4)}jcr:title="${escapeXml(text || '')}"`);
          lines.push(`${indent(4)}type="${tag}"`);
        } else if (tag === 'img' || el.querySelector?.('img')) {
          const img = tag === 'img' ? el : el.querySelector('img');
          lines.push(`${indent(4)}sling:resourceType="core/franklin/components/image/v1/image"`);
          if (img) lines.push(`${indent(4)}fileReference="${escapeXml(img.src || img.getAttribute('src') || '')}"`);
        } else if (tag === 'a' || el.querySelector?.('a')) {
          lines.push(`${indent(4)}sling:resourceType="core/franklin/components/button/v1/button"`);
          const a = tag === 'a' ? el : el.querySelector('a');
          if (a) {
            lines.push(`${indent(4)}linkURL="${escapeXml(a.href || '')}"`);
            lines.push(`${indent(4)}text="${escapeXml(a.textContent?.trim() || '')}"`);
          }
        } else {
          lines.push(`${indent(4)}sling:resourceType="core/franklin/components/text/v1/text"`);
          if (text) lines.push(`${indent(4)}text="${escapeXml(text)}"`);
        }

        lines.push(`${indent(3)}/>`);
      }
    });

    lines.push(`${indent(2)}</section_${si}>`);
  });

  lines.push(`${indent(1)}</jcr:content>`);
  lines.push('</jcr:root>');

  return lines.join('\n');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ── Plan/Execute Mode Toggle ── */
let currentMode = 'execute'; // 'execute' | 'plan'
window.__EW_MODE = 'execute';
const modeToggle = document.getElementById('modeToggle');
if (modeToggle) {
  modeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === currentMode) return;
    currentMode = mode;
    window.__EW_MODE = mode;
    modeToggle.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    showToast(mode === 'plan' ? 'Plan mode — AI will analyze before making changes' : 'Execute mode — AI will make changes directly', 'info');
  });
}

/* ── Content Packaging ── */
const packageBtn = document.getElementById('packageBtn');
const packageModal = document.getElementById('packageModal');
const packageModalClose = document.getElementById('packageModalClose');
const packageCancelBtn = document.getElementById('packageCancelBtn');
const packageUploadBtn = document.getElementById('packageUploadBtn');
const packagePages = document.getElementById('packagePages');
const packageNameInput = document.getElementById('packageName');

function openPackageModal() {
  if (!packageModal) return;
  // Populate with known pages
  if (packagePages) {
    const pages = sitePages.length > 0 ? sitePages : [{ path: '/', title: 'index' }];
    packagePages.innerHTML = pages.map((p) =>
      `<label class="package-page-item"><input type="checkbox" checked value="${escapeHtml(p.path)}"> ${escapeHtml(p.title || p.path)}</label>`
    ).join('');
  }
  if (packageNameInput) {
    packageNameInput.value = `${AEM_ORG.orgId || 'site'}-${AEM_ORG.repo || 'content'}`;
  }
  packageModal.style.display = '';
}

function closePackageModal() {
  if (packageModal) packageModal.style.display = 'none';
}

async function uploadPackage() {
  if (!packagePages) return;
  const selected = [...packagePages.querySelectorAll('input:checked')].map((cb) => cb.value);
  if (selected.length === 0) {
    showToast('Select at least one page to package', 'warn');
    return;
  }

  const pkgName = packageNameInput?.value || 'content-package';
  const includeImages = document.getElementById('packageImages')?.checked ?? true;

  closePackageModal();
  showToast(`Packaging ${selected.length} page(s)...`, 'info');

  // Fetch content for each page
  const pages = [];
  for (const path of selected) {
    try {
      const url = `${AEM_ORG.previewOrigin}${path}.plain.html`;
      const resp = await fetch(url);
      if (resp.ok) {
        const html = await resp.text();
        pages.push({ path, html });
      }
    } catch { /* skip */ }
  }

  // Build a simple content package (JSON bundle)
  const pkg = {
    name: pkgName,
    created: new Date().toISOString(),
    org: AEM_ORG.orgId,
    repo: AEM_ORG.repo,
    branch: AEM_ORG.branch,
    includeImages,
    pages,
  };

  // Download as JSON file
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${pkgName}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Package "${pkgName}" downloaded with ${pages.length} page(s)`, 'success');
}

if (packageBtn) packageBtn.addEventListener('click', openPackageModal);
if (packageModalClose) packageModalClose.addEventListener('click', closePackageModal);
if (packageCancelBtn) packageCancelBtn.addEventListener('click', closePackageModal);
if (packageUploadBtn) packageUploadBtn.addEventListener('click', uploadPackage);

// Locale selector change → filter resources by locale
if (localeSelect) {
  localeSelect.addEventListener('change', () => filterByLocale(localeSelect.value));
}

// Preview toolbar buttons
const refreshPreviewBtn = document.getElementById('refreshPreviewBtn');
if (refreshPreviewBtn) {
  refreshPreviewBtn.addEventListener('click', () => {
    if (!previewFrame) return;
    // If an LLMO report (or other srcdoc overlay) is showing, restore the real page
    if (previewFrame.srcdoc && previewFrame.dataset.savedSrc) {
      previewFrame.removeAttribute('srcdoc');
      previewFrame.src = previewFrame.dataset.savedSrc;
      delete previewFrame.dataset.savedSrc;
    } else {
      previewFrame.src = previewFrame.src;
    }
  });
}

/* ── LLMO Report Detail View ── */
window.__showLLMOReport = (reportId) => {
  const html = window[reportId];
  if (html && previewFrame) {
    // Save the real page URL so refresh can restore it
    if (!previewFrame.dataset.savedSrc && previewFrame.src && previewFrame.src !== 'about:blank') {
      previewFrame.dataset.savedSrc = previewFrame.src;
    }
    previewFrame.srcdoc = html;
  }
};

const editInUEBtn = document.getElementById('editInUEBtn');
if (editInUEBtn) {
  editInUEBtn.addEventListener('click', () => {
    const path = activeResourcePath || '/';
    const aemHost = window.__EW_AEM_HOST;
    const siteType = window.__EW_SITE_TYPE;

    if (siteType === 'aem-cs' && aemHost) {
      // JCR/xwalk: open author-hosted Universal Editor with content path
      // Format: https://{author-host}/ui#/@{ims-org}/aem/universal-editor/canvas/{author-host}{content-path}
      const host = aemHost.replace(/^https?:\/\//, '');
      const contentPath = path.startsWith('/content') ? path : `/content${path}`;
      const ueUrl = `https://${host}/ui#/aem/universal-editor/canvas/${host}${contentPath}`;
      window.open(ueUrl, '_blank');
    } else {
      // DA/EDS: open experience.adobe.com UE with preview URL
      const ueUrl = `https://experience.adobe.com/#/@${AEM_ORG.orgId}/aem/editor/canvas/${AEM_ORG.previewOrigin}${path}`;
      window.open(ueUrl, '_blank');
    }
  });
}

/* ── Inline Site Switcher (click toolbar URL → input → Enter to switch) ── */
const previewSiteUrl = document.getElementById('previewSiteUrl');
const siteSwitchInput = document.getElementById('siteSwitchInput');
// previewUrlText already declared at top of file

if (previewSiteUrl && siteSwitchInput && previewUrlText) {
  // Click URL text → show input
  previewSiteUrl.addEventListener('click', (e) => {
    if (e.target === siteSwitchInput) return; // already editing
    previewUrlText.style.display = 'none';
    siteSwitchInput.style.display = '';
    siteSwitchInput.value = `${AEM_ORG.orgId}/${AEM_ORG.repo}`;
    siteSwitchInput.focus();
    siteSwitchInput.select();
    previewSiteUrl.classList.add('editing');
  });

  // Enter → switch site, Escape → cancel
  siteSwitchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = siteSwitchInput.value.trim();
      if (val && val.includes('/')) {
        // Hide input, show URL text
        siteSwitchInput.style.display = 'none';
        previewUrlText.style.display = '';
        previewSiteUrl.classList.remove('editing');
        // Use the existing connectCustomSite flow
        connectCustomSite(val);
      }
    } else if (e.key === 'Escape') {
      siteSwitchInput.style.display = 'none';
      previewUrlText.style.display = '';
      previewSiteUrl.classList.remove('editing');
    }
  });

  // Blur → cancel
  siteSwitchInput.addEventListener('blur', () => {
    setTimeout(() => {
      siteSwitchInput.style.display = 'none';
      previewUrlText.style.display = '';
      previewSiteUrl.classList.remove('editing');
    }, 150);
  });
}

/* ── Profile Switching ── */
function switchProfile(profileId) {
  setActiveProfile(profileId);
  AEM_ORG = getOrgConfig();
  PREVIEW_URL = AEM_ORG.previewOrigin + '/';

  // Reconfigure DA client
  da.configure({ org: AEM_ORG.orgId, repo: AEM_ORG.repo, branch: AEM_ORG.branch });

  // Update UI
  const customerNameEl = document.querySelector('.customer-name');
  const customerMetaEl = document.querySelector('.customer-meta');
  if (customerNameEl) customerNameEl.textContent = AEM_ORG.name;
  if (customerMetaEl) customerMetaEl.innerHTML = `&bull; ${AEM_ORG.tier} &bull; ${AEM_ORG.env}`;

  // Update active state in org selector
  document.querySelectorAll('.org-option').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.profile === profileId);
  });

  // Reconnect site: reload preview + resources + home badge
  activeResourcePath = null;
  connectSite();
  cachedPageHTML = null;
  cachedPageUrl = null;

  // Clear conversation
  conversationHistory = [];

  // Notify user (only in editor view)
  if (currentView === 'editor') {
    addMessage('assistant', md(`**Switched to ${AEM_ORG.name}**\nCustomer-specific system prompt loaded. Brand voice, segments, approval chains, and legal rules are now active for ${AEM_ORG.name}.`));
  }

  updateAuthUI();
}

function buildOrgSelector() {
  const profiles = listProfiles();
  const activeId = getActiveProfile()?.id || null;

  const container = document.getElementById('orgSelector');
  if (!container) return;

  container.innerHTML = '';
  profiles.forEach((p) => {
    if (p.isCustom) {
      // Custom profiles get a delete button
      const wrap = document.createElement('div');
      wrap.classList.add('org-option-wrap');

      const opt = document.createElement('button');
      opt.classList.add('org-option');
      if (p.id === activeId) opt.classList.add('active');
      opt.dataset.profile = p.id;
      opt.innerHTML = `<span class="org-name">${escapeHtml(p.name)}</span><span class="org-vertical">${escapeHtml(p.vertical)}</span>`;
      opt.addEventListener('click', () => switchProfile(p.id));

      const del = document.createElement('button');
      del.classList.add('org-delete-btn');
      del.title = 'Delete custom profile';
      del.textContent = '\u2715';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (getActiveProfile()?.id === p.id) switchProfile('aem-xsc');
        deleteCustomProfile(p.id);
        buildOrgSelector();
      });

      wrap.appendChild(opt);
      wrap.appendChild(del);
      container.appendChild(wrap);
    } else {
      const opt = document.createElement('button');
      opt.classList.add('org-option');
      if (p.id === activeId) opt.classList.add('active');
      opt.dataset.profile = p.id;
      opt.innerHTML = `<span class="org-name">${escapeHtml(p.name)}</span><span class="org-vertical">${escapeHtml(p.vertical)}</span>`;
      opt.addEventListener('click', () => switchProfile(p.id));
      container.appendChild(opt);
    }
  });
}

/* ── Profile Generator (AI-powered customer onboarding) ── */
function initProfileGenerator() {
  const modal = document.getElementById('profileModal');
  const closeBtn = document.getElementById('profileModalClose');
  const newBtn = document.getElementById('newProfileBtn');
  const generateBtn = document.getElementById('profileGenerateBtn');
  const uploadBtn = document.getElementById('profileUploadBtn');
  const saveBtn = document.getElementById('profileSaveBtn');
  const backBtn = document.getElementById('profileBackBtn');

  if (!modal || !newBtn) return;

  // Open modal
  newBtn.addEventListener('click', () => {
    modal.classList.add('visible');
    document.getElementById('settingsPanel').classList.remove('visible');
    showProfileStep(1);
  });

  // Close modal
  closeBtn.addEventListener('click', () => modal.classList.remove('visible'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('visible');
  });

  // Upload notes file
  uploadBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.pdf,.doc,.docx,.md';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      document.getElementById('profileFileName').textContent = file.name;
      try {
        let text = '';
        if (file.type === 'application/pdf' && window.pdfjsLib) {
          const buffer = await file.arrayBuffer();
          const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
          const pages = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            pages.push(content.items.map((item) => item.str).join(' '));
          }
          text = pages.join('\n\n');
        } else {
          text = await file.text();
        }
        const notes = document.getElementById('profileNotes');
        notes.value = (notes.value ? notes.value + '\n\n---\n\n' : '') + text;
      } catch (err) {
        document.getElementById('profileFileName').textContent = `Error: ${err.message}`;
      }
    };
    input.click();
  });

  // Generate profile
  generateBtn.addEventListener('click', () => runProfileGeneration());

  // Save profile
  saveBtn.addEventListener('click', () => {
    try {
      const json = document.getElementById('profileJson').value;
      const profile = JSON.parse(json);
      if (!profile.id || !profile.name) throw new Error('Profile needs id and name');
      addCustomProfile(profile);
      switchProfile(profile.id);
      buildOrgSelector();
      modal.classList.remove('visible');
      addMessage('assistant', md(`**Customer profile created: ${profile.name}**\nBrand voice, ${profile.segments?.length || 0} segments, approval chain, and legal rules loaded. The AI now speaks ${profile.name}.`));
    } catch (err) {
      alert(`Invalid profile JSON: ${err.message}`);
    }
  });

  // Back button
  backBtn.addEventListener('click', () => showProfileStep(1));
}

function showProfileStep(step) {
  document.getElementById('profileStep1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('profileStep2').style.display = step === 2 ? 'block' : 'none';
  document.getElementById('profileStep3').style.display = step === 3 ? 'block' : 'none';
}

async function runProfileGeneration() {
  const url = document.getElementById('profileUrl').value.trim();
  const notes = document.getElementById('profileNotes').value.trim();

  if (!url && !notes) {
    alert('Enter a customer URL, paste discovery notes, or both.');
    return;
  }

  if (!ai.hasApiKey()) {
    alert('Configure your Claude API key first.');
    return;
  }

  // Step 2: Show progress
  showProfileStep(2);
  const statusEl = document.getElementById('profileGenStatus');
  const stepsEl = document.getElementById('profileGenSteps');
  stepsEl.innerHTML = '';

  const addGenStep = (label, state) => {
    const el = document.createElement('div');
    el.classList.add('profile-gen-step');
    el.innerHTML = `<span class="gen-dot ${state}"></span>${label}`;
    stepsEl.appendChild(el);
    return el;
  };

  const updateGenStep = (el, state) => {
    el.querySelector('.gen-dot').className = `gen-dot ${state}`;
  };

  // Step 2a: Scrape website if URL provided
  let siteData = '';
  if (url) {
    statusEl.textContent = 'Scraping customer website...';
    const scrapeStep = addGenStep('Fetching site content & CSS', 'active');

    try {
      // Fetch the page HTML
      const resp = await fetch(url, { mode: 'cors' }).catch(() => null);
      if (resp?.ok) {
        const html = await resp.text();

        // Extract useful data
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const title = doc.querySelector('title')?.textContent || '';
        const metaDesc = doc.querySelector('meta[name="description"]')?.content || '';

        // Get nav structure
        const navLinks = [...doc.querySelectorAll('nav a, header a')].map((a) => a.textContent?.trim()).filter(Boolean).slice(0, 20);

        // Get headings
        const headings = [...doc.querySelectorAll('h1, h2, h3')].map((h) => h.textContent?.trim()).filter(Boolean).slice(0, 15);

        // Extract inline styles / CSS references for color hints
        const styleSheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).slice(0, 5);
        const inlineStyles = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n').slice(0, 3000);

        // Get body text summary
        const bodyText = doc.body?.textContent?.replace(/\s+/g, ' ')?.trim()?.slice(0, 2000) || '';

        siteData = `URL: ${url}
Title: ${title}
Meta Description: ${metaDesc}
Navigation Links: ${navLinks.join(', ')}
Headings: ${headings.join(' | ')}
CSS Stylesheets: ${styleSheets.join(', ')}
Inline CSS (excerpt): ${inlineStyles.slice(0, 1000)}
Body Text (excerpt): ${bodyText}`;

        updateGenStep(scrapeStep, 'done');
      } else {
        // CORS blocked — provide URL context only
        siteData = `URL: ${url}\n(Direct fetch blocked by CORS — use URL context and any discovery notes to infer site structure)`;
        updateGenStep(scrapeStep, 'done');
      }
    } catch {
      siteData = `URL: ${url}\n(Could not fetch — infer from URL and discovery notes)`;
      updateGenStep(scrapeStep, 'done');
    }
  }

  // Step 2b: Generate profile with AI
  statusEl.textContent = 'AI generating customer profile...';
  const aiStep = addGenStep('Extracting brand voice, segments, rules', 'active');
  const segStep = addGenStep('Building approval chain & legal SLAs', 'pending');
  const finalStep = addGenStep('Assembling complete profile', 'pending');

  try {
    const prompt = buildProfilePrompt(notes, siteData);
    const result = await ai.chat(prompt);

    updateGenStep(aiStep, 'done');
    updateGenStep(segStep, 'done');
    updateGenStep(finalStep, 'done');
    statusEl.textContent = 'Profile generated!';

    // Parse the JSON response
    let profileJson = result;
    // Strip markdown fences if present
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) profileJson = jsonMatch[1];
    // Also try to find raw JSON object
    const braceMatch = profileJson.match(/\{[\s\S]*\}/);
    if (braceMatch) profileJson = braceMatch[0];

    const profile = JSON.parse(profileJson);

    // Show step 3: review
    await sleep(500);
    showProfileStep(3);

    // Build preview
    const preview = document.getElementById('profilePreview');
    const colors = profile.brandVoice?.colorPalette;
    const safeColor = (v) => /^(#[0-9a-f]{3,8}|rgb\([\d\s,.%]+\)|[a-z]+)$/i.test(v) ? v : '#ccc';
    preview.innerHTML = `
      <div class="pv-name">${escapeHtml(profile.name)}</div>
      <div class="pv-meta">${escapeHtml(profile.vertical)} &bull; ${escapeHtml(profile.tier)}</div>
      <div class="pv-section"><div class="pv-label">Brand Voice</div>${escapeHtml(profile.brandVoice?.tone || 'Not specified')} — ${escapeHtml(profile.brandVoice?.style || '')}</div>
      ${colors ? `<div class="pv-section"><div class="pv-label">Brand Colors</div><div class="pv-colors">${Object.entries(colors).map(([k, v]) => `<div class="pv-swatch" style="background:${safeColor(v)}" title="${escapeHtml(k)}: ${escapeHtml(v)}"></div>`).join('')}</div></div>` : ''}
      <div class="pv-section"><div class="pv-label">Segments (${profile.segments?.length || 0})</div>${escapeHtml(profile.segments?.map((s) => s.name).join(', ') || 'None')}</div>
      <div class="pv-section"><div class="pv-label">Approval Chain (${profile.approvalChain?.length || 0} steps)</div>${escapeHtml(profile.approvalChain?.map((s) => s.role).join(' → ') || 'None')}</div>
      <div class="pv-section"><div class="pv-label">Legal Rules (${profile.legalSLA?.specialRules?.length || 0})</div>${escapeHtml(profile.legalSLA?.specialRules?.slice(0, 3).join('; ') || 'None')}${(profile.legalSLA?.specialRules?.length || 0) > 3 ? '...' : ''}</div>
    `;

    // Show editable JSON
    document.getElementById('profileJson').value = JSON.stringify(profile, null, 2);

  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    updateGenStep(aiStep, 'done');
    updateGenStep(segStep, 'done');
    updateGenStep(finalStep, 'done');
    // Fall back to step 1
    await sleep(2000);
    showProfileStep(1);
  }
}

/* ── Init ── */
async function init() {
  // Handle PKCE callback (?code= in URL) — must run before IMS library init
  const wasCallback = await handlePkceCallback();
  if (wasCallback) console.log('[EW] PKCE callback handled — signed in');

  // Configure DA client from dynamic org config (only if a site is set)
  if (AEM_ORG.orgId && AEM_ORG.repo) {
    da.configure({ org: AEM_ORG.orgId, repo: AEM_ORG.repo, branch: AEM_ORG.branch });
  }

  // Set org context in UI from active profile
  const customerNameEl = document.querySelector('.customer-name');
  const customerMetaEl = document.querySelector('.customer-meta');
  if (customerNameEl) customerNameEl.textContent = AEM_ORG.name || '';
  if (customerMetaEl) customerMetaEl.innerHTML = AEM_ORG.tier ? `&bull; ${AEM_ORG.tier} &bull; ${AEM_ORG.env}` : '';

  // Build org selector and profile generator
  buildOrgSelector();
  initProfileGenerator();

  console.log('[EW] init v25 — repo management, real branch picker, recent repos');

  // Render recent repos on home view
  renderRecentRepos();

  // Initialize IMS library (passive — no auto-redirect, no forced sign-in)
  try {
    await loadIms();
  } catch (err) {
    console.warn('IMS init:', err.message);
  }

  // Load user profile (from cache or IMS API) — needed for auth UI
  if (isSignedIn()) {
    await fetchUserProfile();
  }

  updateAuthUI();

  // NO auto sign-in. User clicks "Sign In" button when ready.
  // This prevents any redirect to da.live.

  // Auto-connect site if a profile/site is already set
  if (AEM_ORG.orgId && AEM_ORG.repo) {
    connectSite();
    addMessage('assistant', md(`**Connected to ${AEM_ORG.name}** (${AEM_ORG.orgId}/${AEM_ORG.repo})\nSite loaded. You can:\n- **Prompt to edit**: "Change the hero headline"\n- **Set up experiments**: "A/B test the hero on the homepage"\n- **Generate variations**: "Create 3 hero variations targeting millennials"\n- **Add forms**: "Add a contact form to /contact"\n- **Switch site**: Click the site URL in the toolbar to connect a different repo`));
    previewFrame.addEventListener('load', () => ensurePageContext(), { once: true });
  } else {
    addMessage('assistant', md(`**Welcome to Compass**\nConnect a site by pasting an **.aem.page URL** or entering **org/repo** on the home screen.\n\nExamples: \`https://main--lifepoint--aemxsc.aem.page/\` or \`AEMXSC/lifepoint\``));
  }

  if (ai.hasApiKey()) {
    console.log(`Claude API key found — live AI mode${AEM_ORG.name ? ` for ${AEM_ORG.name}` : ''}`);
  }
}

/* ─── Demo Admin: Customer Co-Brand Logo ─── */

const LOGO_STORAGE_KEY = 'ew-logo-config';

/** Clamp integer to safe range. */
function safeInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Read logo config from localStorage with schema validation. */
function readLogoConfig() {
  try {
    const raw = localStorage.getItem(LOGO_STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (typeof cfg !== 'object' || !cfg) return null;
    return {
      url: typeof cfg.url === 'string' ? cfg.url : '',
      name: typeof cfg.name === 'string' ? cfg.name : '',
      height: safeInt(cfg.height, 16, 48, 20),
    };
  } catch {
    return null;
  }
}

/** Save logo config to localStorage. */
function saveLogoConfig(cfg) {
  if (!cfg || !cfg.url) {
    localStorage.removeItem(LOGO_STORAGE_KEY);
    return;
  }
  localStorage.setItem(LOGO_STORAGE_KEY, JSON.stringify({
    url: cfg.url,
    name: cfg.name || '',
    height: safeInt(cfg.height, 16, 48, 20),
  }));
}

/** Apply logo config to the nav bar using safe DOM APIs. */
function applyLogoToNav(cfg) {
  const logoEl = document.getElementById('customerLogo');
  const cobrandEl = document.getElementById('headerCobrand');
  if (!logoEl) return;

  if (cfg && cfg.url) {
    logoEl.setAttribute('src', cfg.url);
    logoEl.setAttribute('alt', cfg.name || 'Customer logo');
    logoEl.style.height = `${safeInt(cfg.height, 16, 48, 20)}px`;
    logoEl.style.display = '';
    if (cobrandEl) {
      cobrandEl.textContent = cfg.name ? `x ${cfg.name}` : '';
      cobrandEl.style.display = cfg.name ? '' : 'none';
    }
  } else {
    logoEl.style.display = 'none';
    logoEl.removeAttribute('src');
    if (cobrandEl) cobrandEl.style.display = 'none';
  }
}

/** Open Demo Admin modal. */
function openDemoAdmin() {
  const modal = document.getElementById('demoAdminModal');
  if (!modal) return;
  modal.classList.add('visible');

  // Pre-fill from current config
  const cfg = readLogoConfig();
  const urlInput = document.getElementById('logoUrlInput');
  const heightInput = document.getElementById('logoHeightInput');
  const nameInput = document.getElementById('logoNameInput');
  if (urlInput) urlInput.value = cfg?.url || '';
  if (heightInput) heightInput.value = cfg?.height || 20;
  if (nameInput) nameInput.value = cfg?.name || '';

  // Show preview if we have a URL
  updateLogoPreview(cfg?.url);

  // Focus first input
  if (urlInput) urlInput.focus();
}

function closeDemoAdmin() {
  const modal = document.getElementById('demoAdminModal');
  if (modal) modal.classList.remove('visible');
}

function updateLogoPreview(url) {
  const preview = document.getElementById('logoPreview');
  const previewImg = document.getElementById('logoPreviewImg');
  if (!preview || !previewImg) return;
  if (url) {
    previewImg.setAttribute('src', url);
    const h = safeInt(document.getElementById('logoHeightInput')?.value, 16, 48, 20);
    previewImg.style.height = `${h}px`;
    preview.style.display = '';
  } else {
    preview.style.display = 'none';
  }
}

// Wire Demo Admin modal
(function initDemoAdmin() {
  const modal = document.getElementById('demoAdminModal');
  const closeBtn = document.getElementById('demoAdminClose');
  const applyBtn = document.getElementById('logoApplyBtn');
  const removeBtn = document.getElementById('logoRemoveBtn');
  const urlInput = document.getElementById('logoUrlInput');
  const fileInput = document.getElementById('logoFileInput');
  const heightInput = document.getElementById('logoHeightInput');

  if (!modal) return;

  // Close handlers
  if (closeBtn) closeBtn.addEventListener('click', closeDemoAdmin);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeDemoAdmin(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDemoAdmin(); });

  // URL input → live preview
  if (urlInput) urlInput.addEventListener('input', () => updateLogoPreview(urlInput.value));
  if (heightInput) heightInput.addEventListener('input', () => updateLogoPreview(urlInput?.value));

  // File upload → convert to data URL
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (urlInput) urlInput.value = reader.result;
        updateLogoPreview(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  // Apply
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const cfg = {
        url: urlInput?.value || '',
        name: document.getElementById('logoNameInput')?.value || '',
        height: safeInt(heightInput?.value, 16, 48, 20),
      };
      saveLogoConfig(cfg);
      applyLogoToNav(cfg);
      closeDemoAdmin();
    });
  }

  // Remove
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      saveLogoConfig(null);
      applyLogoToNav(null);
      if (urlInput) urlInput.value = '';
      if (document.getElementById('logoNameInput')) document.getElementById('logoNameInput').value = '';
      if (heightInput) heightInput.value = 20;
      updateLogoPreview(null);
      closeDemoAdmin();
    });
  }
})();

init();

// Apply saved logo config on page load (after init)
const savedLogoCfg = readLogoConfig();
if (savedLogoCfg?.url) applyLogoToNav(savedLogoCfg);

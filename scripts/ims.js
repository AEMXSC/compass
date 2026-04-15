/*
 * IMS Authentication Module — S2S via CF Worker
 *
 * S2S (Server-to-Server) via Cloudflare Worker provides:
 * - Instant sign-in on page load (no user interaction)
 * - Valid token for AEM MCP, DA Admin API, and all Adobe APIs
 * - aem_mcp scope for full MCP tool access
 *
 * The S2S token authenticates as a service account. User identity
 * comes from GitHub PAT (stored separately in localStorage).
 */

const IMS_WORKER = localStorage.getItem('ew-ims-proxy')
  || 'https://compass-ims-proxy.compass-xsc.workers.dev';

const PROFILE_STORAGE_KEY = 'ew-ims-profile';
const TOKEN_KEY = 'ew-ims-token';
const EXPIRY_KEY = 'ew-ims-expiry';

let profile = null;
let authMethod = 'none'; // 's2s' | 'none'

/* ─── Token access ─── */

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || null;
}

export function getProfile() {
  if (profile) return profile;
  const cached = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (cached) {
    try { profile = JSON.parse(cached); } catch { /* ignore */ }
  }
  return profile;
}

export function isSignedIn() { return !!getToken(); }
export function getAuthMethod() { return authMethod; }

/* ─── Sign in (S2S via CF Worker) ─── */

export async function signIn() {
  console.log('[IMS] Signing in via S2S Worker...');
  try {
    const resp = await fetch(`${IMS_WORKER}/auth`, { credentials: 'omit' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || 'Auth request failed');
    }
    const data = await resp.json();
    if (!data.access_token) throw new Error('No access token received');

    localStorage.setItem(TOKEN_KEY, data.access_token);
    localStorage.setItem('ew-ims', 'true');
    if (data.expires_at) localStorage.setItem(EXPIRY_KEY, String(data.expires_at));

    authMethod = 's2s';
    console.log('[IMS] S2S token received');
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
    return true;
  } catch (err) {
    console.error('[IMS] Sign-in failed:', err.message);
    return false;
  }
}

/* ─── Sign out ─── */

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('ew-ims');
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  profile = null;
  authMethod = 'none';
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
}

/* ─── Profile (GitHub identity) ─── */

export async function fetchUserProfile() {
  if (profile?.displayName) return profile;

  const ghToken = localStorage.getItem('ew-github-token');
  if (ghToken) {
    try {
      const resp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${ghToken}` },
      });
      if (resp.ok) {
        const gh = await resp.json();
        profile = {
          displayName: gh.name || gh.login || '',
          email: gh.email || '',
          firstName: (gh.name || '').split(' ')[0] || '',
          lastName: (gh.name || '').split(' ').slice(1).join(' ') || '',
          userId: gh.login || '',
          avatar: gh.avatar_url || '',
        };
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
        return profile;
      }
    } catch { /* fall through */ }
  }
  return profile;
}

/* ─── Stubs for import compat ─── */

export function getBookmarkletCode() { return ''; }
export function relaySignIn() { return Promise.reject(new Error('not-implemented')); }
export async function handlePkceCallback() { return false; }

/* ─── Init ─── */

export async function loadIms() {
  // Check for existing token and refresh if expired
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) || 0);
  if (isSignedIn() && expiry && Date.now() > expiry - 300000) {
    console.log('[IMS] S2S token expired — refreshing...');
    await signIn();
  } else if (!isSignedIn()) {
    // Auto-sign-in for seamless experience
    console.log('[IMS] No token — auto-signing in via S2S...');
    await signIn();
  } else {
    authMethod = 's2s';
  }

  if (isSignedIn()) {
    console.log(`[IMS] Ready: method=${authMethod}`);
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
  }

  return { anonymous: !isSignedIn(), method: authMethod };
}

export async function fetchWithToken(url, opts = {}) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const resp = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return resp;
}

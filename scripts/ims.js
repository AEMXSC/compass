/*
 * IMS Authentication Module — Hybrid (S2S + User-Level OAuth)
 *
 * Flow:
 * 1. Page loads → S2S auto-signs in (instant, service account)
 * 2. User clicks Sign In → OAuth popup upgrades to user-level token
 * 3. User-level token gives full AEM author access, audit trails, personal permissions
 *
 * S2S provides baseline MCP access. User-level OAuth provides full access.
 */

const IMS_WORKER = localStorage.getItem('ew-ims-proxy')
  || 'https://compass-ims-proxy.compass-xsc.workers.dev';

const PROFILE_STORAGE_KEY = 'ew-ims-profile';
const TOKEN_KEY = 'ew-ims-token';
const EXPIRY_KEY = 'ew-ims-expiry';
const AUTH_METHOD_KEY = 'ew-ims-method';

let profile = null;
let authMethod = localStorage.getItem(AUTH_METHOD_KEY) || 'none'; // 's2s' | 'user' | 'none'

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

/* ─── S2S Sign In (automatic, service account) ─── */

async function signInS2S() {
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
    localStorage.setItem(AUTH_METHOD_KEY, 's2s');
    if (data.expires_at) localStorage.setItem(EXPIRY_KEY, String(data.expires_at));

    authMethod = 's2s';
    console.log('[IMS] S2S token received');
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: 's2s' } }));
    return true;
  } catch (err) {
    console.error('[IMS] S2S sign-in failed:', err.message);
    return false;
  }
}

/* ─── User-Level OAuth Sign In (click Sign In → popup) ─── */

async function signInOAuth() {
  console.log('[IMS] Opening Adobe sign-in popup...');
  const returnTo = encodeURIComponent(window.location.href);
  const loginUrl = `${IMS_WORKER}/ims/login?return_to=${returnTo}`;
  const w = 500;
  const h = 700;
  const left = Math.round((screen.width - w) / 2);
  const top = Math.round((screen.height - h) / 2);
  const popup = window.open(loginUrl, 'adobeSignIn',
    `width=${w},height=${h},left=${left},top=${top}`);

  if (!popup) {
    console.warn('[IMS] Popup blocked — staying with S2S');
    return false;
  }

  // Wait for the popup to complete and relay the token
  return new Promise((resolve) => {
    // Listen for token from hash (popup redirects back to Compass with #ims_token=...)
    const onStorage = (e) => {
      if (e.key === TOKEN_KEY && e.newValue) {
        cleanup();
        authMethod = 'user';
        localStorage.setItem(AUTH_METHOD_KEY, 'user');
        console.log('[IMS] User-level token received via OAuth popup');
        window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: 'user' } }));
        resolve(true);
      }
    };

    const checkClosed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        // Check if token arrived while popup was closing
        if (authMethod === 'user') {
          resolve(true);
        } else {
          console.log('[IMS] Popup closed — keeping current auth');
          resolve(false);
        }
      }
    }, 500);

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 180000); // 3 minute timeout

    function cleanup() {
      clearInterval(checkClosed);
      clearTimeout(timeout);
      window.removeEventListener('storage', onStorage);
    }

    window.addEventListener('storage', onStorage);
  });
}

/* ─── Public Sign In (called by UI) ─── */

export async function signIn() {
  // If already S2S, upgrade to user-level via OAuth popup
  if (authMethod === 's2s' || authMethod === 'none') {
    const ok = await signInOAuth();
    if (ok) return true;
  }
  // Fallback: S2S
  return signInS2S();
}

/* ─── Sign out ─── */

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('ew-ims');
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  localStorage.removeItem(AUTH_METHOD_KEY);
  profile = null;
  authMethod = 'none';
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
}

/* ─── Profile ─── */

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
  // Check for token from OAuth popup redirect (#ims_token=... in URL hash)
  const hash = window.location.hash;
  if (hash.includes('ims_token=')) {
    const tokenParams = new URLSearchParams(hash.slice(1));
    const token = tokenParams.get('ims_token');
    const expiresIn = tokenParams.get('expires_in');
    const isAuthPopup = tokenParams.get('auth_popup') === '1';
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem('ew-ims', 'true');
      localStorage.setItem(AUTH_METHOD_KEY, 'user');
      if (expiresIn) localStorage.setItem(EXPIRY_KEY, String(Date.now() + Number(expiresIn)));
      authMethod = 'user';
      console.log('[IMS] User-level token from OAuth redirect');
      history.replaceState(null, '', window.location.pathname + window.location.search);

      // If this is the popup window, close it — main window picks up via storage event
      if (isAuthPopup) {
        console.log('[IMS] Auth popup — closing...');
        window.close();
        return { anonymous: false, method: 'user' };
      }
    }
  }

  // Check existing token
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) || 0);
  if (isSignedIn() && expiry && Date.now() > expiry - 300000) {
    // Token expired — refresh with same method
    console.log(`[IMS] Token expired — refreshing (was ${authMethod})...`);
    if (authMethod === 'user') {
      // User token expired — fall back to S2S, user can re-sign-in
      await signInS2S();
    } else {
      await signInS2S();
    }
  } else if (!isSignedIn()) {
    // No token — auto S2S
    console.log('[IMS] No token — auto-signing in via S2S...');
    await signInS2S();
  } else {
    // Existing valid token
    authMethod = localStorage.getItem(AUTH_METHOD_KEY) || 's2s';
    console.log(`[IMS] Existing token: method=${authMethod}`);
  }

  if (isSignedIn()) {
    console.log(`[IMS] Ready: method=${authMethod}`);
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: authMethod } }));
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

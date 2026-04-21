/*
 * IMS Authentication Module — Adobe IMS (Authorization Code Flow via Worker)
 *
 * Flow:
 * 1. Open popup to Worker /ims/login (passes return_to URL)
 * 2. Worker redirects to IMS authorize with response_type=code
 * 3. IMS redirects back to Worker /ims/callback with auth code
 * 4. Worker exchanges code for token (server-side, secret never exposed)
 * 5. Worker redirects popup back to Compass with #ims_token=...
 * 6. Compass parses token from hash, stores in localStorage
 * 7. Main window picks up token via storage event, popup closes
 */

const IMS_WORKER = localStorage.getItem('ew-ims-proxy')
  || 'https://compass-ims-proxy.compass-xsc.workers.dev';

const PROFILE_STORAGE_KEY = 'ew-ims-profile';
const TOKEN_KEY = 'ew-ims-token';
const EXPIRY_KEY = 'ew-ims-expiry';
const AUTH_METHOD_KEY = 'ew-ims-method';

let profile = null;
let authMethod = localStorage.getItem(AUTH_METHOD_KEY) || 'none';

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

/* ─── Build Worker Login URL ─── */

function buildLoginUrl() {
  const returnTo = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({ return_to: returnTo });
  return `${IMS_WORKER}/ims/login?${params}`;
}

/* ─── Sign In (Adobe IMS via Worker authorization_code flow) ─── */

export async function signIn() {
  console.log('[IMS] Opening Adobe sign-in...');

  const authorizeUrl = buildLoginUrl();

  // Open in popup
  const w = 500;
  const h = 700;
  const left = Math.round((screen.width - w) / 2);
  const top = Math.round((screen.height - h) / 2);
  const popup = window.open(authorizeUrl, 'adobeSignIn',
    `width=${w},height=${h},left=${left},top=${top}`);

  if (!popup) {
    // Popup blocked — redirect instead
    console.warn('[IMS] Popup blocked — redirecting to Adobe sign-in');
    window.location.href = authorizeUrl;
    return true;
  }

  // Wait for token via storage event (popup writes to same-origin localStorage)
  return new Promise((resolve) => {
    const onStorage = (e) => {
      if (e.key === TOKEN_KEY && e.newValue) {
        cleanup();
        authMethod = 'user';
        localStorage.setItem(AUTH_METHOD_KEY, 'user');
        console.log('[IMS] User token received via popup');
        window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: 'user' } }));
        resolve(true);
      }
    };

    const checkClosed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        if (isSignedIn() && authMethod === 'user') {
          resolve(true);
        } else {
          console.log('[IMS] Popup closed without sign-in');
          resolve(false);
        }
      }
    }, 500);

    const timeout = setTimeout(() => { cleanup(); resolve(false); }, 180000);

    function cleanup() {
      clearInterval(checkClosed);
      clearTimeout(timeout);
      window.removeEventListener('storage', onStorage);
    }

    window.addEventListener('storage', onStorage);
  });
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
  // Check for token from Worker callback (#ims_token=... in URL hash)
  const hash = window.location.hash;
  if (hash.includes('ims_token=')) {
    const tokenParams = new URLSearchParams(hash.slice(1));
    const token = tokenParams.get('ims_token');
    const expiresIn = tokenParams.get('expires_in');
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem('ew-ims', 'true');
      localStorage.setItem(AUTH_METHOD_KEY, 'user');
      if (expiresIn) localStorage.setItem(EXPIRY_KEY, String(Date.now() + Number(expiresIn)));
      authMethod = 'user';
      console.log('[IMS] Token received from IMS redirect');
      // Clean the hash from URL
      history.replaceState(null, '', window.location.pathname + window.location.search);

      // If this is a popup, close it — main window picks up via storage event
      if (window.opener) {
        console.log('[IMS] Popup — closing');
        window.close();
        return { anonymous: false, method: 'user' };
      }
    }
  }

  if (hash.includes('error=')) {
    const errorParams = new URLSearchParams(hash.slice(1));
    console.error(`[IMS] Auth error: ${errorParams.get('error')}`);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // Check existing token
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) || 0);
  if (isSignedIn() && expiry && Date.now() > expiry - 300000) {
    // Token expired — clear and require re-sign-in
    console.log('[IMS] Token expired — sign in again');
    signOut();
  } else if (isSignedIn()) {
    authMethod = localStorage.getItem(AUTH_METHOD_KEY) || 'user';
    console.log(`[IMS] Existing token: method=${authMethod}`);
  }

  if (isSignedIn()) {
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

/*
 * IMS Authentication Module — Adobe IMS (Implicit Flow)
 *
 * Matches the EXCAT/Sliccy auth pattern:
 * 1. Build IMS authorize URL with client_id + redirect_uri
 * 2. Open in popup (or redirect)
 * 3. IMS returns token in URL hash (#access_token=...)
 * 4. Parse token from hash, store in localStorage
 *
 * No CF Worker needed for auth. Token comes directly from Adobe IMS.
 */

const IMS_CLIENT_ID = '11f136d2a27aba7a99dc6d31159f4311';
const IMS_SCOPE = 'openid,AdobeID,additional_info.projectedProductContext,additional_info.ownerOrg,read_organizations,aem.frontend.all';
const IMS_AUTHORIZE_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';

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

/* ─── Build IMS Authorize URL ─── */

function buildAuthorizeUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    scope: IMS_SCOPE,
    response_type: 'token',
    redirect_uri: redirectUri,
    code_challenge_method: 'plain',
    use_ms_for_expiry: 'true',
  });
  return `${IMS_AUTHORIZE_URL}?${params}`;
}

/* ─── Sign In (Adobe IMS popup — implicit flow) ─── */

export async function signIn() {
  console.log('[IMS] Opening Adobe sign-in...');

  // The redirect_uri is the current page — IMS returns #access_token=... in the hash
  const redirectUri = window.location.origin + window.location.pathname;
  const authorizeUrl = buildAuthorizeUrl(redirectUri);

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
  // Check for token from IMS redirect (#access_token=... in URL hash)
  const hash = window.location.hash;
  if (hash.includes('access_token=')) {
    const tokenParams = new URLSearchParams(hash.slice(1));
    const token = tokenParams.get('access_token');
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

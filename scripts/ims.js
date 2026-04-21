/*
 * IMS Authentication Module — Adobe IMS (PKCE Authorization Code Flow)
 *
 * Pure client-side auth — no Worker needed:
 * 1. Generate PKCE code_verifier + code_challenge
 * 2. Open popup to IMS authorize (redirect_uri = this page)
 * 3. IMS redirects popup back with ?code=...
 * 4. Exchange code for token using code_verifier (no client_secret)
 * 5. Store token in localStorage, popup closes
 * 6. Main window picks up token via storage event
 */

const IMS_AUTHORIZE_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const IMS_SCOPE = 'openid,AdobeID,additional_info.projectedProductContext,additional_info.ownerOrg,read_organizations,aem.frontend.all';

// Will be updated when you create the new OAuth Single-Page App credential
const IMS_CLIENT_ID = 'aem-extension-builder';

const PROFILE_STORAGE_KEY = 'ew-ims-profile';
const TOKEN_KEY = 'ew-ims-token';
const EXPIRY_KEY = 'ew-ims-expiry';
const AUTH_METHOD_KEY = 'ew-ims-method';
const VERIFIER_KEY = 'ew-pkce-verifier';

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

/* ─── PKCE Helpers ─── */

function generateVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64url(array);
}

async function computeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(hash));
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ─── Sign In (PKCE popup flow) ─── */

export async function signIn() {
  console.log('[IMS] Opening Adobe sign-in (PKCE)...');

  // Open popup IMMEDIATELY (must be synchronous from user click or browser blocks it)
  const w = 500;
  const h = 700;
  const left = Math.round((screen.width - w) / 2);
  const top = Math.round((screen.height - h) / 2);
  const popup = window.open('about:blank', 'adobeSignIn',
    `width=${w},height=${h},left=${left},top=${top}`);

  // Generate PKCE pair (async — but popup is already open)
  const codeVerifier = generateVerifier();
  const codeChallenge = await computeChallenge(codeVerifier);

  // Store verifier for the callback (sessionStorage so popup can read it)
  sessionStorage.setItem(VERIFIER_KEY, codeVerifier);

  const redirectUri = window.location.origin + window.location.pathname;

  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    scope: IMS_SCOPE,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authorizeUrl = `${IMS_AUTHORIZE_URL}?${params}`;

  if (!popup) {
    // Popup was blocked — redirect the page instead
    console.warn('[IMS] Popup blocked — redirecting');
    window.location.href = authorizeUrl;
    return true;
  }

  // Navigate the already-open popup to IMS
  popup.location.href = authorizeUrl;

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
  sessionStorage.removeItem(VERIFIER_KEY);
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

/* ─── Init (handles auth callback in popup) ─── */

export async function loadIms() {
  const url = new URL(window.location.href);

  // Handle PKCE callback: IMS redirected back with ?code=...
  const code = url.searchParams.get('code');
  if (code) {
    console.log('[IMS] Auth callback — exchanging code for token...');
    const codeVerifier = sessionStorage.getItem(VERIFIER_KEY);
    if (!codeVerifier) {
      console.error('[IMS] No code_verifier in sessionStorage — cannot exchange');
    } else {
      try {
        const redirectUri = url.origin + url.pathname;
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: IMS_CLIENT_ID,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        });

        const tokenResp = await fetch(IMS_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });

        if (tokenResp.ok) {
          const data = await tokenResp.json();
          if (data.access_token) {
            localStorage.setItem(TOKEN_KEY, data.access_token);
            localStorage.setItem('ew-ims', 'true');
            localStorage.setItem(AUTH_METHOD_KEY, 'user');
            if (data.expires_in) {
              localStorage.setItem(EXPIRY_KEY, String(Date.now() + Number(data.expires_in)));
            }
            authMethod = 'user';
            sessionStorage.removeItem(VERIFIER_KEY);
            console.log('[IMS] Token received via PKCE exchange');

            // Clean URL (remove ?code= from address bar)
            history.replaceState(null, '', url.pathname);

            // If this is a popup, close it — main window picks up via storage event
            if (window.opener) {
              console.log('[IMS] Popup — closing');
              window.close();
              return { anonymous: false, method: 'user' };
            }
          }
        } else {
          const errText = await tokenResp.text();
          console.error(`[IMS] Token exchange failed (${tokenResp.status}):`, errText);
        }
      } catch (err) {
        console.error('[IMS] Token exchange error:', err);
      }
    }

    // Clean URL even on failure
    history.replaceState(null, '', url.pathname);
  }

  // Handle error callback
  const error = url.searchParams.get('error');
  if (error) {
    console.error(`[IMS] Auth error: ${error} — ${url.searchParams.get('error_description') || ''}`);
    history.replaceState(null, '', url.pathname);
  }

  // Handle legacy hash-based token (Worker callback fallback)
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
      history.replaceState(null, '', url.pathname);
      if (window.opener) { window.close(); return { anonymous: false, method: 'user' }; }
    }
  }

  // Check existing token expiry
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) || 0);
  if (isSignedIn() && expiry && Date.now() > expiry - 300000) {
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

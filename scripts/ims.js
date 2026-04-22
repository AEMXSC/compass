/*
 * IMS Authentication Module — Hybrid (imslib + direct authorize)
 *
 * Uses imslib for: token validation, auto-refresh, profile, sign-out
 * Uses direct IMS authorize URL for: sign-in popup
 *
 * Why hybrid: imslib's signIn() fails to construct the authorize URL
 * for aem-extension-builder from .aem.page origins (onError: 'http').
 * But the direct authorize URL works (confirmed 302 → login page).
 * imslib still handles token lifecycle after the initial sign-in.
 *
 * Client ID: aem-extension-builder (EDS origins registered by Zoran)
 */

const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_AUTHORIZE_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const IMS_CLIENT_ID = 'aem-extension-builder';
const IMS_SCOPE = 'AdobeID,openid,read_organizations,additional_info.projectedProductContext';
const IMS_TIMEOUT = 8000;

const PROFILE_STORAGE_KEY = 'ew-ims-profile';
const TOKEN_KEY = 'ew-ims-token';
const EXPIRY_KEY = 'ew-ims-expiry';
const AUTH_METHOD_KEY = 'ew-ims-method';

let profile = null;
let imsReady = false;
let authMethod = localStorage.getItem(AUTH_METHOD_KEY) || 'none';

/* ─── Token access ─── */

export function getToken() {
  if (imsReady && window.adobeIMS) {
    const t = window.adobeIMS.getAccessToken();
    if (t?.token) return t.token;
  }
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

/* ─── Script loader ─── */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

/* ─── Profile sync from imslib ─── */

function _syncProfile() {
  if (!window.adobeIMS) return;
  window.adobeIMS.getProfile().then((p) => {
    if (p) {
      profile = {
        displayName: p.name || p.displayName || '',
        email: p.email || '',
        firstName: p.first_name || (p.name || '').split(' ')[0] || '',
        lastName: p.last_name || (p.name || '').split(' ').slice(1).join(' ') || '',
        userId: p.userId || '',
        avatar: '',
      };
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    }
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: 'user' } }));
  }).catch(() => {
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: 'user' } }));
  });
}

/* ─── Sign In (direct authorize URL — imslib signIn fails for this client) ─── */

export async function signIn() {
  const redirectUri = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    scope: IMS_SCOPE,
    response_type: 'code',
    redirect_uri: redirectUri,
  });
  const authorizeUrl = `${IMS_AUTHORIZE_URL}?${params}`;

  // Open popup synchronously from click context (avoids browser blocking)
  const w = 500;
  const h = 700;
  const left = Math.round((screen.width - w) / 2);
  const top = Math.round((screen.height - h) / 2);
  const popup = window.open(authorizeUrl, 'adobeSignIn',
    `width=${w},height=${h},left=${left},top=${top}`);

  if (!popup) {
    console.warn('[IMS] Popup blocked — redirecting');
    window.location.href = authorizeUrl;
    return true;
  }

  // Wait for token via storage event (popup writes to localStorage on callback)
  return new Promise((resolve) => {
    const onStorage = (e) => {
      if (e.key === TOKEN_KEY && e.newValue) {
        cleanup();
        authMethod = 'user';
        localStorage.setItem(AUTH_METHOD_KEY, 'user');
        _syncProfile();
        resolve(true);
      }
    };

    const checkClosed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        resolve(isSignedIn());
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
  if (imsReady && window.adobeIMS) {
    window.adobeIMS.signOut();
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('ew-ims');
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  localStorage.removeItem(AUTH_METHOD_KEY);
  profile = null;
  authMethod = 'none';
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
}

/* ─── Profile (GitHub fallback) ─── */

export async function fetchUserProfile() {
  if (profile?.displayName) return profile;

  // Try imslib profile
  if (imsReady && window.adobeIMS) {
    try {
      const p = await window.adobeIMS.getProfile();
      if (p?.name || p?.displayName) {
        profile = {
          displayName: p.name || p.displayName || '',
          email: p.email || '',
          firstName: p.first_name || (p.name || '').split(' ')[0] || '',
          lastName: p.last_name || (p.name || '').split(' ').slice(1).join(' ') || '',
          userId: p.userId || '',
          avatar: '',
        };
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
        return profile;
      }
    } catch { /* fall through */ }
  }

  // Fallback: GitHub identity
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

/* ─── Handle IMS callback (?code= in URL from authorize redirect) ─── */

async function handleCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return false;

  // Exchange code for token via imslib if available, or store directly
  // IMS redirected back with ?code= — imslib should pick this up via autoValidateToken
  // Clean the URL so the code isn't visible
  history.replaceState(null, '', url.pathname);

  // If imslib is handling this (it intercepts ?code= on load), just return
  // The onAccessToken callback will fire when imslib processes the code
  return true;
}

/* ─── Init: Load imslib ─── */

export async function loadIms() {
  // Check for IMS callback first
  await handleCallback();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[IMS] imslib timeout');
      resolve({ anonymous: true, method: 'none' });
    }, IMS_TIMEOUT);

    const redirectUri = window.location.origin + window.location.pathname;

    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      locale: 'en_US',
      autoValidateToken: true,
      environment: 'prod',
      useLocalStorage: true,
      modalMode: true,
      redirect_uri: redirectUri,

      onReady: () => {
        clearTimeout(timeout);
        imsReady = true;
        const token = window.adobeIMS.getAccessToken();
        if (token?.token) {
          authMethod = 'user';
          localStorage.setItem(AUTH_METHOD_KEY, 'user');
          localStorage.setItem(TOKEN_KEY, token.token);
          console.debug('[IMS] Signed in (existing token)');
          _syncProfile();
          resolve({ anonymous: false, method: 'user' });
        } else {
          console.debug('[IMS] Ready — not signed in');
          resolve({ anonymous: true, method: 'none' });
        }
      },

      onAccessToken: (tokenInfo) => {
        authMethod = 'user';
        localStorage.setItem(AUTH_METHOD_KEY, 'user');
        if (tokenInfo?.token) {
          localStorage.setItem(TOKEN_KEY, tokenInfo.token);
        }
        console.debug('[IMS] Sign-in complete');
        _syncProfile();

        // If this is a popup, close it — main window picks up via storage event
        if (window.opener) {
          window.close();
        }
      },

      onAccessTokenHasExpired: () => {
        console.debug('[IMS] Token expired');
        authMethod = 'none';
        localStorage.removeItem(AUTH_METHOD_KEY);
        localStorage.removeItem(TOKEN_KEY);
        window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
      },

      onError: (e) => {
        clearTimeout(timeout);
        console.warn('[IMS] imslib error:', e);
        // Don't resolve as failure — imslib may still work for token management
        // even if initial validation fails. Resolve as not-signed-in.
        imsReady = true;
        resolve({ anonymous: true, method: 'none' });
      },
    };

    loadScript(IMS_LIB_URL).catch(() => {
      clearTimeout(timeout);
      console.warn('[IMS] Failed to load imslib');
      resolve({ anonymous: true, method: 'none' });
    });
  });
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

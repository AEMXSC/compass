/*
 * IMS Authentication Module — Adobe imslib (recommended pattern)
 *
 * Uses Adobe's official browser auth library (imslib.min.js):
 * 1. Load imslib from auth.services.adobe.com
 * 2. Configure window.adobeid with client_id + callbacks
 * 3. imslib handles: login popup, token storage, refresh, profile
 *
 * Client ID: aem-extension-builder (registered for Compass EDS origins)
 */

const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_CLIENT_ID = 'aem-extension-builder';
const IMS_SCOPE = 'AdobeID,openid,read_organizations,additional_info.projectedProductContext,additional_info.ownerOrg,aem.frontend.all';
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

/* ─── Profile fetch from imslib ─── */

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

/* ─── Sign In ─── */

export async function signIn() {
  if (imsReady && window.adobeIMS) {
    // imslib handles the popup internally (modalMode: true)
    window.adobeIMS.signIn();
    return true;
  }
  console.warn('[IMS] imslib not ready — cannot sign in');
  return false;
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

  // Try imslib profile first
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
    } catch { /* fall through to GitHub */ }
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

/* ─── Init: Load imslib ─── */

export async function loadIms() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[IMS] imslib timeout');
      resolve({ anonymous: true, method: 'none' });
    }, IMS_TIMEOUT);

    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      locale: 'en_US',
      autoValidateToken: true,
      environment: 'prod',
      useLocalStorage: true,
      modalMode: true,

      onReady: () => {
        clearTimeout(timeout);
        imsReady = true;
        const token = window.adobeIMS.getAccessToken();
        if (token?.token) {
          authMethod = 'user';
          localStorage.setItem(AUTH_METHOD_KEY, 'user');
          console.debug('[IMS] Signed in (existing token)');
          _syncProfile();
          resolve({ anonymous: false, method: 'user' });
        } else {
          console.debug('[IMS] Ready — not signed in');
          resolve({ anonymous: true, method: 'none' });
        }
      },

      onAccessToken: () => {
        authMethod = 'user';
        localStorage.setItem(AUTH_METHOD_KEY, 'user');
        console.debug('[IMS] Sign-in complete');
        _syncProfile();
      },

      onAccessTokenHasExpired: () => {
        console.debug('[IMS] Token expired');
        authMethod = 'none';
        localStorage.removeItem(AUTH_METHOD_KEY);
        window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
      },

      onError: (e) => {
        clearTimeout(timeout);
        console.warn('[IMS] Error:', e);
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

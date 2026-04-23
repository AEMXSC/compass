/**
 * IMS Authentication Module — imslib redirect flow
 *
 * Matches the aemcoder.adobe.io pattern exactly:
 * - imslib.min.js loaded from auth.services.adobe.com
 * - window.adobeid configured with client_id + callbacks
 * - signIn() calls window.adobeIMS.signIn() (full-page redirect, no popup)
 * - imslib handles token lifecycle: validate, refresh, profile, sign-out
 * - On return from IMS, imslib auto-validates and fires onReady with token
 *
 * Client ID: aem-extension-builder (EDS origins registered)
 *
 * @see aemcoder.adobe.io runtime-config.js for reference pattern
 */

/* ─── Constants ─── */

const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_CLIENT_ID = 'aem-extension-builder';
const IMS_SCOPE = 'AdobeID,openid,read_organizations,additional_info.projectedProductContext';
const IMSLIB_INIT_TIMEOUT_MS = 10000;

const STORAGE_KEYS = Object.freeze({
  TOKEN: 'ew-ims-token',
  EXPIRY: 'ew-ims-expiry',
  PROFILE: 'ew-ims-profile',
  METHOD: 'ew-ims-method',
});

/* ─── Module state ─── */

let profile = null;
let imsReady = false;
let authMethod = localStorage.getItem(STORAGE_KEYS.METHOD) || 'none';

/* ─── Public API: Token access ─── */

export function getToken() {
  // Prefer imslib's managed token (auto-refreshed)
  if (imsReady && window.adobeIMS) {
    const t = window.adobeIMS.getAccessToken();
    if (t?.token) return t.token;
  }
  return localStorage.getItem(STORAGE_KEYS.TOKEN) || null;
}

export function isSignedIn() { return !!getToken(); }
export function getAuthMethod() { return authMethod; }

export function getProfile() {
  if (profile) return profile;
  const cached = localStorage.getItem(STORAGE_KEYS.PROFILE);
  if (cached) {
    try { profile = JSON.parse(cached); } catch { /* corrupt — ignore */ }
  }
  return profile;
}

/* ─── Public API: Sign in (imslib redirect — no popup) ─── */

export async function signIn() {
  if (imsReady && window.adobeIMS) {
    // imslib handles redirect to IMS login page and back.
    // The full page reloads after auth — imslib picks up the token on return.
    window.adobeIMS.signIn();
    return true;
  }
  console.warn('[IMS] imslib not ready — cannot sign in');
  return false;
}

/* ─── Public API: Sign out ─── */

export function signOut() {
  if (imsReady && window.adobeIMS) {
    window.adobeIMS.signOut();
  }
  Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  profile = null;
  authMethod = 'none';
  dispatchAuthEvent(false);
}

/* ─── Public API: Profile ─── */

export async function fetchUserProfile() {
  if (profile?.displayName) return profile;

  // Adobe IMS profile (via imslib)
  if (imsReady && window.adobeIMS) {
    try {
      const p = await window.adobeIMS.getProfile();
      if (p?.name || p?.displayName || p?.email) {
        profile = buildAdobeProfile(p);
        localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
        return profile;
      }
    } catch { /* imslib profile unavailable — try GitHub */ }
  }

  // GitHub identity fallback
  const ghToken = localStorage.getItem('ew-github-token');
  if (ghToken) {
    try {
      const resp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${ghToken}` },
      });
      if (resp.ok) {
        const gh = await resp.json();
        profile = buildGitHubProfile(gh);
        localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
        return profile;
      }
    } catch { /* GitHub unavailable */ }
  }

  return profile;
}

/* ─── Public API: Authenticated fetch ─── */

export async function fetchWithToken(url, opts = {}) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated — call signIn() first');
  const resp = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return resp;
}

/* ─── Public API: Init ─── */

export async function loadIms() {
  return new Promise((resolve) => {
    const initTimeout = setTimeout(() => {
      console.warn('[IMS] imslib init timeout');
      imsReady = true; // Mark ready even on timeout so signIn can be attempted
      resolve({ anonymous: true, method: 'none' });
    }, IMSLIB_INIT_TIMEOUT_MS);

    // Configure imslib — matches aemcoder.adobe.io pattern:
    // NO modalMode (uses full-page redirect, not popup)
    // autoValidateToken picks up token from IMS redirect on return
    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      locale: document.documentElement.lang?.replace('-', '_') || 'en_US',
      autoValidateToken: true,
      environment: 'prod',
      useLocalStorage: true,

      onReady: () => {
        clearTimeout(initTimeout);
        imsReady = true;
        const token = window.adobeIMS.getAccessToken();
        if (token?.token) {
          setAuthState('user', token.token);
          syncImsProfile();
          resolve({ anonymous: false, method: 'user' });
        } else {
          resolve({ anonymous: true, method: 'none' });
        }
      },

      onAccessToken: (tokenInfo) => {
        setAuthState('user', tokenInfo?.token);
        syncImsProfile();
      },

      onReauthAccessToken: (tokenInfo) => {
        // Token was silently refreshed by imslib
        setAuthState('user', tokenInfo?.token);
      },

      onAccessTokenHasExpired: () => {
        authMethod = 'none';
        localStorage.removeItem(STORAGE_KEYS.METHOD);
        localStorage.removeItem(STORAGE_KEYS.TOKEN);
        dispatchAuthEvent(false);
      },

      onError: (err) => {
        clearTimeout(initTimeout);
        console.warn('[IMS] imslib error:', err);
        imsReady = true;
        resolve({ anonymous: true, method: 'none' });
      },
    };

    loadScript(IMS_LIB_URL).catch(() => {
      clearTimeout(initTimeout);
      console.warn('[IMS] Failed to load imslib');
      imsReady = true;
      resolve({ anonymous: true, method: 'none' });
    });
  });
}

/* ─── Internal helpers ─── */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) {
      resolve();
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = reject;
    document.head.append(el);
  });
}

function setAuthState(method, token) {
  authMethod = method;
  localStorage.setItem(STORAGE_KEYS.METHOD, method);
  if (token) localStorage.setItem(STORAGE_KEYS.TOKEN, token);
}

function dispatchAuthEvent(signedIn) {
  window.dispatchEvent(
    new CustomEvent('ew-auth-change', { detail: { signedIn, method: authMethod } }),
  );
}

function syncImsProfile() {
  if (!window.adobeIMS) return;
  window.adobeIMS.getProfile()
    .then((p) => {
      if (p) {
        profile = buildAdobeProfile(p);
        localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
      }
      dispatchAuthEvent(true);
    })
    .catch(() => dispatchAuthEvent(true));
}

function buildAdobeProfile(p) {
  return {
    displayName: p.name || p.displayName || '',
    email: p.email || p.emailAddress || p.userId || '',
    firstName: p.first_name || (p.name || '').split(' ')[0] || '',
    lastName: p.last_name || (p.name || '').split(' ').slice(1).join(' ') || '',
    userId: p.userId || '',
    avatar: '',
  };
}

function buildGitHubProfile(gh) {
  return {
    displayName: gh.name || gh.login || '',
    email: gh.email || '',
    firstName: (gh.name || '').split(' ')[0] || '',
    lastName: (gh.name || '').split(' ').slice(1).join(' ') || '',
    userId: gh.login || '',
    avatar: gh.avatar_url || '',
  };
}

/**
 * IMS Authentication Module
 *
 * Hybrid approach: imslib handles token lifecycle (validation, refresh, profile,
 * sign-out) while sign-in uses a direct IMS authorize URL in a popup.
 *
 * Why hybrid: imslib.signIn() cannot construct the authorize URL for the
 * `aem-extension-builder` client from `.aem.page` origins (returns onError: 'http').
 * The direct authorize URL works correctly (302 → Adobe login page). Once the user
 * authenticates, imslib picks up the token via its autoValidateToken flow.
 *
 * @see https://developer.adobe.com/developer-console/docs/guides/authentication/
 */

/* ─── Constants ─── */

const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_AUTHORIZE_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const IMS_CLIENT_ID = 'aem-extension-builder';
const IMS_SCOPE = 'AdobeID,openid,read_organizations,additional_info.projectedProductContext';

const IMSLIB_INIT_TIMEOUT_MS = 8000;
const POPUP_TIMEOUT_MS = 180000;
const POPUP_POLL_MS = 500;
const POPUP_WIDTH = 500;
const POPUP_HEIGHT = 700;

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
    try { profile = JSON.parse(cached); } catch { /* corrupt cache — ignore */ }
  }
  return profile;
}

/* ─── Public API: Sign in ─── */

export async function signIn() {
  const redirectUri = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    scope: IMS_SCOPE,
    response_type: 'code',
    redirect_uri: redirectUri,
    state: crypto.randomUUID(),
  });
  const authorizeUrl = `${IMS_AUTHORIZE_URL}?${params}`;

  // Open popup synchronously from click handler to avoid browser blocking.
  const left = Math.round((screen.width - POPUP_WIDTH) / 2);
  const top = Math.round((screen.height - POPUP_HEIGHT) / 2);
  const popup = window.open(
    authorizeUrl,
    'adobeSignIn',
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`,
  );

  if (!popup) {
    // Popup blocked — fall back to full-page redirect.
    console.warn('[IMS] Popup blocked, redirecting to IMS');
    window.location.href = authorizeUrl;
    return true;
  }

  return waitForPopupToken(popup);
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
      if (p?.name || p?.displayName) {
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
  // If IMS redirected back with ?code=, clean the URL before imslib loads.
  // imslib's autoValidateToken will process the code from its own internal state.
  cleanCallbackParams();

  return new Promise((resolve) => {
    const initTimeout = setTimeout(() => {
      console.warn('[IMS] imslib init timeout');
      resolve({ anonymous: true, method: 'none' });
    }, IMSLIB_INIT_TIMEOUT_MS);

    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      locale: 'en_US',
      autoValidateToken: true,
      environment: 'prod',
      useLocalStorage: true,
      modalMode: true,
      redirect_uri: window.location.origin + window.location.pathname,

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
        // In a popup, close after storing token — main window detects via storage event.
        if (window.opener) window.close();
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
        // Mark imslib as ready even on error — it may still handle token refresh.
        imsReady = true;
        resolve({ anonymous: true, method: 'none' });
      },
    };

    loadScript(IMS_LIB_URL).catch(() => {
      clearTimeout(initTimeout);
      console.warn('[IMS] Failed to load imslib');
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
    email: p.email || '',
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

function cleanCallbackParams() {
  const url = new URL(window.location.href);
  if (url.searchParams.has('code') || url.searchParams.has('error')) {
    url.searchParams.delete('code');
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    history.replaceState(null, '', url.pathname + url.search);
  }
}

function waitForPopupToken(popup) {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(result) {
      if (resolved) return;
      resolved = true;
      clearInterval(pollId);
      clearTimeout(timeoutId);
      window.removeEventListener('storage', onStorage);
      resolve(result);
    }

    function onStorage(e) {
      if (e.key === STORAGE_KEYS.TOKEN && e.newValue) {
        setAuthState('user', e.newValue);
        syncImsProfile();
        finish(true);
      }
    }

    const pollId = setInterval(() => {
      if (popup.closed) finish(isSignedIn());
    }, POPUP_POLL_MS);

    const timeoutId = setTimeout(() => finish(false), POPUP_TIMEOUT_MS);

    window.addEventListener('storage', onStorage);
  });
}

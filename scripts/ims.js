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
const IMS_REDIRECT_URI = 'https://eds-migration--compass--aemxsc.aem.page/';
const IMS_WORKER = localStorage.getItem('ew-ims-proxy') || 'https://compass-ims-proxy.compass-xsc.workers.dev';
const IMSLIB_INIT_TIMEOUT_MS = 3000;

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
let activeOrg = null;   // { id, name, type }
let userOrgs = [];       // [{ id, name, type }, ...]

/* ─── Public API: Token access ─── */

export function getToken() {
  // 1. imslib managed token (best — auto-refreshed)
  if (imsReady && window.adobeIMS) {
    const t = window.adobeIMS.getAccessToken();
    if (t?.token) return t.token;
  }
  // 2. imslib localStorage directly (timing/tracking prevention fallback)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('adobeid_ims_access_token') && key.includes(IMS_CLIENT_ID)) {
        const parsed = JSON.parse(localStorage.getItem(key));
        const token = parsed?.tokenValue || parsed?.token || parsed?.access_token;
        const expiry = parsed?.expire ? new Date(parsed.expire).getTime() : (parsed?.expiry || 0);
        if (token && (!expiry || Date.now() < expiry)) {
          return token;
        }
      }
    }
  } catch { /* */ }
  // 3. Stored token (from S2S or prior sign-in)
  return localStorage.getItem(STORAGE_KEYS.TOKEN) || null;
}

// Ensure a token is available — fetches S2S if nothing else works
export async function ensureToken() {
  if (getToken()) return getToken();
  // Auto-fetch S2S as last resort
  try {
    const resp = await fetch(`${IMS_WORKER}/auth`, { credentials: 'omit' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.access_token) {
        localStorage.setItem(STORAGE_KEYS.TOKEN, data.access_token);
        return data.access_token;
      }
    }
  } catch { /* */ }
  return null;
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

export function getActiveOrg() { return activeOrg; }
export function getUserOrgs() { return userOrgs; }

/* ─── Public API: Sign in (imslib redirect — no popup) ─── */

export async function signIn() {
  if (imsReady && window.adobeIMS) {
    window.adobeIMS.signIn();
    return true;
  }
  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    scope: IMS_SCOPE,
    response_type: 'token',
    redirect_uri: IMS_REDIRECT_URI,
  });
  window.location.href = `https://ims-na1.adobelogin.com/ims/authorize/v2?${params}`;
  return true;
}

const MCP_LOCAL_SERVER = 'http://localhost';

/**
 * MCP OAuth — get a write-capable token for Content MCP.
 *
 * Delegates to the local aem-connect-server (same pattern Claude Code uses):
 *   1. Compass fetches http://localhost/token
 *   2. If server has a valid token → returns it immediately
 *   3. If not → server opens the OAuth browser flow, Compass polls until token arrives
 *
 * Chrome allows HTTPS pages to fetch http://localhost (localhost is a trusted origin,
 * exempt from mixed-content blocking per the W3C spec).
 *
 * Requires aem-connect-server.mjs running on the user's machine.
 * Setup: run scripts/start-aem-connect.bat once (handles netsh permissions).
 */
export async function signInMcpOAuth() {
  // 1. Check if local server is up
  let serverStatus;
  try {
    const resp = await fetch(`${MCP_LOCAL_SERVER}/status`, { signal: AbortSignal.timeout(2000) });
    serverStatus = await resp.json();
  } catch {
    console.warn('[MCP-OAuth] Local server not running — falling back to manual flow');
    return signInMcpOAuthManual();
  }

  // 2. Server is up — request token (triggers OAuth if expired)
  try {
    const resp = await fetch(`${MCP_LOCAL_SERVER}/token`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();

    if (data.access_token) {
      // Server already had a valid token
      localStorage.setItem('ew-mcp-token', data.access_token);
      console.log('[MCP-OAuth] Token from local server');
      return data.access_token;
    }

    if (data.status === 'auth_required') {
      // Server opened the browser — poll until the user completes auth
      console.log('[MCP-OAuth] Auth flow started, polling...');
      return pollLocalServerForToken();
    }
  } catch {
    return signInMcpOAuthManual();
  }
  return null;
}

async function pollLocalServerForToken(maxWaitMs = 180_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const resp = await fetch(`${MCP_LOCAL_SERVER}/token`, { signal: AbortSignal.timeout(3000) });
      const data = await resp.json();
      if (data.access_token) {
        localStorage.setItem('ew-mcp-token', data.access_token);
        console.log('[MCP-OAuth] Token acquired via local server');
        return data.access_token;
      }
    } catch { /* keep polling */ }
  }
  return null;
}

/**
 * Fallback: instruct user to start the local server.
 * Opens instructions in a toast rather than silently failing.
 */
async function signInMcpOAuthManual() {
  window.dispatchEvent(new CustomEvent('ew-mcp-server-missing'));
  return null;
}

export function getMcpToken() {
  return localStorage.getItem('ew-mcp-token') || null;
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
  // Handle return from Worker popup sign-in (token in hash)
  const hash = window.location.hash;
  if (hash.includes('ims_token=') || hash.includes('access_token=')) {
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get('ims_token') || params.get('access_token');
    const expiresIn = params.get('expires_in');
    const isPopup = params.get('auth_popup');

    if (token) {
      if (isPopup && window.opener) {
        // We're in the popup — relay token to opener and close
        window.opener.postMessage({ type: 'ew-ims-relay', token, expires_in: expiresIn }, '*');
        window.close();
        return { anonymous: false, method: 'user' };
      }
      // Direct return (not popup) — save token
      localStorage.setItem(STORAGE_KEYS.TOKEN, token);
      localStorage.setItem(STORAGE_KEYS.METHOD, 'user');
      if (expiresIn) localStorage.setItem(STORAGE_KEYS.EXPIRY, String(Date.now() + Number(expiresIn) * 1000));
      authMethod = 'user';
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  // Clean up stale darkalley tokens (we now use aem-extension-builder)
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('darkalley')) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch { /* */ }

  return new Promise((resolve) => {
    const initTimeout = setTimeout(() => {
      console.warn('[IMS] imslib init timeout');
      imsReady = true;
      resolve({ anonymous: true, method: 'none' });
    }, IMSLIB_INIT_TIMEOUT_MS);

    // Configure imslib — redirect flow (same as AEMcoder)
    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      redirect_uri: IMS_REDIRECT_URI,
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
          // imslib loaded but no valid token — user needs to sign in
          console.log('[IMS] imslib ready but no token — sign in required');
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
      // Fetch orgs from IMS REST API (same pattern as da.live/nx)
      return fetchOrgsFromIms();
    })
    .then(() => dispatchAuthEvent(true))
    .catch(() => dispatchAuthEvent(true));
}

async function fetchOrgsFromIms() {
  const token = getToken();
  if (!token) return;

  // Strategy 1: IMS organizations/v5 endpoint (da.live pattern)
  try {
    const resp = await fetch(
      `https://ims-na1.adobelogin.com/ims/organizations/v5?client_id=${IMS_CLIENT_ID}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (resp.ok) {
      const orgs = await resp.json();
      if (Array.isArray(orgs) && orgs.length > 0) {
        userOrgs = orgs.map((o) => ({
          id: o.orgRef?.ident || o.orgId || '',
          name: o.orgName || o.name || '',
          active: !!o.current,
        }));
        activeOrg = userOrgs.find((o) => o.active) || userOrgs[0] || null;
        return;
      }
    }
  } catch { /* endpoint not available for this scope */ }

  // Strategy 2: imslib getOrganizations()
  try {
    const orgs = await window.adobeIMS.getOrganizations();
    if (Array.isArray(orgs) && orgs.length > 0) {
      userOrgs = orgs.map((o) => ({
        id: o.org || o.id || '',
        name: o.org_name || o.name || o.org || '',
        active: !!o.active,
      }));
      activeOrg = userOrgs.find((o) => o.active) || userOrgs[0] || null;
      return;
    }
  } catch { /* imslib method failed */ }

  // Strategy 3: decode org from the IMS access token
  try {
    if (token && token.includes('.')) {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const orgId = payload.as || '';
      if (orgId.includes('@AdobeOrg')) {
        userOrgs = [{ id: orgId, name: orgId.split('@')[0], active: true }];
        activeOrg = userOrgs[0];
      }
    }
  } catch { /* token not decodable */ }
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

/*
 * IMS Authentication Module — Dual Auth (imslib + S2S fallback)
 *
 * Priority 1: Adobe imslib.min.js (user-level IMS — works with AEM Content MCP)
 * Priority 2: S2S via CF Worker (service account — works with DA Admin API)
 *
 * imslib gives real user identity, org switching, and full AEM API access.
 * S2S is the fallback for demo environments where imslib redirect fails.
 */

const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_WORKER = localStorage.getItem('ew-ims-proxy')
  || 'https://compass-ims-proxy.compass-xsc.workers.dev';
const IMS_CLIENT_ID = 'darkalley';
const IMS_SCOPE = 'AdobeID,openid,gnav,read_organizations,additional_info.projectedProductContext,account_cluster.read';
const IMS_TIMEOUT = 5000;

const PROFILE_STORAGE_KEY = 'ew-ims-profile';
const TOKEN_KEY = 'ew-ims-token';
const EXPIRY_KEY = 'ew-ims-expiry';

let profile = null;
let imsLibLoaded = false;   // true if imslib initialized successfully
let authMethod = 'none';    // 'imslib' | 's2s' | 'none'

/* ─── Token access ─── */

export function getToken() {
  // imslib manages its own token — prefer it
  if (imsLibLoaded && window.adobeIMS) {
    const t = window.adobeIMS.getAccessToken();
    if (t?.token) return t.token;
  }
  // Fallback to localStorage (S2S or relay token)
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

/* ─── imslib loader ─── */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`head > script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

/** Handle successful IMS token (from onReady or onAccessToken) */
function _handleImsToken() {
  authMethod = 'imslib';
  console.log('[IMS] imslib: signed in with user-level token');
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
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: 'imslib' } }));
  }).catch(() => {
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true, method: 'imslib' } }));
  });
}

async function tryImsLib() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[IMS] imslib timeout — falling back to S2S');
      resolve(false);
    }, IMS_TIMEOUT);

    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      locale: 'en_US',
      autoValidateToken: true,
      environment: 'prod',
      useLocalStorage: true,
      modalMode: true, // popup auth — avoids redirect, works cross-origin on github.io
      onReady: () => {
        clearTimeout(timeout);
        imsLibLoaded = true;
        const accessToken = window.adobeIMS.getAccessToken();
        if (accessToken?.token) {
          _handleImsToken();
          resolve(true);
        } else {
          console.log('[IMS] imslib: loaded but no token (user not signed in)');
          resolve(false);
        }
      },
      onAccessToken: (tokenInfo) => {
        // Fired after popup sign-in completes
        console.log('[IMS] onAccessToken — popup sign-in complete');
        _handleImsToken();
      },
      onAccessTokenHasExpired: () => {
        console.log('[IMS] Token expired — clearing auth');
        authMethod = 'none';
        window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
      },
      onError: (e) => {
        clearTimeout(timeout);
        console.warn('[IMS] imslib error:', e);
        resolve(false);
      },
    };

    loadScript(IMS_LIB_URL).catch(() => {
      clearTimeout(timeout);
      console.warn('[IMS] imslib script failed to load');
      resolve(false);
    });
  });
}

/* ─── Sign in ─── */

export async function signIn() {
  // imslib's darkalley client redirects to da.live, not github.io — can't use modalMode.
  // Instead: open da.live in popup. If user is already signed in at da.live,
  // the bookmarklet auto-relays the token. If not, they sign in at da.live first.
  if (imsLibLoaded) {
    console.log('[IMS] Opening da.live for token relay...');
    try {
      await relaySignIn();
      return true;
    } catch (e) {
      console.warn('[IMS] Relay sign-in failed:', e.message);
      // Fall through to S2S
    }
  }

  // Fallback: S2S via CF Worker
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
  if (imsLibLoaded && window.adobeIMS) {
    window.adobeIMS.signOut();
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('ew-ims');
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  profile = null;
  authMethod = 'none';
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
}

/* ─── Profile ─── */

export async function fetchUserProfile() {
  // If imslib gave us a profile, use it
  if (profile?.displayName) return profile;

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

/* ─── Bookmarklet (kept as fallback) ─── */

export function getBookmarkletCode() {
  const ewOrigin = window.location.origin;
  return `javascript:void((function(){try{var t=adobeIMS.getAccessToken().token;if(window.opener){window.opener.postMessage({type:'ew-ims-relay',token:t},'${ewOrigin}');window.close()}else{navigator.clipboard.writeText(t).then(function(){alert('Token copied! Paste in Compass Settings.')},function(){prompt('Copy this token:',t)})}}catch(e){alert('Not signed in at da.live. Please sign in first.')}})())`;
}

/* ─── Relay (kept as fallback) ─── */

function handleRelayMessage(event) {
  if (!event.data || event.data.type !== 'ew-ims-relay') return;
  const trustedOrigins = ['https://da.live', 'https://www.da.live', window.location.origin];
  if (!trustedOrigins.includes(event.origin)) return;
  const { token } = event.data;
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem('ew-ims', 'true');
  authMethod = 'relay';
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
}
window.addEventListener('message', handleRelayMessage);

export function relaySignIn() {
  return new Promise((resolve, reject) => {
    const w = 900, h = 700;
    const left = Math.round((screen.width - w) / 2);
    const top = Math.round((screen.height - h) / 2);
    const popup = window.open('https://da.live/', 'daSignIn',
      `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) { reject(new Error('popup-blocked')); return; }
    const pollTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollTimer);
        const token = getToken();
        if (token) resolve(token); else reject(new Error('popup-closed'));
      }
    }, 500);
  });
}

/* ─── Stubs for import compat ─── */

export async function handlePkceCallback() { return false; }

/* ─── Init ─── */

export async function loadIms() {
  // Check for token in hash (imslib redirect callback)
  const hash = window.location.hash;
  if (hash.includes('access_token=')) {
    const tokenParams = new URLSearchParams(hash.slice(1));
    const token = tokenParams.get('access_token');
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem('ew-ims', 'true');
      authMethod = 'redirect';
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }
  if (hash.includes('error=')) {
    const errorParams = new URLSearchParams(hash.slice(1));
    console.error(`[IMS] Auth error: ${errorParams.get('error')}`);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // Try imslib first (non-blocking — user-level auth)
  const imsOk = await tryImsLib();

  // If imslib didn't yield a token, try S2S auto-refresh
  if (!imsOk) {
    const expiry = Number(localStorage.getItem(EXPIRY_KEY) || 0);
    if (isSignedIn() && expiry && Date.now() > expiry - 300000) {
      console.log('[IMS] S2S token expired — refreshing...');
      await signIn();
    } else if (!isSignedIn()) {
      // Auto-sign-in with S2S for seamless demo experience
      console.log('[IMS] No token — auto-signing in via S2S...');
      await signIn();
    }
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
  return fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
}

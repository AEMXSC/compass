/*
 * IMS Authentication Module
 *
 * PKCE OAuth sign-in (this client only supports authorization_code grant).
 * IMS library loaded for session management + token validation.
 *
 * Fallback: Manual token paste in Settings, bookmarklet relay.
 */

const IMS_CLIENT_ID = '0f5a5fe362ea4afcaf8dd09a8e50ba6e';
const IMS_SCOPE = 'AdobeID,openid,aem.assets.author,aem.folders';
const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_ENV = 'prod';
const IMS_TIMEOUT = 8000;

const IMS_AUTH_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const PKCE_PENDING_KEY = 'ew-pkce-pending';
const PROFILE_STORAGE_KEY = 'ew-ims-profile';

let imsReady = null;
let profile = null;

/* ─── Helpers ─── */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* ─── PKCE helpers ─── */

function base64urlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(new Uint8Array(digest));
}

function generateState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

function getRedirectUri() {
  return window.location.origin + window.location.pathname;
}

/* ─── Token access ─── */

export function getToken() {
  // 1. Our PKCE / manual / relay token
  const stored = localStorage.getItem('ew-ims-token');
  if (stored) return stored;
  // 2. IMS library token (if it ever picks up a session)
  if (window.adobeIMS) {
    try {
      const t = window.adobeIMS.getAccessToken();
      if (t?.token) return t.token;
    } catch { /* ignore */ }
  }
  return null;
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

/* ─── Sign in (PKCE redirect) ─── */

export async function signIn() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  sessionStorage.setItem(PKCE_PENDING_KEY, JSON.stringify({ codeVerifier, state }));

  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    scope: IMS_SCOPE,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    locale: 'en_US',
  });

  window.location.assign(`${IMS_AUTH_URL}?${params}`);
}

/* ─── PKCE callback (exchange ?code= for token) ─── */

export async function handlePkceCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return false;

  const pendingRaw = sessionStorage.getItem(PKCE_PENDING_KEY);
  if (!pendingRaw) {
    console.warn('[IMS] PKCE callback but no pending verifier');
    cleanCallbackUrl();
    return false;
  }

  const { codeVerifier, state: expectedState } = JSON.parse(pendingRaw);
  const state = url.searchParams.get('state');

  if (state !== expectedState) {
    console.error('[IMS] PKCE state mismatch — possible CSRF');
    sessionStorage.removeItem(PKCE_PENDING_KEY);
    cleanCallbackUrl();
    return false;
  }

  try {
    const resp = await fetch(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: IMS_CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: getRedirectUri(),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[IMS] Token exchange failed (${resp.status}):`, errText);
      sessionStorage.removeItem(PKCE_PENDING_KEY);
      cleanCallbackUrl();
      return false;
    }

    const data = await resp.json();
    localStorage.setItem('ew-ims-token', data.access_token);
    localStorage.setItem('ew-ims', 'true');
    sessionStorage.removeItem(PKCE_PENDING_KEY);
    cleanCallbackUrl();

    // Fetch profile immediately
    await fetchUserProfile();

    console.log('[IMS] PKCE login successful');
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
    return true;
  } catch (err) {
    console.error('[IMS] PKCE token exchange error:', err);
    sessionStorage.removeItem(PKCE_PENDING_KEY);
    cleanCallbackUrl();
    return false;
  }
}

function cleanCallbackUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  const clean = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
  history.replaceState(null, '', clean);
}

/* ─── Sign out ─── */

export function signOut() {
  localStorage.removeItem('ew-ims-token');
  localStorage.removeItem('ew-ims');
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  profile = null;
  if (window.adobeIMS) {
    try { window.adobeIMS.signOut(); } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
}

/* ─── Profile ─── */

export async function fetchUserProfile() {
  const token = getToken();
  if (!token) return null;

  // Return cached
  const cached = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (cached) {
    try { profile = JSON.parse(cached); return profile; } catch { /* ignore */ }
  }

  try {
    const resp = await fetch('https://ims-na1.adobelogin.com/ims/profile/v1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    profile = {
      displayName: data.displayName || data.name || data.first_name || '',
      email: data.email || data.emailAddress || data.userId || '',
      firstName: data.first_name || '',
      lastName: data.last_name || '',
      userId: data.userId || '',
    };
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    console.log('[IMS] Profile loaded:', profile.displayName, profile.email);
    return profile;
  } catch {
    return null;
  }
}

/* ─── Bookmarklet ─── */

export function getBookmarkletCode() {
  const ewOrigin = window.location.origin;
  return `javascript:void((function(){try{var t=adobeIMS.getAccessToken().token;if(window.opener){window.opener.postMessage({type:'ew-ims-relay',token:t},'${ewOrigin}');window.close()}else{navigator.clipboard.writeText(t).then(function(){alert('Token copied! Paste in Compass Settings.')},function(){prompt('Copy this token:',t)})}}catch(e){alert('Not signed in at da.live. Please sign in first.')}})())`;
}

/* ─── Relay sign-in (bookmarklet postMessage) ─── */

function handleRelayMessage(event) {
  if (!event.data || event.data.type !== 'ew-ims-relay') return;
  const trustedOrigins = ['https://da.live', 'https://www.da.live', window.location.origin];
  if (!trustedOrigins.includes(event.origin)) return;
  const { token } = event.data;
  if (!token) return;
  console.log('[IMS] Token received via relay');
  localStorage.setItem('ew-ims-token', token);
  localStorage.setItem('ew-ims', 'true');
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
}
window.addEventListener('message', handleRelayMessage);

export function relaySignIn() {
  return new Promise((resolve, reject) => {
    const w = 900;
    const h = 700;
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

/* ─── IMS library initialization ─── */

export async function loadIms() {
  if (imsReady) return imsReady;

  // Check for token in URL hash (from bookmarklet that opens EW directly)
  const hash = window.location.hash;
  if (hash.includes('access_token=')) {
    const tokenParams = new URLSearchParams(hash.slice(1));
    const token = tokenParams.get('access_token');
    if (token) {
      localStorage.setItem('ew-ims-token', token);
      localStorage.setItem('ew-ims', 'true');
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  imsReady = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('IMS timeout — continuing without auth');
      resolve({ anonymous: !getToken() });
    }, IMS_TIMEOUT);

    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      locale: 'en_US',
      autoValidateToken: true,
      environment: IMS_ENV,
      useLocalStorage: true,
      onReady: async () => {
        clearTimeout(timeout);
        console.log('[IMS] onReady fired');

        // Check if we have a token (from PKCE callback or manual)
        if (isSignedIn()) {
          localStorage.setItem('ew-ims', 'true');
          window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
          resolve({ anonymous: false });
        } else {
          resolve({ anonymous: true });
        }
      },
      onAccessToken(token) {
        console.log('[IMS] onAccessToken — token received');
        if (token?.token) {
          localStorage.setItem('ew-ims-token', token.token);
          localStorage.setItem('ew-ims', 'true');
          window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
        }
      },
      onAccessTokenHasExpired() {
        console.log('[IMS] Token expired');
        localStorage.removeItem('ew-ims-token');
        window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
      },
      onError: (err) => {
        clearTimeout(timeout);
        console.error('IMS error:', err);
        resolve({ anonymous: !getToken(), error: err });
      },
    };

    loadScript(IMS_LIB_URL).catch(() => {
      clearTimeout(timeout);
      console.warn('Failed to load IMS library — continuing without auth');
      resolve({ anonymous: true });
    });
  });

  return imsReady;
}

export async function fetchWithToken(url, opts = {}) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const headers = {
    Authorization: `Bearer ${token}`,
    ...opts.headers,
  };
  return fetch(url, { ...opts, headers });
}

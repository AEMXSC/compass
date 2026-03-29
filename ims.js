/*
 * IMS Authentication Module — simplified
 *
 * Uses the Adobe IMS library directly, like AEMCoder.
 *
 * Sign-in:  window.adobeIMS.signIn()  — handles PKCE, redirect, token exchange
 * Sign-out: window.adobeIMS.signOut()
 * Token:    window.adobeIMS.getAccessToken()
 * Profile:  window.adobeIMS.getProfile()
 *
 * Fallback: Manual token paste in Settings, bookmarklet relay.
 */

const IMS_CLIENT_ID = '0f5a5fe362ea4afcaf8dd09a8e50ba6e';
const IMS_SCOPE = 'AdobeID,openid,aem.assets.author,aem.folders';
const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_ENV = 'prod';
const IMS_TIMEOUT = 8000;

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

/* ─── Token access ─── */

export function getToken() {
  // 1. IMS library token (primary — set by signIn flow)
  if (window.adobeIMS) {
    try {
      const t = window.adobeIMS.getAccessToken();
      if (t?.token) return t.token;
    } catch { /* ignore */ }
  }
  // 2. Manual/relay token (fallback for Settings paste, bookmarklet)
  return localStorage.getItem('ew-ims-token') || null;
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

/* ─── Sign in / out ─── */

export function signIn() {
  if (window.adobeIMS) {
    window.adobeIMS.signIn();
  } else {
    console.error('[IMS] Library not loaded — cannot sign in');
  }
}

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
  // Try IMS library first
  if (window.adobeIMS) {
    try {
      const imsProfile = await window.adobeIMS.getProfile();
      if (imsProfile) {
        profile = {
          displayName: imsProfile.displayName || imsProfile.name || '',
          email: imsProfile.email || '',
          firstName: imsProfile.first_name || '',
          lastName: imsProfile.last_name || '',
          userId: imsProfile.userId || '',
        };
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
        console.log('[IMS] Profile loaded:', profile.displayName, profile.email);
        return profile;
      }
    } catch (err) {
      console.warn('[IMS] Profile fetch via library failed:', err.message);
    }
  }

  // Fallback: direct API call (for manual/relay tokens)
  const token = getToken();
  if (!token) return null;

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

  // Clean up error params from failed OAuth redirects (breaks redirect loops)
  const url = new URL(window.location.href);
  if (url.searchParams.has('error')) {
    console.warn('[IMS] OAuth error in URL:', url.searchParams.get('error'));
    url.searchParams.delete('error');
    history.replaceState(null, '', url.pathname + (url.search || '') + (url.hash || ''));
  }

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
      response_type: 'code',
      autoValidateToken: true,
      environment: IMS_ENV,
      useLocalStorage: true,
      onReady: async () => {
        clearTimeout(timeout);
        console.log('[IMS] onReady fired');
        let accessToken = null;
        try { accessToken = window.adobeIMS.getAccessToken(); } catch { /* ignore */ }

        if (accessToken?.token) {
          console.log('[IMS] Token available from IMS library');
          localStorage.setItem('ew-ims', 'true');

          // Fetch profile via IMS library
          try {
            const imsProfile = await window.adobeIMS.getProfile();
            if (imsProfile) {
              profile = {
                displayName: imsProfile.displayName || imsProfile.name || '',
                email: imsProfile.email || '',
                firstName: imsProfile.first_name || '',
                lastName: imsProfile.last_name || '',
                userId: imsProfile.userId || '',
              };
              localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
            }
          } catch { /* profile fetch optional */ }

          window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
          resolve({ anonymous: false, profile });
        } else {
          // No IMS library token — check manual/relay token
          const manual = localStorage.getItem('ew-ims-token');
          if (manual) {
            localStorage.setItem('ew-ims', 'true');
            resolve({ anonymous: false });
          } else {
            resolve({ anonymous: true });
          }
        }
      },
      onAccessToken(token) {
        console.log('[IMS] onAccessToken — token received');
        if (token?.token) {
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

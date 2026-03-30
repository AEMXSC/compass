/*
 * IMS Authentication Module
 *
 * Uses Adobe's IMS library (imslib.min.js) for sign-in.
 * The library handles popup-based auth, token storage, and session management.
 *
 * Fallback: Manual token paste in Settings, bookmarklet relay.
 */

const IMS_CLIENT_ID = 'experience-catalyst-prod';
const IMS_SCOPE = 'ab.manage,AdobeID,gnav,openid,org.read,read_organizations,session,aem.frontend.all,additional_info.ownerOrg,additional_info.projectedProductContext,account_cluster.read';

const PROFILE_STORAGE_KEY = 'ew-ims-profile';

let profile = null;
let imsReady = false;
let imsReadyPromise = null;

/* ─── Token access ─── */

export function getToken() {
  // Try IMS library first
  if (window.adobeIMS) {
    try {
      const tokenInfo = window.adobeIMS.getAccessToken();
      if (tokenInfo && tokenInfo.token) return tokenInfo.token;
    } catch { /* fall through */ }
  }
  // Fall back to manual token
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

/* ─── IMS Library loader ─── */

function loadImsLibrary() {
  return new Promise((resolve, reject) => {
    if (window.adobeIMS) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://auth.services.adobe.com/imslib/imslib.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load IMS library'));
    document.head.appendChild(script);
  });
}

function initImsLibrary() {
  if (imsReadyPromise) return imsReadyPromise;

  imsReadyPromise = new Promise(async (resolve) => {
    try {
      // MUST set config BEFORE loading library — it reads window.adobeid on init
      window.adobeid = {
        client_id: IMS_CLIENT_ID,
        scope: IMS_SCOPE,
        locale: 'en_US',
        environment: 'prod',
        useLocalStorage: true,
        autoValidateToken: true,
        modalMode: true,
        onAccessToken: (tokenInfo) => {
          console.log('[IMS] Token received via library');
          // Store for our getToken() fallback
          if (tokenInfo && tokenInfo.token) {
            localStorage.setItem('ew-ims-token', tokenInfo.token);
            localStorage.setItem('ew-ims', 'true');
          }
          window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
          fetchUserProfile();
        },
        onReauthAccessToken: (reauthTokenInfo) => {
          console.log('[IMS] Reauth token received');
          if (reauthTokenInfo && reauthTokenInfo.token) {
            localStorage.setItem('ew-ims-token', reauthTokenInfo.token);
          }
        },
        onAccessTokenHasExpired: () => {
          console.log('[IMS] Token expired');
          localStorage.removeItem('ew-ims-token');
          localStorage.removeItem('ew-ims');
          window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
        },
        onError: (type, msg) => {
          console.error(`[IMS] Error (${type}):`, msg);
        },
      };

      // Load library AFTER config is set
      await loadImsLibrary();

      // Wait for IMS to initialize
      const checkReady = setInterval(() => {
        if (window.adobeIMS && window.adobeIMS.initialized) {
          clearInterval(checkReady);
          imsReady = true;
          console.log('[IMS] Library initialized');
          resolve();
        }
      }, 100);

      // Timeout after 10s
      setTimeout(() => {
        clearInterval(checkReady);
        if (!imsReady) {
          console.warn('[IMS] Library init timeout — falling back to manual mode');
          resolve();
        }
      }, 10000);
    } catch (err) {
      console.error('[IMS] Library load failed:', err);
      resolve(); // Don't block app init
    }
  });

  return imsReadyPromise;
}

/* ─── Sign in ─── */

export async function signIn() {
  await initImsLibrary();

  if (window.adobeIMS && imsReady) {
    console.log('[IMS] Signing in via IMS library...');
    window.adobeIMS.signIn();
  } else {
    console.warn('[IMS] Library not available — use Settings to paste a token manually');
  }
}

/* ─── Sign out ─── */

export function signOut() {
  if (window.adobeIMS && imsReady) {
    try { window.adobeIMS.signOut(); } catch { /* ignore */ }
  }
  localStorage.removeItem('ew-ims-token');
  localStorage.removeItem('ew-ims');
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  profile = null;
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

  // Try IMS library profile
  if (window.adobeIMS && imsReady) {
    try {
      const imsProfile = await new Promise((resolve, reject) => {
        window.adobeIMS.getProfile().then(resolve).catch(reject);
      });
      if (imsProfile) {
        profile = {
          displayName: imsProfile.displayName || imsProfile.name || imsProfile.first_name || '',
          email: imsProfile.email || imsProfile.emailAddress || imsProfile.userId || '',
          firstName: imsProfile.first_name || '',
          lastName: imsProfile.last_name || '',
          userId: imsProfile.userId || '',
        };
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
        console.log('[IMS] Profile loaded:', profile.displayName, profile.email);
        return profile;
      }
    } catch { /* fall through to manual fetch */ }
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

/* ─── PKCE helpers (kept for future use when client is fixed) ─── */

function base64urlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function handlePkceCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return false;
  // PKCE callback handling preserved for when client supports authorization_code
  console.log('[IMS] PKCE callback detected but PKCE flow is currently disabled');
  return false;
}

/* ─── Init ─── */

export async function loadIms() {
  // Log and clean up error params from IMS redirect
  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(url.hash.slice(1));
  const imsError = url.searchParams.get('error') || hashParams.get('error');
  const imsErrorDesc = url.searchParams.get('error_description') || hashParams.get('error_description');

  if (imsError || url.hash.includes('error=')) {
    console.error(`[IMS] Auth error: ${imsError} — ${imsErrorDesc || 'no description'}`);
    console.error(`[IMS] Full callback URL: ${window.location.href}`);
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    let cleanHash = url.hash;
    if (cleanHash.includes('error=')) cleanHash = '';
    history.replaceState(null, '', url.pathname
      + (url.searchParams.toString() ? `?${url.searchParams}` : '')
      + cleanHash);
  }

  // Check for token in URL hash (from implicit grant or bookmarklet)
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

  // Initialize IMS library in background (non-blocking)
  initImsLibrary();

  // If already signed in (from previous session), dispatch event
  if (isSignedIn()) {
    console.log('[IMS] Existing token found');
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
  }

  return { anonymous: !isSignedIn() };
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

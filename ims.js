/*
 * IMS Authentication Module
 * Two sign-in paths:
 *
 * 1. AUTO-DETECT — IMS library's autoValidateToken silently detects
 *    existing Adobe sessions (works when 3rd-party cookies are allowed).
 *
 * 2. RELAY SIGN-IN — User signs in at da.live (popup), then clicks
 *    a bookmarklet that postMessages the token back to Experience Workspace.
 *    One-time bookmarklet setup, then 2 clicks per session.
 *
 * 3. TOKEN PASTE — Manual fallback in Settings panel.
 */

const IMS_CLIENT_ID = 'darkalley';
const IMS_SCOPE = 'ab.manage,AdobeID,gnav,openid,org.read,read_organizations,session,aem.frontend.all,additional_info.ownerOrg,additional_info.projectedProductContext,account_cluster.read';
const IMS_LIB_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_ENV = 'prod';
const IMS_TIMEOUT = 8000;

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
  // 1. Manual / relay token (most reliable)
  const manual = localStorage.getItem('ew-ims-token');
  if (manual) return manual;
  // 2. IMS library session
  if (!window.adobeIMS) return null;
  try {
    const t = window.adobeIMS.getAccessToken();
    return t?.token || null;
  } catch {
    return null;
  }
}

export function getProfile() { return profile; }
export function isSignedIn() { return !!getToken(); }

/* ─── Bookmarklet ─── */

/**
 * Generate the bookmarklet code. When executed on da.live, it grabs the
 * IMS token and sends it to the EW opener via postMessage, then closes.
 * If there's no opener (ran from a regular tab), copies token to clipboard.
 */
export function getBookmarkletCode() {
  const ewOrigin = window.location.origin;
  // The bookmarklet is self-contained — no external dependencies
  return `javascript:void((function(){try{var t=adobeIMS.getAccessToken().token;if(window.opener){window.opener.postMessage({type:'ew-ims-relay',token:t},'${ewOrigin}');window.close()}else{navigator.clipboard.writeText(t).then(function(){alert('Token copied! Paste in Experience Workspace Settings.')},function(){prompt('Copy this token:',t)})}}catch(e){alert('Not signed in at da.live. Please sign in first.')}})())`;
}

/* ─── Relay sign-in (popup + bookmarklet postMessage) ─── */

let relayPopup = null;
let relayResolve = null;
let relayReject = null;

/**
 * Listen for token relay via postMessage.
 * The bookmarklet on da.live sends { type: 'ew-ims-relay', token: '...' }.
 */
function handleRelayMessage(event) {
  if (!event.data || event.data.type !== 'ew-ims-relay') return;

  // Validate origin — only accept tokens from trusted Adobe/DA origins
  const trustedOrigins = ['https://da.live', 'https://www.da.live', window.location.origin];
  if (!trustedOrigins.includes(event.origin)) return;

  const { token } = event.data;
  if (!token) return;

  console.log('[IMS] Token received via relay');
  localStorage.setItem('ew-ims-token', token);
  localStorage.setItem('ew-ims', 'true');

  if (relayResolve) {
    relayResolve(token);
    relayResolve = null;
    relayReject = null;
  }

  // Dispatch custom event so app.js can update UI without reload
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
}

// Start listening immediately
window.addEventListener('message', handleRelayMessage);

/**
 * Open da.live in a popup and wait for the relay bookmarklet.
 * Returns a Promise that resolves with the token.
 */
export function relaySignIn() {
  return new Promise((resolve, reject) => {
    relayResolve = resolve;
    relayReject = reject;

    const w = 900;
    const h = 700;
    const left = Math.round((screen.width - w) / 2);
    const top = Math.round((screen.height - h) / 2);
    relayPopup = window.open(
      'https://da.live/',
      'daSignIn',
      `width=${w},height=${h},left=${left},top=${top},toolbar=yes,menubar=no,location=yes`,
    );

    if (!relayPopup) {
      reject(new Error('popup-blocked'));
      return;
    }

    // If popup closes without sending token, reject
    const pollTimer = setInterval(() => {
      if (relayPopup.closed) {
        clearInterval(pollTimer);
        if (relayResolve) {
          // Check if token arrived via other means (paste, auto-detect)
          const token = getToken();
          if (token) {
            relayResolve(token);
          } else {
            relayReject(new Error('popup-closed'));
          }
          relayResolve = null;
          relayReject = null;
        }
      }
    }, 500);
  });
}

/* ─── Legacy sign-in (IMS popup direct — may not extract token cross-origin) ─── */

export function signIn() {
  localStorage.setItem('ew-ims', 'true');

  const params = new URLSearchParams({
    client_id: IMS_CLIENT_ID,
    scope: IMS_SCOPE,
    response_type: 'token',
    redirect_uri: 'https://da.live/',
    locale: 'en_US',
  });
  const authUrl = `https://ims-na1.adobelogin.com/ims/authorize/v2?${params}`;

  const w = 600;
  const h = 700;
  const left = Math.round((screen.width - w) / 2);
  const top = Math.round((screen.height - h) / 2);
  const popup = window.open(
    authUrl,
    'adobeImsLogin',
    `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`,
  );

  if (!popup) {
    // eslint-disable-next-line no-alert
    alert('Pop-up blocked — please allow pop-ups for this site, then click Sign In again.');
    return;
  }

  const pollTimer = setInterval(() => {
    try {
      const popupUrl = popup.location.href;
      if (popupUrl && popupUrl.includes('access_token=')) {
        const hash = new URL(popupUrl).hash;
        const tokenParams = new URLSearchParams(hash.slice(1));
        const token = tokenParams.get('access_token');
        if (token) {
          localStorage.setItem('ew-ims-token', token);
          clearInterval(pollTimer);
          popup.close();
          window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
          return;
        }
      }
    } catch {
      // Cross-origin — expected
    }

    if (popup.closed) {
      clearInterval(pollTimer);
      if (getToken()) {
        window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
      }
    }
  }, 500);
}

/* ─── Sign out ─── */

export function signOut() {
  localStorage.removeItem('ew-ims');
  localStorage.removeItem('ew-ims-token');
  profile = null;
  if (window.adobeIMS) {
    try { window.adobeIMS.signOut(); } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
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
      const manualToken = localStorage.getItem('ew-ims-token');
      resolve(manualToken ? { anonymous: false } : { anonymous: true });
    }, IMS_TIMEOUT);

    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPE,
      locale: 'en_US',
      autoValidateToken: true,
      environment: IMS_ENV,
      useLocalStorage: true,
      redirect_uri: window.location.href,
      onReady: async () => {
        clearTimeout(timeout);
        console.log('[IMS] onReady fired');
        let accessToken = null;
        try { accessToken = window.adobeIMS.getAccessToken(); } catch { /* ignore */ }
        if (accessToken) {
          localStorage.setItem('ew-ims', 'true');
          try {
            profile = await window.adobeIMS.getProfile();
            profile.accessToken = accessToken;
            resolve(profile);
          } catch {
            resolve({ accessToken, anonymous: false });
          }
        } else {
          const manualToken = localStorage.getItem('ew-ims-token');
          if (manualToken) {
            localStorage.setItem('ew-ims', 'true');
            resolve({ anonymous: false });
          } else {
            resolve({ anonymous: true });
          }
        }
      },
      onError: (err) => {
        clearTimeout(timeout);
        console.error('IMS error:', err);
        const manualToken = localStorage.getItem('ew-ims-token');
        resolve(manualToken ? { anonymous: false } : { anonymous: true, error: err });
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

/*
 * IMS Authentication Module — BFF Pattern
 *
 * Sign-in flow:
 *   1. User clicks Sign In → redirect to CF Worker /login
 *   2. Worker redirects to Adobe IMS authorize
 *   3. User signs in at Adobe
 *   4. IMS redirects to Worker /callback with auth code
 *   5. Worker exchanges code for token (server-side)
 *   6. Worker redirects to Compass with #access_token=...
 *   7. loadIms() picks up token from hash → signed in
 *
 * The CF Worker (worker/ims-token-proxy.js) handles the OAuth server side.
 * This keeps the token exchange off the browser (no CORS issues).
 */

const IMS_WORKER = localStorage.getItem('ew-ims-proxy')
  || 'https://compass-ims-proxy.compass-xsc.workers.dev';

const PROFILE_STORAGE_KEY = 'ew-ims-profile';

let profile = null;

/* ─── Token access ─── */

export function getToken() {
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

/* ─── Sign in ─── */

export async function signIn() {
  // Redirect to CF Worker /login which handles the full OAuth flow
  const returnTo = window.location.origin + window.location.pathname;
  const loginUrl = `${IMS_WORKER}/login?redirect=${encodeURIComponent(returnTo)}`;
  console.log('[IMS] Redirecting to BFF login...');
  window.location.assign(loginUrl);
}

/* ─── Sign out ─── */

export function signOut() {
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

/* ─── PKCE callback (stub — kept for import compat) ─── */

export async function handlePkceCallback() {
  return false;
}

/* ─── Init ─── */

export async function loadIms() {
  const url = new URL(window.location.href);

  // Pick up token from hash (Worker redirects here with #access_token=...)
  const hash = url.hash;
  if (hash.includes('access_token=')) {
    const tokenParams = new URLSearchParams(hash.slice(1));
    const token = tokenParams.get('access_token');
    if (token) {
      console.log('[IMS] Token received from BFF callback');
      localStorage.setItem('ew-ims-token', token);
      localStorage.setItem('ew-ims', 'true');
      // Clean hash
      history.replaceState(null, '', url.pathname + url.search);
      // Fetch profile
      await fetchUserProfile();
      window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
      return { anonymous: false };
    }
  }

  // Handle error from Worker callback
  if (hash.includes('error=')) {
    const errorParams = new URLSearchParams(hash.slice(1));
    const error = errorParams.get('error');
    console.error(`[IMS] Auth error: ${error}`);
    history.replaceState(null, '', url.pathname + url.search);
  }

  // Also check query params for errors (IMS direct redirect)
  const qError = url.searchParams.get('error');
  if (qError) {
    console.error(`[IMS] Auth error (query): ${qError}`);
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    history.replaceState(null, '', url.pathname
      + (url.searchParams.toString() ? `?${url.searchParams}` : ''));
  }

  // Existing session
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

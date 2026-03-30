/*
 * IMS Authentication Module — S2S via CF Worker
 *
 * Sign-in flow:
 *   1. User clicks Sign In
 *   2. Compass calls CF Worker /auth
 *   3. Worker generates S2S token via client_credentials
 *   4. Compass stores token → signed in
 *
 * No redirects, no popups, no bookmarklets. One click.
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

/* ─── Sign in (one call to Worker) ─── */

export async function signIn() {
  console.log('[IMS] Requesting S2S token from Worker...');

  try {
    const resp = await fetch(`${IMS_WORKER}/auth`, {
      credentials: 'omit',
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.error('[IMS] Auth failed:', err);
      throw new Error(err.error || 'Auth request failed');
    }

    const data = await resp.json();

    if (!data.access_token) {
      console.error('[IMS] No access_token in response');
      throw new Error('No access token received');
    }

    localStorage.setItem('ew-ims-token', data.access_token);
    localStorage.setItem('ew-ims', 'true');
    if (data.expires_at) {
      localStorage.setItem('ew-ims-expiry', String(data.expires_at));
    }

    console.log('[IMS] S2S token received, signed in');
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
    return true;
  } catch (err) {
    console.error('[IMS] Sign-in error:', err);
    return false;
  }
}

/* ─── Sign out ─── */

export function signOut() {
  localStorage.removeItem('ew-ims-token');
  localStorage.removeItem('ew-ims');
  localStorage.removeItem('ew-ims-expiry');
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  profile = null;
  window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: false } }));
}

/* ─── Profile ─── */

export async function fetchUserProfile() {
  // S2S tokens are service accounts — no user profile.
  // Use GitHub identity instead if available.
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
        console.log('[IMS] Profile loaded from GitHub:', profile.displayName);
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
  localStorage.setItem('ew-ims-token', token);
  localStorage.setItem('ew-ims', 'true');
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
  // Check for token in hash (legacy BFF callback compat)
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

  // Clean error params
  if (hash.includes('error=')) {
    const errorParams = new URLSearchParams(hash.slice(1));
    console.error(`[IMS] Auth error: ${errorParams.get('error')}`);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // Auto-refresh if token is expired
  const expiry = Number(localStorage.getItem('ew-ims-expiry') || 0);
  if (isSignedIn() && expiry && Date.now() > expiry - 300000) {
    console.log('[IMS] Token expired or expiring — refreshing...');
    await signIn();
  }

  if (isSignedIn()) {
    console.log('[IMS] Signed in');
    window.dispatchEvent(new CustomEvent('ew-auth-change', { detail: { signedIn: true } }));
  }

  return { anonymous: !isSignedIn() };
}

export async function fetchWithToken(url, opts = {}) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  return fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
}

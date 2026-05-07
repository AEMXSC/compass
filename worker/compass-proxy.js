/**
 * Compass Proxy — routes compass.aemxsc.com → configured origin host
 * Set ORIGIN_HOSTNAME in Variables to change target without redeploying.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Redirect plain HTTP to HTTPS
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    const target = env.ORIGIN_HOSTNAME || 'eds-migration--compass--aemxsc.aem.live';
    url.hostname = target;
    url.port = '';
    url.protocol = 'https:';

    const proxyReq = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    return fetch(proxyReq);
  },
};

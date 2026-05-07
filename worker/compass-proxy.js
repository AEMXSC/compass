/**
 * Compass Proxy — routes compass.aemxsc.com → eds-migration branch
 * Simple reverse proxy: forwards all requests with path/query intact.
 */

const TARGET = 'eds-migration--compass--aemxsc.aem.live';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = TARGET;
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

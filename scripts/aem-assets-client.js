/*
 * AEM Assets HTTP API — Direct Client
 *
 * Direct calls to AEM CS Assets API for CRUD operations.
 * Uses S2S token from ims.js. Faster than MCP for simple operations.
 *
 * NLP search stays on Discovery MCP (smarter). This handles:
 * browse, metadata, upload, delete, move, copy, renditions.
 *
 * API: https://experienceleague.adobe.com/docs/experience-manager-cloud-service/content/assets/admin/mac-api-assets.html
 */

import { fetchWithToken } from './ims.js';

function getHost() {
  return window.__EW_AEM_HOST || null;
}

function assetUrl(path) {
  const host = getHost();
  if (!host) throw new Error('No AEM host configured. Connect a site first.');
  const clean = (path || '/').replace(/^\/content\/dam\/?/, '/').replace(/\.json$/, '');
  return `https://${host}/api/assets${clean}.json`;
}

function adminUrl(path) {
  const host = getHost();
  if (!host) throw new Error('No AEM host configured. Connect a site first.');
  return `https://${host}${path}`;
}

/* ─── Browse / List ─── */

export async function listFolder(path = '/') {
  const url = assetUrl(path);
  const resp = await fetchWithToken(url);
  if (!resp.ok) throw new Error(`List folder failed: ${resp.status}`);
  const data = await resp.json();

  // Normalize response — API returns entities[] for folder children
  const items = (data.entities || []).map((e) => ({
    name: e.properties?.name || e.properties?.['dc:title'] || '',
    path: e.links?.find((l) => l.rel?.includes('self'))?.href?.replace(/\.json$/, '') || '',
    type: e.class?.includes('assets/folder') ? 'folder' : 'asset',
    mimeType: e.properties?.['dc:format'] || '',
    modified: e.properties?.['jcr:lastModified'] || '',
    size: e.properties?.size || 0,
  }));

  return {
    path,
    title: data.properties?.['dc:title'] || path.split('/').pop() || 'DAM Root',
    count: items.length,
    items,
  };
}

/* ─── Get Asset Metadata ─── */

export async function getMetadata(path) {
  const url = assetUrl(path);
  const resp = await fetchWithToken(url);
  if (!resp.ok) throw new Error(`Get metadata failed: ${resp.status}`);
  const data = await resp.json();

  const props = data.properties || {};
  return {
    path,
    title: props['dc:title'] || '',
    description: props['dc:description'] || '',
    mimeType: props['dc:format'] || '',
    size: props.size || 0,
    width: props['tiff:ImageWidth'] || null,
    height: props['tiff:ImageLength'] || null,
    created: props['jcr:created'] || '',
    modified: props['jcr:lastModified'] || '',
    modifiedBy: props['jcr:lastModifiedBy'] || '',
    tags: props['cq:tags'] || [],
    status: props['dam:assetState'] || '',
    expirationDate: props['prism:expirationDate'] || null,
    // DM delivery URL
    deliveryUrl: buildDeliveryUrl(path),
    // All properties for advanced use
    _raw: props,
  };
}

/* ─── Update Asset Metadata ─── */

export async function updateMetadata(path, properties) {
  const url = assetUrl(path);
  const body = {
    class: 'asset',
    properties,
  };
  const resp = await fetchWithToken(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Update metadata failed: ${resp.status}`);
  return resp.json();
}

/* ─── Upload Asset ─── */

export async function uploadAsset(folderPath, fileName, blob, mimeType) {
  const host = getHost();
  if (!host) throw new Error('No AEM host configured.');
  // POST to /api/assets/{folder}/*
  const clean = (folderPath || '/').replace(/^\/content\/dam\/?/, '/').replace(/\/$/, '');
  const url = `https://${host}/api/assets${clean}/${fileName}`;

  const formData = new FormData();
  formData.append('file', blob, fileName);
  if (mimeType) formData.append('mime_type', mimeType);

  const resp = await fetchWithToken(url, {
    method: 'POST',
    body: formData,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Upload failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

/* ─── Delete Asset ─── */

export async function deleteAsset(path) {
  const url = assetUrl(path);
  const resp = await fetchWithToken(url, { method: 'DELETE' });
  if (!resp.ok) throw new Error(`Delete failed: ${resp.status}`);
  return { deleted: true, path };
}

/* ─── Move Asset ─── */

export async function moveAsset(sourcePath, destPath) {
  const host = getHost();
  if (!host) throw new Error('No AEM host configured.');
  // AEM move via Sling POST servlet
  const url = adminUrl(`/content/dam${sourcePath}`);
  const formData = new FormData();
  formData.append(':operation', 'move');
  formData.append(':dest', `/content/dam${destPath}`);

  const resp = await fetchWithToken(url, { method: 'POST', body: formData });
  if (!resp.ok) throw new Error(`Move failed: ${resp.status}`);
  return { moved: true, from: sourcePath, to: destPath };
}

/* ─── Copy Asset ─── */

export async function copyAsset(sourcePath, destPath) {
  const host = getHost();
  if (!host) throw new Error('No AEM host configured.');
  const url = adminUrl(`/content/dam${sourcePath}`);
  const formData = new FormData();
  formData.append(':operation', 'copy');
  formData.append(':dest', `/content/dam${destPath}`);

  const resp = await fetchWithToken(url, { method: 'POST', body: formData });
  if (!resp.ok) throw new Error(`Copy failed: ${resp.status}`);
  return { copied: true, from: sourcePath, to: destPath };
}

/* ─── Create Folder ─── */

export async function createFolder(parentPath, name, title) {
  const url = assetUrl(parentPath);
  const body = {
    class: 'assets/folder',
    properties: {
      'jcr:title': title || name,
    },
  };
  const resp = await fetchWithToken(`${url.replace(/\.json$/, '')}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Create folder failed: ${resp.status}`);
  return { created: true, path: `${parentPath}/${name}` };
}

/* ─── Get Renditions ─── */

export async function getRenditions(path) {
  const host = getHost();
  if (!host) throw new Error('No AEM host configured.');
  // Renditions are at /content/dam/{path}/jcr:content/renditions
  const url = adminUrl(`/content/dam${path}/jcr:content/renditions.json`);
  const resp = await fetchWithToken(url);
  if (!resp.ok) throw new Error(`Get renditions failed: ${resp.status}`);
  const data = await resp.json();

  // Parse rendition entries from JSON
  const renditions = Object.keys(data)
    .filter((key) => !key.startsWith('jcr:') && !key.startsWith('sling:'))
    .map((name) => ({
      name,
      url: `https://${host}/content/dam${path}/jcr:content/renditions/${name}`,
      deliveryUrl: buildDeliveryUrl(path, name),
    }));

  return { path, renditions };
}

/* ─── DM Delivery URL helper ─── */

function buildDeliveryUrl(path, rendition) {
  const host = getHost();
  if (!host) return null;
  const dmHost = host.replace('author-', 'delivery-');
  const assetPath = path.replace(/^\//, '');
  if (rendition && rendition !== 'original') {
    return `https://${dmHost}/adobe/dynamicmedia/deliver/${assetPath}/${rendition}`;
  }
  return `https://${dmHost}/adobe/dynamicmedia/deliver/${assetPath}`;
}

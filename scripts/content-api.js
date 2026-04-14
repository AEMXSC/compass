/*
 * Local Content API — bridge between Experience Workspace (browser) and the local filesystem.
 *
 * EW's edit_page_content tool POSTs HTML here → we write to /workspace/content/ →
 * aem up serves the decorated page at localhost:3000 → preview iframe picks it up.
 *
 * Same pattern as AEMCoder: local file writes + aem up = instant preview.
 *
 * Usage: node content-api.js          (runs on port 3001)
 *        node content-api.js 3002     (custom port)
 */

import { createServer } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const PORT = parseInt(process.argv[2], 10) || 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = resolve(__dirname, '../../content');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function safePath(reqPath) {
  // Normalize and prevent directory traversal
  const cleaned = reqPath.replace(/^\/+/, '').replace(/\.+\//g, '');
  if (!cleaned.endsWith('.html')) return cleaned + '.html';
  return cleaned;
}

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // Health check
  if (route === '/api/health') {
    return json(res, 200, { status: 'ok', contentRoot: CONTENT_ROOT });
  }

  // List content files
  if (route === '/api/content' && req.method === 'GET') {
    const { readdir } = await import('fs/promises');
    try {
      const files = await readdir(CONTENT_ROOT, { recursive: true });
      const htmlFiles = files.filter(f => f.endsWith('.html') && !f.startsWith('.'));
      return json(res, 200, { files: htmlFiles });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // Read content file
  if (route.startsWith('/api/content/') && req.method === 'GET') {
    const filePath = safePath(route.replace('/api/content/', ''));
    const fullPath = join(CONTENT_ROOT, filePath);
    try {
      const content = await readFile(fullPath, 'utf-8');
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    } catch (err) {
      return json(res, 404, { error: `Not found: ${filePath}` });
    }
    return;
  }

  // Write content file
  if (route.startsWith('/api/content/') && req.method === 'PUT') {
    const filePath = safePath(route.replace('/api/content/', ''));
    const fullPath = join(CONTENT_ROOT, filePath);

    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();

    let html;
    try {
      const parsed = JSON.parse(body);
      html = parsed.html;
    } catch {
      html = body; // Plain HTML string
    }

    if (!html) {
      return json(res, 400, { error: 'Missing html content' });
    }

    try {
      // Ensure directory exists
      const dir = dirname(fullPath);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });

      await writeFile(fullPath, html, 'utf-8');
      console.log(`[content-api] Wrote ${filePath} (${html.length} bytes)`);
      return json(res, 200, {
        status: 'written',
        path: filePath,
        size: html.length,
        preview_url: `http://localhost:3000/${filePath.replace(/\.html$/, '')}`,
      });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // 404 fallback
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[content-api] Local content API running on http://localhost:${PORT}`);
  console.log(`[content-api] Content root: ${CONTENT_ROOT}`);
  console.log(`[content-api] PUT /api/content/{path} → writes to content folder`);
  console.log(`[content-api] GET /api/content/{path} → reads content file`);
});

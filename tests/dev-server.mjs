// Local stand-in for `wrangler dev` (workerd needs macOS 13.5+).
// Mirrors run_worker_first: /api/* goes through the Worker, everything else is a
// static file from the repo root. Usage:
//   TURNSTILE_SECRET=... GHL_TOKEN=... PORT=8788 node tests/dev-server.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8788);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };

const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response(null, { status: 404 });
    try {
      return new Response(await fs.readFile(file), {
        headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  },
};
const env = { TURNSTILE_SECRET: process.env.TURNSTILE_SECRET, GHL_TOKEN: process.env.GHL_TOKEN, ASSETS };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(new URL(req.url, `http://localhost:${PORT}`), {
    method: req.method,
    headers: { ...req.headers, 'CF-Connecting-IP': '127.0.0.1' },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const isWorkerPath = new URL(request.url).pathname.startsWith('/api/');
  const response = isWorkerPath ? await worker.fetch(request, env) : await ASSETS.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));

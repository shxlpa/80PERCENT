import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHandler } from './everything.js';
import { isPublicPath, contentType } from './public-files.js';
import writing from '../api/writing.js';

// A configured external origin is authoritative. Never trust forwarded Host,
// Origin, Proto or client-IP headers supplied by a browser or arbitrary proxy.
export function servingOrigin(value) {
  const url = new URL(value);
  if (value !== url.origin || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('EVERYTHING_ORIGIN must be an exact HTTPS origin (HTTP is loopback-only).');
  }
  return url.origin;
}

function requestURL(incoming, origin) {
  if (!incoming.url.startsWith('/') || incoming.url.startsWith('//') || incoming.url.includes('\\')) return null;
  // Tailscale Serve preserves Host. Other proxies must do the same.
  if (incoming.headers.host !== new URL(origin).host) return null;
  const url = new URL(incoming.url, origin);
  return url.origin === origin ? url : null;
}

export async function createEverythingServer({store, password, origin, directory = '.'}) {
  origin = servingOrigin(origin);
  const root = await realpath(directory);
  const handle = createHandler({store, password});
  return createServer(async (incoming, outgoing) => {
    try {
      // Bind to loopback and reject unrelated hostnames (including DNS rebinding).
      const url = requestURL(incoming, origin);
      if (!url) {
        outgoing.writeHead(403).end();
        return;
      }
      const writingFeed = /^\/api\/writing\/?$/.test(url.pathname);
      if (writingFeed || /^\/(everything|api\/everything)\/?$/.test(url.pathname)) {
        const request = new Request(url, {
          method: incoming.method, headers: incoming.headers,
          ...(!['GET', 'HEAD'].includes(incoming.method) && { body: incoming, duplex: 'half' })
        });
        const result = writingFeed ? await writing.fetch(request) : await handle(request, incoming.socket.remoteAddress);
        outgoing.writeHead(result.status, Object.fromEntries(result.headers));
        outgoing.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(url.pathname);
      const path = pathname.replace(/^\//, '') + (pathname.endsWith('/') ? 'index.html' : '');
      if (!isPublicPath(path)) { outgoing.writeHead(404).end(); return; }
      const target = await realpath(join(root, path));
      if (!isPublicPath(relative(root, target)) || !(await stat(target)).isFile()) {
        outgoing.writeHead(404).end(); return;
      }
      outgoing.writeHead(200, { 'content-type': contentType(target), 'x-content-type-options': 'nosniff' });
      if (incoming.method === 'HEAD') outgoing.end();
      else createReadStream(target).on('error', () => outgoing.destroy()).pipe(outgoing);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(404); outgoing.end(); }
  });
}

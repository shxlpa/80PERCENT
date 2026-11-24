import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHandler } from './everything.js';
import { localStore } from './local-storage.js';
import { privateBlobStore } from './storage.js';
import { isPublicPath, contentType } from './public-files.js';
import writing from '../api/writing.js';

const root = await realpath('.');
const store = process.env.BLOB_READ_WRITE_TOKEN ? privateBlobStore(process.env.BLOB_READ_WRITE_TOKEN) :
  localStore(process.env.EVERYTHING_DATA_DIR || '.everything-data');
const handle = createHandler({ store, password: process.env.EVERYTHING_PASSWORD });
const server = createServer(async (incoming, outgoing) => {
  try {
    // Bind to loopback and reject unrelated hostnames (including DNS rebinding).
    const url = new URL(incoming.url, 'http://' + incoming.headers.host);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
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
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => {
  console.log('Everything is available at http://127.0.0.1:' + server.address().port + '/everything/');
});

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readJson } from './storage.js';
import { imageExtension, imageId, imageTypes, validBoard } from './validation.js';

const maxBytes = 4_000_000;
const sessionSeconds = 7 * 86400;
const rateWindow = 15 * 60 * 1000;
const emptyBoard = { revision: 0, items: [] };
const privateHeaders = {
  'cache-control': 'private, no-store, max-age=0',
  'cdn-cache-control': 'no-store',
  'vercel-cdn-cache-control': 'no-store',
  'vary': 'Authorization',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

function json(value, status = 200, headers) {
  return Response.json(value, { status, headers: { ...privateHeaders, ...headers } });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function bodyBytes(request, max) {
  if (+request.headers.get('content-length') > max) throw new HttpError(413, 'File is too large.');
  const chunks = [];
  let size = 0;
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.length;
      if (size > max) throw new HttpError(413, 'File is too large.');
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request, max) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, 'Send JSON.');
  }
  const bytes = await bodyBytes(request, max);
  try { return JSON.parse(bytes.toString()); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

const digest = value => createHash('sha256').update(value).digest();
const privateKey = (password, label, value) => createHmac('sha256', password).update(label + ':' + value).digest('hex');
const bearerSessionKey = (password, token) => 'bearer-sessions/' + privateKey(password, 'bearer', token);

async function reserveLogin(store, key) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = Date.now();
    const current = await readJson(store, key);
    const window = current?.value.until > now ? current.value : { count: 0, until: now + rateWindow };
    if (window.count >= 10) return Math.ceil((window.until - now) / 1000);
    window.count++;
    if (await store.write(key, JSON.stringify(window), current?.etag, 1)) return 0;
  }
  return 1;
}

function requireMethod(request, ...methods) {
  if (!methods.includes(request.method)) throw new HttpError(405, 'Method not allowed.');
}

export function createHandler({ store, password }) {
  return async function handle(request, clientAddress = 'local') {
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get('action') || (/^\/everything\/?$/.test(url.pathname) ? 'page' : '');
      if (!['GET', 'HEAD'].includes(request.method) &&
          (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site')) {
        throw new HttpError(403, 'Origin not allowed.');
      }

      if (action === 'login') {
        requireMethod(request, 'POST');
        if (!store || !password) throw new HttpError(503, 'The private workspace needs server configuration.');
        const input = await jsonBody(request, 4096);
        const key = 'attempts/' + privateKey(password, 'rate', clientAddress);
        const retry = await reserveLogin(store, key);
        if (retry) return json({ error: 'Too many attempts. Please try again later.' }, 429, { 'Retry-After': String(retry) });
        if (typeof input?.password !== 'string' || !timingSafeEqual(digest(input.password), digest(password))) {
          throw new HttpError(401, 'Incorrect password.');
        }
        const token = randomBytes(32).toString('base64url');
        const sessionKey = bearerSessionKey(password, token);
        const expires = Date.now() + sessionSeconds * 1000;
        if (!await store.write(sessionKey, String(expires), null, 7)) throw new Error('Session creation failed');
        await store.remove(key);
        return json({ token });
      }

      const authorization = request.headers.get('authorization') || '';
      const token = /^Bearer ([\w-]{43})$/i.exec(authorization)?.[1];
      const sessionKey = password && token ? bearerSessionKey(password, token) : null;
      const session = store && sessionKey ? await store.read(sessionKey) : null;
      const authenticated = Boolean(session && Number(session.data.toString()) > Date.now());

      if (action === 'page') {
        requireMethod(request, 'GET', 'HEAD');
        const path = authenticated ? 'server/views/editor.html' : 'server/views/login.html';
        const html = request.method === 'HEAD' ? null : await readFile(path);
        return new Response(html, { headers: { ...privateHeaders, 'content-type': 'text/html; charset=utf-8' } });
      }
      if (action === 'session') {
        requireMethod(request, 'GET');
        return json({ authenticated });
      }
      if (!authenticated) throw new HttpError(401, 'Please unlock Everything.');
      if (action === 'logout') {
        requireMethod(request, 'POST');
        await store.remove(sessionKey);
        return json({ ok: true });
      }

      if (action === 'board') {
        requireMethod(request, 'GET', 'PUT');
        const current = await readJson(store, 'board.json');
        const board = current?.value || emptyBoard;
        if (request.method === 'GET') return json(board);
        const input = await jsonBody(request, maxBytes);
        if (!validBoard(input)) throw new HttpError(400, 'Invalid canvas data.');
        const revision = board.revision + 1;
        if (input.revision !== board.revision ||
          !await store.write('board.json', JSON.stringify({ revision, items: input.items }), current?.etag)) {
          throw new HttpError(409, 'The workspace changed on another device.');
        }
        return json({ revision });
      }

      if (action === 'image') {
        requireMethod(request, 'GET', 'POST');
        if (request.method === 'POST') {
          const bytes = await bodyBytes(request, maxBytes);
          const extension = imageExtension(bytes);
          if (!extension) throw new HttpError(415, 'Unsupported image format.');
          const id = randomUUID() + '.' + extension;
          if (!await store.write('images/' + id, bytes)) throw new Error('Image creation failed');
          return json({ id }, 201);
        }
        const id = url.searchParams.get('id') || '';
        if (!imageId.test(id)) throw new HttpError(404, 'Image not found.');
        const image = await store.read('images/' + id);
        if (!image) throw new HttpError(404, 'Image not found.');
        return new Response(image.data, { headers: {
          ...privateHeaders, 'content-type': imageTypes[id.split('.').pop()], 'content-length': String(image.data.length)
        } });
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      // Limit operational logs to the error type. Store keys, request bodies
      // and credentials never belong in the response or deployment logs.
      console.error('Everything request failed', error.name);
      return json({ error: 'Private storage is unavailable. Please try again.' }, 503);
    }
  };
}

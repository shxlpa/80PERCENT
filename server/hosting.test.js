import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEverythingServer, servingOrigin } from './http-server.js';
import { localStore } from './local-storage.js';
import { seed, board, media } from '../test-support/fixture.js';
import vercel from '../api/everything.js';

test('private HTTP entry point reconstructs HTTPS, enforces Host/Origin, persists sessions and never fetches externally', async t => {
  const root = await mkdtemp(join(tmpdir(), 'everything-host-'));
  const store = localStore(root); await seed(store);
  const origin = 'https://fixture.example.ts.net';
  const server = await createEverythingServer({store, password: 'fixture-only', origin});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(done => server.close(done)); store.close(); await rm(root, {recursive: true}); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected outbound runtime request'); });
  function call(path, {method = 'GET', headers = {}, value, bytes} = {}) {
    return new Promise((done, reject) => {
      const body = bytes || (value && JSON.stringify(value));
      const req = request({hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: {host: 'fixture.example.ts.net', origin, ...(value && {'content-type': 'application/json'}), ...headers}}, res => {
        const chunks = []; res.on('data', data => chunks.push(data));
        res.on('end', () => done({status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks)}));
      }); req.on('error', reject); req.end(body);
    });
  }
  const api = action => '/api/everything?action=' + action;
  const login = () => call(api('login'), {method: 'POST', value: {password: 'fixture-only'}});
  assert.match((await call('/everything/')).data.toString(), /data-page="login"/);
  assert.equal((await call('/everything/', {headers: {host: 'evil.example', 'x-forwarded-host': 'fixture.example.ts.net'}})).status, 403);
  assert.equal((await call(api('login'), {method: 'POST', value: {password: 'fixture-only'}, headers: {origin: 'http://fixture.example.ts.net', 'x-forwarded-proto': 'https'}})).status, 403);
  assert.equal((await call(api('login'), {method: 'POST', value: {password: 'fixture-only'}, headers: {'sec-fetch-site': 'cross-site'}})).status, 403);
  const tokens = await Promise.all([login(), login()]);
  const auth = tokens.map(response => ({authorization: 'Bearer ' + JSON.parse(response.data).token}));
  assert.match((await call('/everything/', {headers: auth[0]})).data.toString(), /data-page="editor"/);
  const a = await call(api('board'), {headers: auth[0]}), b = await call(api('board'), {headers: auth[1]});
  assert.deepEqual(JSON.parse(a.data), board); assert.deepEqual(a.data, b.data);
  const uploads = await call(api('image'), {method: 'POST', headers: auth[0], bytes: [...media.values()][0]});
  assert.equal(uploads.status, 201);
  const key = JSON.parse(uploads.data).id;
  assert.deepEqual((await call(api('image&id=' + key), {headers: auth[1]})).data, [...media.values()][0]);
  const saves = await Promise.all(auth.map(headers => call(api('board'), {method: 'PUT', headers, value: board})));
  assert.deepEqual(saves.map(r => r.status).sort(), [200, 409]);
  assert.equal(JSON.parse((await call(api('board'), {headers: auth[1]})).data).revision, 38);
  assert.match((await call('/everything/')).data.toString(), /data-page="login"/);
  assert.equal((await call(api('board'))).status, 401);
  assert.equal((await call(api('image&id=' + key))).status, 401);
  for (const path of ['/.env.local', '/server/views/editor.html', '/.everything-data/everything.sqlite', '/test-support/fixture.js']) assert.equal((await call(path)).status, 404);
  assert.equal((await call('/')).status, 200);
  for (let n = 0; n < 10; n++) assert.equal((await call(api('login'), {method: 'POST', value: {password: 'wrong'}, headers: {'x-forwarded-for': 'forged-' + n}})).status, 401);
  assert.equal((await login()).status, 429);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
test('hosting configuration is exact, and Vercel entry point has no storage fallback', async () => {
  for (const bad of ['https://host.test/', 'http://host.test', 'https://host.test/path', 'https://user:pass@host.test', 'https://host.test?x']) assert.throws(() => servingOrigin(bad));
  assert.equal(servingOrigin('https://host.test'), 'https://host.test');
  const result = await vercel.fetch(new Request('https://host.test/api/everything?action=login', {method: 'POST', headers: {origin: 'https://host.test', 'content-type': 'application/json'}, body: '{"password":"fixture"}'}));
  assert.equal(result.status, 503);
});
test('runtime import graph cannot load the Blob adapter or SDK', async () => {
  const seen = new Set();
  async function walk(path) {
    path = resolve(path); if (seen.has(path)) return; seen.add(path);
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /@vercel\/blob|privateBlobStore|BLOB_READ_WRITE_TOKEN/);
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) await walk(resolve(path, '..', match[1]));
    }
  }
  for (const entry of ['server/serve.js', 'server/dev.js', 'api/everything.js']) await walk(entry);
});

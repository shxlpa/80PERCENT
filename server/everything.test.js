import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createHandler } from './everything.js';
import { localStore } from './local-storage.js';
import { privateBlobStore } from './storage.js';
import { isPublicPath } from './public-files.js';

const origin = 'https://everything.example';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/V6sAAAAASUVORK5CYII=', 'base64');

test('private board reads retain the strong storage ETag used by conditional saves', async t => {
  const board = JSON.stringify({ revision: 1, items: [], padding: 'x'.repeat(1200) });
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  t.after(async () => { setGlobalDispatcher(previous); await agent.close(); });
  agent.get('https://test.private.blob.vercel-storage.com')
    .intercept({ path: '/everything/board.json?cache=0', headers: { 'accept-encoding': 'identity' } })
    .reply(200, board, { headers: { etag: '"version-1"' } });
  const store = privateBlobStore('vercel_blob_rw_test_fixture');
  const stored = await store.read('board.json');
  assert.equal(stored.data.toString(), board);
  assert.equal(stored.etag, '"version-1"');
  await assert.rejects(store.write('board.json', board, 'W/"version-1"'), /strong storage ETag/);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'everything-test-'));
  const store = localStore(directory);
  const password = randomBytes(24).toString('hex');
  const handle = createHandler({ store, password });
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  function request(action, { method = 'GET', token, cookie, value, bytes, from = origin } = {}) {
    const headers = { origin: from };
    if (token) headers.authorization = 'Bearer ' + token;
    if (cookie) headers.cookie = cookie;
    if (value !== undefined) headers['content-type'] = 'application/json';
    return new Request(origin + '/api/everything?action=' + action, {
      method, headers, body: bytes ?? JSON.stringify(value)
    });
  }
  const call = (...args) => handle(request(...args));
  async function login() {
    const result = await call('login', { method: 'POST', value: { password } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.has('set-cookie'), false);
    const { token } = await result.json();
    assert.match(token, /^[\w-]{43}$/);
    return token;
  }
  return { call, login, handle, request, password, store, directory };
}

test('the editor, board and media require an active bearer session', async t => {
  const { call, login, password, store, request } = fixture(t);
  const loginHtml = readFileSync('server/views/login.html', 'utf8');
  const editorHtml = readFileSync('server/views/editor.html', 'utf8');
  const token = await login();
  const editor = await call('page', { token });
  assert.equal(await editor.text(), editorHtml);
  assert.equal(editor.headers.get('vary'), 'Authorization');
  assert.match(editor.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await (await call('session', { token })).json(), { authenticated: true });

  // Older deployments used these records and persisted the token in cookies.
  const oldToken = randomBytes(32).toString('base64url');
  const oldKey = createHmac('sha256', password).update('session:' + oldToken).digest('hex');
  await store.write('sessions/' + oldKey, String(Date.now() + 3600_000));
  const image = await (await call('image', { method: 'POST', token, bytes: png })).json();
  async function assertLocked(credentials) {
    const guest = await call('page', credentials);
    assert.equal(await guest.text(), loginHtml);
    assert.match(guest.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await (await call('session', credentials)).json(), { authenticated: false });
    assert.equal((await call('board', credentials)).status, 401);
    assert.equal((await call('image&id=' + image.id, credentials)).status, 401);
  }
  await assertLocked({});
  await assertLocked({ cookie: '__Host-everything=' + oldToken });
  await assertLocked({ cookie: 'everything_dev=' + oldToken });
  await assertLocked({ token: oldToken });
  await assertLocked({ cookie: '__Host-everything=' + token });

  const changedPassword = createHandler({ store, password: randomBytes(32).toString('hex') });
  assert.equal((await changedPassword(request('board', { token }))).status, 401);
  const other = await login();
  const logout = await call('logout', { method: 'POST', token });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.has('set-cookie'), false);
  await assertLocked({ token });
  assert.equal((await call('board', { token: other })).status, 200);

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(7 * 86400 * 1000);
  await assertLocked({ token: other });
});

test('two devices share private image bytes and one saved board, including following a restart', async t => {
  const { call, login, directory, password, request } = fixture(t);
  const token = await login();
  const other = await login();
  assert.notEqual(token, other);
  const uploaded = await call('image', { method: 'POST', token, bytes: png });
  assert.equal(uploaded.status, 201);
  const { id } = await uploaded.json();
  const items = [{ id: randomUUID(), type: 'image', x: -80, y: 12, width: 40, height: 90, imageId: id, name: 'idea.png' }];
  const saved = await call('board', { method: 'PUT', token, value: { revision: 0, items } });
  assert.deepEqual(await saved.json(), { revision: 1 });
  assert.deepEqual(await (await call('board', { token: other })).json(), { revision: 1, items });
  const disk = localStore(directory);
  try {
    const restarted = createHandler({ store: disk, password });
    assert.deepEqual(await (await restarted(request('board', { token: other }))).json(), { revision: 1, items });
    const image = await restarted(request('image&id=' + id, { token: other }));
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  } finally { disk.close(); }
});

test('saved text retains optional italic styling and invalid values cannot replace the board', async t => {
  const { call, login } = fixture(t);
  const token = await login();
  const text = { id: randomUUID(), type: 'text', text: 'Emphasis', font: 'DM Sans', fontSize: 24,
    color: '#252724', x: 10, y: 20, width: 240, height: 32 };
  const items = [text, {...text, id: randomUUID(), italic: true}, {...text, id: randomUUID(), italic: false}];
  const saved = await call('board', { method: 'PUT', token, value: { revision: 0, items } });
  assert.equal(saved.status, 200);
  assert.deepEqual(await (await call('board', { token })).json(), { revision: 1, items });
  for (const italic of ['true', 'false', 1, 0, null, {}]) {
    const rejected = await call('board', { method: 'PUT', token,
      value: { revision: 1, items: [{...text, italic}] } });
    assert.equal(rejected.status, 400);
  }
  assert.deepEqual(await (await call('board', { token })).json(), { revision: 1, items });
});

test('a HEIC photo must reach private storage as browser-readable image bytes', async t => {
  const { handle, request, login } = fixture(t);
  const token = await login();
  const original = readFileSync('assets/design_media/IMG_4525.HEIC');
  const jpeg = readFileSync('assets/design_media/web/redwooddesk/IMG_4525.jpg');
  async function upload(bytes) {
    const uploadRequest = request('image', { method: 'POST', token, bytes });
    uploadRequest.headers.set('content-type', 'image/jpeg');
    return handle(uploadRequest);
  }
  assert.equal((await upload(original)).status, 415);
  const uploaded = await upload(jpeg);
  assert.equal(uploaded.status, 201);
  const { id } = await uploaded.json();
  assert.match(id, /\.jpg$/);
  assert.equal((await handle(request('image&id=' + id))).status, 401);
  const result = await handle(request('image&id=' + id, { token }));
  assert.equal(result.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), jpeg);
});

test('competing edits cannot overwrite the same revision, including the first write', async t => {
  const { call, login } = fixture(t);
  const token = await login();
  for (const revision of [0, 1]) {
    const requests = [0, 10, 20].map(x => call('board', { method: 'PUT', token, value: { revision,
      items: [{ id: randomUUID(), type: 'shape', x, y: 4, width: 10, height: 10, shape: 'rectangle', color: '#00ff00' }]
    } }));
    assert.deepEqual((await Promise.all(requests)).map(result => result.status).sort(), [200, 409, 409]);
  }
});

test('same-origin mutations, image types, and item types are checked before writing', async t => {
  const { call, login, password } = fixture(t);
  assert.equal((await call('login', { method: 'POST', value: { password }, from: 'https://other.example' })).status, 403);
  const token = await login();
  assert.equal((await call('image', { method: 'POST', token, bytes: Buffer.from('plain text') })).status, 415);
  assert.equal((await call('board', { method: 'PUT', token, value: { revision: 0, items: [{}] } })).status, 400);
  assert.equal((await call('logout', { method: 'POST', token, from: 'null' })).status, 403);
  assert.equal((await call('board', { token })).status, 200);
});

test('wrong passwords are rate limited across handler instances', async t => {
  const { call, password, store, request } = fixture(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('login', { method: 'POST', value: { password: 'incorrect' } })).status, 401);
  }
  const handle = createHandler({ password, store });
  const blocked = await handle(request('login', { method: 'POST', value: { password } }));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('the static site allowlist excludes secrets, storage, and private views', () => {
  for (const path of ['.env.local', 'server/views/editor.html', '.everything-data/everything.sqlite', '.git/config', 'api/everything.js']) {
    assert.equal(isPublicPath(path), false);
  }
  assert.equal(isPublicPath('index.html'), true);
  assert.equal(isPublicPath('everything-assets/app.js'), true);
});
